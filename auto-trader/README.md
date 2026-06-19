# auto-trader

The deterministic auto-trader: a single `AutoTrader` class that runs inside the
bot's Fastify server (`server/src/index.js`) and enforces every order placed on
Kalshi against a fixed set of rails derived from the makers/takers paper.

## What's in here

```
auto-trader/
  autoTrader.js   ← The AutoTrader class (~1000 lines)
  README.md       ← This file
```

The class is constructed once in `server/src/index.js`:

```js
import { AutoTrader } from '../../auto-trader/autoTrader.js';
const autoTrader = new AutoTrader({ … });
```

…and is the single source of truth for every order, whether it originates from
the bot's whale-copy path (`onTrade()`) or from the Agent SDK runner
(`placeOrderDirect()`).

## What the rails are

`_validateDirectOrder()` is the gate. Every order — copy-trade or agent —
passes through it. If any rail fires, the order is rejected with a structured
`{rejected: true, reason: …}` and never touches the Kalshi API.

| Rail | What it checks |
|---|---|
| **Kill switch** | `enabled === true` (auto-disabled when `maxDailyLoss` is hit) |
| **Blocked prefixes** | Ticker doesn't start with `KXNBASPREAD`, `KXIPL`, `KXATPMATCH`, `KXWTAMATCH`, `KXITFMATCH`, `KXUFCFIGHT`, `KXMVECROSSCATEGORY`, or `KXMVESPORTS` |
| **Price band** | `minPriceCents ≤ limit_price ≤ maxPriceCents` |
| **Maker-only / no-cross** | `limit_price < best_ask` on the side being bought (fetched live from `/markets/{ticker}`) |
| **Timing** | `close_time` within `maxDaysToClose` (default 10) |
| **Calibrated EV** | `est_q × (1 − P_dollars) − fee > minEvDollars` using the favorite–longshot regression from Bürgi, Deng & Whelan (2026): α = −1.736, ψ = 0.034 |
| **Min net profit** | Max-win net profit ≥ `minNetProfit` (default $0.02) |
| **Per-event dedupe** | No other live position on the same event ticker |
| **Per-ticker cap** | At most `maxPerTicker` orders on the same ticker (default 5) |
| **Max open** | At most `maxOpenPositions` orders open at any time |
| **Capital cap** | Sum of (entry_price/100 × count) across open orders ≤ `maxCapital` |
| **Daily-loss kill** | Realized P&L today ≥ −`maxDailyLoss` (otherwise disables trader) |

## How orders flow

```
Whale-copy path (deterministic)        Agent SDK path (LLM-proposed)
       │                                        │
       │ onTrade(trade)                         │ HTTP POST /agent/tool
       ▼                                        │ { action: "place_order",
   filter by category,                          │   ticker, side, limit_price }
   notional, etc.                               ▼
       │                                  POST /agent/tool handler
       │ pass filters                     in server/src/index.js
       ▼                                        │
   AutoTrader.onTrade()                         ▼
   → _validateDirectOrder()  ←──────  AutoTrader.placeOrderDirect()
                                       → _validateDirectOrder()
                              │
                              ▼
                  All rails pass? → Kalshi REST /portfolio/orders
                  Any rail fails? → { rejected: true, reason: "…" }
```

## Configuration

All rails are read from environment variables (`AUTO_TRADER_*`) at server
startup. See `.env.example` at the project root for the full list and
`server/src/index.js` for the construction call.

The two important non-rail behaviors:

- **`makerMode = true`** (default): post limit orders inside the spread; never
  cross. Strategy derives from the paper (Makers −9.6% vs Takers −31.5%).
- **`stopLossEnabled = false`** on live by default: the paper's edge is
  hold-to-settlement; stop-loss exits cost spread + taker fee. Measure before
  trusting.

## Why this file lives outside server/

Conceptually the auto-trader is the strategy; everything in `server/src/` is
plumbing (HTTP, WebSocket ingest, DB layer, env loader). Pulling the strategy
out makes the directory layout match the mental model:

```
whale-tracker/
├── agent-trader/      ← Agent SDK runner (operator)
├── auto-trader/       ← Deterministic strategy + rails (this folder)
├── server/            ← HTTP / WebSocket / DB / Kalshi client (plumbing)
├── outcomes/          ← Managed-Agents daily adherence audit (supervisor)
└── …
```

The file's tight dependencies (DB helpers, email notifier, env config) remain
in `server/src/` because they're shared with the server. AutoTrader.js reaches
across the folder boundary via `../server/src/…` imports — explicit and
documented at the top of the file.

## See also

- `agent-trader/` — Claude Agent SDK runner that talks to this via the bot's
  `/agent/tool` HTTP endpoint
- `outcomes/define_outcome.py` — daily Managed-Agents adherence audit (grades
  what this auto-trader actually placed)
- The paper: Bürgi, Deng & Whelan (2026), *"Makers and Takers: The Economics
  of the Kalshi Prediction Market"*
