/**
 * Fetch (build) the Arti Tor client binary.
 *
 * Unlike Ant / libradicle, the Tor Project does not publish a clean, scriptable
 * set of prebuilt `arti` binaries. The reliable, official, pinnable source is
 * crates.io, so we build from source with `cargo install`. This requires a
 * Rust toolchain (`cargo`) on the build machine.
 *
 * The binary is placed at `arti-bin/<platform>-<arch>/arti` (`arti.exe` on
 * Windows) to match the layout that
 * `src/main/tor-manager.js#getArtiBinaryPath` and the electron-builder
 * `extraResources` entries expect.
 *
 * Cross-compilation is out of scope here (it needs per-target toolchains), so
 * this builds for the host platform/arch only — mirroring how the Docker dist
 * jobs fetch the host-only libradicle addon.
 *
 * Build prerequisites beyond cargo, observed on Linux (the macOS, Linux and
 * Windows release runners build this with no extra setup step):
 *   - OpenSSL development headers (`libssl-dev`), for Arti's default
 *     `native-tls` runtime. macOS and Windows use the OS TLS stack instead
 *     (Secure Transport / SChannel) and need no equivalent package.
 *   - `libsqlite3-dev`, but only when `pkg-config` is installed: `libsqlite3-sys`
 *     then links the system SQLite instead of building its bundled copy.
 *   - a C compiler for that bundled SQLite copy where no system one is
 *     linked: Apple CLT on macOS, the x64 MSVC tools on Windows (the release
 *     workflow builds inside the developer shell it already activates for
 *     packaging, and downloads no compiler). Windows has no system SQLite at
 *     all, so the build asks Arti for its `static-sqlite` feature there — see
 *     cargoFeatures() below.
 *
 * Windows builds a patched Arti (#925): see WINDOWS_CRATE_PATCHES below. The
 * pinned `arti` crate is downloaded from crates.io and checked against its
 * pinned sha256, the patched dependency likewise, and cargo builds the crate
 * source with `cargo install --path --locked` and a `[patch.crates-io]`
 * override. macOS and Linux keep the plain `cargo install arti`.
 *
 * Env:
 *   ARTI_VERSION   crates.io version to install (default: pinned below; an
 *                  override also downgrades the MSRV pre-flight to a warning)
 *   CARGO_BIN      path to cargo (default: 'cargo' on PATH)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const { withRetry, MAX_ATTEMPTS, downloadToFile, TIMEOUTS } = require('./lib/fetch-with-retry');

// Pin a known-good Arti release. Bump deliberately and re-test the SOCKS flags
// (`arti proxy -c <config>`) and the `arti.toml` keys tor-manager.js writes.
//
// THE WINDOWS BUILD OF THIS VERSION IS PATCHED. Arti 2.7.0 depends on
// saturating-time 0.5.0, whose find_limit() never terminates on Windows
// (100 ns SystemTime ticks: checked_sub() below 100 ns returns the same value,
// not None), so Tor never bootstraps on any Windows machine:
// https://github.com/solardev-xyz/freedom-browser/issues/925. Until a released
// Arti carries upstream's fix (MR 4520,
// https://gitlab.torproject.org/tpo/core/arti/-/merge_requests/4520), the
// Windows build applies scripts/patches/saturating-time-0.5.0-windows.patch;
// see WINDOWS_CRATE_PATCHES below. When bumping: if the new release's
// saturating-time has the fix, drop the patch, ARTI_CRATE_SHA256's
// Windows-only use and the pin guard in fetch-arti.test.js
// (https://github.com/solardev-xyz/freedom-browser/issues/926); if not, move
// the patch to the new saturating-time version and re-check it applies.
const PINNED_ARTI_VERSION = '2.7.0';
// sha256 of arti-<PINNED_ARTI_VERSION>.crate on crates.io (its `checksum`).
// The patched Windows build installs from that crate's source with
// `cargo install --path`, where cargo no longer checks the top-level crate.
const ARTI_CRATE_SHA256 = 'a567e05cf614b579609d958e41b54602eea6983bccfec46d1e933a45605dd813';
const ARTI_VERSION = process.env.ARTI_VERSION || PINNED_ARTI_VERSION;
// MSRV of PINNED_ARTI_VERSION only (Arti 2.7.0 raised it to 1.92) — bump it in
// the same commit as the pin. Checked up front because `cargo install` only
// reports a too-old toolchain after it has resolved and started compiling the
// dependency tree, minutes into the build. An ARTI_VERSION override has its own
// MSRV, which this script does not know, so the check downgrades to a warning
// there rather than blocking a build cargo may well accept.
const MIN_RUST_VERSION = '1.92.0';
const CARGO_BIN = process.env.CARGO_BIN || 'cargo';

const OUTPUT_DIR = path.join(__dirname, '..', 'arti-bin');
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Dependencies of the pinned Arti that the Windows build patches (#925, #926).
 * Each is fetched from crates.io and checked against `sha256` (the checksum
 * Arti's own Cargo.lock records for it), `patch` is applied strictly, the
 * result must hash to `patchedSha256`, and cargo is pointed at it through a
 * `[patch.crates-io]` override. `patch` is a recipe input of the prebuilt
 * natives key (scripts/prebuilt-natives.js), so editing it rebuilds Arti.
 */
