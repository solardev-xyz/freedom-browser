const fs = require('fs');
const os = require('os');
const path = require('path');
const lockfile = require('proper-lockfile');
const {
  DEFAULT_STALE_MS,
  DEFAULT_UPDATE_MS,
  DEV_STALE_MS,
  DEV_UPDATE_MS,
  PROFILE_LOCK_START_WAIT_MS,
  acquireProfileLock,
  getProfileLockTiming,
  getProfileLockPaths,
  isProfileLocked,
  isLockUnavailableError,
  releaseProfileLock,
  startLockWaitMs,
} = require('./profile-lock');

function makeTempProfile(id = 'default') {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-profile-lock-'));
  return {
    id,
    displayName: id === 'default' ? 'Default' : id,
    userDataDir,
  };
}

describe('profile lock', () => {
  let tempDirs = [];
  let locks = [];

  afterEach(() => {
    locks.forEach((lock) => releaseProfileLock(lock));
    locks = [];
    tempDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    tempDirs = [];
  });

  function trackProfile(profile) {
    tempDirs.push(profile.userDataDir);
    return profile;
  }

  function trackLock(lock) {
    locks.push(lock);
    return lock;
  }

  test('prevents two processes from opening the same profile directory', () => {
    const profile = trackProfile(makeTempProfile());
    const firstLock = trackLock(acquireProfileLock(profile));
    const paths = getProfileLockPaths(profile);

    expect(fs.existsSync(paths.lockDir)).toBe(true);
    expect(() => acquireProfileLock(profile)).toThrow(expect.objectContaining({
      code: 'ELOCKED',
    }));

    releaseProfileLock(firstLock);
    expect(fs.existsSync(paths.lockDir)).toBe(false);

    const secondLock = trackLock(acquireProfileLock(profile));
    expect(fs.existsSync(secondLock.lockDir)).toBe(true);
  });

  test('checks whether a profile directory is locked', () => {
    const profile = trackProfile(makeTempProfile());
    expect(isProfileLocked(profile)).toBe(false);

    const lock = trackLock(acquireProfileLock(profile));
    expect(isProfileLocked(profile)).toBe(true);

    releaseProfileLock(lock);
    expect(isProfileLocked(profile)).toBe(false);
  });

  test('allows different profile directories to be open at the same time', () => {
    const defaultProfile = trackProfile(makeTempProfile('default'));
    const workProfile = trackProfile(makeTempProfile('work'));

    const defaultLock = trackLock(acquireProfileLock(defaultProfile));
    const workLock = trackLock(acquireProfileLock(workProfile));

    expect(defaultLock.lockDir).not.toBe(workLock.lockDir);
    expect(fs.existsSync(defaultLock.lockDir)).toBe(true);
    expect(fs.existsSync(workLock.lockDir)).toBe(true);
  });

  test('recovers stale locks left behind by an unclean exit', () => {
    const profile = trackProfile(makeTempProfile());
    const paths = getProfileLockPaths(profile);
    fs.mkdirSync(profile.userDataDir, { recursive: true });
    fs.writeFileSync(paths.targetPath, 'stale target');
    fs.mkdirSync(paths.lockDir);
    const oldTime = new Date(Date.now() - 10000);
    fs.utimesSync(paths.lockDir, oldTime, oldTime);

    const lock = trackLock(acquireProfileLock(profile, {
      staleMs: 2000,
      updateMs: 1000,
    }));

    expect(lock.lockDir).toBe(paths.lockDir);
    expect(fs.existsSync(paths.lockDir)).toBe(true);
  });

  test('uses shorter stale-lock timing for dev profiles', () => {
    expect(getProfileLockTiming({ isDev: true })).toEqual({
      staleMs: DEV_STALE_MS,
      updateMs: DEV_UPDATE_MS,
    });
    expect(getProfileLockTiming({ isDev: false })).toEqual({
      staleMs: DEFAULT_STALE_MS,
      updateMs: DEFAULT_UPDATE_MS,
    });
  });

  test('allows explicit lock timing overrides', () => {
    expect(getProfileLockTiming({ isDev: true }, {
      staleMs: 12000,
      updateMs: 3000,
    })).toEqual({
      staleMs: 12000,
      updateMs: 3000,
    });
  });

  test('identifies lock-unavailable errors', () => {
    expect(isLockUnavailableError({ code: 'ELOCKED' })).toBe(true);
    expect(isLockUnavailableError({ code: 'ENOENT' })).toBe(false);
    expect(isLockUnavailableError(null)).toBe(false);
  });

  describe("a start's wait for its lock", () => {
    // A clock that moves only when the lock's retry sleeps.
    function fakeClock() {
      let now = 1_000_000;
      const sleeps = [];
      return {
        sleeps,
        now: () => now,
        sleepSync: (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      };
    }

    test('without a wait, a held lock is refused at once', () => {
      const profile = trackProfile(makeTempProfile());
      trackLock(acquireProfileLock(profile));
      const clock = fakeClock();
      expect(() => acquireProfileLock(profile, clock)).toThrow(
        expect.objectContaining({ code: 'ELOCKED' })
      );
      expect(clock.sleeps).toEqual([]);
    });

    test('a holder that lets go within the wait: the lock is taken, tried every 25 ms', () => {
      const profile = trackProfile(makeTempProfile());
      const holder = acquireProfileLock(profile);
      const clock = fakeClock();
      const sleepSync = (ms) => {
        clock.sleepSync(ms);
        if (clock.sleeps.length === 3) releaseProfileLock(holder);
      };
      const lock = trackLock(
        acquireProfileLock(profile, { now: clock.now, sleepSync, waitMs: 2000 })
      );
      expect(lock.released).toBe(false);
      expect(isProfileLocked(profile)).toBe(true);
      expect(clock.sleeps).toEqual([25, 25, 25]);
    });

    test('a holder that keeps the lock past the wait: refused once the wait is over', () => {
      const profile = trackProfile(makeTempProfile());
      trackLock(acquireProfileLock(profile));
      const clock = fakeClock();
      expect(() => acquireProfileLock(profile, { ...clock, waitMs: 100 })).toThrow(
        expect.objectContaining({ code: 'ELOCKED' })
      );
      expect(clock.sleeps).toEqual([25, 25, 25, 25]);
    });

    test('any other failure is thrown at once, without waiting', () => {
      const profile = trackProfile(makeTempProfile());
      const clock = fakeClock();
      const spy = jest.spyOn(lockfile, 'lockSync').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
      try {
        expect(() => acquireProfileLock(profile, { ...clock, waitMs: 2000 })).toThrow(
          expect.objectContaining({ code: 'EACCES' })
        );
      } finally {
        spy.mockRestore();
      }
      expect(clock.sleeps).toEqual([]);
    });

    test("the wait: none when profile open's report says the lock was fresh, the full wait when not", () => {
      const isLocked = jest.fn();
      expect(startLockWaitMs({ lockFresh: true }, {}, { isLocked })).toBe(0);
      expect(startLockWaitMs({ lockFresh: false }, {}, { isLocked })).toBe(
        PROFILE_LOCK_START_WAIT_MS
      );
      expect(isLocked).not.toHaveBeenCalled();
      expect(PROFILE_LOCK_START_WAIT_MS).toBe(2000);
    });

    test("where profile open didn't run, the lock is read: fresh or unreadable, no wait", () => {
      const profile = { userDataDir: '/nowhere' };
      expect(startLockWaitMs({ lockFresh: null }, profile, { isLocked: () => true })).toBe(0);
      expect(startLockWaitMs({}, profile, { isLocked: () => false })).toBe(
        PROFILE_LOCK_START_WAIT_MS
      );
      expect(
        startLockWaitMs(null, profile, {
          isLocked: () => {
            throw new Error('unreadable');
          },
        })
      ).toBe(0);
    });

    test('where profile open did not run, a real profile is read: idle, then held', () => {
      const profile = trackProfile(makeTempProfile());
      expect(startLockWaitMs({ lockFresh: null }, profile)).toBe(PROFILE_LOCK_START_WAIT_MS);
      trackLock(acquireProfileLock(profile));
      expect(startLockWaitMs({ lockFresh: null }, profile)).toBe(0);
    });
  });
});
