#!/usr/bin/env bash
# deploy/run-recalibrate.sh — daily EV-gate recalibration on the droplet.
#
# Driven by systemd recalibrate.timer (daily 04:00 UTC).
# 1) Freshen settlement outcomes for the newest unsettled tickers (bounded).
# 2) Re-fit alpha/psi and apply-within-guardrails / hold-for-review + email.
#
# Mirrors scripts/run-recalibrate.sh (Mac) but with droplet paths and bash.
set -uo pipefail

cd /home/deploy/whale-tracker
set -a; source .env; set +a

echo "=== recalibrate run $(date '+%F %H:%M:%S') ==="
node server/src/backfillOutcomes.js --limit 1200 || echo "[recalibrate] backfill step had errors — continuing to fit on existing settled data"
exec node server/src/recalibrate.js
