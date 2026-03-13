const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const loadIpfsModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    beeMenuOpen: options.beeMenuOpen ?? false,
    currentIpfsStatus: options.currentIpfsStatus || 'stopped',
    ipfsPeersInterval: null,
    ipfsVersionFetched: options.ipfsVersionFetched ?? false,
    ipfsVersionValue: options.ipfsVersionValue || '',
    suppressIpfsRunningStatus: options.suppressIpfsRunningStatus ?? false,
    registry: {
      ipfs: {
        api: 'http://ipfs.test',
        mode: options.mode || 'none',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const buildIpfsApiUrl = jest.fn((endpoint) => `http://ipfs.test${endpoint}`);
  const getDisplayMessage = jest.fn(() => {
    return state.registry.ipfs.tempMessage || state.registry.ipfs.statusMessage;
  });
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const ipfsToggleBtn = createElement('button');
  const ipfsToggleSwitch = createElement('div');
  const ipfsPeersCount = createElement('span');
  const ipfsBandwidthDown = createElement('span');
  const ipfsBandwidthUp = createElement('span');
  const ipfsVersionText = createElement('span');
  const ipfsInfoPanel = createElement('div', {
    classes: ['ipfs-info'],
  });
  const ipfsStatusRow = createElement('div');
  const ipfsStatusLabel = createElement('span');
  const ipfsStatusValue = createElement('span');
  const body = createElement('body');
  body.appendChild(ipfsInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'ipfs-toggle-btn': ipfsToggleBtn,
      'ipfs-toggle-switch': ipfsToggleSwitch,
      'ipfs-peers-count': ipfsPeersCount,
      'ipfs-bandwidth-down': ipfsBandwidthDown,
      'ipfs-bandwidth-up': ipfsBandwidthUp,
      'ipfs-version-text': ipfsVersionText,
      'ipfs-status-row': ipfsStatusRow,
      'ipfs-status-label': ipfsStatusLabel,
      'ipfs-status-value': ipfsStatusValue,
    },
  });
  let statusHandler = null;
  const ipfsApi =
    options.windowIpfs === false
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
      if (url.endsWith('/api/v0/swarm/peers')) {
        return {
          ok: true,
          json: async () => ({ Peers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
        };
      }
      if (url.endsWith('/api/v0/stats/bw')) {
        return {
          ok: true,
          json: async () => ({
            RateIn: 1536,
            RateOut: 1048576,
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({ AgentVersion: 'kubo/0.28.0-rc1/' }),
      };
    });
  global.window = {
    ipfs: ipfsApi,
  };
  global.document = document;

  jest.doMock('./state.js', () => ({
    state,
    buildIpfsApiUrl,
    getDisplayMessage,
  }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./ipfs-ui.js');

  return {
    mod,
    state,
    buildIpfsApiUrl,
    getDisplayMessage,
    debugMocks,
    setIntervalMock,
    clearIntervalMock,
    ipfsApi,
    getStatusHandler: () => statusHandler,
    elements: {
      ipfsToggleBtn,
      ipfsToggleSwitch,
      ipfsPeersCount,
      ipfsBandwidthDown,
      ipfsBandwidthUp,
      ipfsVersionText,
      ipfsInfoPanel,
      ipfsStatusRow,
      ipfsStatusLabel,
      ipfsStatusValue,
    },
  };
};

describe('ipfs-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('starts and stops IPFS info polling and populates stats', async () => {
    const ctx = await loadIpfsModule({
      beeMenuOpen: true,
      currentIpfsStatus: 'running',
      windowIpfs: false,
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.buildIpfsApiUrl).toHaveBeenCalledWith('/api/v0/swarm/peers');
    expect(ctx.buildIpfsApiUrl).toHaveBeenCalledWith('/api/v0/stats/bw');
    expect(ctx.buildIpfsApiUrl).toHaveBeenCalledWith('/api/v0/id');
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('3');
    expect(ctx.elements.ipfsBandwidthDown.textContent).toBe('↓1.5 KB/s');
    expect(ctx.elements.ipfsBandwidthUp.textContent).toBe('↑1.0 MB/s');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('0.28.0');
    expect(ctx.state.ipfsVersionFetched).toBe(true);
    expect(ctx.state.ipfsPeersInterval).toBe(1);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1000);

    ctx.mod.stopIpfsInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(1);
    expect(ctx.state.ipfsPeersInterval).toBeNull();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('0');
    expect(ctx.elements.ipfsBandwidthDown.textContent).toBe('');
    expect(ctx.elements.ipfsBandwidthUp.textContent).toBe('');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('0.28.0');

    ctx.mod.resetIpfsVersion();
    expect(ctx.state.ipfsVersionFetched).toBe(false);
    expect(ctx.state.ipfsVersionValue).toBe('');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('');
  });

  test('updates IPFS status lines, toggle state, and running transitions', async () => {
    const ctx = await loadIpfsModule({
      beeMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusMessage: 'IPFS: Connected',
      windowIpfs: false,
    });

    ctx.mod.initIpfsUi();
    ctx.mod.updateIpfsStatusLine();

    expect(ctx.getDisplayMessage).toHaveBeenCalledWith('ipfs');
    expect(ctx.elements.ipfsStatusLabel.textContent).toBe('IPFS:');
    expect(ctx.elements.ipfsStatusValue.textContent).toBe('Connected');
    expect(ctx.elements.ipfsStatusRow.classList.contains('visible')).toBe(true);

    ctx.state.registry.ipfs.mode = 'reused';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('external')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('title')).toBe(
      'Using existing node — cannot be controlled from Freedom'
    );

    ctx.state.registry.ipfs.mode = 'none';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('external')).toBe(false);

    ctx.mod.updateIpfsUi('starting');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentIpfsStatus).toBe('starting');

    ctx.state.suppressIpfsRunningStatus = true;
    ctx.elements.ipfsToggleSwitch.classList.remove('running');
    ctx.mod.updateIpfsUi('running');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    ctx.mod.updateIpfsUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS Error: offline');

    ctx.mod.updateIpfsUi('stopped');
    expect(ctx.elements.ipfsStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes IPFS controls, handles binary availability, and toggles start and stop', async () => {
    const ctx = await loadIpfsModule({
      beeMenuOpen: true,
      currentIpfsStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    expect(ctx.ipfsApi.checkBinary).toHaveBeenCalled();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS binary not found - toggle disabled');
    expect(ctx.ipfsApi.onStatusUpdate).toHaveBeenCalledWith(expect.any(Function));
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalled();
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 5000);

    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.ipfsApi.start).not.toHaveBeenCalled();

    ctx.ipfsApi.checkBinary.mockResolvedValueOnce({ available: true });
    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    ctx.elements.ipfsToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.ipfsApi.start).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled IPFS On');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.currentIpfsStatus).toBe('running');

    const statusHandler = ctx.getStatusHandler();
    statusHandler({
      status: 'error',
      error: 'offline',
    });
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS Status Update: error (offline)');

    ctx.state.currentIpfsStatus = 'running';
    ctx.elements.ipfsToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.ipfsApi.stop).toHaveBeenCalled();
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('User toggled IPFS Off');
  });
});
