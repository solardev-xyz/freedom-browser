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
 * - the execution (PR 4b) is `safe.execute` naming the board's SafeTx:
 *   the core's prepared send checked, signed by the executor with the
 *   core's `executor-send` token, journaled under `execIntentKey` (the real
 *   transaction service, over a simulated intent journal) and broadcast,
 *   then `safe.executed`; the executor's fee the core's check stops is
 *   shown in the approvals document with the core's verdict and
 *   acknowledged (`fee_ack`), never minted; a superseded SafeTx is told,
 *   nothing signed; a failed signature or broadcast leaves it for "Try
 *   again", which sends the held execution's bytes again;
 * - a site's send (PR 7) is refused, nothing sent; and the hello still
 *   declares no `safe3`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Interface, Transaction, Wallet, getAddress, keccak256 } = require('ethers');
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
  isHardwareWalletIndex: () => false,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// The executor's send goes through the real transaction service: its intent
// journal simulated in a temp dir, and the chain's two calls scripted (the
// executor's pending nonce, and the broadcast).
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
// The payment's record: what main would write, kept; its send the real one.
const mockRecorded = [];
jest.mock('../tx-recorder', () => ({
  ...jest.requireActual('../tx-recorder'),
  signAndRecord: (params, signer, context, options) => {
    mockRecorded.push({ params, context, options });
    return require('../transaction-service').signAndSendTransaction(params, signer, {
      intentKey: options.intentKey,
      context: { kind: context.kind },
    });
  },
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
    // The execution's intent key, the one today's path journals under.
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

// The execution (PR 4b). The executor's key, a well-known test key, signs
// in the scripted core as the vault would.
const EXECUTOR = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const SAFE_SUM = getAddress(SAFE.toLowerCase());
const EXEC_INTERFACE = new Interface([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
]);
const execData = (call = SAFE_TX, operation = 0) =>
  EXEC_INTERFACE.encodeFunctionData('execTransaction', [
    call.to, call.value, call.data, operation, 0, 0, 0, ZERO, ZERO, '0x' + '11'.repeat(65) + '22'.repeat(65),
  ]);
// The core's prepared send, `sign.transaction`'s form without its nonce.
const SEND_TX = Object.freeze({
  type: 2,
  chain_id: '100',
  gas_limit: '150000',
  to: SAFE_SUM,
  value: '0',
  data: execData(),
  max_fee_per_gas: '2000000000',
  max_priority_fee_per_gas: '1000000000',
});
// The board at its threshold: two of three signatures.
const READY = Object.freeze({ ...BOARD, collected: 2, owners: [owner(0, true), owner(1, true), owner(2, false)] });
// The core's verdict on a fee its check stops: 150000 × 2 gwei, 20× today's.
const VERDICT = Object.freeze({
  maxCost: '300000000000000',
  comparable: true,
  ratio: '20',
  above: true,
  oneEndpoint: false,
  basis: 'header',
  autoApprove: false,
  askAgain: true,
});
const EXEC_KEY = `safe-exec:100:${SAFE_TX_HASH}`;

// The core's `executor-send` tokens outstanding (one per Safe in the core:
// a newer prepared send burns the older), as `sign.transaction` spends them.
const coreTokens = new Set();

/** `safe.execute`'s `{ send }`, its token minted by the core. */
let sends = 0;
function prepared(tx = SEND_TX) {
  coreTokens.clear();
  const token = `exec-${(sends += 1)}`;
  coreTokens.add(token);
  return { send: { kind: 'executor-send', account: 0, tx, token } };
}

/**
 * `sign.transaction` as the core answers it for the executor: its token
 * spent, and the transaction (but its nonce) the one prepared, or
 * `not_authorized` `mismatch` with the token burnt.
 */
function signed(message, tx = SEND_TX) {
  const { tx: given, authorization } = message.params;
  const known = coreTokens.delete(authorization?.token);
  const { nonce, ...rest } = given;
  const expected = { ...tx, to: getAddress(tx.to) };
  const same =
    Object.keys(rest).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => rest[key] === value);
  if (!known || authorization.kind !== 'executor-send' || !same) {
    return { error: { code: 'not_authorized', message: 'the request is not the one confirmed', data: { reason: 'mismatch' } } };
  }
  const unsigned = Transaction.from({
    type: 2,
    chainId: 100,
    nonce: Number(nonce),
    gasLimit: rest.gas_limit,
    to: rest.to,
    value: 0,
    data: rest.data,
    maxFeePerGas: rest.max_fee_per_gas,
    maxPriorityFeePerGas: rest.max_priority_fee_per_gas,
  });
  unsigned.signature = EXECUTOR.signingKey.sign(unsigned.unsignedHash);
  return { raw: unsigned.serialized, hash: keccak256(unsigned.serialized) };
}

/** A core that answers each method as `answers` says (a value or `(message) => value`), else as below. */
function scripted(answers = {}) {
  let minted = 0;
  const defaults = {
    'safe.prepare': { safe_tx: SAFE_TX, safe_tx_hash: SAFE_TX_HASH, view: { primaryType: 'SafeTx' } },
    'approval.issue': () => ({ token: `token-${(minted += 1)}`, expires_in_ms: 120000 }),
    'approval.discard': (message) => {
      coreTokens.delete(message.params.token);
      return {};
    },
    'safe.propose': BOARD,
    'safe.pending': { states: [BOARD] },
    'safe.sign_owner': { ...BOARD, collected: 2, owners: [owner(0, true), owner(1, true), owner(2, false)] },
    'safe.discard': {},
    'safe_pending.get': null,
    'safe.execute': () => prepared(),
    'safe.executed': {},
    'keys.addresses': { user_wallets: [{ address: EXECUTOR.address }] },
    'sign.transaction': (message) => signed(message),
    'vault.touch': {},
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
/** With the approvals document off: prepared, its nonce confirmed on the chrome, minted. */
async function confirmOnChrome(request = REQUEST) {
  const asked = await confirm(null, request);
  return confirm(null, { ...request, prepared: asked.prepared.id });
}
const propose = (token, overrides = {}) =>
  transactions.proposeSafeSend({ safeIndex: 5, tx: REQUEST.tx, chainId: 100, display: DISPLAY, authorization: { confirmation: token }, ...overrides });

/** Every request main sent the core, but the hello's and the store reads. */
const sent = () => fake.requests.map((m) => ({ method: m.method, caller: m.context?.caller, params: m.params }));
const methods = () => fake.methods().filter((m) => m !== 'safe_pending.get');

let intentDir = null;

beforeEach(() => {
  coreSends._reset();
  signing._reset();
  safeApprovals._reset();
  _internal.reset();
  pendingStore.refreshPending.mockClear();
  coreTokens.clear();
  mockRecorded.length = 0;
  intentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-core-intents-'));
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

  test("the approvals document off: the prepared SafeTx's nonce goes to the chrome first, and only its confirmation mints", async () => {
    await setup();
    // What the chrome is given to show: "Safe transaction #7", nothing minted.
    const asked = await confirm(null);
    expect(asked).toEqual({
      approved: false,
      code: 'SAFE_TX_PREPARED',
      error: 'Confirm Safe transaction #7',
      prepared: { id: expect.stringMatching(/^[0-9a-f]{32}$/), nonce: 7 },
    });
    expect(methods()).toEqual(['safe.prepare']);
    // Confirmed with its id: minted for exactly that SafeTx, not prepared again.
    const confirmed = await confirm(null, { ...REQUEST, prepared: asked.prepared.id });
    expect(confirmed).toMatchObject({ approved: true, token: 'token-1' });
    expect(methods()).toEqual(['safe.prepare', 'approval.issue']);
    expect(fake.sent('approval.issue')[0].params.payload.safe_tx.nonce).toBe(7);
    await propose(confirmed.token);
    expect(methods()).toEqual(['safe.prepare', 'approval.issue', 'safe.propose']);
    // An id is confirmed once.
    await expect(confirm(null, { ...REQUEST, prepared: asked.prepared.id })).rejects.toMatchObject({
      code: 'SIGNING_NOT_CONFIRMED',
    });
  });

  test("the approvals document off: an id for another call, another Safe or none known mints nothing", async () => {
    await setup();
    const first = await confirm(null);
    await expect(
      confirm(null, { tx: { ...REQUEST.tx, value: '1001' }, chainId: 100, prepared: first.prepared.id })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', message: 'Signing was not confirmed: request differs from what was confirmed' });
    const second = await confirm(null);
    await expect(
      transactions.confirmSafeSend({ sender: CHROME, safeIndex: 6, request: { ...REQUEST, prepared: second.prepared.id }, approvals: null })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    await expect(confirm(null, { ...REQUEST, prepared: 'f'.repeat(32) })).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(methods()).toEqual(['safe.prepare', 'safe.prepare']);
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
      const { token } = await confirmOnChrome();
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
    const { token } = await confirmOnChrome();
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
    const { token } = await confirmOnChrome();
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
    // One that names no SafeTx is refused, unsent: the sweep and an owner alike.
    await expect(transactions.signSafePending(5, 1)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(transactions.signSafePending(5, undefined)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(fake.sent('safe.sign_owner').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', { safe: 5, safe_tx_hash: SAFE_TX_HASH }],
      ['shell', { safe: 5, owner: 1, safe_tx_hash: SAFE_TX_HASH }],
    ]);
    expect(pendingStore.refreshPending).toHaveBeenCalledTimes(2);
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
    await expect(transactions.signSafePending(5, 1, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    await expect(transactions.cancelSafeSend(5, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    expect(fake.sent('safe.sign_owner')).toHaveLength(1);
    fake.answer(fake.sent('safe.sign_owner')[0].id, BOARD);
    await expect(first).resolves.toEqual(BOARD);
    // Ended with its answer: the next step runs.
    fake.script = scripted();
    await transactions.signSafePending(5, 1, { safeTxHash: SAFE_TX_HASH });
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
    await expect(transactions.signSafePending(5, 1, { safeTxHash: SAFE_TX_HASH })).rejects.toMatchObject({ code: 'vault_locked' });
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

  test('one that names no SafeTx is refused, unsent', async () => {
    await setup();
    await expect(transactions.cancelSafeSend(5)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(methods()).toEqual([]);
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

describe('a SafeTx replaced between a board showing it and its step', () => {
  const H1 = SAFE_TX_HASH;
  const H2 = OTHER_HASH;
  // A core that holds one pending SafeTx, and refuses a step naming another
  // (SAFE_DISCARDED), as cored's sign_owner and discard do.
  function pendingCore() {
    const core = { current: H1 };
    const named = (message, answer) =>
      message.params.safe_tx_hash === core.current
        ? answer()
        : refusal('SAFE_DISCARDED', 'This transaction was discarded or replaced');
    core.answers = {
      'safe.pending': () => ({ states: core.current ? [{ ...BOARD, safeTxHash: core.current }] : [] }),
      'safe.sign_owner': (m) => named(m, () => ({ ...BOARD, safeTxHash: core.current, collected: 2 })),
      'safe.discard': (m) =>
        named(m, () => {
          core.current = null;
          return {};
        }),
      'safe.execute': (m) => named(m, () => prepared()),
    };
    return core;
  }

  test("window A shows H1; H1 is discarded and H2 proposed elsewhere: A's sign, sweep and discard are refused, H2 untouched", async () => {
    const core = pendingCore();
    await setup(core.answers);
    // Window A's board shows H1.
    const shown = (await transactions.getSafeSendState(5)).safeTxHash;
    expect(shown).toBe(H1);
    // Elsewhere (window B): H1 discarded, H2 proposed.
    await transactions.cancelSafeSend(5, { safeTxHash: H1 });
    core.current = H2;
    // A's steps name the SafeTx A shows: each refused, none acts on H2.
    await expect(transactions.signSafePending(5, 1, { safeTxHash: shown })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(transactions.signSafePending(5, undefined, { safeTxHash: shown })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(transactions.cancelSafeSend(5, { safeTxHash: shown })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(core.current).toBe(H2);
    const named = [...fake.sent('safe.sign_owner'), ...fake.sent('safe.discard')].map((m) => m.params.safe_tx_hash);
    expect(named).toEqual([H1, H1, H1, H1]);
    // A's execution (PR 4b) names H1 too: the core's board shows H2, so it
    // is refused before the core is asked to execute anything.
    await expect(transactions.executeSafePending(5, { safeTxHash: shown })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(fake.sent('safe.execute')).toEqual([]);
  });

  test("A's execution of H1 after H2 replaced it, A's board still showing H1: the core refuses it, nothing signed", async () => {
    const core = pendingCore();
    await setup(core.answers);
    // A's board read H1 (main keeps that state); H2 replaced it elsewhere.
    expect((await transactions.getSafeSendState(5)).safeTxHash).toBe(H1);
    core.current = H2;
    await expect(transactions.executeSafePending(5, { safeTxHash: H1 })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    expect(fake.sent('safe.execute').map((m) => m.params.safe_tx_hash)).toEqual([H1]);
    expect(fake.sent('sign.transaction')).toEqual([]);
    expect(core.current).toBe(H2);
  });
});

describe('the execution: safe.execute (PR 4b)', () => {
  const execute = (options = {}) => transactions.executeSafePending(5, { safeTxHash: SAFE_TX_HASH, ...options });
  // The core's requests of the execution: its Safe steps, signatures and tokens.
  const steps = () =>
    fake.requests
      .filter((m) => /^(safe\.(execute|executed|pending)|sign\.|approval\.)/.test(m.method))
      .map((m) => m.method);
  const failure = (run) => run().then(() => null, (err) => err);
  const SENT_HASH = () => keccak256(mockChain.broadcastRawTransaction.mock.calls.at(-1)[1]);

  test("at the threshold: the core's send signed with its token under shell, journaled before the broadcast, then safe.executed", async () => {
    await setup({ 'safe.pending': { states: [READY] } });
    const heard = [];
    const stop = transactions.onSafeSendSettled((event) => heard.push(event));
    const order = [];
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped').mockImplementation((...args) => {
      order.push(['dropped', ...args, fake.sent('safe.executed').length]);
    });
    // The journal holds the execution, under its key, when its bytes go out.
    mockChain.broadcastRawTransaction.mockImplementation(async (_chainId, raw) => {
      const held = await mockIntentStore.byKey(EXEC_KEY);
      order.push(['broadcast', held?.chainId, held?.sender, held?.nonce]);
      return { result: Transaction.from(raw).hash, source: 'direct' };
    });

    const state = await execute();

    expect(steps()).toEqual(['safe.pending', 'safe.execute', 'sign.transaction', 'safe.executed', 'approval.discard']);
    expect(fake.sent('safe.execute').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', { safe: 5, safe_tx_hash: SAFE_TX_HASH }],
    ]);
    // The executor signs the prepared send, its nonce main's, with the
    // core's own token: { token, kind: "executor-send" }, under shell.
    const [sign] = fake.sent('sign.transaction');
    expect(sign.context.caller).toBe('shell');
    expect(sign.params).toEqual({
      key: { kind: 'account', index: 0 },
      tx: { ...SEND_TX, nonce: '5' },
      authorization: { token: 'exec-1', kind: 'executor-send' },
    });
    expect(order).toEqual([
      ['broadcast', 100, EXECUTOR.address.toLowerCase(), 5],
      ['dropped', 5, SAFE_TX_HASH, 'executed', 0],
    ]);
    expect(fake.sent('safe.executed').map((m) => [m.context.caller, m.params])).toEqual([
      ['shell', { safe: 5, safe_tx_hash: SAFE_TX_HASH, hash: SENT_HASH() }],
    ]);
    expect(state).toEqual({
      ...READY,
      status: 'executed',
      executed: { hash: SENT_HASH(), explorerUrl: `https://explorer.test/100/tx/${SENT_HASH()}` },
    });
    expect(heard).toEqual([{ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: SENT_HASH() }]);
    // The payment's record: from the Safe, the executor stamped in, under the
    // execution's key.
    expect(mockRecorded).toEqual([
      {
        params: {
          to: SAFE_SUM,
          value: '0',
          data: SEND_TX.data,
          chainId: 100,
          gasLimit: '150000',
          maxFeePerGas: '2000000000',
          maxPriorityFeePerGas: '1000000000',
        },
        context: {
          kind: 'safe-send',
          fromAddress: SAFE,
          toAddress: TO,
          asset: null,
          amount: '1000',
          metadata: { safeAddress: SAFE, safeTxHash: SAFE_TX_HASH, executor: EXECUTOR.address },
        },
        options: { intentKey: EXEC_KEY },
      },
    ]);
    // Main minted nothing: no executor-send, no spend, no store write.
    expect(fake.sent('approval.issue')).toEqual([]);
    expect(fake.sent('approval.spend')).toEqual([]);
    expect(fake.methods()).not.toContain('safe_pending.set');
    expect(fake.methods()).not.toContain('safe_pending.clear');
    expect(safeApprovals.stepRunning(5)).toBe(false);
    expect(pendingStore.refreshPending).toHaveBeenCalledWith(5);
    stop();
    dropped.mockRestore();
  });

  test("the fee the core's check stops: asked in the approvals document with the core's verdict, acknowledged with fee_ack, nothing minted", async () => {
    await setup({
      'safe.pending': { states: [READY] },
      'safe.execute': (message) => (message.params.fee_ack === true ? prepared() : { fee_check: VERDICT }),
    });
    const error = await failure(execute);
    expect(error).toMatchObject({ code: 'FEE_CHECK_NEEDS_CONFIRMATION', feeCheck: VERDICT });
    expect(error.offer).toEqual({ feeAck: true, safeIndex: 5, executorIndex: 0, chainId: 100, to: SAFE, value: '0' });
    expect(steps()).toEqual(['safe.pending', 'safe.execute']);

    // The panel: wallet.executor_send with the core's verdict, asked again
    // above the threshold, and nothing minted on the approval.
    const { approvals, prompts } = panel();
    const outcome = await coreSends.confirmOfferedFee({ approvals, windowId: 1, safeIndex: 5 });
    expect(outcome).toEqual({ approved: true, feeConfirmation: { feeAck: true } });
    expect(prompts.map((p) => [p.kind, p.view.feeAskAgain])).toEqual([
      ['wallet.executor_send', false],
      ['wallet.executor_send', true],
    ]);
    const { askAgain: _askAgain, ...shownVerdict } = VERDICT;
    expect(prompts[0].view).toEqual({
      account: { index: 0, name: 'Main Wallet', address: OWNERS[0], type: 'mnemonic' },
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: SAFE, value: '0', data: '0x' },
      fee: null,
      feeCheck: shownVerdict,
      feeAskAgain: false,
    });
    for (const prompt of prompts) {
      const message = { handle: 'c'.repeat(64), revision: 1, guest: null, kind: prompt.kind, site: { key: 'freedom:wallet', label: 'Your wallet' }, view: prompt.view };
      expect(kinds.checkMessage(message).valid).toBe(true);
    }
    expect(fake.sent('approval.issue')).toEqual([]);

    const state = await execute({ feeConfirmation: outcome.feeConfirmation });
    expect(fake.sent('safe.execute').map((m) => m.params)).toEqual([
      { safe: 5, safe_tx_hash: SAFE_TX_HASH },
      { safe: 5, safe_tx_hash: SAFE_TX_HASH, fee_ack: true },
    ]);
    expect(state.status).toBe('executed');
    expect(fake.sent('sign.transaction')).toHaveLength(1);
    expect(fake.sent('approval.issue')).toEqual([]);
  });

  test('a fee declined in the panel sends nothing more; an acknowledgement main holds no offer for is no fee_ack', async () => {
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': () => ({ fee_check: VERDICT }) });
    await failure(execute);
    const { approvals } = panel([{ approve: false, choices: {} }]);
    expect(await coreSends.confirmOfferedFee({ approvals, windowId: 1, safeIndex: 5 })).toEqual({
      approved: false,
      error: 'User rejected the request',
      code: 'USER_REJECTED',
    });
    expect(steps()).toEqual(['safe.pending', 'safe.execute']);
    // The chrome's acknowledgement, with the document on, is asked there
    // first: declined, nothing sent.
    await expect(
      transactions.executeChromeSafeSend({
        sender: CHROME,
        safeIndex: 5,
        safeTxHash: SAFE_TX_HASH,
        feeConfirmation: { feeAck: true },
        approvals: panel([{ approve: false, choices: {} }]).approvals,
      })
    ).rejects.toMatchObject({ code: 'USER_REJECTED' });
    expect(fake.sent('safe.execute')).toHaveLength(1);

    // No offer held (another Safe's, none shown): no fee_ack goes to the core.
    coreSends._reset();
    await failure(() => execute({ feeConfirmation: { feeAck: true } }));
    expect(fake.sent('safe.execute').at(-1).params).toEqual({ safe: 5, safe_tx_hash: SAFE_TX_HASH });
    // A token for the executor's fee is no confirmation on the core: burnt.
    await expect(execute({ feeConfirmation: { confirmation: 'chrome-token', gasLimit: '1', fees: {} } })).rejects.toMatchObject({
      code: 'SIGNING_NOT_CONFIRMED',
    });
    await arrived();
    expect(fake.sent('approval.discard').map((m) => m.params)).toEqual([{ token: 'chrome-token' }]);
    expect(fake.sent('sign.transaction')).toEqual([]);
  });

  test('a fee that changes between the quote and the acknowledgement: asked again, or refused before signing', async () => {
    const NEWER = { ...VERDICT, maxCost: '450000000000000', ratio: '30' };
    let answer = { fee_check: VERDICT };
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': () => (typeof answer === 'function' ? answer() : answer) });
    await failure(execute);

    // The core's offer replaced meanwhile: quoted again, its new fee asked.
    answer = { fee_check: NEWER };
    const again = await failure(() => execute({ feeConfirmation: { feeAck: true } }));
    expect(again).toMatchObject({ code: 'FEE_CHECK_NEEDS_CONFIRMATION', feeCheck: NEWER });
    expect(fake.sent('safe.execute').at(-1).params.fee_ack).toBe(true);
    const { prompts, approvals } = panel();
    await coreSends.confirmOfferedFee({ approvals, windowId: 1, safeIndex: 5 });
    expect(prompts[0].view.feeCheck.maxCost).toBe(NEWER.maxCost);

    // A send costing another fee than the one confirmed: nothing signed, its token burnt.
    answer = () => prepared({ ...SEND_TX, gas_limit: '160000' });
    const refused = await failure(() => execute({ feeConfirmation: { feeAck: true } }));
    expect(refused).toMatchObject({ code: 'FEE_NOT_SHOWN' });
    await arrived();
    expect(fake.sent('sign.transaction')).toEqual([]);
    expect(fake.sent('approval.discard').map((m) => m.params.token)).toEqual([`exec-${sends}`]);
    expect(mockChain.broadcastRawTransaction).not.toHaveBeenCalled();
    // The offer is gone: the next acknowledgement is no fee_ack.
    answer = { fee_check: VERDICT };
    await failure(() => execute({ feeConfirmation: { feeAck: true } }));
    expect(fake.sent('safe.execute').at(-1).params).toEqual({ safe: 5, safe_tx_hash: SAFE_TX_HASH });
  });

  test("a failed signature: the core's refusal keeps its code; nothing journaled, broadcast or told", async () => {
    await setup({
      'safe.pending': { states: [READY] },
      'sign.transaction': { error: { code: 'not_authorized', message: 'the request is not the one confirmed', data: { reason: 'mismatch' } } },
    });
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped');
    await expect(execute()).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    await arrived();
    expect(steps()).toEqual(['safe.pending', 'safe.execute', 'sign.transaction', 'approval.discard']);
    expect(await mockIntentStore.byKey(EXEC_KEY)).toBeNull();
    expect(mockChain.broadcastRawTransaction).not.toHaveBeenCalled();
    expect(dropped).not.toHaveBeenCalled();
    expect(safeApprovals.stepRunning(5)).toBe(false);
    dropped.mockRestore();
  });

  test('a failed broadcast leaves the execution held: "Try again" sends its bytes again, signs nothing new, then safe.executed', async () => {
    let fees = false;
    await setup({
      'safe.pending': { states: [READY] },
      'safe.execute': () => (fees ? { fee_check: VERDICT } : prepared()),
    });
    mockChain.broadcastRawTransaction.mockRejectedValueOnce(Object.assign(new Error('rejected by the node'), { outcome: 'rejected' }));
    await expect(execute()).rejects.toMatchObject({ outcome: 'rejected' });
    // Journaled before its broadcast: held under the execution's key.
    const held = await mockIntentStore.byKey(EXEC_KEY);
    expect(held).toMatchObject({ chainId: 100, nonce: 5 });
    expect(fake.sent('safe.executed')).toEqual([]);
    const first = mockChain.broadcastRawTransaction.mock.calls[0][1];

    // Again: the core prepares the send anew, but the held bytes go out,
    // unsigned anew; its new token is burnt unused.
    const state = await execute();
    expect(fake.sent('sign.transaction')).toHaveLength(1);
    expect(mockChain.broadcastRawTransaction.mock.calls[1][1]).toBe(first);
    expect(fake.sent('safe.executed').map((m) => m.params.hash)).toEqual([keccak256(first)]);
    expect(state.status).toBe('executed');
    await arrived();
    expect(fake.sent('approval.discard').map((m) => m.params.token)).toContain(`exec-${sends}`);

    // Held, and the core's check stops the fee: the bytes go again, nothing asked.
    await made.client.stop();
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': () => ({ fee_check: VERDICT }) });
    fees = true;
    const resent = await execute();
    expect(resent.status).toBe('executed');
    expect(fake.sent('sign.transaction')).toEqual([]);
    expect(mockChain.broadcastRawTransaction.mock.calls.at(-1)[1]).toBe(first);
  });

  test('safe.executed not answered: the error, and the next attempt tells it again, executing nothing', async () => {
    let fail = true;
    await setup({
      'safe.pending': { states: [READY] },
      'safe.executed': () => (fail ? { error: { code: 'core_unavailable', message: 'The identity core is restarting' } } : {}),
    });
    await expect(execute()).rejects.toThrow('restarting');
    fail = false;
    const heard = [];
    const stop = transactions.onSafeSendSettled((event) => heard.push(event));
    const state = await execute();
    expect(state).toMatchObject({ status: 'executed', executed: { hash: SENT_HASH() } });
    expect(fake.sent('safe.execute')).toHaveLength(1);
    expect(fake.sent('sign.transaction')).toHaveLength(1);
    expect(mockChain.broadcastRawTransaction).toHaveBeenCalledTimes(1);
    expect(fake.sent('safe.executed').map((m) => m.params.hash)).toEqual([SENT_HASH(), SENT_HASH()]);
    expect(heard).toEqual([{ safeIndex: 5, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: SENT_HASH() }]);
    stop();
  });

  test("a superseded SafeTx: the core's state returned, PR 6's record dropped, nothing signed", async () => {
    const SUPERSEDED = { ...READY, status: 'superseded' };
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': { superseded: { ...SUPERSEDED, durable: false } } });
    const dropped = jest.spyOn(coreSends.approvalRecords, 'dropped');
    expect(await execute()).toEqual(SUPERSEDED);
    expect(dropped).toHaveBeenCalledWith(5, SAFE_TX_HASH, 'superseded');
    expect(steps()).toEqual(['safe.pending', 'safe.execute']);
    expect(coreSends.cachedState(5)).toEqual(SUPERSEDED);
    dropped.mockRestore();
  });

  test("the core's send checked before the executor signs: another call, executor, Safe or calldata is refused, its token burnt", async () => {
    const wrong = [
      { ...SEND_TX, data: execData({ ...SAFE_TX, value: '2000' }) },
      { ...SEND_TX, data: execData(SAFE_TX, 1) },
      { ...SEND_TX, to: getAddress(TO) },
      { ...SEND_TX, value: '1' },
      { ...SEND_TX, chain_id: '1' },
      { ...SEND_TX, data: '0x' },
    ];
    let next = null;
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': () => next() });
    for (const tx of wrong) {
      next = () => prepared(tx);
      await expect(execute()).rejects.toThrow('another execution than the pending transaction');
    }
    next = () => ({ send: { ...prepared().send, account: 1 } });
    await expect(execute()).rejects.toThrow('another execution than the pending transaction');
    await arrived();
    expect(fake.sent('sign.transaction')).toEqual([]);
    expect(fake.sent('approval.discard')).toHaveLength(wrong.length + 1);
    expect(coreTokens.size).toBe(0);
  });

  test('refused before the core is asked: no SafeTx named, another on the board, a site\'s, a step running', async () => {
    await setup({ 'safe.pending': { states: [READY] } });
    await expect(transactions.executeSafePending(5)).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(execute({ safeTxHash: 'nope' })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await expect(execute({ safeTxHash: OTHER_HASH })).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
    await made.client.stop();
    coreSends._reset();
    await setup({ 'safe.pending': { states: [{ ...READY, display: { ...DISPLAY, site: 'https://app.example' } }] } });
    await expect(execute()).rejects.toMatchObject({ code: 'SAFE_UNSUPPORTED' });
    safeApprovals.beginStep(5);
    await expect(execute()).rejects.toMatchObject({ code: 'SAFE_BUSY' });
    safeApprovals.endStep(5);
    expect(fake.sent('safe.execute')).toEqual([]);
  });

  test("the core's refusal keeps its code: nothing signed, the step ended", async () => {
    await setup({ 'safe.pending': { states: [READY] }, 'safe.execute': refusal('nonce_behind') });
    await expect(execute()).rejects.toMatchObject({ code: 'SAFE_NONCE_BEHIND' });
    expect(fake.sent('sign.transaction')).toEqual([]);
    expect(safeApprovals.stepRunning(5)).toBe(false);
  });
});

describe('what waits for later PRs is refused, nothing sent', () => {
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
