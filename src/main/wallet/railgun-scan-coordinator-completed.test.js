let mockEndpoint, mockUrl, mockJournals;
const mockTransport = jest.fn();
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => [mockUrl],
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: mockUrl } }],
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: (...args) => mockTransport(...args), release() {} }),
}));
jest.mock('./railgun-scan-journal', () => {
  const actual = jest.requireActual('./railgun-scan-journal');
  return {
    ...actual,
    createRailgunScanJournal: async (options) => {
      const journal = await actual.createRailgunScanJournal(options),
        wrapper = { ...journal };
      for (const key of ['readState', 'revalidate', 'prepare', 'complete', 'withSourceRetention'])
        wrapper[key] = jest.fn((...args) => journal[key](...args));
      mockJournals.push(wrapper);
      return wrapper;
    },
  };
});
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { createRailgunSourceLedger } = require('./railgun-source-ledger');
const {
  createRailgunScanSource,
  getRailgunScanSourceDestination,
  PROXY,
} = require('./railgun-scan-source');
const { createRailgunScanCoordinator } = require('./railgun-scan-coordinator');
const { emptyPublicState } = require('./railgun-public-records');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const b64 = (value) => Buffer.from(value).toString('base64');
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const subject = {
  kind: 'private-account',
  principal: 'fixture',
  protocol: 'railgun',
  chainId: 11155111,
  deployment: 'sepolia-fixture',
};
const next = (to) => ({ to, anchor: { number: 100, hash: hash(101) } });
const readWire = (id, method = 'get', args = { key: b64('fixture') }) =>
  JSON.stringify({ id, method, args });
