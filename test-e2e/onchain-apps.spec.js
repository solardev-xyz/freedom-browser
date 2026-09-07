// Native web3: navigation smoke for ERC-8244 contract-hosted applications.
// The harness owns the protocol bytes here; main-process unit tests cover the
// real html() call and response security policy. This test proves Chromium
// keeps the standard URL in browser chrome while rendering from a
// Chromium-safe contract-and-chain origin in the guest webview.

const { test, expect } = require('./fixtures');
const { ethers } = require('ethers');
const {
  GATE_HEADER,
  PROVENANCE_HEADER,
  buildOnchainInterstitialUrl,
  encodeOnchainProvenance,
} = require('../src/main/onchain/onchain-app-protocol');

const ADDRESS = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const APP_URL = `web3://${ADDRESS}.eip155-1/`;
const DISPLAY_URL = `web3://${ADDRESS}/`;
const HTML_HASH = `0x${'ab'.repeat(32)}`;

// The interstitial's mode-specific controls are switched with `hidden`. Assert
// what the user can actually see and click, not just what the markup contains:
// an author `display` rule outranking the UA `[hidden]` rule once rendered the
// conflict page's non-existent "Continue once" action as a live button.
function readVisibleInterstitial(window) {
  return window.evaluate(async () => {
    const webview = document.querySelector('webview:not(.hidden)');
    if (!webview?.executeJavaScript) return null;
    try {
      return await webview.executeJavaScript(`(() => {
        const shown = (element) => Boolean(element && element.offsetParent !== null);
        return {
          title: document.title,
          buttons: [...document.querySelectorAll('.buttons button')]
            .filter(shown)
            .map((button) => button.textContent.trim()),
          rows: [...document.querySelectorAll('.detail-row')]
            .filter(shown)
            .map((row) => row.querySelector('.detail-label')?.textContent),
        };
      })()`);
    } catch {
      return null;
    }
  });
}

test('loads a contract-hosted app under its web3 contract-and-chain origin', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(APP_URL, {
    body: `<!doctype html>
      <script>
        window.__providerAtParse = {
          request: typeof window.ethereum?.request,
          freedom: window.ethereum?.isFreedomBrowser === true
        };
        window.__chainAtParse = 'pending';
        window.ethereum.request({ method: 'eth_chainId' }).then(
          (chainId) => { window.__chainAtParse = chainId; },
          (error) => { window.__chainAtParse = 'error:' + (error?.message || error); }
        );
      </script>
      <title>Onchain fixture</title><h1 id="app">ERC-8244 fixture</h1>`,
    headers: {
      [PROVENANCE_HEADER]: encodeOnchainProvenance({
        version: 1,
        chainId: 1,
        network: 'Ethereum',
        contract: ADDRESS,
        htmlHash: HTML_HASH,
        trust: {
          level: 'verified',
          method: 'myotis',
          finality: 'optimistic',
          block: 25_684_159,
          agreed: ['myotis-p2p'],
          dissented: [],
          queried: ['myotis-p2p'],
        },
      }),
    },
  });

  // The chrome becomes visible just before the initial home webview commits;
  // wait for that commit so it cannot clear a value typed in this test.
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');

  await expect(input).toHaveValue(DISPLAY_URL);
  await expect
    .poll(
      () =>
        window.evaluate(async (displayUrl) => {
          const rows = await window.electronAPI.getHistory();
          return rows.some((row) => row.url === displayUrl);
        }, DISPLAY_URL),
      { timeout: 10_000, message: 'waiting for the standard web3 URL in history' }
    )
    .toBe(true);
  const trustShield = window.locator('#trust-shield');
  await expect(trustShield).toBeVisible();
  await expect(trustShield).toHaveAttribute('data-trust', 'verified');
  await trustShield.click();
  await expect(window.locator('#trust-popover')).toBeVisible();
  await expect(window.locator('#trust-popover-status')).toHaveText(
    'Onchain application retrieval verified'
  );
  await expect(window.locator('#trust-popover-trust-fields')).toContainText(
    'Verified by: Myotis light client'
  );
  await expect(window.locator('#trust-popover-trust-fields')).toContainText('Block: 25684159');
  await expect(window.locator('#trust-popover-content-title')).toHaveText('Loads from');
  await expect(window.locator('#trust-popover-content-fields')).toContainText(
    `Contract: ${ADDRESS}`
  );
  await expect(
    window.locator('#trust-popover-content-fields [data-copy]').last()
  ).toHaveAttribute('data-copy', HTML_HASH);
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const webview = document.querySelector('webview:not(.hidden)');
          if (!webview?.executeJavaScript) return null;
          try {
            return await webview.executeJavaScript(
              `({
                title: document.title,
                text: document.getElementById('app')?.textContent || null,
                protocol: location.protocol,
                host: location.host,
                providerAtParse: window.__providerAtParse,
                chainAtParse: window.__chainAtParse
              })`
            );
          } catch {
            return null;
          }
        }),
      { timeout: 10_000, message: 'waiting for the web3: fixture to render' }
    )
    .toEqual({
      title: 'Onchain fixture',
      text: 'ERC-8244 fixture',
      protocol: 'web3:',
      host: `${ADDRESS}.eip155-1`,
      providerAtParse: {
        request: 'function',
        freedom: true,
      },
      chainAtParse: '0x1',
    });
});

