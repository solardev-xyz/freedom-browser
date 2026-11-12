// Sends through main, in real Electron (freedom-core design 0011, step
// PRQ-5b): `eth_sendTransaction` goes from the app's preload to main on
// `page:request`. Main quotes the fee and judges it, shows the send prompt as
// a handle, the chrome renders it and answers it, and main's own issuer mints
// the dapp-send token for that handle and the requester's key and spends it.
// The chrome mints no dapp-send token, none for a site's Safe send, and
// claims no site's rule: main reads the contract rule itself, records it for
// the requester's key, and asks for the vault's unlock first when it is
// locked.
//
// No chain runs here: main's quote and its signAndRecord are replaced in
// main for this app instance (the spec's stubs below), and the fee check
// reads the harness's fee fixture. Everything between the page and the
// signer is the app's own.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Sends-2026!';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEY_C = `bzz://${'c'.repeat(64)}`;
const LEDGER = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};
const CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELECTOR = '0x095ea7b3';
// approve(address,uint256): a contract call, so "always allow" is offered.
const CALL = { to: CONTRACT, value: '0x0', data: `${SELECTOR}${'0'.repeat(56)}deadbeef${'f'.repeat(64)}` };
const TRANSFER = { to: '0x1111111111111111111111111111111111111111', value: '0x2386f26fc10000' };
const HASH = `0x${'ab'.repeat(32)}`;
const REJECTED = { code: 4001, message: 'User rejected the request' };

