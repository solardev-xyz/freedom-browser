/**
 * signer.test.js's cases on both Ledger backends (freedom-core design
 * 0016, LDG-3's PR 7; the switch is FREEDOM_LEDGER_BACKEND,
 * ledger-backend-kind.js), through the signer factory (wallet/signers.js):
 *
 * - **`js`**, today's path: hw-app-eth in main (ledger/signer.js), here
 *   over a stand-in Eth app.
 * - **`core`**: the identity core signs with the Ledger key `{ kind:
 *   'ledger', index, path, address }` on its device lane. Here that core is
 *   scripted (test/helpers/fake-ledger-core.js, whose reader is cored
 *   0.30.0's reply.rs), a real CoreClient carries main's request under the
 *   device watchdog (vault-backend.js `deviceCall`, `ledgerCall`), main's
 *   relay (core/ledger-relay.js) admits each APDU and carries it to a
 *   scripted device behind it. The scripted core sends the APDUs of the
 *   stream it builds for the request (main's encoder stands in for the
 *   core's, which the vectors suites hold equal), reads the device's
 *   answers as the core would (the address check, the status words, the
 *   hash-only branch) and passes the device's signature on unchecked, so
 *   main's own check of every result is what a faulty signature meets.
 *
 * The same device answers both: one that holds the account and signs
 * honestly, one that holds another address, one that signs with another
 * key, with the wrong `v` or over another request, one that refuses.
 * Then the core's backend alone: the authorization presented to `sign.*`
 * (a page's `{ device }` token under `page`, the plan's point 10; a dApp
 * send's, whose rule the core writes; a standing rule's; a Safe owner's
 * Safe approval, point 11), the relay's hold for `beforeSign` (point 7),
 * the address-check record (point 8), what main refuses unsent with
 * 0016's new codes, the device's failures with theirs, the hash-only
 * warning's surface, main's own cancel, and one signature on main's real
 * HID device layer over a fake node-hid. Every reply main sends the core
 * is read by the core's reader, and none is a protocol error.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

let mockBackend = 'core';
jest.mock('./ledger-backend-kind', () => ({
  ledgerBackendKind: () => mockBackend,
  readLedgerBackendKind: () => mockBackend,
}));
const mockRuntime = { started: null };
jest.mock('../../core/core-process', () => ({
  getCoreClient: () => mockRuntime.started?.client ?? null,
  getLedgerRelay: () => mockRuntime.started?.relay ?? null,
}));
const mockRecords = new Map();
const mockRecordLedgerAddressCheck = jest.fn();
jest.mock('../../identity-manager', () => ({
  getWalletRecord: (index) => mockRecords.get(index) ?? null,
  recordLedgerAddressCheck: (...args) => mockRecordLedgerAddressCheck(...args),
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
// The JS backend's Eth app, answering as the device scenario says; errors
// mapped as transport.js maps them.
const mockEth = {
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  signPersonalMessage: jest.fn(),
  signEIP712Message: jest.fn(),
  signEIP712HashedMessage: jest.fn(),
};
jest.mock('./transport', () => ({
  withEthApp: (task) =>
    Promise.resolve()
      .then(() => task(mockEth))
      .catch((err) => {
        throw require('./errors').mapLedgerError(err);
      }),
}));

const {
  Signature,
  Transaction,
  TypedDataEncoder,
  Wallet,
  hashMessage,
  verifyMessage,
  verifyTypedData,
} = require('ethers');
const log = require('../../logger');
const { getSigner } = require('../signers');
const { createDeviceSigning } = require('../../page/page-devices');
const { LedgerRelay } = require('../../core/ledger-relay');
const { HidDevice, HidHost } = require('./hid-device');
const { fakeLedgerDevices, startLedgerCore, until } = require('../../../../test/helpers/fake-ledger-core');
const {
  APP_ANSWER,
  createFakeNodeHid,
  inProcessHosts,
} = require('../../../../test/helpers/fake-node-hid');

// Anvil/Hardhat-default test keys, well known, never funded on mainnet.
const deviceWallet = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const otherWallet = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');

const LEDGER_INDEX = 1000000;
const PATH = "44'/60'/0'/0/0";
const RECORD = {
  index: LEDGER_INDEX,
  name: 'My Stax',
  address: deviceWallet.address,
  type: 'ledger',
  path: PATH,
};
const PAGE = { origin: 'https://dapp.example', top_origin: 'https://dapp.example', frame: 0, navigation: 4 };
const TOKEN = 'T'.repeat(43);

const TX_1559 = {
  to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  value: '1000',
  gasLimit: '21000',
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
  nonce: 7,
  chainId: 8453,
  type: 2,
};
const TX_LEGACY = {
  to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  value: '1000',
  gasLimit: '21000',
  gasPrice: '7',
  nonce: 3,
  chainId: 100,
  type: 0,
};
const MAIL_TYPES = {
  Person: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Mail: [
    { name: 'from', type: 'Person' },
    { name: 'to', type: 'Person' },
    { name: 'contents', type: 'string' },
  ],
};
const MAIL = {
  domain: {
    name: 'Ether Mail',
    version: '1',
    chainId: 1,
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  },
  types: MAIL_TYPES,
  primaryType: 'Mail',
  message: {
    from: { name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826' },
    to: { name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' },
    contents: 'Hello, Bob!',
  },
};
const MAIL_HASH = TypedDataEncoder.hash(MAIL.domain, MAIL.types, MAIL.message);
const ZERO = '0x' + '00'.repeat(20);
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
  domain: { chainId: 100, verifyingContract: '0x' + 'aa'.repeat(20) },
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
const withoutDomain = (types) => {
  const rest = { ...types };
  delete rest.EIP712Domain;
  return rest;
};
const SAFE_TX_HASH = TypedDataEncoder.hash(SAFE_TX.domain, withoutDomain(SAFE_TX.types), SAFE_TX.message);

const BAD = {
  code: 'LEDGER_BAD_SIGNATURE',
  message: "The Ledger returned a signature that doesn't match this request. Nothing was sent.",
};
const OK = Buffer.from('9000', 'hex');
const hex = (bytes) => Buffer.from(bytes).toString('hex');

// ---------------------------------------------------------------------------
// The device, as both backends meet it

/**
 * What the attached device does: `holder` holds an address at the path
 * (its key answers the address check), `signer` signs, `flipV` gives the
 * other parity, `over` is what it signs instead of the request (another
 * transaction, message or digest), `status` the status word it refuses
 * the signature with.
 */
