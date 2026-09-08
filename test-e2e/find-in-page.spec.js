// Find-in-page — open the bar with Cmd/Ctrl+F, search fixture-served
// content in the active webview, walk matches with Enter/Shift+Enter,
// and close with Escape.
//
// The shortcut is pressed while the address bar (browser chrome) has
// focus: synthetic CDP key events don't trigger native menu accelerators,
// so the specs exercise the renderer's window-level Cmd/Ctrl+F fallback.
// With the page itself focused the same path runs via the Edit-menu
// accelerator, which e2e cannot simulate.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const FIXTURE_BODY =
  '<!doctype html><title>find fixture</title>' +
  '<p>needle one</p><p>needle two</p><p>NEEDLE three</p>';

// A second page for the navigation/per-tab specs: no "needle" anywhere, so a
// query carried over from the first page would be visibly wrong.
const OTHER_HASH = 'b'.repeat(64);
const OTHER_BODY = '<!doctype html><title>other fixture</title><p>banana one</p><p>banana two</p>';

// A link the browser downloads instead of navigating to (the fixture is
// served as an attachment). Clicking it emits a main-frame
// `did-start-navigation` that never commits — the user stays on the page.
const DOWNLOAD_HASH = 'c'.repeat(64);
// The link's colour and outline are pinned so :visited and :focus can't move
// a pixel after it is clicked — the specs below compare guest screenshots
// taken either side of that click to assert on find highlights.
const DOWNLOAD_LINK_BODY =
  FIXTURE_BODY +
  `<p><a id="dl" style="color:#06c;outline:none" href="bzz://${DOWNLOAD_HASH}/file.bin">get file</a></p>`;

// Serve DOWNLOAD_HASH as an attachment and load the page that links to it.
async function loadPageWithDownloadLink(window, harness) {
  await harness.setContentFixture(`bzz://${DOWNLOAD_HASH}/file.bin`, {
    body: 'find-in-page-download-e2e',
    contentType: 'application/octet-stream',
    headers: { 'Content-Disposition': 'attachment; filename="file.bin"' },
  });
  await loadFixturePage(window, harness, { body: DOWNLOAD_LINK_BODY });
}

// Click the download link inside the guest and wait until the download has
// actually been accepted (a shelf card in the chrome) — proof the navigation
// really started, so the assertions after it are not vacuous.
async function clickDownloadLink(window, electronApp) {
  const guest = await guestPage(electronApp, SAMPLE_BZZ_HASH);
  await guest.click('#dl');
  await expect(window.locator('#download-shelf .download-card')).toHaveCount(1, {
    timeout: 10_000,
  });
}

// Find highlights are painted by Chromium's compositor, not written into the
// guest's DOM, so the only way to assert on them is pixels. A guest webview
// surfaces as its own Playwright page: screenshotting *that* captures the
// page exactly as the user sees it, with no browser chrome (and therefore no
// find bar) in the frame, so a byte-identical shot means "this page carries
// no find highlights".
async function guestPage(electronApp, urlPart) {
  let guest = null;
  await expect
    .poll(
      () => {
        guest = electronApp.windows().find((page) => page.url().includes(urlPart)) || null;
        return !!guest;
      },
      { message: `Waiting for the guest page for ${urlPart}`, timeout: 10_000 }
    )
    .toBe(true);
  return guest;
}

async function guestShot(electronApp, urlPart) {
  const guest = await guestPage(electronApp, urlPart);
  return guest.screenshot();
}

// Navigate the active tab to a bzz:// fixture and wait until the content is
// committed inside the webview — findInPage can only see rendered pages.
async function loadFixturePage(window, harness, { hash = SAMPLE_BZZ_HASH, body, text } = {}) {
  await harness.setContentFixture(`bzz://${hash}/`, { body: body ?? FIXTURE_BODY });

  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(`bzz://${hash}/`);
  await address.press('Enter');

  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript('document.body ? document.body.textContent : null');
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the find fixture page to render', timeout: 10_000 }
    )
    .toContain(text ?? 'needle one');
}

const loadOtherPage = (window, harness) =>
  loadFixturePage(window, harness, { hash: OTHER_HASH, body: OTHER_BODY, text: 'banana one' });

// Focus the chrome and open the bar via the renderer's keydown fallback.
async function openFindBar(window) {
  await window.locator('[data-test="address-input"]').click();
  await window.keyboard.press('ControlOrMeta+f');
  await expect(window.locator('[data-test="find-bar"]')).toBeVisible();
}

test('finds matches case-insensitively and cycles with Enter / Shift+Enter', async ({
  window,
  harness,
}) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  const counter = window.locator('[data-test="find-bar-count"]');
  await expect(input).toBeFocused();

  // Find-as-you-type (debounced); "needle" hits NEEDLE too (Chromium's
  // find is case-insensitive by default).
  await input.fill('needle');
  await expect(counter).toHaveText('1/3');

  await input.press('Enter');
  await expect(counter).toHaveText('2/3');

  await input.press('Shift+Enter');
  await expect(counter).toHaveText('1/3');

  // Esc closes the bar and clears the highlights.
  await input.press('Escape');
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
});

