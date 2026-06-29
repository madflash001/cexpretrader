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
  // Живая цена Gate и её возраст (cexPriceMap обновляется по WS постоянно, в отличие
  // от спреда, который пересчитывается лишь на DEX-тике). Так видно, что Gate жив.
  const enrich = (row) => {
    const p = cexPriceMap.get(row.gateSymbol);
    return { ...row, cexLive: p ? (p.mid ?? null) : null, cexAgeMs: (p && p.ts) ? Date.now() - p.ts : null };
  };
  const liveSorted = (limit = 200) => [...liveSpread.values()].sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct)).slice(0, limit).map(enrich);
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
