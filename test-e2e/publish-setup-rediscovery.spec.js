// Publish setup while Ant is still rediscovering the batches its wallet owns
// (#510, #484). Since Ant v0.5.58, `/health.chainReady` no longer waits for
// that scan, so `GET /stamps` can be empty for a wallet that owns storage.
// Since v0.5.59 antd reports the scan in `/health.walletScan`; the setup
// screen must say it is still looking, with the progress Ant reports,
// instead of offering a plan.
//
// The harness runs no node: this runs the real publish setup service against
// a fake antd in the main process (whose `/health` the test sets, with the
// bodies a live antd v0.5.59 served), and the real setup screen in the
// chrome. Set PUBLISH_SHOTS_DIR to keep a screenshot of each state in both
// themes.

const path = require('path');
const { test, expect } = require('./fixtures');

const WALLET = '0x' + 'cd'.repeat(20);

async function startFakeAnt(electronApp) {
  return electronApp.evaluate(async (_e, wallet) => {
    const http = process.mainModule.require('http');
    const state = { stamps: [], health: { status: 'ok', chainReady: true } };
    const quote = (depth, days) => ({
      depth,
      days,
      amountPerChunk: '65676000',
      planCostPlur: '68866000000000',
      settlementDepositPlur: '0',
      walletAddress: wallet,
      walletBzzPlur: '0',
      walletXdaiWei: '0',
      bzzToAcquirePlur: '68866000000000',
      swapInputWei: '432000000000000000',
      gasReserveWei: '15000000000000000',
      xdaiRequiredWei: '447000000000000000',
      xdaiToSendWei: '447000000000000000',
      sufficientFunds: false,
    });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      switch (`${req.method} ${url.pathname}`) {
        case 'GET /health':
          return send(200, state.health);
        case 'GET /node':
          return send(200, { beeMode: 'light' });
        case 'GET /readiness':
          return send(200, { status: 'ready' });
        case 'GET /stamps':
          return send(200, { stamps: state.stamps });
        case 'GET /addresses':
          return send(200, { ethereum: wallet });
        case 'GET /v0/storage/quote':
          return send(
            200,
            quote(Number(url.searchParams.get('depth')), Number(url.searchParams.get('days')))
          );
        case 'GET /v0/settlement/deposit':
          // An Ant with the storage routes; no chequebook yet.
          return send(200, {
            chequebook: '0x' + '00'.repeat(20),
            walletAddress: wallet,
            walletBzzPlur: '0',
            walletXdaiWei: '0',
            depositPlur: '0',
            needsTopUp: false,
          });
        default:
          return send(404, { code: 404, message: 'Not Found' });
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAnt = { server, state };
    const url = `http://127.0.0.1:${server.address().port}`;
    process.mainModule.require('./src/main/service-registry').updateService('ant', { api: url });
    return url;
  }, WALLET);
}

// The real service. `txCount` is the node wallet's transaction count on
// Gnosis Chain, which only the fallback (no `walletScan`) reads.
async function wireRealService(electronApp, { txCount = 7 } = {}) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }, count) => {
    const load = process.mainModule.require;
    const { createPublishSetupService } = load('./src/main/swarm/publish-setup-service');
    const setup = createPublishSetupService({
      getNodeStatus: () => ({ status: 'running', error: null }),
      getRegistryMode: () => 'bundled',
      restartNode: async () => {},
      getTransactionStatus: async () => ({ status: 'pending' }),
      getWalletTxCount: async () => count,
      // advanceClock() moves this, for the stalled-scan bound.
      now: () => Date.now() + (globalThis.__clockOffset || 0),
      publish: (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('swarm:setup-state', state);
        }
      },
    });
    globalThis.__publishSetup = setup;
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('swarm:setup-get-state', async () => {
      await setup.ensureFresh(0);
      return setup.getState();
    });
    replace('swarm:setup-watch', (_e, surface, on) => {
      setup.watch(`fake:${surface}`, on === true);
      return setup.getState();
    });
    replace('swarm:setup-get-plans', () => setup.getPlans());
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ant:statusUpdate', { status: 'running' });
    }
  }, txCount);
}