test('shows the browser-owned gate before unverified onchain app code can run', async ({
  window,
  harness,
}) => {
  const app = { address: ethers.getAddress(ADDRESS), chainId: 1 };
  const provenance = {
    version: 1,
    chainId: 1,
    network: 'Ethereum',
    contract: app.address,
    htmlHash: HTML_HASH,
    trust: {
      level: 'unverified',
      method: 'direct',
      agreed: ['rpc.example'],
      dissented: [],
      queried: ['rpc.example'],
    },
  };
  const interstitialUrl = buildOnchainInterstitialUrl({
    app,
    provenance,
    requestUrl: APP_URL,
    token: 'a'.repeat(43),
  });

  await harness.setContentFixture(APP_URL, {
    status: 451,
    body: 'This response must never become executable app content.',
    headers: {
      [GATE_HEADER]: Buffer.from(interstitialUrl, 'utf8').toString('base64url'),
    },
  });

  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');

  await expect(input).toHaveValue(DISPLAY_URL);
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/onchain-unverified.html');
  await expect
    .poll(
      () =>
        window.evaluate(async () => {
          const webview = document.querySelector('webview:not(.hidden)');
          if (!webview?.executeJavaScript) return null;
          try {
            return await webview.executeJavaScript(`({
            title: document.title,
            summary: document.getElementById('summary-el')?.textContent.trim(),
            contract: document.getElementById('contract-el')?.textContent,
            source: document.getElementById('source-el')?.textContent,
            hash: document.getElementById('hash-el')?.textContent
          })`);
          } catch {
            return null;
          }
        }),
      { timeout: 10_000 }
    )
    .toEqual({
      title: 'Onchain app not independently verified',
      summary: expect.stringContaining('The app has not run yet.'),
      contract: app.address,
      source: 'rpc.example',
      hash: HTML_HASH,
    });
  // The conflict-only controls belong to the other mode and must not render.
  await expect.poll(() => readVisibleInterstitial(window), { timeout: 10_000 }).toEqual({
    title: 'Onchain app not independently verified',
    buttons: ['Continue once', '← Go back', 'Open RPC settings'],
    rows: ['Network', 'Contract', 'Fetched from', 'HTML hash'],
  });

  // The switched-tab path derives its own address-bar value, so it needs the
  // same check as the active-tab did-navigate handler: open a second tab,
  // come back, and confirm the repaint kept the app identity instead of
  // painting the gate's own `file://` URL — which carries the single-use
  // approval token — into copyable chrome.
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
  await expect(input).toHaveValue(DISPLAY_URL);

  // A gated app never ran, so it is not a visit: nothing may reach history or
  // the autocomplete dropdown while the gate is up.
  expect(
    await window.evaluate(async () => {
      const rows = await window.electronAPI.getHistory();
      return rows.filter((row) => row.url?.startsWith('web3://') || row.url?.includes('.html'));
    })
  ).toEqual([]);

  // Swap the harness response before clicking so this leg proves the
  // internal-page → preload → shell → web3 navigation bridge. Main-process
  // unit tests separately prove the real handler accepts only the bound token
  // and returns its already-fetched bytes without a second chain read.
  await harness.setContentFixture(APP_URL, {
    body: '<title>Approved onchain app</title><h1 id="approved">Approved bytes</h1>',
  });
  await window.evaluate(async () => {
    const webview = document.querySelector('webview:not(.hidden)');
    await webview.executeJavaScript("document.getElementById('continue-btn').click()");
  });
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const webview = document.querySelector('webview:not(.hidden)');
        if (!webview?.executeJavaScript) return null;
        try {
          return await webview.executeJavaScript(
            "document.getElementById('approved')?.textContent || null"
          );
        } catch {
          return null;
        }
      })
    )
    .toBe('Approved bytes');
  await expect(input).toHaveValue(DISPLAY_URL);

  // Only now is there a visit — and it carries the loaded app's own title.
  // Recording the gate first would have burned the once-per-URL dedup on an
  // entry titled "Onchain app not independently verified" that no later load
  // could replace.
  await expect
    .poll(
      () =>
        window.evaluate(async (displayUrl) => {
          const rows = await window.electronAPI.getHistory();
          return rows.filter((row) => row.url === displayUrl).map((row) => row.title);
        }, DISPLAY_URL),
      { timeout: 10_000, message: 'waiting for the approved app in history' }
    )
    .toEqual(['Approved onchain app']);
});

