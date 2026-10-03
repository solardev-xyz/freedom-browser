/** Public historical header corroboration. No wallet or private-note queries. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { keccak256 } = require('ethers');
const { rpc } = require('./capture-railgun-sepolia-logs');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const endpoints = ['https://sepolia.rpc.sentio.xyz', 'https://gateway.tenderly.co/public/sepolia'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = (n) => '0x' + n.toString(16);
// Ethereum's 2048-bit log bloom: three big-endian Keccak bit positions.
// https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9.go
function bloomContains(bloom, value) {
  assert.match(bloom, /^0x[0-9a-f]{512}$/);
  assert.match(value, /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  const bytes = Buffer.from(bloom.slice(2), 'hex');
  const digest = Buffer.from(keccak256(value).slice(2), 'hex');
  for (let offset = 0; offset < 6; offset += 2) {
    const bit = digest.readUInt16BE(offset) & 2047;
    if (!(bytes[255 - Math.floor(bit / 8)] & (1 << (bit % 8)))) return false;
  }
  return true;
}
function header(value, number) {
  assert.equal(value?.number, tag(number));
  for (const name of ['hash', 'parentHash', 'receiptsRoot'])
    assert.match(value[name], /^0x[0-9a-f]{64}$/);
  assert.match(value.logsBloom, /^0x[0-9a-f]{512}$/);
  assert.match(value.timestamp, /^0x(?:0|[1-9a-f][0-9a-f]*)$/);
  const timestamp = Number(BigInt(value.timestamp));
  assert.ok(Number.isSafeInteger(timestamp));
  return {
    number,
    hash: value.hash,
    parentHash: value.parentHash,
    receiptsRoot: value.receiptsRoot,
    logsBloom: value.logsBloom,
    timestamp,
  };
}
async function verifyHeaders({
  directory,
  output,
  capture = readRailgunLogCapture(directory),
  request = rpc,
  sleep = pause,
  now = Date.now,
  progress = (value) => console.log(JSON.stringify(value)),
}) {
  assert.ok(output && path.isAbsolute(output));
  fs.mkdirSync(output, { mode: 0o700 });
  const sources = [
    'scripts/verify-railgun-sepolia-headers.js',
    'scripts/railgun-log-capture-data.js',
    'scripts/capture-railgun-sepolia-logs.js',
  ];
  const sourceSha256 = Object.fromEntries(
    sources.map((file) => [file, hash(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
  const expected = new Map(capture.blocks);
  for (const boundary of capture.boundaries)
    for (const { number, hash } of [boundary.from, boundary.to]) {
      if (expected.has(number)) assert.equal(expected.get(number), hash);
      expected.set(number, hash);
    }
  const numbers = [...expected.keys()].sort((a, b) => a - b);
  assert.ok(numbers.length <= 120000);
  const deadline = now() + 60 * 60000;
  let failedAttempts = 0;
  const failures = [];
  async function pair(calls) {
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.ok(now() < deadline, 'Header qualification deadline');
      const results = await Promise.allSettled(endpoints.map((url) => request(url, calls)));
      assert.ok(now() < deadline, 'Header qualification deadline');
      if (results.every((result) => result.status === 'fulfilled'))
        return results.map((result) => result.value);
      failedAttempts++;
      for (let i = 0; i < results.length; i++) {
        if (results[i].status !== 'rejected' || failures.length >= 1000) continue;
        const error = results[i].reason;
        failures.push({
          requestBatch: calls.map(([method, params]) => ({ method, block: params[0] ?? null })),
          attempt,
          provider: new URL(endpoints[i]).hostname,
          ...(error.evidence ?? { classification: error.code ?? 'invalid' }),
        });
      }
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      const terminal = errors.find((error) => error.code !== 'CAPTURE_TRANSIENT');
      if (terminal || attempt === 4) throw terminal ?? errors[0];
      await sleep(1000 * (attempt + 1));
    }
  }
  const heads = await pair([
    ['eth_chainId', []],
    ['eth_getBlockByNumber', ['finalized', false]],
    ['eth_getBlockByNumber', [tag(capture.report.anchor.number), false]],
  ]);
  for (const [chain, finalized, selected] of heads) {
    assert.equal(chain, '0xaa36a7');
    assert.ok(Number(BigInt(finalized.number)) >= capture.report.anchor.number);
    assert.equal(header(selected, capture.report.anchor.number).hash, capture.report.anchor.hash);
  }
  const headers = new Map();
  const headerFile = path.join(output, 'headers.jsonl');
  fs.writeFileSync(headerFile, '', { flag: 'wx', mode: 0o600 });
  for (let offset = 0; offset < numbers.length; offset += 4) {
    const batch = numbers.slice(offset, offset + 4);
    const results = await pair(
      batch.map((number) => ['eth_getBlockByNumber', [tag(number), false]])
    );
    for (const values of results) assert.equal(values.length, batch.length);
    const normalized = results.map((values) => values.map((value, i) => header(value, batch[i])));
    assert.deepEqual(normalized[0], normalized[1], 'Canonical header disagreement');
    for (const value of normalized[0]) {
      assert.equal(
        value.hash,
        expected.get(value.number),
        'Captured event or boundary is not canonical'
      );
      headers.set(value.number, value);
      fs.appendFileSync(headerFile, JSON.stringify(value) + '\n');
    }
    if (offset % 100 === 0)
      progress({ verified: headers.size, total: numbers.length, failedAttempts });
    await sleep(250);
  }
  for (let i = 1; i < capture.boundaries.length; i++) {
    const previous = capture.boundaries[i - 1].to,
      next = capture.boundaries[i].from;
    assert.equal(next.number, previous.number + 1);
    assert.equal(headers.get(next.number).parentHash, headers.get(previous.number).hash);
  }
  let bloomCheckedLogs = 0;
  for (const log of capture.logs()) {
    const block = headers.get(log.blockNumber);
    assert.equal(block?.hash, log.blockHash);
    for (const value of [log.address, ...log.topics])
      assert.ok(bloomContains(block.logsBloom, value), 'Log is inconsistent with header bloom');
    bloomCheckedLogs++;
  }
  assert.equal(bloomCheckedLogs, capture.report.totalLogs);
  const final = await pair([['eth_getBlockByNumber', [tag(capture.report.anchor.number), false]]]);
  for (const [value] of final)
    assert.equal(header(value, capture.report.anchor.number).hash, capture.report.anchor.hash);
  const report = {
    observedAt: new Date().toISOString(),
    chainId: 11155111,
    anchor: capture.report.anchor,
    endpoints,
    route: 'direct-https-public-contract-research',
    trust: 'two-rpc-agreement-unverified',
    providerIndependenceAssumed: true,
    captureReportSha256: capture.reportSha256,
    logSetSha256: capture.logSetSha256,
    eventBlocks: capture.blocks.size,
    verifiedHeaders: headers.size,
    rangeBoundaryParentLinks: capture.boundaries.length - 1,
    headerFileSha256: hash(fs.readFileSync(headerFile)),
    failedAttempts,
    failures,
    eventBlockHashesCanonicalByAgreement: true,
    bloomCheckedLogs,
    bloomMembershipIsInclusionProof: false,
    headerHashesRecomputed: false,
    receiptProofsVerified: false,
    nullifierCompletenessProven: false,
    privateNullifierQueries: 0,
    walletScanned: false,
    sourceSha256,
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  progress(report);
  return report;
}
module.exports = { header, bloomContains, verifyHeaders };
if (require.main === module)
  verifyHeaders({ directory: process.argv[2], output: process.argv[3] }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
