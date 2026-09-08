// Theme parity: every chrome surface and internal page renders legibly in
// *both* themes (#261 item 1b).
//
// The 0.8.5 visual audit found 28 UI issues and most were theme bugs that no
// test could see, because nothing in the repo ever rendered the light theme:
// a dark-only Settings page (#223), a `.resolver-config` painted dark with no
// light override (#224), pages ignoring the Appearance setting (#233), and the
// sidebar's permission screens rendering the site origin white on the light
// theme's white sidebar — 1.0 : 1 contrast (#249).
//
// This spec walks the surfaces `.claude/skills/run-freedom/recipes.js` can
// reach — the same recipes the screenshot tour drives — seeded `dark` and then
// `light`, and asserts two things per surface:
//
//   1. the *declared* theme: `<html data-theme>` and the computed
//      `color-scheme` both follow the Appearance setting (that is the #233
//      class of bug, and what makes scrollbars and form controls match);
//   2. the *rendered* theme: every visible heading, paragraph, button and
//      input clears WCAG AA — 4.5 : 1 between its text and the background it
//      is actually painted on.
//
// (2) is what catches #224 and #249: both are perfectly valid CSS that simply
// paints unreadable. `npm test -- src/renderer/renderer-styles.test.js` is the
// static half of the same guard; this is the half that runs the real cascade.
//
// Contrast is measured against the *effective* background — compositing every
// translucent layer up the ancestor chain until an opaque one is found — and
// against the *effective* text colour, folding in each ancestor's `opacity`.
// Elements over a gradient or an image are reported as unmeasurable rather
// than guessed at, so a surface cannot go quietly unchecked either way.

const fs = require('fs');
const path = require('path');

const { test, expect } = require('./fixtures');

const recipes = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'recipes.js')
);
const { pageFor, closeMenus, closeSidebar, dismissOnboarding, go } = require(
  path.join(__dirname, '..', '.claude', 'skills', 'run-freedom', 'lib.js')
);

// WCAG 2.2 AA for text. Large text (>= 24px, or >= 18.66px bold) is allowed
// 3:1 by the standard; the surfaces here are dense UI chrome, so the spec holds
// everything to 4.5 and lists the large-text allowance only where a heading
// genuinely relies on it.
const AA = 4.5;
const AA_LARGE = 3;
// Placeholder text is held to 3:1 rather than 4.5:1, and only because nothing
// in the renderer sets `::placeholder` at all: Chromium's own default grey
// (`rgb(117, 117, 117)`) measures 4.14:1 on the light input fill and 3.38:1 on
// the dark one, so a 4.5 bar here would be asserting a palette decision this PR
// has no mandate to make. Choosing a placeholder colour is #261 item 2/3 work;
// the value a user types is held to the full 4.5.
const AA_PLACEHOLDER = 3;

