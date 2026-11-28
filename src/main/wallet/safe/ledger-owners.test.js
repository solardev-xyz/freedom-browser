/**
 * A Safe's Ledger owner signing through the core (ledger-owners.js, routed
 * from core-sends.js and core-messages.js; freedom-core design 0016,
 * "Main's typed-data binding", "Approval records", "The device lane",
 * "Typed data on the device (Q23)"; SAFE-3's PR 8), with
 * FREEDOM_SAFE_BACKEND=core and FREEDOM_LEDGER_BACKEND=core, against a
 * scripted core that reads each `safe.*` request as cored-v0.32.0 does and
 * drives the device lane as cored does, one `shell.ledger_apdu` per APDU,
 * reading main's replies as its lane does (test/helpers/fake-safe-core.js),
 * through the real CoreClient, vault backend, pending-store copy, approval
 * records and main's relay, with a device behind it that records every byte
 * it is sent (fake-ledger-core.js's devices, or the reference's Ledger over
 * a fake node-hid, ledger-reference-device.js):
 * - **Main's Safe binding, a SafeTx:** the pending entry's fields under the
 *   approval record stream the device's typed data byte for byte (the
 *   reference's recording of `typed-safe-tx`); any of the ten fields, the
 *   Safe or the chain changed in the entry is refused before any APDU,
 *   nothing sent; another SafeTx pending is SAFE_DISCARDED, unsent; one
 *   byte of the core's stream changed is refused `payload` before the
 *   device, shown as discarded or replaced.
 * - **A SafeMessage** bound to the page's own request: the core's session
 *   whose hash isn't main's SafeMessage for that request is refused,
 *   unsent; a stream of another digest is refused before the device.
 * - **Confirm again with no record** (the plan's point 6): after a restart
 *   the owner's turn is SAFE_APPROVAL_NEEDED, unsent; the board shows
 *   `wallet.safe_send` from the entry's fields, the approval there records
 *   the SafeTx and mints nothing, and the owner then signs; rejected, or
 *   for fields that don't hash to the core's hash, nothing is recorded or
 *   sent.
 * - **The hash-only warning on the board:** a Ledger's `6D00` is held until
 *   the board's owner row (its window, the owner picked and the board
 *   prompt's handle) reports the warning on screen; no `E0 0C 00 00`
 *   reaches the device before.
 * - **The 7:15 watchdog and its reset per APDU:** a Ledger owner's
 *   `safe.sign_owner` isn't killed before 7 minutes and 15 s with no APDU
 *   and is then; from its first APDU each APDU and each answer gives it
 *   that APDU's `deadline_ms` + 15 s more.
 * - **The switch** (the plan's point 4): on the JS Ledger backend a Ledger
 *   owner is refused, unsent; LDG-3's point-11 path (a Safe approval to
 *   `sign.typed_data`) is refused on the core's Safe backend.
 * The relay's refusal of a Safe parent's APDU outside its row is
 * core/ledger-relay.test.js's.
 */

