// Side-effect import that loads the project's .env BEFORE any module reads
// process.env. ESM evaluates imports top-down, so importing this first
// guarantees AUTH_TOKEN / ANTHROPIC_API_KEY are present by the time
// agentTrader.js runs its top-level guards.
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
// .env lives at the project root (one level up from agent-trader/).
config({ path: resolve(here, '..', '.env') });
