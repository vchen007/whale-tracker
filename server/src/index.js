import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { loadPrivateKey } from './auth.js';
import { KalshiClient } from './kalshiClient.js';
import { AutoTrader } from './autoTrader.js';
import { initDb, insertTrade, bulkInsert, getTradesSince, getTopMarkets, getOldestTradeTs, getNewestTradeTs, bulkInsertTitles, getTitleCount, getCategorizedTitleCount, getCloseTimeCount, getTickerCategoryMap, getTickerTitleMap, getTickerMetaMap, getRecentlyActiveTickers, refreshMarketMeta, getUniqueSeries, updateCategoriesBySeries, getMissingTitleTickers, getTickersMissingCategory, bulkUpdateCategories, purgeSmallTrades, getAutoOrderSummary } from './db.js';
import { fetchTradeHistory, fetchAllMarketTitles, fetchCategories, fetchEventData, fetchEventCategoryMap, fetchTitlesByTickers } from './kalshiRest.js';

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

// ── Auto-trader ───────────────────────────────────────────────────────────────

const autoTrader = new AutoTrader({
  privateKey,
  apiKeyId:     API_KEY_ID,
  enabled:      process.env.AUTO_TRADER_ENABLED !== 'false',
  category:     process.env.AUTO_TRADER_CATEGORY ?? 'Sports',
  count:        Number(process.env.AUTO_TRADER_COUNT ?? 1),
  minNotional:  Number(process.env.AUTO_TRADER_MIN_NOTIONAL ?? 20_000),
  minNetProfit: Number(process.env.AUTO_TRADER_MIN_NET_PROFIT ?? 0.02),
});

// ── Category map (ticker → human-readable category) ──────────────────────────

const categoryMap   = getTickerCategoryMap();
const titleMap      = getTickerTitleMap();
const marketMetaMap = getTickerMetaMap();

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} */
const browserClients = new Set();

let kalshiStatus = 'idle';

function addTrade(trade) {
  if (!isWhale(trade)) return;
  insertTrade(trade);
  broadcast({ type: 'trade', data: trade });
  autoTrader.onTrade(trade).catch((err) => console.error('[auto-trader] unhandled error', err.message));
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

// ── Auto-trader endpoints ─────────────────────────────────────────────────────

app.get('/auto-trader/status', async () => autoTrader.status());

app.post('/auto-trader/enable',  async () => { autoTrader.enable();  return autoTrader.status(); });
app.post('/auto-trader/disable', async () => { autoTrader.disable(); return autoTrader.status(); });

// P&L summary: total wins/losses/realized cents + recent orders with outcomes
app.get('/auto-trader/pnl', async () => getAutoOrderSummary());

// Trigger settlement check on demand
app.post('/auto-trader/settle', async () => autoTrader.checkSettlements());

// ── Categories ────────────────────────────────────────────────────────────────

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
  marketMetaMap,
});

kalshi.connect();

// Periodic gap-fill: every 10 minutes, REST-fill any trades the WebSocket may have missed
setInterval(async () => {
  const newest = getNewestTradeTs();
  if (!newest || (Date.now() - newest) < 60_000) return;
  try {
    const total = await fetchTradeHistory(privateKey, API_KEY_ID, newest + 1, (page) => {
      bulkInsert(page.filter(isWhale));
    });
    if (total > 0) console.log(`[gap-fill] filled ${total} trades`);
  } catch (err) {
    console.error('[gap-fill] error:', err.message);
  }
}, 10 * 60 * 1000);

