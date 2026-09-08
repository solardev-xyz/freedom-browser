/**
 * Guards the workaround for the Colibri 2.0.5+ native-addon crash.
 *
 * Colibri >= 2.0.5 prefers a native N-API addon over the WASM build whenever
 * the `node` export condition matches — which it does in Electron's main
 * process — and that addon segfaults the process while verifying an
 * `eth_call` proof, i.e. on every ENS content-hash lookup. `colibri-runtime`
 * forces upstream's `C4_DISABLE_NATIVE` opt-out, so the app keeps running the
 * same WASM verifier 2.0.4 shipped.
 *
 * These tests fail if that opt-out is removed, if a `require` reaches the
 * package before it is set, or if a future bump renames/drops the upstream
 * escape hatch it depends on.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PKG_DIR = path.dirname(require.resolve('@corpus-core/colibri-stateless/package.json'));
const PREBUILD = path.join(
  PKG_DIR,
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'colibri_native.node'
);

describe('colibri-runtime disables the native addon before the package loads', () => {
  const savedDisableNative = process.env.C4_DISABLE_NATIVE;

  afterEach(() => {
    // Jest reuses one process per worker: restore rather than delete, so a
    // later suite in this worker sees the value it started with.
    if (savedDisableNative === undefined) delete process.env.C4_DISABLE_NATIVE;
    else process.env.C4_DISABLE_NATIVE = savedDisableNative;
    jest.resetModules();
    jest.dontMock('@corpus-core/colibri-stateless');
  });

  // Records what the flag looked like at the moment the package was evaluated,
  // which is the only moment that matters: upstream reads it when the runtime
  // is first initialized, and the module graph is loaded long before that.
  function loadWithEnvProbe() {
    const seen = { value: 'never-loaded' };
    jest.resetModules();
    jest.doMock('@corpus-core/colibri-stateless', () => {
      seen.value = process.env.C4_DISABLE_NATIVE;
      return { __esModule: true, default: class {}, Strategy: {} };
    });
    require('./colibri-runtime');
    return seen.value;
  }

  test('sets C4_DISABLE_NATIVE=1 before requiring the package', () => {
    delete process.env.C4_DISABLE_NATIVE;
    expect(loadWithEnvProbe()).toBe('1');
    expect(process.env.C4_DISABLE_NATIVE).toBe('1');
  });

  test('overrides an inherited C4_DISABLE_NATIVE=0 rather than honoring it', () => {
    process.env.C4_DISABLE_NATIVE = '0';
    expect(loadWithEnvProbe()).toBe('1');
  });

  test('colibri-resolver reaches the package only through colibri-runtime', () => {
    const source = fs.readFileSync(path.join(__dirname, 'colibri-resolver.js'), 'utf8');
    expect(source).toContain("require('./colibri-runtime')");
    expect(source).not.toContain("require('@corpus-core/colibri-stateless')");
  });

  test('the installed package still honors the C4_DISABLE_NATIVE opt-out', () => {
    // Drift guard: if a bump renames or drops the escape hatch, the workaround
    // above becomes a no-op and the crash comes back silently.
    const runtimeNode = fs.readFileSync(path.join(PKG_DIR, 'cjs', 'runtime_node.js'), 'utf8');
    expect(runtimeNode).toContain('C4_DISABLE_NATIVE');
  });
});

describe('colibri runtime selection in a real process', () => {
  // Runs under the Electron binary when it is installed, because Electron is
  // the host the addon crashes on; falls back to plain node otherwise.
  function probeExecutable() {
    const electron = path.join(
      __dirname, '..', '..', '..', 'node_modules', 'electron', 'dist', 'electron'
    );
    return fs.existsSync(electron)
      ? { exe: electron, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, label: 'electron' }
      : { exe: process.execPath, env: { ...process.env }, label: 'node' };
  }

  test('loads the WASM runtime and never dlopens the native addon', () => {
    if (!fs.existsSync(PREBUILD)) {
      // Without a prebuild for this platform upstream falls back to WASM on its
      // own, so the assertion below would pass vacuously. Report the skip.
      console.warn(
        `[colibri-runtime.test] skipped: no native prebuild at ${PREBUILD}; ` +
        'the runtime-selection assertion cannot fail on this platform.'
      );
      return;
    }
    const { exe, env, label } = probeExecutable();
    const probe = path.join(os.tmpdir(), `colibri-runtime-probe-${process.pid}.js`);
    fs.writeFileSync(probe, `
      const path = require('node:path');
      const dlopened = [];
      const dlopen = process.dlopen.bind(process);
      process.dlopen = (mod, filename, flags) => {
        dlopened.push(String(filename));
        return dlopen(mod, filename, flags);
      };
      const { Colibri } = require(${JSON.stringify(path.join(__dirname, 'colibri-runtime.js'))});
      // Package dir is injected: this probe file lives outside the repo, so it
      // cannot resolve the dependency by name itself.
      const pkgDir = ${JSON.stringify(PKG_DIR)};
      const { getRuntime } = require(path.join(pkgDir, 'cjs', 'runtime.js'));
      Colibri.register_storage({ get: () => null, set: () => {}, del: () => {} })
        .then(() => getRuntime())
        .then((runtime) => {
          console.log(JSON.stringify({
            kind: runtime.kind,
            native: dlopened.filter((f) => f.includes('colibri_native')),
          }));
          process.exit(0);
        })
        .catch((err) => {
          console.log(JSON.stringify({ error: String((err && err.message) || err) }));
          process.exit(1);
        });
    `);
    try {
      const stdout = execFileSync(exe, [probe], { env, encoding: 'utf8', timeout: 60_000 });
      const result = JSON.parse(stdout.trim().split('\n').pop());
      expect(result.error).toBeUndefined();
      // 'native' here is upstream's own name for the addon-backed runtime.
      expect(result.kind).toBe('wasm');
      expect(result.native).toEqual([]);
      console.log(`[colibri-runtime.test] probe host=${label} runtime=${result.kind}`);
    } finally {
      try { fs.unlinkSync(probe); } catch { /* best-effort cleanup */ }
    }
  }, 120_000);
});
