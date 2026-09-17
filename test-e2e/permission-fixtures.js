// Shared pieces of the site-permission specs: the fixture pages a test drives
// a permission request from, and the handful of helpers that talk to them.
//
// Two specs use them — `test-e2e/permissions.spec.js` (the source-tree harness,
// which owns the decision matrix) and `test-e2e/packaged/permissions.spec.js`
// (the release smoke leg, which re-checks the #361/#364 fixes in the artifact a
// user installs). The fixture HTML and the click helpers are exactly the part
// that has to stay identical between them: a packaged leg driving a subtly
// different page would not be re-checking the same behaviour.
//
// Both run against the harness's stubbed bzz:// protocol, so no network is
// involved; notification requests inside the webview flow through the real
// session permission handlers in src/main/permissions/permissions-manager.js.

const { expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const FIXTURE_URL = `bzz://${SAMPLE_BZZ_HASH}`;

const FIXTURE_BODY = [
  '<!doctype html><title>permission fixture</title>',
  '<button id="ask">ask</button><div id="out">none</div>',
  '<script>',
  "  document.getElementById('ask').addEventListener('click', () => {",
  '    Notification.requestPermission().then((result) => {',
  "      document.getElementById('out').textContent = result;",
  '    });',
  '  });',
  '</script>',
].join('\n');

// #361: a page that gates its request on the Permissions API the way Google
// Meet's pre-join screen does — it queries first and only asks when the state
// is not already "denied". Electron's check handler is boolean-only, so an
// undecided permission reporting "denied" left this shape permanently stuck:
// the page never called requestPermission(), so Freedom's own prompt never
// fired and there was nothing for the user to click.
const GATED_FIXTURE_BODY = [
  '<!doctype html><title>permission gate fixture</title>',
  '<button id="ask">ask</button><div id="out">none</div><div id="state">pending</div>',
  '<script>',
  '  const out = document.getElementById("out");',
  '  const stateOut = document.getElementById("state");',
  '  async function readState() {',
  '    try {',
  '      return (await navigator.permissions.query({ name: "notifications" })).state;',
  '    } catch (err) {',
  '      return "query-threw:" + err.message;',
  '    }',
  '  }',
  '  readState().then((state) => { stateOut.textContent = state; });',
  '  document.getElementById("ask").addEventListener("click", async () => {',
  '    const state = await readState();',
  '    stateOut.textContent = state;',
  '    if (state === "denied") {',
  '      out.textContent = "blocked-without-asking";',
  '      return;',
  '    }',
  '    out.textContent = await Notification.requestPermission();',
  '  });',
  '</script>',
].join('\n');

// Run a script inside the active webview and return its result.
async function evalInWebview(window, script) {
  return window.evaluate(async (code) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(code);
    } catch {
      return null;
    }
  }, script);
}

const readOut = (window) =>
  evalInWebview(window, "document.getElementById('out')?.textContent || null");

const clickAsk = (window) => evalInWebview(window, "document.getElementById('ask').click(); true");

// Answer the prompt via a DOM click event instead of a synthesized mouse
// click. Right after the guest <webview> attaches (which is exactly when a
// page requests a permission), Chromium's browser-side input routing can
// still send pointer events at the prompt's coordinates into the guest
// surface instead of the chrome renderer, silently swallowing the click
// even though DOM hit-testing resolves the button. These specs verify the
// decision matrix, not compositor input routing, so deliver the click as
// a DOM event directly.
async function answerPrompt(window, action) {
  const button = window.locator(`[data-test="permission-${action}"]`);
  await expect(button).toBeVisible();
  await button.dispatchEvent('click');
}

// Point one app instance's stubbed bzz:// protocol at a fixture body. Takes the
// Electron app rather than the `harness` fixture so a spec can also seed an
// instance it started itself (the relaunch in the packaged spec).
async function setPermissionFixture(electronApp, body = FIXTURE_BODY) {
  await electronApp.evaluate(
    (_electron, { url, fixture }) => {
      globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, fixture);
    },
    { url: `${FIXTURE_URL}/`, fixture: { body } }
  );
}

// Drive the address bar to the fixture and wait until its page is live.
async function gotoPermissionFixture(window) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(FIXTURE_URL);
  await input.press('Enter');

  await expect
    .poll(() => readOut(window), {
      message: 'Waiting for the permission fixture page to load',
      timeout: 10_000,
    })
    .toBe('none');
}

module.exports = {
  FIXTURE_URL,
  FIXTURE_BODY,
  GATED_FIXTURE_BODY,
  evalInWebview,
  readOut,
  clickAsk,
  answerPrompt,
  setPermissionFixture,
  gotoPermissionFixture,
};
