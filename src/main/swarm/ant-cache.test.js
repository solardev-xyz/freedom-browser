const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CACHE_SIZES,
  CHUNK_BYTES,
  DEFAULT_CACHE_BYTES,
  LEGACY_CACHE_BYTES,
  MIN_CACHE_BYTES,
  MAX_CACHE_BYTES,
  COUNTING_WINDOW_MS,
  normalizeCacheBytes,
  resolveCacheBytes,
  cacheCapacityChunks,
  chooseCacheBytes,
  formatCacheBytes,
  cacheSizeLabel,
  parseDebugstore,
  parseCacheStatus,
  isCounting,
  describeCache,
  cacheFileBytes,
  parseClearReport,
  describeClearResult,
  describeCacheWriteError,
  createAntCacheService,
  cacheSettingsView,
  clearAvailability,
  applyCacheSize,
} = require('./ant-cache');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// Ant v0.5.61's `GET /v0/cache` (crates/ant-retrieval/src/cache_control.rs `status_json`).
function v0cache({ used = 0, pinned = 0, cap = 2 * GIB, diskEnabled = true } = {}) {
  return {
    disk_enabled: diskEnabled,
    used_bytes: diskEnabled ? used : 0,
    capacity_bytes: diskEnabled ? cap : 0,
    pinned_bytes: diskEnabled ? pinned : 0,
    chunks: diskEnabled ? Math.ceil(used / 4096) : 0,
    pinned_chunks: diskEnabled ? Math.ceil(pinned / 4096) : 0,
    file_bytes: 0,
    memory_chunks: 0,
    memory_capacity_chunks: 8192,
  };
}

// Ant v0.5.61's `/debugstore` (crates/ant-gateway/src/status.rs `debugstore`).
function debugstore({ size = 0, capacity = (2 * GIB) / 4096, total = size, pins = 0 } = {}) {
  return {
    Upload: { TotalUploaded: 0, TotalSynced: 0, PendingUpload: 0 },
    Pinning: { TotalCollections: pins ? 1 : 0, TotalChunks: pins },
    Cache: { Size: size, Capacity: capacity },
    Reserve: { SizeWithinRadius: 0, TotalSize: 0, Capacity: 0, LastBinIDs: null, Epoch: 0 },
    ChunkStore: { TotalChunks: total, SharedSlots: 0, ReferenceCount: total },
  };
}

describe('cache sizes', () => {
  test('are 512 MB, 1, 2, 5, 10 and 16 GB, MiB/GiB-based, inside Ant’s clamp', () => {
    expect(CACHE_SIZES).toEqual([512 * MIB, GIB, 2 * GIB, 5 * GIB, 10 * GIB, 16 * GIB]);
    for (const bytes of CACHE_SIZES) {
      expect(bytes).toBeGreaterThanOrEqual(MIN_CACHE_BYTES);
      expect(bytes).toBeLessThanOrEqual(MAX_CACHE_BYTES);
      expect(bytes % MIB).toBe(0);
      expect(Number.isInteger(bytes / CHUNK_BYTES)).toBe(true);
    }
  });

  test('default is 2 GB, and the legacy size (Ant’s own default) is one of them', () => {
    expect(DEFAULT_CACHE_BYTES).toBe(2 * GIB);
    expect(LEGACY_CACHE_BYTES).toBe(10 * GIB);
    expect(CACHE_SIZES).toContain(DEFAULT_CACHE_BYTES);
    expect(CACHE_SIZES).toContain(LEGACY_CACHE_BYTES);
  });

  test.each([
    [null],
    [undefined],
    [0],
    [3 * GIB],
    [2 * GIB + 1],
    [String(2 * GIB)],
    [-GIB],
    [NaN],
    [Infinity],
    [{}],
  ])('an unknown stored value (%p) resolves to the default', (stored) => {
    expect(normalizeCacheBytes(stored)).toBeNull();
    expect(resolveCacheBytes(stored)).toBe(DEFAULT_CACHE_BYTES);
  });

  test('a known value resolves to itself', () => {
    for (const bytes of CACHE_SIZES) expect(resolveCacheBytes(bytes)).toBe(bytes);
  });

  test('cache-capacity is the chunk count, bee’s × 4096', () => {
    expect(cacheCapacityChunks(512 * MIB)).toBe(131072);
    expect(cacheCapacityChunks(2 * GIB)).toBe(524288);
    expect(cacheCapacityChunks(16 * GIB)).toBe(4194304);
    // Never anything outside the set.
    expect(cacheCapacityChunks('lots')).toBe(524288);
    expect(cacheCapacityChunks(12345)).toBe(524288);
  });

  test('labels', () => {
    expect(CACHE_SIZES.map(cacheSizeLabel)).toEqual([
      '512 MB',
      '1 GB',
      '2 GB (default)',
      '5 GB',
      '10 GB',
      '16 GB',
    ]);
  });
});

