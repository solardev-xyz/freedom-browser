/**
 * The wallet's own Safe sends on the core's Safe backend (core-sends.js,
 * routed from safe-transactions.js; freedom-core design 0016, SAFE-3's PR
 * 4a), against a scripted core that reads each `safe.*` request as
 * cored-v0.32.0 does (test/helpers/fake-safe-core.js), through the real
 * vault backend, CoreClient and signing confirmations:
 * - a send is prepared by the core, approved in the approvals document with
 *   main's view of the core's SafeTx ("Safe transaction #N"), minted in
 *   design 0016's form under `shell` and proposed with its token; the
 *   chrome's call must be the prepared one, and nothing mints the legacy
 *   form, spends a token through `approval.spend` or writes the store;
 * - the board is `safe.pending`'s; owners sign through `safe.sign_owner`
 *   (the sweep, or one vault owner; a Ledger owner refused, unsent, until
 *   PR 8); a discard is `safe.discard`;
 * - the execution (PR 4b) and a site's send (PR 7) are refused, nothing
 *   sent; and the hello still declares no `safe3`.
 */

const { startSafeCore } = require('../../../../test/helpers/fake-safe-core');
const kinds = require('../../../renderer/approvals/approvals-kinds.js');
const core = require('../../../renderer/approvals/approvals-core.js');

jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => require('os').tmpdir() },
}));
jest.mock('./safe-backend-kind', () => ({
  safeBackendKind: () => 'core',
  readSafeBackendKind: () => 'core',
}));
const mockCore = { client: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockCore.client,
  getLedgerRelay: () => null,
}));

const SAFE = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const OWNERS = ['0x' + '0a'.repeat(20), '0x' + '0b'.repeat(20), '0x' + '0c'.repeat(20)];
const TO = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const SAFE_TX_HASH = '0x' + 'cd'.repeat(32);
const OTHER_HASH = '0x' + 'ef'.repeat(32);

const mockRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  1: { index: 1, name: 'Second', address: OWNERS[1], type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: OWNERS[2], type: 'ledger', path: "44'/60'/0'/0/0" },
  5: { index: 5, name: 'Joint', address: SAFE, type: 'safe', owners: [0, 1, 2], threshold: 2, deployed: { 100: { verified: true } } },
};
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords[index] ?? null,
  getDerivedWallets: async () => Object.values(mockRecords),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// Main's read-only copy of the core's store (the SAFE-3 plan's point 3):
// read again after each step.
jest.mock('./pending-store', () => {
  // Its descriptors, so that `ready` (a getter, which loads) isn't read here.
  const actual = jest.requireActual('./pending-store');
  const mocked = Object.defineProperties({}, Object.getOwnPropertyDescriptors(actual));
  mocked.refreshPending = jest.fn(async () => {});
  return mocked;
});
// Today's protocol-kit path: never on the core.
jest.mock('./safe-executor', () => {
  const never = () => {
    throw new Error("main's own Safe path ran on the core");
  };
  return {
    buildSafeTransaction: never,
    collectOwnerSignature: never,
    execTransaction: never,
    withdrawExecutionSite: never,
    pickDefaultExecutor: never,
  };
});
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => {
    throw new Error('a Safe read outside the core');
  },
}));

const transactions = require('./safe-transactions');
const coreSends = require('./core-sends');
const safeApprovals = require('./safe-approvals');
const pendingStore = require('./pending-store');
const signing = require('../signing-confirmation');
const { _internal } = require('../../core/vault-backend');
const { createWalletApprovals } = require('../../approvals/wallet-approvals');

