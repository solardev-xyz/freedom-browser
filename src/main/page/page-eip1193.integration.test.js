/**
 * Main's relay to the real freedom-cored's Ethereum dispatcher (freedom-core
 * design 0012, APB-4a): main's page requests, documents and prompts
 * (page-requests.js) with the reads, the connect and the switch sent to the
 * core's `eip1193.request`, and the core's `approval.request`,
 * `approval.recheck` and `eip1193.select_chain` served by main
 * (page-eip1193.js). The core writes the grants into dapp-permissions.json.
 * A test seam on the core client's handlers crosses main's answers, as
 * 0012's APR-5 row asks: each is refused, with nothing written.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/page/page-eip1193.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEY_C = `bzz://${'c'.repeat(64)}`;
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet' };
const REJECTED = { code: 4001, message: 'User rejected the request' };
const PENDING = { code: -32002, message: 'Another wallet request is already pending' };

let nextGuest = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextGuest++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.events = [];
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: (_channel, message) => this.events.push([message.event, message.data]),
    };
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
    this.mainFrame = this.frame(url);
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

describeIfBinary('page requests through the real freedom-cored\'s eip1193.request (0012 APB-4a)', () => {
  let root;
  let core;
  // Test seams on main's handlers for the core's requests: `before(method,
  // params)` runs first, `cross(method, params, answer)` may change main's
  // answer.
  const seams = { before: null, cross: null };
  const state = { selected: new Map(), selections: [] };
  let env;

  const grants = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eip1193-relay-'));
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    const { createEip1193Relay } = require('./page-eip1193');
    const relay = createEip1193Relay({
      coreClient: () => core,
      identityWalletEnabled: () => true,
      selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
      getDerivedWallets: async () => [
        { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
        { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
      ],
      networks: () => ({
        1: { name: 'Ethereum', nativeSymbol: 'ETH' },
        100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' },
        31337: { name: 'Anvil' },
      }),
      isChainAvailable: (chainId) => [1, 100].includes(Number(chainId)),
      getActiveWalletIndex: () => 0,
      rulePaused: async () => false,
      selectChainForPage: (windowId, chainId) => {
        state.selections.push([windowId, chainId]);
        state.selected.set(windowId, chainId);
      },
    });
    relay.attach({
      handle: (method, handler) =>
        core.handle(method, async (params, options) => {
          await seams.before?.(method, params);
          const answer = await handler(params, options);
          return seams.cross ? seams.cross(method, params, answer) : answer;
        }),
    });
    env = { relay };
    await core.start();
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    seams.before = null;
    seams.cross = null;
    state.selections = [];
    const { createPageDocuments } = require('./page-documents');
    const { createPageRequests } = require('./page-requests');
    const { createEthereumDispatchers } = require('./page-ethereum');
    const guests = new Map();
    const documents = createPageDocuments({
      isPrivateWebContents: () => false,
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: (contents) => contents.window,
      resolveEnsContent: async () => ({ type: 'not_found' }),
    });
    const sent = [];
    const requests = createPageRequests({
      documents,
      webContentsFromId: (id) => guests.get(id),
      dispatchers: createEthereumDispatchers({
        relay: env.relay,
        identityWalletEnabled: () => true,
        permissionsLoaded: async () => {},
      }),
      setTimer: () => ({}),
      clearTimer: () => {},
      chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
      sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
      watchWindow: () => {},
      isAgentGuest: () => false,
    });
    const tab = (url, { window = 1, front = true } = {}) => {
      const guest = new Guest({ window });
      guests.set(guest.id, guest);
      requests.track(guest);
      guest.commit(url);
      const n = nonce();
      expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
      if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
      return {
        guest,
        ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      };
    };
    const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
    const decide = (handle, approve, choices, windowId = 1) =>
      requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
    Object.assign(env, { requests, tab, prompts, decide, sent });
  });

  test('the reads: the window\'s chain, no account before a connect, and a keyless page\'s', async () => {
    const page = env.tab(`${KEY_C}/`);
    state.selected.set(1, 1);
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x1' });
    expect(await page.ask('net_version')).toEqual({ result: '1' });
    expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    // A chain with no source answers the chrome's text.
    state.selected.set(1, 31337);
    expect(await page.ask('eth_blockNumber')).toEqual({
      error: { code: expect.any(Number), message: 'Anvil requires an RPC provider. Please configure one in Settings.' },
    });
    state.selected.delete(1);
    const keyless = env.tab('data:text/html,<h1>keyless</h1>');
    expect(await keyless.ask('eth_chainId')).toEqual({ result: '0x64' });
    expect(await keyless.ask('eth_accounts')).toEqual({ result: [] });
  });

  test('a keyless document gets the core\'s 4100 for a connect and a switch, with no prompt', async () => {
    const keyless = env.tab('data:text/html,<h1>keyless</h1>');
    expect(await keyless.ask('eth_requestAccounts')).toEqual({ error: NO_ADDRESS });
    expect(await keyless.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ error: NO_ADDRESS });
    expect(env.prompts()).toEqual([]);
    expect(state.selections).toEqual([]);
  });

  test('a connect: main\'s prompt from the core\'s view, the core\'s grant from the user\'s pick, its events, and no prompt after', async () => {
    const page = env.tab(`${KEY_A}/app`);
    const asked = page.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 1);
    const [shown] = env.prompts();
    expect(shown).toMatchObject({
      kind: 'eth.connect',
      site: { key: KEY_A, label: KEY_A },
      view: {
        accounts: [
          { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
          { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
        ],
        defaultIndex: 0,
        chain: { id: 100, name: 'Gnosis Chain' },
      },
    });
    expect(await env.decide(shown.handle, true, { walletIndex: 1 })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: [SECOND] });
    expect(grants()[KEY_A]).toMatchObject({ origin: KEY_A, walletIndex: 1, chainId: 100 });
    await until(() => page.guest.events.length === 2);
    expect(page.guest.events).toEqual([
      ['accountsChanged', [SECOND]],
      ['connect', { chainId: '0x64' }],
    ]);
    // Connected: the core answers from its grant, after main's recheck.
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [SECOND] });
    expect(await page.ask('eth_accounts')).toEqual({ result: [SECOND] });
    expect(env.prompts()).toHaveLength(1);
  });

  test('a rejection and a navigation write nothing', async () => {
    const page = env.tab(`${KEY_B}/`);
    const rejected = page.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 1);
    expect(await env.decide(env.prompts()[0].handle, false)).toEqual({ ok: true });
    expect(await rejected).toEqual({ error: REJECTED });
    const closing = page.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 2);
    page.guest.commit(`${KEY_B}/next`);
    expect(await closing).toEqual({ gone: true });
    const closed = env.sent.filter(([, c]) => c === 'page:prompt-closed').map(([, , p]) => p.reason);
    expect(closed).toEqual(['decided', 'navigated']);
    expect(grants()[KEY_B]).toBeUndefined();
    // The core is up, and answers the next.
    const next = env.tab(`${KEY_B}/again`);
    expect(await next.ask('eth_accounts')).toEqual({ result: [] });
  });

  test('two prompts from one document: the core hears busy for the second, which gets -32002, and the first\'s decision answers only the first', async () => {
    const page = env.tab(`${KEY_B}/two`);
    // The first's prompt is held on its way into main until the second has
    // opened its own.
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    seams.before = async (method) => {
      if (method === 'approval.request' && calls++ === 0) await held;
    };
    const first = page.ask('eth_requestAccounts');
    await until(() => calls === 1);
    const second = page.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 1);
    release();
    expect(await first).toEqual({ error: PENDING });
    const [shown] = env.prompts();
    expect(await env.decide(shown.handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    expect(await second).toEqual({ result: [ACCOUNT] });
    expect(grants()[KEY_B]).toMatchObject({ walletIndex: 0 });
  });

  test('a crossed answer is refused, with nothing written: another prompt\'s id, or a handle an earlier answer named', async () => {
    const answers = [];
    seams.cross = (method, params, answer) => {
      if (method !== 'approval.request') return answer;
      answers.push(answer);
      return answers.crossing ? answers.crossing(answer) : answer;
    };
    const first = env.tab('bzz://' + 'e'.repeat(64) + '/');
    answers.crossing = (answer) => ({ ...answer, prompt: 'f'.repeat(32) });
    const crossedId = first.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 1);
    expect(await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    const refused = await crossedId;
    expect(refused.error.code).toBe(-32603);
    expect(grants()['bzz://' + 'e'.repeat(64)]).toBeUndefined();

    // A rejection names its handle; an approve that names it again later,
    // for another site, is refused.
    answers.crossing = null;
    const rejecting = first.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 2);
    const named = env.prompts()[1].handle;
    expect(await env.decide(named, false)).toEqual({ ok: true });
    expect(await rejecting).toEqual({ error: REJECTED });
    const other = env.tab('bzz://' + '9'.repeat(64) + '/');
    answers.crossing = (answer) => (answer.approve ? { ...answer, handle: named } : answer);
    const crossedHandle = other.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 3);
    expect(await env.decide(env.prompts()[2].handle, true, { walletIndex: 1 })).toEqual({ ok: true });
    expect((await crossedHandle).error.code).toBe(-32603);
    expect(grants()['bzz://' + '9'.repeat(64)]).toBeUndefined();
    expect(other.guest.events).toEqual([]);
  });

  test('a switch: the grant\'s chain, the window\'s selection, and chainChanged to that window\'s pages only', async () => {
    const page = env.tab(`${KEY_A}/switch`);
    const sibling = env.tab(`${KEY_C}/sibling`, { front: false });
    const elsewhere = env.tab(`${KEY_C}/w2`, { window: 2, front: false });
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(state.selections).toEqual([[1, 1]]);
    expect(page.guest.events).toEqual([['chainChanged', '0x1']]);
    expect(sibling.guest.events).toEqual([['chainChanged', '0x1']]);
    expect(elsewhere.guest.events).toEqual([]);
    expect(grants()[KEY_A]).toMatchObject({ chainId: 1 });
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x1' });
    // Today's refusals, the core's: a chain the registry doesn't list, and
    // one without a source.
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x5' }])).toEqual({
      error: { code: 4902, message: 'Unrecognized chain ID' },
    });
    expect((await page.ask('wallet_switchEthereumChain', [{ chainId: '0x7a69' }])).error.code).toBe(4902);
    // An answer to the selection other than `{}` fails the request
    // (`not_authorized`, `mismatch`): main has selected the chain by then.
    seams.cross = (method, params, answer) => (method === 'eip1193.select_chain' ? { selected: true } : answer);
    expect((await page.ask('wallet_switchEthereumChain', [{ chainId: '0x64' }])).error.code).toBe(-32603);
    expect(state.selections).toEqual([[1, 1], [1, 100]]);
    state.selected.delete(1);
  });
});
