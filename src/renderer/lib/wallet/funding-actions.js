/**
 * Shared funding helpers for the Swarm node wallet.
 *
 * The node wallet only ever needs xDAI: the node swaps what it needs into
 * xBZZ itself when it buys storage (publish-setup-service.js).
 */

import { walletState } from './wallet-state.js';
import { openSend } from './send.js';
import { openReceive } from './receive.js';
import { GNOSIS_CHAIN_ID } from './wallet-utils.js';

export { GNOSIS_CHAIN_ID };
export const XDAI_TOKEN_KEY = '100:native';

// Keep in sync with normalizeTokenKey in src/main/token-registry.js.
export function normalizeTokenKey(rawKey) {
  if (typeof rawKey !== 'string') return rawKey;
  const colon = rawKey.indexOf(':');
  if (colon < 0) return rawKey;

  const chain = rawKey.slice(0, colon);
  const asset = rawKey.slice(colon + 1);
  return asset === 'native' ? rawKey : `${chain}:${asset.toLowerCase()}`;
}

export function getTokenMapEntry(map, tokenKey) {
  if (!map || !tokenKey) return null;

  const normalizedKey = normalizeTokenKey(tokenKey);
  if (Object.prototype.hasOwnProperty.call(map, normalizedKey)) return map[normalizedKey];
  if (Object.prototype.hasOwnProperty.call(map, tokenKey)) return map[tokenKey];

  const match = Object.entries(map).find(([key]) => normalizeTokenKey(key) === normalizedKey);
  return match ? match[1] : null;
}

export function hasPositiveTokenBalance(balances, tokenKey) {
  const balance = getTokenMapEntry(balances, tokenKey);
  return parseFloat(balance?.formatted || '0') > 0;
}

/**
 * Top up the Swarm node wallet with xDAI.
 * - Main wallet has xDAI → open send flow pre-filled to the node wallet
 * - Main wallet empty → open receive screen (QR + address)
 */
export function topUpXdai(antWalletAddress) {
  const recipient = antWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    return { error: 'Ant wallet address not available.' };
  }

  const hasMainXdai = hasPositiveTokenBalance(walletState.currentBalances, XDAI_TOKEN_KEY);

  if (!hasMainXdai) {
    openReceive();
    return { action: 'receive' };
  }

  openSend({
    recipient,
    chainId: GNOSIS_CHAIN_ID,
    tokenKey: XDAI_TOKEN_KEY,
    tokenSymbol: 'xDAI',
  });
  return { action: 'send' };
}
