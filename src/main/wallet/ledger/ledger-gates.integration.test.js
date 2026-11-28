/**
 * LDG-3's gates (freedom-core design 0016; the LDG-3 plan's PR 12): every
 * Ledger path main drives on the core's backend (FREEDOM_LEDGER_BACKEND=
 * core), end to end through the real freedom-cored the build pins, with a
 * fake HID Ledger answering from freedom-core's `vectors/ledger.json`.
 *
 * What runs is main's own: the signer factory's core Ledger backend
 * (wallet/signers.js), discovery and adding (wallet/ledger/core-accounts.js),
 * vault-backend.js's `deviceCall` and `ledgerCall` under the device
 * watchdog, a real CoreClient, main's relay (core/ledger-relay.js), and
 * main's HID device layer (hid-device.js: HidDevice and HidHost, its hosts
 * served in this process) over a fake node-hid
 * (test/helpers/fake-node-hid.js). Behind it, the reference's device
 * (test/helpers/ledger-reference-device.js) answers each APDU with the
 * answer ledger.json recorded for it, so each case also shows the core's
 * stream is the one the reference's device saw (and the grammar file's
 * honest stream). Only Electron and identity-manager.js's reads of the
 * wallet list (from the vault-meta.json the core reads and writes) are
 * stand-ins.
 *
 * The core reads every reply of main's to `shell.ledger_apdu` with its
 * strict reader, and ends the connection on one it doesn't take (exit 76).
 * So after each case: the core is the process it started (no exit at all,
 * the same PID), nothing was logged at error (no relay fault), the relay
 * holds no parent and no device, no APDU went unanswered by the
 * recording, and node-hid's contract held. The last case shows that check
 * fails on a reply the core doesn't take.
 *
 * - **Discovery with records** (`discovery-records-mixed`): the accounts
 *   the core checked, and main's unmatched records checked after them and
 *   kept by the core, `mismatched` as main shows it.
 * - **Signatures** under `shell`: `sign.transaction` type 0
 *   (`tx-type0-chain-100-parity-0`) and type 2 (`tx-type2-chain-1-parity-0`),
 *   `sign.message` in three pieces (`msg-live-276`) and `sign.typed_data`
 *   field by field (`typed-mail`): main's params are the vector's request,
 *   and the result is the reference's, byte for byte.
 * - **Hash-only with its warning** (`typed-hash-only-mail`, a Nano S's
 *   `6D00`), main's own warning (hash-only-warning.js) as the chrome's
 *   notice over the tab: until the notice reports it is on screen, no
 *   `E0 0C 00 00` reaches the device; then main's `hash_only: "shown"` is
 *   taken and the signature is the reference's, the notice's hashes the
 *   APDU's. A notice in a hidden window never counts: at the end of main's
 *   wait, the bare `6D00`, `LEDGER_UNKNOWN`, nothing signed.
 * - **Rejected on the device** (`status-tx-steps-piece-last-6985`):
 *   `LEDGER_USER_REJECTED` with its text.
 * - **Cancel and Reject while the device waits** (main's own cancel, as the
 *   send screen's Cancel and the approvals panel's Reject abort the
 *   signer's signal): `LEDGER_CANCELLED`, the device let go of mid-read,
 *   and the next operation runs at once on a fresh handle.
 * - **A deadline:** main's own `deadline_ms`, 15 s on the address check
 *   (`LEDGER_UNRESPONSIVE`) and 5 minutes on the APDU the user confirms
 *   (`LEDGER_TIMEOUT`). Main's timer is fired by the test as the device
 *   waits, never by the wall clock, so no case depends on timing; the
 *   core's own timer (1 s later) is never reached.
 * - **An unplug** while the device waits: `LEDGER_DISCONNECTED`; plugged in
 *   again, the next operation works.
 * - **Adding an account** (`add-legacy-3`), in a world of its own: the
 *   address shown on the device (`E0 02 01 00`, 5 minutes), the record the
 *   core writes holding the device's address.
 *
 * Skipped unless FREEDOM_CORED_PATH points at a build, or
 * FREEDOM_CORED_LEDGER_TEST=1 asks for the binary `npm run core:download`
 * fetched (which must then be there), and the vectors are found
 * (test/helpers/ledger-vectors.js; FREEDOM_CORE_LEDGER_VECTORS names
 * freedom-core's `vectors` directory at the pinned commit, and a missing
 * file then fails the suite), e.g.
 *   FREEDOM_CORED_LEDGER_TEST=1 FREEDOM_CORE_LEDGER_VECTORS=…/freedom-core/vectors \
 *     npx jest src/main/wallet/ledger/ledger-gates.integration
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('./ledger-backend-kind', () => ({
  ledgerBackendKind: () => 'core',
  readLedgerBackendKind: () => 'core',
}));

const mockWorld = { current: null };

jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockWorld.current?.client ?? null,
  getLedgerRelay: () => mockWorld.current?.relay ?? null,
}));
// Main's wallet list, read from the vault-meta.json the core reads and
// writes (in the app, identity-manager.js reads it through the core).
const mockRecordLedgerAddressCheck = jest.fn();
jest.mock('../../identity-manager', () => {
  const read = () =>
    JSON.parse(
      require('fs').readFileSync(
        require('path').join(mockWorld.current.identityDir, 'vault-meta.json'),
        'utf8'
      )
    );
  const record = (wallet) => ({ addressCheck: 'unchecked', ...wallet });
  return {
    getWalletRecord: (index) => {
      const found = read().derivedWallets.find((w) => w.index === index);
      return found ? record(found) : null;
    },
    getLedgerRecordsToCheck: () =>
      read()
        .derivedWallets.filter((w) => w.type === 'ledger' && w.addressCheck !== 'matched')
        .map(record),
    recordLedgerAddressCheck: (...args) => mockRecordLedgerAddressCheck(...args),
    recordRemoteAddressCheck: () => {},
    isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
    WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  };
});
jest.mock('../../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
jest.mock('../remote/signer', () => ({
  createRemoteBackend: () => {
    throw new Error('No phone here');
  },
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getAddress } = require('ethers');
const log = require('../../logger');
const { CoreClient, PROTOCOL_VERSION_STREAMS } = require('../../core/core-client');
const { registerLedgerRelay } = require('../../core/ledger-relay');
const { HidDevice, HidHost } = require('./hid-device');
const { getSigner } = require('../signers');
const { discoverAccounts, addAccount } = require('./core-accounts');
const { createHashOnlyWarnings } = require('./hash-only-warning');
const { until } = require('../../../../test/helpers/fake-ledger-core');
const { createFakeNodeHid, inProcessHosts } = require('../../../../test/helpers/fake-node-hid');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../../test/helpers/ledger-vectors');
const { referenceLedger } = require('../../../../test/helpers/ledger-reference-device');

const required = process.env.FREEDOM_CORED_LEDGER_TEST === '1';
const binary =
  process.env.FREEDOM_CORED_PATH ||
  (required ? require('../../core/cored-binary').getCoredBinaryPath() : null);
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

jest.setTimeout(60_000);

const LEDGER_INDEX = 1000000;
const DEVICE_MS = 15_000;
const USER_MS = 300_000;
const caseOf = (id) => vectors.cases.find((c) => c.id === id);
const honestOf = (id) => grammar.honest.find((h) => h.case === id).apdus;
const APP_CHECK = 'b001000000';
const appTranslated = [{ apdu: APP_CHECK, from: 'the app check recorded on the same app' }];

/** A vector's `sign.transaction` request (the core's wire form) as main's signer takes it. */
function signerTx(tx) {
  return {
    type: tx.type,
    chainId: BigInt(tx.chain_id),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas_limit),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    ...(tx.type === 0
      ? { gasPrice: BigInt(tx.gas_price) }
      : {
          maxFeePerGas: BigInt(tx.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
        }),
  };
}

