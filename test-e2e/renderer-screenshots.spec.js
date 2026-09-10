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
// That command only rewrites the baselines the *comparison* rejects, and the
// comparison is tolerant on purpose (see `COMPARE`) — so a surface can repaint
// for real and still pass, leaving its baseline depicting UI that no longer
// exists. Adopting a change made somewhere else (a merge from `main`) is the
// case where that matters: re-render every surface instead, and read what
// moved.
//
//     FREEDOM_E2E_STABLE_TEXT=1 xvfb-run -a npx playwright test \
//       --project=harness test-e2e/renderer-screenshots.spec.js \
//       --update-snapshots=all
//
// Byte equality is *not* the bar for that sweep: a repeat run of it rewrites
// ~14 of the 98 files with per-channel deltas of 1–2/255 (gradient dithering,
// invisible, measured over two consecutive runs). Compare the re-rendered file
// with its committed self and adopt the ones that differ by more than that —
// `git checkout` the rest rather than committing dithering.
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
// random, so no amount of waiting settles it. The spec therefore skips itself
// unless that variable is set: this file sits in `test-e2e/`, so the `harness`
// project picks it up, and a plain `npm run test:e2e` would otherwise spend
// ~8 minutes failing most of these tests on glyph fringes alone. Run it by its
// npm script.
//
// ## Why the masks
//
// Peer counts, node versions, finalized block heights, download sizes and
// progress bars move between runs even against the stubbed harness. They are
// masked per surface rather than globally, so a mask can never quietly cover a
// region a later change actually breaks. The guest `<webview>` is masked on the
// *chrome* surfaces for the same reason in reverse: what a menu looks like must
// not depend on the page behind it (and the new-tab artwork behind it is a
// megabyte of PNG per baseline). On the surfaces where the guest *is* the
// subject, the one strip it paints that does not settle — its own native
// scrollbar — is masked instead; see `guestScrollbarMask`.

const path = require('path');

const { test, expect } = require('./fixtures');

const recipes = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'recipes.js')
);
const { pageFor, closeMenus, closeSidebar, dismissOnboarding, go } = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'lib.js')
);
const { screenshotGate } = require('./screenshot-gate');
const { THEMES, baselineFiles, groupFiles } = require('./screenshot-baselines');

// Linux, and LCD text off. See `screenshot-gate.js` for both conditions and
// why a run that meets neither has nothing to say.
const { enabled: ENABLED, reason: SKIP_REASON } = screenshotGate();

// Loose enough that antialiasing on a differently-loaded runner does not fail
// a run. `threshold` is per-pixel colour distance; `maxDiffPixelRatio` is how
// much of the frame may differ at all.
//
// It is not a one-pixel tripwire, and the slack is not spread evenly over the
// two themes: `threshold` is measured in YIQ, so the same copy change that
// fails on the light theme's near-black-on-white body text (30 000 pixels
// counted) can go uncounted on the dark theme's grey-on-grey. #334's settings
// rewrite landed exactly that way — the light baselines failed and were
// adopted, their dark twins passed and stayed behind showing the old copy for
// two rounds. Hence the full re-render sweep documented at the top of this
// file whenever a round adopts a UI change it did not write.
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

// The guest's native scrollbar, as something `mask` can be given.
//
// Chromium paints a `<webview>`'s scrollbar from its own compositor layer, and
// on a scrolling internal page that layer is bistable: the same section — whose
// `scrollHeight`/`clientHeight` measure identical on every run — paints a thumb
// of two different lengths, and a capture lands on either one both across runs
// and seconds apart inside a single run, so it is not something a longer wait
// settles. Measured on `settings#ens`, the flip is ~1 600 px, 83% of this
// spec's whole `maxDiffPixelRatio` budget, spent on scroll chrome that is not
// the subject of the baseline. Left of the strip everything still compares, and
// a section that grows or shrinks still shows up there.
//
// `mask` only takes locators and the scrollbar lives inside the guest, which is
// a different page from the one being captured — so the strip is masked by
// parking a fixed, transparent, pointer-events-free element over it in the
// window itself.
const GUEST_SCROLLBAR_MASK = 'screenshot-guest-scrollbar-mask';
// Wide enough for Chromium's 9px Linux scrollbar plus the guest's own border.
//
// 15, not the 14 this started at: the repaint reaches one pixel further left
// than the strip did. Measured rather than guessed — a fresh render of
// `light-40-settings-adblock` compared with its committed self differs by 430
// pixels over 8/255, every one of them in the single column x=1185 the 14px
// strip left uncovered (y 318–799), and none at x=1184. That is 22% of the
// whole `maxDiffPixelRatio` budget spent on the same bistable scroll chrome the
// mask exists to drop, stacking with any real diff on these surfaces.
//
// Widening it repaints one column of every baseline this mask is used on, since
// `mask` is painted into the capture (`#FF00FF`) rather than skipped during
// comparison. The 44 files are regenerated in the same commit.
const GUEST_SCROLLBAR_WIDTH = 15;

