const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadRadicleModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    beeMenuOpen: options.beeMenuOpen ?? false,
    enableRadicleIntegration: options.enableRadicleIntegration ?? true,
    currentRadicleStatus: options.currentRadicleStatus || 'stopped',
    radicleVersionFetched: options.radicleVersionFetched ?? false,
    radicleVersionValue: options.radicleVersionValue || '',
    suppressRadicleRunningStatus: options.suppressRadicleRunningStatus ?? false,
    registry: {
      radicle: {
        api: 'http://radicle.test',
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const buildRadicleUrl = jest.fn((endpoint) => `http://radicle.test${endpoint}`);
  const getDisplayMessage = jest.fn(() => {
    return state.registry.radicle.tempMessage || state.registry.radicle.statusMessage;
  });
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const radicleToggleBtn = createElement('button');
  const radicleToggleSwitch = createElement('div');
  const radiclePeersCount = createElement('span');
  const radicleReposCount = createElement('span');
  const radicleVersionText = createElement('span');
  const radicleNodeId = createElement('span');
  const radicleInfoPanel = createElement('div', {
    classes: ['radicle-info'],
  });
  const radicleStatusRow = createElement('div');
  const radicleStatusLabel = createElement('span');
  const radicleStatusValue = createElement('span');
  const radicleNodesSection = createElement('section');
  const body = createElement('body');
  body.appendChild(radicleInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'radicle-toggle-btn': radicleToggleBtn,
      'radicle-toggle-switch': radicleToggleSwitch,
      'radicle-peers-count': radiclePeersCount,
      'radicle-repos-count': radicleReposCount,
      'radicle-version-text': radicleVersionText,
      'radicle-node-id': radicleNodeId,
      'radicle-status-row': radicleStatusRow,
      'radicle-status-label': radicleStatusLabel,
      'radicle-status-value': radicleStatusValue,
      'radicle-nodes-section': radicleNodesSection,
    },
  });
  let statusHandler = null;
  const windowHandlers = {};
  const radicleApi =
    options.windowRadicle === false
      ? undefined
      : {
          checkBinary: jest
            .fn()
            .mockResolvedValue({ available: options.binaryAvailable ?? true }),
          getConnections: jest
            .fn()
            .mockResolvedValue(options.connectionsResult || { success: true, count: 5 }),
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
      if (url.endsWith('/api/v1/stats')) {
        return {
          ok: true,
          json: async () => ({ repos: { total: 7 } }),
        };
      }
      if (url.endsWith('/api/v1/node')) {
        return {
          ok: true,
          json: async () => ({ id: 'rad123456789abcdef1234' }),
        };
      }

      return {
        ok: true,
        json: async () => ({ version: '1.2.3-buildhash' }),
      };
    });
  global.window = {
    radicle: radicleApi,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    buildRadicleUrl,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./radicle-ui.js');

  return {
    mod,
    state,
    buildRadicleUrl,
    getDisplayMessage,
    debugMocks,
    setIntervalMock,
    clearIntervalMock,
    radicleApi,
    windowHandlers,
    getStatusHandler: () => statusHandler,
    elements: {
      radicleToggleBtn,
      radicleToggleSwitch,
      radiclePeersCount,
      radicleReposCount,
      radicleVersionText,
      radicleNodeId,
      radicleInfoPanel,
      radicleStatusRow,
      radicleStatusLabel,
      radicleStatusValue,
      radicleNodesSection,
    },
  };
};

