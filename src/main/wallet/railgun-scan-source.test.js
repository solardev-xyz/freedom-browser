jest.mock('../networks/private-rpc', () => ({ createPrivateRpc: jest.fn() }));
const { createPrivateRpc } = require('../networks/private-rpc');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { emptyPublicState } = require('./railgun-public-records');
const {
  createRailgunScanSource,
  normalizeLogs,
  MAX_AGE_MS,
  PROXY,
} = require('./railgun-scan-source');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const block = (n) => ({ number: '0x' + n.toString(16), hash: hash(n + 1), parentHash: hash(n) });
const log = () => ({
  address: PROXY,
  blockNumber: '0x5',
  blockHash: hash(6),
  transactionHash: hash(33),
  transactionIndex: '0x0',
  logIndex: '0x1',
  removed: false,
  topics: [hash(22)],
  data: '0x0102',
});
let scope, handle, ledger, rpc, projectRange, sources, now;
const input = () => ({
  from: 0,
  to: 10,
  previousHash: hash(0),
  anchor: { number: 100, hash: hash(101) },
  storeId: 'a'.repeat(64),
});
function open(options = {}) {
  const source = createRailgunScanSource({ handle, ledger, projectRange, ...options });
  sources.push(source);
  return source;
}
beforeEach(() => {
  now = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  scope = createPrivacyScope({ profileId: 'source-fixture', signal: new AbortController().signal });
  sources = [];
  handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    chainId: 11155111,
    deployment: 'fixture',
    role: 'protocol-rpc',
  });
  let staged = [];
  ledger = {
    signal: scope.signal,
    identity: () => 'b'.repeat(64),
    stage: jest.fn(async (_range, logs) => {
      staged = logs;
      return Object.freeze({ ledgerId: 'b'.repeat(64), ledgerSha256: 'c'.repeat(64) });
    }),
    visit: jest.fn(async (_reference, visitor) => {
      for (const value of staged) await visitor(value);
      return { count: staged.length };
    }),
    visitThrough: jest.fn(async (_sha, visitor) => {
      for (const value of staged) await visitor(value);
      return { count: staged.length };
    }),
  };
  createPrivateRpc.mockImplementation((handle, _role, { signal }) => {
    const lifetime = AbortSignal.any([getPrivacyContext(handle).signal, signal]);
    rpc = {
      signal: lifetime,
      trust: { queried: ['rpc.example'] },
      release: jest.fn(),
      assertActive: () => {
        if (lifetime.aborted) throw Error('closed');
      },
      request: jest.fn(async (method, params) => ({
        result:
          method === 'eth_getLogs'
            ? [log()]
            : block(params[0] === 'finalized' ? 100 : Number(BigInt(params[0]))),
      })),
    };
    return rpc;
  });
  projectRange = jest.fn(async ({ range }, { visit }) => {
    await visit(() => {});
    return emptyPublicState(range.storeId);
  });
});
afterEach(() => {
  sources.forEach((s) => s.close());
  scope.close();
  jest.restoreAllMocks();
});
test('snapshot source visiting pins a fresh registered prefix and permits later header refresh', async () => {
  const source = open(),
    result = await source.acquire(input()),
    seen = [];
  await expect(source.visitSnapshot(result.plan, {}, () => {})).rejects.toThrow();
  const visited = await source.visitSnapshot(result.plan, result.evidence, (log) => {
    seen.push(log);
    now += MAX_AGE_MS + 1;
  });
  expect(visited.count).toBe(1);
  expect(seen).toEqual(result.logs);
  expect(ledger.visitThrough).toHaveBeenCalledWith(
    result.plan.source.ledgerSha256,
    expect.any(Function)
  );
  expect(() => source.assertSource(result.plan, result.evidence)).toThrow();
  const fresh = await source.refresh(result.plan, result.evidence);
  expect(() => source.assertSource(result.plan, fresh)).not.toThrow();
});
test('expired snapshot evidence and revoked visitors cannot provide source coverage', async () => {
  const source = open(),
    result = await source.acquire(input());
  now += MAX_AGE_MS + 1;
  await expect(source.visitSnapshot(result.plan, result.evidence, () => {})).rejects.toThrow();
  expect(ledger.visitThrough).not.toHaveBeenCalled();
  const fresh = await source.refresh(result.plan, result.evidence);
  await expect(source.visitSnapshot(result.plan, fresh, () => scope.close())).rejects.toThrow();
});
test('acquires only public proxy history, checks headers and registers exact unverified provenance', async () => {
  const source = open(),
    result = await source.acquire(input());
  expect(source.assertSource(result.plan, result.evidence)).toBeUndefined();
  expect(result.plan.source).toMatchObject({
    level: 'unverified-rpc',
    ledgerId: 'b'.repeat(64),
    ledgerSha256: 'c'.repeat(64),
  });
  expect(result.plan.logs.count).toBe(1);
  expect(Object.isFrozen(result.logs[0])).toBe(true);
  expect(rpc.request.mock.calls.filter(([m]) => m === 'eth_getLogs')).toEqual([
    ['eth_getLogs', [{ address: PROXY, fromBlock: '0x0', toBlock: '0xa' }], expect.any(Function)],
  ]);
  expect(
    rpc.request.mock.calls.every(([m]) => ['eth_getLogs', 'eth_getBlockByNumber'].includes(m))
  ).toBe(true);
  expect(rpc.request).toHaveBeenCalledWith(
    'eth_getBlockByNumber',
    ['0x5', false],
    expect.any(Function)
  );
  expect(ledger.visit).toHaveBeenCalledTimes(1);
  expect(() => source.assertSource(result.plan, { ...result.evidence })).toThrow();
  expect(() =>
    source.assertSource(
      { ...result.plan, source: { ...result.plan.source, level: 'proof' } },
      result.evidence
    )
  ).toThrow();
});
test('expires monotonically and refreshes only canonical boundaries without downloading logs again', async () => {
  const source = open(),
    result = await source.acquire(input());
  now += MAX_AGE_MS;
  expect(() => source.assertSource(result.plan, result.evidence)).toThrow();
  const fresh = await source.refresh(result.plan, result.evidence);
  expect(source.assertSource(result.plan, fresh)).toBeUndefined();
  expect(rpc.request.mock.calls.filter(([m]) => m === 'eth_getLogs')).toHaveLength(1);
  expect(projectRange).toHaveBeenCalledTimes(1);
  now = 0;
  expect(() => source.assertSource(result.plan, fresh)).toThrow();
});
test.each([
  'anchor',
  'parent',
  'event-header',
  'finalized-height',
  'finalized-hash',
  'post-plan-reorg',
  'missing-ledger-visit',
  'provider-error',
])('refuses %s without evidence', async (mode) => {
  const source = open(),
    original = rpc.request.getMockImplementation();
  rpc.request.mockImplementation(async (method, params, ...rest) => {
    if (mode === 'provider-error') throw Error('private provider detail');
    const response = await original(method, params, ...rest);
    if (method === 'eth_getBlockByNumber') {
      if (mode === 'anchor' && params[0] === '0x64') response.result.hash = hash(99);
      if (mode === 'parent' && params[0] === '0x0') response.result.parentHash = hash(99);
      if (mode === 'event-header' && params[0] === '0x5') response.result.hash = hash(99);
      if (mode === 'finalized-height' && params[0] === 'finalized') response.result = block(50);
      if (mode === 'finalized-hash' && params[0] === 'finalized') response.result.hash = hash(99);
      if (mode === 'post-plan-reorg' && projectRange.mock.calls.length && params[0] === '0xa')
        response.result.hash = hash(99);
    }
    return response;
  });
  if (mode === 'missing-ledger-visit')
    projectRange.mockImplementation(async ({ range }) => emptyPublicState(range.storeId));
  await expect(source.acquire(input())).rejects.toMatchObject({
    code: 'RAILGUN_SCAN_SOURCE_REFUSED',
    message: 'Railgun scan source unavailable',
  });
  expect(source.signal.aborted).toBe(true);
});
test('snapshots range input and prevents overlapping acquisitions', async () => {
  const source = open(),
    range = input(),
    pending = source.acquire(range);
  range.to = 99;
  await expect(source.acquire(input())).rejects.toThrow();
  const result = await pending;
  expect(result.plan.to.number).toBe(10);
});
test('scope revocation during planning prevents evidence and aborts transport', async () => {
  const source = open();
  projectRange.mockImplementation(async () => {
    scope.close();
    return emptyPublicState('a'.repeat(64));
  });
  await expect(source.acquire(input())).rejects.toThrow();
  expect(source.signal.aborted).toBe(true);
});
test('old evidence cannot be replayed in a different source session', async () => {
  const first = open(),
    result = await first.acquire(input()),
    second = open();
  expect(() => second.assertSource(result.plan, result.evidence)).toThrow();
  await expect(second.refresh(result.plan, result.evidence)).rejects.toThrow();
});
test.each([
  'removed',
  'wrong-proxy',
  'range',
  'duplicate',
  'block-conflict',
  'tx-order',
  'tx-hash',
  'oversized',
  'topics',
  'data',
])('public log normalization refuses %s', (mode) => {
  const values = [log()];
  if (mode === 'removed') values[0].removed = true;
  if (mode === 'wrong-proxy') values[0].address = '0x' + '9'.repeat(40);
  if (mode === 'range') values[0].blockNumber = '0x20';
  if (mode === 'duplicate') values.push(log());
  if (mode === 'block-conflict') values.push({ ...log(), logIndex: '0x2', blockHash: hash(99) });
  if (mode === 'tx-order') {
    values[0].transactionIndex = '0x2';
    values.push({ ...log(), logIndex: '0x2' });
  }
  if (mode === 'tx-hash') values.push({ ...log(), logIndex: '0x2', transactionHash: hash(99) });
  if (mode === 'oversized') values.push(...Array(4096).fill(log()));
  if (mode === 'topics') values[0].topics = [];
  if (mode === 'data') values[0].data = '0x1';
  expect(() => normalizeLogs(values, 0, 10)).toThrow();
});
test('normalizes a maximum-sized hex payload without recursive-regexp stack growth', () => {
  const value = log();
  value.data = '0x' + 'ab'.repeat(1024 * 1024 - 1);
  expect(normalizeLogs([value], 0, 10).logs[0].data).toBe(value.data);
  value.data = value.data.slice(0, -1) + 'z';
  expect(() => normalizeLogs([value], 0, 10)).toThrow();
});
test('profile lock cancels a silent planner without awaiting its callback', async () => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  projectRange.mockImplementation(async () => {
    entered();
    await new Promise(() => {});
  });
  const source = open(),
    pending = source.acquire(input());
  await started;
  scope.close();
  await expect(pending).rejects.toThrow();
});

