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
