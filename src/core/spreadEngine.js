// Движок спреда — ФАБРИКА инстансов (по одному на стратегию). Все инстансы видят
// один поток обогащённых тиков (symbol, dexPrice, mid, spreadPct), но решают
// независимо и пишут позиции с тегом strategy.
//
// Семантика: торгуем только перп Gate, DEX — сигнал. Реализм: латентность (R3),
// VWAP по стакану + адаптивный сайзинг (R2), стопы тайм/расхождение (R1),
// частичное закрытие по ликвидности и выгодности (R4).
//
// Чистые функции (execAvgPrice/execWithinBand/execExit/computeSimPnlPct) — модульные,
// тестируются отдельно. Зависимости (стакан, contractSize, funding, taker, onEvent)
// внедряются в createEngine — движок не зависит от gateFeed напрямую.
import db from '../storage/db.js';
import { config } from '../config/env.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Чистые функции исполнения ────────────────────────────────────────────────
/** VWAP по стакану на нотионал sizeUsd (вход). levels: [[price,amount(base)],...]. */
export function execAvgPrice(levels, sizeUsd) {
  let remaining = sizeUsd, token = 0, usd = 0;
  if (Array.isArray(levels)) {
    for (const lvl of levels) {
      const price = Number(lvl[0]); const amount = Number(lvl[1]);
      if (!(price > 0) || !(amount > 0)) continue;
      const levelUsd = price * amount;
      const take = Math.min(levelUsd, remaining);
      token += take / price; usd += take; remaining -= take;
      if (remaining <= sizeUsd * 1e-9) break;
    }
  }
  return { avgPrice: token > 0 ? usd / token : 0, filledUsd: usd, filled: remaining <= sizeUsd * 1e-6 };
}

/**
 * Сайзинг входа: до maxUsd, но только уровни в пределах «прибыльной полосы» —
 * наш ордер не должен схлопнуть спред за boundaryPrice.
 *   short: берём bids с ценой ≥ boundaryPrice; long: asks ≤ boundaryPrice.
 */
export function execWithinBand(levels, { boundaryPrice, direction, maxUsd }) {
  let remaining = maxUsd, token = 0, usd = 0, limitedByBand = false;
  if (Array.isArray(levels)) {
    for (const lvl of levels) {
      const price = Number(lvl[0]); const amount = Number(lvl[1]);
      if (!(price > 0) || !(amount > 0)) continue;
      const inBand = direction === 'short_perp' ? price >= boundaryPrice : price <= boundaryPrice;
      if (!inBand) { limitedByBand = true; break; }
      const levelUsd = price * amount;
      const take = Math.min(levelUsd, remaining);
      token += take / price; usd += take; remaining -= take;
      if (remaining <= maxUsd * 1e-9) break;
    }
  }
  const reachedMax = remaining <= maxUsd * 1e-9;
  return { avgPrice: token > 0 ? usd / token : 0, sizeUsd: usd, reachedMax, limitedByBand: limitedByBand && !reachedMax };
}

/**
 * Сайзинг ВЫХОДА по количеству токенов. profitGated (converge): идём пока
 * round-trip PnL слайса ≥ minPnlPct; иначе глубже невыгодно (частичный выход).
 * Стопы: profitGated=false → выход по ликвидности.
 */
export function execExit(levels, { entryPrice, direction, remainingQty, takerPct, minPnlPct = 0, profitGated = false }) {
  let qty = 0, usd = 0, remaining = remainingQty;
  if (Array.isArray(levels)) {
    for (const lvl of levels) {
      const price = Number(lvl[0]); const amount = Number(lvl[1]);
      if (!(price > 0) || !(amount > 0)) continue;
      if (profitGated) {
        const move = direction === 'short_perp' ? ((entryPrice - price) / entryPrice) * 100 : ((price - entryPrice) / entryPrice) * 100;
        if (move - 2 * takerPct < minPnlPct) break;
      }
      const take = Math.min(amount, remaining);
      qty += take; usd += take * price; remaining -= take;
      if (remaining <= remainingQty * 1e-9) break;
    }
  }
  return { closedQty: qty, exitAvgPrice: qty > 0 ? usd / qty : 0, fullyClosed: remaining <= remainingQty * 1e-6 };
}

