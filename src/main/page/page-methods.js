'use strict';

/**
 * The closed method table for page requests (freedom-core design 0011,
 * "Which methods check the name"; step PRQ-2).
 *
 * Every method a page provider serves, and every event main sends a page,
 * has exactly one row here, with one class:
 *
 *   - NAME_REVALIDATED: it reads or changes something held under the key (a
 *     grant, its account, chain, rules or last-used time, or the site's
 *     feeds, tags, signing identity, subscriptions or seed-status events).
 *     For a name-keyed document the name is resolved again before its first
 *     use, and after every later wait.
 *   - PERMISSION_FREE: it answers from public data; the key picks at most a
 *     rate or a routing hint. It runs on the key as it stands.
 *   - EXEMPT: it only gives up the site's own authority, which narrows it.
 *   - REFUSED: it never runs, for any caller.
 *
 * A method with no row is refused before anything runs, and no dispatcher
 * can serve one: `page-requests.js` reads this table before it looks for a
 * dispatcher.
 *
 * Each method row also carries today's page-world time limit for it
 * (`webview-preload-ethereum-inject.js` and the Swarm and Radicle sources in
 * `webview-preload.js`), which becomes main's deadline for the request until
 * its prompt shows (design 0011, "One deadline, main's").
 */

const CLASS = Object.freeze({
  NAME_REVALIDATED: 'name-revalidated',
  PERMISSION_FREE: 'permission-free',
  EXEMPT: 'exempt',
  REFUSED: 'refused',
});

const PROVIDERS = Object.freeze(['ethereum', 'swarm', 'radicle']);

const LONG_MS = 300_000;
const SHORT_MS = 60_000;

// What each provider's page-world timer rejects with today. The Ethereum
// provider's error carries no code; Swarm's and Radicle's carry -32603.
const TIMEOUT_ERRORS = Object.freeze({
  ethereum: Object.freeze({ message: 'Request timed out' }),
  swarm: Object.freeze({ code: -32603, message: 'Request timed out' }),
  radicle: Object.freeze({ code: -32603, message: 'Request timed out' }),
});

// The Ethereum read-only methods but the two that answer the chain
// (`READ_ONLY_METHODS`, dapp-provider.js): the core's router gets the key as
// a routing hint.
const ETHEREUM_RPC_READS = Object.freeze([
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
  'eth_getLogs',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_newPendingTransactionFilter',
  'eth_uninstallFilter',
  'web3_clientVersion',
  'web3_sha3',
]);

// [provider, class, methods, today's time limit for them]
const GROUPS = [
  ['ethereum', CLASS.PERMISSION_FREE, ['eth_chainId', 'net_version'], SHORT_MS],
  ['ethereum', CLASS.PERMISSION_FREE, ETHEREUM_RPC_READS, SHORT_MS],
  ['ethereum', CLASS.NAME_REVALIDATED, ['eth_accounts', 'eth_requestAccounts'], SHORT_MS],
  ['ethereum', CLASS.NAME_REVALIDATED, ['wallet_switchEthereumChain'], SHORT_MS],
  ['ethereum', CLASS.NAME_REVALIDATED, ['eth_sendTransaction'], LONG_MS],
  ['ethereum', CLASS.NAME_REVALIDATED, ['personal_sign', 'eth_signTypedData_v4'], SHORT_MS],
  ['ethereum', CLASS.REFUSED, ['eth_sign'], SHORT_MS],

  ['swarm', CLASS.PERMISSION_FREE, ['swarm_readChunk', 'swarm_readSingleOwnerChunk'], SHORT_MS],
  ['swarm', CLASS.PERMISSION_FREE, ['swarm_readData'], LONG_MS],
  ['swarm', CLASS.NAME_REVALIDATED, ['swarm_requestAccess', 'swarm_getCapabilities'], SHORT_MS],
  ['swarm', CLASS.NAME_REVALIDATED, ['swarm_publishData', 'swarm_publishFiles', 'swarm_publishChunk'], LONG_MS],
  ['swarm', CLASS.NAME_REVALIDATED, ['swarm_getUploadStatus'], SHORT_MS],
  [
    'swarm',
    CLASS.NAME_REVALIDATED,
    [
      'swarm_createFeed',
      'swarm_updateFeed',
      'swarm_writeFeedEntry',
      'swarm_writeSingleOwnerChunk',
      'swarm_getSigningIdentity',
    ],
    LONG_MS,
  ],
  ['swarm', CLASS.NAME_REVALIDATED, ['swarm_readFeedEntry', 'swarm_listFeeds'], SHORT_MS],
  [
    'swarm',
    CLASS.NAME_REVALIDATED,
    ['swarm_getMessagingIdentity', 'swarm_subscribe', 'swarm_sendPss', 'swarm_sendGsoc'],
    LONG_MS,
  ],
  ['swarm', CLASS.EXEMPT, ['swarm_unsubscribe'], SHORT_MS],

  ['radicle', CLASS.NAME_REVALIDATED, ['radicle_requestAccess'], LONG_MS],
  ['radicle', CLASS.NAME_REVALIDATED, ['radicle_getCapabilities', 'radicle_getNodeStatus', 'radicle_listSeededRepos'], SHORT_MS],
  ['radicle', CLASS.NAME_REVALIDATED, ['radicle_seed'], LONG_MS],
  ['radicle', CLASS.NAME_REVALIDATED, ['radicle_unseed', 'radicle_sync', 'radicle_getSeedStatus'], SHORT_MS],
  [
    'radicle',
    CLASS.NAME_REVALIDATED,
    [
      'radicle_getIdentity',
      'radicle_createIssue',
      'radicle_commentIssue',
      'radicle_editIssueState',
      'radicle_commentPatch',
    ],
    LONG_MS,
  ],
  ['radicle', CLASS.EXEMPT, ['radicle_disconnect'], SHORT_MS],
];