test('durable target hook runs after canonical validation and before staging; refusal preserves ledger', async () => {
  let protectedTarget = false;
  const stage = ledger.stage.getMockImplementation();
  ledger.stage.mockImplementation(async (...args) => {
    expect(protectedTarget).toBe(true);
    return stage(...args);
  });
  const source = open({
    beforeAcquire: async (range) => {
      expect(range).toEqual(input());
      expect(rpc.request).toHaveBeenCalled();
      expect(ledger.stage).not.toHaveBeenCalled();
      protectedTarget = true;
    },
  });
  await source.acquire(input());
  expect(ledger.stage).toHaveBeenCalledTimes(1);
});
test('invalid input and canonical mismatch cannot raise the durable acquisition floor', async () => {
  const beforeAcquire = jest.fn();
  const source = open({ beforeAcquire });
  await expect(source.acquire({ ...input(), to: 100001 })).rejects.toThrow();
  expect(beforeAcquire).not.toHaveBeenCalled();
  await expect(
    source.acquire({ ...input(), anchor: { number: 100, hash: hash(999) } })
  ).rejects.toThrow();
  expect(beforeAcquire).not.toHaveBeenCalled();
  expect(ledger.stage).not.toHaveBeenCalled();
});
test('failure to persist the floor refuses before acquiring or staging logs', async () => {
  const source = open({
    beforeAcquire: async () => {
      throw Error('disk');
    },
  });
  await expect(source.acquire(input())).rejects.toThrow();
  expect(ledger.stage).not.toHaveBeenCalled();
  expect(rpc.request.mock.calls.some(([method]) => method === 'eth_getLogs')).toBe(false);
});

