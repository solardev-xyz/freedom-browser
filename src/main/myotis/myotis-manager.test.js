const path = require('path');
const IPC = require('../../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../../test/helpers/main-process-test-utils');

describe('myotis-manager', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  function loadManager(mode = 'managed') {
    const clients = [];
    const status = { beaconState: 'SYNCED', elReaderAvailable: true, elHunting: false, snapPeers: 2 };
    class MockProcess {
      constructor(options) {
        this.options = options;
        this.accepting = true;
        this.exited = false;
        this.startPromise = Promise.resolve(true);
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
    const dataDir = path.join('/profile', 'myotis');
    const { mod } = loadMainModule(require.resolve('./myotis-manager'), {
      ipcMain,
      extraMocks: {
        fs: () => ({ existsSync: () => true }),
        [require.resolve('./myotis-process')]: () => ({ MyotisProcess: MockProcess }),
        [require.resolve('../logger')]: () => ({ info: jest.fn(), warn: jest.fn() }),
        [require.resolve('../profile-paths')]: () => ({ getMyotisDataDir: (network) => path.join(dataDir, network) }),
        [require.resolve('../profile-resolver')]: () => ({
          getActiveProfile: () => ({ metadata: { nodes: { myotis: { mode } } } }),
        }),
        [require.resolve('../service-registry')]: () => ({
          MODE: { BUNDLED: 'bundled', DISABLED: 'disabled', NONE: 'none' }, updateService: jest.fn(),
        }),
      },
    });
    return { mod, clients, dataDir, ipcMain, status };
  }

  test('keeps independent chain processes and profile directories', async () => {
    const { mod, clients, dataDir } = loadManager();
    await expect(mod.startMyotis()).resolves.toBe(true);
    await expect(mod.startMyotis({ chainId: 100 })).resolves.toBe(true);
    expect(clients.map((client) => client.options.dataDir)).toEqual([
      path.join(dataDir, 'mainnet'), path.join(dataDir, 'gnosis'),
    ]);
    expect(mod.publicStatus()).toMatchObject({ state: 'ready', version: '0.1.7' });
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
    jest.setSystemTime(Date.now() + 3001);
    expect(mod.getStatus()).toBeNull();
    expect(mod.isReady()).toBe(false);
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
      ['gas', ['', '0xdef', '0x', '0']], ['fee'], ['broadcast', ['0xsigned']],
      ['ens', [JSON.stringify({ method: 'text', name: 'alice.eth', key: 'url' })]],
    ]));
  });
});