jest.mock(
  'electron',
  () => ({
    app: { isPackaged: false, getPath: () => require('os').tmpdir() },
    BrowserWindow: { fromId: () => null, getFocusedWindow: () => null },
    webContents: { fromId: () => null },
  }),
  { virtual: true }
);
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('./safe-backend-kind', () => ({
  safeBackendKind: () => 'core',
  readSafeBackendKind: () => 'core',
}));
const mockLedgerKind = { kind: 'core' };
jest.mock('../ledger/ledger-backend-kind', () => ({
  ledgerBackendKind: () => mockLedgerKind.kind,
  readLedgerBackendKind: () => mockLedgerKind.kind,
}));
const mockCore = { made: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockCore.made?.client ?? null,
  getLedgerRelay: () => mockCore.made?.relay ?? null,
}));
const mockRecords = {
  0: { index: 0, name: 'Main Wallet', address: '0x' + '0a'.repeat(20), type: 'mnemonic' },
  1000000: {
    index: 1000000,
    name: 'My Nano',
    address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    type: 'ledger',
    path: "44'/60'/0'/0/0",
  },
  5: {
    index: 5,
    name: 'Joint',
    address: '0x1234567890AbcdEF1234567890aBcdef12345678',
    type: 'safe',
    owners: [0, 1000000],
    threshold: 2,
    deployed: { 100: { verified: true } },
  },
};
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords[index] ?? null,
  getDerivedWallets: async () => Object.values(mockRecords),
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  recordLedgerAddressCheck: () => {},
  recordRemoteAddressCheck: () => {},
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
const mockPanel = { approvals: null, documents: null };
jest.mock('../../approvals/wallet-approvals', () => ({
  ...jest.requireActual('../../approvals/wallet-approvals'),
  getWalletApprovals: () => mockPanel.approvals,
}));
jest.mock('../../approvals/approvals-document', () => ({
  ...jest.requireActual('../../approvals/approvals-document'),
  isApprovalsDocumentEnabled: () => true,
  getApprovalsDocuments: () => mockPanel.documents,
}));
jest.mock('../../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
jest.mock('../remote/signer', () => ({
  createRemoteBackend: () => {
    throw new Error('No phone here');
  },
}));

const { hashMessage } = require('ethers');
const { SESSION_ID, startSafeCore } = require('../../../../test/helpers/fake-safe-core');
const { fakeLedgerDevices, until } = require('../../../../test/helpers/fake-ledger-core');
const { createFakeNodeHid, inProcessHosts } = require('../../../../test/helpers/fake-node-hid');
const { ledgerVectors, ledgerVectorsRequired } = require('../../../../test/helpers/ledger-vectors');
const { referenceLedger } = require('../../../../test/helpers/ledger-reference-device');
const { HidDevice, HidHost } = require('../ledger/hid-device');
const { LedgerRelay } = require('../../core/ledger-relay');
const { safeMessageTypedData, safeTxTypedData } = require('../ledger/apdu-binding');
const { _internal } = require('../../core/vault-backend');
const { createWalletApprovals } = require('../../approvals/wallet-approvals');
const {
  coreSends: boardSends,
  confirmLedgerOwnerAgain,
  createSafeBoards,
} = require('../../approvals/safe-boards');
const coreSends = require('./core-sends');
const coreMessages = require('./core-messages');
const records = require('./approval-records');
const safeApprovals = require('./safe-approvals');
const pendingStore = require('./pending-store');
const signing = require('../signing-confirmation');
const kinds = require('../../../renderer/approvals/approvals-kinds.js');

const SAFE_INDEX = 5;
const LEDGER_INDEX = 1000000;
const SAFE = mockRecords[SAFE_INDEX].address;
const PATH = mockRecords[LEDGER_INDEX].path;
const ZERO = '0x' + '00'.repeat(20);
const PAGE = {
  origin: 'https://dapp.example',
  top_origin: 'https://dapp.example',
  frame: 0,
  navigation: 1,
};
// The SafeTx of ledger.json's `typed-safe-tx`, as fc-safe writes an entry's fields.
const SAFE_TX = Object.freeze({
  to: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  value: '1234567890123456789',
  data: '0x',
  operation: 0,
  baseGas: '0',
  gasPrice: '0',
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 3,
  safeTxGas: '0',
});
const SAFE_TX_HASH = records.safeTxHashOf(SAFE, 100, SAFE_TX);
const DEVICE_MS = 15_000;
const USER_MS = 300_000;
const SIGNATURE = '1b' + '11'.repeat(32) + '22'.repeat(32) + '9000';

const owner = (index, signed) => ({
  index,
  address: mockRecords[index].address,
  type: mockRecords[index].type,
  signed,
});
const board = (ledgerSigned = false) => ({
  safeIndex: SAFE_INDEX,
  chainId: 100,
  safeTxHash: SAFE_TX_HASH,
  threshold: 2,
  collected: ledgerSigned ? 1 : 0,
  owners: [owner(0, false), owner(LEDGER_INDEX, ledgerSigned)],
  executorIndex: 0,
  display: null,
  call: { to: SAFE_TX.to, value: SAFE_TX.value, data: SAFE_TX.data },
  createdAt: 1764300000000,
  status: 'awaiting',
});
const entryOf = (safeTx = SAFE_TX, overrides = {}) => ({
  chainId: 100,
  safeAddress: SAFE,
  safeTxData: { ...safeTx },
  safeTxHash: SAFE_TX_HASH,
  threshold: 2,
  signatures: [],
  createdAt: 1764300000000,
  coreProposal: { chainId: 100, safeAddress: SAFE, safeTxHash: SAFE_TX_HASH },
  ...overrides,
});
const recordApproval = () =>
  records.record(SAFE_INDEX, {
    address: SAFE,
    chainId: 100,
    safeTx: { ...SAFE_TX },
    safeTxHash: SAFE_TX_HASH,
  });

// A page's personal_sign for the Safe, and main's SafeMessage for it.
const MESSAGE_REQUEST = Object.freeze({
  method: 'personal_sign',
  params: ['0x48656c6c6f2c205361666521', SAFE],
});
const MESSAGE = safeMessageTypedData({
  safeAddress: SAFE,
  digest: hashMessage(Buffer.from('Hello, Safe!')),
});
const OTHER_MESSAGE = safeMessageTypedData({
  safeAddress: SAFE,
  digest: hashMessage('Something else'),
});

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const ticks = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

/** Main's own stream for a Safe parent: each APDU's hex (the hash-only one apart). */
function streamOf(method, params, bound) {
  const prepared = new LedgerRelay().prepare({
    method,
    params,
    path: PATH,
    typedData: bound.typedData,
    expectedHash: bound.hash,
  });
  if (!prepared.ok) throw new Error(`no stream: ${prepared.rule} ${prepared.reason}`);
  return {
    apdus: prepared.admission.slots.map((slot) => hex(slot.apdu)),
    hashOnly: hex(prepared.admission.hashOnlySlot.apdu),
    hashes: prepared.hashes,
  };
}
const txStream = (safeTx = SAFE_TX) =>
  streamOf(
    'safe.sign_owner',
    { safe: SAFE_INDEX, owner: LEDGER_INDEX, safe_tx_hash: SAFE_TX_HASH },
    safeTxTypedData({ safeAddress: SAFE, safeTx })
  );
const messageStream = (bound = MESSAGE) =>
  streamOf(
    'safe.message_sign',
    { safe: SAFE_INDEX, session: SESSION_ID, owner: LEDGER_INDEX },
    bound
  );

// The scripted core's world: the pending entry, the board's state, the
// SafeMessage session's hash, and the lane for a Ledger owner's request.
const world = {};

function resetWorld() {
  Object.assign(world, {
    entry: entryOf(),
    board: board(false),
    messageHash: MESSAGE.hash,
    messageCollected: 0,
    lane: null,
    replies: [],
    laneDone: null,
  });
}

function messageState() {
  return {
    safeIndex: SAFE_INDEX,
    kind: 'message',
    chainId: 100,
    hash: world.messageHash,
    threshold: 2,
    collected: world.messageCollected,
    owners: [owner(0, false), owner(LEDGER_INDEX, world.messageCollected > 0)],
    display: { method: 'personal_sign' },
    createdAt: 1764300000000,
    complete: false,
  };
}

function script(message, core) {
  const ledgerOwner = message.params?.owner === LEDGER_INDEX;
  switch (message.method) {
    case 'safe_pending.list':
      return { indices: world.entry ? [SAFE_INDEX] : [] };
    case 'safe_pending.get':
      return { entry: message.params.index === SAFE_INDEX ? world.entry : null };
    case 'safe.pending':
      return { states: world.entry ? [world.board] : [] };
    case 'safe.sign_owner':
      if (ledgerOwner && world.lane) return world.lane(message, core);
      return world.board;
    case 'safe.message_start':
      return { session: SESSION_ID, state: messageState() };
    case 'safe.message_sign':
      if (ledgerOwner && world.lane) return world.lane(message, core);
      return messageState();
    case 'safe.message_cancel':
      return {};
    default:
      return { error: { code: 'unknown_method', message: 'not scripted' } };
  }
}

const isUserApdu = (apdu) => apdu.startsWith('e00c');
const ledgerUnknown = {
  code: 'device_failed',
  message: 'Ledger device failed',
  data: { ledger: 'LEDGER_UNKNOWN' },
};

/**
 * The core's lane for a Ledger owner's request: each APDU of `apdus` in
 * turn, its `deadline_ms` the row's, each sent once main has answered the
 * last; a `6D00` main answered `hash_only: "shown"` goes on to `hashOnly`.
 * At the end `done()` answers the request; a refusal, a failure or another
 * status ends it LEDGER_UNKNOWN, as the core does.
 */
function lane(apdus, { done, hashOnly = null } = {}) {
  return (message, core) => {
    world.laneDone = (async () => {
      const queue = [...apdus];
      while (queue.length) {
        const apdu = queue.shift();
        const id = core.apdu(message.id, apdu, isUserApdu(apdu) ? USER_MS : DEVICE_MS);
        await until(() => core.raw(id), 'the reply to an APDU', 10_000);
        const read = core.reply(id);
        world.replies.push(read);
        const status = read?.answer ? hex(read.answer).slice(-4) : null;
        if (status === '6d00' && read.hashOnlyShown && hashOnly) {
          queue.splice(0, queue.length, hashOnly);
          continue;
        }
        if (status !== '9000') {
          core.fail(message.id, ledgerUnknown);
          return;
        }
      }
      core.answer(message.id, done());
    })();
    return undefined;
  };
}

let made = null;
let devices = null;

async function setup({
  device = fakeLedgerDevices({ respond: () => '9000' }),
  openDevice = null,
} = {}) {
  devices = device;
  made = await startSafeCore({
    log: { info() {}, warn() {}, error() {} },
    script,
    relay: { openDevice: openDevice ?? device.openDevice, log: require('../../logger') },
  });
  mockCore.made = made;
  return made.cores[0];
}

const core = () => made.cores[made.cores.length - 1];
/** Main's requests with a device's owner. */
const ledgerRequests = (method) =>
  core()
    .sent(method)
    .filter((m) => m.params.owner === LEDGER_INDEX);

/** The approvals document's panel for `wallet.safe_send`: approving, or as `decisions` say. */
function panel(decisions = []) {
  const prompts = [];
  const approvals = createWalletApprovals({
    walletPrompt: jest.fn(async (windowId, spec) => {
      prompts.push({ windowId, ...spec });
      return decisions.length ? decisions.shift() : { approve: true, choices: {} };
    }),
    chromeWindowOf: () => null,
    getDerivedWallets: async () => Object.values(mockRecords),
    chainName: () => 'Gnosis Chain',
    nativeSymbol: () => 'xDAI',
    checkFees: jest.fn(async () => null),
    checkAtApproval: jest.fn(async () => ({ askAgain: false })),
  });
  mockPanel.approvals = approvals;
  return { approvals, prompts };
}

/**
 * The wallet's board for the Safe in window 1 (safe-boards.js), its steps
 * the core's (`coreSends`, over core-sends.js), its "confirm again" main's
 * (`confirmLedgerOwnerAgain`): each board prompt answered by `decide(view,
 * n)`, a decision naming its prompt's handle (`h<n>`).
 */
function walletBoard(decide) {
  const shown = [];
  const transactions = () => ({
    getSafeSendState: (i) => coreSends.readState(i),
    signSafePending: (i, o, options) => coreSends.signOwner(i, o, options),
    executeSafePending: (i, options) => coreSends.execute(i, options),
    cancelSafeSend: (i, options) => coreSends.discard(i, options),
  });
  const boards = createSafeBoards({
    getDerivedWallets: async () => Object.values(mockRecords),
    sends: boardSends(transactions),
    messages: {},
    walletPrompt: async (_windowId, { view, choices }) => {
      shown.push(view);
      const raw = decide(view, shown.length);
      if (!raw) return { approve: false, choices: {}, handle: `h${shown.length}` };
      return { approve: true, choices: choices(raw), handle: `h${shown.length}` };
    },
    walletUnlock: async () => ({ closed: 'cancelled' }),
    confirmExecutorFee: async () => null,
    confirmSafeSend: confirmLedgerOwnerAgain,
    watchWindow: () => () => {},
  });
  return { boards, shown };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetWorld();
  coreSends._reset();
  records._reset();
  signing._reset();
  safeApprovals._reset();
  pendingStore._reset();
  _internal.reset();
  mockLedgerKind.kind = 'core';
  mockPanel.approvals = null;
  mockPanel.documents = null;
});

