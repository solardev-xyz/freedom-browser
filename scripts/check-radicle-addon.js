/**
 * Load a downloaded libradicle addon and verify it is usable by this app.
 *
 * The addon is the only Radicle runtime, so a release asset built for the
 * wrong ABI, or missing an export the app calls, has to fail in CI rather
 * than in a packaged build. Deliberately does NOT require any main-process
 * module (electron is not available on a plain `node` run) — the export
 * list comes from src/shared/radicle-addon-version.js, the same list
 * radicle-embedded.js loads by.
 *
 * Usage:
 *   node scripts/check-radicle-addon.js [path/to/libradicle.node]
 *   RADICLE_ADDON=radicle-bin/linux-x64/libradicle.node node scripts/check-radicle-addon.js
 *
 * With no argument it checks the host platform's development prebuilt.
 */

const path = require('path');
const fs = require('fs');
const {
  RADICLE_ADDON_VERSION,
  RADICLE_ADDON_REQUIRED_EXPORTS,
} = require('../src/shared/radicle-addon-version');

function hostKey() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `mac-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `linux-${arch}`;
}

function resolveAddonPath(argv = process.argv.slice(2), env = process.env) {
  const explicit = argv[0] || env.RADICLE_ADDON;
  if (explicit) return path.resolve(explicit);
  return path.join(__dirname, '..', 'radicle-bin', hostKey(), 'libradicle.node');
}

async function checkAddon(addonPath) {
  if (!fs.existsSync(addonPath)) {
    throw new Error(`addon not found at ${addonPath} — run \`npm run radicle:download\` first`);
  }
  const addon = require(addonPath);
  const missing = RADICLE_ADDON_REQUIRED_EXPORTS.filter(
    (name) => typeof addon[name] !== 'function'
  );
  if (missing.length) {
    throw new Error(`addon is missing required exports: ${missing.join(', ')}`);
  }
  // Smoke: a read-only call proves the native code actually runs on this
  // platform/ABI, not just that the library loaded. Every export resolves
  // to a JSON string (radicle-embedded.js parses them); a stopped node
  // answers `{"error":"node not started"}` — that is a pass. A throw, a
  // rejection or a non-JSON answer is not.
  let raw;
  try {
    raw = await addon.status();
  } catch (err) {
    throw new Error(`addon.status() failed on this platform: ${err.message}`, { cause: err });
  }
  if (typeof raw !== 'string') {
    throw new Error(`addon.status() resolved to ${typeof raw}, expected a JSON string`);
  }
  JSON.parse(raw);
  return { addonPath, exports: RADICLE_ADDON_REQUIRED_EXPORTS.length, status: raw };
}

if (require.main === module) {
  checkAddon(resolveAddonPath())
    .then((result) => {
      console.log(
        `libradicle v${RADICLE_ADDON_VERSION} OK on ${process.platform}-${process.arch}: ` +
          `${result.exports} exports, status ${result.status}`
      );
      // The addon keeps native threads alive; nothing else is pending.
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { checkAddon, resolveAddonPath, hostKey };
