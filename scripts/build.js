#!/usr/bin/env node

/**
 * Unified build/dist script for Freedom Browser.
 *
 * Replaces 30+ individual npm scripts with a single parameterized helper.
 *
 * Usage:
 *   node scripts/build.js [options]
 *
 * Options:
 *   --mac, --linux, --win   Target platform (required)
 *   --arm64, --x64          Target architecture (can specify both; defaults vary by platform)
 *   --dist                  Create distributable (default: unpacked build via --dir)
 *   --unsigned              Skip code signing (macOS only)
 *   --verbose               Enable electron-builder debug output
 *
 * Examples:
 *   npm run build -- --mac --arm64
 *   npm run build -- --mac --arm64 --unsigned --verbose
 *   npm run dist -- --linux --x64
 *   npm run dist -- --win --arm64
 */

const { execSync } = require('child_process');

const args = process.argv.slice(2);

// Parse flags
const platforms = ['mac', 'linux', 'win'].filter((p) => args.includes(`--${p}`));
const archs = ['arm64', 'x64'].filter((a) => args.includes(`--${a}`));
const dist = args.includes('--dist');
const unsigned = args.includes('--unsigned');
const verbose = args.includes('--verbose');

if (platforms.length === 0) {
  console.error('Error: specify a platform (--mac, --linux, --win)');
  process.exit(1);
}

if (platforms.length > 1) {
  console.error('Error: specify only one platform at a time');
  process.exit(1);
}

const platform = platforms[0];

// Default architectures when none specified
if (archs.length === 0) {
  if (platform === 'mac') archs.push('arm64');
  else if (platform === 'win') archs.push('x64');
  else archs.push('arm64', 'x64'); // Linux defaults to both
}

// 1. Check binaries for the target platform/arch
const checkArgs = [`--${platform}`, ...archs.map((a) => `--${a}`)].join(' ');
console.log(`\n→ Checking binaries: npm run check-binaries -- ${checkArgs}\n`);
execSync(`npm run check-binaries -- ${checkArgs}`, { stdio: 'inherit' });

// 2. Build electron-builder command
const builderArgs = [`--${platform}`, ...archs.map((a) => `--${a}`)];

if (!dist) {
  builderArgs.push('--dir');
}

if (unsigned && platform === 'mac') {
  builderArgs.push('-c.mac.identity=null');
}

// Windows publish channels (signed dist only)
if (dist && platform === 'win') {
  const winArch = archs[0] || 'x64';
  builderArgs.push(`-c.publish.channel=latest-win-${winArch}`);
}

// 3. Environment
const env = { ...process.env };

if (verbose) {
  env.DEBUG =
    dist && platform === 'mac' && !unsigned
      ? 'electron-builder,electron-notarize'
      : 'electron-builder';
}

// 4. Use dotenv for signed macOS builds (loads code-signing env vars)
const useDotenv = platform === 'mac' && !unsigned;
const cmd = useDotenv
  ? `dotenv -- electron-builder ${builderArgs.join(' ')}`
  : `electron-builder ${builderArgs.join(' ')}`;

console.log(`\n→ Running: ${cmd}\n`);
execSync(cmd, { stdio: 'inherit', env });
