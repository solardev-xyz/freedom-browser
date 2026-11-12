const fs = require('fs');
const path = require('path');
const {
  CLASS,
  PROVIDERS,
  METHODS,
  EVENTS,
  methodRow,
  eventRow,
  unknownMethodError,
  timeoutError,
} = require('./page-methods');

const SRC = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');

const literals = (text) => [...text.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

function between(source, start, end) {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from + start.length, to);
}

// The lists the method table was built from. window.ethereum's are the
// chrome's handler's (`READ_ONLY_METHODS` and its dispatcher's own in
// dapp-provider.js), pinned here as they stood when PRQ-9 removed that
// handler: the table is now the only list. Swarm's and Radicle's are read
// from the code that serves them.
const READ_ONLY_METHODS = [
  'eth_chainId',
  'net_version',
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
];
const DISPATCHER_METHODS = [
  'eth_chainId',
  'net_version',
  'eth_accounts',
  'eth_requestAccounts',
  'wallet_switchEthereumChain',
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_sign',
];
const SWARM_KNOWN_METHODS = literals(between(read('main/swarm/swarm-provider-ipc.js'), 'const KNOWN_METHODS = [', '];'));
const RADICLE_METHOD_TIERS = [
  ...between(read('main/radicle/radicle-provider-ipc.js'), 'const METHOD_TIERS = {', '};').matchAll(
    /^\s*(radicle_[A-Za-z]+):/gm
  ),
].map((m) => m[1]);

// The page-facing providers' own sources.
const preload = read('main/webview-preload.js');
const ethereumInject = read('main/webview-preload-ethereum-inject.js');
function injectSource(name) {
  const start = preload.indexOf(`const ${name} = \``);
  expect(start).toBeGreaterThan(0);
  const body = preload.indexOf('`', start) + 1;
  return preload.slice(body, preload.indexOf('\n`;', body));
}
const SWARM_SOURCE = injectSource('SWARM_INJECT_SOURCE');
const RADICLE_SOURCE = injectSource('RADICLE_INJECT_SOURCE');
const pageMethods = (source, prefix) => [
  ...new Set([...source.matchAll(new RegExp(`method: '(${prefix}_[A-Za-z]+)'`, 'g'))].map((m) => m[1])),
];
const listenedEvents = (source) =>
  [...between(source, 'eventListeners = {', '}').matchAll(/([A-Za-z]+): \[\]/g)].map((m) => m[1]);

const rowsOf = (provider) => [...METHODS.values()].filter((row) => row.provider === provider);
const namesOf = (provider, cls) =>
  rowsOf(provider)
    .filter((row) => cls === undefined || row.class === cls)
    .map((row) => row.method)
    .sort();

