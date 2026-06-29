// Обобщённый клиент к V3-DEX (Uniswap V3 / Pancake V3) для произвольной сети.
// Generalization of DEXArbitrage/src/connectors/pancakeV3.js: параметризован
// сетью (provider/factory/quotes) через config/dexRegistry.js.
//
// Discovery (холодный путь, HTTP-RPC):
//   - discoverPools: getPool по всем (quote × fee-тир) — один multicall;
//   - readQuoteLiquidity: баланс quote на адресе пула (TVL по котировке);
//   - readDecimals: on-chain decimals токена;
//   - readSlot0: sqrtPriceX96 (спот-цена) для якоря по цене перпа.
import { ethers } from 'ethers';
import { getDexConfig, MULTICALL3 } from '../config/dexRegistry.js';
import { config } from '../config/env.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const MULTICALL_CHUNK = 100;
const MULTICALL_CONCURRENCY = 6;

const factoryIface = new ethers.Interface([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);
const poolIface = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
]);
const erc20Iface = new ethers.Interface([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/** token0 в V3 — адрес с меньшим числовым значением. */
export function isTokenFirst(tokenAddress, quoteAddress) {
  return BigInt(tokenAddress) < BigInt(quoteAddress);
}

/**
 * Спот-цена токена в котировке (USD-стейбл) из sqrtPriceX96.
 * sqrtPriceX96 = sqrt(token1_raw / token0_raw) * 2^96.
 */
export function priceFromSqrt(sqrtPriceX96, tokenDecimals, quoteDecimals, tokenIsFirst) {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return 0;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const rawP = sqrtP * sqrtP; // token1_raw / token0_raw
  const decFactor = 10 ** (tokenDecimals - quoteDecimals);
  // токен = token0 → цена = rawP * 10^(decTok-decQuote); иначе обратное.
  return tokenIsFirst ? rawP * decFactor : decFactor / rawP;
}

/**
 * Создать клиент DEX для сети chainId. Бросает, если нет HTTP-RPC URL или сеть
 * не в реестре.
 */
export function makeDexClient(chainId) {
  const cfg = getDexConfig(chainId);
  if (!cfg) throw new Error(`dexV3: сеть ${chainId} не в реестре`);
  const url = config.alchemyHttp[chainId];
  if (!url) throw new Error(`dexV3: не задан ALCHEMY_HTTP для сети ${chainId}`);

  const network = new ethers.Network(cfg.name, chainId);
  const provider = new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
  const multicall = new ethers.Contract(
    MULTICALL3,
    ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'],
    provider,
  );

  async function aggregate3Chunked(calls) {
    const chunks = [];
    for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) chunks.push(calls.slice(i, i + MULTICALL_CHUNK));
    const results = new Array(chunks.length);
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const idx = next++;
        results[idx] = await multicall.aggregate3.staticCall(chunks[idx]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(MULTICALL_CONCURRENCY, chunks.length) }, worker));
    return results.flat();
  }

  /**
   * Пулы SYMBOL/QUOTE по всем котировкам × fee-тирам (один multicall).
   * @param {Array<{symbol,address,...}>} tokens
   * @returns {Promise<Array<{...token, quote, poolAddress, fee, tokenIsFirst}>>}
   */
  async function discoverPools(tokens) {
    const specs = [];
    for (const t of tokens) {
      for (const quote of cfg.quotes) {
        if (t.address.toLowerCase() === quote.address.toLowerCase()) continue; // сам стейбл
        for (const fee of cfg.feeTiers) specs.push({ token: t, quote, fee });
      }
    }
    if (!specs.length) return [];
    const calls = specs.map((s) => ({
      target: cfg.factory,
      allowFailure: true,
      callData: factoryIface.encodeFunctionData('getPool', [s.token.address, s.quote.address, s.fee]),
    }));
    const results = await aggregate3Chunked(calls);

    const pools = [];
    results.forEach((res, i) => {
      if (!res.success) return;
      const [pool] = factoryIface.decodeFunctionResult('getPool', res.returnData);
      if (pool === ZERO) return;
      const { token, quote, fee } = specs[i];
      pools.push({
        ...token,
        quote,
        poolAddress: pool.toLowerCase(),
        fee,
        tokenIsFirst: isTokenFirst(token.address, quote.address),
      });
    });
    return pools;
  }

  /** Ликвидность по котировочной стороне: баланс quote на адресе пула (human). */
  async function readQuoteLiquidity(pools) {
    if (!pools.length) return new Map();
    const calls = pools.map((p) => ({
      target: p.quote.address,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData('balanceOf', [p.poolAddress]),
    }));
    const results = await aggregate3Chunked(calls);
    const out = new Map();
    results.forEach((res, i) => {
      if (!res.success) return;
      const [bal] = erc20Iface.decodeFunctionResult('balanceOf', res.returnData);
      out.set(pools[i].poolAddress, Number(ethers.formatUnits(bal, pools[i].quote.decimals)));
    });
    return out;
  }

  /** On-chain decimals токенов (один multicall). */
  async function readDecimals(addresses) {
    if (!addresses.length) return new Map();
    const calls = addresses.map((a) => ({
      target: a,
      allowFailure: true,
      callData: erc20Iface.encodeFunctionData('decimals', []),
    }));
    const results = await aggregate3Chunked(calls);
    const out = new Map();
    results.forEach((res, i) => {
      if (!res.success) return;
      try {
        const [d] = erc20Iface.decodeFunctionResult('decimals', res.returnData);
        out.set(addresses[i], Number(d));
      } catch { /* нестандартный токен — пропускаем */ }
    });
    return out;
  }

  /** sqrtPriceX96 пулов из slot0 (один multicall). poolAddress -> bigint. */
  async function readSlot0(pools) {
    if (!pools.length) return new Map();
    const calls = pools.map((p) => ({
      target: p.poolAddress,
      allowFailure: true,
      callData: poolIface.encodeFunctionData('slot0', []),
    }));
    const results = await aggregate3Chunked(calls);
    const out = new Map();
    results.forEach((res, i) => {
      if (!res.success) return;
      try {
        const decoded = poolIface.decodeFunctionResult('slot0', res.returnData);
        out.set(pools[i].poolAddress, decoded[0]);
      } catch { /* пул без ликвидности/битый slot0 */ }
    });
    return out;
  }

  return { chainId, cfg, provider, discoverPools, readQuoteLiquidity, readDecimals, readSlot0 };
}

export default { makeDexClient, isTokenFirst, priceFromSqrt };
