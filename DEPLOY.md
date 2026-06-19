# Deploying the Whale Tracker (24/7 live trader) to a DigitalOcean Droplet

Target: a single **Ubuntu 24.04** droplet that runs the live trader around the
clock — no Mac, no sleep gaps. Three things run on it:

| Component | What it is | How it's kept alive |
|-----------|-----------|---------------------|
| **`whale-server` (LIVE, :3002)** | Fastify server + Kalshi WS stream + the `/agent/tool` order API the agent calls | **PM2** (`pm2 startup systemd`) |
| **agent-trader** | The Claude Agent SDK trader that proposes orders every 30 min (maker-first / taker-fallback) | **systemd timer** (24/7) |
| **nightly audit + 8am digest** | The two scheduled jobs | **systemd timers** (optional) |
| Demo (:3001) + dashboard (nginx/HTTPS) | Paper trader + the React UI | optional (§12) |

> **Why systemd timers, not cron/launchd:** this is the Linux equivalent of the
> Mac's launchd jobs. systemd timers log to `journald`, survive reboots, and have
> none of the macOS Full-Disk-Access fragility that silently broke the cron jobs.

---

## ⚠️ READ FIRST — do not double-trade

Each trader instance keeps its **dedupe + position state locally** (in-memory +
its own SQLite). If the live trader runs on **both your Mac and the droplet
against the same Kalshi account**, both will independently place real orders —
duplicate fills, blown caps, conflicting positions.

**A move to the droplet means decommissioning the local live trader** (§14). Keep
the Mac's *demo* (:3001) if you like — paper money is harmless — but only **one**
live instance may run at a time.

---

Placeholders used throughout:

| Placeholder    | Meaning                                              |
|----------------|------------------------------------------------------|
| `DROPLET_IP`   | Your droplet's public IPv4 (from the DO console)     |
| `YOUR_DOMAIN`  | Only if you want the dashboard (§12); the trader doesn't need one |
| `deploy`       | The non-root user we create on the droplet           |

---

## 0. Commit + push the latest code (from your Mac)

The droplet clones from GitHub, so the current code — the maker-first/taker-fallback
hybrid, the 24/7 wrapper, this doc — must be committed and pushed first.

```bash
cd /Users/claude_bot/whale-tracker/whale-tracker
git status                 # review what's changed
git add -A && git commit -m "Hybrid maker/taker trader + 24/7 + droplet deploy"
git push origin main
```

> `.env`, `*.key`/`*.pem`, `trades.db*`, and `auth_token*.txt` are gitignored —
> they are **not** pushed. You move those by hand in §6 and §8.

---

## 1. Create the droplet

DigitalOcean console → **Create → Droplets**:

- **Image:** Ubuntu 24.04 (LTS) x64
- **Type:** Basic → Regular → **2 GB / 1 vCPU / 50 GB** ($12/mo). Bump to **4 GB**
  ($24/mo) if you'd rather not babysit RAM — the 6 GB DB + Node heap + the agent
  runs are tight on 2 GB (the swap in §3 is the safety net).
- **Region:** **New York (NYC1/3)** — lowest latency to Kalshi's US API.
- **Authentication:** **SSH key** (paste your public key — far safer than a password).
- **Hostname:** `whale-tracker`

Create it, copy the **public IPv4** → that's `DROPLET_IP`.

---

## 2. ⚠️ FIRST: confirm the droplet isn't WAF-blocked

Kalshi's CloudFront WAF blocks many datacenter IPs with `403`. Test **before**
building anything:

```bash
ssh root@DROPLET_IP
curl -s -o /dev/null -w "%{http_code}\n" https://api.elections.kalshi.com/trade-api/v2/exchange/status
```

- **`200`** → proceed.
- **`403`** → this IP is blocked. Destroy the droplet (DO bills per-second),
  recreate in a different region, retest. Don't build until this is `200`.

---

## 3. Base setup (as root)

