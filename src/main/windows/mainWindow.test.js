// focusBrowserWindow is how a running profile answers another profile's
// "focus your window" request (profile-focus-handoff.js → index.js →
// focusOrCreateMainWindow). The request arrives from a different process, so
// every platform has to get past its window manager's focus-stealing
// prevention in its own way (issue #142 for Linux).

const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');

function makeWindow({ focused = false } = {}) {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => focused,
    restore: record('restore'),
    show: record('show'),
    focus: record('focus'),
    setAlwaysOnTop: record('setAlwaysOnTop'),
    flashFrame: record('flashFrame'),
    once: record('once'),
  };
}

function loadForPlatform(platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  const appFocus = jest.fn();
  try {
    const { mod } = loadMainModule(require.resolve('./mainWindow'), {
      app: { isPackaged: false, focus: appFocus },
      extraMocks: {
        [require.resolve('../logger')]: () => ({
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }),
        [require.resolve('../settings-store')]: () => ({ loadSettings: () => ({}) }),
      },
    });
    return { mod, appFocus, restore: () => Object.defineProperty(process, 'platform', original) };
  } catch (error) {
    Object.defineProperty(process, 'platform', original);
    throw error;
  }
}

describe('focusBrowserWindow', () => {
  let ctx;
  afterEach(() => ctx?.restore());

  test('linux: raises through an always-on-top toggle around focus()', () => {
    ctx = loadForPlatform('linux');
    const win = makeWindow();
    expect(ctx.mod.focusBrowserWindow(win)).toBe(true);
    expect(win.calls).toEqual([
      ['setAlwaysOnTop', true],
      ['focus'],
      ['setAlwaysOnTop', false],
      ['focus'],
    ]);
  });

  test('linux: never flashes the frame, even when focus was refused', () => {
    // On Linux flashFrame(true) sets "demands attention", which GNOME shows
    // as the "'Freedom' is ready" notification #142 is about.
    ctx = loadForPlatform('linux');
    const win = makeWindow({ focused: false });
    ctx.mod.focusBrowserWindow(win);
    expect(win.calls.some(([name]) => name === 'flashFrame')).toBe(false);
  });

  test('win32: toggles always-on-top and flashes the frame if still unfocused', () => {
    ctx = loadForPlatform('win32');
    const win = makeWindow({ focused: false });
    ctx.mod.focusBrowserWindow(win);
    expect(win.calls.slice(0, 4)).toEqual([
      ['setAlwaysOnTop', true],
      ['focus'],
      ['setAlwaysOnTop', false],
      ['flashFrame', true],
    ]);
  });

  test('darwin: steals focus through app.focus, no always-on-top toggle', () => {
    ctx = loadForPlatform('darwin');
    const win = makeWindow();
    ctx.mod.focusBrowserWindow(win);
    expect(ctx.appFocus).toHaveBeenCalledWith({ steal: true });
    expect(win.calls).toEqual([['focus']]);
  });
});
