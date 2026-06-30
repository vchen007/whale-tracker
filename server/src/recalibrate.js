// recalibrate.js — adaptive EV-gate calibration (#2).
//
// Re-fits the favorite–longshot curve (alpha/psi) from the settled trades in the
// local DB and, WITHIN GUARDRAILS, applies it to the live trader by writing
// calibration.json and asking the running server to hot-reload it. Emails the
// outcome either way.
//
//   node server/src/recalibrate.js            # fit, guardrail, apply-or-hold, notify
//   node server/src/recalibrate.js --dry-run  # fit + print only; never writes/applies
//
// Guardrails (operator chose: auto-apply within bounds, hold large jumps):
//   - MIN_N settled trades required, else abort (unstable fit).
//   - alpha/psi must land inside absolute sanity bounds, else HOLD.
//   - step from the currently-applied values is capped; bigger jump ⇒ HOLD for
//     review (e.g. the initial move off the paper default). Held proposals are
//     emailed but NOT applied.
// Scheduled weekly via ~/Library/LaunchAgents/com.whaletracker.recalibrate.plist.
import './loadEnv.js';
import { initDb } from './db.js';
import { DATA_IS_DEMO } from './kalshiEnv.js';
import { fitCalibration, loadCalibration, saveCalibration, PAPER_CALIBRATION } from './calibration.js';
import { notifyCalibration } from './notify.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Guardrails ────────────────────────────────────────────────────────────────
const MIN_N          = 5000;          // settled trades needed for a stable fit
const ALPHA_BOUNDS   = [-6, 1];       // sane range for the intercept
const PSI_BOUNDS     = [0, 0.12];     // slope must be non-negative, not wild
const MAX_STEP_ALPHA = 1.0;           // max |Δalpha| auto-applied per run
const MAX_STEP_PSI   = 0.02;          // max |Δpsi|   auto-applied per run

const round = (x, d = 4) => Number(x.toFixed(d));

async function main() {
  if (DATA_IS_DEMO) {
    console.error('[recalibrate] refusing to fit against DEMO data (prod tickers needed). Abort.');
    process.exit(1);
  }

  const db  = initDb();
  const fit = fitCalibration(db);
  console.log(`[recalibrate] fit: n=${fit.n} alpha=${fit.alpha?.toFixed(3)} psi=${fit.psi?.toFixed(4)}`);

  // Baseline = what the trader is using now: persisted file → env → paper.
  const persisted = loadCalibration();
  const envAlpha  = Number(process.env.AUTO_TRADER_CALIBRATION_ALPHA);
  const envPsi    = Number(process.env.AUTO_TRADER_CALIBRATION_PSI);
  const current = persisted
    ?? (Number.isFinite(envAlpha) && Number.isFinite(envPsi) ? { alpha: envAlpha, psi: envPsi } : PAPER_CALIBRATION);

  // ── Decide: apply / hold / abort ───────────────────────────────────────────
  let status, reason;
  if (!fit.n || fit.n < MIN_N || fit.alpha == null) {
    status = 'abort';
    reason = `only ${fit.n} settled trades (need ${MIN_N}) — fit too unstable.`;
  } else if (fit.alpha < ALPHA_BOUNDS[0] || fit.alpha > ALPHA_BOUNDS[1] ||
             fit.psi   < PSI_BOUNDS[0]   || fit.psi   > PSI_BOUNDS[1]) {
    status = 'hold';
    reason = `fit out of sanity bounds (alpha∈[${ALPHA_BOUNDS}], psi∈[${PSI_BOUNDS}]) — not applied.`;
  } else {
    const dA = Math.abs(fit.alpha - current.alpha);
    const dP = Math.abs(fit.psi - current.psi);
    if (dA > MAX_STEP_ALPHA || dP > MAX_STEP_PSI) {
      status = 'hold';
      reason = `change exceeds step cap (Δalpha=${dA.toFixed(3)}>${MAX_STEP_ALPHA} or Δpsi=${dP.toFixed(4)}>${MAX_STEP_PSI}) — held for review.`;
    } else {
      status = 'apply';
      reason = `within bounds and step caps (Δalpha=${dA.toFixed(3)}, Δpsi=${dP.toFixed(4)}).`;
    }
  }

  const proposal = { alpha: round(fit.alpha), psi: round(fit.psi, 4), n: fit.n };
  console.log(`[recalibrate] current α=${current.alpha} ψ=${current.psi} → proposed α=${proposal.alpha} ψ=${proposal.psi}`);
  console.log(`[recalibrate] decision: ${status.toUpperCase()} — ${reason}`);

  const report = {
    status, reason, proposal, current,
    fittedAt: new Date().toISOString(),
    n: fit.n, source: 'auto-fit (whale-only sample)',
  };

  if (DRY_RUN) {
    console.log('[recalibrate] --dry-run: no file written, no apply, no email.');
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (status === 'apply') {
    saveCalibration({
      alpha: proposal.alpha, psi: proposal.psi, n: fit.n,
      fittedAt: report.fittedAt, source: report.source,
      prev: { alpha: current.alpha, psi: current.psi },
    });
    console.log('[recalibrate] calibration.json updated; asking live servers to hot-reload…');
    await triggerReload();
  }

  // Always notify (applied / held / aborted), so the operator stays informed.
  try { await notifyCalibration(report); }
  catch (e) { console.error('[recalibrate] notify failed:', e.message); }
}

// Best-effort hot-reload of the running servers (live :3002 + demo :3001).
async function triggerReload() {
  const token = process.env.AUTH_TOKEN;
  for (const port of [3002, 3001]) {
    try {
      const res = await fetch(`http://localhost:${port}/auto-trader/reload-calibration`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`[recalibrate] reload :${port} → HTTP ${res.status} ${res.ok ? (await res.text()) : ''}`);
    } catch (e) {
      console.log(`[recalibrate] reload :${port} skipped (${e.message})`);
    }
  }
}

main().catch((e) => { console.error('[recalibrate] fatal:', e); process.exit(1); });
