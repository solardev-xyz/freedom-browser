// The Safe signing boards in the approvals document, in real Electron on an
// anvil Gnosis fork (freedom-core design 0011, step APS-3b), with
// FREEDOM_APPROVALS_DOCUMENT=1: a page's Safe message and a page's Safe send
// each show their board in the window's panel, driven by main; the owner the
// user picks there signs (here after the vault's unlock, asked in the panel
// too); the chrome's decision is refused for both boards, and the chrome's
// own board never shows. The message's EIP-1271 signature is checked
// against the real Safe contract on the fork, and the send's execution
// moves the funds.
//
// A 1-of-2 Safe of two vault owners, with the vault locked before each
// request: the free signature is skipped, so each board needs one owner
// picked in the panel. (Device owners' rows are covered by the unit tests:
// the same board, with the panel's device wait.)

const { Wallet, parseEther, hashMessage, Interface } = require('ethers');
const { test, expect, safeE2eAvailable, VAULT_PASSWORD } = require('./safe-fixtures');
const { PAST_DELAY_MS, sleep, approvalsState, chromeWindowId, approvalsPage, reportCount, nextReport } = require('./approvals-fixtures');

test.skip(!safeE2eAvailable(), 'anvil (foundry) or the Gnosis fork RPC not available — Safe E2E needs both');

test.use({ approvalsDocument: true });

const DAPP_URL = `bzz://${'e'.repeat(64)}/`;

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

