/**
 * safe-service.js on the core's Safe backend (freedom-core design 0016,
 * SAFE-3's PR 3; core-accounts.js), against a scripted core that reads each
 * `safe.*` request as cored-v0.32.0 does (test/helpers/fake-safe-core.js),
 * through the real CoreClient, vault-backend, signers and
 * signing-confirmation:
 * - create is `safe.create`, and status `safe.status` with its `setup`,
 *   passed on as the core gives it: deployed or not, a setup changed or
 *   unverified reported, never thrown;
 * - activation is `safe.deploy`, then `sign.transaction` presenting `{
 *   token, kind: "executor-send" }` for exactly the core's transaction and
 *   a nonce, then the journal under `deployIntentKey`, then the broadcast,
 *   then the receipt and `safe.deployed`; the fee the core's check stopped
 *   shown on the card first, its confirmation (the ask's ID, bound to its
 *   chrome) then asked in the approvals document (the card's alone with it
 *   off) before `safe.deploy { fee_ack: true }`; a held deployment sent again; a failed
 *   broadcast, a failed receipt and an unverified deployment;
 * - on js nothing reaches the core, and no hello declares `safe3` (the
 *   core's backend's does, SAFE-3's PR 7: the activation above passes
 *   under it, a deployment signed only with its `executor-send` token).
 * The journal and the broadcast are transaction-service's (scripted here
 * at tx-recorder's `signAndRecord`, which signs through the real signer).
 */

const { Transaction, keccak256, getAddress } = require('ethers');
const { ownerWallet } = require('./__tests__/helpers/test-owners');
const { startSafeCore } = require('../../../../test/helpers/fake-safe-core');

const SAFE_ADDRESS = '0x41aD4887971f90BB3fE4d83eCa65177281283261';
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const EXECUTOR = ownerWallet(0).address;
const TOKEN = 'executor-token-' + '5e'.repeat(16);
const INTENT_KEY = `safe-deploy:100:${SAFE_ADDRESS.toLowerCase()}`;

// Main's records: 0 a vault account, 2 a Ledger's, 4 a phone's; 5 a Safe of
// 0 and 2, 6 one with no vault owner.
const mockRecords = {
  0: { index: 0, name: 'Main Wallet', address: EXECUTOR, type: 'mnemonic' },
  1: { index: 1, name: 'Spare', address: ownerWallet(2).address, type: 'mnemonic' },
  2: { index: 2, name: 'My Stax', address: ownerWallet(2).address, type: 'ledger' },
  4: { index: 4, name: 'My Phone', address: ownerWallet(4).address, type: 'remote' },
  5: {
    index: 5,
    name: 'Joint',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [0, 2],
    threshold: 1,
    saltNonce: '7508',
    deployed: {},
  },
  6: {
    index: 6,
    name: 'Devices',
    address: SAFE_ADDRESS,
    type: 'safe',
    owners: [2, 4],
    threshold: 1,
    saltNonce: '9',
    deployed: {},
  },
};

const mockBackend = { kind: 'core' };
jest.mock('./safe-backend-kind', () => ({ safeBackendKind: () => mockBackend.kind }));

const mockCore = { client: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockCore.client,
  getLedgerRelay: () => null,
}));

const mockAddSafeWallet = jest.fn();
const mockMarkSafeDeployed = jest.fn();
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords[index] ?? null,
  isHardwareWalletIndex: () => false,
  recordLedgerAddressCheck: () => {},
  recordRemoteAddressCheck: () => {},
  addSafeWallet: (...args) => mockAddSafeWallet(...args),
  markSafeDeployed: (...args) => mockMarkSafeDeployed(...args),
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
jest.mock('../ledger/signer', () => ({ createLedgerBackend: () => ({}) }));
jest.mock('../remote/signer', () => ({ createRemoteBackend: () => ({}) }));

// Main's own chain reads, today's path only: none on the core.
const mockChainRequest = jest.fn();
jest.mock('../../networks/chain-data', () => ({ request: (...args) => mockChainRequest(...args) }));
const mockRpcRequest = jest.fn();
jest.mock('../provider-manager', () => ({
  getEip1193Provider: () => ({ request: (...args) => mockRpcRequest(...args) }),
}));

// Today's protocol-kit path, spied: none of it runs on the core.
const mockPredictSafeAddress = jest.fn(async () => SAFE_ADDRESS);
const mockBuildDeploymentTransaction = jest.fn(async () => ({
  safeAddress: SAFE_ADDRESS,
  to: FACTORY,
  value: '0',
  data: '0xdeadbeef',
}));
const mockDeploySafe = jest.fn(async () => ({
  safeAddress: SAFE_ADDRESS,
  tx: { hash: '0x' + 'ab'.repeat(32) },
}));
jest.mock('./safe-executor', () => ({
  ...jest.requireActual('./safe-executor'),
  predictSafeAddress: (...args) => mockPredictSafeAddress(...args),
  buildDeploymentTransaction: (...args) => mockBuildDeploymentTransaction(...args),
  deploySafe: (...args) => mockDeploySafe(...args),
}));

