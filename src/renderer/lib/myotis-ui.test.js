const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function loadMyotisUi(options = {}) {
  jest.resetModules();
  const elements = {
    button: createElement('button'),
    toggle: createElement('span'),
    info: createElement('div', { classes: ['ipfs-info'] }),
    state: createElement('span'),
    peers: createElement('span'),
    block: createElement('span'),
    version: createElement('span'),
    divider: createElement('div'),
    recoveryMessage: createElement('p'),
    gnosisRecoveryMessage: createElement('p'),
    notice: createElement('div'),
    noticeText: createElement('span'),
    noticeClose: createElement('button'),
    noticeOpen: createElement('button'),
    nodesButton: { click: jest.fn() },
    recoveryHelp: createElement('button'),
    gnosisRecoveryHelp: createElement('button'),
    retryCheckpoint: createElement('button'),
    gnosisRetryCheckpoint: createElement('button'),
    gnosisButton: createElement('button'),
    gnosisToggle: createElement('span'),
    gnosisInfo: createElement('div', { classes: ['ipfs-info'] }),
    gnosisState: createElement('span'),
    gnosisPeers: createElement('span'),
    gnosisBlock: createElement('span'),
    gnosisVersion: createElement('span'),
    gnosisDivider: createElement('div'),
  };
  const document = createDocument({
    elementsById: {
      'myotis-toggle-btn': elements.button,
      'myotis-toggle-switch': elements.toggle,
      'myotis-info': elements.info,
      'myotis-state-text': elements.state,
      'myotis-peers-count': elements.peers,
      'myotis-finalized-block': elements.block,
      'myotis-version-text': elements.version,
      'myotis-divider': elements.divider,
      'myotis-recovery-message': elements.recoveryMessage,
      'myotis-gnosis-recovery-message': elements.gnosisRecoveryMessage,
      'myotis-recovery-notice': elements.notice,
      'myotis-recovery-notice-text': elements.noticeText,
      'myotis-recovery-notice-close': elements.noticeClose,
      'myotis-recovery-notice-open': elements.noticeOpen,
      'bee-menu-button': elements.nodesButton,
      'myotis-retry-checkpoint': elements.retryCheckpoint,
      'myotis-recovery-help': elements.recoveryHelp,
      'myotis-gnosis-recovery-help': elements.gnosisRecoveryHelp,
      'myotis-gnosis-retry-checkpoint': elements.gnosisRetryCheckpoint,
      'myotis-gnosis-toggle-btn': elements.gnosisButton,
      'myotis-gnosis-toggle-switch': elements.gnosisToggle,
      'myotis-gnosis-info': elements.gnosisInfo,
      'myotis-gnosis-state-text': elements.gnosisState,
      'myotis-gnosis-peers-count': elements.gnosisPeers,
      'myotis-gnosis-finalized-block': elements.gnosisBlock,
      'myotis-gnosis-version-text': elements.gnosisVersion,
      'myotis-gnosis-divider': elements.gnosisDivider,
    },
  });
  let statusHandler;
  const initialStatus = options.initialStatus || {
    supported: true,
    available: true,
    running: false,
    state: 'off',
  };
  const api = {
    retryCheckpoint: jest.fn(),
    repairSyncData: jest.fn(),
    recoveryHelp: jest.fn(),
    start: jest.fn().mockResolvedValue({
      supported: true,
      available: true,
      running: true,
      state: 'syncing',
      peerCount: 3,
    }),
    stop: jest.fn().mockResolvedValue(initialStatus),
    getStatus: jest.fn((chainId = 1) =>
      Promise.resolve(
        Number(chainId) === 100
          ? {
              supported: true,
              available: true,
              running: false,
              state: 'off',
              chainId: 100,
            }
          : initialStatus
      )
    ),
    onStatusUpdate: jest.fn((handler) => {
      statusHandler = handler;
      handler(initialStatus);
      return jest.fn();
    }),
  };
  const state = { antMenuOpen: options.antMenuOpen ?? true };
  const debug = { pushDebug: jest.fn() };
  global.window = { myotis: api };
  global.document = document;
  jest.doMock('./state.js', () => ({ state }));
  jest.doMock('./debug.js', () => debug);

  const mod = await import('./myotis-ui.js');
  return { api, debug, elements, getStatusHandler: () => statusHandler, mod, state };
}