// Serialised into the page: no imports available there, so it is one string.
const PROBE = `(() => {
  // Finish every finite animation first. Several primary buttons transition
  // their background, and a measurement taken mid-transition reads an
  // interpolated colour — the same run measured 4.18:1 and 4.31:1 for the send
  // Confirm button on consecutive passes before this was here. Infinite
  // animations (spinners) throw on finish() and are left running.
  for (const animation of document.getAnimations()) {
    try {
      animation.finish();
    } catch {
      /* infinite duration */
    }
  }

  const parse = (value) => {
    const m = String(value).match(/-?[\\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b, a] = m.map(Number);
    return { r, g, b, a: a === undefined ? 1 : a };
  };
  // src over dst, both premultiplied-free sRGB.
  const over = (src, dst) => {
    const a = src.a + dst.a * (1 - src.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (s, d) => (s * src.a + d * dst.a * (1 - src.a)) / a;
    return { r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a };
  };
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = ({ r, g, b }) =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };

  // The backgrounds an element is really painted on: composite every
  // translucent layer up the ancestor chain until an opaque one is found.
  //
  // Returns a *list*, because several internal pages paint their body with a
  // gradient (profiles/history/payments all use
  // \`linear-gradient(135deg, #0d1117, #161b22, #21262d)\`). Text over a gradient
  // has a different contrast at every point, so each colour stop becomes its own
  // candidate and the caller takes the worst one — readable against every stop
  // is readable everywhere. A bitmap background cannot be reasoned about at all,
  // and returns null: reported as unmeasurable rather than guessed at, so a
  // surface cannot go quietly unchecked either way.
  const effectiveBackgrounds = (el) => {
    let acc = { r: 0, g: 0, b: 0, a: 0 };
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const image = style.backgroundImage;
      if (image && image !== 'none') {
        const stops = [...image.matchAll(/rgba?\\([^)]*\\)/g)].map((m) => parse(m[0]));
        if (!stops.length || stops.some((s) => !s)) return null;
        const opaque = stops.filter((s) => s.a > 0);
        if (!opaque.length) return null;
        return opaque.map((stop) => over(acc, stop));
      }
      const bg = parse(style.backgroundColor);
      if (bg && bg.a > 0) {
        acc = over(acc, bg);
        if (acc.a >= 0.999) return [acc];
      }
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (root && root.a >= 0.999) return [over(acc, root)];
    // Nothing opaque anywhere: the UA canvas, which follows color-scheme.
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    return [over(acc, dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 })];
  };

  const cumulativeOpacity = (el) => {
    let o = 1;
    for (let node = el; node; node = node.parentElement) {
      o *= Number(getComputedStyle(node).opacity);
    }
    return o;
  };

  // On screen, not merely in the DOM. A collapsed sidebar is translated out of
  // the window rather than hidden, so its buttons still measure 8px+ and would
  // otherwise be judged on a surface the user is not looking at.
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  };

  // Headings, body copy, buttons and inputs — the four #261 names — but by
  // *painted text*, not by tag: the nodes menu, the wallet rows and most of the
  // chrome write their copy into \`<span>\`s and \`<div>\`s, and a tag allow-list
  // would have declared those surfaces clean because it never looked at them.
  // Only an element's *own* text counts (a wrapper's text belongs to its
  // children), and never a disabled control: WCAG exempts those.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();

  const results = [];
  for (const el of document.querySelectorAll('*')) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    if (el.closest('[hidden], .hidden, [aria-hidden="true"]')) continue;
    if (!visible(el)) continue;

    const isField = /^(input|select|textarea)$/i.test(el.tagName);
    const text = isField ? el.value || el.placeholder || '' : ownText(el);
    if (!text) continue;

    const style = getComputedStyle(el);
    const backgrounds = effectiveBackgrounds(el);
    if (!backgrounds) {
      results.push({ el: describe(el), text: text.slice(0, 40), unmeasurable: true });
      continue;
    }
    // Placeholder text is its own colour and is the one users most often
    // cannot read on a re-themed input.
    const usingPlaceholder = isField && !el.value && el.placeholder;
    const colorSource = usingPlaceholder
      ? getComputedStyle(el, '::placeholder').color
      : style.color;
    const raw = parse(colorSource);
    if (!raw) continue;
    const alpha = raw.a * cumulativeOpacity(el);
    if (alpha <= 0.05) continue;
    // The worst stop wins: text has to clear the bar everywhere it is painted.
    const ratio = Math.min(
      ...backgrounds.map((bg) => contrast(over({ ...raw, a: alpha }, bg), bg))
    );

    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    results.push({
      el: describe(el),
      text: text.replace(/\\s+/g, ' ').slice(0, 40),
      ratio: Number(ratio.toFixed(2)),
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      placeholder: Boolean(usingPlaceholder),
    });
  }
  return {
    theme: document.documentElement.getAttribute('data-theme'),
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    results,
  };
})()`;

/**
 * Assert one surface: the declared theme, then the contrast of everything
 * legible on it. `page` is whichever Playwright page owns the surface — the
 * chrome window, or the guest page an internal page renders in.
 */
const barFor = (r, allowLarge) => {
  if (r.placeholder) return AA_PLACEHOLDER;
  return allowLarge && r.large ? AA_LARGE : AA;
};

