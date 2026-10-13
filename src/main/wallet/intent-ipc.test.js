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
const mockFeeQuote = jest.fn();
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
  getFeeQuote: (...args) => mockFeeQuote(...args),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The finality tracker reads only while the core serves chain data.
jest.mock('../core/chain', () => ({ chainDriver: () => ({ client: { state: 'ready' } }) }));
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
  mockFeeQuote.mockReset().mockResolvedValue({ type: 'legacy', gasPrice: '1000000000' });
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

  // 709-B1: a refused resend must still say where its payment stands, so
  // the chrome keeps offering that payment at its nonce and never composes
  // a new one (which would sign nonce 8 while 7 stays held).
  describe('a refused resend still names its held payment (709-B1)', () => {
    test('a lapsed confirmation: refused with the payment as main holds it; a fresh one sends it, nothing signed', async () => {
      const running = startIntents();
      const failed = await refusedSend(running);
      let clock = 1_000_000;
      running.confirmations._setNow(() => clock);
      const { token } = await running.confirm('intent-resend', null, bindingOf(failed.intent));
      clock += running.confirmations.CONFIRMATION_TTL_MS;

      const expired = await running.resend(failed.intentId, { confirmation: token });
      expect(expired).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        intentId: failed.intentId,
        intent: { intentId: failed.intentId, state: 'held', nonce: 7, hash: failed.intent.hash },
      });
      expect(mockBroadcast).toHaveBeenCalledTimes(1);

      // Confirmed again as main reported it: the same bytes, at nonce 7.
      const again = await resendConfirmed(running, expired.intent);
      expect(again).toMatchObject({ success: true, nonce: 7, hash: failed.intent.hash });
      expect(mockBroadcast).toHaveBeenCalledTimes(2);
      expect(mockBroadcast.mock.calls[1][1]).toBe(mockBroadcast.mock.calls[0][1]);
      expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(1);
      expect(broadcasts().map((tx) => tx.nonce)).toEqual([7, 7]);
    });

    test("a replacement changed the payment's latest transaction: refused with its new hash, which a fresh confirmation sends", async () => {
      const running = startIntents();
      const failed = await refusedSend(running);
      const { token } = await running.confirm('intent-resend', null, bindingOf(failed.intent));
      const raw = await ALICE.signTransaction({
        type: 0,
        chainId: 100,
        nonce: 7,
        to: BOB.address,
        value: 1000n,
        gasLimit: 21000n,
        gasPrice: 2000000000n,
      });
      await running.store.commit({
        intentId: failed.intentId,
        chainId: 100,
        sender: ALICE.address,
        nonce: 7,
        hash: keccak256(raw),
        raw,
        via: 'replacement',
      });

      const stale = await running.resend(failed.intentId, { confirmation: token });
      expect(stale).toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        intent: { intentId: failed.intentId, state: 'held', nonce: 7, hash: keccak256(raw) },
      });
      expect(mockBroadcast).toHaveBeenCalledTimes(1);

      const again = await resendConfirmed(running, stale.intent);
      expect(again).toMatchObject({ success: true, nonce: 7, hash: keccak256(raw) });
      expect(mockBroadcast.mock.calls[1][1]).toBe(raw);
      expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(1);
    });

    test('every other refusal names the payment too: a refused broadcast, a failed write, no authorization', async () => {
      const running = startIntents();
      const failed = await refusedSend(running);
      const held = {
        intentId: failed.intentId,
        intent: { intentId: failed.intentId, state: 'held', nonce: 7 },
      };

      mockBroadcast.mockImplementationOnce(async () => {
        throw Object.assign(new Error('insufficient funds for gas * price + value'), {
          outcome: 'rejected',
        });
      });
      await expect(resendConfirmed(running, failed.intent)).resolves.toMatchObject({
        success: false,
        outcome: 'rejected',
        ...held,
      });

      // A failure with no intent on the error at all.
      const handoff = running.store.handoff;
      running.store.handoff = async () => {
        throw new Error('disk full');
      };
      await expect(resendConfirmed(running, failed.intent)).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('disk full'),
        ...held,
      });
      running.store.handoff = handoff;

      await expect(running.resend(failed.intentId, null)).resolves.toMatchObject({
        success: false,
        code: 'SIGNING_NOT_CONFIRMED',
        ...held,
      });
      expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(1);
    });

    test('only an intent main no longer holds, or never knew, comes back closed', async () => {
      const running = startIntents();
      const failed = await refusedSend(running);
      await running.store.settle({
        intentId: failed.intentId,
        label: 'taken',
        hash: null,
        block: 9,
      });
      await expect(resendConfirmed(running, failed.intent)).resolves.toMatchObject({
        success: false,
        code: 'INTENT_NOT_HELD',
        intent: { intentId: failed.intentId, state: 'settled' },
      });
      const unknown = await running.resend('7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1aff', null);
      expect(unknown).toMatchObject({ success: false, code: 'INTENT_UNKNOWN' });
      expect(unknown.intent).toBeUndefined();
    });

    test('a token is spent once: misuse and two presentations at once broadcast once', async () => {
      const running = startIntents();
      const first = await refusedSend(running);
      const second = await refusedSend(running);
      const { token } = await running.confirm('intent-resend', null, bindingOf(first.intent));
      expect((await running.resend(second.intentId, { confirmation: token })).code).toBe(
        'SIGNING_NOT_CONFIRMED'
      );
      expect((await running.resend(first.intentId, { confirmation: token })).code).toBe(
        'SIGNING_NOT_CONFIRMED'
      );
      const fresh = await running.confirm('intent-resend', null, bindingOf(first.intent));
      const replies = await Promise.all([
        running.resend(first.intentId, { confirmation: fresh.token }),
        running.resend(first.intentId, { confirmation: fresh.token }),
      ]);
      expect(replies.filter((reply) => reply.success)).toHaveLength(1);
      expect(replies.filter((reply) => reply.code === 'SIGNING_NOT_CONFIRMED')).toHaveLength(1);
      expect(mockBroadcast).toHaveBeenCalledTimes(3);
      expect(mockBroadcast.mock.calls[2][1]).toBe(mockBroadcast.mock.calls[0][1]);
      expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(2);
    });

    test('pages, internal pages and chrome sub-frames can neither mint, list nor resend', () => {
      const policy = require('../ipc-sender-policy');
      const event = (type, url, subframe = false) => {
        const mainFrame = { url };
        return {
          sender: { getType: () => type, mainFrame },
          senderFrame: subframe ? { url } : mainFrame,
        };
      };
      const chrome = new URL(`file://${policy.CHROME_INDEX}`).href;
      const settings = new URL(`file://${policy.PAGES_DIR}/settings.html`).href;
      for (const channel of [
        'wallet:confirm-signing',
        'wallet:intents-list',
        'wallet:intent-resend',
      ]) {
        expect(policy.isSenderAllowed(channel, event('webview', 'https://dapp.test/'))).toBe(false);
        expect(policy.isSenderAllowed(channel, event('webview', settings))).toBe(false);
        expect(policy.isSenderAllowed(channel, event('window', chrome, true))).toBe(false);
        expect(policy.isSenderAllowed(channel, event('window', chrome))).toBe(true);
      }
    });
  });
});

