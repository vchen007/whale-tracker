import WebSocket from 'ws';
import { buildAuthParams } from './auth.js';

const RECONNECT_DELAY_MS = 5_000;

/**
 * Map Kalshi ticker prefix → canonical Kalshi category. Used as a fallback
 * when the events API didn't give us a category for a market. Longer
 * prefixes are checked first (e.g. KXNBAEAST before KXNBA) so that the
 * most-specific match wins.
 */
const TICKER_PREFIX_TO_CATEGORY = {
  // ── Sports ────────────────────────────────────────────────────────────
  // Basketball
  'KXNBA': 'Sports', 'KXWNBA': 'Sports', 'KXNCAAMB': 'Sports', 'KXNCAAWB': 'Sports',
  // Baseball
  'KXMLB': 'Sports', 'KXNCAABASE': 'Sports',
  // Hockey
  'KXNHL': 'Sports',
  // American football
  'KXNFL': 'Sports', 'KXNCAAFB': 'Sports', 'KXCFL': 'Sports',
  // Soccer
  'KXEPL': 'Sports', 'KXLALIGA': 'Sports', 'KXBUNDESLIGA': 'Sports',
  'KXSERIEA': 'Sports', 'KXLIGUE1': 'Sports', 'KXMLS': 'Sports',
  'KXUCL': 'Sports', 'KXUEFA': 'Sports', 'KXARGPREMDIV': 'Sports',
  'KXBRASILEIRAO': 'Sports', 'KXFIFA': 'Sports',
  // Cricket
  'KXIPL': 'Sports', 'KXCRICKET': 'Sports', 'KXICC': 'Sports',
  // Tennis
  'KXATP': 'Sports', 'KXWTA': 'Sports', 'KXITF': 'Sports',
  // Golf
  'KXPGA': 'Sports', 'KXLPGA': 'Sports', 'KXMASTERS': 'Sports',
  // Combat sports
  'KXUFC': 'Sports', 'KXBOXING': 'Sports',
  // Motorsports
  'KXF1': 'Sports', 'KXNASCAR': 'Sports', 'KXINDYCAR': 'Sports',
  // Multi-leg props that are explicitly sports
  'KXMVESPORTS': 'Sports',
  // International / world tournament
  'KXMENWORLDCUP': 'Sports', 'KXWOMENWORLDCUP': 'Sports', 'KXOLYMPICS': 'Sports',
  // Other sports
  'KXAFL': 'Sports', 'KXAPFDDH': 'Sports', 'KXDIMAYORGAME': 'Sports',
  'KXNCAAMLAX': 'Sports', 'KXVALORANTGAME': 'Sports', 'KXHIGH': 'Sports',
  // Esports
  'KXCS2': 'Sports', 'KXLOL': 'Sports', 'KXDOTA': 'Sports',

  // ── Crypto ────────────────────────────────────────────────────────────
  'KXBTC': 'Crypto', 'KXETH': 'Crypto', 'KXSOL': 'Crypto',
  'KXDOGE': 'Crypto', 'KXXRP': 'Crypto', 'KXBNB': 'Crypto',
  'KXHYPE': 'Crypto', 'KXLINK': 'Crypto',

  // ── Financials ────────────────────────────────────────────────────────
  'KXINXU': 'Financials', 'KXSPX': 'Financials', 'KXNDX': 'Financials',
  'KXDOW': 'Financials',

  // ── Politics & Elections ──────────────────────────────────────────────
  'KXFEDCHAIR': 'Politics', 'KXSAVEACT': 'Politics',
  'KXDHSFUND': 'Politics', 'KXGOVTSHUT': 'Politics',
  'KXTRUMPMENTION': 'Politics', 'KXFEDDECISION': 'Politics',
  'KXPRESNOM': 'Elections', 'KXMOVVAREDISTRICT': 'Elections',
  'KXGOV': 'Elections',  // catches KXGOVCA, KXGOVOH, etc. — state-governor races

  // ── Companies / Mentions ──────────────────────────────────────────────
  'KXHOOD': 'Companies', 'KXMRBEAST': 'Mentions',

  // ── Entertainment ─────────────────────────────────────────────────────
  'KXMETGALA': 'Entertainment', 'KXOSCAR': 'Entertainment',
  'KXEMMY': 'Entertainment', 'KXGRAMMY': 'Entertainment',
  'KXSURVIVOR': 'Entertainment',

  // ── Other / multi-category ────────────────────────────────────────────
  'KXMVECROSSCATEGORY': 'Other',
};