afterEach(async () => {
  if (!made) return;
  await world.laneDone;
  // No reply main wrote was one the core's lane wouldn't take.
  expect(core().faults).toEqual([]);
  await made.client.stop();
  made = null;
  mockCore.made = null;
});

describe("main's Safe binding: a Ledger owner's SafeTx", () => {
  test("the pending entry under the approval record: safe.sign_owner with the owner, the device sent main's stream byte for byte", async () => {
    await setup();
    recordApproval();
    const { apdus } = txStream();
    world.lane = lane(apdus, { done: () => (world.board = board(true)) });
    const state = await coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH });
    expect(state).toMatchObject({ collected: 1, safeTxHash: SAFE_TX_HASH });
    expect(ledgerRequests('safe.sign_owner').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', { safe: SAFE_INDEX, owner: LEDGER_INDEX, safe_tx_hash: SAFE_TX_HASH }],
    ]);
    expect(devices.bytes()).toEqual(apdus);
    expect(world.replies.every((r) => hex(r.answer) === '9000')).toBe(true);
    // Read from the core's entry before it was sent, and nothing minted.
    expect(core().methods()).not.toContain('approval.issue');
    expect(core().methods().indexOf('safe_pending.get')).toBeLessThan(
      core().methods().indexOf('safe.sign_owner')
    );
    expect(made.relay.stats()).toEqual({ parents: 0, open: false });
  });

  const FIELD_CHANGES = [
    ['to', '0x' + '77'.repeat(20)],
    ['value', '1234567890123456790'],
    ['data', '0x01'],
    ['operation', 1],
    ['safeTxGas', '1'],
    ['baseGas', '1'],
    ['gasPrice', '1'],
    ['gasToken', '0x' + '01'.repeat(20)],
    ['refundReceiver', '0x' + '01'.repeat(20)],
    ['nonce', 4],
  ];

  test.each(FIELD_CHANGES)(
    "the entry's %s changed under the record (its hash kept): refused before any APDU, nothing sent",
    async (field, value) => {
      await setup();
      recordApproval();
      world.entry = entryOf({ ...SAFE_TX, [field]: value });
      world.lane = lane(txStream().apdus, { done: () => board(true) });
      await expect(
        coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
      ).rejects.toThrow("doesn't match its hash");
      expect(ledgerRequests('safe.sign_owner')).toEqual([]);
      expect(devices.events).toEqual([]);
      // The record stays the user's approval of the SafeTx they saw.
      expect(records.recordFor(SAFE_INDEX).hash).toBe(SAFE_TX_HASH);
    }
  );

  test.each([
    ['the Safe', { safeAddress: '0x' + '44'.repeat(20) }],
    ['the chain', { chainId: 101 }],
  ])("the entry's %s changed: refused before any APDU, nothing sent", async (_name, overrides) => {
    await setup();
    recordApproval();
    world.entry = entryOf(SAFE_TX, overrides);
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toThrow("isn't the one approved");
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(devices.events).toEqual([]);
  });

  test('another SafeTx pending than the one the board named: SAFE_DISCARDED, unsent', async () => {
    await setup();
    recordApproval();
    const other = { ...SAFE_TX, nonce: 4 };
    world.entry = entryOf(other, { safeTxHash: records.safeTxHashOf(SAFE, 100, other) });
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(devices.events).toEqual([]);
  });

  test("one byte of the core's stream changed (another SafeTx's): refused payload before the device, shown as discarded or replaced", async () => {
    await setup();
    recordApproval();
    const ours = txStream().apdus;
    const theirs = txStream({ ...SAFE_TX, nonce: 4 }).apdus;
    const at = theirs.findIndex((apdu, k) => apdu !== ours[k]);
    expect(at).toBeGreaterThan(2);
    world.lane = lane(theirs, { done: () => board(true) });
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(world.replies.at(-1)).toEqual({ refused: 'payload' });
    expect(devices.bytes()).toEqual(ours.slice(0, at));
    expect(made.relay.stats()).toEqual({ parents: 0, open: false });
  });

  test("a record of another SafeTx binds none: the owner's turn asks for a new approval, unsent", async () => {
    await setup();
    records.record(SAFE_INDEX, {
      address: SAFE,
      chainId: 100,
      safeTx: { ...SAFE_TX, nonce: 2 },
      safeTxHash: records.safeTxHashOf(SAFE, 100, { ...SAFE_TX, nonce: 2 }),
    });
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toMatchObject({ code: 'SAFE_APPROVAL_NEEDED' });
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(devices.events).toEqual([]);
  });
});

