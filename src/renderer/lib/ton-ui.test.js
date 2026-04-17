const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadTonModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    currentTonStatus: options.currentTonStatus || 'stopped',
    suppressTonRunningStatus: options.suppressTonRunningStatus ?? false,
    registry: {
      ton: {
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };

  const getDisplayMessage = jest.fn(() => {
    return state.registry.ton.tempMessage || state.registry.ton.statusMessage;
  });

  const debugMocks = {
    pushDebug: jest.fn(),
  };

  const tonToggleBtn = createElement('button');
  const tonToggleSwitch = createElement('div');
  const tonStatusRow = createElement('div');
  const tonStatusLabel = createElement('span');
  const tonStatusValue = createElement('span');
  const tonProxyPort = createElement('span');
  const tonVersionText = createElement('span');
  const tonInfoPanel = createElement('div', { classes: ['ton-info'] });

  const body = createElement('body');
  body.appendChild(tonInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'ton-toggle-btn': tonToggleBtn,
      'ton-toggle-switch': tonToggleSwitch,
      'ton-status-row': tonStatusRow,
      'ton-status-label': tonStatusLabel,
      'ton-status-value': tonStatusValue,
      'ton-proxy-port': tonProxyPort,
      'ton-version-text': tonVersionText,
    },
  });

  let statusHandler = null;
  const tonApi =
    options.windowTon === false
      ? undefined
      : {
          checkBinary: jest
            .fn()
            .mockResolvedValue({ available: options.binaryAvailable ?? true }),
          start: jest
            .fn()
            .mockResolvedValue(options.startResult || { status: 'running', proxyPort: 18085, version: '0.1.0', error: null }),
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

  const setIntervalMock = jest.spyOn(global, 'setInterval').mockImplementation(() => 1);

  global.window = {
    ton: tonApi,
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./ton-ui.js');

  return {
    mod,
    state,
    getDisplayMessage,
    debugMocks,
    setIntervalMock,
    tonApi,
    getStatusHandler: () => statusHandler,
    elements: {
      tonToggleBtn,
      tonToggleSwitch,
      tonStatusRow,
      tonStatusLabel,
      tonStatusValue,
      tonProxyPort,
      tonVersionText,
      tonInfoPanel,
    },
  };
};

describe('ton-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('toggle click fires TON start when stopped', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'stopped',
      binaryAvailable: true,
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    ctx.elements.tonToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.tonApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled TON On');
    expect(ctx.elements.tonToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentTonStatus).toBe('running');
  });

  test('toggle click fires TON stop when running', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'running',
      binaryAvailable: true,
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    ctx.elements.tonToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.tonApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled TON Off');
  });

  test('TON_STATUS_UPDATE payload with status=running updates status label', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'stopped',
      statusMessage: 'TON: Connected',
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    const handler = ctx.getStatusHandler();
    handler({ status: 'running', proxyPort: 18085, version: '0.1.0', error: null });

    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('TON Status Update: running');
    expect(ctx.elements.tonToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.elements.tonProxyPort.textContent).toBe('18085');
    expect(ctx.elements.tonVersionText.textContent).toBe('0.1.0');
  });

  test('binaryAvailable=false disables the toggle', async () => {
    const ctx = await loadTonModule({
      binaryAvailable: false,
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    expect(ctx.tonApi.checkBinary).toHaveBeenCalled();
    expect(ctx.elements.tonToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.tonToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('TON binary not found - toggle disabled');

    // Click should not fire start
    ctx.elements.tonToggleBtn.dispatch('click');
    expect(ctx.tonApi.start).not.toHaveBeenCalled();
  });

  test('initTonUi is idempotent: can be called twice without duplicate listeners', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'stopped',
      binaryAvailable: true,
    });

    ctx.mod.initTonUi();
    ctx.mod.initTonUi(); // second call
    await flushMicrotasks();

    ctx.elements.tonToggleBtn.dispatch('click');
    await flushMicrotasks();

    // start should only be called once despite two initTonUi calls
    expect(ctx.tonApi.start).toHaveBeenCalledTimes(1);
  });

  test('updateTonStatusLine parses label: value format', async () => {
    const ctx = await loadTonModule({
      statusMessage: 'Status: Running',
    });

    ctx.mod.initTonUi();
    ctx.mod.updateTonStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('ton');
    expect(ctx.elements.tonStatusLabel.textContent).toBe('Status:');
    expect(ctx.elements.tonStatusValue.textContent).toBe('Running');
    expect(ctx.elements.tonStatusRow.classList.contains('visible')).toBe(true);
  });

  test('updateTonUi stopped clears port and version', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'running',
      windowTon: false,
    });

    ctx.mod.initTonUi();
    ctx.mod.updateTonUi('stopped', {});

    expect(ctx.elements.tonToggleSwitch.classList.contains('running')).toBe(false);
    expect(ctx.elements.tonProxyPort.textContent).toBe('--');
    expect(ctx.elements.tonVersionText.textContent).toBe('--');
    expect(ctx.elements.tonStatusRow.classList.contains('visible')).toBe(false);
  });

  test('shows info panel when status is running', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'stopped',
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    const handler = ctx.getStatusHandler();
    handler({ status: 'running', proxyPort: 18085, version: '0.1.0', error: null });

    expect(ctx.elements.tonInfoPanel.classList.contains('visible')).toBe(true);
  });

  test('hides info panel when status is stopped', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'running',
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    const handler = ctx.getStatusHandler();
    handler({ status: 'stopped', error: null });

    expect(ctx.elements.tonInfoPanel.classList.contains('visible')).toBe(false);
  });

  test('initial status check is called and push subscription is registered', async () => {
    const ctx = await loadTonModule({
      currentTonStatus: 'stopped',
    });

    ctx.mod.initTonUi();
    await flushMicrotasks();

    expect(ctx.tonApi.getStatus).toHaveBeenCalled();
    expect(ctx.tonApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.setIntervalMock).toHaveBeenCalledTimes(1);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5000);
  });
});