const SAFE_TX = Object.freeze({
  to: TO,
  value: '1000',
  data: '0x',
  operation: 0,
  baseGas: '0',
  gasPrice: '0',
  gasToken: ZERO,
  refundReceiver: ZERO,
  nonce: 7,
  safeTxGas: '0',
});
const DISPLAY = { asset: null, toAddress: TO, amount: '1000', symbol: 'xDAI', decimals: 18, formattedAmount: '0.000000000000001' };
const owner = (index, signed) => ({ index, address: OWNERS[index], type: mockRecords[index].type, signed });
const BOARD = Object.freeze({
  safeIndex: 5,
  chainId: 100,
  safeTxHash: SAFE_TX_HASH,
  threshold: 2,
  collected: 1,
  owners: [owner(0, true), owner(1, false), owner(2, false)],
  executorIndex: 0,
  display: DISPLAY,
  call: { to: TO, value: '1000', data: '0x' },
  createdAt: 1764300000000,
  status: 'awaiting',
});
const REQUEST = { tx: { to: TO, value: '1000', data: '0x' }, chainId: 100 };

/** A core that answers each method as `answers` says (a value or `(message) => value`), else as below. */
function scripted(answers = {}) {
  let minted = 0;
  const defaults = {
    'safe.prepare': { safe_tx: SAFE_TX, safe_tx_hash: SAFE_TX_HASH, view: { primaryType: 'SafeTx' } },
    'approval.issue': () => ({ token: `token-${(minted += 1)}`, expires_in_ms: 120000 }),
    'approval.discard': {},
    'safe.propose': BOARD,
    'safe.pending': { states: [BOARD] },
    'safe.sign_owner': { ...BOARD, collected: 2, owners: [owner(0, true), owner(1, true), owner(2, false)] },
    'safe.discard': {},
    'safe_pending.get': null,
  };
  return (message) => {
    const answer = Object.hasOwn(answers, message.method) ? answers[message.method] : defaults[message.method];
    if (answer === undefined) return { error: { code: 'unknown_method', message: 'not scripted' } };
    return typeof answer === 'function' ? answer(message) : answer;
  };
}

// A burnt token's `approval.discard` goes unawaited: given time to arrive.
const arrived = () => new Promise((resolve) => setTimeout(resolve, 20));

const refusal = (safe, message = 'refused') => ({ error: { code: 'invalid_argument', message, data: { safe } } });

let made = null;
let fake = null;

async function setup(answers) {
  made = await startSafeCore({ log: { info() {}, warn() {}, error() {} }, script: scripted(answers) });
  mockCore.client = made.client;
  fake = made.cores[0];
  return fake;
}

/** The approvals document's panel, approving (or as `decisions` say). */
function panel(decisions = []) {
  const prompts = [];
  const approvals = createWalletApprovals({
    walletPrompt: jest.fn(async (windowId, spec) => {
      prompts.push({ windowId, ...spec });
      return decisions.length ? decisions.shift() : { approve: true, choices: {} };
    }),
    chromeWindowOf: (contents) => (contents?.id === 501 ? 1 : null),
    getDerivedWallets: async () => Object.values(mockRecords),
    chainName: () => 'Gnosis Chain',
    nativeSymbol: () => 'xDAI',
    checkFees: jest.fn(async () => null),
    checkAtApproval: jest.fn(async () => ({ askAgain: false })),
  });
  return { approvals, prompts };
}

const CHROME = { id: 501 };
const confirm = (approvals, request = REQUEST) =>
  transactions.confirmSafeSend({ sender: CHROME, safeIndex: 5, request, approvals });
const propose = (token, overrides = {}) =>
  transactions.proposeSafeSend({ safeIndex: 5, tx: REQUEST.tx, chainId: 100, display: DISPLAY, authorization: { confirmation: token }, ...overrides });

/** Every request main sent the core, but the hello's and the store reads. */
const sent = () => fake.requests.map((m) => ({ method: m.method, caller: m.context?.caller, params: m.params }));
const methods = () => fake.methods().filter((m) => m !== 'safe_pending.get');

beforeEach(() => {
  coreSends._reset();
  signing._reset();
  safeApprovals._reset();
  _internal.reset();
  pendingStore.refreshPending.mockClear();
});

afterEach(async () => {
  await made?.client.stop();
  made = null;
  mockCore.client = null;
});

