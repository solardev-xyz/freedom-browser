let mockEndpoint;
const mockTransport = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => ['https://rpc.example/completed-source'],
  getEndpointSources: () => [
    { keyed: false, coverage: { 11155111: 'https://rpc.example/completed-source' } },
  ],
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: (...args) => mockTransport(...args), release() {} }),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunSourceLedger, railgunSourceBinding } = require('./railgun-source-ledger');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const {
  createRailgunScanSource,
  getRailgunScanSourceDestination,
  normalizeLogs,
  PROXY,
} = require('./railgun-scan-source');
const { emptyPublicState } = require('./railgun-public-records');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const block = (n) => ({ number: '0x' + n.toString(16), hash: hash(n + 1), parentHash: hash(n) });
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let scope, tor, resources, operations, wires, wireHook, logNumbers;
const subject = {
  kind: 'private-account',
  principal: 'fixture',
  protocol: 'railgun',
  chainId: 11155111,
  deployment: 'sepolia-fixture',
};
const rawLogs = () =>
  logNumbers.map((n) => ({
    address: PROXY,
    blockNumber: '0x' + n.toString(16),
    blockHash: hash(n + 1),
    transactionHash: hash(n + 40),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
    topics: [hash(22)],
    data: '0x0102',
  }));
function response(wire, result) {
  return {
    status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
  };
}
function defaultReply(wire) {
  return wire.method === 'eth_chainId'
    ? '0xaa36a7'
    : wire.method === 'eth_getLogs'
      ? rawLogs()
      : block(wire.params[0] === 'finalized' ? 100 : Number(BigInt(wire.params[0])));
}
async function close(value) {
  value.close();
  await value.closed;
}
async function fixture({ corrupt = false, project, missing = false, anchor = 100 } = {}) {
  const handle = scope.getContext({ ...subject, role: 'protocol-rpc' });
  const options = {
    handle,
    filename: path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-completed-source-')),
      'source.sqlite'
    ),
    key: Buffer.alloc(32, 82),
    binding: 'd'.repeat(64),
  };
  let actual = await createRailgunSourceLedger({ ...options, create: true });
  resources.push(actual);
  const normalized = normalizeLogs(rawLogs(), 0, 10).logs;
  const digest = {
    count: normalized.length,
    sha256: sha(normalized.map((log) => JSON.stringify(log) + '\n').join('')),
  };
  const providersSha256 = sha(JSON.stringify(['rpc.example']));
  const reference = missing
    ? { ledgerId: actual.identity(), ledgerSha256: 'f'.repeat(64) }
    : await actual.stage(
        {
          from: 0,
          to: { number: 10, hash: hash(11) },
          previousHash: hash(0),
          providersSha256,
          logs: digest,
        },
        normalized
      );
  if (corrupt) {
    await close(actual);
    const worker = startRailgunSessionWorker({
      handle: scope.getContext({ ...subject, role: 'engine' }),
      storage: {
        format: 'paged-v2',
        filename: options.filename,
        key: options.key,
        binding: railgunSourceBinding(options.binding),
        create: false,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw Error('No RPC');
        },
      }),
      onClose: () => {},
    });
    resources.push(worker);
    await worker.ready;
    await worker.dispatch(
      JSON.stringify({
        id: 1,
        method: 'batch',
        args: {
          operations: [
            {
              type: 'put',
              key: Buffer.from('source:range:00000:log:00001').toString('base64'),
              value: Buffer.from(JSON.stringify({ ...normalized[1], data: '0x9999' })).toString(
                'base64'
              ),
            },
          ],
        },
      })
    );
    await close(worker);
    actual = await createRailgunSourceLedger({ ...options, create: false });
    resources.push(actual);
  }
  const ledger = { ...actual };
  for (const method of ['stage', 'retain', 'visit', 'visitThrough', 'hasPrefix'])
    ledger[method] = jest.fn((...args) => actual[method](...args));
  const beforeAcquire = jest.fn();
  const seen = [];
  const projectRange = jest.fn(
    project ||
      (async ({ range }, { visit }) => {
        await visit((log) => {
          seen.push(log);
        });
        return emptyPublicState(range.storeId);
      })
  );
  const source = createRailgunScanSource({ handle, ledger, projectRange, beforeAcquire });
  resources.push(source);
  const checkpoint = {
    from: 0,
    previousHash: hash(0),
    to: { number: 10, hash: hash(11) },
    anchor: { number: anchor, hash: hash(anchor + 1) },
    logs: digest,
    source: { level: 'unverified-rpc', providersSha256, ...reference },
    state: emptyPublicState('a'.repeat(64)),
  };
  return { source, checkpoint, ledger, handle, beforeAcquire, projectRange, seen, normalized };
}
async function operation(entry, overrides = {}) {
  const caller = new AbortController();
  const value = await entry.source.openCompletedCheckpointRead({
    checkpoint: entry.checkpoint,
    destination: getRailgunScanSourceDestination(entry.source, entry.handle),
    signal: caller.signal,
    deadline: performance.now() + 120000,
    ...overrides,
  });
  operations.push(value);
  return { value, caller };
}
function noWrites(entry) {
  expect(entry.ledger.stage).not.toHaveBeenCalled();
  expect(entry.ledger.retain).not.toHaveBeenCalled();
  expect(entry.ledger.visit).not.toHaveBeenCalled();
  expect(entry.beforeAcquire).not.toHaveBeenCalled();
}
async function healthyAgain(entry) {
  const { value } = await operation(entry);
  await value.prepare();
  await value.finish();
  await close(value);
  expect(entry.source.signal.aborted).toBe(false);
}
beforeEach(() => {
  mockTransport.mockReset();
  tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({
    profileId: 'completed-source-fixture',
    signal: new AbortController().signal,
  });
  resources = [];
  operations = [];
  wires = [];
  wireHook = null;
  logNumbers = [5, 6];
  mockTransport.mockImplementation(async (_handle, url, options) => {
    expect(url).toBe('https://rpc.example/completed-source');
    const wire = JSON.parse(options.body);
    wires.push(wire);
    return wireHook ? wireHook(wire) : response(wire, defaultReply(wire));
  });
});
afterEach(async () => {
  for (const value of operations) value.close();
  await Promise.all(operations.map((value) => value.closed));
  scope.close();
  tor.abort();
  for (const value of resources) await close(value);
  jest.restoreAllMocks();
});
test('always-cold completed read uses exact retained prefix, four canonical passes and no acquisition writes', async () => {
  const entry = await fixture();
  const { value } = await operation(entry);
  expect(wires).toEqual([]);
  const prepared = await value.prepare();
  expect(prepared.plan).toEqual(entry.checkpoint);
  const seen = [];
  await value.visitSource((log) => seen.push(log));
  const finished = await value.finish();
  expect(finished.plan).toEqual(entry.checkpoint);
  await close(value);
  expect(() => entry.source.assertSource(finished.plan, finished.evidence)).not.toThrow();
  expect(entry.seen).toEqual(entry.normalized);
  expect(seen).toEqual(entry.normalized);
  expect(entry.ledger.visitThrough).toHaveBeenCalledTimes(2);
  expect(wires.filter((wire) => wire.method === 'eth_chainId')).toHaveLength(1);
  expect(wires.filter((wire) => wire.method === 'eth_getLogs')).toHaveLength(1);
  for (const tag of ['finalized', '0x0', '0xa', '0x64'])
    expect(
      wires.filter((wire) => wire.method === 'eth_getBlockByNumber' && wire.params[0] === tag)
    ).toHaveLength(4);
  expect(
    wires.filter(
      (wire) => wire.method === 'eth_getBlockByNumber' && ['0x5', '0x6'].includes(wire.params[0])
    )
  ).toHaveLength(2);
  noWrites(entry);
});
test('absent retained prefix refuses before even chain-ID acquisition and preserves healthy source', async () => {
  const entry = await fixture({ missing: true });
  await expect(
    (async () => {
      const { value } = await operation(entry);
      await value.prepare();
    })()
  ).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(entry.projectRange).not.toHaveBeenCalled();
  expect(entry.source.signal.aborted).toBe(false);
  noWrites(entry);
});
test.each(['provider', 'ledger', 'destination'])(
  '%s mismatch refuses before query without closing the source',
  async (kind) => {
    const entry = await fixture();
    const checkpoint = structuredClone(entry.checkpoint),
      overrides = {};
    if (kind === 'provider') checkpoint.source.providersSha256 = 'e'.repeat(64);
    if (kind === 'ledger') checkpoint.source.ledgerId = 'e'.repeat(64);
    if (kind === 'destination') overrides.destination = {};
    await expect(
      (async () => {
        const { value } = await operation(entry, { checkpoint, ...overrides });
        await value.prepare();
      })()
    ).rejects.toThrow();
    expect(wires).toEqual([]);
    expect(entry.source.signal.aborted).toBe(false);
    await Promise.all(operations.map((value) => value.closed));
    await healthyAgain(entry);
    noWrites(entry);
  }
);
test('checkpoint is detached before awaiting prefix/network work', async () => {
  const entry = await fixture(),
    original = structuredClone(entry.checkpoint);
  const { value } = await operation(entry);
  entry.checkpoint.to.number = 99;
  entry.checkpoint.state.commitments.count = 99;
  const prepared = await value.prepare();
  expect(prepared.plan).toEqual(original);
  await value.finish();
  noWrites(entry);
});
test.each(['healthy', 'header-schema', 'logs-schema', 'event-hash'])(
  'local cancellation cannot suppress late %s response validation',
  async (kind) => {
    const entry = await fixture(),
      { value, caller } = await operation(entry);
    const entered = deferred(),
      gate = deferred();
    wireHook = async (wire) => {
      const target =
        kind === 'logs-schema'
          ? wire.method === 'eth_getLogs'
          : kind === 'event-hash'
            ? wire.method === 'eth_getBlockByNumber' && wire.params[0] === '0x5'
            : wire.method === 'eth_getBlockByNumber' && wire.params[0] === 'finalized';
      if (!target) return response(wire, defaultReply(wire));
      entered.resolve();
      await gate.promise;
      const result =
        kind === 'header-schema'
          ? { ...block(100), number: 'bad' }
          : kind === 'logs-schema'
            ? [{ ...rawLogs()[0], removed: true }]
            : kind === 'event-hash'
              ? { ...block(5), hash: hash(999) }
              : defaultReply(wire);
      return response(wire, result);
    };
    const pending = value.prepare().catch((error) => error);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      caller.abort();
      await flush();
      expect(settled).toBe(false);
      await expect(operation(entry)).rejects.toThrow();
    } finally {
      gate.resolve();
    }
    expect(await pending).toBeInstanceOf(Error);
    await value.closed;
    expect(entry.source.signal.aborted).toBe(kind !== 'healthy');
    noWrites(entry);
    if (kind === 'healthy') {
      wireHook = null;
      await healthyAgain(entry);
    }
  }
);
test('cancellation during a partially admitted canonical batch does not call missing replies corrupt', async () => {
  const entry = await fixture(),
    { value, caller } = await operation(entry);
  wireHook = (wire) => {
    if (wire.method === 'eth_getBlockByNumber') caller.abort();
    return response(wire, defaultReply(wire));
  };
  await expect(value.prepare()).rejects.toThrow();
  await value.closed;
  expect(wires.filter((wire) => wire.method === 'eth_getBlockByNumber')).toHaveLength(1);
  expect(entry.source.signal.aborted).toBe(false);
  wireHook = null;
  await healthyAgain(entry);
});
test.each([false, true])(
  'planner receives the full prefix after cancellation; corrupt suffix=%s',
  async (corrupt) => {
    let caller;
    const seen = [];
    const entry = await fixture({
      corrupt,
      project: async ({ range }, { visit }) => {
        await visit((log) => {
          seen.push(log);
          if (seen.length === 1) caller.abort();
        });
        return emptyPublicState(range.storeId);
      },
    });
    const created = await operation(entry);
    caller = created.caller;
    await expect(created.value.prepare()).rejects.toThrow();
    await created.value.closed;
    expect(seen).toHaveLength(2);
    expect(entry.source.signal.aborted).toBe(corrupt);
    expect(wires.filter((wire) => wire.method === 'eth_getLogs')).toHaveLength(1);
    noWrites(entry);
  }
);
test.each([false, true])(
  'held planner completion retains exclusion and checks projection after cancellation; mismatch=%s',
  async (mismatch) => {
    const entered = deferred(),
      gate = deferred();
    const entry = await fixture({
      project: async ({ range }, { visit }) => {
        await visit(() => {});
        entered.resolve();
        await gate.promise;
        return emptyPublicState(mismatch ? 'b'.repeat(64) : range.storeId);
      },
    });
    const { value, caller } = await operation(entry);
    const pending = value.prepare().catch((error) => error);
    let closed = false;
    value.closed.then(() => {
      closed = true;
    });
    try {
      await entered.promise;
      caller.abort();
      await flush();
      expect(closed).toBe(false);
      await expect(operation(entry)).rejects.toThrow();
    } finally {
      gate.resolve();
    }
    expect(await pending).toBeInstanceOf(Error);
    await value.closed;
    expect(entry.source.signal.aborted).toBe(mismatch);
    noWrites(entry);
  }
);
test('cancelled callback stops delivery but drains its current visitor and authenticates remaining prefix', async () => {
  const entry = await fixture(),
    { value, caller } = await operation(entry);
  await value.prepare();
  const entered = deferred(),
    gate = deferred(),
    seen = [];
  const pending = value
    .visitSource(async (log) => {
      seen.push(log);
      entered.resolve();
      await gate.promise;
    })
    .catch((error) => error);
  let closed = false;
  value.closed.then(() => {
    closed = true;
  });
  try {
    await entered.promise;
    caller.abort();
    await flush();
    expect(closed).toBe(false);
    await expect(operation(entry)).rejects.toThrow();
  } finally {
    gate.resolve();
  }
  expect(await pending).toBeInstanceOf(Error);
  await value.closed;
  expect(seen).toHaveLength(1);
  expect(entry.ledger.visitThrough).toHaveBeenCalledTimes(2);
  expect(entry.source.signal.aborted).toBe(false);
  await healthyAgain(entry);
});
test('unknown callback rejection after cancellation remains fatal even when caught', async () => {
  const entry = await fixture(),
    { value, caller } = await operation(entry);
  await value.prepare();
  await value
    .visitSource(() => {
      caller.abort();
      throw Error('caller secret');
    })
    .catch(() => {});
  await value.closed;
  expect(entry.source.signal.aborted).toBe(true);
  await expect(Promise.resolve().then(() => value.finish())).rejects.toThrow();
});
test('final canonical drift invalidates the entire completed operation', async () => {
  const entry = await fixture(),
    { value } = await operation(entry);
  await value.prepare();
  wireHook = (wire) =>
    response(
      wire,
      wire.method === 'eth_getBlockByNumber' && wire.params[0] === '0xa'
        ? { ...block(10), hash: hash(999) }
        : defaultReply(wire)
    );
  await expect(value.finish()).rejects.toThrow();
  await value.closed;
  expect(entry.source.signal.aborted).toBe(true);
  noWrites(entry);
});

