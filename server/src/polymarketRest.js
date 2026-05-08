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
 * Polymarket has no `category` field — events expose `series` (e.g. "NBA")
 * and `tags` (e.g. ["Crypto Prices", "Bitcoin", "5M"]). Map those to one of
 * the 14 Kalshi top-level categories so the dashboard CAT column is
 * consistent across both sources.
 */
function mapToCategory(seriesName, tags) {
  const tagSet = new Set((tags ?? []).map((t) => String(t).toLowerCase()));
  const series = (seriesName ?? '').toLowerCase();

  const has = (...needles) => needles.some((n) => tagSet.has(n));
  const seriesIs = (...needles) => needles.some((n) => series.includes(n));

  // Sports leagues
  if (seriesIs('nba','mlb','nfl','nhl','epl','la liga','bundesliga','serie a',
               'champions league','tennis','golf','ufc','boxing','soccer','f1','formula','ipl','nascar')) return 'Sports';
  if (has('sports','nba','mlb','nfl','nhl','epl','soccer','tennis','golf','ufc','boxing','ipl')) return 'Sports';

  // Crypto
  if (has('crypto','bitcoin','ethereum','solana','crypto prices','btc','eth','sol','doge','xrp')) return 'Crypto';

  // Elections vs broader politics
  if (has('elections','election','presidential','primary')) return 'Elections';
  if (has('politics','trump','biden','congress','senate','house','supreme court')) return 'Politics';

  // Economics / Financials
  if (has('economics','fed','inflation','gdp','interest rates','jobs','employment')) return 'Economics';
  if (has('stocks','financial','financials','sp500','dow jones','nasdaq','earnings')) return 'Financials';

  // Commodities
  if (has('oil','gas','commodities','metals','gold','silver')) return 'Commodities';

  // Companies
  if (has('companies','ipo','elon musk','ceos','layoffs','product launches')) return 'Companies';

  // Climate / Weather
  if (has('climate','weather','temperature','snow','rain','hurricanes','natural disasters')) return 'Climate and Weather';

  // Health
  if (has('health','medical','pandemic','disease')) return 'Health';

  // Science & Tech
  if (has('science','technology','ai','artificial intelligence','tech','space','nasa')) return 'Science and Technology';

  // Entertainment
  if (has('entertainment','movies','music','tv','celebrities','grammy','oscar','emmy')) return 'Entertainment';

  // Social / Mentions (Polymarket calls these "tweets" sometimes)
  if (has('mentions','tweets')) return 'Mentions';
  if (has('social','viral','memes')) return 'Social';

  return 'Other';
}

// Slug → category cache so we don't re-hit Gamma API for every trade
const _categoryCache = new Map();

async function getCategoryForEvent(eventSlug) {
  if (!eventSlug) return 'Other';
  if (_categoryCache.has(eventSlug)) return _categoryCache.get(eventSlug);

  try {
    const res = await fetch(`${GAMMA_URL}/events?slug=${encodeURIComponent(eventSlug)}`, {
      headers: { 'User-Agent': 'whale-tracker/1.0' },
    });
    if (!res.ok) {
      _categoryCache.set(eventSlug, 'Other');
      return 'Other';
    }
    const arr = await res.json();
    const event = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!event) {
      _categoryCache.set(eventSlug, 'Other');
      return 'Other';
    }
    const seriesName = (event.series?.[0]?.title) ?? event.seriesSlug ?? '';
    const tags = (event.tags ?? []).map((t) => (typeof t === 'string' ? t : t?.label));
    const category = mapToCategory(seriesName, tags);
    _categoryCache.set(eventSlug, category);
    return category;
  } catch {
    _categoryCache.set(eventSlug, 'Other');
    return 'Other';
  }
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
function normaliseTrade(t, category = 'Other') {
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
    category,
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

  // Enrich each trade with its event's category. Lookups are cached by slug
  // so we hit Gamma API at most once per unique event per server lifetime.
  const result = [];
  for (const t of trades) {
    const category = await getCategoryForEvent(t.eventSlug ?? t.slug);
    result.push(normaliseTrade(t, category));
  }
  return result;
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
