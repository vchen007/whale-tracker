import { sign, constants } from 'crypto';
import { categoryFromTicker } from './kalshiClient.js';

const REST_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function authHeaders(privateKey, apiKeyId, path) {
  const ts = Date.now().toString();
  const sig = sign('sha256', Buffer.from(ts + 'GET' + path, 'utf8'), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');
  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}

/**
 * Normalise a REST trade into the same shape as the WebSocket trade.
 * REST prices are in dollars (0–1); we convert to cents (0–100).
 */
function normaliseRestTrade(t) {
  const ticker = t.ticker ?? '';
  const side   = (t.taker_side ?? '').toLowerCase();
  const yesPrice = t.yes_price_dollars != null ? Math.round(parseFloat(t.yes_price_dollars) * 100) : null;
  const noPrice  = t.no_price_dollars  != null ? Math.round(parseFloat(t.no_price_dollars)  * 100) : null;
  const count    = Math.round(parseFloat(t.count_fp ?? '0'));
  return {
    id:       t.trade_id,
    tradeId:  t.trade_id,
    ticker,
    category: categoryFromTicker(ticker),
    side,
    yesPrice,
    noPrice,
    count,
    ts: t.created_time,
  };
}

/**
 * Paginate through all events and return Map<event_ticker, category>.
 * Kalshi stores `category` on the event, not the market.
 */
export async function fetchEventCategoryMap(privateKey, apiKeyId) {
  const map = new Map();
  let cursor = null;
  const FIXED_PATH = '/trade-api/v2/events';

  while (true) {
    const params = new URLSearchParams({ limit: '200', with_nested_markets: 'false' });
    if (cursor) params.set('cursor', cursor);

    const url = `${REST_BASE}/events?${params}`;
    const headers = authHeaders(privateKey, apiKeyId, FIXED_PATH);
    let data;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) { console.error(`[events] REST error ${res.status}`); break; }
      data = await res.json();
    } catch (err) {
      console.error('[events] fetch error:', err.message);
      break;
    }

    const events = data.events ?? [];
    if (events.length === 0) break;
    for (const e of events) {
      if (e.event_ticker && e.category) map.set(e.event_ticker, e.category);
    }

    if (!data.cursor) break;
    cursor = data.cursor;
  }

  return map;
}

/**
 * Paginate through all markets and call onPage([ticker, title, category][]) per page.
 * Category is looked up by the market's event_ticker in the provided map.
 */
export async function fetchAllMarketTitles(privateKey, apiKeyId, onPage, eventCategoryMap = new Map()) {
  const FIXED_PATH = '/trade-api/v2/markets';
  let cursor = null;
  let total  = 0;

  while (true) {
    const params = new URLSearchParams({ limit: '1000' });
    if (cursor) params.set('cursor', cursor);

    const url = `${REST_BASE}/markets?${params}`;
    const headers = authHeaders(privateKey, apiKeyId, FIXED_PATH);

    let data;
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429) { console.warn('[titles] rate limited — backing off 5s'); await sleep(5000); continue; }
      if (!res.ok) { console.error(`[titles] REST error ${res.status}`); break; }
      data = await res.json();
    } catch (err) {
      console.error('[titles] fetch error:', err.message);
      break;
    }

    const pairs = (data.markets ?? [])
      .filter((m) => m.ticker && m.title)
      .map((m) => [
        m.ticker,
        m.title,
        eventCategoryMap.get(m.event_ticker) ?? null,
        m.yes_sub_title ?? null,
        m.no_sub_title  ?? null,
        m.close_time    ?? null,
        m.occurrence_datetime ?? null,
      ]);

    if (pairs.length === 0) break;
    onPage(pairs);
    total += pairs.length;

    if (!data.cursor) break;
    cursor = data.cursor;
    await sleep(100);
  }

  return total;
}

/**
 * Derive event ticker from market ticker by stripping the last hyphen segment.
 * e.g. KXMLBGAME-26APR092140COLSD-COL → KXMLBGAME-26APR092140COLSD
 */
function eventTickerFromMarket(ticker) {
  const idx = ticker.lastIndexOf('-');
  return idx > 0 ? ticker.slice(0, idx) : ticker;
}

/**
 * Fetch titles AND categories for market tickers via GET /events/{event_ticker}.
 * One event call covers all markets in that event.
 * Calls onPage([[ticker, title, category], ...]) per flush.
 */