describe('chooseCacheBytes (first start after upgrade)', () => {
  test('a saved size is used as is and not saved again', () => {
    expect(chooseCacheBytes({ stored: GIB, hasExistingCache: true })).toEqual({
      bytes: GIB,
      save: false,
    });
  });

  test('a saved unknown value falls back to the default, not to 10 GB', () => {
    expect(chooseCacheBytes({ stored: 3 * GIB, hasExistingCache: true })).toEqual({
      bytes: DEFAULT_CACHE_BYTES,
      save: false,
    });
  });

  test('a profile whose node already has a cache keeps 10 GB, saved', () => {
    expect(chooseCacheBytes({ stored: null, hasExistingCache: true })).toEqual({
      bytes: LEGACY_CACHE_BYTES,
      save: true,
    });
  });

  test('a new profile gets the default, saved so its new cache never reads as an old one', () => {
    expect(chooseCacheBytes({ stored: undefined, hasExistingCache: false })).toEqual({
      bytes: DEFAULT_CACHE_BYTES,
      save: true,
    });
  });
});

describe('formatCacheBytes', () => {
  test.each([
    [0, '0 B'],
    [-5, '0 B'],
    [NaN, '0 B'],
    [512, '512 B'],
    [4096, '4 KB'],
    [120 * MIB, '120 MB'],
    [1.3 * GIB, '1.3 GB'],
    [2 * GIB, '2 GB'],
    [1023.96 * MIB, '1024 MB'],
  ])('%p → %s', (bytes, text) => {
    expect(formatCacheBytes(bytes)).toBe(text);
  });
});

describe('parseDebugstore', () => {
  test('reads Ant’s answer: unpinned size, capacity, pinned from the chunk store', () => {
    expect(
      parseDebugstore(debugstore({ size: 90, capacity: 131072, total: 100, pins: 12 }))
    ).toEqual({
      diskEnabled: true,
      usedBytes: 90 * 4096,
      capacityBytes: 512 * MIB,
      pinnedBytes: 10 * 4096,
      chunks: 100,
    });
  });

  test('Capacity 0 is a node without a disk cache', () => {
    expect(parseDebugstore(debugstore({ capacity: 0 }))).toMatchObject({
      diskEnabled: false,
      capacityBytes: 0,
    });
  });

  test.each([
    ['null', null],
    ['a string', 'not json'],
    ['an array', [1, 2]],
    ['an error body', { code: 404, message: 'Not Found' }],
    ['Cache not an object', { Cache: 7 }],
    ['no Capacity', { Cache: { Size: 3 } }],
    ['a string Capacity', { Cache: { Size: 3, Capacity: '131072' } }],
    ['a negative Capacity', { Cache: { Size: 3, Capacity: -1 } }],
  ])('garbage (%s) is null', (_label, body) => {
    expect(parseDebugstore(body)).toBeNull();
  });

  test('missing or bad counts read as 0, and pinned is never negative', () => {
    expect(parseDebugstore({ Cache: { Capacity: 1024 } })).toEqual({
      diskEnabled: true,
      usedBytes: 0,
      capacityBytes: 1024 * 4096,
      pinnedBytes: 0,
      chunks: 0,
    });
    expect(
      parseDebugstore({ Cache: { Size: -4, Capacity: 1024 }, ChunkStore: { TotalChunks: 'x' } })
    ).toMatchObject({ usedBytes: 0, pinnedBytes: 0 });
    // A chunk store reading below the cache's (counts landing apart).
    expect(
      parseDebugstore({ Cache: { Size: 50, Capacity: 1024 }, ChunkStore: { TotalChunks: 40 } })
    ).toMatchObject({ usedBytes: 50 * 4096, pinnedBytes: 0, chunks: 50 });
  });
});