// The journal and the broadcast (transaction-service's `sendUnderKey`), as
// tx-recorder's `signAndRecord` runs them: a held intent's bytes again, or
// the signature through the real signer at main's nonce, its commit under
// the key, then the broadcast.
const events = [];
const journal = [];
const mockBroadcast = jest.fn(async () => {});
const mockSignAndRecord = jest.fn(async (params, signer, context, { intentKey }) => {
  const held = journal.find((entry) => entry.key === intentKey);
  if (held) {
    events.push('resend');
    return { hash: held.hash, resent: true, intentId: held.intentId };
  }
  const { buildTransaction } = require('../signing-utils');
  const raw = await signer.signTransaction(buildTransaction({ ...params, nonce: 7 }));
  const hash = keccak256(raw);
  const intentId = `intent-${journal.length + 1}`;
  journal.push({ key: intentKey, raw, hash, intentId, context });
  events.push('journal');
  await mockBroadcast(raw);
  events.push('broadcast');
  return { hash, intentId, nonce: 7, outcome: 'sent' };
});
const mockResendAndRecord = jest.fn(async (intentId) => {
  events.push('resend');
  return {
    hash: journal.find((entry) => entry.intentId === intentId).hash,
    resent: true,
    intentId,
  };
});
// A held deployment's speed-up (SAFE-3's PR 7), as tx-recorder's
// `replaceWithAndRecord` runs it: the given transaction signed through the
// real signer at the held intent's nonce, committed as its replacement, then
// broadcast (transaction-service.js `replaceIntentWith`, whose fee and
// payment checks intent-sends.test.js covers).
const mockReplaceWithAndRecord = jest.fn(async (intentId, params, signer) => {
  const held = journal.find((entry) => entry.intentId === intentId);
  const { buildTransaction } = require('../signing-utils');
  const raw = await signer.signTransaction(buildTransaction({ ...params, nonce: held.nonce ?? 7 }));
  const hash = keccak256(raw);
  held.replacements = [...(held.replacements ?? []), { raw, hash }];
  events.push('replace');
  await mockBroadcast(raw);
  events.push('broadcast');
  return { hash, intentId, nonce: held.nonce ?? 7, replaced: true, outcome: 'sent' };
});
jest.mock('../tx-recorder', () => ({
  signAndRecord: (...args) => mockSignAndRecord(...args),
  resendAndRecord: (...args) => mockResendAndRecord(...args),
  replaceWithAndRecord: (...args) => mockReplaceWithAndRecord(...args),
  KINDS: { SAFE_DEPLOY: 'safe-deploy' },
}));
const mockWaitForTransaction = jest.fn(async () => {
  events.push('receipt');
  return { status: 'confirmed', verified: true };
});
jest.mock('../transaction-service', () => ({
  estimateGas: jest.fn(async () => ({ gasLimit: '300000' })),
  getGasPrices: jest.fn(async () => ({
    type: 'eip1559',
    maxFeePerGas: '2000000000',
    maxPriorityFeePerGas: '1000000000',
  })),
  toFeeFields: jest.requireActual('../transaction-service').toFeeFields,
  waitForTransaction: (...args) => mockWaitForTransaction(...args),
  heldIntentFor: async (key) => journal.find((entry) => entry.key === key) ?? null,
}));

// The approvals document's panel (wallet-approvals.js), its prompts scripted.
const prompts = [];
const decisions = [];
// Run while a prompt waits, before its decision (once): another window's step.
const whilePrompted = { run: null };
const mockDocument = { on: true };
jest.mock('../../approvals/wallet-approvals', () => {
  const actual = jest.requireActual('../../approvals/wallet-approvals');
  let shared = null;
  return {
    ...actual,
    getWalletApprovals: () => {
      if (!mockDocument.on) return null;
      shared ??= actual.createWalletApprovals({
        walletPrompt: async (windowId, spec) => {
          prompts.push({ windowId, ...spec });
          const meanwhile = whilePrompted.run;
          whilePrompted.run = null;
          if (meanwhile) await meanwhile();
          return decisions.length ? decisions.shift() : { approve: true, choices: {} };
        },
        chromeWindowOf: (contents) => contents?.windowId ?? null,
        getDerivedWallets: async () => Object.values(mockRecords),
        chainName: () => 'Gnosis Chain',
        nativeSymbol: () => 'xDAI',
        checkFees: async () => {
          throw new Error('main judges no fee of the core’s');
        },
        checkAtApproval: async () => {
          throw new Error('main judges no fee of the core’s');
        },
      });
      return shared;
    },
  };
});

const service = require('./safe-service');
const kinds = require('../../../renderer/approvals/approvals-kinds.js');

// Two chrome windows' webContents: an ask is bound to the one it was shown in.
const CHROME = { id: 41, windowId: 3 };
const OTHER_CHROME = { id: 42, windowId: 4 };
const DEPLOY_TX = Object.freeze({
  type: 2,
  chain_id: '100',
  gas_limit: '300000',
  to: FACTORY,
  value: '0',
  data: '0x1688f0b9' + '00'.repeat(36),
  max_fee_per_gas: '2000000000',
  max_priority_fee_per_gas: '1000000000',
});
const SEND = Object.freeze({
  send: { kind: 'executor-send', account: 0, tx: DEPLOY_TX, token: TOKEN },
});
const VERDICT = Object.freeze({
  maxCost: '600000000000000',
  comparable: false,
  ratio: null,
  above: false,
  oneEndpoint: false,
  basis: null,
  autoApprove: false,
  askAgain: false,
});
const NOT_DEPLOYED = Object.freeze({
  deployed: false,
  chainId: 100,
  executorIndex: 0,
  executorAddress: EXECUTOR,
  executorBalance: '1200000000000000',
  estimatedCost: '720000000000000',
  needsFunds: false,
  setup: { state: 'not_deployed' },
});
const DEPLOYED = Object.freeze({
  ...NOT_DEPLOYED,
  deployed: true,
  executorBalance: null,
  estimatedCost: null,
  setup: { state: 'unchanged' },
});

/** The core's refusal of a Safe step: `invalid_argument` with `data.safe`. */
const refused = (safe, message) => ({
  error: { code: 'invalid_argument', message, data: { safe } },
});

