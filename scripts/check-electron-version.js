/**
 * Assert the Electron actually installed in `node_modules` is the one
 * `package-lock.json` pins.
 *
 * Why this exists (issue #346): a Chrome Web Store detail page killed the
 * browser process on Electron 44.3.0, and the Linux runs of that repro kept
 * coming back clean. The lockfile said 44.3.0 but `node_modules/electron` was
 * still 43.4.1 from an earlier install — 43 predates the Chromium 152 roll
 * that introduced the bug, so `electron .` and any `electron-builder` package
 * produced from that tree ran, and shipped, a completely different Electron
 * from the one CI and the lockfile describe. Nothing in the repo noticed.
 *
 * The installed npm package's version is the load-bearing one. It is what
 * `electron .` runs, what the e2e suites launch, and — traced through the
 * installed app-builder-lib, not assumed — what electron-builder packages:
 * `computeElectronVersion()` reads `node_modules/electron/package.json` first
 * and only falls back to the package.json range when electron isn't installed
 * at all. So a stale node_modules doesn't just mislead a dev run, it ships.
 *
 * `node_modules/electron/dist/version` (the downloaded binary) is compared too,
 * but only when it exists: electron 44 has no postinstall script — its
 * `index.js` downloads the binary lazily on the first `require('electron')` —
 * so a freshly `npm ci`'d tree legitimately has no `dist/` yet, and several CI
 * jobs install with `--ignore-scripts` and never launch the app at all.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const LOCKFILE_PATH = path.join(repoRoot, 'package-lock.json');
const ELECTRON_PACKAGE_JSON = path.join(repoRoot, 'node_modules', 'electron', 'package.json');
const ELECTRON_DIST_VERSION = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'version');

const FIX_HINT = 'run `npm ci` to install the Electron the lockfile pins';

function readLockedElectronVersion(lockfilePath = LOCKFILE_PATH) {
  const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'));
  return lock.packages?.['node_modules/electron']?.version ?? null;
}

function readInstalledElectronVersion(packageJsonPath = ELECTRON_PACKAGE_JSON) {
  if (!fs.existsSync(packageJsonPath)) return null;
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).version ?? null;
}

/**
 * The version of the downloaded binary. Electron's own installer writes this
 * file next to the executable it just unpacked, so it catches a `dist/` that
 * does not match the package around it. Returns null when the binary has not
 * been downloaded yet — electron 44 fetches it lazily, on first use.
 */
function readInstalledBinaryVersion(distVersionPath = ELECTRON_DIST_VERSION) {
  if (!fs.existsSync(distVersionPath)) return null;
  const raw = fs.readFileSync(distVersionPath, 'utf-8').trim();
  if (!raw) return null;
  return raw.startsWith('v') ? raw.slice(1) : raw;
}

/**
 * Pure comparison, so the rules are unit-testable without an install on disk.
 * Returns an array of human-readable problems; empty means "agrees".
 */
function checkElectronVersion({ locked, installed, binary } = {}) {
  const problems = [];

  if (!locked) {
    problems.push('package-lock.json has no node_modules/electron entry — the lockfile is broken');
    return problems;
  }

  if (!installed) {
    problems.push(
      `electron is not installed in node_modules (lockfile pins ${locked}) — ${FIX_HINT}`
    );
  } else if (installed !== locked) {
    problems.push(
      `node_modules/electron is ${installed} but package-lock.json pins ${locked} — ${FIX_HINT}`
    );
  }

  // No binary yet is not a problem: electron 44 downloads it on first use.
  if (binary !== null && binary !== undefined && binary !== locked) {
    problems.push(
      `the downloaded Electron binary is ${binary} but package-lock.json pins ${locked} — ${FIX_HINT}`
    );
  }

  return problems;
}

/** Read all three versions off disk and compare them. */
function checkInstalledElectronVersion() {
  return checkElectronVersion({
    locked: readLockedElectronVersion(),
    installed: readInstalledElectronVersion(),
    binary: readInstalledBinaryVersion(),
  });
}

function main() {
  const problems = checkInstalledElectronVersion();
  if (problems.length > 0) {
    console.error('\n❌ Electron version mismatch:\n');
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('');
    process.exit(1);
  }
  console.log(`✅ Electron ${readLockedElectronVersion()} installed, matching package-lock.json.`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  LOCKFILE_PATH,
  ELECTRON_PACKAGE_JSON,
  ELECTRON_DIST_VERSION,
  readLockedElectronVersion,
  readInstalledElectronVersion,
  readInstalledBinaryVersion,
  checkElectronVersion,
  checkInstalledElectronVersion,
  main,
};
