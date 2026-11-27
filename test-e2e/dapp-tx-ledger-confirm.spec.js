// A page's request from a Ledger account, rejected while the Ledger waits
// (freedom-core design 0016, "Deadlines, cancel and unplugging", deviation
// `cancel`; the LDG-3 plan's PR 10 and its point 16), on the core's Ledger
// backend (FREEDOM_LEDGER_BACKEND=core), through the window's approvals
// document.
//
// Today (the JS backend, `page-sends.spec.js`) a Ledger's approval keeps the
// panel up saying where to confirm, with Reject disabled: hw-app-eth's
// exchange can't be stopped, so rejecting behind it would tell the page 4001
// while the device still signs. On the core's backend main can stop it: the
// core's `sign.*` is main's own request, whose cancel the core reads first,
// and main's relay lets go of the device at once. So once the device step
// says it waits (`page:prompt-waiting`), the panel keeps Reject; pressing it
// answers the page 4001 at once, main cancels the core's request and the
// relay closes the device, and the panel shows main's notice (point 18:
// "Cancelled. If your Ledger still shows the request, reject it there.") for
// a moment.
//
// What runs: the app's page path, the real freedom-cored (its prompt, the
// token it mints and spends at the signature, its device lane), main's relay
// and a fake HID device behind it (ledger-hid-fixture.js), which answers the
// address and app checks and waits for a user who never answers at the
// piece they would confirm. As in page-sends.spec.js, main's own send step
// is cut short at the signature (no nonce read, no broadcast: the signer is
// asked for the transaction at nonce 0), and the core prepares the page's
// send from two loopback endpoints of this spec's (fee-rpc-stub.js).

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Wallet } = require('ethers');
const { freedomPath } = require('../test/helpers/freedom-path');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');
const { approvalsPage, approvalsState, chromeWindowId, decideInPanel } = require('./approvals-fixtures');
const { startFeeRpcStub } = require('./fee-rpc-stub');
const { connectByPrompt } = require('./dapp-prompts');
const { fakeLedgerHid, ledgerHidEvents, ledgerHidHeld } = require('./ledger-hid-fixture');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Ledger-Cancel-2026!';
const KEY = `bzz://${'d'.repeat(64)}`;
// The fake Ledger's key: a test key, never funded.
const LEDGER_KEY = '0x' + '4c'.repeat(32);
const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: new Wallet(LEDGER_KEY).address,
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};
const TRANSFER = { to: '0x1111111111111111111111111111111111111111', value: '0x2386f26fc10000' };
const HASH = `0x${'ab'.repeat(32)}`;
const GAS_PRICE = '760000000';
const REJECTED = { code: 4001, message: 'User rejected the request' };
const NOTICE = 'Cancelled. If your Ledger still shows the request, reject it there.';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  fees: async ({}, use) => {
    const fees = await startFeeRpcStub({ chainId: 100, gasPrice: GAS_PRICE });
    await use(fees);
    await fees.close();
  },
  // A vault with one account and the Ledger account, the approvals document
  // on, and the core's Ledger backend.
  electronApp: async ({ fees }, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-ledger-cancel-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      freedomPath(userDataDir, 'settings.json'),
      JSON.stringify({
        enableIdentityWallet: true,
        startAntAtLaunch: false,
        startIpfsAtLaunch: false,
        startRadicleAtLaunch: false,
        enableRadicleIntegration: false,
      }),
      'utf-8'
    );
    const mnemonic = await identity.createVault(identityDir, VAULT_PASSWORD);
    const keys = identity.deriveAllKeys(mnemonic);
    fs.writeFileSync(
      path.join(identityDir, 'vault-meta.json'),
      JSON.stringify({
        addresses: { userWallet: keys.userWallet.address },
        activeWalletIndex: 0,
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }, LEDGER],
      }),
      'utf-8'
    );
    fs.writeFileSync(
      freedomPath(userDataDir, 'network-config.json'),
      JSON.stringify({
        endpointSources: {
          'e2e-fees-a': { role: 'rpc', keyed: false, coverage: { 100: fees.urls[0] } },
          'e2e-fees-b': { role: 'rpc', keyed: false, coverage: { 100: fees.urls[1] } },
        },
        removedSources: ['gno-gnosischain', 'gno-publicnode', 'gno-drpc-public'],
        networks: { 100: { access: { readOrder: ['quorum', 'direct'] } } },
      }),
      'utf-8'
    );
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_IDENTITY_DATA: identityDir,
        FREEDOM_APPROVALS_DOCUMENT: '1',
        FREEDOM_LEDGER_BACKEND: 'core',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
        // Test-only seam (src/main/networks/e2e-provider-identities.js):
        // the two loopback endpoints count as two providers.
        FREEDOM_E2E_PROVIDER_IDENTITIES: JSON.stringify({ [fees.urls[0]]: 'e2e-fees-a', [fees.urls[1]]: 'e2e-fees-b' }),
      },
      timeout: 20_000,
    });
    await use(app);
    await closeApp(app);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  },
});