describe('parseCacheStatus (GET /v0/cache)', () => {
  test('reads the figures in bytes, chunks counting pinned ones too', () => {
    expect(parseCacheStatus(v0cache({ used: 8192, pinned: 4096 }))).toEqual({
      diskEnabled: true,
      usedBytes: 8192,
      capacityBytes: 2 * GIB,
      pinnedBytes: 4096,
      chunks: 3,
    });
    expect(parseCacheStatus(v0cache({ diskEnabled: false }))).toMatchObject({
      diskEnabled: false,
    });
  });

  test.each([
    [null],
    [[]],
    [debugstore()],
    [{ disk_enabled: 'yes', capacity_bytes: 1 }],
    [{ disk_enabled: true, capacity_bytes: -1 }],
  ])('refuses %p', (body) => {
    expect(parseCacheStatus(body)).toBeNull();
  });
});

describe('isCounting', () => {
  const zero = parseDebugstore(debugstore());
  const big = 5 * MIB;

  test('all zero, just after spawn, over a big file: counting', () => {
    expect(isCounting(zero, { sinceSpawnMs: 5_000, fileBytes: big })).toBe(true);
  });

  test('not past the window', () => {
    expect(isCounting(zero, { sinceSpawnMs: COUNTING_WINDOW_MS, fileBytes: big })).toBe(false);
  });

  test('not over a small or missing file (a genuinely empty cache)', () => {
    expect(isCounting(zero, { sinceSpawnMs: 5_000, fileBytes: 64 * 1024 })).toBe(false);
    expect(isCounting(zero, { sinceSpawnMs: 5_000, fileBytes: null })).toBe(false);
  });

  test('not once anything is counted', () => {
    const some = parseDebugstore(debugstore({ size: 1 }));
    expect(isCounting(some, { sinceSpawnMs: 5_000, fileBytes: big })).toBe(false);
    const pinnedOnly = parseDebugstore(debugstore({ size: 0, total: 3 }));
    expect(isCounting(pinnedOnly, { sinceSpawnMs: 5_000, fileBytes: big })).toBe(false);
  });

  test('not with the disk cache off, an unknown spawn time, or garbage', () => {
    const off = parseDebugstore(debugstore({ capacity: 0 }));
    expect(isCounting(off, { sinceSpawnMs: 5_000, fileBytes: big })).toBe(false);
    expect(isCounting(zero, { sinceSpawnMs: NaN, fileBytes: big })).toBe(false);
    expect(isCounting(zero, { sinceSpawnMs: -1, fileBytes: big })).toBe(false);
    expect(isCounting(null, { sinceSpawnMs: 5_000, fileBytes: big })).toBe(false);
  });
});

describe('describeCache (Settings’ cache usage line)', () => {
  test('"1.3 GB of 2 GB · 120 MB pinned", pinned only when there is some', () => {
    const used = Math.round((1.3 * GIB) / 4096);
    const pinned = (120 * MIB) / 4096;
    const parsed = parseDebugstore(debugstore({ size: used, total: used + pinned }));
    expect(describeCache({ nodeStatus: 'running', parsed })).toMatchObject({
      state: 'ok',
      text: '1.3 GB of 2 GB · 120 MB pinned',
      reason: '',
    });
    const unpinned = parseDebugstore(debugstore({ size: used }));
    expect(describeCache({ nodeStatus: 'running', parsed: unpinned }).text).toBe('1.3 GB of 2 GB');
  });

  test('every state without a figure says why', () => {
    for (const [args, state] of [
      [{ nodeStatus: 'stopped' }, 'not-running'],
      [{ nodeStatus: 'error' }, 'not-running'],
      [{ nodeStatus: 'starting' }, 'starting'],
      [{ nodeStatus: 'running', parsed: null }, 'unreadable'],
      [{ nodeStatus: 'running', parsed: parseDebugstore(debugstore({ capacity: 0 })) }, 'disk-off'],
    ]) {
      const row = describeCache(args);
      expect(row.state).toBe(state);
      expect(row.text).toBeTruthy();
      expect(row.reason).toBeTruthy();
    }
  });

  test('counting reads "Counting… (2 GB max)", never "0 B of 2 GB"', () => {
    const row = describeCache({
      nodeStatus: 'running',
      parsed: parseDebugstore(debugstore()),
      counting: true,
    });
    expect(row).toMatchObject({ state: 'counting', text: 'Counting… (2 GB max)' });
    expect(row.text).not.toMatch(/0 B/);
  });
});

