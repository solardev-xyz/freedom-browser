// Page context menu — the selection group's "Search <Engine> for …" item
// (#330), Chrome's item directly under Copy.
//
// Driven end to end: the selection is made inside the guest, the menu is
// raised through the webview preload's own `contextmenu` interceptor, and the
// item is activated with a real click on the chrome element — including the
// Ctrl-modified click, which is the only way to exercise the background
// disposition (a synthetic `element.click()` carries no modifiers).

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

// Both themes, as a `src/renderer/` change owes: these tests run dark (an
// unseeded app takes theme 'system', which is light under xvfb, so the dark
// capture below needs the theme pinned), and the custom-engine block at the
// bottom re-seeds 'light' for the light capture.
test.use({ seedSettings: { theme: 'dark' } });

const PAGE = `bzz://${SAMPLE_BZZ_HASH}/`;

const LONG_TEXT = 'Freedom is a browser for the decentralized web with search from the address bar';

// A select-all-sized selection: one sentence repeated past the 1024-code-point
// query cap, so the clamp has a word boundary to cut on well inside the budget.
const HUGE_SENTENCE = 'the otter carried a smooth stone under its arm across the cold river. ';
const HUGE_TEXT = HUGE_SENTENCE.repeat(200).trim();

const FIXTURE_BODY =
  '<!doctype html><title>Selection fixture</title>' +
  '<style>body{margin:0;padding:24px;font-size:18px}textarea{width:90%;height:80px;font-size:18px}</style>' +
  `<p id="short">otters</p><p id="long">${LONG_TEXT}</p>` +
  `<textarea id="field">${LONG_TEXT}</textarea>` +
  '<input id="password" type="password" value="hunter2 secret">' +
  `<p id="huge">${HUGE_TEXT}</p>` +
  // Where the test hangs a shadow root holding a login form, the shape
  // LWC/Stencil and embedded auth widgets ship. Populated from the test, not an
  // inline script, so the fixture needs no script-src of its own.
  '<div id="shadow-host"></div>';

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

// Build a shadow root inside the fixture with a field in it, select that
// field's value, and raise the menu.
//
// `mode` is the root's own mode: an *open* root is reachable through
// `composedPath()` and through `host.shadowRoot.activeElement`, a *closed* one
// through neither — `composedPath()` stops at the host and `host.shadowRoot`
// is null, so nothing outside the component can identify the field at all.
// `target` says which element the synthetic `contextmenu` is dispatched at:
// the shadow field itself (the event is `composed`, so it reaches the
// preload's window-level capture listener retargeted to the host) or `#short`,
// an unrelated element in the light DOM. `type` is the field's input type.
function selectShadowFieldAndOpenMenu(
  window,
  { mode = 'open', target = 'shadow', type = 'password' } = {}
) {
  return window.evaluate(
    async ({ mode: rootMode, target: where, type: fieldType }) => {
      const webview = document.querySelector('webview:not(.hidden)');
      await webview.executeJavaScript(`(() => {
        // A fresh host per call: a root's mode is fixed once attached, and a
        // closed one cannot be read back off the host to be replaced.
        const anchor = document.getElementById('shadow-host');
        anchor.textContent = '';
        const host = document.createElement('div');
        anchor.appendChild(host);
        const root = host.attachShadow({ mode: ${JSON.stringify(rootMode)} });
        root.innerHTML = '<input id="pw" type=${JSON.stringify(fieldType)} value="hunter2 secret">';
        const field = root.getElementById('pw');
        field.focus();
        field.setSelectionRange(0, field.value.length);
        const from = ${where === 'shadow' ? 'field' : "document.getElementById('short')"};
        const rect = from.getBoundingClientRect();
        from.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, composed: true,
          clientX: Math.round(rect.left + 10), clientY: Math.round(rect.top + 10),
        }));
        return true;
      })()`);
    },
    { mode, target, type }
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
  await window.screenshot({ path: 'test-results/page-context-menu-search-dark.png' });

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
  await window.screenshot({ path: 'test-results/page-context-menu-password-synthetic.png' });
  // The selection group is up — so the masking bullets really did reach
  // chrome as a selection, and the guard is what withholds the item.
  await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
  await expect(searchItem(window)).toBeHidden();
});

