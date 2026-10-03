const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const baselinePath =
  require.resolve('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const baseline = require(baselinePath);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture(change = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-capture-data-'));
  const value = {
    from: { number: 0, hash: '0x' + '00'.repeat(32) },
    to: baseline.anchor,
    logs: [],
  };
  const bytes = JSON.stringify(value) + '\n';
  const report = {
    chainId: 11155111,
    proxy: baseline.code.proxy.address.toLowerCase(),
    anchor: baseline.anchor,
    anchorRechecked: true,
    fromBlock: 0,
    sourceSha256: 'a'.repeat(64),
    deploymentReportSha256: hash(fs.readFileSync(baselinePath)),
    totalLogs: 0,
    totalBytes: Buffer.byteLength(bytes),
    pages: [
      { filename: '00000.json', from: 0, to: baseline.anchor.number, logs: 0, sha256: hash(bytes) },
    ],
  };
  fs.writeFileSync(path.join(directory, '00000.json'), bytes);
  change(report, directory);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report));
  return directory;
}
test('requires a complete manifest, validates page hashes and exposes bounded reread iteration', () => {
  const result = readRailgunLogCapture(fixture());
  expect([...result.logs()]).toEqual([]);
  expect(result.logSetSha256).toBe(hash(''));
  expect(result.blocks.size).toBe(0);
});
test.each([
  (r) => {
    r.pages[0].from = 1;
  },
  (r) => {
    r.pages[0].to--;
  },
  (r) => {
    r.pages.push(r.pages[0]);
  },
  (r) => {
    r.pages[0].filename = '../page.json';
  },
  (r) => {
    r.pages[0].sha256 = 'b'.repeat(64);
  },
  (r) => {
    r.totalBytes++;
  },
  (r) => {
    r.anchorRechecked = false;
  },
  (r) => {
    r.deploymentReportSha256 = 'f'.repeat(64);
  },
])('rejects inconsistent or incomplete captured coverage', (change) => {
  expect(() => readRailgunLogCapture(fixture(change))).toThrow();
});
test('rehashes a page before later iteration instead of trusting an earlier read', () => {
  const directory = fixture(),
    result = readRailgunLogCapture(directory);
  fs.appendFileSync(path.join(directory, '00000.json'), ' ');
  expect(() => [...result.logs()]).toThrow('Page digest mismatch');
});
