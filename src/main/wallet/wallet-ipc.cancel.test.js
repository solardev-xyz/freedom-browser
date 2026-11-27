/**
 * The send screen's Cancel while a Ledger waits (freedom-core design 0016,
 * "Deadlines, cancel and unplugging", deviation `cancel`; the LDG-3 plan's
 * PR 10 and its point 5), on the core's Ledger backend: `wallet:cancel-send`
 * aborts the window's `wallet:send-transaction` in flight.
 *
 * Main's own pieces run as they do in the app: wallet-ipc.js's handlers,
 * the transaction service's new intent under the account's nonce
 * reservation (nonce-reservations.js), the signer factory's core Ledger
 * backend (signers.js), vault-backend.js's `deviceCall` under the device
 * watchdog, a real CoreClient, and main's relay (core/ledger-relay.js).
 * The core is scripted (test/helpers/fake-ledger-core.js, whose reader is
 * cored 0.30.0's reply.rs): it sends the APDUs of the stream main prepared
 * for `sign.transaction`, and a scripted device behind the relay answers
 * the address check and the app, and waits for the user at the
 * transaction's last piece; once the test answers that piece, the core
 * replies the transaction signed by the device's key. The chain (its nonce
 * and the broadcast) and the intent store are stand-ins.
 *
 * The Cancel: the parent's cancel goes to the core and the device is let go
 * of at once; the send fails LEDGER_CANCELLED with point 18's text, before
 * any commit; the nonce is released (the next send takes the same nonce at
 * once); and nothing reaches the device after the Cancel, a later APDU for
 * the cancelled parent refused `ended`.
 *
 * The commit boundary: exactly one of the signature and the Cancel wins. A
 * Cancel after the device signed but before the commit still wins, and
 * nothing is committed or sent; once the signed bytes are being committed,
 * a Cancel reaches nothing and the send goes out.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: jest.fn() },
  webContents: { fromId: jest.fn(() => null) },
  BrowserWindow: { fromWebContents: jest.fn(() => null) },
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockBackend = 'core';
jest.mock('./ledger/ledger-backend-kind', () => ({
  ledgerBackendKind: () => mockBackend,
  readLedgerBackendKind: () => mockBackend,
}));
const mockRuntime = { started: null };
jest.mock('../core/core-process', () => ({
  getCoreClient: () => mockRuntime.started?.client ?? null,
  getLedgerRelay: () => mockRuntime.started?.relay ?? null,
}));

const LEDGER_INDEX = 1000000;
// The active account: the Ledger, or a phone (1000001).
const mockActive = { index: 1000000 };
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => mockActive.index,
  getWalletRecord: (index) => {
    if (index === 1000001) return { index, name: 'My phone', address: '0x' + '44'.repeat(20), type: 'remote' };
    return index === 1000000
      ? {
          index,
          name: 'My Stax',
          // deviceWallet's address, below.
          address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          type: 'ledger',
          path: "44'/60'/0'/0/0",
        }
      : null;
  },
  recordLedgerAddressCheck: jest.fn(),
  recordRemoteAddressCheck: jest.fn(),
  isHardwareWalletIndex: (index) => Number.isInteger(index) && index >= 1000000,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: () => {} }));
jest.mock('./remote/signer', () => ({
  createRemoteBackend: () => {
    throw new Error('No phone here');
  },
}));
// The JS backend's Ledger (hw-app-eth in main), for the one test that runs
// it: its device answers when the test says.
const mockJsLedger = { answer: null };
// The signer factory as main builds it; a test may step in once a
// signature is back from the signer, before the transaction service
// commits it (`mockSigned.after`).
const mockSigned = { after: null };
jest.mock('./signers', () => {
  const actual = jest.requireActual('./signers');
  return {
    ...actual,
    getSigner: (index, authorized) => {
      const signer = actual.getSigner(index, authorized);
      return {
        ...signer,
        signTransaction: async (tx) => {
          const raw = await signer.signTransaction(tx);
          await mockSigned.after?.();
          return raw;
        },
      };
    },
  };
});
jest.mock('./ledger/signer', () => ({
  createLedgerBackend: (record) => ({
    getAddress: async () => record.address,
    signTransaction: () =>
      new Promise((resolve, reject) => {
        mockJsLedger.answer = { resolve, reject };
      }),
  }),
}));
jest.mock('qrcode', () => ({}));
jest.mock('./balance-service', () => ({}));
jest.mock('./provider-manager', () => ({}));
jest.mock('./chains', () => ({ getTxExplorerUrl: () => null, getChain: () => null, getAllChains: () => ({}) }));
jest.mock('./rpc-manager', () => ({ retiredApiKeys: () => [], getEffectiveRpcUrls: () => [] }));
jest.mock('../networks/network-registry', () => ({ withoutApiKeys: (text) => String(text) }));
jest.mock('./intent-ipc', () => ({ intentFailure: async () => ({}) }));
// The account's pending nonce, as the chain answers it, and the bytes
// broadcast, each named by its hash.
const mockChain = { pending: 5n, reads: 0, broadcasts: [] };
jest.mock('../networks/chain-data', () => ({
  request: jest.fn(async (_chainId, method) => {
    if (method !== 'eth_getTransactionCount') throw new Error(`no ${method} here`);
    mockChain.reads += 1;
    return { result: '0x' + mockChain.pending.toString(16), source: 'test' };
  }),
  broadcastRawTransaction: jest.fn(async (_chainId, raw) => {
    mockChain.broadcasts.push(raw);
    return { result: require('ethers').keccak256(raw), source: 'test' };
  }),
}));
// The intent store: nothing held. A cancelled send never reaches the commit
// (each test that signs answers its own), and a commit's handoff gives its
// bytes back.
const mockStore = {
  ready: Promise.resolve(),
  heldNonces: jest.fn(async () => []),
  commit: jest.fn(async () => {
    throw new Error('A cancelled send is never committed');
  }),
  handoff: jest.fn(async (intentId) => {
    const { hash, raw } = mockStore.commit.mock.calls.at(-1)[0];
    return { handoffId: `handoff-${intentId}`, hash, raw };
  }),
  outcome: jest.fn(async () => ({})),
};
jest.mock('./intent-store', () => ({ getIntentStore: () => mockStore, closedText: () => 'closed' }));
// The send's record: the transaction service's own send, with the caller's
// guard on its commit, nothing written.
jest.mock('./tx-recorder', () => ({
  KINDS: { WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  signAndRecord: (params, signer, context, options) =>
    require('./transaction-service').signAndSendTransaction(params, signer, {
      context: { kind: context.kind, walletIndex: options?.walletIndex },
      guardCommit: options?.guardCommit ?? null,
    }),
}));
// The user's confirmation, as the approvals panel minted it.
jest.mock('./signing-confirmation', () => {
  const actual = jest.requireActual('./signing-confirmation');
  return {
    ...actual,
    confirmationFor: (token, kind, account, payload) => ({ token, kind, account, payload }),
  };
});

const { Transaction, Wallet } = require('ethers');
const { ipcMain } = require('electron');
const log = require('../logger');
const { registerWalletIpc } = require('./wallet-ipc');
const { LedgerRelay } = require('../core/ledger-relay');
const { fakeLedgerDevices, settle, startLedgerCore, until } = require('../../../test/helpers/fake-ledger-core');
const { APP_ANSWER } = require('../../../test/helpers/fake-node-hid');

// Anvil/Hardhat-default test key, well known, never funded on mainnet.
const deviceWallet = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const PATH = "44'/60'/0'/0/0";
const NOTICE = 'Cancelled. If your Ledger still shows the request, reject it there.';
const SEND = {
  to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  value: '1000',
  gasLimit: '21000',
  gasPrice: '1000000000',
  chainId: 8453,
};
const CONFIRMED = { confirmation: 'T'.repeat(43) };
const NOT_WAITING = { success: false, error: 'No send is waiting on a Ledger here' };
// The device's answer to the last piece once the user approves: v, r, s.
const SIGNED = '1c' + 'aa'.repeat(32) + 'bb'.repeat(32) + '9000';
const hex = (bytes) => Buffer.from(bytes).toString('hex');

/** The address check's answer: the device key and address text, then 9000. */
function addressAnswer(wallet) {
  const key = Buffer.from(wallet.signingKey.publicKey.slice(2), 'hex');
  const text = Buffer.from(wallet.address.slice(2), 'ascii');
  return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([text.length]), text, Buffer.from('9000', 'hex')]);
}

