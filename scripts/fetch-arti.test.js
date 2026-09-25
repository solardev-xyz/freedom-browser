/**
 * Guards for the Arti build script's pinned version and toolchain pre-flight.
 *
 * Arti is compiled from crates.io on the release runners, and `cargo install`
 * only reports a too-old toolchain minutes into the dependency build. The MSRV
 * check exists to turn that into an immediate, actionable failure, so it needs
 * to stay correct across bumps.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  ARTI_VERSION,
  PINNED_ARTI_VERSION,
  MIN_RUST_VERSION,
  compareVersions,
  checkRustVersion,
  platformKey,
  artiBinaryName,
  cargoFeatures,
  installArgs,
  isRetryableCargoFailure,
  buildArti,
} = require('./fetch-arti');
const { MAX_ATTEMPTS } = require('./lib/fetch-with-retry');

describe('fetch-arti version pin', () => {
  test('pins a concrete Arti release', () => {
    expect(PINNED_ARTI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ARTI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('declares the pinned release MSRV', () => {
    expect(MIN_RUST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// The build output has to land where the app looks for it. tor-manager.js
// derives that path from process.platform/process.arch with the same map, so
// a host build on any of the three shipped platforms — Windows included since
// the release workflow builds Arti there too — has to agree with it.
describe('host output layout', () => {
  test.each([
    ['darwin', 'arm64', 'mac-arm64', 'arti'],
    ['linux', 'x64', 'linux-x64', 'arti'],
    ['linux', 'arm64', 'linux-arm64', 'arti'],
    ['win32', 'x64', 'win-x64', 'arti.exe'],
  ])('%s-%s builds into arti-bin/%s/%s', (platform, arch, dir, binName) => {
    expect(platformKey(platform, arch)).toBe(dir);
    expect(artiBinaryName(platform)).toBe(binName);
  });

  test('matches the directory and binary name tor-manager.js resolves', () => {
    // Mirrors src/main/tor-manager.js#getArtiBinaryPath, which is the only
    // consumer of this layout in a dev tree.
    const torManager = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'tor-manager.js'),
      'utf8'
    );
    expect(torManager).toContain("{ darwin: 'mac', linux: 'linux', win32: 'win' }");
    expect(torManager).toContain("process.platform === 'win32' ? 'arti.exe' : 'arti'");
  });

  test('only Windows gets an .exe suffix', () => {
    expect(artiBinaryName('darwin')).toBe('arti');
    expect(artiBinaryName('linux')).toBe('arti');
  });
});

// The Windows leg of the release build fails at link time without this:
// `libsqlite3-sys` emits a bare `-l sqlite3` when it finds no system SQLite,
// and MSVC's linker then stops with LNK1181.
describe('cargo features', () => {
  test('asks Arti to bundle SQLite on Windows only', () => {
    expect(cargoFeatures('win32')).toEqual(['static-sqlite']);
    expect(cargoFeatures('darwin')).toEqual([]);
    expect(cargoFeatures('linux')).toEqual([]);
  });

  test('builds the pinned version, locked, into the given root', () => {
    expect(installArgs('2.6.0', '/tmp/root', 'linux')).toEqual([
      'install',
      'arti',
      '--version',
      '2.6.0',
      '--locked',
      '--root',
      '/tmp/root',
    ]);
  });

  test('passes the Windows feature through to cargo', () => {
    expect(installArgs('2.6.0', 'C:\\tmp\\root', 'win32')).toEqual([
      'install',
      'arti',
      '--version',
      '2.6.0',
      '--locked',
      '--root',
      'C:\\tmp\\root',
      '--features',
      'static-sqlite',
    ]);
  });
});

describe('compareVersions', () => {
  test('orders by numeric component, not lexicographically', () => {
    expect(compareVersions('1.9.0', '1.91.0')).toBeLessThan(0);
    expect(compareVersions('1.91.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.91.0', '1.91.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  test('treats a missing component as zero', () => {
    expect(compareVersions('1.91', '1.91.0')).toBe(0);
    expect(compareVersions('1.91', '1.91.1')).toBeLessThan(0);
  });
});

describe('checkRustVersion', () => {
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('accepts a toolchain at the MSRV', () => {
    expect(checkRustVersion(`cargo ${MIN_RUST_VERSION} (f2d3ce0bd 2026-03-21)`)).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('accepts a newer toolchain', () => {
    expect(checkRustVersion('cargo 1.95.0 (f2d3ce0bd 2026-03-21)')).toBe(true);
  });

  test('rejects a toolchain below the MSRV and names both versions', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)')).toBe(false);
    const message = errorSpy.mock.calls.flat().join('\n');
    expect(message).toContain('1.89.0');
    expect(message).toContain(MIN_RUST_VERSION);
    expect(message).toContain(PINNED_ARTI_VERSION);
  });

  // MIN_RUST_VERSION is the *pinned* release's MSRV. An ARTI_VERSION override
  // (the documented local-testing escape hatch, e.g. falling back to a 1.x
  // line) has its own, older MSRV, so an old toolchain must not block it.
  test('warns instead of blocking when ARTI_VERSION overrides the pin', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)', '1.4.6')).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
    const message = warnSpy.mock.calls.flat().join('\n');
    expect(message).toContain('1.89.0');
    expect(message).toContain(MIN_RUST_VERSION);
    expect(message).toContain('1.4.6');
  });

  test('still blocks a too-old toolchain when the override equals the pin', () => {
    expect(checkRustVersion('cargo 1.89.0 (abcdef012 2025-08-01)', PINNED_ARTI_VERSION)).toBe(
      false
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('passes through output it cannot parse rather than blocking the build', () => {
    // cargo still enforces the MSRV itself; this check only fails fast.
    expect(checkRustVersion('cargo (nightly, unknown build)')).toBe(true);
  });
});

/**
 * Arti is the one fetcher with no HTTP of its own: cargo does the downloading,
 * so the shared retry loop (scripts/lib/fetch-with-retry.js) is applied to the
 * `cargo install` itself, with a classifier that reads cargo's own words for a
 * network failure. Retrying a multi-minute build that is going to fail
 * identically is worse than failing once, so only that class is retried.
 */
