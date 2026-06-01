# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install all dependencies (root + server + client)
npm install && npm run install:all

# Run both server and client in dev mode (recommended)
npm run dev

# Run separately
npm run dev:server   # Fastify on :3001 (with --watch)
npm run dev:client   # Vite on :5173

# Production via PM2
pm2 start ecosystem.config.cjs
pm2 logs whale-server --lines 50

# Daily email digest (Python)
python3 scripts/daily_best_bets.py
```

There are no tests or linting configured.

## Architecture

Two-process monorepo: a Node.js server and a Vite+React client, connected via WebSocket.

### Server (`server/src/`)

- **index.js** — Entry point. Starts Fastify with WebSocket hub, orchestrates all periodic tasks:
  - Kalshi WebSocket stream (real-time trades)
  - Polymarket REST polling (every 60s)
  - Gap-fill (10min), title backfill (5min), metadata refresh (20min), ESPN schedule (60min)
  - Auto-trader stop-loss check (3min), settlement check (15min)
  - Whale filter: `isWhale()` (notional >= $10K) AND `isMeaningfulSignal()` (price < 95¢)
- **kalshiClient.js** — Kalshi WebSocket client with RSA-PSS auth, auto-reconnect. Contains `categoryFromTicker()` with ~50 prefix-to-category mappings and `normaliseTrade()` which handles both old (yes_price/count) and new (yes_price_dollars/count_fp) API field formats.
- **kalshiRest.js** — Kalshi REST API client for history backfill, market metadata, event data.
- **polymarketRest.js** — Polymarket data-api polling + gamma-api category enrichment. No auth needed.
- **autoTrader.js** — Copies whale trades on Kalshi. Filters: category, min notional ($20K), min net profit (2%), price range (60-94¢). Stop-loss watchdog sells when bid drops ≥35% below entry.
- **sportsApi.js** — ESPN scoreboard integration for real game start times. Parses Kalshi tickers and Polymarket titles to look up actual start times across 10+ leagues.
- **db.js** — SQLite via better-sqlite3 (WAL mode). Tables: `trades`, `market_titles`, `auto_orders`. Migrations run inline via try/catch ALTER TABLE.
- **auth.js** — RSA-PSS request signing for Kalshi API.
- **notify.js** — Resend email notifications for auto-trader events.

### Client (`client/src/`)

- **App.jsx** — Main app with two tabs: Trades feed and Top Markets aggregation. Connects to `ws://localhost:3001/ws` and fetches `/trades` on mount.
- **useWebSocket.js** — WebSocket hook with reconnect logic.
- **components/** — TradeTable, TradeRow, TopMarketsTable, FilterBar, StatsBar, StatusBar.
- **styles.css** — Dark terminal theme. CSS variables in `:root` for colors. No CSS framework.

### Data Flow

1. Kalshi trades arrive via WebSocket; Polymarket trades via REST polling
2. Both are normalised to a unified shape with `source` field ('kalshi' | 'polymarket')
3. Filtered by whale threshold + meaningful signal check
4. Stored in SQLite `trades` table, broadcast to browser clients via WS
5. Market metadata (titles, categories, close times, ESPN start times) stored in `market_titles`

### Key Data Quirks

- Kalshi WebSocket sends `ts` as Unix seconds (10-digit); must multiply by 1000 for JS Date
- Kalshi API has two field formats: old (`yes_price`/`count`) and new (`yes_price_dollars`/`count_fp`) — both must be handled
- Kalshi `occurrence_datetime` for live-bet markets is game END, not START — approximate by subtracting 3 hours, or use ESPN actual start time
- Polymarket tickers are synthetic: `PM-{conditionId_first16chars}-{outcomeIndex}`
- SQLite DB file (`trades.db`) is ~6GB and gitignored

## Environment Variables

Configured in `.env` at project root. Required: `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`. See `.env.example` for all options including auto-trader settings (`AUTO_TRADER_*`) and Resend email config.

## REST API Endpoints (server :3001)

- `GET /trades?since=<ms>` — Recent trades
- `GET /top-markets` — Aggregated market volumes
- `GET /health` — Server health check
- `GET /auto-trader/status` — Auto-trader config and state
- `GET /auto-trader/pnl` — P&L summary for auto-traded orders
- `WS /ws` — Live trade stream