describe('createAntCacheService', () => {
  const response = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    body: { cancel: jest.fn(async () => {}) },
  });

  function service({ status = 'running', answer, spawnedAt = null, dataDir = null, now = 0 } = {}) {
    const fetchImpl = jest.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return {
      fetchImpl,
      svc: createAntCacheService({
        getNodeStatus: () => ({ status }),
        getApiBase: () => 'http://127.0.0.1:1633/',
        getSpawnedAt: () => spawnedAt,
        getDataDir: () => dataDir,
        fetchImpl,
        now: () => now,
      }),
    };
  }

  test('reads GET /v0/cache from the node, live and in bytes', async () => {
    const { svc, fetchImpl } = service({
      answer: response(200, v0cache({ used: 1.3 * GIB, pinned: 120 * MIB })),
    });
    await expect(svc.getStatus()).resolves.toMatchObject({
      state: 'ok',
      text: '1.3 GB of 2 GB · 120 MB pinned',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:1633/v0/cache',
      expect.objectContaining({ method: 'GET' })
    );
  });

  // A reused bee, or an Ant before v0.5.61.
  test('falls back to GET /debugstore on a node without /v0/cache', async () => {
    const fetchImpl = jest.fn(async (url) =>
      url.endsWith('/v0/cache')
        ? response(404, { code: 404 })
        : response(200, debugstore({ size: 256 }))
    );
    const svc = createAntCacheService({
      getNodeStatus: () => ({ status: 'running' }),
      getApiBase: () => 'http://127.0.0.1:1633',
      fetchImpl,
    });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'ok', text: '1 MB of 2 GB' });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:1633/v0/cache',
      'http://127.0.0.1:1633/debugstore',
    ]);
  });

  test('no answer at all is not asked twice', async () => {
    const { svc, fetchImpl } = service({ answer: new Error('ECONNREFUSED') });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'unreadable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('/v0/cache with the disk cache off', async () => {
    const { svc } = service({ answer: response(200, v0cache({ diskEnabled: false })) });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'disk-off' });
  });

  test('does not ask a node that is not running', async () => {
    const { svc, fetchImpl } = service({ status: 'stopped' });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'not-running' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ['a 404 (a node without the route)', () => response(404, { code: 404 })],
    ['garbage', () => response(200, '<html>')],
    ['no answer', () => new Error('ECONNREFUSED')],
  ])('%s is unreadable', async (_label, answer) => {
    const { svc } = service({ answer: answer() });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'unreadable' });
  });

  test('counting after spawn, from the size of chunks.sqlite and its WAL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-cache-'));
    try {
      fs.writeFileSync(path.join(dir, 'chunks.sqlite'), Buffer.alloc(700 * 1024));
      fs.writeFileSync(path.join(dir, 'chunks.sqlite-wal'), Buffer.alloc(400 * 1024));
      expect(cacheFileBytes(dir)).toBe(1100 * 1024);
      const early = service({
        answer: response(200, debugstore()),
        spawnedAt: 1_000,
        now: 11_000,
        dataDir: dir,
      });
      await expect(early.svc.getStatus()).resolves.toMatchObject({ state: 'counting' });
      const late = service({
        answer: response(200, debugstore()),
        spawnedAt: 1_000,
        now: 1_000 + COUNTING_WINDOW_MS,
        dataDir: dir,
      });
      await expect(late.svc.getStatus()).resolves.toMatchObject({
        state: 'ok',
        text: '0 B of 2 GB',
      });
      // A node Freedom didn't spawn has no spawn time: never "counting".
      const reused = service({ answer: response(200, debugstore()), dataDir: dir, now: 11_000 });
      await expect(reused.svc.getStatus()).resolves.toMatchObject({ state: 'ok' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a node that stopped while the read was out reads as not running', async () => {
    let status = 'running';
    const svc = createAntCacheService({
      getNodeStatus: () => ({ status }),
      getApiBase: () => 'http://127.0.0.1:1633',
      fetchImpl: async () => {
        status = 'stopped';
        throw new Error('ECONNRESET');
      },
    });
    await expect(svc.getStatus()).resolves.toMatchObject({ state: 'not-running' });
  });
});

