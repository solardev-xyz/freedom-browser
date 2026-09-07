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
});
