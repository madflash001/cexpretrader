// Дашборд: Express (REST + статика) + WebSocket (live-пуш) на одном порту (3001).
// Получает движки (для счётчиков по стратегиям) и общий liveSpread.
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import db from '../storage/db.js';
import { config } from '../config/env.js';
import { cexPriceMap } from '../feed/gateFeed.js';

export function startServer({ engines = [], liveSpread = new Map() } = {}) {
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
  const counters = () => engines.map((e) => e.getCounters());

  const app = express();
  const webDir = fileURLToPath(new URL('../../web', import.meta.url));
  app.get('/api/live', (req, res) => res.json(liveSorted(Number(req.query.limit) || 200)));
  app.get('/api/counters', (req, res) => res.json(counters()));
  app.get('/api/positions', (req, res) => res.json(db.getRecentPositions(Math.min(Number(req.query.limit) || 200, 1000))));
  app.get('/api/watchlist', (req, res) => res.json(db.getWatchlist()));
  app.use(express.static(webDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const push = () => {
    const msg = JSON.stringify({ type: 'tick', counters: counters(), live: liveSorted(100) });
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  const timer = setInterval(push, 1000);

  server.listen(config.webPort, () => console.log(`[web] дашборд: http://localhost:${config.webPort}`));
  return { stop() { clearInterval(timer); for (const c of wss.clients) c.terminate(); server.close(); } };
}

export default { startServer };
