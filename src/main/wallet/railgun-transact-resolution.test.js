const {
  validRailgunTransactResolution: valid,
  freezeRailgunTransactResolution: freeze,
} = require('./railgun-transact-resolution');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
function sample(unshield = false) {
  const intent = railgunTransactJournalIntent(fixture(unshield).transaction());
  const record = {
    hash: '0x' + 'a'.repeat(64),
    intent,
    observation: { status: 'included', blockNumber: 16, blockHash: '0x' + 'b'.repeat(64) },
  };
  const value = {
    outcome: 'matched',
    finalizedBlockNumber: 16,
    finalizedBlockHash: record.observation.blockHash,
    transact: {
      status: 'matched',
      transactionHash: record.hash,
      blockHash: record.observation.blockHash,
      blockNumber: '0x10',
      operation: intent.operation,
      inputTree: intent.tree,
      nullifier: intent.nullifier,
      commitment: intent.commitment,
      boundParamsHash: intent.boundParamsHash,
      intentDigest: intent.intentDigest,
      nullifiedLogIndex: '0x5',
      trust: 'unverified-rpc',
      spendingEnabled: false,
      output: unshield
        ? {
            kind: 'unshield',
            logIndex: '0x8',
            recipient: intent.recipient,
            token: pins.wrappedNative,
            amount: intent.amount,
            received: '998',
            fee: '2',
            feeDeviation: false,
          }
        : { kind: 'shielded', tree: 1, position: 123, logIndex: '0x8' },
    },
  };
  return { record, value };
}
test.each([false, true])('accepts matched %s outcome with frozen nested data', (unshield) => {
  const { record, value } = sample(unshield);
  expect(valid(value, record)).toBe(true);
  const frozen = freeze(value);
  expect(Object.isFrozen(frozen.transact.output)).toBe(true);
  expect(JSON.parse(JSON.stringify(frozen))).toStrictEqual(frozen);
});
test.each([
  'operation',
  'inputTree',
  'nullifier',
  'commitment',
  'boundParamsHash',
  'intentDigest',
  'transactionHash',
  'blockHash',
  'blockNumber',
  'trust',
  'spendingEnabled',
  'nullifiedLogIndex',
])('refuses changed %s', (key) => {
  const { record, value } = sample();
  value.transact[key] = 'wrong';
  expect(valid(value, record)).toBe(false);
});
test.each([
  (v) => {
    v.finalizedBlockNumber = 15;
  },
  (v) => {
    v.finalizedBlockHash = '0x' + 'c'.repeat(64);
  },
  (v) => {
    v.transact.output.tree = 65536;
  },
  (v) => {
    v.transact.output.position = -1;
  },
  (v) => {
    v.transact.output.logIndex = '0x5';
  },
  (v) => {
    v.transact.output.extra = true;
  },
  (v) => {
    v.extra = true;
  },
])('refuses invalid finality/position/schema %p', (change) => {
  const { record, value } = sample();
  change(value);
  expect(valid(value, record)).toBe(false);
});
test.each(['recipient', 'token', 'amount', 'received', 'fee', 'feeDeviation'])(
  'refuses changed unshield %s',
  (key) => {
    const { record, value } = sample(true);
    value.transact.output[key] = 'wrong';
    expect(valid(value, record)).toBe(false);
  }
);
test('retains observed fee deviation without granting retry or spending authority', () => {
  const { record, value } = sample(true);
  Object.assign(value.transact.output, { received: '997', fee: '3', feeDeviation: true });
  expect(valid(value, record)).toBe(true);
});
test('reverted has no private outcome and nonce-consumed cannot resolve', () => {
  const { record, value } = sample();
  record.observation.status = 'reverted';
  value.outcome = 'reverted';
  value.transact = null;
  expect(valid(value, record)).toBe(true);
  record.observation.status = 'nonce-consumed';
  expect(valid(value, record)).toBe(false);
});
test('even a wider parser cannot resolve an unversioned partial record', () => {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const { expected } = createRailgunPartialCapsuleData().capsule.preparation;
  const { record, value } = sample(true);
  const { kind, ...fields } = expected;
  record.intent = {
    kind: 'railgun-transact',
    digest: record.intent.digest,
    operation: kind,
    ...fields,
    intentDigest: record.intent.intentDigest,
  };
  expect(valid(value, record)).toBe(false);
  record.observation.status = 'reverted';
  value.outcome = 'reverted';
  value.transact = null;
  // Version/kind dispatch remains explicit even if a parser is later widened.
  try {
    jest.isolateModules(() => {
      jest.doMock('./railgun-transact-intent', () => ({ validRailgunTransactIntent: () => true }));
      const wider = require('./railgun-transact-resolution').validRailgunTransactResolution;
      expect(wider(value, record)).toBe(false);
    });
  } finally {
    jest.dontMock('./railgun-transact-intent');
  }
});