/** The board's sweep and owner row: the Ledger picked first, then Reject. */
const pickLedgerThenReject = (view, n) =>
  n === 1 ? { action: 'sign', owner: LEDGER_INDEX } : null;

describe("confirm again with no record (the plan's point 6)", () => {
  test("approved, then main restarts (or an older build ran between): the owner's turn asks for a new approval before the device, nothing sent", async () => {
    await setup();
    recordApproval();
    // A restart: the records were in memory only.
    records._reset();
    world.lane = lane(txStream().apdus, { done: () => board(true) });
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toMatchObject({
      code: 'SAFE_APPROVAL_NEEDED',
      message: 'Confirm this transaction again before this Ledger signs it',
    });
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(devices.events).toEqual([]);
    expect(records.recordFor(SAFE_INDEX)).toBeNull();
  });

  test("after a restart: the board shows wallet.safe_send from the entry's fields, main records it on the approval, nothing minted, and the owner signs", async () => {
    await setup();
    // A restart: main holds no record.
    const { prompts } = panel();
    const { apdus } = txStream();
    world.lane = lane(apdus, { done: () => (world.board = board(true)) });
    const { boards, shown } = walletBoard(pickLedgerThenReject);
    expect(await boards.openWalletBoard(1, SAFE_INDEX)).toEqual({ outcome: 'parked' });

    // Confirmed again in window 1's panel, from the pending entry's fields.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ windowId: 1, kind: 'wallet.safe_send' });
    expect(prompts[0].view).toEqual({
      account: { index: SAFE_INDEX, name: 'Joint', address: SAFE, type: 'safe' },
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: SAFE_TX.to, value: SAFE_TX.value, data: '0x' },
      transfer: null,
      safeTx: { nonce: 3 },
    });
    const message = {
      handle: 'c'.repeat(64),
      revision: 1,
      guest: null,
      kind: prompts[0].kind,
      site: { key: 'freedom:wallet', label: 'Your wallet' },
      view: prompts[0].view,
    };
    expect(kinds.checkMessage(message).valid).toBe(true);
    // Recorded on that decision, nothing minted; then signed under it.
    expect(records.recordFor(SAFE_INDEX)).toEqual({
      address: SAFE,
      chainId: 100,
      hash: SAFE_TX_HASH,
    });
    expect(core().methods()).not.toContain('approval.issue');
    expect(ledgerRequests('safe.sign_owner')).toHaveLength(1);
    expect(devices.bytes()).toEqual(apdus);
    expect(shown.at(-1).owners.find((o) => o.index === LEDGER_INDEX).signed).toBe(true);
    expect(shown.at(-1).notes).toEqual([]);
  });

  test('the confirmation rejected: no record, nothing sent for the owner, its row noted', async () => {
    await setup();
    const { prompts } = panel([{ approve: false }]);
    world.lane = lane(txStream().apdus, { done: () => board(true) });
    const { boards, shown } = walletBoard(pickLedgerThenReject);
    expect(await boards.openWalletBoard(1, SAFE_INDEX)).toEqual({ outcome: 'parked' });
    expect(prompts).toHaveLength(1);
    expect(records.recordFor(SAFE_INDEX)).toBeNull();
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(devices.events).toEqual([]);
    expect(shown.at(-1).notes).toEqual([
      {
        owner: LEDGER_INDEX,
        note: 'failed',
        message: 'Confirm this transaction again before this Ledger signs it',
      },
    ]);
  });

  test("an entry whose fields don't hash to the core's hash is never shown or recorded", async () => {
    await setup();
    const { approvals, prompts } = panel();
    world.entry = entryOf({ ...SAFE_TX, value: '1' });
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toThrow("doesn't match its hash");
    await expect(
      coreSends.confirmAgain({
        approvals,
        windowId: 1,
        safeIndex: SAFE_INDEX,
        safeTxHash: SAFE_TX_HASH,
      })
    ).rejects.toThrow("doesn't match its hash");
    expect(prompts).toEqual([]);
    expect(records.recordFor(SAFE_INDEX)).toBeNull();
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
  });

  test('confirmed again while a step of the Safe runs: SAFE_BUSY, nothing shown', async () => {
    await setup();
    const { approvals, prompts } = panel();
    safeApprovals.beginStep(SAFE_INDEX);
    try {
      await expect(
        coreSends.confirmAgain({
          approvals,
          windowId: 1,
          safeIndex: SAFE_INDEX,
          safeTxHash: SAFE_TX_HASH,
        })
      ).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    } finally {
      safeApprovals.endStep(SAFE_INDEX);
    }
    expect(prompts).toEqual([]);
  });

  test("on the core no token is presented again: the board's token is burnt and refused", async () => {
    const sends = boardSends(() => ({ signSafePending: jest.fn() }));
    const discard = jest.spyOn(signing, 'discardConfirmation');
    await expect(
      sends.signConfirmed(SAFE_INDEX, LEDGER_INDEX, SAFE_TX_HASH, 'a-token')
    ).rejects.toThrow('needs no new confirmation');
    expect(discard).toHaveBeenCalledWith('a-token');
    expect(sends.call(SAFE_INDEX, SAFE_TX_HASH)).toEqual({ safeTxHash: SAFE_TX_HASH });
  });
});

