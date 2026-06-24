// Load env before anything reads process.env. loadEnv.js applies the ENV_FILE
// overlay (e.g. ENV_FILE=.env.demo) FIRST, then fills the rest from base .env.
// (kalshiEnv.js / db.js read process.env at import time, so this import must
// stay above them.)
import './loadEnv.js';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { loadPrivateKey } from './auth.js';
import { KalshiClient } from './kalshiClient.js';
import { AutoTrader } from '../../auto-trader/autoTrader.js';
import { initDb, insertTrade, bulkInsert, getTradesSince, getTopMarkets, getOldestTradeTs, getNewestTradeTs, bulkInsertTitles, getTickerCategoryMap, getTickerTitleMap, getTickerMetaMap, getRecentlyActiveTickers, refreshMarketMeta, setEventActualStartTime, getUniqueSeries, updateCategoriesBySeries, getMissingTitleTickers, getTickersMissingCategory, bulkUpdateCategories, purgeSmallTrades, getAutoOrderSummary, getActiveKalshiTickersSince } from './db.js';
import { fetchTradeHistory, fetchCategories, fetchEventData, fetchTitlesByTickers } from './kalshiRest.js';
import { fetchPolymarketTrades } from './polymarketRest.js';
import { startSchedulePoller, findKalshiGameStart, findPolymarketGameStart } from './sportsApi.js';
import authMiddleware from './authMiddleware.js';
import { KALSHI_REST_BASE, KALSHI_TRADING_BASE, logKalshiEnv, DATA_IS_DEMO, IS_DEMO } from './kalshiEnv.js';
import { scanForArbs } from './arbDetector.js';
import { notifyArb } from './notify.js';

// ── Config ────────────────────────────────────────────────────────────────────

logKalshiEnv(); // print active data/trading/WS endpoints (demo vs live) at startup
if (DATA_IS_DEMO) {
  console.log('[demo] data base is demo → skipping prod-data backfill loops (history gap-fill, metadata refresh, title backfill) to avoid 429 rate limits.');
}

// Distinct default ports per environment so live and demo never land on the
// same port by default: demo → 3001, live → 3002. An explicit PORT (env or
// ecosystem) overrides. The EADDRINUSE guard at startup catches any remaining
// collision loudly instead of letting one silently win.
const PORT        = Number(process.env.PORT ?? (IS_DEMO ? 3001 : 3002));
const API_KEY_ID  = process.env.KALSHI_API_KEY_ID;
const PRIVATE_KEY_PATH = process.env.KALSHI_PRIVATE_KEY_PATH;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_NOTIONAL_DOLLARS = Number(process.env.MIN_NOTIONAL_DOLLARS ?? 10_000);
// Trades at >=95¢ on the side they bought are usually settlement transfers
// (closing positions, wash trades, OTC) — the upside is too small (≤5¢ max)
// minus fees, so almost never a real conviction signal. Skip them.
// Originally 99¢, tightened to 95¢ after May 11 analysis showed the 98¢
// "ATL Braves" Polymarket trade was a wash/settlement that polluted the
// cross-venue arbitrage comparison.
const ZERO_EV_PRICE_CENTS = 95;

function tradePriceCents(trade) {
  return trade.side === 'yes' ? (trade.yesPrice ?? 0) : (trade.noPrice ?? 0);
}

function tradeNotional(trade) {
  return (trade.count * tradePriceCents(trade)) / 100;
}

function isWhale(trade) {
  return tradeNotional(trade) >= MIN_NOTIONAL_DOLLARS;
}

