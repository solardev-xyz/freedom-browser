// The same answers as the chrome's (freedom-core design 0011, PRQ-3): each
// moved method, for each URL form, answered by the chrome's own handler
// (`dapp-provider.js`, the path pages took until now and which stays for
// rollback) and by main's dispatcher, over the same wallet, grants, chain
// selection and chain data. The page sees an answer's result, or its
// error's code and message.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { ETHEREUM_READ_METHODS, createEthereumDispatchers } = require('./page-ethereum');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { isReadMethod } = require('../networks/chain-data');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
// An IPNS key no name the chrome knows serves.
const PLAIN_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const KEYLESS = 'data:text/html,<p>keyless</p>';

// The URL forms a page commits, as Chromium reports them (the guest's URL).
const FORMS = [
  'https://app.example/swap?ref=1',
  'http://localhost:8080/x',
  `bzz://${'a'.repeat(64)}/index.html`,
  'bzz://name.eth/page#/swap',
  'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/docs',
  'ipfs://name.eth/',
  'ipns://name.eth/guide',
  `ipns://${PLAIN_IPNS_KEY}/plain`,
  'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree',
  `web3://${ONCHAIN}.eip155-1/swap`,
  `web3://${ONCHAIN}.eip155-100/`,
  KEYLESS,
];
// The DNS name over IPNS: its URL carries the key, and both sides key it
// on the name, the chrome from its known names, main from its binding.
const NAMED = `ipns://${IPNS_KEY}/named`;

// [method, params] for each read, with the outcomes the chain data gives.
const CALLS = [
  ['eth_chainId', []],
  ['net_version', []],
  ['eth_accounts', []],
  ['eth_blockNumber', []],
  ['eth_getBalance', [ACCOUNT, 'latest']],
  ['eth_call', ['revert']],
  ['eth_estimateGas', ['empty-message']],
  ['eth_getLogs', ['no-source']],
  ['web3_clientVersion', []],
];