const { createHash } = require('crypto');
const receiptPolicy = require('./railgun-transact-receipt-policy');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
function partialSample() {
  const { record, value } = sample(true);
  const f = createRailgunPartialCapsuleData();
  record.intent = railgunTransactJournalIntent({
    ...f.capsule.preparation.transaction,
    from: '0x' + '34'.repeat(20),
  });
  const i = record.intent;
  value.transact = {
    version: 2,
    receiptPolicy: receiptPolicy.id,
    status: 'matched',
    transactionHash: record.hash,
    blockHash: record.observation.blockHash,
    blockNumber: '0x10',
    operation: i.operation,
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
        unshieldAmount: i.unshieldAmount,
        received: '399',
        fee: '1',
        feeDeviation: false,
        treasury: receiptPolicy.treasury,
        recipientTransferLogIndex: '0x6',
        treasuryTransferLogIndex: '0x7',
      },
    },
    trust: 'unverified-rpc',
    spendingEnabled: false,
  };
  return { record, value };
}
test.each([
  [false, 'f1594ef2c96fc2ac1a342e1d040c90ad7c7fbf29cc3cb4a598ef6b7b4d289709'],
  [true, '0f9985fa90618d93d20100ff9256706b2bb9843934ae209628646c540295d86b'],
])('preserves legacy %s resolution golden bytes', (u, golden) => {
  const { record, value } = sample(u);
  expect(valid(value, record)).toBe(true);
  expect(
    createHash('sha256')
      .update(JSON.stringify(freeze(value)))
      .digest('hex')
  ).toBe(golden);
  expect(valid({ ...value, transact: { ...value.transact, version: 2 } }, record)).toBe(false);
  expect(
    valid({ ...value, transact: { ...value.transact, receiptPolicy: receiptPolicy.id } }, record)
  ).toBe(false);
});
test('partial resolution persists both outcomes and policy id, freezing every nested component', () => {
  const { record, value } = partialSample();
  expect(valid(value, record)).toBe(true);
  const copy = JSON.parse(JSON.stringify(value));
  expect(valid(copy, record)).toBe(true);
  const result = freeze(copy);
  for (const v of [
    result,
    result.transact,
    result.transact.output,
    result.transact.output.change,
    result.transact.output.unshield,
  ])
    expect(Object.isFrozen(v)).toBe(true);
  expect(result).toEqual(value);
});
test.each([
  ['version', undefined],
  ['version', 1],
  ['version', 3],
  ['version', '2'],
  ['receiptPolicy', undefined],
  ['receiptPolicy', 'railgun-sepolia-partial-receipt-v2'],
  ['receiptPolicy', {}],
  ['operation', 'railgun-token-unshield'],
  ['changeCommitment', '0x' + 'a'.repeat(64)],
  ['unshieldCommitment', '0x' + 'a'.repeat(64)],
  ['nullifier', '0x' + 'a'.repeat(64)],
  ['inputTree', 1],
  ['intentDigest', '0x' + 'a'.repeat(64)],
  ['boundParamsHash', '0x' + 'a'.repeat(64)],
  ['transactionHash', '0x' + 'b'.repeat(64)],
  ['blockHash', '0x' + 'a'.repeat(64)],
  ['blockNumber', '0x11'],
  ['trust', 'verified'],
  ['spendingEnabled', true],
])('refuses partial top-level %s=%p', (key, replacement) => {
  const { record, value } = partialSample();
  if (replacement === undefined) delete value.transact[key];
  else value.transact[key] = replacement;
  expect(valid(value, record)).toBe(false);
});
test.each([
  ['kind', 'shielded'],
  ['recipient', receiptPolicy.treasury],
  ['token', pins.proxy],
  ['unshieldAmount', '401'],
  ['unshieldAmount', 400],
  ['received', '0400'],
  ['received', 399],
  ['received', '0'],
  ['received', '400'],
  ['fee', '01'],
  ['fee', 1],
  ['fee', '2'],
  ['feeDeviation', true],
  ['feeDeviation', 0],
  ['treasury', '0x' + '56'.repeat(20)],
])('refuses partial unshield %s=%p', (key, replacement) => {
  const { record, value } = partialSample();
  value.transact.output.unshield[key] = replacement;
  expect(valid(value, record)).toBe(false);
});
test.each([
  ['kind', 'unshield'],
  ['tree', 65536],
  ['tree', -1],
  ['tree', 1.5],
  ['position', 65536],
  ['position', -1],
  ['position', '123'],
])('refuses partial change %s=%p', (key, replacement) => {
  const { record, value } = partialSample();
  value.transact.output.change[key] = replacement;
  expect(valid(value, record)).toBe(false);
});
test.each([
  ['output', 'kind'],
  ['output', 'change'],
  ['output', 'unshield'],
  ['change', 'kind'],
  ['change', 'tree'],
  ['change', 'position'],
  ['change', 'logIndex'],
  ['unshield', 'kind'],
  ['unshield', 'logIndex'],
  ['unshield', 'recipient'],
  ['unshield', 'token'],
  ['unshield', 'unshieldAmount'],
  ['unshield', 'received'],
  ['unshield', 'fee'],
  ['unshield', 'feeDeviation'],
  ['unshield', 'treasury'],
  ['unshield', 'recipientTransferLogIndex'],
  ['unshield', 'treasuryTransferLogIndex'],
])('requires exact nested partial %s.%s', (part, key) => {
  const { record, value } = partialSample();
  const obj = part === 'output' ? value.transact.output : value.transact.output[part];
  delete obj[key];
  expect(valid(value, record)).toBe(false);
});
test.each(['transact', 'output', 'change', 'unshield'])(
  'refuses extra partial fields at %s',
  (part) => {
    const { record, value } = partialSample();
    const obj =
      part === 'transact'
        ? value.transact
        : part === 'output'
          ? value.transact.output
          : value.transact.output[part];
    obj.extra = true;
    expect(valid(value, record)).toBe(false);
  }
);
test.each([
  ['nullifiedLogIndex', '0x6'],
  ['recipientTransferLogIndex', '0x5'],
  ['treasuryTransferLogIndex', '0x6'],
  ['unshieldLogIndex', '0x7'],
  ['changeLogIndex', '0x8'],
  ['recipientTransferLogIndex', '0x06'],
  ['treasuryTransferLogIndex', '0x20000000000000'],
  ['unshieldLogIndex', 8],
  ['changeLogIndex', null],
])('refuses partial index %s=%p', (key, replacement) => {
  const { record, value } = partialSample(),
    t = value.transact;
  if (key === 'nullifiedLogIndex') t[key] = replacement;
  else if (key === 'changeLogIndex') t.output.change.logIndex = replacement;
  else if (key === 'unshieldLogIndex') t.output.unshield.logIndex = replacement;
  else t.output.unshield[key] = replacement;
  expect(valid(value, record)).toBe(false);
});
test('zero fee and equal destination retain two distinct transfer indices in resolution', () => {
  const { record, value } = partialSample();
  record.intent = { ...record.intent, recipient: receiptPolicy.treasury, unshieldAmount: '399' };
  Object.assign(value.transact.output.unshield, {
    recipient: receiptPolicy.treasury,
    unshieldAmount: '399',
    received: '399',
    fee: '0',
  });
  expect(valid(value, record)).toBe(true);
  value.transact.output.unshield.treasuryTransferLogIndex =
    value.transact.output.unshield.recipientTransferLogIndex;
  expect(valid(value, record)).toBe(false);
});
test('fee deviation is diagnostic while exact gross conservation remains mandatory', () => {
  const { record, value } = partialSample(),
    u = value.transact.output.unshield;
  Object.assign(u, { received: '398', fee: '2', feeDeviation: true });
  expect(valid(value, record)).toBe(true);
  u.received = '399';
  expect(valid(value, record)).toBe(false);
});
test('partial finality and reverted resolution do not grant release or accept mixed formats', () => {
  const { record, value } = partialSample();
  value.finalizedBlockNumber = 15;
  expect(valid(value, record)).toBe(false);
  value.finalizedBlockNumber = 16;
  value.finalizedBlockHash = '0x' + 'c'.repeat(64);
  expect(valid(value, record)).toBe(false);
  value.finalizedBlockNumber = 17;
  expect(valid(value, record)).toBe(true);
  value.outcome = 'reverted';
  value.transact = null;
  record.observation.status = 'reverted';
  expect(valid(value, record)).toBe(true);
  record.intent = { ...record.intent, version: 1 };
  expect(valid(value, record)).toBe(false);
});
