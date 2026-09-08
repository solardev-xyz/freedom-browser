// Committed screenshot baselines for every surface the UI tour visits, in both
// themes (#261 item 1c).
//
// `.claude/skills/run-freedom/tour.js` already drives ~50 surfaces in dark and
// light; until now a human had to look at the output. This spec drives the same
// recipes through Playwright's `toHaveScreenshot`, against baselines committed
// under `test-e2e/__screenshots__/`, so a renderer change that repaints a
// surface it did not mean to shows up as a diff artifact on the PR instead of
// waiting for the next manual audit.
//
// ## Updating the baselines
//
//     npm run test:e2e:screenshots:update      # under xvfb, see below
//
// in full:
//
//     xvfb-run -a npm run test:e2e:screenshots:update
//
// Review the resulting diff (`git diff --stat test-e2e/__screenshots__/`) the
// way you would review any other change: a baseline that moved without an
// intended visual change is the finding, not the noise.
//
// The baselines are rendered on Linux. Font rasterisation differs enough
// between platforms that a macOS or Windows run would rewrite every file, so
// the spec only runs there when explicitly asked (`FREEDOM_SCREENSHOTS=1`), and
// CI compares on `ubuntu-latest` only. When a CI run disagrees with locally
// generated baselines, take CI's: download the `renderer-screenshots-diff`
// artifact from the failed job and run
//
//     node scripts/apply-screenshot-baselines.js <unzipped-artifact-dir>
//
// which copies every `*-actual.png` back over its baseline.
//
// Both npm scripts set `FREEDOM_E2E_STABLE_TEXT=1`, which launches Electron
// with `--disable-lcd-text --disable-font-subpixel-positioning`. Without it
// Chromium flips a surface between subpixel and greyscale text antialiasing as
// composited layers come and go, repainting every glyph with different colour
// fringes — ~1% of the frame on a page nothing changed on, bistable rather than
// random, so no amount of waiting settles it. Run the spec by its npm script,
// not by a bare `playwright test`, or the baselines will not match.
//
// ## Why the masks
//
// Peer counts, node versions, finalized block heights, download sizes and
// progress bars move between runs even against the stubbed harness. They are
// masked per surface rather than globally, so a mask can never quietly cover a
// region a later change actually breaks. The guest `<webview>` is masked on the
// *chrome* surfaces for the same reason in reverse: what a menu looks like must
// not depend on the page behind it (and the new-tab artwork behind it is a
// megabyte of PNG per baseline).

const path = require('path');

const { test, expect } = require('./fixtures');

const recipes = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'recipes.js')
);
const { pageFor, closeMenus, closeSidebar, dismissOnboarding, go } = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'lib.js')
);

// Linux-only by default: see the header. `FREEDOM_SCREENSHOTS=1` opts a
// non-Linux machine in, knowing it will rewrite the baselines.
const ENABLED = process.platform === 'linux' || process.env.FREEDOM_SCREENSHOTS === '1';

// Small enough that a one-pixel shift fails, loose enough that antialiasing on
// a differently-loaded runner does not. `threshold` is per-pixel colour
// distance; `maxDiffPixelRatio` is how much of the frame may differ at all.
const COMPARE = {
  threshold: 0.15,
  maxDiffPixelRatio: 0.002,
  animations: 'disabled',
  caret: 'hide',
  timeout: 20_000,
};

/** Values that move between runs even against the stubbed harness. */
const VOLATILE = [
  // Nodes menu: every `label: value` row's value column.
  '.bee-info-row > span:last-child',
  '.ipfs-info-row > span:last-child',
  '.radicle-info-row > span:last-child',
  '.tor-info-row > span:last-child',
  // Download shelf: byte counts and the progress bar.
  '.download-progress',
  '.download-status',
  '.download-size',
];

const maskFor = (page, extra = []) =>
  [...VOLATILE, ...extra].map((selector) => page.locator(selector));

/**
 * One baseline. Soft on purpose: a walk through 25 surfaces should report every
 * surface that moved, not stop at the first one, so a single CI run produces
 * the whole diff artifact.
 */
async function snap(page, name, { mask = [], extra = [] } = {}) {
  await expect
    .soft(page)
    .toHaveScreenshot(`${name}.png`, { ...COMPARE, mask: [...maskFor(page, extra), ...mask] });
}

