import { sign, constants } from 'crypto';
import { notifyTrade } from './notify.js';
import { insertAutoOrder, getOpenAutoOrders, settleAutoOrder } from './db.js';

const REST_BASE  = 'https://api.elections.kalshi.com/trade-api/v2';
const ORDER_PATH = '/trade-api/v2/portfolio/orders';

// ── Kalshi fee schedule ──────────────────────────────────────────────────────
// Standard taker fee: 0.07 × P × (1−P) dollars per contract (P in dollars 0–1)
// Sports premium (NBA, NHL, NFL since Jul 2025): +15% on the standard fee
// Source: https://kalshi.com/fee-schedule
function kalshiFeeDollars(priceCents, count, isSports = false) {
  const P = priceCents / 100;
  const baseFee = 0.07 * P * (1 - P);
  const feePerContract = isSports ? baseFee * 1.15 : baseFee;
  // Round UP to nearest cent (worst-case for the trader, conservative for our filter)
  return Math.ceil(feePerContract * count * 100) / 100;
}

/**
 * Profitability check: returns the max-win net profit in dollars.
 * Buy 1 contract at P (cents); if outcome hits, payout = $1.00.
 *   gross_profit_if_win = (100 − P) / 100 × count
 *   fee = kalshiFeeDollars(P, count, isSports)
 *   net_profit_if_win = gross_profit_if_win − fee
 */
function maxNetProfitDollars(priceCents, count, isSports = false) {
  const grossProfit = ((100 - priceCents) / 100) * count;
  const fee = kalshiFeeDollars(priceCents, count, isSports);
  return grossProfit - fee;
}

