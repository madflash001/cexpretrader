// Обобщённый коннектор к CEX через ccxt (spot/swap). Все биржи ccxt дают единый
// API (loadMarkets/fetchTickers/fetchOrderBook/fetchTrades) + ccxt.pro watch*-
// подписки по WebSocket, поэтому одна фабрика покрывает Gate, Binance, OKX и т.д.
import ccxt from 'ccxt';

const DEFAULT_TAKER_FEE = 0.002; // 0.2% — типовой дефолт, если рынок не отдал точное

/**
 * Создать коннектор к бирже.
 * @param {string} exchangeId — id биржи в ccxt (напр. 'gate')
 * @param {{apiKey?:string, secret?:string, quote?:string, type?:string}} opts
 *   type: 'spot' (по умолчанию) | 'swap' (линейные бессрочные фьючерсы)
 */
export function createCexConnector(exchangeId, opts = {}) {
  const { apiKey, secret, quote = 'USDT', type = 'spot' } = opts;

  // ccxt.pro-класс — наследник REST-класса: REST-методы работают как раньше, плюс
  // доступны watch*-подписки по WebSocket. Фолбэк на REST-класс, если pro нет.
  const Ex = (ccxt.pro && ccxt.pro[exchangeId]) || ccxt[exchangeId];
  const exchange = new Ex({
    apiKey: apiKey || undefined,
    secret: secret || undefined,
    enableRateLimit: true,
    timeout: 30000, // loadMarkets тянет несколько эндпоинтов — 10с по умолчанию мало
    options: { defaultType: type, fetchMarkets: [type] },
  });

  /** Загрузка рынков. */
  async function init() {
    await exchange.loadMarkets();
    return exchange.markets;
  }

  /** Taker-комиссия по символу (доля, напр. 0.002). */
  function takerFee(symbol) {
    const m = exchange.markets && exchange.markets[symbol];
    return m && typeof m.taker === 'number' ? m.taker : DEFAULT_TAKER_FEE;
  }

  /**
   * Размер контракта (база на 1 контракт). У перпов Gate стакан квотится в
   * КОНТРАКТАХ, поэтому базовое количество = amount × contractSize. Дефолт 1.
   */
  function contractSize(symbol) {
    const m = exchange.markets && exchange.markets[symbol];
    return m && typeof m.contractSize === 'number' && m.contractSize > 0 ? m.contractSize : 1;
  }

  /** Батч-запрос тикеров (top bid/ask). */
  function fetchTickers(symbols) {
    return exchange.fetchTickers(symbols);
  }

  /** Стакан по символу (REST, разовый запрос). */
  function fetchOrderBook(symbol, limit = 100) {
    return exchange.fetchOrderBook(symbol, limit);
  }

  /** Недавняя лента сделок по символу (REST) — для скана кандидатов (markout/vol). */
  function fetchTrades(symbol, limit = 1000) {
    return exchange.fetchTrades(symbol, undefined, limit);
  }

  /** Подписка на стакан по WebSocket (ccxt.pro). Резолвится при каждом апдейте. */
  function watchOrderBook(symbol, limit = 50) {
    return exchange.watchOrderBook(symbol, limit);
  }

  /** Подписка на ленту сделок по WebSocket (ccxt.pro). Возвращает массив новых трейдов. */
  function watchTrades(symbol) {
    return exchange.watchTrades(symbol);
  }

  /** Закрыть все WebSocket-соединения (для graceful shutdown). */
  function closeWs() {
    return typeof exchange.close === 'function' ? exchange.close() : Promise.resolve();
  }

  // ── Фьючерсы (type='swap') ────────────────────────────────────────────────
  /** Активные линейные бессрочные контракты SYMBOL/QUOTE:QUOTE. */
  function listContracts() {
    const out = [];
    for (const m of Object.values(exchange.markets)) {
      if (m.swap && m.linear && m.active && m.quote === quote) {
        out.push({ symbol: m.symbol, id: m.id, base: m.base });
      }
    }
    return out;
  }

  /** Ставки финансирования по символам перпов: Map(symbol -> fundingRate|null). */
  async function fetchFundingRates(symbols) {
    const out = new Map();
    try {
      const res = await exchange.fetchFundingRates(symbols);
      for (const [sym, fr] of Object.entries(res)) out.set(sym, fr && fr.fundingRate);
    } catch (e) {
      console.warn(`[${exchangeId}] fetchFundingRates: ${e.message}`);
    }
    return out;
  }

  return {
    id: exchangeId,
    quote,
    type,
    init,
    takerFee,
    contractSize,
    fetchTickers,
    fetchOrderBook,
    fetchTrades,
    watchOrderBook,
    watchTrades,
    closeWs,
    listContracts,
    fetchFundingRates,
  };
}

export default { createCexConnector };
