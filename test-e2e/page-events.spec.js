// The Ethereum events the chrome used to send, sent by main, in real
// Electron (freedom-core design 0011, step PRQ-6): the chain switcher's
// `chainChanged` to every page of its window whose chain follows the
// selection, and `accountsChanged` when a grant is revoked or its account
// changes to every live page of the key, in every window. Each goes from
// main with `WebFrameMain.send` on the guest's main frame, with the
// document's nonce: never to a navigated document, another key, a
// sub-frame, a private window or (`chainChanged`) an onchain app, and never
// an `accountsChanged` to a page whose DNS name has moved off its IPNS key.
// An event main held past its check reaches the document that replaced the
// one it was for, which drops it.
//
// A test preload in every frame of the tabs' session reports each
// `page:event` that reaches a frame (`page-events-listener-preload.js`), so
// the spec sees which frames main sent to, sub-frames included.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');
const { PROVENANCE_HEADER, encodeOnchainProvenance } = require('../src/main/onchain/onchain-app-protocol');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Events-2026!';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const FRAME = `bzz://${'c'.repeat(64)}/frame`;
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const ONCHAIN_CHAIN = 31337;
const ONCHAIN_URL = `web3://${ONCHAIN}.eip155-${ONCHAIN_CHAIN}/`;
const NAME = 'example.com';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAMED_URL = `ipns://${IPNS_KEY}/`;
const LISTENER_PRELOAD = path.join(__dirname, 'page-events-listener-preload.js');
// A second account, so a grant's account can change.
const SECOND = {
  index: 1000000,
  name: 'Ledger 1',
  address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  type: 'ledger',
  path: "44'/60'/0'/0/0",
};

