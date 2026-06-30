#!/usr/bin/env node
// strategyReview.js — daily strategy-tuning agent.
//
// Reviews how the bot's OWN recent bets performed (review_bets) plus the
// historical edge backtest (query_backtest), then AUTO-APPLIES small, bounded
// adjustments to a few allowlisted knobs (set_params) to improve realized P&L.
// The server enforces every guardrail (allowlist, absolute bounds, per-run step
// cap, risk-caps-untouchable) — this agent only proposes. Writes a report to
// outcomes/strategy_review_<date>.md and the server emails any applied change.
//
//   node agent-trader/strategyReview.js
//   node agent-trader/strategyReview.js --max-budget-usd 0.40
//
// Targets the LIVE server (:3002). Reuses agent-trader's SDK install + loadEnv.
import './loadEnv.js';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here       = dirname(fileURLToPath(import.meta.url));
const OUT_DIR    = resolve(here, '../outcomes');
const SERVER_URL = (process.env.LOCAL_SERVER_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) { console.error('AUTH_TOKEN not set.'); process.exit(2); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set.'); process.exit(2); }

const DEFAULTS = { model: 'claude-haiku-4-5', maxTurns: 30, maxBudgetUsd: 0.30, effort: 'medium' };

async function postJSON(path, payload) {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }; }
  } catch (err) { return { error: `request error: ${err.message}` }; }
}
const tool_ = (payload) => postJSON('/agent/tool', payload);
const asText = (p) => ({ content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] });

const getStatus = tool('get_status',
  'Current trader config: the tunable knobs (minPriceCents, maxPriceCents, ' +
    'minEvDollars, yesEvPenalty), calibration α/ψ, and the (NON-tunable) risk caps.',
  {}, async () => asText(await tool_({ action: 'get_status' })), { annotations: { readOnlyHint: true } });

const reviewBetsT = tool('review_bets',
  'How the bot\'s OWN settled bets performed: realized pnl_cents by side and ' +
    'price band, win rates, totals. since_days defaults 30 — widen if the window ' +
    'is thin. This is the bot\'s real money; weight it heavily.',
  { since_days: z.number().int().min(1).max(365).optional() },
  async (a) => asText(await tool_({ action: 'review_bets', ...a })), { annotations: { readOnlyHint: true } });

const queryBacktest = tool('query_backtest',
  'Historical realized edge over 33k+ settled whale trades. group_by: ' +
    'price_band | category | side | series. Returns mean_postfee_cents (the edge) ' +
    'per slice with sample sizes. Use to corroborate where to tilt the knobs.',
  {
    group_by: z.enum(['price_band', 'category', 'side', 'series']).optional(),
    category: z.string().optional(), series_prefix: z.string().optional(),
    side: z.enum(['yes', 'no']).optional(),
    min_price: z.number().int().optional(), max_price: z.number().int().optional(),
    min_sample: z.number().int().optional(),
  },
  async (a) => asText(await tool_({ action: 'query_backtest', ...a })), { annotations: { readOnlyHint: true } });

const setParams = tool('set_params',
  'AUTO-APPLY knob changes to the LIVE trader. ALLOWED knobs ONLY: minPriceCents ' +
    '(55–90), maxPriceCents (85–95), minEvDollars (−0.02..0.05), yesEvPenalty ' +
    '(0..0.03). The server enforces bounds + a small per-run step cap and rejects ' +
    'everything else (risk caps are NOT tunable). Returns per-knob {ok, prev, now} ' +
    'or {ok:false, reason}. Make small nudges; pass a numeric reason.',
  {
    changes: z.record(z.string(), z.number()).describe('knob → new value, e.g. {"yesEvPenalty":0.0,"minPriceCents":69}'),
    reason:  z.string().describe('One line citing the numbers that justify the change.'),
  },
  async (a) => asText(await postJSON('/auto-trader/set-params', { changes: a.changes, reason: a.reason })));

