/**
 * The hash-only warning's surfaces (hash-only-warning.js; freedom-core
 * design 0016, "Typed data on the device (Q23)"; the LDG-3 plan's points 12
 * and 19; LDG-3's PR 11), on the core's Ledger backend.
 *
 * - **Where it shows:** the approvals document's waiting state for the
 *   approval a request names (a prompt's handle, a board prompt's handle and
 *   owner, every one matching), else the chrome's notice over the tab;
 *   under FREEDOM_APPROVALS_DOCUMENT=0 the notice always. A notice's report counts only from its window's own
 *   chrome, for that notice, while the window shows; its Cancel is main's
 *   own cancel (point 19); it goes when the operation ends.
 * - **The hash-only warning comes first** (LDG-3's row), end to end through
 *   main: the real signer factory (wallet/signers.js), page-devices.js and
 *   safe-boards.js, the real approvals documents (approvals-document.js,
 *   over fake views), a real CoreClient against a scripted core whose
 *   reader is cored 0.30.0's (test/helpers/fake-ledger-core.js), main's
 *   relay, and a device that answers `6D00` to the first `E0 1A` (a Nano
 *   S), behind it, recording every byte (the spy). For a prompt, a standing
 *   rule (the notice), a Safe board's SafeTx and SafeMessage, and under the
 *   rollback: with the surface's report held, main sends no answer to the
 *   `6D00` and no `E0 0C 00 00` reaches the device; then the answer carries
 *   `hash_only: "shown"`, and the two hashes the warning shows are the
 *   APDU's. A hidden window and a slow paint give LEDGER_UNKNOWN with
 *   nothing signed. Two boards sharing a Ledger owner in one window, two
 *   prompts, and a request no approval names beside a board: a request's
 *   warning never shows in another's waiting state, and no report of
 *   another's releases it. (x402's case is in x402/sign-flow-ledger.test.js.)
 */

jest.mock(
  'electron',
  () => ({
    app: { isPackaged: false },
    BrowserWindow: {
      fromId: (id) => mockWindows.get(id) ?? null,
      fromWebContents: (contents) => [...mockWindows.values()].find((w) => w.webContents === contents) ?? null,
      getFocusedWindow: () => null,
    },
  }),
  { virtual: true }
);
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('./ledger-backend-kind', () => ({
  ledgerBackendKind: () => 'core',
  readLedgerBackendKind: () => 'core',
}));
const mockRuntime = { started: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockRuntime.started?.client ?? null,
  getLedgerRelay: () => mockRuntime.started?.relay ?? null,
}));
const mockRecords = new Map();
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords.get(index) ?? null,
  recordLedgerAddressCheck: () => {},
  recordRemoteAddressCheck: () => {},
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
jest.mock('../remote/signer', () => ({
  createRemoteBackend: () => {
    throw new Error('No phone here');
  },
}));
const mockApprovals = { enabled: true, docs: null };
jest.mock('../../approvals/approvals-document', () => ({
  ...jest.requireActual('../../approvals/approvals-document'),
  isApprovalsDocumentEnabled: () => mockApprovals.enabled,
  getApprovalsDocuments: () => mockApprovals.docs,
}));

const { EventEmitter } = require('events');
const path = require('path');
const { pathToFileURL } = require('url');
const { TypedDataEncoder, Wallet, Signature, verifyTypedData } = require('ethers');
const log = require('../../logger');
const { getSigner } = require('../signers');
const { createDeviceSigning } = require('../../page/page-devices');
const { createSafeBoards } = require('../../approvals/safe-boards');
const { LedgerRelay } = require('../../core/ledger-relay');
const { runInWindow } = require('../../windows/request-window');
const {
  createApprovalsDocuments,
  CHANNELS: DOC,
  APPROVALS_URL,
  INPUT_DELAY_MS,
} = require('../../approvals/approvals-document');
const {
  CHANNELS,
  createHashOnlyWarnings,
  getHashOnlyWarnings,
  withHashOnlyTarget,
  currentHashOnlyTarget,
} = require('./hash-only-warning');
const { fakeLedgerDevices, startLedgerCore, until } = require('../../../../test/helpers/fake-ledger-core');
const { APP_ANSWER } = require('../../../../test/helpers/fake-node-hid');

const mockWindows = new Map();

// An Anvil/Hardhat-default test key, well known, never funded on mainnet.
const deviceWallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const LEDGER_INDEX = 1000000;
const SAFE_INDEX = 1000005;
const OTHER_SAFE_INDEX = 1000006;
const PATH = "44'/60'/0'/0/0";
const RECORD = { index: LEDGER_INDEX, name: 'My Nano S', address: deviceWallet.address, type: 'ledger', path: PATH };
const PAGE = { origin: 'https://dapp.example', top_origin: 'https://dapp.example', frame: 0, navigation: 4 };
const SITE = 'https://dapp.example';
const TAB = 31;
const TOKEN = 'T'.repeat(43);
const DOMAIN = '0x' + '1a'.repeat(32);
const STRUCT = '0x' + '2b'.repeat(32);
const OK = Buffer.from('9000', 'hex');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const flush = async (turns = 5) => {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
};

