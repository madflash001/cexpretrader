// Хранилище на SQLite (better-sqlite3). Таблицы: cex_trades (лента Gate — сырьё для
// ре-бэктеста), of_positions (paper-позиции order-flow momentum).
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
    CREATE TABLE IF NOT EXISTS cex_trades (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      symbol TEXT    NOT NULL,
      price  REAL    NOT NULL,
      amount REAL    NOT NULL,
      side   TEXT,
      bid    REAL,
      ask    REAL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_sym_ts ON cex_trades(symbol, ts);

    CREATE TABLE IF NOT EXISTS of_positions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      open_ts    INTEGER NOT NULL,
      close_ts   INTEGER NOT NULL,
      symbol     TEXT    NOT NULL,
      direction  TEXT    NOT NULL,
      entry      REAL    NOT NULL,
      exit       REAL    NOT NULL,
      size_usd   REAL    NOT NULL,
      reason     TEXT,
      pnl_usd    REAL    NOT NULL,
      ofi        REAL,
      vol        REAL
    );
    CREATE INDEX IF NOT EXISTS idx_ofpos_sym_ts ON of_positions(symbol, open_ts);
  `);
  return db;
}

// ── cex_trades ───────────────────────────────────────────────────────────────
let _insTrade = null;
export function insertTrades(rows) {
  if (!rows.length) return;
  if (!_insTrade) _insTrade = db.prepare('INSERT INTO cex_trades (ts, symbol, price, amount, side, bid, ask) VALUES (@ts, @symbol, @price, @amount, @side, @bid, @ask)');
  const tx = db.transaction((list) => { for (const r of list) _insTrade.run(r); });
  tx(rows);
}
export function getTradeStats() {
  return db.prepare('SELECT symbol, COUNT(*) AS n, MIN(ts) AS firstTs, MAX(ts) AS lastTs FROM cex_trades GROUP BY symbol ORDER BY n DESC').all();
}

// ── of_positions ─────────────────────────────────────────────────────────────
export function insertOfPosition(r) {
  db.prepare(`INSERT INTO of_positions (open_ts, close_ts, symbol, direction, entry, exit, size_usd, reason, pnl_usd, ofi, vol)
    VALUES (@openTs, @closeTs, @symbol, @direction, @entry, @exit, @sizeUsd, @reason, @pnlUsd, @ofi, @vol)`).run(r);
}
export function getOfStats() {
  const tot = db.prepare('SELECT COUNT(*) n, ROUND(SUM(pnl_usd),3) pnl, SUM(CASE WHEN pnl_usd>0 THEN 1 ELSE 0 END) wins FROM of_positions').get();
  const byReason = db.prepare('SELECT reason, COUNT(*) n, ROUND(SUM(pnl_usd),3) pnl FROM of_positions GROUP BY reason').all();
  const bySym = db.prepare('SELECT symbol, COUNT(*) n, ROUND(SUM(pnl_usd),3) pnl FROM of_positions GROUP BY symbol ORDER BY pnl DESC').all();
  return { n: tot.n || 0, pnl: tot.pnl || 0, wins: tot.wins || 0, byReason, bySym };
}

export default { init, insertTrades, getTradeStats, insertOfPosition, getOfStats };
