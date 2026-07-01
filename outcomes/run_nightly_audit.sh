#!/bin/zsh
# Nightly cross-environment adherence audit: Mac demo :3001 vs the DROPLET's
# LIVE trader. Native multiagent COORDINATOR: demo-auditor + live-auditor debate,
# converging on a joint report (coordinator_audit.py, needs AUDIT_COORDINATOR_ID).
# To fall back to the client-side relay, swap coordinator_audit.py for
# nightly_cross_audit.py on the python line below.
# Driven by ~/Library/LaunchAgents/com.whaletracker.nightly-audit.plist (03:00);
# logs each night to outputs/cron_<date>.log.
#
# LIVE target: the real-money trader lives on the DROPLET, whose :3002 is
# firewalled. We open an SSH tunnel (droplet:3002 -> localhost:3012) and point
# the live auditor at it. The Mac's own :3002 is an idle live-configured server
# and must NOT be audited, so if the tunnel fails we ABORT rather than silently
# audit the wrong box. (Mac and droplet share the same AUTH_TOKEN, so the audit's
# single-token tool calls authenticate to both.)
set -euo pipefail

# cron/launchd run with a minimal PATH; make python3 + ssh + coreutils resolvable.
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

# ── SSH tunnel to the droplet's LIVE server ──────────────────────────────────
DROPLET="deploy@192.241.139.13"
SSH_KEY="/Users/claude_bot/.ssh/id_ed25519"
LIVE_PORT=3012
export LIVE_SERVER_URL="http://localhost:${LIVE_PORT}"   # coordinator_audit.py --live-url

TUNNEL_PID=""
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT

# Clear any stale tunnel bound to the port, then open a fresh one in background.
pkill -f "${LIVE_PORT}:localhost:3002" 2>/dev/null || true
ssh -N -L "${LIVE_PORT}:localhost:3002" -i "$SSH_KEY" \
    -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "$DROPLET" &
TUNNEL_PID=$!

# Wait for the forward to answer (droplet /health via the tunnel).
tunnel_ready=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -m 3 "http://localhost:${LIVE_PORT}/health" >/dev/null 2>&1; then
    tunnel_ready=1; break
  fi
  sleep 1
done

echo "===== nightly cross-audit (coordinator) $(date) =====" >> "$LOG"
if [ -z "$tunnel_ready" ]; then
  echo "[run_nightly_audit] ABORT: SSH tunnel to ${DROPLET}:3002 (live) did not come up; " \
       "refusing to audit the Mac's idle local :3002." >> "$LOG"
  echo "===== exit 1 (no tunnel) @ $(date) =====" >> "$LOG"
  exit 1
fi
echo "[run_nightly_audit] live tunnel up: localhost:${LIVE_PORT} -> ${DROPLET}:3002" >> "$LOG"

# Force unbuffered python so the log streams instead of flushing only at exit.
# Capture rc explicitly: under `set -e` a bare `$?` echo would be skipped on a
# non-zero audit exit. The EXIT trap still tears the tunnel down either way.
rc=0
PYTHONUNBUFFERED=1 python3 outcomes/coordinator_audit.py "$@" >> "$LOG" 2>&1 || rc=$?
echo "===== exit ${rc} @ $(date) =====" >> "$LOG"
exit "$rc"
