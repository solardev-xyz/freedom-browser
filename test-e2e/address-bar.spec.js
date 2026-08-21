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