describe('cargo network failures', () => {
  // Real cargo output. The last two are *not* network failures and must stop
  // the build on the first attempt.
  test.each([
    ['warning: spurious network error (3 tries remaining): [7] Could not connect to server', true],
    ['error: failed to download from `https://static.crates.io/crates/tor-proto/...`', true],
    ['error: failed to get 200 response from `https://index.crates.io/`, got 502', true],
    ['error: failed to fetch `https://github.com/rust-lang/crates.io-index`', true],
    ['caused by: [28] Timeout was reached (Operation timed out after 30000 ms)', true],
    ['error: could not resolve host: static.crates.io', true],
    ['error[E0433]: failed to resolve: use of undeclared crate or module `tor_rtcompat`', false],
    ["LINK : fatal error LNK1181: cannot open input file 'sqlite3.lib'", false],
    ['error: package `arti v2.6.0` cannot be built because it requires rustc 1.91.0', false],
    ['', false],
  ])('classifies %s', (output, retryable) => {
    expect(isRetryableCargoFailure(output)).toBe(retryable);
  });

  // The classifier reads a 64KB *tail*, not the last line: a network hiccup
  // cargo recovered from on its own can still be sitting in it when the build
  // later dies of something deterministic. Retrying that spends four
  // multi-minute builds on a failure that reproduces identically.
  test.each([
    [
      'MSRV failure right after a recovered download',
      'warning: spurious network error (3 tries remaining): [7] Could not connect to server\n' +
        '    Downloaded 412 crates in 21.03s\n' +
        'error: package `arti v2.6.0` cannot be built because it requires rustc 1.91.0',
    ],
    [
      'compile error right after a recovered download',
      'warning: spurious network error (2 tries remaining): [28] Timeout was reached\n' +
        'error[E0433]: failed to resolve: use of undeclared crate or module `tor_rtcompat`\n' +
        'error: could not compile `tor-proto` (lib) due to 1 previous error',
    ],
    [
      'Windows link failure right after a recovered download',
      'warning: spurious network error (3 tries remaining): connection reset\n' +
        "LINK : fatal error LNK1181: cannot open input file 'sqlite3.lib'",
    ],
  ])('does not retry a deterministic failure: %s', (_name, output) => {
    expect(isRetryableCargoFailure(output)).toBe(false);
  });

  // The veto must not swallow the case this retry loop exists for. `cargo
  // install` wraps a *download* failure in its own `failed to compile` line,
  // which is why that phrase is deliberately not a deterministic marker.
  test('still retries a crate download failure cargo wrapped as a compile failure', () => {
    const output =
      'error: failed to compile `arti v2.6.0`, intermediate artifacts can be found at `/tmp/arti-install-x`\n' +
      '\nCaused by:\n  failed to download from `https://static.crates.io/crates/tor-proto/2.6.0/download`';
    expect(isRetryableCargoFailure(output)).toBe(true);
  });
});