describe('the hash-only warning on the board', () => {
  test("a Ledger's 6D00 held until the board's owner row shows the warning; no E0 0C 00 00 reaches the device before", async () => {
    const { apdus, hashOnly, hashes } = txStream();
    // A Nano S: 6D00 to the operation's first E0 1A.
    let fields = true;
    await setup({
      device: fakeLedgerDevices({
        respond: (apdu) => {
          const text = hex(apdu);
          if (text.startsWith('e01a') && fields) {
            fields = false;
            return '6d00';
          }
          return text.startsWith('e00c0000') ? SIGNATURE : '9000';
        },
      }),
    });
    recordApproval();
    const shownOn = [];
    let report = null;
    mockPanel.documents = {
      presentHashOnly: (windowId, target, given, signal) => {
        shownOn.push({ windowId, target, given, signal });
        return new Promise((resolve) => {
          report = resolve;
        });
      },
    };
    world.lane = lane(apdus.slice(0, 3), { hashOnly, done: () => (world.board = board(true)) });
    const { boards } = walletBoard(pickLedgerThenReject);
    const outcome = boards.openWalletBoard(1, SAFE_INDEX);

    await until(() => shownOn.length === 1, 'the warning on the board');
    // On the board's own owner row: its window, the owner picked, its prompt's handle.
    expect(shownOn[0].windowId).toBe(1);
    expect(shownOn[0].target).toEqual({ windowId: 1, owner: LEDGER_INDEX, handle: 'h1' });
    expect(shownOn[0].given).toEqual(hashes);
    // Held: the 6D00 unanswered, and nothing signing on the device.
    await ticks(30);
    const sixD = [...core().asks.entries()].find(([, ask]) =>
      ask.params.apdu.startsWith('e01a')
    )[0];
    expect(core().raw(sixD)).toBeNull();
    expect(devices.bytes().some((apdu) => apdu.startsWith('e00c'))).toBe(false);

    report(true);
    expect(await outcome).toEqual({ outcome: 'parked' });
    expect(core().reply(sixD)).toMatchObject({ hashOnlyShown: true });
    expect(devices.bytes()).toEqual([...apdus.slice(0, 3), hashOnly]);
    expect(hashOnly.slice(10 + 42)).toBe(
      hashes.domainSeparator.slice(2) + hashes.structHash.slice(2)
    );
  });
});

