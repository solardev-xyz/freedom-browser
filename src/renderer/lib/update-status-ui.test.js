// Hamburger update row + update-ready dot (#87): what each update state
// renders, and that a click does the state's action (check / restart /
// open Settings → Updates) — or nothing while a check or download runs.

import {
  describeUpdateMenuItem,
  renderUpdateMenuItem,
  initUpdateStatusUi,
} from './update-status-ui.js';

const el = () => {
  const handlers = {};
  return {
    handlers,
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(event, handler) {
      handlers[event] = handler;
    },
  };
};

const makeEls = () => ({
  button: el(),
  label: el(),
  detail: el(),
  progress: el(),
  progressBar: el(),
  badge: el(),
  menuButton: el(),
});

const STATES = {
  idle: { status: 'idle', message: 'Freedom checks for updates automatically.' },
  checking: { status: 'checking', message: 'Checking for updates…' },
  downloading: { status: 'downloading', percent: 42.7, version: '0.9.0', message: 'Downloading…' },
  ready: {
    status: 'ready',
    version: '0.9.0',
    menuInstallLabel: 'Restart to Update',
    message: 'Ready',
  },
  upToDate: { status: 'up-to-date', message: 'Freedom is up to date.' },
  error: { status: 'error', message: "Couldn't reach the update server." },
  unsupported: { status: 'unsupported', reason: 'development', message: 'Updates are off.' },
};

describe('describeUpdateMenuItem', () => {
  test.each([
    ['idle', 'Check for Updates…', '', 'check', false],
    ['checking', 'Checking for Updates…', '', null, false],
    ['downloading', 'Downloading Update…', '42%', null, false],
    ['ready', 'Restart to Update', 'v0.9.0', 'install', true],
    ['upToDate', 'Check for Updates…', 'Up to date', 'check', false],
    ['error', 'Check for Updates…', 'Failed', 'check', false],
    ['unsupported', 'Check for Updates…', 'Unavailable', 'settings', false],
  ])('%s', (key, label, detail, action, badge) => {
    const view = describeUpdateMenuItem(STATES[key]);
    expect(view).toMatchObject({ label, detail, action, badge, title: STATES[key].message });
  });

  test('a missing state renders as unsupported, never as a live check button', () => {
    expect(describeUpdateMenuItem(null)).toMatchObject({ action: 'settings', badge: false });
  });

  test('the ready row uses the profile-aware install label', () => {
    expect(
      describeUpdateMenuItem({ ...STATES.ready, menuInstallLabel: 'Install Update and Close' })
        .label
    ).toBe('Install Update and Close');
  });
});

describe('renderUpdateMenuItem', () => {
  test('downloading shows percent + bar and disables the row', () => {
    const els = makeEls();
    renderUpdateMenuItem(els, STATES.downloading);
    expect(els.button.disabled).toBe(true);
    expect(els.button.dataset.updateStatus).toBe('downloading');
    expect(els.label.textContent).toBe('Downloading Update…');
    expect(els.detail).toMatchObject({ textContent: '42%', hidden: false });
    expect(els.progress.hidden).toBe(false);
    expect(els.progressBar.style.width).toBe('42.7%');
    expect(els.badge.hidden).toBe(true);
  });

  test('ready lights the hamburger dot and relabels the button; leaving ready clears it', () => {
    const els = makeEls();
    renderUpdateMenuItem(els, STATES.ready);
    expect(els.badge.hidden).toBe(false);
    expect(els.menuButton.attrs['aria-label']).toBe('Menu (update ready)');
    expect(els.progress.hidden).toBe(true);
    expect(els.button.disabled).toBe(false);

    renderUpdateMenuItem(els, STATES.idle);
    expect(els.badge.hidden).toBe(true);
    expect(els.menuButton.attrs['aria-label']).toBe('Menu');
    expect(els.detail.hidden).toBe(true);
  });
});

describe('initUpdateStatusUi', () => {
  let els;
  const originalDocument = global.document;

  beforeEach(() => {
    els = makeEls();
    const ids = {
      'check-updates-btn': els.button,
      'update-menu-label': els.label,
      'update-menu-status': els.detail,
      'update-menu-progress': els.progress,
      'update-menu-progress-bar': els.progressBar,
      'menu-update-badge': els.badge,
      'menu-button': els.menuButton,
    };
    global.document = { getElementById: (id) => ids[id] || null };
  });

  afterEach(() => {
    global.document = originalDocument;
  });

  const setup = async (initial) => {
    let push = null;
    const electronAPI = {
      getUpdateState: jest.fn(() => Promise.resolve(initial)),
      onUpdateState: jest.fn((cb) => {
        push = cb;
        return () => {};
      }),
      checkForUpdates: jest.fn(),
      restartAndInstallUpdate: jest.fn(),
    };
    const closeMenus = jest.fn();
    const openSettings = jest.fn();
    initUpdateStatusUi({ electronAPI, closeMenus, openSettings });
    await Promise.resolve();
    await Promise.resolve();
    return { electronAPI, closeMenus, openSettings, push: (s) => push(s) };
  };

  test('hydrates from getUpdateState and follows broadcasts', async () => {
    const { push } = await setup(STATES.idle);
    expect(els.label.textContent).toBe('Check for Updates…');
    push(STATES.downloading);
    expect(els.detail.textContent).toBe('42%');
  });

  test('a broadcast that lands before the hydration answer wins', async () => {
    let resolve;
    const electronAPI = {
      getUpdateState: jest.fn(() => new Promise((r) => (resolve = r))),
      onUpdateState: jest.fn((cb) => cb(STATES.ready)),
    };
    initUpdateStatusUi({ electronAPI });
    resolve(STATES.idle);
    await Promise.resolve();
    await Promise.resolve();
    expect(els.button.dataset.updateStatus).toBe('ready');
  });

  test('click: idle checks, ready installs, unsupported opens Settings → Updates', async () => {
    const { electronAPI, closeMenus, openSettings, push } = await setup(STATES.idle);
    els.button.handlers.click();
    expect(electronAPI.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(closeMenus).toHaveBeenCalledTimes(1);

    push(STATES.ready);
    els.button.handlers.click();
    expect(electronAPI.restartAndInstallUpdate).toHaveBeenCalledTimes(1);

    push(STATES.unsupported);
    els.button.handlers.click();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(electronAPI.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test('click while checking or downloading does nothing', async () => {
    const { electronAPI, closeMenus, push } = await setup(STATES.checking);
    els.button.handlers.click();
    push(STATES.downloading);
    els.button.handlers.click();
    expect(electronAPI.checkForUpdates).not.toHaveBeenCalled();
    expect(electronAPI.restartAndInstallUpdate).not.toHaveBeenCalled();
    expect(closeMenus).not.toHaveBeenCalled();
  });
});