let device;
const honestDevice = () => ({ holder: deviceWallet, signer: deviceWallet, flipV: false, over: null, status: null });

/** The device's signature over a request: `kind` tx (a Transaction), message (bytes) or typed (its digest). */
function deviceSignature(kind, request) {
  const target = device.over ?? request;
  const digest =
    kind === 'tx' ? Transaction.from(target).unsignedHash : kind === 'message' ? hashMessage(target) : target;
  const sig = device.signer.signingKey.sign(digest);
  return { r: sig.r, s: sig.s, parity: sig.yParity ^ (device.flipV ? 1 : 0) };
}

/** A transaction's `v` byte as the Ethereum app sends it. */
function txV(unsigned, parity) {
  return unsigned.type === 0 ? Number(unsigned.chainId) * 2 + 35 + parity : parity;
}

function statusError(status) {
  return Object.assign(new Error(`status ${status.toString(16)}`), { statusCode: status });
}

/** The JS backend's Eth app, from the scenario. */
function scriptEth() {
  mockEth.getAddress.mockReset().mockImplementation(async () => ({ address: device.holder.address }));
  mockEth.signTransaction.mockReset().mockImplementation(async (_path, rawHex) => {
    if (device.status) throw statusError(device.status);
    const unsigned = Transaction.from('0x' + rawHex);
    const { r, s, parity } = deviceSignature('tx', unsigned);
    return { r: r.slice(2), s: s.slice(2), v: txV(unsigned, parity).toString(16) };
  });
  mockEth.signPersonalMessage.mockReset().mockImplementation(async (_path, messageHex) => {
    if (device.status) throw statusError(device.status);
    const { r, s, parity } = deviceSignature('message', Buffer.from(messageHex, 'hex'));
    return { r: r.slice(2), s: s.slice(2), v: 27 + parity };
  });
  mockEth.signEIP712Message.mockReset().mockImplementation(async (_path, payload) => {
    if (device.status) throw statusError(device.status);
    const digest = TypedDataEncoder.hash(payload.domain, withoutDomain(payload.types), payload.message);
    const { r, s, parity } = deviceSignature('typed', digest);
    return { r: r.slice(2), s: s.slice(2), v: 27 + parity };
  });
  mockEth.signEIP712HashedMessage.mockReset();
}

/** The address check's answer: the holder's uncompressed key and address text, then 9000. */
function addressAnswer(wallet) {
  const key = Buffer.from(wallet.signingKey.publicKey.slice(2), 'hex');
  const text = Buffer.from(wallet.address.slice(2), 'ascii');
  return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([text.length]), text, OK]);
}

/** A signature's answer: `v ‖ r ‖ s`, then 9000. */
function signatureAnswer(v, { r, s }) {
  return Buffer.concat([
    Buffer.from([v & 0xff]),
    Buffer.from(r.slice(2), 'hex'),
    Buffer.from(s.slice(2), 'hex'),
    OK,
  ]);
}

// ---------------------------------------------------------------------------
// The scripted core

