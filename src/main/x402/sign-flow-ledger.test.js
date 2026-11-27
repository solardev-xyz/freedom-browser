/**
 * x402 from a Ledger account on the core's backend (sign-flow.js
 * `settledByLedger`, caps.js `settleTypedData`; freedom-core design 0016,
 * "x402 from a Ledger account", D2 option A, and LDG-2's L5 as built;
 * LDG-3's PR 9 and the plan's point 13), end to end through main: the real
 * sign flow, caps.js and vault-backend.js (`call`, `ledgerCall`), a real
 * CoreClient against a scripted core that answers `x402.authorize` and
 * `x402.settle` as cored 0.30.0 does and drives the device lane with
 * `shell.ledger_apdu` (test/helpers/fake-ledger-core.js, whose reader is
 * reply.rs's at b4e0cef4), main's relay registered on it, and a scripted
 * device behind the relay that records every byte it is sent (the spy).
 *
 * - **Per form** (ledger.json's three x402 cases): each of the core's
 *   authorizations with one thing changed (ledger-grammar.json's 99
 *   `x402_changes`) is refused by main before the first APDU, with nothing
 *   sent to the device and the reservation settled `withheld`, and a faulty
 *   core's APDUs for it are refused `parent`; only a changed nonce passes,
 *   as another nonce the core could have drawn. So is a core's hash that
 *   isn't main's.
 * - **The entry is main's:** a core that names another of the 402's
 *   entries, with typed data and a hash that match it, is refused before
 *   the first APDU, the reservation withheld: a payment the user approved
 *   pays only the entry its token binds, and an auto-pay only an entry
 *   main's own mirror shows a cap covering (else CAP_NOT_COVERED).
 * - **Main's holds against a cap** (cap-holds.js): an auto-pay that passes
 *   holds its amount in the same step, so of two authorize replies held
 *   against one cap with room for one, the second is CAP_NOT_COVERED, no
 *   APDU, withheld once. A hold is let go at once when no signature of the
 *   device's left main (as the relay saw it), whatever the core says;
 *   otherwise only once the mirror shows the spend (each rise claimed by
 *   one hold) or another cap under the key: a read that lands with the cap
 *   unchanged keeps it, and meanwhile another auto-pay finds no room.
 * - **A settled payment:** `now_s` sent with the Ledger's `device`, main's
 *   own frozen copy settled as `{ reservation, typed_data }` under the
 *   device watchdog, the honest stream carried to the device byte for byte,
 *   the core's payment stashed with its reservation; never `{ signature }`.
 * - **After a settle is sent,** whatever ends it (the device's refusal,
 *   another device, the core's `mismatch` or `cap_changed`, a failed flush,
 *   a cancel, the core's exit), the reservation is spent: main never
 *   settles it `withheld` again, and reads `data.refunded` instead.
 * - **A settle main refuses unsent** (a path main can't derive a stream
 *   for) leaves the reservation to be settled `withheld`.
 * - **The hash-only warning comes first** (Q23; LDG-3's PR 11): a device
 *   that answers `6D00` to the first `E0 1A` gets no answer, and no
 *   `E0 0C 00 00` reaches it, until the chrome's notice over the payment's
 *   tab reports it on screen; then `hash_only: "shown"`, and the notice's
 *   two hashes are the APDU's.
 *
 * Skipped unless the vectors are found (test/helpers/ledger-vectors.js):
 * FREEDOM_CORE_LEDGER_VECTORS names freedom-core's `vectors` directory, as
 * CI does at the pinned commit, and then a missing file fails the suite.
 * The JS backend's path is sign-flow.test.js's, unchanged.
 */

const mockState = {
  client: null,
  relay: null,
  records: new Map(),
  addressChecks: [],
  tabs: new Map(),
  // The caps' mirror main reads (core/grants.js), by origin.
  caps: new Map(),
  // A read of the mirror, as core/grants.js's `reread` resolves once it lands.
  reread: () => Promise.resolve(),
  // The tabs' chrome, in window 1 (the hash-only notice's, LDG-3's PR 11).
  chrome: null,
  window: null,
};

jest.mock('electron', () => ({
  app: { isPackaged: false },
  webContents: {
    fromId: (id) => {
      if (!mockState.tabs.has(id)) {
        mockState.tabs.set(id, {
          id,
          isDestroyed: () => false,
          loadURL: () => Promise.resolve(),
          hostWebContents: mockState.chrome,
        });
      }
      return mockState.tabs.get(id);
    },
  },
  BrowserWindow: {
    fromId: (id) => (id === 1 ? mockState.window : null),
    fromWebContents: (contents) => (contents && contents === mockState.chrome ? mockState.window : null),
    getFocusedWindow: () => null,
  },
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../core/core-process', () => ({
  getCoreClient: () => mockState.client,
  getLedgerRelay: () => mockState.relay,
}));
// The caps' mirror, as the core last reported it: read again after each
// payment, which this suite doesn't follow.
jest.mock('../core/grants', () => ({
  grantStore: () => ({
    reread: (key) => mockState.reread(key),
    get: (key) => mockState.caps.get(key) ?? [],
  }),
}));
jest.mock('../wallet/ledger/ledger-backend-kind', () => ({ ledgerBackendKind: () => 'core' }));
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 100,
  getWalletRecord: (index) => mockState.records.get(index) ?? null,
  isHardwareWalletIndex: (index) => index >= 100,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
  recordLedgerAddressCheck: (index, matched) => {
    mockState.addressChecks.push([index, matched]);
  },
}));
// The JS backend's signer: never asked for a Ledger on the core's backend.
jest.mock('../wallet/signers', () => ({
  getSigner: () => {
    throw new Error("the JS backend's Ledger signer was asked");
  },
}));
jest.mock('../webrequest-dispatcher', () => ({ registerWebRequestHandler: jest.fn() }));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));
// The pending payment and the chrome's notices, as sign-flow.js hands them on.
jest.mock('./intercept', () => ({
  ...jest.requireActual('./intercept'),
  setPendingPayment: jest.fn(),
  sendToHost: jest.fn(),
}));

