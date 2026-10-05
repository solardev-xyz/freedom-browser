jest.mock('./privacy-storage', () => ({
  ...jest.requireActual('./privacy-storage'),
  createPrivacyStorage: jest.fn(() => {
    throw Error('storage construction forbidden');
  }),
  getPrivacyStoragePath: jest.fn(() => {
    throw Error('storage access forbidden');
  }),
}));
jest.mock('../networks/privacy-context', () => ({
  ...jest.requireActual('../networks/privacy-context'),
  createPrivacyScope: jest.fn(() => {
    throw Error('authority construction forbidden');
  }),
  getPrivacyContext: jest.fn(() => {
    throw Error('authority access forbidden');
  }),
}));
// Real calldata/receipt/intent/checkpoint validators, with explicitly supplied
// synthetic journal and owned-note data. No genuine owner or chain is claimed.
const { Interface, getAddress, toBeHex } = require('ethers');
const { matchRailgunShieldOrigin } = require('./railgun-shield-origin-data');
const { transactionIntent } = require('./private-transaction-intent');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const { SHIELD_EVENT, inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const { checkpointHash } = require('./railgun-wallet-coverage');
const pins = require('./railgun-shield-pins.json');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const owner = '0x' + 'ab'.repeat(20);
// Keep plain fixture objects in this Jest realm; Node structuredClone creates
// foreign-realm prototypes which the strict data boundary intentionally rejects.
const clone = (value) =>
  Array.isArray(value)
    ? value.map(clone)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
      : value;
function fixture() {
  const transaction = {
    chainId: '0xaa36a7',
    from: owner,
    to: pins.relayAdapt,
    value: '0x' + BigInt(prepared.value).toString(16),
    input: prepared.data,
    hash: hex(101),
    nonce: '0x0',
    blockHash: hex(102),
    blockNumber: '0xb4911f',
  };
  const [, calls] = abi.decodeFunctionData('multicall', transaction.input);
  const [requests] = abi.decodeFunctionData('shield', calls[1].data);
  const log = {
    ...abi.encodeEventLog('Shield', [
      0,
      123,
      [[prepared.npk, [0, pins.wrappedNative, 0], BigInt(prepared.noteValue)]],
      [requests[0].ciphertext],
      [BigInt(prepared.value) - BigInt(prepared.noteValue)],
    ]),
    address: pins.proxy,
    transactionHash: transaction.hash,
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    logIndex: '0x4',
    removed: false,
  };
  const receipt = {
    transactionHash: transaction.hash,
    from: owner,
    to: pins.relayAdapt,
    status: '0x1',
    blockHash: transaction.blockHash,
    blockNumber: transaction.blockNumber,
    logs: [log],
  };
  const blockNumber = Number(BigInt(transaction.blockNumber));
  const record = {
    hash: transaction.hash,
    nonce: 0,
    state: 'submitted',
    attemptedAt: 1,
    revision: 2,
    intent: transactionIntent('railgun-native-shield', { ...transaction, data: transaction.input }),
    observation: {
      status: 'included',
      trust: 'unverified',
      observedAt: 2,
      confirmations: 13,
      blockNumber,
      blockHash: transaction.blockHash,
    },
  };
  const shield = inspectRailgunShieldReceipt(record, transaction, receipt);
  expect(shield.status).toBe('matched');
  record.resolution = {
    minimumConfirmations: 3,
    reviewedAt: 3,
    blockHash: transaction.blockHash,
    railgun: {
      outcome: 'matched',
      finalizedBlockNumber: blockNumber + 12,
      finalizedBlockHash: hex(103),
      shield,
    },
  };
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: blockNumber, hash: transaction.blockHash },
    anchor: { number: blockNumber + 12, hash: hex(103) },
    logs: { count: 1, sha256: '1'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: '2'.repeat(64),
      ledgerId: '3'.repeat(64),
      ledgerSha256: '4'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: '5'.repeat(64),
      trees: [{ tree: 0, length: 124, root: hex(104) }],
      commitments: { count: 124, sha256: '6'.repeat(64) },
      nullifiers: { count: 0, sha256: '7'.repeat(64) },
      unshields: { count: 0, sha256: '8'.repeat(64) },
    },
  };
  const owned = {
    checkpointHash: checkpointHash(checkpoint),
    trees: clone(checkpoint.state.trees),
    read: {
      instanceId: 'synthetic-view-only-data',
      received: [
        {
          id: '0:123',
          tree: 0,
          position: 123,
          txid: transaction.hash,
          hash: hex(10),
          tokenHash: toBeHex(BigInt(pins.wrappedNative), 32),
          asset: { __type: 'erc20', contract: pins.wrappedNative },
          amount: BigInt(prepared.noteValue),
          spentTxid: false,
          tag: 'unverified',
        },
      ],
      sent: [],
    },
    ownedPoi: [
      {
        id: '0:123',
        type: 'Shield',
        txid: transaction.hash,
        hash: hex(10),
        npk: prepared.npk,
        nullifier: hex(11),
        blindedCommitment: hex(12),
        blockNumber,
      },
    ],
  };
  return { record, transaction, receipt, owned, checkpoint, submitter: owner };
}
const expected = (status) => ({
  status,
  trust: 'supplied-data',
  ownershipAuthenticated: false,
  canonicalityVerified: false,
  spendingEnabled: false,
  poiBypassEnabled: false,
});

