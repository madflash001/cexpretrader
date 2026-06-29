// CEXpreTrader — точка входа. Параллельное сравнение стратегий: один поток данных
// (DEX Swap + цены Gate) → N движков (по стратегии) принимают решения независимо.
// Read-only, без реальных ордеров.
import config from './config/env.js';
import db from './storage/db.js';
import { initGateFeed, stopGateFeed, getOrderBook, contractSize, getFunding, takerFee, cexMid, cexPriceMap } from './feed/gateFeed.js';
import { startDexFeed } from './feed/dexFeed.js';
import { buildWatchlist } from './discovery/buildWatchlist.js';
import { createEngine } from './core/spreadEngine.js';
import { STRATEGIES } from './config/strategies.js';
import { startServer } from './server/server.js';
import { CHAIN_NAME } from './config/chains.js';

const liveSpread = new Map();   // общий «сырой» спред по символу (одинаков для всех стратегий)
const lastTickWrite = new Map();

function logEvent(e) {
  const s = `[${e.strategy}]`;
  if (e.type === 'open') console.log(`${s}[OPEN ] ${e.symbol} ${e.direction} spread=${e.spreadPct.toFixed(3)}% size=$${e.sizeUsd.toFixed(1)}${e.limitedByBand ? ' (огранич.ликв.)' : ''} slip=${e.slipPct.toFixed(3)}%`);
  else if (e.type === 'close') console.log(`${s}[CLOSE:${e.reason}] ${e.symbol} simPnL=${e.simPnlPct.toFixed(3)}% ($${e.realizedUsd.toFixed(3)})`);
  else if (e.type === 'partial_close') console.log(`${s}[PART:${e.reason}] ${e.symbol} закрыто $${e.closedUsd.toFixed(1)}, остаток $${e.remainingUsd.toFixed(1)}`);
  else if (e.type === 'error') console.warn(`${s}[engine:${e.symbol}] ${e.detail}`);
}

async function main() {
  console.log('CEXpreTrader — параллельное сравнение стратегий (read-only)…');
  db.init();

  // Авто-обновление универсума: если watchlist пуст или старше N дней — пересобрать.
  const maxTs = db.getWatchlistMaxTs();
  const ageDays = maxTs ? (Date.now() - maxTs) / 864e5 : Infinity;
  if (ageDays > config.watchlistMaxAgeDays) {
    console.log(maxTs
      ? `[watchlist] устарел (${ageDays.toFixed(1)} дн > ${config.watchlistMaxAgeDays}) — обновляю…`
      : '[watchlist] пуст — собираю символы…');
    await buildWatchlist();
  }

  const watchlist = db.getWatchlist();
  if (!watchlist.length) { console.error('watchlist пуст даже после discover — проверьте ключи Alchemy и доступ к Gate'); process.exit(1); }
  const perChain = {};
  for (const w of watchlist) perChain[w.chainId] = (perChain[w.chainId] || 0) + 1;
  console.log(`[watchlist] ${watchlist.length} символов: ${Object.entries(perChain).map(([k, v]) => `${CHAIN_NAME[k] || k}:${v}`).join(', ')}`);

  const gateSymbols = [...new Set(watchlist.map((w) => w.gateSymbol))];
  await initGateFeed(gateSymbols);
  console.log(`[gate] WS-стакан по ${gateSymbols.length} перпам (ccxt.pro)`);

  // По движку на стратегию (общие зависимости и поток данных).
  const deps = { getOrderBook, getContractSize: contractSize, getFunding, takerFee, onEvent: logEvent };
  const engines = STRATEGIES.map((st) => createEngine(st, deps));
  let rehydrated = 0;
  for (const e of engines) rehydrated += e.rehydrate();
  console.log(`[engines] стратегий: ${engines.length} (${engines.map((e) => e.id).join(', ')})${rehydrated ? ` | восстановлено позиций: ${rehydrated}` : ''}`);
  for (const e of engines) e.startSweep();

  // DEX-фид: считаем спред один раз, пишем тик один раз, рассылаем всем движкам.
  const feed = startDexFeed(
    watchlist,
    (tick) => {
      const mid = cexMid(tick.gateSymbol);
      if (mid == null || !(tick.dexPrice > 0)) return;
      const spreadPct = ((mid - tick.dexPrice) / tick.dexPrice) * 100;
      if (Math.abs(spreadPct) > config.maxSaneSpreadPct) return;

      liveSpread.set(tick.symbol, { symbol: tick.symbol, gateSymbol: tick.gateSymbol, chainId: tick.chainId, dexPrice: tick.dexPrice, cexMid: mid, spreadPct, ts: tick.ts });
      const last = lastTickWrite.get(tick.symbol) || 0;
      if (tick.ts - last >= config.tickThrottleMs) {
        const p = cexPriceMap.get(tick.gateSymbol);
        db.insertTick({ ts: tick.ts, symbol: tick.symbol, chainId: tick.chainId, dexPrice: tick.dexPrice, cexBid: p?.bid ?? null, cexAsk: p?.ask ?? null, spreadPct });
        lastTickWrite.set(tick.symbol, tick.ts);
      }
      const enriched = { ...tick, mid, spreadPct };
      for (const e of engines) e.onDexTick(enriched);
    },
    (st) => console.log(`[dex:${CHAIN_NAME[st.chainId] || st.chainId}] ${st.type}: ${st.detail}`),
  );

  const web = startServer({ engines, liveSpread });

  setInterval(() => {
    const line = engines.map((e) => { const c = e.getCounters(); return `${e.id}:${c.openNow}o/${c.closeCount}c/${c.partialCloseCount}p`; }).join('  ');
    console.log(`[status] символов:${liveSpread.size} | ${line}`);
  }, 20000);

  const shutdown = async () => { console.log('\nОстановка…'); feed.stop(); web.stop(); for (const e of engines) e.stopSweep(); await stopGateFeed().catch(() => {}); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Фатальная ошибка запуска:', e); process.exit(1); });