const path = require('path');
const { pathToFileURL } = require('url');
const log = require('../logger');
const { setPendingPayment, sendToHost } = require('./intercept');
const { LedgerRelay } = require('../core/ledger-relay');
const { CHANNELS: HASH_ONLY, getHashOnlyWarnings } = require('../wallet/ledger/hash-only-warning');
const { vaultBackend } = require('../core/vault-backend');
const { TypedDataEncoder } = require('ethers');
const { signAndQueueRetry, CAP_NOT_COVERED } = require('./sign-flow');
const { rebuildLedgerAuthorization } = require('./ledger-authorization');
const capHolds = require('./cap-holds');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../test/helpers/ledger-vectors');
const { fakeLedgerDevices, startLedgerCore, until, settle } = require('../../../test/helpers/fake-ledger-core');

const grammar = ledgerVectors('ledger-grammar.json');
const ledger = ledgerVectors('ledger.json');
const found = Boolean(grammar && ledger);
const describeIfVectors = found ? describe : describe.skip;

jest.setTimeout(120_000);

(ledgerVectorsRequired ? test : test.skip)('the vectors FREEDOM_CORE_LEDGER_VECTORS names are there', () => {
  expect(ledger?.cases?.some((c) => c.family === 'x402')).toBe(true);
  expect(grammar?.x402_changes?.length).toBeGreaterThan(0);
});

const ACCOUNT = 100;
const TAB = 7;
const USER_MS = 300_000;
const DEVICE_MS = 15_000;
const DEVICE_WATCHDOG_MS = 315_000;

const x402Cases = found ? ledger.cases.filter((c) => c.family === 'x402') : [];
const honest = found ? new Map(grammar.honest.map((h) => [h.case, h.apdus])) : new Map();
const FORMS = x402Cases.map((c) => [c.id, c]);

const ORIGIN = 'https://paid.example';

/** The 402 a site answered for a case: its accept entries (the case's alone by default), as main parsed them. */
function detectionOf(c, accepts = [c.x402.requirements]) {
  const url = `${ORIGIN}/a`;
  const requirements =
    c.x402.version === 1
      ? { x402Version: 1, accepts }
      : { x402Version: 2, resource: { url }, accepts };
  return { url, requirements, detectionId: `req-${c.id}`, resourceType: 'xhr' };
}

/** The confirmation x402:approve holds for an entry: its token, as the core minted it. */
const confirmationOf = (acceptIndex = 0, token = 'token-1') => ({ token, payload: { accept_index: acceptIndex } });

/** A cap in main's mirror for the case's chain and asset, with `capAmount` of room. */
function capFor(c, capAmount = '50000') {
  mockState.caps.set(ORIGIN, [
    {
      chainId: 8453,
      asset: c.x402.requirements.asset.toLowerCase(),
      capAmount,
      spentAmount: '0',
      createdAt: c.x402.now_s - 60,
      expiresAt: c.x402.now_s + 3600,
    },
  ]);
}

let started;
let reservations;

/**
 * The scripted core's x402 methods (cored 0.30.0's replies): `authorize`
 * answers `x402.authorize` (`(params) => result` or `{ error }`), `settle`
 * gets each `x402.settle { reservation, typed_data }` (its message), and an
 * outcome settle is answered `{ refunded: true }`.
 */
function serveX402({ authorize, settle: onSettle = () => {} }) {
  const fc = started.core();
  const onMessage = fc.onMessage.bind(fc);
  fc.onMessage = (message) => {
    onMessage(message);
    if (message?.type !== 'request') return;
    if (message.method === 'x402.authorize') {
      const answer = authorize(message.params);
      // null: the test answers it itself.
      if (answer === null) return;
      if (answer.error) fc.fail(message.id, answer.error);
      else fc.respond(message.id, answer);
    } else if (message.method === 'x402.settle') {
      if (Object.hasOwn(message.params, 'outcome')) fc.respond(message.id, { refunded: true });
      else onSettle(message);
    }
  };
  return fc;
}

/** The core's reply to `x402.authorize` for a Ledger's payment: the case's typed data and hash, unless changed. */
function authorizeReply(
  c,
  { typedData = c.request.typed_data, hash = c.request.expected_hash, charged = false, acceptIndex = 0 } = {}
) {
  const reservation = `${String(reservations.length + 1).padStart(2, '0')}${'ab'.repeat(15)}`;
  reservations.push(reservation);
  return { device: { typed_data: typedData, hash }, reservation, accept_index: acceptIndex, charged };
}

/** The device answers each APDU of the case's honest stream as ledger.json recorded it. */
function answersOf(c, overrides = {}) {
  return (apdu, { index }) => {
    if (Object.hasOwn(overrides, index)) return overrides[index];
    const exchange = c.exchanges[index];
    if (!exchange || exchange.apdu !== apdu.toString('hex')) throw new Error(`unexpected APDU ${index}`);
    return exchange.answer;
  };
}

/**
 * The core's device lane for a settle: each APDU of `apdus` in turn, as
 * `shell.ledger_apdu` with its `deadline_ms` (the last one waits for the
 * user), each read back as the core reads it; stops at the first that
 * isn't an answer ending `9000`. Returns the replies.
 */
async function playLane(fc, parentId, apdus) {
  const replies = [];
  for (const [i, apdu] of apdus.entries()) {
    const ask = fc.apdu(parentId, apdu, i === apdus.length - 1 ? USER_MS : DEVICE_MS);
    await until(() => fc.reply(ask) !== null, `the reply to APDU ${i}`);
    const reply = fc.reply(ask);
    replies.push(reply);
    if (!reply.answer || reply.answer.toString('hex').slice(-4) !== '9000') break;
  }
  return replies;
}

