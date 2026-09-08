const fs = require('fs');
const os = require('os');
const path = require('path');

function loadManager(options = {}) {
  jest.resetModules();
  const handlers = new Map();
  const ipcMain = { handle: jest.fn((channel, fn) => handlers.set(channel, fn)) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-radicle-manager-'));
  const embedded = {
    isAvailable: jest.fn(() => options.available !== false),
    isStarted: jest.fn(() => false),
    start: jest.fn(async () => ({ did: 'did:key:z6MkNative' })),
    shutdown: jest.fn(async () => ({ ok: true })),
    connectSeeds: jest.fn(async () => ({
      connected: 4,
      target: 4,
      targetReached: true,
      attempted: 6,
      elapsedMs: 250,
      failures: [],
    })),
    cloneRepo: jest.fn(async () => ({ ok: true })),
    cloneRepoWithProgress: jest.fn(async (_rid, _timeout, onProgress) => {
      onProgress({ phase: 'resolving', candidates: 2 });
      onProgress({ phase: 'done' });
      return { ok: true };
    }),
    cancelClone: jest.fn(async () => ({ cancelled: true })),
    unseedRepo: jest.fn(async () => ({ unseeded: true })),
    repoInfo: jest.fn(async () => ({
      name: 'native', description: 'repo', defaultBranch: 'main',
    })),
    seeders: jest.fn(async () => ({ seeding: 2 })),
    status: jest.fn(async () => ({ connectedPeers: 3 })),
    listRepos: jest.fn(async () => [{ rid: 'rad:zRepoOne' }, { rid: 'rad:zRepoTwo' }]),
    listSeededRepos: jest.fn(async () => [{ rid: 'rad:zRepoOne' }, { rid: 'rad:zRepoTwo' }]),
    getVersion: jest.fn(() => '0.4.0'),
    ...options.embedded,
  };
  const registry = {
    updateService: jest.fn(),
    setStatusMessage: jest.fn(),
    clearService: jest.fn(),
    MODE: { EMBEDDED: 'embedded', DISABLED: 'disabled' },
  };
  const statusSend = jest.fn();
  const windows = options.windows || [{ webContents: { send: statusSend } }];

  jest.doMock('electron', () => ({
    ipcMain,
    BrowserWindow: { getAllWindows: jest.fn(() => windows) },
  }));
  jest.doMock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('./profile-paths', () => ({ getRadicleDataDir: jest.fn(() => dataDir) }));
  jest.doMock('./profile-resolver', () => ({
    getActiveProfile: jest.fn(() => options.profile || { metadata: { nodes: {} } }),
  }));
  jest.doMock('./radicle-embedded', () => embedded);
  jest.doMock('./service-registry', () => registry);

  const mod = require('./radicle-manager');
  return { mod, embedded, registry, ipcMain, handlers, dataDir, statusSend };
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('normalizes Radicle IDs without changing base58 case', () => {
  const ctx = loadManager();
  expect(ctx.mod.validateAndNormalizeRid('rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5')).toBe(
    'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5'
  );
  expect(ctx.mod.validateAndNormalizeRid('rad:z0bad')).toBeNull();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('starts and stops only the native addon', async () => {
  const ctx = loadManager();
  await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
  expect(ctx.embedded.start).toHaveBeenCalledWith(ctx.dataDir, 'FreedomBrowser');
  expect(ctx.registry.updateService).toHaveBeenCalledWith('radicle', {
    api: 'radapi://local', gateway: 'radapi://local', mode: 'embedded',
  });
  expect(ctx.registry.setStatusMessage).toHaveBeenCalledWith('radicle', null);
  await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
  expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('pushes connection and repository metrics after native state changes', async () => {
  const ctx = loadManager();
  await ctx.mod.startRadicle();
  await new Promise((resolve) => setImmediate(resolve));

  expect(ctx.statusSend).toHaveBeenCalledWith(
    'radicle:statusUpdate',
    expect.objectContaining({
      status: 'running',
      info: expect.objectContaining({ success: true, count: 3, reposCount: 2 }),
    })
  );
  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('fails closed when the addon is unavailable', async () => {
  const ctx = loadManager({ available: false });
  await expect(ctx.mod.startRadicle()).resolves.toEqual({
    status: 'error', error: 'libradicle addon is not installed',
  });
  expect(ctx.embedded.start).not.toHaveBeenCalled();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('a stop during native startup shuts the completed runtime down once', async () => {
  let finishStart;
  const start = jest.fn(() => new Promise((resolve) => { finishStart = resolve; }));
  const ctx = loadManager({ embedded: { start } });
  const starting = ctx.mod.startRadicle();
  const stopping = ctx.mod.stopRadicle();
  await Promise.resolve();
  finishStart({ did: 'did:key:z6MkNative' });
  await Promise.all([starting, stopping]);
  expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
  expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('a start requested during shutdown waits for shutdown to complete', async () => {
  let finishShutdown;
  const shutdown = jest.fn(() => new Promise((resolve) => { finishShutdown = resolve; }));
  const ctx = loadManager({ embedded: { shutdown } });
  await ctx.mod.startRadicle();

  const stopping = ctx.mod.stopRadicle();
  const restarting = ctx.mod.startRadicle();
  await Promise.resolve();
  expect(ctx.embedded.start).toHaveBeenCalledTimes(1);

  finishShutdown({ ok: true });
  await expect(stopping).resolves.toEqual({ status: 'stopped', error: null });
  await expect(restarting).resolves.toEqual({ status: 'running', error: null });
  expect(ctx.embedded.start).toHaveBeenCalledTimes(2);
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('window.radicle operations use native calls and expose fetch status', async () => {
  const ctx = loadManager();
  await ctx.mod.startRadicle();
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
  await expect(ctx.mod.seedRepository(rid)).resolves.toMatchObject({
    success: true, status: { rid, state: 'fetching' },
  });
  await Promise.resolve();
  await Promise.resolve();
  await expect(ctx.mod.getSeedFetchStatus(rid)).resolves.toMatchObject({
    success: true,
    status: { rid, inStorage: true, progress: { phase: 'done' }, seedersKnown: 2 },
  });
  await expect(ctx.mod.getConnections()).resolves.toMatchObject({
    success: true,
    count: 3,
    reposCount: 2,
    version: '0.4.0',
  });
  await expect(ctx.mod.unseedRepository(rid)).resolves.toMatchObject({ success: true });
  expect(ctx.embedded.unseedRepo).toHaveBeenCalledWith(rid);
  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('unseed requests native cancellation and re-applies policy after a late clone', async () => {
  let finishClone;
  const cancelClone = jest
    .fn()
    .mockResolvedValueOnce({ cancelled: false })
    .mockResolvedValueOnce({ cancelled: false })
    .mockResolvedValue({ cancelled: true });
  const cloneRepoWithProgress = jest.fn((_rid, _timeout, onProgress) => {
    onProgress({ phase: 'fetching', nid: 'z6MkSeed', index: 1, total: 1 });
    return new Promise((resolve) => { finishClone = resolve; });
  });
  const ctx = loadManager({ embedded: { cloneRepoWithProgress, cancelClone } });
  await ctx.mod.startRadicle();
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

  await ctx.mod.seedRepository(rid);
  await expect(ctx.mod.getSeedFetchStatus(rid)).resolves.toMatchObject({
    success: true,
    status: { state: 'fetching', progress: { phase: 'fetching', nid: 'z6MkSeed' } },
  });
  await expect(ctx.mod.unseedRepository(rid)).resolves.toMatchObject({ success: true });
  expect(ctx.embedded.cancelClone).toHaveBeenCalledWith(rid);
  expect(ctx.embedded.unseedRepo).toHaveBeenCalledTimes(1);

  // cancelCloneWithRetry backs off 0/10/25ms before the third attempt reports
  // `cancelled: true` and the loop stops. Poll for that instead of racing a
  // single fixed sleep, which flakes when the event loop stalls under load,
  // then settle past the next (100ms) backoff to prove it really stopped at 3.
  for (let i = 0; i < 200 && ctx.embedded.cancelClone.mock.calls.length < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(ctx.embedded.cancelClone).toHaveBeenCalledTimes(3);

  finishClone({ cancelled: true });
  await new Promise((resolve) => setImmediate(resolve));
  expect(ctx.embedded.unseedRepo).toHaveBeenCalledTimes(2);

  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

// The native fetch writes a seeding policy as it replicates, so sync must
// stay a retry path for repos the user already committed to — it carries no
// per-repo consent prompt of its own.
test('sync refuses a repository the node is not already seeding', async () => {
  const ctx = loadManager();
  await ctx.mod.startRadicle();
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

  await expect(ctx.mod.refetchRepository(rid)).resolves.toMatchObject({
    success: false,
    error: { code: 'NOT_SEEDED' },
  });
  expect(ctx.embedded.cloneRepoWithProgress).not.toHaveBeenCalled();

  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('sync restarts the fetch for an already-seeded repository', async () => {
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
  const ctx = loadManager({
    embedded: { listSeededRepos: jest.fn(async () => [{ rid }]) },
  });
  await ctx.mod.startRadicle();

  await expect(ctx.mod.refetchRepository(rid)).resolves.toMatchObject({
    success: true,
    status: { rid, state: 'fetching' },
  });
  expect(ctx.embedded.cloneRepoWithProgress).toHaveBeenCalledWith(
    rid,
    expect.any(Number),
    expect.any(Function)
  );

  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('sync fails closed when the seeding policies cannot be read', async () => {
  const ctx = loadManager({
    embedded: {
      listSeededRepos: jest.fn(async () => {
        throw new Error('node busy');
      }),
    },
  });
  await ctx.mod.startRadicle();

  await expect(
    ctx.mod.refetchRepository('rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5')
  ).resolves.toMatchObject({ success: false, error: { code: 'NOT_SEEDED' } });
  expect(ctx.embedded.cloneRepoWithProgress).not.toHaveBeenCalled();

  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('disabled profiles never start the addon', async () => {
  const ctx = loadManager({ profile: { metadata: { nodes: { radicle: { mode: 'disabled' } } } } });
  await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'stopped', error: null });
  expect(ctx.embedded.start).not.toHaveBeenCalled();
  expect(ctx.registry.updateService).toHaveBeenCalledWith('radicle', {
    api: null, gateway: null, mode: 'disabled',
  });
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('profile mode changes stop and re-enable the embedded node', async () => {
  const profile = { metadata: { nodes: { radicle: { mode: 'managed' } } } };
  const ctx = loadManager({ profile });
  await ctx.mod.startRadicle();

  profile.metadata.nodes.radicle.mode = 'disabled';
  await expect(ctx.mod.syncProfileMode()).resolves.toEqual({ status: 'stopped', error: null });
  expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
  expect(ctx.registry.updateService).toHaveBeenLastCalledWith('radicle', {
    api: null, gateway: null, mode: 'disabled',
  });
  expect(ctx.registry.setStatusMessage).toHaveBeenLastCalledWith(
    'radicle',
    'Disabled for this profile'
  );

  profile.metadata.nodes.radicle.mode = 'managed';
  await expect(ctx.mod.syncProfileMode()).resolves.toEqual({ status: 'stopped', error: null });
  expect(ctx.registry.clearService).toHaveBeenCalledWith('radicle');
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('IPC keeps profile gating and RID validation', async () => {
  const ctx = loadManager({
    profile: { metadata: { nodes: { radicle: { mode: 'disabled' } } } },
  });
  ctx.mod.registerRadicleIpc();
  const IPC = require('../shared/ipc-channels');
  await expect(ctx.handlers.get(IPC.RADICLE_START)()).resolves.toMatchObject({ status: 'stopped' });
  await expect(ctx.handlers.get(IPC.RADICLE_SEED)(null, '')).resolves.toMatchObject({
    success: false, error: { code: 'RADICLE_DISABLED' },
  });
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('IPC pushes native seed progress back to the requesting internal page', async () => {
  const ctx = loadManager();
  const IPC = require('../shared/ipc-channels');
  await ctx.mod.startRadicle();
  ctx.mod.registerRadicleIpc();
  const sender = { isDestroyed: jest.fn(() => false), send: jest.fn() };
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';

  await expect(ctx.handlers.get(IPC.RADICLE_SEED)({ sender }, rid)).resolves.toMatchObject({
    success: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(sender.send).toHaveBeenCalledWith(
    IPC.RADICLE_SEED_STATUS_UPDATE,
    expect.objectContaining({ rid, progress: { phase: 'resolving', candidates: 2 } })
  );
  expect(sender.send).toHaveBeenCalledWith(
    IPC.RADICLE_SEED_STATUS_UPDATE,
    expect.objectContaining({ rid, state: 'fetched', progress: { phase: 'done' } })
  );
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});
