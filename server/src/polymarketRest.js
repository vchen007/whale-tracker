/**
 * Polymarket REST client.
 *
 * Public, no auth required. Uses two endpoints:
 *   - data-api.polymarket.com/trades  → recent trades with title + outcome embedded
 *   - gamma-api.polymarket.com/markets → richer market metadata (events, categories)
 *
 * We poll trades periodically and normalise to the same shape as Kalshi trades
 * so the UI / DB layer don't care about the source.
 */

const TRADES_URL  = 'https://data-api.polymarket.com/trades';
const GAMMA_URL   = 'https://gamma-api.polymarket.com';
const PAGE_SIZE   = 500;

/**
 * Build a stable per-trade ticker. Polymarket has condition_id (per market) +
 * asset_id (per outcome token). We use conditionId-outcomeIndex as the ticker
 * so each YES / NO side has its own ticker, mirroring Kalshi's convention.
 */
function ticker(t) {
  const cid = (t.conditionId ?? '').slice(0, 16);
  return `PM-${cid}-${t.outcomeIndex ?? 0}`;
}

/**
 * Map Polymarket trade → unified trade shape.
 *
 * Polymarket pricing is in dollars (0–1). We convert to cents (0–100) so the
 * `count * price` notional calc matches Kalshi conventions downstream.
 *
 * Polymarket has BUY/SELL semantics on top of a multi-outcome market.
 * We collapse to yes/no based on outcomeIndex (0 = "yes" side, anything else
 * = "no" side). For binary Yes/No markets this maps cleanly; for multi-leg
 * markets the ticker captures which outcome was traded.
 */
function normaliseTrade(t) {
  const priceCents = Math.round(parseFloat(t.price ?? 0) * 100);
  const count = Math.round(parseFloat(t.size ?? 0));
  const isYesSide = (t.outcomeIndex ?? 0) === 0;

  // Polymarket trades are uniquely identified by transactionHash + asset + side
  // (one tx can produce multiple fills). Embed those for stable de-dup.
  const id = `pm-${t.transactionHash ?? t.proxyWallet ?? 'unknown'}-${t.asset ?? '0'}-${t.timestamp ?? 0}`;

  return {
    id,
    tradeId: t.transactionHash ?? null,
    ticker: ticker(t),
    title: t.title ?? null,
    category: 'Polymarket',
    source: 'polymarket',
    outcome: t.outcome ?? null,
    side: isYesSide ? 'yes' : 'no',
    yesPrice: isYesSide ? priceCents : null,
    noPrice:  isYesSide ? null       : priceCents,
    count,
    ts: t.timestamp ? new Date(parseInt(t.timestamp, 10) * 1000).toISOString() : new Date().toISOString(),
  };
}

/**
 * Fetch trades since a Unix-seconds timestamp. Polymarket's data-api supports
 * pagination via `offset`. We page until we hit the cutoff or an empty page.
 */
export async function fetchPolymarketTrades(sinceMs) {
  const sinceSec = Math.floor(sinceMs / 1000);
  const trades = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const url = `${TRADES_URL}?limit=${PAGE_SIZE}&offset=${offset}&filterType=CASH`;
    let data;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'whale-tracker/1.0' } });
      if (!res.ok) {
        console.error(`[polymarket] trades HTTP ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error('[polymarket] trades fetch error:', err.message);
      break;
    }

    if (!Array.isArray(data) || data.length === 0) break;

    let hitCutoff = false;
    for (const t of data) {
      const ts = parseInt(t.timestamp ?? 0, 10);
      if (ts < sinceSec) { hitCutoff = true; continue; }
      trades.push(t);
    }

    if (hitCutoff) break;
    if (data.length < PAGE_SIZE) break;
    offset += data.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  return trades.map(normaliseTrade);
}

/**
 * Fetch active markets from Gamma API for backfill / category enrichment.
 * Optional — used to keep `market_titles` populated for any tickers that
 * appear in trades.
 */
export async function fetchPolymarketMarket(conditionId) {
  try {
    const res = await fetch(`${GAMMA_URL}/markets?condition_ids=${conditionId}`, {
      headers: { 'User-Agent': 'whale-tracker/1.0' },
    });
    if (!res.ok) return null;
    const arr = await res.json();
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  } catch {
    return null;
  }
}
