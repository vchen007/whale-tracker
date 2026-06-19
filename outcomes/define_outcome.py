#!/usr/bin/env python3
"""
define_outcome.py — launch a Managed Agents "defined outcome" for the Kalshi
auto-trader and drive it to completion, including executing kalshi_trader tool
calls on behalf of the agent via the local whale-tracker server.

Usage:
    python define_outcome.py --rubric trade_plan            # demo, default caps
    python define_outcome.py --rubric trade_plan --live --max-capital 200
    python define_outcome.py --rubric adherence             # weekly audit
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

try:
    from anthropic import Anthropic
except ImportError:
    sys.exit("Missing dependency. Run:  pip install anthropic")

HERE = Path(__file__).resolve().parent
OUTPUTS_DIR = HERE / "outputs"

BETA = "managed-agents-2026-04-01,files-api-2025-04-14"

RUBRICS = {
    "trade_plan": HERE / "trade_plan_rubric.md",
    "adherence":  HERE / "adherence_review_rubric.md",
}

TERMINAL_RESULTS = {"satisfied", "failed", "max_iterations_reached", "interrupted"}

KALSHI_DEMO_BASE = "https://demo-api.kalshi.co/trade-api/v2"
KALSHI_LIVE_BASE = "https://api.elections.kalshi.com/trade-api/v2"

BLOCKED_PREFIXES = [
    "KXNBASPREAD", "KXIPL", "KXATPMATCH", "KXWTAMATCH",
    "KXITFMATCH", "KXUFCFIGHT", "KXMVECROSSCATEGORY", "KXMVESPORTS",
]


def build_trade_plan_description(args) -> str:
    base     = KALSHI_LIVE_BASE if args.live else KALSHI_DEMO_BASE
    env_word = "LIVE (real money)" if args.live else "DEMO (paper)"
    return f"""\
Place a batch of expected-value-positive Kalshi orders for the current session,
then write two artifacts to /mnt/session/outputs:
  - orders_placed.json : one record per order actually placed.
  - ev_report.md       : the EV justification + a rejects table.

Trade ONLY against the Kalshi {env_word} API at {base} using the kalshi_trader
tool provided. You must respect these HARD constraints on every order:

  - MAKER ONLY: post a resting limit that does not cross the ask.
  - FAVORITES ONLY: limit_price >= {args.min_price} cents.
  - POSITIVE POST-FEE EV: est_net_ev = est_q - P - fee > 0 for every order.
  - BLOCKED MARKETS: skip tickers starting with any of {BLOCKED_PREFIXES};
    skip hourly/crypto-reset and sub-24h markets.
  - RISK CAPS: total notional <= ${args.max_capital}; per-position notional
    <= {args.max_position_pct}% of ${args.max_capital}; at most {args.max_open}
    open positions; aim for >= {args.min_positions} independent events.
  - TIMING: prefer markets within a few days of close.

Use get_status first to confirm the trader is enabled and check current caps.
Use get_pnl to check open positions before placing new ones.

FINDING FILLABLE TRADES: ALWAYS call action=find_markets FIRST (optional
params: limit, max_spread_cents) to discover open markets with a real
two-sided book, ranked by recent taker flow — that flow is the probability
your resting maker order actually fills. Prefer markets from this list over
tickers you remember from get_pnl. To raise fill probability, you may quote
close to (but strictly below) the ask — the server rejects crossing orders.
If an order rests unfilled, it auto-cancels after the TTL; re-quote or move on
rather than chasing.