/** A vault key's signature, as the core makes it. */
function signAsCore({ key, tx }) {
  const fields = {
    type: tx.type,
    chainId: BigInt(tx.chain_id),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas_limit),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
  };
  if (tx.type === 2) {
    fields.maxFeePerGas = BigInt(tx.max_fee_per_gas);
    fields.maxPriorityFeePerGas = BigInt(tx.max_priority_fee_per_gas);
  } else {
    fields.gasPrice = BigInt(tx.gas_price);
  }
  const signed = Transaction.from(fields);
  signed.signature = ownerWallet(key.index).signingKey.sign(signed.unsignedHash);
  return { raw: signed.serialized, hash: signed.hash };
}

// The test's answers by method (each `(message, core) => answer`), and the
// key store's own: addresses and signatures for the vault's accounts.
let answers = {};
function script(message, core) {
  if (message.method.startsWith('safe.') || message.method.startsWith('sign.')) {
    events.push(message.method);
  }
  const answer = answers[message.method];
  if (answer) return typeof answer === 'function' ? answer(message, core) : answer;
  switch (message.method) {
    case 'keys.addresses':
      return {
        user_wallets: message.params.accounts.map((index) => ({
          index,
          address: ownerWallet(index).address,
        })),
        publishers: [],
      };
    case 'sign.transaction':
      return signAsCore(message.params);
    case 'approval.discard':
      return {};
    default:
      return { error: { code: 'unknown_method', message: `unscripted ${message.method}` } };
  }
}

/** Answers one call after another, then the last again. */
const inTurn =
  (...list) =>
  () =>
    list.length > 1 ? list.shift() : list[0];

let made;
let core;

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockBackend.kind = 'core';
  mockDocument.on = true;
  answers = {};
  events.length = 0;
  journal.length = 0;
  prompts.length = 0;
  decisions.length = 0;
  whilePrompted.run = null;
  jest.clearAllMocks();
  mockChainRequest.mockReset();
  mockRpcRequest.mockReset();
  made = await startSafeCore({ script, log: { info: () => {}, warn: () => {}, error: () => {} } });
  core = made.cores[0];
  mockCore.client = made.client;
  require('../../core/vault-backend')._internal.reset();
  require('../signing-confirmation')._reset();
});

afterEach(async () => {
  await made?.client.stop();
  mockCore.client = null;
  jest.restoreAllMocks();
});

/** What main sent of `method`: `{ context, params }` each. */
const sent = (method) => core.sent(method).map(({ context, params }) => ({ context, params }));
const SHELL = { caller: 'shell' };

/** Main's own chain reads and today's path: none on the core. */
function expectNothingOfTodays() {
  expect(mockChainRequest).not.toHaveBeenCalled();
  expect(mockRpcRequest).not.toHaveBeenCalled();
  expect(mockPredictSafeAddress).not.toHaveBeenCalled();
  expect(mockBuildDeploymentTransaction).not.toHaveBeenCalled();
  expect(mockDeploySafe).not.toHaveBeenCalled();
  expect(mockAddSafeWallet).not.toHaveBeenCalled();
  expect(mockMarkSafeDeployed).not.toHaveBeenCalled();
}

describe('create, on the core', () => {
  test("is safe.create as main's own: the core's record, nothing computed or read by main", async () => {
    const wallet = {
      index: 9,
      name: 'Team',
      type: 'safe',
      address: SAFE_ADDRESS,
      owners: [0, 2],
      threshold: 1,
    };
    answers['safe.create'] = { wallet };
    await expect(
      service.createSafeAccount({ name: 'Team', ownerIndexes: [0, 2], threshold: 1 })
    ).resolves.toEqual(wallet);
    expect(sent('safe.create')).toEqual([
      { context: SHELL, params: { name: 'Team', owners: [0, 2], threshold: 1 } },
    ]);
    expect(core.refused).toEqual([]);
    expectNothingOfTodays();
  });

  test("a refusal keeps the core's code", async () => {
    answers['safe.create'] = {
      error: {
        code: 'invalid_argument',
        message: 'Check this Ledger account on the device first',
        data: { code: 'LEDGER_ACCOUNT_UNCHECKED' },
      },
    };
    await expect(
      service.createSafeAccount({ name: '', ownerIndexes: [0, 2], threshold: 1 })
    ).rejects.toMatchObject({
      code: 'LEDGER_ACCOUNT_UNCHECKED',
      message: 'Check this Ledger account on the device first',
    });
    expect(sent('safe.create')[0].params).toEqual({ name: '', owners: [0, 2], threshold: 1 });
    expectNothingOfTodays();
  });
});

describe('status, on the core', () => {
  test('a Safe not deployed: the activation priced by the core, its setup not_deployed', async () => {
    answers['safe.status'] = NOT_DEPLOYED;
    await expect(service.getSafeStatus(5)).resolves.toEqual(NOT_DEPLOYED);
    expect(sent('safe.status')).toEqual([{ context: SHELL, params: { safe: 5 } }]);
    expectNothingOfTodays();
  });

  test('a deployed Safe: its setup as the core read it; a changed one is reported, not thrown', async () => {
    answers['safe.status'] = DEPLOYED;
    await expect(service.getSafeStatus(5)).resolves.toEqual(DEPLOYED);
    const changed = { ...DEPLOYED, setup: { state: 'changed', changed: ['owners', 'threshold'] } };
    answers['safe.status'] = changed;
    await expect(service.getSafeStatus(5)).resolves.toEqual(changed);
    // Reported deployed from an unverified answer: passed on as the core says.
    const session = {
      ...DEPLOYED,
      setup: { state: 'unverified', read: 'code', why: 'unverified' },
    };
    answers['safe.status'] = session;
    await expect(service.getSafeStatus(5)).resolves.toEqual(session);
    expect(sent('safe.status')).toHaveLength(3);
    expectNothingOfTodays();
  });

  // SAFE-3's PR 9: the board of the Safe's pending transaction hears it.
  test("what it read of the setup goes on the pending transaction's board: changed, until it reads unchanged", async () => {
    const coreSends = require('./core-sends');
    const noted = jest.spyOn(coreSends, 'noteSetup');
    answers['safe.status'] = { ...DEPLOYED, setup: { state: 'changed', changed: ['owners'] } };
    await service.getSafeStatus(5);
    answers['safe.status'] = DEPLOYED;
    await service.getSafeStatus(5);
    expect(noted.mock.calls).toEqual([
      [5, { state: 'changed', changed: ['owners'] }],
      [5, { state: 'unchanged' }],
    ]);
    noted.mockRestore();
  });

  test("a code read nothing answered is the core's refusal, SAFE_UNVERIFIED; a non-Safe asks nothing", async () => {
    answers['safe.status'] = refused(
      'unverified',
      "Freedom couldn't verify on Gnosis whether this account is activated. Try again, or add an RPC provider in Settings."
    );
    await expect(service.getSafeStatus(5)).rejects.toMatchObject({
      code: 'SAFE_UNVERIFIED',
      message: /couldn't verify/,
    });
    await expect(service.getSafeStatus(0)).rejects.toThrow(/not a Safe/);
    expect(sent('safe.status')).toHaveLength(1);
    expectNothingOfTodays();
  });
});

