const { matchRailgunOwnTxid: match } = require('./railgun-own-txid');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'matches bounded transfer/unshield %s and active/archive %s facts only',
  (unshield, archived) => {
    const v = sample(unshield, archived),
      result = match(v);
    expect(result).toMatchObject({
      status: 'matched',
      recordKind: archived ? 'archived' : 'active',
      transactionHash: v.record.hash,
      blockNumber: 291,
      transactionIndex: 4,
      boundParamsCompared: true,
      unshieldPreimageCompared: unshield,
      sourceAuthenticated: false,
      currentCanonicalityVerified: false,
      finalityVerified: false,
      txidPathVerified: false,
      txidRootAccepted: false,
      rowMetadataAuthenticated: false,
      unshieldCommitmentHashVerified: false,
      poiVerified: false,
      spendingEnabled: false,
    });
    expect(result.row).toEqual(v.row);
    expect(result.row).not.toBe(v.row);
    const before = JSON.stringify(result);
    v.row.nullifiers[0] = hex(90);
    v.capsule.preparation.amount = '99';
    expect(JSON.stringify(result)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.row.nullifiers)).toBe(true);
    expect(Object.isFrozen(result.output)).toBe(true);
    if (unshield) expect(Object.isFrozen(result.row.unshield.tokenData)).toBe(true);
  }
);
const changes = [
  [
    'row hash',
    (v) => {
      v.row.txid = hex(101).slice(2);
    },
  ],
  [
    'bound parameters',
    (v) => {
      v.row.boundParamsHash = hex(99);
    },
  ],
  [
    'nullifier',
    (v) => {
      v.row.nullifiers = [hex(99)];
    },
  ],
  [
    'commitment',
    (v) => {
      v.row.commitments = [hex(99)];
    },
  ],
  [
    'input tree',
    (v) => {
      v.row.utxoTreeIn = 1;
    },
  ],
  [
    'output tree',
    (v) => {
      v.row.utxoTreeOut = 2;
    },
  ],
  [
    'output position',
    (v) => {
      v.row.utxoBatchStartPositionOut++;
    },
  ],
  [
    'block',
    (v) => {
      v.row.blockNumber++;
      v.row.graphID = hex(292) + hex(4).slice(2) + '0'.repeat(64);
    },
  ],
  [
    'transaction index',
    (v) => {
      v.row.graphID = hex(291) + hex(5).slice(2) + '0'.repeat(64);
    },
  ],
  [
    'nonzero slot',
    (v) => {
      v.row.graphID = v.row.graphID.slice(0, -1) + '1';
    },
  ],
  [
    'oversized index',
    (v) => {
      const n = 1n << 60n;
      v.row.graphID = hex(291) + hex(n).slice(2) + '0'.repeat(64);
      v.receipt.transactionIndex = v.transaction.transactionIndex = '0x' + n.toString(16);
      v.receipt.logs.forEach((log) => {
        log.transactionIndex = v.receipt.transactionIndex;
      });
    },
  ],
  [
    'different capsule',
    (v) => {
      v.capsule.preparation.transaction.data = sample(true).capsule.preparation.transaction.data;
    },
  ],
  [
    'proof bytes',
    (v) => {
      const f = fixture();
      f.inner.proof.a.x = 100n;
      v.transaction.input = f.transaction().data;
    },
  ],
  [
    'wrong receipt',
    (v) => {
      v.receipt.logs[1].logIndex = '0x9';
    },
  ],
  [
    'unshield field on transfer',
    (v) => {
      v.row.unshield = sample(true).row.unshield;
    },
  ],
  [
    'extra output',
    (v) => {
      v.row.commitments.push(hex(99));
    },
  ],
  [
    'malformed row',
    (v) => {
      v.row.timestamp = -1;
    },
  ],
  [
    'oversized input',
    (v) => {
      v.receipt.extra = 'x'.repeat(128 * 1024);
    },
  ],
];
test.each(changes)('refuses inconsistent %s with generic error', (_name, change) => {
  const v = sample();
  change(v);
  expect(() => match(v)).toThrow('Railgun own transaction binding unavailable');
});
test.each([
  (v) => {
    v.record.resolution = null;
  },
  (v) => {
    v.record.resolution.railgun.outcome = 'reverted';
  },
  (v) => {
    v.record.resolution.railgun.transact.output.position++;
  },
  (v) => {
    v.record.observation.confirmations = 2;
  },
  (v) => {
    v.record.resolution.minimumConfirmations = 2;
  },
  (v) => {
    v.record.status = 'included';
  },
  (v) => {
    v.record.railgun = v.record.resolution.railgun;
  },
])('refuses missing/contradictory active resolution %#', (change) => {
  const v = sample();
  change(v);
  expect(() => match(v)).toThrow();
});
test.each([
  (v) => {
    v.record.railgun.transact.output.position++;
  },
  (v) => {
    v.record.resolution = { railgun: v.record.railgun };
  },
  (v) => {
    v.record.observation = { status: 'included' };
  },
  (v) => {
    v.record.blockHash = hex(999);
  },
  (v) => {
    v.record.finalized.blockNumber = 290;
  },
])('refuses contradictory archived resolution %#', (change) => {
  const v = sample(false, true);
  change(v);
  expect(() => match(v)).toThrow();
});
test.each([
  (v) => {
    delete v.row.unshield;
  },
  (v) => {
    v.row.unshield.value = '998';
  },
  (v) => {
    v.row.unshield.toAddress = pins.proxy;
  },
  (v) => {
    v.row.unshield.tokenData.tokenAddress = pins.proxy;
  },
  (v) => {
    v.row.unshield.tokenData.tokenSubID = hex(1);
  },
  (v) => {
    v.row.utxoTreeOut = 0;
    v.row.utxoBatchStartPositionOut = 0;
  },
])('refuses wrong unshield semantics %#', (change) => {
  const v = sample(true);
  change(v);
  expect(() => match(v)).toThrow();
});
test('does not infer timestamp, verification continuity or crypto validity from matching data', () => {
  const v = sample(true);
  v.row.timestamp = 2;
  v.row.verificationHash = hex(999);
  const result = match(v);
  expect(result.rowMetadataAuthenticated).toBe(false);
  // Structural fixture deliberately uses a commitment without a valid preimage.
  expect(result.unshieldCommitmentHashVerified).toBe(false);
});

