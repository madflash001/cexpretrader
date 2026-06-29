// Реестр стратегий для параллельного сравнения. Все видят один поток данных;
// у каждой — свой стейт и свои позиции в БД (колонка strategy).
//
// Сигнал-метрика:
//  - threshold: value = текущий спред (%). Открытие при |value| ≥ openLevel.
//  - meanrev:   value = спред − EMA(спреда) (отклонение от своей средней).
//               Открытие при |value| ≥ openLevel; направление против отклонения;
//               выход когда спред вернулся к средней (|value| ≤ closeLevel).
//
// Общая механика (латентность, VWAP по стакану, адаптивный сайзинг, частичное
// закрытие, тайм-стоп) — одинаковая; различаются только метрика и уровни.
// Параметры meanrev подобраны вручную (разная скорость EMA и чувствительность).
export const STRATEGIES = [
  // ── Пороговые (по запросу пользователя) ──
  { id: 'thr-0.5-0.1', type: 'threshold', openLevel: 0.5, closeLevel: 0.1, stopLevel: 2 },
  { id: 'thr-1.0-0.2', type: 'threshold', openLevel: 1.0, closeLevel: 0.2, stopLevel: 3 },
  { id: 'thr-1.5-0.3', type: 'threshold', openLevel: 1.5, closeLevel: 0.3, stopLevel: 4 },
  { id: 'thr-2.0-0.4', type: 'threshold', openLevel: 2.0, closeLevel: 0.4, stopLevel: 5 },

  // ── Отклонение от средней (EMA спреда), параметры подобраны самостоятельно ──
  { id: 'mr-fast', type: 'meanrev', emaAlpha: 0.10, minSamples: 20, openLevel: 1.0, closeLevel: 0.2, stopLevel: 3 },
  { id: 'mr-mid',  type: 'meanrev', emaAlpha: 0.04, minSamples: 40, openLevel: 1.0, closeLevel: 0.2, stopLevel: 3 },
  { id: 'mr-slow', type: 'meanrev', emaAlpha: 0.02, minSamples: 60, openLevel: 1.5, closeLevel: 0.3, stopLevel: 4 },
];

export default { STRATEGIES };
