// Загрузка и валидация переменных окружения из .env (один типизированный объект).
import 'dotenv/config';

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (Number.isNaN(v)) throw new Error(`Переменная окружения ${name}="${raw}" не является числом`);
  return v;
}

function str(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

// URL из .env, но плейсхолдеры из .env.example (REPLACE_KEY) считаем НЕзаданными,
// чтобы discover/dexFeed дали понятное «вставьте ключ Alchemy», а не RPC-ошибку.
function rpcUrl(name) {
  const v = str(name, '');
  return v && !v.includes('REPLACE_KEY') ? v : '';
}

// chainId -> URL (WSS для горячего пути, HTTP для discovery-multicall).
export const ALCHEMY_WSS = {
  1: rpcUrl('ALCHEMY_WSS_ETH'),
  56: rpcUrl('ALCHEMY_WSS_BSC'),
  8453: rpcUrl('ALCHEMY_WSS_BASE'),
};
export const ALCHEMY_HTTP = {
  1: rpcUrl('ALCHEMY_HTTP_ETH'),
  56: rpcUrl('ALCHEMY_HTTP_BSC'),
  8453: rpcUrl('ALCHEMY_HTTP_BASE'),
};

export const config = {
  alchemyWss: ALCHEMY_WSS,
  alchemyHttp: ALCHEMY_HTTP,
  // Сети для DEX-фида (подписка на свопы). Дефолт BSC+Base: на ETH DEX-догоняние
  // нерентабельно (газ ~8%/сделку), а подписки на ETH-пулы зря жгут CU провайдера.
  // Цены Gate и MM-сбор (cex_trades) этим НЕ ограничены. Можно указать любой WSS-URL
  // (Alchemy, PublicNode, Ankr…) в ALCHEMY_WSS_* — имя ключа историческое.
  dexChains: str('DEX_CHAINS', '56,8453').split(',').map((s) => Number(s.trim())).filter(Boolean),
  // Quoter-замер исполнимой цены покупки на DEX (реальный слиппедж по кривой пула).
  // HTTP-RPC для eth_call к QuoterV2 — дефолт бесплатный PublicNode (Alchemy CU не тратится).
  quoteHttp: {
    56: str('QUOTE_HTTP_BSC', 'https://bsc-rpc.publicnode.com'),
    8453: str('QUOTE_HTTP_BASE', 'https://base-rpc.publicnode.com'),
    1: str('QUOTE_HTTP_ETH', ''),
  },
  // Размеры покупки (USD), для которых пишем исполнимую цену/слиппедж.
  quoteSizesUsd: str('QUOTE_SIZES', '50,100,300,500').split(',').map((s) => Number(s.trim())).filter((n) => n > 0),
  // Не чаще раза в N мс на символ — бережёт RPC публичной ноды.
  quoteThrottleMs: num('QUOTE_THROTTLE_MS', 5000),

  // Gate.io (опционально для read-only; ключи — для точных комиссий).
  gateApiKey: str('GATE_API_KEY', ''),
  gateApiSecret: str('GATE_API_SECRET', ''),

  // CEX-фид (цены — по WebSocket ccxt.pro; funding — REST раз в N мс)
  fundingRefreshMs: num('FUNDING_REFRESH_MS', 5 * 60 * 1000),
  minPerpVolumeUsd: num('MIN_PERP_VOLUME_USD', 100000),
  // Символы, исключаемые из универсума (высококонкурентные), напр. BTC,ETH.
  excludeSymbols: new Set(str('EXCLUDE_SYMBOLS', 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)),
  // Watchlist пересобирается на старте, если старше стольких дней.
  watchlistMaxAgeDays: num('WATCHLIST_MAX_AGE_DAYS', 7),
  // MM-сбор: символы для записи ленты сделок Gate. Пусто → топ-N по ликвидности.
  tradeSymbols: str('TRADE_SYMBOLS', '').split(',').map((s) => s.trim()).filter(Boolean),
  tradeSymbolsLimit: num('TRADE_SYMBOLS_LIMIT', 15),

  // Spread engine
  openThresholdPct: num('OPEN_THRESHOLD_PCT', 0.5),
  closeThresholdPct: num('CLOSE_THRESHOLD_PCT', 0.1),
  // Макс. нотионал позиции, USD. Фактический размер может быть МЕНЬШЕ, если в
  // стакане CEX не хватает ликвидности в пределах целевого спреда (см. сайзинг).
  tradeSizeUsd: num('TRADE_SIZE_USD', 100),
  // Минимальный нотионал, USD: позиции меньше — не открываем (отсев пыли). 0 = без порога.
  minTradeSizeUsd: num('MIN_TRADE_SIZE_USD', 5),
  // Дросселирование записи spread_ticks: не чаще раза в N мс на символ
  // (переходы open/close пишутся всегда). Бережёт размер БД на «горячих» пулах.
  tickThrottleMs: num('TICK_THROTTLE_MS', 250),
  // Защитный потолок: спред выше — явный мусор (битый пул/децималы), игнор.
  maxSaneSpreadPct: num('MAX_SANE_SPREAD_PCT', 50),

  // ── Реализм исполнения ──────────────────────────────────────────────────
  // R3: задержка сигнал→исполнение, мс. Филл по живому WS-стакану ПОСЛЕ задержки
  // (за это время книга реально обновляется) — моделирует латентность реакции.
  // На токийском сервере реальный RTT до Gate единицы мс → дефолт 100.
  executionLatencyMs: num('EXECUTION_LATENCY_MS', 100),
  // R2: глубина стакана для VWAP-исполнения.
  orderbookDepth: num('ORDERBOOK_DEPTH', 50),
  // Кэш стакана, мс: дедуплицирует запросы, когда несколько стратегий торгуют один
  // символ в одном окне (параллельное сравнение). Малый TTL — данные ~свежие.
  orderbookCacheMs: num('ORDERBOOK_CACHE_MS', 250),
  // R1: тайм-стоп — принудительное закрытие позиции старше N мс (по умолч. 30 мин).
  maxHoldMs: num('MAX_HOLD_MS', 30 * 60 * 1000),
  // R1: стоп по расхождению — если спред ушёл В СТОРОНУ входа до этого порога (%),
  // закрываемся с убытком (спред не сошёлся, а разошёлся).
  stopSpreadPct: num('STOP_SPREAD_PCT', 3),
  // R1: период проверки тайм-стопа открытых позиций, мс.
  positionCheckMs: num('POSITION_CHECK_MS', 5000),
  // Частичное закрытие: при схождении (converge) закрываем уровни стакана, пока
  // round-trip PnL слайса ≥ этого порога (%); глубже — невыгодно, остаток ждёт.
  // Стопы (timestop/divergence) закрывают по ликвидности без этого гейта.
  closeMinPnlPct: num('CLOSE_MIN_PNL_PCT', 0),

  // Discovery
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 20000),
  anchorTolerancePct: num('ANCHOR_TOLERANCE_PCT', 20),

  // Веб / хранилище
  webPort: num('WEB_PORT', 3001),
  dbPath: str('DB_PATH', './data/cexpre.db'),
  logLevel: str('LOG_LEVEL', 'info'),
};

export default config;
