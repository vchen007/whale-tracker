// Shared favorite–longshot calibration helpers.
//
// The EV gate converts a market price into a calibrated win probability via
//   q = (P + alpha + psi·P) / 100
// with alpha/psi from a Mincer-Zarnowitz fit (paper default: -1.736 / 0.034).
//
// This module is the single source of truth for (a) FITTING alpha/psi from the
// settled trades in the local DB, and (b) PERSISTING the live-applied values to
// calibration.json so the auto-trader can adapt without an .env edit + restart.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
// Project root (…/whale-tracker/whale-tracker), sibling of server/.
export const CALIBRATION_PATH = resolve(here, '../../calibration.json');

export const PAPER_CALIBRATION = { alpha: -1.736, psi: 0.034 };

/**
 * OLS fit of pre-fee profit (cents) = alpha + psi·price (cents) over settled
 * trades — same Mincer-Zarnowitz form as the paper. CAVEAT: the DB holds
 * WHALE trades only (>= $10k notional, price < 95c), so the fit is conditioned
 * on big-money flow, biased vs the whole market. Returns { n, alpha, psi }.
 */
export function fitCalibration(db) {
  const rows = db.prepare(`
    SELECT side, yes_price, no_price, outcome FROM trades
    WHERE source = 'kalshi' AND outcome IN ('yes','no')
      AND yes_price BETWEEN 1 AND 99
  `).all();
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const r of rows) {
    const price = r.side === 'yes' ? r.yes_price : r.no_price;
    if (!price || price < 1 || price > 99) continue;
    const won = r.side === r.outcome ? 1 : 0;
    const profit = won ? 100 - price : -price; // cents, pre-fee
    n++; sx += price; sy += profit; sxx += price * price; sxy += price * profit;
  }
  if (n < 2) return { n, alpha: null, psi: null };
  const psi = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const alpha = sy / n - psi * (sx / n);
  return { n, alpha, psi };
}

/** Read the persisted live calibration, or null if absent/invalid. */
export function loadCalibration() {
  try {
    if (!existsSync(CALIBRATION_PATH)) return null;
    const j = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8'));
    if (Number.isFinite(j.alpha) && Number.isFinite(j.psi)) return j;
  } catch { /* fall through */ }
  return null;
}

/** Persist the live-applied calibration (pretty-printed for auditability). */
export function saveCalibration(obj) {
  writeFileSync(CALIBRATION_PATH, JSON.stringify(obj, null, 2) + '\n');
}