describe('myotis-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('renders readiness details and controls the embedded client', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();

    ctx.getStatusHandler()({
      supported: true,
      available: true,
      running: true,
      state: 'ready',
      peerCount: 7,
      finalizedBlockNumber: '2345',
      version: '0.1.7',
    });
    expect(ctx.elements.toggle.classList.contains('running')).toBe(true);
    expect(ctx.elements.info.classList.contains('visible')).toBe(true);
    expect(ctx.elements.state.textContent).toBe('Ready');
    expect(ctx.elements.peers.textContent).toBe('7');
    expect(ctx.elements.block.textContent).toBe('2345');
    expect(ctx.elements.version.textContent).toBe('Myotis v0.1.7');

    ctx.elements.button.dispatch('click');
    await flushMicrotasks();
    expect(ctx.api.stop).toHaveBeenCalled();
  });

  test('a running client with nothing to report shows the menu-wide placeholders', async () => {
    // #252: Finalized Block used to read '--' while every sibling counter in
    // the same menu read '0' — Gnosis keeps that state for as long as it has
    // not produced a finalized block. #253: the Version row used to fall back
    // to the bare product name 'Myotis'.
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();

    ctx.getStatusHandler()({
      supported: true,
      available: true,
      running: true,
      state: 'ready',
      peerCount: 0,
    });
    expect(ctx.elements.peers.textContent).toBe('0');
    expect(ctx.elements.block.textContent).toBe('0');
    expect(ctx.elements.version.textContent).toBe('Unknown');

    ctx.getStatusHandler()({
      supported: true,
      available: true,
      running: true,
      state: 'ready',
      chainId: 100,
      peerCount: 0,
    });
    expect(ctx.elements.gnosisPeers.textContent).toBe('0');
    expect(ctx.elements.gnosisBlock.textContent).toBe('0');
    expect(ctx.elements.gnosisVersion.textContent).toBe('Unknown');
  });

  test('shows the restart-blocked reason on each chain control after refused Start', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    const errorStatus = {
      supported: true,
      available: true,
      running: false,
      state: 'error',
      error: 'Myotis exit unconfirmed; restart blocked',
    };
    ctx.api.start.mockImplementation(async (chainId = 1) => ({ ...errorStatus, chainId }));
    for (const [button, toggle] of [
      [ctx.elements.button, ctx.elements.toggle],
      [ctx.elements.gnosisButton, ctx.elements.gnosisToggle],
    ]) {
      button.dispatch('click');
      await flushMicrotasks();
      expect(button.title).toBe(errorStatus.error);
      expect(toggle.classList.contains('running')).toBe(false);
    }
  });

  test('disables runtime controls when the profile disables Myotis', async () => {
    const ctx = await loadMyotisUi({
      initialStatus: {
        supported: true,
        available: true,
        running: false,
        state: 'disabled',
      },
    });
    ctx.mod.initMyotisUi();

    expect(ctx.elements.button.disabled).toBe(true);
    expect(ctx.elements.button.title).toBe('Disabled for this profile in Settings');
    ctx.elements.button.dispatch('click');
    await flushMicrotasks();
    expect(ctx.api.start).not.toHaveBeenCalled();
  });

  test('controls the independent Gnosis light client', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();

    ctx.getStatusHandler()({
      supported: true,
      available: true,
      running: true,
      state: 'ready',
      chainId: 100,
      peerCount: 4,
      finalizedBlockNumber: '9876',
      version: '0.1.7',
    });
    expect(ctx.elements.gnosisToggle.classList.contains('running')).toBe(true);
    expect(ctx.elements.gnosisState.textContent).toBe('Ready');
    expect(ctx.elements.gnosisPeers.textContent).toBe('4');
    expect(ctx.elements.gnosisBlock.textContent).toBe('9876');

    ctx.elements.gnosisButton.dispatch('click');
    await flushMicrotasks();
    expect(ctx.api.stop).toHaveBeenCalledWith(100);
  });

  test('hides Myotis section dividers on unsupported targets', async () => {
    const unsupported = {
      supported: false,
      available: false,
      running: false,
      state: 'unavailable',
    };
    const ctx = await loadMyotisUi({ initialStatus: unsupported });
    ctx.api.getStatus.mockResolvedValue(unsupported);
    ctx.mod.initMyotisUi();
    await flushMicrotasks();

    expect(ctx.elements.button.hidden).toBe(true);
    expect(ctx.elements.divider.hidden).toBe(true);
    expect(ctx.elements.gnosisButton.hidden).toBe(true);
    expect(ctx.elements.gnosisDivider.hidden).toBe(true);
  });
  const recoveryStatus = (chainId, overrides = {}) => ({
    chainId,
    supported: true,
    available: true,
    running: true,
    state: 'recovery-blocked',
    recovery: { phase: 'blocked', reason: 'mismatch', attempt: 3, canRetry: true },
    ...overrides,
  });

  test.each([1, 100])('offers a deduplicated retry for failed chain %s', async (chainId) => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    const button =
      chainId === 100 ? ctx.elements.gnosisRetryCheckpoint : ctx.elements.retryCheckpoint;
    const label = chainId === 100 ? ctx.elements.gnosisState : ctx.elements.state;
    const message =
      chainId === 100 ? ctx.elements.gnosisRecoveryMessage : ctx.elements.recoveryMessage;
    expect(button.hidden).toBe(true);
    const status = recoveryStatus(chainId);
    ctx.getStatusHandler()(status);
    expect(label.textContent).toBe('Sync paused');
    expect(message.textContent).toBe('Checkpoint could not be verified. Sync is paused.');
    expect(button.hidden).toBe(false);
    let complete;
    ctx.api.retryCheckpoint.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    button.dispatch('click');
    button.dispatch('click');
    expect(ctx.api.retryCheckpoint).toHaveBeenCalledTimes(1);
    expect(ctx.api.retryCheckpoint).toHaveBeenCalledWith(chainId);
    expect(button.disabled).toBe(true);
    complete(
      recoveryStatus(chainId, {
        state: 'recovering',
        recovery: { phase: 'checking', attempt: 1, canRetry: false },
      })
    );
    await flushMicrotasks();
    expect(button.hidden).toBe(true);
    expect(button.disabled).toBe(false);
    expect(message.textContent).toBe('Updating sync checkpoint…');
    expect(ctx.elements.notice.hidden).toBe(true);
  });

  test.each([1, 100])(
    'keeps chain %s switch available during recovery without a child',
    async (chainId) => {
      const ctx = await loadMyotisUi();
      ctx.mod.initMyotisUi();
      await flushMicrotasks();
      const button = chainId === 100 ? ctx.elements.gnosisButton : ctx.elements.button;
      const toggle = chainId === 100 ? ctx.elements.gnosisToggle : ctx.elements.toggle;
      ctx.getStatusHandler()(recoveryStatus(chainId, { available: false }));
      expect(button.disabled).toBe(false);
      expect(toggle.classList.contains('running')).toBe(true);
      button.dispatch('click');
      await flushMicrotasks();
      expect(ctx.api.stop).toHaveBeenCalledWith(...(chainId === 100 ? [100] : []));
      expect(toggle.classList.contains('running')).toBe(false);
      expect(ctx.elements.notice.hidden).toBe(true);
    }
  );

  test.each([
    [1, 'restart', 'Restarting node…'],
    [100, 'restart', 'Restarting node…'],
    [1, undefined, 'Checkpoint verified. Restarting sync…'],
  ])('describes chain %s restart mode %s accurately', async (chainId, mode, expected) => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    ctx.getStatusHandler()(
      recoveryStatus(chainId, {
        state: 'recovering',
        recovery: { phase: 'restarting', mode, attempt: 1, canRetry: false },
      })
    );
    const message =
      chainId === 100 ? ctx.elements.gnosisRecoveryMessage : ctx.elements.recoveryMessage;
    const retry =
      chainId === 100 ? ctx.elements.gnosisRetryCheckpoint : ctx.elements.retryCheckpoint;
    expect(message.textContent).toBe(expected);
    expect(retry.hidden).toBe(true);
    expect(ctx.elements.notice.hidden).toBe(true);
  });

  test('reports timed retries honestly and preserves failure details while Nodes is closed', async () => {
    const ctx = await loadMyotisUi({ antMenuOpen: false });
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const waiting = recoveryStatus(1, {
      state: 'recovering',
      recovery: {
        phase: 'waiting',
        reason: 'unavailable',
        attempt: 1,
        nextRetryAt: now + 15000,
        canRetry: false,
      },
    });
    ctx.getStatusHandler()(waiting);
    expect(ctx.elements.recoveryMessage.textContent).toContain('Retrying in 15s');
    expect(ctx.elements.notice.hidden).toBe(true);
    Date.now.mockReturnValue(now + 16000);
    ctx.getStatusHandler()(waiting);
    expect(ctx.elements.recoveryMessage.textContent).toContain('Waiting to retry');
    expect(ctx.elements.recoveryMessage.textContent).not.toContain('0s');

    const blocked = recoveryStatus(1);
    ctx.getStatusHandler()(blocked);
    expect(ctx.elements.notice.hidden).toBe(false);
    expect(ctx.elements.info.classList.contains('visible')).toBe(false);
    ctx.elements.noticeClose.dispatch('click');
    expect(ctx.elements.notice.hidden).toBe(true);
    ctx.getStatusHandler()(blocked);
    expect(ctx.elements.notice.hidden).toBe(true);
    expect(ctx.elements.recoveryMessage.hidden).toBe(false);
    expect(ctx.elements.retryCheckpoint.hidden).toBe(false);
    ctx.getStatusHandler()(waiting);
    ctx.getStatusHandler()(blocked);
    expect(ctx.elements.notice.hidden).toBe(false);
  });

  test('explains an outdated checkpoint while waiting for another automatic attempt', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    jest.spyOn(Date, 'now').mockReturnValue(100000);
    ctx.getStatusHandler()(
      recoveryStatus(100, {
        state: 'recovering',
        recovery: {
          phase: 'waiting',
          reason: 'stale',
          attempt: 1,
          nextRetryAt: 115000,
          canRetry: true,
        },
      })
    );
    expect(ctx.elements.gnosisRecoveryMessage.textContent).toBe(
      'Checkpoint is still out of date. Retrying in 15s…'
    );
    expect(ctx.elements.gnosisRetryCheckpoint.hidden).toBe(true);
    expect(ctx.elements.notice.hidden).toBe(true);
  });

  test('loads an existing Ethereum failure when opening a new window', async () => {
    const ctx = await loadMyotisUi({ initialStatus: recoveryStatus(1), antMenuOpen: false });
    ctx.api.onStatusUpdate.mockImplementation(() => jest.fn());
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    expect(ctx.api.getStatus).toHaveBeenCalledWith();
    expect(ctx.api.getStatus).toHaveBeenCalledWith(100);
    expect(ctx.elements.notice.hidden).toBe(false);
    expect(ctx.elements.noticeText.textContent).toContain('Ethereum:');
    expect(ctx.elements.retryCheckpoint.hidden).toBe(false);
  });

  test('opening Nodes from a notice stops the outside-click dismissal', async () => {
    const ctx = await loadMyotisUi({ antMenuOpen: false });
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    ctx.getStatusHandler()(recoveryStatus(100));
    const stopPropagation = jest.fn();
    ctx.elements.noticeOpen.dispatch('click', { stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(ctx.elements.nodesButton.click).toHaveBeenCalledTimes(1);
    expect(ctx.elements.notice.hidden).toBe(true);
    ctx.getStatusHandler()(recoveryStatus(100));
    expect(ctx.elements.notice.hidden).toBe(true);
    expect(ctx.elements.gnosisRetryCheckpoint.hidden).toBe(false);
  });

  test.each([1, 100])(
    'describes chain %s as slow while native sync keeps trying',
    async (chainId) => {
      const ctx = await loadMyotisUi();
      ctx.mod.initMyotisUi();
      await flushMicrotasks();
      ctx.getStatusHandler()(
        recoveryStatus(chainId, {
          recovery: { phase: 'blocked', reason: 'stalled', attempt: 1, canRetry: true },
        })
      );
      const label = chainId === 100 ? ctx.elements.gnosisState : ctx.elements.state;
      const retry =
        chainId === 100 ? ctx.elements.gnosisRetryCheckpoint : ctx.elements.retryCheckpoint;
      const message =
        chainId === 100 ? ctx.elements.gnosisRecoveryMessage : ctx.elements.recoveryMessage;
      expect(label.textContent).toBe('Syncing slowly');
      expect(message.textContent).toBe(
        'Sync is taking longer than expected. Check your connection; the node will keep trying.'
      );
      expect(retry.hidden).toBe(false);
      expect(ctx.elements.noticeText.textContent).not.toContain('paused');
      ctx.getStatusHandler()(recoveryStatus(chainId === 100 ? 1 : 100));
      expect(ctx.elements.noticeText.textContent).toBe(
        'Ethereum and Gnosis sync need attention. Open Nodes for details.'
      );
      ctx.getStatusHandler()(recoveryStatus(chainId, { state: 'ready', recovery: null }));
      expect(label.textContent).toBe('Ready');
      expect(message.hidden).toBe(true);
      expect(retry.hidden).toBe(true);
      expect(ctx.elements.noticeText.textContent).not.toContain('node will keep trying');
    }
  );

  test('retains both chain failures and removes only the chain that recovered', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    ctx.getStatusHandler()(recoveryStatus(1));
    ctx.getStatusHandler()(recoveryStatus(100));
    expect(ctx.elements.noticeText.textContent).toContain('Ethereum and Gnosis');
    ctx.getStatusHandler()(recoveryStatus(1, { state: 'ready', recovery: null }));
    expect(ctx.elements.notice.hidden).toBe(false);
    expect(ctx.elements.noticeText.textContent).toContain('Gnosis:');
    expect(ctx.elements.recoveryMessage.hidden).toBe(true);
  });

  test('a failed retry remains actionable and explains failure', async () => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    ctx.getStatusHandler()(recoveryStatus(1));
    ctx.api.retryCheckpoint.mockRejectedValue(new Error('IPC gone'));
    ctx.elements.retryCheckpoint.dispatch('click');
    await flushMicrotasks();
    expect(ctx.elements.retryCheckpoint.disabled).toBe(false);
    expect(ctx.elements.recoveryMessage.textContent).toBe('The recovery action could not start. Try again.');
    ctx.getStatusHandler()(recoveryStatus(1));
    expect(ctx.elements.recoveryMessage.textContent).toBe('The recovery action could not start. Try again.');
  });

  test.each([1, 100])(
    'keeps retry and off available for chain %s with unconfirmed ownership',
    async (chainId) => {
      const ctx = await loadMyotisUi();
      ctx.mod.initMyotisUi();
      await flushMicrotasks();
      ctx.getStatusHandler()(
        recoveryStatus(chainId, {
          recovery: { phase: 'blocked', reason: 'ownership', attempt: 1, canRetry: true },
        })
      );
      const retry =
        chainId === 100 ? ctx.elements.gnosisRetryCheckpoint : ctx.elements.retryCheckpoint;
      const button = chainId === 100 ? ctx.elements.gnosisButton : ctx.elements.button;
      expect(retry.hidden).toBe(false);
      expect(retry.disabled).toBe(false);
      expect(button.disabled).toBe(false);
      expect(ctx.elements.noticeText.textContent).toContain('previous node stopped');
      button.dispatch('click');
      await flushMicrotasks();
      expect(ctx.api.stop).toHaveBeenCalledWith(...(chainId === 100 ? [100] : []));
    }
  );

  test.each([
    ['clock', 'date and time'],
    ['storage', 'inconsistent'],
    ['storage-io', 'disk space'],
    ['ownership', 'Close other Freedom instances and retry'],
    ['unsupported', 'Update or reinstall Freedom'],
    ['installation', 'Update or reinstall Freedom'],
    ['startup', 'restart the node'],
    ['stalled', 'node will keep trying'],
    ['quorum-unavailable', 'Not enough checkpoint sources'],
    ['quorum-conflict', 'Checkpoint sources disagree'],
    ['unavailable', 'connection'],
    ['stale', 'outdated checkpoint'],
  ])('gives an actionable explanation for %s', async (reason, text) => {
    const ctx = await loadMyotisUi();
    ctx.mod.initMyotisUi();
    await flushMicrotasks();
    ctx.getStatusHandler()(
      recoveryStatus(1, {
        recovery: {
          reason,
          phase: 'blocked',
          attempt: 1,
          canRetry: reason !== 'unsupported',
        },
      })
    );
    expect(ctx.elements.recoveryMessage.textContent).toContain(text);
    expect(ctx.elements.retryCheckpoint.hidden).toBe(reason === 'unsupported');
  });
  test.each([1, 100])('inconsistent data offers repair rather than a fruitless retry for chain %s', async chainId => {
    const ctx = await loadMyotisUi(); ctx.mod.initMyotisUi(); await flushMicrotasks();
    const status = recoveryStatus(chainId, { recovery: { phase: 'blocked', reason: 'storage', canRetry: true } });
    ctx.getStatusHandler()(status);
    const button = chainId === 100 ? ctx.elements.gnosisRetryCheckpoint : ctx.elements.retryCheckpoint;
    const help = chainId === 100 ? ctx.elements.gnosisRecoveryHelp : ctx.elements.recoveryHelp;
    expect(button.textContent).toBe('Repair sync data');
    expect(help.hidden).toBe(false);
    ctx.api.repairSyncData.mockResolvedValue(status); // User cancels the native confirmation.
    button.dispatch('click'); await flushMicrotasks();
    expect(ctx.api.repairSyncData).toHaveBeenCalledWith(chainId);
    expect(ctx.api.retryCheckpoint).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Repair sync data');
    help.dispatch('click'); await flushMicrotasks();
    expect(ctx.api.recoveryHelp).toHaveBeenCalledWith(chainId);
  });

  test('missing component remains explained in Nodes when no native node ever started', async () => {
    const ctx = await loadMyotisUi({ initialStatus: recoveryStatus(1, {
      available: false, running: false, state: 'unavailable',
      recovery: { phase: 'blocked', reason: 'installation', canRetry: false },
    }) });
    ctx.mod.initMyotisUi(); await flushMicrotasks();
    expect(ctx.elements.info.classList.contains('visible')).toBe(true);
    expect(ctx.elements.recoveryMessage.textContent).toContain('Update or reinstall Freedom');
    expect(ctx.elements.retryCheckpoint.hidden).toBe(true);
    expect(ctx.elements.recoveryHelp.hidden).toBe(false);
    expect(ctx.elements.button.disabled).toBe(true);
    expect(ctx.elements.notice.hidden).toBe(false);
  });

  test('slow recovery notice stays dismissed across automatic attempts but a failure is still announced', async () => {
    const ctx = await loadMyotisUi({ antMenuOpen: false }); ctx.mod.initMyotisUi(); await flushMicrotasks();
    const status = recoveryStatus(1, { state: 'recovering', recovery: {
      phase: 'checking', attempt: 1, canRetry: false, takingLonger: true,
    } });
    ctx.getStatusHandler()(status);
    expect(ctx.elements.noticeText.textContent).toContain('Still trying automatically');
    ctx.elements.noticeClose.dispatch('click');
    ctx.getStatusHandler()({ ...status, recovery: { ...status.recovery, phase: 'waiting', attempt: 2 } });
    expect(ctx.elements.notice.hidden).toBe(true);
    ctx.getStatusHandler()(recoveryStatus(1));
    expect(ctx.elements.notice.hidden).toBe(false);
    expect(ctx.elements.noticeText.textContent).toContain('could not be verified');
    ctx.getStatusHandler()({ ...status, state: 'ready', recovery: undefined });
    expect(ctx.elements.notice.hidden).toBe(true);
    expect(ctx.elements.recoveryMessage.hidden).toBe(true);
  });

});
