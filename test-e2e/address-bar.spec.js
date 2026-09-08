// Address-bar input → URL normalisation pipeline.
//
// We assert at the chrome layer (input value, protocol icon) rather than
// inside the webview, since webview rendering is content-handler-specific
// and the harness already gives us deterministic content.

const { test, expect, SAMPLE_BZZ_HASH } = require('./fixtures');

const evalInActiveWebview = (window, snippet) =>
  window.evaluate(async (source) => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    try {
      return await webview.executeJavaScript(source);
    } catch {
      return null;
    }
  }, snippet);

// Prove a navigation actually went through the harness stub
// (`makeHttpStubHandler` in src/main/test-harness.js) rather than out to the
// public internet. The stub embeds the request URL in a
// <p data-test="harness-http-stub-url"> element, so the presence of that text
// inside the active webview is unambiguous evidence the request was
// intercepted at the protocol-handler layer and served in-process. Without
// this assertion a spec would still pass even if the harness regressed back
// to letting Chromium reach the network.
const expectHarnessStubServed = (window, expectedUrl) =>
  expect
    .poll(
      () =>
        window.evaluate(async () => {
          const wv = document.querySelector('webview:not(.hidden)');
          if (!wv || typeof wv.executeJavaScript !== 'function') return null;
          try {
            return await wv.executeJavaScript(
              'document.querySelector(\'[data-test="harness-http-stub-url"]\')?.textContent || null'
            );
          } catch {
            return null;
          }
        }),
      { message: 'Waiting for harness http(s) stub to be served', timeout: 5_000 }
    )
    .toBe(expectedUrl);

test('typing a 64-char hex hash normalises to bzz:// in the address bar', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>fixture</title><h1>fixture</h1>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(SAMPLE_BZZ_HASH);
  await input.press('Enter');

  // The renderer rewrites the input value to the canonical bzz:// form
  // synchronously inside loadTarget; no need to wait for the webview.
  await expect(input).toHaveValue(`bzz://${SAMPLE_BZZ_HASH}`);
});

test('typing a bzz:// URL with a path preserves the path in the address bar', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(`bzz://${SAMPLE_BZZ_HASH}/`, {
    body: '<!doctype html><title>fixture</title>',
  });

  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(`bzz://${SAMPLE_BZZ_HASH}/about`);
  await input.press('Enter');

  await expect(input).toHaveValue(`bzz://${SAMPLE_BZZ_HASH}/about`);
});

test('typing a bare HTTPS domain auto-prefixes the scheme and stays inside the harness', async ({
  window,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('example.com');
  await input.press('Enter');

  await expect(input).toHaveValue('https://example.com');
  await expectHarnessStubServed(window, 'https://example.com/');
});

test('typing a non-URL query searches with the default provider', async ({ window }) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('best pizza near me');
  await input.press('Enter');

  await expect(input).toHaveValue('https://duckduckgo.com/?q=best%20pizza%20near%20me');
  await expectHarnessStubServed(window, 'https://duckduckgo.com/?q=best%20pizza%20near%20me');
});

test('a custom search engine added in Settings persists and handles address-bar queries', async ({
  window,
}) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://settings/search');
  await input.press('Enter');

  await expect
    .poll(() => evalInActiveWebview(window, `!!document.getElementById('add-search-provider')`), {
      message: 'Waiting for Search settings to render',
      timeout: 10_000,
    })
    .toBe(true);

  await evalInActiveWebview(
    window,
    `(() => {
      document.getElementById('add-search-provider').click();
      const name = document.getElementById('custom-search-provider-name');
      const template = document.getElementById('custom-search-provider-template');
      name.value = 'Private Search';
      template.value = 'https://search.example/?q={searchTerms}&source=freedom';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      template.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('save-search-provider').click();
      return true;
    })()`
  );

  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const settings = await window.electronAPI.getSettings();
          return {
            selected: settings.searchProvider,
            provider: settings.customSearchProviders?.[0],
          };
        }),
      { message: 'Waiting for the custom search engine to persist', timeout: 10_000 }
    )
    .toMatchObject({
      selected: expect.stringMatching(/^custom:/),
      provider: {
        name: 'Private Search',
        searchUrlTemplate: 'https://search.example/?q={searchTerms}&source=freedom',
      },
    });

  await window.reload();
  await window.waitForSelector('[data-test="address-input"]');

  const reloadedInput = window.locator('[data-test="address-input"]');
  await reloadedInput.click();
  await reloadedInput.fill('freedom browser privacy');
  await reloadedInput.press('Enter');

  const expectedUrl = 'https://search.example/?q=freedom%20browser%20privacy&source=freedom';
  await expect(reloadedInput).toHaveValue(expectedUrl);
  await expectHarnessStubServed(window, expectedUrl);
});

