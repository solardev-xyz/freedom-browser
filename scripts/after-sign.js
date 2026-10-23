// electron-builder's afterSign hook (package.json build.afterSign): notarizes
// the freshly signed Freedom.app, then staples the ticket with retries, before
// dmg-builder and the zip target wrap the app (#757).
//
// `build.mac.notarize` is false on purpose. With it on, electron-builder calls
// @electron/notarize's `notarize()`, which submits the app and then staples it
// with promise-retry's defaults: three retries, 1 s / 2 s / 4 s apart. GitHub's
// macOS runners have been dropping the connection to Apple's ticket service
// for longer than that (actions/runner-images#14924), and every drop failed
// the whole build even though notarization had succeeded. So this hook runs
// the notarization half of `notarize()` unchanged (same option builder, same
// signature check, same notarytool submission) and staples through
// scripts/staple-with-retry.sh instead, which waits up to five minutes.
//
// It stays inside electron-builder, rather than a separate workflow step,
// because the app has to be stapled before the .dmg and .zip are made from it,
// and splitting the build around a step does not work: an `--dir` pass writes
// no Contents/Resources/app-update.yml (PublishManager only does that when a
// dmg or zip target is requested), and a `--prepackaged` pass skips afterPack
// entirely.
//
// Opt out with FREEDOM_SKIP_NOTARIZE=1 (scripts/build.js sets it for
// `--no-notarize`). electron-builder only calls this hook when it signed
// something, so unsigned builds never get here.
const path = require('path');
const { execFileSync } = require('child_process');

const STAPLE_SCRIPT = path.join(__dirname, 'staple-with-retry.sh');

function skipNotarize(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.FREEDOM_SKIP_NOTARIZE || '')
      .trim()
      .toLowerCase()
  );
}

// The same pieces @electron/notarize's own `notarize()` runs, minus its staple.
// Deep requires: neither package has an `exports` map, and
// scripts/after-sign.test.js fails if a version bump moves any of them.
function loadNotarizer() {
  const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper');
  const { checkSignatures } = require('@electron/notarize/lib/check-signature');
  const {
    isNotaryToolAvailable,
    notarizeAndWaitForNotaryTool,
  } = require('@electron/notarize/lib/notarytool');
  return {
    getNotarizeOptions: (appPath) => MacTargetHelper.getNotarizeOptions(appPath),
    checkSignatures,
    isNotaryToolAvailable,
    notarizeAndWaitForNotaryTool,
  };
}

function staple(appPath) {
  execFileSync('bash', [STAPLE_SCRIPT, 'staple', appPath], { stdio: 'inherit' });
}

async function afterSign(context, deps = {}) {
  if (context.electronPlatformName !== 'darwin') return;

  const log = deps.log || ((line) => console.log(`  • ${line}`));
  if (skipNotarize(deps.env || process.env)) {
    log('skipped macOS notarization (FREEDOM_SKIP_NOTARIZE)');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const notarizer = deps.notarizer || loadNotarizer();

  // Same credentials electron-builder's built-in pass reads (APPLE_ID +
  // APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, an API key, or a keychain
  // profile); like it, a signed build with none of them is left unnotarized.
  const options = notarizer.getNotarizeOptions(appPath);
  if (!options) {
    log('skipped macOS notarization (no notarization credentials in the environment)');
    return;
  }

  log(`notarizing ${path.basename(appPath)}`);
  await notarizer.checkSignatures({ appPath });
  if (!(await notarizer.isNotaryToolAvailable())) {
    throw new Error(
      'notarytool is not available, you must be on at least Xcode 13 or provide notarytoolPath'
    );
  }
  await notarizer.notarizeAndWaitForNotaryTool(options);
  log('notarization successful; stapling');

  (deps.staple || staple)(appPath);
}

exports.default = afterSign;
exports.skipNotarize = skipNotarize;
exports.loadNotarizer = loadNotarizer;
exports.STAPLE_SCRIPT = STAPLE_SCRIPT;
