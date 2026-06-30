#!/usr/bin/env node
// edgeResearch.js — weekly edge-research agent (#3).
//
// A READ-ONLY analyst. It drives the deterministic backtester (query_backtest)
// over the historical settled-whale-trade DB to find where realized post-fee
// edge actually lives, re-tests the prefixes that were unblocked, and writes a
// markdown report with concrete, evidence-backed proposed parameter changes.
// It NEVER trades and NEVER changes config — it only proposes.
//
//   node agent-trader/edgeResearch.js
//   node agent-trader/edgeResearch.js --max-budget-usd 0.40 --effort high
//
// Targets the LIVE server (:3002) by default because the full historical
// trades.db is served there (demo uses the smaller trades_demo.db). Override
// with LOCAL_SERVER_URL. Reuses agent-trader's SDK install + loadEnv.
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
if (!AUTH_TOKEN) { console.error('AUTH_TOKEN not set — needed for /agent/tool.'); process.exit(2); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY not set — required by the Agent SDK.'); process.exit(2); }

const DEFAULTS = { model: 'claude-haiku-4-5', maxTurns: 40, maxBudgetUsd: 0.40, effort: 'high' };

async function callAgentTool(payload) {
  try {
    const res = await fetch(`${SERVER_URL}/agent/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }; }
  } catch (err) { return { error: `request error: ${err.message}` }; }
}
const asText = (p) => ({ content: [{ type: 'text', text: JSON.stringify(p, null, 2) }] });

const getStatus = tool(
  'get_status',
  'Return the trader\'s CURRENT config so you can compare your findings against ' +
    'the rails in force: price band (minPriceCents/maxPriceCents), EV gate ' +
    '(calibrationAlpha/Psi/source), blocked-prefix list, caps.',
  {},
  async () => asText(await callAgentTool({ action: 'get_status' })),
  { annotations: { readOnlyHint: true } },
);

const queryBacktest = tool(
  'query_backtest',
  'Backtest realized edge over SETTLED whale trades. Returns slices with: n ' +
    '(trades), win_rate, avg_price, mean_profit_cents (realized pre-fee profit ' +
    'per contract = the edge), mean_postfee_cents (after estimated maker fee). ' +
    'group_by: price_band | category | side | series (ticker prefix). Optional ' +
    'filters: category, series_prefix (e.g. "KXUFCFIGHT" to test a blocked ' +
    'prefix), side, min_price/max_price (cents), min_sample (drop thin slices, ' +
    'default 30). Positive mean_postfee_cents ⇒ buying that slice historically ' +
    'paid after fees. CAVEAT: whale-only sample (>=$10k, <95c) — biased vs the ' +
    'whole market; realized whale fills are takers, not your maker fills.',
  {
    group_by:      z.enum(['price_band', 'category', 'side', 'series']).optional(),
    category:      z.string().optional(),
    series_prefix: z.string().optional().describe('Ticker prefix, e.g. KXUFCFIGHT, KXNBASPREAD.'),
    side:          z.enum(['yes', 'no']).optional(),
    min_price:     z.number().int().min(1).max(99).optional(),
    max_price:     z.number().int().min(1).max(99).optional(),
    min_sample:    z.number().int().min(1).optional(),
  },
  async (args) => asText(await callAgentTool({ action: 'query_backtest', ...args })),
  { annotations: { readOnlyHint: true } },
);

const RESEARCH_PROMPT = `You are an edge-research analyst for a Kalshi maker-trading bot.
You have ONE deterministic data tool, query_backtest, over a DB of settled
"whale" trades (>= $10k notional). Your job: find where realized post-fee edge
actually lives and write a report proposing concrete parameter changes. You do
NOT trade and you do NOT change config — you only propose, with evidence.

PROCEDURE (be systematic; cite n and mean_postfee_cents for every claim):
1. get_status — record the CURRENT rails: minPriceCents, maxPriceCents,
   calibrationAlpha/Psi (+ source), blockedPrefixes, caps.
2. Map edge by price_band (min_sample 100). Identify positive vs negative bands
   — note any negative pocket INSIDE the current favorites zone.
3. Map edge by category and by side (min_sample 100). Which categories pay,
   which bleed?
4. Re-test the prefixes that were recently UNBLOCKED (they were originally
   blocked on win-rate grounds): query_backtest with series_prefix for each of
   KXUFCFIGHT, KXNBASPREAD, KXIPL, KXATPMATCH, KXWTAMATCH, KXITFMATCH,
   KXMVECROSSCATEGORY, KXMVESPORTS. State whether the data justifies blocking
   each (negative post-fee edge with adequate n) or not.
5. Drill where useful (e.g. price_band within a strong category).

OUTPUT: a single, self-contained Markdown report. Structure:
  # Edge Research — <today>
  ## TL;DR  (3-6 bullets, the headline findings)
  ## Evidence  (small tables: dimension | n | win% | avg_px | post-fee edge ¢)
  ## Proposed changes  (each as: change, the exact env var / param, the
     supporting numbers, expected effect)
  ## Caveats  (whale-only sample; realized takers vs your maker fills;
     selection effects; small-n slices)
RULES: Never propose a change off a slice with n < 100. Prefer post-fee edge
over raw win-rate. Be concrete and quantitative. The final assistant message
MUST be the complete report (it is saved verbatim to a file).`;

function parseArgs() {
  const opts = { ...DEFAULTS };
  const args = process.argv.slice(2);
  const toCamel = (s) => s.replace(/^--?/, '').toLowerCase().split(/[-_]/)
    .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('');
  for (let i = 0; i < args.length; i++) {
    const key = toCamel(args[i]); const val = args[i + 1];
    if (val === undefined || val.startsWith('-')) continue;
    if      (key === 'maxTurns')     { opts.maxTurns = Number(val);     i++; }
    else if (key === 'maxBudgetUsd') { opts.maxBudgetUsd = Number(val); i++; }
    else if (key === 'model')        { opts.model = val;                i++; }
    else if (key === 'effort')       { opts.effort = val;               i++; }
  }
  return opts;
}

async function main() {
  const opts   = parseArgs();
  const server = createSdkMcpServer({ name: 'research', version: '1.0.0', tools: [getStatus, queryBacktest] });
  console.log(`[edge-research] model=${opts.model} maxTurns=${opts.maxTurns} budget=$${opts.maxBudgetUsd.toFixed(2)} effort=${opts.effort} target=${SERVER_URL}`);

  let finalSubtype = null, finalText = null, cost = null, nTurns = null, sessionId = null;

  const iter = query({
    prompt: RESEARCH_PROMPT,
    options: {
      model:        opts.model,
      mcpServers:   { research: server },
      allowedTools: ['mcp__research__*'],
      tools:        [],
      maxTurns:     opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      effort:       opts.effort,
      systemPrompt: 'You are a rigorous, quantitative prediction-market edge ' +
        'analyst. Every claim cites a sample size and a post-fee edge number. ' +
        'You propose; you never trade.',
    },
  });

  for await (const message of iter) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          let input = JSON.stringify(block.input);
          if (input.length > 160) input = input.slice(0, 160) + '…';
          console.log(`  → ${block.name}(${input})`);
        } else if (block.type === 'text') {
          const t = block.text.trim();
          if (t) console.log(`    ${t.slice(0, 120)}${t.length > 120 ? '…' : ''}`);
        }
      }
    } else if (message.type === 'result') {
      finalSubtype = message.subtype;
      finalText    = message.subtype === 'success' ? message.result : null;
      cost         = message.total_cost_usd ?? null;
      nTurns       = message.num_turns ?? null;
      sessionId    = message.session_id ?? null;
    }
  }

  console.log(`\n[edge-research] result: ${finalSubtype}  cost=$${(cost ?? 0).toFixed(4)}  turns=${nTurns}  session=${sessionId}`);

  if (finalText) {
    mkdirSync(OUT_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const path = resolve(OUT_DIR, `edge_research_${date}.md`);
    const header = `<!-- Auto-generated by edgeResearch.js on ${new Date().toISOString()} ` +
      `(model ${opts.model}, cost $${(cost ?? 0).toFixed(4)}, session ${sessionId}). ` +
      `Proposals only — no config was changed. -->\n\n`;
    writeFileSync(path, header + finalText + '\n');
    console.log(`[edge-research] report written: ${path}`);
  } else {
    console.log('[edge-research] no report produced (non-success result).');
  }

  process.exit(finalSubtype === 'success' ? 0 : 1);
}

try {
  await main();
} catch (err) {
  const msg = String(err?.message ?? err);
  if (/Reached maximum budget/.test(msg)) {
    console.log(`\n[edge-research] stopped: ${msg.replace(/^[^:]*:\s*/, '').trim()}`);
    process.exit(2);
  }
  console.error('[edge-research] fatal:', err);
  process.exit(1);
}
