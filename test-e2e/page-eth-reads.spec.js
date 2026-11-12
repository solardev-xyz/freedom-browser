// window.ethereum's reads through main, in real Electron (freedom-core
// design 0011, step PRQ-3): `eth_chainId`, `net_version`, `eth_accounts`
// and the read-only RPC methods go from the app's preload to main on
// `page:request`, and main answers them with the chrome's answers: the
// chain the window's switcher selected, an onchain app's own chain, a
// keyless page's reads, a connected site's account. The chrome's old path
// (`dapp:provider-request`) stays for rollback, but no page uses it for
// these. A DNS name over IPNS keeps its account through main's name binding
// until the name moves off its IPNS key, and its reads go on answering with
// no resolution.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('./fixtures');
const { closeApp } = require('./close-app');
const { PROVENANCE_HEADER, encodeOnchainProvenance } = require('../src/main/onchain/onchain-app-protocol');

const repoRoot = path.resolve(__dirname, '..');
const identity = require(path.join(repoRoot, 'test', 'legacy-identity'));

const VAULT_PASSWORD = 'Freedom-E2E-Page-Reads-2026!';
const DAPP = `bzz://${'d'.repeat(64)}`;
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
// An onchain app on a chain the registry has no RPC provider for: its reads
// fail fast, with the chrome's text, and name the chain they went to.
const NO_RPC_CHAIN = 31337;
const ONCHAIN_URL = `web3://${ONCHAIN}.eip155-${NO_RPC_CHAIN}/`;
const KEYLESS = 'data:text/html,<!doctype html><title>keyless</title><h1>keyless</h1>';
const NAME = 'example.com';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NO_RPC = `Chain ${NO_RPC_CHAIN} requires an RPC provider. Please configure one in Settings.`;

const test = base.extend({
  // The base app plus a vault with one account, so a connected site has an
  // account to read.
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'f-eth-reads-'));
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

const page = (title) => ({
  contentType: 'text/html; charset=utf-8',
  body: `<!doctype html><title>${title}</title><script>
    window.__chains = [];
    window.ethereum.on('chainChanged', (chainId) => {
      window.ethereum.request({ method: 'eth_chainId' }).then((now) => window.__chains.push([chainId, now]));
    });
  </script><h1>${title}</h1>`,
});

/** The webview that shows `url` (a prefix of its URL), or null. */
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

/** A page's request, as the page sees its outcome. */
const ask = (win, url, method, params = []) =>
  inTab(
    win,
    url,
    `window.ethereum.request({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })
      .then((ok) => ({ ok }), (e) => ({ code: e?.code, message: String(e?.message || e) }))`
  );

/**
 * What the chrome's own path answers a read with, by its own code: its
 * proxyRpcCall over the same IPC it always used.
 */
const chromeRead = (win, chainId, method, params, origin) =>
  win.evaluate(
    async ({ chainId: id, method: m, params: p, origin: o }) => {
      const data = await window.wallet.requestChain(id, m, p, { origin: o });
      if (data?.success) return { ok: data.result };
      let message = data?.error?.message || `All chain sources failed for chain ${id}`;
      const availability = await window.networks.isChainAvailable(id);
      if (availability?.available === false) {
        const chains = await window.networks.getChains();
        const name = chains?.success ? chains.chains?.[id]?.name : null;
        message = `${name || `Chain ${id}`} requires an RPC provider. Please configure one in Settings.`;
      }
      return { code: data?.error?.code || -32603, message };
    },
    { chainId, method, params, origin }
  );

const trace = (electronApp) => electronApp.evaluate(() => globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.trace.slice());

// A connection, written in main as main writes one: the chrome's own grant
// write is refused from PRQ-4.
const grant = (electronApp, key) =>
  electronApp.evaluate((_electron, args) => {
    process.mainModule.require(`${args.root}/src/main/wallet/dapp-permissions`).grantPermission(args.key, 0, 100);
  }, { root: repoRoot, key });

/** Count every request a page sends the chrome on the old path, in every tab. */
const watchOldPath = (win) =>
  win.evaluate(() => {
    window.__oldPath = window.__oldPath || [];
    for (const wv of document.querySelectorAll('webview')) {
      if (wv.__watched) continue;
      wv.__watched = true;
      wv.addEventListener('ipc-message', (event) => {
        if (event.channel === 'dapp:provider-request') window.__oldPath.push(event.args[0]?.method);
      });
    }
  });
const oldPath = (win) => win.evaluate(() => window.__oldPath.slice());

