const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const loadBeeModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    antMenuOpen: options.antMenuOpen ?? false,
    currentAntStatus: options.currentAntStatus || 'stopped',
    antPeersInterval: null,
    antVisibleInterval: null,
    antVersionFetched: options.antVersionFetched ?? false,
    antVersionValue: options.antVersionValue || '',
    suppressRunningStatus: options.suppressRunningStatus ?? false,
    registry: {
      ant: {
        api: 'http://bee.test',
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const getDisplayMessage = jest.fn(() => {
    return state.registry.ant.tempMessage || state.registry.ant.statusMessage;
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

  // The chrome reads the node over IPC (`window.ant.apiGet`), never by
  // fetching the node's port itself (security audit O-1, #428).
  global.fetch = jest.fn(async () => {
    throw new Error('the chrome must not fetch the Ant API directly');
  });
  const apiGet =
    options.apiGetImpl ||
    jest.fn(async (endpoint) => {
      if (endpoint === '/peers') {
        return { ok: true, status: 200, data: { peers: [{ id: 'a' }, { id: 'b' }] } };
      }
      if (endpoint === '/topology') {
        return {
          ok: true,
          status: 200,
          data: {
            bins: {
              '0': { population: 3 },
              '1': { population: 4 },
            },
          },
        };
      }

      return { ok: true, status: 200, data: { version: 'antd/0.5.8-abcdef' } };
    });
  global.window = {
    ant: beeApi,
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./wallet/ant-api.js', () => ({
    fetchAntJson: (endpoint) => apiGet(endpoint),
  }));

  const mod = await import('./ant-ui.js');

  return {
    mod,
    state,
    apiGet,
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
      antMenuOpen: true,
      currentAntStatus: 'running',
      windowBee: false,
    });

    ctx.mod.initAntUi();
    ctx.mod.startAntInfoPolling();
    await flushMicrotasks();

    expect(ctx.apiGet).toHaveBeenCalledWith('/peers');
    expect(ctx.apiGet).toHaveBeenCalledWith('/topology');
    expect(ctx.apiGet).toHaveBeenCalledWith('/health');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.beePeersCount.textContent).toBe('2');
    expect(ctx.elements.beeNetworkPeers.textContent).toBe('7');
    expect(ctx.elements.beeVersionText.textContent).toBe('Ant v0.5.8');
    expect(ctx.state.antVersionFetched).toBe(true);
    expect(ctx.state.antPeersInterval).toBe(1);
    expect(ctx.state.antVisibleInterval).toBe(2);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1000);

    ctx.mod.stopAntInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(1);
    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(2);
    expect(ctx.state.antPeersInterval).toBeNull();
    expect(ctx.state.antVisibleInterval).toBeNull();
    expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.beePeersCount.textContent).toBe('0');
    expect(ctx.elements.beeNetworkPeers.textContent).toBe('0');
    expect(ctx.elements.beeVersionText.textContent).toBe('Ant v0.5.8');

    ctx.mod.resetAntVersion();
    expect(ctx.state.antVersionFetched).toBe(false);
    expect(ctx.state.antVersionValue).toBe('');
    // #253: a blank Version row read as a rendering failure next to four
    // populated siblings; every node's unknown version now reads 'Unknown'.
    expect(ctx.elements.beeVersionText.textContent).toBe('Unknown');

    // Stopping again with nothing fetched keeps 'Unknown' rather than blanking
    // the row — the state the menu is in while /health is still in flight.
    ctx.elements.beeVersionText.textContent = 'Ant v0.5.8';
    ctx.mod.stopAntInfoPolling();
    expect(ctx.elements.beeVersionText.textContent).toBe('Unknown');
  });

  test('updates Bee status lines, toggle state, and running transitions', async () => {
    const ctx = await loadBeeModule({
      antMenuOpen: true,
      currentAntStatus: 'stopped',
      statusMessage: 'Swarm: Connected',
      windowBee: false,
    });

    ctx.mod.initAntUi();
    ctx.mod.updateAntStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('ant');
    expect(ctx.elements.beeStatusLabel.textContent).toBe('Swarm:');
    expect(ctx.elements.beeStatusValue.textContent).toBe('Connected');
    expect(ctx.elements.beeStatusRow.classList.contains('visible')).toBe(true);

    ctx.state.registry.ant.mode = 'reused';
    ctx.mod.updateAntToggleState();
    expect(ctx.elements.beeToggleBtn.classList.contains('external')).toBe(true);
    expect(ctx.elements.beeToggleBtn.getAttribute('title')).toBe(
      'Using existing node — cannot be controlled from Freedom'
    );

    ctx.state.registry.ant.mode = 'none';
    ctx.mod.updateAntToggleState();
    expect(ctx.elements.beeToggleBtn.classList.contains('external')).toBe(false);

    ctx.mod.updateAntUi('starting');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentAntStatus).toBe('starting');

    ctx.state.suppressRunningStatus = true;
    ctx.elements.beeToggleSwitch.classList.remove('running');
    ctx.mod.updateAntUi('running');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(false);

    ctx.mod.updateAntUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Ant Error: offline');

    ctx.mod.updateAntUi('stopped');
    expect(ctx.elements.beeStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes Bee controls, handles binary availability, and toggles start and stop', async () => {
    const ctx = await loadBeeModule({
      antMenuOpen: true,
      currentAntStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initAntUi();
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
    ctx.mod.initAntUi();
    await flushMicrotasks();

    ctx.elements.beeToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.beeApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Swarm On');
    expect(ctx.elements.beeToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentAntStatus).toBe('running');

    const statusHandler = ctx.getStatusHandler();
    statusHandler({
      status: 'error',
      error: 'offline',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Ant Status Update: error (offline)');

    ctx.state.currentAntStatus = 'running';
    ctx.elements.beeToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.beeApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Swarm Off');
  });
});