test.describe('renderer screenshots', () => {
  test.skip(!ENABLED, 'baselines are rendered on Linux; set FREEDOM_SCREENSHOTS=1 to override');

  for (const theme of ['dark', 'light']) {
    test.describe(`theme: ${theme}`, () => {
      test.use({ seedSettings: { theme, showBookmarkBar: true } });

      test(`chrome surfaces (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        // The guest is not the subject of a chrome baseline, and the new-tab
        // artwork behind it costs ~1 MB per file.
        const guest = [window.locator('webview')];
        const shot = (name, opts = {}) =>
          snap(window, `${theme}-${name}`, { mask: guest, ...opts });

        await shot('01-landing');

        await recipes.nodesMenu(ctx);
        await shot('02-nodes-menu');
        await closeMenus(window);

        await recipes.appMenu(ctx, { zoomIn: true });
        await shot('03-app-menu');
        await closeMenus(window);

        await recipes.findBar(ctx);
        await shot('04-find-bar');
        await window.fill('[data-test="find-bar-input"]', 'zzzz-none');
        await window.waitForTimeout(600);
        await shot('05-find-bar-no-match');
        await window.keyboard.press('Escape');

        await recipes.permissionPrompt(ctx);
        await shot('06-permission-prompt');
        await recipes.answerPermission(ctx, true);
        await window.waitForSelector('[data-test="permission-indicator"]', { state: 'visible' });
        await window.click('[data-test="permission-indicator"]');
        await window.waitForTimeout(500);
        await shot('07-permission-indicator-open');
        await closeMenus(window);

        await recipes.downloadShelf(ctx);
        await shot('08-download-shelf');
        await window.click('[data-test="download-close"]');
        await window.waitForSelector('#download-shelf .download-card', { state: 'hidden' });

        await recipes.tabContextMenu(ctx);
        await shot('09-tab-context-menu');
        await window.keyboard.press('Escape');
        await recipes.muteTab(ctx, { pin: true });
        await window.click('[data-test="new-tab-btn"]');
        await window.waitForTimeout(600);
        await shot('10-tab-pinned-muted');

        await window.click('#wallet-toggle-btn');
        await window.waitForTimeout(800);
        await shot('11-sidebar-default');
        await dismissOnboarding(window);
        await closeSidebar(window);

        await recipes.onchainApp(ctx);
        await recipes.trustPopover(ctx);
        await shot('24-onchain-trust-popover');
        await closeMenus(window);
      });

      test(`wallet screens (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        const guest = [window.locator('webview')];
        const shot = (name) => snap(window, `${theme}-${name}`, { mask: guest });

        const resolve = await recipes.stubWalletIpc(ctx);
        await recipes.sendForm(ctx);
        await shot('12-send-form');
        await window.fill('#send-amount', '0.001');
        await window.click('#send-continue-btn');
        await window.waitForSelector('#send-review-view', { state: 'visible' });
        await shot('13-send-review');
        await window.click('#send-confirm-btn');
        await window.waitForSelector('#send-pending-view', { state: 'visible' });
        await shot('14-send-pending');
        await resolve({ success: true, hash: '0xfeedface', recorded: true });
        await window.waitForSelector('#send-success-view', { state: 'visible' });
        await shot('15-send-success');

        await recipes.dappTxApproval(ctx);
        await shot('16-dapp-tx');
        await recipes.dappSign(ctx);
        await shot('17-dapp-sign');
        await recipes.dappConnect(ctx);
        await shot('18-dapp-connect');
        for (const [i, kind] of ['connect', 'publish', 'messaging', 'feed'].entries()) {
          await recipes.swarmApproval(ctx, kind);
          await shot(`${19 + i}-swarm-${kind}`);
        }
        await recipes.dappPermissions(ctx);
        await shot('23-dapp-permissions');
      });

      test(`internal pages and interstitials (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        const shot = (name, opts) => snap(window, `${theme}-${name}`, opts);

        await recipes.tezInterstitial(ctx, 'unverified');
        await shot('25-tez-unverified');
        await recipes.tezInterstitial(ctx, 'conflict');
        await shot('26-tez-conflict');
        await recipes.errorPage(ctx);
        await shot('27-error-page');

        for (const [i, page] of ['downloads', 'history', 'profiles', 'payments'].entries()) {
          await go(window, `freedom://${page}`, 1_800);
          await shot(`${50 + i}-page-${page}`);
        }
      });

      test(`settings sections (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        const SECTIONS = [
          'appearance',
          'search',
          'profile',
          'nodes',
          'startup',
          'downloads',
          'shortcuts',
          'chains',
          'rpc',
          'ens',
          'adblock',
          'permissions',
          'experimental',
          'updates',
        ];
        // `recipes.settings()` re-navigates the tab for every section, which is
        // ~6s each and the single biggest cost in this spec. The page is a hash
        // router, so the first call opens it and the rest only move the hash —
        // the same 14 rendered states, a third of the wall clock, which is what
        // keeps the CI job inside its budget.
        const page = await recipes.settings(ctx, SECTIONS[0]);
        await snap(window, `${theme}-30-settings-${SECTIONS[0]}`);
        for (const [i, section] of SECTIONS.entries()) {
          if (i === 0) continue;
          await page.evaluate((hash) => {
            location.hash = hash;
          }, section);
          await page.waitForTimeout(600);
          await snap(window, `${theme}-${30 + i}-settings-${section}`);
        }
        await recipes.shortcutConflict(ctx);
        await snap(window, `${theme}-45-settings-shortcut-conflict`);
      });

      test(`private window (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(240_000);
        const ctx = { app: electronApp, win: window };
        const priv = await recipes.privateWindow(ctx);
        await snap(priv, `${theme}-60-private-window`, { mask: [priv.locator('webview')] });
        await priv.click('#wallet-toggle-btn');
        await priv.waitForSelector('#sidebar:not(.collapsed)');
        await priv.waitForTimeout(500);
        await snap(priv, `${theme}-61-private-sidebar`, { mask: [priv.locator('webview')] });
      });

      test(`internal page: home (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(120_000);
        await go(window, 'freedom://home', 1_800);
        const page = await pageFor(electronApp, '/pages/home.html');
        expect(page, 'home page not found').toBeTruthy();
        // The guest page, clipped to the copy. The full frame is a `body::before`
        // photograph — not maskable (it is a pseudo-element), a static asset
        // that cannot regress, and a megabyte of PNG in every baseline. The
        // crop still carries what can: the logo variant the theme picks, the
        // heading and body colours, and the type scale.
        await expect.soft(page).toHaveScreenshot(`${theme}-49-page-home.png`, {
          ...COMPARE,
          clip: { x: 0, y: 0, width: 640, height: 260 },
        });
      });
    });
  }
});