const test = base.extend({
  // The base app plus a vault with one account, and a Ledger account.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-page-sends-'));
    const userDataDir = path.join(tmpRoot, 'userData');
    const identityDir = path.join(tmpRoot, 'identity');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.mkdirSync(identityDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'settings.json'),
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
    const app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        FREEDOM_TEST_MODE: '1',
        FREEDOM_TEST_USER_DATA: userDataDir,
        FREEDOM_IDENTITY_DATA: identityDir,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        LANG: 'en_US.UTF-8',
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

const send = (win, url, id, tx) =>
  inTab(win, url, `window.__ask(${JSON.stringify(id)}, 'eth_sendTransaction', [${JSON.stringify(tx)}])`);
const outcome = (win, url, id) => inTab(win, url, `window.__asked[${JSON.stringify(id)}] || null`);
const guestOf = (win, url) =>
  win.evaluate((u) => {
    const wv = [...document.querySelectorAll('webview')].find((w) => {
      try {
        return w.getURL().startsWith(u);
      } catch {
        return false;
      }
    });
    return wv ? wv.getWebContentsId() : null;
  }, url);
const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());

// A connection, written in main as main writes one (PRQ-4).
const grant = (electronApp, key, walletIndex = 0) =>
  electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/wallet/dapp-permissions`).grantPermission(args.key, args.walletIndex, 100);
  }, { root: repoRoot, key, walletIndex });
const ruleCovers = (electronApp, key) =>
  electronApp.evaluate((_electron, args) =>
    process.mainModule
      .require(`${args.root}/src/main/wallet/dapp-permissions`)
      .isTransactionAutoApproved(args.key, args.to, args.selector, 100, '0'),
  { root: repoRoot, key, to: CONTRACT, selector: SELECTOR });

// No chain: main's quote, and what main hands its signer, replaced in main.
// The stub runs main's guard after the "signature", as the transaction
// service does, and can be held at the device.
function stubChain(electronApp) {
  return electronApp.evaluate((_electron, args) => {
    const service = process.mainModule.require(`${args.root}/src/main/wallet/transaction-service`);
    const recorder = process.mainModule.require(`${args.root}/src/main/wallet/tx-recorder`);
    service.estimateGas = async () => ({ gasLimit: '21000' });
    service.getGasPrices = async () => ({ type: 'legacy', gasPrice: '1000000000', effectiveGasPrice: '1000000000' });
    globalThis.__sends = [];
    globalThis.__holdDevice = null;
    recorder.signAndRecord = async (tx, _signer, context, options) => {
      globalThis.__sends.push({ tx, context, walletIndex: options?.walletIndex });
      if (globalThis.__holdDevice) await globalThis.__holdDevice;
      if (options?.guardCommit) await options.guardCommit(async () => ({ intentId: 'intent-e2e' }));
      options?.onCommitted?.();
      return { hash: args.hash, recorded: true };
    };
  }, { root: repoRoot, hash: HASH });
}
const sends = (electronApp) => electronApp.evaluate(() => globalThis.__sends.slice());
// The fee check's evidence, through the harness (null restores its default).
const feeReference = (electronApp, reply) =>
  electronApp.evaluate((_electron, value) => globalThis.__FREEDOM_TEST_HARNESS__.setFeeReferenceFixture(value), reply);

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

const txScreen = (win) => win.locator('#sidebar-dapp-tx');
const unlockScreen = (win) => win.locator('#sidebar-vault-unlock');

/** Prompt messages main sent the chrome, of one kind. */
const promptsOf = async (electronApp, kind) =>
  (await trace(electronApp))
    .filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt' && e.payload.kind === kind)
    .map((e) => e.payload);

test('sends through main: its prompt and fee check, its own token, the contract rule it reads and records, and the chrome refused (0011 PRQ-5b)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${KEY_A}/`, page('dapp a'));
  await harness.setContentFixture(`${KEY_B}/`, page('dapp b'));
  await harness.setContentFixture(`${KEY_C}/`, page('dapp c'));
  await stubChain(electronApp);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  await grant(electronApp, KEY_A);
  await openIn(win, `${KEY_A}/`);
  const guest = await guestOf(win, KEY_A);

  // The chrome mints no dapp-send token, none for a site's Safe send, and
  // claims no site's contract rule.
  const forged = await win.evaluate(
    async ({ guest: id, key, call }) => {
      const reason = (result) => (result?.success ? 'granted' : result?.code || result?.error);
      const tx = { ...call, chainId: 100, gasLimit: '21000', gasPrice: '1000000000' };
      return {
        send: reason(await window.wallet.confirmSigning('dapp-send', 0, { ...tx, origin: key })),
        safe: reason(
          await window.wallet.confirmSigning('safe-send', 1000, { tx: { to: call.to, value: '0', data: call.data }, chainId: 100, origin: key })
        ),
        rule: reason(
          await window.wallet.dappSendTransaction(tx, 0, { origin: key }, { autoApprove: key, webContentsId: id, rememberAutoApprove: key })
        ),
      };
    },
    { guest, key: KEY_A, call: CALL }
  );
  expect(forged).toEqual({ send: 'SIGNING_NOT_CONFIRMED', safe: 'SIGNING_NOT_CONFIRMED', rule: 'SIGNING_NOT_CONFIRMED' });
  expect(await sends(electronApp)).toEqual([]);

  // A contract call: main's prompt, rendered with main's site, transaction
  // and fee.
  await send(win, KEY_A, 'call', CALL);
  await expect(txScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-tx-site')).toHaveText(KEY_A);
  await expect(win.locator('#dapp-tx-to')).toHaveAttribute('title', CONTRACT);
  await expect(win.locator('#dapp-tx-fee')).toHaveText('~0.000021 xDAI');
  await expect(win.locator('#dapp-tx-fee-max')).toHaveText('Up to 0.000021 xDAI');
  const [shown] = await promptsOf(electronApp, 'eth.send');
  expect(shown).toMatchObject({
    guest,
    site: { key: KEY_A },
    view: {
      account: { index: 0, address: account },
      chain: { id: 100 },
      tx: { to: CONTRACT, value: '0', data: CALL.data },
      fee: { gasLimit: '21000', gasPrice: '1000000000' },
      feeCheck: { comparable: true, above: false, autoApprove: true },
      alwaysAllow: true,
    },
  });
  // A decision with a site is refused, and the prompt stays.
  expect(
    await win.evaluate((h) => window.pagePrompts.decide(h, true, { alwaysAllow: false, site: 'bzz://' + 'b'.repeat(64) }), shown.handle)
  ).toEqual({ ok: false, reason: 'invalid' });
  expect(await outcome(win, KEY_A, 'call')).toEqual({ pending: true });
  await expect(win.locator('#dapp-tx-reject')).toBeInViewport({ ratio: 1 });
  await win.screenshot({ path: test.info().outputPath('page-sends-prompt.png') });
  await win.locator('#dapp-tx-auto-approve').check();
  await win.click('#dapp-tx-approve');
  await expect.poll(async () => (await outcome(win, KEY_A, 'call'))?.ok || null, { timeout: 15_000 }).toBe(HASH);
  await expect(txScreen(win)).toBeHidden();
  // Sent with the fee shown, for the requester's key; one token minted for
  // that record and spent; and the rule recorded for the requester's key.
  expect(await sends(electronApp)).toEqual([
    {
      tx: { to: CONTRACT, value: '0', data: CALL.data, chainId: 100, gasLimit: '21000', gasPrice: '1000000000' },
      context: { kind: 'dapp-send', origin: KEY_A },
      walletIndex: 0,
    },
  ]);
  const recordOf = async () =>
    (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.guest === guest && e.method === 'eth_sendTransaction').at(-1).id;
  const callRecord = await recordOf();
  expect((await trace(electronApp)).filter((e) => e.id === callRecord && e.kind.startsWith('token-')).map((e) => [e.kind, e.token])).toEqual([
    ['token-minted', 'dapp-send'],
    ['token-spent', 'dapp-send'],
  ]);
  expect(await ruleCovers(electronApp, KEY_A)).toBe(true);

  // The rule, read by main: the same call sends with no prompt and no token.
  const promptsBefore = (await promptsOf(electronApp, 'eth.send')).length;
  await send(win, KEY_A, 'ruled', CALL);
  await expect.poll(async () => (await outcome(win, KEY_A, 'ruled'))?.ok || null, { timeout: 15_000 }).toBe(HASH);
  expect((await promptsOf(electronApp, 'eth.send')).length).toBe(promptsBefore);
  const ruledRecord = await recordOf();
  expect((await trace(electronApp)).filter((e) => e.id === ruledRecord && e.kind === 'token-minted')).toEqual([]);

  // A plain transfer still needs its prompt, and "always allow" isn't offered.
  await send(win, KEY_A, 'transfer', TRANSFER);
  await expect(txScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-tx-auto-approve-row')).toBeHidden();
  await win.click('#dapp-tx-reject');
  await expect.poll(() => outcome(win, KEY_A, 'transfer')).toEqual(REJECTED);

  // A fee far above today's (the fee check's reference a tenth of the quote):
  // never under the rule, and confirmed twice on the prompt.
  await feeReference(electronApp, {
    header: null,
    lowest_priority: null,
    quote: { type: 'legacy', gasPrice: '100000000', effectiveGasPrice: '100000000', source: 'direct', verified: false, answered: 2 },
  });
  await send(win, KEY_A, 'above', CALL);
  await expect(txScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-tx-fee-warning')).toBeVisible();
  await win.click('#dapp-tx-approve');
  await expect(win.locator('#dapp-tx-approve')).toHaveText('Send anyway');
  expect(await outcome(win, KEY_A, 'above')).toEqual({ pending: true });
  await win.click('#dapp-tx-approve');
  await expect.poll(async () => (await outcome(win, KEY_A, 'above'))?.ok || null, { timeout: 15_000 }).toBe(HASH);
  await feeReference(electronApp, null);

  // A locked vault under the rule: main asks for the unlock first, for the
  // site it attested, and sends once the vault is open.
  await win.evaluate(() => window.identity.lock());
  await send(win, KEY_A, 'locked', CALL);
  await expect(unlockScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#vault-unlock-site')).toHaveText(KEY_A);
  expect(await outcome(win, KEY_A, 'locked')).toEqual({ pending: true });
  await win.locator('#vault-unlock-password-input').fill(VAULT_PASSWORD);
  await win.click('#vault-unlock-password-submit');
  await expect.poll(async () => (await outcome(win, KEY_A, 'locked'))?.ok || null, { timeout: 15_000 }).toBe(HASH);
  await expect(unlockScreen(win)).toBeHidden();

  // A site that isn't connected is refused, unprompted, and another site's
  // rule never answers for it.
  await win.locator('[data-test="new-tab-btn"]').click();
  await openIn(win, `${KEY_B}/`);
  await send(win, KEY_B, 'other', CALL);
  await expect.poll(() => outcome(win, KEY_B, 'other')).toEqual({
    code: 4100,
    message: 'Not connected. Call eth_requestAccounts first.',
  });

  // A Ledger account: once confirmed, the device step holds the screen, and
  // Reject and Back are no way out, until main has the device's answer.
  await grant(electronApp, KEY_C, LEDGER.index);
  await win.locator('[data-test="new-tab-btn"]').click();
  await openIn(win, `${KEY_C}/`);
  await electronApp.evaluate(() => {
    globalThis.__holdDevice = new Promise((resolve) => {
      globalThis.__releaseDevice = resolve;
    });
  });
  await send(win, KEY_C, 'ledger', TRANSFER);
  await expect(txScreen(win)).toBeVisible({ timeout: 15_000 });
  await win.click('#dapp-tx-approve');
  await expect(win.locator('#dapp-tx-approve')).toHaveText('Confirm on your Ledger…');
  await expect(win.locator('#dapp-tx-reject')).toBeDisabled();
  await expect(win.locator('#dapp-tx-back')).toBeDisabled();
  await win.evaluate(() => {
    document.getElementById('dapp-tx-reject').click();
    document.getElementById('dapp-tx-back').click();
  });
  await expect(txScreen(win)).toBeVisible();
  expect(await outcome(win, KEY_C, 'ledger')).toEqual({ pending: true });
  await electronApp.evaluate(() => {
    globalThis.__holdDevice = null;
    globalThis.__releaseDevice();
  });
  await expect.poll(async () => (await outcome(win, KEY_C, 'ledger'))?.ok || null, { timeout: 15_000 }).toBe(HASH);
  await expect(txScreen(win)).toBeHidden();
  expect((await sends(electronApp)).at(-1)).toMatchObject({ walletIndex: LEDGER.index, context: { origin: KEY_C } });

  // Every send went to main; none took the chrome's old path.
  const methods = (await trace(electronApp))
    .filter((e) => e.kind === 'recorded' && e.guest === guest && e.method !== 'eth_chainId')
    .map((e) => e.method);
  expect(methods).toEqual(Array(5).fill('eth_sendTransaction'));
});