/** The core's transaction (`sign.transaction`'s `tx`), signed by the device's key. */
function signedRaw(tx) {
  const unsigned = Transaction.from({
    type: tx.type,
    chainId: BigInt(tx.chain_id),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas_limit),
    gasPrice: BigInt(tx.gas_price),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
  });
  unsigned.signature = deviceWallet.signingKey.sign(unsigned.unsignedHash);
  return unsigned.serialized;
}

/**
 * The core's `sign.transaction` for a Ledger key: the stream main prepared,
 * one `shell.ledger_apdu` at a time, until main's cancel; the device waits
 * at the last piece (the one the user confirms). Once it answers that
 * piece, the core replies the signed transaction.
 */
async function playSign(message) {
  const { id, method, params } = message;
  const core = mockRuntime.started.core();
  const prepared = new LedgerRelay({ log }).prepare({ method, params, path: params.key.path });
  if (!prepared.ok) throw Object.assign(new Error('Invalid parameters'), { code: 'invalid_argument' });
  const slots = [...prepared.admission.slots];
  for (const slot of slots) {
    const ask = core.apdu(id, hex(slot.apdu), slot.waits ? 300_000 : 15_000);
    await until(() => core.raw(ask) || core.cancels().includes(id), 'the reply or the cancel');
    if (core.cancels().includes(id)) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    if (!core.reply(ask)?.answer) throw Object.assign(new Error('Ledger device failed'), { code: 'device_failed', data: { ledger: 'LEDGER_UNKNOWN' } });
  }
  return { raw: signedRaw(params.tx) };
}

