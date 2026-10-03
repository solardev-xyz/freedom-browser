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
