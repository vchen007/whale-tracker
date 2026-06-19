# Kalshi Auto-Trader Strategy — from the Makers/Takers paper to your code

Source: Bürgi, Deng & Whelan (2026), *"Makers and Takers: The Economics of the
Kalshi Prediction Market"* (UCD, Jan 2026). 300k+ contract-prices, 2021–Apr 2025,
markets open ≥ 24h.

This memo (1) states the edge the paper documents, (2) maps it to your
`server/src/autoTrader.js`, and (3) specifies what to change.

> **Status: these changes are now IMPLEMENTED** in `autoTrader.js`, `db.js`,
> `index.js`, and `.env.example` (see the "Changes applied" section). Review the
> diff and test on the Kalshi **demo** API before enabling live. New behavior is
> gated by `AUTO_TRADER_MAKER_MODE` (default `true`) and the bankroll-rail env
> vars; set `AUTO_TRADER_MAKER_MODE=false` to revert to the old taker behavior.

---

## TL;DR — the one thing that matters most

Your bot currently trades as a **taker** (it buys at the whale's executed price,
which crosses the book and fills immediately). The paper's central finding is:

> **Makers average −9.64%; Takers average −31.46%.** Makers buying contracts
> **≥ 50¢ average +2.6%** post-fee.

So the single highest-value change is: **stop taking, start making** — post
resting limit orders *inside* the spread and let them be matched. Everything else
below is secondary to that switch.

---

## The edge, with numbers

1. **Maker ≫ Taker.** −9.64% vs −31.46% average post-fee returns (difference
   significant at extremely high confidence). Makers get a better price *and*, in
   the sample period, paid no fee.
2. **Favorite–longshot bias.** Cheap contracts win *less* than their price; dear
   contracts win *more*. Contracts **≤ 10¢ lose > 60%** of stake. Contracts
   **> 50¢** earn small positive returns; **> 70¢** is where Maker returns are
   *statistically significant* positive. The average return on a randomly chosen
   contract is ≈ **−20%** (pre-fee; the zero-sum pre-fee pool plus the asymmetric
   bias produces this).
3. **Maker favorite sweet spot: +2.6%** on ≥ 50¢ contracts — **measured under the
   pre-2025 regime when makers paid no fee.** Kalshi began charging makers after
   April 2025, so **+2.6% is an upper bound; the real net edge today is smaller**
   and must be recomputed with the current maker fee.
4. **Variance dwarfs the mean.** SD of returns on the ≥ 50¢ Maker cohort is
   **33%** vs a 2.6% mean. The edge is only realizable across **many small,
   independent** positions (Law of Large Numbers). The paper names this — plus
   Samuelson/Pratt-Zeckhauser "proper risk aversion" and thin liquidity — as why
   the anomaly hasn't been arbitraged away.
5. **Accuracy rises toward close.** Mean absolute error of prices falls each day
   toward settlement, with a steep drop on the final day. Favor markets close to
   resolution; the paper excludes hourly/crypto-reset and sub-24h markets as
   noisy.
