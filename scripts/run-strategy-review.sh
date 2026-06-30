#!/bin/zsh
# run-strategy-review.sh — DAILY strategy-tuning agent.
# Reviews the bot's own bet P&L + the backtest and auto-applies small, bounded
# knob changes (server-guardrailed). Writes outcomes/strategy_review_<date>.md;
# the server emails any applied change.
#
# Loaded by ~/Library/LaunchAgents/com.whaletracker.strategy-review.plist (07:00 daily).
export PATH="/Users/claude_bot/.nvm/versions/node/v25.8.1/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/claude_bot/whale-tracker/whale-tracker || exit 1

set -a
source .env
set +a
export LOCAL_SERVER_URL=http://localhost:3002

echo "=== strategy-review run $(date '+%F %H:%M:%S') ==="
exec node agent-trader/strategyReview.js
