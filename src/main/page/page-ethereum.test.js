const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { CLASS, methodRow, ETHEREUM_RPC_READS } = require('./page-methods');
const { ETHEREUM_READ_METHODS, createEthereumDispatchers } = require('./page-ethereum');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const HASH = 'a'.repeat(64);
const DAPP = `bzz://${HASH}/app`;
const DAPP_KEY = `bzz://${HASH}`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A tab guest: a webview webContents hosted by chrome window `window`. */
class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = { url: 'about:blank', frameTreeNodeId: 1000 + this.id, processId: 1, routingId: this.id, detached: false, send: jest.fn() };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getType() {
    return 'webview';
  }

  getURL() {
    return this.mainFrame.url;
  }

  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = { ...this.mainFrame, url, detached: false, send: jest.fn() };
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

/** Main's backends as the dispatcher reads them, all in memory. */
function backends() {
  const state = {
    enabled: true,
    permissions: new Map(),
    wallets: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
    ],
    selected: new Map(),
    available: new Set([1, 100]),
    names: { 1: 'Ethereum', 100: 'Gnosis Chain', 31337: 'Anvil' },
    reads: [],
    answerRead: async (chainId, method) => ({ result: `${method}@${chainId}` }),
    derive: null,
  };
  const deps = {
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getPermission: jest.fn((key) => state.permissions.get(key) || null),
    getDerivedWallets: jest.fn(async () => (state.derive ? state.derive() : state.wallets)),
    chainRequest: jest.fn(async (chainId, method, params, options) => {
      state.reads.push({ chainId, method, params, options });
      return state.answerRead(chainId, method, params);
    }),
    isChainAvailable: (chainId) => state.available.has(chainId),
    chainName: (chainId) => state.names[chainId],
  };
  return { state, deps };
}

/** Timers the test fires by hand. */
function manualTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    fire(ms) {
      for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) {
        timer.cleared = true;
        timer.fn();
      }
    },
  };
}

function setup({ resolveEnsContent } = {}) {
  const guests = new Map();
  const resolutions = [];
  const names = new Map();
  const resolve = resolveEnsContent || (async (name) => {
    resolutions.push(name);
    const key = names.get(name);
    return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
  });
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: resolve,
  });
  const { state, deps } = backends();
  const trace = [];
  const copies = [];
  const timers = manualTimers();
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(deps),
    hooks: {
      onTrace: (entry) => trace.push(entry),
      onCopy: (entry) => copies.push({ ...entry, readsSoFar: state.reads.length }),
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    return {
      guest,
      ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
    };
  }

  /** A tracked guest on `url` whose document has said hello. */
  function tab(url = DAPP, { window = 1, bind = null } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      const host = guest.hostWebContents;
      expect(requests.bindName({ sender: host }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })).toBe(true);
    }
    guest.commit(url);
    return greet(guest);
  }

  return { documents, requests, state, deps, trace, copies, timers, tab, greet, names, resolutions, guests };
}

