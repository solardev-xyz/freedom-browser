const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadRadicleModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    antMenuOpen: options.antMenuOpen ?? false,
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
            .mockResolvedValue(
              options.connectionsResult || {
                success: true,
                count: 5,
                reposCount: 7,
                version: '0.4.0',
              }
            ),
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

  global.window = {
    radicle: radicleApi,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./radicle-ui.js');

  return {
    mod,
    state,
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
    jest.restoreAllMocks();
  });

  test('loads an initial Radicle snapshot and applies pushed info updates', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
      currentRadicleStatus: 'running',
      windowRadicle: true,
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initRadicleUi();
    ctx.mod.startRadicleInfoUpdates();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.radicleApi.getConnections).toHaveBeenCalled();
    expect(ctx.elements.radicleInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.radiclePeersCount.textContent).toBe('5');
    expect(ctx.elements.radicleReposCount.textContent).toBe('7');
    expect(ctx.elements.radicleVersionText.textContent).toBe('libradicle v0.4.0');
    expect(ctx.state.radicleVersionFetched).toBe(true);
    expect(ctx.setIntervalMock).not.toHaveBeenCalled();

    ctx.getStatusHandler()({
      status: 'running',
      error: null,
      info: { success: true, count: 8, reposCount: 9, version: '0.6.1' },
    });
    expect(ctx.elements.radiclePeersCount.textContent).toBe('8');
    expect(ctx.elements.radicleReposCount.textContent).toBe('9');
    expect(ctx.elements.radicleVersionText.textContent).toBe('libradicle v0.6.1');

    ctx.mod.stopRadicleInfoUpdates();

    expect(ctx.clearIntervalMock).not.toHaveBeenCalled();
    expect(ctx.elements.radicleInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.radiclePeersCount.textContent).toBe('0');
    // Counters share one empty state with the rest of the Nodes menu (#227).
    expect(ctx.elements.radicleReposCount.textContent).toBe('0');
    expect(ctx.elements.radicleVersionText.textContent).toBe('libradicle v0.6.1');
  });

  test('an unknown seeded-repository count renders 0, like the other counters', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
      currentRadicleStatus: 'running',
      windowRadicle: true,
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initRadicleUi();
    ctx.mod.startRadicleInfoUpdates();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // reposCount absent (older/partial payload) — must not fall back to '--'
    // while the sibling peers row shows a number.
    ctx.getStatusHandler()({
      status: 'running',
      error: null,
      info: { success: true, count: 3, version: '0.6.1' },
    });
    expect(ctx.elements.radiclePeersCount.textContent).toBe('3');
    expect(ctx.elements.radicleReposCount.textContent).toBe('0');
  });

  test('an unknown connected-peer count renders 0, like the other counters', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
      currentRadicleStatus: 'running',
      windowRadicle: true,
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initRadicleUi();
    ctx.mod.startRadicleInfoUpdates();
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // The mirror of the case above: count absent from a successful payload
    // must not render the literal 'undefined' while the sibling repos row
    // shows a number.
    ctx.getStatusHandler()({
      status: 'running',
      error: null,
      info: { success: true, reposCount: 2, version: '0.6.1' },
    });
    expect(ctx.elements.radiclePeersCount.textContent).toBe('0');
    expect(ctx.elements.radicleReposCount.textContent).toBe('2');

    // A non-integer count (a string from an older/looser payload) is empty
    // state too, not a coerced number.
    ctx.getStatusHandler()({
      status: 'running',
      error: null,
      info: { success: true, count: null, reposCount: 2, version: '0.6.1' },
    });
    expect(ctx.elements.radiclePeersCount.textContent).toBe('0');
  });

  test('updates Radicle status lines, toggle state, and running transitions', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
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
    expect(ctx.elements.radicleStatusRow.classList.contains('visible')).toBe(true);
  });

  test('keeps Radicle visible and disables controls when the addon is unavailable', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
      currentRadicleStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initRadicleUi();
    await flushMicrotasks();

    expect(ctx.elements.radicleNodesSection.classList.contains('hidden')).toBe(false);
    expect(ctx.elements.radicleToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'libradicle addon not found - toggle disabled'
    );
    expect(ctx.radicleApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.radicleApi.getStatus).not.toHaveBeenCalled();
    expect(ctx.setIntervalMock).not.toHaveBeenCalled();

    ctx.elements.radicleToggleBtn.dispatch('click');
    expect(ctx.radicleApi.start).not.toHaveBeenCalled();
  });

  test('starts and stops the first-class Radicle node from the Nodes menu', async () => {
    const ctx = await loadRadicleModule({
      antMenuOpen: true,
      currentRadicleStatus: 'stopped',
      binaryAvailable: true,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initRadicleUi();
    await flushMicrotasks();

    expect(ctx.elements.radicleNodesSection.classList.contains('hidden')).toBe(false);
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
