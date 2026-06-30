// backtest.js — deterministic edge backtester over settled whale trades (#3).
//
// The trustworthy, LLM-free core the edge-research agent queries. For every
// settled Kalshi trade in the DB it knows the entry price, the side, and the
// resolved outcome — so it can compute what BUYING at that price actually
// returned (hold-to-settlement), sliced by whatever dimension you ask for.
//
// "Edge" here = mean realized profit per contract (pre-fee cents). Positive ⇒
// buying that slice historically paid; we also report the figure after an
// estimated Kalshi maker fee. CAVEAT: the DB is whale-only (>= $10k, < 95c), so
// this is the edge conditioned on big-money flow, not the whole market.
import { getDb } from './db.js';

// Inclusive cent bands; tuned around the favorites zone the trader cares about.
const PRICE_BANDS = [[1, 49], [50, 63], [64, 69], [70, 77], [78, 83], [84, 89], [90, 94], [95, 99]];
const bandOf = (p) => { for (const [lo, hi] of PRICE_BANDS) if (p >= lo && p <= hi) return `${lo}-${hi}c`; return '?'; };

// Kalshi fee ≈ 0.07 · C · P · (1−P) (P in dollars). Per contract, in cents:
const feeCents = (price) => 7 * (price / 100) * (1 - price / 100);

/**
 * Slice settled trades and report realized edge per slice.
 * @param {object} o
 * @param {'price_band'|'category'|'side'|'series'} [o.groupBy]
 * @param {string|null}  [o.category]      filter to one category
 * @param {string|null}  [o.seriesPrefix]  filter to a ticker prefix (e.g. 'KXUFCFIGHT')
 * @param {'yes'|'no'|null} [o.side]
 * @param {number} [o.minPrice] [o.maxPrice]  entry-price filter (cents)
 * @param {number} [o.minSampleN]  drop slices with fewer than this many trades
 */
export function runBacktest({
  groupBy = 'price_band', category = null, seriesPrefix = null, side = null,
  minPrice = 1, maxPrice = 99, minSampleN = 30,
} = {}) {
  const db = getDb();
  if (!db) return { error: 'DB not initialised' };

  let where = "source = 'kalshi' AND outcome IN ('yes','no') AND yes_price BETWEEN 1 AND 99";
  const params = [];
  if (category)     { where += ' AND category = ?';  params.push(category); }
  if (side)         { where += ' AND side = ?';      params.push(side); }
  if (seriesPrefix) { where += ' AND ticker LIKE ?'; params.push(seriesPrefix + '%'); }

  const rows = db.prepare(
    `SELECT ticker, category, side, yes_price, no_price, count, outcome FROM trades WHERE ${where}`
  ).all(...params);

  const groups = new Map();
  let kept = 0;
  for (const r of rows) {
    const price = r.side === 'yes' ? r.yes_price : r.no_price;
    if (!Number.isFinite(price) || price < minPrice || price > maxPrice) continue;
    const won    = r.side === r.outcome ? 1 : 0;
    const profit = won ? (100 - price) : -price;             // pre-fee cents / contract
    const key =
      groupBy === 'category' ? (r.category || 'Unknown') :
      groupBy === 'side'     ? r.side :
      groupBy === 'series'   ? (r.ticker.split('-')[0]) :
                               bandOf(price);
    let g = groups.get(key);
    if (!g) { g = { key, n: 0, contracts: 0, wins: 0, sumP: 0, sumProfit: 0, sumPost: 0 }; groups.set(key, g); }
    g.n++; g.contracts += (r.count || 1); g.wins += won;
    g.sumP += price; g.sumProfit += profit; g.sumPost += (profit - feeCents(price));
    kept++;
  }

  const slices = [...groups.values()]
    .filter((g) => g.n >= minSampleN)
    .map((g) => ({
      group: g.key,
      n: g.n,
      contracts: g.contracts,
      win_rate: +(g.wins / g.n).toFixed(3),
      avg_price: +(g.sumP / g.n).toFixed(1),
      mean_profit_cents: +(g.sumProfit / g.n).toFixed(2),   // realized edge, pre-fee
      mean_postfee_cents: +(g.sumPost / g.n).toFixed(2),    // after est. maker fee
    }))
    .sort((a, b) => b.mean_postfee_cents - a.mean_postfee_cents);

  return {
    dimension: groupBy,
    filters: { category, seriesPrefix, side, minPrice, maxPrice, minSampleN },
    total_trades: kept,
    slice_count: slices.length,
    slices,
  };
}

/**
 * Review the AUTO-TRADER'S OWN settled bets (auto_orders), so the daily agent
 * can see how its real configuration performed — not just historical whale
 * flow. Realized P&L is pnl_cents per order. Broken out by side and price band.
 */
export function reviewBets({ sinceDays = 30 } = {}) {
  const db = getDb();
  if (!db) return { error: 'DB not initialised' };
  const sinceIso = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT side, entry_price, count, status, outcome, pnl_cents FROM auto_orders WHERE placed_ts >= ?`
  ).all(sinceIso);

  const settled = rows.filter((r) => r.pnl_cents != null);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const agg = (keyFn) => {
    const m = new Map();
    for (const r of settled) {
      const k = keyFn(r);
      let g = m.get(k);
      if (!g) { g = { group: k, n: 0, pnl: 0, wins: 0 }; m.set(k, g); }
      g.n++; g.pnl += r.pnl_cents; if (r.pnl_cents > 0) g.wins++;
    }
    return [...m.values()]
      .map((g) => ({ group: g.group, n: g.n, win_rate: +(g.wins / g.n).toFixed(3),
                     total_pnl_cents: g.pnl, mean_pnl_cents: +(g.pnl / g.n).toFixed(2) }))
      .sort((a, b) => a.mean_pnl_cents - b.mean_pnl_cents); // worst first
  };

  return {
    window_days: sinceDays,
    total_orders: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    overall: settled.length
      ? { total_pnl_cents: sum(settled.map((r) => r.pnl_cents)),
          win_rate: +(settled.filter((r) => r.pnl_cents > 0).length / settled.length).toFixed(3),
          mean_pnl_cents: +(sum(settled.map((r) => r.pnl_cents)) / settled.length).toFixed(2) }
      : null,
    by_side: agg((r) => r.side),
    by_price_band: agg((r) => bandOf(r.entry_price)),
    note: settled.length < 30
      ? 'Few settled own-bets in window — lean on query_backtest (historical whale edge) for guidance, widen sinceDays, and treat own-bet stats as preliminary.'
      : undefined,
  };
}