// A dApp page that asks and keeps each outcome.
const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__asked = {};
    window.__ask = (id, method, params) => {
      window.__asked[id] = { pending: true };
      window.ethereum.request({ method, params }).then(
        (ok) => { window.__asked[id] = { ok }; },
        (e) => { window.__asked[id] = { code: e && e.code, message: String((e && e.message) || e) }; }
      );
      return true;
    };
  </script><h1>${title}</h1>`,
});

function inTab(win, url, script) {
  return win.evaluate(
    async ({ u, js }) => {
      const wv = [...document.querySelectorAll('webview')].find((w) => {
        try {
          return w.getURL().startsWith(u);
        } catch {
          return false;
        }
      });
      if (!wv) return { missing: true };
      try {
        return await wv.executeJavaScript(js);
      } catch (err) {
        return { thrown: String(err?.message || err) };
      }
    },
    { u: url, js: script }
  );
}

const ask = (win, id, method, params) =>
  inTab(win, KEY, `window.__ask(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
const outcome = (win, id) => inTab(win, KEY, `window.__asked[${JSON.stringify(id)}] || null`);

async function openIn(win, url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, url, 'Boolean(window.__ask) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

// No chain: main's send step is cut short at the signature. The signer
// (the core Ledger backend's) is asked for the transaction at nonce 0, and
// nothing is recorded or sent; a signature would answer the page HASH.
function stubSendStep(electronApp) {
  return electronApp.evaluate((_electron, args) => {
    const service = process.mainModule.require(`${args.root}/src/main/wallet/transaction-service`);
    const recorder = process.mainModule.require(`${args.root}/src/main/wallet/tx-recorder`);
    globalThis.__signed = 0;
    recorder.signAndRecord = async (tx, signer, _context, options) => {
      await signer.signTransaction(service.buildTransaction({ ...tx, nonce: 0 }));
      globalThis.__signed += 1;
      options?.onCommitted?.();
      return { hash: args.hash, recorded: true };
    };
  }, { root: repoRoot, hash: HASH });
}

const panelOf = async (electronApp, windowId) => (await approvalsState(electronApp))[windowId];

/**
 * The panel says where to confirm, the device waits for the user, and main
 * has said Reject still reaches it: Reject is enabled while Approve isn't.
 */
async function expectRejectWhileWaiting(electronApp, panel, windowId, held) {
  await expect(panel.locator('#waiting')).toHaveText('Confirm on your Ledger…');
  await expect.poll(() => ledgerHidHeld(electronApp), { timeout: 30_000 }).toBe(held);
  await expect.poll(async () => (await panelOf(electronApp, windowId))?.cancellable).toBe(true);
  await expect(panel.locator('#reject')).toBeEnabled();
  await expect(panel.locator('#approve')).toBeDisabled();
}

/** After a Reject: main let go of the device at once, and nothing reached it after. */
async function expectDeviceLetGo(electronApp, device) {
  const events = await ledgerHidEvents(electronApp);
  const detach = events.findIndex((e) => e.type === 'detach' && e.device === device);
  expect(events[detach]).toEqual({ type: 'detach', device, inFlight: true });
  expect(events.slice(detach + 1).filter((e) => e.type === 'exchange')).toEqual([]);
}

test('Reject while the Ledger waits: the page hears 4001, the device is let go, and the panel says to reject it there', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${KEY}/`, page('dapp'));
  await stubSendStep(electronApp);
  await fakeLedgerHid(electronApp, LEDGER_KEY);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  await openIn(win, `${KEY}/`);
  const windowId = await chromeWindowId(electronApp);
  const panel = await approvalsPage(electronApp);
  expect(
    await connectByPrompt(electronApp, (js) => inTab(win, KEY, js), { account: LEDGER.name, panel, windowId })
  ).toBe(LEDGER.address);

  // A transaction: approved in the panel, signed on the core's device lane,
  // the device waiting for the user.
  await ask(win, 'send', 'eth_sendTransaction', [{ ...TRANSFER, from: LEDGER.address }]);
  await expect(panel.locator('#heading')).toHaveText('Confirm Transaction', { timeout: 15_000 });
  await decideInPanel(electronApp, { panel, windowId });
  await expectRejectWhileWaiting(electronApp, panel, windowId, 1);
  expect(await outcome(win, 'send')).toEqual({ pending: true });
  await panel.screenshot({ path: test.info().outputPath('dapp-tx-ledger-waiting.png') });

  await panel.click('#reject');
  await expect.poll(() => outcome(win, 'send'), { timeout: 15_000 }).toEqual(REJECTED);
  await expect(panel.locator('#waiting')).toHaveText(NOTICE);
  await expect(panel.locator('#reject')).toBeDisabled();
  expect(await panelOf(electronApp, windowId)).toMatchObject({ visible: true, waiting: null });
  await panel.screenshot({ path: test.info().outputPath('dapp-tx-ledger-cancelled.png') });
  await expectDeviceLetGo(electronApp, 1);
  expect(await electronApp.evaluate(() => globalThis.__signed)).toBe(0);
  // The notice goes after a moment, and the panel with it.
  await expect.poll(async () => (await panelOf(electronApp, windowId))?.visible, { timeout: 15_000 }).toBe(false);

  // A message: the same, through the core's `sign.message`.
  const message = '0x' + Buffer.from('Sign in to the dapp', 'utf8').toString('hex');
  await ask(win, 'sign', 'personal_sign', [message, LEDGER.address]);
  await expect(panel.locator('#heading')).toHaveText('Sign Message', { timeout: 15_000 });
  await decideInPanel(electronApp, { panel, windowId });
  await expectRejectWhileWaiting(electronApp, panel, windowId, 2);
  await panel.click('#reject');
  await expect.poll(() => outcome(win, 'sign'), { timeout: 15_000 }).toEqual(REJECTED);
  await expect(panel.locator('#waiting')).toHaveText(NOTICE);
  await expectDeviceLetGo(electronApp, 2);
  expect((await ledgerHidEvents(electronApp)).filter((e) => e.type === 'open')).toHaveLength(2);

  // A prompt that comes meanwhile takes the panel from the notice.
  await ask(win, 'again', 'personal_sign', [message, LEDGER.address]);
  await expect(panel.locator('#heading')).toHaveText('Sign Message', { timeout: 15_000 });
  await expect(panel.locator('#waiting')).toBeHidden();
  await expect(panel.locator('#reject')).toBeEnabled();
  expect(await panelOf(electronApp, windowId)).toMatchObject({ notice: null, visible: true });
  await decideInPanel(electronApp, { approve: false, panel, windowId });
  await expect.poll(() => outcome(win, 'again'), { timeout: 15_000 }).toEqual(REJECTED);
});
