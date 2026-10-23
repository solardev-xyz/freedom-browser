// A fake antd and the real publish setup service wired against it, shared by
// the publish setup specs. The harness runs no node: `startFakeAnt` serves the
// antd routes the setup service reads from an HTTP server inside the main
// process (`globalThis.__fakeAnt.state` is what it answers), and
// `wireRealService` replaces the harness's setup IPC handlers with the real
// service (`globalThis.__publishSetup`) probing it. Dispose both in the
// spec's afterEach (`__publishSetup.dispose()`, `__fakeAnt.server.close()`).

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

module.exports = { WALLET, startFakeAnt, wireRealService };
