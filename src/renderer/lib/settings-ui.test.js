const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;
const originalCustomEvent = global.CustomEvent;

const createCheckbox = () => {
  const checkbox = createElement('input');
  checkbox.checked = false;
  checkbox.disabled = false;
  return checkbox;
};

const loadSettingsModule = async (options = {}) => {
  jest.resetModules();

  const {
    platform = 'darwin',
    settingsResponses = [
      {
        theme: 'system',
        startBeeAtLaunch: true,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: false,
        autoUpdate: true,
      },
    ],
    saveSettingsResult = true,
    prefersDark = true,
  } = options;

  const settingsQueue = [...settingsResponses];
  const settingsBtn = createElement('button');
  const settingsModal = createElement('dialog');
  const closeSettingsBtn = createElement('button');
  const themeModeSelect = createElement('select');
  const startBeeAtLaunchCheckbox = createCheckbox();
  const startIpfsAtLaunchCheckbox = createCheckbox();
  const enableRadicleIntegrationCheckbox = createCheckbox();
  const startRadicleRow = createElement('div');
  const startRadicleAtLaunchCheckbox = createCheckbox();
  const autoUpdateCheckbox = createCheckbox();
  const experimentalSection = createElement('section');
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
      'enable-radicle-integration': enableRadicleIntegrationCheckbox,
      'start-radicle-row': startRadicleRow,
      'start-radicle-at-launch': startRadicleAtLaunchCheckbox,
      'auto-update': autoUpdateCheckbox,
      'experimental-section': experimentalSection,
    },
  });
  const settingsUpdatedEvents = [];
  const radicleStopResult = {
    catch: jest.fn(),
  };
  const electronAPI = {
    getSettings: jest.fn().mockImplementation(async () => {
      if (settingsQueue.length === 0) {
        return settingsResponses[settingsResponses.length - 1] || null;
      }
      return settingsQueue.shift();
    }),
    saveSettings: jest.fn().mockImplementation(async () => saveSettingsResult),
    getPlatform: jest.fn().mockResolvedValue(platform),
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
    electronAPI,
    matchMedia: jest.fn(() => mediaQueryList),
    dispatchEvent: jest.fn((event) => {
      settingsUpdatedEvents.push(event);
    }),
    radicle: {
      stop: jest.fn(() => radicleStopResult),
    },
  };
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
    elements: {
      settingsBtn,
      settingsModal,
      closeSettingsBtn,
      themeModeSelect,
      startBeeAtLaunchCheckbox,
      startIpfsAtLaunchCheckbox,
      enableRadicleIntegrationCheckbox,
      startRadicleRow,
      startRadicleAtLaunchCheckbox,
      autoUpdateCheckbox,
      experimentalSection,
    },
    electronAPI,
    mediaQueryList,
    settingsUpdatedEvents,
    radicleStopResult,
    debugMocks,
    menuMocks,
    documentElement: document.documentElement,
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

  test('initializes settings modal and saves updated settings successfully', async () => {
    const onSettingsChanged = jest.fn();
    const { mod, elements, electronAPI, settingsUpdatedEvents, radicleStopResult, debugMocks, menuMocks, documentElement } =
      await loadSettingsModule({
        platform: 'darwin',
        settingsResponses: [
          {
            theme: 'dark',
            enableRadicleIntegration: true,
          },
          {
            theme: 'dark',
            startBeeAtLaunch: true,
            startIpfsAtLaunch: false,
            enableRadicleIntegration: true,
            startRadicleAtLaunch: true,
            autoUpdate: false,
          },
        ],
        saveSettingsResult: true,
        prefersDark: true,
      });

    mod.setOnSettingsChanged(onSettingsChanged);
    await mod.initTheme();
    await mod.initSettings();

    elements.settingsBtn.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();

    expect(menuMocks.setMenuOpen).toHaveBeenCalledWith(false);
    expect(elements.themeModeSelect.value).toBe('dark');
    expect(elements.startBeeAtLaunchCheckbox.checked).toBe(true);
    expect(elements.startIpfsAtLaunchCheckbox.checked).toBe(false);
    expect(elements.enableRadicleIntegrationCheckbox.checked).toBe(true);
    expect(elements.startRadicleAtLaunchCheckbox.checked).toBe(true);
    expect(elements.autoUpdateCheckbox.checked).toBe(false);
    expect(elements.startRadicleAtLaunchCheckbox.disabled).toBe(false);
    expect(elements.settingsModal.showModal).toHaveBeenCalled();

    elements.themeModeSelect.value = 'light';
    elements.startBeeAtLaunchCheckbox.checked = false;
    elements.startIpfsAtLaunchCheckbox.checked = true;
    elements.enableRadicleIntegrationCheckbox.checked = false;
    elements.startRadicleAtLaunchCheckbox.checked = true;
    elements.autoUpdateCheckbox.checked = true;
    elements.enableRadicleIntegrationCheckbox.dispatch('change');
    await Promise.resolve();

    expect(elements.startRadicleRow.classList.toggle).toHaveBeenCalledWith('disabled', true);
    expect(elements.startRadicleAtLaunchCheckbox.disabled).toBe(true);
    expect(electronAPI.saveSettings).toHaveBeenCalledWith({
      theme: 'light',
      startBeeAtLaunch: false,
      startIpfsAtLaunch: true,
      enableRadicleIntegration: false,
      startRadicleAtLaunch: true,
      autoUpdate: true,
    });
    expect(global.window.radicle.stop).toHaveBeenCalled();
    expect(radicleStopResult.catch).toHaveBeenCalledWith(expect.any(Function));
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Settings saved');
    expect(documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'light');
    expect(settingsUpdatedEvents).toContainEqual({
      type: 'settings:updated',
      detail: {
        theme: 'light',
        startBeeAtLaunch: false,
        startIpfsAtLaunch: true,
        enableRadicleIntegration: false,
        startRadicleAtLaunch: true,
        autoUpdate: true,
      },
    });
    expect(onSettingsChanged).toHaveBeenCalled();
  });

  test('handles windows-specific settings behavior and failed saves', async () => {
    const { mod, elements, electronAPI, debugMocks } = await loadSettingsModule({
      platform: 'win32',
      settingsResponses: [
        {
          theme: 'system',
          enableRadicleIntegration: false,
        },
        {
          theme: 'system',
          startBeeAtLaunch: false,
          startIpfsAtLaunch: false,
          enableRadicleIntegration: true,
          startRadicleAtLaunch: true,
          autoUpdate: true,
        },
      ],
      saveSettingsResult: false,
      prefersDark: false,
    });

    await mod.initTheme();
    await mod.initSettings();

    expect(elements.experimentalSection.style.display).toBe('none');

    elements.settingsBtn.dispatch('click');
    await Promise.resolve();

    elements.enableRadicleIntegrationCheckbox.checked = true;
    elements.startRadicleAtLaunchCheckbox.checked = true;
    elements.autoUpdateCheckbox.checked = false;
    elements.autoUpdateCheckbox.dispatch('change');
    await Promise.resolve();

    expect(electronAPI.saveSettings).toHaveBeenCalledWith({
      theme: 'system',
      startBeeAtLaunch: false,
      startIpfsAtLaunch: false,
      enableRadicleIntegration: false,
      startRadicleAtLaunch: false,
      autoUpdate: false,
    });
    expect(debugMocks.pushDebug).toHaveBeenCalledWith('Failed to save settings');

    elements.closeSettingsBtn.dispatch('click');
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(1);

    elements.settingsModal.dispatch('click', { target: elements.settingsModal });
    expect(elements.settingsModal.close).toHaveBeenCalledTimes(2);
  });
});
