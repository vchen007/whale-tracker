#!/bin/zsh
# Nightly cross-environment adherence audit (demo :3001 vs live :3002).
# Native multiagent COORDINATOR: demo-auditor + live-auditor debate, converging
# on a joint report (coordinator_audit.py, needs AUDIT_COORDINATOR_ID in .env).
# To fall back to the client-side relay, swap coordinator_audit.py for
# nightly_cross_audit.py on the python line below.
# Installed via crontab; logs each night to outputs/cron_<date>.log.
set -euo pipefail

# cron runs with a minimal PATH; make python3 + coreutils resolvable.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/Library/Developer/CommandLineTools/usr/bin:$PATH"

ROOT="/Users/claude_bot/whale-tracker/whale-tracker"
cd "$ROOT"

# Load env (ANTHROPIC_API_KEY, AGENT_ID, ENVIRONMENT_ID, AUTH_TOKEN, …).
set -a
source "$ROOT/.env"
set +a

DATE="$(date +%F)"
LOG="$ROOT/outcomes/outputs/cron_${DATE}.log"
mkdir -p "$ROOT/outcomes/outputs"

echo "===== nightly cross-audit (coordinator) $(date) =====" >> "$LOG"
# Force unbuffered python so the log streams instead of flushing only at exit.
PYTHONUNBUFFERED=1 python3 outcomes/coordinator_audit.py "$@" >> "$LOG" 2>&1
echo "===== exit $? @ $(date) =====" >> "$LOG"
