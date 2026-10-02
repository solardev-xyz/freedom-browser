const fs = require('fs');
const os = require('os');
const path = require('path');
let mockWrapStorage;
jest.mock('./privacy-storage', () => {
  const actual = jest.requireActual('./privacy-storage');
  return {
    ...actual,
    createPrivacyStorage: (...args) => {
      const storage = actual.createPrivacyStorage(...args);
      return mockWrapStorage ? mockWrapStorage(storage) : storage;
    },
  };
});
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { emptyPublicState } = require('./railgun-public-records');
const { createRailgunScanJournal, RECORD_KEY } = require('./railgun-scan-journal');
let scope, options, journals;
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const digest = 'b'.repeat(64),
  storeId = 'c'.repeat(64);
function range(from = 0, to = 10, count = 1) {
  return {
    from,
    previousHash: from ? hash(from - 1) : hash(0),
    to: { number: to, hash: hash(to) },
    anchor: { number: 100, hash: hash(100) },
    logs: { count, sha256: digest },
    source: {
      level: 'unverified-rpc',
      providersSha256: digest,
      ledgerId: digest,
      ledgerSha256: digest,
    },
    state: {
      schema: 'public-records-v1',
      storeId,
      trees: [{ tree: 0, length: count, root: hash(count) }],
      commitments: { count, sha256: digest },
      nullifiers: { count, sha256: digest },
      unshields: { count, sha256: digest },
    },
  };
}
const source = { issuedByHost: true };
let observation;
async function open(overrides = {}) {
  const journal = await createRailgunScanJournal({ ...options, ...overrides });
  journals.push(journal);
  const value = await journal.readState();
  if (!value.checkpoint && !value.pending)
    await journal.revalidate({
      state: overrides.storeSession?.inspectPublicState
        ? await overrides.storeSession.inspectPublicState()
        : emptyPublicState(value.storeId),
    });
  return journal;
}
beforeEach(() => {
  journals = [];
  observation = range().state;
  mockWrapStorage = undefined;
  scope = createPrivacyScope({
    profileId: 'scan-journal-test',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'public-fixture',
    chainId: 11155111,
    role: 'storage',
    operation: 'railgun-scan-v1',
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-scan-journal-'));
  const storage = createPrivacyStorage({ handle, directory, key: Buffer.alloc(32, 47) });
  options = {
    handle,
    storage, // Independent test-only view of the same encrypted file.
    directory,
    key: Buffer.alloc(32, 47),
    filename: getPrivacyStoragePath(handle, directory),
    binding: 'a'.repeat(64),
    ledgerId: digest,
    storeId,
    storeSession: {
      signal: scope.signal,
      inspectStoreIdentity: async () => ({ format: 'paged-v2', instanceId: storeId }),
      assertFresh: () => {},
    },
    assertSource: jest.fn((_plan, value) => {
      if (value !== source) throw new Error('Stale source');
    }),
  };
});
afterEach(() => {
  for (const journal of journals) journal.close();
  scope.close();
});
test('persists exact pending work before returning authority to apply it, then checkpoints only checked state', async () => {
  const journal = await open(),
    input = range();
  const token = await journal.prepare(input, source);
  input.to.number = 99;
  expect((await journal.readState()).pending.to.number).toBe(10);
  expect(JSON.parse(await options.storage.get(RECORD_KEY)).pending.to.number).toBe(10);
  expect(fs.readFileSync(options.filename).includes(Buffer.from('public-records-v1'))).toBe(false);
  await expect(journal.revalidate({ source, state: observation })).rejects.toThrow();
  await journal.complete(token, { source, state: observation });
  const state = await journal.readState();
  expect(state.pending).toBeNull();
  expect(state.checkpoint.to.number).toBe(10);
  expect((await journal.revalidate({ source, state: observation })).status).toBe(
    'applied-unverified'
  );
  expect(state.checkpoint.state).toEqual(observation);
});
test('a reopened pending range needs source revalidation and a new opaque work token', async () => {
  const first = await open(),
    token = await first.prepare(range(), source);
  const generation = (await first.readState()).generation;
  first.close();
  const restored = await open();
  expect((await restored.readState()).generation).toBe(generation + 1);
  await expect(restored.complete(token, { source, state: observation })).rejects.toThrow();
  const renewed = await restored.prepare(range(), source);
  await restored.complete(renewed, { source, state: observation });
});
test('a checkpoint on disk never bypasses fresh source and database checks on reopen', async () => {
  const first = await open(),
    token = await first.prepare(range(), source);
  await first.complete(token, { source, state: observation });
  first.close();
  const restored = await open();
  await expect(restored.revalidate({ source, state: {} })).rejects.toThrow();
  await expect(restored.revalidate({ source: {}, state: observation })).rejects.toThrow(
    'Stale source'
  );
  await expect(restored.revalidate({ source, state: observation })).resolves.toMatchObject({
    status: 'applied-unverified',
  });
});
test.each(['binding', 'storeId'])(
  'refuses changed %s without replacing stored progress',
  async (field) => {
    const journal = await open();
    await journal.prepare(range(), source);
    journal.close();
    const before = await options.storage.get(RECORD_KEY);
    await expect(
      open(
        field === 'storeId'
          ? {
              storeSession: {
                ...options.storeSession,
                inspectStoreIdentity: async () => ({
                  format: 'paged-v2',
                  instanceId: 'e'.repeat(64),
                }),
              },
            }
          : { binding: 'e'.repeat(64) }
      )
    ).rejects.toThrow();
    expect(await options.storage.get(RECORD_KEY)).toBe(before);
  }
);
test.each(['gap', 'parent', 'anchor', 'regression', 'different-pending'])(
  'refuses incompatible replay plan %s',
  async (mode) => {
    const journal = await open();
    const token = await journal.prepare(range(), source);
    if (mode !== 'different-pending') await journal.complete(token, { source, state: observation });
    const next = mode === 'different-pending' ? range() : range(11, 20, 2);
    if (mode === 'gap') next.from = 12;
    if (mode === 'parent') next.previousHash = hash(999);
    if (mode === 'anchor') next.anchor.hash = hash(999);
    if (mode === 'regression') {
      next.state.commitments.count = 0;
      next.state.trees[0].length = 0;
    }
    if (mode === 'different-pending') next.logs.sha256 = 'd'.repeat(64);
    await expect(journal.prepare(next, source)).rejects.toThrow();
  }
);
test('accepts only one live owner per storage filename and refuses cloned work tokens', async () => {
  const journal = await open();
  await expect(open()).rejects.toMatchObject({ code: 'RAILGUN_SCAN_BUSY' });
  const token = await journal.prepare(range(), source);
  await expect(journal.complete({ ...token }, { source, state: observation })).rejects.toThrow();
  journal.close();
  await expect(open()).resolves.toBeDefined();
});
test('unknown schema and oversized persisted data are refused without reset', async () => {
  const journal = await open();
  journal.close();
  const record = JSON.parse(await options.storage.get(RECORD_KEY));
  await options.storage.set(RECORD_KEY, JSON.stringify({ ...record, version: 99 }));
  await expect(open()).rejects.toThrow();
  await options.storage.set(RECORD_KEY, ' '.repeat(128 * 1024 + 1));
  await expect(open()).rejects.toThrow();
});
test('source assertion must be synchronous and lock revokes pending work', async () => {
  const invalid = await open({ assertSource: async () => {} });
  await expect(invalid.prepare(range(), source)).rejects.toThrow();
  const journal = await open(),
    token = await journal.prepare(range(), source);
  scope.close();
  await expect(journal.complete(token, { source, state: observation })).rejects.toThrow();
  await expect(journal.readState()).rejects.toThrow();
});
test.each([false, true])(
  'failed persistence with committed=%s requires reopening the retained state',
  async (committed) => {
    const journal = await open();
    journal.close();
    let failNext = false;
    const storage = {
      ...options.storage,
      update: async (key, change) => {
        if (!failNext) return options.storage.update(key, change);
        if (committed) await options.storage.update(key, change);
        throw Object.assign(new Error('Disk failure'), { storageCommitted: committed });
      },
    };
    mockWrapStorage = () => storage;
    const active = await open();
    mockWrapStorage = undefined;
    failNext = true;
    await expect(active.prepare(range(), source)).rejects.toThrow('Disk failure');
    await expect(active.readState()).rejects.toThrow();
    const restored = await open();
    expect((await restored.readState()).pending !== null).toBe(committed);
    const token = await restored.prepare(range(), source);
    await restored.complete(token, { source, state: observation });
  }
);
test('lease/sequence compare-and-set refuses externally changed progress', async () => {
  const journal = await open();
  await options.storage.update(RECORD_KEY, (text) =>
    JSON.stringify({ ...JSON.parse(text), sequence: 100 })
  );
  await expect(journal.prepare(range(), source)).rejects.toThrow();
});
test('concurrent requests cannot both return valid work tokens', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let delay = false;
  const storage = {
    ...options.storage,
    update: async (key, change) => {
      if (delay) await gate;
      return options.storage.update(key, change);
    },
  };
  mockWrapStorage = () => storage;
  const journal = await open();
  mockWrapStorage = undefined;
  delay = true;
  const first = journal.prepare(range(), source);
  await expect(journal.prepare(range(), source)).rejects.toMatchObject({
    code: 'RAILGUN_SCAN_BUSY',
  });
  release();
  await expect(first).resolves.toBeDefined();
});
test.each(['root-without-growth', 'finished-tree-growth'])(
  'refuses rewriting a retained tree: %s',
  async (mode) => {
    const journal = await open(),
      first = range();
    if (mode === 'finished-tree-growth') {
      first.state.trees.push({ tree: 1, length: 1, root: hash(1) });
      first.state.commitments.count = 2;
    }
    const token = await journal.prepare(first, source);
    await journal.complete(token, { source, state: first.state });
    const next = range(11, 20);
    next.state = JSON.parse(JSON.stringify(first.state));
    if (mode === 'root-without-growth') next.state.trees[0].root = hash(999);
    else {
      next.state.trees[0].length++;
      next.state.commitments.count++;
    }
    await expect(journal.prepare(next, source)).rejects.toThrow();
  }
);
test('a directory alias cannot open a second owner for the same scoped file', async () => {
  await open();
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-alias-')), 'alias');
  fs.symlinkSync(options.directory, alias);
  await expect(open({ directory: alias })).rejects.toMatchObject({ code: 'RAILGUN_SCAN_BUSY' });
});
test('a post-commit freshness failure is explicitly committed and closes the journal', async () => {
  let stale = false,
    trigger = false;
  mockWrapStorage = (storage) => ({
    ...storage,
    update: async (key, change) => {
      await storage.update(key, change);
      if (trigger) stale = true;
    },
  });
  const journal = await open({
    storeSession: {
      ...options.storeSession,
      assertFresh: () => {
        if (stale) throw new Error('Stale');
      },
    },
  });
  mockWrapStorage = undefined;
  const token = await journal.prepare(range(), source);
  trigger = true;
  await expect(journal.complete(token, { source, state: observation })).rejects.toMatchObject({
    code: 'RAILGUN_SCAN_STATE_CHANGED_AFTER_COMMIT',
    storageCommitted: true,
  });
  await expect(journal.readState()).rejects.toThrow();
  expect((await (await open()).readState()).checkpoint.to.number).toBe(10);
});
test.each(['completed-write', 'pending-write'])(
  'real worker freshness refuses checkpoint after %s',
  async (mode) => {
    const { startRailgunSessionWorker } = require('./railgun-session-worker');
    const engineHandle = scope.getContext({
      kind: 'private-account',
      principal: 'fixture',
      protocol: 'railgun',
      deployment: 'public-fixture',
      chainId: 11155111,
      role: 'engine',
    });
    const worker = startRailgunSessionWorker({
      handle: engineHandle,
      storage: {
        filename: path.join(options.directory, 'engine.sqlite'),
        format: 'paged-v2',
        create: true,
        key: Buffer.alloc(32, 19),
        binding: 'd'.repeat(64),
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw new Error('No RPC');
        },
      }),
      onClose: () => {},
    });
    try {
      await worker.ready;
      const journal = await open({ storeSession: worker });
      const next = range();
      next.state.storeId = (await worker.inspectStoreIdentity()).instanceId;
      const token = await journal.prepare(next, source);
      const frontier = await worker.inspectFrontier();
      const write = worker.dispatch(
        JSON.stringify({
          id: 1,
          method: 'batch',
          args: {
            operations: [
              {
                type: 'put',
                key: Buffer.from('public-fixture-key').toString('base64'),
                value: Buffer.from('value').toString('base64'),
              },
            ],
          },
        })
      );
      if (mode === 'completed-write') await write;
      await expect(journal.complete(token, { source, state: frontier })).rejects.toThrow();
      await write;
      const retained = JSON.parse(await options.storage.get(RECORD_KEY));
      expect(retained.pending.to.number).toBe(10);
      expect(retained.checkpoint).toBeNull();
    } finally {
      worker.close();
      await worker.closed;
    }
  }
);
test('a newly opened journal cannot prepare until its empty store baseline is freshly checked', async () => {
  const journal = await createRailgunScanJournal(options);
  journals.push(journal);
  await expect(journal.prepare(range(), source)).rejects.toThrow();
  const stored = JSON.parse(await options.storage.get(RECORD_KEY));
  expect(stored.pending).toBeNull();
});
test('reopening a completed checkpoint requires revalidation before preparing its successor', async () => {
  const first = await open(),
    token = await first.prepare(range(), source);
  await first.complete(token, { source, state: observation });
  first.close();
  const restored = await open();
  await expect(restored.prepare(range(11, 20, 2), source)).rejects.toThrow();
  const fresh = await open();
  await fresh.revalidate({ source, state: observation });
  await expect(fresh.prepare(range(11, 20, 2), source)).resolves.toBeDefined();
});