const WINDOWS_CRATE_PATCHES = [
  {
    name: 'saturating-time',
    version: '0.5.0',
    sha256: 'a586db154f85f3faf78398c37b6792d71f99d2253d3277571e14f8a8c6e49a65',
    patch: 'scripts/patches/saturating-time-0.5.0-windows.patch',
    file: 'src/internal.rs',
    patchedSha256: 'f2267171b97e42355dd51731f1f908bba8c48adf8a5ea3d3e936b8b519369a21',
  },
];

/**
 * The crate patches a build of `version` on `platform` applies. Only the
 * pinned version is patched: the patch and its checksums describe exactly
 * that release's dependency tree, so an ARTI_VERSION override builds unpatched
 * (and warns, on Windows; see main()).
 * @param {NodeJS.Platform} [platform]
 * @param {string} [version]
 */
function cratePatches(platform = process.platform, version = ARTI_VERSION) {
  return platform === 'win32' && version === PINNED_ARTI_VERSION ? WINDOWS_CRATE_PATCHES : [];
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** crates.io's download URL for a crate version (a .tar.gz). */
function crateUrl(name, version) {
  return `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
}

/**
 * Apply a single-file unified diff to `text`, strictly: every hunk must match
 * its context exactly at the line it names (no fuzz, no offset), so a patch
 * that no longer fits its source fails the build instead of landing somewhere
 * else. Anything before the `---` header is commentary. CRLF in the patch is
 * read as LF (a core.autocrlf checkout); the source itself must be LF.
 * @param {string} text
 * @param {string} patchText
 * @returns {string}
 */
function applyUnifiedPatch(text, patchText) {
  const patchLines = String(patchText).replace(/\r\n/g, '\n').split('\n');
  const start = patchLines.findIndex((line) => line.startsWith('--- '));
  if (start < 0 || !patchLines[start + 1]?.startsWith('+++ ')) {
    throw new Error('patch has no ---/+++ file header');
  }
  if (patchLines.slice(start + 2).some((line) => line.startsWith('--- '))) {
    throw new Error('patch touches more than one file');
  }
  const source = text.split('\n');
  const out = [];
  let cursor = 0; // next unconsumed line of `source`, 0-based
  let hunks = 0;
  let i = start + 2;
  while (i < patchLines.length) {
    const header = patchLines[i];
    if (header === '') {
      i++;
      continue;
    }
    const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) throw new Error(`unexpected patch line: ${header}`);
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    const oldLines = [];
    const newLines = [];
    i++;
    while (oldLines.length < oldCount || newLines.length < newCount) {
      const line = patchLines[i++];
      if (line === undefined) throw new Error(`hunk ${hunks + 1} is truncated`);
      const body = line.slice(1);
      if (line[0] === ' ') {
        oldLines.push(body);
        newLines.push(body);
      } else if (line[0] === '-') {
        oldLines.push(body);
      } else if (line[0] === '+') {
        newLines.push(body);
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file": not produced by our patches.
        throw new Error('patch relies on a missing trailing newline');
      } else {
        throw new Error(`hunk ${hunks + 1} has a malformed line: ${line}`);
      }
    }
    if (oldLines.length !== oldCount || newLines.length !== newCount) {
      throw new Error(`hunk ${hunks + 1} does not match its line counts`);
    }
    const at = oldCount === 0 ? oldStart : oldStart - 1;
    if (at < cursor) throw new Error(`hunk ${hunks + 1} overlaps the previous one`);
    const actual = source.slice(at, at + oldCount);
    if (actual.length !== oldCount || actual.some((line, k) => line !== oldLines[k])) {
      throw new Error(`hunk ${hunks + 1} does not apply at line ${oldStart}`);
    }
    out.push(...source.slice(cursor, at), ...newLines);
    cursor = at + oldCount;
    hunks++;
  }
  if (hunks === 0) throw new Error('patch has no hunks');
  out.push(...source.slice(cursor));
  return out.join('\n');
}

/**
 * Arti's Cargo.lock, rewritten for a `[patch.crates-io]` path override of
 * `name` `version`: that package entry loses its registry `source` and
 * `checksum`, exactly what cargo itself writes for the override, so
 * `--locked` still holds every other package to the published lock file. The
 * registry checksum being dropped must be `expectedChecksum` — the crate the
 * patch was written against.
 * @param {string} lockText
 * @param {string} name
 * @param {string} version
 * @param {string} expectedChecksum
 * @returns {string}
 */
function lockWithPathOverride(lockText, name, version, expectedChecksum) {
  const text = String(lockText);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const blocks = text.split(`${eol}${eol}`);
  const matches = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => {
      const lines = block.split(eol);
      return (
        lines[0] === '[[package]]' &&
        lines.includes(`name = "${name}"`) &&
        lines.includes(`version = "${version}"`)
      );
    });
  if (matches.length !== 1) {
    throw new Error(`Cargo.lock has ${matches.length} entries for ${name} ${version}, expected 1`);
  }
  const { block, index } = matches[0];
  const lines = block.split(eol);
  const source = lines.filter((line) => line.startsWith('source = '));
  const checksum = lines.filter((line) => line.startsWith('checksum = '));
  if (
    source.length !== 1 ||
    source[0] !== 'source = "registry+https://github.com/rust-lang/crates.io-index"' ||
    checksum.length !== 1
  ) {
    throw new Error(`Cargo.lock's ${name} ${version} is not a single crates.io package`);
  }
  if (checksum[0] !== `checksum = "${expectedChecksum}"`) {
    throw new Error(
      `Cargo.lock pins ${name} ${version} as ${checksum[0]}, but the patch was written ` +
        `against ${expectedChecksum}`
    );
  }
  blocks[index] = lines
    .filter((line) => !line.startsWith('source = ') && !line.startsWith('checksum = '))
    .join(eol);
  return blocks.join(`${eol}${eol}`);
}