async function openIn(win, url, ready = url) {
  const address = win.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(url);
  await address.press('Enter');
  await expect
    .poll(() => inTab(win, ready, 'Boolean(window.ethereum?.request) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
}

async function newTab(win, electronApp, url, ready = url) {
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
    .poll(() => inTab(win, ready, 'Boolean(window.ethereum?.request) && document.readyState === "complete"'), {
      timeout: 30_000,
      message: `waiting for ${url} to load`,
    })
    .toBe(true);
  return id;
}

test('the Ethereum reads go to main, with the chrome\'s answers: the selected chain, an onchain app\'s, a keyless page\'s (0011 PRQ-3)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(150_000);
  await harness.setContentFixture(`${DAPP}/`, page('dapp'));
  await harness.setContentFixture(ONCHAIN_URL, {
    ...page('onchain'),
    headers: {
      [PROVENANCE_HEADER]: encodeOnchainProvenance({
        version: 1,
        chainId: NO_RPC_CHAIN,
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
  });
  await electronApp.evaluate(() => {
    globalThis.__copies = [];
    globalThis.__FREEDOM_TEST_PAGE_REQUESTS__.setOnCopy((entry) => globalThis.__copies.push(entry));
  });

  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  await grant(electronApp, DAPP);

  // A connected dApp: Gnosis, the switcher's default, and its account.
  await openIn(win, `${DAPP}/`);
  await watchOldPath(win);
  expect(await ask(win, DAPP, 'eth_chainId')).toEqual({ ok: '0x64' });
  expect(await ask(win, DAPP, 'net_version')).toEqual({ ok: '100' });
  expect(await ask(win, DAPP, 'eth_accounts')).toEqual({ ok: [account] });

  // The user picks Ethereum in the wallet's chain switcher: main reads it
  // before the page hears chainChanged, so the page's own eth_chainId on
  // that event already answers the new chain.
  await win.evaluate(async () => {
    const sidebar = await import('./lib/sidebar.js');
    sidebar.open();
  });
  await win.locator('#chain-switcher-btn').click();
  await win.locator('.chain-switcher-item', { hasText: 'Ethereum' }).first().click();
  await expect.poll(() => inTab(win, DAPP, 'window.__chains')).toEqual([['0x1', '0x1']]);
  expect(await ask(win, DAPP, 'eth_chainId')).toEqual({ ok: '0x1' });
  expect(await ask(win, DAPP, 'net_version')).toEqual({ ok: '1' });

  // A chain the chrome's switcher sets (as the old path's
  // wallet_switchEthereumChain did) reaches main the same way.
  await win.evaluate(async (id) => {
    const switcher = await import('./lib/wallet/chain-switcher.js');
    switcher.setSelectedChainId(id);
  }, NO_RPC_CHAIN);
  expect(await ask(win, DAPP, 'eth_chainId')).toEqual({ ok: '0x7a69' });
  // A read goes to the core on that chain, with the chrome's error text.
  const read = await ask(win, DAPP, 'eth_blockNumber');
  expect(read).toEqual(await chromeRead(win, NO_RPC_CHAIN, 'eth_blockNumber', [], DAPP));
  expect(read).toEqual({ code: expect.any(Number), message: NO_RPC });
  // Its copy for the core was charged before it was made.
  expect(await electronApp.evaluate(() => globalThis.__copies.map(({ label, inPlace }) => ({ label, inPlace })))).toEqual([
    { label: 'ethereum:chain-request', inPlace: true },
  ]);
  // Binary params never reach the JSON.
  expect(await inTab(win, DAPP, `window.ethereum.request({ method: 'eth_call', params: [new Uint8Array(8)] })
    .then((ok) => ({ ok }), (e) => ({ code: e.code, message: e.message }))`)).toEqual({
    code: -32602,
    message: 'Invalid parameters',
  });

  // An onchain app keeps its own chain, whatever the window selected.
  await win.evaluate(async () => (await import('./lib/wallet/chain-switcher.js')).setSelectedChainId(1));
  const onchainId = await newTab(win, electronApp, ONCHAIN_URL, `web3://${ONCHAIN}`);
  await watchOldPath(win);
  expect(await ask(win, ONCHAIN_URL, 'eth_chainId')).toEqual({ ok: '0x7a69' });
  expect(await ask(win, ONCHAIN_URL, 'net_version')).toEqual({ ok: String(NO_RPC_CHAIN) });
  expect(await ask(win, ONCHAIN_URL, 'eth_accounts')).toEqual({ ok: [] });
  expect(await ask(win, ONCHAIN_URL, 'eth_getBalance', [account, 'latest'])).toEqual({
    code: expect.any(Number),
    message: NO_RPC,
  });

  // A keyless page gets its reads, on the window's chain, and no account.
  const keylessId = await newTab(win, electronApp, KEYLESS, 'data:');
  await watchOldPath(win);
  expect(await ask(win, 'data:', 'eth_chainId')).toEqual({ ok: '0x1' });
  expect(await ask(win, 'data:', 'net_version')).toEqual({ ok: '1' });
  expect(await ask(win, 'data:', 'eth_accounts')).toEqual({ ok: [] });

  // Main answered every one of them, for the guest that asked; the chrome's
  // old path saw none.
  const recorded = (await trace(electronApp)).filter((e) => e.kind === 'recorded' && e.provider === 'ethereum');
  const byGuest = (id) => recorded.filter((e) => e.guest === id).map((e) => e.method);
  expect(byGuest(await guestOf(win, DAPP))).toEqual(
    expect.arrayContaining(['eth_chainId', 'net_version', 'eth_accounts', 'eth_blockNumber', 'eth_call'])
  );
  expect(byGuest(onchainId)).toEqual(['eth_chainId', 'net_version', 'eth_accounts', 'eth_getBalance']);
  expect(byGuest(keylessId)).toEqual(['eth_chainId', 'net_version', 'eth_accounts']);
  expect(await oldPath(win)).toEqual([]);
  await win.screenshot({ path: test.info().outputPath('page-eth-reads.png') });
});

test('a DNS name over IPNS: eth_accounts answers until the name moves off its key, then []; its reads answer with no resolution (0011 PRQ-3)', async ({
  electronApp,
  window: win,
  harness,
}) => {
  test.setTimeout(120_000);
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
  // The chrome's own resolution, which loads the key.
  await harness.setEnsFixture(NAME, {
    type: 'ok',
    name: NAME,
    protocol: 'ipns',
    decoded: IPNS_KEY,
    uri: `ipns://${IPNS_KEY}`,
    trust: { level: 'verified', queried: ['a.test', 'b.test'], agreed: ['a.test', 'b.test'] },
  });
  await harness.setContentFixture(`ipns://${IPNS_KEY}/`, page('named'));

  expect(await win.evaluate((pw) => window.identity.unlock(pw), VAULT_PASSWORD)).toMatchObject({ success: true });
  const account = (await win.evaluate(() => window.wallet.getDerivedWallets())).wallets[0].address;
  // Connected under its name, as the chrome keys it.
  await grant(electronApp, NAME);

  await openIn(win, `ens://${NAME}`, `ipns://${IPNS_KEY}`);
  await watchOldPath(win);
  const guest = await guestOf(win, `ipns://${IPNS_KEY}`);
  expect((await trace(electronApp)).filter((e) => e.kind === 'bind-name' && e.guest === guest).map((e) => e.ok)).toContain(
    true
  );
  const url = `ipns://${IPNS_KEY}`;
  expect(await ask(win, url, 'eth_accounts')).toEqual({ ok: [account] });

  // The name moves to other content.
  await electronApp.evaluate((_electron, key) => {
    globalThis.__names['example.com'] = key;
    globalThis.__resolved = [];
  }, OTHER_IPNS_KEY);
  const resolved = () => electronApp.evaluate(() => globalThis.__resolved.slice());

  // The permission-free reads answer on, resolving nothing.
  await win.evaluate(async (id) => (await import('./lib/wallet/chain-switcher.js')).setSelectedChainId(id), NO_RPC_CHAIN);
  expect(await ask(win, url, 'eth_chainId')).toEqual({ ok: '0x7a69' });
  expect(await ask(win, url, 'net_version')).toEqual({ ok: String(NO_RPC_CHAIN) });
  expect(await ask(win, url, 'eth_blockNumber')).toEqual({ code: expect.any(Number), message: NO_RPC });
  expect(await resolved()).toEqual([]);

  // eth_accounts checks the name, finds it moved, and answers [].
  expect(await ask(win, url, 'eth_accounts')).toEqual({ ok: [] });
  expect(await resolved()).toEqual([NAME]);
  // The binding has ended: the page is keyless now, and resolves nothing.
  expect(await ask(win, url, 'eth_accounts')).toEqual({ ok: [] });
  expect(await ask(win, url, 'eth_chainId')).toEqual({ ok: '0x7a69' });
  expect(await resolved()).toEqual([NAME]);
  expect(await oldPath(win)).toEqual([]);
});
