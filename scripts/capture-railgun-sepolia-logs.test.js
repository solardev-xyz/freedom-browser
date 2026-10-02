const fs = require('fs');
const os = require('os');
const path = require('path');
const { keccak256 } = require('ethers');
const { normalizeLogs, capture, rpc } = require('./capture-railgun-sepolia-logs');
afterEach(() => jest.restoreAllMocks());
const log = {
  address: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
  removed: false,
  blockNumber: '0x20',
  blockHash: '0x' + '12'.repeat(32),
  transactionHash: '0x' + '34'.repeat(32),
  transactionIndex: '0x0',
  logIndex: '0x1',
  topics: ['0x' + '56'.repeat(32)],
  data: '0x1234',
};
test('normalizes address and order while preserving empty ranges', () => {
  expect(normalizeLogs([], 0, 100)).toEqual([]);
  expect(normalizeLogs([log, { ...log, logIndex: '0x0' }], 0, 100).map((x) => x.logIndex)).toEqual([
    0, 1,
  ]);
});
test.each([
  { removed: true },
  { blockNumber: '0x65' },
  { blockNumber: '0x020' },
  { data: '0x123' },
  { data: '0xz1' },
  { address: '0x' + '00'.repeat(20) },
  { topics: [] },
  { transactionHash: '0x12' },
])('refuses malformed or out-of-range event %j', (patch) => {
  expect(() => normalizeLogs([{ ...log, ...patch }], 0, 100)).toThrow();
});
test('refuses duplicated positions and inconsistent block hashes', () => {
  expect(() => normalizeLogs([log, log], 0, 100)).toThrow();
  expect(() =>
    normalizeLogs([log, { ...log, logIndex: '0x2', blockHash: '0x' + '78'.repeat(32) }], 0, 100)
  ).toThrow();
});
const blockHash = (n) =>
  '0x' +
  BigInt(n + 100)
    .toString(16)
    .padStart(64, '0');
const header = (n) => ({ number: '0x' + n.toString(16), hash: blockHash(n) });
function fixture(change = () => {}) {
  const directory = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-capture-test-')),
    'capture'
  );
  const ranges = [];
  const sleep = jest.fn(async () => {});
  const request = jest.fn(async (url, calls) => {
    const result = calls.map(([method, params]) => {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_getCode') return '0x12';
      if (method === 'eth_getBlockByNumber')
        return header(params[0] === 'finalized' ? 10 : Number(BigInt(params[0])));
      if (method === 'eth_getLogs') return [];
      throw new Error('Unexpected method');
    });
    if (calls.length === 3)
      ranges.push([
        Number(BigInt(calls[1][1][0].fromBlock)),
        Number(BigInt(calls[1][1][0].toBlock)),
      ]);
    change({ url, calls, result });
    return result;
  });
  const options = {
    directory,
    baseline: {
      anchor: { number: 9, hash: blockHash(9) },
      code: { proxy: { keccak256: keccak256('0x12') } },
    },
    request,
    sleep,
    progress: () => {},
    maxSpan: 4,
  };
  return {
    options,
    ranges,
    request,
    sleep,
    reportExists: () => fs.existsSync(path.join(directory, 'report.json')),
  };
}
test('capture covers genesis through the exact anchor with contiguous bounded ranges', async () => {
  const f = fixture();
  const report = await capture(f.options);
  expect(report.pages.map(({ from, to }) => [from, to])).toEqual([
    [0, 3],
    [4, 7],
    [8, 9],
  ]);
  expect(report.totalLogs).toBe(0);
  expect(f.reportExists()).toBe(true);
});
test('provider disagreement is terminal and never publishes a complete report', async () => {
  const f = fixture(({ url, calls, result }) => {
    if (url.includes('tenderly') && calls.length === 3) result[0].hash = blockHash(900);
  });
  await expect(capture(f.options)).rejects.toThrow('RPC range disagreement');
  expect(f.ranges).toHaveLength(2);
  expect(f.reportExists()).toBe(false);
});
test('a transient provider failure retries the same range without shrinking it', async () => {
  let failed = false;
  const f = fixture(({ calls }) => {
    if (calls.length === 3 && !failed) {
      failed = true;
      throw Object.assign(new Error(), { code: 'CAPTURE_TRANSIENT' });
    }
  });
  const report = await capture(f.options);
  expect(f.ranges.slice(0, 4)).toEqual([
    [0, 3],
    [0, 3],
    [0, 3],
    [0, 3],
  ]);
  expect(report.pages[0]).toMatchObject({ from: 0, to: 3 });
  expect(f.sleep).toHaveBeenCalledWith(1500);
});
test.each(['CAPTURE_RANGE', 'local-count'])(
  'capacity refusal %s splits immediately, then grows toward the maximum',
  async (mode) => {
    let failed = false;
    const f = fixture(({ calls, result }) => {
      if (calls.length === 3 && !failed) {
        failed = true;
        if (mode === 'local-count') result[1] = Array(4097).fill(log);
        else throw Object.assign(new Error(), { code: mode });
      }
    });
    const report = await capture(f.options);
    expect(report.pages.map(({ from, to }) => [from, to])).toEqual([
      [0, 1],
      [2, 5],
      [6, 9],
    ]);
    expect(f.sleep.mock.calls.every(([ms]) => ms === 500)).toBe(true);
  }
);
test('a final anchor change invalidates all written pages as an incomplete capture', async () => {
  const f = fixture(({ calls, result }) => {
    if (calls.length === 1) result[0].hash = blockHash(900);
  });
  await expect(capture(f.options)).rejects.toThrow();
  expect(f.reportExists()).toBe(false);
});
test('repeated transient errors stop instead of shrinking requests indefinitely', async () => {
  const f = fixture(({ calls }) => {
    if (calls.length === 3) throw Object.assign(new Error(), { code: 'CAPTURE_TRANSIENT' });
  });
  await expect(capture(f.options)).rejects.toMatchObject({ code: 'CAPTURE_TRANSIENT' });
  expect(f.ranges).toHaveLength(6);
  expect(f.ranges.every(([from, to]) => from === 0 && to === 3)).toBe(true);
  expect(f.reportExists()).toBe(false);
});
test('body reset retries as transient while a body cap requests a split', async () => {
  const fetch = jest.spyOn(global, 'fetch');
  fetch.mockResolvedValue({
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('[');
        throw new Error('reset');
      },
    },
  });
  await expect(rpc('https://example.invalid', [['eth_chainId', []]])).rejects.toMatchObject({
    code: 'CAPTURE_TRANSIENT',
  });
  fetch.mockResolvedValue({ status: 200, body: [Buffer.alloc(4 * 1024 * 1024 + 1)] });
  await expect(rpc('https://example.invalid', [['eth_chainId', []]])).rejects.toMatchObject({
    code: 'CAPTURE_RANGE',
  });
});
test.each([
  ['cannot generate response', 'CAPTURE_REFUSED'],
  ['please iterate again', 'CAPTURE_REFUSED'],
  ['rate limit exceeded', 'CAPTURE_TRANSIENT'],
  ['query returned more than 10000 results', 'CAPTURE_RANGE'],
])(
  'RPC classification for %s is bounded and does not retain raw error text',
  async (message, code) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({
        status: 200,
        body: [
          Buffer.from(
            JSON.stringify([{ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }])
          ),
        ],
      });
    try {
      await rpc('https://example.invalid', [['eth_getLogs', []]]);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error.code).toBe(code);
      expect(error.evidence.messageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(error)).not.toContain(message);
    }
  }
);
