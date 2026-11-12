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
    // The service's reads (radicle-embedded.js under the service): its node,
    // and a collected result handed to its scope.
    setServiceNodeSource: jest.fn(),
    callScoped: jest.fn(async (op, _args, scope) => {
      if (op !== 'node_info') throw new Error(`unexpected collected read ${op}`);
      return scope({ connected_peers: 6, repos_total: 2, repos_error: null }, { signal: null });
    }),
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
  // freedom-radicled's hold-lock on the home (radicle/radicled-gate.js),
  // faked: a take resolves to a hold at once, as an uncontended holder's
  // does, after `options.gateTake({ home, signal })` if given (which may
  // wait, or throw another writer's refusal); an aborted signal gives it up,
  // as hold-lock.js's does. `gate.holds` is every hold taken, and
  // `gate.events` each take and release, in order.
  const gate = { holds: [], events: [] };
  const gateError = (code, message) =>
    Object.assign(new Error(message), { name: 'RadicleGateError', code });
  const takeRadicleGate = jest.fn(async (home, { signal = null, onLost = null } = {}) => {
    if (signal?.aborted) throw gateError('cancelled', "Taking the Radicle home's lock was cancelled");
    if (options.gateTake) await options.gateTake({ home, signal, gateError });
    const hold = {
      home,
      released: false,
      lost: false,
      release: jest.fn(async () => {
        if (!hold.released) gate.events.push('release');
        hold.released = true;
      }),
      // Its holder ends unreleased (killed).
      lose: () => {
        hold.lost = true;
        onLost?.({ code: null, signal: 'SIGKILL' });
      },
    };
    gate.holds.push(hold);
    gate.events.push('take');
    return hold;
  });
  const withRadicleGate = jest.fn(async (home, fn) => {
    const hold = await takeRadicleGate(home);
    try {
      return await fn({ gated: true, held: () => !hold.lost });
    } finally {
      await hold.release();
    }
  });

  // The real private-window registry decides who is private (R-9).
  const windowFixture = createPrivateWindowFixture();
  jest.doMock('electron', () => ({
    app: options.app,
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
    getRadicledHomeDir: jest.fn(() => path.join(dataDir, 'radicled-home')),
    prepareRadicleDataDir: jest.fn(async () => {
      if (options.prepare) await options.prepare();
      return dataDir;
    }),
  }));
  jest.doMock('./profile-resolver', () => ({
    getActiveProfile: jest.fn(() => options.profile || { metadata: { nodes: {} } }),
  }));
  jest.doMock('./radicle-embedded', () => embedded);
  jest.doMock('./service-locks', () => ({ getLockDir: () => path.join(dataDir, 'locks') }));
  if (options.radicledNode) jest.doMock('./radicle/radicled-node', () => options.radicledNode);
  jest.doMock('./service-registry', () => registry);
  jest.doMock('./radicle/radicled-gate', () => ({
    ...jest.requireActual('./radicle/radicled-gate'),
    takeRadicleGate,
    withRadicleGate,
  }));

  const mod = require('./radicle-manager');
  // The core has started and reported no pending node recovery.
  require('./core/node-identity-guard').setStartupRecovery(null);
  const privateWindows = require('./private/private-windows');
  return {
    mod,
    embedded,
    registry,
    ipcMain,
    handlers,
    dataDir,
    statusSend,
    gate,
    takeRadicleGate,
    withRadicleGate,
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

// K-3 on integration: the core writes keys/radicle (0600) through its
// journal, but core.hello sends no node_roots, so a keys/ an older build
// created stays as it was until main's repair. The repair narrows modes
// only: the key the core wrote is the same file, byte for byte.
posixTest('the node starts only after keys/ is narrowed; the core-written key is kept as is (K-3)', async () => {
  const ctx = loadManager();
  const keysDir = path.join(ctx.dataDir, 'keys');
  fs.mkdirSync(keysDir, { mode: 0o755 });
  fs.chmodSync(keysDir, 0o755);
  const keyPath = path.join(keysDir, 'radicle');
  fs.writeFileSync(keyPath, 'core-written key', { mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, 'radicle.pub'), 'public key');
  const before = fs.statSync(keyPath);
  let modesAtStart = null;
  ctx.embedded.start.mockImplementation(async () => {
    modesAtStart = {
      keys: fs.statSync(keysDir).mode & 0o777,
      key: fs.statSync(keyPath).mode & 0o777,
    };
    return { did: 'did:key:z6MkNative' };
  });

  await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
  expect(modesAtStart).toEqual({ keys: 0o700, key: 0o600 });
  expect(fs.statSync(keyPath).ino).toBe(before.ino);
  expect(fs.readFileSync(keyPath, 'utf8')).toBe('core-written key');
  expect(fs.readFileSync(path.join(keysDir, 'radicle.pub'), 'utf8')).toBe('public key');
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

// Review #1029 R1: the node opens keys/radicle by its path, following a
// link there. A key that is there but unsafe, or a home, keys/ or key that
// cannot be made owner-only, stops the start: embedded.start never runs.
describe('what the node is handed (K-3)', () => {
  let ctx;
  let keysDir;
  let keyPath;
  let outside;
  beforeEach(() => {
    ctx = loadManager();
    keysDir = path.join(ctx.dataDir, 'keys');
    keyPath = path.join(keysDir, 'radicle');
    fs.mkdirSync(keysDir, { mode: 0o700 });
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-outside-'));
    fs.writeFileSync(path.join(outside, 'radicle'), 'not yours');
    fs.chmodSync(path.join(outside, 'radicle'), 0o644);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });
  const startRefused = async (why) => {
    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: expect.stringContaining(why),
    });
    expect(ctx.embedded.start).not.toHaveBeenCalled();
  };

  test.each([
    ['a link to a key elsewhere', () => path.join(outside, 'radicle')],
    ['a dangling link', () => path.join(outside, 'nothing')],
  ])('a keys/radicle that is %s stops the start', async (_label, linkTarget) => {
    fs.symlinkSync(linkTarget(), keyPath, 'file');
    await startRefused('symbolic link');
    expect(fs.lstatSync(keyPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'radicle'), 'utf8')).toBe('not yours');
    expect(fs.statSync(path.join(outside, 'radicle')).mode & 0o777).toBe(0o644);
  });

  describe.each([
    ['the home', () => ctx.dataDir, 0o755],
    ['keys/', () => keysDir, 0o755],
    ['keys/radicle', () => keyPath, 0o644],
  ])('%s cannot be made owner-only', (_label, target, mode) => {
    posixTest('the start stops before the node gets it', async () => {
      fs.writeFileSync(keyPath, 'core-written key', { mode: 0o600 });
      fs.chmodSync(target(), mode);
      jest.spyOn(fs, 'fchmodSync').mockImplementation(() => {
        throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), { code: 'EPERM' });
      });
      await startRefused('could not make it owner-only');
      expect(fs.statSync(target()).mode & 0o777).toBe(mode);
      expect(fs.readFileSync(keyPath, 'utf8')).toBe('core-written key');
    });
  });
});