describe("a held activation's speed-up, on the core (SAFE-3's PR 7)", () => {
  // The deployment held under its key: signed at nonce 7 at the old fee,
  // its broadcast's fate unknown.
  const OLD_RAW = '0x02';
  function holdDeployment() {
    journal.push({ key: INTENT_KEY, raw: OLD_RAW, hash: '0x' + 'cd'.repeat(32), intentId: 'intent-held', nonce: 7, context: {} });
  }
  // The core's deployment now: its own estimate and quote, its token.
  const FASTER = Object.freeze({
    send: {
      kind: 'executor-send',
      account: 0,
      tx: { ...DEPLOY_TX, gas_limit: '310000', max_fee_per_gas: '3000000000', max_priority_fee_per_gas: '1500000000' },
      token: TOKEN,
    },
  });
  // The core's verdict on that offer: its most, 310000 × 3 gwei.
  const FASTER_VERDICT = Object.freeze({ ...VERDICT, maxCost: '930000000000000' });

  test("safe.deploy's send at the core's quote, signed with its executor-send token at the held nonce as the intent's replacement; the receipt; safe.deployed", async () => {
    holdDeployment();
    answers['safe.deploy'] = FASTER;
    answers['safe.deployed'] = { deployed: true };
    const result = await service.activateSafe(5, { speedUp: true, sender: CHROME });

    expect(events).toEqual(['safe.deploy', 'sign.transaction', 'replace', 'broadcast', 'receipt', 'safe.deployed']);
    // Exactly the core's transaction, at the held deployment's nonce, under
    // its token: never the journal's intent-replace, which the core refuses
    // for a deployment under `safe3`.
    expect(core.hello.safe3).toBe(true);
    expect(sent('sign.transaction')).toEqual([
      {
        context: SHELL,
        params: {
          key: { kind: 'account', index: 0 },
          tx: { ...FASTER.send.tx, nonce: '7' },
          authorization: { token: TOKEN, kind: 'executor-send' },
        },
      },
    ]);
    expect(mockReplaceWithAndRecord.mock.calls[0][0]).toBe('intent-held');
    expect(mockReplaceWithAndRecord.mock.calls[0][1]).toEqual({
      to: FACTORY,
      value: '0',
      data: DEPLOY_TX.data,
      chainId: 100,
      gasLimit: '310000',
      maxFeePerGas: '3000000000',
      maxPriorityFeePerGas: '1500000000',
    });
    const [replacement] = journal[0].replacements;
    expect(Transaction.from(replacement.raw).nonce).toBe(7);
    // Not sent again as it was, nor signed as a new intent.
    expect(mockResendAndRecord).not.toHaveBeenCalled();
    expect(mockSignAndRecord).not.toHaveBeenCalled();
    expect(sent('safe.deployed')).toEqual([{ context: SHELL, params: { safe: 5, hash: replacement.hash } }]);
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: replacement.hash });
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
    expect(core.refused).toEqual([]);
    expect(core.sent('approval.issue')).toEqual([]);
  });

  test('its fee asked as an activation\'s when the core\'s check stops it: in the panel, then fee_ack; the held bytes are not what goes', async () => {
    holdDeployment();
    answers['safe.deploy'] = inTurn({ fee_check: FASTER_VERDICT }, FASTER);
    answers['safe.deployed'] = { deployed: true };
    await service.activateSafe(5, { speedUp: true, sender: CHROME });
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([{ safe: 5 }, { safe: 5, fee_ack: true }]);
    expect(prompts.map((p) => p.kind)).toEqual(['wallet.executor_send']);
    expect(events).toContain('replace');
    expect(mockResendAndRecord).not.toHaveBeenCalled();
  });

  test("with the document off, the card's ask: its ID back, twice above the threshold", async () => {
    mockDocument.on = false;
    holdDeployment();
    const above = { ...FASTER_VERDICT, comparable: true, ratio: '20', above: true, askAgain: true };
    answers['safe.deploy'] = inTurn({ fee_check: above }, FASTER);
    answers['safe.deployed'] = { deployed: true };
    const first = await service.activateSafe(5, { speedUp: true, sender: CHROME }).catch((e) => e);
    expect(first).toMatchObject({ code: 'FEE_CHECK_NEEDS_CONFIRMATION', feeAskAgain: false });
    const again = await service
      .activateSafe(5, { speedUp: true, sender: CHROME, feeAskId: first.feeAskId })
      .catch((e) => e);
    expect(again).toMatchObject({ code: 'FEE_CHECK_NEEDS_CONFIRMATION', feeAskAgain: true });
    expect(events).not.toContain('sign.transaction');
    const result = await service.activateSafe(5, { speedUp: true, sender: CHROME, feeAskId: again.feeAskId });
    expect(result.hash).toBe(journal[0].replacements[0].hash);
    expect(sent('safe.deploy').map(({ params }) => params).at(-1)).toEqual({ safe: 5, fee_ack: true });
  });

  test('with nothing held, nothing to speed up: refused before anything is asked', async () => {
    await expect(service.activateSafe(5, { speedUp: true, sender: CHROME })).rejects.toThrow(
      'This account has no activation waiting to speed up'
    );
    expect(events).toEqual([]);
    expect(core.requests.filter((m) => m.method.startsWith('safe.'))).toEqual([]);
  });

  test('a speed-up the replacement refuses (its fee not high enough yet): its code passes, the token burnt', async () => {
    holdDeployment();
    answers['safe.deploy'] = FASTER;
    mockReplaceWithAndRecord.mockRejectedValueOnce(
      Object.assign(new Error('A replacement must raise the fee by at least 10%.'), { code: 'INTENT_FEE_TOO_LOW' })
    );
    await expect(service.activateSafe(5, { speedUp: true, sender: CHROME })).rejects.toMatchObject({
      code: 'INTENT_FEE_TOO_LOW',
    });
    expect(sent('safe.deployed')).toEqual([]);
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
  });
});

