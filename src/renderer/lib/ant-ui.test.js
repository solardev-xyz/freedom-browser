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
  const beeVerifyFailedNotice = createElement('p');
  beeVerifyFailedNotice.hidden = true; // as the markup ships it
  const beeMessagesOffNotice = createElement('p');
  beeMessagesOffNotice.hidden = true; // as the markup ships it
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
      'bee-verify-failed-notice': beeVerifyFailedNotice,
      'bee-messages-off-notice': beeMessagesOffNotice,
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
    ...(options.swarmMessages ? { swarmMessages: options.swarmMessages } : {}),
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
      beeVerifyFailedNotice,
      beeMessagesOffNotice,
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

  // freedom-core design 0009, Failures: "The nodes panel counts verification
  // failures per backend and shows "Your external node served content that
  // failed verification" while any occurred in the last 10 minutes."
  describe("the external Swarm node's verification failures", () => {
    const running = (externalVerifyFailures) => ({
      status: 'running',
      error: null,
      externalVerifyFailures,
    });
    // The status poll the Swarm section already runs every 5 s.
    const statusPoll = (ctx) => ctx.setIntervalMock.mock.calls.find(([, ms]) => ms === 5000)[0];

    test('shown while main counts a failure, read when the panel opens and at the status poll', async () => {
      const ctx = await loadBeeModule({
        antMenuOpen: true,
        currentAntStatus: 'running',
        mode: 'reused',
        statusResult: running(2),
      });
      const notice = ctx.elements.beeVerifyFailedNotice;
      ctx.mod.initAntUi();
      await flushMicrotasks();
      // The first status read finds the node running and opens the section.
      expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(true);
      expect(notice.hidden).toBe(false);
      // The rest of the section is unchanged.
      expect(ctx.elements.beePeersCount.textContent).toBe('2');

      // The window passed (main says 0), then another failure.
      ctx.beeApi.getStatus.mockResolvedValue(running(0));
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(notice.hidden).toBe(true);
      ctx.beeApi.getStatus.mockResolvedValue(running(1));
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(notice.hidden).toBe(false);

      // A status push carries no count, and leaves the notice as it is.
      ctx.getStatusHandler()({ status: 'running', error: null });
      expect(notice.hidden).toBe(false);

      // Closing the menu clears it; a poll while it is closed shows nothing,
      // and the next open reads again.
      ctx.state.antMenuOpen = false;
      ctx.mod.stopAntInfoPolling();
      expect(notice.hidden).toBe(true);
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(notice.hidden).toBe(true);
      ctx.state.antMenuOpen = true;
      ctx.mod.startAntInfoPolling();
      await flushMicrotasks();
      expect(notice.hidden).toBe(false);

      // The node stopping closes the section, and the notice with it.
      ctx.beeApi.getStatus.mockResolvedValue({ status: 'stopped', error: null });
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(false);
      expect(notice.hidden).toBe(true);
    });

    test.each([
      ['no count (an older main)', { status: 'running', error: null }],
      ['zero', running(0)],
      ['a negative count', running(-1)],
      ['a string', running('3')],
      ['a boolean', running(true)],
      ['a fraction', running(0.5)],
    ])('nothing for %s', async (_what, reply) => {
      const ctx = await loadBeeModule({
        antMenuOpen: true,
        currentAntStatus: 'running',
        statusResult: reply,
      });
      ctx.mod.initAntUi();
      ctx.mod.startAntInfoPolling();
      await flushMicrotasks();
      expect(ctx.elements.beeVerifyFailedNotice.hidden).toBe(true);
    });

    test('a failed read hides it, and a reply that lands after the menu closed is dropped', async () => {
      const ctx = await loadBeeModule({
        antMenuOpen: true,
        currentAntStatus: 'running',
        statusResult: running(1),
      });
      const notice = ctx.elements.beeVerifyFailedNotice;
      ctx.mod.initAntUi();
      ctx.mod.startAntInfoPolling();
      await flushMicrotasks();
      expect(notice.hidden).toBe(false);

      ctx.beeApi.getStatus.mockRejectedValueOnce(new Error('ipc gone'));
      ctx.mod.startAntInfoPolling();
      await flushMicrotasks();
      expect(notice.hidden).toBe(true);

      let answer;
      ctx.beeApi.getStatus.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        })
      );
      ctx.mod.startAntInfoPolling();
      ctx.state.antMenuOpen = false;
      ctx.mod.stopAntInfoPolling();
      answer(running(4));
      await flushMicrotasks();
      expect(notice.hidden).toBe(true);
    });
  });

  // freedom-core design 0015, Messaging, question 4 (SWM-7's PR 7.5): "the
  // Nodes panel says 'Live messages are off while Tor is on: …', as it shows
  // the node's other conditions", while main refuses subscriptions to the
  // node in use. Main words it and says when; the panel shows what it gets.
  describe('live messages off over a proxy or Tor', () => {
    const TOR = {
      panel: 'Live messages are off while Tor is on: they would go around it to your external node',
      settings: 'Live messages are off while Tor is on: they would go around it to your external node.',
    };
    const PROXY = {
      panel: 'Live messages are off while your proxy is on: they would go around it to your external node',
      settings: 'Live messages are off while your proxy is on: they would go around it to your external node.',
    };
    const OFF = { panel: null, settings: null };
    const statusPoll = (ctx) => ctx.setIntervalMock.mock.calls.find(([, ms]) => ms === 5000)[0];

    const swarmMessages = (route) => {
      let push = null;
      return {
        getRoute: jest.fn(async () => route.now),
        onRoute: jest.fn((handler) => {
          push = handler;
        }),
        onNotice: jest.fn(),
        push: (value) => push(value),
      };
    };

    const open = async (route, options = {}) => {
      const api = swarmMessages(route);
      const ctx = await loadBeeModule({
        antMenuOpen: true,
        currentAntStatus: 'running',
        mode: 'external',
        statusResult: { status: 'running', error: null },
        swarmMessages: api,
        ...options,
      });
      ctx.mod.initAntUi();
      await flushMicrotasks();
      return { ctx, api, line: ctx.elements.beeMessagesOffNotice };
    };

    test("main's words, read when the panel opens and at the status poll while it's open", async () => {
      const route = { now: PROXY };
      const { ctx, api, line } = await open(route);
      expect(ctx.elements.beeInfoPanel.classList.contains('visible')).toBe(true);
      expect(api.getRoute).toHaveBeenCalled();
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(PROXY.panel);

      // Tor takes the route, read at the next poll.
      route.now = TOR;
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(line.textContent).toBe(TOR.panel);

      // The node moves to loopback (or the bundled node): main says nothing.
      route.now = OFF;
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(line.hidden).toBe(true);
      expect(line.textContent).toBe('');
    });

    test('a push from main updates it at once, open or not', async () => {
      const route = { now: OFF };
      const { api, line } = await open(route);
      expect(line.hidden).toBe(true);
      api.push(TOR);
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(TOR.panel);
      api.push(PROXY);
      expect(line.textContent).toBe(PROXY.panel);
      api.push(OFF);
      expect(line.hidden).toBe(true);
    });

    test('not read while the panel is closed', async () => {
      const route = { now: PROXY };
      const { ctx, api } = await open(route, { antMenuOpen: false, currentAntStatus: 'stopped' });
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(api.getRoute).not.toHaveBeenCalled();
    });

    test('a failed read keeps the last line; a malformed answer shows nothing', async () => {
      const route = { now: PROXY };
      const { ctx, api, line } = await open(route);
      api.getRoute.mockRejectedValueOnce(new Error('ipc gone'));
      statusPoll(ctx)();
      await flushMicrotasks();
      expect(line.textContent).toBe(PROXY.panel);
      for (const bad of [null, undefined, {}, { panel: 7 }, 'text']) {
        api.push(bad);
        expect(line.hidden).toBe(true);
      }
    });

    // Codex round 1 on #1382: main's real notices behind the panel. The
    // panel's read is slow, a node change pushes newer lines meanwhile, and
    // then the slow read's reply lands: it must not stand over the push.
    test("with main's real notices: a slow read's late reply never stands over a newer push", async () => {
      const { createSubscriptionRouteNotices } = require('../../main/swarm/subscription-route-notices');
      const IPC = require('../../shared/ipc-channels');
      let pushToChrome = null;
      const held = [];
      const node = { refusal: null, slow: true };
      const notices = createSubscriptionRouteNotices({
        checkRoute: () =>
          node.slow ? new Promise((resolve) => held.push(resolve)) : Promise.resolve(node.refusal),
        nodeUrl: () => 'https://ant.example:1633',
        noticeWindow: () => null,
        chromeWindows: () => [
          {
            isDestroyed: () => false,
            webContents: {
              send: (channel, payload) => {
                if (channel === IPC.SWARM_MESSAGES_ROUTE) pushToChrome?.(payload);
              },
            },
          },
        ],
      });
      const api = {
        getRoute: jest.fn(() => notices.refresh()),
        onRoute: jest.fn((handler) => {
          pushToChrome = handler;
        }),
        onNotice: jest.fn(),
      };
      const ctx = await loadBeeModule({
        antMenuOpen: true,
        currentAntStatus: 'running',
        mode: 'external',
        statusResult: { status: 'running', error: null },
        swarmMessages: api,
      });
      const line = ctx.elements.beeMessagesOffNotice;
      ctx.mod.initAntUi();
      await flushMicrotasks();
      // The panel opened and read; the read waits (the node reached directly).
      expect(api.getRoute).toHaveBeenCalledTimes(1);
      expect(held).toHaveLength(1);

      // A proxy comes on: main reads again at the change and pushes.
      node.slow = false;
      node.refusal = { reason: 'proxy-or-tor', via: 'proxy' };
      await notices.refresh();
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(PROXY.panel);

      // The slow read's own answer, from before the change, lands last.
      held[0](null);
      await flushMicrotasks();
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(PROXY.panel);
    });

    test('a chrome with no such API leaves the line hidden', async () => {
      const ctx = await loadBeeModule({ antMenuOpen: true, currentAntStatus: 'running' });
      ctx.mod.initAntUi();
      ctx.mod.startAntInfoPolling();
      await flushMicrotasks();
      expect(ctx.elements.beeMessagesOffNotice.hidden).toBe(true);
    });
  });
});
