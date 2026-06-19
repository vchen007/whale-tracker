// Backfill settlement outcomes for Kalshi trades in the local DB, then
// optionally fit a favorite–longshot calibration curve from the settled data.
//
//   npm run backfill:outcomes                 # backfill everything unsettled
//   node server/src/backfillOutcomes.js --limit 50      # smoke test
//   node server/src/backfillOutcomes.js --fit            # fit only (no fetch)
//
// For each distinct ticker with outcome IS NULL, fetches the market from the
// Kalshi REST API (unauthenticated endpoint) and, if settled, stamps `result`
// ('yes'/'no') onto all that ticker's trade rows. Resumable: re-running only
// touches still-NULL tickers. Markets still open simply stay NULL.
//
// Run against PROD data (don't use ENV_FILE=.env.demo — the tickers are prod).
import './loadEnv.js';
import { initDb } from './db.js';
import { KALSHI_REST_BASE, DATA_IS_DEMO } from './kalshiEnv.js';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const FIT_ONLY = args.includes('--fit') && limitIdx < 0 && !args.includes('--fetch');
const DELAY_MS = 250;          // ~4 req/s — polite to datacenter-IP throttling
const BACKOFF_429_MS = 5000;

if (DATA_IS_DEMO) {
  console.error('Refusing to backfill against the DEMO API — these are prod tickers. Run without ENV_FILE=.env.demo.');
  process.exit(1);
}

const db = initDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backfill() {
  // Newest first: recently-traded markets settle within days and are still
  // queryable; months-old tickers are largely delisted (404) on the v2 API.
  const tickers = db.prepare(`
    SELECT ticker, MAX(ts_ms) AS last_ms FROM trades
    WHERE source = 'kalshi' AND outcome IS NULL
    GROUP BY ticker ORDER BY last_ms DESC
  `).all().map((r) => r.ticker);

  const todo = Number.isFinite(LIMIT) ? tickers.slice(0, LIMIT) : tickers;
  console.log(`[backfill] ${tickers.length} unsettled tickers; processing ${todo.length} (newest first)`);

  const stamp = db.prepare(`UPDATE trades SET outcome = ? WHERE ticker = ? AND source = 'kalshi'`);
  let settled = 0, open = 0, missing = 0, errors = 0, i = 0;

  for (const ticker of todo) {
    i++;
    try {
      const res = await fetch(`${KALSHI_REST_BASE}/markets/${ticker}`);
      if (res.status === 429) {
        await sleep(BACKOFF_429_MS);
        errors++;
        continue; // picked up on the next run (still NULL)
      }
      if (res.status === 404) { missing++; await sleep(DELAY_MS); continue; }
      if (!res.ok) { errors++; await sleep(DELAY_MS); continue; }
      const m = (await res.json()).market ?? {};
      if ((m.status === 'settled' || m.status === 'finalized') && (m.result === 'yes' || m.result === 'no')) {
        stamp.run(m.result, ticker);
        settled++;
      } else {
        open++;
      }
    } catch {
      errors++;
    }
    if (i % 200 === 0) console.log(`[backfill] ${i}/${todo.length} — settled ${settled}, open ${open}, missing ${missing}, errors ${errors}`);
    await sleep(DELAY_MS);
  }
  console.log(`[backfill] done: ${settled} tickers stamped, ${open} still open, ${missing} 404, ${errors} errors`);
}

// OLS fit of pre-fee profit (cents) = alpha + psi · price (cents) on settled
// rows — the same Mincer-Zarnowitz form as the paper (alpha=-1.736, psi=0.034
// full-sample). CAVEAT: this DB holds WHALE trades only (>= $10k notional,
// price < 95c), so the fit is conditioned on big-money trades, not the whole
// market. Compare shape, not just point values.
function fit() {
  const rows = db.prepare(`
    SELECT side, yes_price, no_price, outcome FROM trades
    WHERE source = 'kalshi' AND outcome IN ('yes','no')
      AND yes_price BETWEEN 1 AND 99
  `).all();
  if (rows.length < 1000) {
    console.log(`[fit] only ${rows.length} settled trades — too few for a stable fit; backfill more first.`);
    return;
  }
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of rows) {
    const price = r.side === 'yes' ? r.yes_price : r.no_price;
    if (!price || price < 1 || price > 99) continue;
    const won = r.side === r.outcome ? 1 : 0;
    const profit = won ? 100 - price : -price; // cents, pre-fee
    n++; sx += price; sy += profit; sxx += price * price; sxy += price * profit;
  }
  const psi = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const alpha = sy / n - psi * (sx / n);
  console.log(`[fit] n=${n} settled whale trades`);
  console.log(`[fit] your curve:  alpha=${alpha.toFixed(3)}, psi=${psi.toFixed(4)}   (profit_cents ≈ alpha + psi·price)`);
  console.log('[fit] paper curve: alpha=-1.736, psi=0.0340   (full-market sample, 2021–Apr 2025)');
  console.log('[fit] to apply yours: AUTO_TRADER_CALIBRATION_ALPHA / AUTO_TRADER_CALIBRATION_PSI in .env');
  console.log('[fit] caveat: whale-only sample (>=$10k notional, <95c) — biased vs the full market.');
}

if (FIT_ONLY) {
  fit();
} else {
  await backfill();
  fit();
}
