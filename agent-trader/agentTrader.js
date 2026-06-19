#!/usr/bin/env node
// agentTrader.js — Operator-tier trading via the Claude Agent SDK (Node).
//
// What this is: a local Node process that runs the Agent SDK's agent loop
// in-process. Four custom tools wrap the same actions the bot already exposes
// via /agent/tool. The deterministic bot's hard rails (maker-only, EV gate,
// price floor, dedupe, capital cap) are still enforced server-side — this only
// changes WHO decides which orders to propose.
//
// Cost: bounded by max_budget_usd per loop. With Haiku 4.5 and the defaults
// below, a single decision cycle runs ≈$0.02–0.05.
//
// USAGE:
//   npm run trade:agent                              # from project root
//   node agent-trader/agentTrader.js                 # explicit
//   node agent-trader/agentTrader.js --max-budget-usd 0.05 --effort low
//
// Schedule via cron (e.g. every 30 min during US trading hours, weekdays):
//   */30 9-22 * * 1-5 cd /Users/claude_bot/whale-tracker/whale-tracker && \
//     set -a && source .env && set +a && \
//     node agent-trader/agentTrader.js >> logs/agent-trader.log 2>&1
//
// PREREQS:
//   - .env at project root with AUTH_TOKEN + ANTHROPIC_API_KEY
//   - bot's server running on localhost:3001 (`pm2 list` → whale-server or
//     whale-server-demo). Whichever is up decides whether orders go to live
//     or demo Kalshi; THIS script does not pick the environment, it just
//     drives whatever is on :3001.
//
// ARCHITECTURE:
//   Agent loop (Haiku, in-process)
//        │ tool calls
//        ▼
//   4 custom tools ── HTTP ──► localhost:3001/agent/tool ──► autoTrader.js rails
//                                                          (placeOrderDirect,
//                                                           find_markets, etc.)

import './loadEnv.js'; // load ../.env so AUTH_TOKEN / ANTHROPIC_API_KEY are set
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Always hit localhost — the Agent SDK runs in-process; we don't go through the
// ngrok tunnel that SERVER_URL points at (that's for the Managed-Agents runner
// whose cloud agent needs a public callback URL). Override via LOCAL_SERVER_URL
// only if you really want to point at a remote bot.
const SERVER_URL = (process.env.LOCAL_SERVER_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error('AUTH_TOKEN not set — needed for the local /agent/tool endpoint.');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — required by the Agent SDK.');
  process.exit(2);
}

// Cost rails. Override via CLI flags (see parseArgs below). These defaults
// keep a single decision cycle to roughly $0.02–0.05 on Haiku 4.5.
const DEFAULTS = {
  model:          'claude-haiku-4-5',
  maxTurns:       15,
  maxBudgetUsd:   0.10,
  effort:         'medium',
};

// ── HTTP wrapper to the bot's /agent/tool endpoint ────────────────────────
// All four tools forward to the same endpoint. The bot's rails (in
// `_validateDirectOrder`) gate every order; this script does NOT add parallel
// checks (single source of truth).

async function callAgentTool(payload) {
  try {
    const res = await fetch(`${SERVER_URL}/agent/tool`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body:    JSON.stringify(payload),
    });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { error: `HTTP ${res.status}: ${text.slice(0, 300)}` }; }
  } catch (err) {
    return { error: `request error: ${err.message}` };
  }
}

const asTextResult = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

// ── The four tools ───────────────────────────────────────────────────────────

const getStatus = tool(
  'get_status',
  'Return the auto-trader\'s current configuration: enabled flag, price band, ' +
    'EV gate parameters, risk caps (maxCapital, maxOpenPositions, maxPerTicker, ' +
    'maxDailyLoss), and blocked-prefix list. Call this FIRST so you know what ' +
    'rails are in force before proposing orders.',
  {},
  async () => asTextResult(await callAgentTool({ action: 'get_status' })),
  { annotations: { readOnlyHint: true } },
);

const getPnl = tool(
  'get_pnl',
  'Return realized P&L and the most recent orders (up to 50). Use to check ' +
    'current open positions before placing new orders — the dedupe rail will ' +
    'reject any order on an event you already hold.',
  {},
  async () => asTextResult(await callAgentTool({ action: 'get_pnl' })),
  { annotations: { readOnlyHint: true } },
);