async function guestScrollbarMask(win) {
  const boxes = await Promise.all(
    (await win.locator('webview').all()).map((locator) => locator.boundingBox().catch(() => null))
  );
  const box = boxes.find((b) => b && b.width > 0 && b.height > 0);
  if (!box) return [];
  await win.evaluate(
    ({ id, rect }) => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
      }
      // Assigned through CSSOM rather than a style attribute, so the window's
      // CSP has nothing to say about it.
      Object.assign(el.style, {
        position: 'fixed',
        pointerEvents: 'none',
        background: 'transparent',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    },
    {
      id: GUEST_SCROLLBAR_MASK,
      rect: {
        left: box.x + box.width - GUEST_SCROLLBAR_WIDTH,
        top: box.y,
        width: GUEST_SCROLLBAR_WIDTH,
        height: box.height,
      },
    }
  );
  return [win.locator(`#${GUEST_SCROLLBAR_MASK}`)];
}

const BASELINE_FILES = baselineFiles();

/**
 * The surfaces one test is on the hook for, and both directions of the check
 * against `screenshot-baselines.js`.
 *
 * `declared()` gives back the file a surface compares against, having checked
 * the surface is one that file knows about (taken → declared). That is what the
 * stranded-baseline check in `renderer-screenshots-gate.test.js` measures the
 * committed PNGs against, so a name spelled only here would make the two files
 * it does commit look stranded.
 *
 * `tookEverySurface()` is the other direction, and the one that matters for a
 * surface going missing: a name spelled only in `screenshot-baselines.js` means
 * this spec stopped taking it, while its two committed PNGs stay in the tree
 * reading as regression coverage nothing compares against — and neither the
 * gate test (committed PNGs = declared list) nor `declared()` (taken ⊆
 * declared) has anything to say about that. Deleting or commenting out a
 * `shot()` call now fails the test that owned it.
 *
 * Scoped to one test's group rather than the whole file because Playwright may
 * shard these tests across workers, and `--grep` may run one of them — a
 * file-wide tally would fail every partial run instead of catching anything.
 *
 * Soft, like the comparison itself: one run reports every surface that drifted,
 * whichever way it drifted.
 */
function surfaceGroup(theme, group) {
  const expected = groupFiles(theme, group);
  const taken = new Set();
  return {
    declared(name) {
      const file = `${name}.png`;
      expect
        .soft(BASELINE_FILES, `${file} is not declared in test-e2e/screenshot-baselines.js`)
        .toContain(file);
      taken.add(file);
      return file;
    },
    tookEverySurface() {
      expect
        .soft(
          expected.filter((file) => !taken.has(file)),
          `declared under "${group}" in test-e2e/screenshot-baselines.js but never taken — restore the shot, or delete the surface and its committed baselines`
        )
        .toEqual([]);
    },
  };
}

/**
 * One baseline. Soft on purpose: a walk through 25 surfaces should report every
 * surface that moved, not stop at the first one, so a single CI run produces
 * the whole diff artifact.
 */
async function snap(surfaces, page, name, { mask = [], extra = [] } = {}) {
  await expect
    .soft(page)
    .toHaveScreenshot(surfaces.declared(name), {
      ...COMPARE,
      mask: [...maskFor(page, extra), ...mask],
    });
}