```bash
# Non-root user with sudo + your SSH access
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Firewall. Neither :3001 nor :3002 is ever exposed — the trader API is
# localhost-only (the agent calls it over localhost). Web ports only matter if
# you add the dashboard in §12.
ufw allow OpenSSH
ufw --force enable

# 2GB swap — the OOM safety net on a small box (the 6GB DB pressures RAM).
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 4. Install Node 22, git, sqlite3, zsh

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git sqlite3 zsh rsync build-essential python3
node -v   # expect v22.x
```

- `build-essential` — `better-sqlite3` compiles a native module on `npm install`.
- `zsh` — the audit/digest wrapper scripts use a `#!/bin/zsh` shebang.
- `python3` — the nightly audit (`coordinator_audit.py`) and digest run on it.

---

## 5. Clone the repo (as `deploy`)

```bash
ssh deploy@DROPLET_IP
git clone https://github.com/vchen007/whale-tracker.git ~/whale-tracker
cd ~/whale-tracker
mkdir -p logs            # gitignored — create it
```

---

## 6. Secrets — the key and the `.env`

**a) Kalshi private key.** From your **Mac**, copy the key the live `.env` points
at (check `KALSHI_PRIVATE_KEY_PATH` in your local `.env` for the exact source path):

```bash
scp /Users/claude_bot/whale-tracker/arb-scanner/Claude_bot.key \
    deploy@DROPLET_IP:/home/deploy/whale-tracker/kalshi_private_key.pem
chmod 600 ~/whale-tracker/kalshi_private_key.pem   # on the droplet
```

**b) `.env`.** On the droplet, create `~/whale-tracker/.env`. Copy your local
values, with these deployment edits — **`PORT=3002`** (so the server is the LIVE
trader the agent targets) and the local key path:

```ini
# ── Kalshi (LIVE / real money) ──
KALSHI_API_KEY_ID=<from local .env>
KALSHI_PRIVATE_KEY_PATH=/home/deploy/whale-tracker/kalshi_private_key.pem
KALSHI_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2
PORT=3002

# ── Auth + Agent SDK + audit ──
AUTH_TOKEN=<from auth_token_kalshi_vc.txt>
ANTHROPIC_API_KEY=<from local .env>        # the agent-trader + audit need this
AGENT_ID=<from local .env>
ENVIRONMENT_ID=<from local .env>
AUDIT_COORDINATOR_ID=<from local .env>     # for the nightly audit (§11)

# ── Email digest (§11) ──
RESEND_API_KEY=<from local .env>
NOTIFY_EMAIL=<from local .env>

# ── Auto-trader: LIVE hybrid (maker-first / taker-fallback) ──
AUTO_TRADER_ENABLED=true
AUTO_TRADER_LIVE_CONFIRM=true              # real-money arm gate; required to trade live
AUTO_TRADER_CATEGORY=ALL
AUTO_TRADER_MIN_NOTIONAL=999999999         # whale-copy path OFF (agent-trader is the engine)
AUTO_TRADER_MAKER_MODE=true                # post maker first…
AUTO_TRADER_TAKER_FALLBACK=true            # …then cross to taker if unfilled…
AUTO_TRADER_MAKER_FALLBACK_MIN=10          # …after 10 min
AUTO_TRADER_MIN_PRICE_CENTS=64
AUTO_TRADER_MAX_PRICE_CENTS=94
AUTO_TRADER_MIN_EV=0
AUTO_TRADER_MAX_CAPITAL=10
AUTO_TRADER_MAX_OPEN_POSITIONS=30
AUTO_TRADER_MAX_PER_TICKER=5
AUTO_TRADER_MAX_DAILY_LOSS=10
AUTO_TRADER_DEDUPE_BY_EVENT=true
AUTO_TRADER_MAX_DAYS_TO_CLOSE=10
AUTO_TRADER_STOP_LOSS_ENABLED=false
```

> ⚠️ With `AUTO_TRADER_ENABLED=true` + `AUTO_TRADER_LIVE_CONFIRM=true`, the trader
> is **armed for real money the moment the server starts**. For a first dry run,
> set `AUTO_TRADER_ENABLED=false`, verify everything, then flip it on.

---

## 7. Install dependencies

