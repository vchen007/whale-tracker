/**
 * ESPN scoreboard client — fetches actual game start times.
 *
 * Public, no auth. We use it to resolve real kickoff/tip-off times so the
 * dashboard's PRE/LIVE badge matches reality (not the eventEnd-3h estimate).
 *
 * Coverage: NBA, NHL, MLB, NFL, EPL, La Liga, Bundesliga, Serie A, MLS,
 * UEFA Champions League. We fetch each sport's scoreboard once per hour
 * for today + tomorrow and build a lookup map.
 */

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const REFRESH_MS = 60 * 60 * 1000; // every 60 min
const SCHEDULE_LOOKAHEAD_DAYS = 2;

// Map Kalshi league code → ESPN sport path. We detect the league from any
// prefix that starts with KX<LEAGUE>... so we cover GAME, SPREAD, TOTAL,
// SERIES, RFI (run-first-inning), etc. — they all use the same date+team
// encoding under the league.
const LEAGUE_TO_SPORT = {
  'NBA':       'basketball/nba',
  'NHL':       'hockey/nhl',
  'MLB':       'baseball/mlb',
  'NFL':       'football/nfl',
  'EPL':       'soccer/eng.1',
  'LALIGA':    'soccer/esp.1',
  'BUNDES':    'soccer/ger.1',
  'SERIEA':    'soccer/ita.1',
  'UCL':       'soccer/uefa.champions',
  'MLS':       'soccer/usa.1',
};

// Regex: KX<LEAGUE><anything>-<rest>. The league is greedy-matched against
// LEAGUE_TO_SPORT keys, longest match wins (handles BUNDESLIGA vs BUNDES).
const KALSHI_LEAGUE_RE = new RegExp(
  '^KX(' + Object.keys(LEAGUE_TO_SPORT).sort((a, b) => b.length - a.length).join('|') + ')',
);

const SUPPORTED_SPORT_PATHS = [...new Set(Object.values(LEAGUE_TO_SPORT))];

// Map polymarket-style team/league hints → ESPN path. Polymarket titles often
// say "Lakers vs. Thunder" etc. We sample tags + titles to detect sport.
function detectPolymarketSport(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/\b(nba|lakers|thunder|warriors|celtics|knicks|76ers|bucks|nuggets|heat|clippers|suns|mavericks|rockets|jazz|spurs|grizzlies|pelicans|kings|timberwolves|trail blazers|magic|hawks|hornets|wizards|raptors|cavaliers|pistons|bulls|pacers|game \d+:.*at)\b/i.test(t)) return 'basketball/nba';
  if (/\b(nhl|rangers|maple leafs|bruins|panthers|hurricanes|flyers|penguins|capitals|lightning|oilers|kings|sharks|kraken|avalanche|stars|wild|jets|flames|canucks)\b/i.test(t)) return 'hockey/nhl';
  if (/\b(mlb|yankees|red sox|dodgers|astros|braves|phillies|mets|cubs|cardinals|brewers|reds|pirates|nationals|orioles|rays|blue jays|guardians|tigers|royals|twins|white sox|angels|athletics|mariners|rangers|rockies|diamondbacks|giants|padres|marlins)\b/i.test(t)) return 'baseball/mlb';
  if (/\b(nfl|chiefs|bills|49ers|cowboys|eagles|ravens|patriots|packers|seahawks)\b/i.test(t)) return 'football/nfl';
  if (/\b(arsenal|liverpool|man city|man united|manchester united|chelsea|tottenham|newcastle|aston villa|everton|wolves|brighton|leicester|epl|premier league)\b/i.test(t)) return 'soccer/eng.1';
  if (/\b(real madrid|barcelona|atletico|atletico madrid|sevilla|valencia|villarreal|laliga|la liga)\b/i.test(t)) return 'soccer/esp.1';
  if (/\b(psg|paris saint-germain|bayern munich|bayern|inter milan|ac milan|juventus|champions league|ucl)\b/i.test(t)) return 'soccer/uefa.champions';
  return null;
}

