const mockWindows = new Map();
jest.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents) => mockWindows.get(contents) ?? null,
  },
}));

const { runInWindow, requestWindowId, chromeWindowIdOf, forSenderWindow } = require('./request-window');

describe('request-window (design 0011, APS-4)', () => {
  beforeEach(() => mockWindows.clear());

  test('the window an operation runs for, through its awaits and timers; none outside', async () => {
    expect(requestWindowId()).toBeNull();
    const seen = await runInWindow(4, async () => {
      const first = requestWindowId();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return [first, requestWindowId()];
    });
    expect(seen).toEqual([4, 4]);
    expect(requestWindowId()).toBeNull();
  });

  test('two windows at once each see their own', async () => {
    const run = (id) =>
      runInWindow(id, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return requestWindowId();
      });
    await expect(Promise.all([run(1), run(2)])).resolves.toEqual([1, 2]);
  });

  test('no window id runs the operation as it is', () => {
    expect(runInWindow(null, () => requestWindowId())).toBeNull();
    expect(runInWindow(1.5, () => requestWindowId())).toBeNull();
    expect(runInWindow(3, () => runInWindow(undefined, () => requestWindowId()))).toBe(3);
  });

  test("a listener runs for its sender's chrome window only", () => {
    const chrome = { id: 10 };
    const win = { id: 7, webContents: chrome, isDestroyed: () => false };
    mockWindows.set(chrome, win);
    const listener = forSenderWindow((_event, arg) => [requestWindowId(), arg]);
    expect(listener({ sender: chrome }, 'x')).toEqual([7, 'x']);
    expect(chromeWindowIdOf(chrome)).toBe(7);
    // Another webContents of the window (a guest, a view) is not its chrome.
    const guest = { id: 11 };
    mockWindows.set(guest, win);
    expect(listener({ sender: guest }, 'y')).toEqual([null, 'y']);
    expect(chromeWindowIdOf(guest)).toBeNull();
    // A closed window, or none.
    mockWindows.set(chrome, { ...win, isDestroyed: () => true });
    expect(chromeWindowIdOf(chrome)).toBeNull();
    expect(listener({}, 'z')).toEqual([null, 'z']);
  });
});
