#!/usr/bin/env python3
"""
coordinator_agents.py — console agent config for the NATIVE multi-agent
cross-environment audit (the upgrade from the client-side relay in
nightly_cross_audit.py).

It defines THREE managed agents:

    kalshi-audit-coordinator   (multiagent coordinator)
        ├── kalshi-demo-auditor   (leaf; tool: kalshi_demo  -> :3001)
        └── kalshi-live-auditor   (leaf; tool: kalshi_live  -> :3002)

Why three: the API caps coordinator depth at 1 — a coordinator's roster may only
reference NON-coordinator agents. So the two auditors are plain leaf agents and
the coordinator orchestrates them.

Why two differently-named tools (kalshi_demo / kalshi_live) instead of one
shared kalshi_trader: custom tools are executed by the client. Distinct names let
the runner route a call to the correct server (demo :3001 vs live :3002) purely
by tool name — no need to inspect which session thread emitted it.

Both tools are READ-ONLY by schema (action ∈ {get_status, get_pnl}); the runner
must still hard-block anything else, exactly as nightly_cross_audit.py does.

This script does NOT create anything unless you pass --create. By default it just
prints the three definitions (the "config") so you can review or paste into the
console. With --create it provisions them via the API and prints their IDs.

    python coordinator_agents.py                 # print the config (no API calls)
    python coordinator_agents.py --create        # create the 3 agents, print IDs
    python coordinator_agents.py --create --model claude-haiku-4-5

After --create, set AUDIT_COORDINATOR_ID to the coordinator id; a follow-up
coordinator runner (coordinator_audit.py, not yet written) drives one session
against that single coordinator agent.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from anthropic import Anthropic
except ImportError:
    sys.exit("Missing dependency. Run:  pip install anthropic")

BETA = "managed-agents-2026-04-01"

# Read-only tool schema shared by both auditors (names differ for routing).
READONLY_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {
            "type": "string",
            "enum": ["get_status", "get_pnl"],
            "description": "Read-only query against the auto-trader.",
        }
    },
    "required": ["action"],
}

MAKER_MODE_SEMANTICS = """\
MAKER-MODE SEMANTICS — do NOT get this backwards. `makerMode: true` means the
trader POSTS resting maker orders (maker intended). `makerMode: false` means it
crosses the spread as a TAKER (taker intended). So makerMode:false does NOT
mandate maker-only — taker fills are CONSISTENT with that config. Keep three
things distinct:
  (1) CONFIG INTENT  = what makerMode is set to (maker vs taker intended);
  (2) REALIZED ROLE  = the per-order `role` field (maker / taker / null);
  (3) STRATEGY TARGET = the makers/takers paper prefers makers (~-9.6% vs takers
      ~-31.5%), so the rubric's "0 takers" target reflects STRATEGY, not the
      config flag.
Report accordingly: call it a maker-mode VIOLATION only when makerMode:true but
orders filled as taker. When makerMode:false, say the trader is CONFIGURED as a
taker — which DIVERGES from the maker-preference — NOT that it "violated its own
config." Treat role=null as INDETERMINATE (a data gap), not an automatic
violation."""

DEMO_SYSTEM = """\
You are the DEMO auditor of a Kalshi auto-trader (paper money, server :3001).
Use the `kalshi_demo` tool — READ-ONLY, actions get_status and get_pnl only —
to inspect the demo trader. Never request any other action.

Audit adherence across these gates, quoting the ACTUAL numbers:
  - Maker-vs-taker realized behavior (see MAKER-MODE SEMANTICS below)
  - Price floor >= 70c (HARD GATE)
  - EV-positivity at entry (recompute est_net_ev as given)
  - Risk caps: open positions, capital, per-ticker, daily loss, event-dedup (HARD GATE)
  - Stop-loss configuration
  - Bottom-line realized P&L

{maker_mode}

Units: entry_price and pnl_cents are CENTS; est_fee and est_net_ev are DOLLARS.
When the coordinator relays the live auditor's findings, engage critically:
compare environments, defend or revise your read WITH EVIDENCE, and call out
where demo genuinely differs from live and why.
""".format(maker_mode=MAKER_MODE_SEMANTICS)

LIVE_SYSTEM = """\
You are the LIVE auditor of a Kalshi auto-trader (REAL MONEY, server :3002).
Use the `kalshi_live` tool — READ-ONLY, actions get_status and get_pnl only —
to inspect the live trader. Never request any other action.

Audit the same gates as the demo auditor (maker-vs-taker, >=70c floor,
EV-positivity, risk caps incl. event-dedup, stop-loss, P&L), quoting real
numbers. Units: entry_price and pnl_cents are CENTS; est_fee and est_net_ev are
DOLLARS.

{maker_mode}

IMPORTANT context to avoid false alarms: many live orders are LEGACY — placed
before recent backfills/config changes — and show role=null and some sub-70c
entries. Distinguish legacy historical data from violations under the CURRENT
config; do not report legacy artifacts as fresh hard-gate failures without
saying so. When the coordinator relays demo's findings, compare and reconcile
with evidence.
""".format(maker_mode=MAKER_MODE_SEMANTICS)

COORDINATOR_SYSTEM = """\
You coordinate a nightly cross-environment adherence audit of a Kalshi
auto-trader. Your roster: a DEMO auditor (paper, :3001) and a LIVE auditor
(real money, :3002).

