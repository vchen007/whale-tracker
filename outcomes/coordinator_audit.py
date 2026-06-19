#!/usr/bin/env python3
"""
coordinator_audit.py — drive ONE Managed-Agents session against the native
multiagent COORDINATOR (created by coordinator_agents.py --create) to run the
nightly demo-vs-live cross-environment adherence audit.

This is the native-coordinator counterpart to the client-side relay in
nightly_cross_audit.py. Here the *coordinator agent* spawns the demo-auditor and
live-auditor as session threads, relays their findings between them, and writes
the converged joint report. This script's only jobs are:
  1. open the session and kick it off,
  2. execute the two leaf agents' custom-tool calls (routing by TOOL NAME:
     kalshi_demo -> :3001, kalshi_live -> :3002), READ-ONLY,
  3. capture the coordinator's final joint report + a transcript.

Required env: ANTHROPIC_API_KEY, ENVIRONMENT_ID, AUTH_TOKEN, AUDIT_COORDINATOR_ID
(the coordinator agent id printed by `coordinator_agents.py --create`).

    python coordinator_audit.py
    python coordinator_audit.py --rounds 3 --coordinator-id agent_...

To make this the nightly job instead of the relay, point run_nightly_audit.sh at
this file once AUDIT_COORDINATOR_ID is set. Until then the cron keeps running the
relay (nightly_cross_audit.py), which needs no console setup.

SAFETY: read-only. execute_tool() hard-blocks every action except
get_status/get_pnl, so the live thread (real money) cannot place/cancel orders.
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

READ_ONLY_ACTIONS = {"get_status", "get_pnl"}


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        sys.exit(f"Missing required environment variable: {name}")
    return val


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def execute_tool(tool_name: str, action_input: dict, servers: dict, auth_token: str) -> dict:
    """Route a leaf agent's tool call to the correct server BY TOOL NAME and
    enforce the read-only allow-list. Unknown tools / non-read actions are
    rejected without ever touching a server."""
    server_url = servers.get(tool_name)
    if not server_url:
        return {"error": f"BLOCKED: unknown tool '{tool_name}'. Expected one of {sorted(servers)}."}
    action = (action_input or {}).get("action")
    if action not in READ_ONLY_ACTIONS:
        return {
            "error": (
                f"BLOCKED: action '{action}' is not permitted in the read-only "
                f"adherence audit. Allowed: {sorted(READ_ONLY_ACTIONS)}."
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


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--coordinator-id", default=os.environ.get("AUDIT_COORDINATOR_ID"),
                   help="coordinator agent id (default $AUDIT_COORDINATOR_ID)")
    p.add_argument("--rounds", type=int, default=3, help="debate rounds to suggest to the coordinator")
    p.add_argument("--demo-url", default=os.environ.get("DEMO_SERVER_URL", "http://localhost:3001"))
    p.add_argument("--live-url", default=os.environ.get("LIVE_SERVER_URL", "http://localhost:3002"))
    p.add_argument("--poll", type=float, default=4.0)
    p.add_argument("--quiet-polls", type=int, default=3,
                   help="consecutive idle polls with no new events that mean 'done'")
    p.add_argument("--timeout", type=float, default=1800.0, help="overall wall-clock cap (s)")
    p.add_argument("--out", default=None)
    return p.parse_args()


KICKOFF = """\
Run tonight's cross-environment adherence audit ({date}) for the Kalshi \
auto-trader. Coordinate your demo auditor (paper, :3001, tool kalshi_demo) and \
live auditor (real money, :3002, tool kalshi_live): have each audit its own \
environment, then relay findings between them for ~{rounds} rounds of critique \
and reconciliation. Keep it strictly READ-ONLY. Finish by emitting the converged \
joint report as your final message in Markdown, starting with the header \
`# Nightly Cross-Environment Adherence Audit — {date}`.
"""


def main():
    args = parse_args()
    if not args.coordinator_id:
        sys.exit("Missing coordinator id: set AUDIT_COORDINATOR_ID or pass --coordinator-id "
                 "(create it with `python coordinator_agents.py --create`).")

    api_key = require_env("ANTHROPIC_API_KEY")
    environment_id = require_env("ENVIRONMENT_ID")
    auth_token = require_env("AUTH_TOKEN")
    servers = {"kalshi_demo": args.demo_url, "kalshi_live": args.live_url}

    date = datetime.now().strftime("%Y-%m-%d")
    client = Anthropic(api_key=api_key, default_headers={"anthropic-beta": BETA})

    session = client.beta.sessions.create(
        agent=args.coordinator_id, environment_id=environment_id,
        title=f"Cross-audit (coordinator) {date}",
    )
    sid = session.id
    print(f"Session: {sid}  (coordinator {args.coordinator_id})")

    client.beta.sessions.events.send(
        session_id=sid,
        events=[{"type": "user.message",
                 "content": [{"type": "text", "text": KICKOFF.format(date=date, rounds=args.rounds)}]}],
    )
    print("Kickoff sent. Coordinating…\n")

    # ── Drive loop ───────────────────────────────────────────────────────────
    # A custom-tool call puts the session in 'idle' while it awaits the result,
    # so 'idle' alone is NOT completion. Treat it as done only after the session
    # is idle AND no new events have arrived for `quiet_polls` consecutive ticks
    # (every tool result we send revives the coordinator, resetting the count).
    cursor = now_iso()
    deadline = time.time() + args.timeout
    coordinator_msgs: list[str] = []
    transcript: list[str] = [f"# Cross-audit (coordinator) transcript — {date}\n"]
    idle_quiet = 0

    # Listen for: leaf tool calls, coordinator messages, and inter-agent thread chatter.
    types = ["agent.custom_tool_use", "agent.message",
             "agent.thread_message_sent", "agent.thread_message_received"]

    while time.time() < deadline:
        new_events = 0
        for ev in client.beta.sessions.events.list(
            sid, types=types, order="asc", created_at_gt=cursor
        ):
            new_events += 1
            cursor = ev.processed_at.isoformat()

            if ev.type == "agent.custom_tool_use":
                stamp = time.strftime("%H:%M:%S")
                print(f"[{stamp}] tool: {ev.name}({json.dumps(ev.input)})")
                result = execute_tool(ev.name, ev.input, servers, auth_token)
                print(f"          -> {json.dumps(result)[:160]}")
                transcript.append(f"\n- tool `{ev.name}` {json.dumps(ev.input)} -> "
                                  f"{json.dumps(result)[:200]}")
                client.beta.sessions.events.send(
                    session_id=sid,
                    events=[{
                        "type": "user.custom_tool_result",
                        "custom_tool_use_id": ev.id,
                        "content": [{"type": "text", "text": json.dumps(result)}],
                        "is_error": "error" in result,
                        **({"session_thread_id": ev.session_thread_id}
                           if getattr(ev, "session_thread_id", None) else {}),
                    }],
                )
            elif ev.type == "agent.message":
                text = "".join(getattr(b, "text", "") for b in ev.content)
                if text.strip():
                    coordinator_msgs.append(text)
                    transcript.append(f"\n## coordinator\n\n{text}\n")
            else:  # thread_message_sent / thread_message_received
                content = getattr(ev, "content", None)
                text = ""
                if isinstance(content, list):
                    text = "".join(getattr(b, "text", "") for b in content)
                elif isinstance(content, str):
                    text = content
                if text.strip():
                    transcript.append(f"\n### {ev.type}\n\n{text}\n")

        status = client.beta.sessions.retrieve(sid).status
        if status == "terminated":
            print("Session terminated.")
            break
        if status == "idle" and new_events == 0:
            idle_quiet += 1
            if idle_quiet >= args.quiet_polls:
                break
        else:
            idle_quiet = 0
        time.sleep(args.poll)
    else:
        print(f"⚠️  Hit overall timeout ({args.timeout:.0f}s).")

    # ── Capture the joint report ─────────────────────────────────────────────
    # The coordinator emits the full report as one large message, but may ALSO
    # emit short wrap-up messages that merely restate the title header. So pick
    # the LONGEST coordinator message that contains the header (not the last),
    # then slice from the header. Fall back to the longest message overall.
    HEADER = "# Nightly Cross-Environment"
    joint = "\n\n".join(coordinator_msgs).strip()
    with_header = [m for m in coordinator_msgs
                   if any(ln.lstrip().startswith(HEADER) for ln in m.splitlines())]
    if with_header:
        best = max(with_header, key=len)
        bl = best.splitlines()
        start = next(i for i, ln in enumerate(bl) if ln.lstrip().startswith(HEADER))
        report = "\n".join(bl[start:]).strip()
    elif coordinator_msgs:
        report = max(coordinator_msgs, key=len).strip()
    else:
        report = ""

    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else OUTPUTS_DIR / f"cross_audit_{date}.md"
    transcript_path = OUTPUTS_DIR / f"cross_audit_{date}.transcript.md"
    out_path.write_text(report + "\n")
    transcript_path.write_text("\n".join(transcript))
    print(f"\n↓ joint report : {out_path}")
    print(f"↓ transcript   : {transcript_path}")

    ok = bool(report.strip())
    print(f"\nDone. Joint report {'captured' if ok else 'EMPTY — check timeouts/coordinator output'}.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