/**
 * Contrast gaps that predate this spec, recorded in
 * `test-e2e/theme-contrast-baseline.json`.
 *
 * The 4.5 bar above is not negotiable for anything new, but the app walked in
 * with 64 AA misses across both themes, and they are palette decisions rather
 * than bugs this PR can decide: white on the dark theme's light-blue `--accent`
 * reads 2.1:1 on every filled primary button; light `--accent` (#1a73e8) is
 * 4.46:1 on white, so every accent-coloured label in the light theme sits just
 * under the line; the Nodes menu's own greys are 1.8-3.9:1. Repainting any of
 * those is #261 item 2/3 work with a design decision attached.
 *
 * So they are recorded, with what they measured, and the check is the same
 * two-sided ratchet the colour-literal inventory uses:
 *
 *   - a failure that is *not* recorded fails the spec — the whole point;
 *   - a recorded gap that got worse fails;
 *   - a recorded gap that now clears the bar fails too, with "delete this
 *     entry", so the list can only ever shrink;
 *   - a recorded gap that has vanished from the surface fails the same way.
 *
 * Regenerate after fixing some (never as a way of silencing new ones):
 *
 *     xvfb-run -a npm run test:e2e:theme-parity:update
 */
const BASELINE_FILE = path.join(__dirname, 'theme-contrast-baseline.json');
const BASELINE = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const UPDATE = process.env.THEME_CONTRAST_UPDATE === '1';

// Measured ratios still wobble by a few hundredths between runs (subpixel
// antialiasing of the composited text colour), so both sides of the ratchet
// carry a small band rather than comparing exactly. It is far below the size of
// any real regression: #249 was 1.0:1 and #224's rows land near 1.3:1.
const TOLERANCE = 0.1;

const gapKey = ({ surface, theme, el }) => `${surface}|${theme}|${el}`;

const recorded = new Map(BASELINE.gaps.map((g) => [gapKey(g), g]));
/** Filled during an update run, written out by the afterAll below. */
const collected = new Map();

async function assertSurface(page, { label, theme, allowLarge = true, minSamples = 1 }) {
  const state = await page.evaluate(PROBE);

  // The chrome window declares only the *light* theme on `<html>` — dark is the
  // `:root` default, so the attribute is absent — while internal pages stamp
  // both (#233). Both are correct as long as `color-scheme` agrees, which is
  // the value Chromium actually paints scrollbars and form controls from, so
  // that is asserted unconditionally and the attribute is normalised.
  //
  // Soft: one walk through a dozen surfaces should report every surface that is
  // wrong, not stop at the first one — the same reason the screenshot spec is
  // soft. The test still fails; it just fails with the whole picture.
  expect.soft(state.theme ?? 'dark', `${label}: html[data-theme]`).toBe(theme);
  expect.soft(state.colorScheme, `${label}: computed color-scheme`).toBe(theme);

  const measurable = state.results.filter((r) => !r.unmeasurable);
  // A surface that yields nothing is not a passing surface — it means the
  // recipe never reached the state and the assertions below are vacuous.
  expect
    .soft(measurable.length, `${label}: measurable text nodes`)
    .toBeGreaterThanOrEqual(minSamples);

  // Several elements can share one description (every `.bee-info-label` row);
  // the worst of them is the one that has to hold, so they collapse to a single
  // key carrying the minimum ratio.
  const worst = new Map();
  for (const r of measurable) {
    const key = gapKey({ surface: label, theme, el: r.el });
    const bar = barFor(r, allowLarge);
    const prev = worst.get(key);
    if (!prev || r.ratio < prev.ratio) worst.set(key, { ...r, bar, surface: label, theme });
  }

  if (UPDATE) {
    for (const [key, r] of worst) {
      if (r.ratio < r.bar) {
        collected.set(key, {
          surface: label,
          theme,
          el: r.el,
          text: r.text,
          ratio: r.ratio,
          bar: r.bar,
        });
      }
    }
    return;
  }

  const failures = [];
  for (const [key, r] of worst) {
    const known = recorded.get(key);
    if (!known) {
      if (r.ratio < r.bar) {
        failures.push(`${label} [${theme}] ${r.el} "${r.text}" — ${r.ratio}:1 (needs ${r.bar}:1)`);
      }
      continue;
    }
    if (r.ratio >= r.bar + TOLERANCE) {
      failures.push(
        `${label} [${theme}] ${r.el} — now ${r.ratio}:1, clears ${r.bar}:1; delete its entry ` +
          `from theme-contrast-baseline.json`
      );
    } else if (r.ratio < known.ratio - TOLERANCE) {
      failures.push(
        `${label} [${theme}] ${r.el} "${r.text}" — ${r.ratio}:1, worse than the ` +
          `recorded ${known.ratio}:1`
      );
    }
  }
  for (const [key, gap] of recorded) {
    if (gap.surface === label && gap.theme === theme && !worst.has(key)) {
      failures.push(
        `${label} [${theme}] ${gap.el} — recorded at ${gap.ratio}:1 and no longer on this ` +
          `surface; delete its entry from theme-contrast-baseline.json`
      );
    }
  }
  expect.soft(failures).toEqual([]);
}

