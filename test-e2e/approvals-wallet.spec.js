// The wallet's own approvals in the approvals document, in real Electron
// (freedom-core design 0011, step APS-3), with FREEDOM_APPROVALS_DOCUMENT=1:
// the chrome's `wallet:confirm-signing` for one of the wallet's own kinds
// asks in the window's panel, with main's view of exactly the request the
// token binds, whichever tab is in front, and gets a token only on the
// user's approval there; a fee above the threshold is asked again in the
// panel, whatever the chrome says it acknowledged.

const {
  test,
  expect,
  PAST_DELAY_MS,
  sleep,
  approvalsState,
  approvalsTrace,
  chromeWindowId,
  approvalsPage,
  reportCount,
  nextReport,
  clickTooSoon,
} = require('./approvals-fixtures');

const TO = '0x2222222222222222222222222222222222222222';
const HOSTILE = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
const hexOf = (text) => `0x${Buffer.from(text, 'utf8').toString('hex')}`;

test.use({ withVault: true });

test('the wallet\'s own approvals ask in the panel, and only its approval mints (0011 APS-3)', async ({ electronApp, window: win }) => {
  test.setTimeout(180_000);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  const ask = (id, kind, index, payload, options) =>
    win.evaluate(
      ({ id: key, kind: k, index: i, payload: p, options: o }) => {
        window.__asked = window.__asked || {};
        window.__asked[key] = { pending: true };
        window.wallet.confirmSigning(k, i, p, o).then(
          (r) => {
            window.__asked[key] = r;
          },
          (e) => {
            window.__asked[key] = { thrown: String(e && e.message) };
          }
        );
        return true;
      },
      { id, kind, index, payload, options }
    );
  const answer = (id) => win.evaluate((key) => (window.__asked || {})[key] || null, id);
  const requestsSeen = async () => (await approvalsTrace(electronApp)).filter((e) => e.kind === 'request' || e.kind === 'request-refused').length;
  const requestsBefore = await requestsSeen();

  // A send from the wallet, its data a page's hostile text: main's view in
  // the panel, the data as hex, nothing run; a click at once does nothing.
  const send = { chainId: 100, to: TO, value: '1500000000000000000', data: hexOf(HOSTILE), gasLimit: '60000', gasPrice: '1000000000' };
  let after = await reportCount(electronApp, windowId);
  await ask('send', 'wallet-send', null, send);
  const handle = await clickTooSoon(electronApp, docPage, windowId, after);
  await expect(docPage.locator('#heading')).toHaveText('Confirm Send');
  await expect(docPage.locator('#site')).toHaveText('Your wallet');
  await expect(docPage.locator('#body')).toContainText(account);
  await expect(docPage.locator('#body')).toContainText(TO);
  await expect(docPage.locator('#body')).toContainText('1.5 xDAI');
  await expect(docPage.locator('#body')).toContainText(send.data.slice(0, 40));
  const seen = await docPage.evaluate(() => ({
    text: document.getElementById('body').textContent,
    elements: [...document.querySelectorAll('#panel *')].map((el) => el.tagName.toLowerCase()),
    xss: window.__xss,
  }));
  expect(seen.text).not.toContain('<img');
  for (const tag of ['script', 'img', 'a', 'iframe']) expect(seen.elements).not.toContain(tag);
  expect(seen.xss).toBeUndefined();
  // The page makes room for it, whichever tab is in front, and badges no tab.
  await expect(win.locator('[data-test="approvals-space"]')).toHaveClass(/open/);
  await expect(win.locator('[data-test="tab"].has-wallet-prompt')).toHaveCount(0);
  // The chrome can't decide it, and has no token yet.
  expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, {}), handle)).toEqual({ ok: false, reason: 'approvals-document' });
  expect(await answer('send')).toEqual({ pending: true });
  await docPage.click('#approve');
  await expect.poll(() => answer('send')).toMatchObject({ success: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });
  await expect.poll(async () => (await approvalsState(electronApp))[windowId]).toMatchObject({ visible: false, shown: null });
  await expect(win.locator('[data-test="approvals-space"]')).not.toHaveClass(/open/);
  expect(await requestsSeen()).toBe(requestsBefore);

  // Rejected in the panel: no token.
  const hash = `0x${'ab'.repeat(32)}`;
  after = await reportCount(electronApp, windowId);
  await ask('close', 'intent-close', null, { intentId: 'intent-123456', chainId: 100, sender: account, nonce: 3, hashes: [hash] });
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#heading')).toHaveText('Close payment');
  await expect(docPage.locator('#body')).toContainText(hash);
  await sleep(PAST_DELAY_MS);
  await docPage.click('#reject');
  await expect.poll(() => answer('close')).toEqual({ success: false, error: 'User rejected the request', code: 'USER_REJECTED' });

  // A request the token couldn't bind asks nothing.
  const reports = await reportCount(electronApp, windowId);
  await ask('bad', 'intent-resend', null, { intentId: 'x', chainId: 100 });
  await expect.poll(() => answer('bad')).toMatchObject({ success: false });
  expect(await reportCount(electronApp, windowId)).toBe(reports);

  // A fee ten times today's: asked in the panel, then asked again there,
  // whatever the chrome says it acknowledged; the second press mints.
  const pricey = { ...send, data: '0x', gasPrice: '10000000000' };
  after = await reportCount(electronApp, windowId);
  await ask('pricey', 'wallet-send', null, pricey, { feeAcknowledged: true });
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#body')).toContainText("This network fee is 10× today's network fee.");
  await expect(docPage.locator('#approve')).toHaveText('Send');
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await docPage.click('#approve');
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#approve')).toHaveText('Send anyway');
  await expect(docPage.locator('#body')).toContainText('Check the fee, then press Send anyway to pay it.');
  expect(await answer('pricey')).toEqual({ pending: true });
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect.poll(() => answer('pricey')).toMatchObject({ success: true, token: expect.stringMatching(/^[0-9a-f]{64}$/) });

  // The sidebar never took a prompt.
  await expect(win.locator('#sidebar')).toHaveClass(/collapsed/);
});

