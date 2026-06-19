#!/usr/bin/env python3
"""
nightly_cross_audit.py — two Managed-Agents sessions audit the Kalshi auto-trader
(one on DEMO :3001, one on LIVE :3002) and then debate each other's findings over
N rounds, converging on a single joint report.

This is the "two agents, full back-and-forth" topology built as an orchestrator
relay: there is no single coordinator agent in the console, so this script is the
relay — it pumps each session's custom-tool calls AND ferries each agent's text
reply into the other session as a user.message, round after round.

Why a relay and not the native coordinator: the native multi-agent path needs a
*coordinator* agent (a roster of demo-auditor + live-auditor) created in the
Anthropic console. Until that exists, this reuses the single AGENT_ID for both
sides and orchestrates the dialogue client-side.

SAFETY: this is a READ-ONLY audit. execute_tool() hard-blocks every kalshi_trader
action except get_status/get_pnl, so even though the LIVE side talks to a
real-money server, the runner physically cannot place or cancel an order.

Usage:
    python nightly_cross_audit.py                     # 3 rounds, localhost demo+live
    python nightly_cross_audit.py --rounds 2
    python nightly_cross_audit.py --demo-url http://localhost:3001 \
                                  --live-url http://localhost:3002

Required env (loaded from ../.env by the wrapper): ANTHROPIC_API_KEY, AGENT_ID,
ENVIRONMENT_ID, AUTH_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

try:
    from anthropic import Anthropic
except ImportError:
    sys.exit("Missing dependency. Run:  pip install anthropic")

HERE = Path(__file__).resolve().parent
OUTPUTS_DIR = HERE / "outputs"
BETA = "managed-agents-2026-04-01,files-api-2025-04-14"

# Read-only allow-list. The kalshi_trader tool CAN place/cancel orders; for an
# audit we permit only the two read actions and reject everything else, so a
# nightly unattended run can never touch the live account.
READ_ONLY_ACTIONS = {"get_status", "get_pnl"}


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"Missing required environment variable: {name}")
    return val


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def execute_tool(action_input: dict, server_url: str, auth_token: str) -> dict:
    """Proxy a kalshi_trader call to the local whale-tracker /agent/tool endpoint.

    Hard-blocks any non-read action regardless of what the agent requested.
    """
    action = (action_input or {}).get("action")
    if action not in READ_ONLY_ACTIONS:
        return {
            "error": (
                f"BLOCKED: action '{action}' is not permitted in the read-only "
                f"adherence audit. Allowed: {sorted(READ_ONLY_ACTIONS)}. "
                "Do not attempt to place, cancel, or modify orders."
            )
        }
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
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def send_user(client: Anthropic, session_id: str, text: str) -> None:
    client.beta.sessions.events.send(
        session_id=session_id,
        events=[{"type": "user.message", "content": [{"type": "text", "text": text}]}],
    )


def run_to_idle(
    client: Anthropic,
    session_id: str,
    server_url: str,
    auth_token: str,
    label: str,
    *,
    poll: float = 4.0,
    max_wait: float = 600.0,
) -> str:
    """Drive one session until it finishes the current turn (status == 'idle'),
    executing any custom-tool calls along the way. Returns the concatenated
    agent.message text produced during this turn.
    """
    cursor = now_iso()           # only consider events emitted after we were called
    deadline = time.time() + max_wait
    reply_chunks: list[str] = []
    saw_message = False

    while time.time() < deadline:
        kwargs = {
            "types": ["agent.custom_tool_use", "agent.message"],
            "order": "asc",
            "created_at_gt": cursor,
        }
        for ev in client.beta.sessions.events.list(session_id, **kwargs):
            cursor = ev.processed_at.isoformat()
            if ev.type == "agent.custom_tool_use":
                stamp = time.strftime("%H:%M:%S")
                print(f"[{stamp}] {label} tool: {ev.name}({json.dumps(ev.input)})")
                result = execute_tool(ev.input, server_url, auth_token)
                print(f"          -> {json.dumps(result)[:160]}")
                client.beta.sessions.events.send(
                    session_id=session_id,
                    events=[{
                        "type": "user.custom_tool_result",
                        "custom_tool_use_id": ev.id,
                        "content": [{"type": "text", "text": json.dumps(result)}],
                        "is_error": "error" in result,
                        **({"session_thread_id": ev.session_thread_id} if getattr(ev, "session_thread_id", None) else {}),
                    }],
                )
            elif ev.type == "agent.message":
                text = "".join(getattr(b, "text", "") for b in ev.content)
                if text.strip():
                    reply_chunks.append(text)
                    saw_message = True

        status = client.beta.sessions.retrieve(session_id).status
        if status == "terminated":
            print(f"  ⚠️  {label} session terminated mid-turn.")
            break
        # 'idle' means the turn is complete AND no tool call is awaiting a result.
        # Require at least one new agent.message so we don't trip on a stale
        # pre-send idle status (race right after sending the user message).
        if status == "idle" and saw_message:
            break
        time.sleep(poll)
    else:
        print(f"  ⚠️  {label} timed out after {max_wait:.0f}s waiting for idle.")

    return "\n".join(reply_chunks).strip()


AUDIT_KICKOFF = """\
You are the {role} auditor of a Kalshi auto-trader. Audit ONLY the {env} \
environment via your kalshi_trader tool — this is READ-ONLY, never place or \
cancel orders.

