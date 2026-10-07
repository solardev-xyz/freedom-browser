const { EventEmitter } = require('events');

// Next/Previous Tab are claimed in the browser process (#556). These tests
// drive the real `before-input-event` listener the module attaches, the way
// Electron calls it, rather than poking the matcher alone — the bug was a
// second press going missing, so every test presses more than once.

function load({ overrides = {}, mainWindows } = {}) {
  let mod;
  const settings = { shortcutOverrides: overrides };
  const chromeWindow = {
    isDestroyed: () => false,
    webContents: { send: jest.fn() },
  };
  const isMain = mainWindows || new Set([chromeWindow]);
  const fromWebContents = jest.fn((contents) => contents.__window || null);
  jest.isolateModules(() => {
    jest.doMock('electron', () => ({ BrowserWindow: { fromWebContents } }));
    jest.doMock('./settings-store', () => ({ loadSettings: () => settings }));
    jest.doMock('./windows/mainWindow', () => ({
      isMainBrowserWindow: (win) => isMain.has(win),
    }));
    mod = require('./tab-switch-keys');
  });
  return { mod, settings, chromeWindow, fromWebContents };
}

let nextId = 1;
function contentsMock({ hostWebContents = null, window = null } = {}) {
  const contents = new EventEmitter();
  contents.id = nextId++;
  contents.hostWebContents = hostWebContents;
  contents.__window = window;
  return contents;
}

// One press as Electron reports it to `before-input-event`.
function press(contents, input) {
  const event = { preventDefault: jest.fn() };
  contents.emit('before-input-event', event, { type: 'keyDown', ...input });
  return event;
}

const CMD_OPT_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', meta: true, alt: true };
const CMD_OPT_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', meta: true, alt: true };

afterEach(() => {
  jest.resetModules();
  jest.dontMock('electron');
  jest.dontMock('./settings-store');
  jest.dontMock('./windows/mainWindow');
});

describe('matchTabSwitchInput', () => {
  const { mod } = load();
  const match = (input, overrides, platform) =>
    mod.matchTabSwitchInput({ type: 'keyDown', ...input }, overrides, platform);

  test('matches the registry defaults and fixed aliases', () => {
    expect(match({ key: 'PageDown', code: 'PageDown', control: true }, {}, 'darwin')).toBe(
      'tab:next'
    );
    expect(match({ key: 'PageUp', code: 'PageUp', control: true }, {}, 'linux')).toBe('tab:prev');
    expect(match({ key: 'Tab', code: 'Tab', control: true }, {}, 'win32')).toBe('tab:next');
    expect(match({ key: 'Tab', code: 'Tab', control: true, shift: true }, {}, 'linux')).toBe(
      'tab:prev'
    );
    expect(match({ key: '}', code: 'BracketRight', meta: true, shift: true }, {}, 'darwin')).toBe(
      'tab:next'
    );
    // Cmd+Shift+] is a macOS-only alias.
    expect(
      match({ key: '}', code: 'BracketRight', meta: true, shift: true }, {}, 'linux')
    ).toBeNull();
  });

  test('matches a Settings > Shortcuts remap (the #556 Cmd+Opt+Arrow binding)', () => {
    const overrides = { 'tab.next': 'Cmd+Alt+Right', 'tab.previous': 'Cmd+Alt+Left' };
    expect(match(CMD_OPT_RIGHT, overrides, 'darwin')).toBe('tab:next');
    expect(match(CMD_OPT_LEFT, overrides, 'darwin')).toBe('tab:prev');
    // The remap replaces the default primary chord; the aliases stay live.
    expect(match({ key: 'PageDown', code: 'PageDown', control: true }, overrides, 'darwin')).toBe(
      null
    );
    expect(match({ key: 'Tab', code: 'Tab', control: true }, overrides, 'darwin')).toBe('tab:next');
    // Without the remap the chord is nobody's.
    expect(match(CMD_OPT_RIGHT, {}, 'darwin')).toBeNull();
  });

  test('requires an exact modifier match', () => {
    const overrides = { 'tab.next': 'Cmd+Alt+Right' };
    expect(match({ ...CMD_OPT_RIGHT, shift: true }, overrides, 'darwin')).toBeNull();
    expect(match({ ...CMD_OPT_RIGHT, alt: false }, overrides, 'darwin')).toBeNull();
  });

  test('ignores key-ups, IME composition and non-key input', () => {
    const overrides = { 'tab.next': 'Cmd+Alt+Right' };
    expect(mod.matchTabSwitchInput({ type: 'keyUp', ...CMD_OPT_RIGHT }, overrides, 'darwin')).toBe(
      null
    );
    expect(
      mod.matchTabSwitchInput(
        { type: 'keyDown', isComposing: true, ...CMD_OPT_RIGHT },
        overrides,
        'darwin'
      )
    ).toBeNull();
    expect(mod.matchTabSwitchInput({ type: 'mouseDown' }, overrides, 'darwin')).toBeNull();
    expect(mod.matchTabSwitchInput(null, overrides, 'darwin')).toBeNull();
  });

  test('keeps cycling on auto-repeat, like Chrome', () => {
    expect(match({ key: 'Tab', code: 'Tab', control: true, isAutoRepeat: true }, {}, 'linux')).toBe(
      'tab:next'
    );
  });
});

