/** Strict reader for public research captures, not a chain-verification grant. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { normalizeLogs } = require('./capture-railgun-sepolia-logs');
const baseline = require('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function readRailgunLogCapture(directory) {
  assert.ok(path.isAbsolute(directory));
  const read = (name, limit) => {
    assert.ok(/^(?:report|\d{5})\.json$/.test(name));
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length <= limit);
    return bytes;
  };
  const reportBytes = read('report.json', 2 * 1024 * 1024);
  const report = JSON.parse(reportBytes);
  assert.equal(report.chainId, 11155111);
  assert.equal(report.proxy, baseline.code.proxy.address.toLowerCase());
  assert.deepEqual(report.anchor, baseline.anchor);
  assert.equal(report.anchorRechecked, true);
  assert.equal(report.fromBlock, 0);
  assert.match(report.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.deploymentReportSha256,
    sha256(
      fs.readFileSync(
        require.resolve('../docs/qualification/railgun-sepolia-deployment-2026-10-02.json')
      )
    )
  );
  assert.ok(
    Array.isArray(report.pages) && report.pages.length >= 1 && report.pages.length <= 10000
  );
  assert.ok(integer(report.totalLogs) && report.totalLogs <= 100000);
  assert.ok(integer(report.totalBytes) && report.totalBytes <= 128 * 1024 * 1024);
  function load(page) {
    assert.match(page.filename, /^\d{5}\.json$/);
    const bytes = read(page.filename, 8 * 1024 * 1024);
    assert.equal(sha256(bytes), page.sha256, 'Page digest mismatch');
    const value = JSON.parse(bytes);
    assert.deepEqual(Object.keys(value).sort(), ['from', 'logs', 'to']);
    for (const field of ['from', 'to']) {
      assert.equal(value[field]?.number, page[field]);
      assert.match(value[field].hash, /^0x[0-9a-f]{64}$/);
    }
    assert.ok(Array.isArray(value.logs) && value.logs.length === page.logs);
    const raw = value.logs.map((log) => {
      for (const name of ['blockNumber', 'transactionIndex', 'logIndex'])
        assert.ok(integer(log[name]));
      return {
        ...log,
        removed: false,
        blockNumber: '0x' + log.blockNumber.toString(16),
        transactionIndex: '0x' + log.transactionIndex.toString(16),
        logIndex: '0x' + log.logIndex.toString(16),
      };
    });
    assert.deepEqual(
      value.logs,
      normalizeLogs(raw, page.from, page.to),
      'Noncanonical log order or schema'
    );
    return { value, bytes: bytes.length };
  }
  let next = 0,
    totalBytes = 0,
    totalLogs = 0;
  const files = new Set(),
    blocks = new Map(),
    boundaries = [],
    digest = createHash('sha256');
  for (const page of report.pages) {
    assert.ok(
      integer(page.from) &&
        integer(page.to) &&
        page.from === next &&
        page.to >= page.from &&
        page.to <= report.anchor.number
    );
    assert.ok(integer(page.logs) && page.logs <= 4096);
    assert.match(page.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!files.has(page.filename));
    files.add(page.filename);
    const { value, bytes } = load(page);
    for (const log of value.logs) {
      if (blocks.has(log.blockNumber)) assert.equal(blocks.get(log.blockNumber), log.blockHash);
      blocks.set(log.blockNumber, log.blockHash);
      digest.update(JSON.stringify(log) + '\n');
    }
    boundaries.push({ from: value.from, to: value.to });
    totalBytes += bytes;
    totalLogs += value.logs.length;
    assert.ok(totalBytes <= report.totalBytes && totalLogs <= report.totalLogs);
    next = page.to + 1;
  }
  assert.equal(next, report.anchor.number + 1, 'Capture does not reach the anchor');
  assert.equal(totalBytes, report.totalBytes);
  assert.equal(totalLogs, report.totalLogs);
  assert.equal(boundaries.at(-1).to.hash, report.anchor.hash);
  return {
    report,
    reportSha256: sha256(reportBytes),
    logSetSha256: digest.digest('hex'),
    blocks,
    boundaries,
    *logs() {
      for (const page of report.pages) yield* load(page).value.logs;
    },
  };
}
module.exports = { readRailgunLogCapture };