/**
 * Download a crate from crates.io, check its sha256 and unpack it under
 * `parent`. Returns the crate root (`<parent>/<name>-<version>`).
 * @param {string} name
 * @param {string} version
 * @param {string} expectedSha256
 * @param {string} parent
 * @param {{download?: Function, extract?: Function}} [options]
 */
async function fetchCrate(name, version, expectedSha256, parent, options = {}) {
  const download =
    options.download ||
    ((url, file) =>
      downloadToFile(url, file, { maxBytes: 64 * 1024 * 1024, timeoutMs: TIMEOUTS.binary }));
  // Same tar handling and archive-listing checks as the prebuilt archives.
  const extract = options.extract || require('./prebuilt-natives').extractArchive;
  const url = crateUrl(name, version);
  const archive = path.join(parent, `${name}-${version}.crate`);
  await download(url, archive);
  const actual = sha256(fs.readFileSync(archive));
  if (actual !== expectedSha256) {
    throw new Error(`${url} has sha256 ${actual}, expected ${expectedSha256}`);
  }
  const unpacked = path.join(parent, name);
  extract(archive, unpacked);
  const root = path.join(unpacked, `${name}-${version}`);
  if (!fs.existsSync(path.join(root, 'Cargo.toml'))) {
    throw new Error(`${url} did not unpack to ${name}-${version}/Cargo.toml`);
  }
  return root;
}