```bash
cd ~/whale-tracker
npm install && npm run install:all        # root + server + client deps
npm install --prefix agent-trader         # @anthropic-ai/claude-agent-sdk, zod, dotenv
```

---

## 8. Bring over the 6 GB database (or rebuild)

**Option A — transfer history (recommended).** The DB has an open WAL, so snapshot
it with `VACUUM INTO` (safe while the local server runs), then rsync:

```bash
# On your Mac:
sqlite3 /Users/claude_bot/whale-tracker/whale-tracker/trades.db \
  "VACUUM INTO '/tmp/trades_snapshot.db'"
rsync -avP /tmp/trades_snapshot.db \
  deploy@DROPLET_IP:/home/deploy/whale-tracker/trades.db
```

**Option B — rebuild from scratch.** Skip the copy; the server backfills from the
Kalshi stream + gap-fill on first boot. Lighter to set up, but you start with no
history (and the gap-fill is heavy on a 2 GB box — watch RAM).

Do whichever **before** the first server start in §9.

---

## 9. Start the live server under PM2

`deploy/ecosystem.config.cjs` runs only the server, with relative paths and a
1536 MB heap cap sized for a 2 GB box.

```bash
cd ~/whale-tracker
pm2 start deploy/ecosystem.config.cjs
pm2 logs whale-server --lines 30     # expect "[kalshi] … 💰 LIVE" and "listening"
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy   # run the printed sudo command
```

Local sanity check (the API is localhost-only):

```bash
curl -s localhost:3002/health                                       # {"ok":true,"kalshiStatus":"live",...}
curl -s -o /dev/null -w "%{http_code}\n" localhost:3002/auto-trader/status   # 401 (auth works)
TOKEN=$(grep ^AUTH_TOKEN= .env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3002/auto-trader/status | head -c 300
# → makerMode=true, takerFallback=true, makerFallbackMinutes=10
```

---

## 10. The agent-trader as a 24/7 systemd timer

This is the piece that actually places orders. Create the wrapper, a `oneshot`
service, and a timer that fires every 30 minutes around the clock.

**Wrapper** — `~/whale-tracker/deploy/run-agent-trader.sh`:

```bash
cat > ~/whale-tracker/deploy/run-agent-trader.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /home/deploy/whale-tracker
set -a; source .env; set +a
export LOCAL_SERVER_URL=http://localhost:3002    # drive the LIVE server
echo "=== run $(date '+%F %H:%M:%S') ==="
exec node agent-trader/agentTrader.js
EOF
chmod +x ~/whale-tracker/deploy/run-agent-trader.sh
```

**Service** — `/etc/systemd/system/agent-trader.service`:

```bash
sudo tee /etc/systemd/system/agent-trader.service >/dev/null <<'EOF'
[Unit]
Description=Kalshi LIVE agent-trader (one decision cycle)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=deploy
WorkingDirectory=/home/deploy/whale-tracker
ExecStart=/home/deploy/whale-tracker/deploy/run-agent-trader.sh
StandardOutput=append:/home/deploy/whale-tracker/logs/agent-trader-live.log
StandardError=append:/home/deploy/whale-tracker/logs/agent-trader-live.log
EOF
```

**Timer** — `/etc/systemd/system/agent-trader.timer`:

```bash
sudo tee /etc/systemd/system/agent-trader.timer >/dev/null <<'EOF'
[Unit]
Description=Run the agent-trader every 30 minutes, 24/7

[Timer]
OnCalendar=*:0/30
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now agent-trader.timer
systemctl list-timers agent-trader.timer      # confirm next run time
```

Trigger one now to verify end-to-end (real-money run, ~$0.026; no-op if no flow):

```bash
sudo systemctl start agent-trader.service
tail -n 30 ~/whale-tracker/logs/agent-trader-live.log   # expect "[agent-sdk] result: success"
```

> To restrict hours later, add an `hour` guard at the top of the wrapper, or use
> two `OnCalendar=` lines in the timer (e.g. `OnCalendar=09..22:0/30`).

---

## 11. (Optional) nightly audit + 8am digest timers

