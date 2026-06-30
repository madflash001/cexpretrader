// Хранилище на SQLite (better-sqlite3, синхронный API).
// Таблицы: watchlist (универсум пулов), spread_ticks (DEX-цена + CEX bid/ask — сырьё
// для теста DEX-догоняния), cex_trades (лента сделок Gate — сырьё для MM-теста).
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

    -- DEX-цена (из Swap) + CEX bid/ask на момент тика. Сырьё теста DEX-догоняния.
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

    -- Лента сделок Gate-перпа + топ-of-book на момент сделки. Сырьё MM-теста.
    CREATE TABLE IF NOT EXISTS cex_trades (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,                   -- время сделки (мс)
      symbol TEXT    NOT NULL,                   -- gate-символ перпа
      price  REAL    NOT NULL,
      amount REAL    NOT NULL,                   -- объём (контракты/база)
      side   TEXT,                               -- сторона тейкера: 'buy' | 'sell'
      bid    REAL,                               -- топ bid в момент записи
      ask    REAL                                -- топ ask в момент записи
    );
    CREATE INDEX IF NOT EXISTS idx_trades_sym_ts ON cex_trades(symbol, ts);
  `);
  return db;
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

// ── cex_trades ───────────────────────────────────────────────────────────────
const insTrade = () => db.prepare(`
  INSERT INTO cex_trades (ts, symbol, price, amount, side, bid, ask)
  VALUES (@ts, @symbol, @price, @amount, @side, @bid, @ask)
`);
let _insTrade = null;
/** Батч-вставка трейдов в одной транзакции (вызывать по таймеру, не построчно). */
export function insertTrades(rows) {
  if (!rows.length) return;
  if (!_insTrade) _insTrade = insTrade();
  const tx = db.transaction((list) => { for (const r of list) _insTrade.run(r); });
  tx(rows);
}

/** Статистика сбора по символам: число трейдов, первый/последний ts. */
export function getTradeStats() {
  return db.prepare(`
    SELECT symbol, COUNT(*) AS n, MIN(ts) AS firstTs, MAX(ts) AS lastTs
    FROM cex_trades GROUP BY symbol ORDER BY n DESC
  `).all();
}

export default {
  init, replaceWatchlist, getWatchlist, getWatchlistMaxTs,
  insertTick, insertTrades, getTradeStats,
};