let scope, directory, tor, entries, wires, responseHook, logs;
const log = (n) => ({
  address: PROXY,
  blockNumber: '0x' + n.toString(16),
  blockHash: hash(n + 1),
  transactionHash: hash(n + 40),
  transactionIndex: '0x0',
  logIndex: '0x0',
  removed: false,
  topics: [hash(22)],
  data: '0x0102',
});
const reply = (wire, result) => ({
  status: 200,
  body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
});
function defaultResult(wire) {
  if (wire.method === 'eth_chainId') return '0xaa36a7';
  if (wire.method === 'eth_getLogs') {
    const from = Number(BigInt(wire.params[0].fromBlock)),
      to = Number(BigInt(wire.params[0].toBlock));
    return logs.filter(
      (value) =>
        Number(BigInt(value.blockNumber)) >= from && Number(BigInt(value.blockNumber)) <= to
    );
  }
  const number = wire.params[0] === 'finalized' ? 100 : Number(BigInt(wire.params[0]));
  return { number: '0x' + number.toString(16), hash: hash(number + 1), parentHash: hash(number) };
}
async function open(create, apply = async () => {}, principal = subject.principal) {
  const account = { ...subject, principal };
  const handle = scope.getContext({ ...account, role: 'engine' }),
    rpcHandle = scope.getContext({ ...account, role: 'protocol-rpc' });
  const actualLedger = await createRailgunSourceLedger({
    handle: rpcHandle,
    filename: path.join(directory, 'source.sqlite'),
    key: Buffer.alloc(32, 84),
    binding: 'd'.repeat(64),
    create,
  });
  const ledger = { ...actualLedger };
  for (const key of ['stage', 'retain', 'visit', 'visitThrough', 'hasPrefix'])
    ledger[key] = jest.fn((...args) => actualLedger[key](...args));
  const projectRange = jest.fn(async ({ range }, { visit }) => {
    await visit(() => {});
    return emptyPublicState(range.storeId);
  });
  const beforeAcquire = jest.fn();
  const source = createRailgunScanSource({
    handle: rpcHandle,
    ledger,
    projectRange,
    beforeAcquire,
  });
  const sourceBoundary = { ...source };
  for (const key of ['acquire', 'refresh', 'retain'])
    sourceBoundary[key] = jest.fn((...args) => source[key](...args));
  const realSession = startRailgunSessionWorker({
    handle,
    storage: {
      format: 'paged-v2',
      filename: path.join(directory, 'engine.sqlite'),
      key: Buffer.alloc(32, 85),
      binding: 'e'.repeat(64),
      create,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw Error('No engine RPC');
      },
    }),
    onClose: () => {},
  });
  const entry = {
    ledger,
    actualLedger,
    source,
    sourceBoundary,
    realSession,
    rpcHandle,
    projectRange,
    beforeAcquire,
    apply: jest.fn(apply),
    brokerHook: null,
  };
  entries.push(entry);
  await realSession.ready;
  const storeSession = {
    ...realSession,
    claimDispatch: () => {
      const grant = realSession.claimDispatch();
      return {
        dispatch: async (wire) => {
          const result = await grant.dispatch(wire);
          return entry.brokerHook ? entry.brokerHook(wire, result) : result;
        },
      };
    },
  };
  entry.coordinator = await createRailgunScanCoordinator({
    handle,
    storeSession,
    source: sourceBoundary,
    journalStorage: { directory, key: Buffer.alloc(32, 86), binding: 'f'.repeat(64) },
    applyRange: entry.apply,
  });
  entry.journal = mockJournals.at(-1);
  return entry;
}
async function close(entry) {
  entry.coordinator?.close();
  entry.source.close();
  entry.actualLedger.close();
  entry.realSession.close();
  await Promise.all([entry.actualLedger.closed, entry.realSession.closed]);
}
function resetCounters(entry) {
  wires.length = 0;
  for (const object of [entry.ledger, entry.sourceBoundary, entry.journal])
    for (const value of Object.values(object)) if (jest.isMockFunction(value)) value.mockClear();
  entry.projectRange.mockClear();
  entry.beforeAcquire.mockClear();
  entry.apply.mockClear();
}
function snapshot(entry, run = async () => 'read', options = {}) {
  return entry.coordinator.withCompletedPublicSnapshot(
    {
      destination: getRailgunScanSourceDestination(entry.source, entry.rpcHandle),
      signal: new AbortController().signal,
      ...options,
    },
    run
  );
}
function noRepair(entry) {
  for (const method of ['acquire', 'refresh', 'retain'])
    expect(entry.sourceBoundary[method]).not.toHaveBeenCalled();
  for (const method of ['stage', 'retain', 'visit'])
    expect(entry.ledger[method]).not.toHaveBeenCalled();
  for (const method of ['prepare', 'complete', 'withSourceRetention'])
    expect(entry.journal[method]).not.toHaveBeenCalled();
  expect(entry.beforeAcquire).not.toHaveBeenCalled();
  expect(entry.apply).not.toHaveBeenCalled();
  for (const [options] of entry.journal.revalidate.mock.calls)
    expect(Object.hasOwn(options, 'plan')).toBe(false);
}
beforeEach(() => {
  mockTransport.mockReset();
  mockJournals = [];
  entries = [];
  wires = [];
  responseHook = null;
  logs = [log(5), log(6)];
  mockUrl = 'https://rpc.example/completed-coordinator';
  tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({
    profileId: 'completed-coordinator-fixture',
    signal: new AbortController().signal,
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-completed-coordinator-'));
  mockTransport.mockImplementation(async (_handle, url, options) => {
    expect(url).toBe(mockUrl);
    const wire = JSON.parse(options.body);
    wires.push(wire);
    return responseHook ? responseHook(wire) : reply(wire, defaultResult(wire));
  });
});
afterEach(async () => {
  scope.close();
  tor.abort();
  for (const entry of entries) await close(entry);
  jest.restoreAllMocks();
});
test.each([false, true])(
  'completed-only snapshot cold reopen=%s reads exact checkpoint without recovery or metadata replacement',
  async (cold) => {
    let entry = await open(true);
    await entry.coordinator.advance(next(10));
    if (cold) {
      await close(entry);
      entry = await open(false);
    }
    resetCounters(entry);
    let leaked, signal;
    const result = await snapshot(entry, async (window) => {
      leaked = window.dispatch;
      signal = window.signal;
      expect(window.checkpoint.to.number).toBe(10);
      expect(Object.isFrozen(window.checkpoint.source)).toBe(true);
      const response = JSON.parse(await window.dispatch(readWire(1)));
      expect(response).toEqual({ id: 1, value: null });
      const seen = [];
      await window.visitSource((value) => seen.push(value));
      expect(seen).toHaveLength(2);
      return 'observed';
    });
    expect(result.value).toBe('observed');
    expect(signal.aborted).toBe(true);
    expect(entry.coordinator.assertSnapshot(result.evidence).to.number).toBe(10);
    expect(() => entry.coordinator.assertSnapshot({ ...result.evidence })).toThrow();
    expect(entry.journal.readState).toHaveBeenCalled();
    expect(entry.projectRange).toHaveBeenCalledTimes(1);
    expect(wires.filter((wire) => wire.method === 'eth_getLogs')).toHaveLength(1);
    expect(wires.filter((wire) => wire.method === 'eth_chainId')).toHaveLength(cold ? 1 : 0);
    noRepair(entry);
    await expect(leaked(readWire(2))).rejects.toThrow();
  }
);
test('empty journal refuses before any source query, planner, callback or mutation', async () => {
  const entry = await open(true),
    run = jest.fn();
  resetCounters(entry);
  await expect(snapshot(entry, run)).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect(entry.projectRange).not.toHaveBeenCalled();
  expect(entry.coordinator.signal.aborted).toBe(false);
  noRepair(entry);
  await entry.coordinator.advance(next(10));
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
});
test('completed checkpoint plus pending journal refuses without replay even on a cold owner', async () => {
  let entry = await open(true, async ({ plan }) => {
    if (plan.from > 0) throw Error('interrupted apply');
  });
  await entry.coordinator.advance(next(10));
  await expect(entry.coordinator.advance(next(20))).rejects.toThrow();
  await close(entry);
  entry = await open(false);
  resetCounters(entry);
  const run = jest.fn();
  await expect(snapshot(entry, run)).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect(entry.projectRange).not.toHaveBeenCalled();
  expect(entry.coordinator.signal.aborted).toBe(false);
  noRepair(entry);
  const state = await entry.journal.readState();
  expect(state.checkpoint.to.number).toBe(10);
  expect(state.pending.to.number).toBe(20);
});
test('provider-host mismatch on reopen refuses before chain-ID and leaves journal provenance unchanged', async () => {
  let entry = await open(true);
  await entry.coordinator.advance(next(10));
  const before = await entry.journal.readState();
  await close(entry);
  mockUrl = 'https://different.example/completed-coordinator';
  entry = await open(false);
  resetCounters(entry);
  await expect(snapshot(entry)).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(entry.coordinator.signal.aborted).toBe(false);
  noRepair(entry);
  expect((await entry.journal.readState()).checkpoint).toEqual(before.checkpoint);
});
test('completed snapshot preserves a retained orphan tail rather than trimming it', async () => {
  let entry = await open(true);
  await entry.coordinator.advance(next(10));
  const identity = await entry.realSession.inspectStoreIdentity();
  const orphan = await entry.source.acquire({
    from: 11,
    to: 15,
    previousHash: hash(11),
    anchor: next(0).anchor,
    storeId: identity.instanceId,
  });
  await close(entry);
  entry = await open(false);
  resetCounters(entry);
  const result = await snapshot(entry);
  expect(entry.coordinator.assertSnapshot(result.evidence).to.number).toBe(10);
  expect(await entry.actualLedger.hasPrefix(orphan.plan.source.ledgerSha256)).toBe(true);
  noRepair(entry);
});
test.each([
  { destination: {} },
  { signal: null },
  { timeoutMs: 0 },
  { timeoutMs: 180001 },
  { timeoutMs: Infinity },
  { extra: true },
])(
  'invalid admission %# leaves the healthy coordinator unchanged and query-free',
  async (options) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    resetCounters(entry);
    await expect(snapshot(entry, async () => {}, options)).rejects.toThrow();
    expect(wires).toEqual([]);
    expect(entry.coordinator.signal.aborted).toBe(false);
    await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
  }
);
test('ignored callback cancellation retains exclusion until callback settles and supports later healthy reuse', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const entered = deferred(),
    gate = deferred(),
    caller = new AbortController();
  let dispatch,
    settled = false;
  const pending = snapshot(
    entry,
    async (window) => {
      dispatch = window.dispatch;
      entered.resolve();
      await gate.promise;
      return 'late';
    },
    { signal: caller.signal }
  ).catch((error) => error);
  pending.then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    caller.abort();
    await flush();
    expect(settled).toBe(false);
    await expect(snapshot(entry)).rejects.toThrow();
    await expect(dispatch(readWire(1))).rejects.toThrow();
  } finally {
    gate.resolve();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(entry.coordinator.signal.aborted).toBe(false);
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
  noRepair(entry);
});
test('borrowed dispatch drains after callback returns and cancellation cannot release its owner early', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const entered = deferred(),
    gate = deferred(),
    caller = new AbortController();
  entry.brokerHook = async (wire, result) => {
    if (JSON.parse(wire).method === 'get') {
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const pending = snapshot(
    entry,
    ({ dispatch }) => {
      dispatch(readWire(1)).catch(() => {});
      return 'early';
    },
    { signal: caller.signal }
  ).catch((error) => error);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    caller.abort();
    await flush();
    expect(settled).toBe(false);
    await expect(snapshot(entry)).rejects.toThrow();
  } finally {
    gate.resolve();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(entry.coordinator.signal.aborted).toBe(false);
  entry.brokerHook = null;
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
});
test('source visitor cancellation suppresses later delivery but holds coordinator through drain', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const entered = deferred(),
    gate = deferred(),
    caller = new AbortController(),
    seen = [];
  const pending = snapshot(
    entry,
    ({ visitSource }) =>
      visitSource(async (value) => {
        seen.push(value);
        entered.resolve();
        await gate.promise;
      }),
    { signal: caller.signal }
  ).catch((error) => error);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  try {
    await entered.promise;
    caller.abort();
    await flush();
    expect(settled).toBe(false);
    await expect(snapshot(entry)).rejects.toThrow();
  } finally {
    gate.resolve();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(seen).toHaveLength(1);
  expect(entry.coordinator.signal.aborted).toBe(false);
  await snapshot(entry);
});
test.each(['batch', 'txBegin', 'txStage', 'txCommit', 'txAbort', 'clear', 'rpc'])(
  'caught forbidden broker %s remains fatal and cannot be rescued by a valid read',
  async (method) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    resetCounters(entry);
    await expect(
      snapshot(entry, async ({ dispatch }) => {
        await dispatch(readWire(1, method, {})).catch(() => {});
        await dispatch(readWire(2)).catch(() => {});
        return 'caught';
      })
    ).rejects.toThrow();
    expect(entry.coordinator.signal.aborted).toBe(true);
    noRepair(entry);
  }
);
test.each([false, true])(
  'unknown callback throw remains fatal; local cancellation=%s',
  async (cancel) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    const caller = new AbortController();
    await expect(
      snapshot(
        entry,
        () => {
          if (cancel) caller.abort();
          throw Error('not an authenticated cancellation');
        },
        { signal: caller.signal }
      )
    ).rejects.toThrow();
    expect(entry.coordinator.signal.aborted).toBe(true);
  }
);
test('final canonical drift after callback refuses and revokes older snapshot evidence', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const previous = await snapshot(entry);
  await expect(
    snapshot(entry, () => {
      responseHook = (wire) =>
        reply(
          wire,
          wire.method === 'eth_getBlockByNumber' && wire.params[0] === '0xa'
            ? { ...defaultResult(wire), hash: hash(999) }
            : defaultResult(wire)
        );
    })
  ).rejects.toThrow();
  expect(entry.coordinator.signal.aborted).toBe(true);
  expect(() => entry.coordinator.assertSnapshot(previous.evidence)).toThrow();
});
test('late callback throw after cancellation wins over benign cancellation while draining', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const entered = deferred(),
    gate = deferred(),
    caller = new AbortController();
  const pending = snapshot(
    entry,
    async () => {
      entered.resolve();
      await gate.promise;
      throw Error('late callback failure');
    },
    { signal: caller.signal }
  ).catch((error) => error);
  try {
    await entered.promise;
    caller.abort();
    await flush();
    expect(entry.coordinator.signal.aborted).toBe(false);
  } finally {
    gate.resolve();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(entry.coordinator.signal.aborted).toBe(true);
});

