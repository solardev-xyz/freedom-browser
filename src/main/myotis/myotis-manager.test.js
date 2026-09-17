const path = require('path');
const IPC = require('../../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../../test/helpers/main-process-test-utils');

describe('myotis-manager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  function loadManager(mode = 'managed') {
    const clients = [];
    const existsSync = jest.fn(() => true);
    const clipboard = { writeText: jest.fn() };
    const profile = { id: 'profile-one', metadata: { nodes: { myotis: { mode } } } };
    const acquireCheckpoint = jest.fn((_chainId, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const store = {
      loadOrCreateState: jest.fn(async (baseDir) => ({ dataDir: path.join(baseDir, 'initial'), origin: 'bundled', checkpoint: null })),
      repairState: jest.fn(async (baseDir) => ({ dataDir: path.join(baseDir, 'repaired'), origin: 'bundled', checkpoint: null })),
      replaceCheckpoint: jest.fn(async (baseDir, _chainId, checkpoint) => ({ dataDir: path.join(baseDir, 'recovered'), origin: 'verified', checkpoint })),
    };
    const status = { running: true, paused: false, beaconState: 'SYNCED', elReaderAvailable: true, elHunting: false, snapPeers: 2 };
    // Tests that need to act inside the spawn window replace the resolved start
    // promise with one they release themselves.
    let startGate = null;
    class MockProcess {
      constructor(options) {
        this.options = options;
        this.checkpointSupported = true;
        this.accepting = true;
        this.exited = false;
        this.startPromise = startGate ? new Promise((resolve) => { startGate.release = resolve; }) : Promise.resolve(true);
        this.request = jest.fn(async (op) => {
          if (op === 'status') { options.onStatus(status); return status; }
          return { result: op };
        });
        this.stop = jest.fn(async () => {
          this.accepting = false;
          this.exited = true;
          options.onExit();
          return true;
        });
        clients.push(this);
      }
    }
    const ipcMain = createIpcMainMock();
    const frame = { url: require('url').pathToFileURL(path.resolve(__dirname, '../../renderer/index.html')).href };
    const sender = new (require('events').EventEmitter)();
    sender.mainFrame = frame;
    const event = { sender, senderFrame: frame };
    const win = { webContents: sender, isDestroyed: jest.fn(() => false) };
    const dialog = { showMessageBox: jest.fn(async () => ({ response: 0 })) };
    const BrowserWindow = { getAllWindows: () => [], fromWebContents: jest.fn(() => win) };
    const dataDir = path.join('/profile', 'myotis');
    const { mod } = loadMainModule(require.resolve('./myotis-manager'), {
      ipcMain, dialog, BrowserWindow, clipboard,
      extraMocks: {
        fs: () => ({ existsSync }),
        [require.resolve('./myotis-process')]: () => ({ MyotisProcess: MockProcess }),
        [require.resolve('./checkpoint-store')]: () => store,
        [require.resolve('./checkpoint-verifier')]: () => ({ acquireCheckpoint }),
        [require.resolve('../logger')]: () => ({ info: jest.fn(), warn: jest.fn() }),
        [require.resolve('../profile-paths')]: () => ({ getMyotisDataDir: (network) => path.join(dataDir, network) }),
        [require.resolve('../profile-resolver')]: () => ({
          getActiveProfile: () => profile,
        }),
        [require.resolve('../service-registry')]: () => ({
          MODE: { BUNDLED: 'bundled', DISABLED: 'disabled', NONE: 'none' }, updateService: jest.fn(),
        }),
      },
    });
    const gateStart = () => (startGate = {});
    return { mod, clients, dataDir, ipcMain, status, event, win, dialog, acquireCheckpoint, store, profile, existsSync, clipboard,
      gateStart, releaseStart: (value) => startGate.release(value) };
  }

  test('keeps independent chain processes and profile directories', async () => {
    const { mod, clients, dataDir } = loadManager();
    await expect(mod.startMyotis()).resolves.toBe(true);
    await expect(mod.startMyotis({ chainId: 100 })).resolves.toBe(true);
    expect(clients.map((client) => client.options.dataDir)).toEqual([
      path.join(dataDir, 'mainnet', 'initial'), path.join(dataDir, 'gnosis', 'initial'),
    ]);
    expect(mod.publicStatus()).toMatchObject({ state: 'ready', version: '0.1.10', abi: 26 });
    await mod.stopMyotis(100);
    expect(mod.publicStatus(100).state).toBe('off');
    expect(mod.isReady(1)).toBe(true);
  });

  test('status queries use cached snapshots and stale status removes readiness', async () => {
    const { mod, clients } = loadManager();
    await mod.startMyotis();
    const calls = clients[0].request.mock.calls.length;
    for (let i = 0; i < 100; i++) { mod.publicStatus(); mod.getStatus(); mod.isReady(); }
    expect(clients[0].request).toHaveBeenCalledTimes(calls);
    jest.setSystemTime(Date.now() + 6001);
    expect(mod.getStatus()).toBeNull();
    expect(mod.isReady()).toBe(false);
  });

  test('slow status keeps readiness until soft staleness, then recovers without replacing the pending request', async () => {
    const { mod, clients, status } = loadManager();
    await mod.startMyotis();
    const client = clients[0];
    let complete;
    client.request.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const epoch = mod.getAvailabilityEpoch();
    await jest.advanceTimersByTimeAsync(3500); // poll starts at 1s; reply latency is 2.5s
    expect(mod.isReady()).toBe(true);
    expect(mod.getAvailabilityEpoch()).toBe(epoch);
    expect(client.request).toHaveBeenLastCalledWith('status', [], 10000);
    client.options.onStatus(status); complete(status);
    await jest.advanceTimersByTimeAsync(1);

    // The next poll occupies its one slot past freshness. Routing becomes
    // unavailable honestly, while native admission and the generation survive.
    await jest.advanceTimersByTimeAsync(6000);
    expect(mod.isReady()).toBe(false);
    const calls = client.request.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(client.request).toHaveBeenCalledTimes(calls);
    expect(client.accepting).toBe(true);
    expect(client.stop).not.toHaveBeenCalled();
    client.options.onStatus(status); complete(status);
    await Promise.resolve();
    expect(mod.isReady()).toBe(true);
    expect(clients).toHaveLength(1);
  });

  test.each([
    { running: false }, { paused: true }, { beaconState: 'STALE_ANCHOR' },
    { beaconState: 'CATCHING_UP' }, { elReaderAvailable: false }, { snapPeers: 0 }, { elHunting: true },
  ])('does not serve a started but unavailable native lifecycle: %s', async (change) => {
    const { mod, clients, status } = loadManager();
    await mod.startMyotis();
    clients[0].options.onStatus({ ...status, ...change, bootstrapped: true });
    expect(mod.isReady()).toBe(false);
    expect(clients[0].request.mock.calls.every(([op]) => op === 'status')).toBe(true);
  });

  test('does not create any process when disabled', async () => {
    const { mod, clients } = loadManager('disabled');
    await expect(mod.startMyotis()).resolves.toBe(false);
    expect(clients).toHaveLength(0);
    expect(mod.publicStatus().state).toBe('disabled');
  });

  test('does not restart before exit, or admit work after shutdown starts', async () => {
    const { mod, clients } = loadManager();
    await mod.startMyotis();
    clients[0].stop.mockImplementation(async () => { clients[0].accepting = false; return false; });
    await expect(mod.stopMyotis()).resolves.toBe(false);
    await expect(mod.startMyotis()).resolves.toBe(false);
    expect(mod.publicStatus()).toMatchObject({
      state: 'error', error: 'Myotis exit unconfirmed; restart blocked', running: false,
    });
    expect(clients).toHaveLength(1);
    const shutdown = mod.stopAllMyotis({ shutdown: true });
    await expect(mod.startMyotis({ chainId: 100 })).resolves.toBe(false);
    await expect(mod.ethCall({ to: '0xabc' })).rejects.toThrow('not running');
    await shutdown;
  });

  test('invalidates availability before requesting stop and applies recovery cooldown', async () => {
    const { mod, clients } = loadManager();
    const events = [];
    mod.onAvailabilityTransition((event) => events.push(event));
    await mod.startMyotis();
    clients[0].options.onUnavailable('timed out');
    clients[0].accepting = false;
    clients[0].exited = true;
    clients[0].options.onExit();
    expect(events.at(-1).ready).toBe(false);
    await expect(mod.startMyotis()).resolves.toBe(false);
    jest.setSystemTime(Date.now() + 15001);
    await expect(mod.startMyotis()).resolves.toBe(true);
    expect(clients).toHaveLength(2);
  });

  test('registers existing start, stop and cached status IPC', async () => {
    const { mod, ipcMain } = loadManager();
    mod.registerMyotisIpc();
    await expect(ipcMain.invoke(IPC.MYOTIS_START)).resolves.toMatchObject({ running: true });
    await expect(ipcMain.invoke(IPC.MYOTIS_STOP)).resolves.toMatchObject({ state: 'off' });
    await expect(ipcMain.invoke(IPC.MYOTIS_GET_STATUS)).resolves.toMatchObject({ state: 'off' });
  });

  test('sends only operation arguments, including already-signed broadcasts', async () => {
    const { mod, clients } = loadManager();
    await mod.startMyotis({ chainId: 100 });
    await mod.getAccount('0xabc', 100);
    await mod.ethCall({ to: '0xdef', chainId: 100 });
    await mod.estimateGas({ to: '0xdef', chainId: 100 });
    await mod.feeEstimate(100);
    await mod.sendRawTransaction('0xsigned', 100);
    await mod.resolveEnsRecord({ method: 'text', name: 'alice.eth', key: 'url' }, 100);
    expect(clients[0].request.mock.calls).toEqual(expect.arrayContaining([
      ['account', ['0xabc']], ['call', ['', '0xdef', '0x', '0', 'latest']],
      ['gas', ['', '0xdef', '0x', '0']], ['fee', []], ['broadcast', ['0xsigned']],
      ['ens', [JSON.stringify({ method: 'text', name: 'alice.eth', key: 'url' })]],
    ]));
  });
  const checkpoint = { schemaVersion: 1, chainId: 100, network: 'gnosis', root: '0x' + 'ab'.repeat(32), slot: 30000000 };
  const flush = () => jest.advanceTimersByTimeAsync(0);
  async function parked() {
    const ctx = loadManager();
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.mod.registerMyotisIpc();
    ctx.retry = (event = ctx.event) => ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(event, 100);
    return ctx;
  }

  test('automatically verifies stale anchors and restarts in a fresh owned generation', async () => {
    const ctx = await parked();
    expect(ctx.mod.publicStatus(100)).toMatchObject({ running: true, state: 'recovering', recovery: { phase: 'checking' } });
    expect(ctx.acquireCheckpoint).toHaveBeenCalledWith(100, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await ctx.mod.stopMyotis(100);
    ctx.acquireCheckpoint.mockResolvedValue(checkpoint);
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.status.beaconState = 'BOOTSTRAPPING';
    await flush();
    expect(ctx.store.replaceCheckpoint).toHaveBeenCalledWith(path.join(ctx.dataDir, 'gnosis'), 100, checkpoint);
    const replacement = ctx.clients.at(-1);
    expect(replacement.options).toMatchObject({ checkpoint, dataDir: path.join(ctx.dataDir, 'gnosis', 'recovered') });
    expect(ctx.clients.at(-2).exited).toBe(true);
    expect(ctx.mod.isReady(100)).toBe(false);
    replacement.options.onStatus({ ...ctx.status, beaconState: 'SYNCED', finalizedSlot: checkpoint.slot, finalizedRootHex: checkpoint.root.slice(2) });
    expect(ctx.mod.isReady(100)).toBe(true);
    expect(ctx.mod.publicStatus(100).recovery).toBeUndefined();
    expect(ctx.dialog.showMessageBox).not.toHaveBeenCalled();
    for (const client of ctx.clients) expect(client.request).not.toHaveBeenCalledWith('accept-stale-anchor');
  });

  test('never publishes new state while native exit is unconfirmed', async () => {
    const ctx = loadManager();
    let resolveProof;
    ctx.acquireCheckpoint.mockImplementation(() => new Promise(resolve => { resolveProof = resolve; }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].stop.mockResolvedValue(false);
    resolveProof(checkpoint); await flush();
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
    expect(ctx.clients).toHaveLength(1);
    expect(ctx.mod.publicStatus(100)).toMatchObject({ state: 'recovery-blocked', recovery: { reason: 'ownership' } });
  });

  test.each(['stop', 'profile-change'])('late checkpoint verification cannot start a node after %s', async (change) => {
    const ctx = loadManager();
    let resolveProof;
    ctx.acquireCheckpoint.mockImplementation(() => new Promise(resolve => { resolveProof = resolve; }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 });
    const stopping = change === 'stop' ? ctx.mod.stopMyotis(100) : Promise.resolve();
    if (change === 'profile-change') ctx.profile.id = 'another-profile';
    resolveProof(checkpoint); await stopping; await flush();
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
    expect(ctx.clients).toHaveLength(1);
  });

  test('native anchor mismatch exposes a storage block and never starts automatic recovery', async () => {
    const ctx = loadManager();
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].options.onUnavailable('bounded error', 'CHECKPOINT_STORAGE');
    expect(ctx.mod.publicStatus(100)).toMatchObject({ state: 'recovery-blocked', recovery: { reason: 'storage' } });
    expect(ctx.mod.isReady(100)).toBe(false);
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
  });

  test.each(['CHECKPOINT_UNAVAILABLE', 'CHECKPOINT_QUORUM_UNAVAILABLE'])('retries %s twice, then waits for an explicit trusted retry', async (code) => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockRejectedValue(Object.assign(new Error('offline'), { code }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'waiting', attempt: 1 });
    await jest.advanceTimersByTimeAsync(15000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(3);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'blocked', canRetry: true });
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(3);
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(4);
    await ctx.mod.stopMyotis(100);
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(4);
    expect(ctx.mod.publicStatus(100).state).toBe('off');
  });

  test.each([['CHECKPOINT_MISMATCH', 'mismatch'], ['CHECKPOINT_QUORUM_CONFLICT', 'quorum-conflict']])('evidence %s stays blocked without automatic retries or a risk bypass', async (code, reason) => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockRejectedValue(Object.assign(new Error('invalid'), { code }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'blocked', reason });
    await expect(ctx.mod.getAccount('0xabc', 100)).rejects.toThrow('not ready');
  });

  test('privileged retry rejects pages and subframes', async () => {
    const ctx = await parked();
    expect(() => ctx.retry({ ...ctx.event, senderFrame: { ...ctx.event.senderFrame } })).toThrow('Nodes menu');
    ctx.event.senderFrame.url = 'https://example.com';
    expect(() => ctx.retry()).toThrow('Nodes menu');
    await ctx.mod.stopMyotis(100);
  });

  test('resumes only the checkpoint and generation selected by persistent storage', async () => {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockResolvedValue({ origin: 'verified', checkpoint, dataDir: '/owned-generation' });
    ctx.status.finalizedSlot = checkpoint.slot;
    ctx.status.finalizedRootHex = checkpoint.root.slice(2);
    await ctx.mod.startMyotis({ chainId: 100 });
    expect(ctx.clients[0].options).toMatchObject({ dataDir: '/owned-generation', checkpoint });
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    expect(ctx.mod.isReady(100)).toBe(true);
  });

  test('discards a read result completed after recovery revoked its availability epoch', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    let resolveRead;
    ctx.clients[0].request.mockImplementation(op => op === 'account'
      ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve(ctx.status));
    const pending = ctx.mod.getAccount('0xabc', 100);
    ctx.clients[0].options.onStatus({ ...ctx.status, beaconState: 'STALE_ANCHOR' });
    resolveRead({ balance: '123' });
    await expect(pending).rejects.toMatchObject({ code: 'MYOTIS_UNAVAILABLE' });
    await ctx.mod.stopMyotis(100);
  });

  test('an older addon reports update required instead of attempting an unsafe fallback', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].checkpointSupported = false;
    ctx.clients[0].options.onStatus({ ...ctx.status, beaconState: 'STALE_ANCHOR' });
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ reason: 'unsupported', phase: 'blocked' });
  });

  test('waiting retries remain progress rather than terminal failure', async () => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockRejectedValue(Object.assign(new Error('offline'), { code: 'CHECKPOINT_UNAVAILABLE' }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    expect(ctx.mod.publicStatus(100)).toMatchObject({ state: 'recovering', recovery: { phase: 'waiting' } });
    await ctx.mod.stopMyotis(100);
  });

  test('an imported checkpoint that remains stale cannot wait forever', async () => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockResolvedValue(checkpoint);
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'waiting', reason: 'stale' });
    expect(ctx.mod.isReady(100)).toBe(false);
    await ctx.mod.stopMyotis(100);
  });

  test('stalled execution sync stays visible until the verified reader recovers', async () => {
    const ctx = loadManager();
    ctx.status.elReaderAvailable = false;
    await ctx.mod.startMyotis({ chainId: 100 });
    await jest.advanceTimersByTimeAsync(300000);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'blocked', reason: 'stalled' });
    ctx.clients[0].options.onStatus(ctx.status);
    expect(ctx.mod.publicStatus(100).recovery.reason).toBe('stalled');
    ctx.status.elReaderAvailable = true;
    ctx.clients[0].options.onStatus(ctx.status);
    expect(ctx.mod.publicStatus(100).state).toBe('ready');
  });

  test('cached readiness is revoked immediately when active profile changes', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis();
    expect(ctx.mod.isReady()).toBe(true);
    ctx.profile.id = 'another-profile';
    expect(ctx.mod.getStatus()).toBeNull();
    expect(ctx.mod.isReady()).toBe(false);
    await expect(ctx.mod.getAccount('0xabc')).rejects.toThrow('not ready');
  });

  test('unknown legacy ownership blocks migration with an actionable status', async () => {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockRejectedValue(Object.assign(new Error('owner unknown'), { code: 'CHECKPOINT_OWNERSHIP' }));
    await expect(ctx.mod.startMyotis({ chainId: 100 })).resolves.toBe(false);
    expect(ctx.clients).toHaveLength(0);
    expect(ctx.mod.publicStatus(100)).toMatchObject({ running: true, state: 'recovery-blocked', recovery: { reason: 'ownership', canRetry: true } });
    expect(ctx.mod.isReady(100)).toBe(false);
    await ctx.mod.stopMyotis(100);
    expect(ctx.mod.publicStatus(100).state).toBe('off');
  });

  test('checkpoint retry cannot bypass unresolved generation ownership', async () => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockResolvedValue(checkpoint);
    ctx.store.replaceCheckpoint.mockRejectedValue(Object.assign(new Error('owner unknown'), { code: 'CHECKPOINT_OWNERSHIP' }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    expect(ctx.clients).toHaveLength(1);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'blocked', reason: 'ownership' });
    expect(ctx.mod.isReady(100)).toBe(false);
    await ctx.mod.stopMyotis(100);
  });

  test('a verified exit after the stop deadline permits a later start', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis();
    const old = ctx.clients[0];
    old.stop.mockImplementation(async () => { old.accepting = false; return false; });
    await expect(ctx.mod.stopMyotis()).resolves.toBe(false);
    await expect(ctx.mod.startMyotis()).resolves.toBe(false);
    old.exited = true; old.options.onExit();
    expect(ctx.mod.publicStatus().state).toBe('off');
    await expect(ctx.mod.startMyotis()).resolves.toBe(true);
    expect(ctx.clients).toHaveLength(2);
  });

  test.each(['startup', 'stalled'])('%s retry preserves the authenticated generation without a checkpoint request', async (reason) => {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockResolvedValue({ origin: 'verified', checkpoint, dataDir: '/owned-generation' });
    ctx.status.finalizedSlot = checkpoint.slot;
    ctx.status.finalizedRootHex = checkpoint.root.slice(2);
    if (reason === 'stalled') ctx.status.elReaderAvailable = false;
    await ctx.mod.startMyotis({ chainId: 100 });
    if (reason === 'startup') ctx.clients[0].options.onUnavailable('native failure');
    else await jest.advanceTimersByTimeAsync(300000);
    expect(ctx.mod.publicStatus(100).recovery.reason).toBe(reason);
    ctx.status.elReaderAvailable = true;
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    expect(ctx.clients).toHaveLength(2);
    expect(ctx.clients[1].options).toMatchObject({ dataDir: '/owned-generation', checkpoint });
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
    expect(ctx.mod.isReady(100)).toBe(true);
  });

  test('ordinary retry starts checkpoint verification only if the retained native state is stale', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].options.onUnavailable('native failure');
    ctx.status.beaconState = 'STALE_ANCHOR';
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'checking', attempt: 1 });
    await ctx.mod.stopMyotis(100);
  });

  test('stop during owned-state reload prevents a late successor', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    let resolveLoad;
    ctx.store.loadOrCreateState.mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
    ctx.clients[0].options.onUnavailable('native failure');
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    const stopping = ctx.mod.stopMyotis(100);
    resolveLoad({ dataDir: '/owned-generation', checkpoint });
    await stopping; await flush();
    expect(ctx.clients).toHaveLength(1);
    expect(ctx.mod.publicStatus(100).state).toBe('off');
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
  });

  test('ordinary retry remains blocked until the previous native child is confirmed stopped', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].options.onUnavailable('native failure');
    ctx.clients[0].stop.mockResolvedValue(false);
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ reason: 'ownership', phase: 'blocked' });
    expect(ctx.store.loadOrCreateState).toHaveBeenCalledTimes(1);
    expect(ctx.clients).toHaveLength(1);
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
  });

  test('a slowly syncing node automatically recovers when its anchor later expires', async () => {
    const ctx = loadManager(); ctx.status.elReaderAvailable = false;
    await ctx.mod.startMyotis({ chainId: 100 });
    await jest.advanceTimersByTimeAsync(300000);
    expect(ctx.mod.publicStatus(100).recovery.reason).toBe('stalled');
    ctx.status.beaconState = 'STALE_ANCHOR';
    ctx.clients[0].options.onStatus(ctx.status);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'checking', attempt: 1 });
    expect(ctx.mod.isReady(100)).toBe(false);
    await ctx.mod.stopMyotis(100);
  });

  test('missing addon and load incompatibility offer installation help without retrying proofs', async () => {
    const ctx = loadManager(); ctx.existsSync.mockReturnValue(false);
    await expect(ctx.mod.startMyotis()).resolves.toBe(false);
    expect(ctx.mod.publicStatus()).toMatchObject({ state: 'unavailable', recovery: { reason: 'installation', canRetry: false } });
    expect(ctx.clients).toHaveLength(0);
    ctx.existsSync.mockReturnValue(true);
    await ctx.mod.startMyotis();
    ctx.clients[0].options.onUnavailable('bounded error', 'CHECKPOINT_INSTALLATION');
    expect(ctx.mod.publicStatus()).toMatchObject({ state: 'recovery-blocked', recovery: { reason: 'installation', canRetry: false } });
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
  });

  test('recovery advertises a quiet notice after one minute and clears it on stop', async () => {
    const ctx = await parked();
    expect(ctx.mod.publicStatus(100).recovery.takingLonger).toBe(false);
    await jest.advanceTimersByTimeAsync(59999);
    expect(ctx.mod.publicStatus(100).recovery.takingLonger).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(ctx.mod.publicStatus(100).recovery.takingLonger).toBe(true);
    await ctx.mod.stopMyotis(100);
    await jest.advanceTimersByTimeAsync(60000);
    expect(ctx.mod.publicStatus(100).recovery).toBeUndefined();
  });

  test('slow notice counts time across automatic retry delays, then resets on manual retry', async () => {
    const ctx = loadManager();
    ctx.acquireCheckpoint.mockRejectedValue(Object.assign(new Error('offline'), { code: 'CHECKPOINT_UNAVAILABLE' }));
    ctx.status.beaconState = 'STALE_ANCHOR';
    await ctx.mod.startMyotis({ chainId: 100 }); await flush();
    await jest.advanceTimersByTimeAsync(60000);
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'waiting', takingLonger: true });
    await jest.advanceTimersByTimeAsync(15000);
    expect(ctx.mod.publicStatus(100).recovery.phase).toBe('blocked');
    ctx.mod.registerMyotisIpc();
    ctx.ipcMain.handlers.get(IPC.MYOTIS_RETRY_CHECKPOINT)(ctx.event, 100); await flush();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ phase: 'waiting', takingLonger: false });
    await ctx.mod.stopMyotis(100);
  });

  async function brokenStorage() {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockRejectedValue(Object.assign(new Error('bad record'), { code: 'CHECKPOINT_STORAGE' }));
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.mod.registerMyotisIpc();
    ctx.repair = (event = ctx.event) => ctx.ipcMain.handlers.get(IPC.MYOTIS_REPAIR_SYNC_DATA)(event, 100);
    return ctx;
  }

  test('repair is confirmed, single flight, and stale replacement still requires checkpoint verification', async () => {
    const ctx = await brokenStorage();
    let confirm;
    ctx.dialog.showMessageBox.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const first = ctx.repair();
    await ctx.repair();
    expect(ctx.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(ctx.store.repairState).not.toHaveBeenCalled();
    ctx.status.beaconState = 'STALE_ANCHOR';
    confirm({ response: 1 }); await first; await flush();
    expect(ctx.store.repairState).toHaveBeenCalledTimes(1);
    expect(ctx.clients[0].options).toMatchObject({ checkpoint: null, dataDir: path.join(ctx.dataDir, 'gnosis', 'repaired') });
    await jest.advanceTimersByTimeAsync(1000);
    expect(ctx.acquireCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.mod.isReady(100)).toBe(false);
    await ctx.mod.stopMyotis(100);
  });

  test.each(['cancel', 'stop', 'profile-change', 'navigation'])('repair does not mutate storage after %s during confirmation', async (action) => {
    const ctx = await brokenStorage();
    let confirm;
    ctx.dialog.showMessageBox.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const pending = ctx.repair();
    if (action === 'stop') await ctx.mod.stopMyotis(100);
    if (action === 'profile-change') ctx.profile.id = 'new-profile';
    if (action === 'navigation') ctx.event.senderFrame.url = 'https://example.com';
    confirm({ response: action === 'cancel' ? 0 : 1 }); await pending; await flush();
    expect(ctx.store.repairState).not.toHaveBeenCalled();
    expect(ctx.clients).toHaveLength(0);
  });

  test('repair never replaces storage while its native child has unconfirmed exit', async () => {
    const ctx = loadManager(); await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].options.onUnavailable('mismatch', 'CHECKPOINT_STORAGE');
    ctx.clients[0].stop.mockResolvedValue(false);
    ctx.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    ctx.mod.registerMyotisIpc();
    await ctx.ipcMain.handlers.get(IPC.MYOTIS_REPAIR_SYNC_DATA)(ctx.event, 100); await flush();
    expect(ctx.store.repairState).not.toHaveBeenCalled();
    expect(ctx.mod.publicStatus(100).recovery.reason).toBe('ownership');
  });

  test('repair failures stay actionable and cannot become verified reads', async () => {
    const ctx = await brokenStorage();
    ctx.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    ctx.store.repairState.mockRejectedValue(Object.assign(new Error('disk full'), { code: 'CHECKPOINT_STORAGE_IO' }));
    await ctx.repair(); await flush();
    expect(ctx.mod.publicStatus(100).recovery).toMatchObject({ reason: 'storage-io', canRetry: true });
    expect(ctx.clients).toHaveLength(0);
    expect(ctx.mod.isReady(100)).toBe(false);
  });

  test.each([IPC.MYOTIS_REPAIR_SYNC_DATA, IPC.MYOTIS_RECOVERY_HELP])('%s rejects pages and subframes', async channel => {
    const ctx = await brokenStorage();
    const handler = ctx.ipcMain.handlers.get(channel);
    await expect(handler({ ...ctx.event, senderFrame: { ...ctx.event.senderFrame } }, 100)).rejects.toThrow('Nodes menu');
    ctx.event.senderFrame.url = 'https://example.com';
    await expect(handler(ctx.event, 100)).rejects.toThrow('Nodes menu');
    expect(ctx.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(ctx.store.repairState).not.toHaveBeenCalled();
  });

  // The authenticated checkpoint binds the finalized root at exactly its anchor
  // slot. Nothing below may be served as a verified read.
  async function resumed(change) {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockResolvedValue({ origin: 'verified', checkpoint, dataDir: '/owned-generation' });
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.clients[0].options.onStatus({
      ...ctx.status, beaconState: 'SYNCED',
      finalizedSlot: checkpoint.slot, finalizedRootHex: checkpoint.root.slice(2), ...change,
    });
    return ctx;
  }

  test.each([
    ['a finalized head below the anchor', { finalizedSlot: checkpoint.slot - 32 }],
    ['an absent finalized root', { finalizedRootHex: undefined }],
    ['a malformed finalized root', { finalizedRootHex: 'zz'.repeat(32) }],
    ['a non-integer finalized slot', { finalizedSlot: String(checkpoint.slot) }],
    ['a missing finalized slot', { finalizedSlot: undefined }],
  ])('never reports readiness for %s', async (_label, change) => {
    const ctx = await resumed(change);
    expect(ctx.mod.isReady(100)).toBe(false);
    await expect(ctx.mod.getAccount('0xabc', 100)).rejects.toThrow('not ready');
    await ctx.mod.stopMyotis(100);
  });

  test('a finalized head past the anchor slot is served without rebinding its root', async () => {
    const ctx = await resumed({ finalizedSlot: checkpoint.slot + 32, finalizedRootHex: 'cd'.repeat(32) });
    expect(ctx.mod.isReady(100)).toBe(true);
    await ctx.mod.stopMyotis(100);
  });

  test('a divergent finalized root at the anchor slot blocks recovery instead of serving reads', async () => {
    const ctx = await resumed({ finalizedRootHex: 'cd'.repeat(32) });
    expect(ctx.mod.publicStatus(100)).toMatchObject({ state: 'recovery-blocked', recovery: { phase: 'blocked', reason: 'mismatch' } });
    expect(ctx.mod.isReady(100)).toBe(false);
    await expect(ctx.mod.getAccount('0xabc', 100)).rejects.toThrow('not ready');
    await jest.advanceTimersByTimeAsync(120000);
    expect(ctx.acquireCheckpoint).not.toHaveBeenCalled();
    expect(ctx.store.replaceCheckpoint).not.toHaveBeenCalled();
    await ctx.mod.stopMyotis(100);
  });

  test('a profile change during the spawn window stops the orphaned native child', async () => {
    const ctx = loadManager();
    ctx.gateStart();
    const starting = ctx.mod.startMyotis({ chainId: 100 });
    await flush();
    expect(ctx.clients).toHaveLength(1);
    expect(ctx.clients[0].stop).not.toHaveBeenCalled();
    ctx.profile.id = 'another-profile';
    ctx.releaseStart(true);
    await expect(starting).resolves.toBe(false);
    expect(ctx.clients[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.mod.isReady(100)).toBe(false);
  });

  test('ownership help copies only bounded support details on explicit action', async () => {
    const ctx = loadManager();
    ctx.store.loadOrCreateState.mockRejectedValue(Object.assign(new Error('secret path'), { code: 'CHECKPOINT_OWNERSHIP' }));
    await ctx.mod.startMyotis({ chainId: 100 });
    ctx.mod.registerMyotisIpc();
    const help = ctx.ipcMain.handlers.get(IPC.MYOTIS_RECOVERY_HELP);
    await help(ctx.event, 100);
    expect(ctx.clipboard.writeText).not.toHaveBeenCalled();
    ctx.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    await help(ctx.event, 100);
    const details = ctx.clipboard.writeText.mock.calls[0][0];
    expect(details).toContain('Failure: ownership');
    expect(details).not.toMatch(/secret|profile|\/Users/);
    expect(ctx.dialog.showMessageBox.mock.calls[0][1].detail).toContain('cannot clear an unconfirmed ownership record');
    expect(ctx.store.repairState).not.toHaveBeenCalled();
  });

});
