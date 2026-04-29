# 🐳 Kalshi Whale Tracker

Live dashboard for monitoring large trades on [Kalshi](https://kalshi.com) prediction markets.

```
┌─────────────────────────────────────────────────────────┐
│ 🐳 KALSHI WHALE TRACKER                      ● live     │
├────────────┬──────────────┬─────────────────────────────┤
│ CONTRACTS  │ YES VOLUME   │ NO VOLUME                   │
│ 142,300    │ $84.2K       │ $31.7K                      │
├────────────┴──────────────┴─────────────────────────────┤
│ MIN SIZE [    ] CATEGORY [ALL ▾] SIDE [ALL ▾]  74 trades│
├──────────┬──────────────────┬───┬────┬────┬──────┬──────┤
│ TIME     │ MARKET           │CAT│SIDE│PRC │ SIZE │ NOTL │
├──────────┼──────────────────┼───┼────┼────┼──────┼──────┤
│ 14:32:01 │ BTCD-25MAY-T50K  │BTC│ YES│ 65¢│2,500🐳│$1.6K│
│ 14:31:58 │ INXD-25MAY-P4800 │INX│  NO│ 42¢│  800🐋│$336 │
└──────────┴──────────────────┴───┴────┴────┴──────┴──────┘
```

## Architecture

```
Kalshi WSS API
      │  wss://trading-api.kalshi.com/trade-api/ws/v2
      │  RSA-PSS auth via login command
      ▼
 server/  (Node.js + Fastify)
      │  ws://localhost:3001/ws
      │  broadcasts JSON trade events
      ▼
 client/  (Vite + React)
      │  dark terminal UI
      │  live filters: min size, category, side
```

## Prerequisites

- Node.js ≥ 18
- A Kalshi account with API access enabled
- An RSA key pair registered with Kalshi (PKCS#8 PEM format)

## Setup

### 1. Install dependencies

```bash
npm install          # installs concurrently in root
npm run install:all  # installs server/ and client/ deps
```

### 2. Configure credentials

```bash
cp .env.example .env
```

Edit `.env`:

```
KALSHI_API_KEY_ID="KALSHI_API_KEY_ID"
KALSHI_PRIVATE_KEY_PATH="FILE_PATH_TO_PRIVATE_KEY"
```

Put your PEM private key at the path you specified (e.g. `./kalshi_private_key.pem`).
The key should be in PKCS#8 format:

```
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

If you have a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`) convert it:

```bash
openssl pkcs8 -topk8 -nocrypt -in old.pem -out kalshi_private_key.pem
```

### 3. Run

**Both together (recommended):**

```bash
npm run dev
```

**Separately:**

```bash
# Terminal 1 – proxy server on :3001
npm run dev:server

# Terminal 2 – Vite dev server on :5173
npm run dev:client
```

Open **http://localhost:5173** in your browser.

## Whale thresholds

| Icon | Contracts |
|------|-----------|
| 🐋   | ≥ 500     |
| 🐳   | ≥ 2 000   |

## Project structure

```
whale-tracker/
├── .env.example
├── .gitignore
├── package.json          # root – concurrently scripts
│
├── server/
│   ├── package.json
│   └── src/
│       ├── index.js       # Fastify server + browser WS hub
│       ├── kalshiClient.js # upstream WS connection + reconnect
│       └── auth.js        # RSA-PSS signing
│
└── client/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── styles.css
        ├── useWebSocket.js
        └── components/
            ├── FilterBar.jsx
            ├── StatsBar.jsx
            ├── StatusBar.jsx
            ├── TradeTable.jsx
            └── TradeRow.jsx
```

## Notes

- The server keeps a rolling buffer of the last 200 trades and replays them to each new browser connection so the table isn't empty on page load.
- The Kalshi WebSocket is automatically reconnected with a 5-second delay on disconnect.
- A heartbeat ping is sent every 20 seconds to keep the connection alive.
- The server never forwards your private key or API credentials to the browser.
