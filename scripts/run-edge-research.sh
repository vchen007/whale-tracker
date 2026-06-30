#!/bin/zsh
# run-edge-research.sh — weekly edge-research agent (#3). Read-only; writes a
# report to outcomes/edge_research_<date>.md. Proposes; never trades.
#
# Loaded by ~/Library/LaunchAgents/com.whaletracker.edge-research.plist (Sun 05:00,
# after recalibrate at 04:00). Targets the LIVE server (:3002) which serves the
# full historical trades.db.
export PATH="/Users/claude_bot/.nvm/versions/node/v25.8.1/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/claude_bot/whale-tracker/whale-tracker || exit 1

set -a
source .env
set +a
export LOCAL_SERVER_URL=http://localhost:3002

echo "=== edge-research run $(date '+%F %H:%M:%S') ==="
exec node agent-trader/edgeResearch.js
