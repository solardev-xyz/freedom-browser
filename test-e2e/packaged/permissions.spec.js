// Packaged smoke — the site-permission fixes #361 and #364 in the artifact a
// user installs (#370).
//
// Both were verified by the source-tree harness (`test-e2e/permissions.spec.js`)
// and neither is a packaging-independent property: the permission handlers are
// installed per session at startup, the embargo counters live in the main
// process, and the remembered decisions go through `<userData>/permissions.json`
// — all of which a package can get wrong on its own (a session created before
// the handlers are installed, a profile path that only resolves in a source
// tree). Nothing checked them in a built app until this spec, so a regression
// could reach testers through a nightly and a release with every job green.
//
// The fixture pages and the click helpers are shared with the harness spec
// (`test-e2e/permission-fixtures.js`) on purpose: a packaged leg driving a
// slightly different page would not be re-checking the same behaviour.
//
// No OS permission dialog is involved — notifications are decided by Freedom's
// own anchored prompt, and no camera or microphone is ever opened. macOS
// actually handing the camera to the signed app after an in-app Allow is the
// TCC dialog, which no hosted runner can drive; the closest CI can get is the
// entitlements assertion in `smoke-mac-arm64` (`scripts/check-mac-entitlements.js`)
// plus the manual item in release-process.md §6.

const fs = require('fs');
const path = require('path');

const { test, expect, browserWindow } = require('../fixtures');
const {
  FIXTURE_URL,
  GATED_FIXTURE_BODY,
  evalInWebview,
  readOut,
  clickAsk,
  answerPrompt,
  setPermissionFixture,
  gotoPermissionFixture,
} = require('../permission-fixtures');

const prompt = (window) => window.locator('[data-test="permission-prompt"]');
const indicator = (window) => window.locator('[data-test="permission-indicator"]');
const resetOut = (window) =>
  evalInWebview(window, "document.getElementById('out').textContent = 'none'; true");

// What a page's own gate reads before it decides whether to ask. Electron's
// check handler is boolean-only, so an undecided permission cannot report
// "prompt" and reports "granted" instead (#361 is about it not reporting
// "denied", which is what made Google Meet's pre-join screen a dead end).
const queryState = (window, name) =>
  evalInWebview(
    window,
    `navigator.permissions.query({ name: '${name}' }).then((status) => status.state, (err) => 'query-threw:' + err.message)`
  );

// #361: a site nothing has been decided for must read as promptable, or a page
// that consults the Permissions API before it asks — Google Meet's pre-join
// screen — reads a hard block, never calls requestPermission(), and Freedom's
// own prompt never fires. The fixture here is that exact shape.
test('an undecided site reads as promptable, and its page reaches the prompt', async ({
  electronApp,
  window,
}) => {
  await setPermissionFixture(electronApp, GATED_FIXTURE_BODY);
  await gotoPermissionFixture(window);

  for (const name of ['notifications', 'camera', 'microphone']) {
    expect([name, await queryState(window, name)]).toEqual([
      name,
      expect.stringMatching(/^(granted|prompt)$/),
    ]);
  }

  // The gate's own read, taken by the page itself at load.
  const gateState = () =>
    evalInWebview(window, "document.getElementById('state')?.textContent || null");
  await expect.poll(gateState, { timeout: 10_000 }).not.toBe('pending');
  expect(['granted', 'prompt']).toContain(await gateState());
  await expect(prompt(window)).toBeHidden();

  // So the page goes on to ask, and the anchored prompt appears over the
  // packaged app's chrome naming the requesting origin.
  await clickAsk(window);
  await expect(prompt(window)).toBeVisible();
  await expect(window.locator('[data-test="permission-prompt-origin"]')).toHaveText(FIXTURE_URL);

  // Escape is a deny-once: nothing is remembered, so the site can ask again.
  await window.keyboard.press('Escape');
  await expect(prompt(window)).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await resetOut(window);
  await clickAsk(window);
  await expect(prompt(window)).toBeVisible();
});

// #364: because dismissing is a deny-once, a page could re-raise the prompt
// after every Escape and hold it up for as long as the tab is open. Chromium
// bounds that with an embargo after three dismissals; so does Freedom. The
// ungated fixture, so the fourth request really is a request — the gated page
// above would short-circuit on its own read instead of reaching the handler.
test('three dismissals embargo the site, and the fourth request is auto-denied', async ({
  electronApp,
  window,
}) => {
  await setPermissionFixture(electronApp);
  await gotoPermissionFixture(window);

  for (let i = 0; i < 3; i += 1) {
    await resetOut(window);
    await clickAsk(window);
    await expect(prompt(window)).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(prompt(window)).toBeHidden();
    await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  }

  // The fourth request never reaches a prompt at all.
  await resetOut(window);
  await clickAsk(window);
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('denied');
  await window.waitForTimeout(500);
  await expect(prompt(window)).toBeHidden();
  await expect
    .poll(() => evalInWebview(window, 'Notification.permission'), { timeout: 5_000 })
    .toBe('denied');

  // An auto-block the user never chose has to be discoverable, and the
  // address-bar popover is where it is lifted.
  await expect(indicator(window)).toBeVisible();
  await indicator(window).click();
  await expect(window.locator('#permission-popover')).toBeVisible();
  await expect(window.locator('.permission-popover-row-status')).toHaveText(
    'Blocked after repeated dismissals (this session)'
  );
});

// The persistence.spec.js pattern applied to a permission: what makes this a
// *packaging* test is the second launch of the same executable against the same
// profile directory. A package that cannot persist its permissions (a profile
// path that only resolves in a source tree, a store written where the next
// launch does not read it) re-prompts a site the user already allowed.
test('Allow with remember survives a full quit and relaunch', async ({
  electronApp,
  window,
  relaunchApp,
  userDataDir,
}) => {
  await setPermissionFixture(electronApp);
  await gotoPermissionFixture(window);

  await clickAsk(window);
  await expect(prompt(window)).toBeVisible();
  await expect(window.locator('[data-test="permission-remember"]')).toBeChecked();
  await answerPrompt(window, 'allow');
  await expect(prompt(window)).toBeHidden();
  await expect.poll(() => readOut(window), { timeout: 5_000 }).toBe('granted');

  // The decision has to reach disk before the process goes away, or the
  // relaunch below would only be re-reading a race.
  const permissionsFile = path.join(userDataDir, 'permissions.json');
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(fs.readFileSync(permissionsFile, 'utf-8'))[FIXTURE_URL]?.notifications;
        } catch {
          return null;
        }
      },
      { message: `Waiting for the remembered decision in ${permissionsFile}` }
    )
    .toBe('allow');

  // Full quit: every window closed and the main process gone, not a reload.
  await electronApp.close();

  const relaunched = await relaunchApp();
  const relaunchedWindow = await browserWindow(relaunched);
  // Fixtures are in-memory, so the new instance needs its own. The gated body
  // reads the stored decision back the way a real site does.
  await setPermissionFixture(relaunched, GATED_FIXTURE_BODY);
  await gotoPermissionFixture(relaunchedWindow);

  await expect
    .poll(() => evalInWebview(relaunchedWindow, 'Notification.permission'), { timeout: 5_000 })
    .toBe('granted');

  // And a fresh request is granted silently, from the store rather than from a
  // prompt nobody answered this time.
  await clickAsk(relaunchedWindow);
  await expect.poll(() => readOut(relaunchedWindow), { timeout: 5_000 }).toBe('granted');
  await expect(prompt(relaunchedWindow)).toBeHidden();
  await expect(indicator(relaunchedWindow)).toBeVisible();
});
