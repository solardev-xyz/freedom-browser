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
    },
    prefersDark = true,
  } = options;

  const mediaQueryList = {
    matches: prefersDark,
    addEventListener: jest.fn(),
  };
  const eventTarget = createWindowEventTarget();
  const electronAPI = {
    getSettings: jest.fn().mockResolvedValue(initialSettings),
  };
  const antApi = {
    getStatus: jest.fn().mockResolvedValue({ status: 'running', error: null }),
    stop: jest.fn().mockResolvedValue({ status: 'stopped', error: null }),
    start: jest.fn().mockResolvedValue({ status: 'running', error: null }),
  };
  const debugMocks = { pushDebug: jest.fn() };

  const documentElement = {
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
  };

  global.window = {
    ...eventTarget,
    electronAPI,
    ant: antApi,
    matchMedia: jest.fn(() => mediaQueryList),
  };
  global.document = { documentElement };

  jest.doMock('./debug.js', () => debugMocks);

  const mod = await import('./settings-ui.js');

  return {
    mod,
    eventTarget,
    electronAPI,
    antApi,
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
      initialSettings: { theme: 'system' },
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

  test('initSettingsEffects applies a theme change and forwards the update', async () => {
    const { mod, eventTarget, documentElement, debugMocks } = await loadSettingsModule({
      initialSettings: { theme: 'dark' },
    });

    await mod.initTheme();
    const onSettingsChanged = jest.fn();
    mod.initSettingsEffects(onSettingsChanged);

    await emitSettingsUpdated(eventTarget, { theme: 'light' });
    await flushMicrotasks();

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Settings updated');
    expect(onSettingsChanged).toHaveBeenCalledWith(
      { theme: 'light' },
      { theme: 'dark', enableTorIntegration: false }
    );
  });

  // The ultra-light/light switch is gone, and with it the per-window restart
  // it triggered: each open chrome window used to stop and start the node on
  // the same broadcast. Even a stale payload that still carries the mode
  // leaves the node alone.
  test('a settings broadcast never restarts the Swarm node', async () => {
    const { mod, eventTarget, antApi } = await loadSettingsModule();

    await mod.initTheme();
    mod.initSettingsEffects();

    await emitSettingsUpdated(eventTarget, { theme: 'system', antNodeMode: 'light' });
    await emitSettingsUpdated(eventTarget, { theme: 'system', antNodeMode: 'ultraLight' });
    await flushMicrotasks();

    expect(antApi.getStatus).not.toHaveBeenCalled();
    expect(antApi.stop).not.toHaveBeenCalled();
    expect(antApi.start).not.toHaveBeenCalled();
  });
});
