// A Ledger's hash-only warning in real Electron (freedom-core design 0016,
// "Typed data on the device (Q23)"; the LDG-3 plan's points 12 and 19;
// LDG-3's PR 11). On the core's Ledger backend, main's relay holds a device
// that can show only two hashes until this warning is on screen: in the
// approvals document's waiting state for the approval that waits on the
// device, and, for a request no approval waits on (a standing rule's, an
// x402 payment's) and under FREEDOM_APPROVALS_DOCUMENT=0, as the chrome's
// notice over the tab.
//
// Main presents it as the relay does (wallet/ledger/hash-only-warning.js
// `present`, with the two hashes, the parent's signal and main's own
// cancel), and the real chrome renders it: the hashes as the Ethereum app
// shows them, reported on screen after two animation frames in a visible
// window, so main's wait resolves true. A hidden window's notice is never
// reported. Its Cancel (point 19) is main's own cancel, and the notice goes
// as the operation ends. The document's warning, the same way, in a Ledger
// approval's waiting state (approvals-document.js `presentHashOnly`). The
// relay and the device side are the unit suites' (hash-only-warning.test.js,
// ledger-relay.test.js).

const { test, expect, approvalsPage, approvalsTrace, chromeWindowId, decideInPanel, openTab, inGuest } = require('./approvals-fixtures');

const DOMAIN = '0x' + '1a'.repeat(31) + 'ef';
const STRUCT = '0x' + '2b'.repeat(31) + 'cd';
const SITE = 'https://dapp.example';

/** Main puts the notice up in the chrome's window, as the relay's hook would. */
function present(app) {
  return app.evaluate(
    ({ BrowserWindow }, { domainSeparator, structHash, site }) => {
      const { getHashOnlyWarnings } = process.mainModule.require('./src/main/wallet/ledger/hash-only-warning');
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/index.html'));
      const life = new AbortController();
      const state = { shown: null, cancelled: false, end: () => life.abort() };
      globalThis.__hashOnly = state;
      getHashOnlyWarnings()
        .present(
          { windowId: win.id, site },
          {
            domainSeparator,
            structHash,
            signal: life.signal,
            cancel: () => {
              state.cancelled = true;
              life.abort();
            },
          }
        )
        .then((shown) => {
          state.shown = shown;
        });
      return win.id;
    },
    { domainSeparator: DOMAIN, structHash: STRUCT, site: SITE }
  );
}

const outcome = (app) =>
  app.evaluate(() => ({ shown: globalThis.__hashOnly.shown, cancelled: globalThis.__hashOnly.cancelled }));

test('the notice over a tab: its hashes as the device shows them, reported once on screen; its Cancel', async ({
  electronApp,
  window,
}) => {
  const notice = window.locator('[data-test="ledger-hash-only-notice"]');
  await expect(notice).toBeHidden();
  await present(electronApp);

  await expect(notice).toBeVisible();
  await expect(notice).toContainText("This Ledger can't show the request's details");
  await expect(notice).toContainText('approve on the Ledger only if you trust this request');
  await expect(notice).toContainText(`From ${SITE}`);
  await expect(window.locator('[data-test="ledger-hash-only-domain"]')).toHaveText('0x' + '1A'.repeat(31) + 'EF');
  await expect(window.locator('[data-test="ledger-hash-only-message"]')).toHaveText('0x' + '2B'.repeat(31) + 'CD');
  // On screen: main's wait resolves true, and the relay could answer hash_only.
  await expect.poll(() => outcome(electronApp).then((o) => o.shown)).toBe(true);

  // Point 19: Cancel is main's own cancel; the notice goes as the operation ends.
  await window.locator('[data-test="ledger-hash-only-cancel"]').click();
  await expect.poll(() => outcome(electronApp).then((o) => o.cancelled)).toBe(true);
  await expect(notice).toBeHidden();
});