/**
 * The relay's clock: real timers, each kept so a case can fire main's
 * deadline for the APDU the device holds at once (`pending()`, each with
 * `fire()`), rather than wait for the wall clock.
 */
function relayClock() {
  const pending = new Set();
  return {
    deps: {
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const timer = { ms };
        timer.fire = () => {
          clearTimeout(timer.handle);
          if (!pending.delete(timer)) return;
          fn();
        };
        timer.handle = setTimeout(timer.fire, ms);
        pending.add(timer);
        return timer;
      },
      clearTimer: (timer) => {
        if (!timer) return;
        clearTimeout(timer.handle);
        pending.delete(timer);
      },
    },
    pending: () => [...pending],
  };
}

/**
 * A world: an identity directory holding `meta` as vault-meta.json, the real
 * core serving it with main's relay on the core's backend, and the
 * reference's device behind main's HID layer.
 */
async function startWorld(meta) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ledger-gates-'));
  const identityDir = path.join(root, 'identity');
  fs.mkdirSync(identityDir);
  fs.writeFileSync(path.join(identityDir, 'vault-meta.json'), JSON.stringify(meta, null, 2));
  const fake = createFakeNodeHid();
  const host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
  const device = referenceLedger(fake, vectors);
  const clock = relayClock();
  const client = new CoreClient({
    spawn,
    command: binary,
    args: [
      'serve',
      '--data-dir',
      identityDir,
      '--lock-dir',
      path.join(root, 'locks'),
      '--parent-pid',
      String(process.pid),
    ],
    log: { info() {}, warn() {}, error() {}, debug() {} },
    shellVersion: 'jest',
    grantRoot: root,
    protocol: PROTOCOL_VERSION_STREAMS,
  });
  const exits = [];
  client.on('exit', (exit) => exits.push(exit));
  // Every request main sends, with its params, for the cases to read.
  const calls = [];
  const request = client.request.bind(client);
  client.request = (method, params, context, options) => {
    calls.push({ method, params, context });
    return request(method, params, context, options);
  };
  const relay = registerLedgerRelay(client, {
    log,
    backendKind: () => 'core',
    openDevice: () => new HidDevice({ host }),
    ...clock.deps,
  });
  const world = { root, identityDir, fake, host, device, clock, client, relay, exits, calls };
  mockWorld.current = world;
  const hello = await client.start();
  expect(hello.store_moved).toContain('vault_meta');
  expect(hello.capabilities).toEqual(
    expect.arrayContaining(['ledger.accounts', 'ledger.add', 'sign.transaction'])
  );
  world.pid = client.current.child.pid;
  world.readMeta = () => JSON.parse(fs.readFileSync(path.join(identityDir, 'vault-meta.json'), 'utf8'));
  world.stop = async () => {
    await client.stop();
    host.kill();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return world;
}