orders_placed.json SCHEMA (exact field names — the grader's hard-gate check
matches these strings; using a different name fails §7 even if the data is
right). Each array entry MUST include ALL of:
  ticker            (string) — the market ticker you placed against
  side              (string) — "yes" or "no"
  limit_price       (integer cents) — THE PRICE YOU SENT (call it limit_price,
                                      not entry_price)
  count             (integer)
  best_bid          (integer cents) — copy from place_order response.best_bid
  best_ask          (integer cents) — copy from place_order response.best_ask
  maker_ok          (boolean) — MUST be set explicitly. Compute as:
                                response.role == "maker" AND limit_price < best_ask.
                                For a successful place_order this is always true,
                                because the server rejects crossing orders — write
                                true and assert it in ev_report.md.
  price_band_ok     (boolean) — MUST be set explicitly. Compute as:
                                limit_price >= {args.min_price} AND limit_price <= 94.
                                Assert true in ev_report.md per order.
  est_q             (number 0..1) — copy from response.est_q
  est_fee           (number, DOLLARS) — copy from response.est_fee
                                      (NOT est_fee_dollars; the rubric name is est_fee)
  est_net_ev        (number, DOLLARS) — copy from response.est_net_ev
  signal_source     (string) — copy from response.est_q_source
                                (NOT est_q_source; the rubric name is signal_source)
  kalshi_order_id   (string) — copy from response.order_id
                                (NOT order_id; the rubric name is kalshi_order_id)
  status            (string) — "resting" for accepted maker orders
