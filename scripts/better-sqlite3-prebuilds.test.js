/**
 * better-sqlite3 v13 ships prebuilt Node-API addons for every target we
 * package but still carries a `binding.gyp`, which is the *only* signal
 * @electron/rebuild uses to classify a module as native. Left in place it
 * routes better-sqlite3 down the node-gyp path, which cannot cross-compile
 * (mac → Windows release build) and needs Visual Studio Build Tools on
 * Windows even though it compiles nothing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MODULE_ROOT,
  SOURCE_BUILD_ENV,
  isSourceBuildRequested,
  pruneSourceBuildFallback,
  assertTargetPrebuild,
} = require('./better-sqlite3-prebuilds');

let tmpRoot;

function makeModule({ bindingGyp = true, prebuilds = ['linux-x64.node', 'win32-x64.node'] } = {}) {
  const moduleRoot = fs.mkdtempSync(path.join(tmpRoot, 'better-sqlite3-'));
  if (bindingGyp) fs.writeFileSync(path.join(moduleRoot, 'binding.gyp'), '{}');
  if (prebuilds) {
    fs.mkdirSync(path.join(moduleRoot, 'prebuilds'));
    for (const name of prebuilds) {
      fs.writeFileSync(path.join(moduleRoot, 'prebuilds', name), '');
    }
  }
  return moduleRoot;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bs3-prebuilds-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pruneSourceBuildFallback', () => {
  test('removes binding.gyp when prebuilt addons are present', () => {
    const moduleRoot = makeModule();

    const result = pruneSourceBuildFallback(moduleRoot);

    expect(result.removed).toBe(true);
    expect(fs.existsSync(path.join(moduleRoot, 'binding.gyp'))).toBe(false);
    // The prebuilds themselves — the thing that actually gets packaged — stay.
    expect(fs.readdirSync(path.join(moduleRoot, 'prebuilds')).sort()).toEqual([
      'linux-x64.node',
      'win32-x64.node',
    ]);
  });

  test('keeps binding.gyp when no prebuilt addon is available', () => {
    const moduleRoot = makeModule({ prebuilds: [] });

    const result = pruneSourceBuildFallback(moduleRoot);

    expect(result.removed).toBe(false);
    expect(fs.existsSync(path.join(moduleRoot, 'binding.gyp'))).toBe(true);
  });

  test('keeps binding.gyp when the package ships no prebuilds directory', () => {
    const moduleRoot = makeModule({ prebuilds: null });

    expect(pruneSourceBuildFallback(moduleRoot).removed).toBe(false);
    expect(fs.existsSync(path.join(moduleRoot, 'binding.gyp'))).toBe(true);
  });

  test('is idempotent and safe on a missing module', () => {
    const moduleRoot = makeModule();

    expect(pruneSourceBuildFallback(moduleRoot).removed).toBe(true);
    expect(pruneSourceBuildFallback(moduleRoot).removed).toBe(false);
    expect(pruneSourceBuildFallback(path.join(tmpRoot, 'not-installed')).removed).toBe(false);
  });
});

// The prune's guard is package-wide (postinstall runs before any target is
// known), so this is the per-target safety net: once binding.gyp is gone,
// @electron/rebuild ignores the module and a missing prebuild would otherwise
// package silently into an app that throws at startup.
describe('assertTargetPrebuild', () => {
  test('passes when the target platform/arch has a prebuild', () => {
    const moduleRoot = makeModule({ prebuilds: ['win32-x64.node', 'win32-arm64.node'] });

    const result = assertTargetPrebuild({ platform: 'win', archs: ['x64'], moduleRoot });

    expect(result).toEqual({ ok: true, missing: [], expected: ['win32-x64.node'] });
  });

  test('fails for a target the package has no prebuild for', () => {
    const moduleRoot = makeModule({ prebuilds: ['win32-x64.node'] });

    const result = assertTargetPrebuild({ platform: 'win', archs: ['arm64'], moduleRoot });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['win32-arm64.node']);
  });

  test('reports every missing arch of a multi-arch target', () => {
    const moduleRoot = makeModule({ prebuilds: ['linux-x64.node'] });

    // `npm run dist -- --linux` defaults to both arches.
    const result = assertTargetPrebuild({ platform: 'linux', archs: ['arm64', 'x64'], moduleRoot });

    expect(result.missing).toEqual(['linux-arm64.node']);
  });

  test('maps electron-builder platform flags to prebuild names', () => {
    const moduleRoot = makeModule({ prebuilds: ['darwin-arm64.node'] });

    expect(assertTargetPrebuild({ platform: 'mac', archs: ['arm64'], moduleRoot }).ok).toBe(true);
  });

  test('is a no-op when better-sqlite3 is not installed', () => {
    const result = assertTargetPrebuild({
      platform: 'win',
      archs: ['arm64'],
      moduleRoot: path.join(tmpRoot, 'not-installed'),
    });

    expect(result.ok).toBe(true);
  });

  test('accepts every target scripts/build.js can be asked to package', () => {
    for (const [platform, archs] of [
      ['mac', ['arm64', 'x64']],
      ['linux', ['arm64', 'x64']],
      ['win', ['arm64', 'x64']],
    ]) {
      expect(assertTargetPrebuild({ platform, archs })).toMatchObject({ ok: true, missing: [] });
    }
  });
});

// The escape hatch for a target upstream ships no prebuild for: keep the
// package's source-build path intact (binding.gyp) and let @electron/rebuild
// run node-gyp, instead of failing the build at the per-target guard.
describe(`${SOURCE_BUILD_ENV} override`, () => {
  let savedEnv;

  beforeEach(() => {
    // Jest reuses one process per worker: restore whatever was there.
    savedEnv = process.env[SOURCE_BUILD_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[SOURCE_BUILD_ENV];
    else process.env[SOURCE_BUILD_ENV] = savedEnv;
  });

  test('recognises set values and ignores unset/empty/falsey ones', () => {
    expect(isSourceBuildRequested({})).toBe(false);
    expect(isSourceBuildRequested({ [SOURCE_BUILD_ENV]: '' })).toBe(false);
    expect(isSourceBuildRequested({ [SOURCE_BUILD_ENV]: '0' })).toBe(false);
    expect(isSourceBuildRequested({ [SOURCE_BUILD_ENV]: 'false' })).toBe(false);
    expect(isSourceBuildRequested({ [SOURCE_BUILD_ENV]: '1' })).toBe(true);
  });

  test('skips the prune, leaving binding.gyp for a source build', () => {
    const moduleRoot = makeModule();

    const result = pruneSourceBuildFallback(moduleRoot, { env: { [SOURCE_BUILD_ENV]: '1' } });

    expect(result).toEqual({
      removed: false,
      reason: `${SOURCE_BUILD_ENV} is set; keeping binding.gyp for a source build`,
      overridden: true,
    });
    expect(fs.existsSync(path.join(moduleRoot, 'binding.gyp'))).toBe(true);
  });

  test('skips the prune when read from the real process env (postinstall path)', () => {
    const moduleRoot = makeModule();
    process.env[SOURCE_BUILD_ENV] = '1';

    expect(pruneSourceBuildFallback(moduleRoot).overridden).toBe(true);
    expect(fs.existsSync(path.join(moduleRoot, 'binding.gyp'))).toBe(true);
  });

  test('skips the per-target guard for a target with no prebuild', () => {
    const moduleRoot = makeModule({ prebuilds: ['win32-x64.node'] });

    // Without the override this target fails the guard (see above).
    expect(assertTargetPrebuild({ platform: 'win', archs: ['arm64'], moduleRoot }).ok).toBe(false);

    const result = assertTargetPrebuild({
      platform: 'win',
      archs: ['arm64'],
      moduleRoot,
      env: { [SOURCE_BUILD_ENV]: '1' },
    });

    expect(result).toEqual({
      ok: true,
      missing: [],
      expected: ['win32-arm64.node'],
      overridden: true,
    });
  });

  test('skips the per-target guard when read from the real process env (build.js path)', () => {
    const moduleRoot = makeModule({ prebuilds: [] });
    process.env[SOURCE_BUILD_ENV] = '1';

    expect(assertTargetPrebuild({ platform: 'linux', archs: ['x64'], moduleRoot })).toMatchObject({
      ok: true,
      missing: [],
      overridden: true,
    });
  });

  test('is wired into scripts/build.js: no exit(1) and no prune when set', () => {
    const buildScript = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
    // The guard's failure branch must be reachable only when the override is off.
    expect(buildScript).toContain(
      'const { missing, overridden: sourceBuild } = assertTargetPrebuild({ platform, archs });'
    );
    expect(buildScript).toContain('if (sourceBuild) {');
    expect(buildScript).toContain('} else if (missing.length > 0) {');
    // ...and the error message must point at the override, not the `npm rebuild` dead end.
    expect(buildScript).toContain('does NOT restore the pruned binding.gyp');
    expect(buildScript).toContain('${SOURCE_BUILD_ENV}=1 npm ci');
    expect(buildScript).toContain('${SOURCE_BUILD_ENV}=1 npm run build --');
  });
});

describe('the installed better-sqlite3', () => {
  test('carries a prebuilt addon for every platform/arch we package', () => {
    const prebuildsDir = path.join(MODULE_ROOT, 'prebuilds');
    const present = new Set(fs.readdirSync(prebuildsDir));
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        expect(present).toContain(`${platform}-${arch}.node`);
      }
    }
  });

  // `npm install` restores binding.gyp every time, so the prune has to be wired
  // into both entry points that precede an @electron/rebuild pass. (The file's
  // presence in node_modules is not asserted directly: CI's lint/test jobs
  // install with `npm ci --ignore-scripts`, which never runs `postinstall`.)
  test('is pruned by postinstall before install-app-deps runs', () => {
    const { postinstall } = require('../package.json').scripts;
    expect(postinstall.indexOf('better-sqlite3-prebuilds')).toBeGreaterThanOrEqual(0);
    expect(postinstall.indexOf('better-sqlite3-prebuilds')).toBeLessThan(
      postinstall.indexOf('install-app-deps')
    );
  });

  test('is pruned by scripts/build.js before electron-builder runs', () => {
    const buildScript = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
    expect(buildScript).toContain('pruneSourceBuildFallback()');
    expect(buildScript.indexOf('pruneSourceBuildFallback()')).toBeLessThan(
      buildScript.indexOf('execSync(cmd')
    );
  });

  test('has its target prebuild verified by scripts/build.js before packaging', () => {
    const buildScript = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
    expect(buildScript).toContain('assertTargetPrebuild({ platform, archs })');
    expect(buildScript.indexOf('assertTargetPrebuild({ platform, archs })')).toBeLessThan(
      buildScript.indexOf('execSync(cmd')
    );
  });
});