/** What each case leaves: the core it started, no fault, nothing held, every APDU recorded. */
async function expectClean(world) {
  expect(world.exits).toEqual([]);
  expect(world.client.current?.child?.pid).toBe(world.pid);
  expect(log.error).not.toHaveBeenCalled();
  await until(() => world.relay.stats().parents === 0, 'the relay to let go of every parent');
  expect(world.relay.stats()).toEqual({ parents: 0, open: false });
  expect(world.device.unrecorded).toEqual([]);
  expect(world.fake.violations).toEqual([]);
}

/** The request main sent last for `method`. */
const lastCall = (world, method) => world.calls.filter((c) => c.method === method).pop();

describeIfReady('LDG-3 gates: the Ledger on the core, against the real freedom-cored', () => {
  // ledger.json's world for discovery with records: a Ledger at the test
  // phrase's first live path (the account every signature here is from),
  // records no device has matched, a matched one, a phone and one with no
  // path, as the reference's vault-meta.json held them.
  const DISCOVERY = 'discovery-records-mixed';
  let world;

  beforeAll(async () => {
    world = await startWorld(caseOf(DISCOVERY).meta);
  });

  afterAll(async () => {
    await world?.stop();
    mockWorld.current = null;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    world.fake.ledger.held = null;
    world.fake.plug();
  });

  afterEach(async () => {
    await expectClean(world);
  });

  test("discovery with records: the core's accounts, and main's unmatched records checked and kept by the core", async () => {
    const c = world.device.play(DISCOVERY);
    const found = await discoverAccounts(c.request);

    expect(lastCall(world, 'ledger.accounts')).toMatchObject({
      params: { scheme: 'live', start: 0, count: 2 },
      context: { caller: 'shell' },
    });
    expect(found).toEqual({
      accounts: c.result.accounts.map((account, i) => ({ ...account, scheme: 'live', index: i })),
      mismatched: c.result.mismatched,
    });
    // Discovery's two paths, then the unmatched records' (Ledger 1,
    // Planted, Back, Still planted): the reference device's stream, and
    // the grammar's honest one.
    expect(world.device.asked).toEqual(honestOf(DISCOVERY));
    expect(world.device.asked).toEqual(c.exchanges.map((e) => e.apdu));
    expect(world.device.translated).toEqual([]);
    expect(
      world
        .readMeta()
        .derivedWallets.filter((w) => w.type === 'ledger')
        .map((w) => [w.name, w.addressCheck ?? null])
    ).toEqual([
      ['Ledger 1', 'matched'],
      ['Planted', 'mismatched'],
      ['Checked', 'matched'],
      ['Back', 'matched'],
      ['No path', 'unchecked'],
      ['Still planted', 'mismatched'],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  describe('signatures', () => {
    test.each([
      ['type 0', 'tx-type0-chain-100-parity-0'],
      ['type 2', 'tx-type2-chain-1-parity-0'],
    ])("sign.transaction, %s: main's params are the vector's, the signed transaction the reference's", async (_kind, id) => {
      const c = world.device.play(id);
      const raw = await getSigner(LEDGER_INDEX).signTransaction(signerTx(c.request.tx));

      const sent = lastCall(world, 'sign.transaction');
      expect(sent.context).toEqual({ caller: 'shell' });
      expect(sent.params).toEqual({
        key: { kind: 'ledger', index: LEDGER_INDEX, path: c.record.path, address: c.record.address },
        tx: c.request.tx,
      });
      expect(raw).toBe(c.result.raw);
      expect(world.device.asked).toEqual(honestOf(id));
      expect(world.device.translated).toEqual(appTranslated);
      expect(mockRecordLedgerAddressCheck).toHaveBeenCalledWith(LEDGER_INDEX, true);
    });

    test("sign.message in three pieces: main's params are the vector's, the signature the reference's", async () => {
      const id = 'msg-live-276';
      const c = world.device.play(id);
      const signature = await getSigner(LEDGER_INDEX).signMessage(
        Buffer.from(c.request.message.slice(2), 'hex')
      );

      expect(lastCall(world, 'sign.message').params).toEqual({
        key: { kind: 'ledger', index: LEDGER_INDEX, path: c.record.path, address: c.record.address },
        message: c.request.message,
      });
      expect(signature).toBe(c.result.signature);
      expect(world.device.asked).toEqual(honestOf(id));
      expect(world.device.asked.filter((a) => a.startsWith('e008'))).toHaveLength(3);
      expect(world.device.translated).toEqual(appTranslated);
    });

    test("sign.typed_data field by field: main's params are the vector's, the signature the reference's", async () => {
      const id = 'typed-mail';
      const c = world.device.play(id);
      const signature = await getSigner(LEDGER_INDEX).signTypedData(c.request.typed_data, {
        expectedHash: c.request.expected_hash,
      });

      expect(lastCall(world, 'sign.typed_data').params).toEqual({
        key: { kind: 'ledger', index: LEDGER_INDEX, path: c.record.path, address: c.record.address },
        typed_data: c.request.typed_data,
        expected_hash: c.request.expected_hash,
      });
      expect(signature).toBe(c.result.signature);
      expect(world.device.asked).toEqual(honestOf(id));
      expect(world.device.asked).toEqual(c.exchanges.map((e) => e.apdu));
      expect(world.device.translated).toEqual([]);
    });
  });

  describe('hash-only (a Nano S answers 6D00 to the first E0 1A), with its warning', () => {
    const id = 'typed-hash-only-mail';
    const SITE = 'https://dapp.example';
    // Main's own warning (hash-only-warning.js), as the chrome's notice over
    // the tab: a standing rule's request, or one no surface waits for. Its
    // chrome is a stand-in that keeps what main sends it; `shows` is
    // whether the window is visible and not minimized.
    let notices;
    let shows;
    let warnings;
    const chrome = {
      isDestroyed: () => false,
      send: (channel, payload) => notices.push({ channel, payload }),
    };

    beforeEach(() => {
      notices = [];
      shows = true;
      warnings = createHashOnlyWarnings({
        documentEnabled: () => false,
        chromeOf: () => chrome,
        windowShows: () => shows,
        focusedWindowId: () => 1,
        windowOfSender: (sender) => (sender === chrome ? 1 : null),
        log,
      });
    });

    /** Signs the case's typed data with the warning over window 1's tab. */
    function signWithWarning(c) {
      return getSigner(LEDGER_INDEX, {
        hashOnlySurface: warnings.surfaceFor({ windowId: 1, site: SITE }),
      }).signTypedData(c.request.typed_data, { expectedHash: c.request.expected_hash });
    }

    test("the warning comes first: nothing more reaches the device until the notice is on screen; then hash_only is taken and the signature is the reference's", async () => {
      const c = world.device.play(id);
      const signing = signWithWarning(c);

      await until(() => notices.length === 1, 'the hash-only notice');
      // The address check, B0 01 and the first E0 1A, answered 6D00: the
      // core waits for main's answer, which waits for the notice's report.
      expect(world.device.asked).toEqual(honestOf(id).slice(0, 3));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(world.device.asked).toHaveLength(3);
      // The notice's two hashes are the ones the device is then asked to sign over.
      const hashApdu = honestOf(id)[3];
      const [{ channel, payload }] = notices;
      expect(channel).toBe('ledger:hash-only-notice');
      expect(payload).toEqual({
        id: expect.stringMatching(/^[0-9a-f]{32}$/),
        site: SITE,
        domainSeparator: '0x' + hashApdu.slice(-128, -64),
        structHash: '0x' + hashApdu.slice(-64),
      });

      // The chrome reports it on screen (after two frames, in the app).
      expect(warnings.noticeShown({ sender: chrome }, { id: payload.id })).toBe(true);
      expect(await signing).toBe(c.result.signature);
      expect(world.device.asked).toEqual(honestOf(id));
      expect(world.device.translated).toEqual([]);
      // The notice goes with the operation.
      expect(notices.map((n) => n.payload)).toContainEqual({ id: payload.id, closed: true });
    });

    test('a notice in a hidden window is never on screen: at the end of main\'s wait, the bare 6D00, LEDGER_UNKNOWN, and no E0 0C 00 00 reaches the device', async () => {
      const c = world.device.play(id);
      shows = false;
      const signing = signWithWarning(c).catch((err) => err);

      await until(() => notices.length === 1, 'the hash-only notice');
      // The chrome's report doesn't count while its window isn't shown.
      expect(warnings.noticeShown({ sender: chrome }, { id: notices[0].payload.id })).toBe(false);
      // Main's wait for the report (10 s after the 6D00), fired now.
      const pending = world.clock.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].ms).toBeLessThanOrEqual(10_000);
      pending[0].fire();

      const error = await signing;
      expect(error.code).toBe('LEDGER_UNKNOWN');
      expect(world.device.asked).toEqual(honestOf(id).slice(0, 3));
    });
  });

  test('rejected on the device: LEDGER_USER_REJECTED with its text, nothing signed', async () => {
    const id = 'status-tx-steps-piece-last-6985';
    const c = world.device.play(id);
    const error = await getSigner(LEDGER_INDEX)
      .signTransaction(signerTx(c.request.tx))
      .catch((err) => err);

    expect(error.code).toBe(c.result.code);
    expect(error.message).toBe(c.result.message);
    // The core's stream up to the refused piece: the address check, B0 01,
    // and both pieces, the last answered 6985.
    expect(world.device.asked).toEqual([
      c.exchanges[0].apdu,
      APP_CHECK,
      ...c.exchanges.slice(1).map((e) => e.apdu),
    ]);
  });

  describe('Cancel and Reject while the device waits (main\'s own cancel)', () => {
    /** Waits for the device to hold its APDU, then aborts; the signer's error. */
    async function cancelWhileHeld(sign, controller) {
      const signing = sign().catch((err) => err);
      await until(() => world.fake.ledger.held !== null, 'the device to wait for the user');
      controller.abort();
      return signing;
    }

    test("the send screen's Cancel: LEDGER_CANCELLED, the device let go of mid-read, the next operation at once on a fresh handle", async () => {
      const c = world.device.play('tx-type2-chain-1-parity-0');
      world.device.hold((hex) => hex.startsWith('e004'));
      const controller = new AbortController();
      const opens = world.fake.events.filter((e) => e.type === 'open').length;

      const error = await cancelWhileHeld(
        () => getSigner(LEDGER_INDEX, { signal: controller.signal }).signTransaction(signerTx(c.request.tx)),
        controller
      );
      expect(error.code).toBe('LEDGER_CANCELLED');
      expect(error.message).toBe('Cancelled. If your Ledger still shows the request, reject it there.');
      // The handle that held the read was closed by its host's end, never
      // closed with the read pending.
      await until(
        () => world.fake.events.some((e) => e.type === 'exit-close'),
        'the held handle to close'
      );

      // The core moved on: the next signature runs at once, on a new handle.
      const next = world.device.play('msg-live-1');
      expect(
        await getSigner(LEDGER_INDEX).signMessage(Buffer.from(next.request.message.slice(2), 'hex'))
      ).toBe(next.result.signature);
      expect(world.fake.events.filter((e) => e.type === 'open').length).toBe(opens + 2);
    });

    test("the approvals panel's Reject while the Ledger waits: LEDGER_CANCELLED, nothing signed", async () => {
      const c = world.device.play('typed-mail');
      world.device.hold((hex) => hex.startsWith('e00c'));
      const controller = new AbortController();

      const error = await cancelWhileHeld(
        () =>
          getSigner(LEDGER_INDEX, { signal: controller.signal }).signTypedData(c.request.typed_data, {
            expectedHash: c.request.expected_hash,
          }),
        controller
      );
      expect(error.code).toBe('LEDGER_CANCELLED');
      expect(world.device.asked).toEqual(honestOf('typed-mail'));
    });
  });

  describe("a deadline: main's deadline_ms, fired as the device waits", () => {
    /** Waits for the device to hold its APDU, then fires main's one pending deadline. */
    async function expireWhileHeld(sign, deadlineMs) {
      const signing = sign().catch((err) => err);
      await until(() => world.fake.ledger.held !== null, 'the device to wait');
      const pending = world.clock.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].ms).toBeGreaterThan(deadlineMs - 5_000);
      expect(pending[0].ms).toBeLessThanOrEqual(deadlineMs);
      pending[0].fire();
      return signing;
    }

    test('15 s on the address check: LEDGER_UNRESPONSIVE; the next operation works', async () => {
      const c = world.device.play('msg-live-1');
      world.device.hold((hex) => hex.startsWith('e002'));
      const error = await expireWhileHeld(
        () => getSigner(LEDGER_INDEX).signMessage(Buffer.from(c.request.message.slice(2), 'hex')),
        DEVICE_MS
      );
      expect(error.code).toBe('LEDGER_UNRESPONSIVE');
      expect(error.message).toBe('The Ledger stopped answering. Reconnect it and try again.');
      expect(world.device.asked).toEqual(honestOf('msg-live-1').slice(0, 1));

      const next = world.device.play('msg-live-1');
      expect(
        await getSigner(LEDGER_INDEX).signMessage(Buffer.from(next.request.message.slice(2), 'hex'))
      ).toBe(next.result.signature);
    });

    test('5 minutes on the APDU the user confirms: LEDGER_TIMEOUT', async () => {
      const c = world.device.play('tx-type0-chain-100-parity-0');
      world.device.hold((hex) => hex.startsWith('e004'));
      const error = await expireWhileHeld(
        () => getSigner(LEDGER_INDEX).signTransaction(signerTx(c.request.tx)),
        USER_MS
      );
      expect(error.code).toBe('LEDGER_TIMEOUT');
      expect(world.device.asked).toEqual(honestOf('tx-type0-chain-100-parity-0'));
    });
  });

  test('an unplug while the device waits: LEDGER_DISCONNECTED; plugged in again, the next operation works', async () => {
    const c = world.device.play('typed-mail');
    world.device.hold((hex) => hex.startsWith('e00c'));
    const signing = getSigner(LEDGER_INDEX)
      .signTypedData(c.request.typed_data, { expectedHash: c.request.expected_hash })
      .catch((err) => err);
    await until(() => world.fake.ledger.held !== null, 'the device to wait');
    world.fake.unplug();

    const error = await signing;
    expect(error.code).toBe('LEDGER_DISCONNECTED');
    expect(error.message).toBe('Ledger was disconnected. Reconnect it and try again.');

    world.fake.plug();
    const next = world.device.play('typed-mail');
    expect(
      await getSigner(LEDGER_INDEX).signTypedData(next.request.typed_data, {
        expectedHash: next.request.expected_hash,
      })
    ).toBe(next.result.signature);
  });
});

