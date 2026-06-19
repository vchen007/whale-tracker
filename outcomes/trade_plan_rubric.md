# Kalshi Trade Plan — EV Discipline Rubric

This rubric grades the artifacts the agent produces **after** placing orders in a
trading session: `orders_placed.json` (machine-readable order log) and
`ev_report.md` (human-readable justification). Each criterion is scored
independently. The grade reflects whether the orders the agent actually placed
obeyed the maker/favorite EV discipline derived from Bürgi, Deng & Whelan (2026),
*"Makers and Takers: The Economics of the Kalshi Prediction Market."*

A session **passes only if every placed order satisfies the hard gates** below.
A single taker fill, sub-floor entry, or negative-EV order fails the rubric.

> Note for the agent: you cannot improve a placed order retroactively. Treat a
> `needs_revision` result as instruction to (a) cancel/re-quote any still-resting
> orders that violate a gate and (b) place no further violating orders. Do **not**
> add new orders solely to improve the grade.

## 1. Maker-only execution (hard gate)
- Every order in `orders_placed.json` is a **resting limit order that adds
  liquidity**: for a YES buy, `limit_price <= best_bid_yes`; for a NO buy,
  `limit_price <= best_bid_no`. The limit must **not** be ≥ the best ask on that
  side (which would cross and execute as a taker).
- `ev_report.md` records `best_bid` and `best_ask` for each order at placement
  time and explicitly asserts `maker_ok = true` (no cross / no lock).
- Count of marketable (crossing) orders is **0**.
- An unfilled-order policy is stated: resting orders that do not fill within the
  session window are **canceled or re-quoted lower** — never converted to a taker
  by raising the price to cross. (Rationale: Makers −9.64% vs Takers −31.46%.)

## 2. Favorites-only pricing (hard gate)
- Every order has `limit_price >= 70` (cents). This is the zone where the paper
  finds statistically significant positive Maker returns.
- **Zero** orders priced `< 50¢`. **Zero** orders `<= 20¢`. (Contracts ≤10¢ lose
  >60% of stake; cheap contracts are the favorite–longshot trap.)
- `price_band_ok = true` is recorded per order with the price shown.

## 3. Positive post-fee expected value (hard gate)
- For each order, `ev_report.md` shows the calculation
  `est_net_ev = est_q − P − est_fee` (dollars per contract), where:
  - `P` = `limit_price / 100`.
  - `est_q` = an **independently justified** estimate of the win probability —
    from a historical calibration bucket, a model, or the source signal — **not**
    simply `est_q = P`. The justification (source + value) is written out.
  - `est_fee` = per-contract fee from the **current** Kalshi fee schedule
    (https://kalshi.com/fee-schedule) for the order type **actually used**
    (include the maker fee now charged post-April-2025, and the sports +15%
    premium where the ticker is a sports market). Taker fee `0.07·P·(1−P)` is
    **not** the right number for a maker order.
- `est_net_ev > 0` for **every** placed order.
- Because of the documented favorite–longshot bias, a credible `est_q` for a
  favorite should typically be **≥ the market price**; if `est_q < P` the order
  must not be placed.

## 4. Blocked markets (hard gate)
- No order on a no-favorite / coin-flip or combo market. Reject tickers starting
  with: `KXNBASPREAD`, `KXIPL`, `KXATPMATCH`, `KXWTAMATCH`, `KXITFMATCH`,
  `KXUFCFIGHT`, `KXMVECROSSCATEGORY`, `KXMVESPORTS`.
- No hourly / crypto-reset markets and no markets with `< 24h` total lifetime
  (excluded as noisy in the paper).

## 5. Timing discipline
- Entries are within the well-calibrated window — markets within a few days of
  close are preferred; do not enter on stale quotes more than ~10 days out.
- **No new cheap-side entries near close** (Yogi Berra guard): the report
  confirms no order opened a low-price position in the final minutes of a market.

## 6. Risk, sizing & diversification
- **Per-event dedupe:** no two orders hold opposing outcomes of the same event
  (event = ticker minus its last dash-segment).
- **Per-position cap:** each order's notional `(limit_price/100 · count)` is
  `<= MAX_POSITION_FRACTION` of the configured bankroll (stated in the report).
- **Total cap:** sum of placed notionals `<= AUTO_TRADER_MAX_CAPITAL`.
- **Diversification:** the plan targets `>= MIN_INDEPENDENT_POSITIONS` independent
  events so the high return variance (SD ≈ 33% on the ≥50¢ Maker cohort) averages
  out; the report states how many independent events were entered.
- Reserve cash is maintained (deployed capital `<` total bankroll).

## 7. Auditable output (hard gate)
- `orders_placed.json` is valid JSON: an array of objects, each with **all** of:
  `ticker, side, limit_price, count, best_bid, best_ask, maker_ok,
  price_band_ok, est_q, est_fee, est_net_ev, signal_source, kalshi_order_id,
  status`.
- `ev_report.md` contains:
  - A summary line: total capital deployed, number of independent events,
    aggregate expected EV (sum of `est_net_ev · count`).
  - A **rejects table**: every candidate considered but not placed, with the
    specific gate it failed and the failing number (e.g. "price 12¢ < 70¢ floor",
    "est_net_ev = −$0.004").
  - The fee-schedule version/date used and the bankroll figure used for sizing.
