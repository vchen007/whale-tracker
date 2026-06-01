# Deploying the Whale Tracker to a DigitalOcean Droplet

Target setup: a single **2 GB / 1 vCPU Ubuntu 24.04** droplet running the Fastify
server under PM2, with **nginx** serving the built client and reverse-proxying the
API, **Let's Encrypt** HTTPS on your own domain, and the existing **5.8 GB SQLite
database** transferred over.

Throughout, replace these placeholders:

| Placeholder    | Meaning                                              |
|----------------|------------------------------------------------------|
| `DROPLET_IP`   | Your droplet's public IPv4 (shown in the DO console) |
| `YOUR_DOMAIN`  | The domain you register (e.g. `tracker.example.com`) |
| `deploy`       | The non-root user we create on the droplet           |

---

## 0. Push the latest code to GitHub (from your Mac)

The security-hardening commit is currently **local only**. The droplet clones from
GitHub, so push it first:

```bash
cd /Users/claude_bot/whale-tracker/whale-tracker
git push origin main
```

> The `.env`, `*.pem`, `*.key`, `trades.db*`, and `auth_token*.txt` files are
> gitignored — they will **not** be pushed. You move those by hand in steps 7 & 9.

---

## 1. Create the droplet

In the DigitalOcean console: **Create → Droplets**

- **Image:** Ubuntu 24.04 (LTS) x64
- **Type:** Basic → Regular → **2 GB / 1 vCPU / 50 GB** ($12/mo)
- **Region:** New York (NYC1/3) — lowest latency to Kalshi's US API
- **Authentication:** **SSH key** (add your public key; far safer than a password)
- **Hostname:** `whale-tracker`

Create it, then copy the **public IPv4** → that's `DROPLET_IP`.

---

## 2. ⚠️ FIRST: confirm the droplet isn't WAF-blocked

The `403`s we debugged earlier were Kalshi's CloudFront WAF blocking by IP, and
datacenter IPs get blocked more often than home ones. **Before** installing
anything, SSH in and test:

```bash
ssh root@DROPLET_IP
curl -s -o /dev/null -w "%{http_code}\n" https://api.elections.kalshi.com/trade-api/v2/exchange/status
```

- **`200`** → proceed.
- **`403`** → this droplet's IP is blocked. Destroy it (DO bills per-second),
  recreate in a different region, and retest. Don't build the stack until this is `200`.

---

## 3. Base server setup (as root)

```bash
# Create a non-root user and give it sudo
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copy SSH access

# Firewall — allow SSH + web BEFORE enabling (don't lock yourself out).
# Port 3001 is never opened: the API is only reachable through nginx.
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# 2GB swap — critical safety net on a 2GB box so the server can't OOM-kill
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## 4. Install Node 22 LTS, nginx, certbot, git, sqlite3

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git sqlite3 rsync build-essential
node -v   # expect v22.x
```

> `build-essential` is needed because `better-sqlite3` compiles a native module
> during `npm install`.

---

## 5. Register a domain and point it at the droplet

1. Buy a domain (Namecheap / Cloudflare / Porkbun — ~$1–12/yr).
2. In its DNS settings, add an **A record**:
   - Host: `@` (or a subdomain like `tracker`)
   - Value: `DROPLET_IP`
3. Verify it resolves (can take a few minutes to an hour):
   ```bash
   dig +short YOUR_DOMAIN     # should print DROPLET_IP
   ```

---

## 6. Clone the repo (as the `deploy` user)

```bash
ssh deploy@DROPLET_IP
git clone https://github.com/vchen007/whale-tracker.git ~/whale-tracker
cd ~/whale-tracker
mkdir -p logs            # gitignored, so create it
```

---

## 7. Create the secrets on the server

These never go through git — copy the values from your local `.env` and
`auth_token_kalshi_vc.txt`.

**a) The Kalshi private key.** From your **Mac**, copy the key file up:

```bash
scp /Users/claude_bot/arb-scanner/Claude_bot.key \
    deploy@DROPLET_IP:/home/deploy/whale-tracker/kalshi_private_key.pem
```

**b) The `.env`.** On the **droplet**, create `~/whale-tracker/.env` with your real
values (copy from local). Note the three deployment-specific lines at the bottom:

```bash
nano ~/whale-tracker/.env
```

