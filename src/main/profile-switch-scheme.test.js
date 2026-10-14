const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../../package.json');
const {
  PACKAGED_DESKTOP_NAME,
  PROFILE_SWITCH_ACK_DIR,
  PROFILE_SWITCH_MIME_TYPE,
  buildProfileSwitchUrl,
  desktopEntryRunsThisApp,
  execProgram,
  parseDesktopEntryExec,
  parseProfileSwitchArgv,
  parseProfileSwitchUrl,
  profileSwitchStateSince,
  readProfileSwitchAck,
  readProfileSwitchAcks,
  readProfileSwitchAckTime,
  shouldSwitchProfileViaXdgOpen,
  switchProfileViaXdgOpen,
  waitForProfileSwitchAck,
  writeProfileSwitchAck,
} = require('./profile-switch-scheme');
const { extractLaunchUrls, relaunchArgs } = require('./launch-urls');

describe('x-freedom-profile scheme', () => {
  describe('parseProfileSwitchUrl', () => {
    test('accepts a canonical profile id and nothing else after the colon', () => {
      expect(parseProfileSwitchUrl('x-freedom-profile:work')).toBe('work');
      expect(parseProfileSwitchUrl('x-freedom-profile:default')).toBe('default');
      expect(parseProfileSwitchUrl('x-freedom-profile:my_work-2')).toBe('my_work-2');
      // The scheme is case-insensitive (RFC 3986); the id is not.
      expect(parseProfileSwitchUrl('X-Freedom-Profile:work')).toBe('work');
    });

    test('refuses anything that is not already a canonical id', () => {
      for (const value of [
        'x-freedom-profile:',
        'x-freedom-profile:Work', // sanitizeProfileId would lower-case it
        'x-freedom-profile:-work', // ...and strip the dash
        'x-freedom-profile:work-',
        'x-freedom-profile:..',
        'x-freedom-profile:.',
        'x-freedom-profile:a/b',
        'x-freedom-profile:..%2Fetc',
        'x-freedom-profile:%77ork', // no percent-decoding
        'x-freedom-profile://work',
        'x-freedom-profile:work/',
        'x-freedom-profile:work?x=1',
        'x-freedom-profile:work#x',
        'x-freedom-profile:work https://evil.example',
        'x-freedom-profile:work\n',
        'x-freedom-profile:wörk',
        'x-freedom-profile:https://evil.example',
        'https://evil.example/x-freedom-profile:work',
        'freedom://settings',
        '',
        null,
        undefined,
        42,
      ]) {
        expect([value, parseProfileSwitchUrl(value)]).toEqual([value, null]);
      }
    });
  });

  describe('parseProfileSwitchArgv', () => {
    test('finds the switch among the launch arguments on Linux', () => {
      expect(
        parseProfileSwitchArgv(['/opt/Freedom/freedom', 'x-freedom-profile:work'], {
          platform: 'linux',
        })
      ).toEqual({ id: 'work' });
    });

    test('is inert on macOS and Windows', () => {
      for (const platform of ['darwin', 'win32']) {
        expect(
          parseProfileSwitchArgv(['Freedom', 'x-freedom-profile:work'], { platform })
        ).toBeNull();
      }
    });

    test('an ordinary launch carries no switch', () => {
      expect(
        parseProfileSwitchArgv(['/opt/Freedom/freedom', '--profile=work', 'https://a.example'], {
          platform: 'linux',
        })
      ).toBeNull();
      // argv[0] is the executable, never a switch.
      expect(parseProfileSwitchArgv(['x-freedom-profile:work'], { platform: 'linux' })).toBeNull();
    });

    test('a malformed or repeated switch is a refused one, not an ordinary launch', () => {
      expect(
        parseProfileSwitchArgv(['freedom', 'x-freedom-profile:Work'], { platform: 'linux' })
      ).toEqual({ id: null });
      expect(
        parseProfileSwitchArgv(['freedom', 'x-freedom-profile:work', 'x-freedom-profile:home'], {
          platform: 'linux',
        })
      ).toEqual({ id: null });
    });

    test('the switch is never a link to open', () => {
      expect(extractLaunchUrls(['freedom', 'x-freedom-profile:work'])).toEqual([]);
      // A Settings restart keeps it: it still means the same profile.
      expect(relaunchArgs(['freedom', 'x-freedom-profile:work'])).toEqual([
        'x-freedom-profile:work',
      ]);
    });
  });

  test('buildProfileSwitchUrl writes only canonical ids', () => {
    expect(buildProfileSwitchUrl('work')).toBe('x-freedom-profile:work');
    expect(parseProfileSwitchUrl(buildProfileSwitchUrl('my_work-2'))).toBe('my_work-2');
    expect(() => buildProfileSwitchUrl('Work')).toThrow();
    expect(() => buildProfileSwitchUrl('../x')).toThrow();
    expect(() => buildProfileSwitchUrl('')).toThrow();
  });

  test('is registered as a Linux scheme handler only, for the installed desktop entry', () => {
    expect(pkg.build.linux.mimeTypes).toContain(PROFILE_SWITCH_MIME_TYPE);
    expect(PACKAGED_DESKTOP_NAME).toBe(pkg.desktopName);
    const protocols = [pkg.build.protocols, pkg.build.mac?.protocols, pkg.build.win?.protocols]
      .flat()
      .filter(Boolean);
    expect(JSON.stringify(protocols)).not.toContain('x-freedom-profile');
    expect(JSON.stringify(pkg.build.mac?.extendInfo || {})).not.toContain('x-freedom-profile');
  });

  describe('shouldSwitchProfileViaXdgOpen', () => {
    const waylandPackaged = (overrides = {}) => ({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland' },
      isPackaged: true,
      queryDefaultHandler: jest.fn(async () => 'freedom.desktop'),
      runsThisApp: jest.fn(() => true),
      ...overrides,
    });

    test('goes through xdg-open on a packaged Wayland build that handles the scheme', async () => {
      const deps = waylandPackaged();
      await expect(shouldSwitchProfileViaXdgOpen(deps)).resolves.toBe(true);
      expect(deps.queryDefaultHandler).toHaveBeenCalledWith('x-scheme-handler/x-freedom-profile');
      await expect(
        shouldSwitchProfileViaXdgOpen(waylandPackaged({ env: { XDG_SESSION_TYPE: ' Wayland ' } }))
      ).resolves.toBe(true);
    });

    test('never on macOS or Windows, and without asking xdg-mime', async () => {
      for (const platform of ['darwin', 'win32']) {
        const deps = waylandPackaged({ platform });
        await expect(shouldSwitchProfileViaXdgOpen(deps)).resolves.toBe(false);
        expect(deps.queryDefaultHandler).not.toHaveBeenCalled();
      }
    });

    test('not on X11 or an unknown session, where the running profile raises itself', async () => {
      for (const env of [{ XDG_SESSION_TYPE: 'x11' }, { XDG_SESSION_TYPE: '' }, {}]) {
        const deps = waylandPackaged({ env });
        await expect(shouldSwitchProfileViaXdgOpen(deps)).resolves.toBe(false);
        expect(deps.queryDefaultHandler).not.toHaveBeenCalled();
      }
    });

    test('not from a source-tree run, which has no desktop entry', async () => {
      const deps = waylandPackaged({ isPackaged: false });
      await expect(shouldSwitchProfileViaXdgOpen(deps)).resolves.toBe(false);
      expect(deps.queryDefaultHandler).not.toHaveBeenCalled();
    });

    test('not when the scheme is handled by something else, or by nothing', async () => {
      for (const handler of ['', 'freedom-dev.desktop', 'evil.desktop', 'freedom.desktop.bak']) {
        await expect(
          shouldSwitchProfileViaXdgOpen(
            waylandPackaged({ queryDefaultHandler: async () => handler })
          )
        ).resolves.toBe(false);
      }
      await expect(
        shouldSwitchProfileViaXdgOpen(
          waylandPackaged({
            queryDefaultHandler: async () => {
              throw new Error('xdg-mime: not found');
            },
          })
        )
      ).resolves.toBe(false);
    });

    test('not when freedom.desktop starts some other install (a .deb beside this AppImage)', async () => {
      await expect(
        shouldSwitchProfileViaXdgOpen(waylandPackaged({ runsThisApp: () => false }))
      ).resolves.toBe(false);
      await expect(
        shouldSwitchProfileViaXdgOpen(
          waylandPackaged({
            runsThisApp: () => {
              throw new Error('EACCES');
            },
          })
        )
      ).resolves.toBe(false);
    });
  });

  describe('desktopEntryRunsThisApp', () => {
    let root;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-desktop-'));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function install(dataDir, exec) {
      const dir = path.join(root, dataDir, 'applications');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'freedom.desktop'),
        `[Desktop Entry]\nName=Freedom\nExec=${exec}\n[Desktop Action new]\nExec=/somewhere/else\n`
      );
    }
    function binary(rel) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '#!/bin/sh\n');
      fs.chmodSync(file, 0o755);
      return file;
    }
    const env = (extra = {}) => ({
      XDG_DATA_HOME: path.join(root, 'home-share'),
      XDG_DATA_DIRS: `${path.join(root, 'usr-local-share')}:${path.join(root, 'usr-share')}`,
      PATH: path.join(root, 'bin'),
      ...extra,
    });

    test('true when the entry starts this executable (quoted, through a symlink, or on PATH)', () => {
      const exe = binary('opt/Freedom/freedom');
      install('usr-share', `"${exe}" %U`);
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(true);

      fs.mkdirSync(path.join(root, 'bin'));
      fs.symlinkSync(exe, path.join(root, 'bin', 'freedom'));
      install('usr-share', 'freedom %U');
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(true);
    });

    test('false when it starts another install of Freedom', () => {
      const deb = binary('opt/Freedom/freedom');
      const appImageMount = binary('mnt/.mount_Freedom/freedom');
      const appImage = binary('Downloads/Freedom.AppImage');
      install('usr-share', `"${deb}" %U`);
      expect(
        desktopEntryRunsThisApp({ env: env({ APPIMAGE: appImage }), execPath: appImageMount })
      ).toBe(false);
      expect(desktopEntryRunsThisApp({ env: env(), execPath: appImageMount })).toBe(false);
    });

    test('an AppImage matches its own integrated entry by the AppImage file, not its mount', () => {
      const appImageMount = binary('mnt/.mount_Freedom/freedom');
      const appImage = binary('Downloads/Freedom.AppImage');
      install('home-share', `${appImage} %U`);
      expect(
        desktopEntryRunsThisApp({ env: env({ APPIMAGE: appImage }), execPath: appImageMount })
      ).toBe(true);
    });

    test('the first entry in the XDG data dirs wins, as for xdg-open', () => {
      const exe = binary('opt/Freedom/freedom');
      const other = binary('opt/Other/freedom');
      install('home-share', `"${other}" %U`);
      install('usr-share', `"${exe}" %U`);
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(false);
    });

    test('false with no entry, or an Exec it cannot resolve', () => {
      const exe = binary('opt/Freedom/freedom');
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(false);
      install('usr-share', 'not-on-path %U');
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(false);
      install('usr-share', './freedom %U');
      expect(desktopEntryRunsThisApp({ env: env(), execPath: exe })).toBe(false);
    });

    test('reads Exec from [Desktop Entry] only, and unquotes it', () => {
      expect(
        parseDesktopEntryExec('[Desktop Action x]\nExec=/a\n[Desktop Entry]\nExec = "/b c" %U\n')
      ).toBe('"/b c" %U');
      expect(execProgram('"/b c" %U')).toBe('/b c');
      expect(execProgram('"/b\\"c" %U')).toBe('/b"c');
      expect(execProgram('"/unterminated')).toBe(null);
      expect(execProgram('/opt/x --flag')).toBe('/opt/x');
    });
  });

  describe('switch acknowledgement', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-switch-ack-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('waits for an ack written at or after the switch started', async () => {
      writeProfileSwitchAck(dir, { now: 1000 });
      // An old ack (an earlier switch) does not count.
      await expect(
        waitForProfileSwitchAck(dir, 2000, { timeoutMs: 50, pollIntervalMs: 10 })
      ).resolves.toBe(false);
      setTimeout(() => writeProfileSwitchAck(dir, { now: 2500 }), 20);
      await expect(
        waitForProfileSwitchAck(dir, 2000, { timeoutMs: 2000, pollIntervalMs: 10 })
      ).resolves.toBe(true);
      expect(readProfileSwitchAckTime(dir)).toBe(2500);
    });

    test('gives up at once on a switch the launch recorded as failed (R2-M1/M2)', async () => {
      writeProfileSwitchAck(dir, { state: 'received', now: 2100 });
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'failed', now: 2500 }), 20);
      const started = Date.now();
      await expect(
        waitForProfileSwitchAck(dir, 2000, { timeoutMs: 5000, pollIntervalMs: 10 })
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test('stops waiting early when the launch never even arrived', async () => {
      const started = Date.now();
      await expect(
        waitForProfileSwitchAck(dir, 0, {
          receiveTimeoutMs: 40,
          timeoutMs: 5000,
          pollIntervalMs: 10,
        })
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test('a launch that arrived gets the whole budget to finish', async () => {
      writeProfileSwitchAck(dir, { state: 'received', now: 2100 });
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'done', now: 2600 }), 120);
      await expect(
        waitForProfileSwitchAck(dir, 2000, {
          receiveTimeoutMs: 30,
          timeoutMs: 2000,
          pollIntervalMs: 10,
        })
      ).resolves.toBe(true);
      // ...but not past it.
      writeProfileSwitchAck(dir, { state: 'received', now: 3000 });
      await expect(
        waitForProfileSwitchAck(dir, 3000, {
          receiveTimeoutMs: 10,
          timeoutMs: 60,
          pollIntervalMs: 10,
        })
      ).resolves.toBe(false);
    });

    test('a received or failed record from an earlier switch does not count', async () => {
      writeProfileSwitchAck(dir, { state: 'failed', now: 1000 });
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'done', now: 2500 }), 20);
      await expect(
        waitForProfileSwitchAck(dir, 2000, { timeoutMs: 2000, pollIntervalMs: 10 })
      ).resolves.toBe(true);
    });

    test('reads an ack without a state as done, and skips unknown states', () => {
      const acks = path.join(dir, 'profile-switch-acks');
      fs.mkdirSync(acks);
      fs.writeFileSync(path.join(acks, '5-1-1-done.json'), JSON.stringify({ handledAtMs: 5 }));
      expect(readProfileSwitchAck(dir)).toEqual({ at: 5, state: 'done', pid: null });
      fs.writeFileSync(
        path.join(acks, '6-1-2-bogus.json'),
        JSON.stringify({ handledAtMs: 6, state: 'bogus' })
      );
      fs.writeFileSync(path.join(acks, '7-1-3-done.json'), 'not json');
      expect(readProfileSwitchAcks(dir)).toEqual([{ at: 5, state: 'done', pid: null }]);
      expect(() => writeProfileSwitchAck(dir, { state: 'bogus' })).toThrow();
    });

    test('overlapping switches to one profile do not overwrite each other (R3-M3)', async () => {
      // Switch A started at 2000, switch B at 2050. A's launch is done at 2100,
      // and B's launch says received at 2101, before A's waiter polls again.
      // With one shared file, B's record replaced A's `done` and A waited out
      // its whole budget.
      writeProfileSwitchAck(dir, { state: 'received', now: 2010 });
      writeProfileSwitchAck(dir, { state: 'done', now: 2100 });
      writeProfileSwitchAck(dir, { state: 'received', now: 2101 });
      expect(readProfileSwitchAcks(dir)).toEqual([
        { at: 2010, state: 'received', pid: process.pid },
        { at: 2100, state: 'done', pid: process.pid },
        { at: 2101, state: 'received', pid: process.pid },
      ]);
      const started = Date.now();
      await expect(
        waitForProfileSwitchAck(dir, 2000, { timeoutMs: 5000, pollIntervalMs: 10 })
      ).resolves.toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    test("an earlier overlapping launch's failure does not end a later switch's wait (R4-M1)", async () => {
      // Launch L1 said received at 2010; waiter W2 started at 2050 and its own
      // launch L2 said received at 2060; L1's file focus then failed at 2100.
      // W2 keeps waiting for L2, which raises the window at 2200.
      writeProfileSwitchAck(dir, { state: 'received', now: 2010 });
      writeProfileSwitchAck(dir, { state: 'received', now: 2060 });
      writeProfileSwitchAck(dir, { state: 'failed', now: 2100 });
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'done', now: 2200 }), 80);
      await expect(
        waitForProfileSwitchAck(dir, 2050, { timeoutMs: 3000, pollIntervalMs: 10 })
      ).resolves.toBe(true);
    });

    test("an earlier launch failing before this switch's own launch arrived does not end the wait (R4-M1)", async () => {
      // L1 said received at 2010 and fails at 2100, after W2 started (2050)
      // but before W2's own launch L2 got as far as received (2150).
      writeProfileSwitchAck(dir, { state: 'received', now: 2010 });
      writeProfileSwitchAck(dir, { state: 'failed', now: 2100 });
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'received', now: 2150 }), 40);
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'done', now: 2200 }), 80);
      await expect(
        waitForProfileSwitchAck(dir, 2050, { timeoutMs: 3000, pollIntervalMs: 10 })
      ).resolves.toBe(true);
    });

    test('profileSwitchStateSince: failed only once every received launch finished', () => {
      const acks = (...list) => list.map(([at, state]) => ({ at, state }));
      expect(profileSwitchStateSince([], 0)).toBeNull();
      expect(profileSwitchStateSince(acks([5, 'received']), 0)).toBe('received');
      // A failure before any launch said received since is not this switch's.
      expect(profileSwitchStateSince(acks([5, 'failed']), 0)).toBe('received');
      expect(profileSwitchStateSince(acks([5, 'received'], [6, 'failed']), 0)).toBe('failed');
      expect(
        profileSwitchStateSince(acks([5, 'received'], [6, 'received'], [7, 'failed']), 0)
      ).toBe('received');
      expect(
        profileSwitchStateSince(
          acks([5, 'received'], [6, 'received'], [7, 'failed'], [8, 'failed']),
          0
        )
      ).toBe('failed');
      expect(profileSwitchStateSince(acks([5, 'received'], [6, 'failed'], [7, 'done']), 0)).toBe(
        'done'
      );
      // Records before the switch started do not count.
      expect(profileSwitchStateSince(acks([1, 'failed'], [5, 'received']), 3)).toBe('received');
      // A launch that said received just before this switch started is still
      // in flight: an earlier launch's failure after it does not end the wait.
      expect(profileSwitchStateSince(acks([1, 'received'], [5, 'failed']), 3)).toBe('received');
      expect(
        profileSwitchStateSince(
          acks([1, 'received'], [4, 'received'], [5, 'failed'], [6, 'failed']),
          3
        )
      ).toBe('failed');
      expect(
        profileSwitchStateSince(acks([1, 'received'], [4, 'received'], [5, 'failed']), 3)
      ).toBe('received');
      expect(
        profileSwitchStateSince(
          acks([1, 'received'], [4, 'received'], [5, 'failed'], [6, 'failed']),
          3
        )
      ).toBe('failed');
      // ...but not one older than a whole switch budget that never finished.
      expect(profileSwitchStateSince(acks([1, 'received'], [4, 'received'], [6, 'failed']), 3, 1))
        // The launch at 1 is past any wait, so the failure is the one at 4's
        // (R6-M1).
        .toBe('failed');
      const byPid = (...list) => list.map(([at, state, pid]) => ({ at, state, pid }));
      expect(
        profileSwitchStateSince(
          byPid([1, 'received', 10], [4, 'received', 11], [6, 'failed', 11]),
          3,
          1
        )
      ).toBe('failed');
    });

    test('profileSwitchStateSince: a slow launch older than the budget keeps its own failure (R5-M1)', () => {
      const acks = (...list) => list.map(([at, state, pid]) => ({ at, state, pid }));
      // L0 (pid 10) said received 6.5 s before this switch started and fails
      // only after this switch's own launch (pid 11) said received.
      expect(
        profileSwitchStateSince(
          acks([3500, 'received', 10], [10100, 'received', 11], [10200, 'failed', 10]),
          10000
        )
      ).toBe('received');
      // This switch's own launch failing still ends the wait.
      expect(
        profileSwitchStateSince(
          acks(
            [3500, 'received', 10],
            [10100, 'received', 11],
            [10200, 'failed', 10],
            [10300, 'failed', 11]
          ),
          10000
        )
      ).toBe('failed');
      // Its failure landing first ends it too: L0 is past any wait, unfinished.
      expect(
        profileSwitchStateSince(
          acks([3500, 'received', 10], [10100, 'received', 11], [10200, 'failed', 11]),
          10000
        )
      ).toBe('failed');
      // The running profile's ack (a pid that never said received) closes the
      // oldest launch still in flight, so it never ends this switch's wait
      // early...
      expect(
        profileSwitchStateSince(
          acks([5000, 'received', 10], [10100, 'received', 11], [10200, 'failed', 99]),
          10000
        )
      ).toBe('received');
      // ...but a launch older than a whole budget is past any wait and is not
      // the oldest one in flight any more (R6-M1).
      expect(
        profileSwitchStateSince(
          acks([3500, 'received', 10], [10100, 'received', 11], [10200, 'failed', 99]),
          10000
        )
      ).toBe('failed');
      expect(
        profileSwitchStateSince(acks([10100, 'received', 11], [10200, 'failed', 99]), 10000)
      ).toBe('failed');
      expect(profileSwitchStateSince(acks([1, 'done']), 3)).toBeNull();
    });

    test("profileSwitchStateSince: a dead launch's received does not absorb the running profile's failed (R6-M1)", () => {
      const received = 'received';
      const failed = 'failed';
      // The reviewer's exact sequence: a crashed launch still inside the 60 s
      // sweep, this switch's own launch handed over, the holder's focusWindow
      // threw.
      const records = [
        { at: -20000, state: received, pid: 1 },
        { at: 10100, state: received, pid: 2 },
        { at: 10300, state: failed, pid: 99 },
      ];
      expect(profileSwitchStateSince(records, 10000)).toBe('failed');
      // Same as without the dead record.
      expect(profileSwitchStateSince(records.slice(1), 10000)).toBe('failed');
      // A live overlapping launch inside the budget still keeps the wait going.
      expect(
        profileSwitchStateSince(
          [
            { at: -20000, state: received, pid: 1 },
            { at: 9000, state: received, pid: 3 },
            { at: 10100, state: received, pid: 2 },
            { at: 10300, state: failed, pid: 99 },
          ],
          10000
        )
      ).toBe('received');
      // The dead launch's own late failure still closes only itself (R5-M1).
      expect(
        profileSwitchStateSince(
          [
            { at: -20000, state: received, pid: 1 },
            { at: 10100, state: received, pid: 2 },
            { at: 10200, state: failed, pid: 1 },
          ],
          10000
        )
      ).toBe('received');
    });

    test("profileSwitchStateSince: a historical holder outcome closes a launch live at its own time, not this switch's (R1-M1)", () => {
      const acks = (...list) => list.map(([at, state, pid]) => ({ at, state, pid }));
      // L1 and L2 handed over long before this switch; the holder answered L1
      // at 5500 (L2 was live then) and L2 slowly at 10300, after this switch's
      // own launch (pid 3) said received. That last failure is L2's, so this
      // switch keeps waiting for its own launch.
      const records = acks(
        [3000, 'received', 1],
        [5000, 'received', 2],
        [5500, 'done', 99],
        [10100, 'received', 3],
        [10300, 'failed', 99]
      );
      expect(profileSwitchStateSince(records, 10000)).toBe('received');
      // The holder then answering this switch's own launch ends it.
      expect(profileSwitchStateSince([...records, ...acks([10400, 'failed', 99])], 10000)).toBe(
        'failed'
      );
    });

    test("profileSwitchStateSince: a late holder answer to a launch still live for this switch does not close this switch's own (R2-M1)", () => {
      const acks = (...list) => list.map(([at, state, pid]) => ({ at, state, pid }));
      // L1 handed over 1.5 s before this switch (still inside its budget),
      // this switch's own launch (pid 2) handed over, and the holder answered
      // L1 late, more than one budget after L1's received. That failure is
      // L1's, so this switch keeps waiting for its own launch.
      const records = acks([8500, 'received', 1], [10100, 'received', 2], [15000, 'failed', 99]);
      expect(profileSwitchStateSince(records, 10000, 6000)).toBe('received');
      // The holder then answering this switch's own launch ends it.
      expect(
        profileSwitchStateSince([...records, ...acks([15100, 'failed', 99])], 10000, 6000)
      ).toBe('failed');
      // A launch already dead for this switch is still dropped (R6-M1).
      expect(
        profileSwitchStateSince(
          acks([3000, 'received', 1], [10100, 'received', 2], [15000, 'failed', 99]),
          10000,
          6000
        )
      ).toBe('failed');
    });

    test('waitForProfileSwitchAck fails fast past a dead launch record (R6-M1)', async () => {
      writeProfileSwitchAck(dir, { state: 'received', now: Date.now() - 20000 });
      const since = Date.now();
      setTimeout(() => writeProfileSwitchAck(dir, { state: 'received', now: Date.now() }), 20);
      setTimeout(() => {
        // The running profile's failed, from a pid that never said received.
        const file = path.join(dir, PROFILE_SWITCH_ACK_DIR, `holder-${Date.now()}.json`);
        fs.writeFileSync(
          file,
          JSON.stringify({ state: 'failed', handledAtMs: Date.now(), pid: 424242 })
        );
      }, 60);
      const started = Date.now();
      await expect(
        waitForProfileSwitchAck(dir, since, { timeoutMs: 3000, pollIntervalMs: 10 })
      ).resolves.toBe(false);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    test('several records written in the same millisecond all survive', () => {
      writeProfileSwitchAck(dir, { state: 'done', now: 4000 });
      writeProfileSwitchAck(dir, { state: 'received', now: 4000 });
      writeProfileSwitchAck(dir, { state: 'received', now: 4000 });
      expect(readProfileSwitchAcks(dir)).toHaveLength(3);
      // A done since the switch started wins over a later received.
      return expect(
        waitForProfileSwitchAck(dir, 4000, { timeoutMs: 50, pollIntervalMs: 10 })
      ).resolves.toBe(true);
    });

    test('a write sweeps records too old for any waiting switch', () => {
      const now = Date.now();
      writeProfileSwitchAck(dir, { state: 'done', now: now - 5 * 60 * 1000 });
      writeProfileSwitchAck(dir, { state: 'received', now: now - 1000 });
      writeProfileSwitchAck(dir, { state: 'done', now });
      expect(readProfileSwitchAcks(dir).map((ack) => ack.at)).toEqual([now - 1000, now]);
      expect(
        fs.readdirSync(path.join(dir, 'profile-switch-acks')).filter((n) => n.endsWith('.tmp'))
      ).toEqual([]);
    });

    test('times out with no ack at all', async () => {
      await expect(
        waitForProfileSwitchAck(dir, 0, { timeoutMs: 30, pollIntervalMs: 10 })
      ).resolves.toBe(false);
    });
  });

  describe('switchProfileViaXdgOpen', () => {
    const deps = (overrides = {}) => ({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland' },
      isPackaged: true,
      queryDefaultHandler: async () => 'freedom.desktop',
      runsThisApp: () => true,
      shell: { openExternal: jest.fn(async () => {}) },
      waitForAck: jest.fn(async () => true),
      now: () => 1234,
      ...overrides,
    });
    const work = { id: 'work', userDataDir: '/p/work' };

    test('opens x-freedom-profile:<id> through shell.openExternal and waits for the ack', async () => {
      const d = deps();
      await expect(switchProfileViaXdgOpen(work, d)).resolves.toBe(true);
      expect(d.shell.openExternal).toHaveBeenCalledWith('x-freedom-profile:work');
      expect(d.waitForAck).toHaveBeenCalledWith('/p/work', 1234, undefined);
    });

    test('a switch the running profile never confirms is a failure, not a success', async () => {
      // The profile was deleted or quit meanwhile, or the launch went to
      // another install: xdg-open still succeeds.
      const d = deps({ waitForAck: jest.fn(async () => false) });
      await expect(switchProfileViaXdgOpen(work, d)).resolves.toBe(false);
      expect(d.shell.openExternal).toHaveBeenCalledTimes(1);
    });

    test('with the real ack wait, an ack the running profile writes completes the switch', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-switch-ack-'));
      try {
        const d = deps({
          waitForAck: undefined,
          now: undefined,
          ackOptions: { timeoutMs: 2000, pollIntervalMs: 10 },
          shell: {
            openExternal: jest.fn(async () => {
              setTimeout(() => writeProfileSwitchAck(dir), 20);
            }),
          },
        });
        await expect(switchProfileViaXdgOpen({ id: 'work', userDataDir: dir }, d)).resolves.toBe(
          true
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('does nothing when the path does not apply', async () => {
      for (const d of [
        deps({ platform: 'darwin' }),
        deps({ platform: 'win32' }),
        deps({ env: { XDG_SESSION_TYPE: 'x11' } }),
        deps({ isPackaged: false }),
        deps({ queryDefaultHandler: async () => 'other.desktop' }),
      ]) {
        await expect(switchProfileViaXdgOpen(work, d)).resolves.toBe(false);
        expect(d.shell.openExternal).not.toHaveBeenCalled();
      }
    });

    test('never builds a URL from a non-canonical id', async () => {
      const d = deps({ queryDefaultHandler: jest.fn(async () => 'freedom.desktop') });
      await expect(switchProfileViaXdgOpen({ id: '../work', userDataDir: '/p' }, d)).resolves.toBe(
        false
      );
      await expect(
        switchProfileViaXdgOpen({ id: 'https://evil.example', userDataDir: '/p' }, d)
      ).resolves.toBe(false);
      expect(d.queryDefaultHandler).not.toHaveBeenCalled();
      expect(d.shell.openExternal).not.toHaveBeenCalled();
    });

    test('a second switch to the same profile while one is in flight shares it (R4-M1)', async () => {
      let release;
      const d = deps({
        waitForAck: jest.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            })
        ),
      });
      const first = switchProfileViaXdgOpen(work, d);
      const second = switchProfileViaXdgOpen(work, d);
      expect(second).toBe(first);
      await new Promise((resolve) => setImmediate(resolve));
      release(true);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(d.shell.openExternal).toHaveBeenCalledTimes(1);
      // Once it settled, the next switch launches again.
      const d2 = deps();
      await expect(switchProfileViaXdgOpen(work, d2)).resolves.toBe(true);
      expect(d2.shell.openExternal).toHaveBeenCalledTimes(1);
      // A switch to another profile is never held up by it.
      const d3 = deps({ waitForAck: jest.fn(() => new Promise(() => {})) });
      switchProfileViaXdgOpen({ id: 'home', userDataDir: '/p/home' }, d3);
      const d4 = deps();
      await expect(switchProfileViaXdgOpen(work, d4)).resolves.toBe(true);
      expect(d4.shell.openExternal).toHaveBeenCalledTimes(1);
    });

    test('reports failure when xdg-open refuses it, so the caller falls back', async () => {
      const d = deps({
        shell: { openExternal: jest.fn(async () => Promise.reject(new Error('no handler'))) },
      });
      await expect(switchProfileViaXdgOpen(work, d)).resolves.toBe(false);
    });
  });
});