describe("a SafeMessage bound to the page's request", () => {
  async function startSession() {
    return coreMessages.start({
      safeIndex: SAFE_INDEX,
      request: MESSAGE_REQUEST,
      display: { method: 'personal_sign' },
      requester: null,
      authorization: { token: 'tok', handle: 'hdl' },
      page: PAGE,
    });
  }

  test("main's own SafeMessage for the page's request: safe.message_sign with the owner, the device sent its stream byte for byte", async () => {
    await setup();
    const state = await startSession();
    const { apdus } = messageStream();
    world.lane = lane(apdus, { done: () => ((world.messageCollected = 1), messageState()) });
    const signed = await coreMessages.sign(SAFE_INDEX, LEDGER_INDEX, state.token);
    expect(signed).toMatchObject({ collected: 1, hash: MESSAGE.hash });
    const [sent] = ledgerRequests('safe.message_sign');
    expect([sent.context.caller, sent.params]).toEqual([
      'shell',
      { safe: SAFE_INDEX, session: SESSION_ID, owner: LEDGER_INDEX },
    ]);
    expect(devices.bytes()).toEqual(apdus);
    // The session's ID never left main.
    expect(JSON.stringify(signed)).not.toContain(SESSION_ID);
  });

  test("a session whose hash isn't main's SafeMessage for the page's request: refused, nothing sent", async () => {
    await setup();
    world.messageHash = OTHER_MESSAGE.hash;
    const state = await startSession();
    world.lane = lane(messageStream(OTHER_MESSAGE).apdus, { done: () => messageState() });
    await expect(coreMessages.sign(SAFE_INDEX, LEDGER_INDEX, state.token)).rejects.toThrow(
      "isn't the page's"
    );
    expect(ledgerRequests('safe.message_sign')).toEqual([]);
    expect(devices.events).toEqual([]);
  });

  test("the core's stream of another digest: refused payload before the device", async () => {
    await setup();
    const state = await startSession();
    const ours = messageStream().apdus;
    const theirs = messageStream(OTHER_MESSAGE).apdus;
    const at = theirs.findIndex((apdu, k) => apdu !== ours[k]);
    world.lane = lane(theirs, { done: () => messageState() });
    await expect(coreMessages.sign(SAFE_INDEX, LEDGER_INDEX, state.token)).rejects.toMatchObject({
      code: 'LEDGER_UNKNOWN',
    });
    expect(world.replies.at(-1)).toEqual({ refused: 'payload' });
    expect(devices.bytes()).toEqual(ours.slice(0, at));
  });
});