// An update run rewrites the baseline from what it just measured. Deliberately
// gated on an env var and its own npm script, so no ordinary run can quietly
// absorb a regression.
test.afterAll(() => {
  if (!UPDATE) return;
  const gaps = [...collected.values()].sort((a, b) =>
    gapKey(a) < gapKey(b) ? -1 : gapKey(a) > gapKey(b) ? 1 : 0
  );
  fs.writeFileSync(
    BASELINE_FILE,
    `${JSON.stringify({ issue: BASELINE.issue, total: gaps.length, gaps }, null, 2)}\n`
  );
  console.log(`wrote ${gaps.length} recorded contrast gaps to ${BASELINE_FILE}`);
});

// ---------------------------------------------------------------------------
// The surfaces, all reached through recipes.js.

/** Settings sections worth walking; `ens` is the one #224 lived on. */
const SETTINGS_SECTIONS = ['appearance', 'nodes', 'ens', 'permissions', 'shortcuts', 'chains'];

/** Internal pages, by the URL that reaches them and the file they render in. */
const INTERNAL_PAGES = [
  { name: 'home', url: 'freedom://home', file: '/pages/home.html' },
  { name: 'history', url: 'freedom://history', file: '/pages/history.html' },
  { name: 'downloads', url: 'freedom://downloads', file: '/pages/downloads.html' },
  { name: 'payments', url: 'freedom://payments', file: '/pages/payments.html' },
  { name: 'profiles', url: 'freedom://profiles', file: '/pages/profiles.html' },
  { name: 'links', url: 'freedom://links', file: '/pages/links.html' },
];