describe('Ethereum reads through main (freedom-core design 0011, PRQ-3)', () => {
  test('the dispatcher serves exactly the moved reads: the chrome\'s read-only list and eth_accounts', () => {
    // The chrome's own list, read from the code that serves it.
    const source = fs.readFileSync(path.join(__dirname, '../../renderer/lib/dapp-provider.js'), 'utf-8');
    const readOnly = JSON.parse(
      `[${/const READ_ONLY_METHODS = \[([\s\S]*?)\];/.exec(source)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`
    );
    expect(readOnly).toHaveLength(25);
    expect([...ETHEREUM_READ_METHODS].sort()).toEqual([...readOnly, 'eth_accounts'].sort());
    expect(Object.keys(createEthereumDispatchers(backends().deps)).sort()).toEqual(
      ETHEREUM_READ_METHODS.map((method) => `ethereum:${method}`).sort()
    );
    // The preload routes exactly these to main.
    const preload = fs.readFileSync(path.join(__dirname, '../webview-preload.js'), 'utf-8');
    const routes = /const PAGE_ROUTES = new Set\(\[([\s\S]*?)\]\);/.exec(preload)[1].match(/'[^']+'/g).map((r) => r.slice(1, -1));
    expect(routes.sort()).toEqual(ETHEREUM_READ_METHODS.map((method) => `ethereum:${method}`).sort());
    // Each has its row, of the class the design gives it.
    for (const method of ETHEREUM_READ_METHODS) {
      const expected = method === 'eth_accounts' ? CLASS.NAME_REVALIDATED : CLASS.PERMISSION_FREE;
      expect({ method, class: methodRow('ethereum', method).class }).toEqual({ method, class: expected });
    }
  });

  test('eth_chainId and net_version answer the window\'s selected chain, Gnosis by default and for "All Chains"', async () => {
    const env = setup();
    const one = env.tab(DAPP, { window: 1 });
    const two = env.tab(DAPP, { window: 2 });
    expect(await one.ask('eth_chainId')).toEqual({ result: '0x64' });
    expect(await one.ask('net_version')).toEqual({ result: '100' });

    env.state.selected.set(1, 1);
    expect(await one.ask('eth_chainId')).toEqual({ result: '0x1' });
    expect(await one.ask('net_version')).toEqual({ result: '1' });
    // Each window reads its own switcher, as each chrome read its own.
    expect(await two.ask('eth_chainId')).toEqual({ result: '0x64' });

    env.state.selected.set(1, null);
    expect(await one.ask('eth_chainId')).toEqual({ result: '0x64' });
    expect(await one.ask('net_version')).toEqual({ result: '100' });
    env.state.selected.set(1, 42161);
    expect(await one.ask('eth_chainId')).toEqual({ result: '0xa4b1' });
    // Nothing of the key, and no grant, was read.
    expect(env.deps.getPermission).not.toHaveBeenCalled();
  });

  test('an onchain app\'s chain stays pinned, whatever its window selects', async () => {
    const env = setup();
    env.state.selected.set(1, 100);
    const mainnet = env.tab(`web3://${ONCHAIN}.eip155-1/swap`);
    const anvil = env.tab(`web3://${ONCHAIN}.eip155-31337/`);
    expect(await mainnet.ask('eth_chainId')).toEqual({ result: '0x1' });
    expect(await mainnet.ask('net_version')).toEqual({ result: '1' });
    expect(await anvil.ask('eth_chainId')).toEqual({ result: '0x7a69' });
    env.state.selected.set(1, 10);
    expect(await anvil.ask('net_version')).toEqual({ result: '31337' });
    // Its reads go to its own chain, keyed on its chain-scoped key.
    expect(await anvil.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@31337' });
    expect(env.state.reads.at(-1)).toMatchObject({
      chainId: 31337,
      options: { routingContext: { origin: `web3://${ONCHAIN}:31337` } },
    });
  });

  test('eth_accounts: the grant\'s account under each key form, [] without a grant or its wallet', async () => {
    const env = setup();
    const forms = [
      ['https://app.example/swap?x=1', 'https://app.example'],
      [DAPP, DAPP_KEY],
      ['bzz://name.eth/page', 'name.eth'],
      ['ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/docs', 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
      ['ipns://name.eth/', 'name.eth'],
      [`ipns://${IPNS_KEY}/`, `ipns://${IPNS_KEY}`],
      ['rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5/tree', 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5'],
      [`web3://${ONCHAIN}.eip155-100/`, `web3://${ONCHAIN}:100`],
    ];
    for (const [url, key] of forms) {
      env.state.permissions.clear();
      const page = env.tab(url);
      expect({ url, answer: await page.ask('eth_accounts') }).toEqual({ url, answer: { result: [] } });
      env.state.permissions.set(key, { origin: key, walletIndex: 1, chainId: 100 });
      expect({ url, answer: await page.ask('eth_accounts') }).toEqual({ url, answer: { result: [SECOND] } });
      expect(env.deps.getPermission).toHaveBeenLastCalledWith(key);
    }
    // A grant for a wallet that is gone answers nothing.
    env.state.permissions.set(DAPP_KEY, { origin: DAPP_KEY, walletIndex: 7, chainId: 100 });
    expect(await env.tab(DAPP).ask('eth_accounts')).toEqual({ result: [] });
    // As does a wallet list main can't read.
    env.state.permissions.set(DAPP_KEY, { origin: DAPP_KEY, walletIndex: 0, chainId: 100 });
    env.state.derive = async () => {
      throw new Error('locked');
    };
    expect(await env.tab(DAPP).ask('eth_accounts')).toEqual({ result: [] });
    // No name binding, so nothing was resolved.
    expect(env.resolutions).toEqual([]);
  });

  test('a keyless document gets its reads, and eth_accounts answers [] without reading any grant', async () => {
    const env = setup();
    env.state.permissions.set('data:text/html,<p>hi</p>', { walletIndex: 0 });
    const page = env.tab('data:text/html,<p>hi</p>');
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
    expect(await page.ask('net_version')).toEqual({ result: '100' });
    expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    expect(env.deps.getPermission).not.toHaveBeenCalled();
    expect(await page.ask('eth_getBalance', [ACCOUNT, 'latest'])).toEqual({ result: 'eth_getBalance@100' });
    // No key, so no routing hint.
    expect(env.state.reads.at(-1)).toEqual({
      chainId: 100,
      method: 'eth_getBalance',
      params: [ACCOUNT, 'latest'],
      options: { routingContext: { origin: null } },
    });
  });

  test('every read-only method reads through the core on the page\'s chain, its key the routing hint', async () => {
    const env = setup();
    env.state.selected.set(1, 1);
    const page = env.tab(DAPP);
    for (const method of ETHEREUM_RPC_READS) {
      const params = [{ to: ACCOUNT, data: '0x', value: 3n }, 'latest'];
      expect({ method, answer: await page.ask(method, params) }).toEqual({ method, answer: { result: `${method}@1` } });
      expect(env.state.reads.at(-1)).toEqual({
        chainId: 1,
        method,
        params,
        options: { routingContext: { origin: DAPP_KEY } },
      });
    }
    // The core's answer, whatever it is, as the chrome passed it on.
    env.state.answerRead = async () => ({ result: null, source: 'myotis' });
    expect(await page.ask('eth_getTransactionReceipt', ['0xab'])).toEqual({ result: null });
  });

  test('a failed read gets the chrome\'s error, its text for a chain with no RPC provider', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    env.state.answerRead = async () => {
      throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x08c379a0' });
    };
    expect(await page.ask('eth_call', [{ to: ACCOUNT }, 'latest'])).toEqual({
      error: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
    });
    env.state.answerRead = async () => {
      throw new Error('');
    };
    expect(await page.ask('eth_blockNumber')).toEqual({
      error: { code: -32603, message: 'All chain sources failed for chain 100' },
    });
    // A chain with no source names itself, or its id when the registry
    // doesn't know it.
    env.state.answerRead = async () => {
      throw new Error('No source for chain');
    };
    env.state.selected.set(1, 31337);
    expect(await page.ask('eth_blockNumber')).toEqual({
      error: { code: -32603, message: 'Anvil requires an RPC provider. Please configure one in Settings.' },
    });
    env.state.selected.set(1, 999);
    expect(await page.ask('eth_blockNumber')).toEqual({
      error: { code: -32603, message: 'Chain 999 requires an RPC provider. Please configure one in Settings.' },
    });
  });

  test('params holding binary data are refused before any JSON, and the read\'s copy is charged first', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    for (const params of [[new Uint8Array(32)], [{ data: new ArrayBuffer(8) }], { to: [new Uint8Array(1)] }]) {
      expect(await page.ask('eth_call', params)).toEqual({ error: { code: -32602, message: 'Invalid parameters' } });
    }
    expect(env.state.reads).toEqual([]);
    expect(env.copies).toEqual([]);

    expect(await page.ask('eth_call', [{ to: ACCOUNT, data: '0x1234' }, 'latest'])).toEqual({ result: 'eth_call@100' });
    // Reported before the core's request was made, with the charge in place.
    expect(env.copies).toEqual([
      expect.objectContaining({ label: 'ethereum:chain-request', inPlace: true, readsSoFar: 0 }),
    ]);
    // The chain and account reads make no copy of the request.
    await page.ask('eth_chainId');
    await page.ask('eth_accounts');
    expect(env.copies).toHaveLength(1);
  });

  test('with the Identity & Wallet switch off, every read answers 4900 and reads nothing', async () => {
    const env = setup();
    env.state.enabled = false;
    env.state.permissions.set(DAPP_KEY, { walletIndex: 0 });
    const page = env.tab(DAPP);
    for (const method of ETHEREUM_READ_METHODS) {
      expect({ method, answer: await page.ask(method) }).toEqual({
        method,
        answer: { error: { code: 4900, message: 'Disconnected' } },
      });
    }
    expect(env.deps.getPermission).not.toHaveBeenCalled();
    expect(env.state.reads).toEqual([]);
  });

  test('main\'s deadline answers a read that runs too long: "Request timed out" at 60 s', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    env.state.answerRead = () => new Promise(() => {});
    const answer = page.ask('eth_getLogs', [{ fromBlock: '0x0' }]);
    await flush();
    env.timers.fire(59_999);
    env.timers.fire(60_000);
    // The Ethereum provider's own timeout error, which carries no code.
    expect(await answer).toEqual({ error: { message: 'Request timed out' } });
  });

  describe('a DNS name over IPNS', () => {
    function named() {
      const env = setup();
      env.names.set(NAME, IPNS_KEY);
      env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
      env.state.permissions.set(`ipns://${IPNS_KEY}`, { origin: `ipns://${IPNS_KEY}`, walletIndex: 1, chainId: 100 });
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      return { env, page };
    }

    test('eth_accounts answers the name\'s account, checking the name before the grant and after the wait', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      // The commit's check, then one before the grant and one after the
      // wallet read.
      expect(env.resolutions).toEqual([NAME, NAME, NAME]);
      expect(env.deps.getPermission).toHaveBeenCalledWith(NAME);
    });

    test('once the name moves off the IPNS key, eth_accounts answers [] and the binding ends; reads still answer, with no resolution', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      env.names.set(NAME, OTHER_IPNS_KEY);
      env.resolutions.length = 0;

      // The permission-free reads run on the key as it stands, resolving nothing.
      expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
      expect(await page.ask('net_version')).toEqual({ result: '100' });
      expect(await page.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@100' });
      expect(env.state.reads.at(-1).options).toEqual({ routingContext: { origin: NAME } });
      expect(env.resolutions).toEqual([]);

      env.deps.getPermission.mockClear();
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.resolutions).toEqual([NAME]);
      expect(env.deps.getPermission).not.toHaveBeenCalled();
      expect(env.trace.filter((e) => e.kind === 'name-checked').at(-1)).toMatchObject({ holds: false });

      // The binding has ended: the document is keyless now, so its next
      // eth_accounts reads no grant and resolves nothing, not even the
      // IPNS key's own, and its reads go with no routing hint.
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.resolutions).toEqual([NAME]);
      expect(env.deps.getPermission).not.toHaveBeenCalled();
      expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
      expect(await page.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@100' });
      expect(env.state.reads.at(-1).options).toEqual({ routingContext: { origin: null } });

      // Even with the name answering again, a reload on the same key is
      // bound only by a fresh page:bind-name.
      env.names.set(NAME, IPNS_KEY);
      page.guest.commit(`ipns://${IPNS_KEY}/docs`);
      const reloaded = env.greet(page.guest);
      expect(await reloaded.ask('eth_accounts')).toEqual({ result: [SECOND] });
      expect(env.deps.getPermission).toHaveBeenLastCalledWith(`ipns://${IPNS_KEY}`);
    });

    test('a name that moves while the wallets are read answers []', async () => {
      const { env, page } = named();
      env.state.derive = async () => {
        env.names.set(NAME, OTHER_IPNS_KEY);
        return env.state.wallets;
      };
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    });

    test('a frame that moved off its IPNS key during the resolution answers []', async () => {
      let release;
      const env = setup({
        resolveEnsContent: async () => {
          if (release === undefined) return { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY };
          await new Promise((resolve) => {
            release = resolve;
          });
          return { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY };
        },
      });
      env.state.permissions.set(NAME, { walletIndex: 0 });
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      await flush();
      release = null;
      const answer = page.ask('eth_accounts');
      await flush();
      // The frame now shows another site, whose commit main hasn't seen yet.
      page.guest.mainFrame.url = `ipns://${OTHER_IPNS_KEY}/`;
      release();
      expect(await answer).toEqual({ result: [] });
    });

    describe('concurrent checks of one name', () => {
      // Every resolution waits until the test answers it, in order.
      function held() {
        const pending = [];
        const env = setup({
          resolveEnsContent: (name) =>
            new Promise((resolve) => {
              pending.push({ name, answer: (decoded) => resolve({ type: 'ok', protocol: 'ipns', decoded }) });
            }),
        });
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
        const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
        return { env, page, pending };
      }

      // Two eth_accounts, each at its last check, after the commit's and
      // each one's first have answered the bound key.
      async function atFinalChecks() {
        const { env, page, pending } = held();
        pending.shift().answer(IPNS_KEY);
        await flush();
        const a = page.ask('eth_accounts');
        const b = page.ask('eth_accounts');
        await flush();
        expect(pending).toHaveLength(2);
        for (const first of pending.splice(0)) first.answer(IPNS_KEY);
        await flush();
        expect(pending).toHaveLength(2);
        return { env, page, pending, a, b };
      }

      test('the first answering the bound key and the second elsewhere, in the same turn: both answer []', async () => {
        const { pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        first.answer(IPNS_KEY);
        second.answer(OTHER_IPNS_KEY);
        expect({ a: await a, b: await b }).toEqual({ a: { result: [] }, b: { result: [] } });
      });

      test('the other order, in the same turn: both answer []', async () => {
        const { pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        second.answer(OTHER_IPNS_KEY);
        first.answer(IPNS_KEY);
        expect({ a: await a, b: await b }).toEqual({ a: { result: [] }, b: { result: [] } });
      });

      test('a request answered before the name is found moved keeps its answer; the later one gets []', async () => {
        const { page, pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        first.answer(IPNS_KEY);
        expect(await a).toEqual({ result: [ACCOUNT] });
        second.answer(OTHER_IPNS_KEY);
        expect(await b).toEqual({ result: [] });
        // The binding has ended: the next request resolves nothing.
        expect(await page.ask('eth_accounts')).toEqual({ result: [] });
        expect(pending).toEqual([]);
      });
    });

    test('the chrome may bind a name only for a guest it hosts', () => {
      const env = setup();
      const guest = new Guest({ window: 1 });
      env.guests.set(guest.id, guest);
      env.requests.track(guest);
      const own = { sender: guest.hostWebContents };
      const other = { sender: { id: 999 } };
      expect(env.requests.bindName(other, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: 12345, name: NAME, key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: guest.id, name: 'name.eth', key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: 'not/a/key' })).toBe(false);
      expect(env.requests.bindName(own, null)).toBe(false);
      guest.destroyed = true;
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(false);
      guest.destroyed = false;
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(true);
    });
  });
});
