// A renderer can't steer the intent path (review of #706, M1): an intent key
// in a send request's context is dropped at the IPC boundary, so a request
// sends only what it authorized. Real dApp send handler, confirmations,
// tx-recorder, transaction-service, intent store and Safe executor; mocked
// permissions, chain data and signers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, Transaction, keccak256 } = require('ethers');

let mockUserData;
let mockSigners;
let mockPermission;
const mockRequest = jest.fn();
const mockBroadcast = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: { handle: jest.fn() },
  webContents: { getAllWebContents: () => [] },
}));
jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({}));
jest.mock('./rpc-manager', () => ({ getEffectiveRpcUrls: () => [] }));
jest.mock('./chains', () => ({
  getChain: () => null,
  getAllChains: () => [],
  getTxExplorerUrl: (chainId, hash) => `https://explorer.test/${chainId}/${hash}`,
}));
jest.mock('../networks/chain-data', () => ({
  request: (...args) => mockRequest(...args),
  broadcastRawTransaction: (...args) => mockBroadcast(...args),
  getFeeQuote: async () => ({ type: 'legacy', gasPrice: '1000000000' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('./signers', () => ({ getSigner: (index) => mockSigners[index] }));
jest.mock('../identity-manager', () => ({
  getWalletRecord: () => null,
  getActiveWalletIndex: () => 0,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('./provider-manager', () => ({
  testProvider: jest.fn(),
  getEip1193Provider: () => {
    throw new Error('unit tests must inject a provider');
  },
}));
jest.mock('better-sqlite3', () => require('../../../test/helpers/fake-better-sqlite3-payments'));
jest.mock('./dapp-permissions', () => ({
  getPermission: (site) =>
    site === mockPermission.site ? { walletIndex: mockPermission.walletIndex } : null,
  isTransactionAutoApproved: (site, to, selector, chainId) =>
    site === mockPermission.site &&
    to === mockPermission.to &&
    selector === mockPermission.selector &&
    chainId === mockPermission.chainId,
  addTransactionAutoApprove: jest.fn(),
  getSigningAutoApprove: () => false,
}));

jest.setTimeout(20000);

// Deterministic test keys (not real wallets).
const ALICE = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BOB = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const SITE = 'https://approved.test';
const CONTRACT = '0x' + '66'.repeat(20);

const signerFor = (wallet) => ({
  getAddress: jest.fn(async () => wallet.address),
  signTransaction: jest.fn((tx) => wallet.signTransaction(tx)),
});
const broadcasts = () => mockBroadcast.mock.calls.map(([, raw]) => Transaction.from(raw));

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-ipc-'));
  mockSigners = { 0: signerFor(ALICE), 1: signerFor(BOB) };
  mockRequest.mockReset().mockImplementation(async (_chainId, method) => {
    if (method === 'eth_getTransactionReceipt') {
      return { result: { status: '0x1', blockNumber: '0x1', gasUsed: '0x5208' }, source: 'direct' };
    }
    if (method === 'eth_estimateGas') return { result: '0x5208', source: 'direct' };
    if (method === 'eth_getTransactionCount') return { result: '0x7', source: 'direct' };
    throw new Error(`unexpected read ${method}`);
  });
  mockBroadcast.mockReset().mockImplementation(async (_chainId, raw) => ({
    result: keccak256(raw),
    source: 'direct',
  }));
});

afterEach(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

function start() {
  jest.resetModules();
  const { ipcMain } = require('electron');
  ipcMain.handle.mockClear();
  require('./wallet-ipc').registerWalletIpc();
  const handlers = Object.fromEntries(ipcMain.handle.mock.calls);
  return {
    dappSend: handlers['wallet:dapp-send-transaction'],
    walletSend: handlers['wallet:send-transaction'],
    store: require('./intent-store').getIntentStore(),
    safe: require('./safe/safe-executor'),
    confirmations: require('./signing-confirmation'),
  };
}

// Alice's Safe deployment on chain 100, held after a send that never left
// main: the intent a request must not be able to send again.
async function heldDeployment(running, safeAddress = '0x' + '5a'.repeat(20)) {
  mockBroadcast.mockImplementationOnce(async () => {
    throw Object.assign(new Error('Myotis is not ready'), { outcome: 'not_sent' });
  });
  await running.safe
    .deploySafe({
      owners: [ALICE.address],
      threshold: 1,
      saltNonce: '1',
      chainId: 100,
      executorIndex: 0,
      deployment: { safeAddress, to: '0x' + '4e'.repeat(20), data: '0x1688f0b9' },
    })
    .catch((error) => expect(error.outcome).toBe('not_sent'));
  const key = `safe-deploy:100:${safeAddress}`;
  const held = running.store.byKey(key);
  expect(held).toBeTruthy();
  return { key, held };
}

function authorize(running, how, walletIndex, tx) {
  mockPermission = {
    site: SITE,
    walletIndex,
    to: tx.to,
    selector: tx.data.slice(0, 10),
    chainId: tx.chainId,
  };
  return how === 'confirmed'
    ? { confirmation: running.confirmations.issueConfirmation('dapp-send', walletIndex, tx).token }
    : { autoApprove: SITE };
}

const call = (chainId) => ({
  chainId,
  to: CONTRACT,
  value: '0',
  data: '0xabcdef12',
  gasLimit: '21000',
  gasPrice: '1000000000',
});

describe.each(['confirmed', 'auto-approved'])(
  'a %s dApp send whose context names an intent key',
  (how) => {
    test("another account's request sends its own transaction, not the held one", async () => {
      // The review's probe: Bob's call on chain 1, naming Alice's deployment.
      const running = start();
      const { key, held } = await heldDeployment(running);
      const tx = call(1);
      const reply = await running.dappSend(
        {},
        tx,
        1,
        { intentKey: key, origin: SITE },
        authorize(running, how, 1, tx)
      );

      expect(reply).toMatchObject({ success: true, chainId: 1, from: BOB.address });
      expect(reply.intentId).not.toBe(held.intentId);
      const sent = broadcasts().at(-1);
      expect({ from: sent.from, chainId: sent.chainId, to: sent.to }).toEqual({
        from: BOB.address,
        chainId: 1n,
        to: CONTRACT,
      });
      expect(mockSigners[1].signTransaction).toHaveBeenCalledTimes(1);
      // Alice's deployment was not sent again.
      expect(running.store.get(held.intentId).handoffs).toHaveLength(1);
      expect(mockBroadcast).toHaveBeenCalledTimes(2);
    });

    test('the same account on another chain sends its own transaction, not the held one', async () => {
      const running = start();
      const { key, held } = await heldDeployment(running);
      const tx = call(1);
      const reply = await running.dappSend(
        {},
        tx,
        0,
        { intentKey: key, origin: SITE },
        authorize(running, how, 0, tx)
      );

      expect(reply).toMatchObject({ success: true, chainId: 1, from: ALICE.address });
      expect(reply.intentId).not.toBe(held.intentId);
      expect(broadcasts().at(-1).chainId).toBe(1n);
      expect(running.store.get(held.intentId).handoffs).toHaveLength(1);
    });

    test("a request can't reserve another workflow's key", async () => {
      const running = start();
      const future = '0x' + '7b'.repeat(20);
      const futureKey = `safe-deploy:100:${future}`;
      const tx = call(100);
      for (const name of ['intentKey', 'intent_key', 'key', 'KEY']) {
        const reply = await running.dappSend(
          {},
          tx,
          1,
          { [name]: futureKey, origin: SITE },
          authorize(running, how, 1, tx)
        );
        expect(reply.success).toBe(true);
        expect(running.store.get(reply.intentId).context.key).toBeNull();
      }
      expect(running.store.byKey(futureKey)).toBeNull();

      // The real deployment under that key later creates its own intent.
      const before = mockBroadcast.mock.calls.length;
      const { tx: deployed } = await running.safe.deploySafe({
        owners: [ALICE.address],
        threshold: 1,
        saltNonce: '1',
        chainId: 100,
        executorIndex: 0,
        deployment: { safeAddress: future, to: '0x' + '4e'.repeat(20), data: '0x1688f0b9' },
      });
      expect(deployed).toMatchObject({ outcome: 'sent', from: ALICE.address });
      expect(deployed.resent).toBeUndefined();
      expect(broadcasts()[before].from).toBe(ALICE.address);
    });
  }
);

test('the wallet send handler drops a renderer key too', async () => {
  const running = start();
  const { key, held } = await heldDeployment(running);
  const tx = {
    chainId: 100,
    to: BOB.address,
    value: '1',
    gasLimit: '21000',
    gasPrice: '1000000000',
  };
  const { token } = running.confirmations.issueConfirmation('wallet-send', 0, {
    ...tx,
    data: undefined,
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
  });
  const reply = await running.walletSend({}, tx, { intentKey: key }, { confirmation: token });
  expect(reply).toMatchObject({ success: true, from: ALICE.address, to: BOB.address });
  expect(reply.intentId).not.toBe(held.intentId);
  expect(running.store.get(held.intentId).handoffs).toHaveLength(1);
});

describe('held payments over IPC (4b)', () => {
  // The wallet and intent IPC as main registers them, plus a chrome window
  // that collects what main sends it.
  function startIntents() {
    const running = start();
    const sent = [];
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel) => sent.push(channel) },
    };
    require('./intent-ipc').registerIntentIpc({ windows: () => [win] });
    const handlers = Object.fromEntries(require('electron').ipcMain.handle.mock.calls);
    return {
      ...running,
      events: sent,
      confirm: (kind, index, payload) =>
        handlers['wallet:confirm-signing']({}, kind, index, payload),
      resend: (...args) => handlers['wallet:intent-resend']({}, ...args),
      list: () => handlers['wallet:intents-list']({}),
    };
  }

  const PAYMENT = {
    chainId: 100,
    to: BOB.address,
    value: '1000',
    gasLimit: '21000',
    gasPrice: '1000000000',
  };
  const asConfirmed = (tx) => ({
    ...tx,
    data: undefined,
    maxFeePerGas: undefined,
    maxPriorityFeePerGas: undefined,
  });

  async function refusedSend(running) {
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('insufficient funds for gas * price + value'), {
        outcome: 'rejected',
      });
    });
    const { token } = await running.confirm('wallet-send', null, asConfirmed(PAYMENT));
    return running.walletSend({}, PAYMENT, {}, { confirmation: token });
  }

  const bindingOf = (intent) => ({
    intentId: intent.intentId,
    chainId: intent.chainId,
    sender: intent.sender,
    nonce: intent.nonce,
    hash: intent.hash,
  });

  async function resendConfirmed(running, intent) {
    const { token } = await running.confirm('intent-resend', null, bindingOf(intent));
    return running.resend(intent.intentId, { confirmation: token });
  }

  test('refused for funds, topped up, sent again at its nonce, mined: the next send is not stuck', async () => {
    const running = startIntents();
    const refused = await refusedSend(running);

    // The refusal names its held payment (no bytes), its outcome and reason.
    expect(refused).toMatchObject({
      success: false,
      error: 'Insufficient funds for transaction',
      outcome: 'rejected',
      reasonClass: 'insufficient funds',
      intentId: expect.any(String),
      intent: {
        state: 'held',
        nonce: 7,
        chainId: 100,
        sender: ALICE.address.toLowerCase(),
        attention: 'refused',
        lastOutcome: { outcome: 'rejected', reasonClass: 'insufficient funds' },
        fields: expect.objectContaining({ to: BOB.address.toLowerCase(), value: '1000' }),
      },
    });
    expect(refused.intent.raw).toBeUndefined();
    const [firstRaw] = mockBroadcast.mock.calls.map(([, raw]) => raw);

    // Topped up: Send again sends the same signed bytes, at nonce 7.
    const again = await resendConfirmed(running, refused.intent);
    expect(again).toMatchObject({
      success: true,
      resent: true,
      nonce: 7,
      outcome: 'sent',
      intentId: refused.intentId,
      hash: refused.intent.hash,
      recorded: true,
    });
    expect(mockBroadcast.mock.calls[1][1]).toBe(firstRaw);
    expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls.filter(([, m]) => m === 'eth_getTransactionCount')).toHaveLength(
      1
    );

    // Mined: the account's pending count moves to 8, and the next payment
    // goes there, not behind a gap.
    mockRequest.mockImplementation(async (_chainId, method) => {
      if (method === 'eth_getTransactionCount') return { result: '0x8', source: 'direct' };
      if (method === 'eth_getTransactionReceipt') {
        return {
          result: { status: '0x1', blockNumber: '0x2', gasUsed: '0x5208' },
          source: 'direct',
        };
      }
      throw new Error(`unexpected read ${method}`);
    });
    const { token } = await running.confirm('wallet-send', null, asConfirmed(PAYMENT));
    const next = await running.walletSend({}, PAYMENT, {}, { confirmation: token });
    expect(next).toMatchObject({ success: true, nonce: 8, outcome: 'sent' });
    expect(next.intentId).not.toBe(refused.intentId);
  });

  test("a resend needs the intent's own confirmation, and nothing else will do", async () => {
    const running = startIntents();
    const refused = await refusedSend(running);
    const intent = refused.intent;
    const other = (await refusedSend(running)).intent;
    const attempts = [
      ['no authorization', null],
      ['an auto-approve claim', { autoApprove: SITE }],
      [
        'a confirmation of the transaction',
        async () => (await running.confirm('wallet-send', null, asConfirmed(PAYMENT))).token,
      ],
      [
        'a confirmation of another intent',
        async () => (await running.confirm('intent-resend', null, bindingOf(other))).token,
      ],
      [
        'another chain',
        async () =>
          (await running.confirm('intent-resend', null, { ...bindingOf(intent), chainId: 1 }))
            .token,
      ],
      [
        'another sender',
        async () =>
          (
            await running.confirm('intent-resend', null, {
              ...bindingOf(intent),
              sender: BOB.address,
            })
          ).token,
      ],
      [
        'another nonce',
        async () =>
          (await running.confirm('intent-resend', null, { ...bindingOf(intent), nonce: 8 })).token,
      ],
      [
        'another hash',
        async () =>
          (
            await running.confirm('intent-resend', null, {
              ...bindingOf(intent),
              hash: '0x' + '11'.repeat(32),
            })
          ).token,
      ],
    ];
    const broadcasts = mockBroadcast.mock.calls.length;
    for (const [name, authorization] of attempts) {
      const auth =
        typeof authorization === 'function'
          ? { confirmation: await authorization() }
          : authorization;
      const reply = await running.resend(intent.intentId, auth);
      expect({ name, reply }).toMatchObject({
        name,
        reply: { success: false, code: 'SIGNING_NOT_CONFIRMED' },
      });
    }
    expect(mockBroadcast.mock.calls.length).toBe(broadcasts);

    // The right confirmation works once.
    const { token } = await running.confirm('intent-resend', null, bindingOf(intent));
    await expect(running.resend(intent.intentId, { confirmation: token })).resolves.toMatchObject({
      success: true,
    });
    await expect(running.resend(intent.intentId, { confirmation: token })).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
    });
  });

  test('the resend handler takes no request fields: it sends the stored intent', async () => {
    const running = startIntents();
    const refused = await refusedSend(running);
    const { token } = await running.confirm('intent-resend', null, bindingOf(refused.intent));
    const reply = await running.resend(
      refused.intentId,
      { confirmation: token },
      { chainId: 1, to: CONTRACT }
    );
    expect(reply).toMatchObject({ success: true, chainId: 100, to: BOB.address });
    const sentAgain = broadcasts().at(-1);
    expect({ chainId: sentAgain.chainId, to: sentAgain.to }).toEqual({
      chainId: 100n,
      to: BOB.address,
    });
  });

  test("a dApp's held payment is sent again under the same rule", async () => {
    const running = startIntents();
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Myotis is not ready'), { outcome: 'not_sent' });
    });
    const tx = call(100);
    const failed = await running.dappSend(
      {},
      tx,
      1,
      { origin: SITE },
      authorize(running, 'confirmed', 1, tx)
    );
    expect(failed).toMatchObject({
      success: false,
      outcome: 'not_sent',
      intent: { kind: 'dapp-send', origin: SITE, attention: 'not-sent' },
    });
    await expect(resendConfirmed(running, failed.intent)).resolves.toMatchObject({
      success: true,
      from: BOB.address,
    });
  });

  test('a resend sends the bytes the user confirmed, even if a replacement lands meanwhile', async () => {
    const running = startIntents();
    const refused = await refusedSend(running);
    const reservations = require('./nonce-reservations');
    const { token } = await running.confirm('intent-resend', null, bindingOf(refused.intent));

    // A replacement holds the account while the resend waits for it.
    let release;
    const replacing = reservations.withAccountLock(
      { chainId: 100, sender: ALICE.address },
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const resending = running.resend(refused.intentId, { confirmation: token });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bumped = await ALICE.signTransaction({
      type: 0,
      chainId: 100,
      nonce: 7,
      to: BOB.address,
      value: 1000n,
      gasLimit: 21000n,
      gasPrice: 2000000000n,
    });
    await running.store.commit({
      intentId: refused.intentId,
      chainId: 100,
      sender: ALICE.address,
      nonce: 7,
      hash: keccak256(bumped),
      raw: bumped,
      via: 'replacement',
    });
    release();
    await replacing;

    await expect(resending).resolves.toMatchObject({ success: true, hash: refused.intent.hash });
    expect(keccak256(mockBroadcast.mock.calls.at(-1)[1])).toBe(refused.intent.hash);
  });

  test('unknown, settled and voided intents are refused', async () => {
    const running = startIntents();
    const refused = await refusedSend(running);
    await expect(
      running.resend('00000000-0000-4000-8000-000000000000', null)
    ).resolves.toMatchObject({
      success: false,
      code: 'INTENT_UNKNOWN',
    });

    await running.store.settle({
      intentId: refused.intentId,
      label: 'taken',
      hash: null,
      block: 9,
    });
    await expect(resendConfirmed(running, refused.intent)).resolves.toMatchObject({
      success: false,
      code: 'INTENT_NOT_HELD',
    });
  });

  test('the list holds summaries of held payments, never their bytes', async () => {
    const running = startIntents();
    const refused = await refusedSend(running);
    const { intents } = await running.list();
    expect(intents).toEqual([
      expect.objectContaining({ intentId: refused.intentId, nonce: 7, attention: 'refused' }),
    ]);
    expect(JSON.stringify(intents)).not.toContain(mockBroadcast.mock.calls[0][1].slice(2));
  });

  test('every change to the records reaches the chrome windows', async () => {
    const running = startIntents();
    await refusedSend(running);
    // commit, handoff, outcome
    expect(running.events).toEqual([
      'wallet:intents-changed',
      'wallet:intents-changed',
      'wallet:intents-changed',
    ]);
  });

  test('a successful send reports its intent and outcome, as before plus these', async () => {
    const running = startIntents();
    const { token } = await running.confirm('wallet-send', null, asConfirmed(PAYMENT));
    await expect(
      running.walletSend({}, PAYMENT, {}, { confirmation: token })
    ).resolves.toMatchObject({
      success: true,
      intentId: expect.any(String),
      outcome: 'sent',
      nonce: 7,
      recorded: true,
    });
  });
});
