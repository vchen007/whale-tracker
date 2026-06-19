# Kalshi Auto-Trader — Adherence Review Rubric

This is the **audit** outcome. It grades a `performance_review.md` report the
agent produces from *realized* trading history (the `auto_orders` table /
`GET /auto-trader/pnl`), not from a fresh trade plan. Its job is to catch the bot
drifting back into the money-losing behaviors the paper warns about, so cash is
protected. Run it on a schedule (e.g. weekly) or after each live trading session.

The report **fails** if it omits any of the required sections, or if a detected
violation is present but not flagged.

## 1. Coverage
- The report states the review window (date range) and the number of orders
  examined, and reconciles that count against the `auto_orders` table for the
  window. No silent dropping of orders.

## 2. Maker vs taker realized check (hard gate)
- For every entry order, the report classifies it as maker or taker using fill
  data (entry price vs the prevailing ask at placement, or Kalshi's
  maker/taker flag if available).
- **Any taker entry fill is flagged** with ticker, price, and the fee paid. The
  count and total taker-fee cost are reported. (Target: 0 taker entries.)

## 3. Price-floor adherence (hard gate)
- Every entry's price is checked against the `>= 70¢` floor. Any sub-floor entry
  is listed with its price. Count of sub-floor entries reported (target: 0).

## 4. EV-positivity at entry
- For each entry the report recomputes `est_net_ev = est_q − P − fee` using the
  correct order-type fee and an `est_q` source, and flags any entry that was
  placed with non-positive expected value.

## 5. Risk-cap adherence (hard gate)
- The report checks, over the window: max concurrent open positions vs
  `MAX_OPEN_POSITIONS`; peak deployed capital vs `AUTO_TRADER_MAX_CAPITAL`; any
  day's realized loss vs `MAX_DAILY_LOSS`; per-event dedupe (no opposing-outcome
  pairs). Each breach is listed; if the daily-loss kill-switch should have fired,
  that is called out.

## 6. Stop-loss accounting
- For any position closed early by the stop-loss, the report shows the realized
  taker exit cost (spread + fee) and compares actual P&L vs the counterfactual
  hold-to-settlement P&L (from the market's final result). It states whether the
  stop-loss helped or hurt over the window — measured, not assumed.

## 7. Bottom line
- A realized P&L summary (gross, fees, net), realized win rate vs average entry
  price (to check for live favorite–longshot bias), and a short prioritized list
  of the highest-cost violations to fix. No vague conclusions — every claim cites
  a number from the data.