test('offers no continue action when RPC servers disagreed about an app', async ({
  window,
  harness,
}) => {
  const app = { address: ethers.getAddress(ADDRESS), chainId: 1 };
  const interstitialUrl = buildOnchainInterstitialUrl({
    app,
    provenance: {
      version: 1,
      chainId: 1,
      network: 'Ethereum',
      contract: app.address,
      htmlHash: HTML_HASH,
      trust: {
        level: 'unverified',
        method: 'quorum',
        agreed: ['rpc-a.example'],
        dissented: ['rpc-b.example', 'rpc-c.example'],
        queried: ['rpc-a.example', 'rpc-b.example', 'rpc-c.example'],
      },
    },
    requestUrl: APP_URL,
    // Deliberately no token: the main process never mints one for a conflict,
    // which is exactly why a rendered "Continue once" button could only no-op.
  });

  await harness.setContentFixture(APP_URL, {
    status: 451,
    body: 'This response must never become executable app content.',
    headers: {
      [GATE_HEADER]: Buffer.from(interstitialUrl, 'utf8').toString('base64url'),
    },
  });

  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');

  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/onchain-unverified.html');

  // A conflict is a hard block: "Continue once" is not part of this page's
  // contract, so it must be neither visible nor present in the document.
  await expect.poll(() => readVisibleInterstitial(window), { timeout: 10_000 }).toEqual({
    title: 'RPC servers disagreed about this app',
    buttons: ['Try again', '← Go back', 'Open RPC settings'],
    rows: ['Network', 'Contract', 'Fetched from', 'HTML hash', 'Disagreed'],
  });
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const webview = document.querySelector('webview:not(.hidden)');
        if (!webview?.executeJavaScript) return null;
        try {
          return await webview.executeJavaScript(`({
            continueBtn: Boolean(document.getElementById('continue-btn')),
            dissented: document.getElementById('dissented-el')?.textContent
          })`);
        } catch {
          return null;
        }
      })
    )
    .toEqual({ continueBtn: false, dissented: 'rpc-b.example, rpc-c.example' });

  // A hard block is even less of a visit than the soft gate: nothing loaded,
  // so history must stay empty rather than record the app under the gate's
  // "RPC servers disagreed about this app" title.
  expect(
    await window.evaluate(async () => {
      const rows = await window.electronAPI.getHistory();
      return rows.filter((row) => row.url?.startsWith('web3://') || row.url?.includes('.html'));
    })
  ).toEqual([]);

  // Switching away and back keeps the app identity in chrome, never the
  // gate's own file:// URL.
  const gateInput = window.locator('[data-test="address-input"]');
  await expect(gateInput).toHaveValue(DISPLAY_URL);
  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="2"]')).toHaveClass(/active/);
  await window.locator('[data-test="tab"][data-tab-id="1"]').click();
  await expect(window.locator('[data-test="tab"][data-tab-id="1"]')).toHaveClass(/active/);
  await expect(gateInput).toHaveValue(DISPLAY_URL);
});