test('refuses provenance-free legacy journal records rather than silently migrating', async () => {
  const journal = await open();
  const record = await journal.readState();
  journal.close();
  await options.storage.set(RECORD_KEY, JSON.stringify({ ...record, version: 1 }));
  await expect(open()).rejects.toThrow();
});
test('cannot change the source ledger identity across checkpoints', async () => {
  const journal = await open(),
    first = range(),
    token = await journal.prepare(first, source);
  await journal.complete(token, { source, state: first.state });
  const next = range(11, 20, 2);
  next.source.ledgerId = 'd'.repeat(64);
  await expect(journal.prepare(next, source)).rejects.toThrow();
});
test('renews provider provenance without permitting a content change', async () => {
  const journal = await open(),
    first = range(),
    token = await journal.prepare(first, source);
  await journal.complete(token, { source, state: first.state });
  const renewed = structuredClone(first);
  renewed.source.providersSha256 = 'f'.repeat(64);
  await journal.revalidate({ source, state: first.state, plan: renewed });
  expect((await journal.readState()).checkpoint.source.providersSha256).toBe('f'.repeat(64));
  const altered = structuredClone(renewed);
  altered.logs.sha256 = 'e'.repeat(64);
  await expect(journal.revalidate({ source, state: first.state, plan: altered })).rejects.toThrow();
});
test('source retention is opaque, ledger-bound, exclusive and limited to the callback lifetime', async () => {
  const { readRailgunSourceRetention } = require('./railgun-scan-journal');
  const journal = await open();
  let saved;
  await journal.withSourceRetention(async (token) => {
    saved = token;
    expect(readRailgunSourceRetention(token, digest)).toEqual({
      ledgerId: digest,
      checkpoint: null,
      pending: null,
    });
    expect(() => readRailgunSourceRetention({ ...token }, digest)).toThrow();
    expect(() => readRailgunSourceRetention(token, 'a'.repeat(64))).toThrow();
    await expect(journal.prepare(range(), source)).rejects.toMatchObject({
      code: 'RAILGUN_SCAN_BUSY',
    });
    await expect(journal.withSourceRetention(() => {})).rejects.toThrow();
  });
  expect(() => readRailgunSourceRetention(saved, digest)).toThrow();
  await journal.prepare(range(), source);
  await journal.withSourceRetention((token) => {
    expect(readRailgunSourceRetention(token, digest).pending).toBe(digest);
    journal.close();
    expect(() => readRailgunSourceRetention(token, digest)).toThrow();
  });
});
