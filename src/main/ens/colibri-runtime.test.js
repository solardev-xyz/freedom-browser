/**
 * Guards the workaround for the Colibri 2.0.5+ native-addon crash.
 *
 * Colibri >= 2.0.5 prefers a native N-API addon over the WASM build whenever
 * the `node` export condition matches — which it does in Electron's main
 * process — and that addon segfaults the process while verifying an
 * `eth_call` proof, i.e. on every ENS content-hash lookup. `colibri-runtime`
 * forces upstream's `C4_DISABLE_NATIVE` opt-out, so the app keeps running the
 * WASM verifier — the implementation 2.0.4 shipped exclusively, though not its
 * bytes: `c4w.wasm` itself changed across the bump (see `colibri-runtime.js`).
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
    expect(require('./colibri-runtime').clientVersion).toBe(196610);
  });

  test('refuses to encode a client version outside the upstream three-byte shape', () => {
    // 196610 above is the installed 3.0.2 build's own
    // `_c4w_get_current_version_number()`; the encoding only reproduces it for
    // `<major>.<minor>.<patch>` with every part <= 255. Any other shape must
    // fail closed (the checkpoint worker rejects a non-integer clientVersion)
    // rather than produce a wrong but plausible integer the prover routes on.
    for (const version of ['3.0.0-rc.1', '3.1', '3.0.0.1', '3.256.0', '3.0.300', 'next']) {
      jest.resetModules();
      jest.doMock('@corpus-core/colibri-stateless', () => ({
        __esModule: true,
        default: class {},
        Strategy: {},
        decode_proof: () => {},
      }));
      jest.doMock('@corpus-core/colibri-stateless/package.json', () => ({ version }));
      expect(require('./colibri-runtime').clientVersion).toBeNull();
      jest.dontMock('@corpus-core/colibri-stateless/package.json');
    }
    // Control: the accepted shape still encodes, so the assertion above is not
    // passing because every load now returns null.
    jest.resetModules();
    jest.doMock('@corpus-core/colibri-stateless/package.json', () => ({ version: '2.0.6' }));
    expect(require('./colibri-runtime').clientVersion).toBe(131078);
    jest.dontMock('@corpus-core/colibri-stateless/package.json');
  });

  test('overrides an inherited C4_DISABLE_NATIVE=0 rather than honoring it', () => {
    process.env.C4_DISABLE_NATIVE = '0';
    expect(loadWithEnvProbe()).toBe('1');
  });

  test('enforces explicit WASM bounds checks before the package loads (#453)', () => {
    // Electron's main process does not route V8's guard-page SIGSEGV back to
    // the WASM trap handler, so an out-of-bounds access in c4w.wasm kills the
    // browser unless explicit checks are compiled in. The flag is read at
    // compile time, so it has to be set before anything can load the module.
    const flags = [];
    const seen = { flags: 'never-loaded' };
    jest.resetModules();
    jest.doMock('node:v8', () => ({ setFlagsFromString: (flag) => flags.push(flag) }));
    jest.doMock('@corpus-core/colibri-stateless', () => {
      seen.flags = [...flags];
      return { __esModule: true, default: class {}, Strategy: {} };
    });
    try {
      require('./colibri-runtime');
      expect(seen.flags).toEqual(['--wasm-enforce-bounds-checks']);
    } finally {
      jest.dontMock('node:v8');
    }
  });

  test('the Colibri worker reaches the package only through colibri-runtime', () => {
    // Since #495 the router/ENS client lives in colibri-worker.js (a worker
    // thread); colibri-resolver only talks to it and must not load either.
    const worker = fs.readFileSync(path.join(__dirname, 'colibri-worker.js'), 'utf8');
    expect(worker).toContain("require('./colibri-runtime')");
    expect(worker).not.toContain("require('@corpus-core/colibri-stateless')");
    const resolver = fs.readFileSync(path.join(__dirname, 'colibri-resolver.js'), 'utf8');
    expect(resolver).not.toMatch(/require\(['"](?:\.\/colibri-runtime|@corpus-core\/colibri-stateless)['"]\)/);
  });

  test('no shipped module reaches the package except colibri-runtime', () => {
    // The header claims a single entry point that "cannot be bypassed by a
    // second require site", so this has to scan the whole shipped tree, not
    // just colibri-resolver: a direct require anywhere in the main process
    // (e.g. chain-data-router) would initialize the runtime with the flag
    // unset if it loads before colibri-runtime does, re-arming the segfault
    // while every other test here still passes.
    const SRC = path.join(__dirname, '..', '..');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        // Test files may require the package to mock or introspect it; they
        // never run inside the app, so they cannot re-arm the crash.
        if (entry.name.endsWith('.test.js')) continue;
        if (full === path.join(__dirname, 'colibri-runtime.js')) continue;
        if (/(?:require\(|from\s+)['"]@corpus-core\/colibri-stateless/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
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
  //
  // The binary's name under dist/ is platform-specific (`electron`,
  // `electron.exe`, `Electron.app/Contents/MacOS/Electron`), so read it from
  // the same `path.txt` the `electron` module itself uses rather than
  // hardcoding the Linux name — a hardcoded `dist/electron` never exists on
  // macOS or Windows and would silently downgrade every dev run there to the
  // node-hosted probe, which cannot reproduce the crash this test guards.
  function probeExecutable() {
    let electron = null;
    try {
      const dir = path.dirname(require.resolve('electron/package.json'));
      const rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
      const full = path.join(dir, 'dist', rel);
      if (rel && fs.existsSync(full)) electron = full;
    } catch { /* electron not installed / dist not downloaded */ }
    if (electron) {
      return { exe: electron, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, label: 'electron' };
    }
    // Loud, because the assertion still passes on node while losing the
    // Electron-host fidelity that makes it meaningful.
    console.warn(
      '[colibri-runtime.test] no Electron binary in node_modules (dist not downloaded?); ' +
      'running the runtime-selection probe under node, which cannot reproduce the ' +
      'Electron-only addon crash.'
    );
    return { exe: process.execPath, env: { ...process.env }, label: 'node' };
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

