/**
 * x402 through the real freedom-cored (freedom-core design 0012, X402-2):
 * every payment is the core's `x402.authorize`, and every charge's end its
 * `x402.settle`; `x402-permissions.json` is the core's file (`x402` in the
 * hello's `grant_moved`), which main writes nowhere. Main's own detector,
 * sign flow, injector, IPC and confirmations run here, over the core; only
 * Electron, the tabs and the stores around them are faked.
 *
 * #1016's cases against the core: an `x402-payment` token pays exactly the
 * tab, detection, URL, entry, account and grant it binds. #1024's against
 * it: a cap is charged as the core signs, so two auto-pays never both sign
 * against headroom for one, and a payment withheld gets its charge back.
 *
 * X402-2b (cored 0.19.0, freedom-core #393): a Ledger's and a phone's
 * payments take the core's device path (`x402.authorize { device }`, the
 * device's signature over the core's typed data, `x402.settle { reservation,
 * signature }`), the Ledger through its signer backend (its device faked by
 * a key) and the phone through main's real bridge and the core's phone job;
 * the activity pane lowers a cap through `x402.update` and can't raise one;
 * and a cap's payment whose cap was revoked and granted again since its
 * charge is withheld at its retry (`cap_changed`).
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, e.g.
 *   FREEDOM_CORED_PATH=…/freedom-cored-bin/linux-x64/freedom-cored npx jest src/main/x402/x402.integration
 * or FREEDOM_CORED_APPROVALS_TEST=1 asks for the binary `npm run core:download`
 * fetched, which must then be there (CI's e2e-desktop job, on each OS).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Wallet, TypedDataEncoder, recoverAddress } = require('ethers');

const required = process.env.FREEDOM_CORED_APPROVALS_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_APPROVALS_TEST=1 needs freedom-cored: run npm run core:download');
}
const describeIfBinary = binary ? describe : describe.skip;
const quietLog = { info() {}, warn() {}, error() {} };
const ABANDON =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// The abandon mnemonic's accounts 0 and 1.
const ACCOUNTS = ['0x9858EfFD232B4033E47d90003D41EC34EcaEda94', '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0'];

const ORIGIN = 'https://api.example';
// Base USDC as sellers write it, checksummed: the core keys it in lowercase.
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN = 8453;
const PRICE = '10000';
const ENTRY = Object.freeze({
  scheme: 'exact',
  network: `eip155:${CHAIN}`,
  amount: PRICE,
  asset: USDC,
  payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
});
const requirementsFor = (url, accepts = [ENTRY]) => ({ x402Version: 2, resource: { url }, accepts });
const GRANT = Object.freeze({ capAmount: '20000', windowSeconds: 3600 });

// A Ledger's and a phone's accounts: each device's key, faked.
const LEDGER_KEY = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PHONE_KEY = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const OTHER_KEY = new Wallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
const LEDGER_INDEX = 1000000;
const PHONE_INDEX = 1000001;
const DEVICE_RECORDS = {
  [LEDGER_INDEX]: { index: LEDGER_INDEX, type: 'ledger', address: LEDGER_KEY.address, path: "44'/60'/0'/0/0" },
  [PHONE_INDEX]: { index: PHONE_INDEX, type: 'remote', address: PHONE_KEY.address },
};

describeIfBinary('x402 with the real freedom-cored (X402-2)', () => {
  jest.setTimeout(30000);
  let root;
  let core;
  let calls;
  let fsSpies;
  let intercept;
  let sc;
  let caps;
  let signFlow;
  let vaultBackend;
  const handlers = {};
  const tabs = new Map();
  const hostSend = jest.fn();
  const chrome = { id: 1, send: hostSend, isDestroyed: () => false };
  let activeIndex = 0;
  let seq = 100;
  // The faked Ledger: what it was asked to sign, and the key it signs with.
  const ledger = { asked: [], key: LEDGER_KEY, refuse: null };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-core-'));
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    calls = [];
    const request = core.request.bind(core);
    core.request = (method, params, context, options) => {
      const call = { method, context, params };
      calls.push(call);
      const reply = request(method, params, context, options);
      reply.then(
        (value) => {
          call.reply = value;
        },
        () => {}
      );
      return reply;
    };
    jest.resetModules();
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core }));
    jest.doMock('electron', () => ({
      app: { getPath: () => root },
      ipcMain: {
        handle: (channel, handler) => {
          handlers[channel] = handler;
        },
        on: (channel, handler) => {
          handlers[channel] = handler;
        },
        removeHandler() {},
      },
      webContents: { fromId: (id) => tabs.get(id) ?? null },
      // The phone's job goes to the chrome (main's bridge, no approvals
      // document): this window's.
      BrowserWindow: {
        getFocusedWindow: () => ({ isDestroyed: () => false, webContents: chrome }),
        getAllWindows: () => [],
        fromWebContents: () => null,
      },
    }));
    jest.doMock('../approvals/approvals-document', () => ({ isApprovalsDocumentEnabled: () => false }));
    jest.doMock('../wallet/rpc-manager', () => ({ getKeylessRpcUrls: () => [], cachedApiKeys: () => new Map(), retiredApiKeys: () => [] }));
    jest.doMock('../wallet/chains', () => ({ getChain: () => ({ name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }) }));
    // A Ledger signs the EIP-712 data it is given: faked by a key, which
    // signs the typed data itself (not the digest), as the device does.
    jest.doMock('../wallet/ledger/signer', () => ({
      createLedgerBackend: (record) => ({
        getAddress: async () => record.address,
        signTypedData: async (typedData, options = {}) => {
          ledger.asked.push({ typedData, options });
          if (ledger.refuse) throw ledger.refuse;
          const types = { ...typedData.types };
          delete types.EIP712Domain;
          return ledger.key.signTypedData(typedData.domain, types, typedData.message);
        },
      }),
    }));
    jest.doMock('../logger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('../identity-manager', () => ({
      getActiveWalletIndex: () => activeIndex,
      getActiveWalletAddress: async () => ACCOUNTS[activeIndex],
      getWalletRecord: (index) => DEVICE_RECORDS[index] ?? null,
      isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
      recordLedgerAddressCheck: () => {},
      recordRemoteAddressCheck: () => {},
      WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
    }));
    jest.doMock('../wallet/balance-service', () => ({
      getBalancesWithCache: async () => ({ balances: {}, fromCache: true }),
      getAllBalances: async () => ({}),
      clearBalanceCache: () => {},
    }));
    jest.doMock('../webrequest-dispatcher', () => ({ registerWebRequestHandler() {} }));
    jest.doMock('../token-registry', () => ({ getToken: () => null, getTokenKey: (c, a) => `${c}:${a}` }));
    jest.doMock('../payment-history', () => ({
      getRecent: () => [],
      append: () => {},
      KINDS: { X402: 'x402' },
      STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
    }));
    // The build before X402-2's store, for the rollback: it reads the file
    // where the core writes it (the grant root).
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    require('../core/grants').attachGrants(core);
    intercept = require('./intercept');
    sc = require('../wallet/signing-confirmation');
    caps = require('./caps');
    signFlow = require('./sign-flow');
    ({ vaultBackend } = require('../core/vault-backend'));
    require('./ipc').registerX402Ipc();
    require('../wallet/remote/bridge').registerRemoteSignerIpc();
    await core.start();
    expect(await require('../core/grants').grantStore('x402').whenLoaded()).toBe(true);
    await vaultBackend.importVault('testpass1', ABANDON);
  });

  afterAll(async () => {
    require('../core/grants').detachGrants();
    await core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls.length = 0;
    activeIndex = 0;
    ledger.asked.length = 0;
    ledger.key = LEDGER_KEY;
    ledger.refuse = null;
    hostSend.mockReset();
    tabs.clear();
    for (const id of [41, 42, 43]) {
      tabs.set(id, { id, hostWebContents: chrome, isDestroyed: () => false, loadURL: jest.fn().mockResolvedValue() });
    }
    // Main writes nothing in the grant root: the core's file is the core's.
    fsSpies = ['writeFileSync', 'appendFileSync', 'truncateSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'openSync'].map(
      (method) => jest.spyOn(fs, method)
    );
  });

  afterEach(async () => {
    for (const spy of fsSpies) {
      for (const [file] of spy.mock.calls) {
        expect(path.resolve(String(file)).startsWith(root)).toBe(false);
      }
      spy.mockRestore();
    }
    // Whatever a test left held open ends, its charges settled.
    for (const id of tabs.keys()) intercept.cleanupWebContents(id);
    await waitFor(() => true, 200);
    intercept.clearAllPendingPayments();
    intercept.clearAllDetectedPayments();
    intercept.clearAllPendingApprovals();
    intercept.clearAllApprovalClaims();
    await caps.revokeAllForOrigin(ORIGIN);
  });

  // Polls `done` until it holds (the core answers over a pipe), or `ms` pass.
  async function waitFor(done, ms = 5000) {
    const until = Date.now() + ms;
    while (!done() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const file = () => {
    const text = fs.readFileSync(path.join(root, 'x402-permissions.json'), 'utf8');
    // Today's format, byte for byte: JSON.stringify(…, null, 2).
    expect(JSON.stringify(JSON.parse(text), null, 2)).toBe(text);
    return JSON.parse(text);
  };
  const capInFile = () => file()[ORIGIN]?.[`${CHAIN}:${USDC.toLowerCase()}`] ?? null;
  const methods = () => calls.map(({ method }) => method);

  const detect = (tabId, { resourceType = 'mainFrame', url = `${ORIGIN}/article/${seq}`, accepts } = {}) => {
    seq += 1;
    return intercept.detectPaymentRequiredHandler({
      id: seq,
      webContentsId: tabId,
      url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType,
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirementsFor(url, accepts))).toString('base64')],
      },
    });
  };
  const retry = (tabId, url) =>
    intercept.injectPaymentSignatureHandler({ id: (seq += 1), webContentsId: tabId, url, requestHeaders: {} });
  const headerOf = (injected) =>
    JSON.parse(Buffer.from(injected.requestHeaders['PAYMENT-SIGNATURE'], 'base64').toString('utf8'));

  /** A mainFrame 402 on its card, as main records it: the payment the panel approves. */
  async function card(tabId, accepts) {
    await detect(tabId, { accepts });
    const stored = intercept.getDetectedPayment(tabId);
    expect(stored?.detectionId).toBeTruthy();
    return stored;
  }

  /** The panel's approval: an `x402-payment` token the core mints for exactly this payment. */
  async function approveToken(stored, { tabId, acceptIndex = 0, grant = null, account = activeIndex } = {}) {
    const { token } = await sc.issueConfirmation(sc.KINDS.X402_PAYMENT, account, {
      webContentsId: tabId,
      detectionId: stored.detectionId,
      url: stored.url,
      acceptIndex,
      accept: stored.requirements.accepts[acceptIndex],
      grant,
    });
    return token;
  }

  const approve = (tabId, stored, token, { acceptIndex = 0, grant } = {}) =>
    handlers['x402:approve'](
      { sender: chrome },
      { webContentsId: tabId, detectionId: stored.detectionId, selectedAcceptIndex: acceptIndex, grant, confirmation: token }
    );

  test('the hello moves the x402 file to the core', () => {
    expect([...core.service.helloParams(core).grant_moved].sort()).toEqual(['dapp', 'radicle', 'swarm', 'x402']);
  });

  test("a payment the panel approved is the core's: signed by it, and its cap written by it", async () => {
    const stored = await card(41);
    const token = await approveToken(stored, { tabId: 41, grant: GRANT });
    expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
    const authorize = calls.find(({ method }) => method === 'x402.authorize');
    expect(authorize.context).toEqual({ caller: 'shell' });
    expect(authorize.params).toMatchObject({
      account: 0,
      detection: { tab: 41, id: stored.detectionId, url: stored.url },
      authorization: { token },
      accept_index: 0,
      grant: { cap_amount: '20000', window_seconds: 3600 },
    });
    // The header the injector attaches is the core's payment, from account 0.
    const header = headerOf(retry(41, stored.url));
    expect(header.x402Version).toBe(2);
    expect(header.payload.authorization.from.toLowerCase()).toBe(ACCOUNTS[0].toLowerCase());
    expect(header.payload.authorization.value).toBe(PRICE);
    expect(header.accepted).toEqual(ENTRY);
    await waitFor(() => methods().includes('x402.settle'));
    expect(methods()).toContain('x402.settle');
    // The grant, as bound, then the payment charged to it.
    const cap = capInFile();
    expect(cap).toMatchObject({ capAmount: '20000', spentAmount: PRICE });
    expect(cap.expiresAt - cap.createdAt).toBe(3600);
    await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
    expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: '20000', spentAmount: PRICE });
  });

  describe("#1016: a token pays exactly what it binds, as the core checks it", () => {
    async function refusedAndBurnt(run, token) {
      const err = await run().then(
        () => null,
        (e) => e
      );
      expect(err).not.toBeNull();
      expect(err.code).toBe('SIGNING_NOT_CONFIRMED');
      // Nothing was signed or stashed, and the token is spent.
      expect(retry(41, `${ORIGIN}/none`)).toBeNull();
      const again = await caps
        .authorize({
          account: 0,
          detection: { tab: 41, id: 'req-1', url: `${ORIGIN}/a` },
          requirements: requirementsFor(`${ORIGIN}/a`),
          authorization: { token },
          accept_index: 0,
        })
        .catch((e) => e);
      expect(again.data?.reason).toBe('unknown_token');
      return err;
    }
    const held = (token, payload) => ({ token, kind: 'x402-payment', account: 0, payload });

    test("tab A's token is refused for tab B", async () => {
      const a = await card(41);
      const b = await card(42);
      const token = await approveToken(a, { tabId: 41 });
      const err = await refusedAndBurnt(
        () => signFlow.signAndQueueRetry(42, { walletIndex: 0, confirmation: held(token, { accept_index: 0 }) }),
        token
      );
      expect(err.reason).toBe('mismatch');
      expect(intercept.getDetectedPayment(42)).toEqual(b);
    });

    test("entry 0's token is refused for entry 1", async () => {
      const second = { ...ENTRY, amount: '20000' };
      const stored = await card(41, [ENTRY, second]);
      const token = await approveToken(stored, { tabId: 41, acceptIndex: 0 });
      const err = await refusedAndBurnt(
        () => signFlow.signAndQueueRetry(41, { walletIndex: 0, confirmation: held(token, { accept_index: 1 }) }),
        token
      );
      expect(err.reason).toBe('mismatch');
    });

    test('a token is refused after an account switch', async () => {
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, account: 0 });
      activeIndex = 1;
      const result = await approve(41, stored, token);
      expect(result.success).toBe(false);
      expect(result.code).toBe('SIGNING_NOT_CONFIRMED');
      expect(retry(41, stored.url)).toBeNull();
    });

    test('a token is refused with another grant, and no cap is written', async () => {
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant: GRANT });
      const result = await approve(41, stored, token, { grant: { capAmount: '900000', windowSeconds: 3600 } });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(retry(41, stored.url)).toBeNull();
      expect(file()[ORIGIN]).toBeUndefined();
    });
  });

  describe('#1024: a cap is charged as the core signs', () => {
    // A cap of 20000 with 10000 spent: headroom for one more payment.
    async function capWithHeadroomForOne() {
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant: GRANT });
      expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
      retry(41, stored.url);
      await waitFor(() => methods().includes('x402.settle'));
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ spentAmount: PRICE });
      calls.length = 0;
      hostSend.mockReset();
    }

    test('of two concurrent auto-pays one signs, the other goes to the card; sent keeps the charge', async () => {
      await capWithHeadroomForOne();
      const urls = [`${ORIGIN}/seg/1`, `${ORIGIN}/seg/2`];
      const results = [undefined, undefined];
      detect(41, { resourceType: 'xhr', url: urls[0] }).then((r) => (results[0] = r));
      detect(42, { resourceType: 'xhr', url: urls[1] }).then((r) => (results[1] = r));
      const cardsRaised = () => hostSend.mock.calls.filter(([channel]) => channel === 'x402:approval-needed');
      // One is paid (its 307); the other is held open on its card.
      await waitFor(() => results.some((r) => /307/.test(r?.statusLine)) && cardsRaised().length === 1);
      const paid = results.filter((r) => /307/.test(r?.statusLine));
      expect(paid).toHaveLength(1);
      expect(methods().filter((m) => m === 'x402.authorize')).toHaveLength(2);
      expect(cardsRaised()).toHaveLength(1);
      expect(capInFile()).toMatchObject({ spentAmount: '20000' });
      const which = results.indexOf(paid[0]);
      expect(retry(which === 0 ? 41 : 42, urls[which])).not.toBeNull();
      await waitFor(() => methods().includes('x402.settle'));
      expect(calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params.outcome)).toEqual(['sent']);
      expect(capInFile()).toMatchObject({ spentAmount: '20000' });
    });

    test('a payment withheld gets its charge back', async () => {
      await capWithHeadroomForOne();
      const url = `${ORIGIN}/seg/3`;
      const result = await detect(41, { resourceType: 'xhr', url });
      expect(result.statusLine).toMatch(/307/);
      expect(capInFile()).toMatchObject({ spentAmount: '20000' });
      // The tab goes before the signature is attached: it never went out.
      intercept.cleanupWebContents(41);
      await waitFor(() => methods().includes('x402.settle') && capInFile()?.spentAmount === PRICE);
      expect(calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params.outcome)).toEqual([
        'withheld',
      ]);
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
    });

    test('no cap pays for a tab in Agent custody, and the core refuses one too', async () => {
      await capWithHeadroomForOne();
      require('../wallet/agent-tab-custody').setAgentPageCustody(tabs.get(43), true);
      detect(43, { resourceType: 'xhr', url: `${ORIGIN}/seg/4` });
      await waitFor(() => hostSend.mock.calls.some(([channel]) => channel === 'x402:approval-needed'));
      expect(methods()).not.toContain('x402.authorize');
      const refused = await caps
        .authorize({
          account: 0,
          detection: { tab: 43, id: 'req-2', url: `${ORIGIN}/seg/4` },
          requirements: requirementsFor(`${ORIGIN}/seg/4`),
          authorization: { cap: { agent: true, attributable: true } },
        })
        .catch((e) => e);
      expect(refused.data?.reason).toBe('custody');
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
    });

    test('a locked vault signs nothing and charges nothing', async () => {
      await capWithHeadroomForOne();
      await vaultBackend.lock();
      try {
        const err = await signFlow
          .signAndQueueRetry(41, {
            detection: { url: `${ORIGIN}/seg/5`, requirements: requirementsFor(`${ORIGIN}/seg/5`), resourceType: 'xhr' },
            authorizedBy: 'cap',
          })
          .catch((e) => e);
        expect(require('../wallet/vault-errors').isVaultLockedError(err)).toBe(true);
        expect(capInFile()).toMatchObject({ spentAmount: PRICE });
      } finally {
        await vaultBackend.unlock('testpass1');
      }
    });
  });

  test('the activity pane revokes a cap through the core, and can raise none', async () => {
    const stored = await card(41);
    const token = await approveToken(stored, { tabId: 41, grant: GRANT });
    expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
    await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC) !== null);
    calls.length = 0;
    // No raise: an amount or a window is widened only by a payment's token
    // that binds the new cap. Main refuses it unasked.
    const edit = await handlers['x402:update-permission'](
      { sender: chrome },
      { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '900000' }
    );
    expect(edit).toMatchObject({ success: false, code: 'forbidden' });
    expect(capInFile()).toMatchObject({ capAmount: '20000' });
    expect(methods()).toEqual([]);
    // A revoke is the core's, as the chrome's narrowing.
    expect(await handlers['x402:revoke-permission']({ sender: chrome }, { origin: ORIGIN, chainId: CHAIN, asset: USDC })).toEqual({
      success: true,
    });
    const revoke = calls.find(({ method }) => method === 'approval.revoke');
    expect(revoke.context).toEqual({ caller: 'chrome' });
    expect(revoke.params).toEqual({ store: 'x402', key: ORIGIN, what: { cap: { chain_id: CHAIN, asset: USDC } } });
    expect(file()[ORIGIN]).toBeUndefined();
    expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toBeNull();
  });

  describe('X402-2b: the activity pane lowers a cap through x402.update', () => {
    async function capOf20000() {
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant: GRANT });
      expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      calls.length = 0;
    }
    const update = (change) =>
      handlers['x402:update-permission']({ sender: chrome }, { origin: ORIGIN, chainId: CHAIN, asset: USDC, ...change });

    test('a lower amount and a shorter window: written by the core, as the chrome, and the mirror follows', async () => {
      await capOf20000();
      const before = capInFile();
      expect(await update({ capAmount: '15000' })).toEqual({ success: true });
      const narrowing = calls.find(({ method }) => method === 'x402.update');
      expect(narrowing.context).toEqual({ caller: 'chrome' });
      expect(narrowing.params).toEqual({ key: ORIGIN, cap: { chain_id: CHAIN, asset: USDC }, cap_amount: '15000' });
      expect(capInFile()).toMatchObject({ capAmount: '15000', spentAmount: PRICE, createdAt: before.createdAt, expiresAt: before.expiresAt });
      expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: '15000' });

      expect(await update({ windowSeconds: 1800 })).toEqual({ success: true });
      expect(capInFile()).toMatchObject({ capAmount: '15000', expiresAt: before.createdAt + 1800 });
      expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ expiresAt: before.createdAt + 1800 });
    });

    test('an equal or larger amount or window is refused by main unasked, and by the core', async () => {
      await capOf20000();
      for (const change of [{ capAmount: '20000' }, { capAmount: '20001' }, { windowSeconds: 3600 }, { windowSeconds: 7200 }]) {
        expect(await update(change)).toMatchObject({ success: false, code: 'forbidden' });
      }
      expect(methods()).not.toContain('x402.update');
      // The core refuses each too, writing nothing: it decides, not main.
      for (const change of [{ cap_amount: '20000' }, { cap_amount: '90000' }, { window_seconds: 3600 }, { cap_amount: '10', window_seconds: 7200 }]) {
        const refused = await vaultBackend.x402
          .update({ key: ORIGIN, cap: { chain_id: CHAIN, asset: USDC }, ...change }, 'chrome')
          .catch((e) => e);
        expect(refused.code).toBe('forbidden');
      }
      expect(capInFile()).toMatchObject({ capAmount: '20000' });
      expect(capInFile().expiresAt - capInFile().createdAt).toBe(3600);
    });
  });

  describe('X402-2b: cap_changed', () => {
    test('a cap revoked and granted again between the signature and its retry: the core refuses sent, and the header is withheld', async () => {
      // A cap with headroom, paid once.
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant: GRANT });
      expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      // An auto-pay is charged and signed, its signature waiting.
      const url = `${ORIGIN}/seg/cap-changed`;
      const result = await detect(41, { resourceType: 'xhr', url });
      expect(result.statusLine).toMatch(/307/);
      expect(capInFile()).toMatchObject({ spentAmount: '20000' });
      // The cap goes, and an equal one comes back, before the retry: the
      // mirror shows a cap again, but not the one charged.
      await caps.revoke(ORIGIN, CHAIN, USDC);
      const again = await card(42);
      const regrant = await approveToken(again, { tabId: 42, grant: GRANT });
      expect(await approve(42, again, regrant, { grant: GRANT })).toEqual({ success: true });
      retry(42, again.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      calls.length = 0;
      // The retry: no header goes out.
      expect(await retry(41, url)).toBeNull();
      const settles = calls.filter(({ method }) => method === 'x402.settle');
      expect(settles.map(({ params }) => params.outcome)).toEqual(['sent']);
      // The new cap keeps its own charge only; the old charge isn't moved onto it.
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
    });

    test('a cap that stands: the core accepts sent, and the header goes out', async () => {
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant: GRANT });
      expect(await approve(41, stored, token, { grant: GRANT })).toEqual({ success: true });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      const url = `${ORIGIN}/seg/stands`;
      expect((await detect(41, { resourceType: 'xhr', url })).statusLine).toMatch(/307/);
      calls.length = 0;
      const injected = await retry(41, url);
      expect(headerOf(injected).payload.authorization.value).toBe(PRICE);
      expect(calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params.outcome)).toEqual(['sent']);
      expect(capInFile()).toMatchObject({ spentAmount: '20000' });
    });
  });

  describe('X402-2b: a Ledger or a phone pays through the core\'s device path', () => {
    // A Ledger's payment the panel approved: the core spends the token and
    // gives typed data, the Ledger signs it, and the core checks that.
    async function approvedOnLedger({ grant = null } = {}) {
      activeIndex = LEDGER_INDEX;
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, grant, account: LEDGER_INDEX });
      const result = await approve(41, stored, token, grant ? { grant } : {});
      return { stored, token, result };
    }

    test("a Ledger's payment: x402.authorize { device }, the Ledger signs the core's typed data, x402.settle { signature }, and the header is the core's payload", async () => {
      const { stored, token, result } = await approvedOnLedger({ grant: GRANT });
      expect(result).toEqual({ success: true });
      const authorize = calls.find(({ method }) => method === 'x402.authorize');
      expect(authorize.params).toMatchObject({
        account: LEDGER_INDEX,
        device: { kind: 'ledger', address: LEDGER_KEY.address },
        authorization: { token },
        accept_index: 0,
        grant: { cap_amount: '20000', window_seconds: 3600 },
      });
      // The Ledger was asked once, with typed data that hashes to the
      // core's hash, over the paywall's price to its payee.
      expect(ledger.asked).toHaveLength(1);
      const [{ typedData, options }] = ledger.asked;
      const types = { ...typedData.types };
      delete types.EIP712Domain;
      expect(TypedDataEncoder.hash(typedData.domain, types, typedData.message)).toBe(options.digest);
      expect(typedData.message).toMatchObject({ from: LEDGER_KEY.address, to: ENTRY.payTo, value: PRICE });
      expect(typedData.domain).toMatchObject({ name: 'USD Coin', version: '2', chainId: CHAIN });
      const settle = calls.find(({ method, params }) => method === 'x402.settle' && params.signature);
      expect(settle.params.reservation).toEqual(expect.any(String));
      // The header is the core's payload, the Ledger's signature in it as
      // the Ledger answered.
      const injected = retry(41, stored.url);
      expect(Buffer.from(injected.requestHeaders['PAYMENT-SIGNATURE'], 'base64').toString('utf8')).toBe(
        JSON.stringify(settle.reply.payload)
      );
      // The header carries the Ledger's signature, recovering to it.
      const header = headerOf(injected);
      expect(header.payload.signature).toBe(settle.params.signature);
      expect(recoverAddress(options.digest, header.payload.signature)).toBe(LEDGER_KEY.address);
      expect(header.payload.authorization.from.toLowerCase()).toBe(LEDGER_KEY.address.toLowerCase());
      await waitFor(() => calls.some(({ method, params }) => method === 'x402.settle' && params.outcome === 'sent'));
      // The grant is written after the signature, and the payment charged to
      // it, which the sidebar is told of.
      expect(capInFile()).toMatchObject({ capAmount: '20000', spentAmount: PRICE });
      expect(hostSend).toHaveBeenCalledWith('x402:cap-consumed', { origin: ORIGIN });
    });

    test("a Ledger's auto-pay: the cap is charged first, and needs no unlocked vault", async () => {
      const { stored } = await approvedOnLedger({ grant: GRANT });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      calls.length = 0;
      ledger.asked.length = 0;
      await vaultBackend.lock();
      try {
        const url = `${ORIGIN}/seg/ledger-auto`;
        const result = await detect(41, { resourceType: 'xhr', url });
        expect(result.statusLine).toMatch(/307/);
        expect(calls.find(({ method }) => method === 'x402.authorize').params).toMatchObject({
          account: LEDGER_INDEX,
          device: { kind: 'ledger', address: LEDGER_KEY.address },
          authorization: { cap: { agent: false, attributable: true } },
        });
        expect(ledger.asked).toHaveLength(1);
        expect(capInFile()).toMatchObject({ spentAmount: '20000' });
        const header = headerOf(await retry(41, url));
        expect(header.payload.authorization.from.toLowerCase()).toBe(LEDGER_KEY.address.toLowerCase());
      } finally {
        await vaultBackend.unlock('testpass1');
      }
    });

    test("a signature from another key: the core refuses it, nothing is stashed, and an auto-pay's charge goes back", async () => {
      const { stored } = await approvedOnLedger({ grant: GRANT });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      calls.length = 0;
      hostSend.mockReset();
      ledger.key = OTHER_KEY;
      const url = `${ORIGIN}/seg/wrong-key`;
      const err = await signFlow
        .signAndQueueRetry(41, {
          detection: { url, requirements: requirementsFor(url), resourceType: 'xhr', detectionId: 'req-wrong' },
          authorizedBy: 'cap',
        })
        .catch((e) => e);
      expect(err.message).toMatch(/another account/);
      expect(err.cause?.data).toMatchObject({ reason: 'wrong_account', refunded: true });
      // The core spent the reservation and gave the charge back: main settles nothing.
      expect(calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => Object.keys(params).sort())).toEqual([
        ['reservation', 'signature'],
      ]);
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
      expect(retry(41, url)).toBeNull();
      expect(hostSend.mock.calls.filter(([channel]) => channel === 'x402:cap-consumed').length).toBeGreaterThanOrEqual(2);
    });

    test('a Ledger that refuses: nothing is stashed, the charge is given back (withheld), and the error is the device\'s', async () => {
      const { stored } = await approvedOnLedger({ grant: GRANT });
      retry(41, stored.url);
      await waitFor(() => caps.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount === PRICE);
      calls.length = 0;
      const { mapLedgerError } = jest.requireActual('../wallet/ledger/errors');
      ledger.refuse = mapLedgerError(Object.assign(new Error('status 6a80'), { statusCode: 0x6a80 }));
      const url = `${ORIGIN}/seg/refused`;
      const err = await signFlow
        .signAndQueueRetry(41, {
          detection: { url, requirements: requirementsFor(url), resourceType: 'xhr', detectionId: 'req-refused' },
          authorizedBy: 'cap',
        })
        .catch((e) => e);
      expect(err).toBe(ledger.refuse);
      await waitFor(() => calls.some(({ method }) => method === 'x402.settle'));
      expect(calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params.outcome)).toEqual(['withheld']);
      await waitFor(() => capInFile()?.spentAmount === PRICE);
      expect(capInFile()).toMatchObject({ spentAmount: PRICE });
    });

    test("a phone's payment: the core's phone job relays the core's typed data to the chrome, and the phone's signature pays", async () => {
      activeIndex = PHONE_INDEX;
      const stored = await card(41);
      const token = await approveToken(stored, { tabId: 41, account: PHONE_INDEX });
      const paying = approve(41, stored, token);
      // The bridge relays the core's job to this window's chrome.
      await waitFor(() => hostSend.mock.calls.some(([channel]) => channel === 'remote-signer:request'));
      const [, job] = hostSend.mock.calls.find(([channel]) => channel === 'remote-signer:request');
      expect(job.method).toBe('eth_signTypedData_v4');
      expect(job.params[0]).toBe(PHONE_KEY.address);
      const authorize = calls.find(({ method }) => method === 'x402.authorize');
      expect(authorize.params).toMatchObject({ account: PHONE_INDEX, device: { kind: 'phone', address: PHONE_KEY.address } });
      const phoneJob = calls.find(({ method }) => method === 'phone.job');
      expect(phoneJob.params).toMatchObject({ account: PHONE_INDEX, address: PHONE_KEY.address, method: 'typed_data' });
      // The phone signs what it was shown.
      const view = JSON.parse(job.params[1]);
      const types = { ...view.types };
      delete types.EIP712Domain;
      const signature = await PHONE_KEY.signTypedData(view.domain, types, view.message);
      handlers['remote-signer:response']({ sender: { id: chrome.id } }, { jobId: job.jobId, result: signature });
      expect(await paying).toEqual({ success: true });
      const header = headerOf(retry(41, stored.url));
      expect(header.payload.signature).toBe(signature);
      expect(header.payload.authorization.from.toLowerCase()).toBe(PHONE_KEY.address.toLowerCase());
      expect(header.payload.authorization.value).toBe(PRICE);
    });
  });
});