function authHeaders(privateKey, apiKeyId, path, method = 'POST') {
  const ts  = Date.now().toString();
  const sig = sign('sha256', Buffer.from(ts + method + path, 'utf8'), {
    key:        privateKey,
    padding:    constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');
  return {
    'KALSHI-ACCESS-KEY':       apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type':            'application/json',
  };
}

export class AutoTrader {
  /**
   * @param {object} opts
   * @param {import('crypto').KeyObject} opts.privateKey
   * @param {string}  opts.apiKeyId
   * @param {boolean} [opts.enabled]            default true
   * @param {string}  [opts.category]           category to copy-trade (default 'Sports')
   * @param {number}  [opts.count]              contracts per copy-trade (default 1)
   * @param {number}  [opts.minNotional]        min trade notional in dollars to copy (default 20000)
   * @param {number}  [opts.minNetProfit]       min net profit if win, in dollars (default 0.02 = 2¢)
   */
  constructor({ privateKey, apiKeyId, enabled = true, category = 'Sports', count = 1, minNotional = 20_000, minNetProfit = 0.02 }) {
    this.privateKey   = privateKey;
    this.apiKeyId     = apiKeyId;
    this.enabled      = enabled;
    this.category     = category;
    this.count        = count;
    this.minNotional  = minNotional;
    this.minNetProfit = minNetProfit;

    // Simple in-memory log of recent orders (capped at 500)
    this.log = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  enable()  { this.enabled = true;  console.log('[auto-trader] enabled');  }
  disable() { this.enabled = false; console.log('[auto-trader] disabled'); }

  status() {
    return {
      enabled:      this.enabled,
      category:     this.category,
      count:        this.count,
      minNotional:  this.minNotional,
      minNetProfit: this.minNetProfit,
      recentOrders: this.log.slice(-20),
    };
  }

  /**
   * Called for every incoming whale trade.
   * Places a copy order if the trade matches our criteria.
   */
  async onTrade(trade) {
    if (!this.enabled) return;
    if (trade.category !== this.category) return;

    const price = trade.side === 'yes' ? (trade.yesPrice ?? 0) : (trade.noPrice ?? 0);
    if (!price) return;

    // Notional gate
    const notional = (trade.count * price) / 100;
    if (notional < this.minNotional) return;

    // Profitability gate: buying at price P, max payout per contract = $1.00.
    // Sports markets get the +15% fee premium since Jul 2025.
    const isSports  = trade.category === 'Sports';
    const fee       = kalshiFeeDollars(price, this.count, isSports);
    const netProfit = maxNetProfitDollars(price, this.count, isSports);
    if (netProfit < this.minNetProfit) {
      console.log(
        `[auto-trader] skip ${trade.ticker} ${trade.side.toUpperCase()} @ ${price}¢ — ` +
        `max net win = $${netProfit.toFixed(4)} (fee $${fee.toFixed(4)}) < $${this.minNetProfit.toFixed(2)} threshold`
      );
      return;
    }

    await this._placeOrder(trade, { fee, netProfit });
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _placeOrder(trade, { fee = 0, netProfit = 0 } = {}) {
    const side  = trade.side; // 'yes' | 'no'
    const price = side === 'yes' ? trade.yesPrice : trade.noPrice;

    if (!price) {
      console.warn(`[auto-trader] skipping ${trade.ticker} — no price data`);
      return;
    }

    const clientOrderId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const body = {
      ticker:          trade.ticker,
      client_order_id: clientOrderId,
      type:            'limit',
      action:          'buy',
      side,
      count:           this.count,
      ...(side === 'yes' ? { yes_price: price } : { no_price: price }),
    };

    const entry = {
      ts:                  new Date().toISOString(),
      ticker:              trade.ticker,
      side,
      price,
      count:               this.count,
      estFee:              fee,
      estMaxNetProfit:     netProfit,
      clientOrderId,
      status:              'pending',
      error:               null,
    };

    try {
      const res  = await fetch(`${REST_BASE}/portfolio/orders`, {
        method:  'POST',
        headers: authHeaders(this.privateKey, this.apiKeyId, ORDER_PATH),
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        entry.status = 'failed';
        entry.error  = data?.error?.message ?? JSON.stringify(data);
        console.error(`[auto-trader] ❌ ${trade.ticker} BUY ${side.toUpperCase()} — ${entry.error}`);
      } else {
        entry.status  = 'placed';
        entry.orderId = data?.order?.order_id ?? null;
        console.log(
          `[auto-trader] ✅ ${trade.ticker} BUY ${side.toUpperCase()} x${this.count} @ ${price}¢` +
          (entry.orderId ? ` (${entry.orderId})` : '')
        );
      }
    } catch (err) {
      entry.status = 'error';
      entry.error  = err.message;
      console.error(`[auto-trader] ❌ ${trade.ticker} — ${err.message}`);
    }

    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();

    // Persist to DB if successfully placed (so we can track outcome later)
    if (entry.status === 'placed') {
      try {
        insertAutoOrder({
          client_order_id: entry.clientOrderId,
          order_id:        entry.orderId ?? null,
          ticker:          entry.ticker,
          side:            entry.side,
          entry_price:     entry.price,
          count:           entry.count,
          est_fee:         entry.estFee ?? null,
          placed_ts:       entry.ts,
          status:          'placed',
        });
      } catch (err) {
        console.error('[auto-trader] db insert error', err.message);
      }
    }

    notifyTrade(entry).catch((err) => console.error('[notify] unhandled error', err.message));
  }

  /**
   * Poll Kalshi for any open orders that have settled, and record outcomes.
   * Should be called periodically (e.g., every 15 minutes).
   */
  async checkSettlements() {
    const open = getOpenAutoOrders();
    if (open.length === 0) return { checked: 0, settled: 0 };

    let settledCount = 0;
    for (const o of open) {
      try {
        const res = await fetch(`${REST_BASE}/markets/${o.ticker}`);
        if (!res.ok) continue;
        const data = await res.json();
        const m = data.market ?? {};
        const status = m.status;
        if (status !== 'settled' && status !== 'finalized') continue;

        // m.result is 'yes' or 'no' depending on which side won
        const result = m.result;
        if (!result) continue;

        // P&L per contract: win → (100 − entry), lose → −entry
        const won = (o.side === result);
        const pnlPerContract = won ? (100 - o.entry_price) : -o.entry_price;
        const pnlCents = pnlPerContract * o.count;

        settleAutoOrder(o.client_order_id, {
          outcome:   won ? 'win' : 'loss',
          pnlCents,
          settledTs: new Date().toISOString(),
        });

        settledCount++;
        console.log(
          `[auto-trader] ${won ? '✅' : '❌'} settled ${o.ticker} ${o.side.toUpperCase()} @ ${o.entry_price}¢ — ` +
          `${won ? 'WIN' : 'LOSS'} ${pnlCents >= 0 ? '+' : ''}${pnlCents}¢`
        );
      } catch (err) {
        console.error(`[auto-trader] settlement check error ${o.ticker}:`, err.message);
      }
    }
    return { checked: open.length, settled: settledCount };
  }
}
