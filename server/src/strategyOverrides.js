// strategyOverrides.js — server-enforced guardrails for the daily strategy
// agent. The agent PROPOSES knob changes; THIS module is the single source of
// truth for what it's allowed to touch and by how much. Risk caps (maxCapital,
// maxDailyLoss, maxOpenPositions, maxPerTicker) are deliberately NOT tunable —
// they bound the downside and stay operator-only.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const OVERRIDES_PATH = resolve(here, '../../strategy-overrides.json');

// The ONLY knobs the agent may change — entry-selectivity dials. Each has hard
// absolute bounds and a max per-day step (so it nudges, never lurches).
export const TUNABLE = {
  minPriceCents: { min: 55,    max: 90,   step: 5,    int: true },
  maxPriceCents: { min: 85,    max: 95,   step: 3,    int: true },
  minEvDollars:  { min: -0.02, max: 0.05,  step: 0.01, int: false },
  // Ceiling 0.008 (< the ~0.019 max YES-EV) so the agent can de-prioritize YES
  // but can NEVER fully block it — keeps strong YES favorites in play (operator
  // directive 2026-06-29).
  yesEvPenalty:  { min: 0,     max: 0.008, step: 0.01, int: false },
};

/**
 * Validate a single proposed change against the allowlist, absolute bounds, and
 * the per-call step cap (relative to the current live value).
 * @returns {{ok:true, value:number} | {ok:false, reason:string}}
 */
export function validateChange(name, value, current) {
  const spec = TUNABLE[name];
  if (!spec) return { ok: false, reason: `'${name}' is not tunable (allowed: ${Object.keys(TUNABLE).join(', ')})` };
  let v = Number(value);
  if (!Number.isFinite(v)) return { ok: false, reason: `value '${value}' is not a finite number` };
  if (spec.int) v = Math.round(v);
  if (v < spec.min || v > spec.max) return { ok: false, reason: `${name}=${v} out of bounds [${spec.min}, ${spec.max}]` };
  const cur = Number(current);
  if (Number.isFinite(cur) && Math.abs(v - cur) > spec.step + 1e-9) {
    return { ok: false, reason: `step too large for ${name}: |${v} − ${cur}| > max ${spec.step}/run (held — change gradually)` };
  }
  return { ok: true, value: v };
}

/** Read persisted overrides (agent-applied knob values), or {} if none/invalid. */
export function loadOverrides() {
  try {
    if (!existsSync(OVERRIDES_PATH)) return {};
    const j = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    return (j && typeof j === 'object' && j.values && typeof j.values === 'object') ? j.values : {};
  } catch { return {}; }
}

/** Persist the full current override set (merged), with an audit timestamp. */
export function saveOverrides(values) {
  writeFileSync(OVERRIDES_PATH, JSON.stringify({ values, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}
