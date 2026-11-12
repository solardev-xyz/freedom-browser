// Signing through main, in real Electron (freedom-core design 0011, step
// PRQ-5a): `personal_sign` and `eth_signTypedData_v4` go from the app's
// preload to main on `page:request`. Main shows the signing prompt as a
// handle, the chrome renders it and answers it, and main's own issuer mints
// the approval's token for that handle and the requester's key and spends
// it. The chrome mints no page token and claims no site's rule: main reads
// the rule itself, and asks for the vault's unlock first when it is locked.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { verifyMessage, verifyTypedData } = require('ethers');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Signing-2026!';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const MESSAGE = '0x48656c6c6f2c2046726565646f6d'; // "Hello, Freedom"
const RAW_HASH = `0x${'ab'.repeat(32)}`;
const TYPED = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'chainId', type: 'uint256' },
    ],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  domain: { name: 'Freedom Signing Fixture', chainId: 100 },
  primaryType: 'Mail',
  message: { contents: 'Signed through main' },
};
const REJECTED = { code: 4001, message: 'User rejected the request' };

const test = base.extend({
  // The base app plus a vault with one account.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-page-signing-'));
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
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }],
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

const start = (win, url, id, method, params = []) =>
  inTab(win, url, `window.__ask(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
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
const grantOf = (win, key) => win.evaluate((k) => window.dappPermissions.getPermission(k), key);

// A connection, written in main as main writes one (PRQ-4).
const grant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/wallet/dapp-permissions`).grantPermission(args.key, 0, 100);
  }, { root: repoRoot, key });

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

const signScreen = (win) => win.locator('#sidebar-dapp-sign');
const unlockScreen = (win) => win.locator('#sidebar-vault-unlock');

/** Prompt messages main sent the chrome, of one kind. */
const promptsOf = async (electronApp, kind) =>
  (await trace(electronApp))
    .filter((e) => e.kind === 'prompt-message' && e.channel === 'page:prompt' && e.payload.kind === kind)
    .map((e) => e.payload);

