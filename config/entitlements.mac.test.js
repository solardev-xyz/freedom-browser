// macOS camera/microphone build config (#362).
//
// A hardened-runtime app cannot touch the camera or the microphone without
// `com.apple.security.device.camera` / `.audio-input`: TCC never shows the
// system prompt, denies outright, and the app is not even listed under
// Privacy & Security, so `grantWithOsGate`'s `askForMediaAccess()` comes back
// false and the user has nowhere to fix it. The usage descriptions are what
// that system prompt says — without them macOS shows Electron's generic
// placeholder text instead of a Freedom-specific reason.
//
// Both are pure build config, invisible to every test that runs on this
// (Linux) box and to every unsigned build, so they are easy to drop in a
// refactor. This guards them.

const fs = require('fs');

// The same parser the packaged-app assertion reads the expected key list with
// (scripts/check-mac-entitlements.js, #370), so the source plist is understood
// the one way in both places rather than by two copies that can drift.
const {
  ENTITLEMENTS_PATH,
  parseEntitlementsPlist: parseEntitlements,
} = require('../scripts/check-mac-entitlements');
const pkg = require('../package.json');

describe('macOS media entitlements and usage descriptions', () => {
  const entitlements = parseEntitlements(fs.readFileSync(ENTITLEMENTS_PATH, 'utf8'));

  test.each(['com.apple.security.device.camera', 'com.apple.security.device.audio-input'])(
    '%s is granted in config/entitlements.mac.plist',
    (key) => {
      expect(entitlements[key]).toBe(true);
    }
  );

  // The same file is used for `entitlements` and `entitlementsInherit`, which
  // is why adding the keys once covers the renderer/GPU helpers that actually
  // open the capture devices.
  test('the file is used for both the app and its inherited helper entitlements', () => {
    expect(pkg.build.mac.entitlements).toBe('config/entitlements.mac.plist');
    expect(pkg.build.mac.entitlementsInherit).toBe('config/entitlements.mac.plist');
    expect(pkg.build.mac.hardenedRuntime).toBe(true);
  });

  test.each(['NSCameraUsageDescription', 'NSMicrophoneUsageDescription'])(
    'mac.extendInfo carries a non-empty %s',
    (key) => {
      const value = pkg.build.mac.extendInfo[key];
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  );

  test('extendInfo keeps its pre-existing keys', () => {
    expect(pkg.build.mac.extendInfo.LSMultipleInstancesProhibited).toBe(false);
  });

  // docs/security-audit-electron.md, O-11. `allow-jit` is all V8 needs (it is
  // the only code-signing entitlement in Electron's own default plist,
  // @electron/osx-sign's default.darwin.plist). `disable-library-validation`
  // would let the process load a dylib signed by anyone; it is not needed
  // because every native addon Freedom loads (better-sqlite3 and the other
  // `**/*.node` files asarUnpack puts in app.asar.unpacked, and the
  // extraResources copies of libradicle, freedom-ipfs and Myotis) sits inside
  // Freedom.app, and @electron/osx-sign signs every binary it finds under
  // Contents/ with the same Developer ID as the app. Only a signed macOS
  // release run proves that last part (the packaged smoke legs load the
  // IPFS, Radicle and SQLite addons); see the PR that dropped these.
  test('V8 gets allow-jit only: no unsigned executable memory, no foreign dylibs', () => {
    expect(entitlements['com.apple.security.cs.allow-jit']).toBe(true);
    expect(entitlements).not.toHaveProperty(
      'com.apple.security.cs.allow-unsigned-executable-memory'
    );
    expect(entitlements).not.toHaveProperty('com.apple.security.cs.disable-library-validation');
  });

  test('native addons ship outside app.asar, where signing reaches them', () => {
    expect(pkg.build.asarUnpack).toEqual(expect.arrayContaining(['**/*.node']));
    const addonDirs = [...pkg.build.extraResources, ...(pkg.build.mac.extraResources || [])]
      .filter((r) => (r.filter || []).some((f) => f.endsWith('.node')))
      .map((r) => r.to);
    expect(addonDirs).toEqual(
      expect.arrayContaining(['radicle-bin', 'freedom-ipfs-node', 'myotis-node'])
    );
  });

  // The assertions above are only worth anything if the parser refuses what
  // it does not understand instead of quietly dropping it.
  test.each([
    ['a non-boolean value', '<dict><key>a</key><string>yes</string></dict>'],
    ['a nested dict', '<dict><key>a</key><dict><key>b</key><true/></dict></dict>'],
    ['a key with no value', '<dict><key>a</key></dict>'],
    ['no dict at all', '<plist version="1.0"></plist>'],
  ])('the parser refuses %s', (_label, xml) => {
    expect(() => parseEntitlements(xml)).toThrow(/entitlements plist/);
  });
});
