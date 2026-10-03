const { Interface } = require('ethers');
const { collectRailgunOwnSource: collect } = require('./railgun-own-source');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { checkpointHash } = require('./railgun-wallet-coverage');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface(PRIVATE_EVENTS);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function fixture(unshield = false) {
  const { record, transaction, receipt } = sample(unshield);
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: 300, hash: hex(300) },
    anchor: { number: 310, hash: hex(310) },
    logs: { count: 2, sha256: 'a'.repeat(64) },
    source: {
      level: 'unverified-rpc',
      providersSha256: 'b'.repeat(64),
      ledgerId: 'c'.repeat(64),
      ledgerSha256: 'd'.repeat(64),
    },
    state: {
      schema: 'public-records-v1',
      storeId: 'e'.repeat(64),
      trees: [{ tree: 0, length: 1, root: hex(1) }],
      commitments: { count: 1, sha256: 'f'.repeat(64) },
      nullifiers: { count: 1, sha256: '1'.repeat(64) },
      unshields: { count: Number(unshield), sha256: '2'.repeat(64) },
    },
  };
  const logs = receipt.logs.map((log) => ({
    address: log.address,
    blockNumber: Number(BigInt(log.blockNumber)),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: Number(BigInt(log.transactionIndex)),
    logIndex: Number(BigInt(log.logIndex)),
    topics: [...log.topics],
    data: log.data,
  }));
  let visitedCount = 0;
  const options = {
    record,
    transaction,
    receipt,
    checkpoint,
    assertCurrent: jest.fn(),
    visit: jest.fn(async (visitor) => {
      for (const log of logs) {
        await visitor(log);
        visitedCount++;
      }
      return {
        count: logs.length,
        bytes: logs.reduce((sum, log) => sum + Buffer.byteLength(JSON.stringify(log) + '\n'), 0),
      };
    }),
  };
  return { options, logs, visitedCount: () => visitedCount };
}
test.each([false, true])(
  'matches exact %s proxy group as frozen data with no authority',
  async (unshield) => {
    const f = fixture(unshield),
      result = await collect(f.options);
    expect(result).toMatchObject({
      transactionHash: f.options.record.hash,
      blockNumber: 291,
      transactionIndex: 4,
      sourceAuthenticated: false,
      receiptStatusAuthenticated: false,
      accountAuthenticated: false,
      currentFinalityVerified: false,
      spendingEnabled: false,
    });
    expect(result.checkpointHash).toBe(checkpointHash(f.options.checkpoint));
    expect(result.logs).toEqual(f.logs);
    expect(Object.isFrozen(result.logs[0].topics)).toBe(true);
    expect(Object.isFrozen(result.suppliedOutcome.output)).toBe(true);
    f.logs[0].topics[0] = hex(999);
    expect(result.logs[0].topics[0]).not.toBe(hex(999));
  }
);
test('ignores unrelated token-contract receipt logs without omitting proxy events', async () => {
  const f = fixture();
  f.options.receipt.logs.splice(1, 0, { address: pins.wrappedNative, data: '0x', topics: [] });
  expect((await collect(f.options)).logs).toHaveLength(2);
});
test.each([
  [
    'extra event',
    (f) => {
      f.logs.push({ ...f.logs[1], logIndex: 9 });
    },
  ],
  [
    'different block',
    (f) => {
      f.logs[0].blockNumber = 290;
    },
  ],
  [
    'different block hash',
    (f) => {
      f.logs[0].blockHash = hex(999);
    },
  ],
  [
    'different index',
    (f) => {
      f.logs[0].transactionIndex = 3;
    },
  ],
  [
    'missing event',
    (f) => {
      f.logs.pop();
    },
  ],
  [
    'extra data',
    (f) => {
      f.logs[1].data += '00'.repeat(32);
    },
  ],
  [
    'ciphertext',
    (f) => {
      const args = abi.decodeEventLog('Transact', f.logs[1].data, f.logs[1].topics);
      const cipher = args.ciphertext[0].toArray(true);
      cipher[0][0] = hex(999);
      Object.assign(
        f.logs[1],
        abi.encodeEventLog('Transact', [
          args.treeNumber,
          args.startPosition,
          [...args.hash],
          [cipher],
        ])
      );
    },
  ],
])('refuses %s and drains semantic mismatches', async (_name, change) => {
  const f = fixture();
  change(f);
  f.logs.push({
    ...f.logs[0],
    transactionHash: hex(777),
    blockNumber: 292,
    blockHash: hex(292),
    transactionIndex: 0,
    logIndex: 0,
  });
  await expect(collect(f.options)).rejects.toMatchObject({ code: 'RAILGUN_OWN_SOURCE_REFUSED' });
  expect(f.visitedCount()).toBe(f.logs.length);
});
test('checks exact unshield fee split, not only the unchanged gross amount', async () => {
  const f = fixture(true);
  Object.assign(
    f.logs[1],
    abi.encodeEventLog('Unshield', [
      f.options.record.intent.recipient,
      [0, pins.wrappedNative, 0],
      997,
      3,
    ])
  );
  await expect(collect(f.options)).rejects.toThrow();
  expect(f.visitedCount()).toBe(2);
});
test.each(['tail', 'count', 'cancel'])(
  'never returns an early match before %s refusal',
  async (mode) => {
    const f = fixture(),
      visit = f.options.visit.getMockImplementation();
    f.options.visit.mockImplementation(async (visitor) => {
      const result = await visit(visitor);
      if (mode === 'tail') throw Error('private source backend detail');
      if (mode === 'count') result.count++;
      if (mode === 'cancel')
        f.options.assertCurrent.mockImplementation(() => {
          throw Error('cancelled');
        });
      return result;
    });
    await expect(collect(f.options)).rejects.toMatchObject({
      code: 'RAILGUN_OWN_SOURCE_REFUSED',
      message: 'Railgun own source comparison unavailable',
    });
  }
);
test('pins caller data before asynchronous visitation', async () => {
  const f = fixture(),
    visit = f.options.visit.getMockImplementation();
  f.options.visit.mockImplementation(async (visitor) => {
    f.options.receipt.transactionIndex = '0x9';
    f.options.transaction.input = '0x';
    f.options.checkpoint.source.ledgerSha256 = '9'.repeat(64);
    return visit(visitor);
  });
  const result = await collect(f.options);
  expect(result.transactionIndex).toBe(4);
  expect(result.source.ledgerSha256).toBe('d'.repeat(64));
});
test('awaits authenticated suffix after receiving a correct selected group', async () => {
  const f = fixture(),
    visit = f.options.visit.getMockImplementation();
  let release,
    settled = false;
  f.options.visit.mockImplementation(async (visitor) => {
    const result = await visit(visitor);
    await new Promise((resolve) => {
      release = resolve;
    });
    return result;
  });
  const pending = collect(f.options).then((value) => {
    settled = true;
    return value;
  });
  for (let n = 0; n < 8; n++) await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect((await pending).transactionHash).toBe(f.options.record.hash);
});
test.each(['unsafe-index', 'receipt-status', 'oversize', 'checkpoint-before-transaction'])(
  'rejects %s before visiting source',
  async (mode) => {
    const f = fixture();
    if (mode === 'unsafe-index') {
      const index = '0x1000000000000000';
      f.options.receipt.transactionIndex = f.options.transaction.transactionIndex = index;
      f.options.receipt.logs.forEach((log) => {
        log.transactionIndex = index;
      });
    }
    if (mode === 'receipt-status') f.options.receipt.status = '0x0';
    if (mode === 'oversize') f.options.receipt.extra = 'x'.repeat(128 * 1024);
    if (mode === 'checkpoint-before-transaction') f.options.checkpoint.to.number = 290;
    await expect(collect(f.options)).rejects.toThrow();
    expect(f.options.visit).not.toHaveBeenCalled();
  }
);
