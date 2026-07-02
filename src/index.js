// CEXpreTrader — order-flow momentum (PAPER, только CEX, без реальных ордеров).
// Сканер (REST, все перпы Gate) периодически ищет кандидатов по markout/vol → WS-универсум
// + eligible; движок торгует их (вход тейкером по сильному OFI+низкому волу, выход
// мейкер-цель/тейкер-стоп), self-отбирая по трейлинг paper-PnL. of_positions — запись.
import config from './config/env.js';
import db from './storage/db.js';
import { initGateFeed, addMomentumSymbols, cexPriceMap } from './feed/gateFeed.js';
import { createMomentumEngine } from './strategy/ofMomentum.js';
import { scanCandidates } from './strategy/candidateScanner.js';
import { startServer } from './server/server.js';

const tradeBuf = [];
let tradesCollected = 0;

async function main() {
  console.log('CEXpreTrader — order-flow momentum (paper, CEX-only)…');
  db.init();

  let ofmClosed = 0, ofmPnl = 0;
  const momentum = createMomentumEngine({
    onEvent: (e) => {
      if (e.type === 'open') console.log(`[ofm][OPEN ] ${e.sym} ${e.dir > 0 ? 'long' : 'short'} @${e.entry}`);
      else if (e.type === 'close') console.log(`[ofm][CLOSE:${e.reason}] ${e.sym} paperPnL=$${e.pnlUsd.toFixed(3)}`);
    },
    recordPosition: (p) => { try { db.insertOfPosition(p); ofmClosed++; ofmPnl += p.pnlUsd; } catch (err) { console.error('[ofm] insert:', err.message); } },
  });
  console.log(`[ofm] сильный OFI(${config.ofmOfiPct}) + низкий вол(${config.ofmVolPct}), цель ${config.ofmTargetBps}/стоп ${config.ofmStopBps} bps, размер $${config.ofmSizeUsd}; self-отбор по трейлинг paper-PnL`);

  // Лента: буфер в cex_trades (для ре-бэктеста) + кормим momentum.
  const onTrades = (sym, trades) => {
    const p = cexPriceMap.get(sym);
    for (const t of trades) {
      const ts = t.timestamp ?? Date.now(), price = Number(t.price) || 0, amount = Number(t.amount) || 0, side = t.side ?? null;
      tradeBuf.push({ ts, symbol: sym, price, amount, side, bid: p?.bid ?? null, ask: p?.ask ?? null });
      if (price > 0) momentum.onTrade(sym, { ts, price, amount, side }, p);
    }
  };

  await initGateFeed();
  const flushTimer = setInterval(() => {
    if (!tradeBuf.length) return;
    const batch = tradeBuf.splice(0, tradeBuf.length);
    try { db.insertTrades(batch); tradesCollected += batch.length; } catch (e) { console.error('[trades] insert:', e.message); }
  }, 1000);

  // Сканер кандидатов: REST по ВСЕМ перпам Gate (DEX-пара не нужна). Периодически.
  const doScan = async () => {
    try {
      const r = await scanCandidates();
      if (r.monitor.length) {
        const { total, added } = addMomentumSymbols(r.monitor, onTrades);
        momentum.setEligible(new Set(r.eligible));
        console.log(`[scan] WS-монитор: ${total} (+${added}); универсум торговли: ${r.eligible.length}`);
      }
    } catch (e) { console.error('[scan] ошибка:', e.message); }
  };
  await doScan();
  setInterval(doScan, config.scanIntervalMs);

  const web = startServer();

  setInterval(() => {
    console.log(`[status] трейдов:${tradesCollected} (буф:${tradeBuf.length}) | ofm: сделок ${ofmClosed}, откр ${momentum.openCount()}, paperPnL $${ofmPnl.toFixed(2)}`);
  }, 20000);

  const shutdown = () => {
    console.log('\nОстановка…');
    clearInterval(flushTimer);
    if (tradeBuf.length) try { db.insertTrades(tradeBuf.splice(0)); } catch {}
    web.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { console.error('Фатальная ошибка запуска:', e); process.exit(1); });