function backends() {
  const state = {
    enabled: true,
    permissions: new Map(),
    selected: 100,
    reads: [],
  };
  const wallets = [
    { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
    { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
  ];
  const registry = { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis Chain' }, 31337: { name: 'Anvil' } };
  const available = new Set([1, 100]);
  const deps = {
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: () => state.selected,
    // dapp-permissions.js normalizes the key it is asked for.
    getPermission: (key) => state.permissions.get(normalizeOrigin(key)) || null,
    getDerivedWallets: async () => wallets,
    chainRequest: async (chainId, method, params, options) => {
      state.reads.push({ chainId, method, origin: options?.routingContext?.origin });
      if (params?.[0] === 'revert') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
      if (params?.[0] === 'empty-message') throw new Error('');
      if (params?.[0] === 'no-source') throw new Error('No chain source answered');
      return { result: `${method}@${chainId}`, source: 'direct' };
    },
    isChainAvailable: (chainId) => available.has(chainId),
    chainName: (chainId) => registry[chainId]?.name,
  };
  // The chrome reaches the same backends over IPC, through main's handlers
  // as they are today (wallet-ipc.js `wallet:chain-request`,
  // identity-manager.js `wallet:get-derived-wallets`, network-ipc.js).
  const chromeApis = {
    dappPermissions: { getPermission: async (key) => deps.getPermission(key) },
    wallet: {
      getDerivedWallets: async () => {
        try {
          return { success: true, wallets: await deps.getDerivedWallets() };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      requestChain: async (chainId, method, params, routingContext) => {
        try {
          if (!isReadMethod(method)) return { success: false, error: { code: 4200, message: 'Method not supported' } };
          const response = await deps.chainRequest(chainId, method, params || [], { routingContext });
          return { success: true, ...response };
        } catch (err) {
          return { success: false, error: { code: err.code || -32603, message: err.message, data: err.data } };
        }
      },
    },
    networks: {
      isChainAvailable: async (chainId) => ({ success: true, available: deps.isChainAvailable(chainId) }),
      getChains: async () => ({ success: true, chains: registry }),
    },
  };
  return { state, deps, chromeApis };
}

/** The chrome's handler, as a page reached it until now. */
async function chromeSide(env) {
  jest.resetModules();
  jest.doMock('../../renderer/lib/wallet/safe-signing.js', () => ({
    openSafeMessageBoard: jest.fn(),
    abandonSafeMessageBoard: jest.fn(),
  }));
  jest.doMock('../../renderer/lib/tabs.js', () => ({
    getDisplayUrlForWebview: (webview) => webview.committedDisplayUrl,
    isTabAgentOwned: () => false,
  }));
  jest.doMock('../../renderer/lib/wallet-ui.js', () => ({
    showDappConnect: jest.fn(),
    getSelectedChainId: () => env.state.selected,
    setSelectedChainId: jest.fn(),
    updateConnectionBanner: jest.fn(),
    showDappTxApproval: jest.fn(),
    showDappSignApproval: jest.fn(),
    showVaultUnlock: jest.fn(),
    updateSwarmConnectionBanner: jest.fn(),
    updateX402ConnectionBanner: jest.fn(),
  }));
  jest.doMock('../../renderer/lib/wallet/dapp-tx.js', () => ({
    buildDappTxContext: jest.fn(),
    extractSelector: jest.fn(),
  }));
  const windowListeners = new Map();
  global.document = { getElementById: jest.fn(() => null) };
  global.window = {
    addEventListener: jest.fn((type, listener) => windowListeners.set(type, listener)),
    electronAPI: {
      getSettings: jest.fn(async () => ({ enableIdentityWallet: env.state.enabled })),
      handleAgentWalletRequest: jest.fn(async () => ({ handled: false })),
    },
    ...env.chromeApis,
  };
  const provider = await import('../../renderer/lib/dapp-provider.js');
  const { state } = await import('../../renderer/lib/state.js');
  const { formatOnchainAppDisplayUrl } = await import('../../renderer/lib/url-utils.js');
  state.knownEnsNames.set(IPNS_KEY, NAME);
  await flush();
  const setEnabled = (enabled) => windowListeners.get('settings:updated')({ detail: { enableIdentityWallet: enabled } });

  /** A tab on `url`: the chrome's own record of its committed page. */
  function tab(url) {
    const listeners = new Map();
    const sent = [];
    const webview = {
      dataset: { tabId: '1' },
      // tabs.js' committed identity: the onchain display form, or the URL.
      committedDisplayUrl: formatOnchainAppDisplayUrl(url) || url,
      getURL: () => url,
      addEventListener: jest.fn((type, listener) => listeners.set(type, listener)),
      send: jest.fn((channel, message) => sent.push({ channel, message })),
    };
    provider.setupWebviewProvider(webview);
    listeners.get('did-frame-navigate')({ isMainFrame: true, frameProcessId: 1, frameRoutingId: 2 });
    let id = 0;
    return {
      ask: async (method, params) => {
        id += 1;
        const mine = id;
        listeners.get('ipc-message')({
          frameId: [1, 2],
          channel: 'dapp:provider-request',
          args: [{ id: mine, method, params }],
        });
        await flush();
        const reply = sent.find((entry) => entry.channel === 'dapp:provider-response' && entry.message.id === mine);
        if (!reply) return { none: true };
        // What the page-world provider makes of it.
        const { result, error } = reply.message;
        return error ? { error: { code: error.code, message: error.message } } : { result };
      },
    };
  }
  return { tab, setEnabled };
}

/** Main's dispatcher, as a page reaches it now. */
function mainSide(env) {
  const guests = new Map();
  let nextNonce = 1;
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: () => 1,
    resolveEnsContent: async (name) => (name === NAME ? { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY } : { type: 'not_found' }),
  });
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(env.deps),
  });

  function tab(url, { bind } = {}) {
    const guest = new EventEmitter();
    Object.assign(guest, {
      id: guests.size + 1,
      hostWebContents: { id: 77, isDestroyed: () => false, mainFrame: { url: CHROME_URL } },
      mainFrame: { url, frameTreeNodeId: 900 + guests.size, detached: false, processId: 1, routingId: 1 },
      isDestroyed: () => false,
      getType: () => 'webview',
      getURL: () => url,
    });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) requests.bindName({ sender: { id: 77 } }, { guest: guest.id, name: bind, key: IPNS_KEY });
    guest.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, 1);
    const nonce = (nextNonce++).toString(16).padStart(32, '0');
    expect(requests.hello({ sender: guest, senderFrame: guest.mainFrame }, { nonce })).toMatchObject({ ok: true });
    return {
      ask: async (method, params) => {
        const answer = await requests.request(
          { sender: guest, senderFrame: guest.mainFrame },
          { nonce, provider: 'ethereum', method, params }
        );
        return answer.error ? { error: { code: answer.error.code, message: answer.error.message } } : { result: answer.result };
      },
    };
  }
  return { tab };
}