// The trust gate is only worth anything if web content cannot reach it.
// Chromium sends no `Origin` header to a custom-scheme handler and enforces
// no CORS on its response, so before the `onchain-app-guard` onBeforeRequest
// handler a plain `fetch('web3://…')` from any page read the whole 451 gate
// response — including the single-use approval token — replayed it with the
// approval header, and pre-approved unverified app code for the session
// without the user ever seeing this interstitial.
test('blocks a page from reaching the onchain trust gate as a subresource', async ({
  window,
  harness,
}) => {
  const app = { address: ethers.getAddress(ADDRESS), chainId: 1 };
  const interstitialUrl = buildOnchainInterstitialUrl({
    app,
    provenance: {
      version: 1,
      chainId: 1,
      network: 'Ethereum',
      contract: app.address,
      htmlHash: HTML_HASH,
      trust: {
        level: 'unverified',
        method: 'direct',
        agreed: ['rpc.example'],
        dissented: [],
        queried: ['rpc.example'],
      },
    },
    requestUrl: APP_URL,
    token: 'a'.repeat(43),
  });
  await harness.setContentFixture(APP_URL, {
    status: 451,
    body: 'This response must never become executable app content.',
    headers: {
      [GATE_HEADER]: Buffer.from(interstitialUrl, 'utf8').toString('base64url'),
    },
  });

  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/home.html');

  const input = window.locator('[data-test="address-input"]');
  await input.fill('https://hostile.example/');
  await input.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('hostile.example');

  // Both shapes matter: a plain fetch reads the token outright, and an opaque
  // `no-cors` fetch still runs the handler (staging or consuming a token)
  // even though the page cannot read the response.
  const probe = await window.evaluate(
    ({ appUrl, gateHeader }) => {
      const webview = document.querySelector('webview:not(.hidden)');
      return webview.executeJavaScript(`(async () => {
        const attempt = async (init) => {
          try {
            const response = await fetch(${JSON.stringify(appUrl)}, init);
            return {
              status: response.status,
              type: response.type,
              gate: response.headers.get(${JSON.stringify(gateHeader)})
            };
          } catch (error) {
            return { error: String((error && error.message) || error) };
          }
        };
        return { cors: await attempt(undefined), noCors: await attempt({ mode: 'no-cors' }) };
      })()`);
    },
    { appUrl: APP_URL, gateHeader: GATE_HEADER }
  );

  expect(probe.cors.gate).toBeUndefined();
  expect(probe.cors.status).toBeUndefined();
  expect(probe.cors.error).toBeTruthy();
  expect(probe.noCors.status).toBeUndefined();
  expect(probe.noCors.error).toBeTruthy();

  // Acceptance side: the same app in the same tab still gates a real
  // top-level navigation, so the guard blocks the attack, not the feature.
  await input.fill(`web3://${ADDRESS}`);
  await input.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '')
    )
    .toContain('/pages/onchain-unverified.html');
});