// --- APS-4: the chrome's screens lead up to the panel, and ask nothing twice --

const RECIPIENT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// The send form's reads and the send itself, replaced for this app; the
// confirmation stays main's own, asked in the panel.
function stubSend(electronApp, { gasPrice, refuse = null }) {
  return electronApp.evaluate(({ ipcMain }, { gasPrice: price, refuse: held }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('wallet:parse-amount', () => ({ success: true, value: '1000000000000000' }));
    replace('wallet:estimate-gas', () => ({ success: true, gasLimit: '21000' }));
    replace('wallet:get-gas-price', () => ({ success: true, type: 'legacy', gasPrice: price, effectiveGasPrice: price }));
    replace('ens:resolve-reverse', () => ({ success: false }));
    replace('identity:get-status', () => ({ isUnlocked: true }));
    globalThis.__sends = [];
    globalThis.__resends = [];
    replace('wallet:send-transaction', (_event, params, _context, authorization) => {
      globalThis.__sends.push({ params, authorization });
      if (held) {
        return {
          success: false,
          error: 'Insufficient funds for transaction',
          outcome: 'rejected',
          reasonClass: 'insufficient funds',
          intentId: held.intentId,
          intent: held,
        };
      }
      return { success: true, hash: `0x${'12'.repeat(32)}` };
    });
  }, { gasPrice, refuse });
}

async function openSend(win, account) {
  await win.evaluate(async ({ account: address, recipient }) => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    const sidebar = await import('./lib/sidebar.js');
    const send = await import('./lib/wallet/send.js');
    sidebar.open();
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    walletState.viewMode = 'identity';
    walletState.fullAddresses.wallet = address;
    walletState.derivedWallets = [{ index: 0, name: 'Main Wallet', address, type: 'mnemonic' }];
    walletState.activeWalletIndex = 0;
    walletState.selectedChainId = 100;
    walletState.registeredChains = { 100: { chainId: 100, name: 'Gnosis Chain', nativeSymbol: 'xDAI' } };
    walletState.registeredTokens = {
      'gnosis-native': { chainId: 100, symbol: 'xDAI', name: 'xDAI', decimals: 18, address: null, builtin: true },
    };
    walletState.currentBalances = { 'gnosis-native': { formatted: '1.0', symbol: 'xDAI' } };
    send.openSend({ recipient, chainId: 100 });
  }, { account, recipient: RECIPIENT });
  await expect(win.locator('#sidebar-send')).toBeVisible();
  await win.fill('#send-amount', '0.001');
  await win.click('#send-continue-btn');
  await expect(win.locator('#send-review-view')).toBeVisible();
}

