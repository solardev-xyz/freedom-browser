const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../../test/helpers/main-process-test-utils');

describe('myotis-manager', () => {
  let tempDir;
  let originalNodePath;
  let originalDataDir;

  beforeEach(() => {
    jest.useFakeTimers();
    originalNodePath = process.env.MYOTIS_NODE_PATH;
    originalDataDir = process.env.MYOTIS_DATA_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-myotis-manager-'));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalNodePath === undefined) delete process.env.MYOTIS_NODE_PATH;
    else process.env.MYOTIS_NODE_PATH = originalNodePath;
    if (originalDataDir === undefined) delete process.env.MYOTIS_DATA_DIR;
    else process.env.MYOTIS_DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function loadManager(options = {}) {
    const addonPath = path.join(tempDir, 'myotis-addon.js');
    fs.writeFileSync(addonPath, 'module.exports = {};');
    process.env.MYOTIS_NODE_PATH = addonPath;

    const status = options.status || {
      beaconState: 'SYNCED',
      elReaderAvailable: true,
      elHunting: false,
      snapPeers: 2,
      peerCount: 5,
      finalizedBlockNumber: '1234',
    };
    const addon = {
      init: jest.fn(() => options.abi ?? 22),
      create: jest.fn(() => options.handle ?? 7),
      start: jest.fn(() => options.starts !== false),
      stop: jest.fn(),
      drainLogs: jest.fn(() => ''),
      statusJson: jest.fn(() => JSON.stringify(status)),
      ensRecordJson: jest.fn(),
      resolveEnsJson: jest.fn(),
      ethCallJson: jest.fn(),
      requestAccountJson: jest.fn(),
      estimateGasJson: jest.fn(),
      feeEstimateJson: jest.fn(),
      sendRawTransactionJson: jest.fn(),
    };
    const activeProfile = {
      metadata: {
        nodes: {
          myotis: { mode: options.mode || 'managed', backend: 'myotis-native' },
        },
      },
    };
    const updateService = jest.fn();
    const ipcMain = createIpcMainMock();
    const window = { webContents: { send: jest.fn() } };
    const dataDir = path.join(tempDir, 'profile', 'myotis');

    const { mod } = loadMainModule(require.resolve('./myotis-manager'), {
      ipcMain,
      windows: [window],
      extraMocks: {
        [addonPath]: () => addon,
        [require.resolve('../logger')]: () => ({ info: jest.fn(), warn: jest.fn() }),
        [require.resolve('../profile-paths')]: () => ({
          getMyotisDataDir: jest.fn((network) =>
            network === 'gnosis' ? path.join(dataDir, 'gnosis') : dataDir
          ),
        }),
        [require.resolve('../profile-resolver')]: () => ({
          getActiveProfile: jest.fn(() => activeProfile),
        }),
        [require.resolve('../service-registry')]: () => ({
          MODE: { BUNDLED: 'bundled', DISABLED: 'disabled', NONE: 'none' },
          updateService,
        }),
      },
    });

    return { addon, dataDir, ipcMain, mod, updateService, window };
  }

  test('starts an isolated native client in the active profile data directory', () => {
    const ctx = loadManager();

    expect(ctx.mod.startMyotis()).toBe(true);
    expect(ctx.addon.create).toHaveBeenCalledWith('mainnet', ctx.dataDir);
    expect(ctx.addon.start).toHaveBeenCalledWith(7);
    expect(ctx.mod.publicStatus()).toMatchObject({
      available: true,
      running: true,
      state: 'ready',
      version: '0.1.7',
      peerCount: 5,
      finalizedBlockNumber: '1234',
    });
    expect(ctx.updateService).toHaveBeenCalledWith(
      'myotis',
      expect.objectContaining({ mode: 'bundled' })
    );

    ctx.mod.stopMyotis();
    expect(ctx.addon.stop).toHaveBeenCalledWith(7);
  });

  test('runs Ethereum and Gnosis as independent native handles and data directories', () => {
    const ctx = loadManager();
    ctx.addon.create.mockReturnValueOnce(7).mockReturnValueOnce(8);

    expect(ctx.mod.startMyotis()).toBe(true);
    expect(ctx.mod.startMyotis({ chainId: 100 })).toBe(true);
    expect(ctx.addon.create).toHaveBeenNthCalledWith(1, 'mainnet', ctx.dataDir);
    expect(ctx.addon.create).toHaveBeenNthCalledWith(2, 'gnosis', path.join(ctx.dataDir, 'gnosis'));
    expect(ctx.mod.publicStatus(1)).toMatchObject({ chainId: 1, network: 'mainnet', running: true });
    expect(ctx.mod.publicStatus(100)).toMatchObject({ chainId: 100, network: 'gnosis', running: true });

    ctx.mod.stopMyotis(100);
    expect(ctx.addon.stop).toHaveBeenCalledWith(8);
    expect(ctx.mod.publicStatus(1).running).toBe(true);
    expect(ctx.mod.publicStatus(100).running).toBe(false);
  });

  test('publishes warm-up, ready, peer-loss, and stopping availability transitions', () => {
    const status = {
      beaconState: 'SYNCING',
      elReaderAvailable: false,
      elHunting: true,
      snapPeers: 0,
      peerCount: 0,
    };
    const ctx = loadManager({ status });
    const events = [];
    ctx.mod.onAvailabilityTransition((event) => events.push({
      ...event,
      nativeStopCalled: ctx.addon.stop.mock.calls.length > 0,
    }));

    ctx.mod.startMyotis();
    expect(events).toEqual([
      expect.objectContaining({ ready: false, reason: 'starting', epoch: 1 }),
    ]);

    Object.assign(status, {
      beaconState: 'SYNCED',
      elReaderAvailable: true,
      elHunting: false,
      snapPeers: 1,
      peerCount: 2,
    });
    jest.advanceTimersByTime(1000);
    expect(events).toContainEqual(
      expect.objectContaining({ ready: true, reason: 'ready', epoch: 2 })
    );

    status.snapPeers = 0;
    jest.advanceTimersByTime(1000);
    expect(events).toContainEqual(
      expect.objectContaining({ ready: false, reason: 'not-ready', epoch: 3 })
    );

    status.snapPeers = 1;
    jest.advanceTimersByTime(1000);
    ctx.mod.stopMyotis();
    expect(events.at(-1)).toMatchObject({
      ready: false,
      reason: 'stopping',
      nativeStopCalled: false,
    });
    expect(ctx.mod.isReady()).toBe(false);
    expect(ctx.mod.getAvailabilityEpoch()).toBe(events.at(-1).epoch);
  });

  test('does not load or start the addon when the profile disables Myotis', () => {
    const ctx = loadManager({ mode: 'disabled' });

    expect(ctx.mod.isEnabled()).toBe(false);
    expect(ctx.mod.startMyotis()).toBe(false);
    expect(ctx.addon.init).not.toHaveBeenCalled();
    expect(ctx.mod.publicStatus()).toMatchObject({ running: false, state: 'disabled' });
    expect(ctx.updateService).toHaveBeenCalledWith(
      'myotis',
      expect.objectContaining({ mode: 'disabled' })
    );
  });

  test('registers start, stop, status, and status-update IPC', async () => {
    const ctx = loadManager();
    ctx.mod.registerMyotisIpc();

    await expect(ctx.ipcMain.invoke(IPC.MYOTIS_START)).resolves.toMatchObject({
      running: true,
      state: 'ready',
    });
    await expect(ctx.ipcMain.invoke(IPC.MYOTIS_STOP)).resolves.toMatchObject({
      running: false,
      state: 'off',
    });
    await expect(ctx.ipcMain.invoke(IPC.MYOTIS_GET_STATUS)).resolves.toMatchObject({
      running: false,
      state: 'off',
    });
    expect(ctx.window.webContents.send).toHaveBeenCalledWith(
      IPC.MYOTIS_STATUS_UPDATE,
      expect.any(Object)
    );
  });

  test('refuses an incompatible native ABI', () => {
    const ctx = loadManager({ abi: 20 });

    expect(ctx.mod.startMyotis()).toBe(false);
    expect(ctx.addon.create).not.toHaveBeenCalled();
    expect(ctx.mod.publicStatus()).toMatchObject({
      running: false,
      state: 'error',
      error: 'ABI mismatch: engine 20, expected 22',
    });
  });

  test('dispatches generic ENS records, convenience reads, and reverse lookups', async () => {
    const ctx = loadManager();
    ctx.mod.startMyotis();
    ctx.addon.ensRecordJson
      .mockResolvedValueOnce(JSON.stringify({ status: 'ok', value: 'https://example' }))
      .mockResolvedValueOnce(JSON.stringify({ status: 'ok', dataHex: '0x1234' }))
      .mockResolvedValueOnce(
        JSON.stringify({
          status: 'ok',
          addressHex: '0x1111111111111111111111111111111111111111',
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ status: 'ok', name: 'alice.eth' }));

    await expect(
      ctx.mod.resolveEnsRecord({ method: 'text', name: 'alice.eth', key: 'url' })
    ).resolves.toMatchObject({ status: 'ok', value: 'https://example' });
    await expect(ctx.mod.resolveContenthash('alice.eth')).resolves.toMatchObject({
      status: 'ok',
      dataHex: '0x1234',
    });
    await expect(ctx.mod.resolveAddress('alice.eth')).resolves.toMatchObject({
      status: 'ok',
      addressHex: '0x1111111111111111111111111111111111111111',
    });
    await expect(
      ctx.mod.resolveReverse('0x1111111111111111111111111111111111111111')
    ).resolves.toMatchObject({ status: 'ok', name: 'alice.eth' });

    expect(ctx.addon.ensRecordJson.mock.calls.map(([, json]) => JSON.parse(json))).toEqual([
      { method: 'text', name: 'alice.eth', key: 'url' },
      { method: 'contenthash', name: 'alice.eth' },
      { method: 'addr', name: 'alice.eth' },
      { method: 'reverse', addressHex: '0x1111111111111111111111111111111111111111' },
    ]);
    expect(ctx.addon.resolveEnsJson).not.toHaveBeenCalled();
  });

  test('dispatches verified generic contract calls through the native addon', async () => {
    const ctx = loadManager();
    ctx.mod.startMyotis();
    ctx.addon.ethCallJson.mockResolvedValue(
      JSON.stringify({ status: 'ok', resultHex: '0xdeadbeef' })
    );

    await expect(
      ctx.mod.ethCall({
        to: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        block: 'latest',
      })
    ).resolves.toEqual({ status: 'ok', resultHex: '0xdeadbeef' });
    expect(ctx.addon.ethCallJson).toHaveBeenCalledWith(
      7,
      '',
      '0x1111111111111111111111111111111111111111',
      '0x1234',
      '0',
      'latest'
    );
  });

  test('exposes Gnosis account, gas, fee, and P2P broadcast operations', async () => {
    const ctx = loadManager();
    ctx.mod.startMyotis({ chainId: 100 });
    ctx.addon.requestAccountJson.mockResolvedValue(JSON.stringify({ balanceWei: '42', nonce: 2 }));
    ctx.addon.estimateGasJson.mockResolvedValue(JSON.stringify({ gasLimit: 21000 }));
    ctx.addon.feeEstimateJson.mockResolvedValue(JSON.stringify({ gasPriceWei: '3' }));
    ctx.addon.sendRawTransactionJson.mockResolvedValue(JSON.stringify({ txHash: '0x1234' }));

    await expect(ctx.mod.getAccount('0xabc', 100)).resolves.toMatchObject({ balanceWei: '42' });
    await expect(ctx.mod.estimateGas({ chainId: 100, from: '0xabc', to: '0xdef' }))
      .resolves.toMatchObject({ gasLimit: 21000 });
    await expect(ctx.mod.feeEstimate(100)).resolves.toMatchObject({ gasPriceWei: '3' });
    await expect(ctx.mod.sendRawTransaction('0xsigned', 100))
      .resolves.toMatchObject({ txHash: '0x1234' });
    expect(ctx.addon.sendRawTransactionJson).toHaveBeenCalledWith(7, '0xsigned');
  });
});
