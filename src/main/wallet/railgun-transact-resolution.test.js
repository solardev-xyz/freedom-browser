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