1. Call kalshi_trader action=get_status and action=get_pnl at the start.
2. Produce a concise adherence assessment covering: maker-vs-taker realized \
behavior (target 0 takers — a hard gate), price-floor >=70c (hard gate), \
EV-positivity at entry, risk caps (open positions, capital, per-ticker, daily \
loss, event-dedup — hard gate), stop-loss, and a bottom-line P&L read.
3. Quote the actual numbers (realized_pnl_cents, taker counts, caps). Units: \
entry_price and pnl_cents are CENTS; est_fee and est_net_ev are DOLLARS.

End your reply with a section headed exactly `## FINDINGS ({env})` summarizing \
the hard-gate verdicts and net P&L in <=8 bullet points. You will then debate \
these findings with the auditor of the OTHER environment.
"""

DEBATE_PROMPT = """\
Below are the latest findings from the {other_env} auditor. You audit {env}. \
Compare the two environments: where do they agree, where does {env} diverge, \
and WHY (e.g. config differences, legacy data, liquidity)? Challenge anything \
that looks wrong and defend or revise your own read. Keep using your \
kalshi_trader tool (READ-ONLY) if you need to re-check a number. Be specific \
and cite figures.

--- {other_env} auditor said ---
{message}
--- end ---
"""

SYNTHESIS_PROMPT = """\
The demo/live debate is complete. Using the ENTIRE conversation, write the final \
converged joint report as Markdown in your reply (do not rely on writing a file). \
Structure:

# Nightly Cross-Environment Adherence Audit — {date}

## 1. Executive summary (3-4 lines: demo vs live, biggest divergence)
## 2. Demo (:3001) verdict — hard gates, P&L
## 3. Live (:3002) verdict — hard gates, P&L
## 4. Cross-environment divergence (what differs and why)
## 5. Points of disagreement reconciled during the debate (if any)
## 6. Prioritized action list (most important first, with cited numbers)

