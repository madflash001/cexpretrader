// Команда обнаружения универсума пулов для сканера. Запуск: npm run discover.
//
// Универсум: линейные USDT-перпы Gate, чей базовый токен имеет EVM-адрес от Gate
// на ETH/BSC/Base И ликвидный V3-пул против стейбла. Сеть выбирается ЯКОРЕМ ПО
// ЦЕНЕ ПЕРПА: берётся пул, чья спот-цена (slot0) ближе всего к цене перпа; если
// даже лучшая расходится больше порога — токен на DEX неверный/мёртвый, отброс.
// Результат — полная замена таблицы watchlist. Сканер читает её из БД.
import { pathToFileURL } from 'node:url';
import config from '../config/env.js';
import db from '../storage/db.js';
import gateFutures from '../connectors/gateFutures.js';
import { makeDexClient, priceFromSqrt } from '../connectors/dexV3.js';
import { SUPPORTED_CHAINS, getDexConfig } from '../config/dexRegistry.js';
import { CHAIN_NAME } from '../config/chains.js';

/**
 * Собрать универсум пулов и полностью заменить таблицу watchlist.
 * Вызывается командой `npm run discover` И автоматически из index.js, если
 * watchlist устарел. Возвращает число записанных строк (не делает process.exit).
 */
export async function buildWatchlist() {
  console.log('discover — загрузка рынков/валют Gate (swap)…');
  db.init();
  await gateFutures.init();

  // (1) Перпы + цены/объёмы (якорь и фильтр ликвидности перпа).
  const contracts = gateFutures.listContracts();
  let tickers = {};
  try { tickers = await gateFutures.fetchTickers(contracts.map((c) => c.symbol)); }
  catch (e) { console.warn(`[discover] fetchTickers: ${e.message}`); }

  // (2) Кандидаты: символ -> адреса на разрешённых сетях.
  const candidates = []; // {symbol, gateSymbol, chainId, address, perpLast}
  let volSkipped = 0, exclSkipped = 0;
  for (const c of contracts) {
    if (config.excludeSymbols.has(String(c.base).toUpperCase())) { exclSkipped += 1; continue; }
    const t = tickers[c.symbol];
    const perpLast = t && t.last != null ? Number(t.last) : null;
    const vol = t && t.quoteVolume != null ? Number(t.quoteVolume) : null;
    if (!perpLast) continue;
    if (vol != null && vol < config.minPerpVolumeUsd) { volSkipped += 1; continue; }
    for (const a of gateFutures.getEvmAddresses(c.base)) {
      if (!SUPPORTED_CHAINS.includes(a.chainId)) continue;
      candidates.push({ symbol: c.base, gateSymbol: c.symbol, chainId: a.chainId, address: a.address, perpLast });
    }
  }
  console.log(`перпов: ${contracts.length}, кандидатов (символ×сеть): ${candidates.length}, отсеяно по объёму: ${volSkipped}, по списку исключений (${[...config.excludeSymbols].join('/')}): ${exclSkipped}`);

  // (3) По сетям: найти лучший (ликвиднейший) пул каждого символа + спот-цену.
  const byChain = new Map();
  for (const c of candidates) {
    if (!byChain.has(c.chainId)) byChain.set(c.chainId, []);
    byChain.get(c.chainId).push(c);
  }

  const perSymbolPerChain = []; // {symbol, chainId, perpLast, pool, liq, price, decimals, quote}
  for (const chainId of SUPPORTED_CHAINS) {
    const list = byChain.get(chainId);
    if (!list || !list.length) continue;
    let client;
    try { client = makeDexClient(chainId); }
    catch (e) { console.warn(`[discover] сеть ${CHAIN_NAME[chainId] || chainId} пропущена: ${e.message}`); continue; }

    try {
    // уникальные токены на этой сети
    const seen = new Map(); // symbol -> {symbol,address}
    for (const c of list) if (!seen.has(c.symbol)) seen.set(c.symbol, { symbol: c.symbol, address: c.address });
    const tokens = [...seen.values()];

    const pools = await client.discoverPools(tokens);
    const liq = await client.readQuoteLiquidity(pools);

    // лучший пул на символ (по ликвидности котировки)
    const bestBySymbol = new Map();
    for (const p of pools) {
      const l = liq.get(p.poolAddress) ?? 0;
      const prev = bestBySymbol.get(p.symbol);
      if (!prev || l > prev.liq) bestBySymbol.set(p.symbol, { pool: p, liq: l });
    }

    const survivors = [...bestBySymbol.values()].filter((b) => b.liq >= config.minLiquidityUsd);
    if (!survivors.length) { console.log(`[${CHAIN_NAME[chainId] || chainId}] пулов выше порога ликвидности: 0`); continue; }

    const decimals = await client.readDecimals(survivors.map((b) => b.pool.address));
    const slot0 = await client.readSlot0(survivors.map((b) => b.pool));

    let added = 0;
    for (const b of survivors) {
      const dec = decimals.get(b.pool.address);
      if (!Number.isInteger(dec)) continue; // токен «мёртвый»
      const sqrt = slot0.get(b.pool.poolAddress);
      if (!sqrt) continue;
      const price = priceFromSqrt(sqrt, dec, b.pool.quote.decimals, b.pool.tokenIsFirst);
      if (!(price > 0)) continue;
      const cand = list.find((c) => c.symbol === b.pool.symbol);
      perSymbolPerChain.push({
        symbol: b.pool.symbol, gateSymbol: cand?.gateSymbol, chainId, perpLast: cand?.perpLast,
        pool: b.pool, liq: b.liq, price, decimals: dec, quote: b.pool.quote,
      });
      added += 1;
    }
    console.log(`[${CHAIN_NAME[chainId] || chainId}] пулов с ценой: ${added} (из ${survivors.length} ликвидных)`);
    } catch (e) {
      console.warn(`[discover] сеть ${CHAIN_NAME[chainId] || chainId}: ошибка on-chain чтения (${e.message}) — сеть пропущена. Если это BSC — включите BNB Mainnet в приложении Alchemy.`);
    }
  }

  // (4) Якорь по цене перпа: на символ выбрать сеть с ближайшей DEX-ценой.
  const bySymbol = new Map();
  for (const e of perSymbolPerChain) {
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
    bySymbol.get(e.symbol).push(e);
  }
  const tol = config.anchorTolerancePct / 100;
  const rows = [];
  const perChainCount = {};
  let offAnchor = 0;
  const createdTs = Date.now();
  for (const [symbol, list] of bySymbol) {
    let best = null, bestDiff = Infinity;
    for (const e of list) {
      if (!e.perpLast) continue;
      const diff = Math.abs(e.price / e.perpLast - 1);
      if (diff < bestDiff) { bestDiff = diff; best = e; }
    }
    if (!best) continue;
    if (bestDiff > tol) { offAnchor += 1; continue; }
    rows.push({
      symbol,
      gateSymbol: best.gateSymbol,
      chainId: best.chainId,
      dex: getDexConfig(best.chainId).dex,
      poolAddress: best.pool.poolAddress,
      tokenAddress: best.pool.address,
      quoteSymbol: best.quote.symbol,
      decimals: best.decimals,
      quoteDecimals: best.quote.decimals,
      tokenIsFirst: best.pool.tokenIsFirst ? 1 : 0,
      fee: best.pool.fee,
      liquidityUsd: best.liq,
      createdTs,
    });
    perChainCount[best.chainId] = (perChainCount[best.chainId] || 0) + 1;
  }

  db.replaceWatchlist(rows);
  const chainStr = Object.entries(perChainCount).map(([k, v]) => `${CHAIN_NAME[k] || k}:${v}`).join(', ');
  console.log(`watchlist записано: ${rows.length} (${chainStr}); отсеяно по якорю>${config.anchorTolerancePct}%: ${offAnchor}`);
  return rows.length;
}

// CLI: `npm run discover` (но НЕ при импорте из index.js).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildWatchlist()
    .then(() => process.exit(0))
    .catch((e) => { console.error('Ошибка discover:', e); process.exit(1); });
}
