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
    antMenuOpen: options.antMenuOpen ?? false,
    currentIpfsStatus: options.currentIpfsStatus || 'stopped',
    ipfsInfoInterval: null,
    ipfsVersionFetched: options.ipfsVersionFetched ?? false,
    ipfsVersionValue: options.ipfsVersionValue || '',
    ipfsDesiredRunning: options.ipfsDesiredRunning ?? null,
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
  const ipfsActiveRequestsCount = createElement('span');
  const ipfsDataRead = createElement('span');
  const ipfsSandboxText = createElement('span');
  const ipfsPeersCount = createElement('span');
  const ipfsBandwidth = createElement('span');
  const ipfsVersionText = createElement('span');
  const ipfsInfoPanel = createElement('div', {
    classes: ['ipfs-info'],
  });
  const ipfsStatusRow = createElement('div');
  const ipfsStatusLabel = createElement('span');
  const ipfsStatusValue = createElement('span');
  const ipfsUnverifiableNotice = createElement('p');
  ipfsUnverifiableNotice.hidden = true; // as the markup ships it
  const ipfsVerifyFailedNotice = createElement('p');
  ipfsVerifyFailedNotice.hidden = true;
  const body = createElement('body');
  body.appendChild(ipfsInfoPanel);
  const document = createDocument({
    body,
    elementsById: {
      'ipfs-toggle-btn': ipfsToggleBtn,
      'ipfs-toggle-switch': ipfsToggleSwitch,
      'ipfs-active-requests-count': ipfsActiveRequestsCount,
      'ipfs-data-read': ipfsDataRead,
      'ipfs-sandbox-text': ipfsSandboxText,
      'ipfs-peers-count': ipfsPeersCount,
      'ipfs-bandwidth': ipfsBandwidth,
      'ipfs-version-text': ipfsVersionText,
      'ipfs-status-row': ipfsStatusRow,
      'ipfs-status-label': ipfsStatusLabel,
      'ipfs-status-value': ipfsStatusValue,
      'ipfs-unverifiable-notice': ipfsUnverifiableNotice,
      'ipfs-verify-failed-notice': ipfsVerifyFailedNotice,
    },
  });
  let statusHandler = null;
  const ipfsApi =
    options.windowIpfs === false
      ? undefined
      : {
          checkBinary: jest.fn().mockResolvedValue({ available: options.binaryAvailable ?? true }),
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
      ipfsActiveRequestsCount,
      ipfsDataRead,
      ipfsSandboxText,
      ipfsPeersCount,
      ipfsBandwidth,
      ipfsVersionText,
      ipfsInfoPanel,
      ipfsStatusRow,
      ipfsStatusLabel,
      ipfsStatusValue,
      ipfsUnverifiableNotice,
      ipfsVerifyFailedNotice,
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
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: {
          nativeVersion: '0.4.1',
          nativeBuildInfo: JSON.stringify({
            name: 'freedom-ipfs',
            version: '0.4.1',
            release_tag: 'v0.4.1',
          }),
          nativeGatewayStats: JSON.stringify({
            active_native_handles: 3,
            bytes_read: 1536,
          }),
        },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.buildIpfsApiUrl).not.toHaveBeenCalled();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(true);
    // The managed node shows its own gateway counters, not external-node rows.
    expect(ctx.elements.ipfsInfoPanel.classList.contains('external')).toBe(false);
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalledWith({ nodeStats: true });
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('3');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('1.5 KB');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS 0.4.1');
    expect(ctx.state.ipfsVersionFetched).toBe(true);
    expect(ctx.state.ipfsInfoInterval).toBe(2);
    expect(ctx.setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 1000);

    ctx.mod.stopIpfsInfoPolling();

    expect(ctx.clearIntervalMock).toHaveBeenCalledWith(2);
    expect(ctx.state.ipfsInfoInterval).toBeNull();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(false);
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('0');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS 0.4.1');
  });

  // freedom-core design 0010, "Reporting": the service's confinement, off
  // the build info, in the panel's Sandbox row.
  test("shows the service's sandbox, with each property in its title", async () => {
    const confinement = {
      mechanism: 'landlock-4+seccomp',
      files: 'enforced',
      exec: 'enforced',
      ipc: 'partial',
      network: 'none',
      gaps: ['signals'],
      resolution: 'system',
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: {
          nativeBuildInfo: JSON.stringify({
            name: 'freedom-ipfs',
            version: '0.4.1',
            service: { name: 'freedom-ipfsd', confinement },
          }),
          nativeGatewayStats: JSON.stringify({ active_native_handles: 0, bytes_read: 0 }),
        },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.ipfsSandboxText.textContent).toBe('Partial');
    expect(ctx.elements.ipfsSandboxText.title).toBe(
      [
        'Files: enforced',
        'Programs: enforced',
        'Local IPC: partial',
        'Network: none',
        'Open: signals',
        'Mechanism: landlock-4+seccomp',
      ].join('\n')
    );

    ctx.mod.stopIpfsInfoPolling();
    expect(ctx.elements.ipfsSandboxText.textContent).toBe('Unknown');
    expect(ctx.elements.ipfsSandboxText.title).toBe('');
  });

  test('names the sandbox Enforced, Partial, Unavailable or Unknown', async () => {
    const { mod } = await loadIpfsModule();
    const all = { files: 'enforced', exec: 'enforced', ipc: 'enforced', network: 'enforced' };
    expect(mod.sandboxLabel({ mechanism: 'landlock-6+seccomp', ...all })).toBe('Enforced');
    // `none`: the policy asks for no rule there (direct mode's network).
    expect(mod.sandboxLabel({ mechanism: 'seatbelt', ...all, network: 'none' })).toBe('Enforced');
    expect(mod.sandboxLabel({ mechanism: 'landlock-1', ...all, ipc: 'unavailable' })).toBe(
      'Partial'
    );
    expect(mod.sandboxLabel({ mechanism: 'landlock-4', ...all, files: 'blocked' })).toBe('Partial');
    // Windows from freedom-ipfsd 0.4.0: the job, with files and local IPC
    // still unconfined.
    const job = {
      mechanism: 'job',
      files: 'unavailable',
      exec: 'partial',
      ipc: 'unavailable',
      network: 'none',
      gaps: ['parent_process'],
    };
    expect(mod.sandboxLabel(job)).toBe('Partial');
    expect(mod.sandboxDetail(job)).toBe(
      [
        'Files: unavailable',
        'Programs: partial',
        'Local IPC: unavailable',
        'Network: none',
        'Open: parent_process',
        'Mechanism: job',
      ].join('\n')
    );
    expect(mod.sandboxLabel({ mechanism: 'none', files: 'unavailable' })).toBe('Unavailable');
    expect(mod.sandboxLabel(null)).toBe('Unknown');
    expect(mod.sandboxDetail(null)).toBe('');
  });

  test('updates IPFS status lines, toggle state, and running transitions', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
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

    // While a stop is pending, a stale 'running' update must not flip the
    // switch back on before the node data settles.
    ctx.state.ipfsDesiredRunning = false;
    ctx.elements.ipfsToggleSwitch.classList.remove('running');
    ctx.mod.updateIpfsUi('running');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
    expect(ctx.state.ipfsDesiredRunning).toBe(false);

    ctx.mod.updateIpfsUi('error', 'offline');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith('IPFS Error: offline');

    ctx.mod.updateIpfsUi('stopped');
    expect(ctx.elements.ipfsStatusRow.classList.contains('visible')).toBe(false);
  });

  test('initializes IPFS controls, handles binary availability, and toggles start and stop', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      binaryAvailable: false,
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    expect(ctx.ipfsApi.checkBinary).toHaveBeenCalled();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.debugMocks.pushDebug).toHaveBeenCalledWith(
      'IPFS binary not found - toggle disabled'
    );
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

  // #350: on a host where the native addon can't load, an external gateway is
  // the only way to get IPFS at all — so the missing addon must not disable the
  // toggle, whichever of the two writers (binary probe, registry mode) lands last.
  test('keeps the toggle usable in external mode even when the native addon is absent', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      binaryAvailable: false,
      mode: 'external',
      statusResult: { status: 'stopped', error: null },
      startResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // The binary probe resolved last and must not have re-disabled the switch.
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(false);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBeUndefined();
    expect(ctx.elements.ipfsToggleBtn.getAttribute('title')).toBe('Using an external IPFS gateway');

    ctx.elements.ipfsToggleBtn.dispatch('click');
    await flushMicrotasks();
    expect(ctx.ipfsApi.start).toHaveBeenCalled();

    // Switching the profile off external with no addon disables it again.
    ctx.state.registry.ipfs.mode = 'none';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(true);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBe('true');
    expect(ctx.elements.ipfsToggleBtn.getAttribute('title')).toBe('IPFS binary not found');

    // ...and back on again without a relaunch, the registry update alone re-arms it.
    ctx.state.registry.ipfs.mode = 'external';
    ctx.mod.updateIpfsToggleState();
    expect(ctx.elements.ipfsToggleBtn.classList.contains('disabled')).toBe(false);
    expect(ctx.elements.ipfsToggleBtn.getAttribute('disabled')).toBeUndefined();
  });

  test('switches the toggle instantly on each click and converges the backend to the final state', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: { status: 'running', error: null },
      stopResult: { status: 'stopped', error: null },
      startResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // Each click flips the switch immediately — no waiting on the backend.
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    // The background reconcile loop drives the node to the final "on" target
    // (stop() then start(), in order), then clears the pending intent.
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.ipfsApi.stop).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.start).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.stop.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.ipfsApi.start.mock.invocationCallOrder[0]
    );
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
  });

  test('never flickers the switch to an intermediate backend status during convergence', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: { status: 'stopped', error: null },
      startResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    // Stale/intermediate backend updates arriving mid-transition must not move
    // the switch off the user's latest click.
    ctx.mod.updateIpfsUi('stopped');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    ctx.mod.updateIpfsUi('starting');
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    // Once the loop reaches the target the intent clears and the switch stays on.
    await flushMicrotasks();
    await flushMicrotasks();
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
  });

  test('settles the switch off when a start fails to bring the node up', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: { status: 'stopped', error: null },
      startResult: { status: 'error', error: 'boom' },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    ctx.elements.ipfsToggleBtn.dispatch('click');
    // Optimistically on right after the click.
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    await flushMicrotasks();

    // start() reported the node never came up: intent clears and the switch
    // settles off to match reality.
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
  });

  test('re-syncs the switch back on when a stop settles but the node is still running', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: { status: 'running', error: null },
      // The stop didn't take effect — the node reports it's still running.
      stopResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    ctx.elements.ipfsToggleBtn.dispatch('click');
    // Optimistically off right after the click.
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    await flushMicrotasks();

    // The stop settled but the node is still up: rather than stay stuck off, the
    // intent clears and the switch re-syncs to the live 'running' status.
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.ipfsInfoInterval).not.toBeNull();
  });

  test('polls stats during a pending "on" toggle while live status is still stopped', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: {
        status: 'stopped',
        error: null,
        diagnostics: {
          nativeGatewayStats: JSON.stringify({ active_native_handles: 2, bytes_read: 2048 }),
        },
      },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // User just clicked on; the backend hasn't confirmed yet (live status is
    // still 'stopped'). Polling must run on the pending intent, not bail and
    // leave the panel blank.
    ctx.state.ipfsDesiredRunning = true;
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.ipfsInfoPanel.classList.contains('visible')).toBe(true);
    expect(ctx.state.ipfsInfoInterval).not.toBeNull();
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('2');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('2.0 KB');
  });

  // #417: an external node (e.g. Kubo) shows peers/bandwidth from its RPC API
  // instead of freedom-ipfs's own gateway counters.
  test('shows peers and bandwidth instead of freedom-ipfs counters for an external node', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: {
          nativeGatewayStats: JSON.stringify({ active_native_handles: 7, bytes_read: 9999 }),
          externalGateway: 'http://127.0.0.1:8080',
          externalVersion: 'Kubo 0.30.0',
          externalNodeStats: { peers: 42, rateIn: 1536, rateOut: 2 * 1024 * 1024 },
        },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.ipfsApi.getStatus).toHaveBeenCalledWith({ nodeStats: true });
    expect(ctx.elements.ipfsInfoPanel.classList.contains('external')).toBe(true);
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('42');
    expect(ctx.elements.ipfsBandwidth.textContent).toBe('↓1.5 KB/s ↑2.0 MB/s');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Kubo 0.30.0');
    // The managed counters are not written from an external node's proxy tally.
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('');
    expect(ctx.elements.ipfsDataRead.textContent).toBe('');

    ctx.mod.stopIpfsInfoPolling();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('0');
    expect(ctx.elements.ipfsBandwidth.textContent).toBe('');

    // Switching the profile back to the managed node swaps the rows back.
    ctx.state.registry.ipfs.mode = 'bundled';
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('external')).toBe(false);
    expect(ctx.elements.ipfsActiveRequestsCount.textContent).toBe('7');
  });

  // R1-M1: until the first stats read lands (the RPC may take up to its 2s
  // timeout), the external rows read Unknown, not the markup/reset `0`/blank —
  // on first open, on a reopen after close, and on a flip to external mode.
  test('external rows read Unknown until the first stats read lands', async () => {
    const external = {
      status: 'running',
      error: null,
      diagnostics: {
        externalGateway: 'http://127.0.0.1:8080',
        externalVersion: 'Kubo 0.30.0',
        externalNodeStats: { peers: 5, rateIn: 0, rateOut: 0 },
      },
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
    });
    const pending = [];
    ctx.ipfsApi.getStatus.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(external)))
    );

    ctx.mod.initIpfsUi();
    ctx.elements.ipfsPeersCount.textContent = '0'; // markup default
    ctx.mod.startIpfsInfoPolling();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('Unknown');
    expect(ctx.elements.ipfsBandwidth.textContent).toBe('Unknown');

    // A repeat start while already open (updateIpfsUi) must not blank a reading.
    pending.splice(0).forEach((resolve) => resolve());
    await flushMicrotasks();
    await flushMicrotasks();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('5');
    ctx.mod.startIpfsInfoPolling();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('5');

    // Close resets to 0; reopening shows Unknown again, not the stale reset.
    ctx.mod.stopIpfsInfoPolling();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('0');
    ctx.mod.startIpfsInfoPolling();
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('Unknown');
    expect(ctx.elements.ipfsBandwidth.textContent).toBe('Unknown');
    pending.splice(0).forEach((resolve) => resolve());
    await flushMicrotasks();
    await flushMicrotasks();

    // Flip managed -> external while the menu stays open.
    ctx.mod.stopIpfsInfoPolling();
    ctx.state.registry.ipfs.mode = 'bundled';
    ctx.mod.startIpfsInfoPolling();
    ctx.elements.ipfsPeersCount.textContent = '0';
    ctx.state.registry.ipfs.mode = 'external';
    ctx.mod.startIpfsInfoPolling();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('external')).toBe(true);
    expect(ctx.elements.ipfsPeersCount.textContent).toBe('Unknown');
  });

  test('reads Unknown, not 0 peers, when the external node exposes no RPC', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: {
          externalGateway: 'https://gw.example.com',
          externalVersion: null,
          externalNodeStats: null,
        },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(ctx.elements.ipfsPeersCount.textContent).toBe('Unknown');
    expect(ctx.elements.ipfsBandwidth.textContent).toBe('Unknown');
    expect(ctx.elements.ipfsVersionText.textContent).toBe('External · gw.example.com');
  });

  // freedom-core design 0009, Modes: "A gateway that fails the first [probe]
  // serves `unverified`, and the nodes panel says "This gateway doesn't serve
  // verifiable responses"" -- while its verification is on.
  test("says an external gateway without raw blocks can't be verified, while verification is on", async () => {
    const diagnostics = {
      externalGateway: 'http://127.0.0.1:8080',
      externalVersion: 'Kubo 0.30.0',
      externalNodeStats: null,
      externalSupport: { raw: false, car: false },
      externalVerify: true,
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
    });
    ctx.ipfsApi.getStatus.mockImplementation(async () => ({
      status: 'running',
      error: null,
      diagnostics,
    }));
    const notice = ctx.elements.ipfsUnverifiableNotice;
    const poll = async () => {
      ctx.mod.startIpfsInfoPolling();
      await flushMicrotasks();
      await flushMicrotasks();
    };

    ctx.mod.initIpfsUi();
    await poll();
    expect(notice.hidden).toBe(false);
    // The rest of the external rows are unchanged.
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Kubo 0.30.0');

    // The switch off: nothing is verified anyway, and Settings says so.
    diagnostics.externalVerify = false;
    await poll();
    expect(notice.hidden).toBe(true);
    diagnostics.externalVerify = true;
    await poll();
    expect(notice.hidden).toBe(false);

    // Closing the menu clears it; the next poll decides again.
    ctx.mod.stopIpfsInfoPolling();
    expect(notice.hidden).toBe(true);
    await poll();
    expect(notice.hidden).toBe(false);

    // A gateway with raw blocks, with or without ordered CARs.
    for (const support of [
      { raw: true, car: true },
      { raw: true, car: false },
    ]) {
      diagnostics.externalSupport = support;
      await poll();
      expect(notice.hidden).toBe(true);
    }

    // No probe's result yet, or none in the diagnostics at all.
    diagnostics.externalSupport = null;
    await poll();
    expect(notice.hidden).toBe(true);
    delete diagnostics.externalSupport;
    await poll();
    expect(notice.hidden).toBe(true);
  });

  test("the unverifiable gateway's notice goes with the external node, and on a failed read", async () => {
    const external = {
      status: 'running',
      error: null,
      diagnostics: {
        externalGateway: 'http://127.0.0.1:8080',
        externalNodeStats: null,
        externalSupport: { raw: false, car: false },
        externalVerify: true,
      },
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
      statusResult: external,
    });
    const notice = ctx.elements.ipfsUnverifiableNotice;
    const poll = async () => {
      ctx.mod.startIpfsInfoPolling();
      await flushMicrotasks();
      await flushMicrotasks();
    };

    ctx.mod.initIpfsUi();
    await poll();
    expect(notice.hidden).toBe(false);

    // The profile back on its managed node while the menu stays open.
    ctx.state.registry.ipfs.mode = 'bundled';
    ctx.ipfsApi.getStatus.mockResolvedValue({
      status: 'running',
      error: null,
      diagnostics: { nativeGatewayStats: '{"active_native_handles":1}' },
    });
    await poll();
    expect(ctx.elements.ipfsInfoPanel.classList.contains('external')).toBe(false);
    expect(notice.hidden).toBe(true);

    // External again, then a status read that fails: nothing is claimed.
    ctx.state.registry.ipfs.mode = 'external';
    ctx.ipfsApi.getStatus.mockResolvedValue(external);
    await poll();
    expect(notice.hidden).toBe(false);
    ctx.ipfsApi.getStatus.mockRejectedValue(new Error('ipc gone'));
    await poll();
    expect(notice.hidden).toBe(true);
  });

  // freedom-core design 0009, Failures: "The nodes panel counts verification
  // failures per backend and shows "Your external node served content that
  // failed verification" while any occurred in the last 10 minutes."
  test('says the external gateway served content that failed verification while main counts a failure', async () => {
    const diagnostics = {
      externalGateway: 'http://127.0.0.1:8080',
      externalVersion: 'Kubo 0.30.0',
      externalNodeStats: null,
      externalSupport: { raw: true, car: true },
      externalVerify: true,
      externalVerifyFailures: 2,
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
    });
    ctx.ipfsApi.getStatus.mockImplementation(async () => ({
      status: 'running',
      error: null,
      diagnostics,
    }));
    const notice = ctx.elements.ipfsVerifyFailedNotice;
    const poll = async () => {
      ctx.mod.startIpfsInfoPolling();
      await flushMicrotasks();
      await flushMicrotasks();
    };

    ctx.mod.initIpfsUi();
    await poll();
    expect(notice.hidden).toBe(false);
    // #1012's line is its own: this gateway serves raw blocks.
    expect(ctx.elements.ipfsUnverifiableNotice.hidden).toBe(true);
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Kubo 0.30.0');

    // The window passed (main says 0), then another failure.
    diagnostics.externalVerifyFailures = 0;
    await poll();
    expect(notice.hidden).toBe(true);
    diagnostics.externalVerifyFailures = 1;
    await poll();
    expect(notice.hidden).toBe(false);

    // It follows main's count, not the switch: content that failed is
    // reported whatever the setting is now.
    diagnostics.externalVerify = false;
    await poll();
    expect(notice.hidden).toBe(false);

    // Closing the menu clears it; the next poll decides again.
    ctx.mod.stopIpfsInfoPolling();
    expect(notice.hidden).toBe(true);
    await poll();
    expect(notice.hidden).toBe(false);

    // Anything but a positive count shows nothing.
    for (const value of [undefined, null, -1, '3', true, 0.5]) {
      diagnostics.externalVerifyFailures = value;
      await poll();
      expect(notice.hidden).toBe(true);
    }
  });

  test('the failure notice goes with the external gateway, and on a failed read', async () => {
    const external = {
      status: 'running',
      error: null,
      diagnostics: {
        externalGateway: 'http://127.0.0.1:8080',
        externalNodeStats: null,
        externalSupport: { raw: true, car: false },
        externalVerify: true,
        externalVerifyFailures: 1,
      },
    };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      mode: 'external',
      statusResult: external,
    });
    const notice = ctx.elements.ipfsVerifyFailedNotice;
    const poll = async () => {
      ctx.mod.startIpfsInfoPolling();
      await flushMicrotasks();
      await flushMicrotasks();
    };

    ctx.mod.initIpfsUi();
    await poll();
    expect(notice.hidden).toBe(false);

    // The profile back on its managed node while the menu stays open, even
    // with a count in the diagnostics.
    ctx.state.registry.ipfs.mode = 'bundled';
    ctx.ipfsApi.getStatus.mockResolvedValue({
      status: 'running',
      error: null,
      diagnostics: { nativeGatewayStats: '{"active_native_handles":1}', externalVerifyFailures: 1 },
    });
    await poll();
    expect(notice.hidden).toBe(true);

    // External again, then a status read that fails: nothing is claimed.
    ctx.state.registry.ipfs.mode = 'external';
    ctx.ipfsApi.getStatus.mockResolvedValue(external);
    await poll();
    expect(notice.hidden).toBe(false);
    ctx.ipfsApi.getStatus.mockRejectedValue(new Error('ipc gone'));
    await poll();
    expect(notice.hidden).toBe(true);
  });

  test('falls back to the menu-wide Unknown placeholder when diagnostics are missing', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: {
        status: 'running',
        error: null,
        diagnostics: { nativeVersion: '', nativeBuildInfo: '' },
      },
    });

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    // #253: one placeholder for every Nodes-menu Version row, not a bare
    // product name with no version after it.
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Unknown');
    expect(ctx.state.ipfsVersionValue).toBe('');
  });

  test('upgrades the version label once IPFS reports a real version after starting', async () => {
    // Node has no version yet (still spinning up after a start from stopped).
    let diagnostics = { nativeGatewayStats: JSON.stringify({ bytes_read: 0 }) };
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
    });
    ctx.ipfsApi.getStatus.mockImplementation(async () => ({
      status: 'running',
      error: null,
      diagnostics,
    }));

    ctx.mod.initIpfsUi();
    ctx.mod.startIpfsInfoPolling();
    await flushMicrotasks();
    await flushMicrotasks();

    // First poll ran before a version was available: show the placeholder but
    // do NOT cache it, so later polls can still upgrade.
    expect(ctx.elements.ipfsVersionText.textContent).toBe('Unknown');
    expect(ctx.state.ipfsVersionFetched).toBe(false);

    // The node finishes starting and now reports a version; the next poll tick
    // upgrades the label and caches it.
    diagnostics = { nativeVersion: '0.4.2' };
    const statsPoll = ctx.setIntervalMock.mock.calls.find((call) => call[1] === 1000)[0];
    await statsPoll();
    await flushMicrotasks();

    expect(ctx.elements.ipfsVersionText.textContent).toBe('Freedom IPFS 0.4.2');
    expect(ctx.state.ipfsVersionFetched).toBe(true);
  });

  test('reverts optimistic UI to real status when a toggle IPC rejects', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // start() throws at the IPC layer; a follow-up status query shows the node
    // never came up.
    ctx.ipfsApi.start.mockRejectedValueOnce(new Error('ipc boom'));
    ctx.ipfsApi.getStatus.mockResolvedValueOnce({ status: 'stopped', error: null });

    ctx.elements.ipfsToggleBtn.dispatch('click');
    // Optimistically on right after the click.
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);

    await flushMicrotasks();
    await flushMicrotasks();

    // The rejection dropped the optimistic intent, re-queried status, and
    // settled the switch back off instead of polling a node that never started.
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalled();
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
    expect(ctx.state.ipfsInfoInterval).toBeNull();
  });

  test('reverts the switch back on when a stop() IPC rejects but the node is still running', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'running',
      statusResult: { status: 'running', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // stop() throws at the IPC layer; the node is in fact still running.
    ctx.ipfsApi.stop.mockRejectedValueOnce(new Error('ipc boom'));
    ctx.ipfsApi.getStatus.mockResolvedValueOnce({ status: 'running', error: null });

    ctx.elements.ipfsToggleBtn.dispatch('click');
    // Optimistically off right after the click.
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    await flushMicrotasks();
    await flushMicrotasks();

    // Re-queried status shows the node never stopped, so the switch flips back
    // on and stats polling resumes.
    expect(ctx.ipfsApi.getStatus).toHaveBeenCalled();
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    expect(ctx.state.ipfsInfoInterval).not.toBeNull();
  });

  test('a click made while the reconcile loop is working redirects it to the new target', async () => {
    const ctx = await loadIpfsModule({
      antMenuOpen: true,
      currentIpfsStatus: 'stopped',
      statusResult: { status: 'stopped', error: null },
      startResult: { status: 'running', error: null },
      stopResult: { status: 'stopped', error: null },
    });

    ctx.mod.initIpfsUi();
    await flushMicrotasks();

    // Click on — the loop dispatches start() and suspends awaiting it. Before it
    // resolves, click off: the switch follows instantly and the loop will pick up
    // the new "off" target once start() returns.
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(true);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(true);
    ctx.elements.ipfsToggleBtn.dispatch('click');
    expect(ctx.state.ipfsDesiredRunning).toBe(false);
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // The loop reached the latest target: it started the node, then stopped it to
    // honor the final "off" click, and the switch ends off with no pending intent.
    expect(ctx.ipfsApi.start).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.stop).toHaveBeenCalledTimes(1);
    expect(ctx.ipfsApi.start.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.ipfsApi.stop.mock.invocationCallOrder[0]
    );
    expect(ctx.state.ipfsDesiredRunning).toBeNull();
    expect(ctx.elements.ipfsToggleSwitch.classList.contains('running')).toBe(false);
  });
});
