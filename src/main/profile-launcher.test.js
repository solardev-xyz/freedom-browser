const path = require('path');
const {
  buildProfileLaunchCommand,
  getMacAppBundlePath,
  launchProfile,
  openOrFocusProfile,
} = require('./profile-launcher');

describe('profile launcher', () => {
  test('derives the macOS app bundle path from the executable path', () => {
    expect(
      getMacAppBundlePath('/Applications/Freedom.app/Contents/MacOS/Freedom')
    ).toBe('/Applications/Freedom.app');
    expect(getMacAppBundlePath('/usr/bin/freedom')).toBeNull();
  });

  test('builds a dev launch command using the checkout root', () => {
    const command = buildProfileLaunchCommand(
      {
        isDev: true,
        repoRoot: '/repo/freedom-browser',
      },
      'work',
      {
        execPath: '/repo/freedom-browser/node_modules/.bin/electron',
        platform: 'darwin',
      }
    );

    expect(command).toEqual({
      command: '/repo/freedom-browser/node_modules/.bin/electron',
      args: ['/repo/freedom-browser', '--profile=work'],
      cwd: '/repo/freedom-browser',
    });
  });

  test('builds a packaged macOS launch command with open -n', () => {
    const command = buildProfileLaunchCommand(
      { isDev: false },
      'work',
      {
        execPath: '/Applications/Freedom.app/Contents/MacOS/Freedom',
        platform: 'darwin',
      }
    );

    expect(command).toEqual({
      command: 'open',
      args: ['-n', '/Applications/Freedom.app', '--args', '--profile=work'],
      cwd: undefined,
    });
  });

  test('builds a packaged non-mac launch command from the executable', () => {
    const command = buildProfileLaunchCommand(
      { isDev: false },
      'work',
      {
        execPath: path.join('C:', 'Program Files', 'Freedom', 'Freedom.exe'),
        platform: 'win32',
      }
    );

    expect(command).toEqual({
      command: path.join('C:', 'Program Files', 'Freedom', 'Freedom.exe'),
      args: ['--profile=work'],
      cwd: undefined,
    });
  });

  test('appends --open-settings after the profile arg when requested', () => {
    expect(
      buildProfileLaunchCommand(
        { isDev: true, repoRoot: '/repo/freedom-browser' },
        'work',
        { execPath: '/electron', platform: 'linux', openSettings: true }
      ).args
    ).toEqual(['/repo/freedom-browser', '--profile=work', '--open-settings']);

    expect(
      buildProfileLaunchCommand(
        { isDev: false },
        'work',
        { execPath: '/Applications/Freedom.app/Contents/MacOS/Freedom', platform: 'darwin', openSettings: true }
      ).args
    ).toEqual(['-n', '/Applications/Freedom.app', '--args', '--profile=work', '--open-settings']);
  });

  test('spawns detached and unrefs the launched process', () => {
    const child = { unref: jest.fn() };
    const spawn = jest.fn(() => child);
    const command = launchProfile(
      {
        isDev: true,
        repoRoot: '/repo/freedom-browser',
      },
      'work',
      {
        env: { FREEDOM_DEV_HOME: '/tmp/freedom-dev' },
        execPath: '/electron',
        platform: 'linux',
        spawn,
      }
    );

    expect(command).toEqual({
      command: '/electron',
      args: ['/repo/freedom-browser', '--profile=work'],
      cwd: '/repo/freedom-browser',
    });
    expect(spawn).toHaveBeenCalledWith('/electron', ['/repo/freedom-browser', '--profile=work'], {
      cwd: '/repo/freedom-browser',
      detached: true,
      env: { FREEDOM_DEV_HOME: '/tmp/freedom-dev' },
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalled();
  });

  describe('openOrFocusProfile', () => {
    const activeProfile = { isDev: true, repoRoot: '/repo/freedom-browser', source: 'catalog' };

    test('focuses an already-running profile without spawning', async () => {
      const spawn = jest.fn();
      const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
      });

      expect(result).toEqual({ focused: true });
      expect(requestFocus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'work', isLocked: true }),
        { openSettings: false }
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    test('forwards openSettings to the focus request', async () => {
      const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn: jest.fn(),
        openSettings: true,
      });

      expect(requestFocus).toHaveBeenCalledWith(expect.any(Object), { openSettings: true });
    });

    test('launches when the profile is not running', async () => {
      const child = { unref: jest.fn() };
      const spawn = jest.fn(() => child);
      const requestFocus = jest.fn();
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: false }));

      const result = await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(result.launch).toEqual({
        command: '/electron',
        args: ['/repo/freedom-browser', '--profile=work'],
        cwd: '/repo/freedom-browser',
      });
      expect(requestFocus).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    });

    test('falls back to launching when the focus request cannot be written', async () => {
      const child = { unref: jest.fn() };
      const spawn = jest.fn(() => child);
      // requestWritten === false: the request never reached a process, so there
      // is nothing live to focus and cold-starting is correct.
      const requestFocus = jest.fn(() => ({ ok: false, requestWritten: false, error: 'nope' }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(result.launch).toBeDefined();
      expect(spawn).toHaveBeenCalled();
    });

    test('reports failure (no spawn) when a running profile does not acknowledge', async () => {
      const spawn = jest.fn();
      // Request was written but the running profile never acked (timed out).
      const requestFocus = jest.fn(() => ({
        ok: false,
        requestWritten: true,
        timedOut: true,
        error: 'The running profile did not respond',
      }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(result.error).toBe('The running profile did not respond');
      expect(result.launch).toBeUndefined();
      // Must not cold-start a duplicate against the still-live lock.
      expect(spawn).not.toHaveBeenCalled();
    });

    test('reports failure (no spawn) when the running profile acks a focus failure', async () => {
      const spawn = jest.fn();
      // The running profile received the request and acked, but could not focus
      // (e.g. at startup its window focus handler is not yet assigned). This is
      // an explicit acknowledged failure — ok:false, requestWritten:true, and
      // crucially NOT timedOut. A live process still holds the lock, so we must
      // surface the failure rather than cold-start a duplicate into it.
      const requestFocus = jest.fn(() => ({
        ok: false,
        requestWritten: true,
        error: 'Main window focus handler is not ready',
      }));
      const getFocusTarget = jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      const result = await openOrFocusProfile(activeProfile, 'work', {
        getFocusTarget,
        requestFocus,
        spawn,
        execPath: '/electron',
        platform: 'linux',
      });

      expect(result.focused).toBe(false);
      expect(result.error).toBe('Main window focus handler is not ready');
      expect(result.launch).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    describe('GNOME Wayland: switching to a running profile through xdg-open (#142)', () => {
      const running = () => jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: true }));

      test('goes through xdg-open when that path applies, without the file hand-off', async () => {
        const switchViaXdgOpen = jest.fn(async () => true);
        const requestFocus = jest.fn();
        const spawn = jest.fn();
        const result = await openOrFocusProfile(activeProfile, 'Work', {
          getFocusTarget: running(),
          switchViaXdgOpen,
          requestFocus,
          spawn,
        });
        expect(result).toEqual({ focused: true });
        // The catalog's target (canonical id, its dir for the ack), not the
        // caller's input.
        expect(switchViaXdgOpen).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'work', userDataDir: '/p/work' })
        );
        expect(requestFocus).not.toHaveBeenCalled();
        expect(spawn).not.toHaveBeenCalled();
      });

      test('falls back to the file hand-off when it does not apply or fails', async () => {
        const switchViaXdgOpen = jest.fn(async () => false);
        const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
        const result = await openOrFocusProfile(activeProfile, 'work', {
          getFocusTarget: running(),
          switchViaXdgOpen,
          requestFocus,
          spawn: jest.fn(),
        });
        expect(result).toEqual({ focused: true });
        expect(switchViaXdgOpen).toHaveBeenCalledTimes(1);
        expect(requestFocus).toHaveBeenCalledTimes(1);
      });

      test('an unconfirmed xdg-open switch falls back to the file, which reports it', async () => {
        const switchViaXdgOpen = jest.fn(async () => false);
        const requestFocus = jest.fn(async () => ({
          ok: false,
          requestWritten: true,
          timedOut: true,
          error: 'The running profile did not respond',
        }));
        const spawn = jest.fn();
        const result = await openOrFocusProfile(activeProfile, 'work', {
          getFocusTarget: running(),
          switchViaXdgOpen,
          requestFocus,
          spawn,
        });
        expect(result).toEqual({ focused: false, error: 'The running profile did not respond' });
        expect(requestFocus).toHaveBeenCalledTimes(1);
        expect(spawn).not.toHaveBeenCalled();
      });

      test('an --open-settings switch keeps to the file hand-off', async () => {
        const switchViaXdgOpen = jest.fn(async () => true);
        const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
        await openOrFocusProfile(activeProfile, 'work', {
          getFocusTarget: running(),
          switchViaXdgOpen,
          requestFocus,
          spawn: jest.fn(),
          openSettings: true,
        });
        expect(switchViaXdgOpen).not.toHaveBeenCalled();
        expect(requestFocus).toHaveBeenCalledWith(expect.any(Object), { openSettings: true });
      });

      test('a profile that is not running is cold-started, not switched to', async () => {
        const switchViaXdgOpen = jest.fn(async () => true);
        const result = await openOrFocusProfile(activeProfile, 'work', {
          getFocusTarget: jest.fn(() => ({ id: 'work', userDataDir: '/p/work', isLocked: false })),
          switchViaXdgOpen,
          requestFocus: jest.fn(),
          spawn: jest.fn(() => ({ unref: jest.fn() })),
          execPath: '/electron',
          platform: 'linux',
        });
        expect(result.focused).toBe(false);
        expect(result.launch).toBeDefined();
        expect(switchViaXdgOpen).not.toHaveBeenCalled();
      });

      test('the default decision is inert outside packaged Linux Wayland', async () => {
        // No injected switchViaXdgOpen: the real one runs against the jest
        // electron mock (isPackaged: false) and must leave the file path alone.
        const requestFocus = jest.fn(() => ({ ok: true, nonce: 'n' }));
        const result = await openOrFocusProfile(activeProfile, 'work', {
          getFocusTarget: running(),
          requestFocus,
          spawn: jest.fn(),
        });
        expect(result).toEqual({ focused: true });
        expect(requestFocus).toHaveBeenCalledTimes(1);
      });
    });
  });
});
