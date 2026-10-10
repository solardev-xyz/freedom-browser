const { createKohakuScanCache, MAX_BYTES, MAX_PAGES, MAX_AGE_MS } = require('./kohaku-scan-cache');
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const query = (n = 0) => ({
  address: `0x${'11'.repeat(20)}`,
  topics: [[hash(1)]],
  fromBlock: `0x${n.toString(16)}`,
  toBlock: `0x${(n + 9).toString(16)}`,
});
let encoded, read, active, storage;
const validate = (logs) => Array.isArray(logs) && logs.every((r) => typeof r.data === 'string');
const cache = () =>
  createKohakuScanCache({
    storage,
    read,
    assertActive: () => {
      if (!active) throw new Error('lifetime ended');
    },
  });
beforeEach(() => {
  active = true;
  encoded = null;
  storage = {
    get: jest.fn(async () => encoded),
    update: jest.fn(async (change) => {
      encoded = change(encoded);
    }),
  };
  read = jest.fn(async (method, [tag]) =>
    method === 'eth_getLogs'
      ? [{ data: '0x01', blockNumber: '0x0', blockHash: hash(100) }]
      : {
          number: tag === 'finalized' ? '0xffff' : tag,
          hash: hash(100 + Number(BigInt(tag === 'finalized' ? '0xffff' : tag))),
        }
  );
});

test('reuses a completed page after an interrupted later scan and a fresh instance', async () => {
  await cache().logs(query(), validate);
  const complete = encoded;
  const original = read.getMockImplementation();
  read.mockImplementation((method, params) =>
    method === 'eth_getLogs' ? Promise.reject(new Error('interrupted')) : original(method, params)
  );
  await expect(cache().logs(query(10), validate)).rejects.toThrow('interrupted');
  expect(encoded).toBe(complete);
  read.mockClear();
  expect(await cache().logs(query(), validate)).toEqual([
    { data: '0x01', blockNumber: '0x0', blockHash: hash(100) },
  ]);
  expect(read.mock.calls.map(([method]) => method)).toEqual([
    'eth_getBlockByNumber',
    'eth_getBlockByNumber',
  ]);
});

test('changed canonical anchor invalidates a page and refetches it before reuse', async () => {
  await cache().logs(query(), validate);
  const old = JSON.parse(encoded).pages[0].blockHash;
  read.mockImplementation(async (method, [tag]) =>
    method === 'eth_getLogs'
      ? [{ data: '0x02', blockNumber: '0x0', blockHash: hash(200) }]
      : { number: tag === 'finalized' ? '0xffff' : tag, hash: hash(200) }
  );
  expect(await cache().logs(query(), validate)).toEqual([
    { data: '0x02', blockNumber: '0x0', blockHash: hash(200) },
  ]);
  expect(JSON.parse(encoded).pages[0].blockHash).not.toBe(old);
});

test('unavailable anchor never serves cached data and falls back to a live log read', async () => {
  await cache().logs(query(), validate);
  const original = read.getMockImplementation();
  read
    .mockReset()
    .mockImplementation((method, params) =>
      method === 'eth_getBlockByNumber' && params[0] !== 'finalized'
        ? Promise.reject(new Error('offline'))
        : original(method, params)
    );
  await expect(cache().logs(query(), validate)).resolves.toHaveLength(1);
  expect(read.mock.calls.some(([method]) => method === 'eth_getLogs')).toBe(true);
});

test.each([null, { number: '0x0', hash: hash(1) }])(
  'unfinalized ranges are fetched but not saved (%j)',
  async (final) => {
    const original = read.getMockImplementation();
    read.mockImplementation((method, params) =>
      params[0] === 'finalized' ? Promise.resolve(final) : original(method, params)
    );
    await cache().logs(query(), validate);
    await cache().logs(query(), validate);
    expect(encoded).toBeNull();
    expect(read.mock.calls.filter(([method]) => method === 'eth_getLogs')).toHaveLength(2);
  }
);

test('anchor movement while downloading refuses the page without checkpointing', async () => {
  let downloaded = false;
  read.mockImplementation(async (method, [tag]) => {
    if (method === 'eth_getLogs') {
      downloaded = true;
      return [];
    }
    return { number: tag === 'finalized' ? '0xffff' : tag, hash: hash(downloaded ? 2 : 1) };
  });
  await expect(cache().logs(query(), validate)).rejects.toMatchObject({
    code: 'PRIVATE_SCAN_CACHE_INVALID',
  });
  expect(encoded).toBeNull();
});

test('replay is checked against the current grant and cannot mutate persisted data', async () => {
  await cache().logs(query(), validate);
  await expect(cache().logs(query(), () => false)).rejects.toMatchObject({
    code: 'PRIVATE_SCAN_CACHE_INVALID',
  });
  const logs = await cache().logs(query(), validate);
  logs[0].data = 'modified';
  expect((await cache().logs(query(), validate))[0].data).toBe('0x01');
});

test('lifetime ending during a response prevents cache writes or results', async () => {
  const original = read.getMockImplementation();
  read.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if (method === 'eth_getLogs') active = false;
    return result;
  });
  await expect(cache().logs(query(), validate)).rejects.toThrow('lifetime ended');
  expect(encoded).toBeNull();
});

