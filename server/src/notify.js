import { Resend } from 'resend';

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Send an email notification after the auto-trader places an order.
 * @param {object} entry  - log entry from AutoTrader
 */
export async function notifyTrade(entry) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[notify] RESEND_API_KEY not set — skipping email');
    return;
  }

  const statusEmoji = entry.status === 'placed' ? '✅' : '❌';
  const subject     = `${statusEmoji} Auto-trade: ${entry.ticker} BUY ${entry.side.toUpperCase()} @ ${entry.price}¢`;

  const body = entry.status === 'placed'
    ? `
        <h2>✅ Order placed</h2>
        <table style="font-family:monospace;border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0"><b>Market</b></td><td>${entry.ticker}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Side</b></td><td>${entry.side.toUpperCase()}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Price</b></td><td>${entry.price}¢</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Contracts</b></td><td>${entry.count}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Order ID</b></td><td>${entry.orderId ?? '—'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Time</b></td><td>${entry.ts}</td></tr>
        </table>
      `
    : `
        <h2>❌ Order failed</h2>
        <table style="font-family:monospace;border-collapse:collapse">
          <tr><td style="padding:4px 12px 4px 0"><b>Market</b></td><td>${entry.ticker}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Side</b></td><td>${entry.side.toUpperCase()}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Price</b></td><td>${entry.price}¢</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Error</b></td><td style="color:red">${entry.error}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><b>Time</b></td><td>${entry.ts}</td></tr>
        </table>
      `;

  const TO   = process.env.NOTIFY_EMAIL ?? 'claude_bot23@proton.me';
  const FROM = process.env.NOTIFY_FROM  ?? 'Whale Tracker <onboarding@resend.dev>';

  try {
    await getResend().emails.send({
      from:    FROM,
      to:      TO,
      subject,
      html:    `<div style="font-family:sans-serif;max-width:480px">${body}</div>`,
    });
  } catch (err) {
    console.error('[notify] email error:', err.message);
  }
}
