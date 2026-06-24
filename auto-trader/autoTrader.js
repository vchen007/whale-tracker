import { sign, constants } from 'crypto';
// NOTE — this file lives in /auto-trader/ (project root). Its tight
// dependencies (DB helpers, notifier, Kalshi env/client) stay in /server/src/
// because they are shared with the Fastify server. Imports therefore reach
// across the folder boundary; nothing imports back from server → auto-trader
// except `server/src/index.js`, which constructs the AutoTrader instance.
import { notifyTrade } from '../server/src/notify.js';
import { KALSHI_TRADING_BASE, IS_DEMO } from '../server/src/kalshiEnv.js';
import { categoryFromTicker } from '../server/src/kalshiClient.js';
import {
  insertAutoOrder,
  getOpenAutoOrders,
  getRestingAutoOrders,
  getCommittedAutoOrders,
  markAutoOrderFilled,
  cancelAutoOrderRecord,
  settleAutoOrder,
  closeAutoOrderEarly,
} from '../server/src/db.js';

// Order placement, portfolio, and our own positions' market/book reads all use
// the trading base (overridable to demo via KALSHI_API_BASE / KALSHI_TRADING_API_BASE).
const REST_BASE  = KALSHI_TRADING_BASE;
// Signing path is host-independent — same /trade-api/v2 path on demo and prod.
const ORDER_PATH = '/trade-api/v2/portfolio/orders';               // list/cancel (still live)
const CREATE_ORDER_PATH = '/trade-api/v2/portfolio/events/orders'; // create (the v1 path 410s now)
// Account tag for log lines (mirrors the email tagging).
const ENV_TAG = IS_DEMO ? 'DEMO' : 'LIVE';

// ── Kalshi fee schedule ──────────────────────────────────────────────────────
// Trading fee per contract = coeff × P × (1−P) dollars (P in dollars 0–1),
// rounded UP to the nearest cent across the whole order.
//   - Takers: coeff = 0.07 (Kalshi standard).
//   - Makers: Kalshi began charging makers after April 2025. The maker rate is
//     not published as a single number (it varies by market), so it is
//     configurable via `makerFeeCoeff`. Default is the conservative worst case
//     of 0.07 (== taker) so the EV gate never *under*-charges a maker order;
//     lower it to your verified rate from https://kalshi.com/fee-schedule.
//   - Sports premium (NBA/NHL/NFL since Jul 2025): +15% on top of the above.
// Source: https://kalshi.com/fee-schedule
function kalshiFeeDollars(priceCents, count, {
  isSports = false,
  role = 'taker',
  makerFeeCoeff = 0.07,
  takerFeeCoeff = 0.07,
} = {}) {
  const P = priceCents / 100;
  const coeff = role === 'maker' ? makerFeeCoeff : takerFeeCoeff;
  const baseFee = coeff * P * (1 - P);
  const feePerContract = isSports ? baseFee * 1.15 : baseFee;
  // Round UP to nearest cent (worst-case for the trader, conservative for our filter)
  return Math.ceil(feePerContract * count * 100) / 100;
}

/**
 * Profitability check: returns the max-win net profit in dollars for buying
 * `count` contracts at `priceCents` and holding to settlement.
 *   gross_profit_if_win = (100 − P) / 100 × count
 *   fee = kalshiFeeDollars(priceCents, count, feeOpts)
 *   net_profit_if_win = gross_profit_if_win − fee
 */
function maxNetProfitDollars(priceCents, count, feeOpts = {}) {
  const grossProfit = ((100 - priceCents) / 100) * count;
  const fee = kalshiFeeDollars(priceCents, count, feeOpts);
  return grossProfit - fee;
}

// ── Favorite–longshot calibration (Bürgi, Deng & Whelan 2026) ────────────────
// The paper's Mincer-Zarnowitz regression on 156,986 contracts found pre-fee
// profit (cents) ≈ α + ψ·P with α = −1.736, ψ = 0.034 (full sample, Table 4).
// I.e. favorites win MORE often than their price implies, longshots less. So a
// calibrated win probability is q = (P + α + ψ·P)/100 — e.g. a 91¢ contract
// wins ≈ 92.4% of the time. Exported for testing and reuse.
export function calibratedWinProb(priceCents, { alpha = -1.736, psi = 0.034 } = {}) {
  const q = (priceCents + alpha + psi * priceCents) / 100;
  return Math.min(1, Math.max(0, q));
}

// Probability-weighted EV in dollars for the whole order:
//   EV = count·(q − P) − fee   (payout $1 on win)
// Positive only where the calibrated edge exceeds the fee — with the 0.07 fee
// coefficient that's roughly the 84–94¢ band (86¢+ for sports).
export function calibratedEvDollars(priceCents, count, feeOpts = {}, calib = {}) {
  const q = calibratedWinProb(priceCents, calib);
  const fee = kalshiFeeDollars(priceCents, count, feeOpts);
  return (q - priceCents / 100) * count - fee;
}

function authHeaders(privateKey, apiKeyId, path, method = 'POST') {
  const ts  = Date.now().toString();
  const sig = sign('sha256', Buffer.from(ts + method + path, 'utf8'), {
    key:        privateKey,
    padding:    constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }).toString('base64');
  return {
    'KALSHI-ACCESS-KEY':       apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type':            'application/json',
  };
}

// Build a Kalshi create-order-v2 body. That endpoint quotes the YES leg only:
//   buy YES @ P¢  -> side 'bid', price  P/100
//   buy NO  @ P¢  -> side 'ask', price (100−P)/100   (selling YES == buying NO at 1−price)
// price is fixed-point dollars (string); count is fixed-point (string).
function buildOrderBody({ ticker, side, priceCents, count, clientOrderId }) {
  const yesPriceCents = side === 'yes' ? priceCents : 100 - priceCents;
  return {
    ticker,
    client_order_id:            clientOrderId,
    side:                       side === 'yes' ? 'bid' : 'ask',
    price:                      (yesPriceCents / 100).toFixed(2),
    count:                      Number(count).toFixed(2),
    time_in_force:              'good_till_canceled',
    self_trade_prevention_type: 'taker_at_cross',
  };
}