const findMarkets = tool(
  'find_markets',
  'Discover markets with a real two-sided book, ranked by recent taker flow ' +
    '(a liquidity signal — a tight, active book is best for resting makers). Returns ticker, ' +
    'title, best_bid/ask (cents), spread, recent_trades count, volume_24h, ' +
    'close_time, and a "source" field (feed = from our trade DB, scan = from a ' +
    '/markets page scan fallback).',
  {
    limit: z.number().int().min(1).max(50).optional()
      .describe('Max number of markets to return (default 15).'),
    max_spread_cents: z.number().int().min(1).max(50).optional()
      .describe('Reject markets with spread wider than this (default 10).'),
    windowHours: z.number().int().min(1).max(168).optional()
      .describe('How far back to count taker flow in our feed DB (default 48).'),
  },
  async (args) => {
    const payload = { action: 'find_markets', ...args };
    return asTextResult(await callAgentTool(payload));
  },
  { annotations: { readOnlyHint: true } },
);

const placeOrder = tool(
  'place_order',
  'Place a maker buy order priced strictly below the best ask (rests inside the ' +
    'spread). If it has not filled after the maker window, the server crosses it ' +
    'to a taker fill automatically. The server enforces ALL rails before sending to ' +
    'Kalshi: maker pricing (no crossing by you), favorites-only (>=64c), positive ' +
    'calibrated EV after fees, per-event dedupe, per-ticker cap, capital cap, ' +
    'blocked prefixes, timing window (close <= 10 days). On rejection returns ' +
    '{rejected: true, reason: "..."} — note the reason in your summary and ' +
    'move on; do NOT retry the same order. On success returns the order id, ' +
    'role, best_bid/ask snapshot, est_q, est_fee, est_net_ev, ev_formula, ' +
    'fee_schedule, days_to_close.',
  {
    ticker:      z.string().describe('Kalshi market ticker.'),
    side:        z.enum(['yes', 'no']).describe('Which side to buy.'),
    limit_price: z.number().int().min(1).max(99)
      .describe('Maker limit price in cents (integer 1..99), strictly below the best ask.'),
    count:       z.number().int().min(1).max(10).default(1).optional()
      .describe('Number of contracts (default 1).'),
  },
  async (args) => {
    const result = await callAgentTool({
      action:      'place_order',
      ticker:      args.ticker,
      side:        args.side,
      limit_price: args.limit_price,
      count:       args.count ?? 1,
    });
    // Surface real exchange-side errors as is_error so the agent loop can
    // react. Rail-layer rejections (price floor, EV, dedupe, etc.) are
    // expected, structured data — they stay as normal results.
    const isError = Boolean(result.error)
      || (result.rejected && /exchange error/i.test(String(result.reason ?? '')));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError,
    };
  },
);

// ── Prompt + main ────────────────────────────────────────────────────────────
//
// The prompt is environment-agnostic: get_status tells the agent whether it's
// on demo or live (via balance / caps the rails report). Don't bake DEMO or
// LIVE into the prompt — let the agent read it.

const TRADING_PROMPT = `You are placing maker orders on a Kalshi account via the
bot's /agent/tool endpoint. The server enforces every rail; you propose orders,
the server vets them. NOTE: if a maker order has not filled after the maker
window, the server automatically crosses it to a taker fill — so a thin order
book is NOT a reason to skip an EV-positive favorite; post it and let the server
guarantee the fill.

GOAL: One decision cycle. Scan for high-quality opportunities, place 1-3
EV-positive maker orders that satisfy all server rails, then stop and report.

PROCEDURE:
1. Call get_status — read the current rails (price band, EV gate, caps,
   maxPerTicker, maxDailyLoss, blocked prefixes). Quote the numbers in your
   final summary so you can show you respected them.
2. Call get_pnl — note current open positions and their events. The dedupe
   rail will reject any order whose event is already held.
3. Call find_markets — pick candidates with a tight spread AND a real
   two-sided book AND a close_time within the timing window. recent_trades
   indicates how lively the book is; the server's taker-fallback will still
   fill an EV-positive order even if maker interest is thin.
4. For each promising candidate: pick a maker price strictly below the
   current best_ask, then call place_order. The server will tell you why
   any order was rejected (price floor, EV, dedupe, timing). Note the
   reason and move on — do NOT retry the same order.
5. Stop after 1-3 successful placements OR after exhausting the candidates
   from find_markets. Return a short summary listing every order placed
   (ticker, side, price, est_net_ev) and every candidate rejected with its
   reason.

HARD CONSTRAINTS (the server enforces these — not optional):
- Maker pricing: your limit_price must be strictly below the best ask (crossing prices are rejected). Unfilled makers are auto-crossed to taker by the server after the maker window.
- Favorites zone: see minPriceCents in get_status (typically 70c+).
- Positive calibrated EV after fees.
- Timing: close_time within ~10 days (the server's maxDaysToClose).
- No retries: an exchange-side error means stop trying that ticker; rotate.
- Budget: you have a hard token budget for this cycle. Be efficient.

Do not narrate routine status calls. Stay terse.
`;

