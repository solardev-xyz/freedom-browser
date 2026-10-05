// Publish setup while the bundled Ant is still rediscovering the batches its
// wallet owns (#510). Since Ant v0.5.58, `/health.chainReady` no longer waits
// for that scan, so `GET /stamps` can be empty for a wallet that owns storage.
// The setup screen must say it is still checking instead of offering a plan.
//
// The harness runs no node: this runs the real publish setup service and the
// real rediscovery tracker (fed antd's log lines by hand, as ant-manager does
// from the node's output) against a fake antd in the main process, and the
// real setup screen in the chrome. Set PUBLISH_SHOTS_DIR to keep a screenshot
// of each state in both themes.

const path = require('path');
const { test, expect } = require('./fixtures');

const WALLET = '0x' + 'cd'.repeat(20);

async function startFakeAnt(electronApp) {
  return electronApp.evaluate(async (_e, wallet) => {
    const http = process.mainModule.require('http');
    const state = { stamps: [] };
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
          return send(200, { status: 'ok', chainReady: true });
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

// The real service, wired to a real rediscovery tracker the test drives.
// `txCount` is the node wallet's transaction count on Gnosis Chain.
async function wireRealService(electronApp, { txCount }) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }, count) => {
    const load = process.mainModule.require;
    const { createPublishSetupService } = load('./src/main/swarm/publish-setup-service');
    const { createRediscoveryTracker } = load('./src/main/swarm/ant-rediscovery');
    const tracker = createRediscoveryTracker();
    const run = tracker.begin();
    const setup = createPublishSetupService({
      getNodeStatus: () => ({ status: 'running', error: null }),
      getRegistryMode: () => 'bundled',
      restartNode: async () => {},
      getTransactionStatus: async () => ({ status: 'pending' }),
      getRediscovery: tracker.get,
      getWalletTxCount: async () => count,
      publish: (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('swarm:setup-state', state);
        }
      },
    });
    tracker.onChange(() => setup.handleRediscovery());
    globalThis.__rediscovery = { tracker, run, setup };
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

// antd's log line, as ant-manager hands it to the tracker.
const logLine = (electronApp, line) =>
  electronApp.evaluate((_e, text) => {
    const { tracker, run } = globalThis.__rediscovery;
    tracker.noteLine(run, text);
  }, line);

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

test.describe('Publish setup during Ant batch rediscovery (#510)', () => {
  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__rediscovery?.setup.dispose();
      globalThis.__fakeAnt?.server.close();
    });
  });

  test('a wallet with history keeps checking, then shows the storage it already owns', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp, { txCount: 7 });
    await openSetup(window);

    await expect(nodeText(window)).toHaveText(
      'Checking Gnosis Chain for storage this wallet already owns…'
    );
    await expect(planList(window)).toBeHidden();
    await expect(window.locator('#publish-setup-node-action')).toBeHidden();
    await shoot(window, 'checking');

    // The scan finds a batch this wallet bought before, then logs it is done.
    await electronApp.evaluate(() => {
      globalThis.__fakeAnt.state.stamps = [
        { batchID: 'aa'.repeat(32), usable: true, utilization: 0, depth: 20 },
      ];
    });
    await logLine(
      electronApp,
      '2026-10-05T10:00:00Z  INFO antd: background batch rediscovery finished; /stamps lists every batch found rediscovered=1 batches=1'
    );
    await expect(window.locator('#publish-setup-ready')).toBeVisible();
    await expect(window.locator('#publish-setup-ready-text')).toHaveText(
      'Ready to publish. 1 storage batch available.'
    );
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'found');
  });

  test('a finished scan that found nothing offers the plans', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp, { txCount: 7 });
    await openSetup(window);
    await expect(nodeText(window)).toHaveText(/Checking Gnosis Chain/);

    await logLine(electronApp, 'INFO antd: background batch rediscovery finished');
    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
  });

  test('a failed scan offers a restart instead of the plans', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp, { txCount: 7 });
    await openSetup(window);

    await logLine(
      electronApp,
      'WARN antd: postage batch rediscovery scan failed: rpc timeout; continuing without it'
    );
    await logLine(electronApp, 'INFO antd: background batch rediscovery finished');
    await expect(nodeText(window)).toHaveText(/Restart the node to check again/);
    await expect(window.locator('#publish-setup-node-action')).toHaveText('Restart Node');
    await expect(planList(window)).toBeHidden();
    await shoot(window, 'failed');
  });

  test('the node card opens setup while checking, so a failed scan can be restarted', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp, { txCount: 7 });
    await openNodesTab(window);

    // Not a disabled "Checking Node Status…": the check can take minutes.
    const button = window.locator('#swarm-setup-btn');
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Checking for storage this wallet already owns…'
    );
    await expect(button).toBeEnabled();

    await logLine(
      electronApp,
      'WARN antd: postage batch rediscovery scan failed: rpc timeout; continuing without it'
    );
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Restart the node before buying storage'
    );
    await expect(button).toBeEnabled();
    await shoot(window, 'card-failed');
    await button.click();
    await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
    await expect(nodeText(window)).toHaveText(/Restart the node to check again/);
    await expect(window.locator('#publish-setup-node-action')).toHaveText('Restart Node');
  });

  test('a wallet that never sent a transaction gets the plans at once', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp, { txCount: 0 });
    await openSetup(window);

    await expect(planList(window)).toBeVisible();
    await expect(window.locator('#publish-plan-list .stamp-preset-btn')).toHaveCount(3);
    await shoot(window, 'new-wallet');
  });
});