test.each([undefined, null, false, 0, ''])(
  'falsy callback throw %# is fatal even when locally cancelled',
  async (thrown) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    const caller = new AbortController();
    await expect(
      snapshot(
        entry,
        () => {
          caller.abort();
          throw thrown;
        },
        { signal: caller.signal }
      )
    ).rejects.toThrow();
    expect(entry.coordinator.signal.aborted).toBe(true);
  }
);
test('already aborted caller refuses before source work without revoking a healthy owner', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const caller = new AbortController();
  caller.abort();
  await expect(snapshot(entry, async () => {}, { signal: caller.signal })).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(entry.coordinator.signal.aborted).toBe(false);
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
});
test('another genuine client at the same URL cannot substitute its destination observation', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const { createPrivateRpc, getPrivateRpcDestination } = require('../networks/private-rpc');
  const other = createPrivateRpc(entry.rpcHandle, 'protocol-rpc');
  await expect(
    snapshot(entry, async () => {}, {
      destination: getPrivateRpcDestination(other, entry.rpcHandle),
    })
  ).rejects.toThrow();
  expect(wires).toEqual([]);
  expect(entry.coordinator.signal.aborted).toBe(false);
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
});
test('snapshot deadline does not renew after callback and prevents the final header pass', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  resetCounters(entry);
  const start = performance.now();
  let clock, before;
  try {
    await expect(
      snapshot(
        entry,
        () => {
          before = wires.length;
          clock = jest.spyOn(performance, 'now').mockReturnValue(start + 120001);
          return 'late';
        },
        { timeoutMs: 120000 }
      )
    ).rejects.toThrow();
    expect(wires).toHaveLength(before);
    expect(entry.coordinator.signal.aborted).toBe(false);
  } finally {
    clock?.mockRestore();
  }
  await expect(snapshot(entry)).resolves.toMatchObject({ value: 'read' });
});