export async function fetchEventData(privateKey, apiKeyId, marketTickers, onPage, flushEvery = 100) {
  // Deduplicate by event ticker
  const eventToMarkets = new Map();
  for (const t of marketTickers) {
    const ev = eventTickerFromMarket(t);
    if (!eventToMarkets.has(ev)) eventToMarkets.set(ev, []);
    eventToMarkets.get(ev).push(t);
  }

  let total = 0;
  let buffer = [];
  const eventTickers = [...eventToMarkets.keys()];

  for (let i = 0; i < eventTickers.length; i++) {
    const evTicker = eventTickers[i];
    const path = `/trade-api/v2/events/${evTicker}`;
    const headers = authHeaders(privateKey, apiKeyId, path);

    try {
      const res = await fetch(`${REST_BASE}/events/${evTicker}`, { headers });
      if (res.status === 429) {
        console.warn('[event] rate limited — backing off 5s');
        await sleep(5000);
        i--;
        continue;
      }
      if (!res.ok) { await sleep(50); continue; }
      const data = await res.json();

      const category = data.event?.category ?? null;

      // Build a map from the markets array in the event response
      const marketInfo = new Map();
      for (const m of data.event?.markets ?? []) {
        if (m.ticker) marketInfo.set(m.ticker, {
          title:      m.title               ?? null,
          yesSub:     m.yes_sub_title       ?? null,
          noSub:      m.no_sub_title        ?? null,
          closeTime:  m.close_time          ?? null,
          eventStart: m.occurrence_datetime ?? null,
        });
      }

      // Emit one row per market ticker we requested for this event
      for (const mTicker of eventToMarkets.get(evTicker)) {
        const info = marketInfo.get(mTicker) ?? {};
        if (info.title || category) {
          buffer.push([mTicker, info.title ?? '', category, info.yesSub, info.noSub, info.closeTime, info.eventStart]);
          total++;
        }
      }
    } catch {
      // skip
    }

    if (buffer.length >= flushEvery) {
      onPage(buffer);
      buffer = [];
      if (total % 1000 === 0) console.log(`[event] backfilled ${total} so far…`);
    }
    await sleep(50);
  }

  if (buffer.length > 0) onPage(buffer);
  return total;
}

// Keep old name as alias for backwards compat
export { fetchEventData as fetchEventCategories };

/**
 * Fetch titles for specific tickers one at a time using GET /markets/{ticker}.
 * Flushes to onPage([ticker, title, category][]) every `flushEvery` results.
 */
export async function fetchTitlesByTickers(privateKey, apiKeyId, tickers, onPage, flushEvery = 100) {
  let total = 0;
  let buffer = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const path = `/trade-api/v2/markets/${ticker}`;
    const headers = authHeaders(privateKey, apiKeyId, path);

    try {
      const res = await fetch(`${REST_BASE}/markets/${ticker}`, { headers });
      if (res.status === 429) {
        console.warn('[titles] rate limited — backing off 5s');
        await sleep(5000);
        i--; // retry
        continue;
      }
      if (res.status === 404) { await sleep(50); continue; }
      if (!res.ok) { await sleep(50); continue; }
      const data = await res.json();
      const m = data.market ?? data;
      if (m?.ticker && m?.title) {
        buffer.push([
          m.ticker,
          m.title,
          m.category ?? null,
          m.yes_sub_title ?? null,
          m.no_sub_title  ?? null,
          m.close_time    ?? null,
          m.occurrence_datetime ?? null,
        ]);
        total++;
      }
    } catch {
      // skip unreachable tickers
    }

    if (buffer.length >= flushEvery) {
      onPage(buffer);
      buffer = [];
      if (total % 1000 === 0) console.log(`[titles] backfilled ${total} so far…`);
    }
    await sleep(50);
  }

  if (buffer.length > 0) onPage(buffer);
  return total;
}

const CATEGORIES_URL = `${REST_BASE}/search/tags_by_categories`;
let _categoriesCache = null;

/**
 * Fetch the list of top-level Kalshi categories (no auth required).
 * Result is cached in memory for the lifetime of the process.
 */
export async function fetchCategories() {
  if (_categoriesCache) return _categoriesCache;
  const res = await fetch(CATEGORIES_URL);
  if (!res.ok) throw new Error(`categories fetch failed: ${res.status}`);
  const data = await res.json();
  _categoriesCache = Object.keys(data.tags_by_categories ?? {}).sort();
  return _categoriesCache;
}

/**
 * Fetch categories for the given series tickers.
 * Returns Map<series_ticker, category>.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchSeriesCategories(privateKey, apiKeyId, seriesList, delayMs = 100) {
  const map = new Map();
  const FIXED_PATH_BASE = '/trade-api/v2/series/';

  for (const series of seriesList) {
    const path = `${FIXED_PATH_BASE}${series}`;
    const headers = authHeaders(privateKey, apiKeyId, path);
    try {
      const res = await fetch(`${REST_BASE}/series/${series}`, { headers });
      if (res.status === 429) {
        console.warn('[categories] rate limited — backing off 5s');
        await sleep(5000);
        continue;
      }
      if (!res.ok) continue;
      const data = await res.json();
      const category = data.series?.category;
      if (category) map.set(series, category);
    } catch {
      // skip
    }
    await sleep(delayMs);
  }

  return map;
}

/**
 * Fetch all trades since `sinceMs` (epoch ms), paginating as needed.
 * Calls `onPage(trades[])` after each page so the caller can persist incrementally.
 */
export async function fetchTradeHistory(privateKey, apiKeyId, sinceMs, onPage) {
  const minCreatedTime = new Date(sinceMs).toISOString();
  let cursor = null;
  let total  = 0;
  const FIXED_PATH = '/trade-api/v2/markets/trades';

  while (true) {
    const params = new URLSearchParams({ limit: '1000', min_created_time: minCreatedTime });
    if (cursor) params.set('cursor', cursor);

    const url = `${REST_BASE}/markets/trades?${params}`;
    const headers = authHeaders(privateKey, apiKeyId, FIXED_PATH);

    let data;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.error(`[history] REST error ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error('[history] fetch error:', err.message);
      break;
    }

    const trades = (data.trades ?? []).map(normaliseRestTrade);
    if (trades.length === 0) break;

    onPage(trades);
    total += trades.length;

    if (!data.cursor) break;
    cursor = data.cursor;
    await sleep(100);
  }

  return total;
}
