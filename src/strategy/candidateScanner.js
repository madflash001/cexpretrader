// Периодический REST-скан кандидатов для momentum (DEX-пара НЕ нужна). По ВСЕМ
// линейным USDT-перпам Gate: fetchTickers → фильтр по объёму/спреду; по шорт-листу
// fetchTrades → markout(30с, персистентность потока) + realized vol. Отбор по
// правилу «markout высок, vol низок» — то, что подтвердилось walk-forward.
import gateFutures from '../connectors/gateFutures.js';
import config from '../config/env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** markout(30с) + realized vol по ленте сделок (ts,price,side). */
function tradeMetrics(trades) {
  const a = trades.filter((t) => t.price > 0 && t.side).sort((x, y) => x.timestamp - y.timestamp);
  const n = a.length;
  if (n < 100) return null;
  let mkSum = 0, mkN = 0, j = 0, vSum = 0, vN = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) { const r = (a[i].price - a[i - 1].price) / a[i - 1].price; vSum += r * r; vN++; }
    if (j < i) j = i; while (j + 1 < n && a[j].timestamp < a[i].timestamp + 30000) j++;
    if (a[j].timestamp >= a[i].timestamp + 30000) {
      const sgn = a[i].side === 'buy' ? 1 : a[i].side === 'sell' ? -1 : 0;
      if (sgn) { mkSum += sgn * (a[j].price - a[i].price) / a[i].price * 1e4; mkN++; }
    }
  }
  if (mkN < 50) return null;
  const spanMin = (a[n - 1].timestamp - a[0].timestamp) / 60000;
  return { markout: mkSum / mkN, rvol: Math.sqrt(vSum / vN) * 100, n, spanMin, tps: n / Math.max(spanMin * 60, 1) };
}

/**
 * Найти шорт-лист кандидатов. Возвращает [{symbol, markout, rvol, spreadBps, score}]
 * отсортированный по score (markout/rvol), длиной ≤ config.scanSelectK.
 */
export async function scanCandidates() {
  await gateFutures.init();
  const syms = gateFutures.listContracts().map((c) => c.symbol);
  let tickers = {};
  try { tickers = await gateFutures.fetchTickers(syms); } catch (e) { console.warn('[scan] fetchTickers:', e.message); return []; }

  // Прелим-фильтр по объёму и спреду (дёшево, один вызов).
  const prelim = [];
  for (const [sym, t] of Object.entries(tickers)) {
    const vol = Number(t.quoteVolume) || 0, bid = Number(t.bid) || 0, ask = Number(t.ask) || 0;
    if (!(bid > 0 && ask > 0)) continue;
    const spreadBps = (ask - bid) / ((ask + bid) / 2) * 1e4;
    if (vol < config.scanMinVolUsd || spreadBps > config.scanMaxSpreadBps) continue;
    prelim.push({ sym, vol, spreadBps });
  }
  prelim.sort((a, b) => b.vol - a.vol);
  const deep = prelim.slice(0, config.scanDeepN);
  console.log(`[scan] перпов ${syms.length} → после фильтра объём/спред ${prelim.length} → глубокий скан ${deep.length}`);

  // Глубокий скан: markout + vol по ленте (по одному REST-запросу на символ, с паузой).
  const scored = [];
  for (const c of deep) {
    try {
      const trades = await gateFutures.fetchTrades(c.sym, 1000);
      const m = tradeMetrics(trades);
      if (m) scored.push({ symbol: c.sym, markout: m.markout, rvol: m.rvol, spreadBps: c.spreadBps, vol: c.vol, tps: m.tps });
    } catch (e) { /* пропускаем символ */ }
    await sleep(60); // бережём rate-limit
  }
  if (!scored.length) return { monitor: [], eligible: [], detail: [] };

  // МОНИТОР: символы с достаточной активностью (есть поток для momentum). Верх по объёму.
  const monitor = scored.filter((s) => s.tps >= config.scanMinTps).sort((a, b) => b.vol - a.vol).slice(0, config.momentumUniverseCap);
  // ELIGIBLE (что реально торговать): валидированное правило markout>медианы & vol<медианы.
  const mkMed = median(monitor.map((s) => s.markout)), vMed = median(monitor.map((s) => s.rvol));
  const eligible = monitor.filter((s) => s.markout > mkMed && s.rvol < vMed && s.markout > 0)
    .sort((a, b) => b.markout - a.markout).slice(0, config.scanSelectK);
  console.log(`[scan] монитор ${monitor.length} (tps≥${config.scanMinTps}); eligible ${eligible.length} (markout>${mkMed.toFixed(1)}bps & vol<${vMed.toFixed(3)}): ${eligible.map((s) => s.symbol.replace('/USDT:USDT', '')).join(', ')}`);
  return { monitor: monitor.map((s) => s.symbol), eligible: eligible.map((s) => s.symbol), detail: eligible };
}

export default { scanCandidates };