function isMeaningfulSignal(trade) {
  // Skip zero-EV settlement trades — buying at >=99¢ has no upside to bet
  // on, so it's almost never a directional whale signal.
  return tradePriceCents(trade) < ZERO_EV_PRICE_CENTS;
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

if (!DATA_IS_DEMO) (async () => {
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

// Real-money safety gate. On the LIVE trading environment the auto-trader stays
// DISARMED unless AUTO_TRADER_LIVE_CONFIRM=true is explicitly set, so live
// trading can never start by accident (wrong ENV_FILE, port mix-up, etc.). Demo
// (paper money) needs no confirmation. This also guards the runtime
// /auto-trader/enable endpoint below.
const autoTraderWanted = process.env.AUTO_TRADER_ENABLED !== 'false';
const liveConfirmed    = process.env.AUTO_TRADER_LIVE_CONFIRM === 'true';
const liveTradingAllowed = IS_DEMO || liveConfirmed;
const autoTraderEnabled  = autoTraderWanted && liveTradingAllowed;
if (autoTraderWanted && !liveTradingAllowed) {
  console.error(
    '🚨 [SAFETY] Auto-trader requested ENABLED on LIVE Kalshi (real money) but ' +
    'AUTO_TRADER_LIVE_CONFIRM is not "true" — keeping the trader DISARMED. ' +
    'Set AUTO_TRADER_LIVE_CONFIRM=true and restart to trade real money.'
  );
} else if (autoTraderEnabled && !IS_DEMO) {
  console.warn('💰 [LIVE] Auto-trader ARMED on LIVE Kalshi (real money) — AUTO_TRADER_LIVE_CONFIRM=true.');
}

const autoTrader = new AutoTrader({
  privateKey,
  apiKeyId:        API_KEY_ID,
  enabled:         autoTraderEnabled,
  // Disarm the whale-COPY path independently of the agent. Set
  // AUTO_TRADER_WHALE_COPY_ENABLED=false to run the agent only (the agent's
  // placeOrderDirect ignores this flag; it gates on `enabled`).
  whaleCopyEnabled: process.env.AUTO_TRADER_WHALE_COPY_ENABLED !== 'false',
  category:        process.env.AUTO_TRADER_CATEGORY ?? 'Sports',
  count:           Number(process.env.AUTO_TRADER_COUNT ?? 1),
  minNotional:     Number(process.env.AUTO_TRADER_MIN_NOTIONAL ?? 25_000),
  minNetProfit:    Number(process.env.AUTO_TRADER_MIN_NET_PROFIT ?? 0.02),
  // Maker mode: post resting limit orders inside the spread instead of crossing
  // as a taker (Makers −9.6% vs Takers −31.5% per the makers/takers paper).
  makerMode:          process.env.AUTO_TRADER_MAKER_MODE !== 'false',
  makerFeeCoeff:      Number(process.env.AUTO_TRADER_MAKER_FEE_COEFF ?? 0.07),
  unfilledTtlMinutes: Number(process.env.AUTO_TRADER_UNFILLED_TTL_MIN ?? 10),
  // Maker-first / taker-fallback: post a resting maker, then cross the ask as a
  // taker if still unfilled after makerFallbackMinutes (re-validates EV at the
  // ask; cancels instead if it no longer clears). Off ⇒ unfilled makers cancel.
  takerFallback:        process.env.AUTO_TRADER_TAKER_FALLBACK === 'true',
  makerFallbackMinutes: Number(process.env.AUTO_TRADER_MAKER_FALLBACK_MIN ?? 10),
  stopLossEnabled: process.env.AUTO_TRADER_STOP_LOSS_ENABLED !== 'false',
  stopLossPercent: Number(process.env.AUTO_TRADER_STOP_LOSS_PERCENT ?? 50),
  // Comma-separated list overrides the default blocked-prefix set, e.g.:
  //   AUTO_TRADER_BLOCKED_PREFIXES=KXNBASPREAD,KXIPL,KXUFCFIGHT
  // Defined (even empty) overrides the default set; empty string ⇒ no blocks.
  // filter(Boolean) drops blank entries so a stray comma can't yield '' which
  // would startsWith-match (and thus block) every ticker.
  ...(process.env.AUTO_TRADER_BLOCKED_PREFIXES !== undefined
    ? { blockedPrefixes: process.env.AUTO_TRADER_BLOCKED_PREFIXES.split(',').map((s) => s.trim()).filter(Boolean) }
    : {}),
  minPriceCents:   Number(process.env.AUTO_TRADER_MIN_PRICE_CENTS ?? 70),
  maxPriceCents:   Number(process.env.AUTO_TRADER_MAX_PRICE_CENTS ?? 84),
  dedupeByEvent:   process.env.AUTO_TRADER_DEDUPE_BY_EVENT !== 'false',
  maxPerGame:      Number(process.env.AUTO_TRADER_MAX_PER_GAME ?? 5),
  // Bankroll rails for autonomous operation (<=0 disables a given cap).
  maxCapital:       Number(process.env.AUTO_TRADER_MAX_CAPITAL ?? 500),
  maxOpenPositions: Number(process.env.AUTO_TRADER_MAX_OPEN_POSITIONS ?? 25),
  // Per-ticker cap (whale-copy + agent paths): max concurrent committed +
  // in-flight orders on the same market. Belt-and-suspenders with dedupeByEvent.
  maxPerTicker:     Number(process.env.AUTO_TRADER_MAX_PER_TICKER ?? 5),
  maxDailyLoss:     Number(process.env.AUTO_TRADER_MAX_DAILY_LOSS ?? 100),
  // Calibrated EV gate: favorite–longshot correction from the makers/takers
  // paper (win prob ≈ (P − 1.736 + 0.034·P)/100). Requires probability-weighted
  // EV after fees > AUTO_TRADER_MIN_EV. Effectively narrows entries to ~84–94¢.
  calibratedEv:     process.env.AUTO_TRADER_CALIBRATED_EV !== 'false',
  calibrationAlpha: Number(process.env.AUTO_TRADER_CALIBRATION_ALPHA ?? -1.736),
  calibrationPsi:   Number(process.env.AUTO_TRADER_CALIBRATION_PSI ?? 0.034),
  minEvDollars:     Number(process.env.AUTO_TRADER_MIN_EV ?? 0),
  // Timing rail (agent orders): reject markets closing further out than this —
  // the paper's price calibration only holds within ~10 days of close. <=0 disables.
  maxDaysToClose:   Number(process.env.AUTO_TRADER_MAX_DAYS_TO_CLOSE ?? 10),
});

// ── Category map (ticker → human-readable category) ──────────────────────────

const categoryMap   = getTickerCategoryMap();
const titleMap      = getTickerTitleMap();
const marketMetaMap = getTickerMetaMap();

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Set<import('ws').WebSocket>} */
const browserClients = new Set();

// WebSocket connection limits
const MAX_WS_TOTAL  = 50;
const MAX_WS_PER_IP = 5;
/** @type {Map<string, number>} */
const wsPerIp = new Map();

let kalshiStatus = 'idle';

// Cache: tickers we've already tried to enrich, so we don't re-look-up on every trade
const _actualStartLookedUp = new Set();

function tryEnrichActualStart(trade) {
  if (_actualStartLookedUp.has(trade.ticker)) return;
  _actualStartLookedUp.add(trade.ticker);
  let actualStart = null;
  if (trade.source === 'polymarket') {
    actualStart = findPolymarketGameStart(trade.title, trade.ts);
  } else {
    actualStart = findKalshiGameStart(trade.ticker);
  }
  if (actualStart) {
    setEventActualStartTime(trade.ticker, actualStart);
    const meta = marketMetaMap.get(trade.ticker) ?? {};
    marketMetaMap.set(trade.ticker, { ...meta, eventActualStartTime: actualStart });
  }
}

function addTrade(trade) {
  if (!isWhale(trade)) return;
  if (!isMeaningfulSignal(trade)) return;  // skip 99-100¢ settlement trades
  insertTrade(trade);
  // Enrich with ESPN-derived game start time if we haven't already
  tryEnrichActualStart(trade);
  // Attach the cached actual start time to the broadcast so the UI gets it live
  const meta = marketMetaMap.get(trade.ticker);
  if (meta?.eventActualStartTime) trade.eventActualStartTime = meta.eventActualStartTime;
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

const app = Fastify({ logger: false, trustProxy: true });
await app.register(fastifyWebsocket);
await app.register(authMiddleware);
await app.register(rateLimit, {
  max: 100,
  timeWindow: 60_000,             // 100 req/min global default
  keyGenerator: (req) => req.ip,
});

// CORS — restrict to known origins
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
);
app.addHook('onRequest', (req, reply, done) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  reply.header('Vary', 'Origin');
  // Handle preflight
  if (req.method === 'OPTIONS') {
    reply.code(204).send();
    return;
  }
  done();
});

// Live WebSocket feed
app.get('/ws', { websocket: true }, (socket, req) => {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';

  // Enforce connection limits
  if (browserClients.size >= MAX_WS_TOTAL) {
    socket.close(1008, 'too many connections');
    return;
  }
  const ipCount = wsPerIp.get(ip) ?? 0;
  if (ipCount >= MAX_WS_PER_IP) {
    socket.close(1008, 'too many connections from this IP');
    return;
  }

  browserClients.add(socket);
  wsPerIp.set(ip, ipCount + 1);
  console.log(`[ws] client connected from ${ip} (total: ${browserClients.size})`);
  socket.send(JSON.stringify({ type: 'status', data: kalshiStatus }));

  function cleanup() {
    browserClients.delete(socket);
    const current = wsPerIp.get(ip) ?? 1;
    if (current <= 1) wsPerIp.delete(ip);
    else wsPerIp.set(ip, current - 1);
  }

  socket.on('close', () => {
    cleanup();
    console.log(`[ws] client disconnected (total: ${browserClients.size})`);
  });
  socket.on('error', (err) => {
    console.error('[ws] client error', err.message);
    cleanup();
  });
});

// Historical trades REST endpoint
app.get('/trades', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        since:       { type: 'number', minimum: 0 },
        minNotional: { type: 'number', minimum: 0 },
        limit:       { type: 'integer', minimum: 1, maximum: 10_000 },
        sortBy:      { type: 'string', enum: ['time', 'notional'] },
      },
    },
  },
}, async (req) => {
  const sinceMs     = req.query.since       ?? thirtyDaysAgo;
  const minNotional = req.query.minNotional ?? 0;
  const limit       = req.query.limit       ?? 10_000;
  const sortBy      = req.query.sortBy      ?? 'time';
  return getTradesSince(sinceMs, limit, minNotional, sortBy);
});