/** Runs one payment to its end: `{ result }` or `{ error }`. */
async function pay(c, opts = {}) {
  const outcome = await signAndQueueRetry(opts.tab ?? TAB, {
    detection: detectionOf(c, opts.accepts),
    walletIndex: ACCOUNT,
    ...(opts.authorizedBy === 'cap'
      ? { authorizedBy: 'cap' }
      : { confirmation: confirmationOf(opts.acceptIndex) }),
  }).then(
    (result) => ({ result }),
    (error) => ({ error })
  );
  // A withheld settle is fire-and-forget: its answer lands a few turns later.
  await settle();
  return outcome;
}

const requests = (method) => started.core().requests(method).map((m) => m.params);
const ledgerSettles = () => requests('x402.settle').filter((p) => Object.hasOwn(p, 'typed_data'));
const outcomeSettles = () => requests('x402.settle').filter((p) => Object.hasOwn(p, 'outcome'));
const signatureSettles = () => requests('x402.settle').filter((p) => Object.hasOwn(p, 'signature'));

let settleSpy;
let requestSpy;

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(1_762_000_000_000);
  reservations = [];
  mockState.addressChecks = [];
  mockState.tabs.clear();
  mockState.caps.clear();
  mockState.reread = () => Promise.resolve();
  // The chrome of window 1, which hosts every tab here.
  mockState.chrome = {
    id: 1,
    sent: [],
    isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '..', '..', 'renderer', 'index.html')).href,
    send(channel, payload) {
      this.sent.push([channel, payload]);
    },
  };
  mockState.window = { id: 1, webContents: mockState.chrome, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false };
  require('./intercept').clearAllHostSenders?.();
  capHolds._resetForTests();
  setPendingPayment.mockClear();
  sendToHost.mockClear();
  log.warn.mockClear();
  started = await startLedgerCore({ log, devices: fakeLedgerDevices() });
  mockState.client = started.client;
  mockState.relay = started.relay;
  settleSpy = jest.spyOn(vaultBackend.x402, 'settle');
  requestSpy = jest.spyOn(started.client, 'request');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await started.client.stop();
  mockState.client = null;
  mockState.relay = null;
});

/** The case's record, as main holds it: its path and address. */
function recordFor(c, overrides = {}) {
  mockState.records.set(ACCOUNT, { index: ACCOUNT, type: 'ledger', ...c.record, ...overrides });
}

