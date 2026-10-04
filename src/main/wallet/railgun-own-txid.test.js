const {
  matchRailgunOwnTxid: match,
  projectRailgunOwnRecord: project,
} = require('./railgun-own-txid');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
const { createHash } = require('crypto');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
// Captured from the matcher at 941099ff before partial TXID support. These
// canonical bytes are consumed by downstream evidence binding digests.
test.each([
  [false, false, 'fb7f775640f08204300b14495e7a4179f3113aff6f23f724709c6fce39d906e1'],
  [false, true, '7bdb8e58684ccdb2f98b3fa9e7346866a09cc6e4a3e75523dfbbd0a53aae3d37'],
  [true, false, '2c976025b05d40e84eff3b87972c21bf04ad727dd09953d110e00b6d2b777355'],
  [true, true, 'fc0d5d0f8723d09122e98ab867d81a3e184c770442c6987b785ef4450e3cc55d'],
])('preserves legacy matcher bytes, unshield=%s archived=%s', (unshield, archived, digest) => {
  const input = sample(unshield, archived);
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  expect(hash(match(input))).toBe(digest);
  expect(hash(project(input.record))).toBe(
    unshield
      ? '9af874a3b8844b4ec545db4ecfd4540d71230a8502fd75573612ac6cc398b922'
      : '2b19675bb4c73328484780dc1cd352bd9e91f25fdb67a0e5eda98542213739e6'
  );
});
test.each([false, true])(
  'stable %s record projection survives refresh and archival as data only',
  (unshield) => {
    const active = sample(unshield).record,
      archived = sample(unshield, true).record;
    const value = project(active);
    expect(project(archived)).toEqual(value);
    active.state = 'attempted';
    active.revision++;
    active.attemptedAt++;
    active.observation.observedAt++;
    active.observation.confirmations++;
    active.resolution.reviewedAt++;
    expect(project(active)).toEqual(value);
    expect(Object.keys(value)).toEqual([
      'hash',
      'nonce',
      'intent',
      'status',
      'blockNumber',
      'blockHash',
      'railgun',
    ]);
    expect(Object.isFrozen(value.intent)).toBe(true);
    expect(Object.isFrozen(value.railgun.transact.output)).toBe(true);
    active.intent.digest = hex(999);
    expect(value.intent.digest).not.toBe(active.intent.digest);
    expect(value.railgun.transact.spendingEnabled).toBe(false);
  }
);
test.each(['unresolved', 'reorged', 'metadata', 'mixed', 'archive-anchor', 'oversize'])(
  'stable record projection still refuses %s metadata',
  (mode) => {
    const value = sample(false, mode === 'archive-anchor').record;
    if (mode === 'unresolved') value.resolution = null;
    if (mode === 'reorged') value.observation.status = 'reorged';
    if (mode === 'metadata') value.observation.confirmations = 0;
    if (mode === 'mixed') value.archivedAt = 1;
    if (mode === 'archive-anchor') value.finalized.blockNumber = 299;
    if (mode === 'oversize') value.extra = 'x'.repeat(32768);
    expect(() => project(value)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_OWN_RECORD_REFUSED' })
    );
  }
);
test('projection binds a changed inclusion instead of hiding it as refresh metadata', () => {
  const original = sample().record,
    changed = structuredClone(original);
  changed.observation.blockHash = changed.resolution.blockHash = hex(777);
  changed.resolution.railgun.transact.blockHash = hex(777);
  expect(project(changed)).not.toEqual(project(original));
});
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