/**
 * Prepare the patched Windows build in `workDir`: the pinned Arti crate
 * source with its lock file adjusted, and every patched dependency. Returns
 * `{ artiDir, overrides }`, where `overrides` maps crate name to its patched
 * source directory for installArgs().
 * @param {string} workDir
 * @param {Array<typeof WINDOWS_CRATE_PATCHES[number]>} patches
 * @param {object} [options] fetchCrate() overrides; `root` (for the patch
 *   files) and `artiCrateSha256` for the tests
 */
async function preparePatchedSources(workDir, patches, options = {}) {
  const root = options.root || REPO_ROOT;
  const artiSha256 = options.artiCrateSha256 || ARTI_CRATE_SHA256;
  const artiDir = await fetchCrate('arti', PINNED_ARTI_VERSION, artiSha256, workDir, options);
  const lockFile = path.join(artiDir, 'Cargo.lock');
  let lock = fs.readFileSync(lockFile, 'utf8');
  const overrides = {};
  for (const spec of patches) {
    const crateDir = await fetchCrate(spec.name, spec.version, spec.sha256, workDir, options);
    const target = path.join(crateDir, spec.file);
    const patchText = fs.readFileSync(path.join(root, spec.patch), 'utf8');
    const patched = applyUnifiedPatch(fs.readFileSync(target, 'utf8'), patchText);
    if (sha256(patched) !== spec.patchedSha256) {
      throw new Error(
        `${spec.patch} produced ${spec.file} with sha256 ${sha256(patched)}, ` +
          `expected ${spec.patchedSha256}`
      );
    }
    fs.writeFileSync(target, patched);
    lock = lockWithPathOverride(lock, spec.name, spec.version, spec.sha256);
    overrides[spec.name] = crateDir;
    console.log(`Patched ${spec.name} ${spec.version} with ${spec.patch}`);
  }
  fs.writeFileSync(lockFile, lock);
  return { artiDir, overrides };
}

/**
 * Resource directory name for a host, e.g. `win-x64`. Kept identical to
 * `getArtiBinaryPath()` in `src/main/tor-manager.js` — the app looks the
 * binary up by exactly this name in a dev tree.
 * @param {NodeJS.Platform} [platform]
 * @param {string} [arch]
 */
function platformKey(platform = process.platform, arch = process.arch) {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  return `${platformMap[platform] || platform}-${arch}`;
}

/**
 * Name cargo gives the built binary, and the name the app looks for.
 * @param {NodeJS.Platform} [platform]
 */
function artiBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'arti.exe' : 'arti';
}