describe("the wallet's own send: prepared, approved, minted, proposed", () => {
  test("the core's SafeTx, approved with main's view of it, its design 0016 token proposed under shell", async () => {
    await setup();
    const { approvals, prompts } = panel();
    const confirmed = await confirm(approvals);
    expect(confirmed).toMatchObject({ approved: true, token: 'token-1' });

    // Prepared first, as main's own, with the call the chrome composed.
    expect(sent()[0]).toEqual({
      method: 'safe.prepare',
      caller: 'shell',
      params: { safe: 5, chain_id: 100, tx: { to: TO, value: '1000', data: '0x' } },
    });
    // The panel shows the core's SafeTx: its call and its nonce.
    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    expect(prompt.kind).toBe('wallet.safe_send');
    expect(prompt.view).toEqual({
      account: { index: 5, name: 'Joint', address: SAFE, type: 'safe' },
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: TO, value: '1000', data: '0x' },
      transfer: null,
      safeTx: { nonce: 7 },
    });
    const message = { handle: 'c'.repeat(64), revision: 1, guest: null, kind: prompt.kind, site: { key: 'freedom:wallet', label: 'Your wallet' }, view: prompt.view };
    expect(kinds.checkMessage(message).valid).toBe(true);
    // Minted in design 0016's form (D6), under shell, on the approval.
    expect(sent()[1]).toEqual({
      method: 'approval.issue',
      caller: 'shell',
      params: {
        kind: 'safe-send',
        account: 5,
        payload: {
          safe: SAFE.toLowerCase(),
          chain_id: '100',
          safe_tx: { ...SAFE_TX, to: TO.toLowerCase() },
          safe_tx_hash: SAFE_TX_HASH,
        },
      },
    });

    const state = await propose(confirmed.token);
    expect(state).toEqual(BOARD);
    expect(sent()[2]).toEqual({
      method: 'safe.propose',
      caller: 'shell',
      params: { safe: 5, safe_tx_hash: SAFE_TX_HASH, authorization: { token: 'token-1' }, display: DISPLAY },
    });
    expect(methods()).toEqual(['safe.prepare', 'approval.issue', 'safe.propose']);
    expect(pendingStore.refreshPending).toHaveBeenCalledWith(5);
    // The board as the core answered it, kept for the document's board.
    expect(coreSends.cachedState(5)).toEqual(BOARD);
    // The reservation is given up: the next send can reserve.
    safeApprovals.reserveSend(5).release();
  });

  test('the approvals document off: minted on the chrome\'s confirmation, nothing asked', async () => {
    await setup();
    const confirmed = await confirm(null);
    expect(confirmed).toMatchObject({ approved: true, token: 'token-1' });
    expect(methods()).toEqual(['safe.prepare', 'approval.issue']);
    await propose(confirmed.token);
    expect(methods()).toEqual(['safe.prepare', 'approval.issue', 'safe.propose']);
  });

  test('a rejection mints nothing, and holds no SafeTx', async () => {
    await setup();
    const { approvals } = panel([{ approve: false, choices: {} }]);
    expect(await confirm(approvals)).toEqual({ approved: false, error: 'User rejected the request', code: 'USER_REJECTED' });
    expect(methods()).toEqual(['safe.prepare']);
  });

  test.each([
    ['unverified', 'SAFE_UNVERIFIED'],
    ['changed', 'SAFE_CHANGED'],
    ['not_deployed', 'SAFE_NOT_DEPLOYED'],
    ['unsupported', 'SAFE_UNSUPPORTED'],
  ])("the core's refusal to prepare (%s) keeps its code: nothing asked or minted", async (safe, code) => {
    await setup({ 'safe.prepare': refusal(safe, "Freedom couldn't verify this Safe") });
    const { approvals, prompts } = panel();
    await expect(confirm(approvals)).rejects.toMatchObject({ code });
    expect(prompts).toHaveLength(0);
    expect(methods()).toEqual(['safe.prepare']);
  });

  test('a SafeTx for another call than the one composed, or not Freedom\'s, is refused: nothing asked or minted', async () => {
    await setup({ 'safe.prepare': { safe_tx: { ...SAFE_TX, value: '2000' }, safe_tx_hash: SAFE_TX_HASH, view: {} } });
    const { approvals, prompts } = panel();
    await expect(confirm(approvals)).rejects.toThrow('another transaction than the one composed');
    await made.client.stop();
    await setup({ 'safe.prepare': { safe_tx: { ...SAFE_TX, operation: 1 }, safe_tx_hash: SAFE_TX_HASH, view: {} } });
    await expect(confirm(approvals)).rejects.toThrow('Invalid operation');
    expect(prompts).toHaveLength(0);
    expect(methods()).toEqual(['safe.prepare']);
  });

  test("the chrome's call is checked before the core is asked", async () => {
    await setup();
    await expect(confirm(null, { tx: { to: 'nope', value: '1' }, chainId: 100 })).rejects.toThrow('Invalid to');
    await expect(confirm(null, { tx: { to: TO, value: '-1' }, chainId: 100 })).rejects.toThrow('Invalid value');
    expect(methods()).toEqual([]);
  });

  describe("a proposal main refuses: the token burnt, nothing proposed", () => {
    test.each([
      ['no token', () => propose(undefined), 'no confirmation token'],
      ['a token main minted no SafeTx for', () => propose('token-unknown'), 'unknown or already used confirmation'],
      ['another Safe', (t) => propose(t, { safeIndex: 6 }), 'unknown or already used confirmation'],
      ['another call', (t) => propose(t, { tx: { ...REQUEST.tx, value: '1001' } }), 'request differs from what was confirmed'],
      ['another chain', (t) => propose(t, { chainId: 1 }), 'request differs from what was confirmed'],
      ['the chrome\'s auto-approve claim', (t) => propose(t, { authorization: { confirmation: t, autoApprove: true } }), "main reads a page's rules itself"],
    ])('%s', async (name, run, reason) => {
      await setup();
      const { token } = await confirm(null);
      await expect(run(token)).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', message: `Signing was not confirmed: ${reason}` });
      expect(methods()).not.toContain('safe.propose');
      if (reason === 'no confirmation token') return;
      await arrived();
      expect(fake.sent('approval.discard').length).toBeGreaterThan(0);
      if (reason === 'unknown or already used confirmation' && name.startsWith('a token')) return;
      // A token is presented once: the same one is refused afterwards.
      await expect(propose(token)).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
      expect(methods()).not.toContain('safe.propose');
    });
  });

  test("the core's refusal to propose keeps its code; PR 6's seam hears the drop; the reservation is given up", async () => {
    await setup({ 'safe.propose': refusal('SAFE_PENDING_EXISTS', 'A transaction is already waiting for signatures') });
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped');
    const decided = jest.spyOn(coreSends.approvalRecords, 'decided');
    const { token } = await confirm(null);
    expect(decided).toHaveBeenCalledWith(5, { chainId: 100, safeTx: SAFE_TX, safeTxHash: SAFE_TX_HASH });
    await expect(propose(token)).rejects.toMatchObject({ code: 'SAFE_PENDING_EXISTS' });
    expect(dropped).toHaveBeenCalledWith(5, SAFE_TX_HASH, 'propose_failed');
    expect(coreSends.cachedState(5)).toBeNull();
    safeApprovals.reserveSend(5).release();
    dropped.mockRestore();
    decided.mockRestore();
  });

  test("a Safe being deleted: refused before the core is asked, the token burnt", async () => {
    await setup();
    const { token } = await confirm(null);
    const deletion = safeApprovals.beginDeletion(5);
    await expect(propose(token)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    deletion.release();
    await arrived();
    expect(methods()).not.toContain('safe.propose');
    expect(fake.sent('approval.discard').map((m) => m.params)).toEqual([{ token }]);
  });

  test('nothing mints the legacy form, spends a token or writes the store', async () => {
    await setup();
    const { token } = await confirm(panel().approvals);
    await propose(token);
    await transactions.signSafePending(5, undefined, { safeTxHash: SAFE_TX_HASH });
    await transactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
    const all = sent();
    expect(all.some((m) => m.method === 'approval.spend')).toBe(false);
    expect(all.some((m) => m.method === 'safe_pending.set' || m.method === 'safe_pending.clear')).toBe(false);
    for (const issue of all.filter((m) => m.method === 'approval.issue')) {
      expect(issue.params.payload.tx).toBeUndefined();
      expect(issue.params.payload.safe_tx_hash).toBe(SAFE_TX_HASH);
    }
    // On the core the legacy form can't be minted at all.
    await expect(
      signing.issueConfirmation('safe-send', 5, { tx: REQUEST.tx, chainId: 100 })
    ).rejects.toThrow('Transaction is required');
  });
});

