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
 *   npm run dist -- --win --x64
 *   npm run dist -- --win --arm64
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  SOURCE_BUILD_ENV,
  pruneSourceBuildFallback,
  assertTargetPrebuild,
} = require('./better-sqlite3-prebuilds');

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

// 5. Keep better-sqlite3 out of the @electron/rebuild pass.
// Since v13 it ships a prebuilt addon for every supported platform/arch in
// node_modules/better-sqlite3/prebuilds/ (darwin/linux/linuxmusl/win32 x
// x64/arm64) and the loader picks the one matching the *running* process, so
// no rebuild is wanted — but its leftover binding.gyp makes @electron/rebuild
// treat it as a node-gyp module, which cannot cross-compile. `postinstall`
// already prunes that file, so this is normally a silent no-op; repeat it here
// so a build still works after an install that skipped `postinstall`
// (`npm ci --ignore-scripts`) or a manual restore of the file. Note `npm
// rebuild better-sqlite3` does *not* restore it — it re-runs lifecycle scripts
// and never re-extracts the tarball. See scripts/better-sqlite3-prebuilds.js.
// No host-binary protection is needed either: a cross-build never overwrites a
// host-specific build/Release/better_sqlite3.node — that file is not produced
// at all — so local dev keeps working after `--win`/`--linux` builds.
//
// The prune's own guard is package-wide (it runs at install time, before any
// target is known), so check the *target's* prebuild here: with binding.gyp
// gone @electron/rebuild skips the module entirely, and a missing prebuild
// would ship an app with no addon that throws at startup.
// `FREEDOM_BS3_SOURCE_BUILD=1` opts out of both halves (guard and prune) so
// @electron/rebuild source-builds the addon for a target with no prebuild.
const { missing, overridden: sourceBuild } = assertTargetPrebuild({ platform, archs });
if (sourceBuild) {
  console.log(
    `\n→ ${SOURCE_BUILD_ENV} is set: skipping better-sqlite3's prebuild check and binding.gyp ` +
      `prune; @electron/rebuild will build it from source (needs Python + a C++ compiler).\n`
  );
} else if (missing.length > 0) {
  console.error(
    `Error: better-sqlite3 ships no prebuilt addon for this target (missing ${missing.join(', ')} ` +
      `in node_modules/better-sqlite3/prebuilds/). Packaging would produce an app that throws at ` +
      `startup. Add the target upstream, or build better-sqlite3 from source on the target ` +
      `platform. \`npm rebuild better-sqlite3\` does NOT restore the pruned binding.gyp (it only ` +
      `re-runs lifecycle scripts, it never re-extracts the package); the supported source-build ` +
      `path is:\n` +
      `  ${SOURCE_BUILD_ENV}=1 npm ci            # re-extracts better-sqlite3 with the prune skipped\n` +
      `  ${SOURCE_BUILD_ENV}=1 npm run build -- ${args.join(' ') || '<target>'}\n` +
      `which requires the node-gyp toolchain (Python + a C++ compiler; MSVC on Windows).`
  );
  process.exit(1);
}

const { removed } = pruneSourceBuildFallback();
if (removed)
  console.log("\n→ Pruned better-sqlite3's unused binding.gyp (prebuilt addons in use)\n");

// 6. Run the build.
console.log(`\n→ Running: ${cmd}\n`);
execSync(cmd, { stdio: 'inherit', env });
