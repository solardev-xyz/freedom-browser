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
 *   --no-notarize           Disable built-in notarization (macOS dist only)
 *   --verbose               Enable electron-builder debug output
 *
 * Examples:
 *   npm run build -- --mac --arm64
 *   npm run build -- --mac --arm64 --unsigned --verbose
 *   npm run dist -- --mac --no-notarize
 *   npm run dist -- --linux --x64
 *   npm run dist -- --win --arm64
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isHostNativeBinary } = require('./native-binary-arch');

const args = process.argv.slice(2);

// Parse flags
const platforms = ['mac', 'linux', 'win'].filter((p) => args.includes(`--${p}`));
const archs = ['arm64', 'x64'].filter((a) => args.includes(`--${a}`));
const dist = args.includes('--dist');
const unsigned = args.includes('--unsigned');
const noNotarize = args.includes('--no-notarize');
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

// Distributables must not ship the interim remote-signing bridge origin
// (personal test deployment — see the pre-merge checklist on PR #159).
// Override for local experiments only: FREEDOM_ALLOW_INTERIM_BRIDGE=1.
if (dist && process.env.FREEDOM_ALLOW_INTERIM_BRIDGE !== '1') {
  const remoteSession = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'lib', 'wallet', 'remote-session.js'),
    'utf8'
  );
  if (remoteSession.includes('florianglatz.eth.limo')) {
    console.error(
      'Error: BRIDGE_ORIGIN in src/renderer/lib/wallet/remote-session.js still points at the ' +
        'interim test deployment. Deploy freedom-bridge to the production origin and update the ' +
        'constant before building a distributable (FREEDOM_ALLOW_INTERIM_BRIDGE=1 to override locally).'
    );
    process.exit(1);
  }
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

if (noNotarize && platform === 'mac' && dist) {
  builderArgs.push('-c.mac.notarize=false');
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

// 5. Protect the host-built better-sqlite3 binary during cross-platform builds.
// electron-builder rebuilds native deps in node_modules for the TARGET platform,
// which replaces the host binary (e.g. with a Windows DLL after `--win`) and
// silently breaks history/favicons in local dev until a manual rebuild.
const BS3_BINARY = path.join(
  __dirname,
  '..',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

// isHostNativeBinary (see ./native-binary-arch.js) parses the real CPU
// architecture from the binary headers — not just the file format — so a
// same-platform cross-arch build (e.g. `--mac --x64` on an arm64 mac) is
// also detected and restored.

const hostPlatform = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
const crossBuild = platform !== hostPlatform || archs.some((a) => a !== process.arch);

let bs3Snapshot = null;
if (crossBuild && fs.existsSync(BS3_BINARY)) {
  const current = fs.readFileSync(BS3_BINARY);
  if (isHostNativeBinary(current)) {
    bs3Snapshot = current;
  }
}

function restoreHostNativeDeps() {
  if (!crossBuild) return;
  const afterBuild = fs.existsSync(BS3_BINARY) ? fs.readFileSync(BS3_BINARY) : null;
  if (isHostNativeBinary(afterBuild)) return;
  if (bs3Snapshot) {
    // try/catch so a failed write-back (e.g. build/Release wiped by a failed
    // cross-build) can't mask the original build error thrown past the finally.
    try {
      fs.writeFileSync(BS3_BINARY, bs3Snapshot);
      console.log('\n→ Restored host better-sqlite3 binary (was replaced by cross-build)\n');
      return;
    } catch (err) {
      console.error(`Warning: could not write back the snapshotted binary (${err.message})`);
    }
  }
  console.log('\n→ Rebuilding native deps for the host platform\n');
  try {
    // Same command as our postinstall; electron-builder is a declared devDependency.
    execSync('npx electron-builder install-app-deps', { stdio: 'inherit' });
  } catch {
    console.error(
      '\nERROR: could not restore host better-sqlite3 binary after cross-build. ' +
        'Local dev is broken until you run `npx electron-builder install-app-deps`.\n'
    );
    process.exitCode = 1;
  }
}

console.log(`\n→ Running: ${cmd}\n`);
try {
  execSync(cmd, { stdio: 'inherit', env });
} finally {
  restoreHostNativeDeps();
}
