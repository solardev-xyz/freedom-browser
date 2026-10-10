const path = require('path');
const { test, expect } = require('./fixtures');
const root = path.resolve(__dirname, '..');

// Real Electron wallet IPC, balance service, router, SOCKS and TLS. Only the
// managed endpoint/registry are fixtures; there is no live Tor or public RPC.
test('experimental balance IPC isolates accounts and handles outage, restart and vault locks', async ({
  electronApp,
  window,
}) => {
  test.setTimeout(90000);
  const environment = await electronApp.evaluate(async ({ app }, root) => {
    const createRequire = process.mainModule.require('module').createRequire;
    const req = createRequire(`${app.getAppPath()}/package.json`);
    const fixtures = createRequire(`${root}/package.json`);
    const { listen, proxy } = fixtures('./test/helpers/tor-socks-fixture');
    const cert = fixtures('./test/helpers/tor-tls-fixture');
    const { Interface } = req('ethers');
    const abi = new Interface([
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ]);
    const seen = [];
    const server = req('https').createServer(cert, (request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const data = JSON.parse(body);
        seen.push(data);
        const result =
          data.method === 'eth_chainId'
            ? '0xaa36a7'
            : data.method === 'eth_getBalance'
              ? '0x1'
              : data.params[0].data === '0x313ce567'
                ? abi.encodeFunctionResult('decimals', [18])
                : abi.encodeFunctionResult('balanceOf', [2]);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: data.id, result }));
      });
    });
    const port = await listen(server);
    let socks = await proxy(port);
    const tor = req('./src/main/tor-manager');
    tor.getWalletSocksEndpoint = () => socks?.endpoint || null;
    const factory = req('./src/main/networks/wallet-tor-transport');
    const original = factory.createWalletTorTransport;
    factory.createWalletTorTransport = () => original({ ca: cert.cert });
    const registry = req('./src/main/networks/network-registry');
    registry.getNetwork = () => ({ access: { readOrder: ['myotis', 'quorum', 'direct'] } });
    registry.getEndpoints = () => ['https://rpc.example.test'];
    registry.getEndpointSources = () => [
      { keyed: false, coverage: { 11155111: 'https://rpc.example.test' } },
    ];
    const tokens = req('./src/main/token-registry');
    // The private coordinator is loaded lazily after this registry fixture.
    tokens.getTokens = () => ({
      '11155111:native': { chainId: 11155111, address: null, symbol: 'ETH', decimals: 18 },
      '11155111:token': {
        chainId: 11155111,
        address: `0x${'c'.repeat(40)}`,
        symbol: 'TEST',
        decimals: 18,
      },
    });
    const vault = req('./src/main/identity/vault');
    const vaultDir = req('path').join(app.getPath('userData'), 'private-balance-fixture');
    await vault.importVault(
      vaultDir,
      'fixture-password',
      'test test test test test test test test test test test junk'
    );
    await vault.unlockVault(vaultDir, 'fixture-password', 0);
    process.env.FREEDOM_WALLET_TOR_EXPERIMENT = '1';
    const settings = req('./src/main/settings-store');
    const gateBeforeTestOverride = settings.isWalletTorExperimentAvailable();
    // Only this fixture overrides the module export in memory so packaged
    // execution can be exercised while the shipped product gate stays closed.
    if (app.isPackaged) settings.isWalletTorExperimentAvailable = () => true;
    settings.saveSettings({ walletTorBalanceReads: true });
    let directFetchCalls = 0;
    const fetch = globalThis.fetch;
    globalThis.fetch = () => {
      directFetchCalls++;
      throw new Error('Direct fetch refused by fixture');
    };
    const dns = req('dns');
    const lookup = dns.lookup;
    const destinationLookups = [];
    dns.lookup = function (hostname, ...args) {
      if (!['127.0.0.1', '::1'].includes(hostname)) {
        destinationLookups.push(hostname);
        throw new Error('Destination lookup refused by fixture');
      }
      return lookup.call(this, hostname, ...args);
    };
    globalThis.balanceFixture = {
      seen,
      records: () => socks.records,
      egress: () => ({ directFetchCalls, destinationLookups }),
      async outage() {
        await socks.close();
        socks = null;
      },
      async restart() {
        socks = await proxy(port);
      },
      lock() {
        vault.lockVault();
      },
      unlock(ms = 0) {
        return vault.unlockVault(vaultDir, 'fixture-password', ms);
      },
      async close() {
        globalThis.fetch = fetch;
        dns.lookup = lookup;
        vault.lockVault();
        if (socks) await socks.close();
        await new Promise((resolve) => server.close(resolve));
      },
    };
    return { packaged: app.isPackaged, appPath: app.getAppPath(), gateBeforeTestOverride };
  }, root);
  if (environment.packaged) {
    expect(environment.appPath).toContain('app.asar');
    expect(environment.gateBeforeTestOverride).toBe(false);
  }
  const a = `0x${'a'.repeat(40)}`,
    b = `0x${'b'.repeat(40)}`;
  const read = (address) => window.evaluate((value) => window.wallet.getBalances(value), address);
  try {
    const first = await read(a);
    expect(first.balances.status).toBe('fresh');
    expect(first.balances['11155111:token'].raw).toBe('2');
    await read(b);
    const isolation = await electronApp.evaluate(() => ({
      tokens: new Set(globalThis.balanceFixture.records().map((r) => r.token)).size,
      hosts: globalThis.balanceFixture.records().map((r) => r.hostname),
    }));
    expect(isolation.tokens).toBe(2);
    expect(isolation.hosts.every((host) => host === 'rpc.example.test')).toBe(true);
    await electronApp.evaluate(() => globalThis.balanceFixture.outage());
    const failed = await read(a);
    expect(failed.balances).toMatchObject({
      status: 'stale',
      lastUpdated: first.balances.lastUpdated,
    });
    await electronApp.evaluate(() => globalThis.balanceFixture.restart());
    expect((await read(a)).balances.status).toBe('fresh');
    await electronApp.evaluate(() => globalThis.balanceFixture.lock());
    expect((await read(a)).balances.status).toBe('unavailable');
    await electronApp.evaluate(() => globalThis.balanceFixture.unlock(20));
    await expect.poll(async () => (await read(a)).balances.status).toBe('unavailable');
    expect(await electronApp.evaluate(() => globalThis.balanceFixture.egress())).toEqual({
      directFetchCalls: 0,
      destinationLookups: [],
    });
  } finally {
    await electronApp.evaluate(() => globalThis.balanceFixture.close());
  }
});