describe('attachTabSwitchKeys', () => {
  const overrides = { 'tab.next': 'Cmd+Alt+Right', 'tab.previous': 'Cmd+Alt+Left' };

  test('every press from a focused tab page switches, not just the first', () => {
    const { mod, chromeWindow } = load({ overrides });
    const chrome = contentsMock({ window: chromeWindow });
    const guest = contentsMock({ hostWebContents: chrome });
    mod.attachTabSwitchKeys(guest, { platform: 'darwin' });

    const presses = [CMD_OPT_RIGHT, CMD_OPT_RIGHT, CMD_OPT_RIGHT, CMD_OPT_LEFT].map((input) =>
      press(guest, input)
    );

    expect(chromeWindow.webContents.send.mock.calls).toEqual([
      ['tab:next'],
      ['tab:next'],
      ['tab:next'],
      ['tab:prev'],
    ]);
    // Claimed before the page, the menu accelerator and the chrome's keydown
    // fallback — so one press is one switch.
    for (const event of presses) expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('also answers on the chrome renderer itself', () => {
    const { mod, chromeWindow } = load();
    const chrome = contentsMock({ window: chromeWindow });
    mod.attachTabSwitchKeys(chrome, { platform: 'linux' });

    press(chrome, { key: 'PageDown', code: 'PageDown', control: true });
    press(chrome, { key: 'PageUp', code: 'PageUp', control: true });

    expect(chromeWindow.webContents.send.mock.calls).toEqual([['tab:next'], ['tab:prev']]);
  });

  test('follows a remap made while the app is running', () => {
    const { mod, settings, chromeWindow } = load();
    const chrome = contentsMock({ window: chromeWindow });
    const guest = contentsMock({ hostWebContents: chrome });
    mod.attachTabSwitchKeys(guest, { platform: 'darwin' });

    expect(press(guest, CMD_OPT_RIGHT).preventDefault).not.toHaveBeenCalled();
    settings.shortcutOverrides = overrides;
    expect(press(guest, CMD_OPT_RIGHT).preventDefault).toHaveBeenCalled();
    expect(chromeWindow.webContents.send).toHaveBeenCalledWith('tab:next');
  });

  test('leaves every other key to the page', () => {
    const { mod, chromeWindow } = load({ overrides });
    const guest = contentsMock({ hostWebContents: contentsMock({ window: chromeWindow }) });
    mod.attachTabSwitchKeys(guest, { platform: 'darwin' });

    const event = press(guest, { key: 'ArrowRight', code: 'ArrowRight', meta: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(chromeWindow.webContents.send).not.toHaveBeenCalled();
  });

  test('does nothing outside a browser window (DevTools, a closing window)', () => {
    const { mod, chromeWindow } = load({ overrides, mainWindows: new Set() });
    const guest = contentsMock({ hostWebContents: contentsMock({ window: chromeWindow }) });
    const orphan = contentsMock();
    mod.attachTabSwitchKeys(guest, { platform: 'darwin' });
    mod.attachTabSwitchKeys(orphan, { platform: 'darwin' });

    expect(press(guest, CMD_OPT_RIGHT).preventDefault).not.toHaveBeenCalled();
    expect(press(orphan, CMD_OPT_RIGHT).preventDefault).not.toHaveBeenCalled();
    expect(chromeWindow.webContents.send).not.toHaveBeenCalled();
  });
});

describe('a Settings > Shortcuts recording', () => {
  const overrides = { 'tab.next': 'Cmd+Alt+Right' };

  function setup() {
    const ctx = load({ overrides });
    const chrome = contentsMock({ window: ctx.chromeWindow });
    const settingsPage = contentsMock({ hostWebContents: chrome });
    const otherTab = contentsMock({ hostWebContents: chrome });
    ctx.mod.attachTabSwitchKeys(settingsPage, { platform: 'darwin' });
    ctx.mod.attachTabSwitchKeys(otherTab, { platform: 'darwin' });
    return { ...ctx, settingsPage, otherTab };
  }

  test('lets the recording page receive the chord, and only while armed', () => {
    const { mod, chromeWindow, settingsPage, otherTab } = setup();

    mod.setShortcutRecording(settingsPage, true);
    expect(press(settingsPage, CMD_OPT_RIGHT).preventDefault).not.toHaveBeenCalled();
    expect(chromeWindow.webContents.send).not.toHaveBeenCalled();
    // Scoped to that page: another tab still switches.
    expect(press(otherTab, CMD_OPT_RIGHT).preventDefault).toHaveBeenCalled();
    expect(chromeWindow.webContents.send).toHaveBeenCalledTimes(1);

    mod.setShortcutRecording(settingsPage, false);
    expect(press(settingsPage, CMD_OPT_RIGHT).preventDefault).toHaveBeenCalled();
    expect(chromeWindow.webContents.send).toHaveBeenCalledTimes(2);
  });

  test('is disarmed when the page is replaced or goes away', () => {
    const { mod, chromeWindow, settingsPage } = setup();
    const LISTENED = ['did-navigate', 'did-fail-load', 'destroyed'];

    mod.setShortcutRecording(settingsPage, true);
    // A main-frame navigation that starts but never commits (Stop, a link
    // that becomes a download, an external-protocol link) leaves the page
    // and its armed recorder in place, so the chord still reaches it.
    settingsPage.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    settingsPage.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x.test/a.zip', true);
    // Its own #hash routing and a subframe's failed load keep it armed too.
    settingsPage.emit('did-navigate-in-page', {}, 'file:///settings.html#shortcuts', true);
    settingsPage.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.test/', false);
    expect(mod._isRecording(settingsPage.id)).toBe(true);
    expect(press(settingsPage, CMD_OPT_RIGHT).preventDefault).not.toHaveBeenCalled();
    expect(chromeWindow.webContents.send).not.toHaveBeenCalled();

    // A committed main-frame cross-document navigation disarms.
    settingsPage.emit('did-navigate', {}, 'https://example.test/', 200, 'OK');
    expect(mod._isRecording(settingsPage.id)).toBe(false);
    for (const name of LISTENED) expect(settingsPage.listenerCount(name)).toBe(0);
    expect(press(settingsPage, CMD_OPT_RIGHT).preventDefault).toHaveBeenCalled();

    // So does an error page committed over it (a main-frame failure other
    // than ERR_ABORTED).
    mod.setShortcutRecording(settingsPage, true);
    settingsPage.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.test/', true);
    expect(mod._isRecording(settingsPage.id)).toBe(false);
    for (const name of LISTENED) expect(settingsPage.listenerCount(name)).toBe(0);

    mod.setShortcutRecording(settingsPage, true);
    settingsPage.emit('destroyed');
    expect(mod._isRecording(settingsPage.id)).toBe(false);
    for (const name of LISTENED) expect(settingsPage.listenerCount(name)).toBe(0);
  });

  test('re-arming does not stack listeners', () => {
    const { mod, settingsPage } = setup();
    for (let i = 0; i < 3; i++) {
      mod.setShortcutRecording(settingsPage, true);
      mod.setShortcutRecording(settingsPage, true);
      mod.setShortcutRecording(settingsPage, false);
    }
    for (const name of ['did-navigate', 'did-fail-load', 'destroyed']) {
      expect(settingsPage.listenerCount(name)).toBe(0);
    }
  });

  test('is set through the shortcuts:set-recording IPC from the sender', () => {
    const { mod, settingsPage } = setup();
    const handlers = new Map();
    mod.registerTabSwitchKeysIpc({ handle: (channel, fn) => handlers.set(channel, fn) });
    const handler = handlers.get('shortcuts:set-recording');

    handler({ sender: settingsPage }, true);
    expect(mod._isRecording(settingsPage.id)).toBe(true);
    handler({ sender: settingsPage }, false);
    expect(mod._isRecording(settingsPage.id)).toBe(false);
    // Only a literal `true` arms it.
    handler({ sender: settingsPage }, 'yes');
    expect(mod._isRecording(settingsPage.id)).toBe(false);
  });
});