// The real hosts, not mocks: the crash only exists in Electron's full main
// process, and recovery depends on the installed package's internals
// (`cjs/runtime.js`'s `setRuntimeProvider`, `cjs/runtime_wasm.js`'s module-level
// cache), so a bump that moves either has to fail here.
describe('a Colibri WASM trap fails one request instead of the process (#453)', () => {
  function electronBinary() {
    try {
      const dir = path.dirname(require.resolve('electron/package.json'));
      const rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
      const full = path.join(dir, 'dist', rel);
      if (rel && fs.existsSync(full)) return full;
    } catch { /* electron not installed / dist not downloaded */ }
    return null;
  }

  function runProbe(source, { exe, args = [], env }) {
    const probe = path.join(os.tmpdir(), `colibri-trap-probe-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(probe, source);
    try {
      const stdout = execFileSync(exe, [...args, probe], {
        env,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const line = stdout.split('\n').find((l) => l.startsWith('{"probe"'));
      return JSON.parse(line);
    } finally {
      try { fs.unlinkSync(probe); } catch { /* best-effort cleanup */ }
    }
  }

  const RUNTIME = JSON.stringify(path.join(__dirname, 'colibri-runtime.js'));
  const UPSTREAM_RUNTIME = JSON.stringify(path.join(PKG_DIR, 'cjs', 'runtime.js'));
  // 0x7ffffff0 is far past c4w.wasm's linear memory, so treating it as a
  // context pointer is a guaranteed out-of-bounds load: the same trap an
  // unknown-receipt lookup ends in, without needing a prover on the network.
  const BAD_CTX = '0x7ffffff0';

  test('the trap is a catchable RuntimeError in Electron\'s full main process', () => {
    const exe = electronBinary();
    if (!exe && process.env.FREEDOM_COLIBRI_TRAP_PROBE_REQUIRED === '1') {
      // The CI `test` job never downloads Electron, so this would skip there;
      // `e2e-safe` (which has the binary) sets this to make a skip a failure.
      throw new Error('FREEDOM_COLIBRI_TRAP_PROBE_REQUIRED=1 but no Electron binary is installed');
    }
    if (!exe) {
      console.warn(
        '[colibri-runtime.test] skipped: no Electron binary in node_modules; the ' +
        'main-process SIGSEGV this guards cannot be reproduced under node.'
      );
      return;
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // A bare module doing one out-of-bounds i32.load: whatever V8 does with it
    // here, it does to every WASM module in the main process.
    const result = runProbe(`
      const { app } = require('electron');
      const rt = require(${RUNTIME});
      const { getRuntime } = require(${UPSTREAM_RUNTIME});
      const out = { probe: true };
      const tiny = new Uint8Array([0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,5,3,1,0,1,7,8,1,4,108,111,97,100,0,0,10,9,1,7,0,32,0,40,2,0,11]);
      try {
        new WebAssembly.Instance(new WebAssembly.Module(tiny)).exports.load(0x7ffffff0);
        out.tiny = 'no trap';
      } catch (err) { out.tiny = err.constructor.name; }
      rt.Colibri.register_storage({ get: () => null, set() {}, del() {} })
        .then(() => getRuntime())
        .then((runtime) => {
          try { runtime.executeRpcCtx(${BAD_CTX}); out.colibri = 'no trap'; }
          catch (err) { out.colibri = err.constructor.name; }
          out.resets = rt.runtimeResetCount();
        })
        .catch((err) => { out.error = String(err && err.message || err); })
        .finally(() => { console.log(JSON.stringify(out)); app.exit(0); });
    `, { exe, args: ['--no-sandbox', '--ozone-platform=headless'], env });
    expect(result).toEqual({ probe: true, tiny: 'RuntimeError', colibri: 'RuntimeError', resets: 1 });
  }, 120_000);

  test('a trap swaps in a fresh WASM instance with the host storage re-attached', () => {
    const exe = electronBinary();
    const env = exe ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env };
    const result = runProbe(`
      const rt = require(${RUNTIME});
      const { getRuntime } = require(${UPSTREAM_RUNTIME});
      const out = { probe: true, resets: [] };
      rt.setRuntimeResetListener((err) => out.resets.push(err.constructor.name));
      const reads = [];
      const storage = { get: (key) => { reads.push(key); return null; }, set() {}, del() {} };
      (async () => {
        await rt.Colibri.register_storage(storage);
        const first = await getRuntime();
        try { first.executeRpcCtx(${BAD_CTX}); } catch (err) { out.trap = err.constructor.name; }
        // A request still draining on the retired instance repeats the call
        // that trapped; it is refused before reaching WASM, so it must not
        // throw away the replacement a second time (see \`count\`).
        try { first.executeRpcCtx(${BAD_CTX}); out.retiredRetry = 'ran'; }
        catch (err) { out.retiredRetry = err instanceof WebAssembly.RuntimeError ? 'trap' : 'refused'; }
        // Nothing keeps running on the trapped instance: a request that
        // captured it before the trap gets a refusal, not a working call...
        try { first.getMethodType(1n, 'eth_blockNumber', null, 0); out.retiredCall = 'ran'; }
        catch (err) { out.retiredCall = err instanceof WebAssembly.RuntimeError ? 'trap' : 'refused'; }
        // ...but its cleanup in upstream's \`finally\` must not replace that error.
        try { out.retiredFree = first.freeRpcCtx(1) === undefined ? 'noop' : 'ran'; }
        catch { out.retiredFree = 'threw'; }
        const second = await getRuntime();
        out.fresh = first !== second;
        out.kind = second.kind;
        out.works = second.getMethodType(1n, 'eth_blockNumber', null, 0);
        out.count = rt.runtimeResetCount();
        // The verifier loads its chain state through the storage adapter; the
        // replacement must read the host's adapter, not upstream's cwd default.
        reads.length = 0;
        const client = new rt.Colibri({
          chainId: 1,
          prover: ['http://127.0.0.1:9'],
          rpcs: ['http://127.0.0.1:9'],
          beacon_apis: ['http://127.0.0.1:9'],
          proofStrategy: rt.Strategy.VerifiedOnly,
        });
        await client.request({ method: 'eth_blockNumber', params: [] }).catch(() => {});
        out.storageReads = reads.includes('states_1');
        // Retired instances must become unreachable. Node lists every module a
        // file requires in its \`module.children\`, so a retired
        // runtime_wasm.js left there pins its Emscripten instance (memory plus
        // the c4w.wasm bytes, ~1.7 MB) for the life of the process.
        for (let i = 0; i < 5; i += 1) {
          const rt2 = await getRuntime();
          try { rt2.executeRpcCtx(${BAD_CTX}); } catch { /* expected */ }
        }
        await getRuntime();
        out.resetsAfterLoop = rt.runtimeResetCount();
        out.retainedWasmRuntimes = require.cache[require.resolve(${RUNTIME})].children
          .filter((child) => child.id.endsWith('runtime_wasm.js')).length;
      })()
        .catch((err) => { out.error = String(err && err.message || err); })
        .finally(() => { console.log(JSON.stringify(out)); process.exit(0); });
    `, { exe: exe || process.execPath, env });
    expect(result).toEqual({
      probe: true,
      // One for the first trap (the refused draining retry changes nothing,
      // see \`count\`), then one per loop iteration below.
      resets: Array(6).fill('RuntimeError'),
      trap: 'RuntimeError',
      fresh: true,
      kind: 'wasm',
      works: 1,
      count: 1,
      storageReads: true,
      retiredRetry: 'refused',
      retiredCall: 'refused',
      retiredFree: 'noop',
      resetsAfterLoop: 6,
      retainedWasmRuntimes: 1,
    });
  }, 120_000);
});