// What the fake antd's `/health` (and, optionally, `/stamps`) now answers.
// Re-probes at once rather than waiting for the watch's next tick.
async function setNode(electronApp, { walletScan, version = 'antd/0.5.59', stamps } = {}) {
  await electronApp.evaluate(
    async (_e, next) => {
      const { state } = globalThis.__fakeAnt;
      state.health = {
        status: 'ok',
        version: next.version,
        apiVersion: '7.2.0',
        chainReady: true,
        ...(next.walletScan ? { walletScan: next.walletScan } : {}),
      };
      if (next.stamps) state.stamps = next.stamps;
      await globalThis.__publishSetup?.refresh();
    },
    { walletScan, version, stamps }
  );
}

async function advanceClock(electronApp, ms) {
  await electronApp.evaluate(async (_e, by) => {
    globalThis.__clockOffset = (globalThis.__clockOffset || 0) + by;
    await globalThis.__publishSetup?.refresh();
  }, ms);
}

const FROM = 16514506;
const HEAD = 48603825;
const scanning = (scannedThrough) => ({
  state: 'scanning',
  from: FROM,
  scannedThrough,
  head: HEAD,
});

async function openSetup(window) {
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const sidebar = await import('./lib/sidebar.js');
        sidebar.open();
        return sidebar.isVisible();
      })
    )
    .toBe(true);
  await window.evaluate(async () => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.identityView = document.getElementById('sidebar-identity');
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    const { openPublishSetup } = await import('./lib/wallet/publish-setup.js');
    await openPublishSetup();
  });
  await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
}

// The Nodes tab's Swarm card, whose publishing button is the usual way in.
async function openNodesTab(window) {
  await expect
    .poll(() =>
      window.evaluate(async () => {
        const sidebar = await import('./lib/sidebar.js');
        sidebar.open();
        return sidebar.isVisible();
      })
    )
    .toBe(true);
  await window.evaluate(async () => {
    const { walletState } = await import('./lib/wallet/wallet-state.js');
    walletState.viewMode = 'identity';
    walletState.identityView = document.getElementById('sidebar-identity');
    // The harness profile has no identity, so the setup CTA is up; the real
    // app shows the identity view here.
    document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
    document.getElementById('sidebar-identity')?.classList.remove('hidden');
    document.querySelector('.sidebar-tabs')?.classList.remove('hidden');
  });
  await window.click('.sidebar-tab[data-tab="nodes"]');
  await expect(window.locator('#node-card-swarm')).toBeVisible();
}

async function shoot(window, label) {
  const dir = process.env.PUBLISH_SHOTS_DIR;
  if (!dir) return;
  for (const theme of ['dark', 'light']) {
    await window.evaluate((t) => {
      if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
    }, theme);
    await window.locator('#sidebar').screenshot({ path: path.join(dir, `${theme}-${label}.png`) });
  }
  await window.evaluate(() => document.documentElement.removeAttribute('data-theme'));
}

const nodeText = (window) => window.locator('#publish-setup-node-text');
const planList = (window) => window.locator('#publish-setup-plans');