// In-memory schedule cache: Map<key, ISO_start_time>
// Keys are normalized: `<sport>:<teamA>|<teamB>:<dateUTC>`
const scheduleMap = new Map();

function normTeam(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function dateKey(isoString) {
  return isoString.slice(0, 10); // YYYY-MM-DD
}

/**
 * Fetch one sport's scoreboard for a given date. Returns parsed games.
 */
async function fetchScoreboard(sportPath, dateYYYYMMDD) {
  try {
    const url = `${ESPN_BASE}/${sportPath}/scoreboard?dates=${dateYYYYMMDD}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'whale-tracker/1.0' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events ?? []).map((e) => {
      const comp = e.competitions?.[0] ?? {};
      const teams = (comp.competitors ?? []).map((c) => c.team ?? {});
      return {
        date: e.date,
        sportPath,
        abbrs: teams.map((t) => normTeam(t.abbreviation)),
        names: teams.map((t) => normTeam(t.displayName)),
        shorts: teams.map((t) => normTeam(t.shortDisplayName)),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Refresh the global schedule map. Fetches each supported sport for the next
 * SCHEDULE_LOOKAHEAD_DAYS days. Builds a lookup keyed by every team identifier
 * so we can match either Kalshi abbreviations or Polymarket team names.
 */
export async function refreshSchedule() {
  const now = new Date();
  const dates = [];
  for (let d = -1; d < SCHEDULE_LOOKAHEAD_DAYS; d++) {
    const dt = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
    dates.push(dt.toISOString().slice(0, 10).replace(/-/g, ''));
  }

  let totalGames = 0;
  for (const sportPath of SUPPORTED_SPORT_PATHS) {
    for (const date of dates) {
      const games = await fetchScoreboard(sportPath, date);
      for (const g of games) {
        // Index by every combination of team identifiers, in either order
        const idents = g.abbrs.concat(g.names, g.shorts).filter(Boolean);
        if (idents.length < 2) continue;
        for (let i = 0; i < idents.length; i++) {
          for (let j = 0; j < idents.length; j++) {
            if (i === j) continue;
            const key = `${sportPath}:${idents[i]}-${idents[j]}:${dateKey(g.date)}`;
            scheduleMap.set(key, g.date);
          }
        }
        totalGames++;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  console.log(`[espn] schedule cache refreshed: ${totalGames} games, ${scheduleMap.size} keys`);
}

/**
 * Lookup a game's actual start time from the cached schedule.
 * @param {string} sportPath  e.g. 'basketball/nba'
 * @param {string} teamA      any identifier (abbr/name/short), case-insensitive
 * @param {string} teamB      any identifier
 * @param {string} dateUtc    'YYYY-MM-DD' day of the game in UTC
 */
export function lookupGameStart(sportPath, teamA, teamB, dateUtc) {
  if (!sportPath || !teamA || !teamB || !dateUtc) return null;
  const a = normTeam(teamA);
  const b = normTeam(teamB);
  return scheduleMap.get(`${sportPath}:${a}-${b}:${dateUtc}`)
      || scheduleMap.get(`${sportPath}:${b}-${a}:${dateUtc}`)
      || null;
}

/**
 * Detect sport + extract candidate team identifiers from a Kalshi ticker.
 * Returns null if ticker doesn't match a supported sport.
 *
 * Examples:
 *   KXNBAGAME-26MAY07LALOKC-OKC → { sport: 'basketball/nba', teams: ['LAL','OKC'], date: '2026-05-07' }
 *   KXMLBGAME-26MAY051945MILSTL-STL → { sport: 'baseball/mlb', teams: ['MIL','STL'], date: '2026-05-05' }
 */
export function parseKalshiTicker(ticker) {
  if (!ticker) return null;

  // Detect league from prefix (KXNBA*, KXMLB*, KXNHL*, KXNFL*, etc.)
  const leagueMatch = ticker.match(KALSHI_LEAGUE_RE);
  if (!leagueMatch) return null;
  const sport = LEAGUE_TO_SPORT[leagueMatch[1]];

  // Strip the prefix up to the first '-' (e.g., "KXNBASPREAD-" or "KXNBAGAME-")
  const dashIdx = ticker.indexOf('-');
  if (dashIdx < 0) return null;
  const rest = ticker.slice(dashIdx + 1);

  // Remainder format: <date><[hhmm]><teamPair>-<outcome>
  const lastDash = rest.lastIndexOf('-');
  if (lastDash < 0) return null;
  const dateAndTeams = rest.slice(0, lastDash);
  const outcome = rest.slice(lastDash + 1);

  // Date is YYMMMDD (2 digit year, 3 letter month, 2 digit day)
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const dateMatch = dateAndTeams.match(/^(\d{2})([A-Z]{3})(\d{2})/);
  if (!dateMatch) return null;
  const yy = parseInt(dateMatch[1], 10);
  const monthIdx = months[dateMatch[2]];
  const dd = parseInt(dateMatch[3], 10);
  if (monthIdx == null) return null;
  const year = 2000 + yy;
  const dateStr = `${year}-${String(monthIdx + 1).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

  // After the 7-char date, optional 4-digit HHMM, then concatenated team codes
  let cursor = 7;
  if (/^\d{4}/.test(dateAndTeams.slice(7, 11))) cursor = 11;
  const teamBlob = dateAndTeams.slice(cursor);

  // teamBlob = "LALOKC" or "DENMIN" — try all plausible 2-4 char splits
  const splits = [];
  for (let n = 2; n <= 4; n++) {
    if (teamBlob.length - n >= 2 && teamBlob.length - n <= 4) {
      splits.push([teamBlob.slice(0, n), teamBlob.slice(n)]);
    }
  }
  return { sport, splits, outcome, date: dateStr, teamBlob };
}

/**
 * Find a game's start time for a Kalshi ticker. Tries every plausible
 * team-code split until one hits the schedule cache.
 */
export function findKalshiGameStart(ticker) {
  const parsed = parseKalshiTicker(ticker);
  if (!parsed) return null;
  for (const [a, b] of parsed.splits) {
    const start = lookupGameStart(parsed.sport, a, b, parsed.date);
    if (start) return start;
  }
  return null;
}

/**
 * Find a game's start time for a Polymarket trade by title + date.
 * Title format is usually "TeamA vs. TeamB" or similar.
 */
export function findPolymarketGameStart(title, isoDate) {
  if (!title || !isoDate) return null;
  const sport = detectPolymarketSport(title);
  if (!sport) return null;

  // Pull the two team names: "Lakers vs. Thunder" → ["Lakers", "Thunder"]
  // Also handle "Game N: TeamA at TeamB", "Spread: TeamX (-N.N)"
  const dateUtc = isoDate.slice(0, 10);
  const cleaned = title.replace(/^(Game \d+:\s*|Spread:\s*)/i, '').replace(/\(-?\d+\.?\d*\)\s*$/, '').trim();
  const splitMatch = cleaned.match(/(.+?)\s+(?:vs\.?|at|@|-)\s+(.+)/i);
  if (!splitMatch) return null;
  const a = splitMatch[1].trim();
  const b = splitMatch[2].trim();
  return lookupGameStart(sport, a, b, dateUtc);
}

// Auto-refresh loop kicks in when the module is wired into index.js
let _started = false;
export function startSchedulePoller() {
  if (_started) return;
  _started = true;
  refreshSchedule().catch((e) => console.error('[espn] initial refresh failed:', e.message));
  setInterval(() => {
    refreshSchedule().catch((e) => console.error('[espn] refresh error:', e.message));
  }, REFRESH_MS);
}