describe('activate, on the core', () => {
  test('safe.deploy, sign.transaction with its executor-send token, the journal, the broadcast, the receipt, safe.deployed', async () => {
    answers['safe.deploy'] = SEND;
    answers['safe.deployed'] = { deployed: true };

    const result = await service.activateSafe(5, { sender: CHROME });

    expect(events).toEqual([
      'safe.deploy',
      'sign.transaction',
      'journal',
      'broadcast',
      'receipt',
      'safe.deployed',
    ]);
    expect(sent('safe.deploy')).toEqual([{ context: SHELL, params: { safe: 5 } }]);
    // Exactly the core's transaction, the nonce the one field main added,
    // under its token, as main's own.
    expect(sent('sign.transaction')).toEqual([
      {
        context: SHELL,
        params: {
          key: { kind: 'account', index: 0 },
          tx: { ...DEPLOY_TX, nonce: '7' },
          authorization: { token: TOKEN, kind: 'executor-send' },
        },
      },
    ]);
    // Journaled under the deployment's key, as today's activation is, and
    // recorded as the executor's payment for the Safe.
    expect(journal).toHaveLength(1);
    expect(journal[0].key).toBe(INTENT_KEY);
    expect(mockSignAndRecord.mock.calls[0][2]).toEqual({
      kind: 'safe-deploy',
      toAddress: SAFE_ADDRESS,
      amount: '0',
      metadata: { safeAddress: SAFE_ADDRESS, executor: EXECUTOR },
    });
    const signed = Transaction.from(journal[0].raw);
    expect(signed.from).toBe(EXECUTOR);
    expect(getAddress(signed.to)).toBe(FACTORY);
    expect(mockBroadcast).toHaveBeenCalledWith(journal[0].raw);
    expect(mockWaitForTransaction).toHaveBeenCalledWith(journal[0].hash, 100);
    expect(sent('safe.deployed')).toEqual([
      { context: SHELL, params: { safe: 5, hash: journal[0].hash } },
    ]);
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: journal[0].hash });
    // The token burnt once the send ended; nothing asked; main marks nothing.
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
    expect(prompts).toEqual([]);
    expect(core.refused).toEqual([]);
    expectNothingOfTodays();
  });

  test('already deployed: nothing signed or sent', async () => {
    answers['safe.deploy'] = { deployed: true };
    await expect(service.activateSafe(5)).resolves.toEqual({
      safeAddress: SAFE_ADDRESS,
      alreadyDeployed: true,
    });
    expect(events).toEqual(['safe.deploy']);
    expect(journal).toEqual([]);
    expectNothingOfTodays();
  });

  test("nothing can pay: the core's SAFE_NEEDS_FUNDS, nothing signed", async () => {
    answers['safe.deploy'] = refused(
      'SAFE_NEEDS_FUNDS',
      `Fund ${EXECUTOR} with at least 0.00072 xDAI to activate`
    );
    await expect(service.activateSafe(5)).rejects.toMatchObject({ code: 'SAFE_NEEDS_FUNDS' });
    expect(events).toEqual(['safe.deploy']);
    expect(mockSignAndRecord).not.toHaveBeenCalled();
  });

  test("the fee check: the core's verdict on the card first, as on js; its confirmation asked in the panel, then safe.deploy { fee_ack: true }, then the send", async () => {
    answers['safe.deploy'] = inTurn({ fee_check: VERDICT }, SEND);
    answers['safe.deployed'] = { deployed: true };

    // The card shows the verdict under the ask's ID: nothing asked in the
    // panel, nothing signed, no fee_ack yet.
    const ask = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    expect(ask).toMatchObject({ feeCheck: VERDICT, feeAskAgain: false });
    expect(prompts).toEqual([]);
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([{ safe: 5 }]);
    expect(core.sent('sign.transaction')).toEqual([]);

    // The card's confirmation: the panel asks, then the fee_ack.
    const result = await service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId });

    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([
      { safe: 5 },
      { safe: 5, fee_ack: true },
    ]);
    expect(prompts).toHaveLength(1);
    const [prompt] = prompts;
    expect(prompt.windowId).toBe(3);
    expect(prompt.kind).toBe('wallet.executor_send');
    expect(prompt.view).toMatchObject({
      account: { index: 0, name: 'Main Wallet', address: EXECUTOR, type: 'mnemonic' },
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: SAFE_ADDRESS },
      fee: null,
      feeCheck: { maxCost: VERDICT.maxCost, comparable: false, above: false },
      feeAskAgain: false,
    });
    const message = {
      handle: 'c'.repeat(64),
      revision: 1,
      guest: null,
      kind: prompt.kind,
      site: { key: 'freedom:wallet', label: 'Your wallet' },
      view: prompt.view,
    };
    expect(kinds.checkMessage(message).valid).toBe(true);
    expect(events).toEqual([
      'safe.deploy',
      'safe.deploy',
      'sign.transaction',
      'journal',
      'broadcast',
      'receipt',
      'safe.deployed',
    ]);
    expect(sent('sign.transaction')[0].params.authorization).toEqual({
      token: TOKEN,
      kind: 'executor-send',
    });
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: journal[0].hash });
    // Main minted nothing: the only token is the core's, burnt after.
    expect(core.sent('approval.issue')).toEqual([]);
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
  });

  test('a fee above the threshold is asked twice; a rejection sends no fee_ack and signs nothing', async () => {
    const above = {
      ...VERDICT,
      comparable: true,
      ratio: '5',
      above: true,
      basis: 'quote',
      askAgain: true,
    };
    answers['safe.deploy'] = inTurn({ fee_check: above }, SEND);
    answers['safe.deployed'] = { deployed: true };
    // One press on the card: the panel, not the card, asks twice.
    const shown = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    expect(shown.feeAskAgain).toBe(false);
    await service.activateSafe(5, { sender: CHROME, feeAskId: shown.feeAskId });
    expect(prompts.map((prompt) => prompt.view.feeAskAgain)).toEqual([false, true]);
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([
      { safe: 5 },
      { safe: 5, fee_ack: true },
    ]);

    events.length = 0;
    prompts.length = 0;
    journal.length = 0;
    core.requests.length = 0;
    answers['safe.deploy'] = { fee_check: VERDICT };
    decisions.push({ approve: false, choices: {} });
    const rejected = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: rejected.feeAskId })
    ).rejects.toMatchObject({
      code: 'USER_REJECTED',
      message: 'User rejected the request',
    });
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([{ safe: 5 }]);
    expect(events).toEqual(['safe.deploy']);
    expect(journal).toEqual([]);
    // The rejected ask's ID is spent: pressed again, it confirms nothing.
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: rejected.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(prompts).toHaveLength(1);
  });

  test('a locked vault is unlocked before the fee is asked', async () => {
    answers['safe.deploy'] = { fee_check: VERDICT };
    answers['keys.addresses'] = { error: { code: 'vault_locked', message: 'Vault is locked' } };
    await expect(service.activateSafe(5, { sender: CHROME })).rejects.toMatchObject({
      code: 'vault_locked',
    });
    expect(prompts).toEqual([]);
    expect(sent('safe.deploy')).toHaveLength(1);
  });

  test('a fee that keeps changing is asked at most three times: the card first, then the panel', async () => {
    answers['safe.deploy'] = { fee_check: VERDICT };
    const ask = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId })
    ).rejects.toThrow(/kept changing/);
    expect(prompts).toHaveLength(3);
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([
      { safe: 5 },
      { safe: 5, fee_ack: true },
      { safe: 5, fee_ack: true },
      { safe: 5, fee_ack: true },
    ]);
    expect(core.sent('sign.transaction')).toEqual([]);
  });

  /** The card's ask (approvals document off) an activation ends with. */
  async function cardAsk(promise) {
    const err = await promise.catch((e) => e);
    expect(err).toMatchObject({
      code: 'FEE_CHECK_NEEDS_CONFIRMATION',
      feeCheck: expect.any(Object),
    });
    expect(typeof err.feeAskId).toBe('string');
    expect(err.offer).toBeUndefined();
    return err;
  }
  const deploys = () => sent('safe.deploy').map(({ params }) => params);

  test('with the approvals document off: the card asks under an ID, and its confirmation returns it, with no token of its own', async () => {
    mockDocument.on = false;
    answers['safe.deploy'] = { fee_check: VERDICT };
    const ask = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    expect(ask).toMatchObject({ feeCheck: VERDICT, feeAskAgain: false });
    expect(core.sent('sign.transaction')).toEqual([]);

    answers['safe.deploy'] = SEND;
    answers['safe.deployed'] = { deployed: true };
    const result = await service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId });
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: journal[0].hash });
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5, fee_ack: true }]);
    expect(core.sent('approval.issue')).toEqual([]);

    // Its ID is spent: it confirms nothing again.
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(deploys()).toHaveLength(2);
  });

  test("a window's stale confirmation, after another window replaced the offer, is refused", async () => {
    mockDocument.on = false;
    answers['safe.deploy'] = { fee_check: VERDICT };
    const shownInA = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    // Window B activates the same Safe: the core's offer, and main's ask, are B's.
    const pricier = { ...VERDICT, maxCost: '900000000000000' };
    answers['safe.deploy'] = { fee_check: pricier };
    const shownInB = await cardAsk(service.activateSafe(5, { sender: OTHER_CHROME }));
    expect(shownInB.feeAskId).not.toBe(shownInA.feeAskId);

    answers['safe.deploy'] = SEND;
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: shownInA.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', message: /isn't the one shown/ });
    // B's ID from A's window is no confirmation either; nor is one for no ask.
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: shownInB.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    await expect(
      service.activateSafe(6, { sender: CHROME, feeAskId: shownInB.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    await expect(
      service.activateSafe(5, { sender: {}, feeAskId: shownInB.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5 }]);
    expect(core.sent('sign.transaction')).toEqual([]);

    // B's own confirmation stands; the send must be B's offer, which costs
    // what B was shown, and so this one (A's price) is refused, its token burnt.
    await expect(
      service.activateSafe(5, { sender: OTHER_CHROME, feeAskId: shownInB.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5 }, { safe: 5, fee_ack: true }]);
    expect(core.sent('sign.transaction')).toEqual([]);
    await new Promise(setImmediate);
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
  });

  test('a fee above the threshold: a single press is asked again under a new ID; the second press confirms it', async () => {
    mockDocument.on = false;
    const above = { ...VERDICT, comparable: true, ratio: '5', above: true, basis: 'quote' };
    answers['safe.deploy'] = { fee_check: above };
    const first = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    expect(first.feeAskAgain).toBe(false);

    const again = await cardAsk(
      service.activateSafe(5, { sender: CHROME, feeAskId: first.feeAskId })
    );
    expect(again).toMatchObject({ feeCheck: above, feeAskAgain: true });
    expect(again.feeAskId).not.toBe(first.feeAskId);
    // One press only: no fee_ack, and the first ID confirms nothing now.
    expect(deploys()).toEqual([{ safe: 5 }]);
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: first.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });

    answers['safe.deploy'] = SEND;
    answers['safe.deployed'] = { deployed: true };
    const result = await service.activateSafe(5, { sender: CHROME, feeAskId: again.feeAskId });
    expect(result).toEqual({ safeAddress: SAFE_ADDRESS, hash: journal[0].hash });
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5, fee_ack: true }]);
  });

  test("the asks are counted across the card's round trips: at most three", async () => {
    mockDocument.on = false;
    answers['safe.deploy'] = { fee_check: VERDICT };
    let ask = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    for (let i = 0; i < 2; i += 1) {
      ask = await cardAsk(service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId }));
    }
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId })
    ).rejects.toThrow(/kept changing/);
    expect(deploys()).toEqual([
      { safe: 5 },
      { safe: 5, fee_ack: true },
      { safe: 5, fee_ack: true },
      { safe: 5, fee_ack: true },
    ]);
    // The last ask is gone with it.
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: ask.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(core.sent('sign.transaction')).toEqual([]);
  });

  test("in the panel: another window's activation meanwhile leaves the approval confirming nothing", async () => {
    answers['safe.deploy'] = inTurn({ fee_check: VERDICT }, { fee_check: VERDICT }, SEND);
    answers['safe.deployed'] = { deployed: true };
    const shownInA = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    let other;
    whilePrompted.run = async () => {
      const shownInB = await cardAsk(service.activateSafe(5, { sender: OTHER_CHROME }));
      other = await service.activateSafe(5, { sender: OTHER_CHROME, feeAskId: shownInB.feeAskId });
    };
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: shownInA.feeAskId })
    ).rejects.toMatchObject({
      code: 'SIGNING_NOT_CONFIRMED',
    });
    // The other window's activation went through on its own approval; this
    // one's sent no fee_ack of its own.
    expect(other).toEqual({ safeAddress: SAFE_ADDRESS, hash: journal[0].hash });
    expect(prompts.map((prompt) => prompt.windowId)).toEqual([3, 4]);
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5 }, { safe: 5, fee_ack: true }]);
  });

  test("with the document on, an ID that isn't the ask main holds (made up, another chrome's, replaced, spent) is refused before anything is asked; a chrome's own confirmation is burnt unused", async () => {
    answers['safe.deploy'] = { deployed: true };
    await expect(
      service.activateSafe(5, {
        sender: CHROME,
        feeAskId: 'an-id-from-the-chrome',
        feeConfirmation: { confirmation: 'chrome-token' },
      })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED', message: /isn't the one shown/ });
    expect(deploys()).toEqual([]);
    await new Promise(setImmediate);
    expect(sent('approval.discard')).toEqual([
      { context: SHELL, params: { token: 'chrome-token' } },
    ]);

    answers['safe.deploy'] = { fee_check: VERDICT };
    const shownInA = await cardAsk(service.activateSafe(5, { sender: CHROME }));
    // Another chrome's press of A's ask, or one with no chrome.
    for (const sender of [OTHER_CHROME, {}]) {
      await expect(
        service.activateSafe(5, { sender, feeAskId: shownInA.feeAskId })
      ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    }
    // Another Safe's.
    await expect(
      service.activateSafe(6, { sender: CHROME, feeAskId: shownInA.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    // Window B activates meanwhile: A's ask is replaced, and its ID stale.
    const shownInB = await cardAsk(service.activateSafe(5, { sender: OTHER_CHROME }));
    await expect(
      service.activateSafe(5, { sender: CHROME, feeAskId: shownInA.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(prompts).toEqual([]);
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5 }]);

    // B's own: asked in B's panel; once taken, the ID confirms nothing again.
    answers['safe.deploy'] = SEND;
    answers['safe.deployed'] = { deployed: true };
    await service.activateSafe(5, { sender: OTHER_CHROME, feeAskId: shownInB.feeAskId });
    expect(prompts.map((prompt) => prompt.windowId)).toEqual([4]);
    expect(deploys()).toEqual([{ safe: 5 }, { safe: 5 }, { safe: 5, fee_ack: true }]);
    await expect(
      service.activateSafe(5, { sender: OTHER_CHROME, feeAskId: shownInB.feeAskId })
    ).rejects.toMatchObject({ code: 'SIGNING_NOT_CONFIRMED' });
    expect(deploys()).toHaveLength(3);
  });

  test('a deployment journaled before is sent again as it was: nothing signed, its new token burnt, no fee asked', async () => {
    answers['safe.deploy'] = SEND;
    answers['safe.deployed'] = { deployed: true };
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'dropped' });
    await expect(service.activateSafe(5)).rejects.toThrow(/failed on chain/);
    const [{ hash }] = journal;

    // Try again: the core prepares a new send; the held bytes go instead.
    events.length = 0;
    core.requests.length = 0;
    await expect(service.activateSafe(5)).resolves.toEqual({ safeAddress: SAFE_ADDRESS, hash });
    expect(events).toEqual(['safe.deploy', 'resend', 'receipt', 'safe.deployed']);
    expect(core.sent('sign.transaction')).toEqual([]);
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);

    // A fee the core stops meanwhile isn't asked: no new fee would be paid.
    events.length = 0;
    core.requests.length = 0;
    answers['safe.deploy'] = { fee_check: VERDICT };
    await expect(service.activateSafe(5, { sender: CHROME })).resolves.toEqual({
      safeAddress: SAFE_ADDRESS,
      hash,
    });
    expect(events).toEqual(['safe.deploy', 'resend', 'receipt', 'safe.deployed']);
    expect(mockResendAndRecord).toHaveBeenCalledWith(journal[0].intentId);
    expect(prompts).toEqual([]);
    expect(sent('safe.deploy').map(({ params }) => params)).toEqual([{ safe: 5 }]);
  });

  test('a failed broadcast: the error, no safe.deployed, the token burnt', async () => {
    answers['safe.deploy'] = SEND;
    mockBroadcast.mockRejectedValueOnce(
      Object.assign(new Error('Transaction not sent'), { code: 'NOT_SENT' })
    );
    await expect(service.activateSafe(5)).rejects.toMatchObject({ code: 'NOT_SENT' });
    expect(events).toEqual(['safe.deploy', 'sign.transaction', 'journal']);
    expect(core.sent('safe.deployed')).toEqual([]);
    expect(mockWaitForTransaction).not.toHaveBeenCalled();
    expect(sent('approval.discard')).toEqual([{ context: SHELL, params: { token: TOKEN } }]);
  });

  test('a failed receipt: no safe.deployed, nothing marked', async () => {
    answers['safe.deploy'] = SEND;
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'failed' });
    await expect(service.activateSafe(5)).rejects.toThrow(
      'Safe deployment transaction failed on chain'
    );
    expect(core.sent('safe.deployed')).toEqual([]);
    expectNothingOfTodays();
  });

  test('safe.deployed unverified, or not deployed: SAFE_UNVERIFIED, nothing marked by main', async () => {
    const text = /sent the activation, but couldn't verify/;
    for (const deployed of [
      { deployed: true, verified: false },
      { deployed: false },
      refused(
        'unverified',
        "Freedom sent the activation, but couldn't verify on Gnosis that it went through."
      ),
    ]) {
      journal.length = 0;
      answers['safe.deploy'] = SEND;
      answers['safe.deployed'] = deployed;
      await expect(service.activateSafe(5)).rejects.toMatchObject({
        code: 'SAFE_UNVERIFIED',
        message: text,
      });
    }
    expect(core.sent('safe.deployed')).toHaveLength(3);
    expectNothingOfTodays();
  });

  test("a send that isn't the executor's deployment is refused before a key is touched, its token burnt", async () => {
    for (const send of [
      { ...SEND.send, kind: 'dapp-send' },
      { ...SEND.send, account: 2 },
      { ...SEND.send, account: 1 },
      { ...SEND.send, tx: { ...DEPLOY_TX, chain_id: '1' } },
      { ...SEND.send, token: '' },
    ]) {
      answers['safe.deploy'] = { send };
      await expect(service.activateSafe(5)).rejects.toThrow("isn't one Freedom signs");
    }
    answers['safe.deploy'] = {};
    await expect(service.activateSafe(5)).rejects.toThrow("isn't one Freedom signs");
    await new Promise(setImmediate);
    expect(core.sent('sign.transaction')).toEqual([]);
    expect(core.sent('approval.discard')).toHaveLength(4);
    expect(mockSignAndRecord).not.toHaveBeenCalled();
  });
});