test.describe('renderer screenshots', () => {
  test.skip(!ENABLED, SKIP_REASON);

  for (const theme of THEMES) {
    test.describe(`theme: ${theme}`, () => {
      test.use({ seedSettings: { theme, showBookmarkBar: true } });

      test(`chrome surfaces (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        // The guest is not the subject of a chrome baseline, and the new-tab
        // artwork behind it costs ~1 MB per file.
        const guest = [window.locator('webview')];
        const surfaces = surfaceGroup(theme, 'chrome surfaces');
        const shot = (name, opts = {}) =>
          snap(surfaces, window, `${theme}-${name}`, { mask: guest, ...opts });

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
        surfaces.tookEverySurface();
      });

      test(`wallet screens (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        const guest = [window.locator('webview')];
        const surfaces = surfaceGroup(theme, 'wallet screens');
        const shot = (name) => snap(surfaces, window, `${theme}-${name}`, { mask: guest });

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
        surfaces.tookEverySurface();
      });

      test(`internal pages and interstitials (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(300_000);
        const ctx = { app: electronApp, win: window };
        // The guest page is the subject here, so it is not masked — only the
        // strip its scrollbar paints in. See `guestScrollbarMask`.
        await recipes.tezInterstitial(ctx, 'unverified');
        const scrollbar = await guestScrollbarMask(window);
        const surfaces = surfaceGroup(theme, 'internal pages and interstitials');
        const shot = (name, opts = {}) =>
          snap(surfaces, window, `${theme}-${name}`, { mask: scrollbar, ...opts });

        await shot('25-tez-unverified');
        await recipes.tezInterstitial(ctx, 'conflict');
        await shot('26-tez-conflict');
        await recipes.errorPage(ctx);
        await shot('27-error-page');

        for (const [i, page] of ['downloads', 'history', 'profiles', 'payments'].entries()) {
          await go(window, `freedom://${page}`, 1_800);
          await shot(`${50 + i}-page-${page}`);
        }
        surfaces.tookEverySurface();
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
        // Every section in this walk scrolls. See `guestScrollbarMask`.
        const scrollbar = await guestScrollbarMask(window);
        const surfaces = surfaceGroup(theme, 'settings sections');
        const shot = (name) => snap(surfaces, window, `${theme}-${name}`, { mask: scrollbar });

        await shot(`30-settings-${SECTIONS[0]}`);
        for (const [i, section] of SECTIONS.entries()) {
          if (i === 0) continue;
          await page.evaluate((hash) => {
            location.hash = hash;
          }, section);
          await page.waitForTimeout(600);
          await shot(`${30 + i}-settings-${section}`);
        }
        await recipes.shortcutConflict(ctx);
        await shot('45-settings-shortcut-conflict');
        surfaces.tookEverySurface();
      });

      test(`private window (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(240_000);
        const ctx = { app: electronApp, win: window };
        const surfaces = surfaceGroup(theme, 'private window');
        const priv = await recipes.privateWindow(ctx);
        await snap(surfaces, priv, `${theme}-60-private-window`, {
          mask: [priv.locator('webview')],
        });
        await priv.click('#wallet-toggle-btn');
        await priv.waitForSelector('#sidebar:not(.collapsed)');
        await priv.waitForTimeout(500);
        await snap(surfaces, priv, `${theme}-61-private-sidebar`, {
          mask: [priv.locator('webview')],
        });
        surfaces.tookEverySurface();
      });

      test(`internal page: home (${theme})`, async ({ electronApp, window }) => {
        test.setTimeout(120_000);
        const surfaces = surfaceGroup(theme, 'internal page: home');
        await go(window, 'freedom://home', 1_800);
        const page = await pageFor(electronApp, '/pages/home.html');
        expect(page, 'home page not found').toBeTruthy();
        // The guest page, clipped to the copy. The full frame is a `body::before`
        // photograph — not maskable (it is a pseudo-element), a static asset
        // that cannot regress, and a megabyte of PNG in every baseline. The
        // crop still carries what can: the logo variant the theme picks, the
        // heading and body colours, and the type scale.
        // Not through `snap()` — the clip replaces the masks — but through the
        // same declaration, or this surface would be the one baseline the
        // stranded check could not account for.
        await expect.soft(page).toHaveScreenshot(surfaces.declared(`${theme}-49-page-home`), {
          ...COMPARE,
          clip: { x: 0, y: 0, width: 640, height: 260 },
        });
        surfaces.tookEverySurface();
      });
    });
  }
});
