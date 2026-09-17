const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const loadTorModule = async (options = {}) => {
  jest.resetModules();

  const state = {
    currentTorStatus: options.currentTorStatus || 'stopped',
    enableTorIntegration: options.enableTorIntegration ?? true,
    suppressTorRunningStatus: options.suppressTorRunningStatus ?? false,
    registry: {
      tor: {
        mode: options.mode || 'bundled',
        statusMessage: options.statusMessage ?? null,
        tempMessage: options.tempMessage ?? null,
      },
    },
  };
  const getDisplayMessage = jest.fn(
    () => state.registry.tor.tempMessage || state.registry.tor.statusMessage
  );
  const debugMocks = { pushDebug: jest.fn() };

  const torToggleBtn = createElement('button');
  const torToggleSwitch = createElement('div');
  const torStatusLabel = createElement('span');
  const torStatusValue = createElement('span');
  const torStatusRow = createElement('div', { classes: ['tor-info-row', 'node-status-row'] });
  torStatusRow.appendChild(torStatusLabel);
  torStatusRow.appendChild(torStatusValue);
  const torVersionText = createElement('span', { textContent: 'Unknown' });
  const torVersionRow = createElement('div', { classes: ['tor-info-row'] });
  torVersionRow.appendChild(createElement('span', { textContent: 'Version:' }));
  torVersionRow.appendChild(torVersionText);
  // Same nesting as index.html: both rows live inside the one `.tor-info` block.
  const torInfoPanel = createElement('div', { classes: ['tor-info'] });
  torInfoPanel.appendChild(torStatusRow);
  torInfoPanel.appendChild(torVersionRow);
  const torNodesSection = createElement('section');
  const body = createElement('body');
  body.appendChild(torNodesSection);
  torNodesSection.appendChild(torToggleBtn);
  torNodesSection.appendChild(torInfoPanel);

  const document = createDocument({
    body,
    elementsById: {
      'tor-toggle-btn': torToggleBtn,
      'tor-toggle-switch': torToggleSwitch,
      'tor-status-row': torStatusRow,
      'tor-status-label': torStatusLabel,
      'tor-status-value': torStatusValue,
      'tor-version-text': torVersionText,
      'tor-nodes-section': torNodesSection,
    },
  });

  let statusHandler = null;
  const windowHandlers = {};
  const torApi =
    options.windowTor === false
      ? undefined
      : {
          checkBinary: jest.fn().mockResolvedValue({ available: options.binaryAvailable ?? true }),
          getVersion: jest
            .fn()
            .mockResolvedValue(
              options.versionResult || { success: true, name: 'Arti', version: '2.6.0' }
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

  const setIntervalMock = jest.spyOn(global, 'setInterval').mockImplementation(() => 1);

  global.window = {
    tor: torApi,
    addEventListener: jest.fn((event, handler) => {
      windowHandlers[event] = handler;
    }),
  };
  global.document = document;

  jest.doMock('./state.js', () => ({ state, getDisplayMessage }));
  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./tor-ui.js');

  return {
    mod,
    state,
    getDisplayMessage,
    debugMocks,
    torApi,
    setIntervalMock,
    windowHandlers,
    getStatusHandler: () => statusHandler,
    elements: {
      torToggleBtn,
      torToggleSwitch,
      torStatusRow,
      torStatusLabel,
      torStatusValue,
      torVersionText,
      torVersionRow,
      torInfoPanel,
      torNodesSection,
    },
  };
};

// What a user sees beneath the Tor toggle: the `.tor-info` block is
// `display: none` without `.visible` (services.css), so a hidden block means
// neither the status row nor the Version row renders.
const infoVisible = (ctx) => ctx.elements.torInfoPanel.classList.contains('visible');

describe('tor-ui info block visibility (#349)', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a stopped Tor shows nothing beneath its toggle, version row included', async () => {
    // The reported bug: the integration is on, the node is off, and the menu
    // still carried `Version: Arti 2.6.0` while every other node's section was
    // bare. The version is still fetched and cached — it just has nowhere to
    // render until the node is up.
    const ctx = await loadTorModule({ currentTorStatus: 'stopped' });

    ctx.mod.initTorUi();
    await flushMicrotasks();

    expect(ctx.torApi.getVersion).toHaveBeenCalled();
    expect(ctx.elements.torVersionText.textContent).toBe('Arti 2.6.0');
    expect(ctx.elements.torVersionRow.hidden).toBe(false);
    // ...and none of it is on screen, because the block that holds it is not.
    expect(infoVisible(ctx)).toBe(false);
  });

  test('a running Tor shows the status and version rows', async () => {
    const ctx = await loadTorModule({
      currentTorStatus: 'stopped',
      statusMessage: 'SOCKS: 127.0.0.1:9150',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();
    expect(infoVisible(ctx)).toBe(false);

    ctx.mod.updateTorUi('running');

    expect(infoVisible(ctx)).toBe(true);
    expect(ctx.elements.torStatusRow.classList.contains('visible')).toBe(true);
    expect(ctx.elements.torStatusLabel.textContent).toBe('SOCKS:');
    expect(ctx.elements.torStatusValue.textContent).toBe('127.0.0.1:9150');
    expect(ctx.elements.torVersionText.textContent).toBe('Arti 2.6.0');
    expect(ctx.elements.torVersionRow.hidden).toBe(false);
  });

  test('the block follows every run-state transition', async () => {
    const ctx = await loadTorModule({
      currentTorStatus: 'stopped',
      statusMessage: 'Bootstrapping…',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();

    // `starting` already has something to say (the bootstrap progress line),
    // and the toggle is already lit, so the block comes up with it.
    ctx.mod.updateTorUi('starting');
    expect(infoVisible(ctx)).toBe(true);

    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(true);

    ctx.mod.updateTorUi('stopping');
    expect(infoVisible(ctx)).toBe(false);

    ctx.mod.updateTorUi('stopped');
    expect(infoVisible(ctx)).toBe(false);
  });

  test('a failed start keeps the block only for as long as it has a reason to show', async () => {
    // The one state that is not simply "off": the registry's message is the
    // user's only in-menu sign that a start attempt failed, so hiding the block
    // outright on `error` would swallow it. With no message there is nothing to
    // read and the block goes away rather than leaving a lone version row —
    // the exact shape #349 is about.
    const ctx = await loadTorModule({
      currentTorStatus: 'stopped',
      statusMessage: 'External Tor unreachable',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();

    ctx.mod.updateTorUi('error', 'External Tor SOCKS endpoint is unreachable');
    expect(infoVisible(ctx)).toBe(true);
    expect(ctx.elements.torStatusLabel.textContent).toBe('External Tor unreachable');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'Tor Error: External Tor SOCKS endpoint is unreachable'
    );

    // The registry drops the message on a later broadcast — no status change,
    // so updateTorStatusLine is the only thing that runs.
    ctx.state.registry.tor.statusMessage = null;
    ctx.mod.updateTorStatusLine();
    expect(infoVisible(ctx)).toBe(false);
  });

  test('turning the integration off in Settings takes the block down with the section', async () => {
    const ctx = await loadTorModule({
      currentTorStatus: 'stopped',
      statusMessage: 'SOCKS: 127.0.0.1:9150',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();
    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(true);

    ctx.windowHandlers['settings:updated']({ detail: { enableTorIntegration: false } });

    expect(ctx.elements.torNodesSection.classList.contains('hidden')).toBe(true);
    expect(infoVisible(ctx)).toBe(false);

    // A late status update for a now-disabled integration must not bring it
    // back: updateTorUi returns early on that path.
    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(false);
  });

  test('a stale running update cannot outlive an integration disabled elsewhere', async () => {
    // `state.enableTorIntegration` has a second writer: state.js's
    // applySettingsToState, driven by index.js on a settings load, which does
    // not go through the `settings:updated` event tor-ui listens to. So
    // updateTorUi's own disabled branch — not updateTorSectionVisibility — is
    // what has to take the block down on this path.
    const ctx = await loadTorModule({
      currentTorStatus: 'running',
      statusMessage: 'SOCKS: 127.0.0.1:9150',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();
    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(true);

    ctx.state.enableTorIntegration = false;
    ctx.mod.updateTorUi('running');

    expect(ctx.state.currentTorStatus).toBe('stopped');
    expect(infoVisible(ctx)).toBe(false);
  });

  test('external mode drops the bundled version row but still gates on run state', async () => {
    const ctx = await loadTorModule({
      currentTorStatus: 'stopped',
      mode: 'external',
      statusMessage: 'External SOCKS: 127.0.0.1:9050',
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();

    expect(ctx.torApi.getVersion).not.toHaveBeenCalled();
    expect(infoVisible(ctx)).toBe(false);

    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(true);
    // The bundled-version row has nothing to say about someone else's node.
    expect(ctx.elements.torVersionRow.hidden).toBe(true);
    expect(ctx.elements.torVersionText.textContent).toBe('');
  });

  test('toggling the node off from the menu takes the block down with it', async () => {
    const ctx = await loadTorModule({
      currentTorStatus: 'running',
      statusMessage: 'SOCKS: 127.0.0.1:9150',
      stopResult: { status: 'stopping', error: null },
    });

    ctx.mod.initTorUi();
    await flushMicrotasks();
    ctx.mod.updateTorUi('running');
    expect(infoVisible(ctx)).toBe(true);

    ctx.state.currentTorStatus = 'running';
    ctx.elements.torToggleBtn.dispatch('click');
    await flushMicrotasks();

    expect(ctx.torApi.stop).toHaveBeenCalled();
    expect(infoVisible(ctx)).toBe(false);
  });
});
