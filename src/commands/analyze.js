// M6 — сравнение стратегий по накопленным sim-позициям. Запуск: npm run analyze.
// Считаем в USD (размеры адаптивные). Учитываем закрытые, частично реализованный
// PnL открытых и mark-to-market остатка (без выживальческого смещения).
import db from '../storage/db.js';
import { config } from '../config/env.js';

const f = (x, d = 2) => Number(x || 0).toFixed(d);

function statFor(closed, open, lastMid) {
  const closedUsd = closed.reduce((a, r) => a + (r.realizedPnlUsd || 0), 0);
  const wins = closed.filter((r) => (r.simPnlPct ?? 0) > 0).length;
  const reason = {};
  for (const r of closed) { const k = r.closeReason || '—'; (reason[k] || (reason[k] = { n: 0, usd: 0 })); reason[k].n++; reason[k].usd += r.realizedPnlUsd || 0; }
  let openRealized = 0, openUnreal = 0;
  for (const p of open) {
    openRealized += p.realizedPnlUsd || 0;
    const entry = p.entryPrice ?? p.openCexPrice;
    const remQty = Math.max(0, (entry > 0 ? p.sizeUsd / entry : 0) - (p.closedQty || 0));
    const mark = lastMid.get(p.symbol)?.mid;
    if (remQty <= 0 || !(mark > 0) || !(entry > 0)) continue;
    const move = p.direction === 'short_perp' ? remQty * (entry - mark) : remQty * (mark - entry);
    openUnreal += move - (remQty * entry) * 2 * (p.takerFeePct || 0) / 100;
  }
  return {
    closedN: closed.length, winRate: closed.length ? (wins / closed.length) * 100 : 0,
    closedUsd, openN: open.length, openRealized, openUnreal,
    total: closedUsd + openRealized + openUnreal, reason,
  };
}

function main() {
  db.init();
  const closedAll = db.getClosedPositions();
  const openAll = db.getOpenPositions();
  if (!closedAll.length && !openAll.length) { console.log('sim-позиций нет. Запустите npm start и дайте поработать.'); process.exit(0); }
  const lastMid = db.getLastMidBySymbol();

  const ids = [...new Set([...closedAll, ...openAll].map((r) => r.strategy || '—'))];
  const rows = ids.map((id) => ({
    id, ...statFor(closedAll.filter((r) => (r.strategy || '—') === id), openAll.filter((r) => (r.strategy || '—') === id), lastMid),
  })).sort((a, b) => b.total - a.total);

  console.log(`\n=== СРАВНЕНИЕ СТРАТЕГИЙ (USD, размер до $${config.tradeSizeUsd}/сделка) ===`);
  console.log('стратегия      закрыто  win%   реализ.$   откр  частич.$   MTM$     ИТОГО$');
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(13)} ${String(r.closedN).padStart(7)} ${f(r.winRate, 0).padStart(5)} ${f(r.closedUsd).padStart(9)} ` +
      `${String(r.openN).padStart(5)} ${f(r.openRealized).padStart(9)} ${f(r.openUnreal).padStart(8)} ${f(r.total).padStart(9)}`,
    );
  }

  const best = rows[0];
  console.log(`\nЛучшая по суммарному PnL: ${best.id} → $${f(best.total)}.`);
  console.log('Разбивка по причине закрытия (реализ. $):');
  for (const r of rows) {
    const parts = Object.entries(r.reason).map(([k, v]) => `${k}:${v.n}/$${f(v.usd)}`).join('  ');
    console.log(`  ${r.id.padEnd(13)} ${parts || '—'}`);
  }
  console.log('\n⚠ Это симуляция (idealized fill по стакану + латентность). Нужен достаточный период и объём сделок для значимости.');
  process.exit(0);
}

main();
