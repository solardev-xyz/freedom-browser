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
 * Env:
 *   ARTI_VERSION   crates.io version to install (default: pinned below; an
 *                  override also downgrades the MSRV pre-flight to a warning)
 *   CARGO_BIN      path to cargo (default: 'cargo' on PATH)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Pin a known-good Arti release. Bump deliberately and re-test the SOCKS flags
// (`arti proxy -c <config>`) and the `arti.toml` keys tor-manager.js writes.
const PINNED_ARTI_VERSION = '2.6.0';
const ARTI_VERSION = process.env.ARTI_VERSION || PINNED_ARTI_VERSION;
// MSRV of PINNED_ARTI_VERSION only (Arti 2.6.0 raised it to 1.91) — bump it in
// the same commit as the pin. Checked up front because `cargo install` only
// reports a too-old toolchain after it has resolved and started compiling the
// dependency tree, minutes into the build. An ARTI_VERSION override has its own
// MSRV, which this script does not know, so the check downgrades to a warning
// there rather than blocking a build cargo may well accept.
const MIN_RUST_VERSION = '1.91.0';
const CARGO_BIN = process.env.CARGO_BIN || 'cargo';

const OUTPUT_DIR = path.join(__dirname, '..', 'arti-bin');

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
 * and Linux keep linking the system library they always have — changing what
 * they link is not this script's business.
 *
 * Re-check this list when bumping the pin: it is Arti's feature name, not a
 * dependency's, and a major version may rename or drop it.
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
function cargoFeatures(platform = process.platform) {
  return platform === 'win32' ? ['static-sqlite'] : [];
}

/**
 * The exact `cargo install` argv used to build the pinned Arti.
 * @param {string} version
 * @param {string} installRoot
 * @param {NodeJS.Platform} [platform]
 */
function installArgs(version, installRoot, platform = process.platform) {
  const args = ['install', 'arti', '--version', version, '--locked', '--root', installRoot];
  const features = cargoFeatures(platform);
  if (features.length > 0) {
    args.push('--features', features.join(','));
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

function main() {
  const cargoVersionOutput = readCargoVersionOutput();
  if (cargoVersionOutput === null) {
    console.error(
      '\nError: `cargo` (Rust toolchain) not found.\n' +
        'Arti has no clean prebuilt-binary distribution, so it is built from\n' +
        'crates.io. Install Rust (https://rustup.rs) and re-run, or set CARGO_BIN.\n'
    );
    process.exit(1);
  }
  if (!checkRustVersion(cargoVersionOutput)) {
    process.exit(1);
  }

  const target = platformKey();
  const targetDir = path.join(OUTPUT_DIR, target);
  const binName = artiBinaryName();
  const destBin = path.join(targetDir, binName);

  fs.mkdirSync(targetDir, { recursive: true });

  // Install into a temp root, then copy just the binary into place. Using a
  // dedicated root keeps cargo's bookkeeping out of the repo tree.
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-install-'));
  let ok = false;

  const args = installArgs(ARTI_VERSION, installRoot);
  const features = cargoFeatures();
  console.log(
    `Building arti ${ARTI_VERSION} for ${target}` +
      (features.length > 0 ? ` (features: ${features.join(',')})` : '') +
      ' (this can take several minutes)...'
  );
  try {
    execFileSync(CARGO_BIN, args, { stdio: 'inherit' });

    const builtBin = path.join(installRoot, 'bin', binName);
    if (!fs.existsSync(builtBin)) {
      console.error(`\nError: arti binary not found at ${builtBin} after build.`);
    } else {
      fs.copyFileSync(builtBin, destBin);
      if (process.platform !== 'win32') {
        fs.chmodSync(destBin, 0o755);
      }
      console.log(`\nInstalled arti for ${target} -> ${destBin}`);
      ok = true;
    }
  } catch (err) {
    console.error(`\nError: cargo install arti failed: ${err.message}`);
  } finally {
    // Always clean up the temp install root, even on failure.
    try {
      fs.rmSync(installRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

// Exported for unit tests; `npm run tor:download` still runs main() above.
module.exports = {
  ARTI_VERSION,
  PINNED_ARTI_VERSION,
  MIN_RUST_VERSION,
  compareVersions,
  checkRustVersion,
  platformKey,
  artiBinaryName,
  cargoFeatures,
  installArgs,
};
