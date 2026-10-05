// Engine functions are mocked here to localize the fixture hash/prefix guards.
// Native qualification, not this suite, establishes real Poseidon projection.
const fs = require('fs');
const path = require('path');
const { vector } = require('./railgun-combined-poi-terminal-test-data.fixture');
const { rowFromSecond } = require('./railgun-combined-poi-terminal-data');
const { graph } = require('./railgun-combined-poi-chain');
const { normalizeTxidPage } = require('../../src/main/wallet/railgun-public-services');
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let input, ask, hash, append, run;
beforeEach(() => {
  const v = vector(),
    { row } = rowFromSecond(v.second, v.first, v.header);
  const prior = { ...v.first.ownEvidence.row, verificationHash: hex(70) };
  input = {
    archive: '/mock-engine',
    priorRows: JSON.parse(JSON.stringify(normalizeTxidPage([graph(prior)], '0x00').transactions)),
    row,
    kind: 'terminal-full-unshield',
  };
  ask = jest.fn(async (text) => JSON.stringify({ id: JSON.parse(text).id, value: null }));
  hash = jest.fn(() => BigInt(row.commitments[0]));
  append = jest.fn(async (_state, rows) => ({
    state: { count: rows.length, root: hex(77).slice(2), after: rows.at(-1).graphID },
  }));
  const engineRequire = () => {};
  engineRequire.resolve = () => '/mock-engine/engine/index.js';
  const exports = {};
  const mockRequire = (name) => {
    if (name === 'module') return { createRequire: () => engineRequire };
    if (name.endsWith('railgun-engine-runtime'))
      return { verifyRailgunEngineRuntime: () => '/mock-engine' };
    if (name === '/mock-engine/engine/utils/poseidon')
      return { initPoseidonPromise: Promise.resolve(), poseidonHex: jest.fn() };
    if (name === '/mock-engine/engine/note/note-util') return { getNoteHash: hash };
    if (name === '/mock-engine/engine/transaction/railgun-txid')
      return {
        createRailgunTransactionWithHash: jest.fn(),
        calculateRailgunTransactionVerificationHash: (prev) => (prev ? hex(71) : hex(70)),
      };
    if (name.endsWith('railgun-txid-projection'))
      return { createRailgunTxidProjection: () => ({ empty: () => ({}), append }) };
    return require(name);
  };
  new Function(
    'require',
    'exports',
    fs.readFileSync(path.join(__dirname, 'railgun-combined-poi-row-job.js'), 'utf8')
  )(mockRequire, exports);
  run = () =>
    exports.run(JSON.stringify(input), {
      request: ask,
      signal: new AbortController().signal,
      guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['mock'] }),
    });
});
test('terminal hashes final gross preimage and independently projects unchanged canonical prefixes', async () => {
  await run();
  expect(hash).toHaveBeenCalledWith(
    input.row.unshield.toAddress,
    input.row.unshield.tokenData,
    600n
  );
  expect(append).toHaveBeenCalledTimes(2);
  const result = JSON.parse(ask.mock.calls[0][0]).value;
  expect(JSON.stringify(result.rows.slice(0, -1))).toBe(JSON.stringify(input.priorRows));
  expect(result.rows).toHaveLength(2);
});
test('default partial branch remains supported', async () => {
  const v = vector();
  input = { archive: '/mock-engine', priorRows: [], row: v.first.ownEvidence.row };
  hash.mockReturnValue(BigInt(input.row.commitments[1]));
  await run();
  expect(append).toHaveBeenCalledTimes(1);
});
test.each([
  ['wrong final gross hash', () => hash.mockReturnValue(999n)],
  [
    'rewritten predecessor hash',
    () => {
      input.priorRows[0].verificationHash = hex(69);
    },
  ],
  [
    'different canonical order',
    () => {
      const { version, ...rest } = input.priorRows[0];
      input.priorRows[0] = { ...rest, version };
    },
  ],
  [
    'missing prior history',
    () => {
      input.priorRows = [];
    },
  ],
  [
    'too much prior history',
    () => {
      input.priorRows.push(input.priorRows[0], input.priorRows[0]);
    },
  ],
  [
    'ordinary coordinates',
    () => {
      input.row.utxoTreeOut = 0;
    },
  ],
  [
    'extra output',
    () => {
      input.row.commitments.push(hex(11));
    },
  ],
  [
    'unknown mode',
    () => {
      input.kind = 'other';
    },
  ],
  [
    'unknown field',
    () => {
      input.root = hex(10);
    },
  ],
])('%s refuses before result', async (_name, change) => {
  change();
  await expect(run()).rejects.toThrow();
  expect(ask).not.toHaveBeenCalled();
});
