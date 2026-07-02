import { Resend } from 'resend';
import { IS_DEMO } from './kalshiEnv.js';

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

// Account tag so every email makes it unmistakable whether real money moved.
const ENV_TAG   = IS_DEMO ? 'DEMO' : 'LIVE';
const ENV_BADGE = IS_DEMO
  ? '<span style="background:#fde68a;color:#92400e;padding:2px 8px;border-radius:4px;font-weight:bold">DEMO · paper money</span>'
  : '<span style="background:#fecaca;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:bold">LIVE · real money</span>';

const td  = 'padding:4px 12px 4px 0';
const row = (k, v, style = '') => `<tr><td style="${td}"><b>${k}</b></td><td style="${style}">${v}</td></tr>`;
const side = (e) => (e.side ? e.side.toUpperCase() : '');

/**
 * Build the {subject, html} for a trade notification email. Pure (no I/O) so it
 * can be unit-tested. Classifies the AutoTrader log entry into one of:
 * kill-switch, sell/close, placed-or-resting, or failure.
 */
export function buildTradeEmail(entry) {
  let subject, heading, emoji, rows;

  // 1) Daily-loss kill-switch
  if (entry.ticker === 'KILL_SWITCH' || entry.status === 'killed' || entry.action === 'disable') {
    emoji   = '🚨';
    subject = '🚨 Auto-trader DISABLED — daily-loss kill-switch';
    heading = 'Daily-loss kill-switch tripped — auto-trader disabled';
    rows = [
      row('Reason', entry.reason ?? 'max_daily_loss'),
      row('Realized today', `${entry.pnlCents ?? 0}¢`, (entry.pnlCents ?? 0) < 0 ? 'color:red' : ''),
      row('Time', entry.ts),
    ];

  // 1b) Maker order filled (resting → held position)
  } else if (entry.action === 'fill') {
    emoji   = '🎯';
    subject = `🎯 Filled ${entry.ticker} ${side(entry)} @ ${entry.price}¢`;
    heading = 'Maker order filled — position now open';
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Entry', `${entry.price}¢`),
      row('Contracts', entry.count),
      row('Time', entry.ts),
    ];

  // 1c) Position settled at market resolution
  } else if (entry.action === 'settle') {
    const won = entry.outcome === 'win';
    emoji   = won ? '🏆' : '💸';
    subject = `${emoji} ${won ? 'WIN' : 'LOSS'} ${entry.ticker} ${side(entry)} (${entry.pnlCents >= 0 ? '+' : ''}${entry.pnlCents}¢)`;
    heading = `Position settled — ${won ? 'WIN' : 'LOSS'}`;
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Entry', `${entry.price}¢`),
      row('Contracts', entry.count),
      row('P&L', `${entry.pnlCents >= 0 ? '+' : ''}${entry.pnlCents}¢`, won ? 'color:green' : 'color:red'),
      row('Time', entry.ts),
    ];

  // 2) Position close / sell (incl. stop-loss) — taker exit
  } else if (entry.action === 'sell') {
    const ok = entry.status === 'closed_early';
    emoji   = ok ? '🛑' : '❌';
    subject = ok
      ? `🛑 Closed ${entry.ticker} ${side(entry)} (${entry.pnlCents >= 0 ? '+' : ''}${entry.pnlCents}¢)`
      : `❌ Close failed: ${entry.ticker} ${side(entry)}`;
    heading = ok ? `Position closed (${entry.reason ?? 'manual'})` : 'Failed to close position';
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Entry → Sell', `${entry.entryPrice}¢ → ${entry.price}¢`),
      row('Contracts', entry.count),
      ok
        ? row('P&L', `${entry.pnlCents >= 0 ? '+' : ''}${entry.pnlCents}¢`, entry.pnlCents >= 0 ? 'color:green' : 'color:red')
        : row('Error', entry.error ?? 'unknown', 'color:red'),
      ok && entry.exitFee != null ? row('Taker exit fee', `~$${Number(entry.exitFee).toFixed(2)}`) : '',
      row('Time', entry.ts),
    ];

  // 2b) Fill-verification against /portfolio/positions
  } else if (entry.action === 'unfilled' || entry.action === 'drift') {
    const phantom = entry.action === 'unfilled';
    emoji   = phantom ? '👻' : '⚠️';
    subject = phantom
      ? `👻 Unfilled ${entry.ticker} ${side(entry)} — no account position`
      : `⚠️ Position drift ${entry.ticker} ${side(entry)}`;
    heading = phantom
      ? 'Recorded fill not found on account — marked unfilled'
      : 'Account position disagrees with recorded orders';
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Price', `${entry.price}¢`),
      row('Contracts', entry.count),
      row('Detail', entry.status ?? '—', 'color:red'),
      row('Time', entry.ts),
    ];

  // 3) Order accepted — taker fill ('placed') or maker order resting ('resting')
  } else if (entry.status === 'placed' || entry.status === 'resting') {
    const resting = entry.status === 'resting';
    emoji   = resting ? '🟡' : '✅';
    subject = `${emoji} ${resting ? 'Resting' : 'Placed'} ${entry.ticker} ${side(entry)} @ ${entry.price}¢`;
    heading = resting ? 'Maker order resting (awaiting fill)' : 'Order placed';
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Price', `${entry.price}¢` + (entry.role === 'maker' && entry.whalePrice ? ` · maker (whale ${entry.whalePrice}¢)` : '')),
      row('Contracts', entry.count),
      entry.estFee != null ? row('Est. fee', `$${Number(entry.estFee).toFixed(2)}`) : '',
      entry.via ? row('Via', entry.via) : '',
      row('Order ID', entry.orderId ?? '—'),
      row('Time', entry.ts),
    ];

  // 4) Failure (failed / error)
  } else {
    emoji   = '❌';
    subject = `❌ Order failed: ${entry.ticker} ${side(entry)} @ ${entry.price}¢`;
    heading = 'Order failed';
    rows = [
      row('Market', entry.ticker),
      row('Side', side(entry)),
      row('Price', `${entry.price}¢`),
      row('Error', entry.error ?? 'unknown', 'color:red'),
      row('Time', entry.ts),
    ];
  }

  const html =
    `<div style="font-family:sans-serif;max-width:480px">` +
      `<div style="margin-bottom:10px">${ENV_BADGE}</div>` +
      `<h2 style="margin:0 0 8px">${emoji} ${heading}</h2>` +
      `<table style="font-family:monospace;border-collapse:collapse">${rows.filter(Boolean).join('')}</table>` +
    `</div>`;

  // The account tag leads the subject so it's visible in every inbox preview.
  return { subject: `[${ENV_TAG}] ${subject}`, html };
}

