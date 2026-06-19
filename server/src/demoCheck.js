// Verify Kalshi API credentials authenticate, by making a single signed
// GET /portfolio/balance against whatever environment is loaded.
//
//   npm run demo:check        # uses ENV_FILE=.env.demo → the demo API
//
// Exits 0 on a 200 (auth OK), non-zero otherwise. Read-only: places no orders.
import './loadEnv.js';
import { sign, constants } from 'crypto';
import { loadPrivateKey } from './auth.js';
import { KALSHI_TRADING_BASE, IS_DEMO } from './kalshiEnv.js';

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

const apiKeyId = process.env.KALSHI_API_KEY_ID;
const keyPath  = process.env.KALSHI_PRIVATE_KEY_PATH;

if (!apiKeyId) fail('KALSHI_API_KEY_ID is not set (check .env.demo).');
if (!keyPath && !process.env.KALSHI_PRIVATE_KEY) {
  fail('Neither KALSHI_PRIVATE_KEY_PATH nor KALSHI_PRIVATE_KEY is set (check .env.demo).');
}

let privateKey;
try {
  privateKey = loadPrivateKey(keyPath);
} catch (e) {
  fail(`Could not load the private key (${keyPath}): ${e.message}`);
}

const url  = `${KALSHI_TRADING_BASE}/portfolio/balance`;
const path = new URL(url).pathname; // e.g. /trade-api/v2/portfolio/balance
const ts   = Date.now().toString();
const signature = sign('sha256', Buffer.from(ts + 'GET' + path, 'utf8'), {
  key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32,
}).toString('base64');

console.log(`[demo:check] env:  ${IS_DEMO ? '⚠️  DEMO (paper money)' : '💰 LIVE (real money)'}`);
console.log(`[demo:check] GET   ${url}`);
console.log(`[demo:check] key:  ${apiKeyId.slice(0, 8)}…`);

try {
  const res  = await fetch(url, {
    headers: {
      'KALSHI-ACCESS-KEY':       apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': ts,
    },
  });
  const raw = await res.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }

  if (res.ok) {
    const cents = (body && typeof body === 'object' && typeof body.balance === 'number') ? body.balance : null;
    console.log(
      `✅ authenticated (HTTP ${res.status}).` +
      (cents != null ? `  Balance: $${(cents / 100).toFixed(2)}` : `  Response: ${JSON.stringify(body)}`)
    );
    process.exit(0);
  }

  console.error(`❌ auth failed (HTTP ${res.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  if (res.status === 401) {
    console.error('   → Confirm the Key ID + private key are a matching pair, and that they are');
    console.error('     DEMO credentials created at demo.kalshi.co (prod keys 401 against demo).');
  }
  process.exit(1);
} catch (e) {
  fail(`Request error reaching ${url}: ${e.message}`);
}
