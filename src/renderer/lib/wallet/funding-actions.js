/**
 * Shared funding action helpers.
 *
 * Used by both the node card click handlers and the publish setup
 * checklist to handle xDAI, xBZZ, and chequebook funding flows.
 */

import { walletState } from './wallet-state.js';
import { openSend } from './send.js';
import { openReceive } from './receive.js';
import { createTab } from '../tabs.js';
import { GNOSIS_CHAIN_ID } from './wallet-utils.js';

export { GNOSIS_CHAIN_ID };
export const XDAI_TOKEN_KEY = '100:native';
export const XBZZ_TOKEN_KEY = normalizeTokenKey('100:0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da');

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
 * Top up the Bee wallet with xDAI.
 * - Main wallet has xDAI → open send flow pre-filled to Bee wallet
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

/**
 * Top up the Bee wallet with xBZZ.
 * - Main wallet has xBZZ → open send flow pre-filled to Bee wallet
 * - Main wallet has xDAI but no xBZZ → open CowSwap
 * - Main wallet empty → open receive screen
 */
export function topUpXbzz(antWalletAddress) {
  const recipient = antWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    return { error: 'Ant wallet address not available.' };
  }

  const hasMainXbzz = hasPositiveTokenBalance(walletState.currentBalances, XBZZ_TOKEN_KEY);

  if (hasMainXbzz) {
    openSend({
      recipient,
      chainId: GNOSIS_CHAIN_ID,
      tokenKey: XBZZ_TOKEN_KEY,
      tokenSymbol: 'xBZZ',
    });
    return { action: 'send' };
  }

  const hasMainXdai = hasPositiveTokenBalance(walletState.currentBalances, XDAI_TOKEN_KEY);

  if (hasMainXdai) {
    const swapUrl = getTokenMapEntry(walletState.registeredTokens, XBZZ_TOKEN_KEY)?.swapUrl;
    if (swapUrl) {
      createTab(swapUrl);
      return { action: 'swap' };
    }
  }

  openReceive();
  return { action: 'receive' };
}
