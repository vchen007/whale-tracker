# Defined Outcomes for the Kalshi Auto-Trader

This folder turns the edge documented in *Makers and Takers: The Economics of the
Kalshi Prediction Market* (Bürgi, Deng & Whelan, 2026) into a **Managed Agents
"defined outcome"**: an agent places trades, a grader scores the result against a
rubric, and the agent iterates until it meets the bar.

| File | What it is |
|---|---|
| `STRATEGY.md` | The paper → rules → code memo. Read this first. |
| `trade_plan_rubric.md` | Rubric for the **trading** outcome (grades the order log). |
| `adherence_review_rubric.md` | Rubric for the **audit** outcome (grades realized history). |
| `define_outcome.py` | Runner: creates the session, defines the outcome, polls, downloads outputs. |
| `outputs/` | Where deliverables are downloaded. |

## How "define outcomes" works (in one paragraph)

You send a `user.define_outcome` event with a `description` (the task + hard
constraints) and a markdown `rubric` (the gradeable criteria). A **grader** in a
separate context scores the artifact the agent produced and returns
`satisfied | needs_revision | max_iterations_reached | failed` with an
explanation; the agent revises until satisfied or out of iterations. Files land in
`/mnt/session/outputs/` and are pulled via the Files API scoped to the session.
Docs: https://platform.claude.com/docs/en/managed-agents/define-outcomes

## ⚠️ The most important design point

The grader runs **after** the agent acts. With autonomous live placement, a bad
fill **cannot be revised away**. So the real safety lives in **hard code-level
rails inside the Kalshi order tool** in your agent's environment — maker-only,
≥70¢ floor, EV>0 with the maker fee, capital cap, max-open, daily-loss
kill-switch. The rubric is the *second* line that catches drift. Do not rely on
the rubric alone to protect your cash. See `STRATEGY.md` §5.

## Prerequisites (one-time, outside this script)

1. **`pip install anthropic`** and export `ANTHROPIC_API_KEY`.
2. **Create a Managed Agent** → export its id as `AGENT_ID`.
3. **Create an environment** whose toolset includes:
   - a **Kalshi order-placement tool** wired to your Kalshi API credentials, that
     itself enforces the hard rails above and accepts a base-URL (demo vs live);
   - read access to your `auto_orders` data / `GET /auto-trader/pnl` for the
     adherence outcome.
   Export its id as `ENVIRONMENT_ID`.

   > This runner does **not** talk to Kalshi directly and cannot place or stop an
   > order. The agent's environment tool does. Build the rails there.

## Run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export AGENT_ID=agt_...
export ENVIRONMENT_ID=env_...

# Trading outcome — DEMO by default (paper money):
python define_outcome.py --rubric trade_plan

# Tune the rails:
python define_outcome.py --rubric trade_plan \
    --max-capital 200 --max-position-pct 10 --max-open 20 \
    --min-positions 10 --min-price 70 --max-iterations 4

# Go live (real money) — requires typing a confirmation:
python define_outcome.py --rubric trade_plan --live --max-capital 100

# Weekly audit of realized behavior:
python define_outcome.py --rubric adherence
```

`--upload-rubric` uploads the rubric via the Files API (reusable across sessions)
instead of inlining it.

## Reading the result

- The runner prints each grader verdict and explanation as the agent iterates.
- On completion it downloads `orders_placed.json` + `ev_report.md` (trading) or
  `performance_review.md` (audit) into `outputs/`.
- Exit code is `0` only if the outcome was `satisfied`, so you can gate a cron job
  on it.

## Recommended rollout

1. `--rubric trade_plan` on **demo** until the grader returns `satisfied` and the
   `orders_placed.json` looks right (all maker, ≥70¢, EV>0, within caps).
2. `--rubric adherence` on the demo log; confirm it flags an injected violation.
3. `--live` with a **small** `--max-capital` you can afford to lose.
4. Re-run `--rubric adherence` after the first live session; only ratchet capital
   up after a clean review.