test.each([undefined, null, false, 0, ''])(
  'falsy external visitor throw %# is still fatal',
  async (thrown) => {
    const entry = await fixture(),
      { value } = await operation(entry);
    await value.prepare();
    await expect(
      Promise.resolve().then(() =>
        value.visitSource(() => {
          throw thrown;
        })
      )
    ).rejects.toThrow();
    const outcome = await value.closed;
    expect(outcome.fatal).toBe(true);
    expect(entry.source.signal.aborted).toBe(true);
  }
);
test.each([undefined, null, false, 0, ''])(
  'falsy planner visitor throw %# is still fatal',
  async (thrown) => {
    const entry = await fixture({
      project: async ({ range }, { visit }) => {
        await visit(() => {
          throw thrown;
        });
        return emptyPublicState(range.storeId);
      },
    });
    const { value } = await operation(entry);
    await expect(value.prepare()).rejects.toThrow();
    const outcome = await value.closed;
    expect(outcome.fatal).toBe(true);
    expect(entry.source.signal.aborted).toBe(true);
  }
);
test.each([
  'visit-before-prepare',
  'finish-before-prepare',
  'repeat-prepare',
  'repeat-visit',
  'repeat-finish',
])('fixed phase rejects %s without extending its allowance', async (kind) => {
  const entry = await fixture(),
    { value } = await operation(entry);
  let call;
  if (kind === 'visit-before-prepare') call = () => value.visitSource(() => {});
  if (kind === 'finish-before-prepare') call = () => value.finish();
  if (kind.startsWith('repeat')) {
    await value.prepare();
    if (kind === 'repeat-prepare') call = () => value.prepare();
    if (kind === 'repeat-visit') {
      await value.visitSource(() => {});
      call = () => value.visitSource(() => {});
    }
    if (kind === 'repeat-finish') {
      await value.finish();
      call = () => value.finish();
    }
  }
  const before = wires.length;
  await expect(Promise.resolve().then(call)).rejects.toThrow();
  const outcome = await value.closed;
  expect(outcome.fatal).toBe(false);
  expect(wires).toHaveLength(before);
  expect(entry.source.signal.aborted).toBe(false);
  await healthyAgain(entry);
});
test('nonrenewing deadline after successful preparation refuses final admission without poisoning source', async () => {
  const entry = await fixture();
  const deadline = performance.now() + 120000;
  const { value } = await operation(entry, { deadline });
  await value.prepare();
  const before = wires.length;
  const clock = jest.spyOn(performance, 'now').mockReturnValue(deadline);
  try {
    await expect(Promise.resolve().then(() => value.finish())).rejects.toThrow();
    expect(await value.closed).toMatchObject({ fatal: false, reason: 'expired' });
    expect(wires).toHaveLength(before);
  } finally {
    clock.mockRestore();
  }
  expect(entry.source.signal.aborted).toBe(false);
  await healthyAgain(entry);
});

