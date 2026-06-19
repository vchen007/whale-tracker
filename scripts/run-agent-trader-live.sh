#!/bin/zsh
# run-agent-trader-live.sh — launchd wrapper for the LIVE agent-trader.
#
# Loaded by ~/Library/LaunchAgents/com.whaletracker.agent-trader-live.plist,
# which fires this every :00 and :30.
#
# Window: 24/7 (all hours, all days) as of 2026-06-19 — no time guards. The agent
# decides each cycle whether any market qualifies; most overnight/off-peak runs
# no-op on empty books, which is harmless (besides the ~$0.026 Haiku run cost).
# To restrict to trading hours again, re-add the hour/dow guards below, e.g.:
#   [ "$dow" -gt 5 ] && exit 0
#   { [ "$hour" -lt 9 ] || [ "$hour" -gt 22 ]; } && exit 0

# 10# forces decimal so zero-padded "08"/"09" don't get read as octal.
# (kept only for the run-log line below — no longer gating execution: 24/7.)
hour=$((10#$(date +%H)))
dow=$(date +%u)                 # 1=Mon … 7=Sun

# cron's env is minimal and launchd's is too; the Agent SDK spawns a subprocess
# that needs node on PATH.
export PATH="/Users/claude_bot/.nvm/versions/node/v25.8.1/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/claude_bot/whale-tracker/whale-tracker || exit 1

set -a
source .env
set +a

# Drive the LIVE bot on :3002 (default in agentTrader.js is :3001 = demo).
export LOCAL_SERVER_URL=http://localhost:3002

echo "=== launchd run $(date '+%F %H:%M:%S') (hour=$hour dow=$dow) ==="
exec node agent-trader/agentTrader.js
