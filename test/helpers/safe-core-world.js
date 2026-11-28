/**
 * A world for SAFE-3's gates against the real freedom-cored (freedom-core
 * design 0016; the SAFE-3 plan's PR 10): main's own Safe modules on the
 * core's Safe and Ledger backends (FREEDOM_SAFE_BACKEND=core,
 * FREEDOM_LEDGER_BACKEND=core), a real CoreClient serving the pinned
 * binary, main's chain data over two endpoints (the core's chain config,
 * shell, verified reads and drivers, as core/chain.js attaches them), main's
 * Ledger relay with main's HID layer over a fake node-hid, and the
 * reference's Ledger behind it (ledger-reference-device.js).
 *
 * `mockSafeCoreModules(world)` replaces, before main's modules load, only
 * what isn't main's to run here: Electron, the backend switches (read from
 * `world.safeBackend`, the core's by default), the core process (`world`'s
 * client and relay), identity-manager.js's reads of the wallet list (from
 * the vault-meta.json the core reads and writes, as the app reads it
 * through `accounts.*`), the vault's auto-lock timer, phones, core/chain.js
 * (`world.driver`), and the approvals document's wallet prompts
 * (`world.approvals`, none: the chrome's own screens, a development build's
 * FREEDOM_APPROVALS_DOCUMENT=0). Call it first, then require main's modules.
 *
 * `startSafeCoreWorld(world, options)` starts the core on a fresh identity
 * directory: chain 100 read in the order `quorum`, `direct` from the two
 * `endpoints` (a quorum of k = 2, m = 2: two endpoints that agree, as the
 * core's Safe reads need), its JSON-RPC through `fetch`; the vault imported
 * from `mnemonic` (unlocked), and the core's records naming the vault's
 * first two accounts and, with `ledger`, a Ledger account at its path. The
 * core it starts declared `safe3` exactly when `world.safeBackend` is the
 * core's. `restartCore(world)` stops it and starts another on the same
 * directory (main's copy of the pending store reloads), with the backend
 * `world.safeBackend` names then.
 *
 * `pageHarness(world)` is a page in a tab of window 1 (main's page
 * requests, documents and EIP-1193 dispatchers, the core's relay with its
 * prompts, the core's sends and device steps main's own): `tab(url)`,
 * `connected(url, walletIndex)`, `asking(page, method, params)` and
 * `decide(handle, approve, choices)`, its prompts in `prompts()`.
 */

/* global jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { HDNodeWallet } = require('ethers');

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const main = (relative) => path.join(SRC, relative);

const HARDWARE_INDEX_BASE = 1000000;
const LEDGER_INDEX = HARDWARE_INDEX_BASE;
const WALLET_TYPES = Object.freeze({ MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' });
const CHROME_URL = 'file:///app/src/renderer/index.html';

/** The vault's account `index`: the phrase's key at m/44'/60'/index'/0/0, as the vault derives it. */
function vaultAccount(mnemonic, index) {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/${index}'/0/0`);
}

/** The core's vault-meta.json's wallet list, as stored. */
function storedWallets(world) {
  const meta = JSON.parse(fs.readFileSync(path.join(world.identityDir, 'vault-meta.json'), 'utf8'));
  return meta.derivedWallets || [];
}

/**
 * Main's wallet list: the core's records as identity-manager.js exposes
 * them (`extraRecordFields`): a Safe's deployments only where the mark is
 * verified (deployed-mark.js), a device's address check as stored.
 */
function readWallets(world) {
  const { verifiedDeployments } = jest.requireActual(main('wallet/safe/deployed-mark.js'));
  return storedWallets(world).map((wallet) => {
    const record = { type: WALLET_TYPES.MNEMONIC, ...wallet };
    if (record.type === WALLET_TYPES.SAFE) record.deployed = verifiedDeployments(wallet.deployed);
    if (record.type === WALLET_TYPES.LEDGER) record.addressCheck = wallet.addressCheck ?? 'unchecked';
    return record;
  });
}