test.each(['resolve', 'reject'])(
  'planner %s cannot release an unawaited borrowed prefix visit',
  async (mode) => {
    const entered = deferred(),
      gate = deferred(),
      seen = [];
    const entry = await fixture({
      project: async ({ range }, { visit }) => {
        visit(async (log) => {
          seen.push(log);
          entered.resolve();
          await gate.promise;
        }).catch(() => {});
        await entered.promise;
        if (mode === 'reject') throw Error('planner stopped');
        return emptyPublicState(range.storeId);
      },
    });
    const { value, caller } = await operation(entry);
    let closed = false,
      settled = false;
    value.closed.then(() => {
      closed = true;
    });
    const pending = value.prepare().catch((error) => error);
    pending.then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      caller.abort();
      await flush();
      expect(closed).toBe(false);
      expect(settled).toBe(false);
      await expect(operation(entry)).rejects.toThrow();
    } finally {
      gate.resolve();
    }
    expect(await pending).toBeInstanceOf(Error);
    const outcome = await value.closed;
    expect(seen).toHaveLength(2);
    expect(outcome.fatal).toBe(mode === 'reject');
    expect(entry.source.signal.aborted).toBe(mode === 'reject');
    noWrites(entry);
  }
);
test('a leaked planner visitor cannot start a new ledger read after planner settlement', async () => {
  let leaked;
  const entry = await fixture({
    project: async ({ range }, { visit }) => {
      leaked = visit;
      await visit(() => {});
      return emptyPublicState(range.storeId);
    },
  });
  const { value } = await operation(entry);
  await value.prepare();
  const before = entry.ledger.visitThrough.mock.calls.length;
  await expect(Promise.resolve().then(() => leaked(() => {}))).rejects.toThrow();
  expect(entry.ledger.visitThrough).toHaveBeenCalledTimes(before);
  value.close();
  await value.closed;
});

test('event headers at both boundaries share canonical allowances without losing the fourth pass', async () => {
  logNumbers = [0, 10];
  const entry = await fixture({ anchor: 10 });
  const { value } = await operation(entry);
  await value.prepare();
  const visited = [];
  await value.visitSource((log) => visited.push(log));
  const result = await value.finish();
  value.close();
  expect(await value.closed).toMatchObject({ fatal: false, reason: 'completed' });
  expect(() => entry.source.assertSource(result.plan, result.evidence)).not.toThrow();
  expect(visited.map((log) => log.blockNumber)).toEqual([0, 10]);
  const headers = wires.filter((wire) => wire.method === 'eth_getBlockByNumber');
  expect(headers).toHaveLength(4 * 3 + 2);
  expect(headers.filter((wire) => wire.params[0] === 'finalized')).toHaveLength(4);
  expect(headers.filter((wire) => wire.params[0] === '0x0')).toHaveLength(5);
  expect(headers.filter((wire) => wire.params[0] === '0xa')).toHaveLength(5);
  expect(wires.filter((wire) => wire.method === 'eth_chainId')).toHaveLength(1);
  expect(wires.filter((wire) => wire.method === 'eth_getLogs')).toHaveLength(1);
  noWrites(entry);
});