let handlers;
const event = (id = 41) => ({ sender: { id } });
const send = (sender = event()) => handlers.get('wallet:send-transaction')(sender, SEND, {}, CONFIRMED);
const cancel = (sender = event()) => handlers.get('wallet:cancel-send')(sender);
const core = () => mockRuntime.started.core();
const devices = () => mockRuntime.started.devices;
const signs = () => core().requests('sign.transaction');

beforeAll(() => {
  registerWalletIpc();
  handlers = new Map(ipcMain.handle.mock.calls.map(([channel, handler]) => [channel, handler]));
});

beforeEach(async () => {
  mockBackend = 'core';
  mockActive.index = LEDGER_INDEX;
  mockChain.pending = 5n;
  mockChain.reads = 0;
  mockChain.broadcasts = [];
  mockSigned.after = null;
  mockStore.commit.mockClear();
  mockStore.handoff.mockClear();
  const ledger = fakeLedgerDevices({
    respond: (apdu) => {
      const text = hex(apdu);
      if (text.startsWith('e002')) return addressAnswer(deviceWallet);
      if (text.startsWith('b001')) return APP_ANSWER;
      // The transaction's pieces: the last waits for the user.
      return text === ledger.last ? { hold: true } : '9000';
    },
  });
  mockRuntime.started = await startLedgerCore({ log, devices: ledger });
  core().serve('sign.transaction', (message) => {
    const prepared = new LedgerRelay({ log }).prepare({
      method: message.method,
      params: message.params,
      path: message.params.key.path,
    });
    ledger.last = hex(prepared.admission.slots.at(-1).apdu);
    return playSign(message);
  });
  // The send's token, burnt once its request has ended (`withConfirmation`);
  // on the JS backend, spent before the device is asked.
  core().serve('approval.discard', () => ({}));
  core().serve('approval.spend', () => ({}));
});

afterEach(async () => {
  expect(core().faults).toEqual([]);
  await mockRuntime.started.client.stop();
  mockRuntime.started = null;
});

