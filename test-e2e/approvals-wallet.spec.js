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