describe('cacheSettingsView', () => {
  test('offers the sizes with the current one', () => {
    const view = cacheSettingsView({ stored: 5 * GIB, profileMode: 'managed', nodeActive: true });
    expect(view).toMatchObject({ bytes: 5 * GIB, managed: true, reason: '', nodeActive: true });
    expect(view.sizes.map((s) => s.bytes)).toEqual(CACHE_SIZES);
  });

  test('an unknown stored value shows the default', () => {
    expect(cacheSettingsView({ stored: 7 }).bytes).toBe(DEFAULT_CACHE_BYTES);
  });

  // R2-M2 on #588: storedBytes is what settings hold, raw, so the renderer's
  // broadcast compare matches even for a hand-edited size outside the set.
  test('storedBytes carries a stored value outside the set as is', () => {
    expect(cacheSettingsView({ stored: 3 * GIB })).toMatchObject({
      bytes: DEFAULT_CACHE_BYTES,
      storedBytes: 3 * GIB,
    });
    expect(cacheSettingsView({ stored: undefined }).storedBytes).toBeNull();
  });

  test('before the first start it shows the size that start will write', () => {
    expect(cacheSettingsView({ stored: null, hasExistingCache: true })).toMatchObject({
      bytes: LEGACY_CACHE_BYTES,
      storedBytes: null,
    });
    expect(cacheSettingsView({ stored: null, hasExistingCache: false })).toMatchObject({
      bytes: DEFAULT_CACHE_BYTES,
      storedBytes: null,
    });
    // A stored choice wins over the existing cache.
    expect(cacheSettingsView({ stored: 2 * GIB, hasExistingCache: true })).toMatchObject({
      bytes: 2 * GIB,
      storedBytes: 2 * GIB,
    });
  });

  test.each([
    [{ profileMode: 'external' }],
    [{ profileMode: 'disabled' }],
    [{ profileMode: 'managed', registryMode: 'reused' }],
  ])('a node Freedom doesn’t run (%p) is disabled with a reason', (modes) => {
    const view = cacheSettingsView({ stored: null, nodeActive: true, ...modes });
    expect(view.managed).toBe(false);
    expect(view.reason).toBeTruthy();
    expect(view.nodeActive).toBe(false);
  });
});