describe('replacement at the same nonce (9)', () => {
  function startReplacing() {
    const running = start();
    require('./intent-ipc').registerIntentIpc({ windows: () => [] });
    const handlers = Object.fromEntries(require('electron').ipcMain.handle.mock.calls);
    return {
      ...running,
      confirm: (kind, index, payload) =>
        handlers['wallet:confirm-signing']({}, kind, index, payload),
      list: () => handlers['wallet:intents-list']({}),
      fees: (intentId) => handlers['wallet:intent-replacement-fees']({}, intentId),
      replace: (...args) => handlers['wallet:intent-replace']({}, ...args),
    };
  }

  const PAYMENT = {
    chainId: 100,
    to: BOB.address,
    value: '1000',
    gasLimit: '21000',
    gasPrice: '1000000000',
  };

  async function heldBy(running, refusal) {
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error(refusal.message), { outcome: refusal.outcome });
    });
    const { token } = await running.confirm('wallet-send', null, {
      ...PAYMENT,
      data: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    });
    const reply = await running.walletSend({}, PAYMENT, {}, { confirmation: token });
    return reply.intent;
  }

  const UNDERPRICED = { message: 'transaction underpriced', outcome: 'rejected' };

  const replacementOf = (intent, fees) => ({
    intentId: intent.intentId,
    chainId: intent.chainId,
    sender: intent.sender,
    nonce: intent.nonce,
    to: intent.fields.to,
    value: intent.fields.value,
    data: intent.fields.data,
    gasLimit: intent.fields.gasLimit,
    ...fees,
  });

  async function replaceConfirmed(running, intent, fees) {
    const { token } = await running.confirm('intent-replace', null, replacementOf(intent, fees));
    return running.replace(intent.intentId, fees, { confirmation: token });
  }

  test('an underpriced refusal is offered a replacement: same payment, nonce and account, higher fee', async () => {
    const running = startReplacing();
    const intent = await heldBy(running, UNDERPRICED);
    expect(intent).toMatchObject({ replacement: 'replace', nonce: 7, walletIndex: 0 });

    const { fees } = await running.fees(intent.intentId);
    // At least 10% over 1 gwei, and at least today's quote (1 gwei).
    expect(fees).toEqual({ gasPrice: '1100000000' });

    const reply = await replaceConfirmed(running, intent, fees);
    expect(reply).toMatchObject({ success: true, replaced: true, nonce: 7, outcome: 'sent' });
    expect(reply.hash).not.toBe(intent.hash);
    const replacement = broadcasts().at(-1);
    expect({
      from: replacement.from,
      nonce: replacement.nonce,
      to: replacement.to,
      value: replacement.value,
      gasPrice: replacement.gasPrice,
    }).toEqual({
      from: ALICE.address,
      nonce: 7,
      to: BOB.address,
      value: 1000n,
      gasPrice: 1100000000n,
    });
    // The intent keeps both hashes at its one nonce; no pending read.
    expect(running.store.get(intent.intentId).hashes.map((entry) => entry.hash)).toEqual([
      intent.hash,
      reply.hash,
    ]);
    expect(mockRequest.mock.calls.filter(([, m]) => m === 'eth_getTransactionCount')).toHaveLength(
      1
    );
    // Its history row now names the replacement.
    const history = require('../payment-history');
    expect(history.getRecent({})).toEqual([
      expect.objectContaining({
        txHash: reply.hash,
        metadata: expect.objectContaining({ intentId: intent.intentId }),
      }),
    ]);
  });

  test('a fee raised by less than 10% is refused, with nothing signed', async () => {
    const running = startReplacing();
    const intent = await heldBy(running, UNDERPRICED);
    mockSigners[0].signTransaction.mockClear();
    for (const fees of [
      { gasPrice: '1050000000' },
      { maxFeePerGas: '9000000000', maxPriorityFeePerGas: '2000000000' },
    ]) {
      await expect(replaceConfirmed(running, intent, fees)).resolves.toMatchObject({
        success: false,
        code: 'INTENT_FEE_TOO_LOW',
      });
    }
    expect(mockSigners[0].signTransaction).not.toHaveBeenCalled();
    expect(running.store.get(intent.intentId).hashes).toHaveLength(1);
  });

  test('a replacement needs a confirmation of exactly that payment and those fees', async () => {
    const running = startReplacing();
    const intent = await heldBy(running, UNDERPRICED);
    const fees = { gasPrice: '1100000000' };
    mockSigners[0].signTransaction.mockClear();
    const tokenFor = async (payload) =>
      (await running.confirm('intent-replace', null, payload)).token;
    const attempts = [
      ['no authorization', null],
      [
        'other fees',
        { confirmation: await tokenFor(replacementOf(intent, { gasPrice: '1200000000' })) },
      ],
      [
        'another recipient',
        { confirmation: await tokenFor({ ...replacementOf(intent, fees), to: CONTRACT }) },
      ],
      [
        'another value',
        { confirmation: await tokenFor({ ...replacementOf(intent, fees), value: '1' }) },
      ],
      [
        'another nonce',
        { confirmation: await tokenFor({ ...replacementOf(intent, fees), nonce: 8 }) },
      ],
      [
        'a resend confirmation',
        {
          confirmation: (
            await running.confirm('intent-resend', null, {
              intentId: intent.intentId,
              chainId: 100,
              sender: intent.sender,
              nonce: 7,
              hash: intent.hash,
            })
          ).token,
        },
      ],
    ];
    for (const [name, authorization] of attempts) {
      const reply = await running.replace(intent.intentId, fees, authorization);
      expect({ name, reply }).toMatchObject({
        name,
        reply: { success: false, code: 'SIGNING_NOT_CONFIRMED' },
      });
    }
    expect(mockSigners[0].signTransaction).not.toHaveBeenCalled();
  });

  test('a payment that may be stuck is offered a speed-up; other refusals are not', async () => {
    const running = startReplacing();
    mockBroadcast.mockImplementationOnce(async (_chainId, raw) => ({
      result: keccak256(raw),
      source: 'direct',
      outcome: 'uncertain',
    }));
    const { token } = await running.confirm('wallet-send', null, {
      ...PAYMENT,
      data: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    });
    await running.walletSend({}, PAYMENT, {}, { confirmation: token });
    const funds = await heldBy(running, {
      message: 'insufficient funds for gas',
      outcome: 'rejected',
    });

    const { intents } = await running.list();
    expect(intents.map((intent) => [intent.attention, intent.replacement])).toEqual([
      ['uncertain', 'speed-up'],
      ['refused', null],
    ]);
    expect(funds.replacement).toBeNull();
  });

  test("an intent whose account isn't recorded can't be replaced", async () => {
    const running = startReplacing();
    // Committed by a caller that records no wallet index (as #706's sends did).
    const raw = await ALICE.signTransaction({
      type: 0,
      chainId: 100,
      nonce: 7,
      to: BOB.address,
      value: 1n,
      gasLimit: 21000n,
      gasPrice: 1000000000n,
    });
    const view = await running.store.commit({
      chainId: 100,
      sender: ALICE.address,
      nonce: 7,
      hash: keccak256(raw),
      raw,
      via: 'original',
      context: { kind: 'wallet-send' },
    });
    const { intents } = await running.list();
    expect(intents[0]).toMatchObject({ walletIndex: null, replacement: null });
    const fees = { gasPrice: '1100000000' };
    const { token } = await running.confirm(
      'intent-replace',
      null,
      replacementOf(intents[0], fees)
    );
    await expect(
      running.replace(view.intentId, fees, { confirmation: token })
    ).resolves.toMatchObject({
      success: false,
      code: 'INTENT_SIGNER_UNKNOWN',
    });
  });
});

