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

export const GNOSIS_CHAIN_ID = 100;
export const XDAI_TOKEN_KEY = '100:native';
export const XBZZ_TOKEN_KEY = '100:0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';

/**
 * Top up the Bee wallet with xDAI.
 * - Main wallet has xDAI → open send flow pre-filled to Bee wallet
 * - Main wallet empty → open receive screen (QR + address)
 */
export function topUpXdai(beeWalletAddress) {
  const recipient = beeWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    return { error: 'Bee wallet address not available.' };
  }

  const mainBalance = parseFloat(walletState.currentBalances[XDAI_TOKEN_KEY]?.formatted || '0');

  if (mainBalance <= 0) {
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
export function topUpXbzz(beeWalletAddress) {
  const recipient = beeWalletAddress || walletState.fullAddresses.swarm;
  if (!recipient) {
    return { error: 'Bee wallet address not available.' };
  }

  const mainXbzz = parseFloat(walletState.currentBalances[XBZZ_TOKEN_KEY]?.formatted || '0');

  if (mainXbzz > 0) {
    openSend({
      recipient,
      chainId: GNOSIS_CHAIN_ID,
      tokenKey: XBZZ_TOKEN_KEY,
      tokenSymbol: 'xBZZ',
    });
    return { action: 'send' };
  }

  const mainXdai = parseFloat(walletState.currentBalances[XDAI_TOKEN_KEY]?.formatted || '0');

  if (mainXdai > 0) {
    const swapUrl = walletState.registeredTokens[XBZZ_TOKEN_KEY]?.swapUrl;
    if (swapUrl) {
      createTab(swapUrl);
      return { action: 'swap' };
    }
  }

  openReceive();
  return { action: 'receive' };
}
