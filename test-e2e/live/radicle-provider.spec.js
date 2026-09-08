// Radicle E2E: rad: scheme reads + window.radicle provider writes, fully
// offline against an isolated pre-baked node (see radicle-fixtures.js).
//
// Flow:
//   1. Wait for the embedded native node to come up.
//   2. Open canopy (production build, local static server) in a tab and
//      browse the fixture repo — asserts the rad: protocol handler serves
//      repo data to a web page (WP0 path).
//   3. Connect via window.radicle → consent modal in the browser chrome.
//   4. Open a new issue through canopy's UI → signing consent → assert the
//      issue lands (read back through the rad: scheme).
//
// Prereqs: the libradicle addon (npm run radicle:download) and a canopy build
// (npm run build in ../canopy). Skips gracefully when either is missing.

const {
  test,
  expect,
  HAS_RADICLE_ADDON,
  HAS_CANOPY_DIST,
  RADICLE_ADDON,
  CANOPY_DIST,
} = require('../radicle-fixtures');

const NODE_START_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 30_000;

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (s) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return false;
    try {
      return await wv.executeJavaScript(s);
    } catch {
      return false;
    }
  }, snippet);

const waitForWebview = (window, snippet, message, timeout = RENDER_TIMEOUT_MS) =>
  expect
    .poll(() => evalInActiveWebview(window, snippet), {
      message,
      timeout,
      intervals: [500, 1_000, 2_000],
    })
    .toBeTruthy();

const navigate = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
};