describeIfVectors('a Ledger payment on the core: the core changes the authorization', () => {
  describe.each(FORMS)('%s', (id, c) => {
    const changes = found ? grammar.x402_changes.filter((change) => change.case === id) : [];
    const refused = changes.filter((change) => change.change !== 'message.nonce');
    const nonces = changes.filter((change) => change.change === 'message.nonce');

    test.each(refused.map((change) => [change.change, change]))(
      '%s: refused before the first APDU, nothing sent to the device, the reservation withheld',
      async (_name, change) => {
        recordFor(c);
        const fc = serveX402({
          authorize: () => authorizeReply(c, { typedData: change.typed_data, hash: change.hash }),
        });

        const { error } = await pay(c);

        expect(error.message).toMatch(/isn't the one this site asked for: nothing was paid/);
        expect(ledgerSettles()).toEqual([]);
        expect(outcomeSettles()).toEqual([{ reservation: reservations[0], outcome: 'withheld' }]);
        // A faulty core sends its stream anyway, naming main's requests:
        // none is a parent, so nothing reaches the device.
        const asks = fc
          .requests('x402.authorize')
          .concat(fc.requests('x402.settle'))
          .map((m) => fc.apdu(m.id, change.apdus[0]));
        await until(() => asks.every((ask) => fc.reply(ask) !== null), 'the replies');
        expect(asks.map((ask) => fc.reply(ask))).toEqual(asks.map(() => ({ refused: 'parent' })));
        expect(started.devices.events).toEqual([]);
        expect(fc.faults).toEqual([]);
        expect(setPendingPayment).not.toHaveBeenCalled();
      }
    );

    test.each(nonces.map((change) => [change.change, change]))(
      '%s: another nonce the core could have drawn, settled as main rebuilt it around that nonce',
      async (_name, change) => {
        recordFor(c);
        const fc = serveX402({
          authorize: () => authorizeReply(c, { typedData: change.typed_data, hash: change.hash }),
          settle: (message) => fc.fail(message.id, { code: 'cancelled', message: 'Cancelled' }),
        });

        await pay(c);

        expect(ledgerSettles()).toEqual([{ reservation: reservations[0], typed_data: change.typed_data }]);
        expect(outcomeSettles()).toEqual([]);
      }
    );

    test("a core's hash that isn't main's: refused before the first APDU, the reservation withheld", async () => {
      recordFor(c);
      const fc = serveX402({ authorize: () => authorizeReply(c, { hash: `0x${'11'.repeat(32)}` }) });

      const { error } = await pay(c);

      expect(error.message).toMatch(/nothing was paid/);
      expect(ledgerSettles()).toEqual([]);
      expect(outcomeSettles()).toEqual([{ reservation: reservations[0], outcome: 'withheld' }]);
      expect(started.devices.events).toEqual([]);
      expect(fc.faults).toEqual([]);
    });
  });
});

describeIfVectors('a Ledger payment on the core: the core names another entry', () => {
  // A 402 with two entries main's rebuild can build: the case's, and one
  // that pays twice the amount to another recipient.
  const twoEntries = (c) => [
    c.x402.requirements,
    { ...c.x402.requirements, amount: '20000', payTo: `0x${'42'.repeat(20)}` },
  ];

  /** The typed data and hash a faulty core gives for `accept`: exactly what main would build for that entry. */
  function authorizationFor(c, accept) {
    const built = rebuildLedgerAuthorization({
      x402Version: 2,
      accept,
      from: c.record.address,
      nowS: c.x402.now_s,
      nonce: `0x${c.x402.nonce}`,
    });
    const typedData = JSON.parse(JSON.stringify(built.typedData));
    return { typedData, hash: TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message) };
  }

  /** The faulty core's reply naming entry `acceptIndex` (its own typed data for it, when it has one). */
  function replyNaming(c, acceptIndex, accepts) {
    const accept = accepts[acceptIndex];
    return accept ? authorizeReply(c, { ...authorizationFor(c, accept), acceptIndex }) : authorizeReply(c, { acceptIndex });
  }

  function expectRefusedUnsent(fc) {
    expect(ledgerSettles()).toEqual([]);
    expect(outcomeSettles()).toEqual([{ reservation: reservations[0], outcome: 'withheld' }]);
    expect(started.devices.events).toEqual([]);
    expect(fc.faults).toEqual([]);
    expect(setPendingPayment).not.toHaveBeenCalled();
  }

  test("the user approved the first entry; the core pays the second, its typed data matching it: refused before the first APDU, withheld", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    const accepts = twoEntries(c);
    const fc = serveX402({ authorize: () => replyNaming(c, 1, accepts) });

    const { error } = await pay(c, { accepts, acceptIndex: 0 });

    expect(requests('x402.authorize')[0]).toMatchObject({ accept_index: 0 });
    expect(error.message).toMatch(/isn't the one you approved: nothing was paid/);
    expectRefusedUnsent(fc);
  });

  test.each([
    ['out of range', 2],
    ['negative', -1],
    ['text', '0'],
    ['missing', undefined],
  ])("an accept_index %s: refused before the first APDU, withheld", async (_what, acceptIndex) => {
    const [, c] = FORMS[0];
    recordFor(c);
    const accepts = twoEntries(c);
    const fc = serveX402({ authorize: () => ({ ...authorizeReply(c), accept_index: acceptIndex }) });

    const { error } = await pay(c, { accepts, acceptIndex: 0 });

    expect(error.message).toMatch(/nothing was paid/);
    expectRefusedUnsent(fc);
  });

  test('the second entry approved and named: settled around it', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    const accepts = twoEntries(c);
    const fc = serveX402({
      authorize: () => replyNaming(c, 1, accepts),
      settle: (message) => fc.fail(message.id, { code: 'cancelled', message: 'Cancelled' }),
    });

    await pay(c, { accepts, acceptIndex: 1 });

    expect(ledgerSettles()).toEqual([
      { reservation: reservations[0], typed_data: authorizationFor(c, accepts[1]).typedData },
    ]);
    expect(outcomeSettles()).toEqual([]);
  });

  test("an auto-pay: the core picks an entry main's mirror shows no cap covering: CAP_NOT_COVERED before the first APDU, withheld", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    // Room for the first entry's 10000, not the second's 20000.
    capFor(c, '15000');
    const accepts = twoEntries(c);
    const fc = serveX402({ authorize: () => replyNaming(c, 1, accepts) });

    const { error } = await pay(c, { accepts, authorizedBy: 'cap' });

    expect(error.code).toBe(CAP_NOT_COVERED);
    expectRefusedUnsent(fc);
  });

  test('an auto-pay with no cap in main\'s mirror: CAP_NOT_COVERED before the first APDU, withheld', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    const fc = serveX402({ authorize: () => authorizeReply(c) });

    const { error } = await pay(c, { authorizedBy: 'cap' });

    expect(error.code).toBe(CAP_NOT_COVERED);
    expectRefusedUnsent(fc);
  });

  test("an auto-pay: the core's pick among entries main's mirror shows covered is settled around it", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '50000');
    const accepts = twoEntries(c);
    const fc = serveX402({
      authorize: () => replyNaming(c, 1, accepts),
      settle: (message) => fc.fail(message.id, { code: 'cancelled', message: 'Cancelled' }),
    });

    await pay(c, { accepts, authorizedBy: 'cap' });

    expect(ledgerSettles()).toEqual([
      { reservation: reservations[0], typed_data: authorizationFor(c, accepts[1]).typedData },
    ]);
  });
});