test("a hidden window's notice is never reported: main's wait ends false", async ({ electronApp, window }) => {
  await window.locator('#address-input').waitFor();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/index.html'));
    win.hide();
  });
  try {
    await present(electronApp);
    await window.waitForTimeout(1500);
    expect((await outcome(electronApp)).shown).toBeNull();
    // Main gives up on the report (the relay's 10 s, shortened here).
    await electronApp.evaluate(() => globalThis.__hashOnly.end());
    await expect.poll(() => outcome(electronApp).then((o) => o.shown)).toBe(false);
  } finally {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/index.html'));
      win.show();
    });
  }
  await expect(window.locator('[data-test="ledger-hash-only-notice"]')).toBeHidden();
});

// A page that asks for a signature; the harness's dispatcher shows it as a
// Ledger account's `eth.sign`, and, once approved, holds the request as a
// device signature would.
const SIGN_PAGE = {
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>sign</title><script>
    window.__ask = (view) => { window.swarm.request({ method: 'swarm_readChunk', params: { view } }).catch(() => {}); return true; };
    window.__ready = true;
  </script><h1>sign</h1>`,
};
const LEDGER_VIEW = {
  method: 'personal_sign',
  account: { index: 1000000, name: 'My Nano S', address: '0x' + '12'.repeat(20), type: 'ledger' },
  chain: { id: 1, name: 'Ethereum' },
  message: { hex: '0x68656c6c6f', rawHash: false },
};

test("a Ledger approval's waiting state in the approvals document: the warning, reported once on screen", async ({
  electronApp,
  window,
  harness,
}) => {
  test.setTimeout(120_000);
  const site = `bzz://${'c'.repeat(64)}`;
  await harness.setContentFixture(`${site}/`, SIGN_PAGE);
  await electronApp.evaluate(() => {
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setDispatch(async (context) => {
      const decision = await context.prompt({ kind: 'eth.sign', view: context.params.view });
      if (decision.approve !== true) return { error: { code: 4001, message: 'User rejected the request' } };
      await new Promise((resolve) => {
        globalThis.__releaseSigning = resolve;
      });
      return { result: '0x' };
    });
  });
  const windowId = await chromeWindowId(electronApp);
  const doc = await approvalsPage(electronApp);
  const guest = await openTab(electronApp, window, `${site}/`);
  await inGuest(electronApp, guest, `window.__ask(${JSON.stringify(LEDGER_VIEW)})`);
  const handle = await decideInPanel(electronApp, { heading: 'Sign Message', windowId, panel: doc });
  await expect(doc.locator('#waiting')).toHaveText('Confirm on your Ledger…');

  // Main presents the warning for that approval, as the relay's hook does.
  await electronApp.evaluate(
    (_electron, args) => {
      const { getApprovalsDocuments } = process.mainModule.require('./src/main/approvals/approvals-document');
      const life = new AbortController();
      const state = { shown: null, end: () => life.abort() };
      globalThis.__docHashOnly = state;
      const shown = getApprovalsDocuments().presentHashOnly(
        args.windowId,
        { handle: args.handle },
        { domainSeparator: args.domainSeparator, structHash: args.structHash },
        life.signal
      );
      if (!shown) state.shown = 'no-surface';
      else shown.then((value) => (state.shown = value));
    },
    { windowId, handle, domainSeparator: DOMAIN, structHash: STRUCT }
  );
  const warning = doc.locator('#hash-only');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("This Ledger can't show the request's details");
  await expect(warning).toContainText('Domain hash');
  await expect(warning).toContainText('0x' + '1A'.repeat(31) + 'EF');
  await expect(warning).toContainText('Message hash');
  await expect(warning).toContainText('0x' + '2B'.repeat(31) + 'CD');
  await expect.poll(() => electronApp.evaluate(() => globalThis.__docHashOnly.shown)).toBe(true);
  expect((await approvalsTrace(electronApp)).some((e) => e.kind === 'hash-only-shown' && e.handle === handle)).toBe(true);

  // The operation ends: the warning goes; the request is answered.
  await electronApp.evaluate(() => globalThis.__docHashOnly.end());
  await expect(warning).toBeHidden();
  await electronApp.evaluate(() => globalThis.__releaseSigning());
});
