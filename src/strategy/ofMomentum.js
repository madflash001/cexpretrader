// Order-flow momentum (PAPER, без реальных ордеров). Гипотеза (подтверждена офлайн):
// сильный дисбаланс агрессивного потока (OFI за окно) в НИЗКОволатильном режиме →
// цена продолжает в сторону потока. Вход тейкером по сигналу; выход = мейкер-лимит на
// цель ИЛИ тейкер-стоп/таймаут при развороте. Пороги калибруются ОНЛАЙН по скользящему
// окну (перцентили |OFI| и vol на символ) — без заглядывания в будущее.
import config from '../config/env.js';

const MAKER = config.ofmMakerFee, TAKER = config.ofmTakerFee;
const pctile = (arr, p) => { if (arr.length < 50) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

export function createMomentumEngine({ onEvent = () => {}, recordPosition = () => {} } = {}) {
  const st = new Map();
  let openNow = 0;
  let eligible = null; // null = торговать все (до первого скана); Set = только эти символы
  function S(sym) {
    let s = st.get(sym);
    if (!s) st.set(sym, s = { buf: [], sum: 0, vol: 0, prevMid: null, ofiHist: [], volHist: [], ofiThr: Infinity, volThr: 0, calN: 0, pos: null });
    return s;
  }

  /** @param {object} t {ts, price, amount, side}  @param {object} book {bid, ask} */
  function onTrade(sym, t, book) {
    const s = S(sym);
    const mid = (book && book.bid > 0 && book.ask > 0) ? (book.bid + book.ask) / 2 : t.price;
    if (s.prevMid) { const r = (mid - s.prevMid) / s.prevMid; s.vol = 0.94 * s.vol + 0.06 * r * r; }
    s.prevMid = mid;
    const volNow = Math.sqrt(s.vol);

    // OFI за окно
    const sn = (t.side === 'buy' ? 1 : t.side === 'sell' ? -1 : 0) * t.amount * t.price;
    s.buf.push({ ts: t.ts, sn }); s.sum += sn;
    const cutoff = t.ts - config.ofmWindowMs;
    while (s.buf.length && s.buf[0].ts < cutoff) s.sum -= s.buf.shift().sn;
    const ofi = s.sum;

    // Управление открытой позицией (выход по этому трейду)
    if (s.pos) {
      const p = s.pos;
      const hitTarget = p.dir > 0 ? t.price >= p.target : t.price <= p.target;
      const hitStop = p.dir > 0 ? t.price <= p.stop : t.price >= p.stop;
      const timeout = t.ts - p.openTs >= config.ofmMaxHoldMs;
      if (hitTarget || hitStop || timeout) {
        let exit, exitFee, reason;
        if (hitTarget && !hitStop) { exit = p.target; exitFee = MAKER; reason = 'target'; }      // мейкер-выход на цель
        else { exit = p.dir > 0 ? (book?.bid ?? t.price) : (book?.ask ?? t.price); exitFee = TAKER; reason = hitStop ? 'stop' : 'timeout'; }
        const gross = p.dir > 0 ? (exit - p.entry) / p.entry : (p.entry - exit) / p.entry;
        const pnlUsd = (gross - TAKER - exitFee) * p.sizeUsd;                                       // вход был тейкером
        s.pos = null; openNow--;
        recordPosition({ symbol: sym, direction: p.dir > 0 ? 'long' : 'short', openTs: p.openTs, closeTs: t.ts, entry: p.entry, exit, sizeUsd: p.sizeUsd, reason, pnlUsd, ofi: p.ofi, vol: p.vol });
        onEvent({ type: 'close', sym, dir: p.dir, reason, pnlUsd, entry: p.entry, exit });
      }
      return; // одна позиция на символ
    }

    // Онлайн-калибровка порогов
    s.ofiHist.push(Math.abs(ofi)); s.volHist.push(volNow);
    if (s.ofiHist.length > config.ofmRingSize) s.ofiHist.shift();
    if (s.volHist.length > config.ofmRingSize) s.volHist.shift();
    if (++s.calN % 50 === 0) { s.ofiThr = pctile(s.ofiHist, config.ofmOfiPct) ?? Infinity; s.volThr = pctile(s.volHist, config.ofmVolPct) ?? 0; }
    if (s.ofiHist.length < 200) return; // прогрев
    if (eligible && !eligible.has(sym)) return; // вне eligible-набора — не входим (выходы уже обработаны выше)

    // Сигнал входа: сильный OFI + низкий вол
    if (Math.abs(ofi) >= s.ofiThr && volNow <= s.volThr && ofi !== 0 && book && book.bid > 0 && book.ask > 0) {
      const dir = Math.sign(ofi);
      const entry = dir > 0 ? book.ask : book.bid; // тейкер-вход
      const target = entry * (1 + dir * config.ofmTargetBps / 1e4);
      const stop = entry * (1 - dir * config.ofmStopBps / 1e4);
      s.pos = { dir, entry, target, stop, openTs: t.ts, sizeUsd: config.ofmSizeUsd, ofi, vol: volNow };
      openNow++;
      onEvent({ type: 'open', sym, dir, entry, ofi, vol: volNow });
    }
  }

  return { onTrade, openCount: () => openNow, setEligible: (set) => { eligible = set; } };
}

export default { createMomentumEngine };
