#!/bin/zsh
# run-recalibrate.sh — weekly adaptive EV-gate recalibration (#2).
#
# Loaded by ~/Library/LaunchAgents/com.whaletracker.recalibrate.plist (Sun 04:00).
# 1) Freshen settlement outcomes for the newest markets (bounded, best-effort).
# 2) Re-fit alpha/psi and apply-within-guardrails / hold-for-review + email.
export PATH="/Users/claude_bot/.nvm/versions/node/v25.8.1/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/claude_bot/whale-tracker/whale-tracker || exit 1

set -a
source .env
set +a

echo "=== recalibrate run $(date '+%F %H:%M:%S') ==="
# Freshen settled outcomes (newest 1200 unsettled tickers ≈ a few minutes).
# Best-effort: a hiccup here must not block the fit, so it's not gated with &&.
node server/src/backfillOutcomes.js --limit 1200 || echo "[recalibrate] backfill step had errors — continuing to fit on existing settled data"
exec node server/src/recalibrate.js