// ---------------------------------------------------------------------------
// Address-bar editing behaviours that have to match Chrome's omnibox.
//
// All four cases share one concept — Chrome's "user input in progress": an
// uncommitted edit belongs to the tab, survives anything the page does, and
// is ended only by the user (commit, Escape, or picking a suggestion).
//   #305 a page commit must not overwrite text the user is typing
//   #314 an unsubmitted edit survives switching tabs and back
//   #310 Escape restores the page URL and keeps focus, in Chrome's stages
//   #313 arrow keys stop at both ends and return to the typed text
//
// Asserted at the chrome layer (input value, focus, dropdown rows), which is
// where the behaviour lives; the harness serves the page content in-process.

const PAGE_A = `bzz://${SAMPLE_BZZ_HASH}/`;
const HASH_B = 'b'.repeat(64);
const PAGE_B = `bzz://${HASH_B}/`;

const addressState = (window) =>
  window.evaluate(() => {
    const input = document.getElementById('address-input');
    return {
      value: input.value,
      focused: document.activeElement === input,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    };
  });

const suggestionRows = (window) =>
  window.evaluate(() =>
    Array.from(document.querySelectorAll('#autocomplete-dropdown .autocomplete-item')).map(
      (item) => ({
        url: item.dataset.url,
        selected: item.classList.contains('selected'),
      })
    )
  );

// Navigate the active tab and wait for the address bar to settle on the
// canonical display URL for the target.
const goTo = async (window, url) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
  await expect(input).toHaveValue(url);
};

// Type into the address bar the way a user does (real key events, so the
// `input` listener that marks the edit as "in progress" actually fires).
const typeInAddressBar = async (window, text) => {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('');
  await window.keyboard.type(text);
};

// Open the suggestion dropdown for `query` and wait for at least `minRows`
// rows. Suggestions come from open tabs, history and bookmarks; the specs
// below seed history by actually visiting the fixtures first.
const openSuggestions = async (window, query, minRows) => {
  await typeInAddressBar(window, query);
  await expect
    .poll(async () => (await suggestionRows(window)).length, {
      message: `Waiting for ${minRows}+ autocomplete rows for "${query}"`,
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(minRows);
  return suggestionRows(window);
};

test('a page commit does not overwrite text the user is typing (#305)', async ({
  window,
  harness,
}) => {
  // Page A redirects itself a moment after load, like a login hop or a
  // shortener — the exact shape that used to wipe a half-typed address.
  await harness.setContentFixture(PAGE_A, {
    body: `<!doctype html><title>PageA</title><h1>Page A</h1><script>setTimeout(() => { location.href = '${PAGE_B}'; }, 1200);</script>`,
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>PageB</title><h1>Page B</h1>',
  });

  await goTo(window, PAGE_A);

  const draft = 'my-important-note.eth/deep/link';
  await typeInAddressBar(window, draft);
  expect(await addressState(window)).toMatchObject({ value: draft, focused: true });

  // Let the page's redirect commit.
  await expect(window.locator('[data-test="tab"] .tab-title').first()).toHaveText('PageB', {
    timeout: 10_000,
  });

  // The typed text is still there, still focused, caret untouched.
  const afterRedirect = await addressState(window);
  expect(afterRedirect).toMatchObject({ value: draft, focused: true });
  expect(afterRedirect.selectionStart).toBe(draft.length);

  // …and the page's own URL was tracked underneath, so Escape still knows
  // what the tab is actually showing.
  await window.keyboard.press('Escape');
  expect(await addressState(window)).toMatchObject({
    value: PAGE_B,
    focused: true,
  });
});

test('an unsubmitted address-bar edit survives switching tabs and back (#314)', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>PageA</title><p>alpha</p>',
  });

  await goTo(window, PAGE_A);
  await typeInAddressBar(window, 'half-typed-url');
  // Put the caret in the middle: Chrome restores the selection too.
  await window.evaluate(() => document.getElementById('address-input').setSelectionRange(4, 9));

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
  // The new tab shows its own (empty) address bar, not tab 1's draft.
  expect((await addressState(window)).value).toBe('');

  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);

  const restored = await addressState(window);
  expect(restored).toMatchObject({ value: 'half-typed-url', focused: true });
  expect([restored.selectionStart, restored.selectionEnd]).toEqual([4, 9]);

  // Escape ends the edit, so the tab goes back to showing its page URL and
  // stops carrying a draft across switches.
  await window.keyboard.press('Escape');
  await window.locator('[data-test="tab"][data-tab-id="2"]').click();
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  expect((await addressState(window)).value).toBe(PAGE_A);
});