test.describe('Publish setup during Ant batch rediscovery (#510, #484)', () => {
  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__publishSetup?.dispose();
      globalThis.__fakeAnt?.server.close();
      globalThis.__clockOffset = 0;
    });
  });

  test('looks for existing storage with the progress Ant reports, then shows what it found', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, {
      walletScan: { state: 'pending', from: null, scannedThrough: null, head: null },
    });
    await wireRealService(electronApp);
    await openSetup(window);

    await expect(nodeText(window)).toHaveText(
      'Looking for your existing storage… Storage plans appear if this wallet has none.'
    );
    await expect(planList(window)).toBeHidden();

    await setNode(electronApp, { walletScan: scanning(32_000_000) });
    await expect(nodeText(window)).toHaveText(
      'Looking for your existing storage… 48% checked. Storage plans appear if this wallet has none.'
    );
    await expect(planList(window)).toBeHidden();
    await expect(window.locator('#publish-setup-node-action')).toBeHidden();
    await shoot(window, 'scanning');

    await setNode(electronApp, { walletScan: scanning(44_000_000) });
    await expect(nodeText(window)).toHaveText(/^Looking for your existing storage… 85% checked\./);

    // Done: the batch it found is registered, so /stamps lists it.
    await setNode(electronApp, {
      walletScan: { state: 'done', from: FROM, scannedThrough: HEAD - 1024, head: HEAD },
      stamps: [{ batchID: 'aa'.repeat(32), usable: true, utilization: 0, depth: 20 }],
    });
    await expect(window.locator('#publish-setup-ready')).toBeVisible();
    await expect(window.locator('#publish-setup-ready-text')).toHaveText(
      'Ready to publish. 1 storage batch available.'
    );
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'found');
  });

  test('a finished scan that found nothing offers the plans', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, { walletScan: scanning(20_000_000) });
    await wireRealService(electronApp);
    await openSetup(window);
    await expect(nodeText(window)).toHaveText(/Looking for your existing storage…/);

    await setNode(electronApp, {
      walletScan: { state: 'confirming', from: FROM, scannedThrough: HEAD, head: HEAD },
    });
    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
  });

  test('a scan Ant is retrying stays held, without a restart that would start it over', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, {
      walletScan: {
        state: 'retrying',
        from: FROM,
        scannedThrough: 24_000_000,
        head: HEAD,
        error: 'http: error sending request for url (<url>)',
      },
    });
    await wireRealService(electronApp);
    await openSetup(window);

    await expect(nodeText(window)).toHaveText(
      /^Looking for your existing storage… 23% checked\. Gnosis Chain did not answer, so the Swarm node is trying again\./
    );
    await expect(window.locator('#publish-setup-node-action')).toBeHidden();
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'retrying');
  });

  test('a scan that keeps failing without reading a block shows the plans after 30 minutes, with a warning', async ({
    electronApp,
    window,
  }) => {
    const retrying = {
      state: 'retrying',
      from: FROM,
      scannedThrough: 24_000_000,
      head: HEAD,
      error: 'RPC quorum needs 2 endpoints',
    };
    await startFakeAnt(electronApp);
    await setNode(electronApp, { walletScan: retrying });
    await wireRealService(electronApp);
    await openSetup(window);
    await expect(nodeText(window)).toHaveText(/trying again/);
    await expect(planList(window)).toBeHidden();

    await advanceClock(electronApp, 29 * 60_000);
    await expect(nodeText(window)).toHaveText(/trying again/);
    await expect(planList(window)).toBeHidden();

    await advanceClock(electronApp, 2 * 60_000);
    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-setup-plans-warning-text')).toHaveText(
      /^The Swarm node could not finish looking for storage this wallet already owns/
    );
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
    await shoot(window, 'retrying-stalled');
  });

  test('the node card shows the progress and opens setup', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, { walletScan: scanning(32_000_000) });
    await wireRealService(electronApp);
    await openNodesTab(window);

    // Not a disabled "Checking Node Status…": the search can take minutes.
    const button = window.locator('#swarm-setup-btn');
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Looking for your existing storage… 48%'
    );
    await expect(button).toBeEnabled();
    await shoot(window, 'card-scanning');
    await button.click();
    await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
    await expect(nodeText(window)).toHaveText(/48% checked/);
  });

  test('an Ant that does not report its scan (v0.5.58) falls back to a bounded hold', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, { version: 'antd/0.5.58' });
    await wireRealService(electronApp, { txCount: 7 });
    await openSetup(window);

    await expect(nodeText(window)).toHaveText('Looking for your existing storage…');
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'fallback');
  });

  test('a wallet that never sent a transaction gets the plans without waiting for the scan', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await setNode(electronApp, { walletScan: scanning(17_000_000) });
    await wireRealService(electronApp, { txCount: 0 });
    await openSetup(window);

    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
    await shoot(window, 'new-wallet');
  });
});