test('the parent cancelled, the device let go at once, the nonce released, nothing signed after the Cancel', async () => {
  const pending = send();
  await until(() => devices().held.length === 1, 'the Ledger waiting for the user');
  const [request] = signs();
  expect(request.params.key).toEqual({
    kind: 'ledger',
    index: LEDGER_INDEX,
    path: PATH,
    address: deviceWallet.address,
  });
  const nonce = Number(request.params.tx.nonce);
  expect(nonce).toBe(5);
  const reached = devices().bytes().length;

  expect(await cancel()).toEqual({ success: true });
  // The send's answer: main's text, nothing committed or sent.
  expect(await pending).toEqual({ success: false, error: NOTICE, code: 'LEDGER_CANCELLED' });
  expect(core().cancels()).toEqual([request.id]);
  expect(devices().of('detach')).toEqual([expect.objectContaining({ inFlight: true })]);
  expect(mockStore.commit).not.toHaveBeenCalled();
  expect(core().requests('approval.discard')).toHaveLength(1);

  // The parent has ended in the relay: a late APDU for it is refused
  // `ended`, and nothing more reaches the device.
  const late = core().apdu(request.id, hex(Buffer.from('e004800005' + '00'.repeat(5), 'hex')), 300_000);
  await until(() => core().raw(late), 'the late reply');
  expect(core().reply(late)).toMatchObject({ refused: 'ended' });
  expect(devices().bytes()).toHaveLength(reached);
  // The Cancel was the window's one: a second press reaches nothing.
  expect(await cancel()).toMatchObject({ success: false });

  // The nonce went back: the next send takes it again, at once (no wait on
  // the account's reservation), on a fresh device.
  const again = send();
  await until(() => devices().held.length === 2, 'the Ledger waiting again');
  const [, second] = signs();
  expect(Number(second.params.tx.nonce)).toBe(nonce);
  expect(devices().of('open')).toHaveLength(2);
  expect(await cancel()).toEqual({ success: true });
  expect(await again).toMatchObject({ success: false, code: 'LEDGER_CANCELLED' });
  expect(mockStore.commit).not.toHaveBeenCalled();
});

test("one window's Cancel never reaches another window's send", async () => {
  const pending = send(event(41));
  await until(() => devices().held.length === 1, 'the Ledger waiting for the user');
  expect(await cancel(event(42))).toEqual({ success: false, error: 'No send is waiting on a Ledger here' });
  expect(core().cancels()).toEqual([]);
  expect(devices().of('detach')).toEqual([]);
  expect(await cancel(event(41))).toEqual({ success: true });
  expect(await pending).toMatchObject({ success: false, code: 'LEDGER_CANCELLED' });
});

test('with no send in flight, a Cancel reaches nothing', async () => {
  expect(await cancel()).toEqual({ success: false, error: 'No send is waiting on a Ledger here' });
  expect(signs()).toEqual([]);
});

test("a phone's send has no Cancel here: nothing in main could stop it", async () => {
  mockActive.index = 1000001;
  const pending = send();
  expect(await cancel()).toEqual(NOT_WAITING);
  expect(await pending).toMatchObject({ success: false, error: 'No phone here' });
  expect(signs()).toEqual([]);
});

test('on the JS backend no send is cancellable: the Cancel reaches nothing, and the device decides, as before', async () => {
  mockBackend = 'js';
  mockJsLedger.answer = null;
  const pending = send();
  await until(() => mockJsLedger.answer !== null, 'the JS backend asking its device');
  expect(await cancel()).toEqual({ success: false, error: 'No send is waiting on a Ledger here' });
  // The device's own rejection ends it; the core was never asked.
  mockJsLedger.answer.reject(Object.assign(new Error('Request rejected on the Ledger device.'), { code: 'LEDGER_USER_REJECTED' }));
  expect(await pending).toEqual({ success: false, error: 'Request rejected on the Ledger device.' });
  expect(signs()).toEqual([]);
});