const { samplePartial } = require('../../../scripts/fixtures/railgun-partial-own-txid-data');
test.each([false, true])(
  'matches partial change coordinates AND unshield metadata, archived=%s',
  (archived) => {
    const input = samplePartial({ archived });
    const result = match(input);
    expect(result).toMatchObject({
      status: 'matched',
      recordKind: archived ? 'archived' : 'active',
      output: {
        kind: 'partial-unshield',
        change: {
          kind: 'shielded',
          tree: input.row.utxoTreeOut,
          position: input.row.utxoBatchStartPositionOut,
        },
        unshield: { kind: 'unshield', unshieldAmount: '400', received: '399', fee: '1' },
      },
      boundParamsCompared: true,
      unshieldPreimageCompared: true,
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
    expect(result.row.commitments).toEqual([
      input.capsule.preparation.expected.changeCommitment,
      input.capsule.preparation.expected.unshieldCommitment,
    ]);
    expect(result.row.unshield.value).toBe('400');
    expect(result.row.unshield.value).not.toBe(input.capsule.preparation.inputAmount);
    expect(result.row.unshield.value).not.toBe(input.capsule.preparation.changeAmount);
    for (const value of [
      result.output,
      result.output.change,
      result.output.unshield,
      result.row.unshield.tokenData,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    const bytes = JSON.stringify(result);
    input.row.commitments[1] = hex(777);
    input.row.unshield.value = '800';
    expect(JSON.stringify(result)).toBe(bytes);
  }
);
test('partial stable projection preserves both outcomes across archival', () => {
  const active = samplePartial();
  const archived = samplePartial({ archived: true });
  expect(project(active.record)).toEqual(project(archived.record));
  const result = project(active.record);
  expect(result.railgun.transact.version).toBe(2);
  expect(Object.isFrozen(result.railgun.transact.output.change)).toBe(true);
  expect(Object.isFrozen(result.railgun.transact.output.unshield)).toBe(true);
});
test.each([
  ['swapped commitments', (v) => v.row.commitments.reverse()],
  ['wrong change commitment', (v) => (v.row.commitments[0] = hex(999))],
  ['wrong unshield commitment', (v) => (v.row.commitments[1] = hex(999))],
  ['missing unshield commitment', (v) => v.row.commitments.pop()],
  ['extra commitment', (v) => v.row.commitments.push(hex(999))],
  ['extra nullifier', (v) => v.row.nullifiers.push(hex(999))],
  ['wrong nullifier', (v) => (v.row.nullifiers[0] = hex(999))],
  ['missing unshield preimage', (v) => delete v.row.unshield],
  ['net amount as gross', (v) => (v.row.unshield.value = '399')],
  ['change amount as gross', (v) => (v.row.unshield.value = '600')],
  ['input amount as gross', (v) => (v.row.unshield.value = '1000')],
  ['wrong recipient', (v) => (v.row.unshield.toAddress = pins.proxy)],
  ['wrong token address', (v) => (v.row.unshield.tokenData.tokenAddress = pins.proxy)],
  ['wrong token type', (v) => (v.row.unshield.tokenData.tokenType = 1)],
  ['wrong token sub-ID', (v) => (v.row.unshield.tokenData.tokenSubID = hex(1))],
  ['wrong change tree', (v) => v.row.utxoTreeOut++],
  ['wrong change position', (v) => v.row.utxoBatchStartPositionOut++],
  ['unshield sentinel tree', (v) => (v.row.utxoTreeOut = 99999)],
  ['unshield sentinel position', (v) => (v.row.utxoBatchStartPositionOut = 99999)],
  ['wrong input tree', (v) => v.row.utxoTreeIn++],
  ['wrong bound parameters', (v) => (v.row.boundParamsHash = hex(999))],
  ['wrong transaction hash', (v) => (v.row.txid = hex(999).slice(2))],
  ['nonzero graph slot', (v) => (v.row.graphID = v.row.graphID.slice(0, -1) + '1')],
  ['legacy capsule version', (v) => (v.capsule.version = 1)],
  ['legacy expected commitment field', (v) => (v.capsule.preparation.expected.commitment = hex(3))],
])('refuses partial %s without claiming crypto verification', (_name, change) => {
  const input = samplePartial();
  change(input);
  expect(() => match(input)).toThrow(expect.objectContaining({ code: 'RAILGUN_OWN_TXID_REFUSED' }));
});
test.each(['change', 'unshield'])('refuses contradictory retained partial %s outcome', (kind) => {
  const input = samplePartial();
  const output = input.record.resolution.railgun.transact.output;
  if (kind === 'change') output.change.position++;
  else output.unshield.unshieldAmount = '401';
  expect(() => match(input)).toThrow(expect.objectContaining({ code: 'RAILGUN_OWN_TXID_REFUSED' }));
});
test('partial matching does not authenticate its structurally consistent dummy final commitment', () => {
  const input = samplePartial({ commitments: [hex(100), hex(101)] });
  const result = match(input);
  expect(result.row.commitments).toEqual([hex(100), hex(101)]);
  expect(result.unshieldPreimageCompared).toBe(true);
  expect(result.unshieldCommitmentHashVerified).toBe(false);
  expect(result.txidPathVerified).toBe(false);
});