describe('radicle-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('starts and stops Radicle info polling and populates stats', async () => {
    const ctx = await loadRadicleModule({
      beeMenuOpen: true,
      enableRadicleIntegration: true,
      currentRadicleStatus: 'running',
      windowRadicle: true,
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initRadicleUi();
    ctx.mod.startRadicleInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.radicleApi.getConnections).toHaveBeenCalled();
    expect(ctx.buildRadicleUrl).toHaveBeenCalledWith('/api/v1/stats');
    expect(ctx.buildRadicleUrl).toHaveBeenCalledWith('/api/v1/node');
    expect(ctx.buildRadicleUrl).toHaveBeenCalledWith('/');
    expect(ctx.elements.radicleInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.radiclePeersCount.textContent).toBe('5');
    expect(ctx.elements.radicleReposCount.textContent).toBe('7');
    expect(ctx.elements.radicleVersionText.textContent).toBe('1.2.3');
    expect(ctx.elements.radicleNodeId.textContent).toBe('rad12345...1234');
    expect(ctx.elements.radicleNodeId.title).toBe('rad123456789abcdef1234');
    expect(ctx.state.radicleVersionFetched).toBe(true);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 2000);

    ctx.mod.stopRadicleInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalled();
    expect(ctx.elements.radicleInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.radiclePeersCount.textContent).toBe('0');
    expect(ctx.elements.radicleReposCount.textContent).toBe('');
    expect(ctx.elements.radicleVersionText.textContent).toBe('1.2.3');
    expect(ctx.elements.radicleNodeId.textContent).toBe('');
  });

  test('updates Radicle status lines, toggle state, and running transitions', async () => {
    const ctx = await loadRadicleModule({
      beeMenuOpen: true,
      enableRadicleIntegration: true,
      currentRadicleStatus: 'stopped',
      statusMessage: 'Radicle: Connected',
      windowRadicle: false,
    });

    ctx.mod.initRadicleUi();
    ctx.mod.updateRadicleStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('radicle');
    expect(ctx.elements.radicleStatusLabel.textContent).toBe('Radicle:');
    expect(ctx.elements.radicleStatusValue.textContent).toBe('Connected');
    expect(ctx.elements.radicleStatusRow.classList.contains('visible')).toBe(true);

    ctx.state.registry.radicle.mode = 'reused';
    ctx.mod.updateRadicleToggleState();
    expect(ctx.elements.radicleToggleBtn.classList.contains('external')).toBe(true);

    ctx.state.registry.radicle.mode = 'none';
    ctx.mod.updateRadicleToggleState();
    expect(ctx.elements.radicleToggleBtn.classList.contains('external')).toBe(false);

    ctx.mod.updateRadicleUi('starting');
    expect(ctx.elements.radicleToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentRadicleStatus).toBe('starting');

    ctx.state.suppressRadicleRunningStatus = true;
    ctx.elements.radicleToggleSwitch.classList.remove('running');
    ctx.mod.updateRadicleUi('running');
    expect(ctx.elements.radicleToggleSwitch.classList.contains('running')).toBe(false);

    ctx.mod.updateRadicleUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('Radicle Error: offline');

    ctx.mod.updateRadicleUi('stopped');
    expect(ctx.elements.radicleStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes Radicle controls and reacts to settings changes and toggle actions', async () => {
    const ctx = await loadRadicleModule({
      beeMenuOpen: true,
      enableRadicleIntegration: false,
      currentRadicleStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.radicleApi.checkBinary
      .mockResolvedValueOnce({ available: false })
      .mockResolvedValueOnce({ available: true });

    ctx.mod.initRadicleUi();
    await flushMicrotasks();

    expect(ctx.elements.radicleNodesSection.classList.contains('hidden')).toBe(true);
    expect(ctx.elements.radicleToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'Radicle binaries not found - toggle disabled'
    );
    expect(ctx.radicleApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.radicleApi.getStatus).toHaveBeenCalled();
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5000);

    ctx.elements.radicleToggleBtn.dispatch('click');
    expect(ctx.radicleApi.start).not.toHaveBeenCalled();

    ctx.windowHandlers['settings:updated']({
      detail: {
        enableRadicleIntegration: true,
      },
    });
    await flushMicrotasks();

    expect(ctx.state.enableRadicleIntegration).toBe(true);
    expect(ctx.elements.radicleNodesSection.classList.contains('hidden')).toBe(false);
    expect(ctx.radicleApi.checkBinary).toHaveBeenCalledTimes(2);
    expect(ctx.elements.radicleToggleBtn.classList.contains('disabled')).toBe(false);

    ctx.elements.radicleToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.radicleApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Radicle On');
    expect(ctx.elements.radicleToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentRadicleStatus).toBe('running');

    const statusHandler = ctx.getStatusHandler();
    statusHandler({
      status: 'error',
      error: 'offline',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'Radicle Status Update: error (offline)'
    );

    ctx.state.currentRadicleStatus = 'running';
    ctx.elements.radicleToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.radicleApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled Radicle Off');
  });
});