describe('applyCacheSize', () => {
  const deps = (overrides = {}) => ({
    getView: () => ({ managed: true, reason: '' }),
    save: jest.fn(() => true),
    isNodeActive: () => true,
    setLiveCapacity: jest.fn(async () => ({ ok: true })),
    ...overrides,
  });

  test('saves and applies the size live on a running node, without a restart', async () => {
    const d = deps();
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: true, live: true });
    expect(d.save).toHaveBeenCalledWith(GIB);
    expect(d.setLiveCapacity).toHaveBeenCalledWith(GIB);
    // Saved before the live call: Ant doesn't persist it, the next start reads config.yaml.
    expect(d.save.mock.invocationCallOrder[0]).toBeLessThan(
      d.setLiveCapacity.mock.invocationCallOrder[0]
    );
  });

  // A node still coming up may have read config.yaml before the save.
  test('a node still starting: waits for it, then applies live', async () => {
    let state = 'starting';
    const d = deps({
      isNodeActive: () => state === 'running' || state === 'starting',
      isNodeRunning: () => state === 'running',
      waitForNodeSettled: jest.fn(async () => {
        state = 'running';
      }),
    });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: true, live: true });
    expect(d.waitForNodeSettled).toHaveBeenCalledTimes(1);
    expect(d.setLiveCapacity).toHaveBeenCalledWith(GIB);
  });

  test('a start that failed: saved for the next start, nothing sent', async () => {
    let state = 'starting';
    const d = deps({
      isNodeActive: () => state === 'running' || state === 'starting',
      isNodeRunning: () => state === 'running',
      waitForNodeSettled: jest.fn(async () => {
        state = 'stopped';
      }),
    });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: true, live: false });
    expect(d.setLiveCapacity).not.toHaveBeenCalled();
  });

  test('a stopped node: saved, applies at its next start', async () => {
    const d = deps({ isNodeActive: () => false });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: true, live: false });
    expect(d.setLiveCapacity).not.toHaveBeenCalled();
  });

  test('a live call that failed: still saved, applies at the next start, says why', async () => {
    const d = deps({
      setLiveCapacity: jest.fn(async () => ({
        ok: false,
        applied: false,
        error: "The node's disk cache isn't available.",
      })),
    });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({
      ok: true,
      live: false,
      error: "The node's disk cache isn't available.",
    });
    expect(d.save).toHaveBeenCalledWith(GIB);
  });

  test('a live call that threw reads as no answer', async () => {
    const d = deps({ setLiveCapacity: jest.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({
      ok: true,
      live: false,
      error: "The Swarm node didn't answer.",
    });
  });

  // Ant's 500: the size is applied, only the eviction down to it failed, and
  // the next cache write evicts again.
  test('an eviction failure still counts as applied', async () => {
    const d = deps({
      setLiveCapacity: jest.fn(async () => ({ ok: false, applied: true, error: 'x' })),
    });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: true, live: true });
  });

  test.each([[3 * GIB], ['1073741824'], [null], [-1]])(
    'refuses a size not in the set (%p) without saving',
    async (bytes) => {
      const d = deps();
      await expect(applyCacheSize(bytes, d)).resolves.toMatchObject({ ok: false });
      expect(d.save).not.toHaveBeenCalled();
      expect(d.setLiveCapacity).not.toHaveBeenCalled();
    }
  );

  test('refuses on a node Freedom doesn’t run', async () => {
    const d = deps({ getView: () => ({ managed: false, reason: 'not ours' }) });
    await expect(applyCacheSize(GIB, d)).resolves.toEqual({ ok: false, error: 'not ours' });
    expect(d.save).not.toHaveBeenCalled();
    expect(d.setLiveCapacity).not.toHaveBeenCalled();
  });

  test('a failed save is reported and nothing is sent', async () => {
    const d = deps({ save: jest.fn(() => false) });
    await expect(applyCacheSize(GIB, d)).resolves.toMatchObject({ ok: false });
    expect(d.setLiveCapacity).not.toHaveBeenCalled();
  });
});

// Ant v0.5.61's `POST /v0/cache/clear` answer (crates/ant-retrieval/src/cache_control.rs).
const clearReport = ({ freed = 0, before = 0, after = 0, diskEnabled = true } = {}) => ({
  freed_bytes: freed,
  removed_chunks: freed / 4096,
  file_bytes_before: before,
  file_bytes_after: after,
  memory_chunks_removed: 3,
  status: { disk_enabled: diskEnabled, used_bytes: 0, capacity_bytes: 2 * GIB },
});

describe('parseClearReport / describeClearResult', () => {
  test('reads Ant’s clear answer', () => {
    expect(parseClearReport(clearReport({ freed: 5 * MIB, before: 9 * MIB, after: MIB }))).toEqual({
      freedBytes: 5 * MIB,
      fileBytesBefore: 9 * MIB,
      fileBytesAfter: MIB,
      diskEnabled: true,
    });
    expect(parseClearReport(clearReport({ diskEnabled: false })).diskEnabled).toBe(false);
  });

  test.each([[null], [[]], ['x'], [{}], [{ freed_bytes: -1 }], [{ freed_bytes: '5' }]])(
    'refuses %p',
    (body) => {
      expect(parseClearReport(body)).toBeNull();
    }
  );

  test('"Freed X", and the cases with nothing to free or no shrink on disk', () => {
    expect(
      describeClearResult({ freedBytes: 1.3 * GIB, fileBytesBefore: 2 * GIB, fileBytesAfter: 0 })
    ).toBe('Freed 1.3 GB.');
    expect(describeClearResult({ freedBytes: 0, fileBytesBefore: 0, fileBytesAfter: 0 })).toBe(
      'Freed 0 B. The cache was already empty.'
    );
    // A cache file from before Ant v0.5.60 that couldn't be rebuilt smaller.
    expect(
      describeClearResult({
        freedBytes: 5 * MIB,
        fileBytesBefore: 20 * MIB,
        fileBytesAfter: 20 * MIB,
      })
    ).toBe('Freed 5 MB. The cache file keeps its size on disk; the node reuses the space.');
    expect(
      describeClearResult({ freedBytes: 5 * MIB, fileBytesBefore: null, fileBytesAfter: null })
    ).toBe('Freed 5 MB.');
  });
});