describe('the method table (freedom-core design 0011, "Which methods check the name")', () => {
  test('today\'s lists are what this test reads', () => {
    expect(READ_ONLY_METHODS).toHaveLength(25);
    expect(DISPATCHER_METHODS.sort()).toEqual(
      [
        'eth_accounts',
        'eth_chainId',
        'eth_requestAccounts',
        'eth_sendTransaction',
        'eth_sign',
        'eth_signTypedData_v4',
        'net_version',
        'personal_sign',
        'wallet_switchEthereumChain',
      ].sort()
    );
    expect(SWARM_KNOWN_METHODS).toHaveLength(21);
    expect(RADICLE_METHOD_TIERS).toHaveLength(14);
  });

  test('every method in today\'s lists has exactly one row, and the table has no other', () => {
    const today = {
      ethereum: [...new Set([...READ_ONLY_METHODS, ...DISPATCHER_METHODS])],
      swarm: SWARM_KNOWN_METHODS,
      radicle: RADICLE_METHOD_TIERS,
    };
    expect(PROVIDERS).toEqual(['ethereum', 'swarm', 'radicle']);
    for (const provider of PROVIDERS) {
      for (const method of today[provider]) {
        const row = methodRow(provider, method);
        expect({ provider, method, row: Boolean(row) }).toEqual({ provider, method, row: true });
        expect(Object.values(CLASS)).toContain(row.class);
      }
      expect(namesOf(provider)).toEqual([...today[provider]].sort());
    }
    expect(METHODS.size).toBe(25 + 7 + 21 + 14);
  });

  test('every method a page-facing provider names has a row', () => {
    for (const method of pageMethods(SWARM_SOURCE, 'swarm')) expect(methodRow('swarm', method)).not.toBeNull();
    for (const method of pageMethods(RADICLE_SOURCE, 'radicle')) expect(methodRow('radicle', method)).not.toBeNull();
    expect(pageMethods(SWARM_SOURCE, 'swarm')).toHaveLength(21);
    expect(pageMethods(RADICLE_SOURCE, 'radicle')).toHaveLength(14);
  });

  test('the classes are the design\'s', () => {
    const RPC_READS = READ_ONLY_METHODS.filter((m) => m !== 'eth_chainId' && m !== 'net_version');
    expect(RPC_READS).toHaveLength(23);
    expect(namesOf('ethereum', CLASS.PERMISSION_FREE)).toEqual([...READ_ONLY_METHODS].sort());
    expect(namesOf('ethereum', CLASS.NAME_REVALIDATED)).toEqual(
      [
        'eth_accounts',
        'eth_requestAccounts',
        'wallet_switchEthereumChain',
        'eth_sendTransaction',
        'personal_sign',
        'eth_signTypedData_v4',
      ].sort()
    );
    expect(namesOf('ethereum', CLASS.REFUSED)).toEqual(['eth_sign']);
    expect(methodRow('ethereum', 'eth_sign').error).toEqual({
      code: 4200,
      message: 'eth_sign is deprecated for security reasons',
    });

    expect(namesOf('swarm', CLASS.PERMISSION_FREE)).toEqual(
      ['swarm_readChunk', 'swarm_readData', 'swarm_readSingleOwnerChunk'].sort()
    );
    expect(namesOf('swarm', CLASS.EXEMPT)).toEqual(['swarm_unsubscribe']);
    expect(namesOf('swarm', CLASS.NAME_REVALIDATED)).toHaveLength(17);
    for (const method of [
      'swarm_requestAccess',
      'swarm_getCapabilities',
      'swarm_publishData',
      'swarm_publishFiles',
      'swarm_publishChunk',
      'swarm_getUploadStatus',
      'swarm_createFeed',
      'swarm_updateFeed',
      'swarm_writeFeedEntry',
      'swarm_writeSingleOwnerChunk',
      'swarm_getSigningIdentity',
      // One class per method, whatever its params: by name or by topic.
      'swarm_readFeedEntry',
      'swarm_listFeeds',
      'swarm_getMessagingIdentity',
      'swarm_subscribe',
      'swarm_sendPss',
      'swarm_sendGsoc',
    ]) {
      expect(methodRow('swarm', method).class).toBe(CLASS.NAME_REVALIDATED);
    }

    expect(namesOf('radicle', CLASS.EXEMPT)).toEqual(['radicle_disconnect']);
    expect(namesOf('radicle', CLASS.NAME_REVALIDATED)).toEqual(
      RADICLE_METHOD_TIERS.filter((m) => m !== 'radicle_disconnect').sort()
    );
    expect(namesOf('radicle', CLASS.PERMISSION_FREE)).toEqual([]);
  });

  test('each row\'s deadline is the page-world timer its method had', () => {
    // The timers the page-world providers armed until main's deadline
    // replaced them ("One deadline, main's"; PRQ-9 removed the last), pinned
    // here: 300 s for a method that can wait on a prompt or a long transfer,
    // 60 s for the rest.
    const SWARM_LONG = new Set([
      'swarm_publishData',
      'swarm_publishFiles',
      'swarm_publishChunk',
      'swarm_sendPss',
      'swarm_sendGsoc',
      'swarm_createFeed',
      'swarm_updateFeed',
      'swarm_writeFeedEntry',
      'swarm_writeSingleOwnerChunk',
      'swarm_getSigningIdentity',
      'swarm_getMessagingIdentity',
      'swarm_subscribe',
      'swarm_readData',
    ]);
    const RADICLE_LONG = new Set([
      'radicle_requestAccess',
      'radicle_seed',
      'radicle_getIdentity',
      'radicle_createIssue',
      'radicle_commentIssue',
      'radicle_editIssueState',
      'radicle_commentPatch',
    ]);
    const formerTimer = (provider, method) => {
      if (provider === 'ethereum') return method === 'eth_sendTransaction' ? 300_000 : 60_000;
      if (provider === 'swarm') return SWARM_LONG.has(method) ? 300_000 : 60_000;
      return RADICLE_LONG.has(method) ? 300_000 : 60_000;
    };
    for (const row of METHODS.values()) {
      expect({ method: row.method, timeoutMs: row.timeoutMs }).toEqual({
        method: row.method,
        timeoutMs: formerTimer(row.provider, row.method),
      });
    }
    // The page-world providers arm none of their own now.
    for (const source of [ethereumInject, SWARM_SOURCE, RADICLE_SOURCE]) expect(source).not.toMatch(/setTimeout/);
    expect(methodRow('ethereum', 'eth_sendTransaction').timeoutMs).toBe(300_000);
    expect(methodRow('ethereum', 'personal_sign').timeoutMs).toBe(60_000);
    expect(methodRow('swarm', 'swarm_readData').timeoutMs).toBe(300_000);
    expect(methodRow('radicle', 'radicle_seed').timeoutMs).toBe(300_000);
  });

  test('every event has exactly one class, and the table has no other', () => {
    const expected = {
      'ethereum:accountsChanged': CLASS.NAME_REVALIDATED,
      'ethereum:chainChanged': CLASS.PERMISSION_FREE,
      'ethereum:connect': CLASS.PERMISSION_FREE,
      'ethereum:disconnect': CLASS.PERMISSION_FREE,
      'swarm:connect': CLASS.NAME_REVALIDATED,
      'swarm:disconnect': CLASS.NAME_REVALIDATED,
      'swarm:message': CLASS.NAME_REVALIDATED,
      'radicle:connect': CLASS.NAME_REVALIDATED,
      'radicle:disconnect': CLASS.NAME_REVALIDATED,
      'radicle:seedStatus': CLASS.NAME_REVALIDATED,
    };
    expect(Object.fromEntries([...EVENTS].map(([key, row]) => [key, row.class]))).toEqual(expected);
  });

  test('every event sent to a page today has a row, and every row is one the page listens for', () => {
    // What main sends today: the chrome sends pages none (PRQ-9).
    const sent = new Set();
    const add = (provider, text, pattern) => {
      for (const match of text.matchAll(pattern)) sent.add(`${provider}:${match[1]}`);
    };
    // Main's own Ethereum events: a moved method's (PRQ-4), and the chain
    // switcher's and a grant's changes (PRQ-6).
    add('ethereum', read('main/page/page-ethereum.js'), /context\.sendEvent\([A-Za-z]+, '([A-Za-z]+)'/g);
    add('ethereum', read('main/page/page-events.js'), /sendAll\(targets, '([A-Za-z]+)'/g);
    add('swarm', read('main/swarm/swarm-provider-ipc.js'), /event: '([A-Za-z]+)'/g);
    // Main's own Swarm events, for a page's requests through main (PRQ-7b).
    add(
      'swarm',
      read('main/page/page-swarm.js'),
      /(?:announce\(context, |sendEvent\((?:requester|doc), (?:'swarm', )?)'([A-Za-z]+)'/g
    );
    // Main's own Radicle events, for a page's requests through main: a
    // connect's new grant and any revocation (PRQ-8a), and each site's seed
    // statuses (PRQ-8b), which no longer go through the chrome.
    add('radicle', read('main/page/page-radicle.js'), /sendEvent\((?:requester|doc), (?:'radicle', )?'([A-Za-z]+)'/g);
    expect(read('main/radicle/radicle-provider-ipc.js')).not.toMatch(/event: 'seedStatus'/);
    expect(sent).toEqual(
      new Set([
        'ethereum:accountsChanged',
        'ethereum:chainChanged',
        'ethereum:connect',
        'swarm:connect',
        'swarm:disconnect',
        'swarm:message',
        'radicle:connect',
        'radicle:disconnect',
        'radicle:seedStatus',
      ])
    );
    for (const key of sent) expect({ key, row: EVENTS.has(key) }).toEqual({ key, row: true });

    const listened = {
      ethereum: listenedEvents(ethereumInject),
      swarm: listenedEvents(SWARM_SOURCE),
      radicle: listenedEvents(RADICLE_SOURCE),
    };
    for (const row of EVENTS.values()) expect(listened[row.provider]).toContain(row.event);
    // The Ethereum provider takes `message` listeners, but nothing sends one
    // today, so it has no row and main sends none.
    expect(listened.ethereum).toContain('message');
    expect(eventRow('ethereum', 'message')).toBeNull();
    // Ethereum's `disconnect` keeps its row ("as today"), though nothing
    // sends it: the chrome's one emitter was never called, and went with
    // the chrome's other Ethereum event emitters in PRQ-6.
    expect(sent.has('ethereum:disconnect')).toBe(false);
    expect(eventRow('ethereum', 'disconnect')).not.toBeNull();
  });

  test('a method or event with no row is null, prototype names included', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'eth_foo', 'swarm_readChunk ']) {
      for (const provider of PROVIDERS) {
        expect(methodRow(provider, name)).toBeNull();
        expect(eventRow(provider, name)).toBeNull();
      }
    }
    // Another provider's method has no row under this one.
    expect(methodRow('ethereum', 'swarm_readChunk')).toBeNull();
    expect(methodRow('swarm', 'eth_chainId')).toBeNull();
    expect(methodRow('__proto__', 'eth_chainId')).toBeNull();
    expect(methodRow(undefined, undefined)).toBeNull();
    expect(methodRow({ toString: () => 'ethereum' }, 'eth_chainId')).toBeNull();
    expect(Object.isFrozen(methodRow('ethereum', 'eth_chainId'))).toBe(true);
  });

  test('each provider\'s own unknown-method error, and today\'s timeout errors', () => {
    expect(unknownMethodError('ethereum', 'eth_foo')).toEqual({ code: 4200, message: 'Method not supported' });
    expect(unknownMethodError('swarm', 'swarm_foo')).toEqual({ code: 4200, message: 'Unknown method: swarm_foo' });
    expect(unknownMethodError('radicle', 'radicle_foo')).toEqual({
      code: 4200,
      message: 'Unknown method: radicle_foo',
    });
    // A name no provider would send isn't echoed back.
    expect(unknownMethodError('swarm', 'x'.repeat(129))).toEqual({ code: 4200, message: 'Unknown method' });
    expect(timeoutError('ethereum')).toEqual({ message: 'Request timed out' });
    expect(timeoutError('swarm')).toEqual({ code: -32603, message: 'Request timed out' });
    expect(timeoutError('radicle')).toEqual({ code: -32603, message: 'Request timed out' });
  });
});