export function computeSimPnlPct({ direction, entryPrice, exitPrice, takerPct, fundingPnlPct = 0 }) {
  if (!(entryPrice > 0) || !(exitPrice > 0)) return 0;
  const move = direction === 'short_perp' ? ((entryPrice - exitPrice) / entryPrice) * 100 : ((exitPrice - entryPrice) / entryPrice) * 100;
  return move - 2 * takerPct + fundingPnlPct;
}

const bookSideInBase = (levels, cs) => (Array.isArray(levels) ? levels.map((l) => [Number(l[0]), Number(l[1]) * cs]) : []);

// ── Фабрика инстанса движка для стратегии ────────────────────────────────────
/**
 * @param {object} strategy — запись из config/strategies.js
 * @param {object} deps — { getOrderBook, getContractSize, getFunding, takerFee, onEvent }
 */
export function createEngine(strategy, deps) {
  const { getOrderBook, getContractSize, getFunding, takerFee, onEvent = () => {} } = deps;
  const state = new Map();        // symbol -> позиция/состояние
  const metricState = new Map();  // symbol -> { ema, n } (для meanrev)
  let openCount = 0, closeCount = 0, partialCloseCount = 0;
  const closeByReason = { converge: 0, timestop: 0, divergence: 0 };
  let sweepTimer = null;

  /** Метрика сигнала + признак готовности (прогрев EMA для meanrev). */
  function metric(symbol, spreadPct) {
    if (strategy.type === 'threshold') return { value: spreadPct, ready: true };
    let ms = metricState.get(symbol);
    if (!ms) { ms = { ema: spreadPct, n: 0 }; metricState.set(symbol, ms); }
    const prevEma = ms.ema;
    ms.ema = prevEma + strategy.emaAlpha * (spreadPct - prevEma);
    ms.n += 1;
    return { value: spreadPct - prevEma, ready: ms.n >= strategy.minSamples, ema: ms.ema };
  }

  /** Граница сайзинга: цена, за которой edge исчезает. */
  function boundaryPrice(symbol, dexPrice, direction) {
    if (strategy.type === 'threshold') {
      const thr = strategy.openLevel / 100;
      return direction === 'short_perp' ? dexPrice * (1 + thr) : dexPrice * (1 - thr);
    }
    const ms = metricState.get(symbol); const ema = ms ? ms.ema : 0; // meanrev: цена при спреде = средней
    return dexPrice * (1 + ema / 100);
  }

  function onDexTick(t) {
    const { symbol, gateSymbol, chainId, dexPrice, mid, spreadPct } = t;
    if (mid == null || !(dexPrice > 0) || Math.abs(spreadPct) > config.maxSaneSpreadPct) return;
    const m = metric(symbol, spreadPct);
    if (!m.ready) return;

    const st = state.get(symbol);
    const absVal = Math.abs(m.value);

    // ИНВАРИАНТ «одна позиция на символ»: открываем только из FLAT.
    if (!st || st.status === 'FLAT') {
      if (absVal >= strategy.openLevel) {
        scheduleOpen({ symbol, gateSymbol, chainId, dexPrice, mid, value: m.value, spreadPct });
      }
      return;
    }
    if (st.status === 'OPEN') {
      st.lastSpreadPct = spreadPct;
      if (absVal <= strategy.closeLevel) scheduleClose(symbol, 'converge');
      else if (Math.sign(m.value) === st.entrySign && absVal >= strategy.stopLevel) scheduleClose(symbol, 'divergence');
    }
  }

  function scheduleOpen(sig) {
    state.set(sig.symbol, { status: 'PENDING_OPEN' });
    executeOpen(sig).catch((e) => { state.set(sig.symbol, { status: 'FLAT' }); onEvent({ type: 'error', strategy: strategy.id, symbol: sig.symbol, detail: `open: ${e.message}` }); });
  }

  async function executeOpen({ symbol, gateSymbol, chainId, dexPrice, mid, value, spreadPct }) {
    const direction = value > 0 ? 'short_perp' : 'long_perp';
    await sleep(config.executionLatencyMs);
    const book = await getOrderBook(gateSymbol, config.orderbookDepth);
    const cs = getContractSize(gateSymbol) || 1;
    const levels = bookSideInBase(direction === 'short_perp' ? book.bids : book.asks, cs);
    const { avgPrice, sizeUsd, limitedByBand } = execWithinBand(levels, {
      boundaryPrice: boundaryPrice(symbol, dexPrice, direction), direction, maxUsd: config.tradeSizeUsd,
    });
    if (!(avgPrice > 0) || sizeUsd <= config.minTradeSizeUsd) { state.set(symbol, { status: 'FLAT' }); return; }

    const takerPct = (takerFee(gateSymbol) ?? 0.0005) * 100;
    const now = Date.now();
    const posId = db.openPosition({
      strategy: strategy.id, symbol, gateSymbol, chainId, direction, openedTs: now,
      openSpreadPct: spreadPct, openDexPrice: dexPrice, openCexPrice: mid,
      entryPrice: avgPrice, sizeUsd, takerFeePct: takerPct, fundingPct: 0,
    });
    state.set(symbol, {
      status: 'OPEN', posId, gateSymbol, chainId, direction, openTs: now,
      entryPrice: avgPrice, sizeUsd, qty: sizeUsd / avgPrice, takerPct, entrySign: Math.sign(value),
      closedQty: 0, realizedPnlUsd: 0, exitUsdAcc: 0, nextCloseAttemptTs: 0, lastSpreadPct: spreadPct,
    });
    openCount += 1;
    const slipPct = mid > 0 ? ((avgPrice - mid) / mid) * 100 : 0;
    onEvent({ type: 'open', strategy: strategy.id, symbol, chainId, direction, spreadPct, sizeUsd, slipPct, limitedByBand });
  }

  function scheduleClose(symbol, reason) {
    const st = state.get(symbol);
    if (!st || st.status !== 'OPEN') return;
    if (st.nextCloseAttemptTs && Date.now() < st.nextCloseAttemptTs) return;
    state.set(symbol, { ...st, status: 'PENDING_CLOSE' });
    executeClose(symbol, reason).catch((e) => {
      const cur = state.get(symbol); if (cur) state.set(symbol, { ...cur, status: 'OPEN' });
      onEvent({ type: 'error', strategy: strategy.id, symbol, detail: `close: ${e.message}` });
    });
  }

  async function executeClose(symbol, reason) {
    const st = state.get(symbol);
    if (!st || st.status !== 'PENDING_CLOSE') return;
    await sleep(config.executionLatencyMs);
    const book = await getOrderBook(st.gateSymbol, config.orderbookDepth);
    const cs = getContractSize(st.gateSymbol) || 1;
    const levels = bookSideInBase(st.direction === 'short_perp' ? book.asks : book.bids, cs);
    const profitGated = reason === 'converge';
    const { closedQty, exitAvgPrice } = execExit(levels, {
      entryPrice: st.entryPrice, direction: st.direction, remainingQty: st.qty,
      takerPct: st.takerPct, minPnlPct: config.closeMinPnlPct, profitGated,
    });
    if (!(closedQty > 0) || !(exitAvgPrice > 0)) {
      state.set(symbol, { ...st, status: 'OPEN', nextCloseAttemptTs: Date.now() + config.positionCheckMs });
      onEvent({ type: 'close_skip', strategy: strategy.id, symbol, reason, detail: profitGated ? 'невыгодно' : 'нет ликвидности' });
      return;
    }
    const now = Date.now();
    const tf = st.takerPct / 100;
    const fr = getFunding(st.gateSymbol) ?? 0;
    const holdH = Math.max(0, (now - st.openTs) / 3.6e6);
    const sliceNotional = closedQty * st.entryPrice;
    const grossUsd = st.direction === 'short_perp' ? closedQty * (st.entryPrice - exitAvgPrice) : closedQty * (exitAvgPrice - st.entryPrice);
    const feeUsd = tf * (closedQty * st.entryPrice + closedQty * exitAvgPrice);
    const fundingUsd = (st.direction === 'short_perp' ? 1 : -1) * fr * (holdH / 8) * sliceNotional;
    const slicePnlUsd = grossUsd - feeUsd + fundingUsd;

    const newClosedQty = st.closedQty + closedQty;
    const newRealized = st.realizedPnlUsd + slicePnlUsd;
    const newExitUsdAcc = st.exitUsdAcc + closedQty * exitAvgPrice;
    const wavgExit = newExitUsdAcc / newClosedQty;
    const remainingNotional = (st.qty - closedQty) * st.entryPrice;

    if (remainingNotional <= config.minTradeSizeUsd) {
      const simPnlPct = st.sizeUsd > 0 ? (newRealized / st.sizeUsd) * 100 : 0;
      db.closePosition(st.posId, {
        closedTs: now, closeSpreadPct: st.lastSpreadPct ?? null, exitPrice: wavgExit,
        closedQty: newClosedQty, realizedPnlUsd: newRealized, simPnlPct, fundingPct: 0, closeReason: reason,
      });
      state.set(symbol, { status: 'FLAT' });
      closeCount += 1; if (closeByReason[reason] != null) closeByReason[reason] += 1;
      onEvent({ type: 'close', strategy: strategy.id, symbol, chainId: st.chainId, simPnlPct, reason, realizedUsd: newRealized });
      return;
    }
    db.updatePartialClose(st.posId, { closedQty: newClosedQty, realizedPnlUsd: newRealized, exitPrice: wavgExit });
    state.set(symbol, { ...st, status: 'OPEN', qty: st.qty - closedQty, closedQty: newClosedQty, realizedPnlUsd: newRealized, exitUsdAcc: newExitUsdAcc, nextCloseAttemptTs: Date.now() + config.positionCheckMs });
    partialCloseCount += 1;
    onEvent({ type: 'partial_close', strategy: strategy.id, symbol, reason, closedUsd: closedQty * exitAvgPrice, remainingUsd: remainingNotional });
  }

  function startSweep() {
    stopSweep();
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [symbol, st] of state) if (st.status === 'OPEN' && now - st.openTs >= config.maxHoldMs) scheduleClose(symbol, 'timestop');
    }, config.positionCheckMs);
  }
  function stopSweep() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

  function rehydrate() {
    let n = 0;
    for (const p of db.getOpenPositions(strategy.id)) {
      const entryPrice = p.entryPrice ?? p.openCexPrice;
      const sizeUsd = p.sizeUsd ?? config.tradeSizeUsd;
      const closedQty = p.closedQty ?? 0;
      const totalQty = entryPrice > 0 ? sizeUsd / entryPrice : 0;
      state.set(p.symbol, {
        status: 'OPEN', posId: p.id, gateSymbol: p.gateSymbol, chainId: p.chainId, direction: p.direction,
        openTs: p.openedTs, entryPrice, sizeUsd, qty: Math.max(0, totalQty - closedQty),
        closedQty, realizedPnlUsd: p.realizedPnlUsd ?? 0, exitUsdAcc: (p.exitPrice ?? 0) * closedQty,
        takerPct: p.takerFeePct, entrySign: Math.sign(p.openSpreadPct), nextCloseAttemptTs: 0, lastSpreadPct: p.openSpreadPct,
      });
      n += 1;
    }
    return n;
  }

  function getCounters() {
    let openNow = 0;
    for (const st of state.values()) if (st.status === 'OPEN') openNow += 1;
    return { id: strategy.id, openCount, closeCount, partialCloseCount, openNow, closeByReason: { ...closeByReason } };
  }

  return { id: strategy.id, onDexTick, startSweep, stopSweep, rehydrate, getCounters };
}

export default { createEngine, execAvgPrice, execWithinBand, execExit, computeSimPnlPct };
