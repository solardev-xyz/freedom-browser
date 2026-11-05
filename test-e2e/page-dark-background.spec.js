// Web pages keep their own background in both Freedom themes (#923).
//
// Freedom injects page defaults at user origin into every web page, so pages
// without dark-mode support stay readable when the app is dark. It used to
// paint `html, body { background-color: #fff }`, which stopped a dark
// background set on <body> only — x.com in dark mode — from covering the
// window: the canvas stayed white and only <body>'s own box went black. These
// specs read what the user actually sees, the composited pixels of the tab's
// <webview> in the chrome window, for the three cases the issue names:
//
//   1. an X-like page (black on <body> only, short body, fixed nav) fills the
//      window black, including under its nav and below its body;
//   2. an unstyled page (no colours, no color-scheme) is black on white — not
//      the chrome's own background showing through a transparent guest;
//   3. a page using @media (prefers-color-scheme: dark) still goes dark.
//
// Under Xvfb Chromium reports `prefers-color-scheme: light` whatever the app
// theme (see internal-page-theme.spec.js), so cases 2 and 3 also run with the
// guest's media emulated dark — what a macOS/Windows user in dark mode gets.

const { PNG } = require('pngjs');
const { test, expect } = require('./fixtures');

// The repro page attached to #923 (xlike.html), verbatim.
const XLIKE_BODY = `<!doctype html><html><head><title>X-like dark page</title>
<style>body{margin:0;color:#e7e9ea;font:16px system-ui}nav{position:fixed;left:0;top:0;width:220px;padding:20px}main{margin-left:260px;width:520px;background:#000;border:1px solid #2f3336;height:1600px;padding:16px}
#short{height:120px}</style></head>
<body style="background-color:#000">
<div id="short"><b>Top of body (body is only this tall)</b></div>
<nav style="top:140px"><p>Home</p><p>Explore</p><p>Notifications</p><p>Profile</p></nav>
<main style="position:absolute;top:0">Timeline column with its own black background</main>
</body></html>`;

const PLAIN_BODY = '<!doctype html><title>plain page</title><p id="probe">Plain page text</p>';

// Dark only through the media query; light (no rule at all) otherwise.
const PREFERS_DARK_BODY =
  '<!doctype html><title>prefers dark page</title>' +
  '<style>@media (prefers-color-scheme: dark) { html { background: #102030; color: #e0e0e0 } }</style>' +
  '<p id="probe">Prefers-dark page text</p>';

const PAGES = {
  xlike: { hash: 'd'.repeat(64), body: XLIKE_BODY, text: 'Timeline column' },
  plain: { hash: 'e'.repeat(64), body: PLAIN_BODY, text: 'Plain page text' },
  prefers: { hash: 'f'.repeat(64), body: PREFERS_DARK_BODY, text: 'Prefers-dark page text' },
};

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const PREFERS_DARK = [0x10, 0x20, 0x30];

async function guestPage(electronApp, hash) {
  let guest = null;
  await expect
    .poll(
      () => {
        guest = electronApp.windows().find((page) => page.url().includes(hash)) || null;
        return Boolean(guest);
      },
      { message: `Waiting for the guest page for ${hash}`, timeout: 10_000 }
    )
    .toBe(true);
  return guest;
}

async function openFixture(window, electronApp, harness, name) {
  const { hash, body, text } = PAGES[name];
  await harness.setContentFixture(`bzz://${hash}/`, { body });
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(`bzz://${hash}/`);
  await address.press('Enter');
  const guest = await guestPage(electronApp, hash);
  await expect
    .poll(() => guest.evaluate(() => document.body?.textContent || '').catch(() => ''), {
      message: `Waiting for the ${name} page to render`,
      timeout: 10_000,
    })
    .toContain(text);
  return guest;
}

// Pixels of the visible tab as composited in the chrome window, at points
// given as fractions of the webview's box. A guest-page screenshot would not
// do: a transparent guest reads as black there, whatever the chrome paints
// behind it.
async function samplePage(window, points) {
  const box = await window.locator('.webview-container webview:not(.hidden)').boundingBox();
  const png = PNG.sync.read(await window.screenshot({ clip: box }));
  return points.map(([fx, fy]) => {
    const x = Math.min(png.width - 1, Math.round(fx * png.width));
    const y = Math.min(png.height - 1, Math.round(fy * png.height));
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  });
}

const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 2);

async function expectPagePixels(window, points, expected, message) {
  await expect
    .poll(
      async () => {
        const pixels = await samplePage(window, points);
        return pixels.every((px) => near(px, expected)) ? 'ok' : JSON.stringify(pixels);
      },
      { message, timeout: 10_000 }
    )
    .toBe('ok');
}

// Text colour of the probe paragraph (no text is painted at the sample points).
const probeColor = (guest) =>
  guest.evaluate(() => getComputedStyle(document.getElementById('probe')).color);

// Points clear of every piece of text on the fixtures: left edge under the
// fixed nav's column, the bottom-left corner below the X-like page's 120px
// body, and the right-hand side outside its timeline column.
const BACKGROUND_POINTS = [
  [0.01, 0.9],
  [0.1, 0.98],
  [0.95, 0.5],
  [0.95, 0.98],
];

for (const theme of ['dark', 'light']) {
  test.describe(`Freedom ${theme} theme`, () => {
    test.use({ seedSettings: { theme } });

    test('a dark background on <body> only fills the whole window', async ({
      window,
      electronApp,
      harness,
    }) => {
      const guest = await openFixture(window, electronApp, harness, 'xlike');
      // The page leaves <html> alone; nothing Freedom injects may paint it.
      expect(
        await guest.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
      ).toBe('rgba(0, 0, 0, 0)');
      await expectPagePixels(
        window,
        BACKGROUND_POINTS,
        BLACK,
        'X-like page should be black under the nav and below the body'
      );
      // Its own light text colour survives too.
      expect(await guest.evaluate(() => getComputedStyle(document.body).color)).toBe(
        'rgb(231, 233, 234)'
      );
    });

    test('a page without colours or color-scheme stays black on white', async ({
      window,
      electronApp,
      harness,
    }) => {
      const guest = await openFixture(window, electronApp, harness, 'plain');
      await expectPagePixels(window, BACKGROUND_POINTS, WHITE, 'unstyled page should be white');
      expect(await probeColor(guest)).toBe('rgb(0, 0, 0)');

      // And with the OS/app preference reaching the page as dark.
      await guest.emulateMedia({ colorScheme: 'dark' });
      expect(await guest.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
        true
      );
      await expectPagePixels(
        window,
        BACKGROUND_POINTS,
        WHITE,
        'unstyled page should stay white with a dark preference'
      );
      expect(await probeColor(guest)).toBe('rgb(0, 0, 0)');
    });

    test('a page with @media (prefers-color-scheme: dark) still goes dark', async ({
      window,
      electronApp,
      harness,
    }) => {
      const guest = await openFixture(window, electronApp, harness, 'prefers');
      // No dark preference (Xvfb): the page's light default, white.
      await expectPagePixels(window, BACKGROUND_POINTS, WHITE, 'light preference: white page');

      await guest.emulateMedia({ colorScheme: 'dark' });
      await expectPagePixels(
        window,
        BACKGROUND_POINTS,
        PREFERS_DARK,
        'dark preference: the page’s own dark background'
      );
      // The page's light text reaches its paragraphs: no injected <body>
      // colour sits between <html> and them.
      expect(await probeColor(guest)).toBe('rgb(224, 224, 224)');
    });
  });
}
