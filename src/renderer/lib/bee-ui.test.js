const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadBeeModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    beeMenuOpen: options.beeMenuOpen ?? false,
    currentBeeStatus: options.currentBeeStatus || 'stopped',
    beePeersInterval: null,
    beeVisibleInterval: null,
    beeVersionFetched: options.beeVersionFetched ?? false,
    beeVersionValue: options.beeVersionValue || '',
    suppressRunningStatus: options.suppressRunningStatus ?? false,
    registry: {
      bee: {
        api: 'http://bee.test',
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const buildBeeUrl = jest.fn((endpoint) => `http://bee.test${endpoint}`);
  const getDisplayMessage = jest.fn(() => {
    return state.registry.bee.tempMessage || state.registry.bee.statusMessage;
  });
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const beeToggleBtn = createElement('button');
  const beeToggleSwitch = createElement('div');
  const beePeersCount = createElement('span');
  const beeNetworkPeers = createElement('span');
  const beeVersionText = createElement('span');
  const beeInfoPanel = createElement('div', {
    classes: ['bee-info'],
  });
  const beeStatusRow = createElement('div');
  const beeStatusLabel = createElement('span');
  const beeStatusValue = createElement('span');
  const body = createElement('body');
  body.appendChild(beeInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'bee-toggle-btn': beeToggleBtn,
      'bee-toggle-switch': beeToggleSwitch,
      'bee-peers-count': beePeersCount,
      'bee-network-peers': beeNetworkPeers,
      'bee-version-text': beeVersionText,
      'bee-status-row': beeStatusRow,
      'bee-status-label': beeStatusLabel,
      'bee-status-value': beeStatusValue,
    },
  });
  let statusHandler = null;
  const beeApi =
    options.windowBee === false
      ? undefined
      : {
          checkBinary: jest
            .fn()
            .mockResolvedValue({ available: options.binaryAvailable ?? true }),
          start: jest
            .fn()
            .mockResolvedValue(options.startResult || { status: 'running', error: null }),
          stop: jest
            .fn()
            .mockResolvedValue(options.stopResult || { status: 'stopped', error: null }),
          getStatus: jest
            .fn()
            .mockResolvedValue(options.statusResult || { status: 'stopped', error: null }),
          onStatusUpdate: jest.fn((handler) => {
            statusHandler = handler;
          }),
        };
  let intervalId = 1;
  const setIntervalMock = jest.spyOn(global, 'setInterval').mockImplementation(() => intervalId++);
  const clearIntervalMock = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

  global.fetch =
    options.fetchImpl ||
    jest.fn(async (url) => {
      if (url.endsWith('/peers')) {
        return {
          ok: true,
          json: async () => ({ peers: [{ id: 'a' }, { id: 'b' }] }),
        };
      }
      if (url.endsWith('/topology')) {
        return {
          ok: true,
          json: async () => ({
            bins: {
              '0': { population: 3 },
              '1': { population: 4 },
            },
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ version: '2.3.4-abcdef' }),
      };
    });
  global.window = {
    bee: beeApi,
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    buildBeeUrl,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./bee-ui.js');

  return {
    mod,
    state,
    buildBeeUrl,
    getDisplayMessage,
    debugMocks,
    setIntervalMock,
    clearIntervalMock,
    beeApi,
    getStatusHandler: () => statusHandler,
    elements: {
      beeToggleBtn,
      beeToggleSwitch,
      beePeersCount,
      beeNetworkPeers,
      beeVersionText,
      beeInfoPanel,
      beeStatusRow,
      beeStatusLabel,
      beeStatusValue,
    },
  };
};

describe('bee-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('starts and stops Bee info polling and populates stats', async () => {
    const ctx = await loadBeeModule({
      beeMenuOpen: true,
      currentBeeStatus: 'running',
      windowBee: false,
    });

    ctx.mod.initBeeUi();
    ctx.mod.startBeeInfoPolling();
    await flushMicrotasks();

    expect(ctx.buildBeeUrl).toHaveBeenCalledWith('/peers');
    expect(ctx.buildBeeUrl).toHaveBeenCalledWith('/topology');
    expect(ctx.buildBeeUrl).toHaveBeenCalledWith('/health');
    expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.beePeersCount.textContent).toBe('2');
    expect(ctx.elements.beeNetworkPeers.textContent).toBe('7');
    expect(ctx.elements.beeVersionText.textContent).toBe('2.3.4');
    expect(ctx.state.beeVersionFetched).toBe(true);
    expect(ctx.state.beePeersInterval).toBe(1);
    expect(ctx.state.beeVisibleInterval).toBe(2);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1000);

    ctx.mod.stopBeeInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(1);
    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(2);
    expect(ctx.state.beePeersInterval).toBeNull();
    expect(ctx.state.beeVisibleInterval).toBeNull();
    expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.beePeersCount.textContent).toBe('0');
    expect(ctx.elements.beeNetworkPeers.textContent).toBe('0');
    expect(ctx.elements.beeVersionText.textContent).toBe('2.3.4');

    ctx.mod.resetBeeVersion();
    expect(ctx.state.beeVersionFetched).toBe(false);
    expect(ctx.state.beeVersionValue).toBe('');
    expect(ctx.elements.beeVersionText.textContent).toBe('');
  });

  test('updates Bee status lines, toggle state, and running transitions', async () => {
    const ctx = await loadBeeModule({
      beeMenuOpen: true,
      currentBeeStatus: 'stopped',
      statusMessage: 'Swarm: Connected',
      windowBee: false,
    });

    ctx.mod.initBeeUi();
    ctx.mod.updateBeeStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('bee');
    expect(ctx.elements.beeStatusLabel.textContent).toBe('Swarm:');
    expect(ctx.elements.beeStatusValue.textContent).toBe('Connected');
    expect(ctx.elements.beeStatusRow.classList.contains('visible')).toBe(true);

    ctx.state.registry.bee.mode = 'reused';
    ctx.mod.updateBeeToggleState();
    expect(ctx.elements.beeToggleBtn.classList.contains('external')).toBe(true);
    expect(ctx.elements.beeToggleBtn.getAttribute('title')).toBe(
      'Using existing node — cannot be controlled from Freedom'
    );

    ctx.state.registry.bee.mode = 'none';
    ctx.mod.updateBeeToggleState();
    expect(ctx.elements.beeToggleBtn.classList.contains('external')).toBe(false);

    ctx.mod.updateBeeUi('starting');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentBeeStatus).toBe('starting');

    ctx.state.suppressRunningStatus = true;
    ctx.elements.beeToggleSwitch.classList.remove('running');
    ctx.mod.updateBeeUi('running');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(false);

    ctx.mod.updateBeeUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Bee Error: offline');

    ctx.mod.updateBeeUi('stopped');
    expect(ctx.elements.beeStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes Bee controls, handles binary availability, and toggles start and stop', async () => {
    const ctx = await loadBeeModule({
      beeMenuOpen: true,
      currentBeeStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initBeeUi();
    await flushMicrotasks();

    expect(ctx.beeApi.checkBinary).toHaveBeenCalled();
    expect(ctx.elements.beeToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.beeToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Swarm binary not found - toggle disabled');
    expect(ctx.beeApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.beeApi.getStatus).toHaveBeenCalled();
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5000);

    ctx.elements.beeToggleBtn.dispatch('click');
    expect(ctx.beeApi.start).not.toHaveBeenCalled();

    ctx.beeApi.checkBinary.mockResolvedValueOnce({ available: true });
    ctx.mod.initBeeUi();
    await flushMicrotasks();

    ctx.elements.beeToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.beeApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Swarm On');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentBeeStatus).toBe('running');

    const statusHandler = ctx.getStatusHandler();
    statusHandler({
      status: 'error',
      error: 'offline',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Bee Status Update: error (offline)');

    ctx.state.currentBeeStatus = 'running';
    ctx.elements.beeToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.beeApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Swarm Off');
  });
});