test('signing through main: its prompt, its own token, the rule it reads, and the chrome refused (0011 PRQ-5a)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${KEY_A}/`, page('dapp a'));
  await harness.setContentFixture(`${KEY_B}/`, page('dapp b'));
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  await grant(electronApp, KEY_A);
  await openIn(win, `${KEY_A}/`);
  const guest = await guestOf(win, KEY_A);

  // The chrome mints no page token, and claims no site's rule.
  const forged = await win.evaluate(
    async ({ guest: id, key, message, typed }) => {
      const reason = (result) => (result?.success ? 'granted' : result?.code || result?.error);
      return {
        message: reason(await window.wallet.confirmSigning('sign-message', 0, message)),
        typed: reason(await window.wallet.confirmSigning('sign-typed-data', 0, typed)),
        safe: reason(await window.wallet.confirmSigning('safe-message', 1000, { method: 'personal_sign', params: [message] })),
        ruleMessage: reason(await window.wallet.signMessage(message, 0, { autoApprove: key, webContentsId: id })),
        ruleTyped: reason(
          await window.wallet.signTypedData(typed, 0, { autoApprove: key, webContentsId: id }, { chainId: 100 })
        ),
      };
    },
    { guest, key: KEY_A, message: MESSAGE, typed: TYPED }
  );
  expect(forged).toEqual({
    message: 'SIGNING_NOT_CONFIRMED',
    typed: 'SIGNING_NOT_CONFIRMED',
    safe: 'SIGNING_NOT_CONFIRMED',
    ruleMessage: 'SIGNING_NOT_CONFIRMED',
    ruleTyped: 'SIGNING_NOT_CONFIRMED',
  });
  // Nor does it set the site's rule; it may still clear one.
  const ruleWrites = await win.evaluate(async (key) => {
    const out = {};
    try {
      await window.dappPermissions.setSigningAutoApprove(key, true);
      out.set = 'set';
    } catch (err) {
      out.set = String(err?.message || err).includes('only from a signing prompt') ? 'refused' : String(err);
    }
    out.clear = await window.dappPermissions.setSigningAutoApprove(key, false);
    return out;
  }, KEY_A);
  expect(ruleWrites).toEqual({ set: 'refused', clear: true });
  expect((await grantOf(win, KEY_A)).autoApprove?.signing).not.toBe(true);

  // personal_sign: main's prompt, rendered with main's site and message.
  await start(win, KEY_A, 'message', 'personal_sign', [MESSAGE, account]);
  await expect(signScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-sign-site')).toHaveText(KEY_A);
  await expect(win.locator('#dapp-sign-message')).toHaveText('Hello, Freedom');
  const [shown] = await promptsOf(electronApp, 'eth.sign');
  expect(shown).toMatchObject({
    guest,
    site: { key: KEY_A },
    view: { method: 'personal_sign', account: { index: 0, address: account }, message: { hex: MESSAGE, rawHash: false } },
  });
  // A decision with a site is refused, and the prompt stays.
  expect(
    await win.evaluate((h) => window.pagePrompts.decide(h, true, { alwaysAllow: false, site: 'bzz://' + 'b'.repeat(64) }), shown.handle)
  ).toEqual({ ok: false, reason: 'invalid' });
  await expect(signScreen(win)).toBeVisible();
  expect(await outcome(win, KEY_A, 'message')).toEqual({ pending: true });
  await expect(win.locator('#dapp-sign-reject')).toBeInViewport({ ratio: 1 });
  await win.screenshot({ path: test.info().outputPath('page-signing-prompt.png') });
  await win.click('#dapp-sign-approve');
  await expect.poll(async () => (await outcome(win, KEY_A, 'message'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x[0-9a-f]{130}$/i);
  const messageSignature = (await outcome(win, KEY_A, 'message')).ok;
  expect(verifyMessage('Hello, Freedom', messageSignature)).toBe(account);
  await expect(signScreen(win)).toBeHidden();
  // Main's issuer minted one token for that record and spent it.
  const recordOf = async (method) =>
    (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.guest === guest && e.method === method).at(-1).id;
  const messageRecord = await recordOf('personal_sign');
  const tokenTrace = (await trace(electronApp)).filter((e) => e.id === messageRecord && e.kind.startsWith('token-'));
  expect(tokenTrace.map((e) => [e.kind, e.token])).toEqual([
    ['token-minted', 'sign-message'],
    ['token-spent', 'sign-message'],
  ]);

  // eth_signTypedData_v4, with "always allow": main sets the site's rule
  // for the requester's key once the signature is made.
  await start(win, KEY_A, 'typed', 'eth_signTypedData_v4', [account, JSON.stringify(TYPED)]);
  await expect(signScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-sign-typed-data')).toContainText('Signed through main');
  await win.locator('#dapp-sign-auto-approve').check();
  await win.click('#dapp-sign-approve');
  await expect.poll(async () => (await outcome(win, KEY_A, 'typed'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x[0-9a-f]{130}$/i);
  const { EIP712Domain: _domain, ...types } = TYPED.types;
  expect(verifyTypedData(TYPED.domain, types, TYPED.message, (await outcome(win, KEY_A, 'typed')).ok)).toBe(account);
  await expect.poll(async () => (await grantOf(win, KEY_A)).autoApprove?.signing).toBe(true);

  // The rule, read by main: the next message signs with no prompt.
  const promptsBefore = (await promptsOf(electronApp, 'eth.sign')).length;
  await start(win, KEY_A, 'ruled', 'personal_sign', [MESSAGE, account]);
  await expect.poll(async () => (await outcome(win, KEY_A, 'ruled'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x/);
  expect((await promptsOf(electronApp, 'eth.sign')).length).toBe(promptsBefore);
  const ruledRecord = await recordOf('personal_sign');
  expect((await trace(electronApp)).filter((e) => e.id === ruledRecord && e.kind === 'token-minted')).toEqual([]);

  // A 32-byte message still needs its prompt.
  await start(win, KEY_A, 'raw', 'personal_sign', [RAW_HASH, account]);
  await expect(signScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#dapp-sign-raw-warning')).toBeVisible();
  await win.click('#dapp-sign-reject');
  await expect.poll(() => outcome(win, KEY_A, 'raw')).toEqual(REJECTED);

  // A locked vault under the rule: main asks for the unlock first, for the
  // site it attested, and signs once the vault is open.
  await win.evaluate(() => window.identity.lock());
  await start(win, KEY_A, 'locked', 'personal_sign', [MESSAGE, account]);
  await expect(unlockScreen(win)).toBeVisible({ timeout: 15_000 });
  await expect(win.locator('#vault-unlock-site')).toHaveText(KEY_A);
  expect(await outcome(win, KEY_A, 'locked')).toEqual({ pending: true });
  await win.locator('#vault-unlock-password-input').fill(VAULT_PASSWORD);
  await win.click('#vault-unlock-password-submit');
  await expect.poll(async () => (await outcome(win, KEY_A, 'locked'))?.ok || null, { timeout: 15_000 }).toMatch(/^0x/);
  expect(verifyMessage('Hello, Freedom', (await outcome(win, KEY_A, 'locked')).ok)).toBe(account);
  await expect(unlockScreen(win)).toBeHidden();

  // A site that isn't connected is refused, unprompted, and another site's
  // rule never answers for it.
  await win.locator('[data-test="new-tab-btn"]').click();
  await openIn(win, `${KEY_B}/`);
  await start(win, KEY_B, 'other', 'personal_sign', [MESSAGE, account]);
  await expect.poll(() => outcome(win, KEY_B, 'other')).toEqual({
    code: 4100,
    message: 'Not connected. Call eth_requestAccounts first.',
  });

  // Clearing the rule from the chrome is still accepted, and the next
  // message prompts again.
  await win.evaluate((key) => window.dappPermissions.setSigningAutoApprove(key, false), KEY_A);
  await win.locator('[data-test="tab"][data-tab-id="1"]').click();
  await start(win, KEY_A, 'cleared', 'personal_sign', [MESSAGE, account]);
  await expect(signScreen(win)).toBeVisible({ timeout: 15_000 });
  await win.click('#dapp-sign-reject');
  await expect.poll(() => outcome(win, KEY_A, 'cleared')).toEqual(REJECTED);

  // Every signing request went to main; none took the chrome's old path.
  const methods = (await trace(electronApp))
    .filter((e) => e.kind === 'recorded' && e.guest === guest && e.method !== 'eth_chainId')
    .map((e) => e.method);
  expect(methods).toEqual([
    'personal_sign',
    'eth_signTypedData_v4',
    'personal_sign',
    'personal_sign',
    'personal_sign',
    'personal_sign',
  ]);
});
