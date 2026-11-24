// Packaged smoke — the licence texts NOTICES promises are really in the
// artifact.
//
// This is a packaging-class check, not an app-behaviour one, so it can only be
// made from a built binary. Chromium's third-party notices are the reason it
// exists: Electron generates them into a single `LICENSES.chromium.html` and
// leaves it beside the executable, which is what Linux and Windows packages
// ship — but electron-builder before 26.18 *deleted* that copy on the macOS
// path (`unlinkIfExists(path.join(appOutDir, "LICENSES.chromium.html"))` in
// app-builder-lib/out/electron/electronMac.js), and the `.dmg`/`-mac.zip`
// carry only `Freedom.app`, so before `build.mac.extraResources` copied it
// into `Contents/Resources` every macOS artifact redistributed Chromium with
// no third-party attribution at all while NOTICES pointed at the file.
// electron-builder 26.18 moves it into the bundle itself; the explicit copy
// stays.
//
// A unit test over package.json can only say the config still asks for it.
// This says the bytes arrived, once per shipped artifact (the six release
// smoke legs: .deb, AppImage, .dmg, -mac.zip, NSIS install, portable zip).

const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');

const isMac = process.platform === 'darwin';

async function layout(electronApp) {
  const { resourcesPath, execPath } = await electronApp.appFacts();
  return {
    resourcesPath,
    // Where Electron's own dist files land: beside the executable everywhere
    // except macOS, where they sit inside the bundle.
    distDir: isMac ? resourcesPath : path.dirname(fs.realpathSync(execPath)),
  };
}

test("Chromium's third-party notices ship with the artifact", async ({ electronApp }) => {
  const { distDir } = await layout(electronApp);
  const notices = path.join(distDir, 'LICENSES.chromium.html');

  expect({ notices, present: fs.existsSync(notices) }).toEqual({ notices, present: true });

  // Guard against a truncated or placeholder file: Electron's real one is tens
  // of megabytes of per-component notices.
  const { size } = fs.statSync(notices);
  expect(size).toBeGreaterThan(1_000_000);
  const head = fs.readFileSync(notices, { encoding: 'utf8', flag: 'r' }).slice(0, 4096);
  expect(head).toMatch(/chromium/i);
});

test("Electron's own licence text ships with the artifact", async ({ electronApp }) => {
  // electron-builder 26.18+ renames Electron's dist `LICENSE` to
  // `LICENSE.electron.txt` and leaves it where the Chromium notices go. Freedom
  // has no explicit copy of this one, so this is the check that it arrived.
  const { distDir } = await layout(electronApp);
  const license = path.join(distDir, 'LICENSE.electron.txt');
  expect({ license, present: fs.existsSync(license) }).toEqual({ license, present: true });
  const text = fs.readFileSync(license, 'utf8');
  expect(text).toContain('Copyright (c) Electron contributors');
  expect(text).toContain('Permission is hereby granted, free of charge');
});

test('Freedom’s own licence and NOTICES ship with the artifact', async ({ electronApp }) => {
  const { resourcesPath } = await layout(electronApp);

  const license = fs.readFileSync(path.join(resourcesPath, 'LICENSE'), 'utf8');
  expect(license).toContain('Mozilla Public License Version 2.0');

  const notices = fs.readFileSync(path.join(resourcesPath, 'NOTICES'), 'utf8');
  expect(notices).toContain('Third-Party Notices');
  // Every component the audit classifies has an entry; spot-check the ones
  // whose absence was the 0.8.5 licence bug.
  expect(notices).toContain('LICENSES.chromium.html');
  expect(notices).toMatch(/^Myotis /m);
  expect(notices).toMatch(/^Arti /m);
});
