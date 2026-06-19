// Side-effect module: load environment variables as early as possible.
//
// ESM evaluates imported modules before the importing module's body runs, so
// any module that reads process.env at top level (e.g. kalshiEnv.js) must be
// sure the env is already loaded. Importing THIS module first guarantees that,
// regardless of which entry point pulled the module in.
//
// Overlay support: set ENV_FILE (e.g. ENV_FILE=.env.demo) to load an overlay
// file FIRST. Its values win; the base .env then fills in everything it didn't
// set (dotenv never overrides a variable that already exists). This lets
// .env.demo carry only the demo-specific keys and inherit the rest from .env.
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 1) Optional overlay (loaded first so it takes precedence).
if (process.env.ENV_FILE) {
  config({ path: resolve(root, process.env.ENV_FILE) });
}
// 2) Base .env (fills in any keys the overlay didn't set).
config({ path: resolve(root, '.env') });