/**
 * Send an email notification after an auto-trader event (order, close, kill-switch).
 * @param {object} entry - log entry from AutoTrader
 */
export async function notifyTrade(entry) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping email');
    return;
  }

  const { subject, html } = buildTradeEmail(entry);
  const TO   = process.env.NOTIFY_EMAIL ?? 'claude_bot23@proton.me';
  const FROM = process.env.NOTIFY_FROM  ?? 'Whale Tracker <onboarding@resend.dev>';

  try {
    await getResend().emails.send({ from: FROM, to: TO, subject, html });
  } catch (err) {
    console.error('[notify] email error:', err.message);
  }
}

/**
 * Email the outcome of an adaptive-calibration run (#2): applied, held for
 * review, or aborted. `report` is the object built by recalibrate.js.
 */
export async function notifyCalibration(report) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping calibration email');
    return;
  }
  const TO   = process.env.NOTIFY_EMAIL ?? 'claude_bot23@proton.me';
  const FROM = process.env.NOTIFY_FROM  ?? 'Whale Tracker <onboarding@resend.dev>';

  const icon = report.status === 'apply' ? '✅ APPLIED'
             : report.status === 'hold'  ? '⏸️ HELD for review'
             : '🚫 ABORTED';
  const { proposal: p, current: c } = report;
  const subject = `[${ENV_TAG}] Calibration ${report.status === 'apply' ? 'updated' : report.status} — α=${p.alpha} ψ=${p.psi}`;
  const html = `
    <div style="font-family:system-ui,sans-serif">
      <p>${ENV_BADGE} &nbsp; <b>EV-gate calibration: ${icon}</b></p>
      <table style="border-collapse:collapse">
        ${row('Decision', `${report.status} — ${report.reason}`)}
        ${row('Proposed (whale fit)', `α=${p.alpha}, ψ=${p.psi}  (n=${p.n} settled)`)}
        ${row('Current (in use)',     `α=${c.alpha}, ψ=${c.psi}`)}
        ${row('Sample',  report.source)}
        ${row('When',    report.fittedAt)}
      </table>
      ${report.status === 'hold'
        ? `<p style="color:#92400e">Not applied. To accept, set these in calibration.json (or reply to apply):<br>
           <code>{"alpha": ${p.alpha}, "psi": ${p.psi}, "n": ${p.n}}</code></p>`
        : ''}
    </div>`;

  try {
    await getResend().emails.send({ from: FROM, to: TO, subject, html });
  } catch (err) {
    console.error('[notify] calibration email error:', err.message);
  }
}

/**
 * Email the strategy knob changes the daily agent applied (or tried to).
 * `report.applied` is a map of knob → setParam result.
 */
export async function notifyStrategyChange(report) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping strategy email');
    return;
  }
  const TO   = process.env.NOTIFY_EMAIL ?? 'claude_bot23@proton.me';
  const FROM = process.env.NOTIFY_FROM  ?? 'Whale Tracker <onboarding@resend.dev>';

  const rows = Object.entries(report.applied || {}).map(([k, r]) =>
    r.ok ? row(k, `${r.prev} → <b>${r.now}</b>  ✅`)
         : row(k, `<span style="color:#991b1b">unchanged — ${r.reason}</span>`)).join('');
  const nApplied = Object.values(report.applied || {}).filter((r) => r.ok).length;
  const subject = `[${ENV_TAG}] Daily strategy agent — ${nApplied} change${nApplied === 1 ? '' : 's'} applied`;
  const html = `
    <div style="font-family:system-ui,sans-serif">
      <p>${ENV_BADGE} &nbsp; <b>Daily strategy review — ${nApplied} knob change(s) applied</b></p>
      ${report.reason ? `<p><i>${report.reason}</i></p>` : ''}
      <table style="border-collapse:collapse">${rows}</table>
      <p style="color:#666;font-size:12px">Risk caps (capital, daily-loss, position limits) are not agent-tunable.</p>
    </div>`;
  try {
    await getResend().emails.send({ from: FROM, to: TO, subject, html });
  } catch (err) {
    console.error('[notify] strategy email error:', err.message);
  }
}