test('fails closed when the addon is unavailable', async () => {
  const ctx = loadManager({ available: false });
  await expect(ctx.mod.startRadicle()).resolves.toEqual({
    status: 'error', error: 'libradicle addon is not installed',
  });
  expect(ctx.embedded.start).not.toHaveBeenCalled();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('an identity block that arrives while the home is prepared stops the start', async () => {
  const ctx = loadManager({
    prepare: async () => require('./core/node-identity-guard').blockNode('radicle', 'writing'),
  });
  await expect(ctx.mod.startRadicle()).resolves.toMatchObject({ status: 'error' });
  expect(ctx.embedded.start).not.toHaveBeenCalled();
  fs.rmSync(ctx.dataDir, { recursive: true, force: true });
});

test('a stop during native startup shuts the completed runtime down once', async () => {
  let finishStart;
  const start = jest.fn(() => new Promise((resolve) => { finishStart = resolve; }));
  const ctx = loadManager({ embedded: { start } });
  const starting = ctx.mod.startRadicle();
  // Startup awaits the Radicle home first (prepareRadicleDataDir), then its
  // gate, so give it a few microtask turns to reach embedded.start. A stop
  // asked for before then gives the start up instead (below).
  for (let i = 0; i < 20 && !finishStart; i += 1) await Promise.resolve();
  const stopping = ctx.mod.stopRadicle();
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

// freedom-core design 0008, "Spawn and lock" and Rollback: the add-on is a
// writer the home's gate excludes, as the service is. It holds the gate from
// before its start until its shutdown proves it stopped; the alias rewrite
// holds it with the node stopped; and the add-on never starts on a home the
// service has switched.
describe("the Radicle home's gate", () => {
  const flush = async (rounds = 20) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  // The wrapper's ordering (radicle-embedded.js), with each call recorded in
  // `ctx.gate.events` beside the gate's takes and releases.
  function modelNode(ctx, { shutdownFails = false } = {}) {
    const node = { started: false };
    ctx.embedded.isStarted.mockImplementation(() => node.started);
    ctx.embedded.start.mockImplementation(async () => {
      ctx.gate.events.push('start');
      node.started = true;
      return { did: 'did:key:z6MkNative' };
    });
    ctx.embedded.shutdown.mockImplementation(async () => {
      if (!node.started) return { ok: true };
      ctx.gate.events.push('shutdown');
      if (node.shutdownFails ?? shutdownFails) throw new Error('shutdown failed');
      node.started = false;
      return { ok: true };
    });
    return node;
  }

  test('the add-on holds it on its home from before its start until its proved shutdown', async () => {
    const ctx = loadManager();
    modelNode(ctx);

    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
    expect(ctx.takeRadicleGate).toHaveBeenCalledWith(ctx.dataDir, expect.any(Object));
    expect(ctx.gate.events).toEqual(['take', 'start']);

    await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.gate.events).toEqual(['take', 'start', 'shutdown', 'release']);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a shutdown that proves nothing keeps the gate; a later proved one lets it go', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx, { shutdownFails: true });
    await ctx.mod.startRadicle();

    await expect(ctx.mod.stopRadicle()).resolves.toEqual({
      status: 'error',
      error: 'shutdown failed',
    });
    expect(ctx.gate.holds[0].released).toBe(false);

    node.shutdownFails = false;
    await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.gate.holds[0].released).toBe(true);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('the add-on is refused while another writer (a service) holds the home', async () => {
    const held = 'The Radicle data is in use by another process. Close it and try again.';
    const ctx = loadManager({
      gateTake: async ({ gateError }) => {
        throw gateError('lock_held', held);
      },
    });
    modelNode(ctx);

    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'error', error: held });
    expect(ctx.embedded.start).not.toHaveBeenCalled();
    expect(ctx.registry.updateService).not.toHaveBeenCalledWith(
      'radicle',
      expect.objectContaining({ mode: 'embedded' })
    );
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test("a stop gives up a start waiting out another writer's gate, at once", async () => {
    let waiting = null;
    const ctx = loadManager({
      // hold-lock retrying against another holder, until the signal.
      gateTake: ({ signal, gateError }) =>
        new Promise((_resolve, reject) => {
          waiting = true;
          signal.addEventListener('abort', () =>
            reject(gateError('cancelled', "Taking the Radicle home's lock was cancelled"))
          );
        }),
    });
    modelNode(ctx);

    const starting = ctx.mod.startRadicle();
    await flush();
    expect(waiting).toBe(true);
    const stopping = ctx.mod.stopRadicle();

    await expect(starting).resolves.toEqual({ status: 'stopped', error: null });
    await expect(stopping).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.embedded.start).not.toHaveBeenCalled();
    expect(ctx.gate.holds).toEqual([]);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a stop asked for in the same turn as a start gives the start up before its gate wait', async () => {
    const ctx = loadManager();
    modelNode(ctx);

    const starting = ctx.mod.startRadicle();
    const stopping = ctx.mod.stopRadicle();

    await expect(starting).resolves.toEqual({ status: 'stopped', error: null });
    await expect(stopping).resolves.toEqual({ status: 'stopped', error: null });
    expect(ctx.embedded.start).not.toHaveBeenCalled();
    expect(ctx.gate.holds).toEqual([]);
    // A start asked for after the stop runs.
    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a start that fails lets its gate go', async () => {
    const ctx = loadManager();
    modelNode(ctx);
    ctx.embedded.start.mockRejectedValueOnce(new Error('storage is locked'));

    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'storage is locked',
    });
    expect(ctx.gate.events).toEqual(['take', 'release']);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test("a gate lost under the running node stops it, with the loss as its error", async () => {
    const ctx = loadManager();
    modelNode(ctx);
    await ctx.mod.startRadicle();

    ctx.gate.holds[0].lose();
    await flush();

    expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
    expect(ctx.mod.getCurrentStatus()).toEqual({
      status: 'error',
      error: 'freedom-radicled hold-lock exited',
    });
    // A start takes the gate again.
    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
    expect(ctx.gate.holds).toHaveLength(2);
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('a gate lost while the node starts: it never runs ungated', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx);
    ctx.embedded.start.mockImplementationOnce(async () => {
      ctx.gate.holds[0].lose();
      node.started = true;
      return { did: 'did:key:z6MkNative' };
    });

    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'freedom-radicled hold-lock exited',
    });
    expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
    expect(node.started).toBe(false);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('the alias is written under the gate, with the node stopped, and the node restarts', async () => {
    const ctx = loadManager();
    const node = modelNode(ctx);
    await ctx.mod.startRadicle();
    const configPath = path.join(ctx.dataDir, 'config.json');
    ctx.withRadicleGate.mockImplementationOnce(async (home, fn) => {
      // The node has stopped, and let its own gate go, before this is taken.
      expect(home).toBe(ctx.dataDir);
      expect(node.started).toBe(false);
      expect(ctx.gate.holds.every((hold) => hold.released)).toBe(true);
      ctx.gate.events.push('alias gate');
      const result = await fn({ gated: true, held: () => true });
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).node.alias).toBe('renamed');
      ctx.gate.events.push('alias released');
      return result;
    });

    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toEqual(
      expect.objectContaining({ success: true })
    );
    expect(ctx.gate.events).toEqual([
      'take',
      'start',
      'shutdown',
      'release',
      'alias gate',
      'alias released',
      'take',
      'start',
    ]);
    await ctx.mod.stopRadicle();
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test('an alias rewrite refused by another holder of the gate writes nothing', async () => {
    const ctx = loadManager();
    modelNode(ctx);
    const held = 'The Radicle data is in use by another process. Close it and try again.';
    ctx.withRadicleGate.mockImplementationOnce(async () => {
      throw Object.assign(new Error(held), { name: 'RadicleGateError', code: 'lock_held' });
    });

    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toMatchObject({
      success: false,
      error: { code: 'ALIAS_WRITE_FAILED', message: held },
    });
    expect(fs.existsSync(path.join(ctx.dataDir, 'config.json'))).toBe(false);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  test("an alias rewrite whose gate is lost before the write doesn't write", async () => {
    const ctx = loadManager();
    modelNode(ctx);
    ctx.withRadicleGate.mockImplementationOnce(async (_home, fn) =>
      fn({ gated: true, held: () => false })
    );

    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toMatchObject({
      success: false,
      error: {
        code: 'ALIAS_WRITE_FAILED',
        message: "The Radicle home's lock was lost; the alias was not written",
      },
    });
    expect(fs.existsSync(path.join(ctx.dataDir, 'config.json'))).toBe(false);
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  describe('a home the service has switched', () => {
    const { SWITCHED_HOME_MESSAGE } = jest.requireActual('./radicle/radicled-gate');
    const write = (home, rel, content = '') => {
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), content);
    };

    test.each([
      ['its reconciliation record', 'node/reconcile.db'],
      ['the dirty marker the switch leaves', 'node/dirty'],
    ])('without keys/radicle, and with %s: the add-on is refused, under the gate', async (_what, rel) => {
      const ctx = loadManager();
      modelNode(ctx);
      write(ctx.dataDir, rel);

      await expect(ctx.mod.startRadicle()).resolves.toEqual({
        status: 'error',
        error: SWITCHED_HOME_MESSAGE,
      });
      expect(ctx.embedded.start).not.toHaveBeenCalled();
      expect(ctx.gate.events).toEqual(['take', 'release']);
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    });

    test.each([
      ['a home the service never ran (a profile without a vault)', []],
      ['a home with keys/radicle, where the service has run', ['keys/radicle', 'node/reconcile.db']],
    ])('%s: the add-on starts', async (_what, files) => {
      const ctx = loadManager();
      modelNode(ctx);
      for (const rel of files) write(ctx.dataDir, rel, 'x');
      if (files.includes('keys/radicle')) {
        fs.chmodSync(path.join(ctx.dataDir, 'keys'), 0o700);
        fs.chmodSync(path.join(ctx.dataDir, 'keys', 'radicle'), 0o600);
      }

      await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
      await ctx.mod.stopRadicle();
      fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    });
  });
});

// Plan B6 (freedom-core design 0008, step 6): FREEDOM_RADICLE_BACKEND=service
// runs the node on freedom-radicled (radicle/radicled-node.js, faked here:
// radicled-node.test.js runs the real one against a fake service).
describe('the freedom-radicled backend (FREEDOM_RADICLE_BACKEND)', () => {
  const FREEDOM_BROWSER_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';
  const CONFINEMENT = {
    mechanism: 'landlock-4+seccomp',
    files: 'enforced',
    exec: 'enforced',
    ipc: 'partial',
    network: 'none',
    gaps: ['signals'],
  };
  const saved = process.env.FREEDOM_RADICLE_BACKEND;
  const ctxs = [];

  beforeEach(() => {
    process.env.FREEDOM_RADICLE_BACKEND = 'service';
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
    else process.env.FREEDOM_RADICLE_BACKEND = saved;
    for (const ctx of ctxs.splice(0)) fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  });

  /** A promise and its resolve, for a wait the test settles. */
  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /** radicled-node.js, faked: each node's start and stop are the test's.
   * `module.created` resolves once a node is made, and each node's
   * `stopAsked` once its stop is first asked for. */
  function fakeNodeModule() {
    const module = { nodes: [], available: true, DEFAULT_ALIAS: 'FreedomBrowser' };
    module.created = deferred();
    class FakeRadicledNode {
      constructor(options) {
        this.options = options;
        // The process whose rad.start succeeded: a crash's restart is another.
        this.generation = 1;
        this.stopAsked = deferred();
        this.failureReason = null;
        this.stopping = null;
        this.version = '0.8.0';
        this.confinement = CONFINEMENT;
        this.peers = 4;
        this.startCalls = 0;
        this.stopCalls = 0;
        // The test settles them: start(true|false), stop().
        this.started = new Promise((resolve) => {
          this.resolveStart = resolve;
        });
        this.stopped = new Promise((resolve) => {
          this.resolveStop = resolve;
        });
        this.autoStop = true;
        this.connectSeeds = jest.fn(async () => ({
          connected: 2,
          target: 4,
          attempted: 3,
          elapsedMs: 7,
        }));
        this.cloneRepo = jest.fn(async () => ({ ok: true }));
        module.nodes.push(this);
        module.created.resolve(this);
        // A vault that is unlocked: the node comes up at once.
        if (module.autoStart) this.resolveStart(true);
      }
      static isAvailable() {
        return module.available;
      }
      start() {
        this.startCalls += 1;
        return this.started;
      }
      stop() {
        this.stopCalls += 1;
        this.stopAsked.resolve();
        if (!this.stopping) {
          this.resolveStart(false);
          this.stopping = this.autoStop ? Promise.resolve() : this.stopped;
        }
        return this.stopping;
      }
      connectedPeers() {
        return this.peers;
      }
      activeIdentity() {
        return {
          did: 'did:key:z6MkService',
          nid: 'z6MkService',
          alias: 'FreedomBrowser',
          ephemeral: false,
        };
      }
      buildInfo() {
        return { service: { name: 'freedom-radicled', version: '0.1.0' } };
      }
    }
    module.RadicledNode = FakeRadicledNode;
    return module;
  }

  function load(options = {}) {
    const radicledNode = fakeNodeModule();
    const ctx = loadManager({ radicledNode, ...options });
    ctxs.push(ctx);
    return { ...ctx, radicledNode, node: (n = -1) => radicledNode.nodes.at(n) };
  }

  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const broadcastStatuses = (ctx) =>
    ctx.statusSend.mock.calls
      .filter(([channel]) => channel === 'radicle:statusUpdate')
      .map(([, s]) => s.status);

  describe('radicleBackendKind', () => {
    test('development builds: the add-on by default, the service with =service', () => {
      const { mod } = load();
      expect(mod.radicleBackendKind({ packaged: false, env: {} })).toBe('addon');
      expect(
        mod.radicleBackendKind({ packaged: false, env: { FREEDOM_RADICLE_BACKEND: 'addon' } })
      ).toBe('addon');
      expect(
        mod.radicleBackendKind({ packaged: false, env: { FREEDOM_RADICLE_BACKEND: 'service' } })
      ).toBe('service');
    });

    test('an unknown value is warned of, once, and runs the add-on', () => {
      const { mod } = load();
      const log = require('./logger');
      const env = { FREEDOM_RADICLE_BACKEND: 'radicled' };
      expect(mod.radicleBackendKind({ packaged: false, env })).toBe('addon');
      expect(mod.radicleBackendKind({ packaged: false, env })).toBe('addon');
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        '[Radicle] Unknown FREEDOM_RADICLE_BACKEND=radicled; using the add-on'
      );
    });

    test('packaged builds ignore the flag: always the add-on', async () => {
      const ctx = load({ app: { isPackaged: true, getVersion: () => '1.0.0' } });
      expect(ctx.mod.radicleBackendKind()).toBe('addon');
      expect(
        ctx.mod.radicleBackendKind({ packaged: true, env: { FREEDOM_RADICLE_BACKEND: 'service' } })
      ).toBe('addon');
      await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'running', error: null });
      expect(ctx.embedded.start).toHaveBeenCalledTimes(1);
      expect(ctx.radicledNode.nodes).toHaveLength(0);
      await ctx.mod.stopRadicle();
    });
  });

  test('start: the node on the home, the lock directory and its own HOME; running once it is up; then the background network start', async () => {
    const ctx = load();
    fs.writeFileSync(
      path.join(ctx.dataDir, 'config.json'),
      JSON.stringify({ node: { alias: 'mine' } })
    );
    const started = ctx.mod.startRadicle();
    await flush();
    const node = ctx.node();
    expect(node.options).toMatchObject({
      home: ctx.dataDir,
      lockDir: path.join(ctx.dataDir, 'locks'),
      ownHome: path.join(ctx.dataDir, 'radicled-home'),
      alias: 'FreedomBrowser',
    });
    // The switch keeps the alias the home has.
    expect(node.options.switchAlias()).toBe('mine');
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'starting', error: null });

    node.resolveStart(true);
    await expect(started).resolves.toEqual({ status: 'running', error: null });
    expect(ctx.registry.updateService).toHaveBeenCalledWith('radicle', {
      api: 'radapi://local',
      gateway: 'radapi://local',
      mode: 'embedded',
    });
    await flush();
    expect(node.connectSeeds).toHaveBeenCalledWith(15000);
    expect(node.cloneRepo).toHaveBeenCalledWith(FREEDOM_BROWSER_RID, 120000);
    // The add-on is never touched.
    expect(ctx.embedded.start).not.toHaveBeenCalled();
    expect(ctx.takeRadicleGate).not.toHaveBeenCalled();

    await expect(ctx.mod.stopRadicle()).resolves.toEqual({ status: 'stopped', error: null });
    expect(node.stopCalls).toBeGreaterThan(0);
    expect(ctx.embedded.shutdown).not.toHaveBeenCalled();
  });

  test("a start that fails: the error state, with the node's reason; the Retry is a fresh node, after the last one stopped", async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    await flush();
    const first = ctx.node();
    first.failureReason = 'Radicle is still repairing its data';
    first.autoStop = false;
    first.resolveStart(false);
    await expect(started).resolves.toEqual({
      status: 'error',
      error: 'Radicle is still repairing its data',
    });

    const retry = ctx.mod.startRadicle();
    await flush();
    // Not before the failed node's process is gone.
    expect(ctx.radicledNode.nodes).toHaveLength(1);
    first.resolveStop();
    await flush();
    expect(ctx.radicledNode.nodes).toHaveLength(2);
    ctx.node().resolveStart(true);
    await expect(retry).resolves.toEqual({ status: 'running', error: null });
    await ctx.mod.stopRadicle();
  });

  test('a stop takes a start over at once, whatever it waits for (an unlock): no error on the way', async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    await flush();
    const node = ctx.node();
    const stopped = ctx.mod.stopRadicle();
    // At once, not behind the start in the lifecycle queue.
    expect(node.stopCalls).toBeGreaterThan(0);
    await expect(started).resolves.toEqual({ status: 'starting', error: null });
    await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
    expect(broadcastStatuses(ctx)).not.toContain('error');
  });

  // Review round 1: a stop takes a start over at once in every window, so
  // it never queues behind one (which could wait for a locked vault). None
  // of these lets the start run on before the stop.
  describe("a stop takes the start over at once, in each of the start's waits", () => {
    test('asked for in the same turn as the start: no node is made, and it stops', async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      const stopped = ctx.mod.stopRadicle();
      await expect(started).resolves.toEqual({ status: 'stopped', error: null });
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(0);
      expect(broadcastStatuses(ctx)).not.toContain('error');
    });

    test('a start queued behind another op, stopped before it runs: it never makes a node', async () => {
      const ctx = load();
      const work = deferred();
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(() => work.promise);
      const started = ctx.mod.startRadicle();
      const stopped = ctx.mod.stopRadicle();
      work.resolve('done');
      await expect(rekey).resolves.toBe('done');
      await expect(started).resolves.toEqual({ status: 'stopped', error: null });
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(0);
    });

    test("while the last node's process ends: the start gives up; the stop waits for that end", async () => {
      const ctx = load();
      const first = ctx.mod.startRadicle();
      const failed = await ctx.radicledNode.created.promise;
      failed.failureReason = 'freedom-radicled exited';
      failed.autoStop = false;
      failed.resolveStart(false);
      await expect(first).resolves.toMatchObject({ status: 'error' });

      const started = ctx.mod.startRadicle();
      await failed.stopAsked.promise;
      let stoppedYet = false;
      const stopped = ctx.mod.stopRadicle().then((status) => {
        stoppedYet = true;
        return status;
      });
      await expect(started).resolves.toEqual({ status: 'starting', error: null });
      await flush();
      // The stop's proof is that process's end, which hasn't come.
      expect(stoppedYet).toBe(false);
      failed.resolveStop();
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(1);
    });

    test('while the home is prepared: the start gives up, and the stop needs no preparation', async () => {
      const asked = deferred();
      const preparing = deferred();
      const ctx = load({
        prepare: async () => {
          asked.resolve();
          await preparing.promise;
        },
      });
      const started = ctx.mod.startRadicle();
      await asked.promise;
      const stopped = ctx.mod.stopRadicle();
      await expect(started).resolves.toEqual({ status: 'starting', error: null });
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      preparing.resolve();
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(0);
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
    });

    test('as the node is made, while it waits for the vault: the node stops in the same turn', async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      const node = await ctx.radicledNode.created.promise;
      const stopped = ctx.mod.stopRadicle();
      expect(node.stopCalls).toBeGreaterThan(0);
      await expect(started).resolves.toEqual({ status: 'starting', error: null });
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      expect(ctx.radicledNode.nodes).toHaveLength(1);
    });

    test('a re-key while a start prepares the home: the start gives up, the work runs, then a node starts', async () => {
      const asked = deferred();
      const preparing = deferred();
      let prepares = 0;
      const ctx = load({
        prepare: async () => {
          prepares += 1;
          if (prepares === 1) {
            asked.resolve();
            await preparing.promise;
          }
        },
      });
      const started = ctx.mod.startRadicle();
      await asked.promise;
      const work = jest.fn(async () => 'written');
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      await expect(started).resolves.toEqual({ status: 'starting', error: null });
      const node = await ctx.radicledNode.created.promise;
      // The work ran first, with no node; the restart made the only one.
      expect(work).toHaveBeenCalledTimes(1);
      expect(ctx.radicledNode.nodes).toHaveLength(1);
      node.resolveStart(true);
      await expect(rekey).resolves.toBe('written');
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'running', error: null });
      preparing.resolve();
      await ctx.mod.stopRadicle();
    });

    test("a re-key while the node waits for the vault: it stops at once, and the work doesn't wait", async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      const waiting = await ctx.radicledNode.created.promise;
      const work = jest.fn(async () => 'written');
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      expect(waiting.stopCalls).toBeGreaterThan(0);
      await expect(started).resolves.toEqual({ status: 'starting', error: null });
      await flush();
      expect(work).toHaveBeenCalledTimes(1);
      expect(ctx.radicledNode.nodes).toHaveLength(2);
      ctx.node().resolveStart(true);
      await expect(rekey).resolves.toBe('written');
      await ctx.mod.stopRadicle();
    });

    test("a stop during a re-key's restart gives the restart up", async () => {
      const ctx = load();
      const work = jest.fn(async () => 'written');
      const first = ctx.mod.startRadicle();
      (await ctx.radicledNode.created.promise).resolveStart(true);
      await first;
      ctx.radicledNode.created = deferred();
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      const restarting = await ctx.radicledNode.created.promise;
      const stopped = ctx.mod.stopRadicle();
      expect(restarting.stopCalls).toBeGreaterThan(0);
      await expect(rekey).resolves.toBe('written');
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      expect(ctx.radicledNode.nodes).toHaveLength(2);
    });
  });

  // Review round 2: the re-key's restart is cancellable from the moment the
  // re-key is asked for, so a stop during its work suppresses it.
  describe("a stop during a re-key's work, before its replacement node exists", () => {
    async function runningThenRekey(ctx) {
      const started = ctx.mod.startRadicle();
      (await ctx.radicledNode.created.promise).resolveStart(true);
      await started;
      const working = deferred();
      const finish = deferred();
      const work = jest.fn(async () => {
        working.resolve();
        await finish.promise;
        return 'written';
      });
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      await working.promise;
      return { rekey, finish };
    }

    test('vault unlocked: the restart is given up, and no node is made after the work', async () => {
      const ctx = load();
      const { rekey, finish } = await runningThenRekey(ctx);
      // Any replacement would come up at once.
      ctx.radicledNode.autoStart = true;
      const before = broadcastStatuses(ctx).length;
      const stopped = ctx.mod.stopRadicle();
      finish.resolve();
      await expect(rekey).resolves.toBe('written');
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(1);
      // Nothing started after the stop was asked for.
      const after = broadcastStatuses(ctx).slice(before);
      expect(after).not.toContain('starting');
      expect(after).not.toContain('running');
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
    });

    test('vault locked: the stop completes, with no restart left waiting for an unlock', async () => {
      const ctx = load();
      const { rekey, finish } = await runningThenRekey(ctx);
      // Any replacement would wait for the vault: its start never settles.
      const stopped = ctx.mod.stopRadicle();
      finish.resolve();
      await expect(rekey).resolves.toBe('written');
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      await flush();
      expect(ctx.radicledNode.nodes).toHaveLength(1);
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
    });

    test('a stop asked for after the re-key, before its op runs: no restart either', async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      (await ctx.radicledNode.created.promise).resolveStart(true);
      await started;
      ctx.radicledNode.autoStart = true;
      const work = jest.fn(async () => 'written');
      const rekey = ctx.mod.createRadicleLifecycle().withStopped(work);
      const stopped = ctx.mod.stopRadicle();
      await expect(rekey).resolves.toBe('written');
      await expect(stopped).resolves.toEqual({ status: 'stopped', error: null });
      expect(work).toHaveBeenCalledTimes(1);
      expect(ctx.radicledNode.nodes).toHaveLength(1);
    });

    test('a re-key of a stopped node starts nothing, and leaves no start for a later re-key', async () => {
      const ctx = load();
      ctx.radicledNode.autoStart = true;
      const lifecycle = ctx.mod.createRadicleLifecycle();
      const first = lifecycle.withStopped(async () => 'one');
      const second = lifecycle.withStopped(async () => 'two');
      await expect(first).resolves.toBe('one');
      await expect(second).resolves.toBe('two');
      expect(ctx.radicledNode.nodes).toHaveLength(0);
      expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'stopped', error: null });
    });
  });

  // Review round 1: each process that comes up gets today's background
  // network start, a crash's restart included, once.
  test("the seeds and the default repository's clone run once for each process that comes up", async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    const node = await ctx.radicledNode.created.promise;
    node.resolveStart(true);
    await started;
    await flush();
    expect(node.connectSeeds).toHaveBeenCalledTimes(1);
    expect(node.cloneRepo).toHaveBeenCalledTimes(1);

    // Down by its stats and up again, the same process: nothing more.
    node.options.onChange('restarting', node);
    node.options.onChange('running', node);
    await flush();
    expect(node.connectSeeds).toHaveBeenCalledTimes(1);

    // A crash's restart: a new process, which seeds again.
    node.options.onChange('restarting', node);
    node.generation = 2;
    node.options.onChange('running', node);
    await flush();
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'running', error: null });
    expect(node.connectSeeds).toHaveBeenCalledTimes(2);
    expect(node.connectSeeds).toHaveBeenLastCalledWith(15000);
    expect(node.cloneRepo).toHaveBeenCalledTimes(2);
    expect(node.cloneRepo).toHaveBeenLastCalledWith(FREEDOM_BROWSER_RID, 120000);
    await ctx.mod.stopRadicle();
  });

  test('a start while the node restarts, or waits for the unlock, makes no second node', async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    await flush();
    const node = ctx.node();
    node.resolveStart(true);
    await started;
    node.options.onChange('restarting', node);
    await expect(ctx.mod.startRadicle()).resolves.toEqual({ status: 'starting', error: null });
    expect(ctx.radicledNode.nodes).toHaveLength(1);
    await ctx.mod.stopRadicle();
  });

  test("a home that can't be prepared: the error state, and no node", async () => {
    const ctx = load({
      prepare: async () => {
        throw new Error('The Radicle data is in use by another process. Close it and try again.');
      },
    });
    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'The Radicle data is in use by another process. Close it and try again.',
    });
    expect(ctx.radicledNode.nodes).toHaveLength(0);
  });

  test("the node's own changes: restarting, running again, waiting for the unlock, and giving up", async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    await flush();
    const node = ctx.node();
    node.options.onChange('waiting', node);
    expect(ctx.registry.setStatusMessage).toHaveBeenLastCalledWith(
      'radicle',
      'Waiting for the vault to be unlocked'
    );
    node.resolveStart(true);
    await started;

    node.options.onChange('restarting', node);
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'starting', error: null });
    expect(ctx.registry.setStatusMessage).toHaveBeenLastCalledWith('radicle', 'Node restarting');
    node.options.onChange('running', node);
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'running', error: null });

    node.options.onFailure('freedom-radicled crashed three times within a minute', node);
    expect(ctx.mod.getCurrentStatus()).toEqual({
      status: 'error',
      error: 'freedom-radicled crashed three times within a minute',
    });
    // A stale node's callbacks change nothing.
    node.options.onChange('running', node);
    expect(ctx.mod.getCurrentStatus().status).toBe('error');
    await ctx.mod.stopRadicle();
  });

  test("getConnections: node_info's counts, collected, with the libradicle build and the sandbox", async () => {
    const ctx = load();
    await expect(ctx.mod.getConnections()).resolves.toMatchObject({
      success: false,
      count: 0,
      reposCount: null,
      version: null,
      confinement: null,
    });
    expect(ctx.embedded.callScoped).not.toHaveBeenCalled();
    const started = ctx.mod.startRadicle();
    await flush();
    ctx.node().resolveStart(true);
    await started;
    // The reads go to the node the manager holds.
    const [source] = ctx.embedded.setServiceNodeSource.mock.calls.at(-1);
    expect(source()).toBe(ctx.node());
    await expect(ctx.mod.getConnections()).resolves.toEqual({
      success: true,
      count: 6,
      reposCount: 2,
      version: '0.8.0',
      confinement: CONFINEMENT,
      service: '0.1.0',
    });
    expect(ctx.embedded.callScoped).toHaveBeenCalledWith(
      'node_info',
      {},
      expect.any(Function)
    );
    await flush();
    expect(ctx.statusSend).toHaveBeenCalledWith(
      'radicle:statusUpdate',
      expect.objectContaining({
        status: 'running',
        info: expect.objectContaining({ count: 6, reposCount: 2, confinement: CONFINEMENT }),
      })
    );
    // Nothing of the add-on's.
    expect(ctx.embedded.status).not.toHaveBeenCalled();
    expect(ctx.embedded.listRepos).not.toHaveBeenCalled();
    await ctx.mod.stopRadicle();
    expect(source()).toBeNull();
  });

  test("getConnections: node_info's three contracts (0008, Tests first)", async () => {
    const answers = [];
    const ctx = load({
      embedded: {
        callScoped: jest.fn(async (_op, _args, scope) => {
          const next = answers.shift();
          if (next instanceof Error) throw next;
          return scope(next, { signal: null });
        }),
      },
    });
    const started = ctx.mod.startRadicle();
    await flush();
    ctx.node().resolveStart(true);
    await started;
    await flush();
    const log = require('./logger');
    log.warn.mockClear();
    const diagnostics = { version: '0.8.0', confinement: CONFINEMENT, service: '0.1.0' };

    // Both succeed.
    answers.push({ connected_peers: 3, repos_total: 3, repos_error: null });
    await expect(ctx.mod.getConnections()).resolves.toEqual({
      success: true,
      count: 3,
      reposCount: 3,
      ...diagnostics,
    });
    expect(log.warn).not.toHaveBeenCalled();

    // status succeeds, enumeration fails: no count, and today's warning.
    answers.push({ connected_peers: 2, repos_total: null, repos_error: 'listing failed' });
    await expect(ctx.mod.getConnections()).resolves.toEqual({
      success: true,
      count: 2,
      reposCount: null,
      ...diagnostics,
    });
    expect(log.warn).toHaveBeenCalledWith(
      '[Radicle] Could not read seeded repository count:',
      'listing failed'
    );

    // status fails: the read fails, and so does the manager's answer.
    answers.push(Object.assign(new Error('node thread: the node is not running'), { code: 'failed' }));
    await expect(ctx.mod.getConnections()).resolves.toEqual({
      success: false,
      error: { code: 'GET_CONNECTIONS_FAILED', message: 'node thread: the node is not running' },
      count: 0,
      reposCount: null,
      ...diagnostics,
    });
    await ctx.mod.stopRadicle();
  });

  test('exports not on the service yet say so, and touch no add-on', async () => {
    const ctx = load();
    const expected = {
      success: false,
      error: {
        code: 'RADICLE_SERVICE_UNSUPPORTED',
        message: 'Not available on the Radicle service yet',
      },
    };
    await expect(ctx.mod.seedRepository(FREEDOM_BROWSER_RID)).resolves.toEqual(expected);
    await expect(ctx.mod.refetchRepository(FREEDOM_BROWSER_RID)).resolves.toEqual(expected);
    await expect(ctx.mod.unseedRepository(FREEDOM_BROWSER_RID)).resolves.toEqual(expected);
    await expect(ctx.mod.getSeedFetchStatus(FREEDOM_BROWSER_RID)).resolves.toEqual(expected);
    await expect(ctx.mod.setNodeAlias('renamed')).resolves.toEqual(expected);
    expect(ctx.embedded.cloneRepoWithProgress).not.toHaveBeenCalled();
    expect(ctx.embedded.unseedRepo).not.toHaveBeenCalled();
    expect(ctx.withRadicleGate).not.toHaveBeenCalled();
  });

  test("the binary check is freedom-radicled's; without it the start fails", async () => {
    const ctx = load();
    expect(ctx.mod.registerRadicleIpc()).toBeUndefined();
    expect(await ctx.handlers.get('radicle:checkBinary')()).toEqual({ available: true });
    ctx.radicledNode.available = false;
    expect(await ctx.handlers.get('radicle:checkBinary')()).toEqual({ available: false });
    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'freedom-radicled binary not found',
    });
    expect(ctx.radicledNode.nodes).toHaveLength(0);
  });

  test("main's identity guard holds the start back, as for the add-on", async () => {
    const ctx = load();
    require('./core/node-identity-guard').blockNode('radicle', 'writing');
    await expect(ctx.mod.startRadicle()).resolves.toEqual({
      status: 'error',
      error: 'Node identity is being updated',
    });
    expect(ctx.radicledNode.nodes).toHaveLength(0);
  });

  test('a re-key stops the node, its exit proved, runs the work, and starts a fresh one', async () => {
    const ctx = load();
    const started = ctx.mod.startRadicle();
    await flush();
    const first = ctx.node();
    first.resolveStart(true);
    await started;
    first.autoStop = false;
    let stoppedAtWork = null;
    const rekeyed = ctx.mod.createRadicleLifecycle().withStopped(async () => {
      stoppedAtWork = first.stopCalls > 0 && ctx.mod.getCurrentStatus().status === 'stopped';
      return 'written';
    });
    await flush();
    expect(stoppedAtWork).toBeNull();
    first.resolveStop();
    await flush();
    expect(stoppedAtWork).toBe(true);
    expect(ctx.radicledNode.nodes).toHaveLength(2);
    ctx.node().resolveStart(true);
    await expect(rekeyed).resolves.toBe('written');
    expect(ctx.mod.getCurrentStatus()).toEqual({ status: 'running', error: null });
    await ctx.mod.stopRadicle();
  });

  describe("the quit's Radicle leg (0008: 10 s, under SHUTDOWN_WATCHDOG_MS's 20 s)", () => {
    function timers() {
      const set = [];
      return {
        set,
        setTimer: jest.fn((fn, ms) => {
          const timer = { fn, ms };
          set.push(timer);
          return timer;
        }),
        clearTimer: jest.fn((timer) => {
          const i = set.indexOf(timer);
          if (i >= 0) set.splice(i, 1);
        }),
      };
    }

    test("a stop that never ends: the leg ends 1 s after the service's 10 s kill", async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      await flush();
      const node = ctx.node();
      node.resolveStart(true);
      await started;
      node.autoStop = false;
      const clock = timers();
      let done = false;
      const leg = ctx.mod.stopRadicleAtQuit(clock).then((status) => {
        done = true;
        return status;
      });
      // rad.shutdown goes at once.
      expect(node.stopCalls).toBeGreaterThan(0);
      expect(clock.set.map((t) => t.ms)).toEqual([11_000]);
      await flush();
      expect(done).toBe(false);
      clock.set[0].fn();
      await expect(leg).resolves.toEqual({ status: 'stopping', error: null });
      const { SHUTDOWN_GRACE_MS } = jest.requireActual('./radicle/radicled-client');
      expect(SHUTDOWN_GRACE_MS + ctx.mod.QUIT_REAP_MS).toBe(11_000);
      expect(SHUTDOWN_GRACE_MS + ctx.mod.QUIT_REAP_MS).toBeLessThan(20_000);
    });

    test('a stop that ends: the leg ends with it, its timer cleared', async () => {
      const ctx = load();
      const started = ctx.mod.startRadicle();
      await flush();
      ctx.node().resolveStart(true);
      await started;
      const clock = timers();
      await expect(ctx.mod.stopRadicleAtQuit(clock)).resolves.toEqual({
        status: 'stopped',
        error: null,
      });
      expect(clock.set).toHaveLength(0);
      expect(clock.clearTimer).toHaveBeenCalledTimes(1);
    });

    test("the add-on's leg is today's stop, with no bound of its own", async () => {
      delete process.env.FREEDOM_RADICLE_BACKEND;
      const ctx = load();
      await ctx.mod.startRadicle();
      const clock = timers();
      await expect(ctx.mod.stopRadicleAtQuit(clock)).resolves.toEqual({
        status: 'stopped',
        error: null,
      });
      expect(clock.setTimer).not.toHaveBeenCalled();
      expect(ctx.embedded.shutdown).toHaveBeenCalledTimes(1);
    });
  });
});
