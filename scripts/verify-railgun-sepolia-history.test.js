const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const {
  appendLeaves,
  nullifierKey,
  checkTransactionPresence,
  readHeaderEvidence,
} = require('./verify-railgun-sepolia-history');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('rollover preserves an underfull prior tree when a whole insertion cannot fit', () => {
  const trees = new Map();
  appendLeaves(trees, 0, 0, Array(65530).fill('leaf'));
  appendLeaves(trees, 1, 0, Array(7).fill('next'));
  appendLeaves(trees, 1, 7, ['last']);
  expect([...trees.values()].map((v) => v.length)).toEqual([65530, 8]);
});
test('exact fit and an empty event retain the full current tree', () => {
  const trees = new Map([[0, Array(65530).fill('leaf')]]);
  appendLeaves(trees, 0, 65530, Array(6).fill('leaf'));
  appendLeaves(trees, 0, 65536, []);
  expect(trees.size).toBe(1);
  expect(() => appendLeaves(trees, 1, 0, [])).toThrow();
  appendLeaves(trees, 1, 0, ['next']);
  expect(trees.size).toBe(2);
});
test.each(['gap', 'overlap', 'premature', 'missing', 'revisit', 'overflow'])(
  'rejects invalid tree placement: %s',
  (mode) => {
    const trees = new Map([[0, Array(65530).fill('leaf')]]);
    expect(() => {
      if (mode === 'gap') appendLeaves(trees, 0, 65531, ['leaf']);
      if (mode === 'overlap') appendLeaves(trees, 0, 65529, ['leaf']);
      if (mode === 'premature') appendLeaves(trees, 1, 0, ['leaf']);
      if (mode === 'missing') appendLeaves(trees, 2, 0, Array(7).fill('leaf'));
      if (mode === 'overflow') appendLeaves(trees, 0, 65530, Array(7).fill('leaf'));
      if (mode === 'revisit') {
        appendLeaves(trees, 1, 0, Array(7).fill('leaf'));
        appendLeaves(trees, 0, 65530, ['leaf']);
      }
    }).toThrow();
  }
);
test('nullifiers must be field elements in a tree no later than the anchor', () => {
  expect(nullifierKey(0n, '0x01', '0')).toBe('0:' + '1'.padStart(64, '0'));
  expect(() => nullifierKey(1n, '0x01', '0')).toThrow();
  expect(() => nullifierKey(-1n, '0x01', '0')).toThrow();
  expect(() => nullifierKey(0n, -1n, '0')).toThrow();
  expect(() => nullifierKey(0n, 1n << 255n, '0')).toThrow();
});
test('transaction category presence detects total omissions but makes no count claim', () => {
  const check = (nullifiers, transact, unshield) =>
    checkTransactionPresence(new Map([['tx', { nullifiers, transact, unshield }]]));
  expect(() => check(1, 1, 0)).not.toThrow();
  expect(() => check(2, 0, 1)).not.toThrow();
  expect(() => check(0, 0, 0)).not.toThrow();
  expect(() => check(0, 1, 1)).toThrow();
  expect(() => check(1, 0, 0)).toThrow();
  // A partially omitted Nullified event can still leave both categories present.
  expect(() => check(1, 2, 3)).not.toThrow();
});
function fixture(patch = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-history-evidence-'));
  const capture = {
    report: { anchor: { number: 7, hash: 'a'.repeat(64) }, totalLogs: 12 },
    blocks: new Map([[2, 'a'.repeat(64)]]),
    boundaries: [{}, {}],
    reportSha256: 'b'.repeat(64),
    logSetSha256: 'c'.repeat(64),
  };
  const bytes = Buffer.from('{}\n');
  const sourceSha256 = Object.fromEntries(
    [
      'scripts/verify-railgun-sepolia-headers.js',
      'scripts/railgun-log-capture-data.js',
      'scripts/capture-railgun-sepolia-logs.js',
    ].map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
  const report = {
    chainId: 11155111,
    logSetSha256: capture.logSetSha256,
    captureReportSha256: capture.reportSha256,
    anchor: capture.report.anchor,
    eventBlockHashesCanonicalByAgreement: true,
    bloomCheckedLogs: 12,
    eventBlocks: 1,
    rangeBoundaryParentLinks: 1,
    headerFileSha256: hash(bytes),
    sourceSha256,
    ...patch,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(directory, 'headers.jsonl'), bytes);
  return { directory, capture };
}
test('header evidence is bound to the exact capture, file bytes and current source', () => {
  const f = fixture();
  expect(readHeaderEvidence(f.directory, f.capture).sha256).toMatch(/^[0-9a-f]{64}$/);
});
test.each([
  { captureReportSha256: 'd'.repeat(64) },
  { logSetSha256: 'd'.repeat(64) },
  { sourceSha256: {} },
  { bloomCheckedLogs: 11 },
  { eventBlockHashesCanonicalByAgreement: false },
  { headerFileSha256: 'd'.repeat(64) },
])('rejects detached header evidence %j', (patch) => {
  const f = fixture(patch);
  expect(() => readHeaderEvidence(f.directory, f.capture)).toThrow();
});
test('rejects symbolic-link header reports', () => {
  const f = fixture();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-history-symlink-'));
  fs.symlinkSync(path.join(f.directory, 'report.json'), path.join(other, 'report.json'));
  expect(() => readHeaderEvidence(other, f.capture)).toThrow();
});
