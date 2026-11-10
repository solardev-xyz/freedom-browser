const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPrivateWindowFixture } = require('../../test/helpers/private-window-fixture');

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

  // The real private-window registry decides who is private (R-9).
  const windowFixture = createPrivateWindowFixture();
  jest.doMock('electron', () => ({
    ipcMain,
    BrowserWindow: {
      getAllWindows: jest.fn(() => windows),
      fromWebContents: windowFixture.fromWebContents,
    },
    session: { fromPartition: windowFixture.fromPartition },
  }));
  jest.doMock('./windows/mainWindow', () => ({ createMainWindow: windowFixture.createMainWindow }));
  jest.doMock('./logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
  jest.doMock('./profile-paths', () => ({
    getRadicleDataDir: jest.fn(() => dataDir),
    prepareRadicleDataDir: jest.fn(async () => dataDir),
  }));
  jest.doMock('./profile-resolver', () => ({
    getActiveProfile: jest.fn(() => options.profile || { metadata: { nodes: {} } }),
  }));
  jest.doMock('./radicle-embedded', () => embedded);
  jest.doMock('./service-registry', () => registry);

  const mod = require('./radicle-manager');
  const privateWindows = require('./private/private-windows');
  return {
    mod,
    embedded,
    registry,
    ipcMain,
    handlers,
    dataDir,
    statusSend,
    lookup: windowFixture.lookup,
    publicSender: windowFixture.publicSender,
    privateSender: () => windowFixture.privateSender(privateWindows),
  };
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

const posixTest = process.platform === 'win32' ? test.skip : test;

posixTest('narrows keys an older build left readable before the node starts (K-3)', async () => {
  const ctx = loadManager();
  const keysDir = path.join(ctx.dataDir, 'keys');
  fs.mkdirSync(keysDir, { mode: 0o755 });
  fs.chmodSync(keysDir, 0o755);
  fs.writeFileSync(path.join(keysDir, 'radicle'), 'secret');
  fs.chmodSync(path.join(keysDir, 'radicle'), 0o644);

  await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
  expect(fs.statSync(keysDir).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(keysDir, 'radicle')).mode & 0o777).toBe(0o600);
  await ctx.mod.stopRadicle();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

posixTest('a keys/ that is a link stops the start, nothing opened through it (K-3)', async () => {
  const ctx = loadManager();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-outside-'));
  fs.writeFileSync(path.join(outside, 'radicle'), 'not yours');
  fs.chmodSync(path.join(outside, 'radicle'), 0o644);
  fs.symlinkSync(outside, path.join(ctx.dataDir, 'keys'));

  await expect(ctx.mod.startRadicle()).resolves.toEqual({
    status: 'error',
    error: expect.stringContaining('symbolic link'),
  });
  expect(ctx.embedded.start).not.toHaveBeenCalled();
  expect(fs.statSync(path.join(outside, 'radicle')).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(path.join(outside, 'radicle'), 'utf8')).toBe('not yours');
  fs.rmSync(outside, { recursive: true, force: true });
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
  // Startup awaits the Radicle home first (prepareRadicleDataDir), so give it
  // a few microtask turns to reach embedded.start.
  for (let i = 0; i < 20 && !finishStart; i += 1) await Promise.resolve();
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
  const sender = ctx.publicSender();
  await expect(ctx.handlers.get(IPC.RADICLE_SEED)({ sender }, '')).resolves.toMatchObject({
    success: false, error: { code: 'RADICLE_DISABLED' },
  });
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('IPC refuses seeding and sync from private windows, failing closed (R-9)', async () => {
  const ctx = loadManager();
  const IPC = require('../shared/ipc-channels');
  await ctx.mod.startRadicle();
  ctx.mod.registerRadicleIpc();
  const rid = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
  const privateGuest = {
    hostWebContents: ctx.privateSender(),
    isDestroyed: () => false,
    send: jest.fn(),
  };
  const publicSender = ctx.publicSender();
  const refused = {
    success: false,
    error: { code: 'RADICLE_PRIVATE_WINDOW', message: 'Seeding is not available in private windows' },
  };

  for (const event of [
    { sender: privateGuest },
    // A sender main cannot place in a known window counts as private.
    { sender: { isDestroyed: () => true } },
    { sender: { isDestroyed: () => false, hostWebContents: { isDestroyed: () => true } } },
    { sender: { isDestroyed: () => false } },
    {},
    null,
  ]) {
    expect(await ctx.handlers.get(IPC.RADICLE_SEED)(event, rid)).toEqual(refused);
    expect(await ctx.handlers.get(IPC.RADICLE_SYNC_REPO)(event, rid)).toEqual(refused);
  }
  // A public window whose lookup finds nothing, or throws (R-9 review).
  for (const mode of ['null', 'throw']) {
    ctx.lookup.mode = mode;
    expect(await ctx.handlers.get(IPC.RADICLE_SEED)({ sender: publicSender }, rid)).toEqual(refused);
    expect(await ctx.handlers.get(IPC.RADICLE_SYNC_REPO)({ sender: publicSender }, rid)).toEqual(
      refused
    );
  }
  ctx.lookup.mode = 'registry';
  expect(ctx.embedded.cloneRepoWithProgress).not.toHaveBeenCalled();
  expect(privateGuest.send).not.toHaveBeenCalled();

  // Reading a repository's seed status stays available.
  await expect(ctx.handlers.get(IPC.RADICLE_GET_SEED_STATUS)({ sender: privateGuest }, rid))
    .resolves.toMatchObject({ success: true });
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('IPC pushes native seed progress back to the requesting internal page', async () => {
  const ctx = loadManager();
  const IPC = require('../shared/ipc-channels');
  await ctx.mod.startRadicle();
  ctx.mod.registerRadicleIpc();
  const sender = ctx.publicSender();
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

describe('re-key critical section (R-8)', () => {
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  // The wrapper's real ordering (radicle-embedded.js): `started` is set
  // once the add-on's start resolves and cleared only once its shutdown
  // resolves. `nativeAlive` is the add-on's own node. With
  // `clearsBeforeProof`, the wrapper clears `started` before the add-on
  // answers, as it did before this fix.
  function modelNode(ctx, { shutdownFails = false, clearsBeforeProof = false } = {}) {
    const node = { wrapperStarted: false, nativeAlive: false };
    ctx.embedded.isStarted.mockImplementation(() => node.wrapperStarted);
    ctx.embedded.start.mockImplementation(async () => {
      node.nativeAlive = true;
      node.wrapperStarted = true;
      return { did: 'did:key:z6MkNative' };
    });
    ctx.embedded.shutdown.mockImplementation(async () => {
      if (!node.wrapperStarted) return { ok: true };
      if (clearsBeforeProof) node.wrapperStarted = false;
      if (shutdownFails) throw new Error('shutdown failed');
      node.nativeAlive = false;
      node.wrapperStarted = false;
      return { ok: true };
    });
    return node;
  }

  test('stops the node with proof, runs the work, and restarts it', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx);
    await ctx.mod.startRadicle();

    const work = jest.fn(async () => {
      expect(ctx.mod.getCurrentStatus().status).toBe('stopped');
      expect(node.nativeAlive).toBe(false);
      return 'did:key:z6MkNew';
    });
    await expect(ctx.mod.createRadicleLifecycle().withStopped(work)).resolves.toBe(
      'did:key:z6MkNew'
    );
    expect(work).toHaveBeenCalledTimes(1);
    expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.embedded.start).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getCurrentStatus().status).toBe('running');
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a node that was not running stays stopped', async () => {
    const ctx = loadManager();
    modelNode(ctx);
    const work = jest.fn(async () => 'did');
    await expect(ctx.mod.createRadicleLifecycle().withStopped(work)).resolves.toBe('did');
    expect(ctx.embedded.start).not.toHaveBeenCalled();
    expect(ctx.mod.getCurrentStatus().status).toBe('stopped');
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Round-1 review (R1-M1): a node in ERROR with no native node (a failed
  // start, a missing add-on) has nothing to stop; the re-key must not
  // replace the visible error with a clean STOPPED.
  test('a node in error with no native node keeps its error through a re-key', async () => {
    const ctx = loadManager();
    modelNode(ctx);
    ctx.embedded.start.mockImplementationOnce(async () => {
      throw new Error('libradicle addon is not installed');
    });
    await ctx.mod.startRadicle();
    const before = ctx.mod.getCurrentStatus();
    expect(before).toEqual({ status: 'error', error: 'libradicle addon is not installed' });
    ctx.registry.clearService.mockClear();

    const work = jest.fn(async () => 'did');
    await expect(ctx.mod.createRadicleLifecycle().withStopped(work)).resolves.toBe('did');
    expect(work).toHaveBeenCalledTimes(1);
    expect(ctx.embedded.shutdown).not.toHaveBeenCalled();
    expect(ctx.registry.clearService).not.toHaveBeenCalled();
    expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getCurrentStatus()).toEqual(before);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a work that fails still restarts the node, and its error reaches the caller', async () => {
    const ctx = loadManager();
    modelNode(ctx);
    await ctx.mod.startRadicle();
    await expect(
      ctx.mod.createRadicleLifecycle().withStopped(async () => {
        throw new Error('vault locked during the re-key');
      })
    ).rejects.toThrow('vault locked during the re-key');
    expect(ctx.embedded.start).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getCurrentStatus().status).toBe('running');
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Review repro 1: the lifecycle queue was released before the wipe.
  test('a start, and a second re-key, requested during the work wait for it', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx);
    await ctx.mod.startRadicle();
    const lifecycle = ctx.mod.createRadicleLifecycle();
    const steps = [];
    let release;
    const first = lifecycle.withStopped(
      () =>
        new Promise((resolve) => {
          steps.push('first work');
          release = resolve;
        })
    );
    await flush();
    expect(release).toBeDefined();

    // While the first re-key is wiping: a start, and another re-key.
    const starting = ctx.mod.startRadicle();
    const second = lifecycle.withStopped(async () => {
      steps.push(`second work (node ${node.nativeAlive ? 'up' : 'down'})`);
      return 'second';
    });
    await flush();
    expect(ctx.mod.getCurrentStatus().status).toBe('stopped');
    expect(node.nativeAlive).toBe(false);
    expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['first work']);

    release('first');
    await expect(first).resolves.toBe('first');
    await starting;
    await expect(second).resolves.toBe('second');
    expect(steps).toEqual(['first work', 'second work (node down)']);
    expect(ctx.mod.getCurrentStatus().status).toBe('running');
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Review repro 2: a rejected native shutdown was taken as proof.
  for (const clearsBeforeProof of [true, false]) {
    test(`a rejected shutdown is no proof: the work never runs (wrapper clears started ${
      clearsBeforeProof ? 'before' : 'after'
    } the add-on answers)`, async () => {
      const ctx = loadManager();
      const node = modelNode(ctx, { shutdownFails: true, clearsBeforeProof });
      await ctx.mod.startRadicle();
      const work = jest.fn(async () => 'did');

      await expect(ctx.mod.createRadicleLifecycle().withStopped(work)).rejects.toThrow(
        'shutdown failed'
      );
      expect(work).not.toHaveBeenCalled();
      expect(node.nativeAlive).toBe(true);
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'error', error: 'shutdown failed' });
      // Not restarted on top of a node that may still be running.
      expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    });
  }

  // Review note 2a: a shutdown that never answers held onboarding's
  // injection, and every queued start or stop, forever.
  test('a shutdown that never answers fails the re-key in bounded time, data untouched', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const ctx = loadManager();
      const node = modelNode(ctx);
      await ctx.mod.startRadicle();
      let answerShutdown;
      ctx.embedded.shutdown.mockImplementation(
        () => new Promise((resolve) => {
          answerShutdown = () => {
            node.nativeAlive = false;
            node.wrapperStarted = false;
            resolve({ ok: true });
          };
        })
      );
      const work = jest.fn(async () => 'did');

      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      const rekeyResult = rekey.then(() => null, (err) => err);
      const starting = ctx.mod.startRadicle();
      await flush();
      expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30_000);
      const err = await rekeyResult;
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('RADICLE_NOT_STOPPED');
      expect(err.message).toMatch(/did not answer its shutdown within 30s/);
      expect(work).not.toHaveBeenCalled();
      // The queued start is answered (refused: the stop was never proved).
      await expect(starting).resolves.toMatchObject({ status: 'error' });
      expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
      expect(ctx.mod.getCurrentStatus().status).toBe('error');

      // The add-on answers late: a later stop proves it, and a start works.
      answerShutdown();
      await flush();
      ctx.embedded.shutdown.mockImplementation(async () => ({ ok: true }));
      await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
      await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
      await ctx.mod.stopRadicle();
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    } finally {
      jest.useRealTimers();
    }
  });

  // Round-2 review (R2-M1): the user's Stop timed out, so the node is in
  // ERROR with the add-on still counting it as started. A re-key must stop
  // it (with proof) before the wipe, but must not start it again: the
  // user's last action was a stop.
  test('a re-key after an unproved user stop stops the node but does not restart it', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const ctx = loadManager();
      const node = modelNode(ctx);
      await ctx.mod.startRadicle();
      let answerShutdown;
      ctx.embedded.shutdown.mockImplementation(
        () => new Promise((resolve) => {
          answerShutdown = () => {
            node.nativeAlive = false;
            node.wrapperStarted = false;
            resolve({ ok: true });
          };
        })
      );

      const stopping = ctx.mod.stopRadicle();
      await flush();
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(stopping).resolves.toMatchObject({ status: 'error' });
      expect(node.wrapperStarted).toBe(true);

      // The re-key's stop waits on the shutdown, which now answers in time.
      const work = jest.fn(async () => {
        expect(node.nativeAlive).toBe(false);
        return 'did';
      });
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      await flush();
      answerShutdown();
      await expect(rekey).resolves.toBe('did');
      expect(work).toHaveBeenCalledTimes(1);
      expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
      expect(node.nativeAlive).toBe(false);
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a stop the add-on rejects reaches the re-key as RADICLE_NOT_STOPPED', async () => {
    const ctx = loadManager();
    modelNode(ctx, { shutdownFails: true });
    await ctx.mod.startRadicle();
    await expect(
      ctx.mod.createRadicleLifecycle().withStopped(async () => 'did')
    ).rejects.toMatchObject({ code: 'RADICLE_NOT_STOPPED', message: 'shutdown failed' });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Round-2 review: a start queued behind a re-key whose stop was never
  // proved must not start the add-on over the node that may still run.
  test('a start queued behind a re-key whose stop failed is refused', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx, { shutdownFails: true });
    await ctx.mod.startRadicle();
    const IPC = require('../shared/ipc-channels');
    ctx.mod.registerRadicleIpc();
    const work = jest.fn(async () => 'did');

    const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
    const starting = ctx.mod.startRadicle();
    await expect(rekey).rejects.toThrow('shutdown failed');
    await expect(starting).resolves.toEqual({ status: 'error', error: 'shutdown failed' });
    // RADICLE_START, onboarding and the lifecycle controller all queue this
    // same start; an alias change neither writes nor restarts.
    await expect(ctx.handlers.get(IPC.RADICLE_START)()).resolves.toMatchObject({ status: 'error' });
    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toMatchObject({
      success: false,
      error: { code: 'RADICLE_NOT_STOPPED' },
    });
    expect(fs.existsSync(path.join(ctx.dataDir, 'config.json'))).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(node.nativeAlive).toBe(true);
    expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'error', error: 'shutdown failed' });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('an alias change whose stop fails writes nothing and restarts nothing', async () => {
    const ctx = loadManager();
    modelNode(ctx, { shutdownFails: true });
    await ctx.mod.startRadicle();

    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toMatchObject({
      success: false,
      error: { code: 'RADICLE_NOT_STOPPED', message: 'shutdown failed' },
    });
    expect(fs.existsSync(path.join(ctx.dataDir, 'config.json'))).toBe(false);
    expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a later stop that proves the node stopped allows a start again', async () => {
    const ctx = loadManager();
    const failing = { shutdownFails: true };
    const node = modelNode(ctx, failing);
    await ctx.mod.startRadicle();
    await expect(
      ctx.mod.createRadicleLifecycle().withStopped(async () => 'did')
    ).rejects.toThrow('shutdown failed');
    await expect(ctx.mod.startRadicle()).resolves.toMatchObject({ status: 'error' });

    // The next shutdown succeeds: the node is proved stopped, and may start.
    ctx.embedded.shutdown.mockImplementation(async () => {
      node.nativeAlive = false;
      node.wrapperStarted = false;
      return { ok: true };
    });
    await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
    expect(ctx.embedded.start).toHaveBeenCalledTimes(2);
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Round-3 review: disabling the profile after an unproved stop must not
  // publish it stopped, and a later stop must still try to shut it down.
  test('disabling the profile after an unproved stop keeps it recoverable', async () => {
    const profile = { metadata: { nodes: { radicle: { mode: 'managed' } } } };
    const ctx = loadManager({ profile });
    const node = modelNode(ctx, { shutdownFails: true });
    await ctx.mod.startRadicle();
    await expect(
      ctx.mod.createRadicleLifecycle().withStopped(async () => 'did')
    ).rejects.toThrow('shutdown failed');
    expect(node.nativeAlive).toBe(true);

    profile.metadata.nodes.radicle.mode = 'disabled';
    await expect(ctx.mod.syncProfileMode()).resolves.toEqual({
      status: 'error',
      error: 'shutdown failed',
    });
    expect(ctx.registry.updateService).not.toHaveBeenCalledWith('radicle', {
      api: null,
      gateway: null,
      mode: 'disabled',
    });

    // The recovery: a stop whose shutdown now succeeds shuts the node down.
    ctx.embedded.shutdown.mockImplementation(async () => {
      node.nativeAlive = false;
      node.wrapperStarted = false;
      return { ok: true };
    });
    const shutdowns = ctx.embedded.shutdown.mock.calls.length;
    await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.embedded.shutdown.mock.calls.length).toBe(shutdowns + 1);
    expect(node.nativeAlive).toBe(false);

    // Now proved stopped, disabling publishes it as disabled.
    await expect(ctx.mod.syncProfileMode()).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.registry.updateService).toHaveBeenLastCalledWith('radicle', {
      api: null,
      gateway: null,
      mode: 'disabled',
    });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  // Review repro 3: a start queued just before the re-key was stopped and
  // then forgotten.
  test('a start queued just before the re-key is stopped for it, then restarted', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx);
    let finishStart;
    ctx.embedded.start.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStart = () => {
            node.nativeAlive = true;
            node.wrapperStarted = true;
            resolve({ did: 'did:key:z6MkNative' });
          };
        })
    );
    const starting = ctx.mod.startRadicle();
    const work = jest.fn(async () => {
      expect(node.nativeAlive).toBe(false);
      return 'did';
    });
    const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
    await flush();
    finishStart();

    await starting;
    await expect(rekey).resolves.toBe('did');
    expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.embedded.start).toHaveBeenCalledTimes(2);
    expect(ctx.mod.getCurrentStatus().status).toBe('running');
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
});
