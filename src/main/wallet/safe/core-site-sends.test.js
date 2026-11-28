/**
 * A site's Safe send on the core's Safe backend (SAFE-3's PR 7; freedom-core
 * design 0016, C1, the hello's `safe3`), main's side of safe-dapp.spec.js's
 * send on the core: the page's `{ device }`, as the core answers it once its
 * prompt is approved (design 0016's `safe-send`, bound to the page, the
 * handle and the SafeTx the prompt showed), through main's real steps
 * (page/page-core-sends.js, safe-transactions.js, core-sends.js,
 * approval-records.js, the vault backend and a real CoreClient) against a
 * scripted core that reads each request as cored 0.32.0 does under the field
 * (test/helpers/fake-safe-core.js):
 * - main records the user's decision for exactly that SafeTx (PR 6), then
 *   presents `{ token, handle }` to `safe.propose` under `page` with the
 *   page's PageContext, naming its hash, and shows the board; nothing is
 *   spent through `approval.spend`, and no legacy `safe-send` or
 *   `executor-send` is minted (the core refuses both under the field);
 * - the execution runs past the site's guard: signed with the core's
 *   `executor-send` token, journaled and broadcast under the site, then
 *   `safe.executed`, and the page gets the execution's hash; the record is
 *   dropped before `safe.executed`;
 * - a page that no longer holds the SafeTx gets 4100, and the SafeTx stays
 *   the wallet's own: executed later with no site;
 * - refusals (the name gone, a SafeTx that doesn't hash to its hash,
 *   another Safe, the core's own, a core that didn't take `safe3`): nothing
 *   proposed or recorded, the token burnt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Interface, Transaction, TypedDataEncoder, Wallet, getAddress, keccak256 } = require('ethers');
const { startSafeCore } = require('../../../../test/helpers/fake-safe-core');

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
const OWNERS = ['0x' + '0a'.repeat(20), '0x' + '0b'.repeat(20)];
const TO = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const SITE = `bzz://${'d'.repeat(64)}`;
const TOKEN = 'page-token-1';
const HANDLE = 'h'.repeat(64);
const PAGE = { origin: SITE, top_origin: SITE, frame: 0, navigation: 3, agent: false };

const mockRecords = {
  0: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
  1: { index: 1, name: 'Second', address: OWNERS[1], type: 'mnemonic' },
  5: { index: 5, name: 'Dapp Safe', address: SAFE, type: 'safe', owners: [0, 1], threshold: 1, deployed: { 100: { verified: true } } },
  6: { index: 6, name: 'Other Safe', address: '0x' + '66'.repeat(20), type: 'safe', owners: [0, 1], threshold: 1 },
};
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords[index] ?? null,
  getDerivedWallets: async () => Object.values(mockRecords),
  isHardwareWalletIndex: () => false,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
let mockIntentStore = null;
jest.mock('../intent-store', () => ({
  ...jest.requireActual('../intent-store'),
  getIntentStore: () => mockIntentStore,
}));
const mockChain = { request: jest.fn(), broadcastRawTransaction: jest.fn() };
jest.mock('../../networks/chain-data', () => ({
  request: (...args) => mockChain.request(...args),
  broadcastRawTransaction: (...args) => mockChain.broadcastRawTransaction(...args),
  getFeeQuote: jest.fn(),
  SOURCE_CAPABILITIES: {},
}));
jest.mock('../chains', () => ({
  ...jest.requireActual('../chains'),
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/tx/${hash}`,
}));
const mockRecorded = [];
jest.mock('../tx-recorder', () => ({
  ...jest.requireActual('../tx-recorder'),
  signAndRecord: (params, signer, context, options) => {
    mockRecorded.push({ params, context, options });
    return require('../transaction-service').signAndSendTransaction(params, signer, {
      intentKey: options.intentKey,
      context: { kind: context.kind, origin: context.origin },
      onCommitted: options.onCommitted,
      guardCommit: options.guardCommit,
    });
  },
}));
jest.mock('./pending-store', () => {
  const actual = jest.requireActual('./pending-store');
  const mocked = Object.defineProperties({}, Object.getOwnPropertyDescriptors(actual));
  mocked.refreshPending = jest.fn(async () => {});
  return mocked;
});
// Main's own protocol-kit path: never on the core.
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
    execIntentKey: jest.requireActual('./safe-executor').execIntentKey,
  };
});
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => {
    throw new Error('a Safe read outside the core');
  },
}));

const transactions = require('./safe-transactions');
const coreSends = require('./core-sends');
const records = require('./approval-records');
const safeApprovals = require('./safe-approvals');
const signing = require('../signing-confirmation');
const { _internal } = require('../../core/vault-backend');
const { createCoreSends } = require('../../page/page-core-sends');

const SAFE_TX = Object.freeze({
  to: getAddress(TO),
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
const hashOf = (safeTx, safe = SAFE) =>
  TypedDataEncoder.hash({ chainId: 100, verifyingContract: getAddress(safe.toLowerCase()) }, records.SAFE_TX_TYPES, safeTx);
const SAFE_TX_HASH = hashOf(SAFE_TX);
// Design 0016's `safe-send` payload, as the core mints it under `safe3`.
const PAYLOAD = Object.freeze({ safe: SAFE, chain_id: '100', safe_tx: SAFE_TX, safe_tx_hash: SAFE_TX_HASH });
const DEVICE = Object.freeze({
  type: 'safe',
  kind: 'safe-send',
  account: 5,
  payload: PAYLOAD,
  handle: HANDLE,
  token: TOKEN,
  remember: false,
});
// What the page's board shows for its SafeTx (page-core-sends.js `safeDisplay`).
const DISPLAY = Object.freeze({ site: SITE, asset: null, toAddress: getAddress(TO), amount: '1000' });
const owner = (index, signed) => ({ index, address: OWNERS[index], type: 'mnemonic', signed });
// The core's board for the SafeTx, once proposed: the one vault owner's
// signature meets the threshold (safe-dapp.spec.js's 1-of-2 Safe).
const BOARD = Object.freeze({
  safeIndex: 5,
  chainId: 100,
  safeTxHash: SAFE_TX_HASH,
  threshold: 1,
  collected: 1,
  owners: [owner(0, true), owner(1, false)],
  executorIndex: 0,
  display: DISPLAY,
  call: { to: getAddress(TO), value: '1000', data: '0x' },
  createdAt: 1764300000000,
  status: 'ready',
  proposed: true,
});

// The execution's prepared send (safe.execute), signed by the executor's key.
const EXECUTOR = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const EXEC_INTERFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const SEND_TX = Object.freeze({
  type: 2,
  chain_id: '100',
  gas_limit: '150000',
  to: getAddress(SAFE.toLowerCase()),
  value: '0',
  data: EXEC_INTERFACE.encodeFunctionData('execTransaction', [
    TO, '1000', '0x', 0, 0, 0, 0, ZERO, ZERO, '0x' + '11'.repeat(65),
  ]),
  max_fee_per_gas: '2000000000',
  max_priority_fee_per_gas: '1000000000',
});

const coreTokens = new Set();
let sends = 0;
function prepared() {
  coreTokens.clear();
  const token = `exec-${(sends += 1)}`;
  coreTokens.add(token);
  return { send: { kind: 'executor-send', account: 0, tx: SEND_TX, token } };
}

/** `sign.transaction` as the core answers the executor's: its token spent, the send as prepared. */
function signed(message) {
  const { tx: given, authorization } = message.params;
  const known = coreTokens.delete(authorization?.token);
  if (!known || authorization.kind !== 'executor-send') {
    return { error: { code: 'not_authorized', message: 'the request is not the one confirmed', data: { reason: 'mismatch' } } };
  }
  const unsigned = Transaction.from({
    type: 2,
    chainId: 100,
    nonce: Number(given.nonce),
    gasLimit: given.gas_limit,
    to: given.to,
    value: 0,
    data: given.data,
    maxFeePerGas: given.max_fee_per_gas,
    maxPriorityFeePerGas: given.max_priority_fee_per_gas,
  });
  unsigned.signature = EXECUTOR.signingKey.sign(unsigned.unsignedHash);
  return { raw: unsigned.serialized, hash: keccak256(unsigned.serialized) };
}