/**
 * Extra cargo features needed to build the pinned Arti on a given host.
 *
 * Windows has no system SQLite to link against, and `libsqlite3-sys` falls
 * through to emitting a bare `-l sqlite3` when neither pkg-config nor vcpkg
 * finds one, so the link fails with `LNK1181: cannot open input file
 * 'sqlite3.lib'` (observed 2026-09-09 on `windows-latest`, MSVC 14.51, Arti
 * 2.6.0). Arti's own `static-sqlite` feature switches rusqlite to its bundled
 * amalgamation, which the MSVC toolchain compiles as part of the build. macOS
 * uses it too, so a pkg-config-discovered Homebrew SQLite can never end up
 * linked into the shipped binary (see cargoEnv). Linux keeps linking the
 * system library it always has.
 *
 * Re-check this list when bumping the pin: it is Arti's feature name, not a
 * dependency's, and a major version may rename or drop it.
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function cargoFeatures(platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? ['static-sqlite'] : [];
}

/**
 * Extra environment for the cargo build on a given host.
 *
 * macOS: the shipped binary may link only libraries every Mac has (see
 * nonSystemDylibs below). The release runners have Homebrew's xz installed,
 * and `lzma-sys` links a pkg-config-discovered liblzma dynamically, so the
 * 2.6.0 nightly shipped an `arti` that loaded
 * `/opt/homebrew/opt/xz/lib/liblzma.5.dylib`. That fails on every Mac without
 * Homebrew xz, and on Macs *with* it once library validation is on (O-11
 * dropped `disable-library-validation`), because Homebrew's dylib carries a
 * different Team ID. `LZMA_API_STATIC` makes lzma-sys build and link its
 * bundled xz statically instead.
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
function cargoEnv(platform = process.platform) {
  return platform === 'darwin' ? { LZMA_API_STATIC: '1' } : {};
}

// Where a dylib a shipped macOS binary links may live: the OS itself.
const MAC_SYSTEM_DYLIB_PREFIXES = ['/usr/lib/', '/System/Library/'];

/**
 * Dylibs in `otool -L` output that are not part of macOS itself — anything
 * under /opt/homebrew, /usr/local, a build tree, or an @rpath the app does not
 * provide. The first line of `otool -L` names the file itself and is skipped.
 * @param {string} otoolOutput
 * @returns {string[]}
 */
function nonSystemDylibs(otoolOutput) {
  return String(otoolOutput)
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, ''))
    .filter(Boolean)
    .filter((lib) => !MAC_SYSTEM_DYLIB_PREFIXES.some((prefix) => lib.startsWith(prefix)));
}

/**
 * The exact `cargo install` argv used to build the pinned Arti. With
 * `patched` (from preparePatchedSources), it installs from that crate source
 * instead of the registry and adds one `[patch.crates-io]` override per
 * patched dependency; `--locked` holds either way.
 * @param {string} version
 * @param {string} installRoot
 * @param {NodeJS.Platform} [platform]
 * @param {{artiDir: string, overrides: Record<string, string>}} [patched]
 */
function installArgs(version, installRoot, platform = process.platform, patched = null) {
  const args = patched
    ? ['install', '--path', patched.artiDir, '--locked', '--root', installRoot]
    : ['install', 'arti', '--version', version, '--locked', '--root', installRoot];
  const features = cargoFeatures(platform);
  if (features.length > 0) {
    args.push('--features', features.join(','));
  }
  if (patched) {
    for (const [name, dir] of Object.entries(patched.overrides)) {
      // A TOML basic string: JSON escaping is valid TOML for a path.
      args.push('--config', `patch.crates-io.${name}.path=${JSON.stringify(dir)}`);
    }
  }
  return args;
}

/** `cargo --version` output, or null when cargo is not runnable. */
function readCargoVersionOutput() {
  try {
    return String(execFileSync(CARGO_BIN, ['--version'], { stdio: 'pipe' }));
  } catch {
    return null;
  }
}