Same pattern, reusing the existing scripts (they're zsh — installed in §4):

```bash
# Nightly cross-audit, 03:00
sudo tee /etc/systemd/system/whale-audit.service >/dev/null <<'EOF'
[Unit]
Description=Nightly demo-vs-live adherence audit
[Service]
Type=oneshot
User=deploy
WorkingDirectory=/home/deploy/whale-tracker
ExecStart=/bin/zsh /home/deploy/whale-tracker/outcomes/run_nightly_audit.sh
EOF
sudo tee /etc/systemd/system/whale-audit.timer >/dev/null <<'EOF'
[Unit]
Description=Run the cross-audit at 03:00
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

# 8am best-bets email digest
sudo tee /etc/systemd/system/whale-digest.service >/dev/null <<'EOF'
[Unit]
Description=Daily best-bets email digest
[Service]
Type=oneshot
User=deploy
WorkingDirectory=/home/deploy/whale-tracker
ExecStart=/bin/zsh /home/deploy/whale-tracker/scripts/run-daily-digest.sh
EOF
sudo tee /etc/systemd/system/whale-digest.timer >/dev/null <<'EOF'
[Unit]
Description=Run the digest at 08:00
[Timer]
OnCalendar=*-*-* 08:00:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now whale-audit.timer whale-digest.timer
systemctl list-timers 'whale-*' agent-trader.timer
```

---

## 12. (Optional) the dashboard — demo, nginx, domain, HTTPS

Skip this entirely for a headless trader. To serve the React UI over HTTPS:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
ufw allow 'Nginx Full'                  # opens 80/443

# Build the client against your domain
cd ~/whale-tracker/client && VITE_API_URL=https://YOUR_DOMAIN npm run build && cd ..

# nginx: serve client/dist, reverse-proxy the API. Point an A record YOUR_DOMAIN → DROPLET_IP first.
sudo cp deploy/nginx.conf /etc/nginx/sites-available/whale-tracker
sudo sed -i 's/YOUR_DOMAIN/tracker.example.com/g' /etc/nginx/sites-available/whale-tracker
# NOTE: deploy/nginx.conf proxies to :3001 — change it to :3002 to match this LIVE setup.
sudo ln -s /etc/nginx/sites-available/whale-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_DOMAIN     # HTTPS + auto-renew
```

To also run the **demo** (:3001) on the droplet, copy your `.env.demo` over and add
a second PM2 app, or run `ENV_FILE=.env.demo PORT=3001 pm2 start ...`.

---

## 13. Verify

```bash
systemctl list-timers agent-trader.timer 'whale-*'   # all timers scheduled
pm2 status                                           # whale-server online
tail -n 20 ~/whale-tracker/logs/agent-trader-live.log
curl -s localhost:3002/health                        # kalshiStatus: live
```

A clean agent run logs `[agent-sdk] result: success` and either places orders
(`[agent-tool] ✅ …`) or reports no qualifying markets.

---

## 14. ⚠️ Decommission the local live trader (Mac)

Once the droplet is trading, **stop the Mac's live instance** so you don't
double-trade:

```bash
# On the Mac:
pm2 stop whale-server && pm2 save                       # stop LIVE (:3002)
launchctl bootout gui/$(id -u)/com.whaletracker.agent-trader-live   # stop the local agent
```

Leave the Mac's **demo** (`whale-server-demo`, :3001) running if you want paper
parity — it never touches real money. The audit/digest can run on **either**
machine, but not both (pick one to avoid duplicate emails).

---

## Operating it (on the droplet)

```bash
pm2 logs whale-server                 # server logs
pm2 monit                             # live CPU/RAM  (watch on the 2GB box)
journalctl -u agent-trader.service -n 50 --no-pager   # last agent run
systemctl list-timers                 # all scheduled jobs + next fire

# Update to new code:
cd ~/whale-tracker && git pull && npm run install:all && npm install --prefix agent-trader
pm2 restart whale-server
sudo systemctl daemon-reload          # only if you changed a unit file
```

**If the server gets OOM-restarted** (`pm2 monit` shows restarts climbing), lower
`--max-old-space-size` in `deploy/ecosystem.config.cjs` or resize to 4 GB in the
DO console.