test('zero matches shows 0/0 and tints the input', async ({ window, harness }) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  await input.fill('definitely-not-on-this-page');

  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('0/0');
  await expect(input).toHaveClass(/find-bar-input--no-matches/);
});

test('closing right after typing leaves no orphaned find session', async ({ window, harness }) => {
  await loadFixturePage(window, harness);
  await openFindBar(window);

  const input = window.locator('[data-test="find-bar-input"]');
  const counter = window.locator('[data-test="find-bar-count"]');

  // Type and close inside the find-as-you-type debounce window: the queued
  // search must be dropped, not run against a bar the user already closed.
  await input.fill('needle');
  await input.press('Escape');
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();

  // Well past the debounce — the counter stays blank (no session ran) and
  // the page carries no highlights.
  await window.waitForTimeout(600);
  await expect(counter).toHaveText('');
  expect(
    await window.evaluate(async () => {
      const wv = document.querySelector('webview:not(.hidden)');
      return wv.executeJavaScript('window.getSelection().toString()');
    })
  ).toBe('');
});

test('a new tab shows no find bar of its own', async ({ window }) => {
  await openFindBar(window);

  // Opening a new tab activates it — find state is per tab, so the incoming
  // tab shows its own (closed) bar, not the one from the tab left behind.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
});

// #300: closing the bar must leave the page with no match highlights.
test('closing the bar clears the highlights, and re-opening starts clean', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadFixturePage(window, harness);
  const clean = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  await openFindBar(window);
  const input = window.locator('[data-test="find-bar-input"]');
  await input.fill('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('1/3');

  // Acceptance evidence for the negative assertions below: with a live
  // session the page really is painted differently from its clean state.
  await expect
    .poll(async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), clean), {
      message: 'Waiting for the match highlights to be painted',
    })
    .not.toBe(0);

  await input.press('Escape');
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
  await expect
    .poll(async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), clean), {
      message: 'Waiting for the find highlights to be cleared',
    })
    .toBe(0);

  // Re-opening starts clean: no stale count, and nothing repainted until the
  // user searches again.
  await openFindBar(window);
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('');
  expect(Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), clean)).toBe(0);
});

// #299: Chrome ends the find session when the tab commits a cross-document
// navigation — the bar closes and the query is not re-run on the new page.
test('navigating with the bar open ends the session and closes the bar', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadFixturePage(window, harness);

  await openFindBar(window);
  await window.locator('[data-test="find-bar-input"]').fill('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('1/3');

  await loadOtherPage(window, harness);
  // Baseline for "the incoming page carries no highlights of its own",
  // captured before the bar is re-opened on it.
  const cleanOtherPage = await guestShot(electronApp, OTHER_HASH);

  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('');

  // The query is kept for the next open (Chrome prepopulates it) but nothing
  // was searched on the new page: the counter stays blank until the user acts.
  await openFindBar(window);
  await expect(window.locator('[data-test="find-bar-input"]')).toHaveValue('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('');
  await window.locator('[data-test="find-bar-input"]').press('Escape');

  // Nothing on the page the user navigated away from is left highlighted
  // either — see the back/forward-cache spec below.
  expect(Buffer.compare(await guestShot(electronApp, OTHER_HASH), cleanOtherPage)).toBe(0);
});

// #300, the reported repro: navigating away from a searched page put that
// document into the back/forward cache with its find session still live, so
// pressing Back brought it up painted with highlights and no bar at all.
test('going back does not restore a page cached mid-search with its highlights', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadFixturePage(window, harness);
  const cleanFirstPage = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  await openFindBar(window);
  await window.locator('[data-test="find-bar-input"]').fill('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('1/3');

  await loadOtherPage(window, harness);

  // Close the bar if it is still open (it is not, after this fix — but the
  // point of this spec is the state of the *page*, so the highlights must be
  // gone whether or not the bar survived the navigation).
  const bar = window.locator('[data-test="find-bar"]');
  if (await bar.isVisible()) {
    await window.locator('[data-test="find-bar-input"]').press('Escape');
    await expect(bar).toBeHidden();
  }

  await window.locator('#back-btn').click();
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          try {
            return await wv.executeJavaScript('document.body ? document.body.textContent : null');
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the back navigation to render', timeout: 10_000 }
    )
    .toContain('needle one');
  await expect(bar).toBeHidden();
  await expect
    .poll(
      async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), cleanFirstPage),
      { message: 'Waiting for the restored page to render without find highlights' }
    )
    .toBe(0);
});