describe("the switch (the plan's point 4)", () => {
  test('on the JS Ledger backend a Ledger owner is refused, unsent, its SafeTx and its SafeMessage', async () => {
    mockLedgerKind.kind = 'js';
    await setup();
    recordApproval();
    await expect(
      coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
    ).rejects.toMatchObject({
      code: 'SAFE_UNSUPPORTED',
      message: "A Ledger can't sign for a multi-owner account here yet",
    });
    const state = await coreMessages.start({
      safeIndex: SAFE_INDEX,
      request: MESSAGE_REQUEST,
      requester: null,
      authorization: { token: 'tok', handle: 'hdl' },
      page: PAGE,
    });
    await expect(coreMessages.sign(SAFE_INDEX, LEDGER_INDEX, state.token)).rejects.toMatchObject({
      code: 'SAFE_UNSUPPORTED',
    });
    expect(core().methods()).not.toContain('safe_pending.get');
    expect(ledgerRequests('safe.sign_owner')).toEqual([]);
    expect(ledgerRequests('safe.message_sign')).toEqual([]);
    expect(devices.events).toEqual([]);
  });

  test("LDG-3's point-11 path is refused on the core's Safe backend: no Safe approval goes to sign.typed_data", () => {
    const { getSigner } = require('../signers');
    expect(() => getSigner(LEDGER_INDEX, { safe: { id: 'f'.repeat(32), page: null } })).toThrow(
      "signs through the Safe's own steps"
    );
    // A Ledger account's own signature is as before.
    expect(() => getSigner(LEDGER_INDEX, {})).not.toThrow();
  });
});

