// CEXpreTrader — сбор данных для двух тестов (read-only, без ордеров):
//  • DEX-догоняние: DEX-цена (Swap) + CEX bid/ask → spread_ticks.
//  • MM на CEX: лента сделок Gate + топ-of-book → cex_trades.
// Симуляторы/бэктесты обоих — офлайн-скрипты поверх собранных данных.
import config from './config/env.js';
import db from './storage/db.js';
import { initGateFeed, addMomentumSymbols, cexMid, cexPriceMap } from './feed/gateFeed.js';
import { startDexFeed } from './feed/dexFeed.js';
import { quoteBuy } from './connectors/dexQuoter.js';
import { createMomentumEngine } from './strategy/ofMomentum.js';
import { scanCandidates } from './strategy/candidateScanner.js';
import { startServer } from './server/server.js';
import { CHAIN_NAME } from './config/chains.js';

const liveSpread = new Map();   // символ -> текущий спред (для дашборда/DEX-теста)
const lastTickWrite = new Map();
const tradeBuf = [];            // буфер трейдов CEX (флашится батчем раз в секунду)
const quoteBuf = [];            // буфер Quoter-замеров DEX
const lastQuoteTs = new Map();  // троттл Quoter-замера на символ
let tradesCollected = 0;
let quotesCollected = 0;

/** Quoter-замер исполнимой цены покупки на размеры QUOTE_SIZES (async, не блокирует тик). */
async function probeQuotes(w, ts, mid) {
  for (const size of config.quoteSizesUsd) {
    try {
      const exec = await quoteBuy(w, size);
      if (exec > 0) quoteBuf.push({
        ts, symbol: w.symbol, chainId: w.chainId, sizeUsd: size,
        midPrice: mid, execPrice: exec, slippagePct: mid > 0 ? (exec - mid) / mid * 100 : null,
      });
    } catch { /* публичная нода могла лимитнуть — пропускаем замер */ }
  }
}

/** Выбор символов для сбора ленты: из env TRADE_SYMBOLS или топ-N по ликвидности. */
function pickTradeSymbols(watchlist) {
  if (config.tradeSymbols.length) {
    const set = new Set(config.tradeSymbols.map((s) => s.toUpperCase()));
    return watchlist.filter((w) => set.has(w.symbol.toUpperCase()));
  }
  return [...watchlist].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, config.tradeSymbolsLimit);
}

