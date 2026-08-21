const IPC = require('../shared/ipc-channels');
const {
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

function loadServiceRegistry(options = {}) {
  return loadMainModule(require.resolve('./service-registry'), options);
}

describe('service-registry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('returns no service URLs when registry is empty', () => {
    const { mod } = loadServiceRegistry();

    expect(mod.getIpfsApiUrl()).toBeNull();
    expect(mod.getIpfsGatewayUrl()).toBeNull();
    expect(mod.getAntApiUrl()).toBeNull();
    expect(mod.getAntGatewayUrl()).toBeNull();
    expect(mod.getRadicleApiUrl()).toBeNull();
    expect(mod.getService('myotis')).toEqual(
      expect.objectContaining({ mode: mod.MODE.NONE, api: null, gateway: null })
    );
  });

  test('returns service URLs after registry hydration', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('ipfs', {
      api: 'http://127.0.0.1:15001',
      gateway: 'http://localhost:18080',
      mode: mod.MODE.BUNDLED,
    });
    mod.updateService('ant', {
      api: 'http://127.0.0.1:11633',
      gateway: 'http://127.0.0.1:11633',
      mode: mod.MODE.BUNDLED,
    });
    mod.updateService('radicle', {
      api: 'http://127.0.0.1:18780',
      gateway: 'http://127.0.0.1:18780',
      mode: mod.MODE.BUNDLED,
    });
    mod.updateService('myotis', {
      mode: mod.MODE.BUNDLED,
      statusMessage: 'Ready',
    });

    expect(mod.getIpfsApiUrl()).toBe('http://127.0.0.1:15001');
    expect(mod.getIpfsGatewayUrl()).toBe('http://localhost:18080');
    expect(mod.getAntApiUrl()).toBe('http://127.0.0.1:11633');
    expect(mod.getAntGatewayUrl()).toBe('http://127.0.0.1:11633');
    expect(mod.getRadicleApiUrl()).toBe('http://127.0.0.1:18780');
    expect(mod.getService('myotis')).toEqual(
      expect.objectContaining({ mode: mod.MODE.BUNDLED, statusMessage: 'Ready' })
    );
  });

  test('updates a service and broadcasts the new registry state', () => {
    const firstWindow = { webContents: { send: jest.fn() } };
    const closingWindow = {
      webContents: {
        send: jest.fn(() => {
          throw new Error('window closing');
        }),
      },
    };
    const { mod } = loadServiceRegistry({ windows: [firstWindow, closingWindow] });

    mod.updateService('ipfs', {
      api: 'http://127.0.0.1:5999',
      gateway: 'http://127.0.0.1:8999',
      mode: mod.MODE.EXTERNAL,
    });

    expect(mod.getService('ipfs')).toEqual(
      expect.objectContaining({
        api: 'http://127.0.0.1:5999',
        gateway: 'http://127.0.0.1:8999',
        mode: mod.MODE.EXTERNAL,
      })
    );
    expect(firstWindow.webContents.send).toHaveBeenCalledWith(
      IPC.SERVICE_REGISTRY_UPDATE,
      expect.objectContaining({
        ipfs: expect.objectContaining({
          api: 'http://127.0.0.1:5999',
          gateway: 'http://127.0.0.1:8999',
          mode: mod.MODE.EXTERNAL,
        }),
      })
    );
    expect(closingWindow.webContents.send).toHaveBeenCalled();
  });

  test('temporary messages override status and auto-clear back to the permanent message', () => {
    const { mod } = loadServiceRegistry();

    mod.setStatusMessage('ant', 'Bee ready');
    mod.setTempStatusMessage('ant', 'Reconnecting', 50);

    expect(mod.getDisplayMessage('ant')).toBe('Reconnecting');

    jest.advanceTimersByTime(50);

    expect(mod.getDisplayMessage('ant')).toBe('Bee ready');
  });

  test('error state can be cleared back to the permanent status message', () => {
    const { mod } = loadServiceRegistry();

    mod.setStatusMessage('radicle', 'Running');
    mod.setErrorState('radicle', 'Connection failed');
    expect(mod.getDisplayMessage('radicle')).toBe('Connection failed');

    mod.clearErrorState('radicle');
    expect(mod.getDisplayMessage('radicle')).toBe('Running');
  });

  test('clearService resets service state back to defaults', () => {
    const { mod } = loadServiceRegistry();

    mod.updateService('ant', {
      api: 'http://127.0.0.1:1999',
      gateway: 'http://127.0.0.1:1999',
      mode: mod.MODE.BUNDLED,
    });
    mod.setStatusMessage('ant', 'Online');

    mod.clearService('ant');

    expect(mod.getService('ant')).toEqual({
      api: null,
      gateway: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
    });

    mod.updateService('tor', {
      socks: '127.0.0.1:19150',
      mode: mod.MODE.BUNDLED,
    });
    mod.clearService('tor');

    expect(mod.getService('tor')).toEqual({
      socks: null,
      mode: mod.MODE.NONE,
      statusMessage: null,
      tempMessage: null,
      tempMessageTimeout: null,
    });
  });

  test('registers an IPC handler that returns the current registry state', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadServiceRegistry({ ipcMain });

    mod.updateService('radicle', {
      api: 'http://127.0.0.1:8781',
      gateway: 'http://127.0.0.1:8781',
      mode: mod.MODE.REUSED,
    });
    mod.registerServiceRegistryIpc();

    await expect(ipcMain.invoke(IPC.SERVICE_REGISTRY_GET)).resolves.toEqual(
      expect.objectContaining({
        radicle: expect.objectContaining({
          api: 'http://127.0.0.1:8781',
          gateway: 'http://127.0.0.1:8781',
          mode: mod.MODE.REUSED,
        }),
      })
    );
  });
});