const PROMPT = `You are the DAILY strategy tuner for a LIVE Kalshi maker bot (real money).
You review performance and AUTO-APPLY small, evidence-based knob changes to
improve realized post-fee P&L. The server enforces all guardrails and rejects
anything unsafe; risk caps (capital, daily-loss, position limits) are NOT yours
to change. Goal: more winning bets / more cash, without taking on the kind of
flow the data shows loses money.

PROCEDURE:
1. get_status — note the current knobs.
2. review_bets (since_days 30, then 90 if settled<30) — how have the bot's OWN
   bets actually done, by side and price band? Find the losers.
3. query_backtest by price_band and by side — where does realized post-fee edge
   actually live? Corroborate #2.
4. Decide SMALL adjustments to push the bot toward profitable flow, e.g.:
   • raise minPriceCents if the lowest in-band prices bleed; lower it (toward a
     positive low band) only if both own-bets and backtest support it;
   • set yesEvPenalty toward the observed YES-vs-NO edge gap;
   • nudge minEvDollars up if marginal bets lose, down if you're too selective.
   Apply via ONE set_params call with a numeric reason. The server caps step
   size; a "step too large" rejection just means you reached the per-day max.
5. If the data does NOT justify a change, apply NOTHING — stability is fine and
   you should say so.

Then output a short Markdown report (this becomes the saved record):
  # Strategy Review — <today>
  ## Reviewed   (own-bet P&L + backtest numbers you used)
  ## Changes    (each knob: from → to, the numbers that justify it; or "none")
  ## Watch next (what to check tomorrow)
Be terse and quantitative. Never claim a change "will" win — say what the
evidence supports.`;

function parseArgs() {
  const o = { ...DEFAULTS }; const a = process.argv.slice(2);
  const camel = (s) => s.replace(/^--?/, '').toLowerCase().split(/[-_]/).map((p, i) => i ? p[0].toUpperCase() + p.slice(1) : p).join('');
  for (let i = 0; i < a.length; i++) {
    const k = camel(a[i]); const v = a[i + 1]; if (v === undefined || v.startsWith('-')) continue;
    if (k === 'maxTurns') { o.maxTurns = +v; i++; }
    else if (k === 'maxBudgetUsd') { o.maxBudgetUsd = +v; i++; }
    else if (k === 'model') { o.model = v; i++; }
    else if (k === 'effort') { o.effort = v; i++; }
  }
  return o;
}

async function main() {
  const opts = parseArgs();
  const server = createSdkMcpServer({ name: 'strategy', version: '1.0.0', tools: [getStatus, reviewBetsT, queryBacktest, setParams] });
  console.log(`[strategy-review] model=${opts.model} budget=$${opts.maxBudgetUsd.toFixed(2)} effort=${opts.effort} target=${SERVER_URL}`);

  let finalSubtype = null, finalText = null, cost = null, nTurns = null, sessionId = null;
  const iter = query({
    prompt: PROMPT,
    options: {
      model: opts.model, mcpServers: { strategy: server },
      allowedTools: ['mcp__strategy__*'], tools: [],
      maxTurns: opts.maxTurns, maxBudgetUsd: opts.maxBudgetUsd, effort: opts.effort,
      systemPrompt: 'You are a disciplined, quantitative trading-strategy tuner. ' +
        'You make small evidence-based changes within the server\'s guardrails ' +
        'and never overclaim. Risk caps are off-limits.',
    },
  });

  for await (const m of iter) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') { let i = JSON.stringify(b.input); if (i.length > 160) i = i.slice(0, 160) + '…'; console.log(`  → ${b.name}(${i})`); }
        else if (b.type === 'text') { const t = b.text.trim(); if (t) console.log(`    ${t.slice(0, 120)}${t.length > 120 ? '…' : ''}`); }
      }
    } else if (m.type === 'result') {
      finalSubtype = m.subtype; finalText = m.subtype === 'success' ? m.result : null;
      cost = m.total_cost_usd ?? null; nTurns = m.num_turns ?? null; sessionId = m.session_id ?? null;
    }
  }

  console.log(`\n[strategy-review] result: ${finalSubtype}  cost=$${(cost ?? 0).toFixed(4)}  turns=${nTurns}  session=${sessionId}`);
  if (finalText) {
    mkdirSync(OUT_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = resolve(OUT_DIR, `strategy_review_${date}.md`);
    const header = `<!-- Auto-generated by strategyReview.js on ${new Date().toISOString()} ` +
      `(model ${opts.model}, cost $${(cost ?? 0).toFixed(4)}, session ${sessionId}). ` +
      `Knob changes (if any) were auto-applied within server guardrails. -->\n\n`;
    writeFileSync(path, header + finalText + '\n');
    console.log(`[strategy-review] report written: ${path}`);
  }
  process.exit(finalSubtype === 'success' ? 0 : 1);
}

try { await main(); }
catch (err) {
  const msg = String(err?.message ?? err);
  if (/Reached maximum budget/.test(msg)) { console.log(`\n[strategy-review] stopped: ${msg.replace(/^[^:]*:\s*/, '').trim()}`); process.exit(2); }
  console.error('[strategy-review] fatal:', err); process.exit(1);
}
