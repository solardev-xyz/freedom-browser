// Internal pages follow Settings > Appearance, not the OS colour scheme (#233).
//
// The harness runs under Xvfb, where Chromium reports
// `prefers-color-scheme: light` — so seeding `theme: 'dark'` puts the app
// setting and the OS scheme in direct conflict, which is exactly the state the
// bug report describes (dark chrome over white pages). These specs assert the
// *setting* wins on every internal page, that `color-scheme` is declared from
// the same source (the settings scrollbar half of the issue), and that
// 'system' still follows the OS.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

// Every internal page named in #233 that ships both palettes, plus the URL that
// reaches it. `probe` is a selector whose colour flips with the theme, so the
// assertions are not satisfied by the attribute alone.
const PAGES = [
  { name: 'home', url: 'freedom://home', file: '/pages/home.html', probe: 'body' },
  { name: 'history', url: 'freedom://history', file: '/pages/history.html', probe: 'h1' },
  { name: 'downloads', url: 'freedom://downloads', file: '/pages/downloads.html', probe: 'h1' },
  // Both headings moved onto the shared accent pair (#58a6ff dark / #0969da
  // light) in #256, so `h1` flips with the theme here like the rows above and
  // exercises the accent that change standardised.
  { name: 'payments', url: 'freedom://payments', file: '/pages/payments.html', probe: 'h1' },
  { name: 'profiles', url: 'freedom://profiles', file: '/pages/profiles.html', probe: 'h1' },
  { name: 'settings', url: 'freedom://settings', file: '/pages/settings.html', probe: 'body' },
];

const navigate = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
};

// The internal page renders in a <webview>, which Playwright surfaces as a
// separate page on the Electron app.
const pageFor = async (electronApp, file) => {
  let found;
  await expect
    .poll(() => {
      found = electronApp.windows().find((candidate) => candidate.url().includes(file));
      return Boolean(found);
    })
    .toBe(true);
  return found;
};

// `data-theme` plus the two computed values a user actually sees: the UA
// colour scheme (scrollbars, form controls) and a painted colour.
const themeState = (page, probe) =>
  expect
    .poll(async () => {
      try {
        return await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            attribute: document.documentElement.getAttribute('data-theme'),
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
            // Text colour is set on every probe in both palettes; background is
            // a gradient on several of these pages and computes to transparent.
            color: style.color,
          };
        }, probe);
      } catch {
        // Execution context torn down by an in-flight navigation; poll again.
        return null;
      }
    })
    .not.toBe(null);

const readState = (page, probe) =>
  page.evaluate((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    const [r, g, b] = style.color.match(/\d+(\.\d+)?/g).map(Number);
    return {
      attribute: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      // Perceptual luminance of the probe's *text*: light on a dark page, dark
      // on a light one. Keeps the assertion about what is rendered rather than
      // about a specific hex value the design may re-tune.
      textLuminance: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255,
    };
  }, probe);

for (const theme of ['dark', 'light']) {
  test.describe(`theme: '${theme}'`, () => {
    test.use({ seedSettings: { theme } });

    test(`every internal page renders ${theme} regardless of the OS scheme`, async ({
      window,
      electronApp,
    }) => {
      // Precondition: the OS scheme really does disagree with the setting for
      // `dark`, so this spec fails on the pre-#233 code rather than passing by
      // coincidence on a dark desktop.
      const osPrefersDark = await window.evaluate(
        () => window.matchMedia('(prefers-color-scheme: dark)').matches
      );
      expect(osPrefersDark).toBe(false);

      for (const { name, url, file, probe } of PAGES) {
        await navigate(window, url);
        const page = await pageFor(electronApp, file);
        await themeState(page, probe);
        const state = await readState(page, probe);

        expect(state.attribute, `${name}: data-theme`).toBe(theme);
        // Declared so Chromium paints the scrollbar to match — the settings
        // Shortcuts / Name Resolution sections scroll (#233).
        expect(state.colorScheme, `${name}: color-scheme`).toBe(theme);
        if (theme === 'dark') {
          expect(state.textLuminance, `${name}: text should be light-on-dark`).toBeGreaterThan(0.5);
        } else {
          expect(state.textLuminance, `${name}: text should be dark-on-light`).toBeLessThan(0.5);
        }
      }
    });
  });
}