function parseArgs() {
  const opts = { ...DEFAULTS };
  const args = process.argv.slice(2);
  // Normalize --max-budget-usd / --max_budget_usd / --maxBudgetUsd into the
  // same camelCase key for matching.
  const toCamel = (s) => s
    .replace(/^--?/, '')
    .toLowerCase()
    .split(/[-_]/)
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
  for (let i = 0; i < args.length; i++) {
    const key = toCamel(args[i]);
    const val = args[i + 1];
    if (val === undefined || val.startsWith('-')) continue;
    if      (key === 'maxTurns')     { opts.maxTurns = Number(val);     i++; }
    else if (key === 'maxBudgetUsd') { opts.maxBudgetUsd = Number(val); i++; }
    else if (key === 'model')        { opts.model = val;                i++; }
    else if (key === 'effort')       { opts.effort = val;               i++; }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  const server = createSdkMcpServer({
    name:    'kalshi',
    version: '1.0.0',
    tools:   [getStatus, getPnl, findMarkets, placeOrder],
  });

  console.log(
    `[agent-sdk] model=${opts.model} maxTurns=${opts.maxTurns} ` +
    `budget=$${opts.maxBudgetUsd.toFixed(2)} effort=${opts.effort}`
  );

  let finalSubtype = null;
  let finalText    = null;
  let cost         = null;
  let nTurns       = null;
  let sessionId    = null;

  const iter = query({
    prompt:  TRADING_PROMPT,
    options: {
      model:        opts.model,
      mcpServers:   { kalshi: server },
      // Wildcard auto-approves all four tools — no human-in-the-loop prompts.
      allowedTools: ['mcp__kalshi__*'],
      // Strip Claude Code's built-in tools. We want the agent quoting/placing
      // orders, not opening shells or editing files.
      tools:        [],
      maxTurns:     opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      effort:       opts.effort,
      systemPrompt: 'You are a disciplined Kalshi maker-trader. The server ' +
        'enforces every rail; your job is to PROPOSE good orders and accept ' +
        'the server\'s rejections as data, not retries. Stay terse.',
    },
  });

  for await (const message of iter) {
    if (message.type === 'assistant') {
      // AssistantMessage wraps the raw API message; content is at .message.content
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          let input = JSON.stringify(block.input);
          if (input.length > 160) input = input.slice(0, 160) + '…';
          console.log(`  → ${block.name}(${input})`);
        } else if (block.type === 'text') {
          const text = block.text.trim();
          if (text) for (const line of text.split('\n')) console.log(`    ${line.slice(0, 200)}`);
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

  console.log();
  console.log(`[agent-sdk] result: ${finalSubtype}`);
  if (finalText) console.log(`[agent-sdk] summary:\n${finalText}`);
  if (cost != null)     console.log(`[agent-sdk] cost: $${cost.toFixed(4)}`);
  if (nTurns != null)   console.log(`[agent-sdk] turns: ${nTurns}`);
  if (sessionId)        console.log(`[agent-sdk] session: ${sessionId}`);

  // Non-zero exit on non-success so cron / PM2 can react.
  process.exit(finalSubtype === 'success' ? 0 : 1);
}

// The SDK throws "Reached maximum budget" instead of returning a result
// subtype when --max-budget-usd is exhausted mid-loop. Treat that as a
// soft exit (the agent already did its work and printed its summary).
try {
  await main();
} catch (err) {
  const msg = String(err?.message ?? err);
  if (/Reached maximum budget/.test(msg)) {
    console.log(`\n[agent-sdk] stopped: ${msg.replace(/^[^:]*:\s*/, '').trim()}`);
    process.exit(2); // distinct from grader-failure exit code (1)
  }
  console.error(`\n[agent-sdk] crashed: ${msg}`);
  process.exit(3);
}