export class AutoTrader {
  /**
   * @param {object} opts
   * @param {import('crypto').KeyObject} opts.privateKey
   * @param {string}  opts.apiKeyId
   * @param {boolean} [opts.enabled]            default true
   * @param {string}  [opts.category]           category to copy-trade (default 'Sports')
   * @param {number}  [opts.count]              contracts per copy-trade (default 1).
   *                                            NOTE: maker mode assumes count = 1 (partial
   *                                            fills on count > 1 are treated as a full fill).
   * @param {number}  [opts.minNotional]        min whale-trade notional in dollars to copy (default 25000)
   * @param {number}  [opts.minNetProfit]       min net profit if win, in dollars (default 0.02 = 2¢)
   * @param {boolean} [opts.makerMode]          post resting maker orders inside the spread instead of
   *                                            crossing as a taker (default true). The paper shows
   *                                            Makers average −9.6% vs Takers −31.5%.
   * @param {number}  [opts.makerFeeCoeff]      maker fee coefficient (default 0.07 == taker, conservative).
   * @param {number}  [opts.unfilledTtlMinutes] cancel resting maker orders older than this (default 10).
   * @param {boolean} [opts.stopLossEnabled]    enable stop-loss closing (default true)
   * @param {number}  [opts.stopLossPercent]    close if bid drops >= N% of entry price (default 70)
   * @param {string[]} [opts.blockedPrefixes]   ticker prefixes to skip (no-favorite / coin-flip markets)
   * @param {number}  [opts.minPriceCents]      min entry price in cents (default 70 — favorites floor).
   * @param {number}  [opts.maxPriceCents]      max entry price in cents (default 84).
   * @param {boolean} [opts.dedupeByEvent]      skip if we already hold/await a position on the same event.
   * @param {number}  [opts.maxPerGame]         max concurrent positions on the same game (same DATETEAMS segment, default 5; <=0 disables).
   * @param {number}  [opts.maxCapital]         max total open notional in dollars (default 500; <=0 disables).
   * @param {number}  [opts.maxOpenPositions]   max concurrent committed positions (default 25; <=0 disables).
   * @param {number}  [opts.maxDailyLoss]       realized-loss kill-switch in dollars (default 100; <=0 disables).
   */
  constructor({
    privateKey, apiKeyId,
    enabled = true,
    // Independent gate for the whale-COPY path (onTrade). `enabled` is the master
    // kill-switch for BOTH copy and the agent's placeOrderDirect; this lets a
    // box run the agent only (whaleCopyEnabled=false, enabled=true) without also
    // disarming the agent. Default true preserves prior behavior.
    whaleCopyEnabled = true,
    category = 'Sports',
    count = 1,
    minNotional = 25_000,
    minNetProfit = 0.02,
    makerMode = true,
    makerFeeCoeff = 0.07,
    unfilledTtlMinutes = 10,
    takerFallback = false,
    makerFallbackMinutes = 10,
    stopLossEnabled = true,
    stopLossPercent = 70,
    blockedPrefixes = [
      'KXNBASPREAD',        // 20% win rate
      'KXIPL',              // 50% win rate (coin-flip)
      'KXATPMATCH',         // 50% win rate (coin-flip)
      'KXWTAMATCH',         // 50% win rate (coin-flip)
      'KXITFMATCH',         // insufficient data, tennis generally weak
      'KXUFCFIGHT',         // 0% win rate
      'KXMVECROSSCATEGORY', // multi-leg combos (cross-category)
      'KXMVESPORTS',        // multi-leg combos (sports)
    ],
    minPriceCents = 70,
    maxPriceCents = 84,
    dedupeByEvent = true,
    maxPerGame = 5,
    maxCapital = 500,
    maxOpenPositions = 25,
    maxPerTicker = 5,
    maxDailyLoss = 100,
    calibratedEv = true,
    calibrationAlpha = -1.736,
    calibrationPsi = 0.034,
    minEvDollars = 0,
    maxDaysToClose = 10,
  }) {
    this.privateKey         = privateKey;
    this.apiKeyId           = apiKeyId;
    this.enabled            = enabled;
    this.whaleCopyEnabled   = whaleCopyEnabled;
    this.category           = category;
    this.count              = count;
    this.minNotional        = minNotional;
    this.minNetProfit       = minNetProfit;
    this.makerMode          = makerMode;
    this.makerFeeCoeff      = makerFeeCoeff;
    this.unfilledTtlMinutes = unfilledTtlMinutes;
    this.takerFallback      = takerFallback;
    this.makerFallbackMinutes = makerFallbackMinutes;
    this.stopLossEnabled    = stopLossEnabled;
    this.stopLossPercent    = stopLossPercent;
    this.blockedPrefixes    = blockedPrefixes;
    this.minPriceCents      = minPriceCents;
    this.maxPriceCents      = maxPriceCents;
    this.dedupeByEvent      = dedupeByEvent;
    this.maxPerGame         = maxPerGame;
    this.maxCapital         = maxCapital;
    this.maxOpenPositions   = maxOpenPositions;
    this.maxPerTicker       = maxPerTicker;
    this.maxDailyLoss       = maxDailyLoss;
    this.calibratedEv       = calibratedEv;
    this.calibrationAlpha   = calibrationAlpha;
    this.calibrationPsi     = calibrationPsi;
    this.minEvDollars       = minEvDollars;
    this.maxDaysToClose     = maxDaysToClose;

    // Realized-P&L tracking for the daily-loss kill-switch (in-memory, resets daily).
    this._pnlDate            = null;
    this._realizedTodayCents = 0;

    // Simple in-memory log of recent orders (capped at 500)
    this.log = [];

    // In-flight order reservations (resId → {eventTicker, notional}). Set
    // synchronously before an order is placed so that near-simultaneous trades
    // can't both pass the dedupe/cap gates before either is written to the DB —
    // this closes the double-fill race the adherence audit surfaced.
    this._inFlight = new Map();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  enable()  { this.enabled = true;  console.log('[auto-trader] enabled');  }
  disable() { this.enabled = false; console.log('[auto-trader] disabled'); }

  status() {
    return {
      enabled:            this.enabled,
      whaleCopyEnabled:   this.whaleCopyEnabled,
      category:           this.category,
      count:              this.count,
      minNotional:        this.minNotional,
      minNetProfit:       this.minNetProfit,
      makerMode:          this.makerMode,
      makerFeeCoeff:      this.makerFeeCoeff,
      unfilledTtlMinutes: this.unfilledTtlMinutes,
      takerFallback:      this.takerFallback,
      makerFallbackMinutes: this.makerFallbackMinutes,
      stopLossEnabled:    this.stopLossEnabled,
      stopLossPercent:    this.stopLossPercent,
      blockedPrefixes:    this.blockedPrefixes,
      minPriceCents:      this.minPriceCents,
      maxPriceCents:      this.maxPriceCents,
      dedupeByEvent:      this.dedupeByEvent,
      maxPerGame:         this.maxPerGame,
      maxCapital:         this.maxCapital,
      maxOpenPositions:   this.maxOpenPositions,
      maxPerTicker:       this.maxPerTicker,
      maxDailyLoss:       this.maxDailyLoss,
      calibratedEv:       this.calibratedEv,
      calibrationAlpha:   this.calibrationAlpha,
      calibrationPsi:     this.calibrationPsi,
      minEvDollars:       this.minEvDollars,
      maxDaysToClose:     this.maxDaysToClose,
      realizedTodayCents: this._realizedTodayCents,
      recentOrders:       this.log.slice(-20),
    };
  }

  /**
   * Called for every incoming whale trade.
   * Places a copy order if the trade matches our criteria.
   *
   * Polymarket trades are tracked but NOT auto-traded — source-gate here.
   * `category = 'ALL'` (or null) means trade every category.
   */
  async onTrade(trade) {
    // Master kill-switch OR the copy-specific gate disarms whale-copy. The agent
    // path (placeOrderDirect/_validateDirectOrder) checks only `enabled`, so it
    // keeps trading when whaleCopyEnabled=false.
    if (!this.enabled || !this.whaleCopyEnabled) return;
    if ((trade.source ?? 'kalshi') !== 'kalshi') return;
    if (this.category && this.category !== 'ALL' && trade.category !== this.category) return;

    const price = trade.side === 'yes' ? (trade.yesPrice ?? 0) : (trade.noPrice ?? 0);
    if (!price) return;

    // Blocked subcategory gate (ticker-prefix based, catches IPL/tennis/spread/UFC)
    if (this.blockedPrefixes.length > 0) {
      const blocked = this.blockedPrefixes.find((pfx) => trade.ticker.startsWith(pfx));
      if (blocked) {
        console.log(`[auto-trader] skip ${trade.ticker} — blocked prefix ${blocked}`);
        return;
      }
    }

    // Entry price range gate (favorites zone) — first-pass check on the whale's
    // executed price. The actual maker entry price is re-validated in _placeOrder.
    if (price < this.minPriceCents || price > this.maxPriceCents) {
      console.log(
        `[auto-trader] skip ${trade.ticker} ${trade.side.toUpperCase()} @ ${price}¢ — ` +
        `outside price range [${this.minPriceCents}¢, ${this.maxPriceCents}¢]`
      );
      return;
    }

    // Notional gate (size of the whale signal we're copying)
    const notional = (trade.count * price) / 100;
    if (notional < this.minNotional) return;

    // Committed positions (resting + filled, from the DB) PLUS in-flight
    // reservations (orders being placed right now but not yet written). Checking
    // both — and reserving synchronously below before any await — makes the
    // dedupe + cap gates atomic against near-simultaneous trades. Without the
    // in-flight set, two trades arriving in the same event-loop window both read
    // the same committed state, both pass, and both place (the double-fill bug).
    const committed   = getCommittedAutoOrders();
    const inFlight    = [...this._inFlight.values()];
    const eventTicker = trade.ticker.split('-').slice(0, -1).join('-');
    const gameKey     = trade.ticker.split('-')[1]; // DATETEAMS segment — same for all bet types on one game
    const addNotional = (price / 100) * this.count; // whale price = conservative upper bound (maker fills lower)

    // Game-level cap: allow up to maxPerGame bets on the same game (same DATETEAMS
    // segment), including exact duplicates. Exact-ticker duplicates are also bounded
    // by maxPerTicker below.
    if (this.maxPerGame > 0) {
      const sameGame = committed.filter((o) => o.ticker.split('-')[1] === gameKey).length
                     + inFlight.filter((r) => r.gameKey === gameKey).length;
      if (sameGame >= this.maxPerGame) {
        console.log(`[auto-trader] skip ${trade.ticker} — game cap ${sameGame}/${this.maxPerGame} on ${gameKey}`);
        return;
      }
    }

    // ── Bankroll rails (count committed + in-flight so concurrency can't bypass) ─
    const openCount = committed.length + inFlight.length;
    if (this.maxOpenPositions > 0 && openCount >= this.maxOpenPositions) {
      console.log(`[auto-trader] skip ${trade.ticker} — at max open positions (${openCount}/${this.maxOpenPositions})`);
      return;
    }
    if (this.maxPerTicker > 0) {
      const sameTicker = committed.filter((o) => o.ticker === trade.ticker).length
                       + inFlight.filter((r) => r.ticker === trade.ticker).length;
      if (sameTicker >= this.maxPerTicker) {
        console.log(`[auto-trader] skip ${trade.ticker} — at max per ticker (${sameTicker}/${this.maxPerTicker})`);
        return;
      }
    }
    if (this.maxCapital > 0) {
      const openNotional = committed.reduce((s, o) => s + (o.entry_price / 100) * o.count, 0)
                         + inFlight.reduce((s, r) => s + r.notional, 0);
      if (openNotional + addNotional > this.maxCapital) {
        console.log(
          `[auto-trader] skip ${trade.ticker} — capital cap: ` +
          `$${openNotional.toFixed(2)} open + $${addNotional.toFixed(2)} new > $${this.maxCapital} cap`
        );
        return;
      }
    }

    // Reserve the slot SYNCHRONOUSLY (before the first await in _placeOrder) so a
    // concurrent onTrade sees it and skips. Released once placement resolves.
    const resId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._inFlight.set(resId, { ticker: trade.ticker, eventTicker, gameKey, notional: addNotional });
    try {
      await this._placeOrder(trade);
    } finally {
      this._inFlight.delete(resId);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Fetch the current order book for a ticker and return bid/ask in cents.
   * Asks are derived as 100 − the opposite side's best bid (guaranteed by the
   * binary contract structure), so we don't depend on ask-specific API fields.
   */
  async _fetchMarketCents(ticker) {
    try {
      const res = await fetch(`${REST_BASE}/markets/${ticker}`);
      if (!res.ok) return null;
      const data = await res.json();
      const m = data.market ?? {};
      const yesBidD = parseFloat(m.yes_bid_dollars ?? NaN);
      const noBidD  = parseFloat(m.no_bid_dollars ?? NaN);
      const yesBid = Number.isFinite(yesBidD) ? Math.round(yesBidD * 100) : NaN;
      const noBid  = Number.isFinite(noBidD)  ? Math.round(noBidD  * 100) : NaN;
      const yesAsk = Number.isFinite(noBid)  ? 100 - noBid  : NaN; // sell YES = buy NO
      const noAsk  = Number.isFinite(yesBid) ? 100 - yesBid : NaN; // sell NO  = buy YES
      // Days-to-close gate keys off the actual resolution time. Kalshi sets
      // close_time to the GROUP-STAGE end for World Cup single-game markets
      // (~2 weeks out) while expected_expiration_time is the real game end (same
      // day) — prefer the latter so same-day games aren't wrongly rejected as
      // "closes in 14 days" by the maxDaysToClose timing rail.
      const closeTime = m.expected_expiration_time ?? m.close_time ?? null;
      return { status: m.status, yesBid, noBid, yesAsk, noAsk, closeTime };
    } catch (err) {
      console.error(`[auto-trader] book fetch error ${ticker}:`, err.message);
      return null;
    }
  }

  async _placeOrder(trade) {
    const side       = trade.side; // 'yes' | 'no'
    const whalePrice = side === 'yes' ? trade.yesPrice : trade.noPrice;

    if (!whalePrice) {
      console.warn(`[auto-trader] skipping ${trade.ticker} — no price data`);
      return;
    }

    const isSports = trade.category === 'Sports';
    const feeBase  = { isSports, makerFeeCoeff: this.makerFeeCoeff };

    // ── Determine the limit price + role (maker vs taker) ──────────────────────
    let limitPrice = whalePrice;
    let role       = 'taker';

    if (this.makerMode) {
      const book = await this._fetchMarketCents(trade.ticker);
      if (!book || book.status !== 'active') {
        console.log(`[auto-trader] skip ${trade.ticker} — no active book for maker pricing`);
        return;
      }
      const bestBid = side === 'yes' ? book.yesBid : book.noBid;
      const bestAsk = side === 'yes' ? book.yesAsk : book.noAsk;
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid < 1 || bestAsk < 1) {
        console.log(`[auto-trader] skip ${trade.ticker} — incomplete book (bid ${bestBid}¢, ask ${bestAsk}¢)`);
        return;
      }

      // Rest inside the book: never pay more than whalePrice−1, and never above
      // the best bid (join the bid queue) — this is what makes us a Maker.
      limitPrice = Math.min(whalePrice - 1, bestBid);
      role       = 'maker';

      // No-cross guarantee: a buy at ≥ best ask would execute immediately as a Taker.
      if (limitPrice >= bestAsk) {
        console.log(`[auto-trader] skip ${trade.ticker} — maker price ${limitPrice}¢ would cross ask ${bestAsk}¢`);
        return;
      }
      // Re-validate the favorites floor/ceiling against the *actual* entry price.
      if (limitPrice < this.minPriceCents || limitPrice > this.maxPriceCents) {
        console.log(
          `[auto-trader] skip ${trade.ticker} — maker price ${limitPrice}¢ outside ` +
          `[${this.minPriceCents}¢, ${this.maxPriceCents}¢]`
        );
        return;
      }
      if (limitPrice < 1) {
        console.log(`[auto-trader] skip ${trade.ticker} — maker price below 1¢`);
        return;
      }
    }

    // ── Authoritative profitability gate at the actual entry price + role ──────
    const fee       = kalshiFeeDollars(limitPrice, this.count, { ...feeBase, role });
    const netProfit = maxNetProfitDollars(limitPrice, this.count, { ...feeBase, role });
    if (netProfit < this.minNetProfit) {
      console.log(
        `[auto-trader] skip ${trade.ticker} ${side.toUpperCase()} @ ${limitPrice}¢ — ` +
        `max net win $${netProfit.toFixed(4)} (fee $${fee.toFixed(4)}, ${role}) < $${this.minNetProfit.toFixed(2)}`
      );
      return;
    }

    // ── Calibrated EV gate (favorite–longshot correction) ──────────────────────
    // q from the paper's bias regression; require probability-weighted EV after
    // fees to clear minEvDollars. With default params this passes only ~84–94¢
    // entries — choosier than the raw price band, in exactly the zone where the
    // paper finds statistically significant positive Maker returns.
    const calib = { alpha: this.calibrationAlpha, psi: this.calibrationPsi };
    let estQ = null, estNetEv = netProfit;
    if (this.calibratedEv) {
      estQ     = calibratedWinProb(limitPrice, calib);
      estNetEv = calibratedEvDollars(limitPrice, this.count, { ...feeBase, role }, calib);
      if (estNetEv <= this.minEvDollars) {
        console.log(
          `[auto-trader] skip ${trade.ticker} ${side.toUpperCase()} @ ${limitPrice}¢ — ` +
          `calibrated EV $${estNetEv.toFixed(4)} (q=${(estQ * 100).toFixed(1)}%, fee $${fee.toFixed(4)}, ${role}) ` +
          `<= $${this.minEvDollars.toFixed(2)} threshold`
        );
        return;
      }
    }

    const clientOrderId = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const body = buildOrderBody({
      ticker: trade.ticker, side, priceCents: limitPrice, count: this.count, clientOrderId,
    });
    // NOTE: if your Kalshi API version supports it, adding `post_only: true` here
    // would make the exchange itself reject any order that would cross (take).

    const entry = {
      ts:              new Date().toISOString(),
      ticker:          trade.ticker,
      side,
      price:           limitPrice,
      whalePrice,
      role,
      count:           this.count,
      estFee:          fee,
      estMaxNetProfit: netProfit,
      estQ,
      estNetEv,
      clientOrderId,
      status:          'pending',
      error:           null,
    };

    try {
      const res  = await fetch(`${REST_BASE}/portfolio/events/orders`, {
        method:  'POST',
        headers: authHeaders(this.privateKey, this.apiKeyId, CREATE_ORDER_PATH),
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        entry.status = 'failed';
        entry.error  = data?.error?.message ?? JSON.stringify(data);
        console.error(`[auto-trader] ❌ ${trade.ticker} BUY ${side.toUpperCase()} — ${entry.error}`);
      } else {
        // Maker orders rest until matched; taker orders fill immediately.
        entry.status  = role === 'maker' ? 'resting' : 'placed';
        entry.orderId = data?.order_id ?? null;   // create-order-v2 response is flat
        console.log(
          `[auto-trader] ✅ ${trade.ticker} BUY ${side.toUpperCase()} x${this.count} @ ${limitPrice}¢ ` +
          `(${role}${role === 'maker' ? `, was ${whalePrice}¢` : ''}${entry.orderId ? `, ${entry.orderId}` : ''})`
        );
      }
    } catch (err) {
      entry.status = 'error';
      entry.error  = err.message;
      console.error(`[auto-trader] ❌ ${trade.ticker} — ${err.message}`);
    }

    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();

    // Persist to DB if accepted. Maker → 'resting' (awaiting fill); taker → 'placed'.
    if (entry.status === 'resting' || entry.status === 'placed') {
      try {
        insertAutoOrder({
          client_order_id: entry.clientOrderId,
          order_id:        entry.orderId ?? null,
          ticker:          entry.ticker,
          side:            entry.side,
          entry_price:     entry.price,
          count:           entry.count,
          est_fee:         entry.estFee ?? null,
          role:            entry.role ?? null,
          est_q:           entry.estQ ?? null,
          est_net_ev:      entry.estNetEv ?? null,
          placed_ts:       entry.ts,
          status:          entry.status,
        });
      } catch (err) {
        console.error('[auto-trader] db insert error', err.message);
      }
    }

    notifyTrade(entry).catch((err) => console.error('[notify] unhandled error', err.message));
  }

  /**
   * Reconcile resting maker orders: promote filled ones to held positions
   * ('placed') and cancel any that have rested longer than unfilledTtlMinutes.
   * Unfilled orders are NEVER converted to a taker by crossing — they are
   * canceled, preserving the maker edge. Call periodically (e.g. every 2 min).
   */
  async checkOpenOrders() {
    // Sweep whenever resting orders exist, regardless of makerMode: agent-tool
    // orders are always maker (resting) even when whale-copying runs as taker,
    // and a maker→taker config flip must not strand leftovers.
    const resting = getRestingAutoOrders();
    if (resting.length === 0) return { checked: 0, filled: 0, canceled: 0 };

    const ttlMs = this.unfilledTtlMinutes * 60_000;
    let filled = 0, canceled = 0;

    for (const o of resting) {
      if (!o.order_id) continue; // can't reconcile without a Kalshi order id
      try {
        const path = `${ORDER_PATH}/${o.order_id}`;   // cancel path (DELETE still works)
        // The single-order GET was retired (404). Read this ticker's TERMINAL
        // orders and match by id: 'executed' => filled, 'canceled'/'expired' =>
        // canceled, absent => still resting (active orders aren't in this list).
        const listPath = '/trade-api/v2/portfolio/orders';
        const res  = await fetch(`${REST_BASE}/portfolio/orders?ticker=${encodeURIComponent(o.ticker)}`, {
          headers: authHeaders(this.privateKey, this.apiKeyId, listPath, 'GET'),
        });
        if (!res.ok) continue;
        const data   = await res.json();
        const match  = (data.orders || []).find((x) => x.order_id === o.order_id);
        const status = (match?.status ?? '').toLowerCase();

        // Filled → promote to a held position.
        if (status === 'executed') {
          markAutoOrderFilled(o.client_order_id);
          filled++;
          console.log(`[auto-trader] 🎯 filled ${o.ticker} ${o.side.toUpperCase()} @ ${o.entry_price}¢`);
          notifyTrade({
            ts: new Date().toISOString(),
            ticker: o.ticker, side: o.side,
            price:  o.entry_price,
            count:  o.count,
            action: 'fill',
            status: 'filled',
          }).catch((err) => console.error('[notify] unhandled error', err.message));
          continue;
        }

        // Terminal-but-unfilled on the exchange → record as canceled.
        if (status === 'canceled' || status === 'expired') {
          cancelAutoOrderRecord(o.client_order_id, { ts: new Date().toISOString(), reason: status });
          canceled++;
          continue;
        }

        // Past the resting window. Pure-maker (takerFallback off): cancel,
        // preserving the maker edge. Maker-first/taker-fallback (on): cancel the
        // resting maker, then re-submit as a taker crossing the current ask —
        // placeOrderDirect re-validates band + EV at that worse price, so it
        // only crosses when the trade still clears; otherwise it stays canceled.
        const age = Date.now() - new Date(o.placed_ts).getTime();
        const windowMs = this.takerFallback ? this.makerFallbackMinutes * 60_000 : ttlMs;
        if (age >= windowMs) {
          const del = await fetch(`${REST_BASE}/portfolio/orders/${o.order_id}`, {
            method:  'DELETE',
            headers: authHeaders(this.privateKey, this.apiKeyId, path, 'DELETE'),
          });
          if (!del.ok) continue;
          cancelAutoOrderRecord(o.client_order_id, {
            ts: new Date().toISOString(),
            reason: this.takerFallback ? 'maker_window_expired' : 'ttl_expired',
          });
          canceled++;
          if (this.takerFallback) {
            const r = await this.placeOrderDirect({
              ticker: o.ticker, side: o.side, limitPrice: this.maxPriceCents,
              count: o.count, forceTaker: true,
            });
            if (r && !r.rejected && !r.error) {
              console.log(`[auto-trader] ↪️  taker-fallback crossed ${o.ticker} ${o.side.toUpperCase()} after ${Math.round(age / 60_000)}m unfilled`);
            } else {
              console.log(`[auto-trader] ↪️  taker-fallback declined ${o.ticker} after ${Math.round(age / 60_000)}m — ${r?.reason ?? r?.error ?? 'unknown'}`);
            }
          } else {
            console.log(`[auto-trader] ⏲️  canceled unfilled ${o.ticker} after ${Math.round(age / 60_000)}m`);
          }
        }
      } catch (err) {
        console.error(`[auto-trader] open-order check error ${o.ticker}:`, err.message);
      }
    }
    if (filled || canceled) {
      console.log(`[auto-trader] reconcile: ${filled} filled, ${canceled} canceled of ${resting.length} resting`);
    }
    return { checked: resting.length, filled, canceled };
  }

  /**
   * Poll Kalshi for any held positions that have settled, and record outcomes.
   * Should be called periodically (e.g., every 15 minutes).
   */
  async checkSettlements() {
    const open = getOpenAutoOrders();
    if (open.length === 0) return { checked: 0, settled: 0 };

    let settledCount = 0;
    for (const o of open) {
      try {
        const res = await fetch(`${REST_BASE}/markets/${o.ticker}`);
        if (!res.ok) continue;
        const data = await res.json();
        const m = data.market ?? {};
        const status = m.status;
        if (status !== 'settled' && status !== 'finalized') continue;

        // m.result is 'yes' or 'no' depending on which side won
        const result = m.result;
        if (!result) continue;

        // P&L per contract: win → (100 − entry), lose → −entry
        const won = (o.side === result);
        const pnlPerContract = won ? (100 - o.entry_price) : -o.entry_price;
        const pnlCents = pnlPerContract * o.count;

        settleAutoOrder(o.client_order_id, {
          outcome:   won ? 'win' : 'loss',
          pnlCents,
          settledTs: new Date().toISOString(),
        });
        this._recordRealized(pnlCents);

        settledCount++;
        console.log(
          `[auto-trader] ${won ? '✅' : '❌'} settled ${o.ticker} ${o.side.toUpperCase()} @ ${o.entry_price}¢ — ` +
          `${won ? 'WIN' : 'LOSS'} ${pnlCents >= 0 ? '+' : ''}${pnlCents}¢`
        );
        notifyTrade({
          ts: new Date().toISOString(),
          ticker: o.ticker, side: o.side,
          price:  o.entry_price,
          count:  o.count,
          action: 'settle',
          status: 'settled',
          outcome: won ? 'win' : 'loss',
          pnlCents,
        }).catch((err) => console.error('[notify] unhandled error', err.message));
      } catch (err) {
        console.error(`[auto-trader] settlement check error ${o.ticker}:`, err.message);
      }
    }
    return { checked: open.length, settled: settledCount };
  }

  /**
   * Stop-loss watchdog. Poll current market prices for held positions and close
   * any where the current bid (on the side we hold) has dropped by
   * stopLossPercent% or more relative to our entry price.
   *
   * IMPORTANT: this is a TAKER exit (sells at bid − 1¢) and crosses the spread,
   * so it forfeits the hold-to-settlement edge the paper documents. Run with
   * `stopLossEnabled = false` on a sample and compare realized P&L on the
   * auto_orders table before trusting it. Should be called every ~3 minutes.
   */
  async checkStopLosses() {
    if (!this.stopLossEnabled) return { checked: 0, closed: 0 };
    const open = getOpenAutoOrders();
    if (open.length === 0) return { checked: 0, closed: 0 };

    const dropFraction = this.stopLossPercent / 100;
    let closedCount = 0;
    for (const o of open) {
      try {
        const res = await fetch(`${REST_BASE}/markets/${o.ticker}`);
        if (!res.ok) continue;
        const data = await res.json();
        const m = data.market ?? {};
        if (m.status !== 'active') continue; // skip closed/settled markets

        // Current bid on the side we hold (we'll sell into it)
        const bidField = o.side === 'yes' ? 'yes_bid_dollars' : 'no_bid_dollars';
        const bidDollars = parseFloat(m[bidField] ?? 0);
        if (!bidDollars || bidDollars <= 0) continue;
        const currentBidCents = Math.round(bidDollars * 100);

        // Trigger threshold: drop ≥ stopLossPercent% of entry
        const triggerBidCents = o.entry_price * (1 - dropFraction);
        if (currentBidCents > triggerBidCents) continue;

        // Trigger! Place a SELL at (bid - 1c) to ensure fill
        const sellPrice = Math.max(1, currentBidCents - 1);
        await this._closePosition(o, sellPrice, 'stop_loss');
        closedCount++;
      } catch (err) {
        console.error(`[auto-trader] stop-loss check error ${o.ticker}:`, err.message);
      }
    }
    if (closedCount > 0) console.log(`[auto-trader] stop-loss: closed ${closedCount}/${open.length} open positions`);
    return { checked: open.length, closed: closedCount };
  }

  /**
   * Close a held position by placing a SELL order at the given price.
   * This is a taker exit — the estimated taker exit fee is logged for the
   * adherence review. Updates DB and sends notification email.
   */
  async _closePosition(order, sellPriceCents, reason = 'manual') {
    const clientOrderId = `close-${order.client_order_id.slice(-12)}-${Date.now().toString(36)}`;
    const body = {
      ticker:          order.ticker,
      client_order_id: clientOrderId,
      type:            'limit',
      action:          'sell',
      side:            order.side,
      count:           order.count,
      ...(order.side === 'yes' ? { yes_price: sellPriceCents } : { no_price: sellPriceCents }),
    };

    // Gross P&L vs entry; the taker exit fee is an additional drag we surface.
    const pnlCents = (sellPriceCents - order.entry_price) * order.count;
    const exitFee  = kalshiFeeDollars(sellPriceCents, order.count, { role: 'taker', makerFeeCoeff: this.makerFeeCoeff });
    const entry = {
      ts:            new Date().toISOString(),
      ticker:        order.ticker,
      side:          order.side,
      price:         sellPriceCents,
      count:         order.count,
      action:        'sell',
      reason,
      entryPrice:    order.entry_price,
      pnlCents,
      exitFee,
      clientOrderId,
      status:        'pending',
      error:         null,
    };

    try {
      const res = await fetch(`${REST_BASE}/portfolio/orders`, {
        method:  'POST',
        headers: authHeaders(this.privateKey, this.apiKeyId, ORDER_PATH),
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok) {
        entry.status = 'failed';
        entry.error  = data?.error?.message ?? JSON.stringify(data);
        console.error(`[auto-trader] ❌ Failed to close ${order.ticker}: ${entry.error}`);
      } else {
        entry.status = 'closed_early';
        closeAutoOrderEarly(order.client_order_id, {
          pnlCents,
          soldPrice: sellPriceCents,
          ts: new Date().toISOString(),
        });
        this._recordRealized(pnlCents);
        console.log(
          `[auto-trader] 🛑 ${reason} closed ${order.ticker} ${order.side.toUpperCase()} ` +
          `entry ${order.entry_price}¢ → sold ${sellPriceCents}¢ = ${pnlCents >= 0 ? '+' : ''}${pnlCents}¢ ` +
          `(taker exit fee ~$${exitFee.toFixed(2)})`
        );
      }
    } catch (err) {
      entry.status = 'error';
      entry.error  = err.message;
      console.error(`[auto-trader] close error ${order.ticker}: ${err.message}`);
    }

    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    notifyTrade(entry).catch((err) => console.error('[notify] unhandled error', err.message));
  }

  /**
   * Validate an explicit (agent-supplied) order against the SAME hard rails as
   * the whale-copy path. Returns { ok: false, reason } on any violation, or
   * { ok: true, role, fee, estQ, estNetEv, eventTicker, addNotional }.
   * Maker-only is enforced unconditionally here: the agent's rubric requires
   * resting orders, so a crossing (taker) price is rejected outright.
   */
  async _validateDirectOrder({ ticker, side, limitPrice, count, forceTaker = false }) {
    if (!this.enabled) return { ok: false, reason: 'auto-trader is disabled (kill-switch or manual)' };
    if (side !== 'yes' && side !== 'no') return { ok: false, reason: `invalid side '${side}'` };
    if (!Number.isInteger(limitPrice) || limitPrice < 1 || limitPrice > 99) {
      return { ok: false, reason: 'limit_price must be integer cents 1–99' };
    }
    if (!Number.isInteger(count) || count < 1) return { ok: false, reason: 'count must be a positive integer' };

    const blocked = this.blockedPrefixes.find((p) => ticker.startsWith(p));
    if (blocked) return { ok: false, reason: `blocked market prefix ${blocked}` };

    if (limitPrice < this.minPriceCents || limitPrice > this.maxPriceCents) {
      return { ok: false, reason: `price ${limitPrice}¢ outside [${this.minPriceCents}¢, ${this.maxPriceCents}¢]` };
    }

    // Validate against the live book. makerMode=true rests strictly inside the
    // spread (no-cross). makerMode=false crosses at the best ask so the order
    // fills immediately as a taker, using the agent's limit_price as a ceiling
    // we refuse to pay past. After this block `limitPrice` is the ACTUAL entry.
    const book = await this._fetchMarketCents(ticker);
    if (!book || book.status !== 'active') return { ok: false, reason: 'no active book — cannot validate pricing' };
    const bestBid = side === 'yes' ? book.yesBid : book.noBid;
    const bestAsk = side === 'yes' ? book.yesAsk : book.noAsk;
    if (!Number.isFinite(bestAsk) || bestAsk < 1) return { ok: false, reason: 'incomplete book — cannot validate entry' };

    let role;
    if (this.makerMode && !forceTaker) {
      if (limitPrice >= bestAsk) {
        return { ok: false, reason: `limit ${limitPrice}¢ >= best ask ${bestAsk}¢ — would cross as taker (maker-only)` };
      }
      role = 'maker';
    } else {
      if (bestAsk > limitPrice) {
        return { ok: false, reason: `best ask ${bestAsk}¢ > limit ${limitPrice}¢ — won't chase past taker ceiling` };
      }
      limitPrice = bestAsk;   // cross the spread: fill now against the resting ask
      role = 'taker';
      // Re-validate the favorites band against the actual crossed entry price.
      if (limitPrice < this.minPriceCents || limitPrice > this.maxPriceCents) {
        return { ok: false, reason: `taker entry ${limitPrice}¢ outside [${this.minPriceCents}¢, ${this.maxPriceCents}¢]` };
      }
    }

    // Timing rail: prices are only well-calibrated within ~10 days of close
    // (the paper's window) — reject entries on far-dated markets.
    let daysToClose = null;
    if (book.closeTime) {
      daysToClose = Math.ceil((new Date(book.closeTime).getTime() - Date.now()) / 86_400_000);
      if (this.maxDaysToClose > 0 && daysToClose > this.maxDaysToClose) {
        return { ok: false, reason: `closes in ${daysToClose} days > ${this.maxDaysToClose}-day window (timing discipline)` };
      }
    }

    const isSports = categoryFromTicker(ticker) === 'Sports';
    const feeOpts  = { isSports, makerFeeCoeff: this.makerFeeCoeff, role };
    const fee       = kalshiFeeDollars(limitPrice, count, feeOpts);
    const netProfit = maxNetProfitDollars(limitPrice, count, feeOpts);
    if (netProfit < this.minNetProfit) {
      return { ok: false, reason: `max net win $${netProfit.toFixed(4)} (fee $${fee.toFixed(4)}) < $${this.minNetProfit.toFixed(2)}` };
    }

    let estQ = null, estNetEv = netProfit;
    if (this.calibratedEv) {
      const calib = { alpha: this.calibrationAlpha, psi: this.calibrationPsi };
      estQ     = calibratedWinProb(limitPrice, calib);
      estNetEv = calibratedEvDollars(limitPrice, count, feeOpts, calib);
      if (estNetEv <= this.minEvDollars) {
        return { ok: false, reason: `calibrated EV $${estNetEv.toFixed(4)} (q=${(estQ * 100).toFixed(1)}%) <= $${this.minEvDollars.toFixed(2)}` };
      }
    }

    // Dedupe + bankroll rails (committed positions + in-flight reservations).
    const committed   = getCommittedAutoOrders();
    const inFlight    = [...this._inFlight.values()];
    const eventTicker = ticker.split('-').slice(0, -1).join('-');
    const gameKey     = ticker.split('-')[1];
    if (this.maxPerGame > 0) {
      const sameGame = committed.filter((o) => o.ticker.split('-')[1] === gameKey).length
                     + inFlight.filter((r) => r.gameKey === gameKey).length;
      if (sameGame >= this.maxPerGame) {
        return { ok: false, reason: `game cap ${sameGame}/${this.maxPerGame} on ${gameKey}` };
      }
    }
    const openCount = committed.length + inFlight.length;
    if (this.maxOpenPositions > 0 && openCount >= this.maxOpenPositions) {
      return { ok: false, reason: `at max open positions (${openCount}/${this.maxOpenPositions})` };
    }
    if (this.maxPerTicker > 0) {
      const sameTicker = committed.filter((o) => o.ticker === ticker).length
                       + inFlight.filter((r) => r.ticker === ticker).length;
      if (sameTicker >= this.maxPerTicker) {
        return { ok: false, reason: `at max per ticker (${sameTicker}/${this.maxPerTicker})` };
      }
    }
    const addNotional = (limitPrice / 100) * count;
    if (this.maxCapital > 0) {
      const openNotional = committed.reduce((s, o) => s + (o.entry_price / 100) * o.count, 0)
                         + inFlight.reduce((s, r) => s + r.notional, 0);
      if (openNotional + addNotional > this.maxCapital) {
        return { ok: false, reason: `capital cap: $${openNotional.toFixed(2)} open + $${addNotional.toFixed(2)} new > $${this.maxCapital}` };
      }
    }

    return {
      ok: true, role, entryPrice: limitPrice, fee, estQ, estNetEv, eventTicker, gameKey, addNotional, isSports,
      bestBid: Number.isFinite(bestBid) ? bestBid : null,
      bestAsk, closeTime: book.closeTime, daysToClose,
    };
  }

  /**
   * Place an order directly with explicit parameters (used by the agent tool
   * endpoint). Enforces the SAME hard rails as the whale-copy path — the rubric
   * is the second line of defense, not the first. Returns { rejected, reason }
   * on a rails violation (so the agent can read why), or the order ids.
   */
  async placeOrderDirect({ ticker, side, limitPrice, count = 1, forceTaker = false }) {
    const v = await this._validateDirectOrder({ ticker, side, limitPrice, count, forceTaker });
    if (!v.ok) {
      console.log(`[agent-tool] ❌ rejected ${ticker} ${String(side).toUpperCase()} @ ${limitPrice}¢ — ${v.reason}`);
      return { rejected: true, reason: v.reason };
    }
    // Validated entry price: the agent's limit in maker mode, the crossed best
    // ask in taker mode (makerMode=false). Post + record the order at THIS price.
    const entryPrice = v.entryPrice;

    // Reserve the slot so concurrent agent calls / whale copies can't stack past
    // the caps (same in-flight mechanism as onTrade).
    const resId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._inFlight.set(resId, { ticker, eventTicker: v.eventTicker, gameKey: v.gameKey, notional: v.addNotional });
    try {
      const clientOrderId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const body = buildOrderBody({ ticker, side, priceCents: entryPrice, count, clientOrderId });
      const res  = await fetch(`${REST_BASE}/portfolio/events/orders`, {
        method:  'POST',
        headers: authHeaders(this.privateKey, this.apiKeyId, CREATE_ORDER_PATH),
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? JSON.stringify(data));
      const orderId = data?.order_id ?? null;   // create-order-v2 response is flat
      const status  = 'resting'; // initial DB state; reconciler flips resting→filled/settled from the exchange (taker fills ~immediately)
      insertAutoOrder({
        client_order_id: clientOrderId,
        order_id:        orderId,
        ticker, side,
        entry_price:     entryPrice,
        count,
        est_fee:         v.fee,
        role:            v.role,
        est_q:           v.estQ,
        est_net_ev:      v.estNetEv,
        placed_ts:       new Date().toISOString(),
        status,
      });
      console.log(`[agent-tool] ✅ ${ticker} BUY ${side.toUpperCase()} x${count} @ ${entryPrice}¢ (${v.role}, ${orderId})`);
      notifyTrade({
        ts: new Date().toISOString(),
        ticker, side,
        price:  entryPrice,
        count,
        role:   v.role,
        status,
        estFee: v.fee,
        orderId,
        clientOrderId,
        via: 'managed agent',
      }).catch((err) => console.error('[notify] unhandled error', err.message));
      return {
        client_order_id: clientOrderId,
        order_id:        orderId,
        status,
        role:        v.role,
        best_bid:    v.bestBid,
        best_ask:    v.bestAsk,
        est_fee:     v.fee,
        est_q:       v.estQ,
        est_q_source: 'favorite-longshot calibration bucket q=(P+α+ψ·P)/100, α=-1.736 ψ=0.034 ' +
                      '(Bürgi, Deng & Whelan 2026, full-sample Mincer-Zarnowitz regression). ' +
                      'Price-bucket calibration: same entry price ⇒ same q by construction.',
        est_net_ev:  v.estNetEv,
        // Pre-formatted, unit-consistent provenance strings — cite these
        // VERBATIM in reports so EV math and fee citations are always right.
        ev_formula:  v.estQ != null
          ? `est_net_ev = q − P − fee = ${v.estQ.toFixed(5)} − ${(limitPrice / 100).toFixed(2)} − ${v.fee.toFixed(2)} = ` +
            `${v.estNetEv >= 0 ? '+' : ''}$${v.estNetEv.toFixed(5)} per contract (all figures in dollars)`
          : `max-win gate: (1 − P) − fee = ${((100 - limitPrice) / 100).toFixed(2)} − ${v.fee.toFixed(2)} = $${v.estNetEv.toFixed(5)} (dollars)`,
        fee_schedule: `fee = 0.07·P·(1−P) per contract, rounded up to the next cent per order ` +
          `(maker coefficient 0.07, conservative = taker rate)` +
          `${v.isSports ? '; sports +15% premium APPLIED (sports ticker)' : '; sports premium NOT applicable (non-sports ticker)'} ` +
          `— source: https://kalshi.com/fee-schedule, June 2026 schedule`,
        close_time:  v.closeTime,
        days_to_close: v.daysToClose,
      };
    } finally {
      this._inFlight.delete(resId);
    }
  }

  /**
   * Cancel a resting order by its Kalshi order_id. Updates the DB record.
   */
  async cancelOrderDirect(orderId) {
    const path = `/trade-api/v2/portfolio/orders/${orderId}`;
    const res  = await fetch(`${REST_BASE}/portfolio/orders/${orderId}`, {
      method:  'DELETE',
      headers: authHeaders(this.privateKey, this.apiKeyId, path, 'DELETE'),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    }
    console.log(`[agent-tool] canceled order ${orderId}`);
    return { canceled: orderId };
  }

  /**
   * Accumulate realized P&L for the day and trip the kill-switch (disable the
   * trader) if the configured daily loss is breached. Resets at UTC midnight.
   */
  _recordRealized(pnlCents) {
    const today = new Date().toISOString().slice(0, 10);
    if (this._pnlDate !== today) {
      this._pnlDate = today;
      this._realizedTodayCents = 0;
    }
    this._realizedTodayCents += pnlCents;

    if (this.maxDailyLoss > 0 && this._realizedTodayCents <= -this.maxDailyLoss * 100 && this.enabled) {
      console.warn(
        `[${ENV_TAG}][auto-trader] 🚨 daily-loss kill-switch tripped: realized ${this._realizedTodayCents}¢ today ` +
        `≤ −$${this.maxDailyLoss}. Disabling auto-trader.`
      );
      this.disable();
      notifyTrade({
        ts:       new Date().toISOString(),
        ticker:   'KILL_SWITCH',
        action:   'disable',
        reason:   'max_daily_loss',
        pnlCents: this._realizedTodayCents,
        status:   'killed',
      }).catch((err) => console.error('[notify] unhandled error', err.message));
    }
  }
}
