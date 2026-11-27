/**
 * LDG-3's x402 gate (freedom-core design 0016, "x402 from a Ledger
 * account", D2 option A; the LDG-3 plan's PR 12): a Ledger's x402 payment
 * on the core's backend (FREEDOM_LEDGER_BACKEND=core), end to end through
 * the real freedom-cored the build pins, with a fake HID Ledger answering
 * from freedom-core's `vectors/ledger.json`.
 *
 * Main's own pieces run as in the app: the detector, the approval card's
 * token (`approval.issue`), the sign flow (sign-flow.js `settledByLedger`:
 * `now_s` with the Ledger's `device`, main's rebuild of the core's
 * authorization, #1356, compared before the device), caps.js
 * `settleTypedData` (`x402.settle { reservation, typed_data }` with main's
 * own copy, under the device watchdog), main's relay and main's HID device
 * layer (hid-device.js, its hosts served in this process) over a fake
 * node-hid. Only Electron, the tabs and the stores around them are faked,
 * as in x402.integration.test.js.
 *
 * The device is the reference's (test/helpers/ledger-reference-device.js)
 * playing ledger.json's `x402-eip3009-v2`, the same 402 entry. The core
 * builds the authorization afresh, with its own nonce and main's clock, so
 * those two values and the signature can't be the recording's: every other
 * APDU (the address check, `B0 01`, each definition, the domain's values,
 * `from`, `to`, `value`, `validAfter`) is answered from the recording, and
 * the device answers the two values and signs as ledger.json's device
 * format says the reference's device did (`ruled`), with the test phrase's
 * key over the digest of main's copy.
 *
 * After the payment: the core is the process it started (its strict reader
 * of main's replies ends the connection on any it doesn't take, exit 76),
 * nothing logged at error, the relay holds nothing, and no APDU went
 * unanswered.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, or
 * FREEDOM_CORED_LEDGER_TEST=1 asks for the binary `npm run core:download`
 * fetched, and the vectors are found (test/helpers/ledger-vectors.js), e.g.
 *   FREEDOM_CORED_LEDGER_TEST=1 FREEDOM_CORE_LEDGER_VECTORS=…/freedom-core/vectors \
 *     npx jest src/main/x402/sign-flow-ledger.integration
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { HDNodeWallet, TypedDataEncoder, getAddress, recoverAddress } = require('ethers');
const { seedAccountRecords } = require('../../../test/helpers/core-account-records');
const { until } = require('../../../test/helpers/fake-ledger-core');
const { createFakeNodeHid, inProcessHosts } = require('../../../test/helpers/fake-node-hid');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../test/helpers/ledger-vectors');
const { referenceLedger } = require('../../../test/helpers/ledger-reference-device');

const required = process.env.FREEDOM_CORED_LEDGER_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH || (required ? require('../core/cored-binary').getCoredBinaryPath() : null);
if (required && !fs.existsSync(binary)) {
  throw new Error('FREEDOM_CORED_LEDGER_TEST=1 needs freedom-cored: run npm run core:download');
}
const vectors = ledgerVectors('ledger.json');
const grammar = ledgerVectors('ledger-grammar.json');
if (ledgerVectorsRequired && (!vectors || !grammar)) {
  throw new Error('FREEDOM_CORE_LEDGER_VECTORS names no ledger.json and ledger-grammar.json');
}
const skipped = !binary
  ? 'no freedom-cored: set FREEDOM_CORED_PATH or FREEDOM_CORED_LEDGER_TEST=1'
  : !vectors || !grammar
    ? 'no Ledger vectors: set FREEDOM_CORE_LEDGER_VECTORS'
    : null;
const describeIfReady = skipped
  ? (name, fn) => describe.skip(`${name} (skipped: ${skipped})`, fn)
  : describe;

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const CASE = 'x402-eip3009-v2';
// A vault of its own (another public test phrase, never funded), so the
// Ledger's account is the device's alone.
const VAULT_PHRASE = 'test test test test test test test test test test test junk';
const VAULT_ACCOUNT = HDNodeWallet.fromPhrase(VAULT_PHRASE, undefined, "m/44'/60'/0'/0/0").address;
const LEDGER_INDEX = 1000000;
const ORIGIN = 'https://api.example';

describeIfReady('LDG-3 gates: an x402 payment from a Ledger on the core, against the real freedom-cored', () => {
  jest.setTimeout(60_000);
  const c = vectors?.cases.find((x) => x.id === CASE);
  const honest = grammar?.honest.find((h) => h.case === CASE)?.apdus;
  const LEDGER = c && { index: LEDGER_INDEX, type: 'ledger', address: c.record.address, path: c.record.path };
  const WALLETS = c && [
    { index: 0, name: 'Main Wallet', address: VAULT_ACCOUNT, type: 'mnemonic' },
    { ...LEDGER, name: 'Ledger 1' },
  ];
  let root;
  let core;
  let relay;
  let host;
  let fake;
  let device;
  let calls;
  let exits;
  let pid;
  let sc;
  let intercept;
  let log;
  const handlers = {};
  const tabs = new Map();
  const hostSend = jest.fn();
  const chrome = { id: 1, send: hostSend, isDestroyed: () => false };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-ledger-gates-'));
    const { CoreClient } = require('../core/core-client');
    core = new CoreClient({
      spawn,
      command: binary,
      args: ['serve', '--data-dir', path.join(root, 'identity'), '--lock-dir', path.join(root, 'locks')],
      log: quietLog,
      shellVersion: 'jest',
      grantRoot: root,
    });
    exits = [];
    core.on('exit', (exit) => exits.push(exit));
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
    jest.doMock('../wallet/ledger/ledger-backend-kind', () => ({
      ledgerBackendKind: () => 'core',
      readLedgerBackendKind: () => 'core',
    }));
    jest.doMock('../core/core-process', () => ({ getCoreClient: () => core, getLedgerRelay: () => relay }));
    jest.doMock('electron', () => ({
      app: { getPath: () => root, isPackaged: false },
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
      BrowserWindow: {
        getFocusedWindow: () => ({ isDestroyed: () => false, webContents: chrome }),
        getAllWindows: () => [],
        fromWebContents: () => null,
        fromId: () => null,
      },
    }));
    jest.doMock('../approvals/approvals-document', () => ({
      isApprovalsDocumentEnabled: () => false,
      getApprovalsDocuments: () => [],
    }));
    jest.doMock('../wallet/rpc-manager', () => ({ getKeylessRpcUrls: () => [], cachedApiKeys: () => new Map(), retiredApiKeys: () => [] }));
    jest.doMock('../wallet/chains', () => ({ getChain: () => ({ name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }) }));
    jest.doMock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
    jest.doMock('../identity-manager', () => ({
      getActiveWalletIndex: () => LEDGER_INDEX,
      getActiveWalletAddress: async () => LEDGER.address,
      getWalletRecord: (index) => (index === LEDGER_INDEX ? { ...LEDGER, name: 'Ledger 1' } : null),
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
    jest.doMock('../token-registry', () => ({ getToken: () => null, getTokenKey: (chain, asset) => `${chain}:${asset}` }));
    jest.doMock('../payment-history', () => ({
      getRecent: () => [],
      appendOnce: () => {},
      reserveHistorySlot: () => ({}),
      releaseHistorySlot: () => {},
      KINDS: { X402: 'x402' },
      STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
    }));
    jest.doMock('../freedom-root', () => ({ getFreedomDataPath: (name) => path.join(root, name) }));
    log = require('../logger');
    const { registerLedgerRelay } = require('../core/ledger-relay');
    const { HidDevice, HidHost } = require('../wallet/ledger/hid-device');
    fake = createFakeNodeHid();
    host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
    device = referenceLedger(fake, vectors);
    relay = registerLedgerRelay(core, {
      log,
      backendKind: () => 'core',
      openDevice: () => new HidDevice({ host }),
    });
    require('../core/grants').attachGrants(core);
    intercept = require('./intercept');
    sc = require('../wallet/signing-confirmation');
    const { vaultBackend } = require('../core/vault-backend');
    require('./ipc').registerX402Ipc();
    const hello = await core.start();
    expect(hello.store_moved).toContain('vault_meta');
    expect(await require('../core/grants').grantStore('x402').whenLoaded()).toBe(true);
    await vaultBackend.importVault('testpass1', VAULT_PHRASE);
    await seedAccountRecords(request, path.join(root, 'identity'), WALLETS);
    pid = core.current.child.pid;
  });

  afterAll(async () => {
    require('../core/grants').detachGrants();
    await core.stop();
    host?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const lastCall = (method, match = () => true) => calls.filter((call) => call.method === method && match(call)).pop();
  const digestOf = (typedData) => {
    const types = { ...typedData.types };
    delete types.EIP712Domain;
    return TypedDataEncoder.hash(typedData.domain, types, typedData.message);
  };

  test("a Ledger's payment the panel approved: now_s with the device, main's copy settled as { reservation, typed_data } through the relay, and the header the core's, signed by the device", async () => {
    tabs.set(41, { id: 41, hostWebContents: chrome, isDestroyed: () => false, loadURL: jest.fn().mockResolvedValue() });
    // The device signs the digest of the typed data main settles: its own copy.
    device.play(CASE, {
      sign: () => digestOf(lastCall('x402.settle', (call) => call.params.typed_data).params.typed_data),
    });
    const url = `${ORIGIN}/article/1`;
    const requirements = { x402Version: c.x402.version, resource: { url }, accepts: [c.x402.requirements] };
    await intercept.detectPaymentRequiredHandler({
      id: 1,
      webContentsId: 41,
      url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirements)).toString('base64')] },
    });
    const stored = intercept.getDetectedPayment(41);
    expect(stored?.detectionId).toBeTruthy();
    const { token } = await sc.issueConfirmation(sc.KINDS.X402_PAYMENT, LEDGER_INDEX, {
      webContentsId: 41,
      detectionId: stored.detectionId,
      url: stored.url,
      acceptIndex: 0,
      accept: stored.requirements.accepts[0],
      grant: null,
    });
    const before = Math.floor(Date.now() / 1000);

    const result = await handlers['x402:approve'](
      { sender: chrome },
      { webContentsId: 41, detectionId: stored.detectionId, selectedAcceptIndex: 0, confirmation: token }
    );
    expect(result).toEqual({ success: true });

    // x402.authorize: the Ledger's device and main's clock.
    const authorize = lastCall('x402.authorize');
    expect(authorize.params).toMatchObject({
      account: LEDGER_INDEX,
      device: { kind: 'ledger', address: LEDGER.address },
      authorization: { token },
      accept_index: 0,
    });
    expect(authorize.params.now_s).toBeGreaterThanOrEqual(before);
    expect(authorize.params.now_s).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    // x402.settle: main's own copy, never a device signature.
    const settle = lastCall('x402.settle', (call) => call.params.typed_data);
    expect(settle.params).toEqual({ reservation: expect.any(String), typed_data: expect.any(Object) });
    expect(calls.some((call) => call.method === 'x402.settle' && call.params.signature)).toBe(false);
    const typed = settle.params.typed_data;
    expect(typed.domain).toEqual(c.request.typed_data.domain);
    expect(typed.message).toMatchObject({
      from: LEDGER.address,
      to: getAddress(c.x402.requirements.payTo),
      value: c.x402.requirements.amount,
      validAfter: '0',
      validBefore: String(authorize.params.now_s + c.x402.requirements.maxTimeoutSeconds),
    });
    expect(digestOf(typed)).toBe(authorize.reply.device.hash);

    // The device saw the vector's stream, byte for byte but for the two
    // values the core made afresh (validBefore and the nonce); the
    // signature APDU is the vector's too (the path alone), signed over
    // main's copy.
    expect(device.asked).toHaveLength(honest.length);
    const differ = honest.map((apdu, i) => (apdu === device.asked[i] ? null : i)).filter((i) => i !== null);
    expect(device.ruled.map((apdu) => apdu.slice(0, 8))).toEqual(['e01c00ff', 'e01c00ff', 'e00c0001']);
    expect(differ.map((i) => device.asked[i])).toEqual(device.ruled.slice(0, 2));
    expect(device.ruled[2]).toBe(honest[honest.length - 1]);
    expect(device.translated).toEqual([]);

    // The header is the core's payment, its signature the device's over main's copy.
    const injected = intercept.injectPaymentSignatureHandler({ id: 2, webContentsId: 41, url, requestHeaders: {} });
    const header = JSON.parse(Buffer.from(injected.requestHeaders['PAYMENT-SIGNATURE'], 'base64').toString('utf8'));
    expect(header.payload.authorization).toEqual(typed.message);
    expect(recoverAddress(digestOf(typed), header.payload.signature)).toBe(LEDGER.address);
    await until(
      () => calls.some((call) => call.method === 'x402.settle' && call.params.outcome === 'sent'),
      'the payment settled sent',
      10_000
    );

    // The core read every reply main wrote: it is the one it started.
    expect(exits).toEqual([]);
    expect(core.current?.child?.pid).toBe(pid);
    expect(log.error).not.toHaveBeenCalled();
    expect(relay.stats()).toEqual({ parents: 0, open: false });
    expect(device.unrecorded).toEqual([]);
    expect(fake.violations).toEqual([]);
    intercept.cleanupWebContents(41);
  });
});