app.get('/health', async () => ({ ok: true, kalshiStatus, clients: browserClients.size }));

app.get('/markets/top', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        since: { type: 'number', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
    },
  },
}, async (req) => {
  const sinceMs = req.query.since ?? thirtyDaysAgo;
  const limit   = req.query.limit ?? 100;
  return getTopMarkets(sinceMs, limit);
});

// ── Auto-trader endpoints ─────────────────────────────────────────────────────

app.get('/auto-trader/status', { preHandler: [app.authenticate] }, async () => autoTrader.status());

const autoTraderRateLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };
app.post('/auto-trader/enable', { preHandler: [app.authenticate], ...autoTraderRateLimit }, async (req, reply) => {
  // Same real-money gate as startup: refuse to arm on LIVE without explicit confirmation.
  if (!liveTradingAllowed) {
    return reply.code(403).send({
      error: 'live trading not confirmed — set AUTO_TRADER_LIVE_CONFIRM=true and restart to arm the trader on live Kalshi',
    });
  }
  autoTrader.enable();
  return autoTrader.status();
});
app.post('/auto-trader/disable', { preHandler: [app.authenticate], ...autoTraderRateLimit }, async () => { autoTrader.disable(); return autoTrader.status(); });

// P&L summary: total wins/losses/realized cents + recent orders with outcomes
app.get('/auto-trader/pnl', { preHandler: [app.authenticate] }, async () => getAutoOrderSummary());

