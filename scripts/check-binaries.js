const fs = require('fs');
const path = require('path');

const ANT_BIN_DIR = path.join(__dirname, '..', 'ant-bin');
const FREEDOM_IPFS_NATIVE_PREBUILDS_DIR = path.join(
  __dirname,
  '..',
  'native',
  'freedom-ipfs-node',
  'prebuilds'
);
const FREEDOM_IPFS_NATIVE_ADDON = 'freedom_ipfs_native.node';
const RADICLE_BIN_DIR = path.join(__dirname, '..', 'radicle-bin');
const MYOTIS_BIN_DIR = path.join(__dirname, '..', 'myotis-bin');
// Targets the Myotis release publishes addons for (see scripts/fetch-myotis.js).
// Anything else (e.g. win-arm64) is skipped with a notice — the app degrades
// gracefully to Colibri/quorum when the addon is absent.
const MYOTIS_SUPPORTED = new Set(['mac-x64', 'mac-arm64', 'linux-x64', 'linux-arm64', 'win-x64']);
const ARTI_BIN_DIR = path.join(__dirname, '..', 'arti-bin');

function getPlatformArch() {
  const args = process.argv.slice(2);
  const platforms = [];

  // Parse command line args to determine target platforms
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--mac') {
      const nextArg = args[i + 1];
      if (nextArg === '--arm64' || args.includes('--arm64')) {
        platforms.push({ os: 'mac', arch: 'arm64' });
      }
      if (nextArg === '--x64' || args.includes('--x64')) {
        platforms.push({ os: 'mac', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        // Default to current architecture
        platforms.push({ os: 'mac', arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
      }
    } else if (arg === '--linux') {
      if (args.includes('--arm64')) {
        platforms.push({ os: 'linux', arch: 'arm64' });
      }
      if (args.includes('--x64')) {
        platforms.push({ os: 'linux', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        platforms.push({ os: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
      }
    } else if (arg === '--win') {
      if (args.includes('--arm64')) {
        platforms.push({ os: 'win', arch: 'arm64' });
      }
      if (args.includes('--x64')) {
        platforms.push({ os: 'win', arch: 'x64' });
      }
      if (!args.includes('--arm64') && !args.includes('--x64')) {
        platforms.push({ os: 'win', arch: 'x64' });
      }
    }
    i++;
  }

  // If no platform specified, use current platform
  if (platforms.length === 0) {
    let os;
    switch (process.platform) {
      case 'darwin':
        os = 'mac';
        break;
      case 'win32':
        os = 'win';
        break;
      default:
        os = 'linux';
    }
    platforms.push({ os, arch: process.arch === 'arm64' ? 'arm64' : 'x64' });
  }

  return platforms;
}

function checkBinaries(platforms) {
  const missing = [];

  // Platform-independent: bundled adblock filter lists (assets/adblock is
  // gitignored; populated by npm run adblock:download).
  const adblockManifest = path.join(__dirname, '..', 'assets', 'adblock', 'manifest.json');
  if (!fs.existsSync(adblockManifest)) {
    missing.push(`adblock filter lists: ${adblockManifest}`);
  }

  for (const { os, arch } of platforms) {
    const platformDir = `${os}-${arch}`;
    const antExt = os === 'win' ? '.exe' : '';

    const antPath = path.join(ANT_BIN_DIR, platformDir, `antd${antExt}`);

    if (!fs.existsSync(antPath)) {
      missing.push(`antd binary for ${platformDir}: ${antPath}`);
    }

    const freedomIpfsAddonPath = path.join(
      FREEDOM_IPFS_NATIVE_PREBUILDS_DIR,
      platformDir,
      FREEDOM_IPFS_NATIVE_ADDON
    );
    if (!fs.existsSync(freedomIpfsAddonPath)) {
      missing.push(`freedom-ipfs native addon for ${platformDir}: ${freedomIpfsAddonPath}`);
    }

    // Myotis: required where the release publishes an addon; electron-builder
    // would otherwise silently skip the missing extraResources dir and ship a
    // build with the feature permanently unavailable.
    if (MYOTIS_SUPPORTED.has(platformDir)) {
      const myotisAddonPath = path.join(MYOTIS_BIN_DIR, platformDir, 'myotis-node.node');
      if (!fs.existsSync(myotisAddonPath)) {
        missing.push(`myotis-node addon for ${platformDir}: ${myotisAddonPath}`);
      }
    } else {
      console.log(`  (myotis-node: no addon published for ${platformDir} — skipping)`);
    }

    // Radicle: no official Windows binaries yet — skip check for win targets
    if (os !== 'win') {
      const nodePath = path.join(RADICLE_BIN_DIR, platformDir, 'radicle-node');
      const httpdPath = path.join(RADICLE_BIN_DIR, platformDir, 'radicle-httpd');

      if (!fs.existsSync(nodePath)) {
        missing.push(`radicle-node binary for ${platformDir}: ${nodePath}`);
      }
      if (!fs.existsSync(httpdPath)) {
        missing.push(`radicle-httpd binary for ${platformDir}: ${httpdPath}`);
      }
    }
  }

  return missing;
}

/**
 * Arti (Tor) is OPTIONAL and built from source via `npm run tor:download`
 * (cargo), unlike the prebuilt Bee/Radicle downloads. It is intentionally not
 * a required build binary: when absent, Tor simply isn't bundled and the
 * in-app toggle stays disabled. We still create the per-platform resource dir
 * so electron-builder's `extraResources` entry resolves cleanly instead of
 * failing late during packaging.
 */
function ensureOptionalArti(platforms) {
  for (const { os, arch } of platforms) {
    if (os === 'win') continue; // Arti is bundled for macOS/Linux only
    const platformDir = `${os}-${arch}`;
    const artiPath = path.join(ARTI_BIN_DIR, platformDir, 'arti');
    if (!fs.existsSync(artiPath)) {
      fs.mkdirSync(path.join(ARTI_BIN_DIR, platformDir), { recursive: true });
      console.warn(
        `⚠️  Arti (Tor) binary not found for ${platformDir} — Tor will not be bundled.\n` +
          `   Optional; build it with: npm run tor:download  (requires a Rust toolchain)`
      );
    }
  }
}

function main() {
  const platforms = getPlatformArch();
  console.log(`Checking binaries for: ${platforms.map((p) => `${p.os}-${p.arch}`).join(', ')}`);

  const missing = checkBinaries(platforms);

  if (missing.length > 0) {
    console.error('\n❌ Build cannot proceed. Missing binaries:\n');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('\nRun the following commands to download binaries:');
    console.error('  npm run ant:download');
    console.error('  npm run ipfs:download');
    console.error('  npm run radicle:download');
    console.error('  npm run myotis:download');
    console.error('  npm run adblock:download\n');
    process.exit(1);
  }

  // Optional binaries (non-fatal): warn and prepare resource dirs.
  ensureOptionalArti(platforms);

  console.log('✅ All required binaries found.\n');
  process.exit(0);
}

main();
