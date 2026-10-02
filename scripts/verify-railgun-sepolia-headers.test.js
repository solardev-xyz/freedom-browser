const fs = require('fs');
const os = require('os');
const path = require('path');
const { keccak256 } = require('ethers');
const { bloomContains, header, verifyHeaders } = require('./verify-railgun-sepolia-headers');
const blockHash = (n) =>
  '0x' +
  BigInt(n + 100)
    .toString(16)
    .padStart(64, '0');
const address = '0x' + '12'.repeat(20);
const topic = '0x' + '34'.repeat(32);
// Independent whole-integer bloom construction, rather than byte indexing.
function bloom(values) {
  let bits = 0n;
  for (const value of values) {
    const digest = keccak256(value).slice(2);
    for (let n = 0; n < 12; n += 4) bits |= 1n << (BigInt('0x' + digest.slice(n, n + 4)) & 2047n);
  }
  return '0x' + bits.toString(16).padStart(512, '0');
}
const block = (n) => ({
  number: '0x' + n.toString(16),
  hash: blockHash(n),
  parentHash: blockHash(n - 1),
  receiptsRoot: blockHash(400),
  logsBloom: bloom([address, topic]),
  timestamp: '0x1234',
});
function fixture(change = () => {}) {
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-headers-')), 'output');
  const capture = {
    report: { anchor: { number: 7, hash: blockHash(7) }, totalLogs: 1 },
    reportSha256: 'a'.repeat(64),
    logSetSha256: 'b'.repeat(64),
    blocks: new Map([[2, blockHash(2)]]),
    boundaries: [
      { from: { number: 0, hash: blockHash(0) }, to: { number: 3, hash: blockHash(3) } },
      { from: { number: 4, hash: blockHash(4) }, to: { number: 7, hash: blockHash(7) } },
    ],
    *logs() {
      yield { blockNumber: 2, blockHash: blockHash(2), address, topics: [topic] };
    },
  };
  const request = jest.fn(async (url, calls) => {
    const result = calls.map(([method, params]) => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_getBlockByNumber')
        return block(params[0] === 'finalized' ? 10 : Number(BigInt(params[0])));
      throw new Error('Unexpected method');
    });
    change({ url, calls, result });
    return result;
  });
  return {
    options: { output, capture, request, sleep: jest.fn(), progress: jest.fn() },
    reportExists: () => fs.existsSync(path.join(output, 'report.json')),
  };
}
test('bloom membership uses raw address and topic bytes with Ethereum bit order', () => {
  expect(bloomContains(bloom([address, topic]), address)).toBe(true);
  expect(bloomContains(bloom([address, topic]), topic)).toBe(true);
  expect(bloomContains(bloom([address]), topic)).toBe(false);
  expect(bloomContains(bloom([]), address)).toBe(false);
  expect(() => bloomContains('0x00', address)).toThrow();
  expect(() => header({ ...block(2), logsBloom: '0x00' }, 2)).toThrow();
});
test('covers every event block and boundary, checks blooms, and explicitly limits trust', async () => {
  const f = fixture();
  const report = await verifyHeaders(f.options);
  expect(report).toMatchObject({
    eventBlocks: 1,
    verifiedHeaders: 5,
    rangeBoundaryParentLinks: 1,
    eventBlockHashesCanonicalByAgreement: true,
    bloomCheckedLogs: 1,
    bloomMembershipIsInclusionProof: false,
    receiptProofsVerified: false,
    nullifierCompletenessProven: false,
  });
  expect(f.reportExists()).toBe(true);
});
test.each(['disagreement', 'noncanonical', 'parent', 'final-anchor', 'bloom'])(
  '%s failure leaves no complete report',
  async (mode) => {
    let singletonBatches = 0;
    const f = fixture(({ url, calls, result }) => {
      if (calls[0][0] !== 'eth_getBlockByNumber') return;
      if (calls.length === 1) singletonBatches++;
      if (mode === 'final-anchor' && singletonBatches > 2) result[0].hash = blockHash(99);
      for (const value of result) {
        if (mode === 'disagreement' && url.includes('tenderly')) value.receiptsRoot = blockHash(88);
        if (mode === 'noncanonical' && value.number === '0x2') value.hash = blockHash(99);
        if (mode === 'parent' && value.number === '0x4') value.parentHash = blockHash(99);
        if (mode === 'bloom' && value.number === '0x2') value.logsBloom = bloom([address]);
      }
    });
    const expected = {
      disagreement: 'Canonical header disagreement',
      noncanonical: 'Captured event or boundary is not canonical',
      parent: 'Expected values to be strictly equal',
      'final-anchor': 'Expected values to be strictly equal',
      bloom: 'Log is inconsistent with header bloom',
    };
    await expect(verifyHeaders(f.options)).rejects.toThrow(expected[mode]);
    if (mode === 'final-anchor') expect(singletonBatches).toBe(4);
    expect(f.reportExists()).toBe(false);
  }
);
test('transient retry records bounded diagnostics and eventually completes', async () => {
  let failed = false;
  const f = fixture(() => {
    if (failed) return;
    failed = true;
    throw Object.assign(new Error('do not retain provider text'), {
      code: 'CAPTURE_TRANSIENT',
      evidence: { classification: 'CAPTURE_TRANSIENT', reason: 'http-status', status: 429 },
    });
  });
  const report = await verifyHeaders(f.options);
  expect(report.failedAttempts).toBe(1);
  expect(report.failures[0]).toMatchObject({ status: 429, attempt: 0 });
  expect(JSON.stringify(report)).not.toContain('do not retain');
  expect(f.options.sleep).toHaveBeenCalledWith(1000);
});
test('repeated transient failures stop after five attempts without a report', async () => {
  const f = fixture(() => {
    throw Object.assign(new Error(), { code: 'CAPTURE_TRANSIENT' });
  });
  await expect(verifyHeaders(f.options)).rejects.toMatchObject({ code: 'CAPTURE_TRANSIENT' });
  expect(f.options.request).toHaveBeenCalledTimes(10);
  expect(f.reportExists()).toBe(false);
});