describeIfVectors("a Ledger auto-pay on the core: main's holds against the cap", () => {
  const assetOf = (c) => c.x402.requirements.asset.toLowerCase();
  const heldOf = (c) => capHolds.heldAmount(ORIGIN, 8453, assetOf(c));
  const cancelled = { code: 'cancelled', message: 'Cancelled' };
  const capRecord = () => mockState.caps.get(ORIGIN)[0];

  /** A mirror read that lands only when the test says so (with the mirror as the test left it). */
  function readHeld() {
    const read = {};
    read.promise = new Promise((resolve) => {
      read.land = resolve;
    });
    mockState.reread = () => read.promise;
    return read;
  }

  /** The core: each auto-pay's honest stream on the device, then `end(message)` (the payment, by default). */
  function signingCore(c, end = null) {
    started.devices.respond = answersOf(c);
    const fc = serveX402({
      authorize: () => authorizeReply(c, { charged: true }),
      settle: (message) => {
        playLane(fc, message.id, honest.get(c.id)).then(() =>
          end ? end(fc, message) : fc.respond(message.id, { payload: JSON.parse(c.result.payload), charged: true })
        );
      },
    });
    return fc;
  }

  test('two authorize replies held against one insufficient cap: one goes on, the other is CAP_NOT_COVERED with no APDU, withheld once', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    // Room for one 10000 payment, not two.
    capFor(c, '15000');
    const ledgerAsks = [];
    const fc = serveX402({ authorize: () => null, settle: (message) => ledgerAsks.push(message) });
    const payments = [pay(c, { authorizedBy: 'cap', tab: 7 }), pay(c, { authorizedBy: 'cap', tab: 8 })];
    await until(() => fc.requests('x402.authorize').length === 2, 'both authorizations');

    // Both replies in one chunk, as the core's writer sends frames back to back.
    fc.batch(() => {
      for (const message of fc.requests('x402.authorize')) {
        fc.respond(message.id, authorizeReply(c, { charged: true }));
      }
    });
    await until(() => ledgerAsks.length === 1 && outcomeSettles().length === 1, 'one settle and one withheld');
    await settle();

    expect(ledgerSettles()).toHaveLength(1);
    const going = ledgerSettles()[0].reservation;
    const refused = reservations.find((reservation) => reservation !== going);
    expect(outcomeSettles()).toEqual([{ reservation: refused, outcome: 'withheld' }]);
    expect(started.devices.events).toEqual([]);
    expect(heldOf(c)).toBe(10000n);

    fc.fail(ledgerAsks[0].id, cancelled);
    const outcomes = await Promise.all(payments);

    expect(outcomes.map(({ error }) => error?.code).sort()).toEqual([CAP_NOT_COVERED, 'cancelled'].sort());
    expect(outcomeSettles()).toHaveLength(1);
    expect(started.devices.events).toEqual([]);
    expect(heldOf(c)).toBe(0n);
    expect(fc.faults).toEqual([]);
  });

  // No signature of the device's left main, as main's relay saw it: the
  // hold is let go at once, whatever the core says of its charge, even with
  // the mirror's read never landing.
  const lastApdu = (c) => c.exchanges.length - 1;
  const AT_ONCE = [
    ["refused before the device (the core's hash isn't main's)", { hash: `0x${'11'.repeat(32)}` }],
    ["refused unsent (a path main can't derive a stream for)", { path: true }],
    [
      'the core ends it before the device, saying refunded false',
      { error: { code: 'not_authorized', message: 'x', data: { reason: 'cap_changed', refunded: false } } },
    ],
    ['cancelled before the device', { error: cancelled }],
    [
      'rejected on the device, the core saying refunded false',
      {
        lane: (c) => ({ [lastApdu(c)]: '6985' }),
        error: { code: 'device_failed', message: 'x', data: { ledger: 'LEDGER_USER_REJECTED', refunded: false } },
      },
    ],
    [
      'the device fails at the signature',
      {
        lane: (c) => ({ [lastApdu(c)]: { fail: 'disconnected' } }),
        error: { code: 'device_failed', message: 'x', data: { ledger: 'LEDGER_DISCONNECTED', refunded: true } },
      },
    ],
  ];

  test.each(AT_ONCE)('%s: the hold is let go at once', async (_what, how) => {
    const [, c] = FORMS[0];
    recordFor(c, how.path ? { path: `m/${c.record.path}` } : {});
    capFor(c, '15000');
    readHeld();
    if (how.lane) started.devices.respond = answersOf(c, how.lane(c));
    const fc = serveX402({
      authorize: () => authorizeReply(c, { charged: true, ...(how.hash ? { hash: how.hash } : {}) }),
      settle: (message) => {
        const lane = how.lane ? playLane(fc, message.id, honest.get(c.id)) : Promise.resolve();
        lane.then(() => fc.fail(message.id, how.error));
      },
    });

    const { error } = await pay(c, { authorizedBy: 'cap' });

    expect(error).toBeDefined();
    expect(heldOf(c)).toBe(0n);
    if (!how.lane) expect(started.devices.events).toEqual([]);
  });

  test("a signed payment whose first read after it lands with the cap unchanged: another auto-pay stays refused until a later read shows the spend", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    const read = readHeld();
    signingCore(c);

    const first = await pay(c, { authorizedBy: 'cap' });
    expect(first.error).toBeUndefined();
    expect(setPendingPayment).toHaveBeenCalledTimes(1);
    expect(heldOf(c)).toBe(10000n);

    // The read asked after it lands, the cap unchanged (a core that doesn't
    // report the spend): the hold stays, and another auto-pay finds no room.
    read.land();
    await settle();
    expect(heldOf(c)).toBe(10000n);
    const second = await pay(c, { authorizedBy: 'cap', tab: 8 });
    expect(second.error.code).toBe(CAP_NOT_COVERED);
    expect(ledgerSettles()).toHaveLength(1);
    expect(started.devices.of('open')).toHaveLength(1);

    // A later refresh shows the spend: the mirror counts it now, not the hold.
    capRecord().spentAmount = '10000';
    expect(heldOf(c)).toBe(0n);
    const third = await pay(c, { authorizedBy: 'cap', tab: 9 });
    expect(third.error.code).toBe(CAP_NOT_COVERED);
    expect(ledgerSettles()).toHaveLength(1);
  });

  test('two signed payments against one rise: only one hold is let go', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '25000');
    signingCore(c);

    expect((await pay(c, { authorizedBy: 'cap', tab: 7 })).error).toBeUndefined();
    expect((await pay(c, { authorizedBy: 'cap', tab: 8 })).error).toBeUndefined();
    expect(heldOf(c)).toBe(20000n);

    capRecord().spentAmount = '10000';
    expect(heldOf(c)).toBe(10000n);
    capRecord().spentAmount = '20000';
    expect(heldOf(c)).toBe(0n);
  });

  test.each([
    ['revoked, then granted again (another createdAt)', 'replaced'],
    ['gone from the mirror, then granted again', 'gone'],
  ])('a signed payment whose cap is %s: the hold is let go', async (_what, how) => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    signingCore(c);

    expect((await pay(c, { authorizedBy: 'cap' })).error).toBeUndefined();
    expect(heldOf(c)).toBe(10000n);

    if (how === 'gone') {
      mockState.caps.delete(ORIGIN);
      // No cap covers anything: the hold waits, inert.
      expect(heldOf(c)).toBe(10000n);
      expect((await pay(c, { authorizedBy: 'cap', tab: 8 })).error.code).toBe(CAP_NOT_COVERED);
      capFor(c, '15000');
    }
    capRecord().createdAt += 30;
    expect(heldOf(c)).toBe(0n);
  });

  test.each([
    ["the cap changed after the signature (refunded false): kept until another cap takes the key", 'replaced'],
    ["the hold's write wasn't flushed (counted, refunded false): kept until the mirror shows it", 'spent'],
    ['the core says refunded after the signature: kept until the mirror shows the spend or another cap', 'spent'],
  ])('%s', async (what, settles) => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    const read = readHeld();
    const data = what.includes('flushed')
      ? { store: 'x402', applied: true, durable: false, refunded: false }
      : { reason: 'cap_changed', refunded: what.includes('says refunded') };
    signingCore(c, (fc, message) =>
      fc.fail(message.id, { code: what.includes('flushed') ? 'storage' : 'not_authorized', message: 'x', data })
    );

    const { error } = await pay(c, { authorizedBy: 'cap' });

    expect(error).toBeDefined();
    expect(outcomeSettles()).toEqual([]);
    read.land();
    await settle();
    expect(heldOf(c)).toBe(10000n);
    if (settles === 'spent') capRecord().spentAmount = '10000';
    else capRecord().createdAt += 30;
    expect(heldOf(c)).toBe(0n);
  });

  test('the core exits while the device waits for the user: no signature left main, the hold is let go at once', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    readHeld();
    started.devices.respond = answersOf(c, { [lastApdu(c)]: { hold: true } });
    const fc = serveX402({
      authorize: () => authorizeReply(c, { charged: true }),
      settle: (message) => {
        const apdus = honest.get(c.id);
        playLane(fc, message.id, apdus.slice(0, -1)).then(() => fc.apdu(message.id, apdus.at(-1), USER_MS));
      },
    });
    const paid = pay(c, { authorizedBy: 'cap' });
    await until(() => started.devices.held.length === 1, 'the device waiting for the user');

    fc.exit(null, 'SIGKILL');
    const { error } = await paid;

    expect(error.code).toBe('core_unavailable');
    expect(heldOf(c)).toBe(0n);
  });

  test("the core's cancel overtakes the device's signature: no signature left main, the hold is let go at once", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    readHeld();
    // The device's signature reaches the relay after the core's cancel of
    // the last APDU (a device whose answer outlives main letting go of it).
    started.devices.respond = answersOf(c, { [lastApdu(c)]: { hold: true, outlives: true } });
    let settleId = null;
    let lastAsk = null;
    const fc = serveX402({
      authorize: () => authorizeReply(c, { charged: true }),
      settle: (message) => {
        settleId = message.id;
        const apdus = honest.get(c.id);
        playLane(fc, message.id, apdus.slice(0, -1)).then(() => {
          lastAsk = fc.apdu(message.id, apdus.at(-1), USER_MS);
        });
      },
    });
    const paid = pay(c, { authorizedBy: 'cap' });
    await until(() => started.devices.held.length === 1, 'the device waiting for the user');

    fc.cancel(lastAsk);
    await until(() => fc.reply(lastAsk) !== null, 'the cancelled reply');
    expect(fc.reply(lastAsk)).toEqual({ cancelled: true });
    const signature = c.exchanges[lastApdu(c)].answer;
    started.devices.release(signature);
    await settle();
    expect(started.devices.of('answer').at(-1).answer).toBe(signature);
    fc.fail(settleId, cancelled);
    const { error } = await paid;

    expect(error.code).toBe('cancelled');
    expect(heldOf(c)).toBe(0n);
    expect(fc.faults).toEqual([]);
  });

  test('the core exits after the device signed: the hold is kept until the mirror accounts for it', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c, '15000');
    const read = readHeld();
    signingCore(c, (fc) => fc.exit(null, 'SIGKILL'));

    const { error } = await pay(c, { authorizedBy: 'cap' });

    expect(error.code).toBe('core_unavailable');
    read.land();
    await settle();
    expect(heldOf(c)).toBe(10000n);
    capRecord().spentAmount = '10000';
    expect(heldOf(c)).toBe(0n);
  });
});

