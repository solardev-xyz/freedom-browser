// Tor windows (#473), the chrome's side: what a Tor window won't open.
//
// A Tor window's session goes through Arti, but some addresses never become
// page requests on it. Swarm, IPFS, Radicle and on-chain apps are served from
// the user's own nodes, and ENS and Tezos names are looked up through
// blockchain RPC providers; neither goes through Tor. So the chrome sends such
// an address to the Tor page's notice instead of resolving or loading it.
// main backs this up (src/main/tor-window.js): those schemes answer a Tor
// window's session with a notice page, and name lookups refuse it.

import { buildInternalPageUrl, parseEnsInput } from './page-urls.js';

const TOR_BLOCKED_SCHEMES = /^(bzz|ipfs|ipns|rad|radapi|web3|ens):/i;

/**
 * True for an address a Tor window doesn't open: a dweb scheme or a name
 * (`.eth`, `.box`, `.tez`, …), typed or behind `view-source:`.
 */
export const isTorBlockedTarget = (value) => {
  if (typeof value !== 'string') return false;
  let target = value.trim();
  if (target.toLowerCase().startsWith('view-source:')) target = target.slice('view-source:'.length);
  if (!target) return false;
  return TOR_BLOCKED_SCHEMES.test(target) || parseEnsInput(target) !== null;
};

/** The Tor page with its "not available here" notice showing. */
export const torBlockedPageUrl = () => `${buildInternalPageUrl('tor.html')}#blocked`;

/**
 * What the Tor badge says for a Tor status (`{ status }` from `window.tor`).
 * It only reports: main starts Tor for a Tor window by itself
 * (tor-manager.js#ensureTorForTorWindow).
 */
export const torBadgeView = ({ status } = {}) => {
  switch (status) {
    case 'running':
      return { label: 'connected', tone: 'on' };
    case 'starting':
      return { label: 'connecting…', tone: 'pending' };
    case 'stopping':
      return { label: 'stopping…', tone: 'pending' };
    case 'error':
      return { label: 'not connected', tone: 'off' };
    default:
      return { label: 'not running', tone: 'off' };
  }
};

/** Keep a Tor window's badge on Tor's status. */
export const initTorWindowBadge = ({ badgeState, tor }) => {
  if (!badgeState || !tor) return;
  const badge = badgeState.closest('[data-test="tor-badge"]');
  tor.onStatusUpdate?.((status) => {
    const view = torBadgeView(status || {});
    badgeState.textContent = view.label;
    if (badge) badge.dataset.tone = view.tone;
  });
};
