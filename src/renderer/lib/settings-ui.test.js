const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalCustomEvent = global.CustomEvent;

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

const createCheckbox = () => {
  const checkbox = createElement('input');
  checkbox.checked = false;
  checkbox.disabled = false;
  return checkbox;
};

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

const loadSettingsModule = async (options = {}) => {
  jest.resetModules();

  const {
    settingsResponses = [
      {
        theme: 'system',
        beeNodeMode: 'ultraLight',
        startBeeAtLaunch: true,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: false,
        enableIdentityWallet: false,
        autoUpdate: true,
      },
    ],
    saveSettingsResult = true,
    prefersDark = true,
    beeStatusResult = { status: 'stopped', error: null },
    registryResult = { bee: { mode: 'bundled' } },
  } = options;

  const settingsQueue = [...settingsResponses];
  const settingsBtn = createElement('button');
  const settingsModal = createElement('dialog');
  const closeSettingsBtn = createElement('button');
  const themeModeSelect = createElement('select');
  const startBeeAtLaunchCheckbox = createCheckbox();
  const startIpfsAtLaunchCheckbox = createCheckbox();
  const enableBeeLightModeCheckbox = createCheckbox();
  const enableRadicleIntegrationCheckbox = createCheckbox();
  const startRadicleRow = createElement('div');
  const startRadicleAtLaunchCheckbox = createCheckbox();
  const enableIdentityWalletCheckbox = createCheckbox();
  const autoUpdateCheckbox = createCheckbox();
  const mediaQueryList = {
    matches: prefersDark,
    addEventListener: jest.fn(),
  };
  const document = createDocument({
    elementsById: {
      'settings-btn': settingsBtn,
      'settings-modal': settingsModal,
      'close-settings': closeSettingsBtn,
      'theme-mode': themeModeSelect,
      'start-bee-at-launch': startBeeAtLaunchCheckbox,
      'start-ipfs-at-launch': startIpfsAtLaunchCheckbox,
      'enable-bee-light-mode': enableBeeLightModeCheckbox,
      'enable-radicle-integration': enableRadicleIntegrationCheckbox,
      'start-radicle-row': startRadicleRow,
      'start-radicle-at-launch': startRadicleAtLaunchCheckbox,
      'enable-identity-wallet': enableIdentityWalletCheckbox,
      'auto-update': autoUpdateCheckbox,
    },
  });
  const eventTarget = createWindowEventTarget();
  const settingsUpdatedEvents = [];
  const radicleStopResult = {
    catch: jest.fn(),
  };
  const electronAPI = {
    getPlatform: jest.fn().mockResolvedValue('darwin'),
    getSettings: jest.fn().mockImplementation(async () => {
      if (settingsQueue.length === 0) {
        return settingsResponses[settingsResponses.length - 1] || null;
      }
      return settingsQueue.shift();
    }),
    saveSettings: jest.fn().mockImplementation(async () => saveSettingsResult),
  };
  const beeApi = {
    getStatus: jest.fn().mockResolvedValue(beeStatusResult),
    stop: jest.fn().mockResolvedValue({ status: 'stopped', error: null }),
    start: jest.fn().mockResolvedValue({ status: 'running', error: null }),
  };
  const serviceRegistry = {
    getRegistry: jest.fn().mockResolvedValue(registryResult),
  };
  const debugMocks = {
    pushDebug: jest.fn(),
  };
  const menuMocks = {
    setMenuOpen: jest.fn(),
  };

  settingsModal.showModal = jest.fn();
  settingsModal.close = jest.fn();
  document.documentElement = {
    setAttribute: jest.fn(),
    removeAttribute: jest.fn(),
  };

  global.window = {
    ...eventTarget,
    electronAPI,
    bee: beeApi,
    serviceRegistry,
    matchMedia: jest.fn(() => mediaQueryList),
    radicle: {
      stop: jest.fn(() => radicleStopResult),
    },
  };
  global.window.dispatchEvent.mockImplementation((event) => {
    settingsUpdatedEvents.push(event);
    for (const handler of eventTarget.listeners.get(event.type) || []) {
      handler(event);
    }
    return true;
  });
  global.document = document;
  global.CustomEvent = jest.fn((type, init) => ({
    type,
    detail: init.detail,
  }));

  jest.doMock('./debug.js', () => debugMocks);
  jest.doMock('./menus.js', () => menuMocks);

  const mod = await import('./settings-ui.js');

  return {
    mod,
    beeApi,
    serviceRegistry,
    electronAPI,
    debugMocks,
    menuMocks,
    mediaQueryList,
    radicleStopResult,
    settingsUpdatedEvents,
    documentElement: document.documentElement,
    elements: {
      settingsBtn,
      settingsModal,
      closeSettingsBtn,
      themeModeSelect,
      startBeeAtLaunchCheckbox,
      startIpfsAtLaunchCheckbox,
      enableBeeLightModeCheckbox,
      enableRadicleIntegrationCheckbox,
      startRadicleRow,
      startRadicleAtLaunchCheckbox,
      enableIdentityWalletCheckbox,
      autoUpdateCheckbox,
    },
  };
};

