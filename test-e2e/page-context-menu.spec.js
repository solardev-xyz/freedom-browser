// Page context menu — the selection group's "Search <Engine> for …" item
// (#330), Chrome's item directly under Copy.
//
// Driven end to end: the selection is made inside the guest, the menu is
// raised through the webview preload's own `contextmenu` interceptor, and the
// item is activated with a real click on the chrome element — including the
// Ctrl-modified click, which is the only way to exercise the background
// disposition (a synthetic `element.click()` carries no modifiers).

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const PAGE = `bzz://${SAMPLE_BZZ_HASH}/`;

const LONG_TEXT = 'Freedom is a browser for the decentralized web with search from the address bar';

const FIXTURE_BODY =
  '<!doctype html><title>Selection fixture</title>' +
  '<style>body{margin:0;padding:24px;font-size:18px}textarea{width:90%;height:80px;font-size:18px}</style>' +
  `<p id="short">otters</p><p id="long">${LONG_TEXT}</p>` +
  `<textarea id="field">${LONG_TEXT}</textarea>` +
  '<input id="password" type="password" value="hunter2 secret">';

// Load the fixture into the active tab and wait for it to render.
async function openFixture(window, harness) {
  await harness.setContentFixture(PAGE, { body: FIXTURE_BODY });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(PAGE);
  await input.press('Enter');

  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv?.executeJavaScript) return null;
          try {
            return await wv.executeJavaScript("document.getElementById('short')?.textContent");
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the selection fixture to render', timeout: 15_000 }
    )
    .toBe('otters');
}

// Select `id`'s text (or, for the textarea, part of its value) inside the
// guest, then raise the context menu over it. The preload intercepts
// `contextmenu` in the capture phase and forwards the context to the shell,
// which is what renders `#page-context-menu`.
function selectAndOpenMenu(window, id, { field = false } = {}) {
  return window.evaluate(
    async ({ id: target, field: isField }) => {
      const webview = document.querySelector('webview:not(.hidden)');
      await webview.executeJavaScript(`(() => {
        const el = document.getElementById(${JSON.stringify(target)});
        if (${isField ? 'true' : 'false'}) {
          el.focus();
          el.setSelectionRange(0, el.value.length);
        } else {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 10),
          clientY: Math.round(rect.top + 10),
        }));
        return true;
      })()`);
    },
    { id, field }
  );
}

const menu = (window) => window.locator('#page-context-menu');
const searchItem = (window) =>
  window.locator('#page-context-menu [data-group="selection"] [data-action="search-selection"]');

// The visible rows of the selection group, in DOM order — the item has to sit
// directly under Copy, where Chrome puts it.
const selectionItems = (window) =>
  window.evaluate(() =>
    [...document.querySelectorAll('#page-context-menu [data-group="selection"] .context-menu-item')]
      .filter((item) => !item.classList.contains('hidden'))
      .map((item) => item.textContent.trim())
  );

const tabCount = (window) =>
  window.evaluate(() => document.querySelectorAll('[data-test="tab"]').length);

test('offers "Search <Engine> for …" under Copy and opens the search in a new tab', async ({
  window,
  harness,
}) => {
  await openFixture(window, harness);
  await selectAndOpenMenu(window, 'short');

  await expect(menu(window)).toBeVisible();
  await expect(searchItem(window)).toHaveText('Search DuckDuckGo for "otters"');
  // Directly under Copy, before the separator and Inspect.
  expect(await selectionItems(window)).toEqual([
    'Copy',
    'Search DuckDuckGo for "otters"',
    'Inspect',
  ]);
  await window.screenshot({ path: '/tmp/page-context-menu-search-dark.png' });

  expect(await tabCount(window)).toBe(1);
  await searchItem(window).click();

  // A plain click opens the search in a new foreground tab.
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '2');
  await expect(menu(window)).toBeHidden();
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(
    'https://duckduckgo.com/?q=otters'
  );
  // The search really went to the provider's URL: the harness http(s) stub
  // echoes the request URL it served, so nothing reached the network.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv?.executeJavaScript) return null;
          try {
            return await wv.executeJavaScript(
              'document.querySelector(\'[data-test="harness-http-stub-url"]\')?.textContent || null'
            );
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for the search URL to be served', timeout: 10_000 }
    )
    .toBe('https://duckduckgo.com/?q=otters');
});

