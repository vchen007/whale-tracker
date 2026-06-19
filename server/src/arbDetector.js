import { getLatestTradePricesSince, getTitlesForTickers } from './db.js';

// ── Cross-venue arbitrage detector (Kalshi ↔ Polymarket) ────────────────────
//
// When the same event prices differently on the two venues, buying YES on the
// cheaper venue and NO on the other for a combined cost under $1 locks a profit
// at settlement regardless of outcome. Gross edge (cents) = |P_kalshi − P_poly|;
// net subtracts the Kalshi taker fee (Polymarket charges no trading fee; gas
// and spread are not modeled).
//
// HONEST LIMITS — this is a DETECTOR, not an executor:
//  - Prices are LAST-TRADE prices from our feed, not live order books, so every
//    hit is *indicative* and must be re-checked against both books before
//    acting (the displayed gap may be stale or inside the spread).
//  - Matching is heuristic but guarded on three axes so a pair must be the same
//    EVENT, same TYPE, and same SIDE:
//      • event — title token overlap, OR (winner markets) the Polymarket subject
//        being a team in the Kalshi title, OR (non-winner markets) a same-matchup
//        team-identity check (sameMatchup) using title teams or the Kalshi ticker
//        code; plus a matching event date when both titles carry one;
//      • type  — classifyMarketType: a "Winner?" won't pair with an "O/U 2.5"
//        total/spread/prop/outright, and two totals with different lines won't;
//      • side  — for winner/outright, kalshiYesSubject (from yes_sub) vs
//        polyYesSubject (from the question, or the team at the PM ticker's
//        outcomeIndex for "A vs B" markets) must agree when both are known —
//        so "Argentina to win" never pairs with "Algeria to win", and a Kalshi
//        team never pairs with the opposite side of a PM head-to-head market.
//    Coverage: WINNER/OUTRIGHT and FIRST-GOAL ("Team to Score First", side-checked
//    by team subject), symmetric BTTS/DRAW (same-game), and TOTALS/SPREADS
//    (additionally matched on SCOPE [full vs half / 1st-5-innings], DIRECTION
//    [over/under, which team covers], LINE, and SUBJECT [combined game total vs a
//    single team's total], read mostly from yes_sub). A soft category check
//    rejects a pair only when BOTH venues have a (differing) category — Kalshi's
//    is null for most tickers and the taxonomies don't fully align. Still NOT
//    emitted: player props (goalscorer / stat lines, need player-name resolution)
//    and halftime-leader (no clean Kalshi counterpart). The US-sports code↔name
//    gap can conservatively drop legit non-winner pairs whose Kalshi title lacks
//    team names (only the ticker abbreviation, e.g. SFATL). Eyeball both titles.
//  - THE KILLER RISK is settlement-criteria mismatch: the two venues can
//    resolve the "same" event differently (different sources, cutoff times,
//    definitions). Verify both rule pages before treating a gap as risk-free.

const STOPWORDS = new Set([
  'will', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'be', 'is',
  'vs', 'v', 'and', 'or', 'for', 'win', 'wins', 'who', 'what', 'which',
  'market', 'price', 'than', 'this', 'that', 'it', 'do', 'does', 'how',
  'many', 'much', 'before', 'after', 'between', 'over', 'under', 'yes', 'no',
  // Name particles / foreign articles — never a distinguishing identifier, so
  // they must not carry a subject match ("De Chassart" vs "de la Espriella").
  'de', 'del', 'la', 'le', 'les', 'el', 'al', 'du', 'da', 'di', 'dos', 'das',
  'van', 'von', 'der', 'den', 'bin',
]);