describeIfVectors('a Ledger payment on the core: settled', () => {
  test.each(FORMS)(
    "%s: now_s, main's copy settled under the device watchdog, the honest stream on the device, the payment stashed",
    async (id, c) => {
      recordFor(c);
      started.devices.respond = answersOf(c);
      let lane = null;
      const fc = serveX402({
        authorize: () => authorizeReply(c),
        settle: (message) => {
          lane = playLane(fc, message.id, honest.get(id)).then((replies) => {
            fc.respond(message.id, { payload: JSON.parse(c.result.payload), charged: false });
            return replies;
          });
        },
      });

      const { result, error } = await pay(c);

      expect(error).toBeUndefined();
      expect(result).toBeUndefined();
      // x402.authorize: the Ledger's device, with main's clock.
      expect(requests('x402.authorize')).toEqual([
        expect.objectContaining({
          account: ACCOUNT,
          device: { kind: 'ledger', address: c.record.address },
          now_s: c.x402.now_s,
          authorization: { token: 'token-1' },
          accept_index: 0,
        }),
      ]);
      // x402.settle: exactly the reservation and main's own copy, which
      // equals the core's, under the device watchdog.
      const [settleParams] = ledgerSettles();
      expect(Object.keys(settleParams)).toEqual(['reservation', 'typed_data']);
      expect(settleParams).toEqual({ reservation: reservations[0], typed_data: c.request.typed_data });
      const sent = requestSpy.mock.calls.filter(([method, params]) => method === 'x402.settle' && params.typed_data);
      expect(sent).toHaveLength(1);
      expect(sent[0][3]).toMatchObject({ deviceWatchdogMs: DEVICE_WATCHDOG_MS });
      expect(sent[0][3].watchdogMs).toBeUndefined();
      // Every APDU of the honest stream reached the device byte for byte,
      // on one device, closed after.
      const replies = await lane;
      expect(replies.every((reply) => reply.answer)).toBe(true);
      expect(started.devices.bytes()).toEqual(honest.get(id));
      expect(started.devices.of('open')).toHaveLength(1);
      expect(started.devices.of('detach')).toHaveLength(1);
      expect(fc.faults).toEqual([]);
      expect(started.relay.stats()).toEqual({ parents: 0, open: false });
      // The core's payment, stashed with its reservation, which now waits
      // for `sent` or `withheld` there.
      expect(setPendingPayment).toHaveBeenCalledTimes(1);
      const [, , pending] = setPendingPayment.mock.calls[0];
      expect(pending).toMatchObject({ reservation: reservations[0], charged: false });
      expect(JSON.parse(Buffer.from(pending.value, 'base64').toString())).toEqual(JSON.parse(c.result.payload));
      expect(signatureSettles()).toEqual([]);
      expect(outcomeSettles()).toEqual([]);
      expect(settleSpy).not.toHaveBeenCalled();
      expect(mockState.addressChecks).toEqual([[ACCOUNT, true]]);
    }
  );

  test("a cap's auto-pay: the hold charged at authorize, the payment signed on the device and stashed", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    capFor(c);
    started.devices.respond = answersOf(c);
    const fc = serveX402({
      authorize: () => authorizeReply(c, { charged: true }),
      settle: (message) => {
        playLane(fc, message.id, honest.get(c.id)).then(() =>
          fc.respond(message.id, { payload: JSON.parse(c.result.payload), charged: true })
        );
      },
    });

    const { error } = await pay(c, { authorizedBy: 'cap' });

    expect(error).toBeUndefined();
    expect(requests('x402.authorize')[0]).toMatchObject({
      now_s: c.x402.now_s,
      authorization: { cap: { agent: false, attributable: true } },
    });
    expect(sendToHost).toHaveBeenCalledWith(TAB, 'x402:cap-consumed', { origin: ORIGIN });
    expect(setPendingPayment.mock.calls[0][2]).toMatchObject({ reservation: reservations[0], charged: true });
    expect(outcomeSettles()).toEqual([]);
  });

  test('a signed payment keeps its reservation: a payment past its runway when it comes back is withheld', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    started.devices.respond = answersOf(c);
    const fc = serveX402({
      authorize: () => authorizeReply(c),
      settle: (message) => {
        playLane(fc, message.id, honest.get(c.id)).then(() => {
          // The user took 45 s to confirm: 15 s of the authorization left.
          Date.now.mockReturnValue(1_762_000_045_000);
          fc.respond(message.id, { payload: JSON.parse(c.result.payload), charged: false });
        });
      },
    });

    const { error } = await pay(c);

    expect(error.message).toMatch(/expired while it was being confirmed/);
    expect(outcomeSettles()).toEqual([{ reservation: reservations[0], outcome: 'withheld' }]);
    expect(setPendingPayment).not.toHaveBeenCalled();
  });
});

