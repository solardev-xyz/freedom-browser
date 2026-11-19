/**
 * A DNS name over IPNS through the real freedom-cored's eip1193.request
 * (freedom-core design 0012, APR-5f; browser step APB-4e): main's relay sends
 * the document's `transport_key`, and the core resolves the name itself with
 * its own naming, at each of the reference's checks. Here naming reads
 * Direct from one endpoint, which a scripted hop answers: the anchor from
 * naming's recorded replay, and the name's `resolve` call with the
 * document's IPNS key, another key (the name moved), or a node error. Main
 * serves naming's `shell.*` requests (naming-shell.js), and the core's
 * `approval.request`, `approval.recheck` and `eip1193.select_chain`, whose
 * echoed `page` carries the transport key main sent.
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/page/page-eip1193-names.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { HDNodeWallet, verifyMessage } = require('ethers');

jest.mock('../ens-prefetch', () => ({ prefetchGatewayUrl: jest.fn() }));
jest.mock('../ipfs/gateway-transport', () => ({ netGatewayFetch: jest.fn() }));

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };
// A real core resolves on real timers.
jest.setTimeout(30_000);

const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VAULT_ACCOUNT = HDNodeWallet.fromPhrase(ABANDON, undefined, "m/44'/60'/0'/0/0").address;
const CHROME_URL = 'file:///app/src/renderer/index.html';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
// `IPNS_KEY`'s contenthash (`ipns-ns`, then its CIDv1, an inlined Ed25519
// key), and another key's: the name moved (freedom-core's
// tests/eip1193_names.rs).
const IPNS_CONTENTHASH = 'e5010172002408011220e4680b2f8c8d21090e6aa327f1bb342ab8e7d9238f1e35831a54d6a8f5c91124';
const OTHER_CONTENTHASH = 'e5010172002408011220000000000000000000000000000000000000000000000000000000000000beef';
const NODE = 'https://n1.rpc.example';
const MESSAGE = '0x48656c6c6f2c2046726565646f6d'; // "Hello, Freedom"
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet' };
// Naming's anchor reads, as freedom-core's naming replay recorded them
// (vectors/naming-replay.json, `quorum-agree`).
const RECORDED = {
  eth_blockNumber: '0x1312d00',
  eth_getBlockByNumber: {
    number: '0x1312cf8',
    hash: '0x4be63f085f8ba370ebbda152ea166c706c7456e0a760e43dd99fa20a90bbb878',
    parentHash: '0x8e2113c39b77e776d49c4bec6c88d9e7a7ae874f1ef9ba7126759e97182ad8ed',
    timestamp: '0x1',
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: '0x1',
    gasUsed: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    baseFeePerGas: '0x1',
    transactions: [],
  },
};

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

/** The `resolve` answer, ABI-encoded `(bytes, address)`, for `contenthash`. */
function resolveResult(contenthash) {
  const bytes = contenthash.length / 2;
  const padded = Math.ceil(bytes / 32) * 32;
  const word = (n) => n.toString(16).padStart(64, '0');
  const inner = `${word(32)}${word(bytes)}${contenthash}${'00'.repeat(padded - bytes)}`;
  return `0x${word(0x40)}${'2'.repeat(40).padStart(64, '0')}${word(inner.length / 2)}${inner}`;
}

// A DNS name as the resolve call's calldata carries it.
const labelHex = (label) => Buffer.from(label, 'utf8').toString('hex');

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

