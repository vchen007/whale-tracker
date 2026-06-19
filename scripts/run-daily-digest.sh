#!/bin/zsh
# Daily Best Bets email digest (Kalshi whale tracker) — fires at 08:00 via
# launchd (com.whaletracker.daily-digest.plist). Migrated off crontab, which
# stopped firing after the 2026-06-15 reboot (macOS cron lost Full Disk Access).
# Mirrors the now-DISABLED remote trigger trig_018DFBKwfZ2wniQ1vnAfCjjs.
set -euo pipefail

# launchd/cron run with a minimal PATH; make python3 resolvable.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:$PATH"

ROOT="/Users/claude_bot/whale-tracker/whale-tracker"
cd "$ROOT"

# Load env (RESEND_API_KEY, NOTIFY_EMAIL, …).
set -a
source "$ROOT/.env"
set +a

LOG="$ROOT/logs/daily_digest.log"
echo "===== daily best bets $(date) =====" >> "$LOG"
/usr/bin/python3 scripts/daily_best_bets.py >> "$LOG" 2>&1
echo "===== exit $? @ $(date) =====" >> "$LOG"