const STATUS_CODES = {
  6985: 'LEDGER_USER_REJECTED',
  5501: 'LEDGER_USER_REJECTED',
  5515: 'LEDGER_DEVICE_LOCKED',
  6982: 'LEDGER_DEVICE_LOCKED',
  '6a80': 'LEDGER_BLIND_SIGNING_REQUIRED',
  6511: 'LEDGER_ETH_APP_NOT_OPEN',
  '6d00': 'LEDGER_ETH_APP_NOT_OPEN',
  '6e00': 'LEDGER_ETH_APP_NOT_OPEN',
};
const FAILED_CODES = {
  not_found: 'LEDGER_DEVICE_NOT_FOUND',
  busy: 'LEDGER_BUSY',
  disconnected: 'LEDGER_DISCONNECTED',
  unresponsive: 'LEDGER_UNRESPONSIVE',
  timeout: 'LEDGER_TIMEOUT',
};
const deviceFailed = (ledger) =>
  Object.assign(new Error('Ledger device failed'), { code: 'device_failed', data: { ledger } });

/** A core wire transaction as ethers' (signing-utils.js `toCoreTransaction`, reversed). */
function fromWire(tx) {
  return Transaction.from({
    type: tx.type,
    chainId: BigInt(tx.chain_id),
    nonce: Number(tx.nonce),
    gasLimit: BigInt(tx.gas_limit),
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
    ...(tx.type === 0
      ? { gasPrice: BigInt(tx.gas_price) }
      : {
          maxFeePerGas: BigInt(tx.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas),
        }),
  });
}

/** How a test bends the core (`script.result`: members added to its reply; `script.endWith`: a code it ends with instead). */
let script;
/** What answers the device's APDUs for the current operation. */
const answerer = { current: () => OK, hold: null, fail: null };

/** The core's `sign.*`: the stream, each answer read, then its reply. */
async function playSign(message) {
  const { id, method, params } = message;
  const core = mockRuntime.started.core();
  const prepared = new LedgerRelay({ log }).prepare({ method, params, path: params.key.path });
  if (!prepared.ok) throw Object.assign(new Error('Invalid parameters'), { code: 'invalid_argument' });
  const { admission } = prepared;
  const kind = method === 'sign.transaction' ? 'tx' : method === 'sign.message' ? 'message' : 'typed';
  const unsigned = kind === 'tx' ? fromWire(params.tx) : null;
  const request =
    kind === 'tx' ? unsigned : kind === 'message' ? Buffer.from(params.message.slice(2), 'hex') : params.expected_hash;
  const slots = [...admission.slots];
  const last = hex(slots.at(-1).apdu);
  const hashOnly = admission.hashOnlySlot ? hex(admission.hashOnlySlot.apdu) : null;
  // The device: the address check, the app, and the signature at the end.
  answerer.current = (apdu) => {
    const text = hex(apdu);
    if (text.startsWith('e002')) return addressAnswer(device.holder);
    if (text.startsWith('b001')) return Buffer.from(APP_ANSWER, 'hex');
    if (text === last || text === hashOnly) {
      if (device.status) return Buffer.from(device.status.toString(16).padStart(4, '0'), 'hex');
      const signature = deviceSignature(kind, request);
      const v = kind === 'tx' ? txV(unsigned, signature.parity) : 27 + signature.parity;
      return signatureAnswer(v, signature);
    }
    if (device.typedStatus && text.startsWith('e01a')) return Buffer.from(device.typedStatus, 'hex');
    return OK;
  };
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    const ask = core.apdu(id, hex(slot.apdu), slot.waits ? 300_000 : 15_000);
    await until(() => core.raw(ask), 'the reply');
    const reply = core.reply(ask);
    if (core.cancels().includes(id)) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
    if (!reply || reply.refused) throw deviceFailed('LEDGER_UNKNOWN');
    if (reply.failed) throw deviceFailed(FAILED_CODES[reply.failed]);
    const answer = reply.answer;
    const status = hex(answer.subarray(-2));
    if (k === 0 && status === '9000') {
      // The address check: the record's address, or the wrong device.
      const keyLength = answer[0];
      const textLength = answer[1 + keyLength];
      const text = answer.subarray(2 + keyLength, 2 + keyLength + textLength).toString('ascii');
      if (`0x${text}`.toLowerCase() !== params.key.address.toLowerCase()) {
        throw deviceFailed('LEDGER_WRONG_DEVICE');
      }
    }
    if (slot === admission.firstTypeName && status === '6d00') {
      // Q23: on to the two hashes only once main showed the warning.
      if (!reply.hashOnlyShown) throw deviceFailed('LEDGER_UNKNOWN');
      slots.splice(k + 1, slots.length, admission.hashOnlySlot);
      continue;
    }
    if (status !== '9000') throw deviceFailed(STATUS_CODES[status] ?? 'LEDGER_UNKNOWN');
    if (k < slots.length - 1) continue;
    if (script.endWith) throw deviceFailed(script.endWith);
    // Passed on unchecked: main's own check is what a faulty one meets.
    const v = answer[0];
    const r = '0x' + hex(answer.subarray(1, 33));
    const s = '0x' + hex(answer.subarray(33, 65));
    if (kind === 'tx') {
      const yParity = (v - (unsigned.type === 0 ? (Number(unsigned.chainId % 256n) * 2 + 35) & 0xff : 0) + 256) & 0xff;
      const signed = fromWire(params.tx);
      signed.signature = Signature.from({ r, s, yParity });
      return { raw: signed.serialized, hash: signed.hash, ...script.result };
    }
    return { signature: Signature.from({ r, s, yParity: v - 27 }).serialized, ...script.result };
  }
  throw new Error('the stream ended without a signature');
}

