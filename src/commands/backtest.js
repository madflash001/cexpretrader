// Бэктест-движок с МОДЕЛЬЮ ЛАТЕНТНОСТИ: реплей spread_ticks под разные правила.
// Запуск: node src/commands/backtest.js
//
// Латентность: решение принимается по value на тике сигнала, но ФИЛЛ — по bid/ask
// тика, наступающего через latencyMs после сигнала (цена успевает уйти) — как в live.
// Прочее как раньше: fills по bid/ask (без глубокого слиппеджа), фикс $100,
// комиссия 0.05%/сторона, EMA по сохранённым (тротл-250мс) тикам.
// → не 1:1 с live (нет глубины стакана/адаптивного сайзинга), но изолирует эффект латентности.
import Database from 'better-sqlite3';
import { STRATEGIES } from '../config/strategies.js';
import config from '../config/env.js';

const FEE = 0.0005;
const MIN = 60000;
const LAT = config.executionLatencyMs; // как в live (дефолт 100мс на токийском сервере)

const d = new Database(config.dbPath, { readonly: true });
const ROWS = d.prepare('SELECT ts, symbol, cex_bid AS bid, cex_ask AS ask, spread_pct AS spread FROM spread_ticks WHERE cex_bid>0 AND cex_ask>0 ORDER BY ts ASC').all();
// по-символьные временные ряды (для поиска «цены через latencyMs»)
const BYSYM = new Map();
for (const r of ROWS) { let a = BYSYM.get(r.symbol); if (!a) BYSYM.set(r.symbol, a = []); a.push(r); }

/** run: opts {timestopMs, latencyMs, mode(symbol), cooldown:{strikes,ms}} */
function run(strat, opts) {
  const { timestopMs, latencyMs = LAT, mode = () => 'normal', cooldown = null } = opts;
  const trades = [];
  for (const [sym, arr] of BYSYM) {
    if (mode(sym) === 'exclude') continue;
    const rev = mode(sym) === 'reverse';
    let emaV = null, n = 0, pos = null, cdUntil = 0, strikes = 0;
    const fillAt = (i) => { const tt = arr[i].ts + latencyMs; let j = i; while (j + 1 < arr.length && arr[j].ts < tt) j++; return arr[j]; };
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      let value, ready;
      if (strat.type === 'threshold') { value = t.spread; ready = true; }
      else { if (emaV === null) emaV = t.spread; const prev = emaV; emaV = prev + strat.emaAlpha * (t.spread - prev); n++; value = t.spread - prev; ready = n >= strat.minSamples; }
      if (!pos) {
        if (!ready || t.ts < cdUntil) continue;
        if (Math.abs(value) >= strat.openLevel) {
          let dir = value > 0 ? 'short' : 'long'; if (rev) dir = dir === 'short' ? 'long' : 'short';
          const ft = fillAt(i); const entry = dir === 'short' ? ft.bid : ft.ask;
          if (entry > 0) pos = { dir, entry, openTs: t.ts, entrySign: Math.sign(value) };
        }
        continue;
      }
      const absV = Math.abs(value);
      let reason = null;
      if (absV <= strat.closeLevel) reason = 'converge';
      else if (Math.sign(value) === pos.entrySign && absV >= strat.stopLevel) reason = 'divergence';
      else if (t.ts - pos.openTs >= timestopMs) reason = 'timestop';
      if (reason) {
        const ft = fillAt(i); const exit = pos.dir === 'short' ? ft.ask : ft.bid;
        if (exit > 0) {
          const gross = pos.dir === 'short' ? (pos.entry - exit) / pos.entry : (exit - pos.entry) / pos.entry;
          const pnlUsd = (gross - 2 * FEE) * 100;
          trades.push({ symbol: sym, reason, pnlUsd });
          if (cooldown) { if (reason !== 'converge' || pnlUsd < 0) { strikes++; if (strikes >= cooldown.strikes) { cdUntil = t.ts + cooldown.ms; strikes = 0; } } else strikes = 0; }
        }
        pos = null;
      }
    }
    if (pos) { const ft = arr[arr.length - 1]; const exit = pos.dir === 'short' ? ft.ask : ft.bid; if (exit > 0) { const g = pos.dir === 'short' ? (pos.entry - exit) / pos.entry : (exit - pos.entry) / pos.entry; trades.push({ symbol: sym, reason: 'eod', pnlUsd: (g - 2 * FEE) * 100 }); } }
  }
  return summarize(trades);
}

function summarize(trades) {
  let usd = 0, w = 0; const byReason = {}; const bySym = {};
  for (const t of trades) { usd += t.pnlUsd; if (t.pnlUsd > 0) w++; (byReason[t.reason] || (byReason[t.reason] = { n: 0, usd: 0 })); byReason[t.reason].n++; byReason[t.reason].usd += t.pnlUsd; (bySym[t.symbol] || (bySym[t.symbol] = { n: 0, usd: 0 })); bySym[t.symbol].n++; bySym[t.symbol].usd += t.pnlUsd; }
  return { n: trades.length, usd, winRate: trades.length ? 100 * w / trades.length : 0, byReason, bySym };
}

const f = (x) => Number(x || 0).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const pl = (s, n) => String(s).padStart(n);

console.log(`Бэктест с латентностью. Тиков: ${ROWS.length}, символов: ${BYSYM.size}. Fee 0.05%/сторона, $100, fills по bid/ask.\n`);

