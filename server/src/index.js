import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { loadPrivateKey } from './auth.js';
import { KalshiClient } from './kalshiClient.js';
import { initDb, insertTrade, bulkInsert, getTradesSince, getTopMarkets, getOldestTradeTs, getNewestTradeTs, bulkInsertTitles, getTitleCount, getCategorizedTitleCount, getTickerCategoryMap, getTickerTitleMap, getUniqueSeries, updateCategoriesBySeries, getMissingTitleTickers, getTickersMissingCategory, bulkUpdateCategories, purgeSmallTrades } from './db.js';
import { fetchTradeHistory, fetchAllMarketTitles, fetchCategories, fetchEventData } from './kalshiRest.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT        = Number(process.env.PORT ?? 3001);
const API_KEY_ID  = process.env.KALSHI_API_KEY_ID;
const PRIVATE_KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_NOTIONAL_DOLLARS = Number(process.env.MIN_NOTIONAL_DOLLARS ?? 10_000);

function tradeNotional(trade) {
  const price = trade.side === 'yes' ? (trade.yesPrice ?? 0) : (trade.noPrice ?? 0);
  return (trade.count * price) / 100;
}

function isWhale(trade) {
  return tradeNotional(trade) >= MIN_NOTIONAL_DOLLARS;
}

if (!API_KEY_ID || !PRIVATE_KEY_PATH) {
  console.error('Missing env vars: KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH must be set.');
  process.exit(1);
}

// ── Database ──────────────────────────────────────────────────────────────────

initDb();

// One-time cleanup: remove trades below the minimum notional threshold
const purged = purgeSmallTrades(MIN_NOTIONAL_DOLLARS);
if (purged > 0) console.log(`[db] purged ${purged.toLocaleString()} trades below $${MIN_NOTIONAL_DOLLARS.toLocaleString()}`);

// Seed historical trades if we don't have 30 days of data yet
const privateKey = loadPrivateKey(PRIVATE_KEY_PATH);
const oldest = getOldestTradeTs();
const thirtyDaysAgo = Date.now() - THIRTY_DAYS_MS;

(async () => {
  // Backfill from 30 days ago if we're missing early history
  if (!oldest || oldest > thirtyDaysAgo) {
    const sinceMs = oldest ? Math.min(oldest - 1, thirtyDaysAgo) : thirtyDaysAgo;
    console.log(`[history] fetching trades since ${new Date(sinceMs).toISOString()} …`);
    const total = await fetchTradeHistory(privateKey, API_KEY_ID, sinceMs, (page) => {
      bulkInsert(page.filter(isWhale));
    });
    console.log(`[history] seeded ${total} trades`);
  }

  // Gap-fill: fetch any trades between the newest stored trade and now
  const newest = getNewestTradeTs();
  const GAP_THRESHOLD_MS = 60_000; // ignore gaps under 1 minute
  if (newest && (Date.now() - newest) > GAP_THRESHOLD_MS) {
    console.log(`[history] gap detected — fetching trades since ${new Date(newest).toISOString()} …`);
    const total = await fetchTradeHistory(privateKey, API_KEY_ID, newest + 1, (page) => {
      bulkInsert(page.filter(isWhale));
    });
    console.log(`[history] gap-filled ${total} trades`);
  }
})();

// ── Category map (ticker → human-readable category) ──────────────────────────

const categoryMap = getTickerCategoryMap();
const titleMap    = getTickerTitleMap();

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} */
const browserClients = new Set();

let kalshiStatus = 'idle';

function addTrade(trade) {
  if (!isWhale(trade)) return;
  insertTrade(trade);
  broadcast({ type: 'trade', data: trade });
}

function setStatus(status) {
  kalshiStatus = status;
  console.log(`[kalshi] ${status}`);
  broadcast({ type: 'status', data: status });
}

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of browserClients) {
    if (client.readyState === 1 /* OPEN */) client.send(text);
  }
}

// ── Fastify ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });
await app.register(fastifyWebsocket);

// CORS for local dev
app.addHook('onRequest', (req, reply, done) => {
  reply.header('Access-Control-Allow-Origin', '*');
  done();
});

// Live WebSocket feed
app.get('/ws', { websocket: true }, (socket) => {
  browserClients.add(socket);
  console.log(`[ws] client connected (total: ${browserClients.size})`);
  socket.send(JSON.stringify({ type: 'status', data: kalshiStatus }));
  socket.on('close', () => {
    browserClients.delete(socket);
    console.log(`[ws] client disconnected (total: ${browserClients.size})`);
  });
  socket.on('error', (err) => {
    console.error('[ws] client error', err.message);
    browserClients.delete(socket);
  });
});

// Historical trades REST endpoint
app.get('/trades', async (req) => {
  const sinceMs     = req.query.since       ? Number(req.query.since)       : thirtyDaysAgo;
  const minNotional = req.query.minNotional ? Number(req.query.minNotional) : 0;
  const limit       = req.query.limit       ? Number(req.query.limit)       : 10_000;
  const sortBy      = req.query.sortBy === 'notional' ? 'notional' : 'time';
  return getTradesSince(sinceMs, limit, minNotional, sortBy);
});

app.get('/health', async () => ({ ok: true, kalshiStatus, clients: browserClients.size }));

app.get('/markets/top', async (req) => {
  const sinceMs = req.query.since ? Number(req.query.since) : thirtyDaysAgo;
  const limit   = req.query.limit ? Number(req.query.limit) : 100;
  return getTopMarkets(sinceMs, limit);
});

app.get('/categories', async (_req, reply) => {
  try {
    return await fetchCategories();
  } catch (err) {
    reply.code(502).send({ error: err.message });
  }
});

// ── Kalshi upstream ───────────────────────────────────────────────────────────

const kalshi = new KalshiClient({
  apiKeyId: API_KEY_ID,
  privateKey,
  onTrade: addTrade,
  onStatus: setStatus,
  categoryMap,
  titleMap,
});

kalshi.connect();

// Seed market titles in background if not yet cached
if (getTitleCount() === 0) {
  console.log('[titles] fetching market titles in background…');
  fetchAllMarketTitles(privateKey, API_KEY_ID, (page) => bulkInsertTitles(page))
    .then((n) => console.log(`[titles] cached ${n} market titles`))
    .catch((err) => console.error('[titles] error:', err.message));
}

// Backfill titles + categories together via event endpoint
const missingTickers = getMissingTitleTickers();
if (missingTickers.length > 0) {
  console.log(`[event] backfilling ${missingTickers.length} tickers via event endpoint…`);
  fetchEventData(privateKey, API_KEY_ID, missingTickers, (page) => {
    bulkInsertTitles(page);
    for (const [ticker, title, category] of page) {
      if (title)    titleMap.set(ticker, title);
      if (category) categoryMap.set(ticker, category);
    }
  })
    .then((n) => console.log(`[event] backfilled ${n} tickers`))
    .catch((err) => console.error('[event] backfill error:', err.message));
}

// ── Start ─────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[server] listening on http://localhost:${PORT}`);
console.log(`[server] browser WebSocket → ws://localhost:${PORT}/ws`);

process.on('SIGINT', () => {
  kalshi.destroy();
  app.close(() => process.exit(0));
});