test('matches supplied own-origin relations without authenticating handles or issuing authority', () => {
  const data = fixture();
  const before = clone(data);
  const value = matchRailgunShieldOrigin(data);
  expect(value).toEqual(expected('matched'));
  expect(Object.isFrozen(value)).toBe(true);
  expect(data).toEqual(before);
  // Copying consistent data is allowed: diagnostic equality is not a registry.
  expect(matchRailgunShieldOrigin(clone(data))).toEqual(value);
});

test('checksum-equivalent owners match and a resolved lost acknowledgement is allowed', () => {
  const data = fixture();
  data.submitter = getAddress(owner);
  data.transaction.from = getAddress(owner);
  data.receipt.from = getAddress(owner);
  data.record.state = 'attempted';
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('matched'));
});

test('address normalization accepts only hex EOA syntax, not ICAP aliases', () => {
  const data = fixture();
  data.submitter = require('ethers').getIcapAddress(owner);
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('refused'));
});

test('third-party funding to the same private note refuses even with coherently rebound intent', () => {
  const data = fixture();
  data.transaction.from = data.receipt.from = '0x' + 'c'.repeat(40);
  data.record.intent = transactionIntent('railgun-native-shield', {
    ...data.transaction,
    data: data.transaction.input,
  });
  expect(inspectRailgunShieldReceipt(data.record, data.transaction, data.receipt).status).toBe(
    'matched'
  );
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('refused'));
});

test.each([
  [
    'absent resolution',
    (f) => {
      delete f.record.resolution;
    },
  ],
  [
    'archive shape',
    (f) => {
      delete f.record.state;
      f.record.railgun = f.record.resolution.railgun;
      delete f.record.resolution;
    },
  ],
  [
    'pending',
    (f) => {
      f.record.observation.status = 'pending';
    },
  ],
  [
    'reverted',
    (f) => {
      f.record.resolution.railgun.outcome = 'reverted';
    },
  ],
  [
    'insufficient confirmations',
    (f) => {
      f.record.observation.confirmations = 2;
    },
  ],
  [
    'unreviewed minimum',
    (f) => {
      f.record.resolution.minimumConfirmations = 2;
    },
  ],
  [
    'resolution fork',
    (f) => {
      f.record.resolution.blockHash = hex(99);
    },
  ],
  [
    'finalized fork',
    (f) => {
      f.record.resolution.railgun.finalizedBlockHash = hex(99);
    },
  ],
  [
    'future finality',
    (f) => {
      f.record.resolution.railgun.finalizedBlockNumber++;
    },
  ],
  [
    'wrong nonce',
    (f) => {
      f.transaction.nonce = '0x1';
    },
  ],
  [
    'wrong chain',
    (f) => {
      f.transaction.chainId = '0x1';
    },
  ],
  [
    'wrong receipt sender',
    (f) => {
      f.receipt.from = pins.proxy;
    },
  ],
  [
    'trailing calldata',
    (f) => {
      f.transaction.input += '00';
    },
  ],
  [
    'duplicate Shield event',
    (f) => {
      f.receipt.logs.push(clone(f.receipt.logs[0]));
    },
  ],
  [
    'removed Shield event',
    (f) => {
      f.receipt.logs[0].removed = true;
    },
  ],
  [
    'changed receipt block',
    (f) => {
      f.receipt.blockHash = hex(99);
    },
  ],
  [
    'changed log emitter',
    (f) => {
      f.receipt.logs[0].address = pins.relayAdapt;
    },
  ],
  [
    'checkpoint hash',
    (f) => {
      f.owned.checkpointHash = 'a'.repeat(64);
    },
  ],
  [
    'checkpoint source mutation',
    (f) => {
      f.checkpoint.source.ledgerId = 'a'.repeat(64);
    },
  ],
  [
    'owned tree substitution',
    (f) => {
      f.owned.trees[0].root = hex(99);
    },
  ],
  [
    'missing owned note',
    (f) => {
      f.owned.read.received = [];
    },
  ],
  [
    'duplicate owned note',
    (f) => {
      f.owned.read.received.push(clone(f.owned.read.received[0]));
    },
  ],
  [
    'duplicate creator',
    (f) => {
      f.owned.ownedPoi.push(clone(f.owned.ownedPoi[0]));
    },
  ],
  [
    'Transact creator',
    (f) => {
      f.owned.ownedPoi[0].type = 'Transact';
    },
  ],
  [
    'creator NPK',
    (f) => {
      f.owned.ownedPoi[0].npk = hex(99);
    },
  ],
  [
    'creator hash',
    (f) => {
      f.owned.ownedPoi[0].hash = hex(99);
    },
  ],
  [
    'creator transaction',
    (f) => {
      f.owned.ownedPoi[0].txid = hex(99);
    },
  ],
  [
    'creator block',
    (f) => {
      f.owned.ownedPoi[0].blockNumber--;
    },
  ],
  [
    'spent note',
    (f) => {
      f.owned.read.received[0].spentTxid = hex(99);
    },
  ],
  [
    'different amount',
    (f) => {
      f.owned.read.received[0].amount++;
    },
  ],
  [
    'wrong token',
    (f) => {
      f.owned.read.received[0].asset.contract = pins.proxy;
    },
  ],
  [
    'wrong token hash',
    (f) => {
      f.owned.read.received[0].tokenHash = hex(99);
    },
  ],
  [
    'wrong coordinates',
    (f) => {
      f.owned.read.received[0].position--;
    },
  ],
  [
    'caller authority flag',
    (f) => {
      f.authorized = true;
    },
  ],
])('refuses %s with no sensitive diagnostic fields', (_name, mutate) => {
  const data = fixture();
  mutate(data);
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('refused'));
});

