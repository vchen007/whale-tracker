# agent-trader

Operator-tier Kalshi trader powered by the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

Runs in-process, with four custom tools that wrap the bot's `/agent/tool`
endpoint. The bot's rails (`auto-trader/autoTrader.js → _validateDirectOrder`)
gate every order before it touches Kalshi.

## Architecture

```
agent-trader/  (this package)         server/  (the bot)
   │                                     │
   │ Haiku 4.5 + 4 custom tools          │ Fastify on :3001
   │     get_status, get_pnl,            │ POST /agent/tool
   │     find_markets, place_order       │   → AutoTrader.placeOrderDirect
   │                                     │      → rails: maker-only, ≥70¢,
   │ ── HTTP POST localhost:3001/ ──▶    │         EV>0, dedupe, caps,
   │    agent/tool                       │         timing window, blocked
   │                                     │         prefixes
   │                                     ▼
   ▼                                  Kalshi REST API (live or demo)
   exit 0/1 + ResultMessage
   (cost, turns, session_id)
```

## Install

```bash
cd agent-trader && npm install
```

(Or `npm install --prefix agent-trader` from the project root.)

## Run

```bash
# from project root
npm run trade:agent

# explicit
node agent-trader/agentTrader.js

# CLI overrides
node agent-trader/agentTrader.js \
  --max-budget-usd 0.05 \
  --max-turns 10 \
  --effort low \
  --model claude-haiku-4-5
```

| Flag | Default | What it caps |
|---|---|---|
| `--max-budget-usd` | 0.10 | Hard dollar cap on Anthropic token spend per run |
| `--max-turns` | 15 | Tool-use round trips |
| `--effort` | `medium` | Reasoning depth (`low`/`medium`/`high`/`xhigh`/`max`) |
| `--model` | `claude-haiku-4-5` | Anthropic model id |

A typical run on Haiku 4.5 costs **$0.02–0.06** depending on how many
markets it scouts.

## Live vs demo

This script does **not** decide which Kalshi environment to trade against.
That is whatever bot is on `localhost:3001`:

| PM2 process | Env |
|---|---|
| `whale-server` | **Live** (real money) |
| `whale-server-demo` | Demo (paper money) |

Check with `pm2 list`, or call `get_status` and look at the balance via your
Kalshi dashboard.

## Required env

Loaded from `../.env` automatically.

| Var | Why |
|---|---|
| `AUTH_TOKEN` | bearer for the bot's `/agent/tool` |
| `ANTHROPIC_API_KEY` | the Agent SDK needs it |
| `LOCAL_SERVER_URL` *(optional)* | override default `http://localhost:3001` |

`SERVER_URL` in `.env` is the ngrok tunnel used by the Managed-Agents
runner — this script ignores it. It always talks to localhost unless
`LOCAL_SERVER_URL` is set.

## Schedule

```cron
# every 30 min during US trading hours, weekdays
*/30 9-22 * * 1-5 cd /Users/claude_bot/whale-tracker/whale-tracker && \
  set -a && source .env && set +a && \
  node agent-trader/agentTrader.js >> logs/agent-trader.log 2>&1
```

## Output

Each run prints a per-turn trace and a final block:

```
[agent-sdk] model=claude-haiku-4-5 maxTurns=15 budget=$0.10 effort=medium
  → mcp__kalshi__get_status({})
  → mcp__kalshi__get_pnl({})
  → mcp__kalshi__find_markets({"limit":15,"max_spread_cents":10})
  → mcp__kalshi__place_order({"ticker":"KX...","side":"yes","limit_price":85})
[agent-sdk] result: success
[agent-sdk] summary: ...
[agent-sdk] cost: $0.0352
[agent-sdk] turns: 4
[agent-sdk] session: 364549e0-...
```

Exit code is `0` on `result: success`, `1` otherwise.

## See also

- `auto-trader/` — the deterministic bot's `AutoTrader` class + rails
- `outcomes/` — the Managed-Agents daily adherence audit
