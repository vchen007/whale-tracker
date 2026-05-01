import { sign, constants } from 'crypto';
import { notifyTrade } from './notify.js';

const REST_BASE  = 'https://api.elections.kalshi.com/trade-api/v2';
const ORDER_PATH = '/trade-api/v2/portfolio/orders';

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
   * @param {boolean} [opts.enabled]      default true
   * @param {string}  [opts.category]     category to copy-trade (default 'Sports')
   * @param {number}  [opts.count]        contracts per copy-trade (default 1)
   * @param {number}  [opts.minNotional]  min trade notional in dollars to copy (default 20000)
   */
  constructor({ privateKey, apiKeyId, enabled = true, category = 'Sports', count = 1, minNotional = 20_000 }) {
    this.privateKey  = privateKey;
    this.apiKeyId    = apiKeyId;
    this.enabled     = enabled;
    this.category    = category;
    this.count       = count;
    this.minNotional = minNotional;

    // Simple in-memory log of recent orders (capped at 500)
    this.log = [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  enable()  { this.enabled = true;  console.log('[auto-trader] enabled');  }
  disable() { this.enabled = false; console.log('[auto-trader] disabled'); }

  status() {
    return {
      enabled:     this.enabled,
      category:    this.category,
      count:       this.count,
      minNotional: this.minNotional,
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
    const notional = (trade.count * price) / 100;
    if (notional < this.minNotional) return;
    await this._placeOrder(trade);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _placeOrder(trade) {
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
      ts:            new Date().toISOString(),
      ticker:        trade.ticker,
      side,
      price,
      count:         this.count,
      clientOrderId,
      status:        'pending',
      error:         null,
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

    notifyTrade(entry).catch((err) => console.error('[notify] unhandled error', err.message));
  }
}