describe('the list knows which payments are mined (6)', () => {
  test('a mined payment carries its receipt; a refused one has none', async () => {
    const running = start();
    require('./intent-ipc').registerIntentIpc({ windows: () => [] });
    const handlers = Object.fromEntries(require('electron').ipcMain.handle.mock.calls);
    const PAYMENT = {
      chainId: 100,
      to: BOB.address,
      value: '1000',
      gasLimit: '21000',
      gasPrice: '1000000000',
    };
    const send = async () => {
      const { token } = await handlers['wallet:confirm-signing']({}, 'wallet-send', null, {
        ...PAYMENT,
        data: undefined,
        maxFeePerGas: undefined,
        maxPriorityFeePerGas: undefined,
      });
      return running.walletSend({}, PAYMENT, {}, { confirmation: token });
    };
    const mined = await send();
    expect(mined).toMatchObject({ success: true });
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('insufficient funds for gas'), { outcome: 'rejected' });
    });
    const refused = await send();

    const history = require('../payment-history');
    let rows = [];
    for (let i = 0; i < 50 && !rows.some((row) => row.status === 'confirmed'); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      rows = history.getRecent({});
    }
    const { intents } = await handlers['wallet:intents-list']({});
    expect(intents.map((intent) => [intent.intentId, intent.receipt])).toEqual([
      [mined.intentId, 'confirmed'],
      [refused.intentId, null],
    ]);
  });
});

