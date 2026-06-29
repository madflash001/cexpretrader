// Хранилище на SQLite (better-sqlite3, синхронный API).
// Таблицы: watchlist (универсум пулов), spread_ticks (сырьё спреда),
// sim_positions (виртуальные round-trip позиции — без реальных ордеров).
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config/env.js';

let db;

export function init() {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol         TEXT    NOT NULL,           -- базовый токен, напр. BTC
      gate_symbol    TEXT    NOT NULL,           -- ccxt-перп, напр. BTC/USDT:USDT
      chain_id       INTEGER NOT NULL,
      dex            TEXT    NOT NULL,
      pool_address   TEXT    NOT NULL,
      token_address  TEXT    NOT NULL,
      quote_symbol   TEXT    NOT NULL,
      decimals       INTEGER NOT NULL,
      quote_decimals INTEGER NOT NULL,
      token_is_first INTEGER NOT NULL,
      fee            INTEGER NOT NULL,
      liquidity_usd  REAL    NOT NULL,
      created_ts     INTEGER NOT NULL,
      UNIQUE(symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_chain ON watchlist(chain_id);
    CREATE INDEX IF NOT EXISTS idx_watch_pool  ON watchlist(pool_address);

    CREATE TABLE IF NOT EXISTS spread_ticks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      symbol     TEXT    NOT NULL,
      chain_id   INTEGER NOT NULL,
      dex_price  REAL    NOT NULL,
      cex_bid    REAL,
      cex_ask    REAL,
      spread_pct REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tick_sym_ts ON spread_ticks(symbol, ts);

    -- Виртуальные позиции: открытие при расширении спреда, закрытие при схождении.
    CREATE TABLE IF NOT EXISTS sim_positions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy         TEXT,                     -- id стратегии (параллельное сравнение)
      symbol           TEXT    NOT NULL,
      gate_symbol      TEXT,                     -- ccxt-перп (для закрытия по стакану)
      chain_id         INTEGER NOT NULL,
      direction        TEXT    NOT NULL,         -- 'long_perp' | 'short_perp'
      opened_ts        INTEGER NOT NULL,
      closed_ts        INTEGER,
      open_spread_pct  REAL    NOT NULL,
      close_spread_pct REAL,
      open_dex_price   REAL    NOT NULL,
      open_cex_price   REAL    NOT NULL,         -- mid перпа в момент СИГНАЛА (референс)
      entry_price      REAL,                     -- VWAP фактического входа (после латентности)
      exit_price       REAL,                     -- средневзвеш. VWAP выхода (по всем частичным закрытиям)
      size_usd         REAL,                     -- исполненный нотионал входа (исходный размер)
      closed_qty       REAL    DEFAULT 0,        -- закрыто токенов (для частичного закрытия)
      realized_pnl_usd REAL    DEFAULT 0,        -- накопленный реализованный PnL, USD
      sim_pnl_pct      REAL,
      taker_fee_pct    REAL    NOT NULL DEFAULT 0,
      funding_pct      REAL    NOT NULL DEFAULT 0,
      close_reason     TEXT,                     -- 'converge' | 'timestop' | 'divergence'
      status           TEXT    NOT NULL          -- 'open' | 'closed'
    );
    CREATE INDEX IF NOT EXISTS idx_pos_status ON sim_positions(status);
    CREATE INDEX IF NOT EXISTS idx_pos_sym    ON sim_positions(symbol);
  `);

  // Лёгкие миграции для уже существующей БД (новые колонки realism-апгрейда).
  addColumnIfMissing('sim_positions', 'strategy', 'TEXT');
  addColumnIfMissing('sim_positions', 'gate_symbol', 'TEXT');
  addColumnIfMissing('sim_positions', 'entry_price', 'REAL');
  addColumnIfMissing('sim_positions', 'exit_price', 'REAL');
  addColumnIfMissing('sim_positions', 'size_usd', 'REAL');
  addColumnIfMissing('sim_positions', 'closed_qty', 'REAL');
  addColumnIfMissing('sim_positions', 'realized_pnl_usd', 'REAL');
  addColumnIfMissing('sim_positions', 'close_reason', 'TEXT');
  return db;
}

/** ALTER TABLE ADD COLUMN, если колонки ещё нет (идемпотентно). */
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// ── watchlist ──────────────────────────────────────────────────────────────
/** Полная замена универсума (вызывается командой discover). */
export function replaceWatchlist(rows) {
  const del = db.prepare('DELETE FROM watchlist');
  const ins = db.prepare(`
    INSERT INTO watchlist
      (symbol, gate_symbol, chain_id, dex, pool_address, token_address, quote_symbol,
       decimals, quote_decimals, token_is_first, fee, liquidity_usd, created_ts)
    VALUES
      (@symbol, @gateSymbol, @chainId, @dex, @poolAddress, @tokenAddress, @quoteSymbol,
       @decimals, @quoteDecimals, @tokenIsFirst, @fee, @liquidityUsd, @createdTs)
  `);
  const tx = db.transaction((list) => { del.run(); for (const r of list) ins.run(r); });
  tx(rows);
}

export function getWatchlist() {
  return db.prepare(`
    SELECT symbol, gate_symbol AS gateSymbol, chain_id AS chainId, dex,
           pool_address AS poolAddress, token_address AS tokenAddress, quote_symbol AS quoteSymbol,
           decimals, quote_decimals AS quoteDecimals, token_is_first AS tokenIsFirst,
           fee, liquidity_usd AS liquidityUsd
    FROM watchlist ORDER BY chain_id, liquidity_usd DESC
  `).all();
}

/** Время самой свежей записи watchlist (мс) или 0, если таблица пуста. */
export function getWatchlistMaxTs() {
  const row = db.prepare('SELECT MAX(created_ts) AS mx FROM watchlist').get();
  return row && row.mx ? Number(row.mx) : 0;
}

// ── spread_ticks ─────────────────────────────────────────────────────────────
export function insertTick(row) {
  db.prepare(`
    INSERT INTO spread_ticks (ts, symbol, chain_id, dex_price, cex_bid, cex_ask, spread_pct)
    VALUES (@ts, @symbol, @chainId, @dexPrice, @cexBid, @cexAsk, @spreadPct)
  `).run(row);
}

// ── sim_positions ────────────────────────────────────────────────────────────
export function openPosition(row) {
  const info = db.prepare(`
    INSERT INTO sim_positions
      (strategy, symbol, gate_symbol, chain_id, direction, opened_ts, open_spread_pct, open_dex_price, open_cex_price,
       entry_price, size_usd, taker_fee_pct, funding_pct, status)
    VALUES
      (@strategy, @symbol, @gateSymbol, @chainId, @direction, @openedTs, @openSpreadPct, @openDexPrice, @openCexPrice,
       @entryPrice, @sizeUsd, @takerFeePct, @fundingPct, 'open')
  `).run(row);
  return info.lastInsertRowid;
}

/** Частичное закрытие: позиция остаётся 'open', копятся closed_qty/realized_pnl_usd. */
export function updatePartialClose(id, row) {
  db.prepare(`
    UPDATE sim_positions
       SET closed_qty = @closedQty, realized_pnl_usd = @realizedPnlUsd, exit_price = @exitPrice
     WHERE id = @id
  `).run({ id, ...row });
}

/** Финальное закрытие позиции (остаток исчерпан). */
export function closePosition(id, row) {
  db.prepare(`
    UPDATE sim_positions
       SET closed_ts = @closedTs, close_spread_pct = @closeSpreadPct, exit_price = @exitPrice,
           closed_qty = @closedQty, realized_pnl_usd = @realizedPnlUsd,
           sim_pnl_pct = @simPnlPct, funding_pct = @fundingPct, close_reason = @closeReason, status = 'closed'
     WHERE id = @id
  `).run({ id, ...row });
}

export function getOpenPositions(strategy) {
  const base = `
    SELECT id, strategy, symbol, gate_symbol AS gateSymbol, chain_id AS chainId, direction, opened_ts AS openedTs,
           open_spread_pct AS openSpreadPct, open_dex_price AS openDexPrice,
           open_cex_price AS openCexPrice, entry_price AS entryPrice, exit_price AS exitPrice, size_usd AS sizeUsd,
           closed_qty AS closedQty, realized_pnl_usd AS realizedPnlUsd,
           taker_fee_pct AS takerFeePct, funding_pct AS fundingPct
    FROM sim_positions WHERE status = 'open'`;
  if (strategy) return db.prepare(base + ' AND strategy = ?').all(strategy);
  return db.prepare(base).all();
}

export function getRecentPositions(limit = 200) {
  return db.prepare(`
    SELECT strategy, symbol, chain_id AS chainId, direction, opened_ts AS openedTs, closed_ts AS closedTs,
           open_spread_pct AS openSpreadPct, close_spread_pct AS closeSpreadPct,
           entry_price AS entryPrice, exit_price AS exitPrice, size_usd AS sizeUsd,
           closed_qty AS closedQty, realized_pnl_usd AS realizedPnlUsd,
           sim_pnl_pct AS simPnlPct, taker_fee_pct AS takerFeePct, funding_pct AS fundingPct,
           close_reason AS closeReason, status
    FROM sim_positions ORDER BY opened_ts DESC LIMIT ?
  `).all(limit);
}

/** Все закрытые позиции (для анализа M6). */
export function getClosedPositions() {
  return db.prepare(`
    SELECT strategy, symbol, chain_id AS chainId, direction, opened_ts AS openedTs, closed_ts AS closedTs,
           open_spread_pct AS openSpreadPct, close_spread_pct AS closeSpreadPct,
           entry_price AS entryPrice, exit_price AS exitPrice, size_usd AS sizeUsd,
           closed_qty AS closedQty, realized_pnl_usd AS realizedPnlUsd,
           sim_pnl_pct AS simPnlPct, taker_fee_pct AS takerFeePct, funding_pct AS fundingPct,
           close_reason AS closeReason
    FROM sim_positions WHERE status = 'closed' ORDER BY closed_ts ASC
  `).all();
}

/** Последний mid перпа по символу из spread_ticks (для mark-to-market в analyze). */
export function getLastMidBySymbol() {
  const rows = db.prepare(`
    SELECT t.symbol, t.cex_bid AS bid, t.cex_ask AS ask, t.dex_price AS dexPrice, t.ts
    FROM spread_ticks t
    JOIN (SELECT symbol, MAX(ts) AS mx FROM spread_ticks GROUP BY symbol) m
      ON m.symbol = t.symbol AND m.mx = t.ts
  `).all();
  const map = new Map();
  for (const r of rows) {
    const mid = (r.bid > 0 && r.ask > 0) ? (r.bid + r.ask) / 2 : null;
    map.set(r.symbol, { mid, dexPrice: r.dexPrice, ts: r.ts });
  }
  return map;
}

export default {
  init, replaceWatchlist, getWatchlist, getWatchlistMaxTs,
  insertTick, openPosition, updatePartialClose, closePosition, getOpenPositions, getRecentPositions, getClosedPositions,
  getLastMidBySymbol,
};