function mockSafeCoreModules(world) {
  world.safeBackend ??= 'core';
  world.errors = [];
  jest.doMock(
    'electron',
    () => ({
      app: { isPackaged: false, getPath: () => world.root ?? os.tmpdir(), getVersion: () => '0.0.0-test' },
      ipcMain: { handle() {}, on() {}, removeHandler() {}, removeAllListeners() {} },
      BrowserWindow: { fromId: () => null, getFocusedWindow: () => null, getAllWindows: () => [] },
      // A page's tab, by its id (pageHarness's guests): main watches the
      // requesting page of a Safe message through it.
      webContents: { fromId: (id) => world.guests?.get(id) ?? null, getAllWebContents: () => [] },
    }),
    { virtual: true }
  );
  jest.doMock(main('logger.js'), () => ({
    info() {},
    warn() {},
    debug() {},
    error: (...args) => world.errors.push(args.map(String).join(' ')),
  }));
  jest.doMock(main('ens-prefetch.js'), () => ({ prefetchGatewayUrl() {} }));
  jest.doMock(main('wallet/safe/safe-backend-kind.js'), () => ({
    safeBackendKind: () => world.safeBackend,
    readSafeBackendKind: () => world.safeBackend,
  }));
  jest.doMock(main('wallet/ledger/ledger-backend-kind.js'), () => ({
    ledgerBackendKind: () => 'core',
    readLedgerBackendKind: () => 'core',
  }));
  jest.doMock(main('core/core-process.js'), () => ({
    getCoreClient: () => world.client ?? null,
    getLedgerRelay: () => world.relay ?? null,
  }));
  jest.doMock(main('identity-manager.js'), () => {
    const find = (index) => readWallets(world).find((wallet) => wallet.index === index) ?? null;
    return {
      getWalletRecord: find,
      getDerivedWallets: async () => readWallets(world),
      getActiveWalletIndex: () => 0,
      findWalletRecordByAddress: (address) =>
        readWallets(world).find((wallet) => wallet.address.toLowerCase() === String(address).toLowerCase()) ?? null,
      getLedgerRecordsToCheck: () => readWallets(world).filter((wallet) => wallet.type === WALLET_TYPES.LEDGER),
      isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= HARDWARE_INDEX_BASE,
      isVaultUnlocked: async () => (await require(main('core/vault-backend.js')).vaultBackend.status()).unlocked === true,
      recordLedgerAddressCheck() {},
      recordRemoteAddressCheck() {},
      WALLET_TYPES,
    };
  });
  jest.doMock(main('vault-timer.js'), () => ({ resetVaultAutoLockTimer() {} }));
  jest.doMock(main('wallet/remote/signer.js'), () => ({
    createRemoteBackend: () => {
      throw new Error('No phone here');
    },
  }));
  jest.doMock(main('core/chain.js'), () => ({
    chainDriver: () => world.driver ?? null,
    chainSettingsChanged() {},
  }));
  jest.doMock(main('approvals/wallet-approvals.js'), () => ({
    ...jest.requireActual(main('approvals/wallet-approvals.js')),
    getWalletApprovals: () => world.approvals ?? null,
  }));
}

/**
 * Chain 100 as main's registry gives it (core/chain-config.js reads it):
 * the endpoints in `urls`, read through a quorum of two, then Direct.
 */
function gnosisRegistry(urls) {
  return {
    getAllNetworks: () => ({
      100: {
        name: 'Gnosis Chain',
        nativeSymbol: 'xDAI',
        access: { readOrder: ['quorum', 'direct'], broadcastOrder: ['direct'] },
        quorum: { k: 2, m: 2, timeoutMs: 5000 },
      },
    }),
    getEndpoints: (chainId, role) => (Number(chainId) === 100 && role === 'rpc' ? [...urls] : []),
    getEndpointSources: () => [],
    getEndpointSourceList: () => [],
  };
}