function authenticatedOutcome(entry, error) {
  const { getRailgunCompletedSnapshotOutcome } = require('./railgun-scan-coordinator');
  const outcome = getRailgunCompletedSnapshotOutcome(entry.coordinator, error);
  expect(Object.keys(outcome).sort()).toEqual(['fatal', 'reason', 'rpcFailure']);
  expect(Object.isFrozen(outcome)).toBe(true);
  expect(typeof outcome.fatal).toBe('boolean');
  expect(typeof outcome.reason).toBe('string');
  expect(outcome.reason.length).toBeGreaterThan(0);
  expect([null, 'response', 'transport', 'revoked']).toContain(outcome.rpcFailure);
  expect(JSON.stringify(outcome)).not.toMatch(/rpc\.example|fixture|11155111|callback-secret/);
  return outcome;
}
test.each(['empty', 'invalid-options', 'preaborted', 'destination'])(
  'authenticated outcome describes benign %s refusal and preserves healthy owner',
  async (kind) => {
    const entry = await open(true);
    if (kind !== 'empty') await entry.coordinator.advance(next(10));
    resetCounters(entry);
    let options = {};
    if (kind === 'invalid-options') options = { timeoutMs: -1 };
    if (kind === 'preaborted') {
      const caller = new AbortController();
      caller.abort();
      options = { signal: caller.signal };
    }
    if (kind === 'destination') options = { destination: {} };
    const error = await snapshot(entry, async () => {}, options).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(authenticatedOutcome(entry, error)).toMatchObject({ fatal: false, rpcFailure: null });
    expect(entry.coordinator.signal.aborted).toBe(false);
    expect(wires).toEqual([]);
  }
);
test('outcome requires the exact final thrown error and its exact genuine coordinator', async () => {
  const entry = await open(true);
  const error = await snapshot(entry).catch((error) => error);
  const expected = authenticatedOutcome(entry, error);
  const { getRailgunCompletedSnapshotOutcome } = require('./railgun-scan-coordinator');
  const copied = Object.assign(new Error(error.message), error, { outcome: expected });
  for (const candidate of [
    undefined,
    null,
    {},
    { ...error },
    copied,
    Object.create(error),
    expected,
  ])
    expect(() => getRailgunCompletedSnapshotOutcome(entry.coordinator, candidate)).toThrow();
  for (const coordinator of [{}, { ...entry.coordinator }, Object.create(entry.coordinator)])
    expect(() => getRailgunCompletedSnapshotOutcome(coordinator, error)).toThrow();
  expect(entry.coordinator.signal.aborted).toBe(false);
  await close(entry);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-completed-other-coordinator-'));
  const other = await open(true, undefined, 'other');
  expect(() => getRailgunCompletedSnapshotOutcome(other.coordinator, error)).toThrow();
  expect(authenticatedOutcome(entry, error)).toEqual(expected);
  expect(entry.coordinator.signal.aborted).toBe(true);
  expect(other.coordinator.signal.aborted).toBe(false);
});
test('caller Error with copied public code and outcome is never accepted as authenticated provenance', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const callerError = Object.assign(Error('callback-secret'), {
    code: 'RAILGUN_SCAN_COORDINATOR_REFUSED',
    outcome: { fatal: false, reason: 'cancelled', rpcFailure: null },
  });
  const error = await snapshot(entry, () => {
    throw callerError;
  }).catch((error) => error);
  expect(error).not.toBe(callerError);
  expect(authenticatedOutcome(entry, error)).toMatchObject({ fatal: true, rpcFailure: null });
  expect(entry.coordinator.signal.aborted).toBe(true);
  const { getRailgunCompletedSnapshotOutcome } = require('./railgun-scan-coordinator');
  expect(() => getRailgunCompletedSnapshotOutcome(entry.coordinator, callerError)).toThrow();
});
test('already-closed owner produces authenticated fatal outcome without transport work', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const destination = getRailgunScanSourceDestination(entry.source, entry.rpcHandle);
  await close(entry);
  wires.length = 0;
  const error = await entry.coordinator
    .withCompletedPublicSnapshot(
      { destination, signal: new AbortController().signal },
      async () => {}
    )
    .catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(authenticatedOutcome(entry, error).fatal).toBe(true);
  expect(wires).toEqual([]);
});
test('busy refusal gets its own benign outcome without damaging the active operation', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const entered = deferred(),
    gate = deferred();
  const first = snapshot(entry, async () => {
    entered.resolve();
    await gate.promise;
    return 'owner';
  });
  try {
    await entered.promise;
    const error = await snapshot(entry).catch((error) => error);
    expect(authenticatedOutcome(entry, error)).toMatchObject({ fatal: false, rpcFailure: null });
    expect(entry.coordinator.signal.aborted).toBe(false);
  } finally {
    gate.resolve();
  }
  const result = await first;
  expect(result.value).toBe('owner');
  expect(entry.coordinator.assertSnapshot(result.evidence).to.number).toBe(10);
});
test.each(['valid', 'response', 'transport'])(
  'outcome waits for drain and upgrades cancelled pending RPC when late result is %s',
  async (kind) => {
    const entry = await open(true);
    await entry.coordinator.advance(next(10));
    resetCounters(entry);
    const entered = deferred(),
      gate = deferred(),
      caller = new AbortController();
    responseHook = async (wire) => {
      if (wire.method === 'eth_getBlockByNumber' && wire.params[0] === 'finalized') {
        entered.resolve();
        await gate.promise;
        if (kind === 'transport') throw Error('callback-secret');
        if (kind === 'response') return reply(wire, { ...defaultResult(wire), number: 'bad' });
      }
      return reply(wire, defaultResult(wire));
    };
    const pending = snapshot(entry, async () => {}, { signal: caller.signal }).catch(
      (error) => error
    );
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      caller.abort();
      await flush();
      expect(settled).toBe(false);
    } finally {
      gate.resolve();
    }
    const error = await pending;
    expect(authenticatedOutcome(entry, error)).toMatchObject({
      fatal: kind !== 'valid',
      rpcFailure: kind === 'valid' ? null : kind,
    });
    expect(entry.coordinator.signal.aborted).toBe(kind !== 'valid');
  }
);
test('borrowed internal broker error has no published outcome before final callback drain', async () => {
  const entry = await open(true);
  await entry.coordinator.advance(next(10));
  const { getRailgunCompletedSnapshotOutcome } = require('./railgun-scan-coordinator');
  const entered = deferred(),
    gate = deferred();
  let borrowed;
  const pending = snapshot(entry, async ({ dispatch }) => {
    borrowed = await dispatch(readWire(1, 'batch', {})).catch((error) => error);
    entered.resolve();
    await gate.promise;
  }).catch((error) => error);
  try {
    await entered.promise;
    expect(() => getRailgunCompletedSnapshotOutcome(entry.coordinator, borrowed)).toThrow();
  } finally {
    gate.resolve();
  }
  const error = await pending;
  expect(authenticatedOutcome(entry, error)).toMatchObject({ fatal: true, rpcFailure: null });
});
