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
 * Email a cross-venue arbitrage candidate (detection only — nothing executed).
 * Subject leads with [ARB] (distinct from the [DEMO]/[LIVE] trade tags since
 * this concerns market data, not an account action).
 */
export async function notifyArb(c) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping arb email');
    return;
  }
  const subject = `[ARB] 💹 ${c.netCents}¢ net gap — ${c.kalshiTicker}`;
  const html =
    `<div style="font-family:sans-serif;max-width:520px">` +
      `<div style="margin-bottom:10px"><span style="background:#ddd6fe;color:#5b21b6;padding:2px 8px;border-radius:4px;font-weight:bold">ARB · cross-venue candidate</span></div>` +
      `<h2 style="margin:0 0 8px">💹 ${c.grossCents}¢ gross / ${c.netCents}¢ net per $1</h2>` +
      `<table style="font-family:monospace;border-collapse:collapse">` +
        row('Kalshi', `${c.kalshiTicker} — ${c.kalshiTitle} (YES ${c.kalshiYesCents}¢, ${c.kalshiAgeMin}m old)`) +
        row('Polymarket', `${c.polyTicker} — ${c.polyTitle} (YES ${c.polyYesCents}¢, ${c.polyAgeMin}m old)`) +
        row('Direction', c.direction) +
        row('Title match', `${Math.round(c.matchScore * 100)}%`) +
      `</table>` +
      `<p style="color:#92400e"><b>Before acting:</b> re-check both live order books (these are last-trade prices), ` +
      `confirm the two markets are truly the same event, and compare <b>settlement criteria</b> on both venues — ` +
      `resolution mismatches are the main way "arbs" lose.</p>` +
    `</div>`;
  const TO   = process.env.NOTIFY_EMAIL ?? 'claude_bot23@proton.me';
  const FROM = process.env.NOTIFY_FROM  ?? 'Whale Tracker <onboarding@resend.dev>';
  try {
    await getResend().emails.send({ from: FROM, to: TO, subject, html });
  } catch (err) {
    console.error('[notify] arb email error:', err.message);
  }
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
