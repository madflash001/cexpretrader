// Реестр DEX по сетям (V3-пулы). Для каждой сети: фабрика/квотер V3, fee-тиры,
// котировочные стейблы (для поиска пула и расчёта цены в USD) и сигнатура Swap.
//
// ВАЖНО: топик/ABI события Swap различаются у Uniswap V3 и Pancake V3 —
//   Uniswap V3:  Swap(address,address,int256,int256,uint160,uint128,int24)
//   Pancake V3:  Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)
// → разный topic0 и layout data. sqrtPriceX96 (5-й непроиндексированный) есть в обоих.
//
// АДРЕСА ниже — публичные канонические; перед боевым прогоном свериться (особенно
// квотеры и стейблы Base), т.к. сейчас не проверены живым RPC (нет ключей Alchemy).
import { ethers } from 'ethers';

// keccak256 сигнатур событий Swap.
export const UNIV3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
export const PANCAKEV3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');

// ABI событий (для декодирования data).
export const UNIV3_SWAP_ABI = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)';
export const PANCAKEV3_SWAP_ABI = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)';

// Multicall3 — один адрес во всех основных EVM-сетях.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** @typedef {{symbol:string, address:string, decimals:number}} Quote */

export const DEX_REGISTRY = {
  // ── Ethereum (Uniswap V3) ────────────────────────────────────────────────
  1: {
    chainId: 1,
    name: 'Ethereum',
    dex: 'uniswapv3',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // QuoterV2
    feeTiers: [100, 500, 3000, 10000],
    swapTopic: UNIV3_SWAP_TOPIC,
    swapAbi: UNIV3_SWAP_ABI,
    quotes: [
      { symbol: 'USDT', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
      { symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
    ],
  },
  // ── BSC (PancakeSwap V3) ─────────────────────────────────────────────────
  56: {
    chainId: 56,
    name: 'BSC',
    dex: 'pancakev3',
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    feeTiers: [100, 500, 2500, 10000],
    swapTopic: PANCAKEV3_SWAP_TOPIC,
    swapAbi: PANCAKEV3_SWAP_ABI,
    quotes: [
      { symbol: 'USDT', address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
      { symbol: 'USDC', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
    ],
  },
  // ── Base (Uniswap V3) — у Base СВОЙ factory/quoter, не как у Ethereum ──────
  8453: {
    chainId: 8453,
    name: 'Base',
    dex: 'uniswapv3',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // QuoterV2
    feeTiers: [100, 500, 3000, 10000],
    swapTopic: UNIV3_SWAP_TOPIC,
    swapAbi: UNIV3_SWAP_ABI,
    quotes: [
      { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
    ],
  },
};

/** Список поддерживаемых chainId (порядок = приоритет). */
export const SUPPORTED_CHAINS = [1, 56, 8453];

export function getDexConfig(chainId) {
  return DEX_REGISTRY[chainId] || null;
}

export default { DEX_REGISTRY, SUPPORTED_CHAINS, getDexConfig, MULTICALL3, UNIV3_SWAP_TOPIC, PANCAKEV3_SWAP_TOPIC };