```ini
KALSHI_API_KEY_ID=<from your local .env>
KALSHI_PRIVATE_KEY_PATH=/home/deploy/whale-tracker/kalshi_private_key.pem
KALSHI_WS_URL=wss://api.elections.kalshi.com/trade-api/ws/v2

RESEND_API_KEY=<from your local .env>
NOTIFY_EMAIL=<from your local .env>

AUTH_TOKEN=<from auth_token_kalshi_vc.txt>

# Deployment-specific:
PORT=3001
CORS_ORIGINS=https://YOUR_DOMAIN

# Auto-trader settings (copy from your local .env)
AUTO_TRADER_CATEGORY=ALL
AUTO_TRADER_MIN_NOTIONAL=20000
AUTO_TRADER_MIN_NET_PROFIT=0.02
AUTO_TRADER_STOP_LOSS_ENABLED=true
AUTO_TRADER_STOP_LOSS_PERCENT=35
AUTO_TRADER_MIN_PRICE_CENTS=60
AUTO_TRADER_MAX_PRICE_CENTS=94
```

> ⚠️ The auto-trader places **real-money** trades on boot. Keep
> `AUTO_TRADER_ENABLED` unset/true only when you actually want it live; set it to
> `false` for a first dry run.

---

## 8. Install dependencies and build the client

```bash
cd ~/whale-tracker
npm install && npm run install:all

# Build the client pointed at your domain. Because nginx serves the API on the
# same host, the client talks to https://YOUR_DOMAIN and wss://YOUR_DOMAIN/ws.
cd client
VITE_API_URL=https://YOUR_DOMAIN npm run build
cd ..
```

This produces `client/dist`, which nginx serves.

---

## 9. Transfer the 5.8 GB database

The DB is live with an open WAL, so don't copy it raw. Make a **consistent
snapshot** with `VACUUM INTO` (safe while the local server keeps running — no
auto-trader downtime), then rsync it.

**On your Mac:**

```bash
# Clean, single-file snapshot (no -wal/-shm sidecars), ~10–20s
sqlite3 /Users/claude_bot/whale-tracker/whale-tracker/trades.db \
  "VACUUM INTO '/tmp/trades_snapshot.db'"

# Transfer (~5.8GB; -P shows progress and resumes if interrupted)
rsync -avP /tmp/trades_snapshot.db \
  deploy@DROPLET_IP:/home/deploy/whale-tracker/trades.db
```

> Do this **before** the first server start so it imports your history instead of
> backfilling from scratch.

---

## 10. Start the server under PM2

```bash
cd ~/whale-tracker
pm2 start deploy/ecosystem.config.cjs
pm2 logs whale-server --lines 30     # expect "[kalshi] live" and "[server] listening"
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy   # run the printed sudo command
```

Quick local check (still on the droplet):

```bash
curl -s localhost:3001/health                                  # {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" localhost:3001/auto-trader/status   # 401 (auth works)
```

---

## 11. Configure nginx

```bash
sudo cp ~/whale-tracker/deploy/nginx.conf /etc/nginx/sites-available/whale-tracker
# Replace the YOUR_DOMAIN placeholder with your real domain throughout the file:
sudo sed -i 's/YOUR_DOMAIN/tracker.example.com/g' /etc/nginx/sites-available/whale-tracker
sudo nano /etc/nginx/sites-available/whale-tracker   # sanity-check domain + root path
sudo ln -s /etc/nginx/sites-available/whale-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Now `http://YOUR_DOMAIN` should load the tracker.

---

## 12. Enable HTTPS

```bash
sudo certbot --nginx -d YOUR_DOMAIN
```

Answer the email/TOS prompts and choose to redirect HTTP→HTTPS. Certbot edits the
nginx config and sets up auto-renewal. Confirm:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR_DOMAIN/health   # 200
```

---

## 13. Final verification (from your Mac)

```bash
DOMAIN=YOUR_DOMAIN
TOKEN=$(cat /Users/claude_bot/whale-tracker/whale-tracker/auth_token_kalshi_vc.txt)

curl -s -o /dev/null -w "health:           %{http_code}\n" https://$DOMAIN/health
curl -s -o /dev/null -w "trades (public):  %{http_code}\n" "https://$DOMAIN/trades?limit=1"
curl -s -o /dev/null -w "autotrader (401): %{http_code}\n"  https://$DOMAIN/auto-trader/status
curl -s -o /dev/null -w "autotrader (200): %{http_code}\n" -H "Authorization: Bearer $TOKEN" https://$DOMAIN/auto-trader/status
```

Expected: `200`, `200`, `401`, `200`. Open `https://YOUR_DOMAIN` in a browser and
confirm the live feed connects (status bar shows connected).

---

## Operating it

```bash
pm2 logs whale-server          # tail logs
pm2 restart whale-server       # restart after a config change
pm2 monit                      # live CPU/RAM

# Update to new code later:
cd ~/whale-tracker && git pull
npm run install:all
cd client && VITE_API_URL=https://YOUR_DOMAIN npm run build && cd ..
pm2 restart whale-server
```

**Watch RAM on the 2 GB box** (`pm2 monit` / `free -h`). If the server gets
OOM-restarted, lower `--max-old-space-size` further in
`deploy/ecosystem.config.cjs`, or resize the droplet to 4 GB in the DO console.