describeIfBinary('a DNS name over IPNS through the real freedom-cored (0012 APR-5f, APB-4e)', () => {
  let root;
  let core;
  let vaultBackend;
  let sc;
  let env;
  const state = { selected: new Map(), selections: [], calls: [] };
  // The core's requests main served, with the page each echoed.
  const served = [];
  const grants = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'dapp-permissions.json'), 'utf8'));
    } catch {
      return {};
    }
  };

  // The node naming reads: the anchor as recorded, and each name's
  // `resolve` by its first label: `moved` answers another IPNS key, `down`
  // fails, every other name serves the document's key.
  const hop = jest.fn(async (url, init) => {
    const request = JSON.parse(init.body);
    let reply;
    if (request.method === 'eth_call') {
      const data = String(request.params?.[0]?.data || '');
      state.calls.push(data);
      if (data.includes(labelHex('down'))) {
        reply = { error: { code: -32000, message: 'header not found' } };
      } else {
        reply = { result: resolveResult(data.includes(labelHex('moved')) ? OTHER_CONTENTHASH : IPNS_CONTENTHASH) };
      }
    } else if (RECORDED[request.method] !== undefined) {
      reply = { result: RECORDED[request.method] };
    } else {
      reply = { error: { code: -32601, message: 'the method does not exist' } };
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply });
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(body) };
  });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eip1193-names-'));
    jest.resetModules();
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    sc = require('../wallet/signing-confirmation');
    ({ vaultBackend } = require('../core/vault-backend'));
    // Naming, read Direct from one endpoint the user configured.
    const { NamingConfig } = require('../core/naming-config');
    const { registerNamingShell } = require('../core/naming-shell');
    const config = new NamingConfig({
      client: core,
      log: quietLog,
      sources: {
        ens: {
          getEffectiveRpcEndpoints: () => [NODE],
          getDirectRpcCandidate: () => ({ url: NODE, userConfigured: true }),
          resolutionPolicy: () => ({ order: ['direct'] }),
        },
        tezos: { getRpcEndpoints: () => ['https://t1.tez.example'] },
        registry: { getNetwork: () => ({ quorum: { k: 3, m: 2 } }), getEndpoints: () => [] },
        myotis: { isEnabled: () => false, isReady: () => false },
      },
    });
    registerNamingShell(core, config, { hop });
    const { createEip1193Relay } = require('./page-eip1193');
    const relay = createEip1193Relay({
      coreClient: () => core,
      identityWalletEnabled: () => true,
      selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
      getDerivedWallets: async () => [{ index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' }],
      networks: () => ({ 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
      isChainAvailable: (chainId) => [1, 100].includes(Number(chainId)),
      getActiveWalletIndex: () => 0,
      rulePaused: async () => false,
      isVaultUnlocked: async () => (await vaultBackend.status()).unlocked === true,
      discardToken: (token) => sc.discardConfirmation(token),
      selectChainForPage: (windowId, chainId) => {
        state.selections.push([windowId, chainId]);
        state.selected.set(windowId, chainId);
      },
    });
    relay.attach({
      handle: (method, handler) =>
        core.handle(method, async (params, options) => {
          served.push([method, params?.page]);
          return handler(params, options);
        }),
    });
    env = { relay };
    await core.start();
    expect(await config.whenReady()).toBe(true);
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    served.length = 0;
    state.calls.length = 0;
    state.selections = [];
    if (!(await vaultBackend.status()).unlocked) await vaultBackend.unlock('testpass1');
    const { createPageDocuments } = require('./page-documents');
    const { createPageRequests } = require('./page-requests');
    const { createEthereumDispatchers } = require('./page-ethereum');
    const guests = new Map();
    // Main's own check of the name, at the commit: the name served the
    // document's IPNS key when the page loaded.
    const mainChecks = [];
    const documents = createPageDocuments({
      isPrivateWebContents: () => false,
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: (contents) => contents.window,
      resolveEnsContent: async (name) => {
        mainChecks.push(name);
        return { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY };
      },
    });
    const sent = [];
    const requests = createPageRequests({
      documents,
      webContentsFromId: (id) => guests.get(id),
      dispatchers: createEthereumDispatchers({
        relay: env.relay,
        identityWalletEnabled: () => true,
        permissionsLoaded: async () => {},
        agentWalletRequest: async () => ({ handled: false }),
        signing: { inCustody: () => false },
        sends: { inCustody: () => false },
      }),
      setTimer: () => ({}),
      clearTimer: () => {},
      chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
      sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
      watchWindow: () => {},
      isAgentGuest: () => false,
    });
    // A page on the IPNS key, bound to `name` by the chrome.
    const named = async (name) => {
      const guest = new Guest({ window: 1 });
      guests.set(guest.id, guest);
      requests.track(guest);
      expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name, key: IPNS_KEY })).toBe(true);
      guest.commit(`ipns://${IPNS_KEY}/`);
      await until(() => mainChecks.length > 0);
      const n = nonce();
      expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
      requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
      return {
        guest,
        ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      };
    };
    const prompts = () => sent.filter(([w, c]) => w === 1 && c === 'page:prompt').map(([, , p]) => p);
    const decide = (handle, approve, choices) => requests.decide({ sender: { id: 501 } }, { handle, approve, choices });
    Object.assign(env, { named, prompts, decide, mainChecks });
  });

  test('a name that still serves its IPNS key connects, signs and switches under the name; the core checks it, and main accepts the transport key in every echo', async () => {
    const page = await env.named('docs.example.org');
    expect(env.mainChecks).toEqual(['docs.example.org']);
    // No grant yet, after the core's check.
    expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    expect(state.calls.length).toBeGreaterThan(0);
    const asked = page.ask('eth_requestAccounts');
    await until(() => env.prompts().length === 1);
    expect(env.prompts()[0]).toMatchObject({ kind: 'eth.connect', site: { key: 'docs.example.org' } });
    expect(await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: [VAULT_ACCOUNT] });
    expect(grants()['docs.example.org']).toMatchObject({ origin: 'docs.example.org', walletIndex: 0 });
    // Connected: the core's recheck, the name, and its last recheck.
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [VAULT_ACCOUNT] });
    expect(await page.ask('eth_accounts')).toEqual({ result: [VAULT_ACCOUNT] });

    const signing = page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT]);
    await until(() => env.prompts().length === 2);
    expect(env.prompts()[1]).toMatchObject({ kind: 'eth.sign' });
    expect(await env.decide(env.prompts()[1].handle, true, {})).toEqual({ ok: true });
    const signed = await signing;
    expect(verifyMessage(Buffer.from(MESSAGE.slice(2), 'hex'), signed.result)).toBe(VAULT_ACCOUNT);

    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(state.selections).toEqual([[1, 1]]);
    state.selected.delete(1);

    // Every request of the core's echoed the transport key main sent.
    const methods = new Set(served.map(([method]) => method));
    expect([...methods].sort()).toEqual(['approval.recheck', 'approval.request', 'eip1193.select_chain']);
    for (const [, echoed] of served) {
      expect(echoed).toMatchObject({ origin: 'docs.example.org', transport_key: `ipns://${IPNS_KEY}` });
    }
  });

  test('a name that moved off its IPNS key gets keyless answers from the core: [] for eth_accounts, 4100 for the rest, with no prompt, nothing written or signed', async () => {
    const page = await env.named('moved.example.org');
    expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    expect(state.calls.length).toBeGreaterThan(0);
    expect(await page.ask('eth_requestAccounts')).toEqual({ error: NO_ADDRESS });
    expect(await page.ask('personal_sign', [MESSAGE, VAULT_ACCOUNT])).toEqual({ error: NO_ADDRESS });
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ error: NO_ADDRESS });
    expect(await page.ask('eth_sendTransaction', [{ to: VAULT_ACCOUNT, value: '0x1' }])).toEqual({ error: NO_ADDRESS });
    expect(env.prompts()).toEqual([]);
    expect(served).toEqual([]);
    expect(state.selections).toEqual([]);
    expect(grants()['moved.example.org']).toBeUndefined();
    // The reads still answer: the core checks no name for them.
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
  });

  test('a name the core cannot resolve fails closed', async () => {
    const page = await env.named('down.example.org');
    expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    expect(await page.ask('eth_requestAccounts')).toEqual({ error: NO_ADDRESS });
    expect(env.prompts()).toEqual([]);
    expect(grants()['down.example.org']).toBeUndefined();
  });
});