const MAIL = {
  domain: { name: 'Ether Mail', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
  types: {
    Person: [
      { name: 'name', type: 'string' },
      { name: 'wallet', type: 'address' },
    ],
    Mail: [
      { name: 'from', type: 'Person' },
      { name: 'to', type: 'Person' },
      { name: 'contents', type: 'string' },
    ],
  },
  primaryType: 'Mail',
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};
const MAIL_HASH = TypedDataEncoder.hash(MAIL.domain, MAIL.types, MAIL.message);
const ZERO = '0x' + '00'.repeat(20);
const SAFE_DOMAIN = { chainId: 100, verifyingContract: '0x' + 'aa'.repeat(20) };
const SAFE_TX = {
  types: {
    EIP712Domain: [
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  domain: SAFE_DOMAIN,
  primaryType: 'SafeTx',
  message: {
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    value: '1000',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: '3',
  },
};
const SAFE_MESSAGE = {
  types: {
    EIP712Domain: SAFE_TX.types.EIP712Domain,
    SafeMessage: [{ name: 'message', type: 'bytes' }],
  },
  domain: SAFE_DOMAIN,
  primaryType: 'SafeMessage',
  message: { message: '0x' + 'cd'.repeat(32) },
};
const withoutDomain = (types) => {
  const rest = { ...types };
  delete rest.EIP712Domain;
  return rest;
};
/** The two hashes the device shows for typed data (main's binding computes them with ethers). */
const hashesOf = (data) => ({
  domainSeparator: TypedDataEncoder.hashDomain(data.domain),
  structHash: TypedDataEncoder.from(withoutDomain(data.types)).hash(data.message),
});

// ---------------------------------------------------------------------------
// Unit: where the warning shows, and the notice's reports

describe('where the warning shows', () => {
  function env({ enabled = true, waiting = null, visible = true } = {}) {
    const sent = [];
    const chrome = { isDestroyed: () => false, send: (channel, message) => sent.push([channel, message]) };
    const documents = { presentHashOnly: jest.fn(() => waiting) };
    let next = 0;
    const warnings = createHashOnlyWarnings({
      documentEnabled: () => enabled,
      documents: () => documents,
      chromeOf: (windowId) => (windowId === 1 ? chrome : null),
      windowShows: () => visible,
      focusedWindowId: () => null,
      windowOfSender: (contents) => (contents === chrome ? 1 : null),
      randomId: () => (next++).toString(16).padStart(32, '0'),
      log: { warn: () => {} },
    });
    return { warnings, sent, chrome, documents };
  }
  const notices = (sent) => sent.filter(([channel]) => channel === CHANNELS.NOTICE).map(([, m]) => m);

  test("a prompt's handle, or a board prompt's handle and owner, goes to the approvals document when it waits on that approval", async () => {
    const shown = Promise.resolve(true);
    const { warnings, sent, documents } = env({ waiting: shown });
    const life = new AbortController();
    const args = { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal };
    await expect(warnings.present({ windowId: 1, handle: 'h', guest: TAB }, args)).resolves.toBe(true);
    await expect(warnings.present({ windowId: 1, handle: 'b', owner: 4 }, args)).resolves.toBe(true);
    expect(documents.presentHashOnly.mock.calls.map(([w, target, hashes]) => [w, target, hashes])).toEqual([
      [1, { windowId: 1, handle: 'h', guest: TAB }, { domainSeparator: DOMAIN, structHash: STRUCT }],
      [1, { windowId: 1, handle: 'b', owner: 4 }, { domainSeparator: DOMAIN, structHash: STRUCT }],
    ]);
    expect(notices(sent)).toEqual([]);
  });

  test('no approval waiting there, no handle (an owner alone, or an x402 payment\'s tab), or FREEDOM_APPROVALS_DOCUMENT=0: the notice over the tab', async () => {
    for (const [options, target] of [
      [{ waiting: null }, { windowId: 1, handle: 'h', guest: TAB, site: SITE }],
      [{ waiting: Promise.resolve(true) }, { windowId: 1, guest: TAB, site: SITE }],
      [{ waiting: Promise.resolve(true) }, { windowId: 1, owner: 4, guest: TAB, site: SITE }],
      [{ enabled: false, waiting: Promise.resolve(true) }, { windowId: 1, handle: 'h', guest: TAB, site: SITE }],
    ]) {
      const { warnings, sent, documents } = env(options);
      const life = new AbortController();
      const pending = warnings.present(target, { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal });
      const [message] = notices(sent);
      expect(message).toEqual({ id: '0'.repeat(32), site: SITE, domainSeparator: DOMAIN, structHash: STRUCT });
      if (options.enabled === false || !target.handle) expect(documents.presentHashOnly).not.toHaveBeenCalled();
      life.abort();
      await expect(pending).resolves.toBe(false);
    }
  });

  test("a notice's report counts only from its window's chrome, for it, while the window shows; it goes with the operation", async () => {
    const { warnings, sent, chrome } = env();
    const life = new AbortController();
    const pending = warnings.present({ windowId: 1, guest: TAB }, { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal });
    const [{ id }] = notices(sent);
    expect(warnings.noticeShown({ sender: {} }, { id })).toBe(false);
    expect(warnings.noticeShown({ sender: chrome }, { id: 'f'.repeat(32) })).toBe(false);
    expect(warnings.noticeShown({ sender: chrome }, { id, more: 1 })).toBe(false);
    expect(warnings.state()).toEqual([{ id, windowId: 1, reported: false }]);
    expect(warnings.noticeShown({ sender: chrome }, { id })).toBe(true);
    await expect(pending).resolves.toBe(true);
    // Up until the operation ends, then taken down.
    expect(warnings.state()).toEqual([{ id, windowId: 1, reported: true }]);
    life.abort();
    expect(notices(sent).at(-1)).toEqual({ id, closed: true });
    expect(warnings.state()).toEqual([]);
    expect(warnings.noticeShown({ sender: chrome }, { id })).toBe(false);
  });

  test('a hidden or minimized window: the report counts for nothing', async () => {
    const { warnings, sent, chrome } = env({ visible: false });
    const life = new AbortController();
    const pending = warnings.present({ windowId: 1 }, { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal });
    const [{ id }] = notices(sent);
    expect(warnings.noticeShown({ sender: chrome }, { id })).toBe(false);
    life.abort();
    await expect(pending).resolves.toBe(false);
  });

  test("its Cancel (point 19) is main's own cancel, from the window's own chrome only", async () => {
    const { warnings, sent, chrome } = env();
    const life = new AbortController();
    const cancel = jest.fn(() => life.abort());
    const pending = warnings.present(
      { windowId: 1, guest: TAB },
      { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal, cancel }
    );
    const [{ id }] = notices(sent);
    expect(warnings.noticeCancel({ sender: {} }, { id })).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(warnings.noticeCancel({ sender: chrome }, { id })).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe(false);
    expect(notices(sent).at(-1)).toEqual({ id, closed: true });
  });

  test('no window, no chrome, no signal or bad hashes: false, nothing shown', async () => {
    const { warnings, sent } = env();
    const life = new AbortController();
    const args = { domainSeparator: DOMAIN, structHash: STRUCT, signal: life.signal };
    await expect(warnings.present({}, args)).resolves.toBe(false);
    await expect(warnings.present({ windowId: 2 }, args)).resolves.toBe(false);
    await expect(warnings.present({ windowId: 1 }, { ...args, signal: null })).resolves.toBe(false);
    await expect(warnings.present({ windowId: 1 }, { ...args, structHash: STRUCT.toUpperCase() })).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  test("the target adds to the caller's, and takes the request's window", () => {
    expect(currentHashOnlyTarget()).toEqual({});
    runInWindow(3, () =>
      withHashOnlyTarget({ guest: TAB, site: SITE }, () =>
        withHashOnlyTarget({ handle: 'h', guest: 'nope' }, () => {
          expect(currentHashOnlyTarget()).toEqual({ windowId: 3, guest: TAB, site: SITE, handle: 'h' });
          expect(currentHashOnlyTarget({ site: 'https://other.example' })).toMatchObject({ site: 'https://other.example' });
        })
      )
    );
  });

  test("an approval's identity comes whole from the entry point that names it: never one's handle with another's owner", () => {
    withHashOnlyTarget({ guest: TAB, site: SITE, handle: 'page' }, () => {
      // A board's owner row, its decision naming no handle: the page's handle goes.
      withHashOnlyTarget({ windowId: 2, owner: 7, handle: undefined }, () => {
        expect(currentHashOnlyTarget()).toEqual({ windowId: 2, guest: TAB, site: SITE, owner: 7 });
      });
      withHashOnlyTarget({ windowId: 2, owner: 7, handle: 'board' }, () => {
        expect(currentHashOnlyTarget()).toEqual({ windowId: 2, guest: TAB, site: SITE, owner: 7, handle: 'board' });
        // A prompt's handle inside it: the board's owner goes.
        withHashOnlyTarget({ handle: 'prompt' }, () => {
          expect(currentHashOnlyTarget()).toEqual({ windowId: 2, guest: TAB, site: SITE, handle: 'prompt' });
        });
      });
      // A target naming no approval keeps the caller's.
      withHashOnlyTarget({ windowId: 2 }, () => {
        expect(currentHashOnlyTarget()).toEqual({ windowId: 2, guest: TAB, site: SITE, handle: 'page' });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// End to end: the hash-only warning comes first

/** A Nano S: answers the address check and the app, `6D00` to the first E0 1A, and signs the hash-only APDU. */
function nanoS(apdu) {
  const text = hex(apdu);
  if (text.startsWith('e002')) {
    const key = Buffer.from(deviceWallet.signingKey.publicKey.slice(2), 'hex');
    const address = Buffer.from(deviceWallet.address.slice(2), 'ascii');
    return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([address.length]), address, OK]);
  }
  if (text.startsWith('b001')) return Buffer.from(APP_ANSWER, 'hex');
  if (text.startsWith('e01a')) return Buffer.from('6d00', 'hex');
  if (text.startsWith('e00c0000')) {
    // Signs the two hashes it was sent: the EIP-712 digest over them.
    const tail = apdu.subarray(apdu.length - 64);
    const digest = '0x' + hex(Buffer.concat([Buffer.from('1901', 'hex'), tail]));
    const sig = deviceWallet.signingKey.sign(require('ethers').keccak256(digest));
    return Buffer.concat([
      Buffer.from([27 + sig.yParity]),
      Buffer.from(sig.r.slice(2), 'hex'),
      Buffer.from(sig.s.slice(2), 'hex'),
      OK,
    ]);
  }
  return OK;
}

const deviceFailed = (ledger) => Object.assign(new Error('Ledger device failed'), { code: 'device_failed', data: { ledger } });

/** The scripted core's `sign.typed_data` (cored 0.30.0's lane): the stream, the Q23 branch, the signature. */
let lane;
async function playTyped(message) {
  const { id, params } = message;
  const fc = mockRuntime.started.core();
  const { admission } = new LedgerRelay({ log }).prepare({ method: 'sign.typed_data', params, path: params.key.path });
  const slots = [...admission.slots];
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    const ask = fc.apdu(id, hex(slot.apdu), slot.waits ? 300_000 : 15_000);
    if (slot === admission.firstTypeName) lane.sixD = ask;
    await until(() => fc.raw(ask), 'the reply', 20_000);
    const reply = fc.reply(ask);
    if (fc.cancels().includes(id)) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    if (!reply || reply.refused || reply.failed) throw deviceFailed('LEDGER_UNKNOWN');
    const status = hex(reply.answer.subarray(-2));
    if (slot === admission.firstTypeName && status === '6d00') {
      // Q23: on to the two hashes only once main showed the warning.
      if (!reply.hashOnlyShown) throw deviceFailed('LEDGER_UNKNOWN');
      lane.hashOnlyApdu = hex(admission.hashOnlySlot.apdu);
      slots.splice(k + 1, slots.length, admission.hashOnlySlot);
      continue;
    }
    if (status !== '9000') throw deviceFailed('LEDGER_UNKNOWN');
    if (k < slots.length - 1) continue;
    const answer = reply.answer;
    const signature = Signature.from({
      r: '0x' + hex(answer.subarray(1, 33)),
      s: '0x' + hex(answer.subarray(33, 65)),
      yParity: answer[0] - 27,
    }).serialized;
    return { signature };
  }
  throw new Error('the stream ended without a signature');
}

async function startCore(deps = {}) {
  const devices = fakeLedgerDevices({ respond: (apdu) => nanoS(apdu) });
  const started = await startLedgerCore({ log, devices, deps });
  mockRuntime.started = started;
  started.core().serve('sign.typed_data', playTyped);
  // Main's own typed data is hashed by the core first (signers.js).
  started.core().serve('typed_data.hash', ({ params: { typed_data: data } }) => ({
    hash: TypedDataEncoder.hash(data.domain, withoutDomain(data.types), data.message),
  }));
  return started;
}

/** Real timers in the relay, and a short wait for the report: for the hidden window and the slow paint. */
const realTimers = (hashOnlyWaitMs) => ({
  hashOnlyWaitMs,
  now: () => Date.now(),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
});

const reached = () => mockRuntime.started.devices.bytes();
const hashOnlyReached = () => reached().filter((apdu) => apdu.startsWith('e00c0000'));
const signingReached = () => reached().some((apdu) => apdu.startsWith('e00c'));
const signingCount = () => reached().filter((apdu) => apdu.startsWith('e00c')).length;

// --- The window: a chrome and an approvals document over fake views ------

const CHROME_URL = pathToFileURL(path.resolve(__dirname, '..', '..', '..', 'renderer', 'index.html')).href;
let nextContentsId = 700;

class FakeContents extends EventEmitter {
  constructor(url) {
    super();
    this.id = nextContentsId++;
    this.sent = [];
    this.mainFrame = { url, detached: false };
  }
  isDestroyed() {
    return false;
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
  getURL() {
    return this.mainFrame.url;
  }
  focus() {}
  isFocused() {
    return false;
  }
  setWindowOpenHandler() {}
  loadFile() {
    return Promise.resolve();
  }
  reload() {}
  close() {}
}

class FakeWindow extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.webContents = new FakeContents(CHROME_URL);
    this.contentView = { addChildView: () => {} };
    this.shows = true;
    this.minimized = false;
  }
  isDestroyed() {
    return false;
  }
  isVisible() {
    return this.shows;
  }
  isMinimized() {
    return this.minimized;
  }
  getContentSize() {
    return [1200, 800];
  }
  getMinimumSize() {
    return [0, 0];
  }
  setMinimumSize() {}
}

let clock = 0;
let decisions;

/** Window 1, its chrome and its approvals document, attached and ready. */
function openWindow() {
  const window = new FakeWindow(1);
  mockWindows.set(1, window);
  const ses = {
    protocol: { handle: () => {} },
    webRequest: { onBeforeRequest: () => {} },
  };
  const docs = createApprovalsDocuments({
    WebContentsView: () =>
      class {
        constructor() {
          this.webContents = new FakeContents(APPROVALS_URL);
        }
        setBounds() {}
        setVisible() {}
      },
    sessionFor: () => ses,
    // A decision is answered once what it started is done, as page-requests.js answers it.
    decide: (_windowId, payload) => decisions.shift()(payload),
    chromeWindowOf: () => null,
    readFile: async () => Buffer.from(''),
    now: () => clock,
    defer: (fn) => fn(),
    log: { warn: () => {} },
  });
  mockApprovals.docs = docs;
  const record = docs.attach(window);
  const doc = record.contents;
  docs.ready({ sender: doc, senderFrame: doc.mainFrame });
  return { window, docs, doc, chrome: window.webContents };
}

let handleCount = 0;
const nextHandle = () => (++handleCount).toString(16).padStart(64, '0');

/** Shows `prompt` in the document and approves it with `choices` once the input delay passed. */
function approveInDocument(win, prompt, choices) {
  const { docs, doc } = win;
  docs.send(1, DOC.PROMPT, prompt);
  const revision = doc.sent.filter(([channel]) => channel === DOC.PROMPT).at(-1)[1].revision;
  docs.shown({ sender: doc, senderFrame: doc.mainFrame }, { handle: prompt.handle, revision });
  clock += INPUT_DELAY_MS;
  return docs.decide({ sender: doc, senderFrame: doc.mainFrame }, { handle: prompt.handle, approve: true, ...(choices ? { choices } : {}) });
}

const docWarnings = (win) => win.doc.sent.filter(([channel]) => channel === DOC.HASH_ONLY).map(([, m]) => m);
const chromeNotices = (win) => win.chrome.sent.filter(([channel]) => channel === CHANNELS.NOTICE).map(([, m]) => m);
const reportDocument = (win, { handle, warning }) =>
  win.docs.hashOnlyShown({ sender: win.doc, senderFrame: win.doc.mainFrame }, { handle, warning });
const reportNotice = (win, { id }) => getHashOnlyWarnings().noticeShown({ sender: win.chrome }, { id });

/**
 * The warning first: once it is up (`up()` gives what it shows), the held
 * `6D00` has no answer and no E0 0C 00 00 has reached the device (none
 * since this operation's start), however long the report takes; then the
 * report, and the lane goes on.
 */
async function heldThenReported(up, report) {
  const signedBefore = signingCount();
  await until(() => up(), 'the warning up', 10_000);
  const shown = up();
  // Held: give the lane every chance to move on its own.
  await flush(20);
  const fc = mockRuntime.started.core();
  expect(lane.sixD).toBeDefined();
  expect(fc.raw(lane.sixD)).toBeNull();
  expect(signingCount()).toBe(signedBefore);
  expect(report(shown)).toEqual(expect.anything());
  await until(() => fc.raw(lane.sixD), 'the answer to the 6D00');
  expect(fc.raw(lane.sixD).result).toEqual({ answer: '6d00', hash_only: 'shown' });
  return shown;
}

/** The hashes a warning showed are the hash-only APDU's: its last 64 bytes. */
function expectHashesOfApdu(shown, data) {
  const [apdu] = hashOnlyReached();
  expect(apdu).toBe(lane.hashOnlyApdu);
  expect({ domainSeparator: shown.domainSeparator, structHash: shown.structHash }).toEqual(hashesOf(data));
  expect(apdu.endsWith(shown.domainSeparator.slice(2) + shown.structHash.slice(2))).toBe(true);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRecords.clear();
  mockRecords.set(LEDGER_INDEX, RECORD);
  mockWindows.clear();
  mockApprovals.enabled = true;
  mockApprovals.docs = null;
  lane = {};
  decisions = [];
  clock = 0;
});

afterEach(async () => {
  if (mockRuntime.started) {
    expect(mockRuntime.started.core().faults).toEqual([]);
    await mockRuntime.started.client.stop();
    mockRuntime.started = null;
  }
});

describe('the hash-only warning comes first', () => {
  /** A page's `{ device }` for the Mail typed data on the approve's handle. */
  const typedDevice = (handle) => ({
    type: 'ledger',
    kind: 'sign-typed-data',
    account: LEDGER_INDEX,
    payload: { typed_data: MAIL, primary_type: 'Mail', chain_id: '1' },
    expectedHash: MAIL_HASH,
    handle,
    token: TOKEN,
  });
  const pageContext = {
    params: [deviceWallet.address, MAIL],
    nameHolds: async () => true,
    holdsKey: () => true,
    pageContext: () => ({ agent: false }),
  };
  /** As page-requests.js runs a page's request: in its tab's window, with its tab and site. */
  const asPageRequest = (fn) => runInWindow(1, () => withHashOnlyTarget({ guest: TAB, site: SITE }, fn));
  const signing = () =>
    createDeviceSigning({ walletList: async () => [RECORD], getSigner, discardToken: () => {} });

  test("a prompt: in the approvals document's waiting state for the approved handle", async () => {
    await startCore();
    const win = openWindow();
    const handle = nextHandle();
    let answered;
    decisions.push(() => new Promise((resolve) => (answered = resolve)));
    const decided = approveInDocument(win, {
      handle,
      guest: TAB,
      kind: 'eth.sign',
      site: { key: SITE, label: SITE },
      view: { account: { index: LEDGER_INDEX, name: 'My Nano S', address: deviceWallet.address, type: 'ledger' } },
    });
    expect(win.docs.state()[1].waiting).toBe('ledger');

    const signed = asPageRequest(() => signing().sign(pageContext, typedDevice(handle), PAGE));
    const shown = await heldThenReported(
      () => docWarnings(win).find((m) => m.warning !== null),
      (message) => reportDocument(win, message)
    );
    const { result } = await signed;
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, result)).toBe(deviceWallet.address);
    expect(shown.handle).toBe(handle);
    expectHashesOfApdu(shown, MAIL);
    // In the document, never over the tab; taken down as the operation ended.
    expect(chromeNotices(win)).toEqual([]);
    expect(docWarnings(win).at(-1)).toEqual({ handle, warning: null });
    answered({ ok: true });
    await decided;
  });

  test('a standing rule: no approval waits on the device, so the notice over the tab', async () => {
    await startCore();
    const win = openWindow();
    const signed = asPageRequest(() =>
      getSigner(LEDGER_INDEX, { page: PAGE, standing: { paused: false }, chainId: 1 }).signTypedData(MAIL)
    );
    const shown = await heldThenReported(
      () => chromeNotices(win).find((m) => !m.closed),
      (message) => reportNotice(win, message)
    );
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, await signed)).toBe(deviceWallet.address);
    expect(shown.site).toBe(SITE);
    expectHashesOfApdu(shown, MAIL);
    expect(docWarnings(win)).toEqual([]);
    expect(chromeNotices(win).at(-1)).toEqual({ id: shown.id, closed: true });
    const [request] = mockRuntime.started.core().requests('sign.typed_data');
    expect(request.params.authorization).toEqual({ standing: { paused: false } });
  });

  test('under FREEDOM_APPROVALS_DOCUMENT=0 a prompt\'s warning is the notice over the tab', async () => {
    mockApprovals.enabled = false;
    await startCore();
    const win = openWindow();
    const signed = asPageRequest(() => signing().sign(pageContext, typedDevice(nextHandle()), PAGE));
    const shown = await heldThenReported(
      () => chromeNotices(win).find((m) => !m.closed),
      (message) => reportNotice(win, message)
    );
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, (await signed).result)).toBe(deviceWallet.address);
    expectHashesOfApdu(shown, MAIL);
    expect(docWarnings(win)).toEqual([]);
  });

  /**
   * A Safe board in window 1's document (safe-boards.js `runBoard`), its
   * one owner the Ledger, threshold 1: the user picks the owner's row and
   * approves; main signs `data` with the owner's Safe approval, once `gate`
   * settles (the device operation queued until then).
   */
  function safeBoard(win, data, { gate = null, safeIndex = SAFE_INDEX } = {}) {
    let signed = false;
    const state = () => ({
      safeTxHash: '0x' + '5a'.repeat(32),
      threshold: 1,
      collected: signed ? 1 : 0,
      owners: [{ index: LEDGER_INDEX, address: deviceWallet.address, type: 'ledger', signed }],
      chainId: 100,
      executorIndex: null,
      status: 'pending',
      display: { method: 'eth_signTypedData_v4' },
    });
    const signatures = [];
    const sign = async (_safeIndex, owner) => {
      if (owner === undefined) return;
      await gate;
      signatures.push(await getSigner(owner, { safe: { id: 'f'.repeat(32), page: null } }).signTypedData(data));
      signed = true;
    };
    // Each turn's prompt in the document; its decision (naming its handle,
    // as page-requests.js names a board's) answered once the board moved on.
    const ask = (kind, guest) => ({ view, released }) =>
      new Promise((resolve) => {
        const handle = nextHandle();
        decisions.push((payload) => {
          resolve({ approve: payload.approve, choices: payload.choices, handle });
          return released.then(() => ({ ok: true }));
        });
        win.docs.send(1, DOC.PROMPT, { handle, guest, kind, site: { key: SITE, label: SITE }, view });
      });
    const boards = createSafeBoards({
      getDerivedWallets: async () => [RECORD, { index: safeIndex, name: 'Team Safe', address: '0x' + 'aa'.repeat(20) }],
      sends: {
        state,
        tx: () => ({ to: SAFE_TX.message.to, value: '1000', data: '0x' }),
        sign,
        execute: async () => ({ status: 'executed', safeTxHash: state().safeTxHash, executed: { hash: '0x' + 'e'.repeat(64) } }),
      },
      messages: { state, sign: (safeIndex, owner) => sign(safeIndex, owner) },
      walletPrompt: (_windowId, spec) => ask('wallet.safe_board', null)(spec),
      walletUnlock: async () => ({ closed: 'cancelled' }),
      confirmExecutorFee: async () => null,
      watchWindow: () => () => {},
    });
    return { boards, ask, signatures };
  }

  /** The `count`th prompt shown, a board: the Ledger owner's row picked and approved in the document. */
  async function pickOwner(win, count = 1) {
    const prompts = () => win.doc.sent.filter(([channel]) => channel === DOC.PROMPT);
    await until(() => prompts().length >= count, 'the board shown');
    const shown = prompts().at(-1)[1];
    const revision = shown.revision;
    win.docs.shown({ sender: win.doc, senderFrame: win.doc.mainFrame }, { handle: shown.handle, revision });
    clock += INPUT_DELAY_MS;
    const decided = win.docs.decide(
      { sender: win.doc, senderFrame: win.doc.mainFrame },
      { handle: shown.handle, approve: true, choices: { action: 'sign', owner: LEDGER_INDEX } }
    );
    expect(win.docs.state()[1].waiting).toBe('ledger');
    return { handle: shown.handle, decided };
  }

  test("a Safe board's SafeTx (the wallet's board): in the owner row's waiting state", async () => {
    await startCore();
    const win = openWindow();
    const { boards, signatures } = safeBoard(win, SAFE_TX);
    const outcome = boards.openWalletBoard(1, SAFE_INDEX);
    const picked = await pickOwner(win);
    const shown = await heldThenReported(
      () => docWarnings(win).find((m) => m.warning !== null),
      (message) => reportDocument(win, message)
    );
    expect(await outcome).toMatchObject({ outcome: 'executed' });
    expect(await picked.decided).toEqual({ ok: true });
    expect(shown.handle).toBe(picked.handle);
    expectHashesOfApdu(shown, SAFE_TX);
    expect(verifyTypedData(SAFE_DOMAIN, withoutDomain(SAFE_TX.types), SAFE_TX.message, signatures[0])).toBe(
      deviceWallet.address
    );
    expect(chromeNotices(win)).toEqual([]);
    // As sign.typed_data with the Safe approval, never safe.sign_owner (point 11).
    const [request] = mockRuntime.started.core().requests('sign.typed_data');
    expect(request.params.authorization).toEqual({ safe: 'f'.repeat(32) });
  });

  test("a Safe board's SafeMessage (a page's board): in the owner row's waiting state", async () => {
    await startCore();
    const win = openWindow();
    const { boards, ask, signatures } = safeBoard(win, SAFE_MESSAGE);
    const context = { prompt: ask('eth.safe_message', TAB), requester: { window: 1, guest: TAB, key: SITE } };
    const outcome = asPageRequest(() => boards.runMessageBoard(context, { safeIndex: SAFE_INDEX, token: 'session' }));
    const picked = await pickOwner(win);
    const shown = await heldThenReported(
      () => docWarnings(win).find((m) => m.warning !== null),
      (message) => reportDocument(win, message)
    );
    expect(await outcome).toEqual({ outcome: 'complete' });
    expect(shown.handle).toBe(picked.handle);
    expectHashesOfApdu(shown, SAFE_MESSAGE);
    expect(
      verifyTypedData(SAFE_DOMAIN, withoutDomain(SAFE_MESSAGE.types), SAFE_MESSAGE.message, signatures[0])
    ).toBe(deviceWallet.address);
    expect(chromeNotices(win)).toEqual([]);
  });

  /** Held: the 6D00 unanswered and nothing signing on the device, after every chance to move. */
  async function expectHeld() {
    await flush(20);
    expect(lane.sixD).toBeDefined();
    expect(mockRuntime.started.core().raw(lane.sixD)).toBeNull();
    expect(signingReached()).toBe(false);
  }

  /** Every report the document could send, for these handles: none counts. */
  function expectNoDocumentReportCounts(win, handles) {
    for (let warning = 0; warning < 4; warning += 1) {
      for (const handle of handles) {
        expect(reportDocument(win, { handle, warning })).toEqual({ ok: false, reason: 'not-shown' });
      }
    }
  }

  // The crossing (Codex, #1364): Safe A's and Safe B's boards in one window
  // share the Ledger owner. A is approved while its device operation is
  // queued; B's board takes the panel and is approved for the same owner;
  // then A's device answers 6D00.
  test("two queued boards in one window sharing a Ledger owner: A's warning never shows in B's board, and B's report never releases A", async () => {
    await startCore();
    const win = openWindow();
    let openA;
    let openB;
    const a = safeBoard(win, SAFE_MESSAGE, { gate: new Promise((resolve) => (openA = resolve)) });
    const b = safeBoard(win, SAFE_TX, {
      gate: new Promise((resolve) => (openB = resolve)),
      safeIndex: OTHER_SAFE_INDEX,
    });
    const context = { prompt: a.ask('eth.safe_message', TAB), requester: { window: 1, guest: TAB, key: SITE } };
    const outcomeA = asPageRequest(() => a.boards.runMessageBoard(context, { safeIndex: SAFE_INDEX, token: 'session' }));
    const pickedA = await pickOwner(win, 1);
    // B's board takes the panel (A's prompt gone from it, A's operation
    // queued), and the user approves it for the same owner.
    const outcomeB = b.boards.openWalletBoard(1, OTHER_SAFE_INDEX);
    const pickedB = await pickOwner(win, 2);
    expect(pickedB.handle).not.toBe(pickedA.handle);

    // A's operation reaches the device: 6D00. B waits with the same owner,
    // but it is not A's approval: A's warning goes to A's own notice.
    openA();
    await until(() => chromeNotices(win).some((m) => !m.closed), "A's notice up", 10_000);
    const [notice] = chromeNotices(win);
    expect(notice).toMatchObject({ site: SITE, ...hashesOf(SAFE_MESSAGE) });
    await expectHeld();
    // Nothing of A's in B's board, and no report of B's document releases A.
    expect(docWarnings(win)).toEqual([]);
    expectNoDocumentReportCounts(win, [pickedA.handle, pickedB.handle]);
    await expectHeld();

    // A's own surface reports: A goes on, with A's hashes.
    expect(reportNotice(win, notice)).toBe(true);
    const fc = mockRuntime.started.core();
    await until(() => fc.raw(lane.sixD), 'the answer to the 6D00');
    expect(fc.raw(lane.sixD).result).toEqual({ answer: '6d00', hash_only: 'shown' });
    expect(await outcomeA).toEqual({ outcome: 'complete' });
    expectHashesOfApdu(notice, SAFE_MESSAGE);
    expect(verifyTypedData(SAFE_DOMAIN, withoutDomain(SAFE_MESSAGE.types), SAFE_MESSAGE.message, a.signatures[0])).toBe(
      deviceWallet.address
    );
    expect(await pickedA.decided).toEqual({ ok: true });
    expect(docWarnings(win)).toEqual([]);

    // Then B's own operation: its warning in B's board, for B's handle.
    openB();
    const shownB = await heldThenReported(
      () => docWarnings(win).find((m) => m.warning !== null),
      (message) => reportDocument(win, message)
    );
    expect(shownB).toMatchObject({ handle: pickedB.handle, ...hashesOf(SAFE_TX) });
    expect(await outcomeB).toMatchObject({ outcome: 'executed' });
    expect(await pickedB.decided).toEqual({ ok: true });
    expect(chromeNotices(win).filter((m) => !m.closed)).toEqual([notice]);
  });

  test("two prompts in one window: A's warning never shows in B's waiting state; with no report of A's own, LEDGER_UNKNOWN, nothing signed", async () => {
    await startCore(realTimers(300));
    const win = openWindow();
    const view = { account: { index: LEDGER_INDEX, name: 'My Nano S', address: deviceWallet.address, type: 'ledger' } };
    const site = { key: SITE, label: SITE };
    const handleA = nextHandle();
    const handleB = nextHandle();
    const answers = [];
    decisions.push(() => new Promise((resolve) => answers.push(resolve)));
    const decidedA = approveInDocument(win, { handle: handleA, guest: TAB, kind: 'eth.sign', site, view });
    // B's prompt takes the panel and is approved: B waits on the same Ledger.
    decisions.push(() => new Promise((resolve) => answers.push(resolve)));
    const decidedB = approveInDocument(win, { handle: handleB, guest: TAB + 1, kind: 'eth.sign', site, view });
    expect(win.docs.state()[1].waiting).toBe('ledger');

    // A's operation reaches the device.
    const signed = asPageRequest(() => signing().sign(pageContext, typedDevice(handleA), PAGE));
    await until(() => chromeNotices(win).some((m) => !m.closed), "A's notice up", 10_000);
    const [notice] = chromeNotices(win);
    expect(docWarnings(win)).toEqual([]);
    expectNoDocumentReportCounts(win, [handleA, handleB]);
    // Nobody reports A's notice: main stops waiting, and nothing is signed.
    const answer = await signed;
    expect(answer.error).toMatchObject({ code: -32603 });
    expect(mockRuntime.started.core().raw(lane.sixD).result).toEqual({ answer: '6d00' });
    expect(signingReached()).toBe(false);
    expect(chromeNotices(win).at(-1)).toEqual({ id: notice.id, closed: true });
    expect(docWarnings(win)).toEqual([]);
    for (const resolve of answers) resolve({ ok: true });
    await decidedA;
    await decidedB;
  });

  test("a request no approval names (a standing rule's; x402's target is the same, its tab and site) beside a board waiting on the same Ledger: the notice, and the board's reports never release it", async () => {
    await startCore();
    const win = openWindow();
    let openB;
    const b = safeBoard(win, SAFE_TX, { gate: new Promise((resolve) => (openB = resolve)) });
    const outcomeB = b.boards.openWalletBoard(1, SAFE_INDEX);
    const pickedB = await pickOwner(win);

    const signed = asPageRequest(() =>
      getSigner(LEDGER_INDEX, { page: PAGE, standing: { paused: false }, chainId: 1 }).signTypedData(MAIL)
    );
    await until(() => chromeNotices(win).some((m) => !m.closed), 'the notice up', 10_000);
    const [notice] = chromeNotices(win);
    expect(notice).toMatchObject({ site: SITE, ...hashesOf(MAIL) });
    await expectHeld();
    expect(docWarnings(win)).toEqual([]);
    expectNoDocumentReportCounts(win, [pickedB.handle]);
    await expectHeld();
    expect(reportNotice(win, notice)).toBe(true);
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, await signed)).toBe(deviceWallet.address);
    expectHashesOfApdu(notice, MAIL);

    openB();
    const shownB = await heldThenReported(
      () => docWarnings(win).find((m) => m.warning !== null),
      (message) => reportDocument(win, message)
    );
    expect(shownB).toMatchObject({ handle: pickedB.handle, ...hashesOf(SAFE_TX) });
    expect(await outcomeB).toMatchObject({ outcome: 'executed' });
    expect(await pickedB.decided).toEqual({ ok: true });
  });

  test('a hidden window: its report counts for nothing, LEDGER_UNKNOWN, nothing signed', async () => {
    await startCore(realTimers(300));
    const win = openWindow();
    win.window.shows = false;
    const signed = asPageRequest(() =>
      getSigner(LEDGER_INDEX, { page: PAGE, standing: { paused: false }, chainId: 1 }).signTypedData(MAIL)
    );
    await until(() => chromeNotices(win).some((m) => !m.closed), 'the notice up');
    const [notice] = chromeNotices(win);
    expect(reportNotice(win, notice)).toBe(false);
    await expect(signed).rejects.toMatchObject({ code: 'LEDGER_UNKNOWN' });
    expect(mockRuntime.started.core().raw(lane.sixD).result).toEqual({ answer: '6d00' });
    expect(signingReached()).toBe(false);
    expect(chromeNotices(win).at(-1)).toEqual({ id: notice.id, closed: true });
  });

  test('a slow paint: a report after the wait counts for nothing, LEDGER_UNKNOWN, nothing signed', async () => {
    await startCore(realTimers(300));
    const win = openWindow();
    const handle = nextHandle();
    let answered;
    decisions.push(() => new Promise((resolve) => (answered = resolve)));
    const decided = approveInDocument(win, {
      handle,
      guest: TAB,
      kind: 'eth.sign',
      site: { key: SITE, label: SITE },
      view: { account: { index: LEDGER_INDEX, name: 'My Nano S', address: deviceWallet.address, type: 'ledger' } },
    });
    const signed = asPageRequest(() => signing().sign(pageContext, typedDevice(handle), PAGE));
    await until(() => docWarnings(win).some((m) => m.warning !== null), 'the warning up');
    const [warning] = docWarnings(win);
    const answer = await signed;
    expect(answer.error).toMatchObject({ code: -32603 });
    expect(mockRuntime.started.core().raw(lane.sixD).result).toEqual({ answer: '6d00' });
    // The paint lands too late: taken down already, it counts for nothing.
    expect(docWarnings(win).at(-1)).toEqual({ handle, warning: null });
    expect(reportDocument(win, warning)).toEqual({ ok: false, reason: 'not-shown' });
    expect(signingReached()).toBe(false);
    answered({ ok: true });
    await decided;
  });

  test("the notice's Cancel (point 19): the request cancelled, the core told, nothing signed", async () => {
    await startCore();
    const win = openWindow();
    const signed = asPageRequest(() =>
      getSigner(LEDGER_INDEX, { page: PAGE, standing: { paused: false }, chainId: 1 }).signTypedData(MAIL)
    );
    await until(() => chromeNotices(win).some((m) => !m.closed), 'the notice up');
    const [notice] = chromeNotices(win);
    expect(getHashOnlyWarnings().noticeCancel({ sender: win.chrome }, { id: notice.id })).toBe(true);
    await expect(signed).rejects.toMatchObject({ code: 'cancelled' });
    const [request] = mockRuntime.started.core().requests('sign.typed_data');
    expect(mockRuntime.started.core().cancels()).toEqual([request.id]);
    expect(signingReached()).toBe(false);
    expect(chromeNotices(win).at(-1)).toEqual({ id: notice.id, closed: true });
  });
});
