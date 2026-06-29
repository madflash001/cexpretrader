// Нормализация имён сетей: одна и та же сеть называется по-разному у разных CEX.
// Напр. BSC: Gate отдаёт сеть как 'BEP20', другие биржи — 'BSC' / 'BNB Smart Chain'.
// Это позволяет коннектору находить нужную сеть монеты независимо от биржи.
export const CHAIN_NETWORK_ALIASES = {
  BSC: ['BEP20', 'BSC', 'BNB SMART CHAIN', 'BNB_SMART_CHAIN', 'BSC-BEP20'],
};

/** Список алиасов (в верхнем регистре) для ключа сети. */
export function resolveNetworkAliases(chainKey) {
  return CHAIN_NETWORK_ALIASES[chainKey] || [String(chainKey).toUpperCase()];
}

/**
 * Найти запись сети `chainKey` среди `networks` валюты ccxt.
 * Сопоставляет по ключу объекта и по полям network/id (без учёта регистра).
 * @returns {object|null}
 */
export function pickNetwork(networks, chainKey) {
  if (!networks) return null;
  const aliases = resolveNetworkAliases(chainKey);
  for (const [key, n] of Object.entries(networks)) {
    const names = [key, n && n.network, n && n.id].map((x) => String(x || '').toUpperCase());
    if (names.some((name) => aliases.includes(name))) return n;
  }
  return null;
}

// ── Мультичейн для фьючерс-стратегии (DEX-цена через 1inch) ─────────────────
// Ключ сети Gate (currency.networks) -> chainId сети, поддерживаемой 1inch.
// Сети не из этой карты пропускаются (1inch их не обслуживает).
export const GATE_NETWORK_TO_CHAINID = {
  ERC20: 1,
  BEP20: 56,
  BASE: 8453,
  ARBONE: 42161,
  ARBEVM: 42161,
  OP: 10,
  OPETH: 10,
  MATIC: 137,
  POLYGON: 137,
  AVAXC: 43114,
  LINEA: 59144,
  ZKSERA: 324,
};

// Приоритет/белый список сетей для futures-стратегии. Работаем только с
// Ethereum, BSC, Base (бережём лимит 1inch); токены вне этих сетей не берём.
export const CHAIN_PRIORITY = [1, 56, 8453];

// Канонический стейблкоин (USDC) по chainId — dst для size-aware quote 1inch.
export const CHAIN_STABLE = {
  1:     { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  56:    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  8453:  { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  42161: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  10:    { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 },
  137:   { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  43114: { address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6 },
  59144: { address: '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', decimals: 6 },
  324:   { address: '0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4', decimals: 6 },
};

/** Человеко-читаемое имя сети по chainId (для логов/UI). */
export const CHAIN_NAME = {
  1: 'Ethereum', 56: 'BSC', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism',
  137: 'Polygon', 43114: 'Avalanche', 59144: 'Linea', 324: 'zkSync',
};

/**
 * Перебрать сети валюты ccxt и вернуть EVM-адреса на поддерживаемых 1inch сетях.
 * @returns {Array<{chainId:number, address:string}>}
 */
export function evmAddressesFromNetworks(networks) {
  const out = [];
  if (!networks) return out;
  for (const [key, n] of Object.entries(networks)) {
    const chainId = GATE_NETWORK_TO_CHAINID[String(key).toUpperCase()];
    if (!chainId) continue;
    const info = (n && n.info) || {};
    const addr = info.addr || info.contract_address || info.contractAddress || '';
    const a = String(addr).toLowerCase();
    if (a.startsWith('0x') && a.length === 42) out.push({ chainId, address: a });
  }
  return out;
}

export default {
  CHAIN_NETWORK_ALIASES, resolveNetworkAliases, pickNetwork,
  GATE_NETWORK_TO_CHAINID, CHAIN_PRIORITY, CHAIN_STABLE, CHAIN_NAME, evmAddressesFromNetworks,
};
