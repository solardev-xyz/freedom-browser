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
    start: jest.fn().mockResolvedValue({
      supported: true,
      available: true,
      running: true,
      state: 'syncing',
      peerCount: 3,
    }),
    stop: jest.fn().mockResolvedValue(initialStatus),
    getStatus: jest.fn((chainId = 1) => Promise.resolve(
      Number(chainId) === 100
        ? {
            supported: true,
            available: true,
            running: false,
            state: 'off',
            chainId: 100,
          }
        : initialStatus
    )),
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
});