6. **Yogi Berra effect.** Near close, the losing/cheap side stays *overpriced*
   (longshots don't fall enough). Never open new cheap-side positions late.
7. **Fill is not guaranteed.** Maker match rate is calibrated at **θ ≈ 0.6**.
   Unfilled maker orders must be re-quoted or canceled — never converted to a
   taker by crossing.
8. **The bias is fading.** The 2025 price coefficient is smaller and less
   significant than prior years, and the authors expect publication to erode it
   further. Treat the edge as decaying.

---

## Your bot today vs the paper

| Area | Current behavior (`autoTrader.js`) | Paper says | Verdict |
|---|---|---|---|
| Execution | Limit buy at the whale's **traded price** → crosses → **taker** (`_placeOrder`, L205-224) | Makers beat takers by ~22 pts | ❌ biggest leak |
| Fee model | Taker fee `0.07·P·(1−P)` (+15% sports) only (`kalshiFeeDollars`, L12-18) | Maker fee now exists; EV math needs it | ⚠️ wrong for maker orders |
| Price band | 65–84¢ (`.env.example`) | Favorites zone; > 70¢ significant | ✅ good; nudge floor to 70¢ |
| Stop-loss | Sells at `bid−1¢` → **taker exit, locks loss** (`checkStopLosses`/`_closePosition`, L348-401) | Edge is hold-to-settlement; exits cost spread+fee | ⚠️ measure, don't assume |
| Bankroll rails | none (no capital cap / max-open / daily-loss kill) | high variance ⇒ need many small bets + caps | ❌ required for autonomy |
| Blocked markets | NBA spreads / IPL / tennis / UFC / combos blocked | these are no-favorite/coin-flip | ✅ keep |
| Dedupe | per-event, blocks opposing outcomes (L187-198) | independence matters | ✅ keep |

---

## Changes applied to `autoTrader.js` (and `db.js`, `index.js`, `.env.example`)

### 1. Maker placement (the big one) — `_placeOrder()`, L205-224
The order body currently sets the limit to the incoming `price`. Change it so the
limit **rests inside the book** and never crosses:

- Fetch the current book for the ticker (you already hit
  `GET /markets/{ticker}` in `checkSettlements`/`checkStopLosses`; reuse it).
- For a YES buy, set `yes_price = min(whalePrice − 1, best_bid_yes)`; for NO,
  `no_price = min(whalePrice − 1, best_bid_no)`. Reject if that price would be
  `≥ best_ask` (would cross) or would drop below the `minPriceCents` floor.
- Add an **unfilled-order policy**: a periodic task (like the existing 3-min
  stop-loss tick) that cancels or re-quotes *lower* any resting auto order older
  than N minutes. Never re-quote *up to cross*.
- Optionally gate on whether the whale signal is still fresh before re-quoting.

Why: moves every entry from the −31% taker cohort to the −9.6% maker cohort.

### 2. Maker fee model — `kalshiFeeDollars()` / `maxNetProfitDollars()`, L12-31
`kalshiFeeDollars` models only the taker fee. Add a `role: 'maker' | 'taker'`
parameter and the **current maker fee** from https://kalshi.com/fee-schedule, and
have `maxNetProfitDollars` (and the `minNetProfit` gate in `onTrade`, L171-182)
use the maker fee for entries. Keep the taker fee for the stop-loss **exit** in
`_closePosition`. Getting this right is what keeps the EV gate honest now that
makers pay fees.

### 3. Price floor → 70¢ — `.env`
`AUTO_TRADER_MIN_PRICE_CENTS=70` (currently 65). 70¢ is where the paper's Maker
returns are statistically significant. Keep `MAX=84` (caps capital-at-risk per
cent of edge and avoids the thin 90¢+ book).

### 4. Stop-loss — measure, don't assume — `checkStopLosses()`/`_closePosition()`, L348-401
The +2.6% Maker figure is a **hold-to-settlement** average. Your stop-loss sells
at `bid−1¢` (a taker exit) after a 70% drop, which both pays the spread and
forfeits any favorite mean-reversion. It *might* still help on genuinely falling
favorites (consistent with the Yogi Berra effect), so:
- Add a flag to run with stop-loss **off** and compare realized P&L on the
  `auto_orders` table over a meaningful sample.
- Log the realized exit cost (spread + fee) so the adherence review can compare
  actual vs hold-to-settlement P&L. Decide from the data.

### 5. Bankroll rails (new) — enforce in `onTrade()` before `_placeOrder()`
These are the hard rails the autonomous outcome depends on (the rubric is only a
*post-hoc* check):
- `AUTO_TRADER_MAX_CAPITAL` — refuse new orders once summed open notional hits it.
- `AUTO_TRADER_MAX_OPEN_POSITIONS` — cap concurrent positions (forces diversification).
- `AUTO_TRADER_MAX_DAILY_LOSS` — kill-switch: on breach, call `this.disable()`
  and notify.
- Keep `count` small and `dedupeByEvent` on so positions stay independent — that
  is what lets the 33%-SD edge average out.

---

## How this connects to the defined outcomes

- `trade_plan_rubric.md` grades a live trading session's order log against exactly
  these rules (maker-only, ≥70¢, EV>0 with the *maker* fee, caps, blocked
  buckets, timing). It is the agent-driven path; the rails in §5 are the code-
  level enforcement behind it.
- `adherence_review_rubric.md` audits *realized* `auto_orders` history for the
  same rules, so drift back into taker/longshot behavior is caught and corrected.
- `define_outcome.py` launches either outcome (demo by default).

---

## Honest reality check

This is your own authorized account on a CFTC-regulated venue, so automating it is
legitimate. But be clear-eyed:

- The documented edge is **small, high-variance, and decaying** — and **maker fees
  now eat into the +2.6%** that was measured fee-free. A realistic goal is moving
  EV from *deeply negative* (taker + longshot) toward *roughly break-even to
  slightly positive* (maker + favorite + discipline). It is **not** a money
  printer, and no parameter set guarantees profit.
- Thin Kalshi liquidity means large maker orders get worse prices and may not
  fill; the edge lives at **small size**.
- Run on `demo-api.kalshi.co` first, then go live with a small
  `AUTO_TRADER_MAX_CAPITAL` you can afford to lose, and only ratchet up after a
  clean adherence review.