// ── A. Свип латентности (тайм-стоп 30) — объясняет ли латентность разрыв с live ──
console.log('=== A. ЧУВСТВИТЕЛЬНОСТЬ К ЛАТЕНТНОСТИ (тайм-стоп 30, PnL$) ===');
const LATS = [0, 150, 300, 600, 1000];
console.log(pad('стратегия', 14), ...LATS.map((l) => pl(l + 'мс', 9)));
for (const s of STRATEGIES) console.log(pad(s.id, 14), ...LATS.map((l) => pl(f(run(s, { timestopMs: 30 * MIN, latencyMs: l }).usd), 9)));

console.log(`\n>>> Дальше всё при латентности ${LAT}мс (как в live) <<<`);

// ── B. Базлайн при LAT + множество лузеров ──
const base = {};
for (const s of STRATEGIES) base[s.id] = run(s, { timestopMs: 30 * MIN });
const loserUsd = {};
for (const s of STRATEGIES) for (const [sym, v] of Object.entries(base[s.id].bySym)) loserUsd[sym] = (loserUsd[sym] || 0) + v.usd;
const losers = new Set(Object.entries(loserUsd).filter(([, u]) => u < 0).map(([s]) => s));
console.log(`\n=== B. БАЗЛАЙН (тайм-стоп 30, латентность ${LAT}мс) ===`);
console.log(pad('стратегия', 14), pl('сделок', 7), pl('win%', 6), pl('PnL$', 10));
for (const s of STRATEGIES) console.log(pad(s.id, 14), pl(base[s.id].n, 7), pl((base[s.id].winRate).toFixed(0), 6), pl(f(base[s.id].usd), 10));
console.log(`Лузеров: ${losers.size}/${Object.keys(loserUsd).length}`);

// ── C. Реверс/исключение лузеров ──
console.log('\n=== C. ЛУЗЕРЫ: обычно / исключить / реверс ===');
console.log(pad('стратегия', 14), pl('обычно$', 10), pl('исключ$', 10), pl('реверс$', 10));
let aN = 0, aE = 0, aR = 0;
for (const s of STRATEGIES) {
  const e = run(s, { timestopMs: 30 * MIN, mode: (x) => (losers.has(x) ? 'exclude' : 'normal') }).usd;
  const r = run(s, { timestopMs: 30 * MIN, mode: (x) => (losers.has(x) ? 'reverse' : 'normal') }).usd;
  aN += base[s.id].usd; aE += e; aR += r;
  console.log(pad(s.id, 14), pl(f(base[s.id].usd), 10), pl(f(e), 10), pl(f(r), 10));
}
console.log(pad('ИТОГО', 14), pl(f(aN), 10), pl(f(aE), 10), pl(f(aR), 10));

// ── D. Свип тайм-стопа ──
console.log('\n=== D. ТАЙМ-СТОП 15/30/45/60 мин (PnL$) ===');
const TS = [15, 30, 45, 60]; const tsRes = {};
console.log(pad('стратегия', 14), ...TS.map((m) => pl(m + 'м', 9)));
for (const s of STRATEGIES) { tsRes[s.id] = TS.map((m) => run(s, { timestopMs: m * MIN }).usd); console.log(pad(s.id, 14), ...tsRes[s.id].map((u) => pl(f(u), 9))); }
const bestTs = {};
for (const s of STRATEGIES) { let bi = 0; tsRes[s.id].forEach((u, i) => { if (u > tsRes[s.id][bi]) bi = i; }); bestTs[s.id] = TS[bi]; }

// ── E. Кулдаун-автоотсев (на лучшем тайм-стопе) ──
console.log('\n=== E. КУЛДАУН (на лучшем тайм-стопе; пауза, не отключение навсегда) ===');
const GRID = [{ strikes: 1, min: 30 }, { strikes: 1, min: 60 }, { strikes: 2, min: 60 }, { strikes: 2, min: 120 }, { strikes: 3, min: 120 }];
console.log(pad('стратегия', 14), pl('TS', 5), pl('безCD$', 9), ...GRID.map((g) => pl(`K${g.strikes}/${g.min}`, 9)));
const cdRes = {};
for (const s of STRATEGIES) {
  const ts = bestTs[s.id] * MIN; const noCd = run(s, { timestopMs: ts }).usd;
  const row = GRID.map((g) => run(s, { timestopMs: ts, cooldown: { strikes: g.strikes, ms: g.min * MIN } }).usd);
  cdRes[s.id] = { ts: bestTs[s.id], noCd, row };
  console.log(pad(s.id, 14), pl(bestTs[s.id] + 'м', 5), pl(f(noCd), 9), ...row.map((u) => pl(f(u), 9)));
}

// ── F. Итог: лучший вариант каждой стратегии ──
console.log('\n=== F. ИТОГ при латентности ' + LAT + 'мс: лучший вариант ===');
console.log(pad('стратегия', 14), pl('базлайн$', 10), pl('лучший$', 10), '  конфиг');
const finals = [];
for (const s of STRATEGIES) {
  const cands = [{ usd: base[s.id].usd, cfg: 'TS30 baseline' }, { usd: cdRes[s.id].noCd, cfg: `TS${cdRes[s.id].ts}` }];
  GRID.forEach((g, i) => cands.push({ usd: cdRes[s.id].row[i], cfg: `TS${cdRes[s.id].ts}+CD K${g.strikes}/${g.min}м` }));
  let best = cands[0]; for (const c of cands) if (c.usd > best.usd) best = c;
  finals.push({ id: s.id, base: base[s.id].usd, best });
}
finals.sort((a, b) => b.best.usd - a.best.usd);
for (const r of finals) console.log(pad(r.id, 14), pl(f(r.base), 10), pl(f(r.best.usd), 10), '  ' + r.best.cfg);
process.exit(0);
