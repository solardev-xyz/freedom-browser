jest.mock('./logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const log = require('./logger');
const { EventEmitter } = require('events');
const {
  SCROLL_QUIET_MS,
  TWO_FINGER_DEFAULT_KEY,
  attachThreeFingerSwipe,
  awaitScrollEnd,
  getSwipeNavigationState,
  isTwoFingerSwipeEnabled,
} = require('./swipe-navigation');

describe('two-finger swipe setting (#980)', () => {
  const reading = (value) => jest.fn(() => value);

  test('reads macOS "Swipe between pages" as a string, so unset means on', () => {
    const getUserDefault = reading('');
    expect(isTwoFingerSwipeEnabled({ platform: 'darwin', getUserDefault })).toBe(true);
    expect(getUserDefault).toHaveBeenCalledWith(TWO_FINGER_DEFAULT_KEY, 'string');
    expect(TWO_FINGER_DEFAULT_KEY).toBe('AppleEnableSwipeNavigateWithScrolls');
  });

  test('is off only when the user turned it off', () => {
    expect(isTwoFingerSwipeEnabled({ platform: 'darwin', getUserDefault: reading('0') })).toBe(
      false
    );
    expect(isTwoFingerSwipeEnabled({ platform: 'darwin', getUserDefault: reading('1') })).toBe(
      true
    );
  });

  test('is off on other platforms without asking', () => {
    const getUserDefault = reading('1');
    expect(isTwoFingerSwipeEnabled({ platform: 'linux', getUserDefault })).toBe(false);
    expect(isTwoFingerSwipeEnabled({ platform: 'win32', getUserDefault })).toBe(false);
    expect(getUserDefault).not.toHaveBeenCalled();
  });

  test('falls back to macOS’s default when the setting cannot be read', () => {
    const getUserDefault = jest.fn(() => {
      throw new Error('no defaults');
    });
    expect(isTwoFingerSwipeEnabled({ platform: 'darwin', getUserDefault })).toBe(true);
    expect(log.warn).toHaveBeenCalled();
  });

  test('the state the chrome asks for', () => {
    expect(getSwipeNavigationState({ platform: 'darwin', getUserDefault: reading('0') })).toEqual({
      twoFinger: false,
    });
    expect(getSwipeNavigationState({ platform: 'darwin', getUserDefault: reading('') })).toEqual({
      twoFinger: true,
    });
  });
});

describe('three-finger swipe (#980)', () => {
  function fakeWindow() {
    const handlers = {};
    return {
      destroyed: false,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      isDestroyed() {
        return this.destroyed;
      },
      webContents: { send: jest.fn() },
      swipe(direction) {
        handlers.swipe({}, direction);
      },
    };
  }

  test("Electron's left is Back and right is Forward, as in Chrome", () => {
    const window = fakeWindow();
    attachThreeFingerSwipe(window);
    window.swipe('left');
    window.swipe('right');
    expect(window.webContents.send.mock.calls).toEqual([['history:back'], ['history:forward']]);
  });

  test('vertical swipes and a closed window do nothing', () => {
    const window = fakeWindow();
    attachThreeFingerSwipe(window);
    window.swipe('up');
    window.swipe('down');
    window.destroyed = true;
    window.swipe('left');
    expect(window.webContents.send).not.toHaveBeenCalled();
  });
});

describe("the end of a swipe's scroll (#980)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const wheel = (tab, type = 'mouseWheel') => tab.emit('input-event', {}, { type });

  // Settle the wait's promise, if it is due, without moving the clock.
  const settled = async (promise) => {
    let value = 'pending';
    promise.then((answer) => {
      value = answer;
    });
    await Promise.resolve();
    await Promise.resolve();
    return value;
  };

  test('answers once the tab has had no wheel input for the quiet time', async () => {
    expect(SCROLL_QUIET_MS).toBe(150);
    const tab = new EventEmitter();
    const answer = awaitScrollEnd(tab);
    for (let i = 0; i < 20; i += 1) {
      jest.advanceTimersByTime(100);
      wheel(tab);
    }
    // Other input does not keep the scroll going.
    wheel(tab, 'gestureScrollUpdate');
    wheel(tab, 'mouseMove');
    jest.advanceTimersByTime(149);
    expect(await settled(answer)).toBe('pending');
    jest.advanceTimersByTime(1);
    expect(await settled(answer)).toEqual({ quietForMs: 150 });
    expect(tab.listenerCount('input-event')).toBe(0);
    expect(tab.listenerCount('destroyed')).toBe(0);
  });

  test('answers after the quiet time when no wheel input comes at all', async () => {
    const tab = new EventEmitter();
    const answer = awaitScrollEnd(tab);
    jest.advanceTimersByTime(150);
    expect(await settled(answer)).toEqual({ quietForMs: 150 });
  });

  test('keeps waiting for as long as the wheel input goes on', async () => {
    // Answering early would let a page that arrives late take the rest of
    // the scroll for a new swipe.
    const tab = new EventEmitter();
    const answer = awaitScrollEnd(tab);
    for (let t = 0; t < 10000; t += 100) {
      jest.advanceTimersByTime(100);
      wheel(tab);
    }
    expect(await settled(answer)).toBe('pending');
    jest.advanceTimersByTime(150);
    expect(await settled(answer)).toEqual({ quietForMs: 150 });
  });

  test('answers when the tab goes away', async () => {
    const tab = new EventEmitter();
    const answer = awaitScrollEnd(tab);
    jest.advanceTimersByTime(40);
    wheel(tab);
    jest.advanceTimersByTime(30);
    tab.emit('destroyed');
    expect(await settled(answer)).toEqual({ quietForMs: 30 });
    expect(tab.listenerCount('input-event')).toBe(0);
  });
});