/** A core that answers each method as `answers` says, else as below. */
function scripted(answers = {}) {
  const defaults = {
    // The SafeTx the page's token binds, written with its display, under
    // the core's proposal mark (`proposed`).
    'safe.propose': (message) => ({ ...BOARD, display: message.params.display }),
    'safe.pending': { states: [BOARD] },
    'safe.execute': () => prepared(),
    'safe.executed': {},
    'safe.discard': {},
    'approval.discard': (message) => {
      coreTokens.delete(message.params.token);
      return {};
    },
    'keys.addresses': { user_wallets: [{ address: EXECUTOR.address }] },
    'sign.transaction': (message) => signed(message),
    'vault.touch': {},
    'safe_pending.get': null,
  };
  return (message) => {
    const answer = Object.hasOwn(answers, message.method) ? answers[message.method] : defaults[message.method];
    if (answer === undefined) return { error: { code: 'unknown_method', message: 'not scripted' } };
    return typeof answer === 'function' ? answer(message) : answer;
  };
}

const quiet = { info() {}, warn() {}, error() {} };
let made = null;
let fake = null;

async function setup(answers, options = {}) {
  made = await startSafeCore({ log: quiet, script: scripted(answers), ...options });
  mockCore.client = made.client;
  fake = made.cores[0];
  return fake;
}