describe('replacement fees (9)', () => {
  function startReplacing() {
    const running = start();
    require('./intent-ipc').registerIntentIpc({ windows: () => [] });
    const handlers = Object.fromEntries(require('electron').ipcMain.handle.mock.calls);
    return {
      ...running,
      confirm: (kind, index, payload) =>
        handlers['wallet:confirm-signing']({}, kind, index, payload),
      fees: (intentId) => handlers['wallet:intent-replacement-fees']({}, intentId),
      replace: (...args) => handlers['wallet:intent-replace']({}, ...args),
    };
  }

  const LEGACY = { gasPrice: '1000000000' };
  const EIP1559 = { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' };

  // A send refused as underpriced, paying `fees`.
  async function underpriced(running, fees) {
    const params = { chainId: 100, to: BOB.address, value: '1000', gasLimit: '21000', ...fees };
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('transaction underpriced'), { outcome: 'rejected' });
    });
    const { token } = await running.confirm('wallet-send', null, {
      data: undefined,
      gasPrice: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
      ...params,
    });
    const reply = await running.walletSend({}, params, {}, { confirmation: token });
    expect(reply).toMatchObject({ success: false, outcome: 'rejected' });
    return running.store.get(reply.intentId);
  }

  async function replaceConfirmed(running, intent, fees) {
    const { token } = await running.confirm('intent-replace', null, {
      intentId: intent.intentId,
      chainId: intent.chainId,
      sender: intent.sender,
      nonce: intent.nonce,
      to: intent.fields.to,
      value: intent.fields.value,
      data: intent.fields.data,
      gasLimit: intent.fields.gasLimit,
      ...fees,
    });
    return running.replace(intent.intentId, fees, { confirmation: token });
  }

  test("the offer is today's quote when that is higher than the 10% bump", async () => {
    const running = startReplacing();
    const intent = await underpriced(running, LEGACY);
    mockFeeQuote.mockResolvedValue({ type: 'legacy', gasPrice: '5000000000' });
    await expect(running.fees(intent.intentId)).resolves.toEqual({
      success: true,
      fees: { gasPrice: '5000000000' },
    });
    // A quote that can't be read leaves the bump alone.
    mockFeeQuote.mockRejectedValue(new Error('rpc down'));
    await expect(running.fees(intent.intentId)).resolves.toEqual({
      success: true,
      fees: { gasPrice: '1100000000' },
    });
  });

  test('an EIP-1559 payment is replaced with both fees raised, and keeps its type', async () => {
    const running = startReplacing();
    const intent = await underpriced(running, EIP1559);
    mockFeeQuote.mockResolvedValue({
      type: 'eip1559',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '500000000',
    });
    const { fees } = await running.fees(intent.intentId);
    expect(fees).toEqual({ maxFeePerGas: '2200000000', maxPriorityFeePerGas: '1100000000' });

    // Another fee type, one fee left behind, or a tip above the cap: refused.
    for (const [other, refusal] of [
      [{ gasPrice: '9000000000' }, { code: 'INTENT_FEE_TOO_LOW' }],
      [
        { maxFeePerGas: '2200000000', maxPriorityFeePerGas: '1100000000', gasPrice: '9000000000' },
        { code: 'INTENT_FEE_TOO_LOW' },
      ],
      [
        { maxFeePerGas: '9000000000', maxPriorityFeePerGas: '1000000000' },
        { code: 'INTENT_FEE_TOO_LOW' },
      ],
      [
        { maxFeePerGas: '2200000000', maxPriorityFeePerGas: '3000000000' },
        { error: expect.stringMatching(/priority fee/) },
      ],
    ]) {
      await expect(replaceConfirmed(running, intent, other)).resolves.toMatchObject({
        success: false,
        ...refusal,
      });
    }
    expect(running.store.get(intent.intentId).hashes).toHaveLength(1);

    await expect(replaceConfirmed(running, intent, fees)).resolves.toMatchObject({ success: true });
    const replacement = broadcasts().at(-1);
    expect([
      replacement.type,
      replacement.nonce,
      replacement.maxFeePerGas,
      replacement.maxPriorityFeePerGas,
    ]).toEqual([2, 7, 2200000000n, 1100000000n]);
  });

  // #710 review probes: what the fee object carries beyond fees changes
  // nothing; a confirmation is spent once; two at once sign once.
  test('a fee object smuggling a payment changes nothing, and its confirmation is spent once', async () => {
    const running = startReplacing();
    const intent = await underpriced(running, LEGACY);
    const fees = {
      gasPrice: '0x4190ab00', // 1.1 gwei, in hex
      nonce: 999,
      chainId: 1,
      to: CONTRACT,
      value: '99999999999999999',
      data: '0xcafe',
      gasLimit: '1',
      walletIndex: 1,
      sender: BOB.address,
    };
    const { token } = await running.confirm('intent-replace', null, {
      intentId: intent.intentId,
      chainId: intent.chainId,
      sender: intent.sender,
      nonce: intent.nonce,
      to: intent.fields.to,
      value: intent.fields.value,
      data: intent.fields.data,
      gasLimit: intent.fields.gasLimit,
      gasPrice: fees.gasPrice,
    });
    await expect(
      running.replace(intent.intentId, fees, { confirmation: token })
    ).resolves.toMatchObject({
      success: true,
    });
    const tx = broadcasts().at(-1);
    expect({
      nonce: tx.nonce,
      chainId: tx.chainId,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
    }).toEqual({
      nonce: 7,
      chainId: 100n,
      from: ALICE.address,
      to: BOB.address,
      value: 1000n,
      data: '0x',
      gasLimit: 21000n,
      gasPrice: 1100000000n,
    });
    await expect(
      running.replace(intent.intentId, fees, { confirmation: token })
    ).resolves.toMatchObject({
      success: false,
      code: 'SIGNING_NOT_CONFIRMED',
    });
  });

  test('two replacements at once with the same fees sign once: the second meets the new floor', async () => {
    const running = startReplacing();
    const intent = await underpriced(running, LEGACY);
    mockSigners[0].signTransaction.mockClear();
    const fees = { gasPrice: '1100000000' };
    const replies = await Promise.all([
      replaceConfirmed(running, intent, fees),
      replaceConfirmed(running, intent, fees),
    ]);
    expect(replies.filter((reply) => reply.success)).toHaveLength(1);
    expect(replies.filter((reply) => reply.code === 'INTENT_FEE_TOO_LOW')).toHaveLength(1);
    expect(mockSigners[0].signTransaction).toHaveBeenCalledTimes(1);
    expect(
      mockRequest.mock.calls.filter(
        ([, method, params]) => method === 'eth_getTransactionCount' && params?.[1] === 'pending'
      )
    ).toHaveLength(1);
  });

  // #710 review: an offer the replacement handler refused.
  // #710 review (rounds 1 and 2): an offer the replacement handler
  // refused. Each original is sent at a zero fee through the send path,
  // with no quote to raise the offer: the offer is still one the handler
  // takes, confirmed and signed as offered.
  test.each([
    [
      'a zero tip',
      { maxFeePerGas: '100', maxPriorityFeePerGas: '0' },
      { maxFeePerGas: '110', maxPriorityFeePerGas: '0' },
      (tx) => [tx.type, tx.maxFeePerGas, tx.maxPriorityFeePerGas],
      [2, 110n, 0n],
    ],
    [
      'a zero cap and tip',
      { maxFeePerGas: '0', maxPriorityFeePerGas: '0' },
      { maxFeePerGas: '1', maxPriorityFeePerGas: '0' },
      (tx) => [tx.type, tx.maxFeePerGas, tx.maxPriorityFeePerGas],
      [2, 1n, 0n],
    ],
    [
      'a zero gas price',
      { gasPrice: '0' },
      { gasPrice: '1' },
      (tx) => [tx.type, tx.gasPrice],
      [0, 1n],
    ],
  ])(
    '%s is offered a replacement the handler accepts, with no quote',
    async (_name, original, offered, feesOf, signed) => {
      const running = startReplacing();
      const intent = await underpriced(running, original);
      expect(intent.fields).toMatchObject(original);
      mockFeeQuote.mockRejectedValue(new Error('quote unavailable'));
      const offer = await running.fees(intent.intentId);
      expect(offer).toEqual({ success: true, fees: offered });

      await expect(replaceConfirmed(running, intent, offer.fees)).resolves.toMatchObject({
        success: true,
        nonce: 7,
      });
      const replacement = broadcasts().at(-1);
      expect(replacement.nonce).toBe(7);
      expect(feesOf(replacement)).toEqual(signed);
    }
  );

  test('a zero or negative maximum fee, and a negative tip, are still refused', async () => {
    const running = startReplacing();
    const eip1559 = await underpriced(running, { maxFeePerGas: '100', maxPriorityFeePerGas: '0' });
    for (const fees of [
      { maxFeePerGas: '0', maxPriorityFeePerGas: '0' },
      { maxFeePerGas: '-110', maxPriorityFeePerGas: '0' },
      { maxFeePerGas: '110', maxPriorityFeePerGas: '-1' },
    ]) {
      await expect(replaceConfirmed(running, eip1559, fees)).resolves.toMatchObject({
        success: false,
      });
    }
    expect(running.store.get(eip1559.intentId).hashes).toHaveLength(1);
  });

  test('a second replacement raises the fee over the first, not over the original', async () => {
    const running = startReplacing();
    const intent = await underpriced(running, LEGACY);
    await expect(
      replaceConfirmed(running, intent, { gasPrice: '1100000000' })
    ).resolves.toMatchObject({
      success: true,
    });
    const after = running.store.get(intent.intentId);
    expect(after.fields.gasPrice).toBe('1100000000');
    await expect(
      replaceConfirmed(running, after, { gasPrice: '1150000000' })
    ).resolves.toMatchObject({
      success: false,
      code: 'INTENT_FEE_TOO_LOW',
    });
    await expect(
      replaceConfirmed(running, after, { gasPrice: '1210000000' })
    ).resolves.toMatchObject({
      success: true,
      nonce: 7,
    });
    expect(running.store.get(intent.intentId).hashes).toHaveLength(3);
  });

  test("the account at the payment's recorded index must be the one that signed it", async () => {
    const running = startReplacing();
    const intent = await underpriced(running, LEGACY);
    // The wallet at index 0 is now another account (a vault restored from
    // another phrase, say).
    mockSigners[0] = signerFor(BOB);
    await expect(
      replaceConfirmed(running, intent, { gasPrice: '1100000000' })
    ).resolves.toMatchObject({
      success: false,
      code: 'INTENT_KEY_MISMATCH',
    });
    expect(running.store.get(intent.intentId).hashes).toHaveLength(1);
    expect(broadcasts()).toHaveLength(1);
  });

  test('a settled payment is not replaced', async () => {
    const running = startReplacing();
    const { token } = await running.confirm('wallet-send', null, {
      chainId: 100,
      to: BOB.address,
      value: '1000',
      gasLimit: '21000',
      gasPrice: '1000000000',
      data: undefined,
      maxFeePerGas: undefined,
      maxPriorityFeePerGas: undefined,
    });
    const sent = await running.walletSend(
      {},
      { chainId: 100, to: BOB.address, value: '1000', gasLimit: '21000', gasPrice: '1000000000' },
      {},
      { confirmation: token }
    );
    const intent = running.store.get(sent.intentId);
    await running.store.settle({
      intentId: intent.intentId,
      label: 'paid',
      hash: intent.hash,
      block: 9,
    });
    await expect(running.fees(intent.intentId)).resolves.toMatchObject({
      success: false,
      code: 'INTENT_NOT_HELD',
    });
    await expect(
      replaceConfirmed(running, intent, { gasPrice: '2000000000' })
    ).resolves.toMatchObject({
      success: false,
      code: 'INTENT_NOT_HELD',
    });
  });
});