test('qualification gate and advanced setting render in both themes', async ({
  window,
  electronApp,
}, testInfo) => {
  await window.locator('[data-test="address-input"]').fill('freedom://settings/experimental');
  await window.locator('[data-test="address-input"]').press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp
        .windows()
        .find((candidate) => candidate.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);
  await expect(page.locator('#wallet-tor-help')).toContainText('previously enabled experiment');
  // Disable transitions before the theme changes; fast-forwarding only during
  // capture can leave custom-property-driven backgrounds between palettes.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  for (const theme of ['dark', 'light']) {
    await window.evaluate((theme) => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#wallet-tor-help')).toBeVisible();
    await expect(page.locator('#wallet-tor-balance-reads')).toBeDisabled();
    await expect(page.locator('#wallet-tor-help')).toContainText('qualification');
    await expect(page.locator('#swarm-publishing-row')).toBeHidden();
    await expect(page.locator('#swarm-mode-row')).toHaveCount(0);
    await page.locator('#wallet-tor-help').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`wallet-privacy-${theme}.png`),
      animations: 'disabled',
    });
    // Main moved publishing from Advanced to Nodes; keep checking its real location.
    await page.locator('.nav-item[data-target="nodes"]').click();
    await expect(page.locator('#swarm-publishing-row')).toBeVisible();
    await page.locator('.nav-item[data-target="advanced"]').click();
  }
});