Be concrete and quote the numbers both auditors established.
"""


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rounds", type=int, default=3, help="debate rounds after the initial audit")
    p.add_argument("--demo-url", default=os.environ.get("DEMO_SERVER_URL", "http://localhost:3001"))
    p.add_argument("--live-url", default=os.environ.get("LIVE_SERVER_URL", "http://localhost:3002"))
    p.add_argument("--max-wait", type=float, default=600.0, help="per-turn idle timeout (s)")
    p.add_argument("--poll", type=float, default=4.0)
    p.add_argument("--out", default=None, help="output path (default outputs/cross_audit_<date>.md)")
    return p.parse_args()


def main():
    args = parse_args()
    api_key = require_env("ANTHROPIC_API_KEY")
    agent_id = require_env("AGENT_ID")
    environment_id = require_env("ENVIRONMENT_ID")
    auth_token = require_env("AUTH_TOKEN")

    date = datetime.now().strftime("%Y-%m-%d")
    client = Anthropic(api_key=api_key, default_headers={"anthropic-beta": BETA})

    sides = {
        "demo": {"url": args.demo_url, "env": "DEMO (:3001)", "sid": None},
        "live": {"url": args.live_url, "env": "LIVE (:3002)", "sid": None},
    }
    for key, s in sides.items():
        sess = client.beta.sessions.create(
            agent=agent_id, environment_id=environment_id,
            title=f"Cross-audit {key} {date}",
        )
        s["sid"] = sess.id
        print(f"Session ({key}): {sess.id}")

    transcript: list[str] = [f"# Cross-audit transcript — {date}\n"]

    def record(speaker: str, text: str):
        transcript.append(f"\n## {speaker}\n\n{text}\n")

    # ── Round 0: each side audits its own environment ────────────────────────
    print("\n=== Round 0: independent audits ===")
    send_user(client, sides["demo"]["sid"],
              AUDIT_KICKOFF.format(role="demo", env="DEMO (:3001)"))
    demo_msg = run_to_idle(client, sides["demo"]["sid"], sides["demo"]["url"],
                           auth_token, "demo", poll=args.poll, max_wait=args.max_wait)
    record("DEMO auditor — initial", demo_msg)

    send_user(client, sides["live"]["sid"],
              AUDIT_KICKOFF.format(role="live", env="LIVE (:3002)"))
    live_msg = run_to_idle(client, sides["live"]["sid"], sides["live"]["url"],
                           auth_token, "live", poll=args.poll, max_wait=args.max_wait)
    record("LIVE auditor — initial", live_msg)

    # ── Debate rounds: relay each side's last message to the other ───────────
    for r in range(1, args.rounds + 1):
        print(f"\n=== Round {r}: debate ===")
        # live responds to demo's latest
        send_user(client, sides["live"]["sid"],
                  DEBATE_PROMPT.format(env="LIVE (:3002)", other_env="DEMO (:3001)", message=demo_msg))
        live_msg = run_to_idle(client, sides["live"]["sid"], sides["live"]["url"],
                               auth_token, "live", poll=args.poll, max_wait=args.max_wait)
        record(f"LIVE auditor — round {r}", live_msg)

        # demo responds to live's latest
        send_user(client, sides["demo"]["sid"],
                  DEBATE_PROMPT.format(env="DEMO (:3001)", other_env="LIVE (:3002)", message=live_msg))
        demo_msg = run_to_idle(client, sides["demo"]["sid"], sides["demo"]["url"],
                               auth_token, "demo", poll=args.poll, max_wait=args.max_wait)
        record(f"DEMO auditor — round {r}", demo_msg)

    # ── Convergence: live synthesizes the joint report (it has both sides) ────
    print("\n=== Synthesis: joint report ===")
    send_user(client, sides["live"]["sid"], SYNTHESIS_PROMPT.format(date=date))
    joint = run_to_idle(client, sides["live"]["sid"], sides["live"]["url"],
                        auth_token, "live", poll=args.poll, max_wait=args.max_wait)

    # ── Write outputs (capture text directly — do not rely on the Files API) ─
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else OUTPUTS_DIR / f"cross_audit_{date}.md"
    transcript_path = OUTPUTS_DIR / f"cross_audit_{date}.transcript.md"

    # The synthesis turn often emits reasoning before the report proper. Trim the
    # saved report to start at the title header if present (full text is always
    # preserved in the transcript).
    report = joint
    lines = joint.splitlines()
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("# Nightly Cross-Environment"):
            report = "\n".join(lines[i:])
            break

    out_path.write_text(report + "\n")
    transcript_path.write_text("\n".join(transcript))
    print(f"\n↓ joint report : {out_path}")
    print(f"↓ transcript   : {transcript_path}")

    ok = bool(joint.strip())
    print(f"\nDone. Joint report {'captured' if ok else 'EMPTY — check timeouts'}.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
