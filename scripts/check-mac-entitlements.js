// Assert a *built* macOS app really carries the media entitlements and usage
// descriptions #362 added (#370).
//
// `config/entitlements.mac.test.js` guards the source config on every pull
// request: that the plist grants `com.apple.security.device.camera` /
// `.audio-input` and that package.json points `entitlements` and
// `entitlementsInherit` at it. What it cannot say is that the signature the
// notarized app ships with carries them — entitlements only reach a bundle
// through `codesign`, so a wrong `entitlements` path, a signing step that
// falls back to signing without them, or a hardened-runtime app signed before
// the plist was extended all leave that unit test green and ship an app whose
// camera TCC prompt never appears and which is not even listed under Privacy &
// Security.
//
// It reads the outer `Freedom.app` signature *and* each helper bundle under
// `Contents/Frameworks`: those host the capture and renderer processes and are
// signed separately, through `entitlementsInherit` rather than `entitlements`
// (app-builder-lib hands every nested path that is neither the app itself nor a
// `Library/LoginItems` helper to that file). package.json points both keys at
// the same plist today, so an `entitlementsInherit` split or a signing step
// that reaches only the outer bundle would deny the hardened-runtime capture
// process while the outer app's signature still reads correctly — #362's exact
// symptom, with this check green.
//
// The macOS smoke job runs this once per shipped artifact (the app copied out
// of the `.dmg` and the app out of the `-mac.zip`), on signed runs only:
// entitlements reach a bundle only through the `codesign` pass electron-builder
// skips on an unsigned dispatch run, so there is nothing to assert there. What
// `codesign -d` does on such a build — error out, or print an empty set off the
// ad-hoc signature the repacked Electron binaries were shipped with — has never
// been checked against a real unsigned artifact; the gate holds either way, so
// do not lean on one of those answers without verifying it first.
//
// Usage:
//   node scripts/check-mac-entitlements.js <path/to/Freedom.app>
//   node scripts/check-mac-entitlements.js --entitlements <plist> --info-plist <plist>
//
// The second form is what makes the assertion testable off a Mac: the checks
// are pure functions over two plists, so scripts/check-mac-entitlements.test.js
// mutation-tests them against doctored copies of the real inputs rather than by
// shipping a broken plist.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENTITLEMENTS_PATH = path.join(__dirname, '..', 'config', 'entitlements.mac.plist');

// The two entitlements #362 is about. Every key the source plist grants is
// required in the signed app, but these are named explicitly as well: without
// them, dropping a key from the plist would shrink the expected set and pass.
const REQUIRED_ENTITLEMENTS = [
  'com.apple.security.device.camera',
  'com.apple.security.device.audio-input',
];

// What macOS shows in the TCC prompt. Without them the prompt carries
// Electron's generic placeholder text instead of a Freedom-specific reason.
const REQUIRED_USAGE_DESCRIPTIONS = ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'];

// Read the source plist without a plist library on purpose: `plist` is not
// declared in this repo's dependencies, it only resolves through
// electron-builder's hoisted copy, so requiring it would let an unrelated
// dependency bump break this script and its suite with `Cannot find module
// 'plist'`. The entitlements file is a flat <dict> of <key>…</key><true/> pairs,
// which is all a signing entitlements file needs; anything else in there is a
// shape this parser refuses loudly rather than skipping past (a silent skip
// would let a key that no longer says <true/> pass the assertions below).
function parseEntitlementsPlist(xml) {
  const dict = xml.match(/<dict>([\s\S]*?)<\/dict>/);
  if (!dict) throw new Error('entitlements plist: no top-level <dict>');

  let rest = dict[1].replace(/<!--[\s\S]*?-->/g, '').trim();
  const entitlements = {};
  while (rest.length > 0) {
    const pair = rest.match(/^<key>([^<]+)<\/key>\s*<(true|false)\s*\/>\s*/);
    if (!pair) {
      throw new Error(
        `entitlements plist: expected a <key>/<true|false> pair, got ${rest.slice(0, 60)}`
      );
    }
    entitlements[pair[1]] = pair[2] === 'true';
    rest = rest.slice(pair[0].length);
  }
  return entitlements;
}

// The keys a signed app must carry: everything config/entitlements.mac.plist
// grants, so a key added there is asserted in the artifact without editing this
// script.
function expectedEntitlementKeys(xml = fs.readFileSync(ENTITLEMENTS_PATH, 'utf8')) {
  const entitlements = parseEntitlementsPlist(xml);
  const granted = Object.keys(entitlements).filter((key) => entitlements[key] === true);

  const missing = REQUIRED_ENTITLEMENTS.filter((key) => !granted.includes(key));
  if (missing.length > 0) {
    throw new Error(
      `config/entitlements.mac.plist no longer grants ${missing.join(', ')} — ` +
        'the camera and microphone cannot work under the hardened runtime without them (#362).'
    );
  }
  return granted;
}