// Trigger settlement check on demand
app.post('/auto-trader/settle', { preHandler: [app.authenticate], ...autoTraderRateLimit }, async () => autoTrader.checkSettlements());

// Market discovery for the agent: markets with PROVEN taker flow (tickers that
// actually traded recently, from our own feed DB), enriched with their current
// book. A resting maker order only fills where takers exist, so recent-trade
// count is the fill-probability signal. Falls back to a /markets page scan
// ranked by 24h volume when the feed DB has nothing recent.
const _centsOf = (c, d) => {
  if (c != null && Number.isFinite(Number(c)) && Number(c) > 0) return Math.round(Number(c));
  const f = parseFloat(d ?? NaN);
  return Number.isFinite(f) ? Math.round(f * 100) : NaN;
};
const _volOf = (m) => Number(m.volume_24h ?? m.volume_24h_fp ?? m.volume ?? m.volume_fp ?? 0);

async function findMarkets({ limit = 15, maxSpreadCents = 10, windowHours = 48 } = {}) {
  const out = [];

  // 1) Proven-flow tickers from our own trade feed, enriched with live books.
  const active = getActiveKalshiTickersSince(Date.now() - windowHours * 3600_000, 60)
    .filter((t) => !autoTrader.blockedPrefixes.some((p) => t.ticker.startsWith(p)));
  for (const t of active.slice(0, 50)) {
    try {
      const res = await fetch(`${KALSHI_TRADING_BASE}/markets/${t.ticker}`);
      if (!res.ok) continue;
      const m = (await res.json()).market ?? {};
      if (m.status !== 'active') continue;
      const yesBid = _centsOf(m.yes_bid, m.yes_bid_dollars);
      const yesAsk = _centsOf(m.yes_ask, m.yes_ask_dollars);
      if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesAsk <= yesBid) continue;
      if (yesAsk - yesBid > maxSpreadCents) continue;
      out.push({
        ticker: t.ticker, title: m.title ?? null,
        yes_bid: yesBid, yes_ask: yesAsk, spread_cents: yesAsk - yesBid,
        recent_trades: t.trades, last_trade_min_ago: Math.round((Date.now() - t.last_ms) / 60_000),
        volume_24h: _volOf(m), close_time: m.expected_expiration_time ?? m.close_time ?? null,
        source: 'feed',
      });
    } catch { /* skip ticker */ }
    await new Promise((r) => setTimeout(r, 120)); // gentle on the API
  }
  out.sort((a, b) => b.recent_trades - a.recent_trades);

  // 2) Fallback page scan when the feed is quiet (e.g. WS down): volume-ranked.
  if (out.length === 0) {
    const res = await fetch(`${KALSHI_TRADING_BASE}/markets?status=open&limit=1000`);
    if (!res.ok) throw new Error(`markets fetch failed: HTTP ${res.status}`);
    const { markets = [] } = await res.json();
    for (const m of markets) {
      if (autoTrader.blockedPrefixes.some((p) => m.ticker?.startsWith(p))) continue;
      const yesBid = _centsOf(m.yes_bid, m.yes_bid_dollars);
      const yesAsk = _centsOf(m.yes_ask, m.yes_ask_dollars);
      if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk)) continue;
      if (yesBid < 1 || yesAsk > 99 || yesAsk <= yesBid) continue;
      if (yesAsk - yesBid > maxSpreadCents) continue;
      out.push({
        ticker: m.ticker, title: m.title ?? null,
        yes_bid: yesBid, yes_ask: yesAsk, spread_cents: yesAsk - yesBid,
        recent_trades: 0, last_trade_min_ago: null,
        volume_24h: _volOf(m), close_time: m.expected_expiration_time ?? m.close_time ?? null,
        source: 'scan',
      });
    }
    out.sort((a, b) => b.volume_24h - a.volume_24h);
  }

  // Diversify the returned list by series so one hot category (e.g. World Cup
  // during the tournament) can't fill every slot. `out` is already sorted by
  // recent_trades / volume, so we keep the best book per series first (up to
  // perSeriesCap each), then backfill remaining slots with the next-best
  // regardless of series — this guarantees up to `limit` markets even when only
  // one series is liquid, while surfacing other high-liquidity categories.
  const perSeriesCap = Math.max(2, Math.ceil(limit / 4));
  const seriesSeen = new Map();
  const primary = [];   // diversified picks (<= perSeriesCap per series)
  const overflow = [];  // the rest, in sorted order, for backfill
  for (const m of out) {
    const series = (m.ticker ?? '').split('-')[0];
    const n = seriesSeen.get(series) ?? 0;
    if (n < perSeriesCap) { seriesSeen.set(series, n + 1); primary.push(m); }
    else                  { overflow.push(m); }
  }
  const markets = [...primary, ...overflow].slice(0, limit);

  return {
    count: markets.length,
    note: out.length === 0
      ? 'No markets with a usable book found — taker flow is absent right now; placing maker orders is unlikely to fill.'
      : undefined,
    markets,
  };
}