/** A CoreClient for the core at `world.identityDir`, its chain data and relay attached; started. */
async function startCore(world) {
  const { CoreClient, PROTOCOL_VERSION_STREAMS } = require(main('core/core-client.js'));
  const { ChainConfig } = require(main('core/chain-config.js'));
  const { BroadcastRecords } = require(main('core/chain-broadcasts.js'));
  const { registerChainShell } = require(main('core/chain-shell.js'));
  const { registerChainVerified } = require(main('core/chain-verified.js'));
  const { ChainDriver } = require(main('core/chain-driver.js'));
  const { makeHop } = require(main('core/naming-shell.js'));
  const { registerLedgerRelay } = require(main('core/ledger-relay.js'));
  const { HidDevice } = require(main('wallet/ledger/hid-device.js'));
  // FREEDOM_SAFE_CORE_LOG=1 shows the core's log, for a failing run.
  const quiet =
    process.env.FREEDOM_SAFE_CORE_LOG === '1'
      ? { info: console.log, warn: console.warn, error: console.error, debug() {} }
      : { info() {}, warn() {}, error() {}, debug() {} };
  const client = new CoreClient({
    spawn,
    command: world.binary,
    args: [
      'serve',
      '--data-dir',
      world.identityDir,
      '--lock-dir',
      path.join(world.root, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: quiet,
    shellVersion: 'jest',
    grantRoot: world.root,
    protocol: PROTOCOL_VERSION_STREAMS,
  });
  const exits = [];
  client.on('exit', (exit) => exits.push(exit));
  const config = new ChainConfig({
    client,
    sources: { registry: gnosisRegistry(world.urls), myotis: { NETWORKS: new Map() }, logIndexUrls: {} },
    log: quiet,
    checks: null,
  });
  const broadcasts = new BroadcastRecords();
  registerChainShell(client, config, { broadcasts, hop: makeHop({ fetch: world.fetch }) });
  registerChainVerified(client, config, { broadcasts, adapters: {} });
  world.driver = new ChainDriver({ client, config, broadcasts });
  world.relay = registerLedgerRelay(client, {
    log: require(main('logger.js')),
    backendKind: () => 'core',
    openDevice: () => new HidDevice({ host: world.host }),
  });
  world.client = client;
  world.exits = exits;
  // Main's copies the core writes, loaded at each handshake (core-process.js).
  require(main('wallet/safe/pending-store.js')).attachCore(client);
  require(main('wallet/dapp-permissions.js')).attachCore(client);
  world.pageRelay?.attach(client);
  world.hello = await client.start();
  await config.whenServing();
  world.pid = client.current?.child?.pid;
  await require(main('wallet/safe/pending-store.js')).ready;
  return client;
}

/**
 * @param {object} world - the object mockSafeCoreModules was given
 * @param {object} options
 * @param {string} options.binary - freedom-cored
 * @param {string[]} options.urls - chain 100's two endpoints
 * @param {Function} options.fetch - their JSON-RPC (main's hop)
 * @param {string} options.mnemonic - the vault's phrase
 * @param {string} options.password
 * @param {object} [options.ledger] - `{ path, address }`: a Ledger account
 * @param {object} [options.vectors] - ledger.json, for the reference's device
 */
async function startSafeCoreWorld(world, { binary, urls, fetch, mnemonic, password, ledger = null, vectors = null }) {
  const { createFakeNodeHid, inProcessHosts } = require('./fake-node-hid');
  const { referenceLedger } = require('./ledger-reference-device');
  const { HidHost } = require(main('wallet/ledger/hid-device.js'));
  const { seedAccountRecords } = require('./core-account-records');
  world.root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-safe-core-'));
  world.identityDir = path.join(world.root, 'identity');
  fs.mkdirSync(world.identityDir);
  Object.assign(world, { binary, urls, fetch, mnemonic, password });
  world.fake = createFakeNodeHid();
  world.host = new HidHost({ launch: inProcessHosts(world.fake), idleMs: null });
  world.device = vectors ? referenceLedger(world.fake, vectors) : null;
  await startCore(world);
  const { vaultBackend } = require(main('core/vault-backend.js'));
  await vaultBackend.importVault(password, mnemonic);
  world.accounts = [vaultAccount(mnemonic, 0), vaultAccount(mnemonic, 1)];
  const wallets = [
    { index: 0, name: 'Main Wallet', address: world.accounts[0].address },
    { index: 1, name: 'Second Wallet', address: world.accounts[1].address },
  ];
  if (ledger) {
    wallets.push({
      index: LEDGER_INDEX,
      name: 'My Nano',
      address: ledger.address,
      type: 'ledger',
      path: ledger.path,
      addressCheck: 'matched',
    });
  }
  await seedAccountRecords(world.client, world.identityDir, wallets);
  if (!(await vaultBackend.status()).unlocked) await vaultBackend.unlock(password);
  world.wallets = () => readWallets(world);
  world.record = (index) => readWallets(world).find((wallet) => wallet.index === index) ?? null;
  world.stored = (index) => storedWallets(world).find((wallet) => wallet.index === index) ?? null;
  world.stop = async () => {
    await world.client?.stop();
    world.host?.kill();
    fs.rmSync(world.root, { recursive: true, force: true });
  };
  return world;
}

/** The core stopped and started again on its directory, on the backend `world.safeBackend` names now. */
async function restartCore(world) {
  await world.client.stop();
  await startCore(world);
  const { vaultBackend } = require(main('core/vault-backend.js'));
  if (!(await vaultBackend.status()).unlocked) await vaultBackend.unlock(world.password);
  return world.client;
}

const until = async (check, what = 'a condition', ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

let nextGuest = 1;

/** A tab's guest webContents in window 1, as main's page requests track one. */
class Guest extends EventEmitter {
  constructor() {
    super();
    this.id = nextGuest++;
    this.window = 1;
    this.hostWebContents = { id: 501, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
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

/**
 * The core's relay for a page's EIP-1193 requests (page-eip1193.js), on
 * main's own deps but the world's: made before the core starts, so its
 * handlers for the core's prompts are on the client from the handshake.
 */
function createPageRelay(world) {
  const { createEip1193Relay } = require(main('page/page-eip1193.js'));
  const { vaultBackend } = require(main('core/vault-backend.js'));
  const signing = require(main('wallet/signing-confirmation.js'));
  world.pageRelay = createEip1193Relay({
    coreClient: () => world.client,
    identityWalletEnabled: () => true,
    selectedChainOf: () => 100,
    getDerivedWallets: async () => readWallets(world),
    networks: () => ({ 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
    isChainAvailable: (chainId) => Number(chainId) === 100,
    getActiveWalletIndex: () => 0,
    rulePaused: async () => false,
    selectChainForPage: () => {},
    isVaultUnlocked: async () => (await vaultBackend.status()).unlocked === true,
    discardToken: (token) => signing.discardConfirmation(token),
  });
  return world.pageRelay;
}

/** A page in window 1, through main's page requests and the core's relay. */
function pageHarness(world) {
  const { createPageDocuments } = require(main('page/page-documents.js'));
  const { createPageRequests } = require(main('page/page-requests.js'));
  const { createEthereumDispatchers } = require(main('page/page-ethereum.js'));
  const { vaultBackend } = require(main('core/vault-backend.js'));
  const grants = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(world.root, 'dapp-permissions.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const guests = new Map();
  world.guests = guests;
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
      relay: world.pageRelay,
      identityWalletEnabled: () => true,
      permissionsLoaded: async () => {},
      getDerivedWallets: async () => readWallets(world),
      getPermission: (site) => grants()[site] || null,
      updateLastUsed: (_site, chainId, page) =>
        vaultBackend.approval.touch({ store: 'dapp', ...(chainId !== undefined ? { chain_id: chainId } : {}) }, page),
      signing: { inCustody: () => false },
      sends: { inCustody: () => false },
      deviceDeps: { walletList: async () => readWallets(world) },
      coreSendDeps: {
        // The site's turn and pause (D12): nothing waits here.
        takeSiteTurn: async () => () => {},
        sitePaymentWaiting: async () => false,
      },
    }),
    setTimer: () => ({}),
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
    isAgentGuest: () => false,
  });
  let nonce = 0;
  const tab = (url) => {
    const guest = new Guest();
    guests.set(guest.id, guest);
    requests.track(guest);
    guest.commit(url);
    const n = (nonce += 1).toString(16).padStart(32, '0');
    const event = () => ({ sender: guest, senderFrame: guest.mainFrame });
    if (requests.hello(event(), { nonce: n }).ok !== true) throw new Error('the page provider did not say hello');
    requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
    return {
      guest,
      ask: (method, params = []) => requests.request(event(), { nonce: n, provider: 'ethereum', method, params }),
    };
  };
  const prompts = () => sent.filter(([w, c]) => w === 1 && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices) => requests.decide({ sender: { id: 501 } }, { handle, approve, choices });
  const asking = (page, method, params) => {
    const seen = prompts().length;
    const answer = page.ask(method, params);
    return {
      answer,
      prompt: async (n = 1) => {
        await until(() => prompts().length >= seen + n, `prompt ${n} of ${method}`, 30_000);
        return prompts()[seen + n - 1];
      },
    };
  };
  const connected = async (url, walletIndex) => {
    const page = tab(url);
    const asked = asking(page, 'eth_requestAccounts');
    const shown = await asked.prompt();
    const decided = await decide(shown.handle, true, { walletIndex });
    if (decided?.ok !== true) throw new Error(`the connect was refused: ${JSON.stringify(decided)}`);
    const answer = await asked.answer;
    if (!Array.isArray(answer?.result)) throw new Error(`no account: ${JSON.stringify(answer)}`);
    return page;
  };
  return { requests, tab, prompts, decide, asking, connected, sent };
}

module.exports = {
  LEDGER_INDEX,
  createPageRelay,
  mockSafeCoreModules,
  pageHarness,
  readWallets,
  restartCore,
  storedWallets,
  startSafeCoreWorld,
  until,
  vaultAccount,
};