test('event headers run in bounded groups and all validate before ledger staging', async () => {
  const source = open(),
    original = rpc.request.getMockImplementation();
  let inFlight = 0,
    maximum = 0,
    checked = 0;
  const logs = Array.from({ length: 20 }, (_, i) => ({
    ...log(),
    blockNumber: '0x' + (i + 1).toString(16),
    blockHash: hash(i + 2),
  }));
  rpc.request.mockImplementation(async (method, params, ...rest) => {
    if (method === 'eth_getLogs') return { result: logs };
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await original(method, params, ...rest);
    inFlight--;
    checked++;
    return result;
  });
  ledger.stage.mockImplementationOnce(async () => {
    expect(inFlight).toBe(0);
    expect(checked).toBe(24); // Four distinct boundary/header reads plus 20 event blocks.
    return Object.freeze({ ledgerId: 'b'.repeat(64), ledgerSha256: 'c'.repeat(64) });
  });
  await source.acquire({ ...input(), to: 30 });
  expect(maximum).toBe(8);
});

test('header mismatch cancels siblings and drains them before rejecting without staging', async () => {
  const source = open(),
    original = rpc.request.getMockImplementation();
  let sawLogs = false,
    release,
    siblingStarted = false,
    settled = false;
  rpc.request.mockImplementation(async (method, params, ...rest) => {
    if (method === 'eth_getLogs') {
      sawLogs = true;
      return { result: [log(), { ...log(), blockNumber: '0x6', blockHash: hash(7) }] };
    }
    if (sawLogs && params[0] === '0x6') {
      siblingStarted = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    const result = await original(method, params, ...rest);
    if (sawLogs && params[0] === '0x5') result.result.hash = hash(99);
    return result;
  });
  const operation = source.acquire(input()).finally(() => {
    settled = true;
  });
  const rejected = expect(operation).rejects.toThrow('Railgun scan source unavailable');
  while (!siblingStarted || !rpc.signal.aborted) await Promise.resolve();
  expect(settled).toBe(false);
  expect(ledger.stage).not.toHaveBeenCalled();
  release();
  await rejected;
  expect(ledger.stage).not.toHaveBeenCalled();
});

test('canonical boundary reads are concurrent and deduplicate identical block numbers', async () => {
  const source = open(),
    original = rpc.request.getMockImplementation();
  let pending = 0,
    maximum = 0;
  rpc.request.mockImplementation(async (method, params, ...rest) => {
    if (method === 'eth_getLogs') return { result: [] };
    pending++;
    maximum = Math.max(maximum, pending);
    await new Promise((resolve) => setImmediate(resolve));
    pending--;
    return original(method, params, ...rest);
  });
  await source.acquire({ ...input(), from: 100, to: 100, previousHash: hash(100) });
  expect(maximum).toBe(3); // finalized, block 100 and its predecessor.
  expect(
    rpc.request.mock.calls.filter(
      ([method, params]) => method === 'eth_getBlockByNumber' && params[0] === '0x64'
    )
  ).toHaveLength(2);
});