test('a page\'s Safe message and Safe send: their boards in the panel, driven by main (0011 APS-3b)', async ({
  window: win,
  anvil,
  electronApp,
}) => {
  test.setTimeout(360_000);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  expect(await win.evaluate(() => window.pagePrompts.approvalsDocument)).toBe(true);
  const heading = docPage.locator('#heading');
  const body = docPage.locator('#body');

  /** Approve what the panel shows next (after `after` reports), once main's delay has passed. */
  async function approveNext(after, title) {
    const report = await nextReport(electronApp, windowId, after);
    if (title) await expect(heading).toHaveText(title);
    await sleep(PAST_DELAY_MS);
    await docPage.click('#approve');
    return report.handle;
  }

  /** The vault unlock the board's step asks for, in the panel. */
  async function unlockNext(after) {
    await nextReport(electronApp, windowId, after);
    await expect(heading).toHaveText('Unlock Vault');
    await sleep(PAST_DELAY_MS);
    await docPage.fill('input[type="password"]', VAULT_PASSWORD);
    await docPage.click('#approve');
  }

  /** The board main shows: main's view, and the chrome's decision refused. */
  async function checkBoard(after, { reject }) {
    const { handle } = await nextReport(electronApp, windowId, after);
    await expect(heading).toHaveText('Collect signatures');
    await expect(body).toContainText('Dapp Safe');
    await expect(body).toContainText('0 of 1');
    await expect(docPage.locator('#approve')).toHaveText('Sign');
    await expect(docPage.locator('#reject')).toHaveText(reject);
    expect(await docPage.locator('#body input[type="radio"]').count()).toBeGreaterThanOrEqual(2);
    expect((await approvalsState(electronApp))[windowId].shown).toBe(handle);
    expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, { action: 'sign', owner: 0 }), handle)).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    // The chrome's own board stays down.
    await expect(win.locator('#sidebar-safe-signing')).toBeHidden();
    return handle;
  }

  // --- Create + activate a 1/2 Safe (both owners are vault accounts) ------

  // The seeded vault, as main reads it (through the identity core).
  await expect.poll(() => win.evaluate(() => window.identity.getStatus().then((s) => s.hasVault === true)), { timeout: 30_000 }).toBe(true);
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

  const mainAddress = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets.find((w) => w.index === 0).address;
  await anvil.rpc('anvil_setBalance', [mainAddress, '0x' + parseEther('1').toString(16)]);
  const activateBtn = win.locator('#safe-status-activate');
  const refreshBtn = win.locator('#safe-status-refresh');
  await expect(activateBtn.or(refreshBtn)).toBeVisible({ timeout: 60_000 });
  if (await refreshBtn.isVisible()) {
    await refreshBtn.click();
  }
  await expect(activateBtn).toBeVisible({ timeout: 60_000 });
  expect((await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).success).toBe(true);
  await win.click('#safe-status-activate');
  await expect(win.locator('#wallet-send-btn')).toBeEnabled({ timeout: 90_000 });

  // --- The dApp page, connected to the Safe in the panel -------------------

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
    .poll(() => inWebview(win, 'Boolean(window.ethereum?.request)'), { timeout: 30_000 })
    .toBe(true);

  let after = await reportCount(electronApp, windowId);
  await inWebview(win, `
    window.__acc = null; window.__accErr = null;
    window.ethereum.request({ method: 'eth_requestAccounts' })
      .then((a) => { window.__acc = a; })
      .catch((e) => { window.__accErr = String(e?.message || e); });
    true
  `);
  await nextReport(electronApp, windowId, after);
  await expect(heading).toHaveText('Connect');
  await expect(body).toContainText('Dapp Safe');
  // The Safe, the active account, is picked first.
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect.poll(() => inWebview(win, 'JSON.stringify(window.__acc || window.__accErr)'), { timeout: 30_000 }).toBe(
    JSON.stringify([safeAddress])
  );

  // --- personal_sign: the Safe message's board in the panel ---------------

  // Locked, so the free signature waits for the owner the user picks.
  await win.evaluate(() => window.identity.lock());
  const text = 'freedom e2e 1271 in the panel';
  const hexMessage = '0x' + Buffer.from(text, 'utf8').toString('hex');
  after = await reportCount(electronApp, windowId);
  await inWebview(win, `
    window.__sig = null; window.__sigErr = null;
    window.ethereum.request({ method: 'personal_sign', params: ['${hexMessage}', '${safeAddress}'] })
      .then((s) => { window.__sig = s; })
      .catch((e) => { window.__sigErr = String(e?.message || e); });
    true
  `);
  await approveNext(after, 'Sign Message');
  after = await reportCount(electronApp, windowId);
  await checkBoard(after, { reject: 'Cancel request' });
  await docPage.screenshot({ path: test.info().outputPath('approvals-safe-message-board.png') });
  after = await reportCount(electronApp, windowId);
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  // The owner's signature needs the vault: its unlock, in the panel.
  await unlockNext(after);
  await expect.poll(() => inWebview(win, 'window.__sig || window.__sigErr'), { timeout: 30_000 }).toMatch(/^0x[0-9a-f]{130}$/i);
  const signature = await inWebview(win, 'window.__sig');
  const iface = new Interface(['function isValidSignature(bytes32 dataHash, bytes signature) view returns (bytes4)']);
  const verdict = await anvil.rpc('eth_call', [
    { to: safeAddress, data: iface.encodeFunctionData('isValidSignature', [hashMessage(text), signature]) },
    'latest',
  ]);
  expect(verdict.slice(0, 10)).toBe('0x1626ba7e');
  await expect.poll(async () => (await approvalsState(electronApp))[windowId].visible).toBe(false);

  // --- eth_sendTransaction: the Safe send's board in the panel -------------

  await anvil.rpc('anvil_setBalance', [safeAddress, '0x' + parseEther('1').toString(16)]);
  await win.evaluate(() => window.identity.lock());
  const recipient = Wallet.createRandom().address;
  after = await reportCount(electronApp, windowId);
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
  await nextReport(electronApp, windowId, after);
  await expect(heading).toHaveText('Confirm Transaction');
  await expect(body).toContainText('Paid by an owner account');
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await docPage.click('#approve');
  await checkBoard(after, { reject: 'Leave' });
  // Main's view of the SafeTx it holds: the recipient, the value.
  expect((await body.textContent()).toLowerCase()).toContain(recipient.toLowerCase());
  await expect(body).toContainText('0.4 xDAI');
  await docPage.screenshot({ path: test.info().outputPath('approvals-safe-send-board.png') });
  after = await reportCount(electronApp, windowId);
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await unlockNext(after);

  // The threshold met, main executes. An executor's fee the fee check stops
  // for is asked in the panel, and confirmed there.
  let hash = null;
  for (let i = 0; i < 120 && !hash; i += 1) {
    hash = await inWebview(win, 'window.__tx || window.__txErr');
    if (hash) break;
    const panel = (await approvalsState(electronApp))[windowId];
    if (panel?.shown && (await heading.textContent()) === 'Confirm the network fee') {
      await sleep(PAST_DELAY_MS);
      await docPage.click('#approve');
    }
    await sleep(1000);
  }
  expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
  await expect
    .poll(async () => BigInt(await anvil.rpc('eth_getBalance', [recipient, 'latest'])), { timeout: 30_000 })
    .toBe(parseEther('0.4'));
  await expect(win.locator('#sidebar-safe-signing')).toBeHidden();
});