async function main() {
  console.log('CEXpreTrader — сбор данных (DEX-догоняние + MM на CEX), read-only…');
  db.init();

  const watchlist = db.getWatchlist();
  if (!watchlist.length) { console.error('watchlist пуст — сначала: npm run discover'); process.exit(1); }
  const maxTs = db.getWatchlistMaxTs();
  const ageDays = maxTs ? (Date.now() - maxTs) / 864e5 : Infinity;
  if (ageDays > config.watchlistMaxAgeDays) {
    console.log(`watchlist устарел (${ageDays === Infinity ? 'пуст' : ageDays.toFixed(1) + ' дн'}) — обновляю…`);
    const { buildWatchlist } = await import('./discovery/buildWatchlist.js');
    await buildWatchlist();
  }

  const perChain = {};
  for (const w of watchlist) perChain[w.chainId] = (perChain[w.chainId] || 0) + 1;
  console.log(`[watchlist] ${watchlist.length} символов: ${Object.entries(perChain).map(([k, v]) => `${CHAIN_NAME[k] || k}:${v}`).join(', ')}`);

  // Order-flow momentum (paper) — тот же поток трейдов кормит стратегию.
  let ofmClosed = 0, ofmPnl = 0;
  const momentum = config.ofmEnabled ? createMomentumEngine({
    onEvent: (e) => {
      if (e.type === 'open') console.log(`[ofm][OPEN ] ${e.sym} ${e.dir > 0 ? 'long' : 'short'} @${e.entry}`);
      else if (e.type === 'close') console.log(`[ofm][CLOSE:${e.reason}] ${e.sym} paperPnL=$${e.pnlUsd.toFixed(3)}`);
    },
    recordPosition: (p) => { try { db.insertOfPosition(p); ofmClosed++; ofmPnl += p.pnlUsd; } catch (err) { console.error('[ofm] insert:', err.message); } },
  }) : null;
  if (momentum) console.log(`[ofm] paper-стратегия ВКЛ: сильный OFI(${config.ofmOfiPct}) + низкий вол(${config.ofmVolPct}), цель ${config.ofmTargetBps}/стоп ${config.ofmStopBps} bps, размер $${config.ofmSizeUsd}`);

  // Callback ленты: складываем трейды в буфер с топ-of-book + кормим momentum.
  const onTrades = (gateSymbol, trades) => {
    const p = cexPriceMap.get(gateSymbol);
    for (const t of trades) {
      const ts = t.timestamp ?? Date.now(), price = Number(t.price) || 0, amount = Number(t.amount) || 0, side = t.side ?? null;
      tradeBuf.push({ ts, symbol: gateSymbol, price, amount, side, bid: p?.bid ?? null, ask: p?.ask ?? null });
      if (momentum && price > 0) momentum.onTrade(gateSymbol, { ts, price, amount, side }, p);
    }
  };

  // WS-цены по watchlist (нужны для DEX-догоняния spread_ticks).
  const gateSymbols = [...new Set(watchlist.map((w) => w.gateSymbol))];
  await initGateFeed(gateSymbols);
  console.log(`[gate] WS-цены по ${gateSymbols.length} перпам (watchlist, для DEX-теста)`);

  // Momentum-универсум: DEX-пара НЕ нужна. Сканер по ВСЕМ перпам (REST) → набор
  // мониторинга (WS: цена+лента) + eligible (что реально торговать). Пересканируем.
  if (config.momentumScan) {
    const doScan = async () => {
      try {
        const r = await scanCandidates();
        if (r.monitor.length) {
          const { total, added } = addMomentumSymbols(r.monitor, onTrades);
          momentum?.setEligible(new Set(r.eligible));
          console.log(`[scan] WS-универсум momentum: ${total} (+${added}); eligible к торговле: ${r.eligible.length}`);
        }
      } catch (e) { console.error('[scan] ошибка:', e.message); }
    };
    await doScan();
    setInterval(doScan, config.scanIntervalMs);
  } else {
    // Фолбэк без сканера: лента по DEX-символам watchlist (как раньше).
    const rows = pickTradeSymbols(watchlist);
    addMomentumSymbols(rows.map((w) => w.gateSymbol), onTrades);
    console.log(`[mm] сканер выкл — лента по ${rows.length} watchlist-символам`);
  }

  // Флаш буфера трейдов батчем (раз в секунду) — не построчно (см. db.insertTrades).
  const flushTimer = setInterval(() => {
    if (tradeBuf.length) {
      const batch = tradeBuf.splice(0, tradeBuf.length);
      try { db.insertTrades(batch); tradesCollected += batch.length; }
      catch (e) { console.error('[mm] insertTrades:', e.message); }
    }
    if (quoteBuf.length) {
      const qb = quoteBuf.splice(0, quoteBuf.length);
      try { db.insertQuotes(qb); quotesCollected += qb.length; }
      catch (e) { console.error('[dex] insertQuotes:', e.message); }
    }
  }, 1000);

  // DEX-фид только по нужным сетям (дефолт BSC+Base — экономит CU провайдера,
  // на ETH DEX-догоняние нерентабельно). Цены Gate/MM-сбор это не ограничивает.
  const dexWatchlist = watchlist.filter((w) => config.dexChains.includes(w.chainId));
  const wlBySymbol = new Map(dexWatchlist.map((w) => [w.symbol, w]));
  console.log(`[dex] подписка на свопы по ${dexWatchlist.length} пулам (сети: ${config.dexChains.join(',')}); Quoter-замер $${config.quoteSizesUsd.join('/$')}`);
  const feed = startDexFeed(
    dexWatchlist,
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
      // Quoter-замер исполнимой цены покупки (троттл на символ; не блокирует тик).
      const lq = lastQuoteTs.get(tick.symbol) || 0;
      const w = wlBySymbol.get(tick.symbol);
      if (w && tick.ts - lq >= config.quoteThrottleMs) {
        lastQuoteTs.set(tick.symbol, tick.ts);
        probeQuotes(w, tick.ts, tick.dexPrice);
      }
    },
    (st) => console.log(`[dex:${CHAIN_NAME[st.chainId] || st.chainId}] ${st.type}: ${st.detail}`),
  );

  const web = startServer({ liveSpread });

  setInterval(() => {
    const ofm = momentum ? ` | ofm: сделок ${ofmClosed}, откр ${momentum.openCount()}, paperPnL $${ofmPnl.toFixed(2)}` : '';
    console.log(`[status] спред-символов:${liveSpread.size} | трейдов:${tradesCollected} (буф:${tradeBuf.length}) | Quoter:${quotesCollected}${ofm}`);
  }, 20000);

  const shutdown = async () => {
    console.log('\nОстановка…');
    clearInterval(flushTimer);
    if (tradeBuf.length) try { db.insertTrades(tradeBuf.splice(0)); } catch {}
    if (quoteBuf.length) try { db.insertQuotes(quoteBuf.splice(0)); } catch {}
    feed.stop(); web.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Фатальная ошибка запуска:', e); process.exit(1); });
