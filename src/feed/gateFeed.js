// CEX-сторона: живые цены USDT-перпов Gate по WebSocket (ccxt.pro).
// На каждый отслеживаемый символ держим подписку watchOrderBook — это единственный
// источник: из верхушки книги берём bid/ask (цена), а саму книгу отдаём движку на
// исполнение (VWAP по стакану). Данные обновляются по событиям (мс), не поллингом.
// Funding — медленная величина, его тянем REST раз в fundingRefreshMs.
import gateFutures from '../connectors/gateFutures.js';
import config from '../config/env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// symbol -> { bid, ask, last, mid, ts }
export const cexPriceMap = new Map();
// symbol -> fundingRate (доля, напр. 0.0001)
export const fundingMap = new Map();
// symbol -> живой стакан ccxt {bids, asks, ...} (последний апдейт WS)
const liveBooks = new Map();

let symbols = [];
let running = false;
let fundingTimer = null;

/** Среднее bid/ask (mid); фолбэк на last, если стакан пуст. */
export function cexMid(symbol) {
  const p = cexPriceMap.get(symbol);
  if (!p) return null;
  if (p.bid > 0 && p.ask > 0) return (p.bid + p.ask) / 2;
  return p.last ?? null;
}

export function getFunding(symbol) {
  return fundingMap.get(symbol) ?? null;
}

/** taker-комиссия по символу перпа (доля). */
export function takerFee(symbol) {
  return gateFutures.takerFee(symbol);
}

/** Размер контракта перпа (база на контракт): стакан Gate квотится в контрактах. */
export function contractSize(symbol) {
  return gateFutures.contractSize(symbol);
}

/**
 * Стакан перпа для исполнения. Отдаём СНИМОК живой WS-книги (глубина limit),
 * чтобы VWAP не читал мутируемый ccxt-объект. Если WS-книга символа ещё не пришла —
 * разовый REST-запрос как прогрев. Контракт совместим с прежним getOrderBook.
 * @returns {Promise<{bids:[number,number][], asks:[number,number][]}>}
 */
export async function getOrderBook(symbol, limit = config.orderbookDepth) {
  const ob = liveBooks.get(symbol);
  if (ob && ob.bids && ob.asks) {
    return {
      bids: ob.bids.slice(0, limit).map((l) => [Number(l[0]), Number(l[1])]),
      asks: ob.asks.slice(0, limit).map((l) => [Number(l[0]), Number(l[1])]),
    };
  }
  return gateFutures.fetchOrderBook(symbol, limit);
}

/** Обновить топ-цену из верхушки живой книги. */
function updateTopOfBook(symbol, ob) {
  const bid = ob.bids && ob.bids[0] ? Number(ob.bids[0][0]) : 0;
  const ask = ob.asks && ob.asks[0] ? Number(ob.asks[0][0]) : 0;
  cexPriceMap.set(symbol, {
    bid, ask, last: null,
    mid: (bid > 0 && ask > 0) ? (bid + ask) / 2 : null,
    ts: Date.now(),
  });
}

/** Бесконечный цикл WS-подписки на стакан одного символа (с бэкоффом на ошибку). */
async function streamSymbol(symbol) {
  let backoff = 1000;
  while (running) {
    try {
      const ob = await gateFutures.watchOrderBook(symbol, config.orderbookDepth);
      if (!running) break;
      liveBooks.set(symbol, ob);
      updateTopOfBook(symbol, ob);
      backoff = 1000; // успех — сбросить бэкофф
    } catch (e) {
      if (!running) break;
      console.error(`[gateFeed] WS ${symbol}: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

/** Цикл WS-подписки на ленту сделок одного символа (для MM-сбора). */
async function streamTrades(symbol, onTrades) {
  let backoff = 1000;
  while (running) {
    try {
      const trades = await gateFutures.watchTrades(symbol);
      if (!running) break;
      if (trades && trades.length) onTrades(symbol, trades);
      backoff = 1000;
    } catch (e) {
      if (!running) break;
      console.error(`[gateFeed] WS trades ${symbol}: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function pollFunding() {
  const m = await gateFutures.fetchFundingRates(symbols);
  for (const [sym, fr] of m) if (fr != null) fundingMap.set(sym, fr);
}

/**
 * Инициализация и запуск WS-фида. Если symbols не передан — берём все активные
 * линейные USDT-перпы Gate. Если в opts заданы tradeSymbols+onTrades — дополнительно
 * подписываемся на ленту сделок этих символов (для MM-сбора).
 * @param {string[]} [trackedSymbols]
 * @param {{tradeSymbols?:string[], onTrades?:(symbol:string, trades:object[])=>void}} [opts]
 */
export async function initGateFeed(trackedSymbols, opts = {}) {
  await gateFutures.init();
  symbols = (trackedSymbols && trackedSymbols.length)
    ? trackedSymbols
    : gateFutures.listContracts().map((c) => c.symbol);

  running = true;
  for (const sym of symbols) streamSymbol(sym); // не await — крутятся параллельно

  const { tradeSymbols = [], onTrades } = opts;
  if (onTrades && tradeSymbols.length) for (const sym of tradeSymbols) streamTrades(sym, onTrades);

  await pollFunding().catch((e) => console.warn('[gateFeed] funding:', e.message));
  fundingTimer = setInterval(
    () => pollFunding().catch((e) => console.error('[gateFeed] funding:', e.message)),
    config.fundingRefreshMs,
  );

  return { symbols };
}

export async function stopGateFeed() {
  running = false;
  if (fundingTimer) clearInterval(fundingTimer);
  await gateFutures.closeWs().catch(() => {});
}

export default { initGateFeed, stopGateFeed, getOrderBook, cexPriceMap, fundingMap, cexMid, getFunding, takerFee, contractSize };