describe("a Ledger owner's watchdog: 7:15 before its first APDU, then each APDU's", () => {
  async function advance(ms) {
    jest.advanceTimersByTime(ms);
    await ticks();
  }

  /**
   * The step's outcome once the core is killed: its read of the entry
   * after the step waits for the next core, so the clock moves on.
   */
  async function outcomeOf(promise) {
    let done = false;
    let value;
    promise.then((v) => {
      done = true;
      value = v;
    });
    for (let i = 0; i < 120 && !done; i += 1) await advance(1_000);
    if (!done) throw new Error('the step never ended');
    return value;
  }

  /** Waits on the pipes alone (no timer runs on the fake clock meanwhile). */
  async function settled(predicate, what) {
    for (let i = 0; i < 5_000; i += 1) {
      if (predicate()) return;
      await new Promise(setImmediate);
    }
    throw new Error(`never: ${what}`);
  }

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(async () => {
    world.laneDone = null;
    const stopped = made?.client.stop();
    await ticks();
    jest.advanceTimersByTime(3_000);
    await stopped;
    made = null;
    mockCore.made = null;
    jest.useRealTimers();
  });

  /** A Ledger owner's safe.sign_owner sent and held by the core: its request. */
  async function held() {
    await setup();
    recordApproval();
    let request = null;
    world.lane = (message) => {
      request = message;
      return undefined;
    };
    const signing = coreSends
      .signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH })
      .catch((e) => e);
    await settled(() => request, "the Ledger owner's safe.sign_owner");
    return { request, signing };
  }

  test('with no APDU: not killed before 7 minutes and 15 s, killed then', async () => {
    const { signing } = await held();
    const first = core();
    await advance(7 * 60_000 + 15_000 - 1);
    expect(first.killed).toBeNull();
    await advance(1);
    expect(first.killed).toBe('SIGKILL');
    expect(await outcomeOf(signing)).toMatchObject({ code: 'core_unavailable' });
  });

  test("each APDU and each answer resets it to the APDU's deadline_ms + 15 s, past 7:15", async () => {
    const { request, signing } = await held();
    const first = core();
    const { apdus } = txStream();
    await advance(7 * 60_000);
    expect(first.killed).toBeNull();
    // The first APDU at 7:00, answered at once: 30 s from then.
    const one = first.apdu(request.id, apdus[0], DEVICE_MS);
    await settled(() => first.raw(one), 'the first reply');
    await advance(30_000 - 1);
    expect(first.killed).toBeNull();
    // The next APDU at 7:29.999: 30 s more.
    const two = first.apdu(request.id, apdus[1], DEVICE_MS);
    await settled(() => first.raw(two), 'the second reply');
    await advance(30_000 - 1);
    expect(first.killed).toBeNull();
    await advance(1);
    expect(first.killed).toBe('SIGKILL');
    expect(await outcomeOf(signing)).toMatchObject({ code: 'core_unavailable' });
    expect(devices.bytes()).toEqual(apdus.slice(0, 2));
  });
});

// The reference's Ledger (ledger.json's recording of `typed-safe-tx`) behind
// main's HID layer, over a fake node-hid.
const vectors = ledgerVectors('ledger.json');
const grammar = ledgerVectors('ledger-grammar.json');
if (ledgerVectorsRequired && (!vectors || !grammar)) {
  throw new Error('FREEDOM_CORE_LEDGER_VECTORS names no ledger.json and ledger-grammar.json');
}
const describeIfVectors = vectors && grammar ? describe : describe.skip;

describeIfVectors("the reference's Ledger, ledger.json's typed-safe-tx", () => {
  let host = null;

  afterEach(() => {
    host?.kill();
    host = null;
  });

  test("the core's honest stream for the entry's SafeTx is main's, and the reference's device answers it as recorded", async () => {
    const fake = createFakeNodeHid();
    host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
    const reference = referenceLedger(fake, vectors);
    const recorded = reference.play('typed-safe-tx');
    expect(recorded.record).toEqual({ path: PATH, address: mockRecords[LEDGER_INDEX].address });
    expect(recorded.request.expected_hash).toBe(SAFE_TX_HASH);
    const spy = fakeLedgerDevices();
    await setup({ device: spy, openDevice: () => new HidDevice({ host }) });
    recordApproval();
    const honest = grammar.honest.find((h) => h.case === 'typed-safe-tx').apdus;
    expect(txStream().apdus).toEqual(honest);
    world.lane = lane(honest, { done: () => (world.board = board(true)) });
    const state = await coreSends.signOwner(SAFE_INDEX, LEDGER_INDEX, { safeTxHash: SAFE_TX_HASH });
    expect(state).toMatchObject({ collected: 1 });
    expect(reference.asked).toEqual(honest);
    expect(reference.unrecorded).toEqual([]);
    expect(fake.violations).toEqual([]);
    const signature = recorded.exchanges.at(-1).answer;
    expect(hex(world.replies.at(-1).answer)).toBe(signature);
  });
});