describe("the board: the core's", () => {
  test('safe.pending under shell, each state as the core gave it, and the last one kept', async () => {
    await setup();
    expect(await transactions.getAllSafeSendStates()).toEqual([BOARD]);
    expect(await transactions.getSafeSendState(5)).toEqual(BOARD);
    expect(await transactions.getSafeSendState(6)).toBeNull();
    expect(fake.sent('safe.pending').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', {}],
      ['shell', {}],
      ['shell', {}],
    ]);
    expect(coreSends.cachedState(5)).toEqual(BOARD);
    // No owner is confirmed again on the core.
    expect(transactions.pendingCall(5, SAFE_TX_HASH)).toBeNull();
  });

  test('a board read the core fails rejects, as its code says', async () => {
    await setup({ 'safe.pending': { error: { code: 'not_moved', message: 'not moved', data: { store: 'vault_meta' } } } });
    await expect(transactions.getAllSafeSendStates()).rejects.toMatchObject({ code: 'not_moved' });
  });
});

describe("owners: safe.sign_owner", () => {
  test("the vault owners' sweep, and one owner, naming the board's SafeTx", async () => {
    await setup();
    const swept = await transactions.signSafePending(5, undefined, { safeTxHash: SAFE_TX_HASH });
    expect(swept.collected).toBe(2);
    await transactions.signSafePending(5, 1, { safeTxHash: SAFE_TX_HASH });
    await transactions.signSafePending(5, 1);
    expect(fake.sent('safe.sign_owner').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', { safe: 5, safe_tx_hash: SAFE_TX_HASH }],
      ['shell', { safe: 5, owner: 1, safe_tx_hash: SAFE_TX_HASH }],
      ['shell', { safe: 5, owner: 1 }],
    ]);
    expect(pendingStore.refreshPending).toHaveBeenCalledTimes(3);
    expect(coreSends.cachedState(5).collected).toBe(2);
  });

  test('a Ledger owner is refused, unsent, until PR 8', async () => {
    await setup();
    await expect(transactions.signSafePending(5, 2, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    expect(methods()).toEqual([]);
  });

  test("one step at a time: another of the Safe's meanwhile is SAFE_BUSY, unsent", async () => {
    await setup({ 'safe.sign_owner': () => undefined });
    const first = transactions.signSafePending(5, undefined, { safeTxHash: SAFE_TX_HASH });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(transactions.signSafePending(5, 1)).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    await expect(transactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    expect(fake.sent('safe.sign_owner')).toHaveLength(1);
    fake.answer(fake.sent('safe.sign_owner')[0].id, BOARD);
    await expect(first).resolves.toEqual(BOARD);
    // Ended with its answer: the next step runs.
    fake.script = scripted();
    await transactions.signSafePending(5, 1);
  });

  test.each([
    ['not_proposed', 'SAFE_NOT_PROPOSED'],
    ['SAFE_DISCARDED', 'SAFE_DISCARDED'],
    ['unverified', 'SAFE_UNVERIFIED'],
  ])("the core's refusal (%s) keeps its code, and the step ends", async (safe, code) => {
    await setup({ 'safe.sign_owner': refusal(safe) });
    await expect(transactions.signSafePending(5, 1, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code });
    expect(safeApprovals.stepRunning(5)).toBe(false);
    expect(pendingStore.refreshPending).toHaveBeenCalledWith(5);
  });

  test('a locked vault is the core\'s vault_locked', async () => {
    await setup({ 'safe.sign_owner': { error: { code: 'vault_locked', message: 'The vault is locked' } } });
    await expect(transactions.signSafePending(5, 1)).rejects.toMatchObject({ code: 'vault_locked' });
  });

  test('no owner takes a confirmation of its own on the core', async () => {
    await setup();
    await expect(transactions.signSafePending(5, 1, { approval: { id: 'a'.repeat(32), page: null } })).rejects.toThrow(
      'This transaction was not confirmed'
    );
    expect(methods()).toEqual([]);
  });
});

describe('a discard: safe.discard', () => {
  test("the board's SafeTx named, told as discarded, PR 6's seam hearing it first", async () => {
    await setup();
    const heard = [];
    const stop = transactions.onSafeSendSettled((event) => heard.push(event));
    const order = [];
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped').mockImplementation((...args) => {
      order.push(['dropped', ...args, fake.sent('safe.discard').length]);
    });
    await transactions.getSafeSendState(5);
    await transactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
    expect(fake.sent('safe.discard').map((m) => [m.context.caller, m.params])).toEqual([['shell', { safe: 5, safe_tx_hash: SAFE_TX_HASH }]]);
    expect(order).toEqual([['dropped', 5, SAFE_TX_HASH, 'discard', 0]]);
    expect(heard).toEqual([{ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' }]);
    expect(coreSends.cachedState(5)).toBeNull();
    expect(pendingStore.refreshPending).toHaveBeenCalledWith(5);
    stop();
    dropped.mockRestore();
  });

  test("unnamed (the chrome's own Discard): the SafeTx the core's board shows now", async () => {
    await setup();
    await transactions.cancelSafeSend(5);
    expect(methods()).toEqual(['safe.pending', 'safe.discard']);
    expect(fake.sent('safe.discard')[0].params).toEqual({ safe: 5, safe_tx_hash: SAFE_TX_HASH });
  });

  test("another SafeTx pending: the core's SAFE_DISCARDED, nothing told", async () => {
    await setup({ 'safe.discard': refusal('SAFE_DISCARDED', 'This transaction was discarded or replaced') });
    const heard = [];
    const stop = transactions.onSafeSendSettled((event) => heard.push(event));
    await expect(transactions.cancelSafeSend(5, { safeTxHash: OTHER_HASH })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(heard).toEqual([]);
    stop();
  });
});

describe('what waits for later PRs is refused, nothing sent', () => {
  test("the execution (PR 4b)", async () => {
    await setup();
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    expect(methods()).toEqual([]);
  });

  test("a site's send (PR 7), before its token is spent", async () => {
    await setup();
    expect(() => transactions.reserveSafeSend(5)).toThrow(expect.objectContaining({ code: 'SAFE_UNSUPPORTED' }));
    await expect(transactions.startSafeSend({ safeIndex: 5 })).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    expect(methods()).toEqual([]);
  });

  test('the hello declares no safe3 (PR 7 does)', async () => {
    await setup();
    expect(fake.hello).not.toBeNull();
    expect(JSON.stringify(fake.hello)).not.toContain('safe3');
  });
});

describe("the wallet's Safe-send approval of the core's SafeTx", () => {
  // The builders' DOM, as approvals-kinds.test.js's.
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.children = [];
      this.text = '';
      this.listeners = {};
    }
    set textContent(value) {
      this.text = String(value);
      this.children = [];
    }
    get textContent() {
      return this.text + this.children.map((child) => child.textContent).join(' ');
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
  }
  const render = (view) => {
    const doc = { createElement: (tag) => new Node(tag) };
    const body = new Node('div');
    kinds.KINDS['wallet.safe_send'].render(view, core.createBuilders(doc), body);
    return body.textContent;
  };

  test('shows "Safe transaction #N" beside the recipient, the amount and the data; today\'s view has none', () => {
    const view = {
      account: { index: 5, name: 'Joint', address: SAFE, type: 'safe' },
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: TO, value: '1000', data: '0x' },
      transfer: null,
    };
    const shown = render({ ...view, safeTx: { nonce: 7 } });
    expect(shown).toMatch(/Safe transaction\s*#7/);
    expect(shown.indexOf('Safe transaction')).toBeLessThan(shown.indexOf(TO));
    expect(render(view)).not.toContain('Safe transaction');
  });
});
