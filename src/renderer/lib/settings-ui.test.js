const originalWindow = global.window;
const originalDocument = global.document;

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

const createWindowEventTarget = () => {
  const listeners = new Map();

  return {
    listeners,
    addEventListener: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    dispatchEvent: jest.fn((event) => {
      for (const handler of listeners.get(event.type) || []) {
        handler(event);
      }
      return true;
    }),
  };
};

const emitSettingsUpdated = async (eventTarget, detail) => {
  const handlers = eventTarget.listeners.get('settings:updated') || [];
  for (const handler of handlers) {
    await handler({ type: 'settings:updated', detail });
  }
};

const loadSettingsModule = async (options = {}) => {
  jest.resetModules();

  const {
    initialSettings = {
      theme: 'system',
      beeNodeMode: 'ultraLight',
      enableRadicleIntegration: false,
    },
    prefersDark = true,
    beeStatusResult = { status: 'running', error: null },
    registryResult = { bee: { mode: 'bundled' } },
  } = options;

  const mediaQueryList = {
    matches: prefersDark,
    addEventListener: jest.fn(),
  };
  const eventTarget = createWindowEventTarget();
  const electronAPI = {
    getSettings: jest.fn().mockResolvedValue(initialSettings),
  };
  const beeApi = {
    getStatus: jest.fn().mockResolvedValue(beeStatusResult),
    stop: jest.fn().mockResolvedValue({ status: 'stopped', error: null }),
    start: jest.fn().mockResolvedValue({ status: 'running', error: null }),
  };
  const serviceRegistry = {
    getRegistry: jest.fn().mockResolvedValue(registryResult),
  };
  const radicleStopResult = { catch: jest.fn() };
  const radicle = { stop: jest.fn(() => radicleStopResult) };
  const debugMocks = { pushDebug: jest.fn() };

  const documentElement = {
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
  };

  global.window = {
    ...eventTarget,
    electronAPI,
    bee: beeApi,
    serviceRegistry,
    radicle,
    matchMedia: jest.fn(() => mediaQueryList),
  };
  global.document = { documentElement };

  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./settings-ui.js');

  return {
    mod,
    eventTarget,
    electronAPI,
    beeApi,
    serviceRegistry,
    radicle,
    debugMocks,
    mediaQueryList,
    documentElement,
  };
};

describe('settings-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('applyTheme toggles data-theme attribute based on mode', async () => {
    const { mod, documentElement } = await loadSettingsModule();

    mod.applyTheme('light');
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');

    mod.applyTheme('dark');
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
  });

  test('initTheme loads settings and reacts to system theme changes', async () => {
    const { mod, mediaQueryList, documentElement, electronAPI } = await loadSettingsModule({
      initialSettings: { theme: 'system', beeNodeMode: 'ultraLight' },
      prefersDark: true,
    });

    await mod.initTheme();

    expect(electronAPI.getSettings).toHaveBeenCalledTimes(1);
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    mediaQueryList.matches = false;
    mediaQueryList.addEventListener.mock.calls[0][1]();

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
  });

  test('initSettingsEffects restarts bundled Bee when bee mode flips', async () => {
    const { mod, eventTarget, beeApi, serviceRegistry, debugMocks, documentElement } =
      await loadSettingsModule({
        initialSettings: { theme: 'dark', beeNodeMode: 'ultraLight' },
        beeStatusResult: { status: 'running', error: null },
        registryResult: { bee: { mode: 'bundled' } },
      });

    await mod.initTheme();
    const onSettingsChanged = jest.fn();
    mod.initSettingsEffects(onSettingsChanged);

    await emitSettingsUpdated(eventTarget, {
      theme: 'light',
      beeNodeMode: 'light',
      enableRadicleIntegration: false,
    });
    await flushMicrotasks();

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(serviceRegistry.getRegistry).toHaveBeenCalled();
    expect(beeApi.getStatus).toHaveBeenCalled();
    expect(beeApi.stop).toHaveBeenCalled();
    expect(beeApi.start).toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      'Restarting Swarm node to apply light mode'
    );
    expect(onSettingsChanged).toHaveBeenCalled();
  });

  test('initSettingsEffects does not restart Bee when using a reused node', async () => {
    const { mod, eventTarget, beeApi, serviceRegistry, debugMocks } = await loadSettingsModule({
      initialSettings: { theme: 'system', beeNodeMode: 'ultraLight' },
      registryResult: { bee: { mode: 'reused' } },
    });

    await mod.initTheme();
    mod.initSettingsEffects();

    await emitSettingsUpdated(eventTarget, {
      theme: 'system',
      beeNodeMode: 'light',
      enableRadicleIntegration: false,
    });
    await flushMicrotasks();

    expect(serviceRegistry.getRegistry).toHaveBeenCalled();
    expect(beeApi.getStatus).not.toHaveBeenCalled();
    expect(beeApi.stop).not.toHaveBeenCalled();
    expect(beeApi.start).not.toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      'Swarm light mode setting saved. Using an existing Swarm node, so the change only applies to bundled nodes.'
    );
  });

  test('initSettingsEffects stops Radicle when the integration is disabled', async () => {
    const { mod, eventTarget, radicle } = await loadSettingsModule({
      initialSettings: {
        theme: 'system',
        beeNodeMode: 'ultraLight',
        enableRadicleIntegration: true,
      },
    });

    await mod.initTheme();
    mod.initSettingsEffects();

    await emitSettingsUpdated(eventTarget, {
      theme: 'system',
      beeNodeMode: 'ultraLight',
      enableRadicleIntegration: false,
    });
    await flushMicrotasks();

    expect(radicle.stop).toHaveBeenCalled();
  });

  test('initSettingsEffects does not restart Bee when bee mode is unchanged', async () => {
    const { mod, eventTarget, beeApi } = await loadSettingsModule({
      initialSettings: { theme: 'system', beeNodeMode: 'light' },
    });

    await mod.initTheme();
    mod.initSettingsEffects();

    await emitSettingsUpdated(eventTarget, {
      theme: 'system',
      beeNodeMode: 'light',
      enableRadicleIntegration: false,
    });
    await flushMicrotasks();

    expect(beeApi.getStatus).not.toHaveBeenCalled();
    expect(beeApi.stop).not.toHaveBeenCalled();
    expect(beeApi.start).not.toHaveBeenCalled();
  });
});
