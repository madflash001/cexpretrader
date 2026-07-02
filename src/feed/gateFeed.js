// CEX WS-фид (ccxt.pro): топ-of-book (bid/ask) в cexPriceMap + лента сделок.
// Подписки динамические — сканер добавляет символы momentum-универсума на ходу.
import gateFutures from '../connectors/gateFutures.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// symbol -> { bid, ask, mid, ts }
export const cexPriceMap = new Map();
let running = false;

export function cexMid(symbol) {
  const p = cexPriceMap.get(symbol);
  if (!p) return null;
  return (p.bid > 0 && p.ask > 0) ? (p.bid + p.ask) / 2 : null;
}

function updateTop(sym, ob) {
  const bid = ob.bids && ob.bids[0] ? Number(ob.bids[0][0]) : 0;
  const ask = ob.asks && ob.asks[0] ? Number(ob.asks[0][0]) : 0;
  cexPriceMap.set(sym, { bid, ask, mid: (bid > 0 && ask > 0) ? (bid + ask) / 2 : null, ts: Date.now() });
}

async function streamSymbol(sym) {
  let backoff = 1000;
  while (running) {
    try { const ob = await gateFutures.watchOrderBook(sym, 5); if (!running) break; updateTop(sym, ob); backoff = 1000; }
    catch (e) { if (!running) break; console.error(`[gateFeed] WS ${sym}: ${e.message}`); await sleep(backoff); backoff = Math.min(backoff * 2, 30000); }
  }
}
async function streamTrades(sym, onTrades) {
  let backoff = 1000;
  while (running) {
    try { const tr = await gateFutures.watchTrades(sym); if (!running) break; if (tr && tr.length) onTrades(sym, tr); backoff = 1000; }
    catch (e) { if (!running) break; console.error(`[gateFeed] WS trades ${sym}: ${e.message}`); await sleep(backoff); backoff = Math.min(backoff * 2, 30000); }
  }
}

const priceSubs = new Set(), tradeSubs = new Set();
function ensurePrice(sym) { if (!running || priceSubs.has(sym)) return; priceSubs.add(sym); streamSymbol(sym); }
function ensureTrades(sym, onTrades) { if (!running || tradeSubs.has(sym)) return; tradeSubs.add(sym); streamTrades(sym, onTrades); }

/** Добавить символы momentum-универсума: цена (топ-of-book) + лента. Идемпотентно. */
export function addMomentumSymbols(list, onTrades) {
  let added = 0;
  for (const sym of list) { if (!tradeSubs.has(sym)) added++; ensurePrice(sym); ensureTrades(sym, onTrades); }
  return { total: tradeSubs.size, added };
}

export async function initGateFeed() { await gateFutures.init(); running = true; }
export async function stopGateFeed() { running = false; await gateFutures.closeWs().catch(() => {}); }

export default { initGateFeed, stopGateFeed, addMomentumSymbols, cexPriceMap, cexMid };