test.describe('radicle provider e2e', () => {
  test.skip(
    !HAS_RADICLE_ADDON,
    `Radicle E2E needs the addon at ${RADICLE_ADDON}. Run \`npm run radicle:download\`.`
  );
  test.skip(
    !HAS_CANOPY_DIST,
    `Radicle E2E needs a canopy build at ${CANOPY_DIST}. Run \`npm run build\` in the canopy repo.`
  );

  test('canopy reads via rad: scheme, connects, and writes an issue', async ({
    window,
    radicleEnv,
  }) => {
    const { rid, secondCommit, canopyUrl } = radicleEnv;

    // (1) Node up — poll the host-chrome radicle status API.
    await expect
      .poll(async () => (await window.evaluate(() => window.radicle.getStatus())).status, {
        message: 'radicle node should reach running',
        timeout: NODE_START_TIMEOUT_MS,
        intervals: [1_000, 2_000],
      })
      .toBe('running');

    // A valid direct rad: URL must reach the repository viewer even when the
    // repo is unavailable; route readiness must never masquerade as RID
    // validation failure.
    const reportedRid = 'z4V1sjrXqjvFdnCUbxPFqd5p4DtH5';
    await navigate(window, `rad://${reportedRid}`);
    await waitForWebview(
      window,
      `(() => {
        const invalid = document.querySelector('#invalid-rid-error');
        const settled = document.querySelector('#error-state:not(.hidden)') ||
          document.querySelector('#success-state:not(.hidden)');
        return invalid?.classList.contains('hidden') && !!settled;
      })()`,
      'a structurally valid direct rad URL should not show Invalid Radicle ID'
    );

    // (2) Open canopy at the fixture repo. Reads go fetch('rad:<rid>/…')
    // through the protocol handler into native storage.
    await navigate(window, `${canopyUrl}/#/${rid}`);
    await waitForWebview(
      window,
      `!!document.querySelector('h1 a') && document.querySelector('h1 a').textContent.includes('e2e-sample')`,
      'canopy should render the fixture repo name from rad: data'
    );
    await waitForWebview(
      window,
      `[...document.querySelectorAll('td a')].some((a) => a.textContent.includes('README.md'))`,
      'file tree should list README.md'
    );
    await waitForWebview(
      window,
      `document.body.textContent.includes('2 commits') &&
       document.body.textContent.includes('1 branch') &&
       document.body.textContent.includes('1 contributor')`,
      'canopy should render native repository stats'
    );

    // Native historical reads: list both fixture commits, then render the
    // structured first-parent diff for the newest one.
    await navigate(window, `${canopyUrl}/#/${rid}/commits`);
    await waitForWebview(
      window,
      `document.body.textContent.includes('update fixture files') &&
       document.body.textContent.includes('initial commit')`,
      'commit history should render from native storage'
    );
    await navigate(window, `${canopyUrl}/#/${rid}/commits/${secondCommit}`);
    await waitForWebview(
      window,
      `document.body.textContent.includes('update fixture files') &&
       document.body.textContent.includes('2 files changed') &&
       document.body.textContent.includes('README.md') &&
       document.body.textContent.includes('new.txt')`,
      'commit detail should render its structured native diff'
    );

    // (3) Connect. The button lives in canopy (webview); the consent modal
    // lives in the browser chrome (main window DOM).
    await evalInActiveWebview(
      window,
      `[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Connect node'))?.click(), true`
    );
    const approve = window.locator('#radicle-consent-approve');
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await expect(window.locator('#radicle-consent-title')).toContainText('Connect');
    await approve.click();
    await waitForWebview(
      window,
      `document.querySelector('header')?.textContent.includes('radicle-e2e')`,
      'canopy should show the connected state with the node alias'
    );

    // (4) Issues: existing fixture issue is listed (read path for COBs).
    await navigate(window, `${canopyUrl}/#/${rid}/issues`);
    await waitForWebview(
      window,
      `document.body.textContent.includes('Fixture issue')`,
      'fixture issue should be listed'
    );

    // (5) New issue through the UI. Vue v-model needs real input events.
    await evalInActiveWebview(
      window,
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('New issue'))?.click(), true`
    );
    await waitForWebview(
      window,
      `!!document.querySelector('input[placeholder="Title"]')`,
      'new-issue form should open'
    );
    await evalInActiveWebview(
      window,
      `(() => {
        const set = (el, value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set(document.querySelector('input[placeholder="Title"]'), 'Issue from e2e');
        set(document.querySelector('textarea'), 'Written through window.radicle in a Playwright run.');
        return true;
      })()`
    );
    // Vue re-enables the submit button on the next reactivity flush —
    // clicking in the same synchronous block would hit it while disabled.
    await waitForWebview(
      window,
      `(() => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.includes('Submit new issue'));
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`,
      'submit button should enable and be clicked'
    );

    // Signing consent modal (first signing-tier call for this origin).
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await expect(window.locator('#radicle-consent-title')).toContainText('identity');
    await approve.click();

    // (6) The write lands: canopy navigates to the new issue and the
    // discussion renders — data read back through the rad: scheme.
    await waitForWebview(
      window,
      `document.body.textContent.includes('Issue from e2e') &&
       document.body.textContent.includes('Written through window.radicle')`,
      'new issue should render after creation',
      RENDER_TIMEOUT_MS
    );

    // (7) Identity page: the issue author links to their profile, which
    // aggregates delegate roles and authored COBs across known repos.
    await evalInActiveWebview(
      window,
      `[...document.querySelectorAll('a[href*="/users/did:key:"]')][0]?.click(), true`
    );
    await waitForWebview(
      window,
      `document.body.textContent.includes('radicle-e2e') &&
       document.body.textContent.includes('Maintainer of') &&
       document.body.textContent.includes('e2e-sample') &&
       document.body.textContent.includes('Issue from e2e')`,
      'profile should show alias, maintainer role, and authored issue'
    );

    // (8) Seed-to-browse honesty: a repo that exists nowhere reachable
    // (the fixture node is fully isolated). Seeding must NOT pretend
    // success — the page reports the failed fetch and offers a retry.
    // radicle-desktop's real RID: structurally valid, guaranteed absent.
    const unknownRid = 'rad:z4D5UCArafTzTQpDZNQRuqswh3ury';
    await navigate(window, `${canopyUrl}/#/${unknownRid}`);
    await waitForWebview(
      window,
      `document.body.textContent.includes('Repository not on your node yet')`,
      'unknown repo should show the seed CTA, not a raw node error'
    );
    await evalInActiveWebview(
      window,
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Seed this repository'))?.click(), true`
    );
    // Seed consent (node tier, per-repo prompt).
    await expect(approve).toBeVisible({ timeout: 10_000 });
    await approve.click();
    // Isolated node → zero candidate seeds → honest failure with retry.
    await waitForWebview(
      window,
      `document.body.textContent.includes("Your node couldn't fetch this repository") &&
       [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Try again'))`,
      'failed fetch should surface honestly with a retry',
      60_000
    );
    await waitForWebview(
      window,
      `document.body.textContent.includes('No seeds for it are currently reachable')`,
      'zero reachable seeds should be called out specifically'
    );
    await waitForWebview(
      window,
      `window.radicle.listSeededRepos().then((repos) =>
        repos.some((repo) => repo.rid === '${unknownRid}'))`,
      'failed first fetch should remain visible as an active seeding policy'
    );
    await navigate(window, `${canopyUrl}/#/seeded`);
    await waitForWebview(
      window,
      `document.body.textContent.includes('${unknownRid}') &&
       document.body.textContent.includes('Awaiting first successful fetch')`,
      'canopy should render policy-only repositories without missing metadata'
    );
  });
});