describe('describeCacheWriteError', () => {
  test.each([
    [{ timedOut: true }, 'The Swarm node took too long to answer.'],
    [{}, "The Swarm node didn't answer."],
    [{ status: 404 }, "This Swarm node can't clear its cache while it runs."],
    [{ status: 501 }, "This Swarm node can't clear its cache while it runs."],
    [{ status: 503 }, "The node's disk cache isn't available."],
    [
      { status: 500, message: 'clear disk cache: disk I/O error' },
      "The Swarm node couldn't clear its cache (500: clear disk cache: disk I/O error).",
    ],
    [{ status: 403, message: '' }, "The Swarm node couldn't clear its cache (403)."],
  ])('clear %p', (failure, text) => {
    expect(describeCacheWriteError('clear', failure)).toBe(text);
  });

  test('resize words its own action', () => {
    expect(describeCacheWriteError('resize', { status: 405 })).toBe(
      "This Swarm node can't change its cache size while it runs."
    );
  });
});

describe('clearAvailability', () => {
  const managed = { managed: true, reason: '', clearReason: '' };

  test.each([['ok'], ['counting']])('offered while the usage line is %s', (state) => {
    expect(clearAvailability({ state }, managed)).toEqual({ canClear: true, clearReason: '' });
  });

  test.each([
    ['not-running', 'Available while the Swarm node is running.'],
    ['starting', 'Available once the Swarm node is running.'],
    ['disk-off', "The node's disk cache isn't available, so there is nothing to clear."],
    ['unreadable', "The node doesn't report its cache, so Freedom can't clear it."],
  ])('off while %s, with the reason', (state, clearReason) => {
    expect(clearAvailability({ state }, managed)).toEqual({ canClear: false, clearReason });
  });

  test('never for a node Freedom doesn’t run, even with a figure', () => {
    const view = cacheSettingsView({ stored: null, profileMode: 'external' });
    expect(clearAvailability({ state: 'ok' }, view)).toEqual({
      canClear: false,
      clearReason: "Freedom doesn't run this Swarm node. Clear its cache where it runs.",
    });
    const off = cacheSettingsView({ stored: null, profileMode: 'disabled' });
    expect(clearAvailability({ state: 'ok' }, off).canClear).toBe(false);
    expect(clearAvailability({ state: 'ok' }, off).clearReason).toMatch(/off for this profile/);
  });
});

