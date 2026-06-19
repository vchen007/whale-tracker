import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../trades.db');

let db;

export function initDb() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id        TEXT PRIMARY KEY,
      ticker    TEXT NOT NULL,
      category  TEXT NOT NULL,
      side      TEXT NOT NULL,
      yes_price INTEGER,
      no_price  INTEGER,
      count     INTEGER NOT NULL,
      ts        TEXT NOT NULL,
      ts_ms     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_ts_ms ON trades (ts_ms DESC);

    CREATE TABLE IF NOT EXISTS market_titles (
      ticker     TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      category   TEXT,
      yes_sub    TEXT,
      no_sub     TEXT,
      close_time TEXT
    );
  `);
  // Migrations
  try { db.exec('ALTER TABLE market_titles ADD COLUMN category   TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN yes_sub    TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN no_sub     TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN close_time TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN event_start_time TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN event_actual_start_time TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE market_titles ADD COLUMN source TEXT DEFAULT \'kalshi\''); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE trades ADD COLUMN trade_id TEXT');                    } catch { /* already exists */ }
  try { db.exec('ALTER TABLE trades ADD COLUMN source   TEXT DEFAULT \'kalshi\''); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE trades ADD COLUMN outcome  TEXT');                    } catch { /* already exists */ }

  // Auto-trader order tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_orders (
      client_order_id TEXT PRIMARY KEY,
      order_id        TEXT,
      ticker          TEXT NOT NULL,
      side            TEXT NOT NULL,
      entry_price     INTEGER NOT NULL,
      count           INTEGER NOT NULL,
      est_fee         REAL,
      role            TEXT,
      est_net_ev      REAL,
      placed_ts       TEXT NOT NULL,
      status          TEXT NOT NULL,
      outcome         TEXT,
      pnl_cents       INTEGER,
      settled_ts      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_orders_status ON auto_orders (status);
  `);
  // Migrations: role (maker/taker) + est_net_ev added so the adherence audit can
  // grade execution role and per-order economics; est_q is the calibrated win
  // probability behind est_net_ev (null → est_net_ev is the max-win gate value).
  try { db.exec('ALTER TABLE auto_orders ADD COLUMN role       TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE auto_orders ADD COLUMN est_net_ev REAL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE auto_orders ADD COLUMN est_q      REAL'); } catch { /* already exists */ }
  // sold_price (cents) for early exits: the realized exit price the stop-loss /
  // take-profit taker sold into. Required by the adherence audit's stop-loss
  // accounting (exit cost = (entry_price − sold_price)·count). Previously
  // closeAutoOrderEarly() received it but dropped it, leaving exit price
  // unrecoverable except by inverting pnl_cents.
  try { db.exec('ALTER TABLE auto_orders ADD COLUMN sold_price INTEGER'); } catch { /* already exists */ }
  return db;
}

// ── Auto-trader order helpers ────────────────────────────────────────────────

export function insertAutoOrder(o) {
  return db.prepare(`
    INSERT OR REPLACE INTO auto_orders
      (client_order_id, order_id, ticker, side, entry_price, count, est_fee, role, est_q, est_net_ev, placed_ts, status)
    VALUES (@client_order_id, @order_id, @ticker, @side, @entry_price, @count, @est_fee, @role, @est_q, @est_net_ev, @placed_ts, @status)
  `).run(o);
}

// Filled positions we currently hold (maker orders are promoted to 'placed'
// once matched; taker orders are 'placed' immediately). Drives settlement and
// stop-loss.
export function getOpenAutoOrders() {
  return db.prepare(`
    SELECT * FROM auto_orders WHERE status = 'placed' ORDER BY placed_ts DESC
  `).all();
}

// Maker orders that are resting on the book, not yet known to be filled.
export function getRestingAutoOrders() {
  return db.prepare(`
    SELECT * FROM auto_orders WHERE status = 'resting' ORDER BY placed_ts DESC
  `).all();
}

// Everything that ties up capital / blocks a duplicate: resting + filled.
export function getCommittedAutoOrders() {
  return db.prepare(`
    SELECT * FROM auto_orders WHERE status IN ('resting', 'placed') ORDER BY placed_ts DESC
  `).all();
}

// Promote a resting maker order to a held position once it has matched.
export function markAutoOrderFilled(clientOrderId) {
  return db.prepare(`
    UPDATE auto_orders SET status = 'placed'
    WHERE client_order_id = ? AND status = 'resting'
  `).run(clientOrderId);
}