// One key at a time rather than a full parse of what `codesign` printed: the
// embedded entitlements are Apple's output, not ours, and a key with a value
// shape this file has no reason to model (an array, a string) must not turn a
// good build's assertion into a parse error. A key that is present without an
// immediately following <true/> reads as not granted, which is what it means.
function grantsEntitlement(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`).test(xml);
}

// @returns {string[]} One line per problem; empty when the bundle is fine.
function checkEntitlements(entitlementsXml, expectedKeys, subject = 'the signed app') {
  return expectedKeys
    .filter((key) => !grantsEntitlement(entitlementsXml, key))
    .map((key) => `entitlement ${key} is not granted in ${subject}`);
}

// The helper bundles Electron runs its capture, GPU and renderer processes in.
// They sit directly under Contents/Frameworks next to the frameworks
// themselves, so only the `.app` children are signed with entitlements of their
// own; a build with none there is a layout this check cannot assert, which is
// worth failing on rather than passing quietly.
function helperBundlePaths(appPath) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworks)) {
    throw new Error(`No Contents/Frameworks at ${frameworks} — is ${appPath} an app bundle?`);
  }
  const helpers = fs
    .readdirSync(frameworks)
    .filter((entry) => entry.endsWith('.app'))
    .sort()
    .map((entry) => path.join(frameworks, entry));
  if (helpers.length === 0) {
    throw new Error(
      `No helper app bundles under ${frameworks} — Electron hosts the camera and microphone` +
        ' capture processes there, so their entitlements cannot be read (#362).'
    );
  }
  return helpers;
}

// @returns {string[]} One line per problem; empty when the app is fine.
function checkUsageDescriptions(infoPlistXml) {
  const problems = [];
  for (const key of REQUIRED_USAGE_DESCRIPTIONS) {
    const value = infoPlistXml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    if (!value) {
      problems.push(`Info.plist has no non-empty ${key} string`);
    } else if (value[1].trim().length === 0) {
      problems.push(`Info.plist's ${key} is empty`);
    }
  }
  return problems;
}

// `--entitlements -` writes them to stdout and `--xml` asks for the plist
// rather than a DER blob. Not the `:-` spelling most recipes still use: it does
// the same thing, but codesign on macOS 14 answers it with "Specifying ':' in
// the path is deprecated and will not work in a future release". Nothing here
// assumes the output starts with `<?xml` either — the checks read keys wherever
// they are, so a header or a one-line serialization changes nothing.
function extractEntitlements(appPath) {
  return execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// Through plutil so the checks always see XML: a bundle's Info.plist is a
// binary plist as often as not, and electron-builder's choice of format is not
// this script's business.
function readInfoPlist(appPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) {
    throw new Error(`No Info.plist at ${infoPlist} — is ${appPath} an app bundle?`);
  }
  return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', infoPlist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function main(argv) {
  // One entry per separately-signed bundle: `{ subject, entitlementsXml }`,
  // where `subject` is what a failure line names.
  let bundles;
  let infoPlistXml;
  let subject;

  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  const entitlementsFile = flag('--entitlements');
  const infoPlistFile = flag('--info-plist');

  if (entitlementsFile || infoPlistFile) {
    if (!entitlementsFile || !infoPlistFile) {
      throw new Error('--entitlements and --info-plist go together');
    }
    subject = `${entitlementsFile} + ${infoPlistFile}`;
    bundles = [
      { subject: entitlementsFile, entitlementsXml: fs.readFileSync(entitlementsFile, 'utf8') },
    ];
    infoPlistXml = fs.readFileSync(infoPlistFile, 'utf8');
  } else {
    const appPath = argv.find((arg) => !arg.startsWith('--'));
    if (!appPath) {
      throw new Error(
        'Usage: node scripts/check-mac-entitlements.js <path/to/Freedom.app>\n' +
          '       node scripts/check-mac-entitlements.js --entitlements <plist> --info-plist <plist>'
      );
    }
    subject = appPath;
    bundles = [appPath, ...helperBundlePaths(appPath)].map((bundlePath) => ({
      subject: bundlePath === appPath ? 'the signed app' : path.basename(bundlePath),
      entitlementsXml: extractEntitlements(bundlePath),
    }));
    infoPlistXml = readInfoPlist(appPath);
  }

  const expectedKeys = expectedEntitlementKeys();
  const problems = [];

  for (const bundle of bundles) {
    // Printed whether or not the assertions pass: when a release build fails
    // here, the log has to show what each bundle actually carries.
    console.log(`--- entitlements embedded in ${bundle.subject} ---`);
    console.log(bundle.entitlementsXml.trim());
    problems.push(...checkEntitlements(bundle.entitlementsXml, expectedKeys, bundle.subject));
  }
  problems.push(...checkUsageDescriptions(infoPlistXml));

  if (problems.length > 0) {
    console.error(`\n${subject} is missing what config/entitlements.mac.plist promises:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nA hardened-runtime app without these cannot reach the camera or the microphone:' +
        ' TCC denies without ever prompting and the app is not listed under Privacy & Security (#362).'
    );
    return 1;
  }

  console.log(
    `\nOK: ${expectedKeys.length} entitlements granted in each of ${bundles.length} signed ` +
      `bundle${bundles.length === 1 ? '' : 's'} (including ${REQUIRED_ENTITLEMENTS.join(', ')})` +
      ` and ${REQUIRED_USAGE_DESCRIPTIONS.join(' / ')} present.`
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ENTITLEMENTS_PATH,
  REQUIRED_ENTITLEMENTS,
  REQUIRED_USAGE_DESCRIPTIONS,
  parseEntitlementsPlist,
  expectedEntitlementKeys,
  grantsEntitlement,
  checkEntitlements,
  helperBundlePaths,
  checkUsageDescriptions,
  main,
};