test.each([
  (v) => {
    delete v.record.attemptedAt;
  },
  (v) => {
    v.record.attemptedAt = -1;
  },
  (v) => {
    v.record.revision = -1;
  },
  (v) => {
    delete v.record.observation.trust;
  },
  (v) => {
    v.record.observation.trust = 'verified';
  },
  (v) => {
    delete v.record.observation.observedAt;
  },
  (v) => {
    v.record.observation.observedAt = -1;
  },
])('rejects active metadata refused by the journal decoder %#', (change) => {
  const v = sample();
  change(v);
  expect(() => match(v)).toThrow();
});
test('supports legacy active records without optional revision', () => {
  const v = sample();
  delete v.record.revision;
  expect(match(v).recordKind).toBe('active');
});
test.each([
  (v) => {
    v.record.finalized = { blockNumber: 291, blockHash: hex(999) };
  },
  (v) => {
    v.record.finalized = { blockNumber: 300, blockHash: hex(999) };
  },
  (v) => {
    v.record.finalized = { blockNumber: 299, blockHash: hex(201) };
  },
])('rejects contradictory/regressing archival anchors %#', (change) => {
  const v = sample(false, true);
  change(v);
  expect(() => match(v)).toThrow();
});
test('accepts equal consistent archived finality anchors without claiming current finality', () => {
  const v = sample(false, true);
  v.record.finalized = { blockNumber: 300, blockHash: hex(201) };
  expect(match(v).finalityVerified).toBe(false);
  v.record.railgun.finalizedBlockNumber = v.record.finalized.blockNumber = 291;
  v.record.railgun.finalizedBlockHash = v.record.finalized.blockHash = hex(200);
  expect(match(v).finalityVerified).toBe(false);
});
