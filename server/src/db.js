import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const DB_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../trades.db');

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
  try { db.exec('ALTER TABLE trades ADD COLUMN trade_id TEXT');          } catch { /* already exists */ }

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
      placed_ts       TEXT NOT NULL,
      status          TEXT NOT NULL,
      outcome         TEXT,
      pnl_cents       INTEGER,
      settled_ts      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_orders_status ON auto_orders (status);
  `);
  return db;
}

// ── Auto-trader order helpers ────────────────────────────────────────────────

export function insertAutoOrder(o) {
  return db.prepare(`
    INSERT OR REPLACE INTO auto_orders
      (client_order_id, order_id, ticker, side, entry_price, count, est_fee, placed_ts, status)
    VALUES (@client_order_id, @order_id, @ticker, @side, @entry_price, @count, @est_fee, @placed_ts, @status)
  `).run(o);
}

export function getOpenAutoOrders() {
  return db.prepare(`
    SELECT * FROM auto_orders WHERE status = 'placed' ORDER BY placed_ts DESC
  `).all();
}

export function settleAutoOrder(clientOrderId, { outcome, pnlCents, settledTs }) {
  return db.prepare(`
    UPDATE auto_orders
    SET status = 'settled', outcome = ?, pnl_cents = ?, settled_ts = ?
    WHERE client_order_id = ?
  `).run(outcome, pnlCents, settledTs, clientOrderId);
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
    SELECT * FROM auto_orders ORDER BY placed_ts DESC LIMIT 50
  `).all();
  return { ...totals, recent };
}

const insertStmt = () => db.prepare(`
  INSERT OR IGNORE INTO trades (id, trade_id, ticker, category, side, yes_price, no_price, count, ts, ts_ms)
  VALUES (@id, @trade_id, @ticker, @category, @side, @yes_price, @no_price, @count, @ts, @ts_ms)
`);

let _insert;
export function insertTrade(trade) {
  if (!_insert) _insert = insertStmt();
  _insert.run({
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
  });
}

export function bulkInsert(trades) {
  if (!_insert) _insert = insertStmt();
  const run = db.transaction((rows) => { for (const r of rows) _insert.run(r); });
  run(trades.map(t => ({
    id:        t.id,
    trade_id:  t.tradeId ?? null,
    ticker:    t.ticker,
    category:  t.category,
    side:      t.side,
    yes_price: t.yesPrice ?? null,
    no_price:  t.noPrice  ?? null,
    count:     t.count,
    ts:        t.ts,
    ts_ms:     new Date(t.ts).getTime(),
  })));
}

export function getTradesSince(sinceMs, limit = 10_000, minNotional = 0, sortBy = 'time') {
  const minNotionalCents = minNotional * 100;
  const order = sortBy === 'notional'
    ? `CASE t.side WHEN 'yes' THEN t.count * COALESCE(t.yes_price, 0) ELSE t.count * COALESCE(t.no_price, 0) END DESC`
    : `t.ts_ms DESC`;
  return db.prepare(`
    SELECT t.id, t.trade_id AS tradeId, t.ticker,
           COALESCE(m.category, t.category) AS category,
           t.side,
           t.yes_price AS yesPrice, t.no_price AS noPrice,
           t.count, t.ts,
           m.title, m.yes_sub AS yesSub, m.no_sub AS noSub, m.close_time AS closeTime
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
      COALESCE(m.category, t.category) AS category,
      COUNT(*) AS tradeCount,
      SUM(CASE t.side WHEN 'yes' THEN t.count * COALESCE(t.yes_price, 0)
                                  ELSE t.count * COALESCE(t.no_price,  0) END) / 100 AS totalNotional
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

export function bulkInsertTitles(rows) {
  const stmt = db.prepare(`
    INSERT INTO market_titles (ticker, title, category, yes_sub, no_sub, close_time) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET
      title      = CASE WHEN excluded.title != '' THEN excluded.title ELSE market_titles.title END,
      category   = COALESCE(excluded.category,   market_titles.category),
      yes_sub    = COALESCE(excluded.yes_sub,    market_titles.yes_sub),
      no_sub     = COALESCE(excluded.no_sub,     market_titles.no_sub),
      close_time = COALESCE(excluded.close_time, market_titles.close_time)
  `);
  const run = db.transaction((r) => {
    for (const [ticker, title, category = null, yes_sub = null, no_sub = null, close_time = null] of r)
      stmt.run(ticker, title, category, yes_sub, no_sub, close_time);
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