// [provider, class, events]
const EVENT_GROUPS = [
  ['ethereum', CLASS.NAME_REVALIDATED, ['accountsChanged']],
  ['ethereum', CLASS.PERMISSION_FREE, ['chainChanged', 'connect', 'disconnect']],
  ['swarm', CLASS.NAME_REVALIDATED, ['connect', 'disconnect', 'message']],
  ['radicle', CLASS.NAME_REVALIDATED, ['connect', 'disconnect', 'seedStatus']],
];

// The answer of a method that never runs (today's, `dapp-provider.js`).
const REFUSED_ERRORS = Object.freeze({
  'ethereum:eth_sign': Object.freeze({
    code: 4200,
    message: 'eth_sign is deprecated for security reasons',
  }),
});

const rowKey = (provider, name) => `${provider}:${name}`;

function buildMethods() {
  const methods = new Map();
  for (const [provider, cls, names, timeoutMs] of GROUPS) {
    for (const method of names) {
      const key = rowKey(provider, method);
      if (methods.has(key)) throw new Error(`page-methods: ${key} has two rows`);
      methods.set(
        key,
        Object.freeze({
          provider,
          method,
          class: cls,
          timeoutMs,
          error: REFUSED_ERRORS[key] || null,
        })
      );
    }
  }
  return methods;
}

function buildEvents() {
  const events = new Map();
  for (const [provider, cls, names] of EVENT_GROUPS) {
    for (const event of names) {
      const key = rowKey(provider, event);
      if (events.has(key)) throw new Error(`page-methods: event ${key} has two rows`);
      events.set(key, Object.freeze({ provider, event, class: cls }));
    }
  }
  return events;
}

const METHODS = buildMethods();
const EVENTS = buildEvents();

const own = (map, provider, name) =>
  typeof provider === 'string' && typeof name === 'string' ? map.get(rowKey(provider, name)) || null : null;

/** The method's row, or null: a method with no row never runs. */
function methodRow(provider, method) {
  return own(METHODS, provider, method);
}

/** The event's row, or null: main sends no event without one. */
function eventRow(provider, event) {
  return own(EVENTS, provider, event);
}

// The longest method name any provider echoes back in its unknown-method
// error. Longer names (only a page that bypassed the provider sends one) are
// not echoed.
const ECHO_MAX = 128;

/** Each provider's own error for a method it doesn't serve, as today. */
function unknownMethodError(provider, method) {
  if (provider === 'ethereum') return { code: 4200, message: 'Method not supported' };
  const echo = typeof method === 'string' && method.length <= ECHO_MAX;
  return { code: 4200, message: echo ? `Unknown method: ${method}` : 'Unknown method' };
}

function timeoutError(provider) {
  return { ...(TIMEOUT_ERRORS[provider] || TIMEOUT_ERRORS.swarm) };
}

module.exports = {
  CLASS,
  PROVIDERS,
  ETHEREUM_RPC_READS,
  METHODS,
  EVENTS,
  methodRow,
  eventRow,
  unknownMethodError,
  timeoutError,
};
