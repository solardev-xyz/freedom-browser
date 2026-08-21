/**
 * Fetch (build) the Arti Tor client binary.
 *
 * Unlike Bee / Radicle, the Tor Project does not publish a clean, scriptable
 * set of prebuilt `arti` binaries. The reliable, official, pinnable source is
 * crates.io, so we build from source with `cargo install`. This requires a
 * Rust toolchain (`cargo`) on the build machine.
 *
 * The binary is placed at `arti-bin/<platform>-<arch>/arti` to match the
 * layout that `src/main/tor-manager.js#getArtiBinaryPath` and the
 * electron-builder `extraResources` entries expect.
 *
 * Cross-compilation is out of scope here (it needs per-target toolchains), so
 * this builds for the host platform/arch only — mirroring how the Docker dist
 * jobs fetch host-only Radicle binaries.
 *
 * Env:
 *   ARTI_VERSION   crates.io version to install (default: pinned below)
 *   CARGO_BIN      path to cargo (default: 'cargo' on PATH)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Pin a known-good Arti release. Bump deliberately and re-test the SOCKS flags.
const ARTI_VERSION = process.env.ARTI_VERSION || '1.4.4';
const CARGO_BIN = process.env.CARGO_BIN || 'cargo';

const OUTPUT_DIR = path.join(__dirname, '..', 'arti-bin');

function platformKey() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  return `${platform}-${process.arch}`;
}

function hasCargo() {
  try {
    execFileSync(CARGO_BIN, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!hasCargo()) {
    console.error(
      '\nError: `cargo` (Rust toolchain) not found.\n' +
        'Arti has no clean prebuilt-binary distribution, so it is built from\n' +
        'crates.io. Install Rust (https://rustup.rs) and re-run, or set CARGO_BIN.\n'
    );
    process.exit(1);
  }

  const target = platformKey();
  const targetDir = path.join(OUTPUT_DIR, target);
  const binName = process.platform === 'win32' ? 'arti.exe' : 'arti';
  const destBin = path.join(targetDir, binName);

  fs.mkdirSync(targetDir, { recursive: true });

  // Install into a temp root, then copy just the binary into place. Using a
  // dedicated root keeps cargo's bookkeeping out of the repo tree.
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arti-install-'));
  let ok = false;

  console.log(`Building arti ${ARTI_VERSION} for ${target} (this can take several minutes)...`);
  try {
    execFileSync(
      CARGO_BIN,
      ['install', 'arti', '--version', ARTI_VERSION, '--locked', '--root', installRoot],
      { stdio: 'inherit' }
    );

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

main();