describeIfVectors('a Ledger payment on the core: whatever ends a sent settle, its reservation is spent', () => {
  const lastApdu = (c) => c.exchanges.length - 1;
  const fail = (code, message, data) => ({ code, message, ...(data ? { data } : {}) });

  // [what, the device's overrides by APDU index (null: the core ends it
  // before the lane), the core's error, the caller's code, refunded]
  const OUTCOMES = [
    [
      'the device rejects it',
      (c) => ({ [lastApdu(c)]: '6985' }),
      fail('device_failed', 'Ledger device failed', { ledger: 'LEDGER_USER_REJECTED', refunded: true }),
      'LEDGER_USER_REJECTED',
      true,
    ],
    [
      'another device holds another account',
      () => ({}),
      fail('device_failed', 'Ledger device failed', { ledger: 'LEDGER_WRONG_DEVICE', refunded: false }),
      'LEDGER_WRONG_DEVICE',
      false,
    ],
    [
      "the core's authorization isn't main's copy",
      null,
      fail('not_authorized', 'typed_data: not the reserved authorization', { reason: 'mismatch', refunded: true }),
      'not_authorized',
      true,
    ],
    [
      'the cap changed while the device signed',
      () => ({}),
      fail('not_authorized', 'the cap changed', { reason: 'cap_changed', refunded: false }),
      'not_authorized',
      false,
    ],
    [
      "the hold's write wasn't flushed",
      () => ({}),
      fail('storage', 'The permission file could not be written durably', {
        store: 'x402',
        applied: true,
        durable: false,
        refunded: false,
      }),
      'storage',
      false,
    ],
    ['the settle is cancelled', () => ({}), fail('cancelled', 'Cancelled'), 'cancelled', false],
  ];

  test.each(OUTCOMES)(
    '%s: never settled withheld again',
    async (_what, overrides, coreError, code, refunded) => {
      const [, c] = FORMS[0];
      recordFor(c);
      if (overrides) started.devices.respond = answersOf(c, overrides(c));
      const fc = serveX402({
        authorize: () => authorizeReply(c),
        settle: (message) => {
          const lane = overrides ? playLane(fc, message.id, honest.get(c.id)) : Promise.resolve();
          lane.then(() => fc.fail(message.id, coreError));
        },
      });

      const { error } = await pay(c);

      expect(error.code).toBe(code);
      expect(ledgerSettles()).toHaveLength(1);
      expect(outcomeSettles()).toEqual([]);
      expect(settleSpy).not.toHaveBeenCalled();
      expect(setPendingPayment).not.toHaveBeenCalled();
      // `data.refunded` read instead: the cap's room is back, or isn't.
      expect(sendToHost.mock.calls.filter(([, channel]) => channel === 'x402:cap-consumed')).toHaveLength(
        refunded ? 1 : 0
      );
      expect(fc.faults).toEqual([]);
      if (!overrides) expect(started.devices.events).toEqual([]);
      expect(started.relay.stats()).toEqual({ parents: 0, open: false });
    }
  );

  test("the device's failure is shown with the Ledger's text, the core's error its cause", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    started.devices.respond = answersOf(c, { [lastApdu(c)]: '6985' });
    const fc = serveX402({
      authorize: () => authorizeReply(c),
      settle: (message) =>
        playLane(fc, message.id, honest.get(c.id)).then(() =>
          fc.fail(message.id, OUTCOMES[0][2])
        ),
    });

    const { error } = await pay(c);

    expect(error.message).toBe('Request rejected on the Ledger device.');
    expect(error.cause).toMatchObject({ code: 'device_failed', data: { ledger: 'LEDGER_USER_REJECTED', refunded: true } });
    expect(mockState.addressChecks).toEqual([]);
  });

  test('another device: the record is marked mismatched, as the JS backend marks it', async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    const fc = serveX402({
      authorize: () => authorizeReply(c),
      settle: (message) => fc.fail(message.id, OUTCOMES[1][2]),
    });

    await pay(c);

    expect(mockState.addressChecks).toEqual([[ACCOUNT, false]]);
  });

  test("the core exits while the device signs: nothing is settled again, to it or to the next", async () => {
    const [, c] = FORMS[0];
    recordFor(c);
    started.devices.respond = answersOf(c, { [lastApdu(c)]: { hold: true } });
    const fc = serveX402({
      authorize: () => authorizeReply(c),
      settle: (message) => {
        const apdus = honest.get(c.id);
        playLane(fc, message.id, apdus.slice(0, -1)).then(() => fc.apdu(message.id, apdus.at(-1), USER_MS));
      },
    });
    const paid = pay(c);
    await until(() => started.devices.held.length === 1, 'the device waiting for the user');

    fc.exit(null, 'SIGKILL');
    const { error } = await paid;

    expect(error.code).toBe('core_unavailable');
    expect(settleSpy).not.toHaveBeenCalled();
    expect(outcomeSettles()).toEqual([]);
    expect(started.relay.stats()).toEqual({ parents: 0, open: false });
  });
});

