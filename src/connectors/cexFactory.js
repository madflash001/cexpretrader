// Обобщённый коннектор к спот-CEX через ccxt.
//
// Все биржи ccxt дают единый API (loadMarkets/fetchCurrencies/fetchTickers/
// fetchOrderBook), поэтому одна фабрика покрывает Gate, Binance, OKX и т.д.
// Различия в именах сетей нормализуются через config/chains.js.
//
// Ступень 1 (дёшево, по всем парам): fetchTickers — top bid/ask разом.
// Ступень 2 (дорого, по кандидатам): fetchOrderBook + симуляция исполнения
// по стакану (VWAP) на заданный объём в USDT, с учётом taker-комиссии.
import ccxt from 'ccxt';
import { pickNetwork, evmAddressesFromNetworks } from '../config/chains.js';

const DEFAULT_TAKER_FEE = 0.002; // 0.2% — типовой дефолт спот, если рынок не отдал точное

/**
 * Создать коннектор к бирже.
 * @param {string} exchangeId — id биржи в ccxt (напр. 'gate')
 * @param {{apiKey?:string, secret?:string, quote?:string, chain?:string, type?:string}} opts
 *   type: 'spot' (по умолчанию) | 'swap' (линейные бессрочные фьючерсы)
 */
export function createCexConnector(exchangeId, opts = {}) {
  const { apiKey, secret, quote = 'USDT', chain = 'BSC', type = 'spot' } = opts;

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

  let currencies = {};
  let transferFees = {};
  let feesLoaded = false;

  /** Загрузка рынков, валют и (при наличии ключей) комиссий ввода/вывода. */
  async function init() {
    await exchange.loadMarkets();
    try {
      currencies = await exchange.fetchCurrencies();
    } catch (e) {
      console.warn(`[${exchangeId}] не удалось загрузить валюты (${e.message}); проверка ввода/вывода отключена`);
      currencies = {};
    }
    if (apiKey && secret) {
      try {
        transferFees = await exchange.fetchDepositWithdrawFees();
        feesLoaded = true;
      } catch (e) {
        console.warn(`[${exchangeId}] не удалось загрузить комиссии ввода/вывода (${e.message}); приняты за 0`);
      }
    } else {
      console.warn(`[${exchangeId}] API-ключи не заданы: комиссии ввода/вывода приняты за 0. Задайте ключи для точного расчёта.`);
    }
    return exchange.markets;
  }

  /** Учитываются ли реальные комиссии ввода/вывода (true только при наличии ключей). */
  function feesAccounted() {
    return feesLoaded;
  }

  /** Множество активных спот-рынков вида SYMBOL/QUOTE. */
  function listSpotSymbols() {
    const set = new Set();
    for (const m of Object.values(exchange.markets)) {
      if (m.spot && m.active && m.quote === quote) set.add(m.symbol);
    }
    return set;
  }

  /**
   * Информация о вводе/выводе монеты по сети `chainKey` (по умолчанию — сеть коннектора).
   * Адрес контракта берётся из данных биржи — это источник истины для on-chain адреса.
   * @returns {null | {deposit:boolean, withdraw:boolean, address:string, fee:number|null}}
   *   null — у биржи нет этой сети для монеты (перевод в неё невозможен).
   */
  function getOnChainToken(baseSymbol, chainKey = chain) {
    const cur = currencies[baseSymbol];
    if (!cur || !cur.networks) return null;
    const net = pickNetwork(cur.networks, chainKey);
    if (!net) return null;
    const addr = net.info && (net.info.addr || net.info.contract_address || net.info.contractAddress);
    return {
      deposit: !!net.deposit,
      withdraw: !!net.withdraw,
      address: String(addr || '').toLowerCase(),
      fee: typeof net.fee === 'number' ? net.fee : null,
    };
  }

  /**
   * Комиссии ввода и вывода монеты по сети `chainKey`.
   * Комиссии могут быть фиксированными (в единицах монеты) или процентными
   * (доля от суммы перевода) — флаг `percentage` это различает.
   * Без API-ключей возвращает нули.
   * @returns {{deposit:{fee:number,percentage:boolean}, withdraw:{fee:number,percentage:boolean}}}
   */
  function getTransferFees(baseSymbol, chainKey = chain) {
    const zero = { fee: 0, percentage: false };
    const c = transferFees[baseSymbol];
    const net = c && c.networks && pickNetwork(c.networks, chainKey);
    if (!net) return { deposit: { ...zero }, withdraw: { ...zero } };
    const parse = (v) => {
      if (v && typeof v === 'object') return { fee: Number(v.fee) || 0, percentage: !!v.percentage };
      if (typeof v === 'number') return { fee: v, percentage: false };
      return { ...zero };
    };
    return { deposit: parse(net.deposit), withdraw: parse(net.withdraw) };
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

  /** Батч-запрос тикеров (top bid/ask) — ступень 1. */
  function fetchTickers(symbols) {
    return exchange.fetchTickers(symbols);
  }

  /** Стакан по символу — ступень 2 (REST, разовый запрос). */
  function fetchOrderBook(symbol, limit = 100) {
    return exchange.fetchOrderBook(symbol, limit);
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

  /**
   * EVM-адреса контракта монеты по сетям биржи, смапленные на chainId сетей 1inch.
   * @returns {Array<{chainId:number, address:string}>}
   */
  function getEvmAddresses(baseSymbol) {
    const cur = currencies[baseSymbol];
    if (!cur) return [];
    return evmAddressesFromNetworks(cur.networks);
  }

  return {
    id: exchangeId,
    quote,
    chain,
    type,
    init,
    feesAccounted,
    listSpotSymbols,
    getOnChainToken,
    getTransferFees,
    takerFee,
    contractSize,
    fetchTickers,
    fetchOrderBook,
    watchOrderBook,
    watchTrades,
    closeWs,
    listContracts,
    fetchFundingRates,
    getEvmAddresses,
    simulateBuy,
    simulateSell,
  };
}

// ── Симуляция исполнения по стакану (VWAP) — биржевно-агностична ────────────
/**
 * Покупка токена на бирже: тратим до `usdtBudget` USDT, идём по asks.
 * Taker-комиссия удерживается из получаемого токена.
 * @returns {{filled:boolean, usdtSpent:number, tokenReceived:number, avgPrice:number}}
 */
export function simulateBuy(asks, usdtBudget, fee) {
  let remaining = usdtBudget;
  let tokenGross = 0;
  for (const [price, amount] of asks) {
    const levelCost = price * amount;
    if (levelCost >= remaining) {
      tokenGross += remaining / price;
      remaining = 0;
      break;
    }
    tokenGross += amount;
    remaining -= levelCost;
  }
  const filled = remaining <= usdtBudget * 1e-9;
  const usdtSpent = usdtBudget - remaining;
  const tokenReceived = tokenGross * (1 - fee);
  const avgPrice = tokenReceived > 0 ? usdtSpent / tokenReceived : Infinity;
  return { filled, usdtSpent, tokenReceived, avgPrice };
}

/**
 * Продажа токена на бирже: продаём `tokenAmount`, идём по bids.
 * Taker-комиссия удерживается из получаемого USDT.
 * @returns {{filled:boolean, tokenSold:number, usdtReceived:number, avgPrice:number}}
 */
export function simulateSell(bids, tokenAmount, fee) {
  let remaining = tokenAmount;
  let usdtGross = 0;
  for (const [price, amount] of bids) {
    if (amount >= remaining) {
      usdtGross += remaining * price;
      remaining = 0;
      break;
    }
    usdtGross += amount * price;
    remaining -= amount;
  }
  const filled = remaining <= tokenAmount * 1e-9;
  const tokenSold = tokenAmount - remaining;
  const usdtReceived = usdtGross * (1 - fee);
  const avgPrice = tokenSold > 0 ? usdtReceived / tokenSold : 0;
  return { filled, tokenSold, usdtReceived, avgPrice };
}

export default { createCexConnector, simulateBuy, simulateSell };