/** The core: its relay, a device behind it (`openDevice`), and its methods served. */
async function startCore(openDevice = null) {
  const devices = fakeLedgerDevices({ respond: (apdu) => answerer.current(apdu) });
  const started = await startLedgerCore({
    log,
    devices,
    deps: openDevice ? { openDevice, now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout } : {},
  });
  mockRuntime.started = started;
  const core = started.core();
  for (const method of ['sign.transaction', 'sign.message', 'sign.typed_data']) core.serve(method, playSign);
  core.serve('typed_data.hash', ({ params: { typed_data: data } }) => ({
    hash: TypedDataEncoder.hash(data.domain, data.types, data.message),
  }));
  return started;
}

const core = () => mockRuntime.started.core();
/** Main's requests of the signing methods the core got. */
const signRequests = () =>
  core().messages.filter((m) => m?.type === 'request' && /^(sign|safe|approval)\./.test(m.method));
/** Every APDU that reached the device, in hex. */
const reached = () => mockRuntime.started.devices.bytes();
/** Whether a signing APDU (anything after the address check and the app) reached the device. */
const signingReached = () => reached().some((apdu) => !apdu.startsWith('e002') && !apdu.startsWith('b001'));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordLedgerAddressCheck.mockReset();
  mockRecords.clear();
  mockRecords.set(LEDGER_INDEX, RECORD);
  device = honestDevice();
  script = { result: {}, endWith: null };
  answerer.current = () => OK;
  scriptEth();
});

afterEach(async () => {
  if (mockRuntime.started) {
    expect(core().faults).toEqual([]);
    await mockRuntime.started.client.stop();
    mockRuntime.started = null;
  }
});

// ---------------------------------------------------------------------------
// signer.test.js's cases, on each backend

