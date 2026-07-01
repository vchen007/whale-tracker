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
    from anthropic import Anthropic, APIConnectionError, APITimeoutError
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


def extract_cost(session) -> tuple[float | None, dict | None]:
    """Best-effort cost/usage extraction from a retrieved Sessions object.

    The Sessions beta doesn't document a stable field name for this, so probe
    the plausible spots defensively instead of assuming one and crashing when
    it's absent. `session.usage`, if present, is the SESSION-level total —
    i.e. the coordinator's own turns plus both spawned leaf-auditor threads,
    since they all run inside this one session.
    """
    cost = getattr(session, "total_cost_usd", None)
    usage = getattr(session, "usage", None)
    if cost is None and usage is not None:
        cost = getattr(usage, "total_cost_usd", None) or getattr(usage, "cost_usd", None)
    usage_dict = None
    if usage is not None:
        usage_dict = {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None),
        }
    return cost, usage_dict


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
    # max_retries: the drive loop polls events.list every few seconds for up to
    # `timeout` seconds (hundreds of calls). A single transient getaddrinfo/DNS
    # blip on any one used to crash the whole audit (2026-07-01). The SDK retries
    # connection errors with exponential backoff on every request.
    client = Anthropic(api_key=api_key, max_retries=8,
                       default_headers={"anthropic-beta": BETA})

    coordinator_agent = client.beta.agents.retrieve(args.coordinator_id)
    model_id = getattr(getattr(coordinator_agent, "model", None), "id", None) or "unknown"

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

    consecutive_conn_errors = 0
    while time.time() < deadline:
        new_events = 0
        # Materialize the page inside a guard so one transient DNS/connection
        # blip (after the client's own retries are exhausted) skips this poll
        # instead of crashing the whole run. Cursor is unchanged on failure, so
        # the next tick simply re-fetches from the same point.
        try:
            page = list(client.beta.sessions.events.list(
                sid, types=types, order="asc", created_at_gt=cursor
            ))
        except (APIConnectionError, APITimeoutError) as e:
            consecutive_conn_errors += 1
            print(f"⚠️  transient API error (#{consecutive_conn_errors}, "
                  f"{type(e).__name__}) on events.list — retry in {args.poll:.0f}s")
            if consecutive_conn_errors >= 20:
                print("⚠️  too many consecutive connection errors — aborting drive loop.")
                break
            time.sleep(args.poll)
            continue

        for ev in page:
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

        try:
            status = client.beta.sessions.retrieve(sid).status
        except (APIConnectionError, APITimeoutError) as e:
            consecutive_conn_errors += 1
            print(f"⚠️  transient API error (#{consecutive_conn_errors}, "
                  f"{type(e).__name__}) on session.retrieve — retry in {args.poll:.0f}s")
            if consecutive_conn_errors >= 20:
                print("⚠️  too many consecutive connection errors — aborting drive loop.")
                break
            time.sleep(args.poll)
            continue
        consecutive_conn_errors = 0

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

    # ── Cost/usage ────────────────────────────────────────────────────────────
    # One extra retrieve, after the session is done, so this reads the final
    # session-level total rather than a mid-run snapshot.
    cost, usage = extract_cost(client.beta.sessions.retrieve(sid))
    if cost is not None:
        print(f"\n[coordinator-audit] cost: ${cost:.4f}  model={model_id}  session={sid}")
    else:
        print(f"\n[coordinator-audit] cost: unavailable from Sessions API  "
              f"model={model_id}  session={sid}"
              + (f"  usage={json.dumps(usage)}" if usage else ""))

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

    cost_note = f"cost ${cost:.4f}" if cost is not None else "cost unavailable"
    header = (f"<!-- Auto-generated by coordinator_audit.py on {now_iso()} "
              f"(model {model_id}, {cost_note}, session {sid}). "
              f"Read-only audit — no config was changed. -->\n\n")

    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else OUTPUTS_DIR / f"cross_audit_{date}.md"
    transcript_path = OUTPUTS_DIR / f"cross_audit_{date}.transcript.md"
    out_path.write_text((header + report if report.strip() else report) + "\n")
    transcript.append(f"\n---\n\n{cost_note}, model {model_id}, session {sid}\n")
    transcript_path.write_text("\n".join(transcript))
    print(f"\n↓ joint report : {out_path}")
    print(f"↓ transcript   : {transcript_path}")

    ok = bool(report.strip())
    print(f"\nDone. Joint report {'captured' if ok else 'EMPTY — check timeouts/coordinator output'}. {cost_note}.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