export function normalizeTitle(title) {
  return new Set(
    String(title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

// Overlap coefficient |A∩B| / min(|A|,|B|) — robust when one title is a longer
// sentence containing the other's key tokens ("Lakers vs Celtics" inside
// "Will the Lakers beat the Celtics on June 9?").
export function titleSimilarity(aTokens, bTokens) {
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter++;
  return { score: inter / Math.min(aTokens.size, bTokens.size), shared: inter };
}

// Classify the *kind* of bet a title represents so we never pair a moneyline
// winner with a totals/spread/draw market that merely shares the team names.
// Runs on the RAW title (not the token set) because the distinguishing words —
// "over"/"under" and the line number — are stripped by normalizeTitle. Returns
// one of: 'total' | 'outright' | 'prop' | 'spread' | 'draw' | 'winner' (default).
export function classifyMarketType(title) {
  const t = String(title ?? '').toLowerCase();
  // Margin of victory ("Team wins by over N goals") is a SPREAD, not a total —
  // it contains "over", so it must be caught before the O/U total rule below.
  if (/\bwins?\s+by\b|\bto win by\b|\bmargin of victory\b/.test(t)) return 'spread';
  // Over/Under totals: "O/U 2.5", "over/under", "over 2.5 goals", "total points".
  if (/\bo\s*\/?\s*u\b/.test(t) || /\bover\b|\bunder\b/.test(t) || /\btotals?\b/.test(t)) return 'total';
  // Tournament/outright futures ("win the World Cup", "win Group J", "win the
  // title") — a different bet from a single game, so it must not pair with a
  // game winner. Skipped when the title is a head-to-head matchup ("A vs B").
  if (!/\bvs\.?\b/.test(t) &&
      (/\b(world cup|super bowl|champions league|stanley cup|world series|finals|grand slam)\b/.test(t)
       || /\bwin (?:the )?(?:group|division|conference|title|championship|tournament|league)\b/.test(t)))
    return 'outright';
  // Props, SUB-TYPED so different props on the same game never match each other.
  // Symmetric btts and team-subject firstgoal are matched downstream; player
  // props (goalscorer / stat lines) and halftime-leader have no clean cross-venue
  // counterpart yet, so they get distinct types and are suppressed.
  if (/\bboth teams (?:to )?score\b|\bbtts\b/.test(t)) return 'prop:btts';
  // Player props first: "First Goalscorer" / "Anytime Goalscorer" name a PLAYER,
  // not a team — check before the team first-goal rule (which matches "first goal").
  if (/\bgoalscorer\b|\banytime scorer\b|\bclean sheet\b/.test(t)) return 'prop:scorer';
  if (/:\s*\d+\+/.test(t)) return 'prop:player';
  // Team first-goal / "Team to Score First" / "X to score first" — a team subject.
  if (/\b(?:team )?to score first\b|\bscore first\b|\bfirst team to score\b|\bfirst to score\b|\bfirst goal\b|\brecord the first\b|\bopening goal\b/.test(t)) return 'prop:firstgoal';
  if (/\bhalftime\b|\bhalf[- ]time\b|\bleading at\b|\bat the half\b/.test(t)) return 'prop:halftime';
  // Point spread / Asian handicap: "spread", "handicap", "cover", or a signed
  // line. The sign must START a token ((?:^|[\s(])) so date hyphens (2026-06-16)
  // and scores (2-1) — where the sign sits between digits — don't read as spreads.
  if (/\bspread\b|\bhandicap\b|\bhcap\b|\bcover\b/.test(t) || /(?:^|[\s(])[+\-−]\d+(?:\.\d+)?\b/.test(t)) return 'spread';
  // Dedicated draw/tie markets (common in soccer 3-way books).
  if (/\bdraw\b|\btie\b/.test(t)) return 'draw';
  // Default: head-to-head winner / moneyline (incl. "winner", "to win", "beat").
  return 'winner';
}

// Extract the betting line for totals/spreads (e.g. 2.5 from "O/U 2.5"). Only
// decimal lines are returned — bare integers are skipped to avoid grabbing
// years, kickoff times, or counts. null when no clean line is present.
export function extractLine(title) {
  const m = String(title ?? '').match(/(\d+\.\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Outcome (side) identity ─────────────────────────────────────────────────
// Token overlap on the title only proves "same event", not "same outcome". A
// 3-way game has three Kalshi tickers that SHARE ONE TITLE ("Argentina vs
// Algeria Winner?"); the side lives in yes_sub ("Argentina"/"Algeria"/"Tie").
// Polymarket instead splits the event into per-outcome YES/NO markets whose
// title names the subject ("Will Argentina win on 2026-06-16?"). To know two
// YES contracts are the same bet we must compare the SUBJECT, not just tokens.

// Kalshi: the YES side's subject from yes_sub. Returns a token Set, or null when
// indeterminate — generic "Yes" labels (→ empty after stopwords) and comma-
// joined multi-leg parlays (KXMVE* markets) are treated as "no clean subject".
export function kalshiYesSubject(yesSub) {
  const s = String(yesSub ?? '').trim();
  if (!s || s.includes(',')) return null;
  const tokens = normalizeTitle(s.replace(/^yes\s+/i, ''));
  return tokens.size ? tokens : null;
}

// Normalize a team name to a single alnum string ("Atlanta Braves" → "atlantabraves").
const normTeam = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// outcomeIndex baked into a Polymarket ticker (PM-<cid>-<index>); defaults to 0.
function polyOutcomeIndex(ticker) {
  const m = String(ticker ?? '').match(/-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

// Split a Polymarket "Team A vs. Team B" title into its two sides, stripping a
// leading "Spread:"/"Game N:" tag, a trailing line "(-3.5)", and a ": <prop/total>"
// suffix. Returns [a, b] or null when it isn't a two-sided matchup title.
export function splitMatchupTitle(title) {
  const cleaned = String(title ?? '')
    .replace(/^(?:\d+(?:st|nd|rd|th)\s+\d+\s+innings\s+)?(?:spread|game \d+):\s*/i, '')
    .replace(/:\s.*$/, '')                 // drop a ": <suffix>" (prop / total / scope)
    .replace(/\(\s*[+\-−]?\d+(?:\.\d+)?\s*\)\s*$/, '') // drop a trailing "(-3.5)"
    .trim();
  // Only "vs"/"@" separate the two sides. Bare "at" is NOT used: it false-splits
  // phrases like "France leading at halftime?" into bogus teams.
  const m = cleaned.match(/^(.+?)\s+(?:vs\.?|@)\s+(.+)$/i);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

// Polymarket: the YES subject for a side-based (winner) market. Two shapes:
//   "Will <X> win …?"        → YES pays on X winning;
//   "<Team A> vs. <Team B>"  → outcomes ARE the teams; the YES token is the team
//                              at the ticker's outcomeIndex (index 0 = first team).
// Returns a token Set, or null when the title isn't a recognizable winner market.
export function polyYesSubject(ticker, title) {
  const willMatch = String(title ?? '').match(/\bwill\s+(.+?)\s+(?:win|to win|beat)\b/i);
  if (willMatch) {
    const tokens = normalizeTitle(willMatch[1]);
    return tokens.size ? tokens : null;
  }
  const teams = splitMatchupTitle(title);
  if (teams) {
    const side = teams[polyOutcomeIndex(ticker)];
    const tokens = normalizeTitle(side ?? '');
    return tokens.size ? tokens : null;
  }
  return null;
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// Best-effort event date as YYYY-MM-DD, used to keep a team's multiple games
// apart (Polymarket disambiguates them by date in the title). Kalshi encodes it
// in the ticker (…-26JUN16…); Polymarket spells it in the title (2026-06-16).
// null when no date is present — callers must not reject on a missing date.
export function eventDate({ source, ticker, title }) {
  if (source === 'kalshi') {
    const m = String(ticker ?? '').match(/-(\d{2})([A-Z]{3})(\d{2})/);
    if (m && MONTHS[m[2].toLowerCase()]) return `20${m[1]}-${MONTHS[m[2].toLowerCase()]}-${m[3]}`;
    return null;
  }
  const m = String(title ?? '').match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const overlaps = (a, b) => { for (const t of a) if (b.has(t)) return true; return false; };

// ── Matchup (event) identity for non-winner markets ─────────────────────────
// Totals / spreads / props / draws are about a GAME, not a side, so "same bet"
// needs "same game". Winner titles name the teams ("San Francisco vs Atlanta"),
// but generic props don't ("Will both teams score?") — there the teams live only
// in the Kalshi ticker's matchup code (…IRQNOR…). This is what stops an Iraq-
// Norway prop pairing with a France-Senegal prop just because both say "score".

// Words that describe the bet, not the teams — dropped so only team tokens remain.
const GENERIC_EVENT_WORDS = new Set([
  'both', 'teams', 'team', 'score', 'scores', 'scored', 'goal', 'goals', 'first',
  'second', 'half', 'innings', 'inning', 'quarter', 'period', 'clean', 'sheet',
  'run', 'runs', 'corner', 'corners', 'card', 'cards', 'penalty', 'winner', 'game',
  'match', 'spread', 'points', 'point', 'total', 'totals', 'extra', 'go', 'there',
]);

// Team-name tokens from a title: normalized tokens minus generic bet words and
// bare numbers (years / lines). "San Francisco vs Atlanta Winner?" → {san,francisco,atlanta}.
function teamTokens(title) {
  return new Set([...normalizeTitle(title)]
    .filter((w) => !GENERIC_EVENT_WORDS.has(w) && !/^\d+$/.test(w)));
}

// The concatenated team-code blob from a Kalshi ticker (…-26JUN16IRQNOR-BTTS →
// "irqnor"), league-agnostic so it covers World Cup tickers that sportsApi's
// league map doesn't. null when the segment isn't <date><time?><letters>.
export function kalshiMatchupBlob(ticker) {
  const dash = String(ticker ?? '').indexOf('-');
  if (dash < 0) return null;
  const rest = ticker.slice(dash + 1);
  const lastDash = rest.lastIndexOf('-');
  const seg = lastDash >= 0 ? rest.slice(0, lastDash) : rest;
  const m = seg.match(/^\d{2}[A-Z]{3}\d{2}(?:\d{4})?([A-Za-z]+)$/);
  return m ? m[1].toLowerCase() : null;
}

// Is a Polymarket team name present in a Kalshi market's identity? Matches its
// word tokens against the Kalshi title's team tokens (US sports name the teams),
// else its first-3 / full form as a substring of the ticker blob (World Cup uses
// ISO3 codes ≈ first 3 letters: France→fra in "frasen").
function teamPresent(name, kTok, kBlob) {
  const words = [...teamTokens(name)];
  if (words.some((w) => kTok.has(w))) return true;
  const norm = normTeam(name);
  if (norm.length >= 3 && (kBlob.includes(norm) || kBlob.includes(norm.slice(0, 3)))) return true;
  return words.some((w) => w.length >= 3 && kBlob.includes(w.slice(0, 3)));
}

// Do a Kalshi market and a Polymarket market describe the same game? When the PM
// title is a two-team matchup, BOTH teams must be present in the Kalshi identity;
// otherwise fall back to requiring a shared team token.
function sameMatchup(kTitle, kTicker, pTitle) {
  const kTok = teamTokens(kTitle);
  const kBlob = kalshiMatchupBlob(kTicker) ?? '';
  const pTeams = splitMatchupTitle(pTitle);
  if (pTeams) return pTeams.every((name) => teamPresent(name, kTok, kBlob));
  const pTok = teamTokens(pTitle);
  return pTok.size > 0 && overlaps(pTok, kTok);
}

// ── Totals / spreads: scope · subject · direction · line ────────────────────
// Totals and spreads share a line and the same teams across many near-identical
// markets, so "same bet" also needs SCOPE (full game vs half / 1st-5-innings),
// SUBJECT (combined game total vs a single team's total), and DIRECTION (over vs
// under; which team covers). yes_sub carries these on BOTH venues — Kalshi
// "Over 2.5 goals scored" / "Over 1.5 1H goals scored" / "France wins by over 2.5
// goals"; Polymarket "Over" / "Under" or the covering team — so read it there,
// falling back to the title.

function eventScope(text) {
  const t = String(text).toLowerCase();
  if (/\b(?:1st|first) 5 innings\b|\bf5\b/.test(t)) return 'f5';
  if (/\b1h\b|\b(?:1st|first) half\b/.test(t)) return '1h';
  if (/\b2h\b|\b(?:2nd|second) half\b/.test(t)) return '2h';
  return 'full';
}

// Text after "Team A vs. Team B:" in a Polymarket title ("…: France O/U 1.5" →
// "France O/U 1.5"); '' when there is no such suffix.
function matchupSuffix(title) {
  const m = String(title ?? '').match(/\bvs\.?\s.+?:\s(.+)$/i);
  return m ? m[1].trim() : '';
}

// Over/Under direction of a totals market (null if undeterminable).
function totalDirection(title, yesSub) {
  const t = `${yesSub ?? ''} ${title ?? ''}`.toLowerCase();
  if (/\bunder\b/.test(t)) return 'under';
  if (/\bover\b/.test(t)) return 'over';
  return null;
}

// The team a total is about — null means a combined GAME total. Polymarket: the
// team named before "O/U" in the suffix; Kalshi: the team before "over/under" in
// yes_sub. "France O/U 1.5" / "Senegal over 2.5 goals" → {france} / {senegal};
// "O/U 2.5" / "Over 2.5 goals scored" → null.
function totalSubjectTeam(source, title, yesSub) {
  const label = source === 'polymarket' ? matchupSuffix(title) : (yesSub ?? title);
  const before = String(label).toLowerCase().split(/\bover\b|\bunder\b|\bo\/?u\b/)[0];
  const toks = teamTokens(before);
  return toks.size ? toks : null;
}

// The covering (favored) team of a spread — YES pays if this team covers the line.
// Polymarket: the YES outcome label is the team (idx0 of "Spread: TEAM (-x.5)");
// Kalshi: the team before "wins by" in "France wins by over 2.5 goals".
function spreadTeam(source, title, yesSub) {
  if (source === 'polymarket') {
    if (yesSub && !/^(?:over|under|yes|no)$/i.test(String(yesSub).trim())) return teamTokens(yesSub);
    const m = String(title).replace(/^.*spread:\s*/i, '').match(/^(.+?)\s*\(/);
    return m ? teamTokens(m[1]) : null;
  }
  const m = String(yesSub ?? title).match(/^(.+?)\s+wins?\s+by\b/i);
  return m ? teamTokens(m[1]) : null;
}

// Kalshi taker fee in cents for one contract at price P cents: 7·p·(1−p),
// rounded up to the next cent (matches the auto-trader's fee model).
function kalshiTakerFeeCents(priceCents) {
  const p = priceCents / 100;
  return Math.ceil(7 * p * (1 - p));
}

/**
 * Scan recent trades on both venues for cross-venue price gaps.
 * Returns candidates sorted by net edge (cents), best first.
 */
export function scanForArbs({
  windowHours = 6,
  minNetCents = 4,
  matchThreshold = 0.7,
  minSharedTokens = 2,
  maxResults = 10,
} = {}) {
  const sinceMs = Date.now() - windowHours * 3600_000;
  const rows = getLatestTradePricesSince(sinceMs);
  const kalshi = rows.filter((r) => r.source === 'kalshi' && r.yes_price != null);
  const poly   = rows.filter((r) => r.source === 'polymarket' && r.yes_price != null);
  if (kalshi.length === 0 || poly.length === 0) {
    return { scanned: { kalshi: kalshi.length, polymarket: poly.length }, candidates: [] };
  }

  const meta = new Map(
    getTitlesForTickers([...kalshi, ...poly].map((r) => r.ticker)).map((t) => [t.ticker, t]),
  );
  const titleOf = (ticker) => meta.get(ticker)?.title ?? '';
  const tokensFor = (ticker) => normalizeTitle(titleOf(ticker));

  // Comma-joined titles are multi-leg parlay/multi-outcome blobs (Kalshi KXMVE*
  // markets), not a single binary market — their leg list token-matches anything.
  const isComposite = (s) => s.includes(',');

  const candidates = [];
  for (const k of kalshi) {
    const kTokens = tokensFor(k.ticker);
    if (kTokens.size === 0) continue;
    const kTitle = titleOf(k.ticker);
    if (isComposite(kTitle)) continue;
    const kType = classifyMarketType(kTitle);
    // First-goal ("Team to Score First") has a single team subject, so it matches
    // like a winner; other props are handled (btts/draw) or suppressed below.
    const sideBased = kType === 'winner' || kType === 'outright' || kType === 'prop:firstgoal';
    const kYesSub = meta.get(k.ticker)?.yes_sub;
    const kCat = meta.get(k.ticker)?.category;
    const kSubj = kalshiYesSubject(kYesSub);
    const kDate = eventDate({ source: 'kalshi', ticker: k.ticker, title: kTitle });

    for (const p of poly) {
      const pTokens = tokensFor(p.ticker);
      if (pTokens.size === 0) continue;
      const pTitle = titleOf(p.ticker);
      if (isComposite(pTitle)) continue;

      // Market-type guard: shared team names are NOT enough — a "Winner?" market
      // and an "O/U 2.5" market are different bets. Reject conflicting types.
      const pType = classifyMarketType(pTitle);
      if (kType !== pType) continue;
      const pYesSub = meta.get(p.ticker)?.yes_sub;
      // Category sanity (SOFT): Kalshi category is null for most tickers and the
      // two venues' taxonomies don't fully align, so only reject when BOTH are
      // present and differ — cheap cross-domain defense (golf "Sports" vs an
      // election "Elections") that never fires on the common null-category case.
      const pCat = meta.get(p.ticker)?.category;
      if (kCat && pCat && kCat !== pCat) continue;

      // Same-game guard: a team plays many games, so when both titles carry an
      // event date it must match (Polymarket disambiguates games by date).
      const pDate = eventDate({ source: 'polymarket', ticker: p.ticker, title: pTitle });
      if (kDate && pDate && kDate !== pDate) continue;

      // Title similarity (used by the side path + for reporting).
      const { score, shared } = titleSimilarity(kTokens, pTokens);

      let matchBasis;
      if (sideBased) {
        // Winner / outright: token overlap proves same EVENT; the subject proves
        // same SIDE. When both subjects are known they must agree — this stops
        // "Argentina to win" pairing with "Algeria to win", and a Kalshi team
        // pairing with the OPPOSITE team of a Polymarket "A vs B" market.
        const pSubj = polyYesSubject(p.ticker, pTitle);
        const bothSubjKnown = kSubj && pSubj;
        const subjAgree = bothSubjKnown && overlaps(kSubj, pSubj);
        if (bothSubjKnown && !subjAgree) continue; // opposite sides — reject
        // Same-game: when the PM title names both teams, the Kalshi market must be
        // that exact matchup — stops "Tampa Bay vs LA Dodgers" pairing with a
        // different LA team's game just because "Los Angeles" overlaps.
        if (splitMatchupTitle(pTitle) && !sameMatchup(kTitle, k.ticker, pTitle)) continue;
        const titleMatch = score >= matchThreshold && shared >= minSharedTokens;
        // PM winner titles name only one team, so they can't clear the title
        // threshold against Kalshi's "A vs B" — match on the agreed subject instead.
        const subjectMatch = subjAgree && overlaps(pSubj, kTokens);
        if (!titleMatch && !subjectMatch) continue;
        matchBasis = titleMatch ? (subjectMatch ? 'title+subject' : 'title') : 'subject';
      } else if (kType === 'prop:btts' || kType === 'draw') {
        // Symmetric markets (both-teams-score, draw): no single side and the YES
        // is binary, so direction aligns — just require the SAME GAME by team
        // identity (title team names, or the Kalshi ticker matchup code).
        if (!sameMatchup(kTitle, k.ticker, pTitle)) continue;
        matchBasis = 'matchup';
      } else if (kType === 'total') {
        // Totals must agree on the SAME GAME, SCOPE (full vs 1H vs 1st-5-innings),
        // DIRECTION (over/under), LINE, and SUBJECT (combined game total vs a
        // specific team's total) — otherwise it's a different bet on a shared line.
        if (!sameMatchup(kTitle, k.ticker, pTitle)) continue;
        if (eventScope(`${kTitle} ${kYesSub ?? ''}`) !== eventScope(`${pTitle} ${pYesSub ?? ''}`)) continue;
        const kDir = totalDirection(kTitle, kYesSub), pDir = totalDirection(pTitle, pYesSub);
        if (!kDir || !pDir || kDir !== pDir) continue;
        const kLine = extractLine(kTitle) ?? extractLine(kYesSub);
        const pLine = extractLine(pTitle) ?? extractLine(pYesSub);
        if (kLine == null || pLine == null || kLine !== pLine) continue;
        const kSub = totalSubjectTeam('kalshi', kTitle, kYesSub);
        const pSub = totalSubjectTeam('polymarket', pTitle, pYesSub);
        if (!!kSub !== !!pSub) continue;              // game-total vs team-total
        if (kSub && !overlaps(kSub, pSub)) continue;  // different team's total
        matchBasis = 'total';
      } else if (kType === 'spread') {
        // Spreads must agree on the SAME GAME, SCOPE, LINE, and the covering team
        // (YES = that team covers) — a same .5 line means the same margin bet.
        if (!sameMatchup(kTitle, k.ticker, pTitle)) continue;
        if (eventScope(`${kTitle} ${kYesSub ?? ''}`) !== eventScope(`${pTitle} ${pYesSub ?? ''}`)) continue;
        const kLine = extractLine(kTitle) ?? extractLine(kYesSub);
        const pLine = extractLine(pTitle) ?? extractLine(pYesSub);
        if (kLine == null || pLine == null || kLine !== pLine) continue;
        const kTeam = spreadTeam('kalshi', kTitle, kYesSub);
        const pTeam = spreadTeam('polymarket', pTitle, pYesSub);
        if (!kTeam || !pTeam || !overlaps(kTeam, pTeam)) continue;
        matchBasis = 'spread';
      } else {
        // Remaining props — player goalscorer/stat-line (prop:scorer/prop:player,
        // need cross-venue player-name resolution) and halftime-leader
        // (prop:halftime, no clean Kalshi counterpart) — stay suppressed.
        continue;
      }

      // Both YES prices in cents. Buy YES on the cheaper venue + NO on the other:
      // cost = min(Pk,Pp) + (100 − max(Pk,Pp)) → gross = |Pk − Pp|.
      const Pk = k.yes_price, Pp = p.yes_price;
      const grossCents = Math.abs(Pk - Pp);
      const kalshiLegPrice = Pk <= Pp ? Pk : 100 - Pk; // YES if cheap side, else NO
      const netCents = grossCents - kalshiTakerFeeCents(kalshiLegPrice);
      if (netCents < minNetCents) continue;

      candidates.push({
        kalshiTicker: k.ticker,
        polyTicker: p.ticker,
        kalshiTitle: kTitle || '(no title)',
        polyTitle: pTitle || '(no title)',
        kalshiYesSub: kYesSub ?? null,
        polyYesSub: pYesSub ?? null,
        kalshiYesCents: Pk,
        polyYesCents: Pp,
        direction: Pk <= Pp
          ? `buy KALSHI YES @${Pk}¢ + POLY NO @${100 - Pp}¢`
          : `buy POLY YES @${Pp}¢ + KALSHI NO @${100 - Pk}¢`,
        grossCents,
        netCents,
        marketType: kType,
        matchBasis,
        matchScore: Number(score.toFixed(2)),
        kalshiAgeMin: Math.round((Date.now() - k.ts_ms) / 60_000),
        polyAgeMin: Math.round((Date.now() - p.ts_ms) / 60_000),
      });
    }
  }

  candidates.sort((a, b) => b.netCents - a.netCents);
  // De-dupe by venue pair: a ts_ms tie in "latest trade per ticker" can surface
  // the same ticker twice; keep the best (already sorted) instance of each pair.
  const seen = new Set();
  const unique = candidates.filter((c) => {
    const key = `${c.kalshiTicker}|${c.polyTicker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    scanned: { kalshi: kalshi.length, polymarket: poly.length },
    candidates: unique.slice(0, maxResults),
  };
}