describe('on js', () => {
  test("nothing reaches the core: today's path runs", async () => {
    mockBackend.kind = 'js';
    mockAddSafeWallet.mockResolvedValueOnce({ index: 9, type: 'safe' });
    await service.createSafeAccount({ name: 'Team', ownerIndexes: [0, 2], threshold: 1 });
    expect(mockPredictSafeAddress).toHaveBeenCalled();
    expect(mockAddSafeWallet).toHaveBeenCalled();

    mockChainRequest.mockResolvedValue({ result: '0x', verified: true });
    mockRpcRequest.mockResolvedValue('0x' + (10n ** 18n).toString(16));
    await expect(service.getSafeStatus(5)).resolves.toMatchObject({
      deployed: false,
      executorIndex: 0,
      needsFunds: false,
    });
    mockWaitForTransaction.mockResolvedValueOnce({ status: 'confirmed', verified: true });
    await expect(service.activateSafe(5)).resolves.toEqual({
      safeAddress: SAFE_ADDRESS,
      hash: '0x' + 'ab'.repeat(32),
    });
    expect(mockDeploySafe).toHaveBeenCalled();
    expect(mockMarkSafeDeployed).toHaveBeenCalledWith(5, 100);
    expect(core.requests).toEqual([]);
  });

  test("the hello declares safe3 on the core's backend only, never on js", async () => {
    // This suite's client was made on the core's backend.
    expect(core.hello.safe3).toBe(true);
    await made.client.stop();
    mockBackend.kind = 'js';
    made = await startSafeCore({ script, log: { info: () => {}, warn: () => {}, error: () => {} } });
    mockCore.client = made.client;
    const jsCore = made.cores[0];
    expect(jsCore.hello).toBeTruthy();
    expect(Object.keys(jsCore.hello)).not.toContain('safe3');
    expect(JSON.stringify(jsCore.hello)).not.toMatch(/safe3/);
    expect(made.client.hello.safe3).toBe(false);
  });
});