test('capacity prunes only oldest disposable pages and skips a single oversized result', async () => {
  const instance = cache();
  for (let i = 0; i <= MAX_PAGES; i++) await instance.logs(query(i), validate);
  expect(JSON.parse(encoded).pages).toHaveLength(MAX_PAGES);
  expect(JSON.parse(JSON.parse(encoded).pages[0].key).fromBlock).toBe('0x1');
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_BYTES);
  const previous = encoded,
    original = read.getMockImplementation();
  read.mockImplementation((method, params) =>
    method === 'eth_getLogs'
      ? Promise.resolve([
          { data: 'x'.repeat(MAX_BYTES), blockNumber: '0x7d0', blockHash: hash(2100) },
        ])
      : original(method, params)
  );
  expect((await instance.logs(query(2000), validate))[0].data).toHaveLength(MAX_BYTES);
  expect(encoded).toBe(previous);
});

test('concurrent windows merge into the latest storage state without losing a checkpoint', async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => cache().logs(query(i), validate)));
  expect(JSON.parse(encoded).pages).toHaveLength(10);
});

test.each([
  'bad json',
  '{"version":0,"pages":[]}',
  '{"version":1,"pages":[],"extra":true}',
  'x'.repeat(MAX_BYTES + 1),
])('logical cache corruption is replaced by a fresh read (%#)', async (value) => {
  encoded = value;
  await expect(cache().logs(query(), validate)).resolves.toHaveLength(1);
  expect(read).toHaveBeenCalled();
  expect(JSON.parse(encoded).pages).toHaveLength(1);
});

test.each(['expiry', 'bypass'])(
  'a lagging empty log page is refreshed after %s',
  async (reason) => {
    const original = read.getMockImplementation();
    read.mockImplementation((method, params) =>
      method === 'eth_getLogs' ? Promise.resolve([]) : original(method, params)
    );
    await cache().logs(query(), validate);
    read.mockImplementation(original);
    const now = Date.now();
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(now + (reason === 'expiry' ? MAX_AGE_MS + 1 : 0));
    try {
      expect(await cache().logs(query(), validate, { bypass: reason === 'bypass' })).toHaveLength(
        1
      );
    } finally {
      clock.mockRestore();
    }
  }
);

test('storage authentication failures are not mistaken for disposable logical cache corruption', async () => {
  storage.get.mockRejectedValue(
    Object.assign(new Error('unauthenticated'), { code: 'PRIVATE_STORAGE_READ_FAILED' })
  );
  await expect(cache().logs(query(), validate)).rejects.toMatchObject({
    code: 'PRIVATE_STORAGE_READ_FAILED',
  });
  expect(read).not.toHaveBeenCalled();
  expect(storage.update).not.toHaveBeenCalled();
});

test.each(['end-hash', 'same-block-conflict'])(
  'refuses internally inconsistent log hashes: %s',
  async (kind) => {
    const original = read.getMockImplementation();
    read.mockImplementation((method, params) =>
      method !== 'eth_getLogs'
        ? original(method, params)
        : Promise.resolve(
            kind === 'end-hash'
              ? [{ data: '0x', blockNumber: '0x9', blockHash: hash(999) }]
              : [
                  { data: '0x', blockNumber: '0x1', blockHash: hash(1) },
                  { data: '0x', blockNumber: '0x1', blockHash: hash(2) },
                ]
          )
    );
    await expect(cache().logs(query(), validate)).rejects.toMatchObject({
      code: 'PRIVATE_SCAN_CACHE_INVALID',
    });
    expect(encoded).toBeNull();
  }
);

test.each(['finality-error', 'null-anchor', 'after-anchor-error', 'disk-full'])(
  'cache-only failure preserves a usable uncached response: %s',
  async (reason) => {
    const original = read.getMockImplementation();
    let downloaded = false;
    read.mockImplementation((method, params) => {
      if (reason === 'finality-error' && params[0] === 'finalized') throw new Error('unsupported');
      if (
        reason === 'null-anchor' &&
        method === 'eth_getBlockByNumber' &&
        params[0] !== 'finalized'
      )
        return null;
      if (reason === 'after-anchor-error' && method === 'eth_getBlockByNumber' && downloaded)
        throw new Error('lagging backend');
      if (method === 'eth_getLogs') downloaded = true;
      return original(method, params);
    });
    if (reason === 'disk-full')
      storage.update.mockRejectedValue(
        Object.assign(new Error('disk full'), { code: 'PRIVATE_STORAGE_WRITE_FAILED' })
      );
    expect(await cache().logs(query(), validate)).toHaveLength(1);
    expect(encoded).toBeNull();
  }
);

test('finality observation is shared across concurrent eligible pages within a minute', async () => {
  const instance = cache();
  await Promise.all([instance.logs(query(), validate), instance.logs(query(1), validate)]);
  await instance.logs(query(2), validate);
  expect(read.mock.calls.filter(([, params]) => params[0] === 'finalized')).toHaveLength(1);
});
