// DEX-сторона (горячий путь): подписка на событие Swap целевых V3-пулов через
// WebSocket Alchemy, по одному соединению на сеть. Цена берётся ПРЯМО из события
// (sqrtPriceX96), без доп. RPC-запросов — минимальная латентность.
//
// Надёжность: слушатель 'error' на ws вешается СИНХРОННО через фабрику сокета —
// иначе одиночный сбой (напр. 403 на сети без поддержки WSS) бросает unhandled
// 'error' и валит весь процесс. Сбой одной сети не должен ронять сканер.
// Соединение самовосстанавливается (reconnect+resubscribe); после MAX_RETRIES
// подряд — сеть отключается с понятным сообщением.
import { ethers } from 'ethers';
import WebSocket from 'ws';
import { config } from '../config/env.js';
import { getDexConfig } from '../config/dexRegistry.js';
import { priceFromSqrt } from '../connectors/dexV3.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const MAX_RETRIES = 8;

/**
 * Запустить DEX-фид по watchlist. Возвращает { stop(), chains }.
 * @param {Array} watchlist — строки из db.getWatchlist()
 * @param {(tick:{symbol,gateSymbol,chainId,dexPrice,poolAddress,ts,blockNumber})=>void} onTick
 * @param {(evt:{chainId,type,detail})=>void} [onStatus]
 */
export function startDexFeed(watchlist, onTick, onStatus = () => {}) {
  const byChain = new Map();
  for (const w of watchlist) {
    if (!byChain.has(w.chainId)) byChain.set(w.chainId, { pools: [], index: new Map() });
    const g = byChain.get(w.chainId);
    g.pools.push(w.poolAddress);
    g.index.set(w.poolAddress.toLowerCase(), w);
  }

  const conns = [];
  for (const [chainId, g] of byChain) {
    const cfg = getDexConfig(chainId);
    const url = config.alchemyWss[chainId];
    if (!cfg) { onStatus({ chainId, type: 'skip', detail: 'нет в реестре' }); continue; }
    if (!url) { onStatus({ chainId, type: 'skip', detail: 'не задан ALCHEMY_WSS (вставьте ключ)' }); continue; }
    conns.push(new ChainConnection(chainId, cfg, url, g, onTick, onStatus));
  }

  for (const c of conns) c.connect();
  return {
    stop() { for (const c of conns) c.stop(); },
    chains: conns.map((c) => c.chainId),
  };
}

class ChainConnection {
  constructor(chainId, cfg, url, group, onTick, onStatus) {
    this.chainId = chainId;
    this.cfg = cfg;
    this.url = url;
    this.group = group;
    this.onTick = onTick;
    this.onStatus = onStatus;
    this.iface = new ethers.Interface([cfg.swapAbi]);
    this.filter = { address: group.pools, topics: [cfg.swapTopic] };
    this.network = new ethers.Network(cfg.name, chainId);
    this.provider = null;
    this.retries = 0;
    this.stopped = false;
    this._reconnecting = false;
    this.handler = (log) => this.onLog(log);
  }

  connect() {
    if (this.stopped) return;
    try {
      // Фабрика сокета: вешаем 'error'/'close' СИНХРОННО, до любых сетевых событий.
      this.provider = new ethers.WebSocketProvider(() => {
        const ws = new WebSocket(this.url);
        ws.on('error', (e) => this.onSocketError(e));
        ws.on('close', () => this.onSocketClose());
        return ws;
      }, this.network, { staticNetwork: this.network });
    } catch (e) {
      this.onStatus({ chainId: this.chainId, type: 'error', detail: `create: ${e.message}` });
      return this.scheduleReconnect();
    }

    this.provider.on(this.filter, this.handler).then(
      () => { this.retries = 0; this.onStatus({ chainId: this.chainId, type: 'connected', detail: `${this.group.pools.length} пулов` }); },
      (e) => { this.onStatus({ chainId: this.chainId, type: 'error', detail: `subscribe: ${e.message}` }); this.scheduleReconnect(); },
    );
  }

  onSocketError(e) {
    this.onStatus({ chainId: this.chainId, type: 'error', detail: `socket: ${e?.message || 'err'}` });
    this.scheduleReconnect();
  }

  onSocketClose() {
    this.onStatus({ chainId: this.chainId, type: 'closed', detail: 'socket close' });
    this.scheduleReconnect();
  }

  onLog(log) {
    try {
      const w = this.group.index.get(String(log.address).toLowerCase());
      if (!w) return;
      const parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      const sqrt = parsed.args.sqrtPriceX96;
      const dexPrice = priceFromSqrt(sqrt, w.decimals, w.quoteDecimals, !!w.tokenIsFirst);
      if (!(dexPrice > 0)) return;
      this.onTick({
        symbol: w.symbol,
        gateSymbol: w.gateSymbol,
        chainId: this.chainId,
        dexPrice,
        poolAddress: w.poolAddress,
        ts: Date.now(),
        blockNumber: log.blockNumber,
      });
    } catch (e) {
      this.onStatus({ chainId: this.chainId, type: 'error', detail: `decode: ${e.message}` });
    }
  }

  scheduleReconnect() {
    if (this.stopped || this._reconnecting) return;
    this._reconnecting = true;
    this.cleanup();
    if (this.retries >= MAX_RETRIES) {
      this.stopped = true;
      this.onStatus({ chainId: this.chainId, type: 'giveup', detail: `сеть отключена после ${MAX_RETRIES} неудач (проверьте поддержку WSS/доступ Alchemy)` });
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.retries, RECONNECT_MAX_MS);
    this.retries += 1;
    this.onStatus({ chainId: this.chainId, type: 'reconnect', detail: `через ${delay}мс (попытка ${this.retries}/${MAX_RETRIES}; возможен пропуск событий)` });
    setTimeout(() => { this._reconnecting = false; this.connect(); }, delay);
  }

  cleanup() {
    if (!this.provider) return;
    try { this.provider.destroy(); } catch { /* noop */ }
    this.provider = null;
  }

  stop() { this.stopped = true; this.cleanup(); }
}

export default { startDexFeed };