describe('Ethereum reads: main answers as the chrome did (freedom-core design 0011, PRQ-3)', () => {
  afterEach(() => {
    delete global.document;
    delete global.window;
  });

  test('every moved method, for every URL form, chain selection and grant', async () => {
    const env = backends();
    const chrome = await chromeSide(env);
    const main = mainSide(env);
    const urls = [...FORMS, NAMED];
    const chromeTabs = urls.map((url) => chrome.tab(url));
    const mainTabs = urls.map((url) => main.tab(url, url === NAMED ? { bind: NAME } : {}));
    await flush();

    const compared = [];
    for (const selected of [100, 1, null, 31337, 999]) {
      env.state.selected = selected;
      for (const granted of [false, true]) {
        env.state.permissions.clear();
        if (granted) {
          // Each key its own account, so a request keyed on another site's
          // grant would show. Not the keyless page: see below.
          urls.forEach((url, i) => {
            if (url === KEYLESS) return;
            const key = url === NAMED ? NAME : normalizeOrigin(url);
            env.state.permissions.set(key, { origin: key, walletIndex: i % 2, chainId: 100 });
          });
        }
        for (let i = 0; i < urls.length; i += 1) {
          for (const [method, params] of CALLS) {
            env.state.reads.length = 0;
            const theirs = await chromeTabs[i].ask(method, params);
            const chromeReads = env.state.reads.splice(0);
            const ours = await mainTabs[i].ask(method, params);
            const mainReads = env.state.reads.splice(0);
            const label = { url: urls[i], selected, granted, method };
            expect({ ...label, answer: ours }).toEqual({ ...label, answer: theirs });
            // The same chain read, and the same routing hint, but for a
            // URL with no key, which main sends none (design 0011, Keys).
            const keyless = urls[i].startsWith('data:');
            expect({ ...label, reads: mainReads.map((r) => ({ ...r, origin: keyless ? undefined : r.origin })) }).toEqual({
              ...label,
              reads: chromeReads.map((r) => ({ ...r, origin: keyless ? undefined : r.origin })),
            });
            if (keyless) for (const read of mainReads) expect(read.origin).toBeNull();
            compared.push(ours);
          }
        }
      }
    }
    // The comparison covered real answers, not only errors.
    expect(compared).toContainEqual({ result: [ACCOUNT] });
    expect(compared).toContainEqual({ result: [SECOND] });
    expect(compared).toContainEqual({ result: '0x1' });
    expect(compared).toContainEqual({ result: 'eth_blockNumber@31337' });
    expect(compared).toContainEqual({
      error: { code: -32603, message: 'Anvil requires an RPC provider. Please configure one in Settings.' },
    });
    expect(compared).toContainEqual({ error: { code: 3, message: 'execution reverted' } });

    // The one difference, by design (0011, Keys: opaque URLs get no key):
    // the chrome keyed a `data:` page on its whole URL, so a grant written
    // under that URL showed; main gives the page no key and reads no grant.
    env.state.selected = 100;
    env.state.permissions.set(normalizeOrigin(KEYLESS), { origin: KEYLESS, walletIndex: 0, chainId: 100 });
    const keyless = urls.indexOf(KEYLESS);
    expect(await chromeTabs[keyless].ask('eth_accounts', [])).toEqual({ result: [ACCOUNT] });
    expect(await mainTabs[keyless].ask('eth_accounts', [])).toEqual({ result: [] });

    // With the Identity & Wallet switch off, both answer 4900.
    env.state.enabled = false;
    chrome.setEnabled(false);
    for (const method of ETHEREUM_READ_METHODS) {
      const theirs = await chromeTabs[0].ask(method, []);
      expect({ method, answer: await mainTabs[0].ask(method, []) }).toEqual({ method, answer: theirs });
      expect(theirs).toEqual({ error: { code: 4900, message: 'Disconnected' } });
    }
  });
});