describe('the finality tracker settles held payments (7)', () => {
  const PAYMENT = {
    chainId: 100,
    to: BOB.address,
    value: '1000',
    gasLimit: '21000',
    gasPrice: '1000000000',
  };
  const hex = (n) => `0x${n.toString(16)}`;
  const BLOCK_90 = `0x${'90'.repeat(32)}`;

  function startTracking() {
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
      sent,
      list: async () => (await handlers['wallet:intents-list']({})).intents,
      tracker: require('./intent-tracker').getIntentTracker(),
      history: require('../payment-history'),
      send: async () => {
        const { token } = await handlers['wallet:confirm-signing']({}, 'wallet-send', null, {
          ...PAYMENT,
          data: undefined,
          maxFeePerGas: undefined,
          maxPriorityFeePerGas: undefined,
        });
        return running.walletSend({}, PAYMENT, {}, { confirmation: token });
      },
    };
  }

  // The chain as verified reads (a quorum of 2) see it: finalized block
  // 100, Alice's finalized count, and `mined` included at block 90.
  function finality({ count, mined = {}, at = 90 }) {
    const plain = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (chainId, method, params, options) => {
      if (!options?.includeTrust) return plain(chainId, method, params, options);
      const verified = (result) => ({
        result,
        source: 'quorum',
        verified: true,
        trust: { level: 'verified', method: 'quorum', quorum: { k: 3, m: 2, achieved: true } },
      });
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
        return verified({ number: hex(100), hash: `0x${'aa'.repeat(32)}` });
      }
      if (method === 'eth_getTransactionCount') return verified(hex(count));
      if (method === 'eth_getTransactionReceipt') {
        const status = mined[params[0]];
        if (status === undefined) return verified(null);
        return verified({
          transactionHash: params[0],
          from: ALICE.address.toLowerCase(),
          blockNumber: hex(at),
          blockHash: BLOCK_90,
          status: hex(status),
        });
      }
      if (method === 'eth_getBlockByNumber') return verified({ number: params[0], hash: BLOCK_90 });
      throw new Error(`unexpected verified read ${method}`);
    });
  }

  test('a mined payment settles paid at finality; its history row and the chrome hear of it', async () => {
    const running = startTracking();
    const sent = await running.send();
    expect(sent).toMatchObject({ success: true, nonce: 7 });
    finality({ count: 8, mined: { [sent.hash]: 1 } });
    running.sent.length = 0;

    await running.tracker.pass();

    expect(running.store.get(sent.intentId)).toMatchObject({
      state: 'settled',
      settlement: { label: 'paid', hash: sent.hash, block: 100 },
    });
    // Its bytes are forgotten once settled.
    expect(running.store.get(sent.intentId).hashes.every((entry) => entry.raw === null)).toBe(true);
    expect(running.history.getRecent({})).toEqual([
      expect.objectContaining({
        txHash: sent.hash,
        status: 'confirmed',
        metadata: expect.objectContaining({
          intentId: sent.intentId,
          finality: { label: 'paid', block: 100 },
        }),
      }),
    ]);
    expect(running.sent).toContain('wallet:intents-changed');
    await expect(running.list()).resolves.toEqual([]);
    // Nothing held: the tracker has nothing scheduled.
    expect(running.tracker.nextPassAt()).toBeNull();
  });

  test('a payment included with status 0 settles failed', async () => {
    const running = startTracking();
    const sent = await running.send();
    finality({ count: 8, mined: { [sent.hash]: 0 } });
    await running.tracker.pass();
    expect(running.store.get(sent.intentId).settlement).toMatchObject({ label: 'failed' });
    expect(running.history.getRecent({})[0]).toMatchObject({ status: 'failed' });
  });

  test('a refused payment whose nonce another transaction used is taken; the history gets its row', async () => {
    const running = startTracking();
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('insufficient funds for gas'), { outcome: 'rejected' });
    });
    const refused = await running.send();
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    expect(running.history.getRecent({})).toEqual([]);
    finality({ count: 8 });

    await running.tracker.pass();

    expect(running.store.get(refused.intentId)).toMatchObject({
      state: 'settled',
      settlement: { label: 'taken', hash: null, block: 100 },
    });
    expect(running.history.getRecent({})).toEqual([
      expect.objectContaining({
        kind: 'wallet-send',
        chainId: 100,
        status: 'taken',
        fromAddress: ALICE.address.toLowerCase(),
        toAddress: BOB.address.toLowerCase(),
        amount: '1000',
        metadata: { intentId: refused.intentId, finality: { label: 'taken', block: 100 } },
      }),
    ]);
  });

  test('on chain but not final yet: no longer waiting, and still held', async () => {
    const running = startTracking();
    // Refused as far as the broadcast could tell, with no history row:
    // only the tracker's reads know it is on chain.
    mockBroadcast.mockImplementationOnce(async () => {
      throw Object.assign(new Error('nonce too low'), { outcome: 'rejected' });
    });
    const refused = await running.send();
    expect(refused).toMatchObject({ success: false, outcome: 'rejected' });
    finality({ count: 7, mined: { [refused.intent.hash]: 1 }, at: 101 });
    running.sent.length = 0;
    await running.tracker.pass();
    expect(running.store.get(refused.intentId).state).toBe('held');
    expect(await running.list()).toEqual([
      expect.objectContaining({
        intentId: refused.intentId,
        observed: 'included',
        receipt: 'mined',
      }),
    ]);
    expect(running.sent).toContain('wallet:intents-changed');
  });

  test('after a restart, a payment the reads show is not on chain says so, instead of "pending"', async () => {
    const first = startTracking();
    mockBroadcast.mockImplementationOnce(async (_chainId, raw) => ({
      result: keccak256(raw),
      source: 'direct',
      outcome: 'uncertain',
    }));
    const sent = await first.send();
    expect(sent).toMatchObject({ success: true, outcome: 'uncertain' });

    // The app restarts: the records are read back, the outcomes summarized.
    const running = startTracking();
    await running.store.ready;
    expect(await running.list()).toEqual([
      expect.objectContaining({ intentId: sent.intentId, attention: 'pending', observed: null }),
    ]);
    finality({ count: 7 });
    await running.tracker.pass();
    expect(await running.list()).toEqual([
      expect.objectContaining({
        intentId: sent.intentId,
        attention: 'absent',
        observed: 'absent',
        replacement: 'speed-up',
        receipt: null,
      }),
    ]);
  });
});
