const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const {
  PRIVATE_EVENTS,
  inspectRailgunTransactReceipt: inspect,
} = require('./railgun-transact-receipt');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([TRANSACT_ABI, ...PRIVATE_EVENTS]);
const hash = '0x' + 'a'.repeat(64),
  block = '0x' + 'b'.repeat(64);
function data(unshield = false) {
  const f = fixture(unshield),
    original = f.transaction();
  const transaction = {
    ...original,
    chainId: '0xaa36a7',
    value: '0x0',
    hash,
    nonce: '0x3',
    input: original.data,
    blockHash: block,
    blockNumber: '0x123',
    transactionIndex: '0x4',
  };
  delete transaction.data;
  const record = { hash, nonce: 3, intent: railgunTransactJournalIntent(original) };
  const events = [
    ['Nullified', [f.inner.boundParams.treeNumber, f.inner.nullifiers]],
    unshield
      ? ['Unshield', [f.recipient, [0, pins.wrappedNative, 0], 998n, 2n]]
      : ['Transact', [1n, 123n, f.inner.commitments, f.inner.boundParams.commitmentCiphertext]],
  ];
  const log = (index) => ({
    ...abi.encodeEventLog(events[index][0], events[index][1]),
    address: pins.proxy,
    transactionHash: hash,
    blockHash: block,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logIndex: index === 0 ? '0x5' : '0x8',
    removed: false,
  });
  const receipt = {
    status: '0x1',
    transactionHash: hash,
    from: transaction.from,
    to: pins.proxy,
    blockHash: block,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logs: [log(0), log(1)],
  };
  return { record, transaction, receipt, events, log, f };
}
test.each([false, true])(
  'matches exact %s outcome data without granting verification or retry',
  (unshield) => {
    const { record, transaction, receipt } = data(unshield);
    const result = inspect(record, transaction, receipt);
    expect(result).toMatchObject({
      status: 'matched',
      inputTree: 0,
      intentDigest: record.intent.intentDigest,
      nullifier: record.intent.nullifier,
      commitment: record.intent.commitment,
      spendingEnabled: false,
      trust: 'unverified-rpc',
    });
    expect(result.output).toEqual(
      unshield
        ? {
            kind: 'unshield',
            logIndex: '0x8',
            recipient: record.intent.recipient,
            token: pins.wrappedNative,
            amount: '1000',
            received: '998',
            fee: '2',
            feeDeviation: false,
          }
        : { kind: 'shielded', tree: 1, position: 123, logIndex: '0x8' }
    );
    expect(Object.isFrozen(result.output)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  }
);
test('records actual fee deviation without pretending the observed funds did not move', () => {
  const v = data(true);
  v.events[1][1][2] = 997n;
  v.events[1][1][3] = 3n;
  v.receipt.logs[1] = v.log(1);
  expect(inspect(v.record, v.transaction, v.receipt)).toMatchObject({
    status: 'matched',
    output: { feeDeviation: true, received: '997', fee: '3' },
  });
});
test.each([
  (v) => {
    v.transaction.hash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.transaction.nonce = '0x4';
  },
  (v) => {
    v.transaction.chainId = '0x1';
  },
  (v) => {
    v.transaction.from = '0x' + '56'.repeat(20);
  },
  (v) => {
    v.transaction.to = pins.implementation;
  },
  (v) => {
    v.transaction.blockHash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.transaction.blockNumber = '0x124';
  },
  (v) => {
    v.transaction.transactionIndex = '0x5';
  },
  (v) => {
    v.transaction.input += '00'.repeat(32);
  },
  (v) => {
    v.receipt.status = '0x0';
  },
  (v) => {
    v.receipt.transactionHash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.receipt.from = '0x' + '56'.repeat(20);
  },
  (v) => {
    v.receipt.to = pins.relayAdapt;
  },
  (v) => {
    v.receipt.blockHash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.receipt.logs[0].removed = true;
  },
  (v) => {
    v.receipt.logs[1].blockNumber = '0x124';
  },
  (v) => {
    v.receipt.logs[1].transactionIndex = '0x5';
  },
  (v) => {
    v.receipt.logs[1].transactionHash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.receipt.logs[1].logIndex = '0x5';
  },
  (v) => {
    v.receipt.logs[1].data += '00'.repeat(32);
  },
  (v) => {
    v.receipt.logs.push(v.receipt.logs[1]);
  },
  (v) => {
    v.receipt.logs.reverse();
  },
  (v) => {
    v.receipt.logs[1].address = pins.relayAdapt;
  },
  (v) => {
    v.record.intent.intentDigest = '0x' + '1'.repeat(64);
  },
])('rejects transaction, metadata or log mismatch %#', (change) => {
  const v = data();
  v.record.intent = { ...v.record.intent };
  change(v);
  expect(inspect(v.record, v.transaction, v.receipt)).toEqual({
    status: 'anomaly',
    transactionHash: hash,
    trust: 'unverified-rpc',
    spendingEnabled: false,
  });
});
test.each([
  (v) => {
    v.events[0][1][0] = 1n;
  },
  (v) => {
    v.events[0][1][1] = ['0x' + '1'.repeat(64)];
  },
  (v) => {
    v.events[0][1][1].push(v.events[0][1][1][0]);
  },
  (v) => {
    v.events[1][1][0] = 65536n;
  },
  (v) => {
    v.events[1][1][1] = 65536n;
  },
  (v) => {
    v.events[1][1][2] = ['0x' + '1'.repeat(64)];
  },
  (v) => {
    v.events[1][1][3][0].memo = '0x12';
  },
  (v) => {
    v.events[1][1][3][0].ciphertext[0] = '0x' + '1'.repeat(64);
  },
  (v) => {
    v.events[1][1][3][0].blindedReceiverViewingKey = '0x' + '1'.repeat(64);
  },
])('rejects different private-transfer output or nullification %#', (change) => {
  const v = data();
  change(v);
  v.receipt.logs = [v.log(0), v.log(1)];
  expect(inspect(v.record, v.transaction, v.receipt).status).toBe('anomaly');
});
test.each([
  (v) => {
    v.events[1][1][0] = '0x' + '56'.repeat(20);
  },
  (v) => {
    v.events[1][1][1][0] = 1;
  },
  (v) => {
    v.events[1][1][1][1] = pins.proxy;
  },
  (v) => {
    v.events[1][1][1][2] = 1;
  },
  (v) => {
    v.events[1][1][2] = 999n;
  },
  (v) => {
    v.events[1][1][2] = 0n;
    v.events[1][1][3] = 1000n;
  },
])('rejects different unshield destination/token/amount %#', (change) => {
  const v = data(true);
  change(v);
  v.receipt.logs[1] = v.log(1);
  expect(inspect(v.record, v.transaction, v.receipt).status).toBe('anomaly');
});
test('ignores token-contract logs but never extra proxy events', () => {
  const v = data();
  v.receipt.logs.splice(1, 0, { address: pins.wrappedNative, data: '0x', topics: [] });
  expect(inspect(v.record, v.transaction, v.receipt).status).toBe('matched');
  v.receipt.logs[1].address = pins.proxy;
  expect(inspect(v.record, v.transaction, v.receipt).status).toBe('anomaly');
});

const { createHash } = require('crypto');
const receiptPolicy = require('./railgun-transact-receipt-policy');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const tokenAbi = new Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
function partialData({ unshieldAmount = '400', fee = '1', sameRecipient = false } = {}) {
  const f = createRailgunPartialCapsuleData({ inputAmount: '1000', unshieldAmount });
  if (sameRecipient)
    f.inner.unshieldPreimage.npk = '0x' + receiptPolicy.treasury.slice(2).padStart(64, '0');
  const original = {
    ...f.capsule.preparation.transaction,
    from: '0x' + '34'.repeat(20),
    data: f.encode(),
  };
  const transaction = {
    ...original,
    chainId: '0xaa36a7',
    value: '0x0',
    hash,
    nonce: '0x3',
    input: original.data,
    blockHash: block,
    blockNumber: '0x123',
    transactionIndex: '0x4',
  };
  delete transaction.data;
  const record = { hash, nonce: 3, intent: railgunTransactJournalIntent(original) };
  const received = BigInt(unshieldAmount) - BigInt(fee);
  const recipient = record.intent.recipient;
  const events = [
    ['Nullified', [f.inner.boundParams.treeNumber, f.inner.nullifiers]],
    ['Transfer', [pins.proxy, recipient, received]],
    ['Transfer', [pins.proxy, receiptPolicy.treasury, BigInt(fee)]],
    ['Unshield', [recipient, [0, pins.wrappedNative, 0], received, BigInt(fee)]],
    ['Transact', [1n, 123n, [f.inner.commitments[0]], f.inner.boundParams.commitmentCiphertext]],
  ];
  const log = (n) => ({
    ...(n === 1 || n === 2 ? tokenAbi : abi).encodeEventLog(events[n][0], events[n][1]),
    address: n === 1 || n === 2 ? pins.wrappedNative : pins.proxy,
    transactionHash: hash,
    blockHash: block,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logIndex: '0x' + (5 + n).toString(16),
    removed: false,
  });
  const receipt = {
    status: '0x1',
    transactionHash: hash,
    from: transaction.from,
    to: pins.proxy,
    blockHash: block,
    blockNumber: transaction.blockNumber,
    transactionIndex: transaction.transactionIndex,
    logs: events.map((_event, n) => log(n)),
  };
  return { f, record, transaction, receipt, events, log };
}
test.each([
  [false, '7c854093a753a885059d5cfa0d07f0eefe8f261665c1671e810cbb9eb85d3556'],
  [true, '0ef06a1ce483d52cb4ff584eb66627c06f669c9d7a53b9b2b6bb182eb7818c68'],
])('preserves legacy %s receipt golden bytes', (u, golden) => {
  const d = data(u);
  expect(
    createHash('sha256')
      .update(JSON.stringify(inspect(d.record, d.transaction, d.receipt)))
      .digest('hex')
  ).toBe(golden);
});
test('uses an immutable explicit unverified historical policy, not receipt-derived treasury', () => {
  expect(receiptPolicy).toEqual({
    id: 'railgun-sepolia-partial-receipt-v1',
    treasury: '0x0dce0fe955222a3ed1b756b1d962dd0a1615e1af',
    observedBlock: 11829346,
    chainId: 11155111,
    trust: 'unverified-rpc',
  });
  expect(Object.isFrozen(receiptPolicy)).toBe(true);
});
test.each([
  { unshieldAmount: '400', fee: '1', sameRecipient: false },
  { unshieldAmount: '399', fee: '0', sameRecipient: false },
  { unshieldAmount: '400', fee: '1', sameRecipient: true },
  { unshieldAmount: '1', fee: '0', sameRecipient: true },
  { unshieldAmount: '400', fee: '2', sameRecipient: false },
])('matches both partial outcomes and distinct transfers %j', (options) => {
  const d = partialData(options),
    i = d.record.intent;
  const result = inspect(d.record, d.transaction, d.receipt);
  expect(result).toEqual({
    version: 2,
    receiptPolicy: receiptPolicy.id,
    status: 'matched',
    transactionHash: hash,
    blockHash: block,
    blockNumber: '0x123',
    operation: 'railgun-partial-unshield',
    inputTree: i.tree,
    nullifier: i.nullifier,
    changeCommitment: i.changeCommitment,
    unshieldCommitment: i.unshieldCommitment,
    boundParamsHash: i.boundParamsHash,
    intentDigest: i.intentDigest,
    nullifiedLogIndex: '0x5',
    output: {
      kind: 'partial-unshield',
      change: { kind: 'shielded', tree: 1, position: 123, logIndex: '0x9' },
      unshield: {
        kind: 'unshield',
        logIndex: '0x8',
        recipient: i.recipient,
        token: pins.wrappedNative,
        unshieldAmount: options.unshieldAmount,
        received: (BigInt(options.unshieldAmount) - BigInt(options.fee)).toString(),
        fee: options.fee,
        feeDeviation: BigInt(options.fee) !== (BigInt(options.unshieldAmount) * 25n) / 10000n,
        treasury: receiptPolicy.treasury,
        recipientTransferLogIndex: '0x6',
        treasuryTransferLogIndex: '0x7',
      },
    },
    trust: 'unverified-rpc',
    spendingEnabled: false,
  });
  for (const v of [result, result.output, result.output.change, result.output.unshield])
    expect(Object.isFrozen(v)).toBe(true);
  expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  const { validRailgunTransactResolution } = require('./railgun-transact-resolution');
  expect(
    validRailgunTransactResolution(
      {
        outcome: 'matched',
        finalizedBlockNumber: 291,
        finalizedBlockHash: block,
        transact: JSON.parse(JSON.stringify(result)),
      },
      { ...d.record, observation: { status: 'included', blockNumber: 291, blockHash: block } }
    )
  ).toBe(true);
});
test.each([
  [
    'missing zero-fee log',
    (v) => {
      v.receipt.logs.splice(2, 1);
    },
  ],
  [
    'equal-recipient merged transfer',
    (v) => {
      v.receipt.logs[1] = {
        ...v.receipt.logs[1],
        data: tokenAbi.encodeEventLog('Transfer', [pins.proxy, receiptPolicy.treasury, 1n]).data,
      };
      v.receipt.logs.splice(2, 1);
    },
  ],
  [
    'extra WETH event',
    (v) => {
      v.receipt.logs.push({ ...v.receipt.logs[2], logIndex: '0xa' });
    },
  ],
  [
    'extra unrelated event',
    (v) => {
      v.receipt.logs.push({
        ...v.receipt.logs[2],
        address: '0x' + '56'.repeat(20),
        logIndex: '0xa',
      });
    },
  ],
  [
    'extra proxy event',
    (v) => {
      v.receipt.logs.push({ ...v.receipt.logs[0], logIndex: '0xa' });
    },
  ],
  [
    'swapped transfer positions',
    (v) => {
      [v.receipt.logs[1], v.receipt.logs[2]] = [v.receipt.logs[2], v.receipt.logs[1]];
    },
  ],
  [
    'swapped proxy events',
    (v) => {
      [v.receipt.logs[3], v.receipt.logs[4]] = [v.receipt.logs[4], v.receipt.logs[3]];
    },
  ],
  [
    'wrong transfer emitter',
    (v) => {
      v.receipt.logs[1].address = pins.proxy;
    },
  ],
  [
    'wrong proxy emitter',
    (v) => {
      v.receipt.logs[3].address = pins.wrappedNative;
    },
  ],
  [
    'wrong transfer topic',
    (v) => {
      v.receipt.logs[1].topics[0] = '0x' + '0'.repeat(64);
    },
  ],
  [
    'extra transfer topic',
    (v) => {
      v.receipt.logs[1].topics.push('0x' + '0'.repeat(64));
    },
  ],
  [
    'missing transfer topic',
    (v) => {
      v.receipt.logs[1].topics.pop();
    },
  ],
  [
    'noncanonical indexed address',
    (v) => {
      v.receipt.logs[1].topics[1] = '0x01' + v.receipt.logs[1].topics[1].slice(4);
    },
  ],
  [
    'transfer trailing data',
    (v) => {
      v.receipt.logs[2].data += '00'.repeat(32);
    },
  ],
  [
    'duplicate log index',
    (v) => {
      v.receipt.logs[2].logIndex = v.receipt.logs[1].logIndex;
    },
  ],
  [
    'unsafe index',
    (v) => {
      v.receipt.logs[4].logIndex = '0x20000000000000';
    },
  ],
  [
    'removed',
    (v) => {
      v.receipt.logs[2].removed = true;
    },
  ],
  [
    'missing removed flag',
    (v) => {
      delete v.receipt.logs[2].removed;
    },
  ],
  [
    'foreign hash',
    (v) => {
      v.receipt.logs[2].transactionHash = '0x' + 'c'.repeat(64);
    },
  ],
  [
    'foreign block',
    (v) => {
      v.receipt.logs[1].blockHash = '0x' + 'c'.repeat(64);
    },
  ],
  [
    'foreign height',
    (v) => {
      v.receipt.logs[2].blockNumber = '0x124';
    },
  ],
  [
    'foreign transaction index',
    (v) => {
      v.receipt.logs[1].transactionIndex = '0x5';
    },
  ],
  [
    'unversioned intent',
    (v) => {
      v.record.intent = { ...v.record.intent };
      delete v.record.intent.version;
    },
  ],
])('refuses partial receipt %s including zero fee/equal-recipient cases', (_name, change) => {
  const v = partialData({ unshieldAmount: '1', fee: '0', sameRecipient: true });
  change(v);
  expect(inspect(v.record, v.transaction, v.receipt)).toEqual({
    status: 'anomaly',
    transactionHash: hash,
    trust: 'unverified-rpc',
    spendingEnabled: false,
  });
});
test.each([
  [
    'wrong nullifier',
    (v) => {
      v.events[0][1][1] = ['0x' + '1'.repeat(64)];
    },
  ],
  [
    'wrong input tree',
    (v) => {
      v.events[0][1][0] = 1;
    },
  ],
  [
    'wrong base source',
    (v) => {
      v.events[1][1][0] = pins.implementation;
    },
  ],
  [
    'wrong fee source',
    (v) => {
      v.events[2][1][0] = pins.implementation;
    },
  ],
  [
    'wrong base recipient',
    (v) => {
      v.events[1][1][1] = receiptPolicy.treasury;
    },
  ],
  [
    'wrong treasury',
    (v) => {
      v.events[2][1][1] = v.record.intent.recipient;
    },
  ],
  [
    'wrong base amount',
    (v) => {
      v.events[1][1][2] = 398n;
    },
  ],
  [
    'wrong fee amount',
    (v) => {
      v.events[2][1][2] = 2n;
    },
  ],
  [
    'unshield recipient',
    (v) => {
      v.events[3][1][0] = receiptPolicy.treasury;
    },
  ],
  [
    'unshield token',
    (v) => {
      v.events[3][1][1][1] = pins.proxy;
    },
  ],
  [
    'unshield token type',
    (v) => {
      v.events[3][1][1][0] = 1;
    },
  ],
  [
    'unshield sub-id',
    (v) => {
      v.events[3][1][1][2] = 1;
    },
  ],
  [
    'conservation despite coherent transfers',
    (v) => {
      v.events[1][1][2] = 400n;
      v.events[3][1][2] = 400n;
    },
  ],
  [
    'zero received despite conservation',
    (v) => {
      v.events[1][1][2] = 0n;
      v.events[2][1][2] = 400n;
      v.events[3][1][2] = 0n;
      v.events[3][1][3] = 400n;
    },
  ],
  [
    'unshield commitment as change',
    (v) => {
      v.events[4][1][2] = [v.record.intent.unshieldCommitment];
    },
  ],
  [
    'both commitments as UTXO leaves',
    (v) => {
      v.events[4][1][2].push(v.record.intent.unshieldCommitment);
    },
  ],
  [
    'change tree overflow',
    (v) => {
      v.events[4][1][0] = 65536;
    },
  ],
  [
    'change position overflow',
    (v) => {
      v.events[4][1][1] = 65536;
    },
  ],
  [
    'missing ciphertext',
    (v) => {
      v.events[4][1][3] = [];
    },
  ],
  [
    'extra ciphertext',
    (v) => {
      v.events[4][1][3].push(v.events[4][1][3][0]);
    },
  ],
  [
    'ciphertext',
    (v) => {
      v.events[4][1][3][0].ciphertext[0] = '0x' + '1'.repeat(64);
    },
  ],
  [
    'sender viewing key',
    (v) => {
      v.events[4][1][3][0].blindedSenderViewingKey = '0x' + '1'.repeat(64);
    },
  ],
  [
    'receiver viewing key',
    (v) => {
      v.events[4][1][3][0].blindedReceiverViewingKey = '0x' + '1'.repeat(64);
    },
  ],
  [
    'annotation',
    (v) => {
      v.events[4][1][3][0].annotationData = '0x1234';
    },
  ],
  [
    'memo',
    (v) => {
      v.events[4][1][3][0].memo = '0x1234';
    },
  ],
])('refuses partial event binding %s', (_name, change) => {
  const v = partialData();
  change(v);
  v.receipt.logs = v.events.map((_event, n) => v.log(n));
  expect(inspect(v.record, v.transaction, v.receipt).status).toBe('anomaly');
});
test('does not infer or accept a replacement treasury from caller metadata', () => {
  const v = partialData();
  const other = '0x' + '56'.repeat(20);
  v.events[2][1][1] = other;
  v.receipt.logs[2] = v.log(2);
  v.receipt.treasury = other;
  v.record.treasury = other;
  expect(inspect(v.record, v.transaction, v.receipt, { treasury: other }).status).toBe('anomaly');
});
