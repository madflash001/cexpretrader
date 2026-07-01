// Дашборд: Express (REST + статика) + WebSocket (live-пуш) на одном порту (3001).
// Показывает live-спреды (DEX-тест) и статистику сбора ленты сделок (MM-тест).
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import db from '../storage/db.js';
import { config } from '../config/env.js';
import { cexPriceMap } from '../feed/gateFeed.js';

export function startServer({ liveSpread = new Map() } = {}) {
  // Список строим из watchlist (снимок на старте — меняется только при discover→рестарт),
  // чтобы КАЖДЫЙ символ был виден сразу, даже до первого DEX-свопа. Цена Gate (cexLive)
  // и её возраст берутся из cexPriceMap (обновляется по WS постоянно). DEX-цена/спред —
  // из liveSpread, появляются после первого свопа символа (до него — null/«—»).
  const watchlist = db.getWatchlist();
  const liveSorted = (limit = 200) => {
    const rows = watchlist.map((w) => {
      const ls = liveSpread.get(w.symbol);
      const p = cexPriceMap.get(w.gateSymbol);
      return {
        symbol: w.symbol, gateSymbol: w.gateSymbol, chainId: w.chainId,
        dexPrice: ls ? ls.dexPrice : null,
        cexMid: ls ? ls.cexMid : null,
        spreadPct: ls ? ls.spreadPct : null,
        ts: ls ? ls.ts : null,
        cexLive: p ? (p.mid ?? null) : null,
        cexAgeMs: (p && p.ts) ? Date.now() - p.ts : null,
      };
    });
    rows.sort((a, b) => (b.spreadPct == null ? -1 : Math.abs(b.spreadPct)) - (a.spreadPct == null ? -1 : Math.abs(a.spreadPct)));
    return rows.slice(0, limit);
  };
  // Статистика сбора ленты сделок (MM-тест): трейдов на символ + темп (за сессию).
  const startTs = Date.now();
  const collectStats = () => {
    const rows = db.getTradeStats();
    const total = rows.reduce((a, r) => a + r.n, 0);
    const mins = Math.max(1, (Date.now() - startTs) / 60000);
    return { total, perMin: total / mins, symbols: rows.slice(0, 30) };
  };

  const app = express();
  const webDir = fileURLToPath(new URL('../../web', import.meta.url));
  app.get('/api/live', (req, res) => res.json(liveSorted(Number(req.query.limit) || 200)));
  app.get('/api/collect', (req, res) => res.json(collectStats()));
  app.get('/api/ofm', (req, res) => res.json(db.getOfStats()));
  app.get('/api/watchlist', (req, res) => res.json(db.getWatchlist()));
  app.use(express.static(webDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const push = () => {
    const msg = JSON.stringify({ type: 'tick', live: liveSorted(100), collect: collectStats(), ofm: db.getOfStats() });
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  const timer = setInterval(push, 1000);

  server.listen(config.webPort, () => console.log(`[web] дашборд: http://localhost:${config.webPort}`));
  return { stop() { clearInterval(timer); for (const c of wss.clients) c.terminate(); server.close(); } };
}

export default { startServer };