// Periodic market metadata refresher: every 20 minutes, refresh close_time +
// event_start_time for tickers traded in the last 48 hours. Kalshi updates
// these fields when markets actually close (often earlier than scheduled),
// so a stale cache shows wrong PRE/LIVE timing badges on the dashboard.
setInterval(async () => {
  const tickers = getRecentlyActiveTickers(48);
  if (tickers.length === 0) return;
  let updated = 0;
  for (const ticker of tickers) {
    try {
      const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
      if (!res.ok) continue;
      const m = (await res.json()).market;
      if (!m) continue;
      refreshMarketMeta(ticker, m.close_time ?? null, m.occurrence_datetime ?? null);
      if (m.close_time || m.occurrence_datetime) {
        marketMetaMap.set(ticker, {
          closeTime: m.close_time ?? null,
          eventStartTime: m.occurrence_datetime ?? null,
        });
        updated++;
      }
    } catch {
      // skip
    }
    await new Promise((r) => setTimeout(r, 30)); // rate limit
  }
  if (updated > 0) console.log(`[meta] refreshed ${updated}/${tickers.length} active tickers`);
}, 20 * 60 * 1000);

// Periodic settlement check: every 15 minutes, look up open auto-trader orders
// against Kalshi market status. When a market settles, record outcome + P&L.
setInterval(async () => {
  try {
    const { checked, settled } = await autoTrader.checkSettlements();
    if (settled > 0) console.log(`[auto-trader] settlement check: ${settled}/${checked} orders settled`);
  } catch (err) {
    console.error('[auto-trader] settlement check error:', err.message);
  }
}, 15 * 60 * 1000);

// Periodic title backfill: every 5 minutes, fetch titles for any tickers that arrived since startup.
// Uses direct /markets/{ticker} endpoint which always has the title (event endpoint may not).
setInterval(async () => {
  const missing = getMissingTitleTickers();
  if (missing.length === 0) return;
  console.log(`[titles] backfilling ${missing.length} new tickers…`);
  try {
    await fetchTitlesByTickers(privateKey, API_KEY_ID, missing, (page) => {
      bulkInsertTitles(page);
      for (const [ticker, title, category, _yesSub, _noSub, closeTime, eventStartTime] of page) {
        if (title)    titleMap.set(ticker, title);
        if (category) categoryMap.set(ticker, category);
        if (closeTime || eventStartTime) {
          marketMetaMap.set(ticker, { closeTime, eventStartTime });
        }
      }
    });
  } catch (err) {
    console.error('[titles] periodic backfill error:', err.message);
  }
}, 5 * 60 * 1000);

// Seed market titles in background if not yet cached, or if close_time is missing
if (getTitleCount() === 0 || getCategorizedTitleCount() === 0 || getCloseTimeCount() === 0) {
  console.log('[titles] fetching market titles + close times in background…');
  (async () => {
    try {
      const eventCategoryMap = await fetchEventCategoryMap(privateKey, API_KEY_ID);
      console.log(`[events] loaded ${eventCategoryMap.size} event categories`);
      const n = await fetchAllMarketTitles(privateKey, API_KEY_ID, (page) => {
        bulkInsertTitles(page);
        for (const [ticker, , category] of page) {
          if (category) categoryMap.set(ticker, category);
        }
      }, eventCategoryMap);
      console.log(`[titles] cached ${n} market titles with close times`);
    } catch (err) {
      console.error('[titles] error:', err.message);
    }
  })();
}

// Backfill titles for any tickers missing them via direct /markets/{ticker} endpoint
const missingTickers = getMissingTitleTickers();
if (missingTickers.length > 0) {
  console.log(`[titles] backfilling ${missingTickers.length} tickers via markets endpoint…`);
  fetchTitlesByTickers(privateKey, API_KEY_ID, missingTickers, (page) => {
    bulkInsertTitles(page);
    for (const [ticker, title, category] of page) {
      if (title)    titleMap.set(ticker, title);
      if (category) categoryMap.set(ticker, category);
    }
  })
    .then((n) => console.log(`[titles] backfilled ${n} tickers`))
    .catch((err) => console.error('[titles] backfill error:', err.message));
}

// ── Start ─────────────────────────────────────────────────────────────────────

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[server] listening on http://localhost:${PORT}`);
console.log(`[server] browser WebSocket → ws://localhost:${PORT}/ws`);

process.on('SIGINT', () => {
  kalshi.destroy();
  app.close(() => process.exit(0));
});
