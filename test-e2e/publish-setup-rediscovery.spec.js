// Publish setup while Ant is still looking for the storage its wallet owns
// (#510). Since Ant v0.5.58, `/health.chainReady` no longer waits for that
// scan, so `GET /stamps` can be empty for a wallet that owns storage; since
// v0.5.59 the node reports the scan as `/health.walletScan`. The setup screen
// must say it is looking (with its progress) instead of offering a plan.
//
// The harness runs no node: this runs the real publish setup service against
// a fake antd in the main process, whose `/health.walletScan` the test sets,
// and the real setup and storage screens in the chrome. Set PUBLISH_SHOTS_DIR
// to keep a screenshot of each state in both themes.

const path = require('path');
const { test, expect } = require('./fixtures');

const WALLET = '0x' + 'cd'.repeat(20);

async function startFakeAnt(electronApp) {
  return electronApp.evaluate(async (_e, wallet) => {
    const http = process.mainModule.require('http');
    const state = { stamps: [], walletScan: undefined };
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
          return send(200, { status: 'ok', chainReady: true, walletScan: state.walletScan });
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

// The real service against the fake antd. The storage screen's batch list
// comes from bee-js, which the fake antd does not serve in full, so that one
// channel answers from the fake's stamps directly.
async function wireRealService(electronApp) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    const load = process.mainModule.require;
    const { createPublishSetupService } = load('./src/main/swarm/publish-setup-service');
    const setup = createPublishSetupService({
      getNodeStatus: () => ({ status: 'running', error: null }),
      getRegistryMode: () => 'bundled',
      restartNode: async () => {},
      getTransactionStatus: async () => ({ status: 'pending' }),
      publish: (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('swarm:setup-state', state);
        }
      },
    });
    globalThis.__walletScan = { setup };
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
    replace('swarm:get-stamps', () => ({
      success: true,
      stamps: globalThis.__fakeAnt.state.stamps.map((batch) => ({
        batchId: batch.batchID,
        depth: batch.depth,
        usable: batch.usable,
        pending: false,
        isMutable: false,
        sizeBytes: 4 * 1024 ** 3,
        remainingBytes: 4 * 1024 ** 3,
        usagePercent: 0,
        ttlSeconds: 30 * 86400,
        expiresApprox: null,
      })),
    }));
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ant:statusUpdate', { status: 'running' });
    }
  });
}

// What the fake antd's `/health.walletScan` says (and its stamps), then a
// fresh read, as the watch cadence would make.
const SCAN = { from: 16_514_506, head: 48_560_000 };
async function setScan(electronApp, scan, stamps) {
  await electronApp.evaluate(
    async (_e, { scan: next, stamps: list }) => {
      globalThis.__fakeAnt.state.walletScan = next;
      if (list) globalThis.__fakeAnt.state.stamps = list;
      await globalThis.__walletScan.setup.refresh();
    },
    { scan, stamps }
  );
}
const BATCH = { batchID: 'aa'.repeat(32), usable: true, utilization: 0, depth: 20 };

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

async function openStorage(window) {
  await window.evaluate(async () => {
    const { openStampManager } = await import('./lib/wallet/stamp-manager.js');
    await openStampManager();
  });
  await expect(window.locator('#sidebar-stamp-manager')).toBeVisible();
}

test.describe("Publish setup while Ant looks for the wallet's storage (#510)", () => {
  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__walletScan?.setup.dispose();
      globalThis.__fakeAnt?.server.close();
    });
  });

  test('shows the search and its progress, then the storage the wallet already owns', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await setScan(electronApp, { state: 'scanning', ...SCAN, scannedThrough: 41_230_000 });
    await openSetup(window);

    await expect(nodeText(window)).toHaveText('Looking for your existing storage… 77%');
    await expect(planList(window)).toBeHidden();
    await expect(window.locator('#publish-setup-node-action')).toBeHidden();
    await shoot(window, 'looking');

    // The scan finds a batch this wallet bought before; `done` comes once it
    // is registered, so /stamps lists it.
    await setScan(electronApp, { state: 'done', ...SCAN, scannedThrough: 48_559_000 }, [BATCH]);
    await expect(window.locator('#publish-setup-ready')).toBeVisible();
    await expect(window.locator('#publish-setup-ready-text')).toHaveText(
      'Ready to publish. 1 storage batch available.'
    );
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'found');
  });

  test('a finished scan that found nothing offers the plans', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await setScan(electronApp, { state: 'pending', from: null, scannedThrough: null, head: null });
    await openSetup(window);
    await expect(nodeText(window)).toHaveText('Looking for your existing storage…');

    await setScan(electronApp, { state: 'done', ...SCAN, scannedThrough: 48_559_000 });
    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
  });

  test('a retrying scan says Ant is trying again, without the plans or a restart', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await setScan(electronApp, {
      state: 'retrying',
      ...SCAN,
      scannedThrough: 30_000_000,
      error: 'http: error sending request for url (<url>)',
    });
    await openSetup(window);

    await expect(nodeText(window)).toHaveText(
      "The Swarm node couldn't finish looking for your existing storage and is trying again. Wait for it before you buy more."
    );
    await expect(window.locator('#publish-setup-node-action')).toBeHidden();
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'retrying');
  });

  test('the node card opens setup while Ant looks', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await setScan(electronApp, { state: 'scanning', ...SCAN, scannedThrough: 20_000_000 });
    await openNodesTab(window);

    // Not a disabled "Checking Node Status…": the search can take a while.
    const button = window.locator('#swarm-setup-btn');
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Looking for your existing storage…'
    );
    await expect(button).toBeEnabled();
    await shoot(window, 'card-looking');

    await setScan(electronApp, { state: 'retrying', ...SCAN, scannedThrough: 20_000_000 });
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Retrying the search for your existing storage'
    );
    await expect(button).toBeEnabled();
    await button.click();
    await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
    await expect(nodeText(window)).toHaveText(/trying again/);
  });

  test('the storage screen says Ant is still looking, then still confirming', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await setScan(electronApp, { state: 'scanning', ...SCAN, scannedThrough: 41_230_000 });
    await openNodesTab(window);
    await openStorage(window);

    const status = window.locator('#stamp-scan-status');
    // Not "You have no storage yet": the list may still grow.
    await expect(status).toHaveText('Looking for your existing storage… 77%');
    await expect(window.locator('#stamp-list-empty')).toBeHidden();
    await shoot(window, 'storage-looking');

    // Found from Ant's unverified source: usable, confirmation still running.
    await setScan(electronApp, { state: 'confirming', ...SCAN, scannedThrough: 48_559_000 }, [
      BATCH,
    ]);
    await expect(status).toHaveText('Still confirming your storage history in the background.');
    await expect(window.locator('#stamp-batch-list .stamp-batch-card')).toHaveCount(1);
    await shoot(window, 'storage-confirming');

    await setScan(electronApp, { state: 'done', ...SCAN, scannedThrough: 48_559_000 });
    await expect(status).toBeHidden();
  });

  test('a node that reports no scan gets the plans at once', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await openSetup(window);

    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
  });
});