And per order, ALSO include the extra provenance fields in the SAME object
(they don't break the schema; the grader looks for the required ones first):
  ev_formula        (string) — quote response.ev_formula VERBATIM. Unit-
                                consistent, all dollars. Do NOT rewrite or mix
                                cents and dollars.
  fee_schedule      (string) — quote response.fee_schedule VERBATIM. Names
                                the rate, rounding, whether the sports premium
                                applied, source URL, and schedule date.
  days_to_close     (integer) — copy from response.days_to_close

ev_report.md REQUIRED CONTENT (rubric §7):
  - Summary line: total capital deployed (in dollars), number of independent
    events, aggregate expected EV.
  - Per-order block citing ev_formula AS-IS, asserting maker_ok=true and
    price_band_ok=true, naming fee_schedule AS-IS, citing signal_source.
    est_q comes from a historical calibration bucket (the favorite-longshot
    regression), so two orders at the same price legitimately share the same
    q — state this explicitly when relevant.
  - Rejects table: every candidate you considered but did NOT place, with the
    specific failing gate and the failing number.
  - The fee-schedule version/date used and the bankroll figure ($ value).
TIMING: the server rejects markets closing more than ~10 days out; only
propose near-dated markets, and record days_to_close per order. State the
unfilled-order policy explicitly in your report: unfilled orders are canceled
at TTL, never re-priced upward to cross.
DIVERSIFICATION: aim for the independent-events target. If fewer events pass
all gates, keep scanning different categories via find_markets before settling
for fewer, and document every near-miss in the rejects table with its failing
gate and number.

ERROR HANDLING: if a place_order returns an exchange error or the same
rejection twice, do NOT retry it again — record it in your rejects table and
move to a different market. Never retry the same order more than twice total.
The tool endpoint is rate-limited; hammering it wastes your iteration budget.
Your work will be graded against the rubric.
"""


def build_adherence_description(args) -> str:
    return """\
Produce /mnt/session/outputs/performance_review.md auditing the Kalshi auto-
trader's REALIZED behavior. Read-only — do NOT place, cancel, or modify orders.

DATA SOURCES (call BOTH at the start; you have no caps to audit against without
both):
  1. kalshi_trader action=get_status — returns the configured limits:
     enabled, makerMode, minPriceCents, maxPriceCents, minNotional, maxCapital,
     maxOpenPositions, maxPerTicker, maxDailyLoss, stopLossEnabled, stopLossPercent,
     calibratedEv, calibrationAlpha, calibrationPsi, minEvDollars, maxDaysToClose,
     unfilledTtlMinutes, dedupeByEvent, realizedTodayCents. THIS IS THE AUTHORITATIVE
     SOURCE for risk-cap audits — quote these numbers, do not say they are unknown.
  2. kalshi_trader action=get_pnl — returns the auto_orders table snapshot:
     total, open, wins, losses, realized_pnl_cents, plus recent[] (up to 50 most
     recent orders with ticker, side, entry_price, count, est_fee, role, est_q,
     est_net_ev, placed_ts, status, outcome, pnl_cents, settled_ts). THIS IS the
     auto_orders reconciliation source — state explicitly that recent[] is your
     window and reconcile total = sum across statuses.

FIELD UNITS (the schema mixes cents and dollars — get these RIGHT in §4):
  - entry_price: CENTS (integer 1..99). Convert to dollars as entry_price/100.
  - pnl_cents:   CENTS (integer, signed).
  - est_fee:     DOLLARS (e.g. 0.01 = 1 cent, NOT 0.01 cents).
  - est_net_ev:  DOLLARS (signed; per-contract).
  - est_q:       probability (0..1), unitless.
  - count:       integer contracts.
  All §4 EV math is in DOLLARS PER CONTRACT.

Cover ALL SEVEN rubric sections explicitly in performance_review.md, with the
section number/name as the heading:

  §1 Coverage. State the review window as date range from min(placed_ts) to
     max(placed_ts) across recent[]. Report orders examined (len of recent[]).
     RECONCILIATION RULE: recent[] is capped at 50 rows. If total <= 50 it is
     the FULL set and you must count statuses DIRECTLY from recent[] (group
     by status); treat recent[] as authoritative. Any minor mismatch vs the
     pre-computed totals object (open/wins/losses) is a data-race artifact
     between two SQL queries — note it as such and move on, do NOT call it
     incomplete reconciliation. If total > 50, recent[] is only the most-
     recent 50 and you should state that older orders are out of scope.
     Note any orders missing required fields.

  §2 Maker vs taker realized check (HARD GATE). For each order classify
     role from the 'role' column ('maker' / 'taker' / null). List every taker
     entry with ticker, price, est_fee. REPORT THE COUNT AND TOTAL TAKER-FEE
     COST (sum of est_fee where role='taker', in dollars). FRAMING: the
     rubric target is 0 taker entries; any taker count > 0 is a HARD-GATE
     VIOLATION. State it as such — for example, '18 taker entries detected:
     exceeds target of 0 — HARD GATE VIOLATION'. Do not present takers as
     neutral data points; they ARE the violation. For role=null orders,
     state they are indeterminate and count them separately.

  §3 Price-floor adherence (HARD GATE). Check entry_price >= 70c for every
     order. List sub-floor entries with price. Count = 0 means pass.

  §4 EV-positivity at entry. Recompute the EV formula AS-IS — ALL TERMS
     IN DOLLARS, NO CENTS:
       est_net_ev_dollars = est_q − (entry_price/100) − est_fee
     where est_q is the probability (0..1), entry_price/100 converts cents
     to dollars, and est_fee is ALREADY IN DOLLARS (e.g. 0.01 means $0.01 =
     1 cent — do NOT call it '0.01 cents'). Cite the formula explicitly as
     'all terms dollars per contract'. Flag any order where stored
     est_net_ev <= 0 or is null.

  §5 Risk-cap adherence (HARD GATE). USE THE NUMBERS FROM get_status. Check:
     (a) peak concurrent open positions across recent[] vs maxOpenPositions —
         a breach if exceeded;
     (b) peak deployed notional vs maxCapital — sum (entry_price/100 * count)
         across status='resting'|'placed' in recent[];
     (c) per-ticker count vs maxPerTicker;
     (d) daily realized P&L vs maxDailyLoss (kill-switch threshold). With
         realized_pnl_cents = +X cents, state explicitly: '+X cents vs
         -$MAX_DAILY_LOSS·100c threshold = no breach' (if positive);
     (e) per-event dedupe — group recent[] by event ticker (ticker minus the
         last dash-segment) and flag any event with >1 distinct ticker; this
         IS the dedupeByEvent constraint.
     If ANY breach, list it with the specific value. If NO breaches found,
     SAY SO EXPLICITLY (do not say 'cannot be checked' — the data is there).

  §6 Stop-loss accounting. If stopLossEnabled=true: scan for orders with
     status='closed_early'. For each, compute realized exit cost = (entry_price
     - sold_price) * count cents. If none exist, STATE EXPLICITLY: 'no early
     closes in window — stop-loss did not fire.' Either way address this
     section; do not omit it.

  §7 Bottom line. Compute and report all of:
     - Realized P&L: gross = sum pnl_cents across settled+closed_early;
       fees = sum est_fee across settled+closed_early;
       net = gross - fees (in cents).
     - Win rate: wins / (wins + losses). State settled count.
     - Realized win-rate vs average entry price of settled positions
       (avg(entry_price) for settled outcomes) — interpret per the favorite-
       longshot literature: high avg entry price + high win rate is consistent
       with the paper's calibration; deviations are a flag.
     - A prioritized fix list (top 3-5 items) with each citing a specific
       number from the data.

CONSTRAINTS:
  - Every claim must cite a number from get_status or get_pnl. If a number is
    not in the data, say 'not available from get_pnl/get_status' rather than
    leaving the question unanswered.
  - Do not say a cap or config is unknown. ALWAYS call get_status FIRST.
  - Output the artifact at /mnt/session/outputs/performance_review.md, with the
    seven sections in order using the headings above.
"""


def parse_args():
    p = argparse.ArgumentParser(description="Launch a Kalshi defined-outcome session.")
    p.add_argument("--rubric", choices=RUBRICS.keys(), default="trade_plan")
    # Cost caps: 2 grader iterations + a 20-min window keep a session to pennies
    # (pair with a Haiku-class agent model in the console agent config).
    p.add_argument("--max-iterations", type=int, default=2)
    p.add_argument("--live", action="store_true")
    p.add_argument("--upload-rubric", action="store_true")
    p.add_argument("--max-capital",      type=float, default=200.0)
    p.add_argument("--max-position-pct", type=float, default=10.0)
    p.add_argument("--max-open",         type=int,   default=20)
    p.add_argument("--min-positions",    type=int,   default=10)
    p.add_argument("--min-price",        type=int,   default=70)
    p.add_argument("--poll-interval",    type=float, default=5.0)
    p.add_argument("--timeout",          type=float, default=1200.0)
    p.add_argument("--server-url",       type=str,   default=None,
                   help="Whale-tracker server URL (overrides SERVER_URL env var).")
    return p.parse_args()


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"Missing required environment variable: {name}")
    return val


def execute_tool(action_input: dict, server_url: str, auth_token: str) -> dict:
    """Call the local whale-tracker /agent/tool endpoint and return the result."""
    try:
        resp = requests.post(
            f"{server_url}/agent/tool",
            json=action_input,
            headers={"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"},
            timeout=30,
        )
        if resp.ok:
            return {"result": resp.json()}
        return {"error": f"HTTP {resp.status_code}: {resp.text[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def main():
    args = parse_args()

    api_key        = require_env("ANTHROPIC_API_KEY")
    agent_id       = require_env("AGENT_ID")
    environment_id = require_env("ENVIRONMENT_ID")
    auth_token     = require_env("AUTH_TOKEN")
    server_url     = args.server_url or require_env("SERVER_URL")

    rubric_path = RUBRICS[args.rubric]
    rubric_text = rubric_path.read_text()

    if args.rubric == "trade_plan" and args.live:
        print("\n  ⚠️  LIVE MODE — this will place REAL orders on your Kalshi account.")
        if input("  Type 'I UNDERSTAND' to continue: ").strip() != "I UNDERSTAND":
            sys.exit("Aborted.")

    client = Anthropic(api_key=api_key, default_headers={"anthropic-beta": BETA})

    if args.upload_rubric:
        uploaded   = client.beta.files.upload(file=rubric_path)
        rubric_ref = {"type": "file", "file_id": uploaded.id}
        print(f"Uploaded rubric: {uploaded.id}")
    else:
        rubric_ref = {"type": "text", "content": rubric_text}

    if args.rubric == "trade_plan":
        description = build_trade_plan_description(args)
        title       = f"Kalshi trade plan ({'LIVE' if args.live else 'DEMO'})"
    else:
        description = build_adherence_description(args)
        title       = "Kalshi auto-trader adherence review"

    # ── Create session ───────────────────────────────────────────────────────────
    session    = client.beta.sessions.create(agent=agent_id, environment_id=environment_id, title=title)
    session_id = session.id
    print(f"Session: {session_id}  ({title})")

    # ── Define the outcome ───────────────────────────────────────────────────────
    client.beta.sessions.events.send(
        session_id=session_id,
        events=[{
            "type":           "user.define_outcome",
            "description":    description,
            "rubric":         rubric_ref,
            "max_iterations": max(1, min(20, args.max_iterations)),
        }],
    )
    print(f"Outcome defined (max_iterations={args.max_iterations}). Working…\n")

    # ── Event loop ───────────────────────────────────────────────────────────────
    deadline      = time.time() + args.timeout
    seen_evals    = {}    # outcome_id → last (result, explanation) printed
    seen_tools    = set() # event IDs already handled
    final         = None
    last_event_ts = None  # only fetch events newer than this each tick

    while time.time() < deadline:
        # 1. Check for pending custom tool calls
        tool_kwargs = {"types": ["agent.custom_tool_use"], "order": "asc"}
        if last_event_ts:
            tool_kwargs["created_at_gt"] = last_event_ts
        for ev in client.beta.sessions.events.list(session_id, **tool_kwargs):
            if ev.id in seen_tools:
                continue
            seen_tools.add(ev.id)
            last_event_ts = ev.processed_at.isoformat()

            stamp = time.strftime("%H:%M:%S")
            print(f"[{stamp}] tool call: {ev.name}({json.dumps(ev.input)})")
            result = execute_tool(ev.input, server_url, auth_token)
            print(f"          → {json.dumps(result)[:200]}")

            client.beta.sessions.events.send(
                session_id=session_id,
                events=[{
                    "type":               "user.custom_tool_result",
                    "custom_tool_use_id": ev.id,
                    "content":            [{"type": "text", "text": json.dumps(result)}],
                    "is_error":           "error" in result,
                    **({"session_thread_id": ev.session_thread_id} if ev.session_thread_id else {}),
                }],
            )

        # 2. Check outcome evaluations
        s     = client.beta.sessions.retrieve(session_id)
        evals = getattr(s, "outcome_evaluations", None) or []
        for ev in evals:
            oid         = getattr(ev, "outcome_id", "?")
            result      = getattr(ev, "result", None)
            explanation = getattr(ev, "explanation", "") or ""
            key = (result, explanation)
            if result and seen_evals.get(oid) != key:
                seen_evals[oid] = key
                stamp = time.strftime("%H:%M:%S")
                print(f"[{stamp}] {oid}: {result}")
                if explanation:
                    print(f"    grader: {explanation}\n")
                if result in TERMINAL_RESULTS:
                    final = result
        if final:
            break

        time.sleep(args.poll_interval)
    else:
        print("Timed out waiting for a terminal outcome result.")

    print(f"\nFinal result: {final or 'unknown'}")

    # ── Download deliverables ────────────────────────────────────────────────────
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        files = client.beta.files.list()
        data  = getattr(files, "data", []) or []
        if not data:
            print("No output files were produced.")
        for f in data:
            dest = OUTPUTS_DIR / f.filename
            content = client.beta.files.download(f.id)
            if hasattr(content, "write_to_file"):
                content.write_to_file(str(dest))
            else:
                dest.write_bytes(content.read() if hasattr(content, "read") else bytes(content))
            print(f"  ↓ {dest.relative_to(HERE)}")
    except Exception as e:
        print(f"Could not download outputs: {e}")

    sys.exit(0 if final == "satisfied" else 1)


if __name__ == "__main__":
    main()