const test = base.extend({
  // The base app plus a vault with two accounts.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-page-events-'));
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
        derivedWallets: [{ index: 0, name: 'Main Wallet', address: keys.userWallet.address }, SECOND],
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

// A page that keeps every provider event it hears, and on `chainChanged`
// what its own `eth_chainId` then answers. A private window's page has no
// provider, and keeps nothing.
const page = (title, extra = '') => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__events = [];
    window.__chains = [];
    if (window.ethereum) {
      for (const name of ['accountsChanged', 'chainChanged', 'connect', 'disconnect']) {
        window.ethereum.on(name, (data) => window.__events.push([name, data]));
      }
      window.ethereum.on('chainChanged', (chainId) => {
        window.ethereum.request({ method: 'eth_chainId' }).then((now) => window.__chains.push([chainId, now]));
      });
    }
    window.__ready = true;
  </script><h1>${title}</h1>${extra}`,
});

const onchainFixture = {
  ...page('onchain'),
  headers: {
    [PROVENANCE_HEADER]: encodeOnchainProvenance({
      version: 1,
      chainId: ONCHAIN_CHAIN,
      network: 'Anvil',
      contract: ONCHAIN,
      htmlHash: `0x${'ab'.repeat(32)}`,
      trust: {
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
        block: 1,
        agreed: ['myotis-p2p'],
        dissented: [],
        queried: ['myotis-p2p'],
      },
    }),
  },
};

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

const ask = (win, url, method, params = []) =>
  inTab(
    win,
    url,
    `window.ethereum.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
      .then((ok) => ({ ok }), (e) => ({ code: e?.code, message: String(e?.message || e) }))`
  );
const eventsOf = (win, url) => inTab(win, url, 'window.__events');

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

const activeGuestId = (win) =>
  win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getWebContentsId() ?? null);

const ready = (win, url) =>
  expect
    .poll(() => inTab(win, url, 'window.__ready === true && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);

const load = (electronApp, id, url) =>
  electronApp.evaluate(({ webContents }, args) => {
    webContents.fromId(args.id).loadURL(args.url).catch(() => {});
  }, { id, url });

/** Open `url` in a new tab of `win`; its guest id. */
async function newTab(win, electronApp, url, readyUrl = url) {
  const before = new Set(await win.evaluate(() => [...document.querySelectorAll('webview')].map((w) => w.getWebContentsId())));
  await win.locator('[data-test="new-tab-btn"]').click();
  let id = null;
  await expect
    .poll(async () => {
      id = await activeGuestId(win).catch(() => null);
      return id !== null && !before.has(id);
    })
    .toBe(true);
  await load(electronApp, id, url);
  await ready(win, readyUrl);
  return id;
}

/** Open `url` in the active tab of `win`; its guest id. */
async function openHere(win, electronApp, url, readyUrl = url) {
  let id = null;
  await expect
    .poll(async () => {
      id = await activeGuestId(win).catch(() => null);
      return id !== null;
    })
    .toBe(true);
  await load(electronApp, id, url);
  await ready(win, readyUrl);
  return id;
}

async function secondWindow(win, electronApp) {
  const known = new Set(electronApp.windows());
  await win.evaluate(() => window.electronAPI.newWindow());
  let win2;
  await expect
    .poll(
      () => {
        win2 = electronApp.windows().find((p) => !known.has(p) && p.url().includes('renderer/index.html') && !p.url().includes('privatePartition='));
        return Boolean(win2);
      },
      { timeout: 15_000 }
    )
    .toBe(true);
  await win2.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return win2;
}

async function privateWindow(electronApp) {
  const known = new Set(electronApp.windows().map((p) => p.url()));
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu().getMenuItemById('new-private-window').click();
  });
  let privateWin;
  await expect
    .poll(() => {
      privateWin = electronApp.windows().find((p) => p.url().includes('privatePartition=private-') && !known.has(p.url()));
      return Boolean(privateWin);
    }, { timeout: 15_000 })
    .toBe(true);
  await privateWin.waitForSelector('[data-test="address-input"]', { state: 'visible' });
  return privateWin;
}

/** Report every `page:event` that reaches any frame of the tabs' session. */
async function listen(electronApp, win) {
  const id = await activeGuestId(win);
  await electronApp.evaluate(({ webContents }, args) => {
    globalThis.__pe = { heard: [], watched: new Set(), release: null };
    webContents.fromId(args.id).session.registerPreloadScript({
      type: 'frame',
      id: 'page-events-test-listener',
      filePath: args.preload,
    });
  }, { id, preload: LISTENER_PRELOAD });
}

/** Watch every tab guest not yet watched for the listener's reports. */
const watchAll = (electronApp) =>
  electronApp.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() !== 'webview' || globalThis.__pe.watched.has(contents.id)) continue;
      globalThis.__pe.watched.add(contents.id);
      const guest = contents.id;
      contents.on('ipc-message', (_event, channel, payload) => {
        if (channel === 'page-events-test:heard') globalThis.__pe.heard.push({ guest, ...payload });
      });
    }
  });

const heard = (electronApp) => electronApp.evaluate(() => globalThis.__pe.heard.slice());
const clearHeard = (electronApp) => electronApp.evaluate(() => (globalThis.__pe.heard.length = 0));
const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());
const sentTo = async (electronApp, event) =>
  (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.event === event).map((e) => e.guest);
const liveNavigation = (electronApp, guest) =>
  electronApp.evaluate(
    (_electron, id) => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.liveDocuments().find((doc) => doc.guest === id)?.navigation ?? null,
    guest
  );

/** Hold main's send of the next event to `guest`, after main has checked the record. */
const holdNextSendTo = (electronApp, guest) =>
  electronApp.evaluate((_electron, id) => {
    globalThis.__pe.release = null;
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setBeforeEventSend((_message, target) => {
      if (target.guest !== id || globalThis.__pe.release) return undefined;
      return new Promise((resolve) => {
        globalThis.__pe.release = resolve;
      });
    });
  }, guest);
const releaseSend = (electronApp) =>
  electronApp.evaluate(() => {
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setBeforeEventSend(null);
    globalThis.__pe.release();
  });

/** Reload a guest in its process, and wait for its new document's hello. */
async function reloadInPlace(electronApp, win, guest, url) {
  const before = await liveNavigation(electronApp, guest);
  const processBefore = await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).mainFrame.processId, guest);
  await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).reload(), guest);
  await expect
    .poll(async () => {
      const now = await liveNavigation(electronApp, guest);
      return now !== null && now !== before && (await inTab(win, url, 'window.__ready === true')) === true;
    }, { timeout: 20_000, message: `waiting for ${url} to reload and say hello` })
    .toBe(true);
  expect(
    await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id).mainFrame.processId, guest),
    'the reload stays in its process'
  ).toBe(processBefore);
}

const mainModule = (electronApp, file, method, ...args) =>
  electronApp.evaluate((_electron, a) => {
    return process.mainModule.require(`${a.root}/${a.file}`)[a.method](...a.args);
  }, { root: repoRoot, file, method, args });
// Written by the identity core, under the page's PageContext (design 0012,
// APB-2).
const pageOf = (key) => ({ origin: key, top_origin: key, frame: 1, navigation: 1, agent: false });
const grant = (electronApp, key, walletIndex = 0) =>
  mainModule(electronApp, 'src/main/wallet/dapp-permissions', 'grantPermission', key, walletIndex, 100, pageOf(key));
// The agent's connect changes a grant's account this way.
const changeAccount = (electronApp, key, walletIndex) =>
  mainModule(electronApp, 'src/main/wallet/dapp-permissions', 'updateWalletIndex', key, walletIndex, pageOf(key));
// The chrome's own disconnect, as the banner and the permissions screen run it.
const disconnect = (win, key) =>
  win.evaluate(async (k) => (await import('./lib/wallet/dapp-connect.js')).disconnectDapp(k), key);

async function pickChain(win, name) {
  await win.evaluate(async () => (await import('./lib/sidebar.js')).open());
  await win.locator('#chain-switcher-btn').click();
  await win.locator('.chain-switcher-item', { hasText: name }).first().click();
  await expect(win.locator('#chain-switcher-name')).toContainText(name);
}

test('the chain switcher\'s chainChanged goes from main to every page of its window but onchain apps; a replaced document drops it (0011 PRQ-6)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(180_000);
  await harness.setContentFixture(`${KEY_A}/`, page('dapp a'));
  await harness.setContentFixture(`${KEY_B}/framed`, page('framed b', `<iframe src="${FRAME}"></iframe>`));
  await harness.setContentFixture(FRAME, page('frame'));
  await harness.setContentFixture(ONCHAIN_URL, onchainFixture);
  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  await listen(electronApp, win);

  const a = await openHere(win, electronApp, `${KEY_A}/`);
  const b = await newTab(win, electronApp, `${KEY_B}/framed`);
  const onchain = await newTab(win, electronApp, ONCHAIN_URL, `web3://${ONCHAIN}`);
  const win2 = await secondWindow(win, electronApp);
  const elsewhere = await openHere(win2, electronApp, `${KEY_A}/`);
  await watchAll(electronApp);

  // The user picks Ethereum in window 1's switcher.
  await pickChain(win, 'Ethereum');
  await expect.poll(() => eventsOf(win, `${KEY_A}/`)).toEqual([['chainChanged', '0x1']]);
  await expect.poll(() => eventsOf(win, `${KEY_B}/framed`)).toEqual([['chainChanged', '0x1']]);
  // Main recorded the selection before it told them: the page's own
  // eth_chainId on the event answers the new chain.
  await expect.poll(() => inTab(win, `${KEY_A}/`, 'window.__chains')).toEqual([['0x1', '0x1']]);
  // Not the onchain app, which keeps its own chain, nor window 2's page.
  expect(await eventsOf(win, `web3://${ONCHAIN}`)).toEqual([]);
  expect(await ask(win, `web3://${ONCHAIN}`, 'eth_chainId')).toEqual({ ok: `0x${ONCHAIN_CHAIN.toString(16)}` });
  expect(await eventsOf(win2, `${KEY_A}/`)).toEqual([]);
  expect((await sentTo(electronApp, 'chainChanged')).sort()).toEqual([a, b].sort());
  // Only the two pages' main frames heard it, each with its nonce: no
  // sub-frame, the onchain app or window 2's page.
  const reports = await heard(electronApp);
  expect(reports.map((r) => [r.guest, r.top, r.event, r.data, r.nonce]).sort()).toEqual(
    [
      [a, true, 'chainChanged', '0x1', true],
      [b, true, 'chainChanged', '0x1', true],
    ].sort()
  );
  expect(reports.filter((r) => !r.top || r.guest === onchain || r.guest === elsewhere)).toEqual([]);

  // "All Chains" reads as Gnosis: the pages hear 0x64.
  await clearHeard(electronApp);
  await pickChain(win, 'All Chains');
  await expect.poll(() => eventsOf(win, `${KEY_A}/`)).toEqual([['chainChanged', '0x1'], ['chainChanged', '0x64']]);

  // PRQ-2's race: main checks page A's record, its send is held, page A
  // reloads in its process, and the send goes to the new document, whose
  // preload drops it.
  const oldNavigation = await liveNavigation(electronApp, a);
  await holdNextSendTo(electronApp, a);
  await pickChain(win, 'Ethereum');
  await expect.poll(() => electronApp.evaluate(() => typeof globalThis.__pe.release)).toBe('function');
  await reloadInPlace(electronApp, win, a, `${KEY_A}/`);
  await releaseSend(electronApp);
  await expect
    .poll(async () => (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.guest === a && e.navigation === oldNavigation).length)
    .toBe(3);
  await expect.poll(() => eventsOf(win, `${KEY_B}/framed`)).toEqual([
    ['chainChanged', '0x1'],
    ['chainChanged', '0x64'],
    ['chainChanged', '0x1'],
  ]);
  // The new document's preload got the old document's event and dropped it.
  await expect
    .poll(async () => (await heard(electronApp)).filter((r) => r.guest === a && r.top && r.data === '0x1').length)
    .toBe(1);
  expect(await eventsOf(win, `${KEY_A}/`)).toEqual([]);
  // It hears the next change.
  await pickChain(win, 'Gnosis');
  await expect.poll(() => eventsOf(win, `${KEY_A}/`)).toEqual([['chainChanged', '0x64']]);
  await win2.close();
});