// The commit boundary: in the same run as the commit of the signed bytes,
// the window's Cancel stops reaching its send (wallet-ipc.js `signed()`).
describe('the commit boundary: exactly one of the signature and the Cancel wins', () => {
  /** The next commit, held until the test answers it. */
  function heldCommit() {
    let answer;
    const held = new Promise((resolve) => {
      answer = resolve;
    });
    mockStore.commit.mockImplementationOnce(() => held);
    return answer;
  }

  test('signed first: a Cancel while the commit is pending reaches nothing, and the send is committed and broadcast', async () => {
    const commit = heldCommit();
    const pending = send();
    await until(() => devices().held.length === 1, 'the Ledger waiting for the user');
    // The user approves on the device: the core replies the signature.
    devices().release(SIGNED);
    await until(() => mockStore.commit.mock.calls.length === 1, 'the commit');
    const [{ nonce, hash, raw }] = mockStore.commit.mock.calls[0];
    expect(nonce).toBe(5);
    expect(Transaction.from(raw).from).toBe(deviceWallet.address);

    // The Cancel comes while the commit is pending: not waiting, and nothing
    // is cancelled.
    expect(await cancel()).toEqual(NOT_WAITING);
    expect(core().cancels()).toEqual([]);
    expect(devices().of('detach').filter((e) => e.inFlight)).toEqual([]);

    commit({ intentId: 'intent-1', chainId: SEND.chainId });
    // The screen hears the send's own outcome: sent.
    expect(await pending).toMatchObject({
      success: true,
      hash,
      nonce: 5,
      from: deviceWallet.address,
      intentId: 'intent-1',
      outcome: 'sent',
    });
    expect(mockChain.broadcasts).toEqual([raw]);
    expect(mockStore.handoff.mock.calls).toEqual([['intent-1']]);
    // After it too, the Cancel reaches nothing.
    expect(await cancel()).toEqual(NOT_WAITING);
  });

  test('a Cancel after the device signed, before the commit: nothing committed or sent, Not sent, the nonce released once', async () => {
    const pending = send(event(41));
    await until(() => devices().held.length === 1, 'the Ledger waiting for the user');
    const [request] = signs();
    // The signer has the signature (signers.js saw no Cancel); the Cancel
    // comes before the transaction service commits it.
    let cancelled = null;
    mockSigned.after = async () => {
      mockSigned.after = null;
      cancelled = await cancel(event(41));
    };
    devices().release(SIGNED);

    expect(await pending).toEqual({ success: false, error: NOTICE, code: 'LEDGER_CANCELLED' });
    expect(cancelled).toEqual({ success: true });
    expect(mockStore.commit).not.toHaveBeenCalled();
    expect(mockStore.handoff).not.toHaveBeenCalled();
    expect(mockChain.broadcasts).toEqual([]);
    // The core's request had ended: no cancel went to it.
    expect(core().cancels()).toEqual([]);
    expect(core().requests('approval.discard')).toHaveLength(1);

    // The nonce went back once: the next send takes it again at once, and
    // holds the account while it waits, so a send from another window waits
    // its turn rather than taking the nonce too.
    const again = send(event(41));
    await until(() => devices().held.length === 1, 'the Ledger waiting again');
    const other = send(event(42));
    await settle();
    expect(signs().map((sign) => Number(sign.params.tx.nonce))).toEqual([Number(request.params.tx.nonce), 5]);
    expect(await cancel(event(41))).toEqual({ success: true });
    expect(await again).toMatchObject({ success: false, code: 'LEDGER_CANCELLED' });
    // Its turn now: the same nonce, the account's lock handed on once.
    await until(() => signs().length === 3, 'the other window signing');
    expect(Number(signs()[2].params.tx.nonce)).toBe(5);
    await until(() => devices().held.length === 1, 'the Ledger waiting for the other window');
    expect(await cancel(event(42))).toEqual({ success: true });
    expect(await other).toMatchObject({ success: false, code: 'LEDGER_CANCELLED' });
    expect(mockStore.commit).not.toHaveBeenCalled();
  });
});