// ── Managed Agent tool endpoint ───────────────────────────────────────────────
// Called by the Anthropic Managed Agent via the ngrok tunnel.
// Rate-limited as a doom-loop backstop: an agent retrying a dead exchange once
// burned 80 identical calls in 25 minutes.
app.post('/agent/tool', { preHandler: [app.authenticate], config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req, reply) => {
  const { action, ticker, side, limit_price, count, client_order_id: cancelId } = req.body ?? {};
  try {
    if (action === 'get_status') return autoTrader.status();
    if (action === 'get_pnl')    return getAutoOrderSummary();
    if (action === 'find_markets') {
      return await findMarkets({
        limit:          Number(req.body?.limit ?? 15),
        maxSpreadCents: Number(req.body?.max_spread_cents ?? 10),
      });
    }
    if (action === 'place_order') {
      if (!ticker || !side || !limit_price) {
        return reply.code(400).send({ error: 'place_order requires ticker, side, limit_price' });
      }
      try {
        return await autoTrader.placeOrderDirect({ ticker, side, limitPrice: limit_price, count: count ?? 1 });
      } catch (err) {
        // Exchange-side failures come back as a structured rejection with an
        // explicit no-retry instruction, NOT an HTTP 500 — agents read 500s as
        // "transient, retry" and hammer a dead exchange.
        return {
          rejected: true,
          reason: `exchange error: ${err.message}`,
          retry_advice: 'Do NOT retry this or other orders now — the exchange order path is unavailable. ' +
                        'Note the failure in your report and move on; it typically recovers in minutes to hours.',
        };
      }
    }
    if (action === 'cancel_order') {
      if (!cancelId) return reply.code(400).send({ error: 'cancel_order requires client_order_id' });
      return await autoTrader.cancelOrderDirect(cancelId);
    }
    return reply.code(400).send({ error: `Unknown action: ${action}` });
  } catch (err) {
    reply.code(500).send({ error: err.message });
  }
});

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