// Record a resting maker order as canceled (TTL expiry or exchange cancel).
// reason is stored in the outcome column for auditability.
export function cancelAutoOrderRecord(clientOrderId, { ts, reason } = {}) {
  return db.prepare(`
    UPDATE auto_orders SET status = 'canceled', outcome = ?, settled_ts = ?
    WHERE client_order_id = ? AND status = 'resting'
  `).run(reason ?? 'canceled', ts ?? null, clientOrderId);
}

export function settleAutoOrder(clientOrderId, { outcome, pnlCents, settledTs }) {
  return db.prepare(`
    UPDATE auto_orders
    SET status = 'settled', outcome = ?, pnl_cents = ?, settled_ts = ?
    WHERE client_order_id = ?
  `).run(outcome, pnlCents, settledTs, clientOrderId);
}

// Mark an auto-order as closed early via SELL (stop-loss / take-profit / manual)
export function closeAutoOrderEarly(clientOrderId, { pnlCents, soldPrice, ts }) {
  return db.prepare(`
    UPDATE auto_orders
    SET status = 'closed_early',
        outcome = ?,
        pnl_cents = ?,
        sold_price = ?,
        settled_ts = ?
    WHERE client_order_id = ?
  `).run(pnlCents > 0 ? 'win' : 'loss', pnlCents, soldPrice ?? null, ts, clientOrderId);
}

export function getAutoOrderSummary() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'placed'  THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN outcome = 'win'    THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN outcome = 'loss'   THEN 1 ELSE 0 END) AS losses,
      COALESCE(SUM(pnl_cents), 0) AS realized_pnl_cents
    FROM auto_orders
  `).get();
  const recent = db.prepare(`
    SELECT ticker, side, entry_price, count, est_fee, role, est_q, est_net_ev,
           placed_ts, status, outcome, pnl_cents, sold_price, settled_ts
    FROM auto_orders ORDER BY placed_ts DESC LIMIT 50
  `).all();
  return { ...totals, recent };
}

// ── Cross-venue arbitrage helpers ────────────────────────────────────────────

// Latest trade per ticker since `sinceMs` (both venues) — last-trade prices are
// the arb detector's indicative quotes.
export function getLatestTradePricesSince(sinceMs) {
  return db.prepare(`
    SELECT t.ticker, t.source, t.side, t.yes_price, t.no_price, t.ts_ms
    FROM trades t
    JOIN (SELECT ticker, MAX(ts_ms) AS m FROM trades WHERE ts_ms > ? GROUP BY ticker) x
      ON t.ticker = x.ticker AND t.ts_ms = x.m
  `).all(sinceMs);
}

// Kalshi tickers with actual trades since `sinceMs` — proven taker flow, used
// by the agent's find_markets discovery (a resting maker order only fills where
// takers exist).
export function getActiveKalshiTickersSince(sinceMs, limit = 30) {
  return db.prepare(`
    SELECT ticker, COUNT(*) AS trades, MAX(ts_ms) AS last_ms
    FROM trades WHERE source = 'kalshi' AND ts_ms > ?
    GROUP BY ticker ORDER BY trades DESC LIMIT ?
  `).all(sinceMs, limit);
}

// Titles for a set of tickers (for cross-venue matching). yes_sub/no_sub carry
// the YES/NO outcome labels — on Kalshi these name the side (e.g. "Argentina"),
// which the arb detector uses to confirm two YES contracts are the same side.
export function getTitlesForTickers(tickers) {
  if (tickers.length === 0) return [];
  const placeholders = tickers.map(() => '?').join(',');
  return db.prepare(`
    SELECT ticker, title, source, close_time, yes_sub, no_sub
    FROM market_titles WHERE ticker IN (${placeholders})
  `).all(...tickers);
}

const insertStmt = () => db.prepare(`
  INSERT OR IGNORE INTO trades (id, trade_id, ticker, category, side, yes_price, no_price, count, ts, ts_ms, source, outcome)
  VALUES (@id, @trade_id, @ticker, @category, @side, @yes_price, @no_price, @count, @ts, @ts_ms, @source, @outcome)
