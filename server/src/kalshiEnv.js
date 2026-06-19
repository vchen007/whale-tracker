// ── Centralised Kalshi endpoint configuration ────────────────────────────────
//
// Switch the WHOLE bot to a different Kalshi environment with one env var — no
// code edits. To run against the demo (paper-money) environment:
//
//   KALSHI_API_BASE=https://demo-api.kalshi.co/trade-api/v2
//
// Advanced: route ONLY order placement to a different environment (e.g. keep
// real whale signals coming from prod, but place orders safely in demo) by
// setting KALSHI_TRADING_API_BASE instead. Note: maker-mode prices against the
// order's own environment book, so a near-empty demo book will make most maker
// orders skip — expect sparse activity when trading demo against prod signals.
//
// Demo requires DEMO API credentials (a separate key from prod). Set
// KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY(_PATH) to the demo key when pointing
// the trading base at demo.

// Ensure .env is loaded before we read process.env at module top-level.
import './loadEnv.js';

const PROD_REST = 'https://api.elections.kalshi.com/trade-api/v2';

const stripTrailingSlash = (b) => (b ? b.replace(/\/+$/, '') : b);

// Base for market data + the trade WebSocket (read-only observation of the market).
export const KALSHI_REST_BASE = stripTrailingSlash(process.env.KALSHI_API_BASE) || PROD_REST;

// Base for the auto-trader: order placement, portfolio, and the market/book
// lookups tied to our own orders. Defaults to the data base.
export const KALSHI_TRADING_BASE =
  stripTrailingSlash(process.env.KALSHI_TRADING_API_BASE) || KALSHI_REST_BASE;

// WebSocket base derived from the data REST base (https→wss, /v2→/ws/v2).
// KALSHI_WS_URL is honored only when KALSHI_API_BASE is NOT set, so an explicit
// environment switch via KALSHI_API_BASE always moves the WebSocket too (and a
// stale KALSHI_WS_URL pinned in .env doesn't silently keep it on prod).
const wsFromRest = KALSHI_REST_BASE.replace(/^http/, 'ws').replace('/trade-api/v2', '/trade-api/ws/v2');
export const KALSHI_WS_BASE =
  (process.env.KALSHI_WS_URL && !process.env.KALSHI_API_BASE)
    ? process.env.KALSHI_WS_URL
    : wsFromRest;

// True when the *trading* base targets the demo environment (no real money).
export const IS_DEMO = /demo/i.test(KALSHI_TRADING_BASE);

// True when the *data* base targets demo. Used to skip the bulk history /
// metadata / title backfill loops in demo — those iterate over prod tickers in
// the local DB and would hammer the demo API with 429s for no benefit.
export const DATA_IS_DEMO = /demo/i.test(KALSHI_REST_BASE);

export function logKalshiEnv() {
  console.log(`[kalshi] data REST:    ${KALSHI_REST_BASE}`);
  console.log(`[kalshi] trading REST: ${KALSHI_TRADING_BASE}  ${IS_DEMO ? '⚠️  DEMO (paper money)' : '💰 LIVE (real money)'}`);
  console.log(`[kalshi] WebSocket:    ${KALSHI_WS_BASE}`);
}
