// Order-flow momentum (PAPER, без реальных ордеров) с РЕАЛИЗМОМ исполнения:
//  - латентность: вход исполняется по книге через ofmLatencyMs после сигнала;
//  - слиппедж входа: тейкер платит ofmEntrySlipBps сверху (прокси глубины);
//  - очередь на мейкер-выходе: цель филлится, только когда через неё прошёл объём
//    ≥ ofmQueueMult×размер (иначе — стоп/таймаут тейкером). Убирает оптимизм «коснулось=филл».
// Пороги OFI/vol калибруются онлайн; self-отбор символа по трейлинг paper-PnL.
import config from '../config/env.js';

const MAKER = config.ofmMakerFee, TAKER = config.ofmTakerFee;
const pctile = (arr, p) => { if (arr.length < 50) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

export function createMomentumEngine({ onEvent = () => {}, recordPosition = () => {} } = {}) {
  const st = new Map();
  let openNow = 0;
  let eligible = null;
  function S(sym) {
    let s = st.get(sym);
    if (!s) st.set(sym, s = { buf: [], sum: 0, vol: 0, prevMid: null, ofiHist: [], volHist: [], ofiThr: Infinity, volThr: 0, calN: 0, pos: null, pending: null, pnlWin: [] });
    return s;
  }

  function onTrade(sym, t, book) {
    const s = S(sym);
    const mid = (book && book.bid > 0 && book.ask > 0) ? (book.bid + book.ask) / 2 : t.price;
    if (s.prevMid) { const r = (mid - s.prevMid) / s.prevMid; s.vol = 0.94 * s.vol + 0.06 * r * r; }
    s.prevMid = mid;
    const volNow = Math.sqrt(s.vol);

    const sn = (t.side === 'buy' ? 1 : t.side === 'sell' ? -1 : 0) * t.amount * t.price;
    s.buf.push({ ts: t.ts, sn }); s.sum += sn;
    const cutoff = t.ts - config.ofmWindowMs;
    while (s.buf.length && s.buf[0].ts < cutoff) s.sum -= s.buf.shift().sn;
    const ofi = s.sum;

    // 1. Управление открытой позицией (выход) — с моделью очереди на цели.
    if (s.pos) {
      const p = s.pos;
      const throughTarget = p.dir > 0 ? t.price >= p.target : t.price <= p.target;
      if (throughTarget) p.exitVol += t.amount * t.price;                    // объём, прошедший через нашу цель
      const targetFilled = p.exitVol >= config.ofmQueueMult * p.sizeUsd;      // очередь впереди расчищена
      const hitStop = p.dir > 0 ? t.price <= p.stop : t.price >= p.stop;
      const timeout = t.ts - p.openTs >= config.ofmMaxHoldMs;
      if (targetFilled || hitStop || timeout) {
        let exit, exitFee, reason;
        if (targetFilled && !hitStop) { exit = p.target; exitFee = MAKER; reason = 'target'; }
        else { exit = p.dir > 0 ? (book?.bid ?? t.price) : (book?.ask ?? t.price); exitFee = TAKER; reason = hitStop ? 'stop' : 'timeout'; }
        const gross = p.dir > 0 ? (exit - p.entry) / p.entry : (p.entry - exit) / p.entry;
        const pnlUsd = (gross - TAKER - exitFee) * p.sizeUsd;                 // вход был тейкером
        s.pos = null; openNow--;
        s.pnlWin.push({ ts: t.ts, pnl: pnlUsd });
        recordPosition({ symbol: sym, direction: p.dir > 0 ? 'long' : 'short', openTs: p.openTs, closeTs: t.ts, entry: p.entry, exit, sizeUsd: p.sizeUsd, reason, pnlUsd, ofi: p.ofi, vol: p.vol });
        onEvent({ type: 'close', sym, dir: p.dir, reason, pnlUsd, entry: p.entry, exit });
      }
      return;
    }

    // 2. Исполнение отложенного входа после латентности.
    if (s.pending) {
      if (t.ts >= s.pending.signalTs + config.ofmLatencyMs) {
        if (book && book.bid > 0 && book.ask > 0) {
          const dir = s.pending.dir;
          const raw = dir > 0 ? book.ask : book.bid;
          const entry = raw * (1 + dir * config.ofmEntrySlipBps / 1e4);       // слиппедж входа (хуже)
          const target = entry * (1 + dir * config.ofmTargetBps / 1e4);
          const stop = entry * (1 - dir * config.ofmStopBps / 1e4);
          s.pos = { dir, entry, target, stop, openTs: t.ts, sizeUsd: config.ofmSizeUsd, ofi: s.pending.ofi, vol: s.pending.vol, exitVol: 0 };
          openNow++;
          onEvent({ type: 'open', sym, dir, entry });
        }
        s.pending = null;
      }
      return;
    }

    // 3. Онлайн-калибровка порогов.
    s.ofiHist.push(Math.abs(ofi)); s.volHist.push(volNow);
    if (s.ofiHist.length > config.ofmRingSize) s.ofiHist.shift();
    if (s.volHist.length > config.ofmRingSize) s.volHist.shift();
    if (++s.calN % 50 === 0) { s.ofiThr = pctile(s.ofiHist, config.ofmOfiPct) ?? Infinity; s.volThr = pctile(s.volHist, config.ofmVolPct) ?? 0; }
    if (s.ofiHist.length < 200) return; // прогрев
    if (eligible && !eligible.has(sym)) return;
    while (s.pnlWin.length && s.pnlWin[0].ts < t.ts - config.ofmPnlWindowMs) s.pnlWin.shift();
    if (s.pnlWin.length >= config.ofmPnlWarmup && s.pnlWin.reduce((a, x) => a + x.pnl, 0) < 0) return;

    // 4. Сигнал → отложенный вход (исполнится через латентность).
    if (Math.abs(ofi) >= s.ofiThr && volNow <= s.volThr && ofi !== 0 && book && book.bid > 0 && book.ask > 0) {
      s.pending = { dir: Math.sign(ofi), signalTs: t.ts, ofi, vol: volNow };
    }
  }

  return { onTrade, openCount: () => openNow, setEligible: (set) => { eligible = set; } };
}

export default { createMomentumEngine };
