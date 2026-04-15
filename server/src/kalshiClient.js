import WebSocket from 'ws';
import { buildAuthParams } from './auth.js';

const RECONNECT_DELAY_MS = 5_000;

/**
 * Extract a human-readable category from a Kalshi market ticker.
 * Tickers look like: BTCD-25DEC-T50000, INXD-25JAN-P4500, KXBTCD-25NOV-T45000
 * The first segment (before the first hyphen) is the series root.
 */
export function categoryFromTicker(ticker = '') {
  return ticker.split('-')[0] || 'UNKNOWN';
}

/**
 * Normalise a raw Kalshi trade message into a flat object we send to clients.
 * @param {object} raw
 * @param {Map<string,string>} [categoryMap]  ticker → human category
 */
function normaliseTrade(raw, categoryMap, titleMap) {
  const m = raw.msg ?? raw;
  const ticker = m.market_ticker ?? m.ticker ?? '';
  return {
    id: `${m.trade_id ?? m.ts ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ticker,
    category: categoryMap?.get(ticker) ?? categoryFromTicker(ticker),
    title: titleMap?.get(ticker) ?? null,
    side: (m.taker_side ?? '').toLowerCase(),   // 'yes' | 'no'
    yesPrice: m.yes_price ?? null,              // cents  0-100
    noPrice: m.no_price ?? null,
    count: m.count ?? 0,                        // number of contracts
    ts: m.ts ? new Date(m.ts).toISOString() : new Date().toISOString(),
  };
}

export class KalshiClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKeyId
   * @param {string} opts.privateKey   PEM string
   * @param {(trade: object) => void} opts.onTrade   callback for each trade
   * @param {(status: string) => void} opts.onStatus  callback for status strings
   */
  constructor({ apiKeyId, privateKey, onTrade, onStatus, categoryMap, titleMap }) {
    this.apiKeyId = apiKeyId;
    this.privateKey = privateKey;
    this.onTrade = onTrade;
    this.onStatus = onStatus ?? (() => {});
    this.categoryMap = categoryMap ?? new Map();
    this.titleMap = titleMap ?? new Map();

    this._ws = null;
    this._msgId = 1;
    this._destroyed = false;
  }

  connect() {
    if (this._destroyed) return;
    this.onStatus('connecting');

    // Kalshi requires RSA-PSS auth headers on the HTTP upgrade request.
    const wsUrl = process.env.KALSHI_WS_URL ?? 'wss://api.elections.kalshi.com/trade-api/ws/v2';
    const wsPath = new URL(wsUrl).pathname;
    const { api_key, signature, timestamp } = buildAuthParams(this.privateKey, this.apiKeyId, wsPath);
    const ws = new WebSocket(wsUrl, {
      headers: {
        'KALSHI-ACCESS-KEY': api_key,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      },
    });
    this._ws = ws;

    ws.on('open', () => {
      this.onStatus('subscribing');
      this._send('subscribe', { channels: ['trade'] });
    });

    // Kalshi sends WebSocket Ping frames every ~10 s; ws auto-replies with Pong.
    // It also sends a text "heartbeat" message — just ignore it.
    ws.on('ping', () => { /* ws library auto-sends pong */ });

    ws.on('message', (data) => {
      const raw = data.toString();
      if (raw === 'heartbeat') return;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.error) {
        this.onStatus(`error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        return;
      }

      // Subscription confirmation
      if (msg.type === 'subscribed') {
        this.onStatus('live');
        return;
      }

      // Trade event
      if (msg.type === 'trade') {
        try {
          this.onTrade(normaliseTrade(msg, this.categoryMap, this.titleMap));
        } catch (err) {
          console.error('[kalshi] normalise error', err.message, msg);
        }
        return;
      }

      if (msg.type === 'pong') return;
    });

    ws.on('error', (err) => {
      this.onStatus(`ws-error: ${err.message}`);
    });

    ws.on('close', (code) => {
      if (this._destroyed) return;
      this.onStatus(`disconnected (${code}) – reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    });
  }

  destroy() {
    this._destroyed = true;
    this._ws?.terminate();
  }

  _send(cmd, params = {}) {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ id: this._msgId++, cmd, params }));
  }
}