describe('buildArti', () => {
  /** A fake `cargo` that writes `stderr` and exits with `code`. */
  function fakeCargo(runs) {
    const calls = [];
    const spawnFn = (bin, args) => {
      const run = runs[calls.length];
      calls.push({ bin, args });
      const child = new EventEmitter();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        if (run.stderr) child.stderr.write(run.stderr);
        child.stderr.end();
        process.nextTick(() => child.emit('close', run.code));
      });
      return child;
    };
    return { calls, spawnFn };
  }

  const noWait = { sleep: () => Promise.resolve(), log: () => {} };
  let warnSpy;
  let stderrSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('retries a crates.io network failure and succeeds', async () => {
    const { calls, spawnFn } = fakeCargo([
      { code: 101, stderr: 'error: failed to download from `https://static.crates.io/...`' },
      { code: 0, stderr: '' },
    ]);
    await buildArti(installArgs('2.6.0', '/tmp/root', 'linux'), { ...noWait, spawnFn });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain('--locked');
  });

  // A compile error takes minutes to reproduce and will reproduce exactly.
  test('never retries a compile error', async () => {
    const { calls, spawnFn } = fakeCargo([
      {
        code: 101,
        stderr: 'error[E0433]: failed to resolve: use of undeclared crate `tor_rtcompat`',
      },
    ]);
    await expect(
      buildArti(installArgs('2.6.0', '/tmp/root', 'linux'), { ...noWait, spawnFn })
    ).rejects.toThrow(/was not retried .*cargo install arti exited with code 101/);
    expect(calls).toHaveLength(1);
  });

  test(`gives up after ${MAX_ATTEMPTS} network failures`, async () => {
    const { calls, spawnFn } = fakeCargo(
      Array.from({ length: MAX_ATTEMPTS }, () => ({
        code: 101,
        stderr: 'error: failed to fetch `https://github.com/rust-lang/crates.io-index`',
      }))
    );
    await expect(
      buildArti(installArgs('2.6.0', '/tmp/root', 'linux'), { ...noWait, spawnFn })
    ).rejects.toThrow(`failed after ${MAX_ATTEMPTS} attempt(s) of ${MAX_ATTEMPTS}`);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  // The build takes several minutes; swallowing its progress to capture the
  // tail for classification would be a real regression.
  test('keeps cargo output visible while capturing the tail', async () => {
    const { spawnFn } = fakeCargo([{ code: 0, stderr: '   Compiling tor-proto v0.34.0\n' }]);
    await buildArti(installArgs('2.6.0', '/tmp/root', 'linux'), { ...noWait, spawnFn });
    expect(stderrSpy.mock.calls.flat().join('')).toContain('Compiling tor-proto');
  });
});