// `event.target` retargets to the shadow host for a node inside a shadow root,
// and `element.parentElement` is null at the boundary, so an ancestor walk from
// the retargeted target never sees the field. `document.activeElement` retargets
// to the host too. An *open* root can be pierced from both sides; a *closed*
// one from neither, so the preload has to fall back on the document range —
// collapsed, because the text is the field's own selection — and withhold what
// it cannot attribute. Either way the masking bullets must never be offered as
// a search query.
for (const [article, mode] of [
  ['an', 'open'],
  ['a', 'closed'],
]) {
  test(`withholds the item over a password field inside ${article} ${mode} shadow root`, async ({
    window,
    harness,
  }) => {
    await openFixture(window, harness);
    await selectShadowFieldAndOpenMenu(window, { mode, target: 'shadow' });

    await expect(menu(window)).toBeVisible();
    await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
    await expect(searchItem(window)).toBeHidden();
  });

  test(`withholds the item for ${article} ${mode} shadow-root password selection raised elsewhere`, async ({
    window,
    harness,
  }) => {
    await openFixture(window, harness);
    await selectShadowFieldAndOpenMenu(window, { mode, target: 'light' });

    await expect(menu(window)).toBeVisible();
    await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
    await expect(searchItem(window)).toBeHidden();
  });
}

// The documented cost of failing closed: an ordinary field inside a closed root
// is withheld too, since from outside the component it is indistinguishable
// from the password one. An open root keeps the item (covered by the text-field
// case above), so this is not a blanket ban on shadow DOM.
test('withholds the item for an ordinary field inside a closed shadow root', async ({
  window,
  harness,
}) => {
  await openFixture(window, harness);
  await selectShadowFieldAndOpenMenu(window, { mode: 'closed', target: 'shadow', type: 'text' });

  await expect(menu(window)).toBeVisible();
  await expect(window.locator('#page-context-menu [data-action="copy"]')).toBeVisible();
  await expect(searchItem(window)).toBeHidden();
});

// A select-all search must not build a query the size of the document: the URL
// is navigated to and written verbatim into the history DB, and past Chromium's
// own maximum URL length the navigation is dropped with no error page at all.
test('clamps a select-all sized selection to a bounded query', async ({ window, harness }) => {
  await openFixture(window, harness);
  await selectAndOpenMenu(window, 'huge');

  await expect(searchItem(window)).toBeVisible();
  await searchItem(window).click();

  const url = await window.locator('[data-test="address-input"]').inputValue();
  expect(url.startsWith('https://duckduckgo.com/?q=')).toBe(true);
  const query = decodeURIComponent(url.slice('https://duckduckgo.com/?q='.length));
  expect(query.length).toBeLessThanOrEqual(1024);
  // Clamped, not emptied: the head of the selection is what gets searched, cut
  // on a word boundary.
  expect(HUGE_TEXT.startsWith(query)).toBe(true);
  expect(query.length).toBeGreaterThan(512);
  // And the clamped URL is what history stores, not the whole page.
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const entries = (await window.electronAPI?.getHistory?.({ limit: 10 })) || [];
          return Math.max(0, ...entries.map((entry) => (entry?.url || '').length));
        }),
      { message: 'Waiting for the search to reach history', timeout: 10_000 }
    )
    .toBeLessThan(2048);
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
    await window.screenshot({ path: 'test-results/page-context-menu-search-light.png' });

    await searchItem(window).click();
    await expect(window.locator('[data-test="address-input"]')).toHaveValue(
      'https://search.example/?q=otters&source=freedom'
    );
  });
});