describeIfReady('LDG-3 gates: adding an account, against the real freedom-cored', () => {
  let world;

  beforeAll(async () => {
    world = await startWorld({
      activeWalletIndex: 0,
      derivedWallets: [{ index: 0, name: 'Main Wallet', address: '0x0000000000000000000000000000000000000001' }],
    });
  });

  afterAll(async () => {
    await world?.stop();
    mockWorld.current = null;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("ledger.add: the address shown on the device, the record the core wrote holding the device's address", async () => {
    const id = 'add-legacy-3';
    const c = world.device.play(id);
    const wallet = await addAccount({ name: 'Ledger legacy', scheme: 'legacy', index: 3 });

    expect(lastCall(world, 'ledger.add')).toMatchObject({
      params: { scheme: 'legacy', index: 3, name: 'Ledger legacy' },
      context: { caller: 'shell' },
    });
    const address = getAddress(c.result.wallet.address);
    expect(wallet).toEqual({
      index: LEDGER_INDEX,
      name: 'Ledger legacy',
      address,
      type: 'ledger',
      path: c.request.path,
      addressCheck: 'matched',
    });
    expect(world.readMeta().derivedWallets[1]).toEqual(wallet);
    // Shown on the device: E0 02 01 00, the reference's E0 02 00 00 answer.
    expect(world.device.asked).toEqual(honestOf(id));
    expect(world.device.translated).toEqual([{ apdu: honestOf(id)[0], from: c.exchanges[0].apdu }]);
    expect(world.fake.ledger.apdus).toHaveLength(1);
    await expectClean(world);
  });

  test("the check itself: a reply the core's reader doesn't take ends the core (exit 76), which every case would catch", async () => {
    world.device.play('add-legacy-3');
    // A relay that adds one member to its answer, as a wire mismatch would.
    const apdu = world.relay.apdu.bind(world.relay);
    world.relay.apdu = async (params, context) => ({ ...(await apdu(params, context)), extra: true });

    const error = await addAccount({ name: 'Broken', scheme: 'legacy', index: 3 }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    await until(() => world.exits.length > 0, 'the core to exit', 10_000);
    expect(world.exits[0].code).toBe(76);
    expect(world.client.current?.child?.pid).not.toBe(world.pid);
  });
});
