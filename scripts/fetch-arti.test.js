/**
 * Guards for the Arti build script's pinned version and toolchain pre-flight.
 *
 * Arti is compiled from crates.io on the release runners, and `cargo install`
 * only reports a too-old toolchain minutes into the dependency build. The MSRV
 * check exists to turn that into an immediate, actionable failure, so it needs
 * to stay correct across bumps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const {
  ARTI_VERSION,
  PINNED_ARTI_VERSION,
  ARTI_CRATE_SHA256,
  WINDOWS_CRATE_PATCHES,
  MIN_RUST_VERSION,
  cratePatches,
  crateUrl,
  applyUnifiedPatch,
  lockWithPathOverride,
  fetchCrate,
  preparePatchedSources,
  compareVersions,
  checkRustVersion,
  platformKey,
  artiBinaryName,
  cargoFeatures,
  cargoEnv,
  nonSystemDylibs,
  installArgs,
  isRetryableCargoFailure,
  buildArti,
} = require('./fetch-arti');
const { MAX_ATTEMPTS } = require('./lib/fetch-with-retry');
const { COMPONENTS, componentKey } = require('./prebuilt-natives');

const ROOT = path.join(__dirname, '..');

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
  test('asks Arti to bundle SQLite on Windows and macOS', () => {
    expect(cargoFeatures('win32')).toEqual(['static-sqlite']);
    expect(cargoFeatures('darwin')).toEqual(['static-sqlite']);
    expect(cargoFeatures('linux')).toEqual([]);
  });

  // The 2.6.0 nightly linked Homebrew's liblzma dynamically on the macOS
  // runner and failed to start on users' Macs.
  test('links liblzma statically on macOS only', () => {
    expect(cargoEnv('darwin')).toEqual({ LZMA_API_STATIC: '1' });
    expect(cargoEnv('linux')).toEqual({});
    expect(cargoEnv('win32')).toEqual({});
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

describe('nonSystemDylibs', () => {
  // `otool -L` of the arti binary from the broken nightly.
  const broken = [
    '/tmp/root/bin/arti:',
    '\t/opt/homebrew/opt/xz/lib/liblzma.5.dylib (compatibility version 14.0.0, current version 14.8.0)',
    '\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.1)',
    '\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)',
    '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
    '',
  ].join('\n');

  test('flags a Homebrew dylib', () => {
    expect(nonSystemDylibs(broken)).toEqual(['/opt/homebrew/opt/xz/lib/liblzma.5.dylib']);
  });

  test('accepts a binary that links only macOS itself', () => {
    const fixed = broken
      .split('\n')
      .filter((line) => !line.includes('homebrew'))
      .join('\n');
    expect(nonSystemDylibs(fixed)).toEqual([]);
  });

  test('flags /usr/local and @rpath libraries too', () => {
    const out = [
      'arti:',
      '\t/usr/local/opt/sqlite/lib/libsqlite3.0.dylib (compatibility version 9.0.0, current version 9.6.0)',
      '\t@rpath/libzstd.1.dylib (compatibility version 1.0.0, current version 1.5.7)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
    ].join('\n');
    expect(nonSystemDylibs(out)).toEqual([
      '/usr/local/opt/sqlite/lib/libsqlite3.0.dylib',
      '@rpath/libzstd.1.dylib',
    ]);
  });

  test('ignores the header line naming the file itself', () => {
    expect(nonSystemDylibs('/opt/homebrew/somewhere/arti:\n')).toEqual([]);
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
    const spawnFn = (bin, args, spawnOptions) => {
      const run = runs[calls.length];
      calls.push({ bin, args, spawnOptions });
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

  test('keeps the inherited environment for cargo', async () => {
    const { calls, spawnFn } = fakeCargo([{ code: 0, stderr: '' }]);
    await buildArti(installArgs('2.6.0', '/tmp/root', 'linux'), { ...noWait, spawnFn });
    expect(calls[0].spawnOptions.env).toMatchObject({ ...cargoEnv(), PATH: process.env.PATH });
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

// The Windows build patches saturating-time 0.5.0 (#925) until a released
// Arti carries upstream MR 4520 (#926). The patch, its checksums and this
// guard all describe exactly Arti 2.7.0's dependency tree.
describe('Windows saturating-time patch (#925)', () => {
  test('is re-checked whenever the Arti pin moves', () => {
    if (PINNED_ARTI_VERSION !== '2.7.0') {
      throw new Error(
        `PINNED_ARTI_VERSION moved from 2.7.0 to ${PINNED_ARTI_VERSION}. Check whether the new ` +
          'Arti release contains upstream MR 4520 ' +
          '(https://gitlab.torproject.org/tpo/core/arti/-/merge_requests/4520): its ' +
          'saturating-time find_limit() must only accept Some(st) when st != res. If it does, ' +
          'drop the patch, WINDOWS_CRATE_PATCHES, ARTI_CRATE_SHA256 and this guard ' +
          '(see https://github.com/solardev-xyz/freedom-browser/issues/926). If it does not, ' +
          "re-check that the patch still applies to that release's saturating-time (update " +
          'its version, crate sha256 and patched sha256), set ARTI_CRATE_SHA256 to the new ' +
          "arti crate's crates.io checksum, and update this guard."
      );
    }
    expect(ARTI_CRATE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is applied to the pinned Windows build only', () => {
    expect(cratePatches('win32', PINNED_ARTI_VERSION)).toBe(WINDOWS_CRATE_PATCHES);
    expect(cratePatches('linux', PINNED_ARTI_VERSION)).toEqual([]);
    expect(cratePatches('darwin', PINNED_ARTI_VERSION)).toEqual([]);
    // An ARTI_VERSION override has its own dependency tree the patch does not describe.
    expect(cratePatches('win32', '9.9.9')).toEqual([]);
  });

  test("pins saturating-time 0.5.0 from crates.io and upstream's fix", () => {
    expect(WINDOWS_CRATE_PATCHES).toHaveLength(1);
    const [spec] = WINDOWS_CRATE_PATCHES;
    expect(spec).toMatchObject({
      name: 'saturating-time',
      version: '0.5.0',
      file: 'src/internal.rs',
    });
    expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.patchedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(crateUrl(spec.name, spec.version)).toBe(
      'https://static.crates.io/crates/saturating-time/saturating-time-0.5.0.crate'
    );
    const patch = fs.readFileSync(path.join(ROOT, spec.patch), 'utf8');
    // The two halves of MR 4520: the supertrait, and the guard in find_limit().
    expect(patch).toContain('+pub trait SaturatingTime: Sized + Copy + PartialEq {');
    expect(patch).toContain('+            Some(st) if st != res => {');
    expect(patch).toContain('+            None | Some(_) => {');
    expect(patch).toContain('merge_requests/4520');
  });

  test('every patch file is part of the prebuilt natives recipe key', () => {
    const inputs = COMPONENTS.arti.inputs();
    for (const spec of WINDOWS_CRATE_PATCHES) expect(inputs).toContain(spec.patch);

    // Editing the patch makes the pinned Arti prebuilt stale.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-arti-key-'));
    try {
      for (const file of inputs) {
        fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(scratch, file));
      }
      const key = componentKey('arti', scratch);
      fs.appendFileSync(path.join(scratch, WINDOWS_CRATE_PATCHES[0].patch), ' \n');
      expect(componentKey('arti', scratch)).not.toBe(key);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the patch file is LF in the checkout (.gitattributes)', () => {
    const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    expect(attributes).toMatch(/^scripts\/patches\/\*\* text eol=lf$/m);
  });
});

describe('applyUnifiedPatch', () => {
  const source = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\n');
  const patch = [
    'commentary before the header is ignored',
    '--- a/f.rs',
    '+++ b/f.rs',
    '@@ -2,3 +2,4 @@',
    ' two',
    '-three',
    '+THREE',
    '+three and a half',
    ' four',
    '@@ -6,1 +7,1 @@',
    '-six',
    '+SIX',
    '',
  ].join('\n');

  test('applies every hunk at its stated line', () => {
    expect(applyUnifiedPatch(source, patch)).toBe(
      ['one', 'two', 'THREE', 'three and a half', 'four', 'five', 'SIX', ''].join('\n')
    );
  });

  test('reads a CRLF patch (core.autocrlf checkout) the same way', () => {
    expect(applyUnifiedPatch(source, patch.replace(/\n/g, '\r\n'))).toBe(
      applyUnifiedPatch(source, patch)
    );
  });

  test('refuses a hunk whose context changed', () => {
    expect(() => applyUnifiedPatch(source.replace('four', 'FOUR'), patch)).toThrow(
      'hunk 1 does not apply at line 2'
    );
  });

  test('refuses a hunk that only matches somewhere else (no offset)', () => {
    expect(() => applyUnifiedPatch(`zero\n${source}`, patch)).toThrow('hunk 1 does not apply');
  });

  test('refuses an already-applied patch', () => {
    expect(() => applyUnifiedPatch(applyUnifiedPatch(source, patch), patch)).toThrow(
      'does not apply'
    );
  });

  test('refuses malformed patches', () => {
    expect(() => applyUnifiedPatch(source, 'no header')).toThrow('no ---/+++ file header');
    expect(() => applyUnifiedPatch(source, '--- a/f\n+++ b/f\n')).toThrow('no hunks');
    expect(() => applyUnifiedPatch(source, `${patch}--- a/g\n+++ b/g\n`)).toThrow(
      'more than one file'
    );
    expect(() => applyUnifiedPatch(source, '--- a/f\n+++ b/f\n@@ -2,3 +2,3 @@\n two')).toThrow(
      'truncated'
    );
  });
});

describe('lockWithPathOverride', () => {
  const sum = 'a'.repeat(64);
  const lock = [
    '# This file is automatically @generated by Cargo.',
    'version = 4',
    '',
    '[[package]]',
    'name = "rustc-hash"',
    'version = "2.1.1"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${'b'.repeat(64)}"`,
    '',
    '[[package]]',
    'name = "saturating-time"',
    'version = "0.5.0"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    `checksum = "${sum}"`,
    'dependencies = [',
    ' "web-time-compat",',
    ']',
    '',
  ].join('\n');

  test("drops only the overridden entry's registry source and checksum, as cargo does", () => {
    const out = lockWithPathOverride(lock, 'saturating-time', '0.5.0', sum);
    expect(out).toBe(
      lock.replace(
        `source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${sum}"\n`,
        ''
      )
    );
    expect(out).toContain(`checksum = "${'b'.repeat(64)}"`);
  });

  test('keeps CRLF line endings', () => {
    const out = lockWithPathOverride(lock.replace(/\n/g, '\r\n'), 'saturating-time', '0.5.0', sum);
    expect(out).toBe(
      lockWithPathOverride(lock, 'saturating-time', '0.5.0', sum).replace(/\n/g, '\r\n')
    );
  });

  test('refuses a lock file pinning different crate bytes than the patch was written for', () => {
    expect(() => lockWithPathOverride(lock, 'saturating-time', '0.5.0', 'c'.repeat(64))).toThrow(
      'but the patch was written against'
    );
  });

  test('refuses a missing entry or an entry that is not from crates.io', () => {
    expect(() => lockWithPathOverride(lock, 'saturating-time', '0.6.0', sum)).toThrow(
      'has 0 entries'
    );
    const pathEntry = lockWithPathOverride(lock, 'saturating-time', '0.5.0', sum);
    expect(() => lockWithPathOverride(pathEntry, 'saturating-time', '0.5.0', sum)).toThrow(
      'not a single crates.io package'
    );
  });
});

describe('the patched Windows build', () => {
  let scratch;
  let logSpy;
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-arti-test-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Fake crates.io: each "crate" archive is a JSON map of relative path to contents. */
  function fakeRegistry(crates) {
    const downloads = [];
    return {
      downloads,
      download: async (url, file) => {
        downloads.push(url);
        const crate = crates[url];
        if (!crate) throw new Error(`404 ${url}`);
        fs.writeFileSync(file, crate.bytes);
      },
      extract: (archive, destination) => {
        for (const [rel, text] of Object.entries(JSON.parse(fs.readFileSync(archive, 'utf8')))) {
          fs.mkdirSync(path.dirname(path.join(destination, rel)), { recursive: true });
          fs.writeFileSync(path.join(destination, rel), text);
        }
      },
    };
  }
  const crate = (files) => {
    const bytes = JSON.stringify(files);
    return { bytes, sha256: sha(bytes) };
  };

  test('fetchCrate refuses a crate whose sha256 does not match, before unpacking it', async () => {
    const good = crate({ 'x-1.0.0/Cargo.toml': '' });
    const registry = fakeRegistry({ [crateUrl('x', '1.0.0')]: good });
    const extract = jest.fn(registry.extract);
    await expect(
      fetchCrate('x', '1.0.0', 'f'.repeat(64), scratch, { download: registry.download, extract })
    ).rejects.toThrow(`has sha256 ${good.sha256}, expected ${'f'.repeat(64)}`);
    expect(extract).not.toHaveBeenCalled();
    await expect(
      fetchCrate('x', '1.0.0', good.sha256, scratch, { ...registry, extract })
    ).resolves.toBe(path.join(scratch, 'x', 'x-1.0.0'));
  });

  /** A fake Arti crate depending on a fake `dep`, and a patch for it. */
  function patchedTree() {
    const original = 'fn a() {}\nfn b() { old(); }\n';
    const patched = 'fn a() {}\nfn b() { new(); }\n';
    const root = path.join(scratch, 'repo');
    fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'patches/dep.patch'),
      '--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -2,1 +2,1 @@\n-fn b() { old(); }\n+fn b() { new(); }\n'
    );
    const dep = crate({ 'dep-0.5.0/Cargo.toml': '', 'dep-0.5.0/src/lib.rs': original });
    const lock =
      'version = 4\n\n[[package]]\nname = "dep"\nversion = "0.5.0"\n' +
      `source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${dep.sha256}"\n`;
    const arti = crate({
      [`arti-${PINNED_ARTI_VERSION}/Cargo.toml`]: '',
      [`arti-${PINNED_ARTI_VERSION}/Cargo.lock`]: lock,
    });
    const registry = fakeRegistry({
      [crateUrl('arti', PINNED_ARTI_VERSION)]: arti,
      [crateUrl('dep', '0.5.0')]: dep,
    });
    const spec = {
      name: 'dep',
      version: '0.5.0',
      sha256: dep.sha256,
      patch: 'patches/dep.patch',
      file: 'src/lib.rs',
      patchedSha256: sha(patched),
    };
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work);
    return {
      work,
      spec,
      patched,
      registry,
      options: { ...registry, root, artiCrateSha256: arti.sha256 },
    };
  }

  test('checks the downloaded Arti crate against the pinned checksum', async () => {
    const { work, spec, registry } = patchedTree();
    await expect(
      preparePatchedSources(work, [spec], { ...registry, root: path.join(scratch, 'repo') })
    ).rejects.toThrow(`expected ${ARTI_CRATE_SHA256}`);
  });

  test('patches the dependency, overrides it in the lock file and hands both to cargo', async () => {
    const { work, spec, patched, registry, options } = patchedTree();
    const result = await preparePatchedSources(work, [spec], options);
    const artiDir = path.join(work, 'arti', `arti-${PINNED_ARTI_VERSION}`);
    const depDir = path.join(work, 'dep', 'dep-0.5.0');
    expect(result).toEqual({ artiDir, overrides: { dep: depDir } });
    expect(registry.downloads).toEqual([
      crateUrl('arti', PINNED_ARTI_VERSION),
      crateUrl('dep', '0.5.0'),
    ]);
    expect(fs.readFileSync(path.join(depDir, 'src/lib.rs'), 'utf8')).toBe(patched);
    const lock = fs.readFileSync(path.join(artiDir, 'Cargo.lock'), 'utf8');
    expect(lock).toBe('version = 4\n\n[[package]]\nname = "dep"\nversion = "0.5.0"\n');

    expect(installArgs(PINNED_ARTI_VERSION, '/root', 'win32', result)).toEqual([
      'install',
      '--path',
      artiDir,
      '--locked',
      '--root',
      '/root',
      '--features',
      'static-sqlite',
      '--config',
      `patch.crates-io.dep.path=${JSON.stringify(depDir)}`,
    ]);
  });

  test('refuses a patch result that does not hash to the pinned patched file', async () => {
    const { work, spec, options } = patchedTree();
    await expect(
      preparePatchedSources(work, [{ ...spec, patchedSha256: '0'.repeat(64) }], options)
    ).rejects.toThrow(`expected ${'0'.repeat(64)}`);
  });

  test('quotes a Windows override path as a TOML string', () => {
    expect(
      installArgs(PINNED_ARTI_VERSION, 'C:\\root', 'win32', {
        artiDir: 'C:\\src\\arti-2.7.0',
        overrides: { 'saturating-time': 'C:\\src\\saturating-time-0.5.0' },
      }).slice(-2)
    ).toEqual([
      '--config',
      'patch.crates-io.saturating-time.path="C:\\\\src\\\\saturating-time-0.5.0"',
    ]);
  });
});
