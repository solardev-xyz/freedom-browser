const { EventEmitter } = require('events');
const {
  createSecondInstanceHandler,
  handleLockedProfileLaunch,
  handOverToRunningProfile,
  listenForProfileRelaunches,
  recordProfileSwitch,
} = require('./profile-instance-handoff');
const { createFirstWindowLinkQueue } = require('./launch-urls');

const SETTINGS_URL = 'freedom://settings/profile';

function makeApp({ lock = true, ready = true } = {}) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = jest.fn(() => lock);
  app.isReady = jest.fn(() => ready);
  let resolveReady;
  const whenReady = new Promise((resolve) => {
    resolveReady = resolve;
  });
  app.whenReady = jest.fn(() => whenReady);
  app.becomeReady = () => {
    app.isReady.mockReturnValue(true);
    resolveReady();
    return whenReady;
  };
  return app;
}

function readyQueue() {
  const queue = createFirstWindowLinkQueue();
  queue.drainForFirstWindow();
  return queue;
}

describe('profile instance hand-off (Linux single-instance lock, #142)', () => {
  describe('handleLockedProfileLaunch (R2-M1)', () => {
    const SWITCH = { id: 'work', userDataDir: '/p/work', switchOnly: true };
    const PLAIN = { id: 'work', displayName: 'Work', userDataDir: '/p/work' };
    const run = ({ profile, lock = false, probe = () => false, focusOk = true } = {}) => {
      const deps = {
        app: makeApp({ lock }),
        profile,
        launchUrls: [],
        probe: jest.fn(probe),
        requestFocus: jest.fn(() => ({ ok: focusOk, error: focusOk ? undefined : 'timed out' })),
        showError: jest.fn(),
        writeSwitchAck: jest.fn(),
        logger: { warn: jest.fn() },
        platform: 'linux',
      };
      handleLockedProfileLaunch(deps);
      return deps;
    };

    test('a hand-over through the lock leaves the file and the ack to the holder', () => {
      const deps = run({ profile: SWITCH, probe: () => true, lock: false });
      expect(deps.requestFocus).not.toHaveBeenCalled();
      expect(deps.writeSwitchAck).not.toHaveBeenCalled();
      expect(deps.showError).not.toHaveBeenCalled();
    });

    test('a switch launch that falls back to the file records the focus it got, so the switching profile does not focus again', () => {
      const deps = run({ profile: SWITCH, focusOk: true });
      expect(deps.requestFocus).toHaveBeenCalledTimes(1);
      expect(deps.writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'done' });
      expect(deps.showError).not.toHaveBeenCalled();
    });

    test('a switch launch whose file focus fails records it and shows no dialog of its own', () => {
      const deps = run({ profile: SWITCH, focusOk: false });
      expect(deps.writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'failed' });
      expect(deps.showError).not.toHaveBeenCalled();
      expect(deps.logger.warn).toHaveBeenCalled();
    });

    test('a switch launch whose file focus throws counts it as failed', () => {
      const deps = {
        app: makeApp(),
        profile: SWITCH,
        probe: () => false,
        requestFocus: () => {
          throw new Error('EACCES');
        },
        showError: jest.fn(),
        writeSwitchAck: jest.fn(),
        platform: 'linux',
      };
      handleLockedProfileLaunch(deps);
      expect(deps.writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'failed' });
      expect(deps.showError).not.toHaveBeenCalled();
    });

    test('an ordinary launch still reports a focus that failed, and writes no switch ack', () => {
      const deps = run({ profile: PLAIN, focusOk: false });
      expect(deps.showError).toHaveBeenCalledWith(
        'Freedom profile is already open',
        expect.stringContaining('"Work" profile is already open')
      );
      expect(deps.writeSwitchAck).not.toHaveBeenCalled();
      const ok = run({ profile: PLAIN, focusOk: true });
      expect(ok.showError).not.toHaveBeenCalled();
    });
  });

  describe('recordProfileSwitch', () => {
    test('records only for a switch launch, and never throws', () => {
      const writeSwitchAck = jest.fn();
      recordProfileSwitch({ id: 'work', userDataDir: '/p/work' }, 'received', { writeSwitchAck });
      expect(writeSwitchAck).not.toHaveBeenCalled();
      recordProfileSwitch({ id: 'work', userDataDir: '/p/work', switchOnly: true }, 'received', {
        writeSwitchAck,
      });
      expect(writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'received' });
      const logger = { warn: jest.fn() };
      expect(() =>
        recordProfileSwitch({ userDataDir: '/p/work', switchOnly: true }, 'failed', {
          writeSwitchAck: () => {
            throw new Error('EROFS');
          },
          logger,
        })
      ).not.toThrow();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('handOverToRunningProfile', () => {
    test('a launch of a running profile hands over when the running process answers the probe and holds the lock', () => {
      const app = makeApp({ lock: false });
      const probe = jest.fn(() => true);
      expect(handOverToRunningProfile(app, { platform: 'linux', probe })).toBe(true);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    });

    test('never asks for the lock unless the running process answered the probe', () => {
      // Chromium SIGKILLs a lock holder that does not acknowledge within 20 s
      // (a modal error box, a busy main thread): no answer, no lock request.
      for (const probe of [
        undefined,
        jest.fn(() => false),
        jest.fn(() => {
          throw new Error('EACCES');
        }),
      ]) {
        const app = makeApp({ lock: false });
        expect(handOverToRunningProfile(app, { platform: 'linux', probe })).toBe(false);
        expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
      }
    });

    test('falls back to the file hand-off when the holder went away after answering', () => {
      const app = makeApp({ lock: true });
      expect(handOverToRunningProfile(app, { platform: 'linux', probe: () => true })).toBe(false);
    });

    test('is inert on macOS and Windows', () => {
      for (const platform of ['darwin', 'win32']) {
        const app = makeApp({ lock: false });
        const probe = jest.fn(() => true);
        expect(handOverToRunningProfile(app, { platform, probe })).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
      }
    });
  });

  describe('listenForProfileRelaunches', () => {
    test('takes the lock and listens for second launches on Linux', () => {
      const app = makeApp();
      const focusWindow = jest.fn();
      expect(
        listenForProfileRelaunches(app, {
          platform: 'linux',
          settingsUrl: SETTINGS_URL,
          firstWindowLinks: readyQueue(),
          focusWindow,
        })
      ).toBe(true);
      app.emit('second-instance', {}, ['/opt/Freedom/freedom', '--profile=work']);
      expect(focusWindow).toHaveBeenCalledWith([]);
    });

    test('is inert on macOS and Windows', () => {
      for (const platform of ['darwin', 'win32']) {
        const app = makeApp();
        expect(listenForProfileRelaunches(app, { platform })).toBe(false);
        expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
        expect(app.listenerCount('second-instance')).toBe(0);
      }
    });

    test('without the lock it does not listen, and says why', () => {
      const app = makeApp({ lock: false });
      const logger = { warn: jest.fn() };
      expect(listenForProfileRelaunches(app, { platform: 'linux', logger })).toBe(false);
      expect(app.listenerCount('second-instance')).toBe(0);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('second-instance handler', () => {
    function handler(overrides = {}) {
      const app = overrides.app || makeApp();
      const focusWindow = overrides.focusWindow || jest.fn();
      const firstWindowLinks = overrides.firstWindowLinks || readyQueue();
      const logger = { error: jest.fn(), warn: jest.fn() };
      const writeSwitchAck = overrides.writeSwitchAck || jest.fn();
      return {
        app,
        focusWindow,
        firstWindowLinks,
        logger,
        writeSwitchAck,
        handle: createSecondInstanceHandler({
          app,
          settingsUrl: SETTINGS_URL,
          firstWindowLinks,
          focusWindow,
          logger,
          userDataDir: '/p/work',
          writeSwitchAck,
        }),
      };
    }

    test('a plain relaunch (dock, app grid, terminal) raises the window in the same turn', () => {
      const { handle, focusWindow } = handler();
      handle({}, ['/opt/Freedom/freedom', '--profile=default']);
      // Synchronously: Electron set this launch's activation token just before
      // the event, and the focus must activate with it.
      expect(focusWindow).toHaveBeenCalledWith([]);
    });

    test('an x-freedom-profile switch raises the window, opens nothing, then acknowledges', () => {
      const { handle, focusWindow, writeSwitchAck } = handler();
      handle({}, ['/opt/Freedom/freedom', 'x-freedom-profile:work']);
      expect(focusWindow).toHaveBeenCalledWith([]);
      expect(writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'done' });
      expect(focusWindow.mock.invocationCallOrder[0]).toBeLessThan(
        writeSwitchAck.mock.invocationCallOrder[0]
      );
    });

    test('only a switch is acknowledged, and one whose focus threw as failed (R3-M2)', () => {
      const plain = handler();
      plain.handle({}, ['/opt/Freedom/freedom', '--profile=work']);
      expect(plain.writeSwitchAck).not.toHaveBeenCalled();

      const failing = handler({
        focusWindow: jest.fn(() => {
          throw new Error('window destroyed');
        }),
      });
      failing.handle({}, ['/opt/Freedom/freedom', 'x-freedom-profile:work']);
      expect(failing.writeSwitchAck).toHaveBeenCalledTimes(1);
      expect(failing.writeSwitchAck).toHaveBeenCalledWith('/p/work', { state: 'failed' });

      const plainFailing = handler({
        focusWindow: jest.fn(() => {
          throw new Error('window destroyed');
        }),
      });
      plainFailing.handle({}, ['/opt/Freedom/freedom', '--profile=work']);
      expect(plainFailing.writeSwitchAck).not.toHaveBeenCalled();
    });

    test('a switch during cold start is acknowledged once queued for the first window', () => {
      const { handle, writeSwitchAck } = handler({
        firstWindowLinks: createFirstWindowLinkQueue(),
      });
      handle({}, ['/opt/Freedom/freedom', 'x-freedom-profile:work']);
      expect(writeSwitchAck).toHaveBeenCalledTimes(1);
    });

    test('an ack that cannot be written is logged, not thrown into Electron', () => {
      const { handle, logger } = handler({
        writeSwitchAck: jest.fn(() => {
          throw new Error('ENOSPC');
        }),
      });
      expect(() => handle({}, ['/opt/Freedom/freedom', 'x-freedom-profile:work'])).not.toThrow();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('opens the links the launch was given, checked like any launch', () => {
      const { handle, focusWindow } = handler();
      handle({}, [
        '/opt/Freedom/freedom',
        '--profile=work',
        'https://example.com/a',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ]);
      expect(focusWindow).toHaveBeenCalledWith([
        'https://example.com/a',
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      ]);
    });

    test('a Profiles-manager launch with --open-settings opens Profile settings only', () => {
      const { handle, focusWindow } = handler();
      handle({}, [
        '/opt/Freedom/freedom',
        '--profile=work',
        '--open-settings',
        'https://a.example',
      ]);
      expect(focusWindow).toHaveBeenCalledWith([SETTINGS_URL]);
    });

    test('while cold-starting, the links go to the first window instead', () => {
      const firstWindowLinks = createFirstWindowLinkQueue();
      const { handle, focusWindow } = handler({ firstWindowLinks });
      handle({}, ['/opt/Freedom/freedom', 'https://example.com/a']);
      handle({}, ['/opt/Freedom/freedom', '--open-settings']);
      expect(focusWindow).not.toHaveBeenCalled();
      expect(firstWindowLinks.drainForFirstWindow()).toEqual([
        'https://example.com/a',
        SETTINGS_URL,
      ]);
    });

    test('waits for ready if the app is not ready yet', async () => {
      const app = makeApp({ ready: false });
      const { handle, focusWindow } = handler({ app });
      handle({}, ['/opt/Freedom/freedom', 'https://example.com/a']);
      expect(focusWindow).not.toHaveBeenCalled();
      await app.becomeReady();
      await Promise.resolve();
      expect(focusWindow).toHaveBeenCalledWith(['https://example.com/a']);
    });

    test('a focus failure is logged, not thrown into Electron', () => {
      const focusWindow = jest.fn(() => {
        throw new Error('window destroyed');
      });
      const { handle, logger } = handler({ focusWindow });
      expect(() => handle({}, ['/opt/Freedom/freedom'])).not.toThrow();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });
});
