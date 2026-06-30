// Quoter-замер исполнимой цены ПОКУПКИ токена на DEX (реальный слиппедж по кривой
// концентрированной ликвидности пула). Зовём QuoterV2.quoteExactInputSingle через
// eth_call (staticCall): сколько токенов получим за $X стейбла → исполнимая цена.
// HTTP-RPC — бесплатный PublicNode (config.quoteHttp), Alchemy CU не тратится.
import { ethers } from 'ethers';
import config from '../config/env.js';
import { getDexConfig } from '../config/dexRegistry.js';

// QuoterV2 (Uniswap V3 / Pancake V3 — одинаковый struct-интерфейс).
const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const clients = new Map(); // chainId -> { quoter, cfg } | null
function client(chainId) {
  if (clients.has(chainId)) return clients.get(chainId);
  const cfg = getDexConfig(chainId);
  const url = config.quoteHttp[chainId];
  if (!cfg || !cfg.quoter || !url) { clients.set(chainId, null); return null; }
  const provider = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
  const c = { quoter: new ethers.Contract(cfg.quoter, QUOTER_ABI, provider), cfg };
  clients.set(chainId, c);
  return c;
}

/**
 * Исполнимая цена покупки `sizeUsd` токена (USD за токен) по реальной ликвидности пула.
 * @param {object} w — строка watchlist {chainId, tokenAddress, decimals, quoteSymbol, fee}
 * @param {number} sizeUsd — размер покупки в USD (целое)
 * @returns {Promise<number|null>} USD/токен после слиппеджа, либо null
 */
export async function quoteBuy(w, sizeUsd) {
  const c = client(w.chainId);
  if (!c) return null;
  const quote = c.cfg.quotes.find((q) => q.symbol === w.quoteSymbol) || c.cfg.quotes[0];
  if (!quote) return null;
  const amountIn = BigInt(Math.round(sizeUsd)) * 10n ** BigInt(quote.decimals);
  const res = await c.quoter.quoteExactInputSingle.staticCall({
    tokenIn: quote.address, tokenOut: w.tokenAddress, amountIn, fee: w.fee, sqrtPriceLimitX96: 0n,
  });
  const tokensOut = Number(res[0]) / 10 ** w.decimals;
  return tokensOut > 0 ? sizeUsd / tokensOut : null;
}

export default { quoteBuy };