test('a Ctrl-clicked search item opens the results behind the current tab', async ({
  window,
  harness,
}) => {
  await openFixture(window, harness);
  await selectAndOpenMenu(window, 'short');
  await expect(searchItem(window)).toBeVisible();

  await searchItem(window).click({ modifiers: ['Control'] });

  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  // Chrome keeps you on the page you searched from.
  await expect(window.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', '1');
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(PAGE);

  // The background tab still loaded the search, and its own title says so.
  await expect
    .poll(
      () =>
        window.evaluate(
          () => document.querySelector('[data-test="tab"][data-tab-id="2"] .tab-title')?.textContent
        ),
      { message: 'Waiting for the background tab to load the search', timeout: 10_000 }
    )
    .toContain('stub');
});

test('elides a long selection in the label but searches for all of it', async ({
  window,
  harness,
}) => {
  await openFixture(window, harness);
  await selectAndOpenMenu(window, 'long');

  // 32 characters, elided on a word boundary.
  await expect(searchItem(window)).toHaveText(
    'Search DuckDuckGo for "Freedom is a browser for the…"'
  );

  await searchItem(window).click();
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(
    `https://duckduckgo.com/?q=${encodeURIComponent(LONG_TEXT)}`
  );
});

test('offers the search for a selection inside an editable field', async ({ window, harness }) => {
  await openFixture(window, harness);
  // Chrome offers the item for a form-field selection too, and the whole
  // preload → shell path has to carry it: this drives a real <textarea>.
  await selectAndOpenMenu(window, 'field', { field: true });

  await expect(menu(window)).toBeVisible();
  await expect(searchItem(window)).toHaveText(
    'Search DuckDuckGo for "Freedom is a browser for the…"'
  );

  await searchItem(window).click();
  await expect(window.locator('[data-test="address-input"]')).toHaveValue(
    `https://duckduckgo.com/?q=${encodeURIComponent(LONG_TEXT)}`
  );
});

test('withholds the item over a password field', async ({ window, harness }) => {
  await openFixture(window, harness);
  // Chromium reports a password field's selection as the masking bullets, so
  // without the guard the menu would offer to search for "••••••••".
  await selectAndOpenMenu(window, 'password', { field: true });

  await expect(menu(window)).toBeVisible();
  // The selection group is up — Copy is there, the search item is not.
  await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
  await expect(searchItem(window)).toBeHidden();
});

// The bullets travel with the selection, not with the element the menu was
// raised over: the page keeps the password field's selection live and fires a
// synthetic `contextmenu` at an unrelated paragraph, so nothing in the event
// target's ancestor chain is a password field.
test('withholds the item for a password selection raised from another element', async ({
  window,
  harness,
}) => {
  await openFixture(window, harness);

  await window.evaluate(async () => {
    const webview = document.querySelector('webview:not(.hidden)');
    await webview.executeJavaScript(`(() => {
      const field = document.getElementById('password');
      field.focus();
      field.setSelectionRange(0, field.value.length);
      document.getElementById('short').dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 30, clientY: 30
      }));
      return true;
    })()`);
  });

  await expect(menu(window)).toBeVisible();
  await window.screenshot({ path: '/tmp/page-context-menu-password-synthetic.png' });
  // The selection group is up — so the masking bullets really did reach
  // chrome as a selection, and the guard is what withholds the item.
  await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
  await expect(searchItem(window)).toBeHidden();
});

test('withholds the item when nothing is selected', async ({ window, harness }) => {
  await openFixture(window, harness);

  await window.evaluate(async () => {
    const webview = document.querySelector('webview:not(.hidden)');
    await webview.executeJavaScript(`(() => {
      window.getSelection().removeAllRanges();
      document.body.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 5, clientY: 5
      }));
      return true;
    })()`);
  });

  await expect(menu(window)).toBeVisible();
  // The page group is up, not the selection group.
  await expect(window.locator('#page-context-menu [data-action="reload"]')).toBeVisible();
  await expect(searchItem(window)).toBeHidden();
});

test.describe('with a custom search engine configured', () => {
  test.use({
    seedSettings: {
      theme: 'light',
      searchProvider: 'custom:private-search',
      customSearchProviders: [
        {
          id: 'private-search',
          name: 'Private Search',
          searchUrlTemplate: 'https://search.example/?q={searchTerms}&source=freedom',
        },
      ],
    },
  });

  test('names the custom engine and searches with its template', async ({ window, harness }) => {
    await openFixture(window, harness);
    await selectAndOpenMenu(window, 'short');

    await expect(searchItem(window)).toHaveText('Search Private Search for "otters"');
    await window.screenshot({ path: '/tmp/page-context-menu-search-light.png' });

    await searchItem(window).click();
    await expect(window.locator('[data-test="address-input"]')).toHaveValue(
      'https://search.example/?q=otters&source=freedom'
    );
  });
});