test('accountsChanged goes from main to every live page of the key when its grant is revoked or its account changes; none once a name has moved (0011 PRQ-6)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(240_000);
  // Main resolves the bound name itself; the harness stands in for ENS.
  await electronApp.evaluate((_electron, args) => {
    globalThis.__names = { [args.name]: args.key };
    globalThis.__resolved = [];
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setResolveName(async (name) => {
      globalThis.__resolved.push(name);
      const decoded = globalThis.__names[name];
      return decoded ? { type: 'ok', protocol: 'ipns', decoded } : { type: 'not_found' };
    });
  }, { name: NAME, key: IPNS_KEY });
  await harness.setEnsFixture(NAME, {
    type: 'ok',
    name: NAME,
    protocol: 'ipns',
    decoded: IPNS_KEY,
    uri: `ipns://${IPNS_KEY}`,
    trust: { level: 'verified', queried: ['a.test', 'b.test'], agreed: ['a.test', 'b.test'] },
  });
  await harness.setContentFixture(NAMED_URL, page('named'));
  await harness.setContentFixture(`${KEY_A}/one`, page('a one'));
  await harness.setContentFixture(`${KEY_A}/two`, page('a two', `<iframe src="${FRAME}"></iframe>`));
  await harness.setContentFixture(`${KEY_A}/x`, page('a x'));
  await harness.setContentFixture(`${KEY_A}/secret`, page('a secret'));
  await harness.setContentFixture(`${KEY_B}/`, page('b'));
  await harness.setContentFixture(FRAME, page('frame'));

  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const wallets = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets;
  const first = wallets.find((w) => w.index === 0).address;
  const second = wallets.find((w) => w.index === SECOND.index).address;
  await grant(electronApp, KEY_A);
  await grant(electronApp, KEY_B);
  await grant(electronApp, NAME);
  await listen(electronApp, win);

  const one = await openHere(win, electronApp, `${KEY_A}/one`);
  const two = await newTab(win, electronApp, `${KEY_A}/two`);
  const other = await newTab(win, electronApp, `${KEY_B}/`);
  // A DNS name over IPNS, connected under its name: the chrome binds it.
  await win.locator('[data-test="new-tab-btn"]').click();
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(`ens://${NAME}`);
  await address.press('Enter');
  await ready(win, NAMED_URL);
  const named = await guestOf(win, NAMED_URL);
  await expect.poll(() => ask(win, NAMED_URL, 'eth_accounts')).toEqual({ ok: [first] });
  const win2 = await secondWindow(win, electronApp);
  const elsewhere = await openHere(win2, electronApp, `${KEY_A}/x`);
  const privateWin = await privateWindow(electronApp);
  const hidden = await openHere(privateWin, electronApp, `${KEY_A}/secret`);
  expect(await inTab(privateWin, `${KEY_A}/secret`, 'typeof window.ethereum')).toBe('undefined');
  await watchAll(electronApp);

  // The grant's account changes (as the agent's connect changes it): every
  // live page of the key, in both windows, hears the new account.
  await changeAccount(electronApp, KEY_A, SECOND.index);
  for (const [w, url] of [[win, `${KEY_A}/one`], [win, `${KEY_A}/two`], [win2, `${KEY_A}/x`]]) {
    await expect.poll(() => eventsOf(w, url)).toEqual([['accountsChanged', [second]]]);
  }

  // The chrome's disconnect revokes it: main tells every live page of the
  // key, and the chrome tells none.
  await disconnect(win, KEY_A);
  for (const [w, url] of [[win, `${KEY_A}/one`], [win, `${KEY_A}/two`], [win2, `${KEY_A}/x`]]) {
    await expect.poll(() => eventsOf(w, url)).toEqual([['accountsChanged', [second]], ['accountsChanged', []]]);
  }
  expect(await ask(win, `${KEY_A}/one`, 'eth_accounts')).toEqual({ ok: [] });
  // Not another key's page, nor the name's, nor the private window's page,
  // which never said hello.
  expect(await eventsOf(win, `${KEY_B}/`)).toEqual([]);
  expect(await eventsOf(win, NAMED_URL)).toEqual([]);
  expect((await sentTo(electronApp, 'accountsChanged')).sort()).toEqual([one, two, elsewhere, one, two, elsewhere].sort());
  expect(await liveNavigation(electronApp, hidden)).toBeNull();
  // Main frames only, each with its nonce: the iframe in page two heard
  // nothing.
  const reports = await heard(electronApp);
  expect(reports.filter((r) => !r.top || r.guest === other || r.guest === named || r.guest === hidden)).toEqual([]);
  expect(reports.every((r) => r.nonce && r.provider === 'ethereum' && r.event === 'accountsChanged')).toBe(true);
  expect(reports).toHaveLength(6);

  // The name's grant changes while the name answers its IPNS key: main
  // resolves it again, then tells the page.
  await electronApp.evaluate(() => (globalThis.__resolved = []));
  await changeAccount(electronApp, NAME, SECOND.index);
  await expect.poll(() => eventsOf(win, NAMED_URL)).toEqual([['accountsChanged', [second]]]);
  expect(await electronApp.evaluate(() => globalThis.__resolved.slice())).toEqual([NAME]);
  // The name moves to other content; its grant is then revoked: main
  // resolves the name, finds it moved, and sends nothing.
  await electronApp.evaluate((_electron, key) => {
    globalThis.__names['example.com'] = key;
    globalThis.__resolved = [];
  }, OTHER_IPNS_KEY);
  await disconnect(win, NAME);
  await expect
    .poll(async () => (await trace(electronApp)).filter((e) => e.kind === 'event-refused' && e.guest === named).map((e) => [e.event, e.reason]))
    .toEqual([['accountsChanged', 'name-moved']]);
  expect(await electronApp.evaluate(() => globalThis.__resolved.slice())).toEqual([NAME]);
  expect(await eventsOf(win, NAMED_URL)).toEqual([['accountsChanged', [second]]]);
  expect((await heard(electronApp)).filter((r) => r.guest === named)).toHaveLength(1);

  // PRQ-2's race: main checks page one's record, its send is held, page one
  // reloads in its process, and the send goes to the new document, whose
  // preload drops it.
  await grant(electronApp, KEY_A);
  const oldNavigation = await liveNavigation(electronApp, one);
  await holdNextSendTo(electronApp, one);
  await disconnect(win, KEY_A);
  await expect.poll(() => electronApp.evaluate(() => typeof globalThis.__pe.release)).toBe('function');
  await reloadInPlace(electronApp, win, one, `${KEY_A}/one`);
  await releaseSend(electronApp);
  await expect
    .poll(async () => (await trace(electronApp)).filter((e) => e.kind === 'event-sent' && e.guest === one && e.navigation === oldNavigation).length)
    .toBe(3);
  await expect.poll(() => eventsOf(win2, `${KEY_A}/x`)).toEqual([
    ['accountsChanged', [second]],
    ['accountsChanged', []],
    ['accountsChanged', []],
  ]);
  await expect.poll(async () => (await heard(electronApp)).filter((r) => r.guest === one).length).toBe(3);
  expect(await eventsOf(win, `${KEY_A}/one`)).toEqual([]);
  // The new document hears the next change.
  await grant(electronApp, KEY_A);
  await disconnect(win, KEY_A);
  await expect.poll(() => eventsOf(win, `${KEY_A}/one`)).toEqual([['accountsChanged', []]]);
  await win2.close();
  await privateWin.close();
});