// ── ESPN sports schedule cache ───────────────────────────────────────────────
// Used to enrich trades with the actual game start time (vs the eventEnd-3h
// approximation). Hourly background refresh covers today + 2 days ahead.
startSchedulePoller();

// ── Polymarket ───────────────────────────────────────────────────────────────
// REST poller — Polymarket's WebSocket needs a Polygon wallet auth flow we
// haven't set up yet. Polling every 60s is plenty for whale-trade tracking
// since the data-api includes title + outcome inline (no extra metadata fetch).
let lastPolymarketPollMs = Date.now() - 24 * 60 * 60 * 1000; // backfill last 24h on first run

async function pollPolymarket() {
  try {
    const sinceMs = lastPolymarketPollMs;
    const trades = await fetchPolymarketTrades(sinceMs);
    if (trades.length === 0) return;

    // Each Polymarket trade arrives with title + category already enriched.
    // Upsert into market_titles so the dashboard's JOIN can render the title
    // (instead of the raw ticker like "PM-0xacc23a9c2a5601-1").
    const titleRows = [];
    const seen = new Set();
    for (const t of trades) {
      if (!t.title || seen.has(t.ticker)) continue;
      seen.add(t.ticker);
      titleRows.push([
        t.ticker,
        t.title,
        t.category,
        t.outcome ?? null,    // yes_sub: which outcome the YES side represents
        null,                 // no_sub: Polymarket markets are per-outcome, no separate NO label
        null,                 // close_time: not in the trade payload
        null,                 // event_start_time: not in the trade payload
      ]);
      titleMap.set(t.ticker, t.title);
      categoryMap.set(t.ticker, t.category);
    }
    if (titleRows.length > 0) bulkInsertTitles(titleRows, 'polymarket');

    let kept = 0;
    for (const t of trades) {
      if (new Date(t.ts).getTime() < sinceMs) continue;
      addTrade(t);
      kept++;
    }
    lastPolymarketPollMs = Date.now();
    if (kept > 0) console.log(`[polymarket] +${kept} whale trades, ${titleRows.length} new titles`);
  } catch (err) {
    console.error('[polymarket] poll error:', err.message);
  }
}

setInterval(pollPolymarket, 60 * 1000);
pollPolymarket(); // run once at startup

