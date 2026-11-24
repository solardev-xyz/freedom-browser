const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalFetch = global.fetch;

const ACT_KEY = `02${'ab'.repeat(32)}`;

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
  const beeActKeyText = createElement('code');
  beeActKeyText.textContent = 'Unknown';
  const beeActKeyCopy = createElement('button', { disabled: true });
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
      'bee-act-key-text': beeActKeyText,
      'bee-act-key-copy': beeActKeyCopy,
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
      if (endpoint === '/addresses') {
        return {
          ok: true,
          status: 200,
          data: {
            overlay: 'f'.repeat(64),
            publicKey: 'publicKey' in options ? options.publicKey : ACT_KEY,
          },
        };
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
  const copyText = jest.fn().mockResolvedValue(undefined);
  global.window = {
    ant: beeApi,
    electronAPI: { copyText },
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
    copyText,
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
      beeActKeyText,
      beeActKeyCopy,
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
    expect(ctx.elements.beeVersionText.textContent).toBe('Ant 0.5.8');
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
    expect(ctx.elements.beeVersionText.textContent).toBe('Ant 0.5.8');

    ctx.mod.resetAntVersion();
    expect(ctx.state.antVersionFetched).toBe(false);
    expect(ctx.state.antVersionValue).toBe('');
    // #253: a blank Version row read as a rendering failure next to four
    // populated siblings; every node's unknown version now reads 'Unknown'.
    expect(ctx.elements.beeVersionText.textContent).toBe('Unknown');

    // Stopping again with nothing fetched keeps 'Unknown' rather than blanking
    // the row — the state the menu is in while /health is still in flight.
    ctx.elements.beeVersionText.textContent = 'Ant 0.5.8';
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

describe('ACT public key row (#1188)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const openMenu = async (ctx) => {
    ctx.state.antMenuOpen = true;
    ctx.mod.startAntInfoPolling();
    await flushMicrotasks();
  };

  test('shows the node /addresses publicKey and copies the full key', async () => {
    const ctx = await loadBeeModule({ currentAntStatus: 'running', windowBee: false });
    ctx.mod.initAntUi();
    await openMenu(ctx);

    expect(ctx.apiGet).toHaveBeenCalledWith('/addresses');
    expect(ctx.elements.beeActKeyText.textContent).toBe(`02abab…abab`);
    expect(ctx.elements.beeActKeyText.getAttribute('title')).toBe(ACT_KEY);
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(false);
    expect(ctx.elements.beeActKeyText.classList.contains('has-key')).toBe(true);

    const timeouts = [];
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      timeouts.push([fn, ms]);
      return timeouts.length;
    });
    ctx.elements.beeActKeyCopy.dispatch('click');
    await flushMicrotasks();
    expect(ctx.copyText).toHaveBeenCalledWith(ACT_KEY);
    expect(ctx.elements.beeActKeyCopy.classList.contains('copied')).toBe(true);
    // Same 1.5 s "copied" flash as the sidebar's node copy buttons.
    expect(timeouts.map(([, ms]) => ms)).toEqual([1500]);
    timeouts[0][0]();
    expect(ctx.elements.beeActKeyCopy.classList.contains('copied')).toBe(false);
  });

  test.each([
    ['a failed read', { apiGetImpl: jest.fn(async () => Promise.reject(new Error('down'))) }],
    ['no publicKey', { publicKey: null }],
    ['a malformed key', { publicKey: 'not-a-key' }],
    [
      'a non-OK reply',
      {
        apiGetImpl: jest.fn(async (endpoint) =>
          endpoint === '/addresses'
            ? { ok: false, status: 503, data: { publicKey: ACT_KEY } }
            : { ok: true, status: 200, data: {} }
        ),
      },
    ],
  ])('%s leaves Unknown with the copy button disabled', async (_label, options) => {
    const ctx = await loadBeeModule({ currentAntStatus: 'running', windowBee: false, ...options });
    ctx.mod.initAntUi();
    await openMenu(ctx);

    expect(ctx.elements.beeActKeyText.textContent).toBe('Unknown');
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(true);
    ctx.elements.beeActKeyCopy.dispatch('click');
    await flushMicrotasks();
    expect(ctx.copyText).not.toHaveBeenCalled();
  });

  test('stopping clears the key, and a reopen reads it again from the current node', async () => {
    let key = ACT_KEY;
    const apiGetImpl = jest.fn(async (endpoint) =>
      endpoint === '/addresses'
        ? { ok: true, status: 200, data: { publicKey: key } }
        : { ok: true, status: 200, data: {} }
    );
    const ctx = await loadBeeModule({ currentAntStatus: 'running', windowBee: false, apiGetImpl });
    ctx.mod.initAntUi();
    await openMenu(ctx);
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(false);

    ctx.state.antMenuOpen = false;
    ctx.mod.stopAntInfoPolling();
    expect(ctx.elements.beeActKeyText.textContent).toBe('Unknown');
    expect(ctx.elements.beeActKeyText.getAttribute('title')).toBeFalsy();
    expect(ctx.elements.beeActKeyText.classList.contains('has-key')).toBe(false);
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(true);

    // The endpoint moved to another node (bundled → external Bee).
    key = `03${'cd'.repeat(32)}`;
    await openMenu(ctx);
    expect(ctx.elements.beeActKeyText.textContent).toBe('03cdcd…cdcd');
    jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    ctx.elements.beeActKeyCopy.dispatch('click');
    await flushMicrotasks();
    expect(ctx.copyText).toHaveBeenCalledWith(key);
  });

  test('a reply that lands after the menu was torn down paints nothing', async () => {
    let release;
    const apiGetImpl = jest.fn((endpoint) =>
      endpoint === '/addresses'
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true, status: 200, data: { publicKey: ACT_KEY } });
          })
        : Promise.resolve({ ok: true, status: 200, data: {} })
    );
    const ctx = await loadBeeModule({ currentAntStatus: 'running', windowBee: false, apiGetImpl });
    ctx.mod.initAntUi();
    await openMenu(ctx);

    // Closed and reopened while the first read is still in flight: the panel
    // is visible again, so only the generation check can drop the old reply.
    ctx.state.antMenuOpen = false;
    ctx.mod.stopAntInfoPolling();
    const firstRelease = release;
    ctx.state.antMenuOpen = true;
    ctx.mod.startAntInfoPolling();
    firstRelease();
    await flushMicrotasks();
    expect(ctx.elements.beeActKeyText.textContent).toBe('Unknown');
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(true);

    // The current open's own reply still paints.
    release();
    await flushMicrotasks();
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(false);
  });

  test('a read that found the node still starting is retried once it runs', async () => {
    let up = false;
    const apiGetImpl = jest.fn(async (endpoint) => {
      if (endpoint !== '/addresses') return { ok: true, status: 200, data: {} };
      if (!up) throw new Error('Ant API unreachable');
      return { ok: true, status: 200, data: { publicKey: ACT_KEY } };
    });
    const ctx = await loadBeeModule({ currentAntStatus: 'starting', windowBee: false, apiGetImpl });
    ctx.mod.initAntUi();
    await openMenu(ctx);
    expect(ctx.elements.beeActKeyText.textContent).toBe('Unknown');

    // The menu stays open; the node comes up. The poll intervals already
    // exist, so only updateAntUi can trigger the second read.
    up = true;
    ctx.mod.updateAntUi('running');
    await flushMicrotasks();
    expect(ctx.elements.beeActKeyText.textContent).toBe('02abab…abab');
    expect(ctx.elements.beeActKeyCopy.disabled).toBe(false);

    // Once it has the key, later status refreshes don't read again.
    const reads = apiGetImpl.mock.calls.filter(([e]) => e === '/addresses').length;
    ctx.mod.updateAntUi('running');
    await flushMicrotasks();
    expect(apiGetImpl.mock.calls.filter(([e]) => e === '/addresses').length).toBe(reads);
  });

  test('status refreshes do not stack /addresses reads while one is in flight', async () => {
    const apiGetImpl = jest.fn((endpoint) =>
      endpoint === '/addresses' ? new Promise(() => {}) : Promise.resolve({ ok: true, data: {} })
    );
    const ctx = await loadBeeModule({ currentAntStatus: 'running', windowBee: false, apiGetImpl });
    ctx.mod.initAntUi();
    await openMenu(ctx);
    ctx.mod.updateAntUi('running');
    ctx.mod.updateAntUi('running');
    await flushMicrotasks();
    expect(apiGetImpl.mock.calls.filter(([e]) => e === '/addresses')).toHaveLength(1);
  });
});