test('the send form\'s fee above the threshold is asked about once, in the panel (0011 APS-4)', async ({ electronApp, window: win }) => {
  test.setTimeout(180_000);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  await stubSend(electronApp, { gasPrice: '10000000000' });
  await openSend(win, account);
  // The review shows main's verdict, and asks nothing of its own.
  await expect(win.locator('#send-fee-warning-text')).toHaveText("This network fee is 10× today's network fee.");
  let after = await reportCount(electronApp, windowId);
  await win.click('#send-confirm-btn');
  // One press reaches the panel: its first prompt, then its own second press.
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#heading')).toHaveText('Confirm Send');
  await expect(docPage.locator('#body')).toContainText("This network fee is 10× today's network fee.");
  await expect(docPage.locator('#approve')).toHaveText('Send');
  await expect(win.locator('#send-confirm-btn')).not.toHaveText('Send anyway');
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await docPage.click('#approve');
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#approve')).toHaveText('Send anyway');
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect(win.locator('#send-success-view')).toBeVisible();
  const sends = await electronApp.evaluate(() => globalThis.__sends);
  expect(sends).toHaveLength(1);
  expect(sends[0].authorization).toEqual({ confirmation: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // Two prompts in the panel, both its own; the chrome decided none.
  const decides = (await approvalsTrace(electronApp)).filter((e) => e.kind === 'decide' && e.ok === true);
  expect(decides).toHaveLength(2);
});

test('a resend asked again after a replacement says why, in the panel (0011 APS-4)', async ({ electronApp, window: win }) => {
  test.setTimeout(180_000);
  const windowId = await chromeWindowId(electronApp);
  const docPage = await approvalsPage(electronApp);
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  const first = `0x${'ab'.repeat(32)}`;
  const replaced = `0x${'cd'.repeat(32)}`;
  const heldIntent = { intentId: '7b0c6c1e-0c62-4a6e-9a49-0d6a3f6d1a04', chainId: 100, sender: account.toLowerCase(), nonce: 7, hash: first, state: 'held', attention: 'refused' };
  await stubSend(electronApp, { gasPrice: '1000000000', refuse: heldIntent });
  // The resend's first token goes stale: the payment was replaced meanwhile.
  await electronApp.evaluate(({ ipcMain }, { intent, hash }) => {
    ipcMain.removeHandler('wallet:intent-resend');
    ipcMain.handle('wallet:intent-resend', (_event, intentId, authorization) => {
      globalThis.__resends.push({ intentId, authorization });
      if (globalThis.__resends.length === 1) {
        return { success: false, code: 'SIGNING_NOT_CONFIRMED', error: 'Signing was not confirmed', intentId, intent: { ...intent, hash } };
      }
      return { success: true, hash, outcome: 'sent', resent: true };
    });
  }, { intent: heldIntent, hash: replaced });
  await openSend(win, account);
  let after = await reportCount(electronApp, windowId);
  await win.click('#send-confirm-btn');
  await nextReport(electronApp, windowId, after);
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect(win.locator('#send-retry-btn')).toHaveText('Send again');

  after = await reportCount(electronApp, windowId);
  await win.click('#send-retry-btn');
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#heading')).toHaveText('Send again');
  await expect(docPage.locator('#body')).toContainText(first);
  await expect(docPage.locator('#body')).not.toContainText('was replaced');
  await sleep(PAST_DELAY_MS);
  after = await reportCount(electronApp, windowId);
  await docPage.click('#approve');
  // Asked again, once, saying why, for main's latest transaction.
  await nextReport(electronApp, windowId, after);
  await expect(docPage.locator('#body')).toContainText('This payment was replaced with a higher fee after you approved sending it again');
  await expect(docPage.locator('#body')).toContainText(replaced);
  await expect(docPage.locator('#body')).toContainText(`Approved before${first}`);
  await docPage.screenshot({ path: test.info().outputPath('approvals-resend-replaced.png') });
  await sleep(PAST_DELAY_MS);
  await docPage.click('#approve');
  await expect(win.locator('#send-success-view')).toBeVisible();
  expect(await electronApp.evaluate(() => globalThis.__resends.length)).toBe(2);
});