/** The page's request as page-eip1193.js hands it to its device step. */
function pageRequest({ nameHolds = true, grant = 5 } = {}) {
  const controller = new AbortController();
  const prompts = [];
  let decide;
  const decided = new Promise((resolve) => {
    decide = resolve;
  });
  const state = { nameHolds, grant, holdsKey: true };
  const context = {
    requester: { key: SITE, window: 1, guest: null },
    signal: controller.signal,
    approvalsDocument: false,
    nameHolds: jest.fn(async () => state.nameHolds),
    holdsKey: () => state.holdsKey,
    prompt: jest.fn((spec) => {
      prompts.push(spec);
      return decided;
    }),
    leaveWalletSlot: jest.fn(),
    traceCoreToken: jest.fn(),
  };
  const sends = createCoreSends({
    getPermission: (key) => (key === SITE && state.grant !== null ? { walletIndex: state.grant } : null),
    updateLastUsed: async () => {},
    walletList: async () => Object.values(mockRecords),
  });
  return { context, sends, prompts, decide, controller, state };
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const arrived = () => new Promise((resolve) => setTimeout(resolve, 20));
// The core's requests of the send: its Safe steps, signatures and tokens.
const methods = () =>
  fake.methods().filter((m) => /^(safe\.|sign\.|approval\.)/.test(m));

let intentDir = null;

beforeEach(() => {
  coreSends._reset();
  records._reset();
  signing._reset();
  safeApprovals._reset();
  _internal.reset();
  coreTokens.clear();
  mockRecorded.length = 0;
  intentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-site-intents-'));
  const { createIntentStore } = jest.requireActual('../intent-store');
  const { simulatedIntents } = require('../../../../test/helpers/simulated-intents-core');
  mockIntentStore = createIntentStore({
    backend: simulatedIntents({ filePath: path.join(intentDir, 'wallet-intents.jsonl') }).intents,
  });
  mockChain.request.mockReset().mockResolvedValue({ result: '0x5', source: 'direct' });
  mockChain.broadcastRawTransaction.mockReset().mockImplementation(async (_chainId, raw) => ({
    result: Transaction.from(raw).hash,
    source: 'direct',
  }));
});

afterEach(async () => {
  await made?.client.stop();
  made = null;
  mockCore.client = null;
  fs.rmSync(intentDir, { recursive: true, force: true });
});

describe("a site's send on the core: recorded, proposed under the page, its board, its execution", () => {
  test("safe-dapp.spec.js's send: recorded, safe.propose under page with { token, handle }, the board, executed past the site's guard, the page gets the hash", async () => {
    // The record main holds as the core is asked to spend the token.
    let recordedAtPropose;
    await setup({
      'safe.propose': (message) => {
        recordedAtPropose = records.recordFor(5);
        return { ...BOARD, display: message.params.display };
      },
    });
    expect(fake.hello.safe3).toBe(true);
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped');
    const { context, sends, prompts, decide } = pageRequest();

    const answer = sends.device(context, DEVICE, PAGE);
    await until(() => prompts.length === 1);

    // The decision recorded for exactly that SafeTx, before its token was
    // spent; then the token and its handle presented under the page.
    expect(recordedAtPropose).toEqual({ address: SAFE, chainId: 100, hash: SAFE_TX_HASH.toLowerCase() });
    expect(records.recordFor(5)).toEqual({ address: SAFE, chainId: 100, hash: SAFE_TX_HASH.toLowerCase() });
    expect(records.binds(5, { address: SAFE, chainId: 100, safeTx: SAFE_TX })).toBe(true);
    expect(fake.sent('safe.propose').map((m) => [m.context, m.params])).toEqual([
      [
        { caller: 'page', page: PAGE },
        { safe: 5, safe_tx_hash: SAFE_TX_HASH, authorization: { token: TOKEN, handle: HANDLE }, display: DISPLAY },
      ],
    ]);
    expect(context.traceCoreToken).toHaveBeenCalledWith('spent', 'safe-send');
    // The board, shown with the core's state.
    expect(prompts[0]).toMatchObject({ kind: 'eth.safe_send', view: { safeIndex: 5, state: { safeTxHash: SAFE_TX_HASH, proposed: true } } });
    // Nothing spent through approval.spend, nothing minted by main.
    // (The spent token is burnt again once the step ends, which spends nothing.)
    expect(methods()).toEqual(['safe.propose', 'approval.discard']);
    expect(fake.refused).toEqual([]);

    // The board's execution (the chrome's, with the document off), past the
    // page's guard: its name, key and grant checked in the same run.
    const nameChecks = context.nameHolds.mock.calls.length;
    const state = await transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH });
    expect(state.status).toBe('executed');
    expect(context.nameHolds.mock.calls.length).toBeGreaterThan(nameChecks);
    const hash = keccak256(mockChain.broadcastRawTransaction.mock.calls.at(-1)[1]);
    expect(await answer).toEqual({ result: hash });
    decide({});

    // Signed with the core's own executor-send token, under the site; the
    // record dropped before safe.executed.
    expect(fake.sent('sign.transaction').map((m) => [m.context.caller, m.params.authorization.kind])).toEqual([
      ['shell', 'executor-send'],
    ]);
    expect(mockRecorded.map((r) => r.context.origin)).toEqual([SITE]);
    expect(typeof mockRecorded[0].options.guardCommit).toBe('function');
    expect(dropped).toHaveBeenCalledWith(5, SAFE_TX_HASH, 'executed');
    expect(records.recordFor(5)).toBeNull();
    expect(methods()).toEqual([
      'safe.propose',
      'approval.discard',
      'safe.execute',
      'sign.transaction',
      'safe.executed',
      'approval.discard',
    ]);
    // Under the field nothing was refused: no legacy form, no executor-send
    // minted, no approval.spend.
    expect(fake.refused).toEqual([]);
    expect(fake.sent('approval.issue')).toEqual([]);
    expect(fake.sent('approval.spend')).toEqual([]);
    dropped.mockRestore();
  });

  test('a page that no longer holds its SafeTx gets 4100; the SafeTx stays the wallet\'s own, executed later with no site', async () => {
    await setup();
    const { context, sends, prompts, state } = pageRequest();
    const answer = sends.device(context, DEVICE, PAGE);
    await until(() => prompts.length === 1);

    // The site's grant gone: its execution is refused at the guard, nothing
    // executed, and the page told.
    state.grant = null;
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({
      code: 'SAFE_SITE_WITHDRAWN',
    });
    expect(await answer).toEqual({ error: { code: 4100, message: 'This page has no address to connect from yet' } });
    expect(fake.sent('safe.execute')).toEqual([]);

    // Executed again, it is the wallet's own: no guard, no site.
    const done = await transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH });
    expect(done.status).toBe('executed');
    expect(mockRecorded.map((r) => r.context.origin)).toEqual([undefined]);
    expect(mockRecorded[0].options.guardCommit).toBeUndefined();
  });

  test('after a restart (no guard), the first execution withdraws it from its site, nothing sent, and the next executes it', async () => {
    await setup();
    const { context, sends, prompts, controller } = pageRequest();
    const answer = sends.device(context, DEVICE, PAGE);
    await until(() => prompts.length === 1);
    // The page's request ended (its document gone): its guard with it.
    controller.abort();
    expect(await answer).toEqual({ error: { code: 4001, message: 'User rejected the request' } });

    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({
      code: 'SAFE_SITE_WITHDRAWN',
    });
    expect(fake.sent('safe.execute')).toEqual([]);
    const done = await transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH });
    expect(done.status).toBe('executed');
    expect(mockRecorded.map((r) => r.context.origin)).toEqual([undefined]);
  });

  test("withdrawn, discarded, then the same SafeTx proposed again by a site: the new one is the site's, its page gone executes nothing (Codex round 1)", async () => {
    await setup();
    const first = pageRequest();
    const firstAnswer = first.sends.device(first.context, DEVICE, PAGE);
    await until(() => first.prompts.length === 1);
    first.controller.abort();
    await firstAnswer;
    // The first execution withdraws it from its site.
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({
      code: 'SAFE_SITE_WITHDRAWN',
    });
    // Discarded (the nonce doesn't move), then the same call proposed again.
    await transactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH });
    const second = pageRequest();
    const secondAnswer = second.sends.device(second.context, DEVICE, PAGE);
    await until(() => second.prompts.length === 1);
    expect(fake.sent('safe.propose')).toHaveLength(2);
    // Its page goes: the new proposal is the site's, so its execution meets
    // the site's guard, and nothing is sent.
    second.controller.abort();
    await secondAnswer;
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({
      code: 'SAFE_SITE_WITHDRAWN',
    });
    expect(fake.sent('safe.execute')).toEqual([]);
    expect(fake.sent('sign.transaction')).toEqual([]);
  });

  test('a held execution of the site (committed, not sent) is withdrawn from its site in the journal first', async () => {
    await setup();
    const { context, sends, prompts, state } = pageRequest();
    const answer = sends.device(context, DEVICE, PAGE);
    await until(() => prompts.length === 1);
    // The first attempt commits, then its broadcast fails: held, under the site.
    mockChain.broadcastRawTransaction.mockRejectedValueOnce(Object.assign(new Error('rejected by the node'), { outcome: 'rejected' }));
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toThrow();
    const key = `safe-exec:100:${SAFE_TX_HASH.toLowerCase()}`;
    expect((await mockIntentStore.byKey(key))?.context?.origin).toBe(SITE);
    // The site gone: the held execution loses its site, durably, before
    // anything is sent; the page is told.
    state.grant = null;
    const withdraw = jest.spyOn(mockIntentStore, 'withdrawOrigin');
    await expect(transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({
      code: 'SAFE_SITE_WITHDRAWN',
    });
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect((await mockIntentStore.byKey(key))?.context?.origin ?? null).toBeNull();
    expect(await answer).toEqual({ error: { code: 4100, message: 'This page has no address to connect from yet' } });
  });
});

