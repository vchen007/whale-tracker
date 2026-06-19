// One-shot cross-venue arb scan against the local trades DB.
//
//   npm run arb:scan                          # scan, print candidates
//   node server/src/arbScan.js --hours 48 --min-net 2 --email
//
// Reads ONLY the local DB (no exchange calls). Run against the PROD database
// (default DB_PATH) — demo data has no cross-venue overlap worth scanning.
import './loadEnv.js';
import { initDb } from './db.js';
import { scanForArbs } from './arbDetector.js';
import { notifyArb } from './notify.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};

initDb();
const opts = {
  windowHours: flag('hours', 6),
  minNetCents: flag('min-net', 4),
  matchThreshold: flag('match', 0.7),
};
const { scanned, candidates } = scanForArbs(opts);

console.log(`[arb] scanned last ${opts.windowHours}h — ${scanned.kalshi} kalshi tickers × ${scanned.polymarket} polymarket tickers`);
if (candidates.length === 0) {
  console.log(`[arb] no candidates with net edge >= ${opts.minNetCents}¢ (matching >= ${opts.matchThreshold})`);
  process.exit(0);
}
for (const c of candidates) {
  console.log(
    `\n💹 ${c.netCents}¢ net (${c.grossCents}¢ gross, ${c.marketType}, ${c.matchBasis} match)\n` +
    `   K: ${c.kalshiTicker}  YES ${c.kalshiYesCents}¢ (${c.kalshiAgeMin}m old)  ${c.kalshiTitle}  [YES=${c.kalshiYesSub}]\n` +
    `   P: ${c.polyTicker}  YES ${c.polyYesCents}¢ (${c.polyAgeMin}m old)  ${c.polyTitle}  [YES=${c.polyYesSub}]\n` +
    `   → ${c.direction}`
  );
}
console.log('\n⚠️  Indicative (last-trade prices). Re-check both books + settlement criteria before acting.');

if (args.includes('--email') && candidates.length > 0) {
  await notifyArb(candidates[0]);
  console.log('[arb] emailed top candidate');
}