test('rebinding both owned transaction hashes still cannot substitute a different original Shield', () => {
  const data = fixture();
  data.owned.read.received[0].txid = data.owned.ownedPoi[0].txid = hex(99);
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('refused'));
});

test('internally consistent changed fee is an anomaly for this restricted route', () => {
  const f = fixture();
  const args = abi.decodeEventLog('Shield', f.receipt.logs[0].data, f.receipt.logs[0].topics);
  const value = BigInt(prepared.noteValue) - 1n;
  Object.assign(
    f.receipt.logs[0],
    abi.encodeEventLog('Shield', [
      args[0],
      args[1],
      [[prepared.npk, [0, pins.wrappedNative, 0], value]],
      args[3],
      [BigInt(prepared.value) - value],
    ])
  );
  f.record.resolution.railgun.shield = inspectRailgunShieldReceipt(
    f.record,
    f.transaction,
    f.receipt
  );
  expect(f.record.resolution.railgun.shield.status).toBe('matched');
  expect(f.record.resolution.railgun.shield.feeDeviation).toBe(true);
  f.owned.read.received[0].amount = value;
  expect(matchRailgunShieldOrigin(f)).toEqual(expected('refused'));
});

test('later checkpoint can retain the origin but an earlier checkpoint cannot cover it', () => {
  const f = fixture();
  f.checkpoint.to.number++;
  f.checkpoint.to.hash = hex(105);
  f.owned.checkpointHash = checkpointHash(f.checkpoint);
  expect(matchRailgunShieldOrigin(f)).toEqual(expected('matched'));
  f.checkpoint.to.number -= 2;
  f.owned.checkpointHash = checkpointHash(f.checkpoint);
  expect(matchRailgunShieldOrigin(f)).toEqual(expected('refused'));
});

test.each([
  'getter',
  'proxy',
  'array prototype',
  'iterator',
  'cycle',
  'oversized string',
  'sparse array',
])('refuses unsafe %s data without invoking caller code; later valid data succeeds', (kind) => {
  const f = fixture(),
    hook = jest.fn(() => {
      throw Error('caller hook');
    });
  if (kind === 'getter') Object.defineProperty(f.transaction, 'from', { get: hook });
  if (kind === 'proxy') f.owned = new Proxy(f.owned, { ownKeys: hook });
  if (kind === 'array prototype') Object.setPrototypeOf(f.receipt.logs, { toJSON: hook });
  if (kind === 'iterator') f.receipt.logs[Symbol.iterator] = hook;
  if (kind === 'cycle') f.owned.self = f.owned;
  if (kind === 'oversized string') f.transaction.input = 'x'.repeat(262145);
  if (kind === 'sparse array') f.receipt.logs.length = 3;
  expect(matchRailgunShieldOrigin(f)).toEqual(expected('refused'));
  expect(hook).not.toHaveBeenCalled();
  expect(matchRailgunShieldOrigin(fixture())).toEqual(expected('matched'));
});

test('matching and refusal do not access context authority or construct storage', () => {
  const storage = require('./privacy-storage');
  const context = require('../networks/privacy-context');
  expect(matchRailgunShieldOrigin(fixture())).toEqual(expected('matched'));
  expect(matchRailgunShieldOrigin(null)).toEqual(expected('refused'));
  for (const method of [
    storage.createPrivacyStorage,
    storage.getPrivacyStoragePath,
    context.createPrivacyScope,
    context.getPrivacyContext,
  ])
    expect(method).not.toHaveBeenCalled();
});

test.each(['key', 'array'])('refuses oversized %s containers', (kind) => {
  const data = fixture();
  if (kind === 'key') data.owned['x'.repeat(257)] = false;
  else data.owned.read.received = Array(10001).fill(data.owned.read.received[0]);
  expect(matchRailgunShieldOrigin(data)).toEqual(expected('refused'));
});