describe('the cache writes (createAntCacheService)', () => {
  const answer = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  function service({ status = 'running', reply, spawnedAt = 5, dataDir = null, now = 6 } = {}) {
    const calls = [];
    const fetchImpl = jest.fn(async (url, init) => {
      calls.push({ url, init });
      const next = typeof reply === 'function' ? reply(url, init) : reply;
      if (next instanceof Error) throw next;
      return next;
    });
    return {
      calls,
      fetchImpl,
      svc: createAntCacheService({
        getNodeStatus: () => ({ status }),
        getApiBase: () => 'http://127.0.0.1:1633/',
        getSpawnedAt: () => spawnedAt,
        getDataDir: () => dataDir,
        fetchImpl,
        now: () => now,
      }),
    };
  }

  test('clear: POST /v0/cache/clear, no body, no Origin; answers "Freed X"', async () => {
    const { svc, calls } = service({
      reply: answer(200, clearReport({ freed: 6 * MIB, before: 20 * MIB, after: 64 * 1024 })),
    });
    await expect(svc.clearCache()).resolves.toEqual({
      ok: true,
      freedBytes: 6 * MIB,
      text: 'Freed 6 MB.',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:1633/v0/cache/clear');
    expect(calls[0].init).toMatchObject({ method: 'POST' });
    expect(calls[0].init.body).toBeUndefined();
    // Ant refuses a write that carries an Origin (a web page's).
    expect(JSON.stringify(calls[0].init.headers || {})).not.toMatch(/origin/i);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test('clear: a node that isn’t running is not asked', async () => {
    const { svc, fetchImpl } = service({ status: 'stopped' });
    await expect(svc.clearCache()).resolves.toEqual({
      ok: false,
      error: "The Swarm node isn't running.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [
      'a 500 with Ant’s error body',
      () => answer(500, { code: 500, message: 'clear disk cache: database is locked' }),
      "The Swarm node couldn't clear its cache (500: clear disk cache: database is locked).",
    ],
    [
      'a 403 (refused as a web page)',
      () => answer(403, { code: 403, message: 'does not accept requests from web pages' }),
      "The Swarm node couldn't clear its cache (403: does not accept requests from web pages).",
    ],
    [
      'a node without the route',
      () => answer(404, '{"code":404}'),
      "This Swarm node can't clear its cache while it runs.",
    ],
    ['no answer', () => new Error('ECONNREFUSED'), "The Swarm node didn't answer."],
    [
      'a timeout',
      () => Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
      'The Swarm node took too long to answer.',
    ],
    ['garbage', () => answer(200, '<html>'), "The Swarm node's answer couldn't be read."],
    [
      'no disk cache (Ant emptied only the memory tier)',
      () => answer(200, clearReport({ diskEnabled: false })),
      "The node's disk cache isn't available, so nothing was cleared.",
    ],
  ])('clear: %s is a failure with the reason', async (_label, reply, error) => {
    const { svc } = service({ reply });
    await expect(svc.clearCache()).resolves.toEqual({ ok: false, error });
  });

  // After a clear, an all-zero reading over a big old cache file is the truth
  // (Ant can't always shrink a pre-v0.5.60 file), not Ant still counting.
  test('after a clear, the same spawn never reads as counting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ant-cache-clear-'));
    try {
      fs.writeFileSync(path.join(dir, 'chunks.sqlite'), Buffer.alloc(2 * MIB));
      let spawnedAt = 1_000;
      const svc = createAntCacheService({
        getNodeStatus: () => ({ status: 'running' }),
        getApiBase: () => 'http://127.0.0.1:1633',
        getSpawnedAt: () => spawnedAt,
        getDataDir: () => dir,
        now: () => spawnedAt + 5_000,
        fetchImpl: async (url) =>
          url.endsWith('/v0/cache/clear')
            ? answer(200, clearReport({ freed: MIB, before: 2 * MIB, after: 2 * MIB }))
            : answer(200, debugstore()),
      });
      await expect(svc.getStatus()).resolves.toMatchObject({ state: 'counting' });
      await expect(svc.clearCache()).resolves.toMatchObject({ ok: true });
      await expect(svc.getStatus()).resolves.toMatchObject({ state: 'ok', text: '0 B of 2 GB' });
      // A new spawn counts afresh.
      spawnedAt = 9_000;
      await expect(svc.getStatus()).resolves.toMatchObject({ state: 'counting' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resize: PUT /v0/cache/capacity with {"bytes": N} as JSON', async () => {
    const { svc, calls } = service({ reply: answer(200, { capacity_bytes: GIB }) });
    await expect(svc.setCapacity(GIB)).resolves.toEqual({ ok: true });
    expect(calls[0].url).toBe('http://127.0.0.1:1633/v0/cache/capacity');
    expect(calls[0].init).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({ bytes: GIB });
  });

  test.each([
    [
      503,
      { code: 503, message: 'disk chunk cache is not available' },
      false,
      "The node's disk cache isn't available.",
    ],
    [
      500,
      { code: 500, message: 'set cache capacity: disk full' },
      true,
      "The Swarm node couldn't change its cache size (500: set cache capacity: disk full).",
    ],
    [404, '{"code":404}', false, "This Swarm node can't change its cache size while it runs."],
  ])('resize: a %i', async (status, body, applied, error) => {
    const { svc } = service({ reply: answer(status, body) });
    await expect(svc.setCapacity(GIB)).resolves.toEqual({ ok: false, applied, error });
  });
});
