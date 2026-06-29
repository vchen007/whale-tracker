#!/usr/bin/env bash
# systemd/launchd wrapper for the LIVE agent-trader. Runs one decision cycle and,
# if the Anthropic API credit balance is exhausted (the SDK can't run), emails a
# THROTTLED heads-up so the trader doesn't sit dead silently. The Anthropic API
# has no remaining-balance endpoint, so this fires on the depletion error itself —
# the earliest signal available — not as a predictive "getting low" warning.
#
# Note: no `set -e` — we must capture the agent's failure to detect + alert on it.
set -uo pipefail

cd /home/deploy/whale-tracker
set -a; source .env; set +a
export LOCAL_SERVER_URL=http://localhost:3002    # drive the LIVE server

echo "=== run $(date '+%F %H:%M:%S') ==="
out="$(node agent-trader/agentTrader.js 2>&1)"
printf '%s\n' "$out"

# ── Low-credit heads-up ──────────────────────────────────────────────────────
# Fire only on the Anthropic credit-depletion error, at most once per 6h.
if printf '%s' "$out" | grep -qiE 'credit balance is too low|insufficient.*credit'; then
  flag=/home/deploy/whale-tracker/logs/.lowcredit_alert
  now=$(date +%s); last=$(cat "$flag" 2>/dev/null || echo 0)
  if [ "$((now - last))" -gt 21600 ] && [ -n "${RESEND_API_KEY:-}" ] && [ -n "${NOTIFY_EMAIL:-}" ]; then
    curl -s -X POST https://api.resend.com/emails \
      -H "Authorization: Bearer ${RESEND_API_KEY}" -H 'Content-Type: application/json' \
      -d "{\"from\":\"Whale Tracker <onboarding@resend.dev>\",\"to\":\"${NOTIFY_EMAIL}\",\"subject\":\"⚠️ Kalshi live trader DOWN — Anthropic API credits depleted\",\"html\":\"The agent-trader could not run: <b>Anthropic API credit balance is too low</b>. The 20-minute trading cycles are PAUSED until you top up at <a href=\\\"https://console.anthropic.com/settings/billing\\\">console.anthropic.com/settings/billing</a>.<br><br>This alert repeats at most once every 6 hours while the balance stays empty.\"}" >/dev/null \
      && { echo "$now" > "$flag"; echo "[alert] low-credit heads-up emailed to ${NOTIFY_EMAIL}"; }
  fi
fi