test.describe("theme: 'system'", () => {
  test.use({ seedSettings: { theme: 'system' } });

  test('still follows the OS colour scheme', async ({ window, electronApp }) => {
    const osTheme = (await window.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches
    ))
      ? 'dark'
      : 'light';

    for (const { name, url, file, probe } of PAGES) {
      await navigate(window, url);
      const page = await pageFor(electronApp, file);
      await themeState(page, probe);
      const state = await readState(page, probe);
      expect(state.attribute, `${name}: data-theme under 'system'`).toBe(osTheme);
      expect(state.colorScheme, `${name}: color-scheme under 'system'`).toBe(osTheme);
    }
  });
});

// The error page and the name interstitials are reachable only through a
// failure path, so they get their own case rather than a row in PAGES.
test.describe("theme: 'dark' — pages reached through a failure path", () => {
  test.use({ seedSettings: { theme: 'dark' } });

  test('the error page and the name interstitial follow the setting too', async ({
    window,
    harness,
    electronApp,
  }) => {
    await harness.setProbeFixture(SAMPLE_BZZ_HASH, { ok: false, reason: 'not_found' });
    await navigate(window, `bzz://${SAMPLE_BZZ_HASH}`);
    const errorPage = await pageFor(electronApp, '/pages/error.html');
    await themeState(errorPage, 'body');
    const error = await readState(errorPage, 'body');
    expect(error.attribute, 'error page: data-theme').toBe('dark');
    expect(error.colorScheme, 'error page: color-scheme').toBe('dark');
    expect(error.textLuminance, 'error page: text should be light-on-dark').toBeGreaterThan(0.5);

    // `ens-unverified.html` (styled by the shared interstitial.css) is the
    // page every unverified-name flow lands on — ENS, Tezos and onchain names.
    await harness.setEnsFixture('retry.tez', {
      type: 'ok',
      system: 'tezos',
      protocol: 'ipfs',
      decoded: 'QmRetryTez',
      uri: 'ipfs://QmRetryTez',
      trust: { level: 'unverified', system: 'tezos', agreed: ['rpc-one.test'] },
    });
    await navigate(window, 'retry.tez');
    const interstitial = await pageFor(electronApp, '/pages/ens-unverified.html');
    await themeState(interstitial, 'body');
    const unverified = await readState(interstitial, 'body');
    expect(unverified.attribute, 'interstitial: data-theme').toBe('dark');
    expect(unverified.colorScheme, 'interstitial: color-scheme').toBe('dark');
    expect(unverified.textLuminance, 'interstitial: text should be light-on-dark').toBeGreaterThan(
      0.5
    );
  });
});

test.describe('the Radicle browser', () => {
  test.use({ seedSettings: { theme: 'dark' } });

  test('follows the setting, syntax highlighting included', async ({ window, electronApp }) => {
    // Any well-formed `rad://` URL lands on rad-browser.html; an invalid RID
    // renders its error state without needing a seeded repository.
    await navigate(window, 'rad://znotavalidrid');
    const rad = await pageFor(electronApp, '/pages/rad-browser.html');
    await themeState(rad, 'body');

    const state = await readState(rad, 'body');
    expect(state.attribute).toBe('dark');
    expect(state.colorScheme).toBe('dark');
    expect(state.textLuminance).toBeGreaterThan(0.5);

    // The highlight.js stylesheet is picked in JS, so it needs the same source
    // of truth as the CSS — and has to follow a later change.
    const hljsHref = () =>
      rad.evaluate(() => document.getElementById('hljs-theme')?.getAttribute('href') || '');
    expect(await hljsHref()).toContain('hljs-github-dark.css');

    await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
    await expect.poll(hljsHref).toContain('hljs-github-light.css');
    expect((await readState(rad, 'body')).colorScheme).toBe('light');
  });
});

test.describe('changing the Appearance setting', () => {
  test.use({ seedSettings: { theme: 'dark' } });

  test('repaints an already-open internal page', async ({ window, electronApp }) => {
    await navigate(window, 'freedom://history');
    const history = await pageFor(electronApp, '/pages/history.html');
    await themeState(history, 'h1');
    expect((await readState(history, 'h1')).attribute).toBe('dark');

    await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'light' }));
    await expect.poll(() => readState(history, 'h1').then((s) => s.attribute)).toBe('light');
    expect((await readState(history, 'h1')).colorScheme).toBe('light');

    await window.evaluate(() => window.electronAPI.saveSettings({ theme: 'dark' }));
    await expect.poll(() => readState(history, 'h1').then((s) => s.attribute)).toBe('dark');
    expect((await readState(history, 'h1')).colorScheme).toBe('dark');
  });
});