describe('settings-ui', () => {
  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    global.CustomEvent = originalCustomEvent;
    jest.restoreAllMocks();
  });

  test('applies light and dark themes and reacts to system theme changes', async () => {
    const { mod, mediaQueryList, documentElement, electronAPI } = await loadSettingsModule({
      settingsResponses: [
        {
          theme: 'system',
          beeNodeMode: 'ultraLight',
          enableRadicleIntegration: true,
        },
      ],
      prefersDark: true,
    });

    mod.applyTheme('light');
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');

    mod.applyTheme('dark');
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');

    await mod.initTheme();

    expect(electronAPI.getSettings).toHaveBeenCalledTimes(1);
    expect(documentElement.removeAttribute).toHaveBeenCalledWith('data-theme');
    expect(mediaQueryList.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    mediaQueryList.matches = false;
    mediaQueryList.addEventListener.mock.calls[0][1]();

    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
  });

  test('loads bee mode settings and restarts bundled Bee when the mode changes', async () => {
    const onSettingsChanged = jest.fn();
    const { mod, elements, beeApi, serviceRegistry, electronAPI, settingsUpdatedEvents, debugMocks, documentElement } =
      await loadSettingsModule({
        settingsResponses: [
          {
            theme: 'dark',
            beeNodeMode: 'ultraLight',
            enableRadicleIntegration: true,
          },
          {
            theme: 'dark',
            beeNodeMode: 'ultraLight',
            startBeeAtLaunch: true,
            startIpfsAtLaunch: false,
            enableRadicleIntegration: true,
            startRadicleAtLaunch: true,
            enableIdentityWallet: false,
            autoUpdate: false,
          },
        ],
        saveSettingsResult: true,
        beeStatusResult: { status: 'running', error: null },
        registryResult: { bee: { mode: 'bundled' } },
      });

    mod.setOnSettingsChanged(onSettingsChanged);
    await mod.initTheme();
    await mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await flushMicrotasks();

    expect(elements.themeModeSelect.value).toBe('dark');
    expect(elements.enableBeeLightModeCheckbox.checked).toBe(false);
    expect(elements.enableIdentityWalletCheckbox.checked).toBe(false);
    expect(elements.settingsModal.showModal).toHaveBeenCalled();

    elements.themeModeSelect.value = 'light';
    elements.enableBeeLightModeCheckbox.checked = true;
    elements.startBeeAtLaunchCheckbox.checked = false;
    elements.startIpfsAtLaunchCheckbox.checked = true;
    elements.enableRadicleIntegrationCheckbox.checked = false;
    elements.startRadicleAtLaunchCheckbox.checked = true;
    elements.enableIdentityWalletCheckbox.checked = true;
    elements.autoUpdateCheckbox.checked = true;
    elements.enableBeeLightModeCheckbox.dispatch('change');
    await flushMicrotasks();

    expect(electronAPI.saveSettings).toHaveBeenCalledWith({
      theme: 'light',
      beeNodeMode: 'light',
      startBeeAtLaunch: false,
      startIpfsAtLaunch: true,
      enableRadicleIntegration: false,
      startRadicleAtLaunch: true,
      enableIdentityWallet: true,
      autoUpdate: true,
    });
    expect(serviceRegistry.getRegistry).toHaveBeenCalled();
    expect(beeApi.getStatus).toHaveBeenCalled();
    expect(beeApi.stop).toHaveBeenCalled();
    expect(beeApi.start).toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Settings saved');
    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      'Restarting Swarm node to apply light mode'
    );
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(settingsUpdatedEvents).toContainEqual({
      type: 'settings:updated',
      detail: {
        theme: 'light',
        beeNodeMode: 'light',
        startBeeAtLaunch: false,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: true,
        enableIdentityWallet: true,
        autoUpdate: true,
      },
    });
    expect(onSettingsChanged).toHaveBeenCalled();
  });

  test('saves Bee mode changes without restarting when Freedom is reusing an existing node', async () => {
    const { mod, elements, beeApi, serviceRegistry, electronAPI, debugMocks } =
      await loadSettingsModule({
        settingsResponses: [
          {
            theme: 'system',
            beeNodeMode: 'ultraLight',
          },
        ],
        saveSettingsResult: true,
        registryResult: { bee: { mode: 'reused' } },
      });

    mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await flushMicrotasks();

    elements.enableBeeLightModeCheckbox.checked = true;
    elements.enableBeeLightModeCheckbox.dispatch('change');
    await flushMicrotasks();

    expect(electronAPI.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        beeNodeMode: 'light',
      })
    );
    expect(serviceRegistry.getRegistry).toHaveBeenCalled();
    expect(beeApi.getStatus).not.toHaveBeenCalled();
    expect(beeApi.stop).not.toHaveBeenCalled();
    expect(beeApi.start).not.toHaveBeenCalled();
    expect(debugMocks.pushDebug).toHaveBeenCalledWith(
      'Swarm light mode setting saved. Using an existing Swarm node, so the change only applies to bundled nodes.'
    );
  });

  test('handles save failures and closes the settings modal', async () => {
    const { mod, elements, beeApi, electronAPI, debugMocks } = await loadSettingsModule({
      settingsResponses: [
        {
          theme: 'system',
          beeNodeMode: 'ultraLight',
          startBeeAtLaunch: false,
          startIpfsAtLaunch: false,
          enableRadicleIntegration: false,
          startRadicleAtLaunch: false,
          enableIdentityWallet: false,
          autoUpdate: true,
        },
      ],
      saveSettingsResult: false,
      prefersDark: false,
    });

    await mod.initTheme();
    mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await flushMicrotasks();

    elements.autoUpdateCheckbox.checked = false;
    elements.autoUpdateCheckbox.dispatch('change');
    await flushMicrotasks();

    expect(electronAPI.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        autoUpdate: false,
        beeNodeMode: 'ultraLight',
      })
    );
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Failed to save settings');
    expect(beeApi.stop).not.toHaveBeenCalled();

    elements.closeSettingsBtn.dispatch('click');
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(1);

    elements.settingsModal.dispatch('click', { target: elements.settingsModal });
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(2);
  });
});
