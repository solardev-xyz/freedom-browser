// Pins build.electronFuses (docs/security-audit-electron.md, E-5 / O-4;
// issues #425 and #431). electron-builder flips these into every packaged
// binary right before signing. Each value here is a decision, so a change to
// any of them — including leaving one to Electron's default by deleting it —
// should fail a test and be argued for in review.
//
// What the shipped artifact actually carries is checked separately, per
// release smoke leg, by test-e2e/packaged/fuses.spec.js.

const pkg = require('../package.json');

const fuses = pkg.build.electronFuses;

describe('build.electronFuses', () => {
  test('sets exactly the fuses we have decided on, and nothing else', () => {
    expect(Object.keys(fuses).sort()).toEqual(
      [
        'enableCookieEncryption',
        'enableEmbeddedAsarIntegrityValidation',
        'enableNodeCliInspectArguments',
        'enableNodeOptionsEnvironmentVariable',
        'grantFileProtocolExtraPrivileges',
        'onlyLoadAppFromAsar',
        'resetAdHocDarwinSignature',
        'runAsNode',
      ].sort()
    );
  });

  test('NODE_OPTIONS cannot inject code into the signed app (E-5)', () => {
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(false);
  });

  test('--inspect / --inspect-brk / SIGUSR1 cannot open a main-process inspector (O-4)', () => {
    // Packaged smoke tests attach over CDP instead (test-e2e/packaged-launch.js),
    // and the app itself drops --remote-debugging-* outside E2E runs
    // (src/main/remote-debugging-gate.js).
    expect(fuses.enableNodeCliInspectArguments).toBe(false);
  });

  test('the app only loads from its own, integrity-checked app.asar (O-4)', () => {
    // Paired. Electron 44 searches resources/ for app.asar, then app/, then
    // default_app.asar: without OnlyLoadAppFromAsar, deleting or corrupting
    // app.asar next to a planted app/ directory runs that directory instead.
    // Integrity validation (enforced on macOS and Windows only) stops app.asar
    // itself being edited. Either alone leaves the other route open.
    expect(fuses.onlyLoadAppFromAsar).toBe(true);
    expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
    // Integrity validation needs the asar the hash is computed over.
    expect(pkg.build.asar).not.toBe(false);
    expect(pkg.build.disableAsarIntegrity).not.toBe(true);
  });

  // Deliberately still at Electron's defaults, each for a reason recorded in
  // O-4 and issue #431. Written out so that flipping one is a visible change.
  test('fuses that stay at their defaults until their prerequisites land', () => {
    // Myotis runs its child through a native supervisor that execs Electron
    // under ELECTRON_RUN_AS_NODE (src/main/myotis/myotis-process.js).
    expect(fuses.runAsNode).toBe(true);
    // Moving cookies into the OS keychain prompts on macOS and needs a
    // migration for existing profiles: a product decision.
    expect(fuses.enableCookieEncryption).toBe(false);
    // The chrome and every internal page are still file:// URLs.
    expect(fuses.grantFileProtocolExtraPrivileges).toBe(true);
  });

  test('an unsigned arm64 macOS build still launches after the fuses are flipped', () => {
    expect(fuses.resetAdHocDarwinSignature).toBe(true);
  });
});