test('Escape with the dropdown open restores the typed text, then the page URL, keeping focus (#310)', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>PageA</title><p>alpha</p>',
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>PageB</title><p>beta</p>',
  });

  // Two visited pages give the dropdown something to show for "bzz".
  await goTo(window, PAGE_B);
  await goTo(window, PAGE_A);

  await openSuggestions(window, 'bzz', 1);
  await window.keyboard.press('ArrowDown');
  const previewed = await addressState(window);
  expect(previewed.value).not.toBe('bzz');

  // First Escape: back to the text the user typed, dropdown closed, focus
  // kept — never a blurred fragment that looks like a committed URL.
  await window.keyboard.press('Escape');
  expect(await addressState(window)).toMatchObject({ value: 'bzz', focused: true });
  await expect(window.locator('#autocomplete-dropdown')).toHaveClass(/hidden/);

  // Second Escape: revert to the URL of the page actually on screen, still
  // focused, with the text selected.
  await window.keyboard.press('Escape');
  const reverted = await addressState(window);
  expect(reverted).toMatchObject({ value: PAGE_A, focused: true });
  expect([reverted.selectionStart, reverted.selectionEnd]).toEqual([0, reverted.value.length]);

  // Third Escape: focus leaves the bar (Chrome's "move focus to the page").
  await window.keyboard.press('Escape');
  expect(await addressState(window)).toMatchObject({
    value: PAGE_A,
    focused: false,
  });
});

test('arrow keys stop at both ends of the dropdown and return to the typed text (#313)', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(PAGE_A, {
    body: '<!doctype html><title>PageA</title><p>alpha</p>',
  });
  await harness.setContentFixture(PAGE_B, {
    body: '<!doctype html><title>PageB</title><p>beta</p>',
  });

  await goTo(window, PAGE_B);
  await goTo(window, PAGE_A);

  const rows = await openSuggestions(window, 'bzz', 2);

  // Walk to the last row…
  for (let i = 0; i < rows.length; i += 1) {
    await window.keyboard.press('ArrowDown');
  }
  expect((await addressState(window)).value).toBe(rows[rows.length - 1].url);

  // …one more ArrowDown stops there instead of wrapping to the first row.
  await window.keyboard.press('ArrowDown');
  expect((await addressState(window)).value).toBe(rows[rows.length - 1].url);

  // Walk back up: the row above the first suggestion is the typed text.
  for (let i = 0; i < rows.length; i += 1) {
    await window.keyboard.press('ArrowUp');
  }
  expect((await addressState(window)).value).toBe('bzz');
  expect((await suggestionRows(window)).some((row) => row.selected)).toBe(false);

  // …and one more ArrowUp stays on the typed text rather than teleporting to
  // the bottom of the list.
  await window.keyboard.press('ArrowUp');
  expect((await addressState(window)).value).toBe('bzz');

  // Mouse hover moves the highlight, so Enter would commit the row under the
  // cursor rather than the typed text.
  await window.locator('#autocomplete-dropdown .autocomplete-item').last().hover();
  const hovered = await suggestionRows(window);
  expect(hovered[hovered.length - 1].selected).toBe(true);
});
