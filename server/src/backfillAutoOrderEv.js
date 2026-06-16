// Backfill the deterministically-recoverable economics columns on auto_orders
// rows left NULL by older code (before role/est_q/est_net_ev/sold_price existed).
//
//   node server/src/backfillAutoOrderEv.js --dry-run     # show what would change
//   node server/src/backfillAutoOrderEv.js               # apply
//   ENV_FILE=.env.demo node server/src/backfillAutoOrderEv.js --dry-run   # demo DB
//
// What it can recover, and why each is honest (no fabrication):
//   - est_q       = calibratedWinProb(entry_price). Pure function of entry price
//                   (favorite–longshot bucket); identical to what the trader
//                   would have stamped at placement. Role-independent.
//   - est_net_ev  = calibratedEvDollars(entry_price, count, {isSports}). Under
//                   the current 0.07 maker == 0.07 taker fee schedule the fee —
//                   and therefore EV — is role-independent, so this is exact
//                   regardless of whether the historical fill was maker or taker.
//   - sold_price  = entry_price + round(pnl_cents / count) for closed_early rows.
//                   Inverts the stored P&L identity pnl = (sold − entry)·count.
//
// What it deliberately does NOT touch:
//   - role: the maker/taker label and the prevailing ask at placement were never
//     stored for these legacy rows and cannot be reconstructed. Left NULL rather
//     than guessed. (New orders capture role at placement — see autoTrader.js.)
//
// Reuses the SAME calibration/EV functions the trader uses (single source of
// truth) and the SAME env-driven params index.js passes to the AutoTrader.
import './loadEnv.js';
import { initDb } from './db.js';
import { calibratedWinProb, calibratedEvDollars } from '../../auto-trader/autoTrader.js';
import { categoryFromTicker } from './kalshiClient.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Mirror index.js's AutoTrader construction so backfilled values match what the
// live trader would have computed.
const calib = {
  alpha: Number(process.env.AUTO_TRADER_CALIBRATION_ALPHA ?? -1.736),
  psi:   Number(process.env.AUTO_TRADER_CALIBRATION_PSI ?? 0.034),
};
const makerFeeCoeff = Number(process.env.AUTO_TRADER_MAKER_FEE_COEFF ?? 0.07);

const db = initDb();

function backfill() {
  const rows = db.prepare(`
    SELECT client_order_id, ticker, entry_price, count, status, pnl_cents,
           est_q, est_net_ev, sold_price
    FROM auto_orders
    WHERE est_q IS NULL
       OR est_net_ev IS NULL
       OR (status = 'closed_early' AND sold_price IS NULL AND pnl_cents IS NOT NULL)
  `).all();

  const update = db.prepare(`
    UPDATE auto_orders
    SET est_q      = COALESCE(@est_q, est_q),
        est_net_ev = COALESCE(@est_net_ev, est_net_ev),
        sold_price = COALESCE(@sold_price, sold_price)
    WHERE client_order_id = @client_order_id
  `);

  let nQ = 0, nEv = 0, nSold = 0;
  const apply = db.transaction((items) => {
    for (const u of items) update.run(u);
  });

  const updates = [];
  for (const r of rows) {
    const isSports = categoryFromTicker(r.ticker) === 'Sports';
    const feeOpts  = { isSports, makerFeeCoeff, role: 'maker' };

    const estQ = r.est_q == null
      ? calibratedWinProb(r.entry_price, calib)
      : null;
    const estNetEv = r.est_net_ev == null
      ? calibratedEvDollars(r.entry_price, r.count, feeOpts, calib)
      : null;
    // pnl = (sold − entry)·count  ⇒  sold = entry + pnl/count (rounded to cents).
    const soldPrice = (r.status === 'closed_early' && r.sold_price == null && r.pnl_cents != null && r.count)
      ? Math.round(r.entry_price + r.pnl_cents / r.count)
      : null;

    if (estQ != null) nQ++;
    if (estNetEv != null) nEv++;
    if (soldPrice != null) nSold++;

    updates.push({
      client_order_id: r.client_order_id,
      est_q:      estQ,
      est_net_ev: estNetEv,
      sold_price: soldPrice,
    });
  }

  console.log(`auto_orders rows needing backfill: ${rows.length}`);
  console.log(`  est_q to set:      ${nQ}`);
  console.log(`  est_net_ev to set: ${nEv}`);
  console.log(`  sold_price to set: ${nSold}  (closed_early)`);

  // Show a few examples so the change is auditable before/after.
  for (const r of rows.slice(0, 5)) {
    const u = updates.find((x) => x.client_order_id === r.client_order_id);
    console.log(
      `  e.g. ${r.ticker} @${r.entry_price}¢ x${r.count} [${r.status}] → ` +
      `est_q=${u.est_q != null ? u.est_q.toFixed(5) : '(kept)'} ` +
      `est_net_ev=${u.est_net_ev != null ? u.est_net_ev.toFixed(5) : '(kept)'} ` +
      `sold_price=${u.sold_price != null ? u.sold_price : '(n/a)'}`
    );
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no rows written.');
    return;
  }
  apply(updates);
  console.log(`\nApplied. role left NULL on legacy rows (not reconstructable).`);
}

backfill();
