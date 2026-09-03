// A Safe account acting as a dApp wallet, end to end (WP-S4): a real
// bzz:// dApp page in a webview connects the Safe through the provider
// bridge, gets a personal_sign answered via the EIP-1271 SafeMessage
// flow (verified against the REAL deployed contract's isValidSignature
// on an anvil Gnosis fork), and sends a transaction that routes through
// the signing board and comes back as an execution hash.
//
// Uses a 1-of-2 vault Safe: the free vault signature meets the
// threshold, exercising the instant-signature path for messages and the
// board's auto-execution for transactions. (Device-owner board rows are
// covered by safe-phone.spec.js — same board machinery.)

const { Wallet, parseEther, hashMessage, Interface } = require('ethers');
const { test, expect, safeE2eAvailable, VAULT_PASSWORD } = require('./safe-fixtures');

test.skip(
  !safeE2eAvailable(),
  'anvil (foundry) or the Gnosis fork RPC not available — Safe E2E needs both'
);

const DAPP_HASH = 'd'.repeat(64);
const DAPP_URL = `bzz://${DAPP_HASH}/`;

/** Run a script inside the active webview (the dApp page). */
function inWebview(win, script) {
  return win.evaluate(async (js) => {
    const wv = document.querySelector('webview:not(.hidden)');
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(js);
    } catch {
      return null;
    }
  }, script);
}

test('a dApp connects a Safe, gets an EIP-1271 signature, and sends through the board', async ({
  window: win,
  anvil,
  electronApp,
}) => {
  test.setTimeout(300_000);

  // --- Create + activate a 1/2 Safe (both owners are vault accounts) ------

  await win.click('#wallet-toggle-btn');
  await win.click('#wallet-selector-btn');
  await win.click('#wallet-create-safe-btn');
  const ownerRows = win.locator('#create-safe-owner-list .connect-ledger-account');
  await expect(ownerRows).toHaveCount(2);
  await ownerRows.nth(0).click();
  await ownerRows.nth(1).click();
  await win.fill('#create-safe-name-input', 'Dapp Safe');
  await win.click('#create-safe-submit');
  await expect(win.locator('#create-safe-success')).toBeVisible({ timeout: 30_000 });
  const safeAddress = (await win.locator('#create-safe-result-address').textContent()).trim();
  await win.click('#create-safe-done');

  const mainAddress = (await win.evaluate(() => window.wallet.getDerivedWallets()))
    .wallets.find((w) => w.index === 0).address;
  await anvil.rpc('anvil_setBalance', [mainAddress, '0x' + parseEther('1').toString(16)]);
  const activateBtn = win.locator('#safe-status-activate');
  const refreshBtn = win.locator('#safe-status-refresh');
  await expect(activateBtn.or(refreshBtn)).toBeVisible({ timeout: 60_000 });
  if (await refreshBtn.isVisible()) {
    await refreshBtn.click();
  }
  await expect(activateBtn).toBeVisible({ timeout: 60_000 });
  const unlock = await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD);
  expect(unlock.success).toBe(true);
  await win.click('#safe-status-activate');
  await expect(win.locator('#wallet-send-btn')).toBeEnabled({ timeout: 90_000 });

  // --- Load the dApp page (harness-served bzz fixture) ---------------------

  await electronApp.evaluate((_electron, { url }) => {
    globalThis.__FREEDOM_TEST_HARNESS__.setContentFixture(url, {
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>e2e dapp</title><h1 data-test="e2e-dapp">e2e dapp</h1>',
    });
  }, { url: DAPP_URL });

  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(DAPP_URL);
  await address.press('Enter');
  await expect
    .poll(() => inWebview(win, 'Boolean(window.ethereum?.request)'), {
      message: 'waiting for the provider bridge in the dApp page',
      timeout: 30_000,
    })
    .toBe(true);

  // --- eth_requestAccounts: the deployed Safe is connectable ---------------

  await inWebview(win, `
    window.__acc = null; window.__accErr = null;
    window.ethereum.request({ method: 'eth_requestAccounts' })
      .then((a) => { window.__acc = a; })
      .catch((e) => { window.__accErr = String(e?.message || e); });
    true
  `);
  await expect(win.locator('#sidebar-dapp-connect')).toBeVisible({ timeout: 30_000 });
  // The active account (the Safe) is the default — with the honest caveat.
  await expect(win.locator('#dapp-connect-wallet-name')).toHaveText('Dapp Safe');
  await expect(win.locator('#dapp-connect-safe-note')).toBeVisible();
  await win.click('#dapp-connect-approve');

  await expect
    .poll(() => inWebview(win, 'JSON.stringify(window.__acc || window.__accErr)'), {
      timeout: 30_000,
    })
    .toBe(JSON.stringify([safeAddress]));

  // --- personal_sign → SafeMessage → isValidSignature on the fork ----------

  const text = 'freedom e2e 1271';
  const hexMessage = '0x' + Buffer.from(text, 'utf8').toString('hex');
  await inWebview(win, `
    window.__sig = null; window.__sigErr = null;
    window.ethereum.request({ method: 'personal_sign', params: ['${hexMessage}', '${safeAddress}'] })
      .then((s) => { window.__sig = s; })
      .catch((e) => { window.__sigErr = String(e?.message || e); });
    true
  `);
  await expect(win.locator('#sidebar-dapp-sign')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#dapp-sign-safe-note')).toBeVisible();
  await win.click('#dapp-sign-approve');

  // 1-of-2: the free vault signature completes the session instantly.
  await expect
    .poll(() => inWebview(win, 'window.__sig || window.__sigErr'), { timeout: 30_000 })
    .toMatch(/^0x[0-9a-f]{130}$/i);
  const signature = await inWebview(win, 'window.__sig');

  // The dApp-side verification: isValidSignature on the REAL contract.
  const iface = new Interface([
    'function isValidSignature(bytes32 dataHash, bytes signature) view returns (bytes4)',
  ]);
  const result = await anvil.rpc('eth_call', [
    { to: safeAddress, data: iface.encodeFunctionData('isValidSignature', [hashMessage(text), signature]) },
    'latest',
  ]);
  expect(result.slice(0, 10)).toBe('0x1626ba7e');

  // --- eth_sendTransaction routes through the signing board ----------------

  await anvil.rpc('anvil_setBalance', [safeAddress, '0x' + parseEther('1').toString(16)]);
  const recipient = Wallet.createRandom().address;
  await inWebview(win, `
    window.__tx = null; window.__txErr = null;
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: '${safeAddress}', to: '${recipient}', value: '0x${parseEther('0.4').toString(16)}' }],
    })
      .then((h) => { window.__tx = h; })
      .catch((e) => { window.__txErr = String(e?.message || e); });
    true
  `);
  await expect(win.locator('#sidebar-dapp-tx')).toBeVisible({ timeout: 30_000 });
  await expect(win.locator('#dapp-tx-fee')).toContainText('Paid by', { timeout: 30_000 });
  await win.click('#dapp-tx-approve');

  // The board takes over; the free signature meets the threshold and
  // execution runs on its own — the dApp receives the execution hash.
  await expect(win.locator('#safe-signing-title')).toHaveText('Transaction sent', {
    timeout: 90_000,
  });
  await expect
    .poll(() => inWebview(win, 'window.__tx || window.__txErr'), { timeout: 30_000 })
    .toMatch(/^0x[0-9a-f]{64}$/i);
  await win.click('#safe-signing-done');

  await expect
    .poll(async () => BigInt(await anvil.rpc('eth_getBalance', [recipient, 'latest'])), {
      timeout: 30_000,
    })
    .toBe(parseEther('0.4'));
});