describe('refused: nothing proposed or recorded, the token burnt', () => {
  test("the page's name or key gone, or its grant: no propose, no record", async () => {
    await setup();
    for (const change of [{ nameHolds: false }, { grant: 6 }]) {
      const { context, sends } = pageRequest(change);
      const answer = await sends.device(context, DEVICE, PAGE);
      expect(answer.error.code).toBe(4100);
    }
    await arrived();
    expect(fake.sent('safe.propose')).toEqual([]);
    expect(records.recordFor(5)).toBeNull();
    expect(new Set(fake.sent('approval.discard').map((m) => m.params.token))).toEqual(new Set([TOKEN]));
    expect(fake.sent('approval.discard').length).toBeGreaterThanOrEqual(2);
  });

  test("a SafeTx that doesn't hash to its hash, another Safe's address, another chain, another shape: nothing proposed", async () => {
    await setup();
    const crossed = [
      { ...PAYLOAD, safe_tx: { ...SAFE_TX, value: '1001' } },
      { ...PAYLOAD, safe_tx_hash: hashOf({ ...SAFE_TX, nonce: 8 }) },
      { ...PAYLOAD, safe: mockRecords[6].address },
      { ...PAYLOAD, chain_id: '1' },
      { safe: SAFE, chain_id: '100', tx: { to: TO, value: '1000', data: '0x' } },
      { ...PAYLOAD, extra: true },
    ];
    for (const payload of crossed) {
      const { context, sends } = pageRequest();
      const answer = await sends.device(context, { ...DEVICE, payload }, PAGE);
      expect(answer.error.code).toBe(-32603);
    }
    await arrived();
    expect(fake.sent('safe.propose')).toEqual([]);
    expect(records.recordFor(5)).toBeNull();
    // Burnt each time (and again as the step ends), and only that token.
    expect(fake.sent('approval.discard').length).toBeGreaterThanOrEqual(crossed.length);
    expect(new Set(fake.sent('approval.discard').map((m) => m.params.token))).toEqual(new Set([TOKEN]));
    // The Safe's reservation was released each time.
    safeApprovals.reserveSend(5).release();
  });

  test("the core's refusal of the propose: the record dropped, the reservation released, the token burnt", async () => {
    await setup({
      'safe.propose': { error: { code: 'invalid_argument', message: 'A transaction is already waiting', data: { safe: 'pending_exists' } } },
    });
    const { context, sends, prompts } = pageRequest();
    const answer = await sends.device(context, DEVICE, PAGE);
    expect(answer).toEqual({ error: { code: -32603, message: 'A transaction is already waiting' } });
    expect(prompts).toEqual([]);
    expect(fake.sent('safe.propose')).toHaveLength(1);
    expect(records.recordFor(5)).toBeNull();
    await arrived();
    expect(fake.sent('approval.discard').map((m) => m.params.token)).toContain(TOKEN);
    safeApprovals.reserveSend(5).release();
  });

  test("a core that didn't take safe3 (before 0.32.0) never gets a site's propose: refused in main, unsent", async () => {
    await setup({}, { takesSafe3: false });
    expect(fake.hello.safe3).toBe(true);
    expect(made.client.hello.safe3).toBe(false);
    const { context, sends } = pageRequest();
    const answer = await sends.device(context, DEVICE, PAGE);
    expect(answer.error.code).toBe(-32603);
    expect(fake.sent('safe.propose')).toEqual([]);
    expect(records.recordFor(5)).toBeNull();
  });

  test("main's own start of a site's SafeTx (the legacy path) never runs on the core", async () => {
    await setup();
    expect(() => transactions.reserveSafeSend(5)).toThrow("Main's own Safe transactions don't run on the identity core");
    await expect(transactions.startSafeSend({ safeIndex: 5 })).rejects.toThrow(
      "Main's own Safe transactions don't run on the identity core"
    );
    expect(methods()).toEqual([]);
  });
});
