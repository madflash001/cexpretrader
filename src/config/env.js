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

export const config = {
  // Gate.io — цены/лента идут по публичному WS; ключи нужны лишь для точных комиссий.
  gateApiKey: str('GATE_API_KEY', ''),
  gateApiSecret: str('GATE_API_SECRET', ''),

  // ── Order-flow momentum (PAPER-стратегия, без реальных ордеров) ───────────
  ofmWindowMs: num('OFM_WINDOW_MS', 5000),      // окно расчёта OFI
  ofmOfiPct: num('OFM_OFI_PCT', 0.8),           // порог «сильного» OFI (перцентиль)
  ofmVolPct: num('OFM_VOL_PCT', 0.5),           // порог «низкого» вола (перцентиль)
  ofmTargetBps: num('OFM_TARGET_BPS', 20),      // цель (мейкер-выход), bps
  ofmStopBps: num('OFM_STOP_BPS', 15),          // стоп (тейкер-выход), bps
  ofmMaxHoldMs: num('OFM_MAX_HOLD_MS', 30000),  // таймаут удержания
  ofmSizeUsd: num('OFM_SIZE_USD', 50),
  ofmRingSize: num('OFM_RING_SIZE', 1500),      // окно онлайн-калибровки порогов
  ofmMakerFee: num('OFM_MAKER_FEE', 0.0002),
  ofmTakerFee: num('OFM_TAKER_FEE', 0.0005),
  // Реализм исполнения (сближает paper с боевым):
  ofmLatencyMs: num('OFM_LATENCY_MS', 20),       // сигнал→филл: сеть Токио(~5мс)+матчинг Gate(~15мс)
  ofmEntrySlipBps: num('OFM_ENTRY_SLIP_BPS', 2), // слиппедж входа тейкером (прокси глубины; L2 не пишем)
  ofmQueueMult: num('OFM_QUEUE_MULT', 1),        // мейкер-выход филлится, когда через цель прошёл объём ≥ mult×размер
  // Rolling self-отбор символа по недавнему paper-PnL (сильнейшее правило: prior-PnL>0).
  ofmPnlWindowMs: num('OFM_PNL_WINDOW_MS', 60 * 60 * 1000),
  ofmPnlWarmup: num('OFM_PNL_WARMUP', 8), // не бенчить, пока < N закрытий в окне

  // ── Скан кандидатов momentum (REST по всем перпам Gate) ──
  scanIntervalMs: num('SCAN_INTERVAL_MS', 60 * 60 * 1000), // пересканировать раз в час
  scanMinVolUsd: num('SCAN_MIN_VOL_USD', 300000),          // первичный фильтр ликвидности: мин. 24ч объём
  scanMaxSpreadBps: num('SCAN_MAX_SPREAD_BPS', 30),        // первичный фильтр: макс. спред (0.30%)
  scanDeepN: num('SCAN_DEEP_N', 300),                      // глубокий скан markout/vol (кап-предохранитель)
  scanSelectK: num('SCAN_SELECT_K', 6),                    // сколько реально торгуем (eligible)
  scanMinTps: num('SCAN_MIN_TPS', 0.2),                    // мин. сделок/с (активность)
  scanMinMarkoutBps: num('SCAN_MIN_MARKOUT_BPS', 4),       // мин. markout eligible (персистентность потока)
  momentumUniverseCap: num('MOMENTUM_UNIVERSE_CAP', 12),   // WS-монитор = шорт-лист + тёплый буфер (≈2× торгуемых)

  // Веб / хранилище
  webPort: num('WEB_PORT', 3001),
  dbPath: str('DB_PATH', './data/cexpre.db'),
};

export default config;