// #299: a reload behaves like any other navigation.
test('reloading with the bar open ends the session and closes the bar', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadFixturePage(window, harness);
  const clean = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  await openFindBar(window);
  await window.locator('[data-test="find-bar-input"]').fill('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('1/3');

  await window.locator('#reload-btn').click();

  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('');
  await expect
    .poll(async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), clean), {
      message: 'Waiting for the reloaded page to render without find highlights',
    })
    .toBe(0);
});

// #299: find state is per tab — each tab keeps its own bar, query and count.
test('two tabs keep their own query, count and highlights', async ({
  window,
  electronApp,
  harness,
}) => {
  const firstTab = window.locator('[data-test="tab"][data-tab-id="1"]');
  const secondTab = window.locator('[data-test="tab"][data-tab-id="2"]');
  const bar = window.locator('[data-test="find-bar"]');
  const input = window.locator('[data-test="find-bar-input"]');
  const counter = window.locator('[data-test="find-bar-count"]');

  await loadFixturePage(window, harness);
  const cleanFirstPage = await guestShot(electronApp, SAMPLE_BZZ_HASH);
  await openFindBar(window);
  await input.fill('needle');
  await expect(counter).toHaveText('1/3');
  await expect
    .poll(
      async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), cleanFirstPage),
      {
        message: 'Waiting for the first tab match highlights to be painted',
      }
    )
    .not.toBe(0);
  const searchedFirstPage = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  // Second tab: its own (closed) bar, then its own query and count.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(secondTab).toHaveClass(/active/);
  await expect(bar).toBeHidden();

  await loadOtherPage(window, harness);
  await openFindBar(window);
  await expect(input).toHaveValue('');
  await input.fill('banana');
  await expect(counter).toHaveText('1/2');

  // Back to the first tab: its bar, its query, its count — and its
  // highlights, which the switch never cleared (Chrome keeps the background
  // tab's find session running).
  await firstTab.click();
  await expect(bar).toBeVisible();
  await expect(input).toHaveValue('needle');
  await expect(counter).toHaveText('1/3');
  expect(Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), searchedFirstPage)).toBe(0);

  // ...and the second tab still has its own.
  await secondTab.click();
  await expect(bar).toBeVisible();
  await expect(input).toHaveValue('banana');
  await expect(counter).toHaveText('1/2');
});

// A main-frame navigation that starts and never commits (here: a link served
// as an attachment, so it downloads) leaves the user on the same page.
// Chrome ends find sessions at commit, so nothing about the live session
// changes — bar, count and highlights all stay.
test('a download link mid-search leaves the session, count and highlights alone', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadPageWithDownloadLink(window, harness);
  const clean = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  await openFindBar(window);
  const counter = window.locator('[data-test="find-bar-count"]');
  await window.locator('[data-test="find-bar-input"]').fill('needle');
  await expect(counter).toHaveText('1/3');

  // Acceptance evidence for the "still highlighted" assertion below: the
  // searched page really is painted differently from its clean state.
  await expect
    .poll(async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), clean), {
      message: 'Waiting for the match highlights to be painted',
    })
    .not.toBe(0);
  const searched = await guestShot(electronApp, SAMPLE_BZZ_HASH);

  await clickDownloadLink(window, electronApp);

  // Same page, same session: the bar is still open on the same count.
  await expect(window.locator('[data-test="find-bar"]')).toBeVisible();
  await expect(counter).toHaveText('1/3');

  // ...and the page is still painted with its matches. The shelf card the
  // download popped is dismissed first, so the guest is laid out exactly as
  // it was when `searched` was captured and the comparison is about
  // highlights rather than about the shelf's height.
  await window.locator('[data-test="download-close"]').click();
  await expect(window.locator('#download-shelf .download-card')).toHaveCount(0);
  await expect
    .poll(async () => Buffer.compare(await guestShot(electronApp, SAMPLE_BZZ_HASH), searched), {
      message: 'Waiting for the guest to be laid out without the download shelf',
    })
    .toBe(0);

  // The session is still live, not just visually intact: Enter advances it.
  await window.locator('[data-test="find-bar-input"]').press('Enter');
  await expect(counter).toHaveText('2/3');
});

// The flag Chrome records at DidStartNavigation must be rewritten on every
// start: an uncommitted navigation that leaves it stuck at "the bar was
// closed" made the *next*, real navigation keep the bar open with the old
// page's query — the #299 behaviour this PR removes.
test('a download link with the bar closed does not keep the bar open across the next navigation', async ({
  window,
  electronApp,
  harness,
}) => {
  await loadPageWithDownloadLink(window, harness);

  // Bar closed while a navigation starts and never commits.
  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
  await clickDownloadLink(window, electronApp);

  // Now search this (unchanged) page and navigate away for real.
  await openFindBar(window);
  await window.locator('[data-test="find-bar-input"]').fill('needle');
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('1/3');

  await loadOtherPage(window, harness);

  await expect(window.locator('[data-test="find-bar"]')).toBeHidden();
  await expect(window.locator('[data-test="find-bar-count"]')).toHaveText('');
});