/** Compare dotted numeric versions; returns <0, 0 or >0 like a sort comparator. */
function compareVersions(a, b) {
  const parse = (v) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fail early when the toolchain predates the pinned Arti's MSRV. Cargo and
 * rustc share a version number, so `cargo --version` is enough. An output we
 * cannot parse is not treated as a failure — cargo itself still enforces the
 * MSRV, this check only makes the common case fail fast with a fix. Likewise
 * an ARTI_VERSION override, whose MSRV is not MIN_RUST_VERSION: warn, and
 * leave the real decision to cargo.
 * @param {string} cargoVersionOutput
 * @param {string} [artiVersion] version being built (default: ARTI_VERSION)
 * @returns {boolean} false when the toolchain is definitely too old
 */
function checkRustVersion(cargoVersionOutput, artiVersion = ARTI_VERSION) {
  const match = String(cargoVersionOutput).match(/\b(\d+\.\d+\.\d+)\b/);
  if (!match) return true;
  if (compareVersions(match[1], MIN_RUST_VERSION) >= 0) return true;
  if (artiVersion !== PINNED_ARTI_VERSION) {
    console.warn(
      `\nWarning: ${CARGO_BIN} reports Rust ${match[1]}, below the Rust ` +
        `${MIN_RUST_VERSION} that the pinned Arti ${PINNED_ARTI_VERSION} needs.\n` +
        `Building the requested Arti ${artiVersion} anyway — its own MSRV is not ` +
        'known here, and cargo enforces it.\n'
    );
    return true;
  }
  console.error(
    `\nError: Arti ${PINNED_ARTI_VERSION} requires Rust ${MIN_RUST_VERSION} or later, ` +
      `but ${CARGO_BIN} reports ${match[1]}.\n` +
      'Update the toolchain (`rustup update stable`) and re-run.\n'
  );
  return false;
}

/**
 * The network half of this script is cargo's: it resolves the index and
 * downloads every crate in Arti's tree from crates.io. Those failures look
 * nothing like an HTTP status, so the shared retry loop
 * (scripts/lib/fetch-with-retry.js) is given a classifier that reads cargo's
 * own words for them. Everything else — a compile error, a missing MSRV, the
 * Windows `LNK1181` — fails on the first attempt: retrying a multi-minute
 * build that is going to fail identically wastes a release runner's time and
 * buries the real error four copies deep.
 *
 * Phrases observed from cargo 1.9x; `cargo` retries spurious network errors a
 * few times itself before printing these, so reaching one means its own
 * retries are already spent.
 */
const RETRYABLE_CARGO_OUTPUT =
  /(spurious network error|failed to download|failed to fetch|network failure|error sending request|connection reset|connection closed|could not resolve host|temporary failure in name resolution|operation timed out|timed out|unexpected eof|failed to get 200 response|failed to update registry)/i;

/**
 * Deterministic failures, which *veto* the network match above. The tail is a
 * window over the whole build, not just its last line, so a network hiccup
 * cargo recovered from on its own ("warning: spurious network error (3 tries
 * remaining)") can still be sitting in it when the build later dies of an MSRV
 * or compile error — a positive network match alone would then spend four
 * multi-minute attempts on a failure that reproduces identically. A build that
 * got far enough to emit one of these reached rustc or the linker, so whatever
 * the network did earlier it recovered from.
 *
 * Only markers that rustc, the linker or the MSRV check emit are listed.
 * Cargo's own `failed to compile \`arti v2.6.0\`` wrapper is deliberately *not*
 * here: `cargo install` wraps a crate *download* failure in it too, so vetoing
 * on it would stop retrying the exact class this loop exists for.
 */
const DETERMINISTIC_CARGO_OUTPUT =
  /(error\[E\d+\]|LNK\d{4}|requires rustc|could not compile|linking with .* failed)/i;

/** @param {string} output cargo's stderr (tail) */
function isRetryableCargoFailure(output) {
  const text = String(output || '');
  if (DETERMINISTIC_CARGO_OUTPUT.test(text)) return false;
  return RETRYABLE_CARGO_OUTPUT.test(text);
}

// Enough of cargo's stderr to classify the failure, without holding a whole
// build log in memory.
const CARGO_STDERR_TAIL_BYTES = 64 * 1024;

/**
 * One `cargo install` run. stderr is teed rather than swallowed: the build
 * takes minutes and its progress has to stay visible, but the tail is also
 * kept so the failure can be classified.
 * @param {string[]} args
 * @param {{spawnFn?: typeof spawn}} [options]
 */
function runCargoInstall(args, options = {}) {
  const spawnFn = options.spawnFn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(CARGO_BIN, args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, ...cargoEnv() },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-CARGO_STDERR_TAIL_BYTES);
    });
    // A spawn failure (no cargo on PATH) is not a network blip.
    child.on('error', (error) => reject(Object.assign(error, { retryable: false })));
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(new Error(`cargo install arti exited with code ${code}`), {
          retryable: isRetryableCargoFailure(stderr),
        })
      );
    });
  });
}