// Periodic gap-fill: every 10 minutes, REST-fill any trades the WebSocket may have missed.
// Skipped in demo (data base = demo) — would hammer the demo API with prod-ticker history.
if (!DATA_IS_DEMO) setInterval(async () => {
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
if (!DATA_IS_DEMO) setInterval(async () => {
  const tickers = getRecentlyActiveTickers(48);
  if (tickers.length === 0) return;
  let updated = 0;
  for (const ticker of tickers) {
    try {
      const res = await fetch(`${KALSHI_REST_BASE}/markets/${ticker}`);
      if (res.status === 429) {
        // Datacenter IPs get throttled — back off hard, skip this ticker
        // (it'll be retried on the next 20-min cycle).
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
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
    await new Promise((r) => setTimeout(r, 200)); // rate limit — gentle on datacenter IPs
  }
  if (updated > 0) console.log(`[meta] refreshed ${updated}/${tickers.length} active tickers`);
}, 20 * 60 * 1000);

// Periodic maker-order reconciler: every 2 minutes, promote filled resting
// orders to held positions and cancel any that have rested past their TTL.
// No-op when makerMode is off.
setInterval(async () => {
  try {
    const { filled, canceled } = await autoTrader.checkOpenOrders();
    if (filled || canceled) console.log(`[auto-trader] reconcile: ${filled} filled, ${canceled} canceled`);
  } catch (err) {
    console.error('[auto-trader] open-order reconcile error:', err.message);
  }
}, 2 * 60 * 1000);

// Periodic stop-loss check: every 3 minutes, scan open positions for those
// where the current bid has fallen ≥ stopLossCents below our entry. Closes
// the position via SELL order to cap the loss.
// Gated by liveTradingAllowed: checkStopLosses() places a live taker SELL, and
// it only checks stopLossEnabled internally (not `enabled`), so without this
// gate a disarmed-on-live trader could still place real-money orders. Demo and
// confirmed-live run normally; unconfirmed live positions ride to settlement.
setInterval(async () => {
  if (!liveTradingAllowed) return;
  try {
    const { closed } = await autoTrader.checkStopLosses();
    if (closed > 0) console.log(`[auto-trader] stop-loss closed ${closed} positions`);
  } catch (err) {
    console.error('[auto-trader] stop-loss check error:', err.message);
  }
}, 3 * 60 * 1000);

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

// Periodic cross-venue arb scan: every 5 minutes, compare recent Kalshi vs
// Polymarket last-trade prices for the same event and email candidates with a
// net edge after the Kalshi taker fee. Detection only — never places orders.
// Prod-data only (demo has no real cross-venue overlap); ARB_SCAN_ENABLED=false disables.
const arbAlerted = new Map(); // pairKey → last alert ms (suppress repeats for 6h)
if (!DATA_IS_DEMO && process.env.ARB_SCAN_ENABLED !== 'false') setInterval(async () => {
  try {
    const { candidates } = scanForArbs({
      windowHours: Number(process.env.ARB_WINDOW_HOURS ?? 6),
      minNetCents: Number(process.env.ARB_MIN_NET_CENTS ?? 4),
      matchThreshold: Number(process.env.ARB_MATCH_THRESHOLD ?? 0.7),
    });
    for (const c of candidates) {
      const key = `${c.kalshiTicker}|${c.polyTicker}`;
      const last = arbAlerted.get(key) ?? 0;
      if (Date.now() - last < 6 * 3600_000) continue;
      arbAlerted.set(key, Date.now());
      console.log(`[arb] 💹 ${c.netCents}¢ net: ${c.kalshiTicker} ↔ ${c.polyTicker} (${c.direction})`);
      notifyArb(c).catch((err) => console.error('[arb] email error:', err.message));
    }
  } catch (err) {
    console.error('[arb] scan error:', err.message);
  }
}, 5 * 60 * 1000);

// Periodic title backfill: every 5 minutes, fetch titles for any tickers that arrived since startup.
// Uses direct /markets/{ticker} endpoint which always has the title (event endpoint may not).
if (!DATA_IS_DEMO) setInterval(async () => {
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

// NOTE: we intentionally do NOT seed market_titles from the full Kalshi
// /markets catalog. That crawl (fetchAllMarketTitles) pulls *every* market the
// exchange has ever listed — dominated by KXMVE* multivariate/parlay combos,
// a combinatorial explosion that bloated market_titles to ~12M orphan rows
// (≈99.9% never referenced by a trade) and a multi-GB DB file. Titles are
// instead populated on demand, bounded by actual trade flow, by the per-ticker
// backfill below + the periodic backfill loop (getMissingTitleTickers →
// fetchTitlesByTickers). A newly-traded ticker gets its title within ~5 min.

// Backfill titles for any tickers missing them via direct /markets/{ticker} endpoint.
// Skipped in demo (empty list) — avoids a startup burst of prod-ticker fetches at the demo API.
const missingTickers = DATA_IS_DEMO ? [] : getMissingTitleTickers();
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

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `🚨 [server] port ${PORT} is already in use — another whale-tracker instance ` +
      `(live or demo) is likely bound here. Refusing to start to avoid a silent ` +
      `live/demo mix-up. Give this instance a distinct PORT (live and demo must differ).`
    );
    process.exit(1);
  }
  throw err;
}
console.log(`[server] listening on http://localhost:${PORT}  (${IS_DEMO ? 'DEMO / paper money' : 'LIVE / real money'})`);
console.log(`[server] browser WebSocket → ws://localhost:${PORT}/ws`);

process.on('SIGINT', () => {
  kalshi.destroy();
  app.close(() => process.exit(0));
});