describeIfVectors('a Ledger payment on the core: a settle main refuses unsent', () => {
  test("a record path main can't derive a stream for: nothing sent, the reservation withheld", async () => {
    const [, c] = FORMS[0];
    recordFor(c, { path: `m/${c.record.path}` });
    const fc = serveX402({ authorize: () => authorizeReply(c) });

    const { error } = await pay(c);

    expect(error).toMatchObject({ code: 'invalid_argument', data: { rule: 'path' } });
    expect(ledgerSettles()).toEqual([]);
    expect(outcomeSettles()).toEqual([{ reservation: reservations[0], outcome: 'withheld' }]);
    expect(started.devices.events).toEqual([]);
    expect(fc.faults).toEqual([]);
  });
});

describeIfVectors("a Ledger payment on the core: the hash-only warning comes first (Q23, LDG-3's PR 11)", () => {
  test.each(FORMS)(
    "%s: over the payment's tab, the 6D00 held until the notice reports; the hashes shown are the APDU's",
    async (id, c) => {
      recordFor(c);
      const { admission } = new LedgerRelay({ log }).prepare({
        method: 'x402.settle',
        params: { reservation: 'r', typed_data: c.request.typed_data },
        path: c.record.path,
        expectedHash: c.request.expected_hash,
      });
      const hashOnlyApdu = admission.hashOnlySlot.apdu.toString('hex');
      // A Nano S: the case's address check and app, 6D00 to the first E0 1A,
      // and the recorded signature (over the same digest) for the two hashes.
      started.devices.respond = (apdu, { index }) => {
        const text = apdu.toString('hex');
        if (index < 2) return c.exchanges[index].answer;
        if (text.startsWith('e01a')) return '6d00';
        if (text === hashOnlyApdu) return c.exchanges.at(-1).answer;
        throw new Error(`unexpected APDU ${index}`);
      };
      const lane = { sixD: null, done: null };
      const fc = serveX402({
        authorize: () => authorizeReply(c),
        settle: (message) => {
          lane.done = (async () => {
            for (const [i, slot] of admission.slots.slice(0, 3).entries()) {
              const ask = fc.apdu(message.id, slot.apdu.toString('hex'), DEVICE_MS);
              if (i === 2) lane.sixD = ask;
              await until(() => fc.reply(ask) !== null, `the reply to APDU ${i}`, 20_000);
            }
            if (!fc.reply(lane.sixD).hashOnlyShown) return;
            const ask = fc.apdu(message.id, hashOnlyApdu, USER_MS);
            await until(() => fc.reply(ask) !== null, 'the signature');
            fc.respond(message.id, { payload: JSON.parse(c.result.payload), charged: false });
          })();
        },
      });
      const notices = () => mockState.chrome.sent.filter(([channel]) => channel === HASH_ONLY.NOTICE).map(([, m]) => m);

      const paid = pay(c);
      await until(() => notices().length > 0, 'the notice up', 10_000);
      const [notice] = notices();
      // Held: no answer to the 6D00, nothing signing on the device.
      await settle();
      expect(fc.raw(lane.sixD)).toBeNull();
      expect(started.devices.bytes().some((apdu) => apdu.startsWith('e00c'))).toBe(false);
      expect(notice.site).toBe(ORIGIN);
      expect(getHashOnlyWarnings().noticeShown({ sender: mockState.chrome }, { id: notice.id })).toBe(true);
      const { error } = await paid;
      await lane.done;

      expect(error).toBeUndefined();
      expect(fc.raw(lane.sixD).result).toEqual({ answer: '6d00', hash_only: 'shown' });
      const reachedHashOnly = started.devices.bytes().filter((apdu) => apdu.startsWith('e00c0000'));
      expect(reachedHashOnly).toEqual([hashOnlyApdu]);
      expect(hashOnlyApdu.endsWith(notice.domainSeparator.slice(2) + notice.structHash.slice(2))).toBe(true);
      const typed = c.request.typed_data;
      const types = { ...typed.types };
      delete types.EIP712Domain;
      expect(notice.domainSeparator).toBe(TypedDataEncoder.hashDomain(typed.domain));
      expect(notice.structHash).toBe(TypedDataEncoder.from(types).hash(typed.message));
      expect(notices().at(-1)).toEqual({ id: notice.id, closed: true });
      expect(setPendingPayment).toHaveBeenCalledTimes(1);
      expect(fc.faults).toEqual([]);
    }
  );
});