/**
 * Build Arti, retrying only crates.io/network failures.
 * @param {string[]} args
 * @param {object} [options] `spawnFn` plus retry-loop overrides, used by the tests
 */
function buildArti(args, options = {}) {
  const attempts = options.attempts || MAX_ATTEMPTS;
  return withRetry(
    `cargo install arti ${ARTI_VERSION}`,
    (attempt) => {
      if (attempt > 1) {
        console.warn(`\nRetrying the Arti build (attempt ${attempt} of ${attempts})...`);
      }
      return runCargoInstall(args, options);
    },
    options
  );
}

async function main() {
  const cargoVersionOutput = readCargoVersionOutput();
  if (cargoVersionOutput === null) {
    console.error(
      '\nError: `cargo` (Rust toolchain) not found.\n' +
        'Arti has no clean prebuilt-binary distribution, so it is built from\n' +
        'crates.io. Install Rust (https://rustup.rs) and re-run, or set CARGO_BIN.\n'
    );
    process.exitCode = 1;
    return;
  }
  if (!checkRustVersion(cargoVersionOutput)) {
    process.exitCode = 1;
    return;
  }

  const target = platformKey();
  const targetDir = path.join(OUTPUT_DIR, target);
  const binName = artiBinaryName();
  const destBin = path.join(targetDir, binName);

  fs.mkdirSync(targetDir, { recursive: true });

  if (process.platform === 'win32' && cratePatches().length === 0) {
    console.warn(
      `\nWarning: building Arti ${ARTI_VERSION} on Windows without the saturating-time ` +
        `patch, which is pinned to Arti ${PINNED_ARTI_VERSION} only. Without the fix Tor ` +
        'never bootstraps on Windows (#925); check that this release carries upstream ' +
        'MR 4520 (#926).\n'
    );
  }

  // Install into a temp root, then copy just the binary into place. Using a
  // dedicated root keeps cargo's bookkeeping out of the repo tree.
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-install-'));
  // Patched crate sources (Windows), kept short for MAX_PATH.
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-src-'));
  let ok = false;

  const features = cargoFeatures();
  console.log(
    `Building arti ${ARTI_VERSION} for ${target}` +
      (features.length > 0 ? ` (features: ${features.join(',')})` : '') +
      ' (this can take several minutes)...'
  );
  try {
    const patches = cratePatches();
    const patched = patches.length > 0 ? await preparePatchedSources(sourceRoot, patches) : null;
    await buildArti(installArgs(ARTI_VERSION, installRoot, process.platform, patched));

    const builtBin = path.join(installRoot, 'bin', binName);
    if (!fs.existsSync(builtBin)) {
      console.error(`\nError: arti binary not found at ${builtBin} after build.`);
    } else {
      const foreign =
        process.platform === 'darwin'
          ? nonSystemDylibs(execFileSync('otool', ['-L', builtBin], { encoding: 'utf8' }))
          : [];
      if (foreign.length > 0) {
        console.error(
          `\nError: the built arti links libraries that are not part of macOS:\n` +
            foreign.map((lib) => `  ${lib}`).join('\n') +
            '\nIt would fail to launch on Macs without them (and under library\n' +
            'validation even with them). Link them statically; see cargoEnv().'
        );
      } else {
        fs.copyFileSync(builtBin, destBin);
        if (process.platform !== 'win32') {
          fs.chmodSync(destBin, 0o755);
        }
        console.log(`\nInstalled arti for ${target} -> ${destBin}`);
        ok = true;
      }
    }
  } catch (err) {
    console.error(`\nError: building arti failed: ${err.message}`);
  } finally {
    // Always clean up the temp install and source roots, even on failure.
    for (const dir of [installRoot, sourceRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Not process.exit(): on Node 24 it can hang forever joining V8's
  // background compiler threads — see the note at the end of
  // scripts/fetch-ant.js's main() (#544, nodejs/node#64274).
  process.exitCode = ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  });
}

// Exported for unit tests; `npm run tor:download` still runs main() above.
module.exports = {
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
  runCargoInstall,
  buildArti,
};
