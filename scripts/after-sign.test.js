/**
 * scripts/after-sign.js (#757): electron-builder's own notarize pass is off,
 * and this hook notarizes Freedom.app the same way @electron/notarize does,
 * then staples through scripts/staple-with-retry.sh before the .dmg/.zip are
 * built from the app.
 */

const path = require('path');
const pkg = require('../package.json');
const afterSign = require('./after-sign').default;
const { skipNotarize, loadNotarizer, STAPLE_SCRIPT } = require('./after-sign');

function context(platform = 'darwin') {
  return {
    electronPlatformName: platform,
    appOutDir: '/build/mac-arm64',
    packager: { appInfo: { productFilename: 'Freedom' } },
  };
}

const APP = '/build/mac-arm64/Freedom.app';

function fakes({
  options = { tool: 'notarytool', appPath: APP, appleId: 'a' },
  notaryTool = true,
} = {}) {
  const calls = [];
  const notarizer = {
    getNotarizeOptions: jest.fn((appPath) => {
      calls.push(['options', appPath]);
      return options;
    }),
    checkSignatures: jest.fn(async (opts) => calls.push(['checkSignatures', opts.appPath])),
    isNotaryToolAvailable: jest.fn(async () => notaryTool),
    notarizeAndWaitForNotaryTool: jest.fn(async (opts) => calls.push(['notarize', opts])),
  };
  const staple = jest.fn((appPath) => calls.push(['staple', appPath]));
  return { calls, notarizer, staple, deps: { notarizer, staple, env: {}, log: () => {} } };
}

describe('package.json wiring', () => {
  test('electron-builder does not notarize (and so never staples) by itself', () => {
    expect(pkg.build.mac.notarize).toBe(false);
  });

  test('the afterSign hook is this script', () => {
    expect(path.resolve(__dirname, '..', pkg.build.afterSign)).toBe(
      path.join(__dirname, 'after-sign.js')
    );
  });
});

describe('afterSign', () => {
  test('notarizes, then staples, in that order, with the builder options untouched', async () => {
    const f = fakes();
    await afterSign(context(), f.deps);
    expect(f.calls).toEqual([
      ['options', APP],
      ['checkSignatures', APP],
      ['notarize', { tool: 'notarytool', appPath: APP, appleId: 'a' }],
      ['staple', APP],
    ]);
  });

  test('a notarization failure fails the build and staples nothing', async () => {
    const f = fakes();
    f.notarizer.notarizeAndWaitForNotaryTool.mockRejectedValue(new Error('Invalid'));
    await expect(afterSign(context(), f.deps)).rejects.toThrow('Invalid');
    expect(f.staple).not.toHaveBeenCalled();
  });

  test('a staple that still fails after its retries fails the build', async () => {
    const f = fakes();
    f.staple.mockImplementation(() => {
      throw new Error('Command failed: bash staple-with-retry.sh');
    });
    await expect(afterSign(context(), f.deps)).rejects.toThrow('staple-with-retry');
  });

  test('missing notarytool fails like @electron/notarize does', async () => {
    const f = fakes({ notaryTool: false });
    await expect(afterSign(context(), f.deps)).rejects.toThrow(/notarytool is not available/);
    expect(f.notarizer.notarizeAndWaitForNotaryTool).not.toHaveBeenCalled();
  });

  test('no credentials: skipped, like electron-builder skipped it', async () => {
    const f = fakes({ options: null });
    await afterSign(context(), f.deps);
    expect(f.notarizer.notarizeAndWaitForNotaryTool).not.toHaveBeenCalled();
    expect(f.staple).not.toHaveBeenCalled();
  });

  test('FREEDOM_SKIP_NOTARIZE skips notarizing and stapling', async () => {
    const f = fakes();
    await afterSign(context(), { ...f.deps, env: { FREEDOM_SKIP_NOTARIZE: '1' } });
    expect(f.calls).toEqual([]);
  });

  test('non-mac builds are left alone', async () => {
    const f = fakes();
    await afterSign(context('win32'), f.deps);
    expect(f.calls).toEqual([]);
  });
});

describe('skipNotarize', () => {
  test.each(['1', 'true', ' TRUE ', 'yes', 'on'])('%j skips', (value) => {
    expect(skipNotarize({ FREEDOM_SKIP_NOTARIZE: value })).toBe(true);
  });

  test.each([undefined, '', '0', 'false', 'off', 'no'])('%j does not skip', (value) => {
    expect(skipNotarize({ FREEDOM_SKIP_NOTARIZE: value })).toBe(false);
  });
});

// The hook reaches into app-builder-lib and @electron/notarize past their
// main entry points. A dependency bump that moves or renames any of these
// must fail here, not in the middle of a signed release build.
describe('the installed notarizer', () => {
  test('exposes every function the hook calls', () => {
    const n = loadNotarizer();
    for (const fn of [
      'getNotarizeOptions',
      'checkSignatures',
      'isNotaryToolAvailable',
      'notarizeAndWaitForNotaryTool',
    ]) {
      expect(typeof n[fn]).toBe('function');
    }
  });

  test('builds the same notarytool options electron-builder would', () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('APPLE_')) delete process.env[key];
      }
      const n = loadNotarizer();
      expect(n.getNotarizeOptions(APP)).toBeUndefined();
      Object.assign(process.env, {
        APPLE_ID: 'dev@example.com',
        APPLE_APP_SPECIFIC_PASSWORD: 'pw',
        APPLE_TEAM_ID: 'TEAM',
      });
      expect(n.getNotarizeOptions(APP)).toEqual({
        tool: 'notarytool',
        appPath: APP,
        appleId: 'dev@example.com',
        appleIdPassword: 'pw',
        teamId: 'TEAM',
      });
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('APPLE_')) delete process.env[key];
      }
      for (const [key, value] of Object.entries(saved)) {
        if (key.startsWith('APPLE_')) process.env[key] = value;
      }
    }
  });

  // @electron/notarize's own notarize() is these same steps plus a staple
  // with three short retries. If upstream changes what notarize() does, the
  // hook needs a second look.
  test('@electron/notarize notarize() is still check + submit + staple', () => {
    const source = require('fs').readFileSync(require.resolve('@electron/notarize'), 'utf8');
    expect(source).toContain('checkSignatures');
    expect(source).toContain('notarizeAndWaitForNotaryTool');
    expect(source).toContain('stapleApp');
  });

  test('stapling goes through the retry script', () => {
    expect(STAPLE_SCRIPT).toBe(path.join(__dirname, 'staple-with-retry.sh'));
  });
});