const _sortedPrefixes = Object.keys(TICKER_PREFIX_TO_CATEGORY).sort((a, b) => b.length - a.length);

/**
 * Extract a human-readable category from a Kalshi market ticker.
 * Falls back to the raw prefix only when no mapping matches.
 */
export function categoryFromTicker(ticker = '') {
  if (!ticker) return 'UNKNOWN';
  for (const prefix of _sortedPrefixes) {
    if (ticker.startsWith(prefix)) return TICKER_PREFIX_TO_CATEGORY[prefix];
  }
  return ticker.split('-')[0] || 'UNKNOWN';
}

/**
 * Normalise a raw Kalshi trade message into a flat object we send to clients.
 * @param {object} raw
 * @param {Map<string,string>} [categoryMap]  ticker → human category
 */
function normaliseTrade(raw, categoryMap, titleMap, marketMetaMap) {
  const m = raw.msg ?? raw;
  const ticker = m.market_ticker ?? m.ticker ?? '';
  const tradeId = m.trade_id ?? null;
  const meta = marketMetaMap?.get(ticker) ?? {};

  // Kalshi migrated from integer cent prices (yes_price) + integer count
  // to dollar string prices (yes_price_dollars) + float string count (count_fp).
  // Handle both formats so old and new messages both work.
  const count = parseFloat(m.count_fp ?? m.count ?? 0);
  const yesPrice = m.yes_price_dollars != null
    ? Math.round(parseFloat(m.yes_price_dollars) * 100)
    : (m.yes_price ?? null);
  const noPrice = m.no_price_dollars != null
    ? Math.round(parseFloat(m.no_price_dollars) * 100)
    : (m.no_price ?? null);

  // Kalshi sends `ts` as a Unix-seconds integer (10 digits) on the WebSocket.
  // Some REST shapes use `created_time` as an ISO string. Handle both —
  // and if we get a number, detect whether it's seconds (<1e12) or ms.
  let tsValue = m.ts ?? m.created_time;
  if (typeof tsValue === 'number' && tsValue < 1e12) tsValue = tsValue * 1000;
  const ts = tsValue ? new Date(tsValue).toISOString() : new Date().toISOString();

  return {
    id: tradeId ?? `${tsValue ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    tradeId,
    ticker,
    category: categoryMap?.get(ticker) ?? categoryFromTicker(ticker),
    title: titleMap?.get(ticker) ?? null,
    closeTime:            meta.closeTime            ?? null,
    eventStartTime:       meta.eventStartTime       ?? null,
    eventActualStartTime: meta.eventActualStartTime ?? null,
    side: (m.taker_side ?? '').toLowerCase(),   // 'yes' | 'no'
    yesPrice,
    noPrice,
    count,
    ts,
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
  constructor({ apiKeyId, privateKey, onTrade, onStatus, categoryMap, titleMap, marketMetaMap }) {
    this.apiKeyId = apiKeyId;
    this.privateKey = privateKey;
    this.onTrade = onTrade;
    this.onStatus = onStatus ?? (() => {});
    this.categoryMap = categoryMap ?? new Map();
    this.titleMap = titleMap ?? new Map();
    this.marketMetaMap = marketMetaMap ?? new Map();

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
          this.onTrade(normaliseTrade(msg, this.categoryMap, this.titleMap, this.marketMetaMap));
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
