const fs = require('fs');
const path = require('path');

const BEE_BIN_DIR = path.join(__dirname, '..', 'bee-bin');
const IPFS_BIN_DIR = path.join(__dirname, '..', 'ipfs-bin');

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

  for (const { os, arch } of platforms) {
    const platformDir = `${os}-${arch}`;
    const beeExt = os === 'win' ? '.exe' : '';
    const ipfsExt = os === 'win' ? '.exe' : '';

    const beePath = path.join(BEE_BIN_DIR, platformDir, `bee${beeExt}`);
    const ipfsPath = path.join(IPFS_BIN_DIR, platformDir, `ipfs${ipfsExt}`);

    if (!fs.existsSync(beePath)) {
      missing.push(`bee binary for ${platformDir}: ${beePath}`);
    }
    if (!fs.existsSync(ipfsPath)) {
      missing.push(`ipfs binary for ${platformDir}: ${ipfsPath}`);
    }
  }

  return missing;
}

function main() {
  const platforms = getPlatformArch();
  console.log(`Checking binaries for: ${platforms.map((p) => `${p.os}-${p.arch}`).join(', ')}`);

  const missing = checkBinaries(platforms);

  if (missing.length > 0) {
    console.error('\n❌ Build cannot proceed. Missing binaries:\n');
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error('\nRun the following commands to download binaries:');
    console.error('  npm run bee:download');
    console.error('  npm run ipfs:download\n');
    process.exit(1);
  }

  console.log('✅ All required binaries found.\n');
  process.exit(0);
}

main();