for (const theme of ['dark', 'light']) {
  test.describe(`theme parity: ${theme}`, () => {
    test.use({ seedSettings: { theme, showBookmarkBar: true } });

    test(`chrome surfaces render legibly in ${theme}`, async ({ electronApp, window }) => {
      // One app launch walked through a dozen surfaces; the per-test budget is
      // the walk, not any single assertion.
      test.setTimeout(240_000);
      const ctx = { app: electronApp, win: window };
      const check = (label, opts) => assertSurface(window, { label, theme, ...opts });

      await check('toolbar');

      await recipes.nodesMenu(ctx);
      await check('nodes menu', { minSamples: 3 });
      await closeMenus(window);

      await recipes.appMenu(ctx, { zoomIn: true });
      await check('app menu', { minSamples: 3 });
      await closeMenus(window);

      await recipes.findBar(ctx);
      await check('find bar');
      await window.keyboard.press('Escape');

      // #249's sibling surface: the permission prompt names the origin.
      await recipes.permissionPrompt(ctx);
      await check('permission prompt', { minSamples: 2 });
      await recipes.answerPermission(ctx, true);
      await window.click('[data-test="permission-indicator"]');
      await window.waitForTimeout(400);
      await check('permission indicator popover');
      await closeMenus(window);

      await recipes.downloadShelf(ctx);
      await check('download shelf');
      await window.click('[data-test="download-close"]');
      await window.waitForSelector('#download-shelf .download-card', { state: 'hidden' });

      await recipes.tabContextMenu(ctx);
      await check('tab context menu', { minSamples: 3 });
      await window.keyboard.press('Escape');

      await window.click('#wallet-toggle-btn');
      await window.waitForTimeout(600);
      await check('sidebar', { minSamples: 2 });
      await dismissOnboarding(window);
      await closeSidebar(window);

      await recipes.onchainApp(ctx);
      await recipes.trustPopover(ctx);
      await check('onchain trust popover', { minSamples: 2 });
      await closeMenus(window);
    });

    test(`wallet and permission subscreens render legibly in ${theme}`, async ({
      electronApp,
      window,
    }) => {
      test.setTimeout(240_000);
      const ctx = { app: electronApp, win: window };
      const check = (label, opts) => assertSurface(window, { label, theme, ...opts });

      const resolve = await recipes.stubWalletIpc(ctx);
      await recipes.sendForm(ctx);
      await check('send form', { minSamples: 2 });

      await window.fill('#send-amount', '0.001');
      await window.click('#send-continue-btn');
      await window.waitForSelector('#send-review-view', { state: 'visible' });
      await check('send review', { minSamples: 2 });
      await window.click('#send-confirm-btn');
      await window.waitForSelector('#send-pending-view', { state: 'visible' });
      await resolve({ success: true, hash: '0xfeedface', recorded: true });
      await window.waitForSelector('#send-success-view', { state: 'visible' });
      await check('send success');

      await recipes.dappTxApproval(ctx);
      await check('dApp transaction approval', { minSamples: 2 });
      await recipes.dappSign(ctx);
      await check('dApp sign', { minSamples: 2 });
      await recipes.dappConnect(ctx);
      await check('dApp connect', { minSamples: 2 });
      for (const kind of ['connect', 'publish', 'messaging', 'feed']) {
        await recipes.swarmApproval(ctx, kind);
        await check(`Swarm ${kind} approval`, { minSamples: 2 });
      }

      // #249 itself: the manage-permissions screens, whose site origin used to
      // render white on the light theme's white sidebar. This assertion fails
      // at 1.0:1 the moment those rules go back to quoting a token the chrome
      // palette does not define.
      await recipes.dappPermissions(ctx);
      await check('dApp manage permissions', { minSamples: 3 });
    });

    test(`internal pages render legibly in ${theme}`, async ({ electronApp, window }) => {
      test.setTimeout(240_000);
      const ctx = { app: electronApp, win: window };

      for (const { name, url, file } of INTERNAL_PAGES) {
        await go(window, url, 1_500);
        const page = await pageFor(electronApp, file);
        expect(page, `${name}: page not found`).toBeTruthy();
        await assertSurface(page, { label: `page ${name}`, theme });
      }

      // #224 lived in Settings > Name Resolution: `.resolver-config` painted a
      // hard-coded dark background with no light override, so its rows stayed
      // dark — and their dark text unreadable — on the light theme.
      for (const section of SETTINGS_SECTIONS) {
        const page = await recipes.settings(ctx, section);
        await assertSurface(page, { label: `settings ${section}`, theme, minSamples: 2 });
      }
    });

    test(`failure-path pages render legibly in ${theme}`, async ({ electronApp, window }) => {
      test.setTimeout(180_000);
      const ctx = { app: electronApp, win: window };

      await recipes.errorPage(ctx);
      const error = await pageFor(electronApp, '/pages/error.html');
      expect(error, 'error page not found').toBeTruthy();
      await assertSurface(error, { label: 'error page', theme });

      await recipes.tezInterstitial(ctx, 'unverified');
      const unverified = await pageFor(electronApp, '/pages/ens-unverified.html');
      expect(unverified, 'unverified interstitial not found').toBeTruthy();
      await assertSurface(unverified, { label: 'unverified interstitial', theme, minSamples: 2 });

      await recipes.tezInterstitial(ctx, 'conflict');
      const conflict = await pageFor(electronApp, '/pages/ens-conflict.html');
      expect(conflict, 'conflict interstitial not found').toBeTruthy();
      await assertSurface(conflict, { label: 'conflict interstitial', theme, minSamples: 2 });
    });
  });
}
