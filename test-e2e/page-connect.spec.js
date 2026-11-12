// Connecting through main, in real Electron (freedom-core design 0011, step
// PRQ-4): `eth_requestAccounts` and `wallet_switchEthereumChain` go from
// the app's preload to main on `page:request`. Main issues the connect
// prompt as a handle, shows it while its tab is in front by the chrome's
// `page:foreground` report and holds it while the tab is in the background
// (a badge on the tab, a count on the wallet button), takes a decision only
// for the handle it shows at that moment, and writes the grant itself. The
// window's approvals panel shows the prompt and decides it (design 0011,
// APS-2); the chrome's decision is refused, and it writes no grant.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');
const { APPROVALS_URL, approvalsPage, approvalsState, decideInPanel, panelArmed } = require('./approvals-fixtures');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Connect-2026!';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const KEY_C = `bzz://${'c'.repeat(64)}`;
const FORGED_PRELOAD = path.join(__dirname, 'page-connect-forged-preload.js');
const REJECTED = { code: 4001, message: 'User rejected the request' };

const test = base.extend({
  // The base app plus a vault with one account, so a connection has an
  // account to grant.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-page-connect-'));
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

// A dApp page that keeps every provider event it hears.
const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__events = [];
    for (const name of ['accountsChanged', 'chainChanged', 'connect']) {
      window.ethereum.on(name, (data) => window.__events.push([name, data]));
    }
    window.__asked = {};
    window.__ask = (id, method, params) => {
      window.__asked[id] = { pending: true };
      window.ethereum.request({ method, params }).then(
        (ok) => { window.__asked[id] = { ok, at: Date.now() }; },
        (e) => { window.__asked[id] = { code: e && e.code, message: String((e && e.message) || e), at: Date.now() }; }
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

/** Start a request in the page at `url`; its outcome lands on `window.__asked[id]`. */
const start = (win, url, id, method, params = []) =>
  inTab(win, url, `window.__ask(${JSON.stringify(id)}, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
const outcome = (win, url, id) =>
  inTab(win, url, `(() => { const o = window.__asked[${JSON.stringify(id)}]; if (!o) return null; const { at, ...rest } = o; return rest; })()`);
const events = (win, url) => inTab(win, url, 'window.__events');

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

/** What main holds and shows, per window id. */
const promptState = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.promptState());
const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const windowIdOf = (electronApp, guest) =>
  electronApp.evaluate(({ webContents, BrowserWindow }, id) => {
    return BrowserWindow.fromWebContents(webContents.fromId(id).hostWebContents).id;
  }, guest);
/** The prompt messages main sent the chrome of `windowId`, by channel. */
const promptMessages = async (electronApp, windowId, channel) =>
  (await trace(electronApp))
    .filter((e) => e.kind === 'prompt-message' && e.window === windowId && e.channel === channel)
    .map((e) => e.payload);

const grantOf = (win, key) => win.evaluate((k) => window.dappPermissions.getPermission(k), key);

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

async function newTab(win, electronApp, url) {
  const before = new Set(await win.evaluate(() => [...document.querySelectorAll('webview')].map((w) => w.getWebContentsId())));
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);
      return id !== null && !before.has(id);
    })
    .toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url });
  await expect
    .poll(() => inTab(win, url, 'Boolean(window.__ask) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
  return id;
}

const tabButton = (win, tabId) => win.locator(`[data-test="tab"][data-tab-id="${tabId}"]`);
async function switchTo(win, tabId) {
  await tabButton(win, tabId).click();
  await expect(win.locator('[data-test="tab"].active')).toHaveAttribute('data-tab-id', String(tabId));
}

const count = (win) => win.locator('[data-test="wallet-prompt-count"]');

// The window's approvals panel: what it shows, the handle main shows in
// it, and its own decision for a handle. The chrome's is refused (APS-1).
const CHROME_REFUSED = { ok: false, reason: 'approvals-document' };
const heading = (panel) => panel.locator('#heading');
const panelSite = (panel) => panel.locator('#site');
const panelShows = async (electronApp, windowId) => (await approvalsState(electronApp))[windowId]?.shown ?? null;
const panelDecide = (panel, handle, choices) =>
  panel.evaluate(({ h, c }) => window.approvals.decide(h, true, c), { h: handle, c: choices });
async function expectConnect(panel, key) {
  await expect(heading(panel)).toHaveText('Connect', { timeout: 15_000 });
  await expect(panelSite(panel)).toHaveText(key);
}

async function fixtures(harness) {
  for (const [key, title] of [[KEY_A, 'dapp a'], [KEY_B, 'dapp b'], [KEY_C, 'dapp c']]) {
    await harness.setContentFixture(`${key}/`, page(title));
  }
}

test('connecting through main: its prompt, its grant, and the chrome\'s forged origins refused (0011 PRQ-4)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await fixtures(harness);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;

  // The chrome has no way to name a site and grant it (PRQ-9): its preload
  // exposes no grant write, and main refuses dapp:grant-permission for every
  // site (dapp-permissions.test.js).
  expect(await win.evaluate(() => typeof window.dappPermissions.grantPermission)).toBe('undefined');
  expect(await grantOf(win, KEY_A)).toBeNull();

  await openIn(win, `${KEY_A}/`);
  const guestA = await guestOf(win, KEY_A);
  const windowId = await windowIdOf(electronApp, guestA);
  const panel = await approvalsPage(electronApp);
  await start(win, KEY_A, 'connect', 'eth_requestAccounts');
  // In front: main shows it, and the panel renders main's site.
  await expectConnect(panel, KEY_A);
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 1)).toHaveClass(/has-wallet-prompt/);
  const [handle] = (await promptState(electronApp))[windowId].open;
  expect((await promptState(electronApp))[windowId].shown).toBe(handle);
  expect(await panelShows(electronApp, windowId)).toBe(handle);

  // The chrome can't decide it. The panel's decision names no site and
  // can't move the grant to another.
  expect(await win.evaluate((h) => window.pagePrompts.decide(h, true, { walletIndex: 0 }), handle)).toEqual(CHROME_REFUSED);
  await panelArmed(electronApp, windowId);
  expect(await panelDecide(panel, handle, { walletIndex: 0, site: 'bzz://' + 'b'.repeat(64) })).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await panelShows(electronApp, windowId)).toBe(handle);
  expect(await outcome(win, KEY_A, 'connect')).toEqual({ pending: true });

  await win.screenshot({ path: test.info().outputPath('page-connect-prompt.png') });
  await panel.screenshot({ path: test.info().outputPath('page-connect-panel.png') });
  await decideInPanel(electronApp, { heading: 'Connect', panel, windowId });
  await expect.poll(() => outcome(win, KEY_A, 'connect')).toEqual({ ok: [account] });
  // Main wrote the grant, for the requester's key, and told the page.
  expect(await grantOf(win, KEY_A)).toMatchObject({ origin: KEY_A, walletIndex: 0, chainId: 100 });
  expect(await grantOf(win, KEY_B)).toBeNull();
  await expect.poll(() => events(win, KEY_A)).toEqual([
    ['accountsChanged', [account]],
    ['connect', { chainId: '0x64' }],
  ]);
  await expect.poll(() => panelShows(electronApp, windowId)).toBeNull();
  await expect(count(win)).toBeHidden();
  await expect(tabButton(win, 1)).not.toHaveClass(/has-wallet-prompt/);
  // Connected: the next request answers at once.
  await start(win, KEY_A, 'again', 'eth_requestAccounts');
  await expect.poll(() => outcome(win, KEY_A, 'again')).toEqual({ ok: [account] });

  // wallet_switchEthereumChain, main's: the grant's chain, the window's
  // switcher, and chainChanged to the page.
  await start(win, KEY_A, 'switch', 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  await expect.poll(() => outcome(win, KEY_A, 'switch')).toEqual({ ok: null });
  await expect.poll(async () => (await events(win, KEY_A)).at(-1)).toEqual(['chainChanged', '0x1']);
  expect(await grantOf(win, KEY_A)).toMatchObject({ chainId: 1 });
  await start(win, KEY_A, 'chain', 'eth_chainId');
  await expect.poll(() => outcome(win, KEY_A, 'chain')).toEqual({ ok: '0x1' });
  await win.evaluate(async () => (await import('./lib/sidebar.js')).open());
  await expect(win.locator('#chain-switcher-name')).toHaveText('Ethereum');
  // The chrome writes neither a site's last use nor its chain: since PRQ-9
  // its preload has no such call (main marks a site used itself).
  expect(await win.evaluate(() => typeof window.dappPermissions.updateLastUsed)).toBe('undefined');
  expect(await grantOf(win, KEY_A)).toMatchObject({ chainId: 1 });

  // Every one went to main for the guest that asked; the chrome's old path
  // took none.
  const recorded = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.guest === guestA).map((e) => e.method);
  expect(recorded).toEqual(['eth_requestAccounts', 'eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_chainId']);

  // One pending wallet prompt per document.
  await newTab(win, electronApp, `${KEY_B}/`);
  const guestB = await guestOf(win, KEY_B);
  await start(win, KEY_B, 'first', 'eth_requestAccounts');
  await expectConnect(panel, KEY_B);
  await start(win, KEY_B, 'second', 'eth_requestAccounts');
  await expect.poll(() => outcome(win, KEY_B, 'second')).toEqual({
    code: -32002,
    message: 'Another wallet request is already pending',
  });
  const [handleB] = (await promptState(electronApp))[windowId].open;

  // Another window: its chrome's decision and its panel's for this
  // window's handle are refused, and its report of this window's guest is
  // ignored.
  await win.evaluate(() => window.electronAPI.newWindow());
  let win2;
  await expect
    .poll(
      () => {
        win2 = electronApp.windows().find((p) => p !== win && p.url().includes('renderer/index.html'));
        return Boolean(win2);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  await win2.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  expect(await win2.evaluate((h) => window.pagePrompts.decide(h, true, { walletIndex: 0 }), handleB)).toEqual(CHROME_REFUSED);
  let panel2;
  await expect
    .poll(() => {
      panel2 = electronApp.windows().find((p) => p !== panel && p.url() === APPROVALS_URL);
      return Boolean(panel2);
    })
    .toBe(true);
  expect(await panelDecide(panel2, handleB, { walletIndex: 0 })).toEqual({ ok: false, reason: 'not-shown' });
  await win2.evaluate((guest) => window.pagePrompts.foreground(guest), guestA);
  await win.waitForTimeout(300);
  const state = await promptState(electronApp);
  expect(state[windowId]).toEqual({ front: guestB, shown: handleB, open: [handleB] });
  expect(Object.values(state).filter((s) => s !== state[windowId]).every((s) => s.open.length === 0 && s.front !== guestA)).toBe(true);
  expect(await outcome(win, KEY_B, 'first')).toEqual({ pending: true });
  expect(await grantOf(win, KEY_B)).toBeNull();
  await win2.close();

  // A page can't report its own tab in front or decide its own prompt: the
  // sender policy gives it neither channel.
  await switchTo(win, 1);
  await expect.poll(() => panelShows(electronApp, windowId)).toBeNull();
  await electronApp.evaluate(({ webContents }, args) => {
    globalThis.__forged = [];
    const guest = webContents.fromId(args.guest);
    guest.on('ipc-message', (_event, channel, payload) => {
      if (channel === 'page-connect-test:forged') globalThis.__forged.push(payload);
    });
    guest.session.registerPreloadScript({ type: 'frame', id: 'page-connect-test-forged', filePath: args.preload });
  }, { guest: guestA, preload: FORGED_PRELOAD });
  await electronApp.evaluate(({ webContents }, id) => {
    webContents.fromId(id).reload();
  }, guestA);
  await expect
    .poll(() => inTab(win, KEY_A, 'Boolean(window.__ask) && document.readyState === "complete"'), { timeout: 30_000 })
    .toBe(true);
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.page).mainFrame.send('page-connect-test:forge', { guest: args.target, handle: args.handle });
  }, { page: guestA, target: guestB, handle: handleB });
  await expect.poll(() => electronApp.evaluate(() => globalThis.__forged.length), { timeout: 15_000 }).toBe(1);
  const [forgedDecision] = await electronApp.evaluate(() => globalThis.__forged);
  expect(forgedDecision.rejected).toBeTruthy();
  await electronApp.evaluate(({ webContents }, id) => {
    webContents.fromId(id).session.unregisterPreloadScript('page-connect-test-forged');
  }, guestA);
  expect((await promptState(electronApp))[windowId]).toEqual({ front: guestA, shown: null, open: [handleB] });
  expect(await grantOf(win, KEY_B)).toBeNull();

  // Back on B, the user rejects it.
  await switchTo(win, 2);
  await expectConnect(panel, KEY_B);
  await decideInPanel(electronApp, { approve: false, panel, windowId });
  await expect.poll(() => outcome(win, KEY_B, 'first')).toEqual(REJECTED);
  expect(await grantOf(win, KEY_B)).toBeNull();
});

test('a background tab\'s prompt waits for its tab; switching away hides it and back shows it; a late decision is refused (0011 PRQ-4)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await fixtures(harness);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;

  await openIn(win, `${KEY_A}/`);
  await newTab(win, electronApp, `${KEY_B}/`);
  const guestA = await guestOf(win, KEY_A);
  const guestB = await guestOf(win, KEY_B);
  const windowId = await windowIdOf(electronApp, guestA);
  await switchTo(win, 1);
  const sidebarOpen = () => win.evaluate(async () => (await import('./lib/sidebar.js')).isVisible());
  expect(await sidebarOpen()).toBe(false);

  // B, in the background, asks: main holds it. Its tab has a badge and the
  // wallet button a count, and nothing opens.
  await start(win, KEY_B, 'b', 'eth_requestAccounts');
  await expect(count(win)).toHaveText('1');
  await expect(tabButton(win, 2)).toHaveClass(/has-wallet-prompt/);
  await expect(tabButton(win, 1)).not.toHaveClass(/has-wallet-prompt/);
  const panel = await approvalsPage(electronApp);
  await win.waitForTimeout(500);
  expect(await panelShows(electronApp, windowId)).toBeNull();
  expect(await sidebarOpen()).toBe(false);
  const [handleB] = (await promptState(electronApp))[windowId].open;
  expect(await promptMessages(electronApp, windowId, 'page:prompt-pending')).toEqual([{ handle: handleB, guest: guestB }]);
  expect(await promptMessages(electronApp, windowId, 'page:prompt')).toEqual([]);
  await win.screenshot({ path: test.info().outputPath('page-connect-background-badge.png') });

  // The user switches to B: its prompt opens.
  await switchTo(win, 2);
  await expectConnect(panel, KEY_B);

  // A asks while B's shows: A waits; B's isn't refused or replaced.
  await start(win, KEY_A, 'a', 'eth_requestAccounts');
  await expect(count(win)).toHaveText('2');
  await expect(tabButton(win, 1)).toHaveClass(/has-wallet-prompt/);
  await expect(panelSite(panel)).toHaveText(KEY_B);
  const handleA = (await promptState(electronApp))[windowId].open.find((h) => h !== handleB);

  // Switching away hides B's (it keeps its place) and shows A's.
  await switchTo(win, 1);
  await expectConnect(panel, KEY_A);
  expect(await promptMessages(electronApp, windowId, 'page:prompt-hidden')).toEqual([{ handle: handleB }]);
  expect((await promptState(electronApp))[windowId]).toEqual({ front: guestA, shown: handleA, open: [handleB, handleA] });
  // B's decision, sent after the report of A: refused, nothing done.
  await panelArmed(electronApp, windowId);
  expect(await panelDecide(panel, handleB, { walletIndex: 0 })).toEqual({ ok: false, reason: 'not-shown' });
  expect(await outcome(win, KEY_B, 'b')).toEqual({ pending: true });
  expect(await grantOf(win, KEY_B)).toBeNull();
  await decideInPanel(electronApp, { approve: false, panel, windowId });
  await expect.poll(() => outcome(win, KEY_A, 'a')).toEqual(REJECTED);
  await expect(count(win)).toHaveText('1');
  await expect.poll(() => panelShows(electronApp, windowId)).toBeNull();

  // Back to B: its prompt shows again, and now its decision counts.
  await switchTo(win, 2);
  await expectConnect(panel, KEY_B);
  await decideInPanel(electronApp, { panel, windowId });
  await expect.poll(() => outcome(win, KEY_B, 'b')).toEqual({ ok: [account] });
  expect(await grantOf(win, KEY_B)).toMatchObject({ origin: KEY_B, walletIndex: 0 });
  expect(await grantOf(win, KEY_A)).toBeNull();
  await expect(count(win)).toBeHidden();

  // A held prompt closes when its document navigates, and when its tab
  // closes: badge and count go, and nothing shows it later.
  await switchTo(win, 1);
  await start(win, KEY_B, 'held', 'eth_requestAccounts');
  // B is connected now: answered at once, no prompt.
  await expect.poll(() => outcome(win, KEY_B, 'held')).toEqual({ ok: [account] });
  await newTab(win, electronApp, `${KEY_C}/`);
  const guestC = await guestOf(win, KEY_C);
  await switchTo(win, 1);
  await start(win, KEY_C, 'c', 'eth_requestAccounts');
  await expect(tabButton(win, 3)).toHaveClass(/has-wallet-prompt/);
  const [handleC] = (await promptState(electronApp))[windowId].open;
  await electronApp.evaluate(({ webContents }, id) => {
    webContents.fromId(id).loadURL('about:blank').catch(() => {});
  }, guestC);
  await expect(tabButton(win, 3)).not.toHaveClass(/has-wallet-prompt/);
  await expect(count(win)).toBeHidden();
  expect((await promptMessages(electronApp, windowId, 'page:prompt-closed')).find((m) => m.handle === handleC)).toEqual({
    handle: handleC,
    reason: 'navigated',
  });
  await switchTo(win, 3);
  await win.waitForTimeout(500);
  expect(await panelShows(electronApp, windowId)).toBeNull();
  expect(await panelDecide(panel, handleC, { walletIndex: 0 })).toEqual({ ok: false, reason: 'not-shown' });
  expect(await grantOf(win, KEY_C)).toBeNull();

  // Its tab closes.
  await electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id: guestC, url: `${KEY_C}/` });
  await expect
    .poll(() => inTab(win, KEY_C, 'Boolean(window.__ask) && document.readyState === "complete"'), { timeout: 30_000 })
    .toBe(true);
  await switchTo(win, 1);
  await start(win, KEY_C, 'closing', 'eth_requestAccounts');
  await expect(tabButton(win, 3)).toHaveClass(/has-wallet-prompt/);
  const [handleClosing] = (await promptState(electronApp))[windowId].open;
  await tabButton(win, 3).locator('[data-test="tab-close"]').click();
  await expect(count(win)).toBeHidden();
  await expect
    .poll(async () => (await promptMessages(electronApp, windowId, 'page:prompt-closed')).find((m) => m.handle === handleClosing))
    .toEqual({ handle: handleClosing, reason: 'closed' });
  expect((await promptState(electronApp))[windowId].open).toEqual([]);
});

test('a held prompt\'s deadline is main\'s, from its arrival: the page hears only main\'s "Request timed out", and nothing shows later (0011 PRQ-4)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(300_000);
  await fixtures(harness);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  await openIn(win, `${KEY_A}/`);
  await newTab(win, electronApp, `${KEY_B}/`);
  const guestA = await guestOf(win, KEY_A);
  const windowId = await windowIdOf(electronApp, guestA);
  await switchTo(win, 1);

  // A test hook holds B's request on its way into main past today's page
  // timer (60 s), as a slow delivery would.
  await electronApp.evaluate(() => {
    globalThis.__released = null;
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setHoldRequest(async (payload) => {
      if (payload?.method !== 'eth_requestAccounts') return;
      await new Promise((resolve) => setTimeout(resolve, 62_000));
      globalThis.__released = Date.now();
    });
  });
  await start(win, KEY_B, 'slow', 'eth_requestAccounts');
  const sent = Date.now();
  // Past the page timer's 60 s: still pending, and main has it now.
  await expect.poll(() => electronApp.evaluate(() => globalThis.__released), { timeout: 70_000, intervals: [1000] }).not.toBeNull();
  await electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setHoldRequest(null));
  expect(Date.now() - sent).toBeGreaterThan(60_000);
  expect(await outcome(win, KEY_B, 'slow')).toEqual({ pending: true });
  await expect(count(win)).toHaveText('1');
  const [handle] = (await promptState(electronApp))[windowId].open;

  // Main's own deadline, a full 60 s from the arrival.
  await expect
    .poll(() => outcome(win, KEY_B, 'slow'), { timeout: 75_000, intervals: [1000] })
    .toEqual({ message: 'Request timed out' });
  const released = await electronApp.evaluate(() => globalThis.__released);
  const answeredAt = await inTab(win, KEY_B, 'window.__asked.slow.at');
  expect(answeredAt - released).toBeGreaterThanOrEqual(59_500);
  expect((await promptMessages(electronApp, windowId, 'page:prompt-closed')).find((m) => m.handle === handle)).toEqual({
    handle,
    reason: 'expired',
  });
  await expect(count(win)).toBeHidden();
  await expect(tabButton(win, 2)).not.toHaveClass(/has-wallet-prompt/);

  // A later report that its tab is in front shows nothing, and a decision
  // for it does nothing.
  await switchTo(win, 2);
  await win.waitForTimeout(500);
  expect(await panelShows(electronApp, windowId)).toBeNull();
  expect(await promptMessages(electronApp, windowId, 'page:prompt')).toEqual([]);
  const panel = await approvalsPage(electronApp);
  expect(await panelDecide(panel, handle, { walletIndex: 0 })).toEqual({ ok: false, reason: 'not-shown' });
  expect(await grantOf(win, KEY_B)).toBeNull();
});