Run this flow:
  1. Have each auditor independently audit its own environment.
  2. Relay each auditor's findings to the OTHER for a few rounds of critique and
     comparison. Push them to reconcile disagreements with evidence — do not let
     a contested claim stand unexamined.
  3. Synthesize ONE converged joint report as your FINAL MESSAGE in Markdown
     (do not rely on writing a file). Use these sections:
       # Nightly Cross-Environment Adherence Audit — <date>
       ## 1. Executive summary
       ## 2. Demo (:3001) verdict
       ## 3. Live (:3002) verdict
       ## 4. Cross-environment divergence (what differs and why)
       ## 5. Disagreements reconciled during the debate
       ## 6. Prioritized action list (most important first, with cited numbers)

Distinguish legacy live data from current-config violations. Quote the numbers
both auditors established. Keep the audit strictly read-only.

Do NOT conflate config intent with the strategy target on maker-vs-taker:
`makerMode:false` means TAKER is the configured intent (a divergence from the
maker-preference), NOT a config violation; only `makerMode:true` with taker fills
is a true maker-mode violation. Treat role=null as a data gap, not a violation.
"""


def leaf_defs(model: str):
    return [
        {
            "name": "kalshi-demo-auditor",
            "description": "Read-only adherence auditor for the DEMO Kalshi auto-trader (:3001).",
            "model": {"id": model, "speed": "standard"},
            "system": DEMO_SYSTEM,
            "tools": [{
                "type": "custom",
                "name": "kalshi_demo",
                "description": "Read-only query of the DEMO auto-trader (:3001). action: get_status | get_pnl.",
                "input_schema": READONLY_SCHEMA,
            }],
        },
        {
            "name": "kalshi-live-auditor",
            "description": "Read-only adherence auditor for the LIVE Kalshi auto-trader (:3002).",
            "model": {"id": model, "speed": "standard"},
            "system": LIVE_SYSTEM,
            "tools": [{
                "type": "custom",
                "name": "kalshi_live",
                "description": "Read-only query of the LIVE auto-trader (:3002). action: get_status | get_pnl.",
                "input_schema": READONLY_SCHEMA,
            }],
        },
    ]


def coordinator_def(model: str, demo_id: str, live_id: str):
    return {
        "name": "kalshi-audit-coordinator",
        "description": "Coordinates the demo+live cross-environment adherence audit and writes the joint report.",
        "model": {"id": model, "speed": "standard"},
        "system": COORDINATOR_SYSTEM,
        "multiagent": {
            "type": "coordinator",
            "agents": [demo_id, live_id],   # roster: leaf auditors only (depth limit 1)
        },
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--create", action="store_true", help="create the agents via the API")
    p.add_argument("--update", action="store_true",
                   help="push the current system prompts to the existing agents and re-pin the roster")
    p.add_argument("--model", default="claude-haiku-4-5",
                   help="model id for all three agents (default claude-haiku-4-5)")
    p.add_argument("--coordinator-model", default=None,
                   help="override the coordinator's model (e.g. claude-sonnet-4-6 for better synthesis)")
    args = p.parse_args()

    coord_model = args.coordinator_model or args.model
    leaves = leaf_defs(args.model)

    if not args.create and not args.update:
        print("# ── Leaf auditors ──")
        print(json.dumps(leaves, indent=2))
        print("\n# ── Coordinator (fill in <demo_id>/<live_id> after creating leaves) ──")
        print(json.dumps(coordinator_def(coord_model, "<demo_id>", "<live_id>"), indent=2))
        print("\n(no API calls made — re-run with --create to provision or --update to push prompts)")
        return

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Missing ANTHROPIC_API_KEY")
    client = Anthropic(api_key=api_key, default_headers={"anthropic-beta": BETA})

    if args.update:
        names = {"kalshi-demo-auditor", "kalshi-live-auditor", "kalshi-audit-coordinator"}
        by_name = {a.name: a for a in client.beta.agents.list() if a.name in names}
        missing = names - set(by_name)
        if missing:
            sys.exit(f"Missing agents {sorted(missing)} — create them first with --create.")
        demo, live, coord = (by_name["kalshi-demo-auditor"], by_name["kalshi-live-auditor"],
                             by_name["kalshi-audit-coordinator"])
        demo2 = client.beta.agents.update(demo.id, version=demo.version, system=DEMO_SYSTEM)
        print(f"updated kalshi-demo-auditor  -> v{demo2.version}")
        live2 = client.beta.agents.update(live.id, version=live.version, system=LIVE_SYSTEM)
        print(f"updated kalshi-live-auditor  -> v{live2.version}")
        # Re-pin the roster to the freshly-updated leaf versions, else the
        # coordinator keeps spawning the OLD pinned versions.
        coord2 = client.beta.agents.update(
            coord.id, version=coord.version, system=COORDINATOR_SYSTEM,
            multiagent={"type": "coordinator", "agents": [
                {"type": "agent", "id": demo2.id, "version": demo2.version},
                {"type": "agent", "id": live2.id, "version": live2.version},
            ]},
        )
        print(f"updated kalshi-audit-coordinator -> v{coord2.version} "
              f"(roster re-pinned: demo v{demo2.version}, live v{live2.version})")
        return

    ids = {}
    for d in leaves:
        agent = client.beta.agents.create(**d)
        ids[d["name"]] = agent.id
        print(f"created {d['name']}: {agent.id}")

    coord = coordinator_def(coord_model, ids["kalshi-demo-auditor"], ids["kalshi-live-auditor"])
    c = client.beta.agents.create(**coord)
    print(f"created kalshi-audit-coordinator: {c.id}")
    print(f"\nexport AUDIT_COORDINATOR_ID={c.id}")


if __name__ == "__main__":
    main()