`);

let _insert;
function tradeRow(trade) {
  return {
    id:        trade.id,
    trade_id:  trade.tradeId ?? null,
    ticker:    trade.ticker,
    category:  trade.category,
    side:      trade.side,
    yes_price: trade.yesPrice ?? null,
    no_price:  trade.noPrice  ?? null,
    count:     trade.count,
    ts:        trade.ts,
    ts_ms:     new Date(trade.ts).getTime(),
    source:    trade.source ?? 'kalshi',
    outcome:   trade.outcome ?? null,
  };
}

export function insertTrade(trade) {
  if (!_insert) _insert = insertStmt();
  _insert.run(tradeRow(trade));
}

export function bulkInsert(trades) {
  if (!_insert) _insert = insertStmt();
  const run = db.transaction((rows) => { for (const r of rows) _insert.run(r); });
  run(trades.map(tradeRow));
}

// Allowlisted ORDER BY clauses — never interpolate user input directly into SQL
const ORDER_BY = {
  notional: `CASE t.side WHEN 'yes' THEN t.count * COALESCE(t.yes_price, 0) ELSE t.count * COALESCE(t.no_price, 0) END DESC`,
  time:     `t.ts_ms DESC`,
};

export function getTradesSince(sinceMs, limit = 10_000, minNotional = 0, sortBy = 'time') {
  const minNotionalCents = minNotional * 100;
  const order = ORDER_BY[sortBy] ?? ORDER_BY.time;
  return db.prepare(`
    SELECT t.id, t.trade_id AS tradeId, t.ticker,
           COALESCE(m.category, t.category) AS category,
           t.side, t.outcome, t.source,
           t.yes_price AS yesPrice, t.no_price AS noPrice,
           t.count, t.ts,
           COALESCE(m.title, t.ticker) AS title,
           m.yes_sub AS yesSub, m.no_sub AS noSub,
           m.close_time AS closeTime,
           m.event_start_time AS eventStartTime,
           m.event_actual_start_time AS eventActualStartTime
    FROM trades t
    LEFT JOIN market_titles m ON m.ticker = t.ticker
    WHERE t.ts_ms >= ?
      AND (
        CASE t.side
          WHEN 'yes' THEN t.count * COALESCE(t.yes_price, 0)
          ELSE             t.count * COALESCE(t.no_price,  0)
        END
      ) >= ?
    ORDER BY ${order}
    LIMIT ?
  `).all(sinceMs, minNotionalCents, limit);
}

export function getOldestTradeTs() {
  const row = db.prepare('SELECT MIN(ts_ms) AS v FROM trades').get();
  return row?.v ?? null;
}

export function purgeSmallTrades(minNotionalDollars) {
  const minCents = minNotionalDollars * 100;
  const result = db.prepare(`
    DELETE FROM trades
    WHERE (
      CASE side
        WHEN 'yes' THEN count * COALESCE(yes_price, 0)
        ELSE             count * COALESCE(no_price,  0)
      END
    ) < ?
  `).run(minCents);
  return result.changes;
}

export function getTopMarkets(sinceMs, limit = 100) {
  return db.prepare(`
    SELECT
      t.ticker,
      COALESCE(m.title, '') AS title,
      m.yes_sub AS yesSub,
      m.no_sub  AS noSub,
      COALESCE(m.category, t.category) AS category,
      t.source,
      COUNT(*) AS tradeCount,
      SUM(CASE t.side WHEN 'yes' THEN t.count * COALESCE(t.yes_price, 0)
                                  ELSE t.count * COALESCE(t.no_price,  0) END) / 100 AS totalNotional,
      SUM(CASE WHEN t.side = 'yes' THEN t.count * COALESCE(t.yes_price, 0) ELSE 0 END) / 100 AS yesNotional,
      SUM(CASE WHEN t.side = 'no'  THEN t.count * COALESCE(t.no_price,  0) ELSE 0 END) / 100 AS noNotional
    FROM trades t
    LEFT JOIN market_titles m ON m.ticker = t.ticker
    WHERE t.ts_ms >= ?
    GROUP BY t.ticker
    ORDER BY totalNotional DESC
    LIMIT ?
  `).all(sinceMs, limit);
}

export function getNewestTradeTs() {
  const row = db.prepare('SELECT MAX(ts_ms) AS v FROM trades').get();
  return row?.v ?? null;
}

export function bulkInsertTitles(rows, source = 'kalshi') {
  const stmt = db.prepare(`
    INSERT INTO market_titles (ticker, title, category, yes_sub, no_sub, close_time, event_start_time, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      title            = CASE WHEN excluded.title != '' THEN excluded.title ELSE market_titles.title END,
      category         = COALESCE(excluded.category,         market_titles.category),
      yes_sub          = COALESCE(excluded.yes_sub,          market_titles.yes_sub),
      no_sub           = COALESCE(excluded.no_sub,           market_titles.no_sub),
      close_time       = COALESCE(excluded.close_time,       market_titles.close_time),
      event_start_time = COALESCE(excluded.event_start_time, market_titles.event_start_time),
      source           = COALESCE(market_titles.source,      excluded.source)
  `);
  const run = db.transaction((r) => {
    for (const [ticker, title, category = null, yes_sub = null, no_sub = null, close_time = null, event_start_time = null] of r)
      stmt.run(ticker, title, category, yes_sub, no_sub, close_time, event_start_time, source);
  });
  run(rows);
}

export function getTickerCategoryMap() {
  const rows = db.prepare(`
    SELECT m.ticker, m.category FROM market_titles m
    WHERE m.category IS NOT NULL
      AND m.ticker IN (SELECT DISTINCT ticker FROM trades)
  `).all();
  return new Map(rows.map((r) => [r.ticker, r.category]));
}

export function getTickerMetaMap() {
  // Returns Map<ticker, { closeTime, eventStartTime, eventActualStartTime }>
  // for tickers with active trades.
  const rows = db.prepare(`
    SELECT m.ticker,
           m.close_time AS closeTime,
           m.event_start_time AS eventStartTime,
           m.event_actual_start_time AS eventActualStartTime
    FROM market_titles m
    WHERE (m.close_time IS NOT NULL
        OR m.event_start_time IS NOT NULL
        OR m.event_actual_start_time IS NOT NULL)
      AND m.ticker IN (SELECT DISTINCT ticker FROM trades)
  `).all();
  return new Map(rows.map((r) => [r.ticker, {
    closeTime: r.closeTime,
    eventStartTime: r.eventStartTime,
    eventActualStartTime: r.eventActualStartTime,
  }]));
}

// Tickers traded recently — used by the metadata refresher to keep
// close_time / event_start_time current as Kalshi updates them.
export function getRecentlyActiveTickers(hoursBack = 48) {
  const cutoffMs = Date.now() - Math.floor(hoursBack) * 3600_000;
  return db.prepare(`
    SELECT DISTINCT ticker FROM trades
    WHERE ts_ms >= ?
  `).all(cutoffMs).map((r) => r.ticker);
}

export function refreshMarketMeta(ticker, closeTime, eventStartTime) {
  return db.prepare(`
    UPDATE market_titles
    SET close_time = COALESCE(?, close_time),
        event_start_time = COALESCE(?, event_start_time)
    WHERE ticker = ?
  `).run(closeTime, eventStartTime, ticker);
}

export function setEventActualStartTime(ticker, isoTime) {
  return db.prepare(`
    INSERT INTO market_titles (ticker, title, event_actual_start_time)
    VALUES (?, '', ?)
    ON CONFLICT(ticker) DO UPDATE SET event_actual_start_time = excluded.event_actual_start_time
  `).run(ticker, isoTime);
}

export function getTickerTitleMap() {
  const rows = db.prepare(`
    SELECT m.ticker, m.title FROM market_titles m
    WHERE m.title IS NOT NULL
      AND m.ticker IN (SELECT DISTINCT ticker FROM trades)
  `).all();
  return new Map(rows.map((r) => [r.ticker, r.title]));
}

export function getTitleCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM market_titles').get().n;
}

export function getCategorizedTitleCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM market_titles WHERE category IS NOT NULL').get().n;
}

export function getCloseTimeCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM market_titles WHERE close_time IS NOT NULL').get().n;
}

export function getMissingTitleTickers() {
  return db.prepare(`
    SELECT DISTINCT t.ticker
    FROM trades t
    LEFT JOIN market_titles m ON m.ticker = t.ticker
    WHERE m.title IS NULL OR m.title = ''
  `).all().map(r => r.ticker);
}

// Returns distinct tickers whose category in market_titles is NULL or missing
export function getTickersMissingCategory() {
  return db.prepare(`
    SELECT DISTINCT t.ticker
    FROM trades t
    LEFT JOIN market_titles m ON m.ticker = t.ticker
    WHERE m.category IS NULL
  `).all().map(r => r.ticker);
}

export function bulkUpdateCategories(rows) {
  const stmt = db.prepare(`
    INSERT INTO market_titles (ticker, title, category) VALUES (?, '', ?)
    ON CONFLICT(ticker) DO UPDATE SET
      category = excluded.category,
      title = CASE WHEN market_titles.title != '' THEN market_titles.title ELSE '' END
  `);
  const run = db.transaction((r) => { for (const [ticker, category] of r) stmt.run(ticker, category); });
  run(rows);
}

export function getUniqueSeries() {
  return db.prepare(`
    SELECT DISTINCT substr(ticker, 1, instr(ticker||'-', '-')-1) AS series
    FROM market_titles
  `).all().map(r => r.series);
}

export function updateCategoriesBySeries(seriesCategoryMap) {
  const stmt = db.prepare(`
    UPDATE market_titles SET category = ?
    WHERE category IS NULL
      AND substr(ticker, 1, instr(ticker||'-', '-')-1) = ?
  `);
  const run = db.transaction((map) => {
    for (const [series, category] of map) stmt.run(category, series);
  });
  run(seriesCategoryMap);
}