describe.each(['js', 'core'])('on the %s backend', (backend) => {
  beforeEach(async () => {
    mockBackend = backend;
    // The JS backend asks the core only for typed data's hash.
    await startCore();
  });

  afterEach(() => {
    const ledgerSigns = core()
      .requests('sign.transaction')
      .concat(core().requests('sign.message'), core().requests('sign.typed_data'))
      .filter((m) => m.params?.key?.kind === 'ledger');
    // The JS backend never sends a Ledger key to the core.
    if (backend === 'js') expect(ledgerSigns).toEqual([]);
  });

  /** Whether the device was asked to sign anything. */
  const asked = () =>
    backend === 'js'
      ? [mockEth.signTransaction, mockEth.signPersonalMessage, mockEth.signEIP712Message].some(
          (fn) => fn.mock.calls.length > 0
        )
      : signingReached();

  test.each([
    ['type 2', TX_1559],
    ['legacy', TX_LEGACY],
  ])('%s: the device signs the transaction, and the signed bytes recover to the account', async (_label, tx) => {
    const raw = await getSigner(LEDGER_INDEX).signTransaction(tx);
    const parsed = Transaction.from(raw);
    expect(parsed.from).toBe(deviceWallet.address);
    expect(parsed.unsignedHash).toBe(Transaction.from(tx).unsignedHash);
    if (backend === 'core') {
      const [request] = core().requests('sign.transaction');
      expect(request.params.key).toEqual({ kind: 'ledger', index: LEDGER_INDEX, path: PATH, address: RECORD.address });
      expect(request.context).toEqual({ caller: 'shell' });
      expect(request.params).not.toHaveProperty('authorization');
    }
  });

  test('signs UTF-8 string messages (EIP-191)', async () => {
    const signature = await getSigner(LEDGER_INDEX).signMessage('hello freedom');
    expect(verifyMessage('hello freedom', signature)).toBe(deviceWallet.address);
  });

  test('signs raw bytes (pre-normalized 0x-hex dApp messages)', async () => {
    const signature = await getSigner(LEDGER_INDEX).signMessage('0xfffefd00010203deadbeef');
    expect(verifyMessage(Buffer.from('fffefd00010203deadbeef', 'hex'), signature)).toBe(deviceWallet.address);
  });

  test('typed data field by field, recovered over the confirmed digest', async () => {
    const signature = await getSigner(LEDGER_INDEX).signTypedData(MAIL, { expectedHash: MAIL_HASH });
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, signature)).toBe(deviceWallet.address);
  });

  test('a device that holds another address: LEDGER_WRONG_DEVICE, nothing signed, the check kept as mismatched', async () => {
    device.holder = otherWallet;
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject({
      code: 'LEDGER_WRONG_DEVICE',
      message: 'This Ledger does not hold the selected account. Connect the device this account was added from.',
    });
    expect(asked()).toBe(false);
    expect(mockRecordLedgerAddressCheck.mock.calls).toEqual([[LEDGER_INDEX, false]]);
  });

  test('a device that holds it: the check kept as matched', async () => {
    const signature = await getSigner(LEDGER_INDEX).signMessage('hi');
    expect(verifyMessage('hi', signature)).toBe(deviceWallet.address);
    expect(mockRecordLedgerAddressCheck.mock.calls).toEqual([[LEDGER_INDEX, true]]);
  });

  test('a failure to keep the check does not change the outcome', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRecordLedgerAddressCheck.mockImplementation(() => {
      throw new Error('disk full');
    });
    const signature = await getSigner(LEDGER_INDEX).signMessage('hi');
    expect(verifyMessage('hi', signature)).toBe(deviceWallet.address);
    console.warn.mockRestore();
  });

  test.each([
    ['a transaction', (signer) => signer.signTransaction(TX_1559)],
    ['a message', (signer) => signer.signMessage('hi')],
    ['typed data', (signer) => signer.signTypedData(MAIL, { expectedHash: MAIL_HASH })],
  ])('%s refused on the device: LEDGER_USER_REJECTED, with its text', async (_label, sign) => {
    device.status = 0x6985;
    await expect(sign(getSigner(LEDGER_INDEX))).rejects.toMatchObject({
      code: 'LEDGER_USER_REJECTED',
      message: 'Request rejected on the Ledger device.',
    });
  });

  /**
   * #1063: the device's answer is never trusted. On the core's backend the
   * core checks it first; here it passes it on, so main's own check of the
   * core's result is what refuses it.
   */
  describe('every signature is recovered against the account', () => {
    const OTHER_TX = { ...TX_1559, value: '1000000000000000000' };
    const OTHER_DIGEST = TypedDataEncoder.hash(MAIL.domain, MAIL.types, { ...MAIL.message, contents: 'Hello, Mallory!' });
    const kinds = [
      ['type 2', (signer) => signer.signTransaction(TX_1559), { tx: OTHER_TX }],
      ['legacy', (signer) => signer.signTransaction(TX_LEGACY), { tx: { ...TX_LEGACY, value: '9' } }],
      ['a message', (signer) => signer.signMessage('Sign in to example.org'), { message: 'Send everything' }],
      ['typed data', (signer) => signer.signTypedData(MAIL, { expectedHash: MAIL_HASH }), { typed: OTHER_DIGEST }],
    ];

    test.each(kinds)('%s: a signature from another key is refused', async (_label, sign) => {
      device.signer = otherWallet;
      await expect(sign(getSigner(LEDGER_INDEX))).rejects.toMatchObject(BAD);
    });

    test.each(kinds)('%s: the wrong v is refused', async (_label, sign) => {
      device.flipV = true;
      await expect(sign(getSigner(LEDGER_INDEX))).rejects.toMatchObject(BAD);
    });

    test.each(kinds)("%s: the account's signature over another request is refused", async (_label, sign, other) => {
      device.over = other.tx ?? (other.message !== undefined ? Buffer.from(other.message, 'utf8') : other.typed);
      await expect(sign(getSigner(LEDGER_INDEX))).rejects.toMatchObject(BAD);
    });
  });

  test("the caller's last check refuses: its own error, and nothing is signed", async () => {
    const refusal = Object.assign(new Error('The Agent no longer holds this tab'), { code: 'SIGNING_NOT_CONFIRMED' });
    const beforeSign = jest.fn(async () => {
      throw refusal;
    });
    await expect(getSigner(LEDGER_INDEX, { beforeSign }).signMessage('hi')).rejects.toBe(refusal);
    expect(beforeSign).toHaveBeenCalledTimes(1);
    expect(asked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The core's backend alone

describe('on the core backend', () => {
  beforeEach(async () => {
    mockBackend = 'core';
    await startCore();
  });

  test('sent with the device watchdog and requires vault_meta; the relay opens it and closes it at its end', async () => {
    const request = jest.spyOn(mockRuntime.started.client, 'request');
    await getSigner(LEDGER_INDEX).signMessage('hi');
    const sent = request.mock.calls.find(([method]) => method === 'sign.message');
    expect(sent[2]).toEqual({ caller: 'shell' });
    expect(sent[3]).toMatchObject({ deviceWatchdogMs: 315_000 });
    expect(sent[3]).not.toHaveProperty('watchdogMs');
    expect(sent[3].requires({ store_moved: ['vault_meta'] })).toBe(true);
    expect(sent[3].requires({ store_moved: [] })).toBe(false);
    expect(sent[3].onSent).toEqual(expect.any(Function));
    expect(mockRuntime.started.relay.stats()).toEqual({ parents: 0, open: false });
    // One device for the operation, opened at its first APDU and closed after its last.
    const types = mockRuntime.started.devices.events.map((e) => e.type);
    expect(types[0]).toBe('open');
    expect(types.at(-1)).toBe('detach');
    expect(types.filter((t) => t === 'open')).toHaveLength(1);
  });

  test("a page's { device } token: presented to sign.message and sign.typed_data with the Ledger key under page, never spent first (point 10)", async () => {
    const discarded = [];
    const signing = createDeviceSigning({
      walletList: async () => [RECORD],
      getSigner,
      discardToken: (token) => discarded.push(token),
    });
    const context = {
      params: ['0x68656c6c6f', MAIL],
      nameHolds: async () => true,
      holdsKey: () => true,
      pageContext: () => ({ agent: false }),
    };
    const message = { type: 'ledger', kind: 'sign-message', account: LEDGER_INDEX, payload: { message: '0x68656c6c6f' }, handle: 'h-1', token: TOKEN };
    const answered = await signing.sign(context, message, PAGE);
    expect(verifyMessage('hello', answered.result)).toBe(deviceWallet.address);
    const typed = {
      type: 'ledger',
      kind: 'sign-typed-data',
      account: LEDGER_INDEX,
      payload: { typed_data: MAIL, primary_type: 'Mail', chain_id: '1' },
      expectedHash: MAIL_HASH,
      handle: 'h-2',
      token: TOKEN,
    };
    const typedAnswer = await signing.sign(context, typed, PAGE);
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, typedAnswer.result)).toBe(deviceWallet.address);
    const [first, second] = signRequests();
    expect(first).toMatchObject({
      method: 'sign.message',
      context: { caller: 'page', page: PAGE },
      params: { key: { kind: 'ledger', index: LEDGER_INDEX }, message: '0x68656c6c6f', authorization: { token: TOKEN, handle: 'h-1' } },
    });
    expect(second).toMatchObject({
      method: 'sign.typed_data',
      context: { caller: 'page', page: PAGE },
      params: { expected_hash: MAIL_HASH, primary_type: 'Mail', chain_id: '1', authorization: { token: TOKEN, handle: 'h-2' } },
    });
    expect(signRequests()).toHaveLength(2);
    expect(discarded).toEqual([TOKEN, TOKEN]);
  });

  test("a dApp send's token: presented to sign.transaction, and the rule the core wrote is heard, no receipt", async () => {
    script.result = { rule: { added: true } };
    const onRule = jest.fn();
    const onReceipt = jest.fn();
    const { tx: coreTx } = require('../signing-utils').toCoreTransaction(TX_1559);
    const confirmation = { token: TOKEN, kind: 'dapp-send', account: LEDGER_INDEX, payload: { tx: coreTx, remember: true }, handle: 'h-3', page: PAGE };
    const raw = await getSigner(LEDGER_INDEX, { confirmation, onRule, onReceipt }).signTransaction(TX_1559);
    expect(Transaction.from(raw).from).toBe(deviceWallet.address);
    expect(signRequests()).toEqual([
      expect.objectContaining({
        method: 'sign.transaction',
        context: { caller: 'page', page: PAGE },
        params: expect.objectContaining({ authorization: { token: TOKEN, kind: 'dapp-send', handle: 'h-3' } }),
      }),
    ]);
    expect(onRule).toHaveBeenCalledWith({ added: true });
    expect(onReceipt).not.toHaveBeenCalled();
  });

  test("a standing rule's request: { standing } under page, the page's view beside typed data", async () => {
    await getSigner(LEDGER_INDEX, { page: PAGE, standing: { paused: false }, chainId: 1 }).signTypedData(MAIL);
    const [request] = core().requests('sign.typed_data');
    expect(request.context).toEqual({ caller: 'page', page: PAGE });
    expect(request.params).toMatchObject({
      authorization: { standing: { paused: false } },
      primary_type: 'Mail',
      chain_id: '1',
      expected_hash: MAIL_HASH,
    });
  });

  test("a Safe's Ledger owner (point 11): its SafeTx as sign.typed_data with the Safe approval, under the caller it was recorded for, never safe.sign_owner", async () => {
    const id = 'f'.repeat(32);
    const beforeSign = jest.fn(async () => {});
    const wallets = await getSigner(LEDGER_INDEX, { safe: { id, page: null }, beforeSign }).signTypedData(SAFE_TX);
    expect(verifyTypedData(SAFE_TX.domain, withoutDomain(SAFE_TX.types), SAFE_TX.message, wallets)).toBe(deviceWallet.address);
    const site = await getSigner(LEDGER_INDEX, { safe: { id, page: PAGE } }).signTypedData(SAFE_TX);
    expect(site).toBe(wallets);
    const [own, page] = core().requests('sign.typed_data');
    expect(own).toMatchObject({ context: { caller: 'shell' }, params: { authorization: { safe: id }, expected_hash: SAFE_TX_HASH } });
    expect(page).toMatchObject({ context: { caller: 'page', page: PAGE }, params: { authorization: { safe: id } } });
    expect(core().messages.filter((m) => m?.type === 'request' && m.method.startsWith('safe.'))).toEqual([]);
    expect(beforeSign).toHaveBeenCalledTimes(1);
  });

  test("the relay holds the caller's last check after B0 01, right before the first signing APDU (point 7)", async () => {
    const events = mockRuntime.started.devices.events;
    const beforeSign = jest.fn(async () => {
      events.push({ type: 'beforeSign' });
    });
    await getSigner(LEDGER_INDEX, { beforeSign }).signTransaction(TX_1559);
    const order = events.filter((e) => e.type === 'exchange' || e.type === 'beforeSign').map((e) => e.apdu?.slice(0, 4) ?? e.type);
    expect(order.slice(0, 4)).toEqual(['e002', 'b001', 'beforeSign', 'e004']);
  });

  test("its refusal: main's own cancel, the caller's own error, nothing after B0 01 reaches the device", async () => {
    const refusal = Object.assign(new Error('The site no longer holds the send'), { code: 'SIGNING_NOT_CONFIRMED', answer: { error: { code: 4100 } } });
    await expect(
      getSigner(LEDGER_INDEX, {
        beforeSign: async () => {
          throw refusal;
        },
      }).signTypedData(MAIL, { expectedHash: MAIL_HASH })
    ).rejects.toBe(refusal);
    expect(reached().map((apdu) => apdu.slice(0, 4))).toEqual(['e002', 'b001']);
    const [request] = core().requests('sign.typed_data');
    expect(core().cancels()).toEqual([request.id]);
    // A refusal isn't a device's answer: no address check is kept either way.
    expect(mockRecordLedgerAddressCheck).not.toHaveBeenCalled();
  });

  test('the address check is kept only after a good signature, or as mismatched on LEDGER_WRONG_DEVICE (point 8)', async () => {
    device.status = 0x6985;
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject({ code: 'LEDGER_USER_REJECTED' });
    device.status = null;
    device.signer = otherWallet;
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject(BAD);
    expect(mockRecordLedgerAddressCheck).not.toHaveBeenCalled();
    device.signer = deviceWallet;
    await getSigner(LEDGER_INDEX).signMessage('hi');
    device.holder = otherWallet;
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject({ code: 'LEDGER_WRONG_DEVICE' });
    expect(mockRecordLedgerAddressCheck.mock.calls).toEqual([
      [LEDGER_INDEX, true],
      [LEDGER_INDEX, false],
    ]);
  });

  test.each([
    ['an empty message', 'LEDGER_EMPTY_MESSAGE', "A Ledger can't sign an empty message. Nothing was sent.", (signer) => signer.signMessage('0x')],
    [
      'an array suffix written uint8[02]',
      'LEDGER_TYPE_NOT_CANONICAL',
      "This request writes a type in a form a Ledger can't sign. Nothing was sent.",
      (signer) => {
        const types = { Data: [{ name: 'values', type: 'uint8[02]' }] };
        const data = { domain: { name: 'Fixed', chainId: 1 }, types, message: { values: [1, 2] } };
        return signer.signTypedData(data, { expectedHash: TypedDataEncoder.hash(data.domain, types, data.message) });
      },
    ],
    [
      'an array of 256 entries',
      'LEDGER_TOO_LARGE',
      'This request is too large for a Ledger to sign. Nothing was sent.',
      (signer) => {
        const types = { Data: [{ name: 'values', type: 'uint8[]' }] };
        const data = { domain: { name: 'Long', chainId: 1 }, types, message: { values: Array.from({ length: 256 }, (_, i) => i % 256) } };
        return signer.signTypedData(data, { expectedHash: TypedDataEncoder.hash(data.domain, types, data.message) });
      },
    ],
  ])('%s: refused unsent, %s', async (_label, code, message, sign) => {
    const confirmation = { token: TOKEN, kind: 'sign-message', account: LEDGER_INDEX, payload: {}, page: PAGE };
    await expect(sign(getSigner(LEDGER_INDEX, { confirmation }))).rejects.toMatchObject({ code, message });
    expect(signRequests()).toEqual([]);
    expect(reached()).toEqual([]);
  });

  test("typed data that isn't the confirmed hash's: refused unsent", async () => {
    const other = TypedDataEncoder.hash(MAIL.domain, MAIL.types, { ...MAIL.message, contents: 'other' });
    await expect(getSigner(LEDGER_INDEX).signTypedData(MAIL, { expectedHash: other })).rejects.toMatchObject({
      message: 'The typed data changed after it was confirmed',
    });
    expect(signRequests()).toEqual([]);
  });

  test.each([
    ['the address check unanswered', 'e002', 'unresponsive', 'LEDGER_UNRESPONSIVE', 'The Ledger stopped answering. Reconnect it and try again.'],
    [
      'the confirmation not given',
      'e008',
      'timeout',
      'LEDGER_TIMEOUT',
      "The Ledger wasn't confirmed in 5 minutes. If it still shows the request, reject it there.",
    ],
    ['the device unplugged', 'e008', 'disconnected', 'LEDGER_DISCONNECTED', 'Ledger was disconnected. Reconnect it and try again.'],
  ])("%s: the core's %s, with its text", async (_label, prefix, failure, code, message) => {
    const devices = mockRuntime.started.devices;
    devices.respond = (apdu) => (hex(apdu).startsWith(prefix) ? { fail: failure } : answerer.current(apdu));
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject({ code, message });
  });

  test("the core's own LEDGER_BAD_SIGNATURE: today's text", async () => {
    script.endWith = 'LEDGER_BAD_SIGNATURE';
    await expect(getSigner(LEDGER_INDEX).signMessage('hi')).rejects.toMatchObject(BAD);
  });

  test("hash-only (Q23): without the warning on screen the 6D00 goes bare and nothing is signed; with it, the two hashes are", async () => {
    device.typedStatus = '6d00';
    await expect(getSigner(LEDGER_INDEX).signTypedData(MAIL, { expectedHash: MAIL_HASH })).rejects.toMatchObject({
      code: 'LEDGER_UNKNOWN',
    });
    expect(reached().some((apdu) => apdu.startsWith('e00c'))).toBe(false);
    const shown = [];
    const hashOnlySurface = jest.fn(async ({ domainSeparator, structHash }) => {
      shown.push({ domainSeparator, structHash });
      return true;
    });
    const signature = await getSigner(LEDGER_INDEX, { hashOnlySurface }).signTypedData(MAIL, { expectedHash: MAIL_HASH });
    expect(verifyTypedData(MAIL.domain, MAIL.types, MAIL.message, signature)).toBe(deviceWallet.address);
    expect(shown).toEqual([
      { domainSeparator: TypedDataEncoder.hashDomain(MAIL.domain), structHash: TypedDataEncoder.from(MAIL.types).hash(MAIL.message) },
    ]);
    expect(reached().filter((apdu) => apdu.startsWith('e00c0000'))).toHaveLength(1);
  });

  test("main's own cancel while the device waits: the core is told, the device let go at once, the caller hears cancelled", async () => {
    const devices = mockRuntime.started.devices;
    devices.respond = (apdu) => (hex(apdu).startsWith('e008') ? { hold: true } : answerer.current(apdu));
    const controller = new AbortController();
    const pending = getSigner(LEDGER_INDEX, { signal: controller.signal }).signMessage('hi');
    await until(() => devices.held.length === 1, 'the device waiting');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const [request] = core().requests('sign.message');
    expect(core().cancels()).toEqual([request.id]);
    expect(devices.of('detach')).toEqual([expect.objectContaining({ inFlight: true })]);
  });

  test('on main\'s real HID device layer, over a fake node-hid: one handle for the operation, the signature checked', async () => {
    await mockRuntime.started.client.stop();
    const fake = createFakeNodeHid();
    const host = new HidHost({ launch: inProcessHosts(fake), idleMs: null });
    fake.ledger.respond = (apdu) => ({ answer: hex(answerer.current(apdu)) });
    try {
      await startCore(() => new HidDevice({ host }));
      const signature = await getSigner(LEDGER_INDEX).signMessage('hello freedom');
      expect(verifyMessage('hello freedom', signature)).toBe(deviceWallet.address);
      await until(() => fake.events.some((e) => e.type === 'close'), 'the handle closed');
      expect(fake.events.filter((e) => e.type === 'open' || e.type === 'close').map((e) => e.type)).toEqual(['open', 'close']);
      expect(fake.violations).toEqual([]);
    } finally {
      host.kill();
    }
  });
});
