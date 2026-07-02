// Дашборд: Express + WebSocket на :3001. Показывает сбор ленты и paper-стратегию momentum.
import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import db from '../storage/db.js';
import { config } from '../config/env.js';

export function startServer() {
  const startTs = Date.now();
  const collectStats = () => {
    const rows = db.getTradeStats();
    const total = rows.reduce((a, r) => a + r.n, 0);
    const mins = Math.max(1, (Date.now() - startTs) / 60000);
    return { total, perMin: total / mins, symbols: rows.slice(0, 30) };
  };

  const app = express();
  const webDir = fileURLToPath(new URL('../../web', import.meta.url));
  app.get('/api/collect', (req, res) => res.json(collectStats()));
  app.get('/api/ofm', (req, res) => res.json(db.getOfStats()));
  app.use(express.static(webDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  const push = () => {
    const msg = JSON.stringify({ type: 'tick', collect: collectStats(), ofm: db.getOfStats() });
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
  };
  const timer = setInterval(push, 1000);

  server.listen(config.webPort, () => console.log(`[web] дашборд: http://localhost:${config.webPort}`));
  return { stop() { clearInterval(timer); for (const c of wss.clients) c.terminate(); server.close(); } };
}

export default { startServer };
