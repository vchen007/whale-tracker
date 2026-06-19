#!/usr/bin/env python3
"""
Register the kalshi_trader custom tool on the Managed Agent.
Run once (or after changing the tool schema).

Usage:
    python3 outcomes/register_tool.py
"""

import os
import sys

try:
    from anthropic import Anthropic
except ImportError:
    sys.exit("Run: pip install anthropic")

BETA = "managed-agents-2026-04-01"

def require_env(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"Missing env var: {name}")
    return v

def main():
    api_key  = require_env("ANTHROPIC_API_KEY")
    agent_id = require_env("AGENT_ID")

    client = Anthropic(api_key=api_key, default_headers={"anthropic-beta": BETA})
    agent  = client.beta.agents.retrieve(agent_id)

    kalshi_tool = {
        "type": "custom",
        "name": "kalshi_trader",
        "description": (
            "Place, cancel, and query orders on the Kalshi DEMO exchange via the "
            "whale-tracker server. Actions: place_order, cancel_order, get_pnl, get_status."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["place_order", "cancel_order", "get_pnl", "get_status"],
                },
                "ticker":          {"type": "string",  "description": "Kalshi market ticker. Required for place_order/cancel_order."},
                "side":            {"type": "string",  "enum": ["yes", "no"], "description": "Required for place_order."},
                "limit_price":     {"type": "integer", "description": "Limit price in cents (1-99). Required for place_order."},
                "count":           {"type": "integer", "description": "Number of contracts (default 1). Optional for place_order."},
                "client_order_id": {"type": "string",  "description": "Required for cancel_order."},
            },
            "required": ["action"],
        },
    }

    # Preserve existing tools (agent_toolset) and add/replace kalshi_trader
    existing = [t for t in (agent.tools or []) if getattr(t, "name", None) != "kalshi_trader"]
    existing_dicts = [t.model_dump() if hasattr(t, "model_dump") else dict(t) for t in existing]

    updated = client.beta.agents.update(
        agent_id,
        version=agent.version,
        tools=[*existing_dicts, kalshi_tool],
    )
    print(f"Agent {agent_id} updated to version {updated.version}")
    print(f"Tools: {[getattr(t, 'type', t.get('type')) for t in (updated.tools or [])]}")

if __name__ == "__main__":
    main()
