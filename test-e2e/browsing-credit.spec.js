// The wallet sidebar's Nodes tab shows the Swarm node's chequebook as
// browsing credit (#488): what is left, the recent spend, whether the node
// pays peers, a top-up of any amount, and bee's `swap-enable` switch.
//
// The pinned Ant (v0.5.56) predates freedom-hq/ant#126 and the harness runs
// no node at all. The first group replaces the browsing credit and publish
// setup IPC and feeds each node state to the real renderer. The second runs
// the real main-process services against a fake antd serving #126's routes
// (`GET /node`'s `settlement`, `PUT /v0/settlement/swap`,
// `POST /v0/settlement/deposit?amount=`). Set CREDIT_SHOTS_DIR to keep a
// screenshot of every state in both themes.

const path = require('path');
const { test, expect } = require('./fixtures');

const CHEQUEBOOK = '0x' + 'ab'.repeat(20);
const XBZZ = 10n ** 16n;
const plur = (micro) => ((BigInt(micro) * XBZZ) / 1_000_000n).toString();

function credit(overrides = {}) {
  return {
    node: 'running',
    support: 'supported',
    swapEnable: true,
    // An Ant with freedom-hq/ant#126: `/node` says it pays, deposits take an amount.
    paying: true,
    depositAmount: true,
    toggle: { inProgress: false, error: null },
    // The node's own deposit target is 0.001 xBZZ; 0.0002 of it written to
    // peers in cheques they have not cashed yet.
    chequebook: {
      address: CHEQUEBOOK,
      total: '0.001',
      available: '0.0008',
      totalPlur: plur(1000),
      availablePlur: plur(800),
      availableExact: true,
    },
    spend: { day: '0.00012', week: '0.0002', dayPlur: plur(120), weekPlur: plur(200), since: 1 },
    ...overrides,
  };
}

const balance = (micro, total) => ({
  address: CHEQUEBOOK,
  total: String(total / 1e6),
  available: String(micro / 1e6),
  totalPlur: plur(total),
  availablePlur: plur(micro),
  availableExact: true,
});

function setupState({ needsTopUp = false, deposit = '0.001' } = {}) {
  return {
    node: { status: 'running', error: null, registryMode: 'bundled' },
    readiness: { ok: true, key: 'ready', reason: null, message: '' },
    chainReady: true,
    nodeMode: 'light',
    stamps: { known: true, usable: 1, pending: 0, total: 1 },
    account: {
      storage: 'available',
      walletAddress: '0x' + 'cd'.repeat(20),
      xdai: '0.42',
      xdaiWei: '420000000000000000',
      bzz: '0',
      chequebook: {
        address: CHEQUEBOOK,
        deposit,
        target: '0.001',
        needsTopUp,
        managed: true,
      },
    },
    canBuy: true,
    canRestart: true,
    operation: null,
    restart: { inProgress: false, error: null },
    plans: [],
  };
}

async function stubMain(electronApp) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    globalThis.__credit = null;
    globalThis.__setup = null;
    globalThis.__swapCalls = [];
    globalThis.__swapAnswer = null;
    replace('swarm:credit-get-state', () => globalThis.__credit);
    replace('swarm:credit-set-swap-enable', (_e, enabled) => {
      globalThis.__swapCalls.push(enabled);
      return globalThis.__swapAnswer(enabled);
    });
    replace('swarm:setup-get-state', () => globalThis.__setup);
    replace('swarm:setup-watch', () => globalThis.__setup);
    globalThis.__pushSetup = () => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('swarm:setup-state', globalThis.__setup);
        win.webContents.send('ant:statusUpdate', { status: 'running' });
      }
    };
  });
}

async function feed(electronApp, window, { creditState, setup }) {
  await electronApp.evaluate(
    (_e, { c, s }) => {
      globalThis.__credit = c;
      globalThis.__setup = s;
      globalThis.__pushSetup();
    },
    { c: creditState, s: setup }
  );
  // Leave the Nodes tab and come back: the card re-reads the credit when it
  // comes on screen.
  await window.click('.sidebar-tab[data-tab="wallet"]');
  await window.click('.sidebar-tab[data-tab="nodes"]');
}

async function openNodesTab(window) {
  // The sidebar's feature flag arrives with the settings, after first paint.
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
  const dir = process.env.CREDIT_SHOTS_DIR;
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

test.describe('Nodes tab: browsing credit (#488)', () => {
  test.beforeEach(async ({ electronApp, window }) => {
    await stubMain(electronApp);
    await openNodesTab(window);
  });

  test('a funded node pays peers and shows the credit, the spend and the cost', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, { creditState: credit(), setup: setupState() });

    const group = window.locator('#swarm-credit-group');
    await expect(group).toBeVisible();
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Paying peers');
    await expect(window.locator('#swarm-credit-tier')).toHaveAttribute('data-status', 'running');
    await expect(window.locator('#swarm-credit-available')).toHaveText('0.0008');
    await expect(window.locator('#swarm-credit-detail')).toHaveText('Of 0.001 xBZZ deposited');
    await expect(window.locator('#swarm-credit-spend')).toHaveText(
      'Spent 0.00012 xBZZ in 24 h · 0.0002 xBZZ in 7 days'
    );
    // Any amount can be added, so the top-up is on offer at any level.
    await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
    await expect(window.locator('#swarm-credit-switch')).toBeChecked();
    await expect(window.locator('#swarm-credit-switch')).toBeEnabled();
    await expect(window.locator('#swarm-credit-note')).toContainText(
      'pays peers for faster downloads and for uploads'
    );
    await expect(window.locator('#swarm-credit-note')).toContainText('0.59 xBZZ per GB');
    await expect(window.locator('#swarm-credit-note')).toContainText(
      '0.16 xBZZ per hour of HD video'
    );
    await expect(window.locator('#swarm-credit-note')).toContainText(
      'Uploads cost about 0.22 xBZZ per GB'
    );
    await expect(window.locator('#swarm-credit-note')).toContainText(
      'Spending never goes past what is deposited'
    );
    await shoot(window, 'paying');
  });

  test('the switch writes swap-enable through main and shows the free tier', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, { creditState: credit(), setup: setupState() });
    await expect(window.locator('#swarm-setup-hint')).toHaveText('View and extend your storage');
    await electronApp.evaluate(
      (_e, off) => {
        globalThis.__swapAnswer = () => ({ ok: true, error: null, state: off });
      },
      credit({ swapEnable: false, paying: false })
    );

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();

    await expect.poll(() => electronApp.evaluate(() => globalThis.__swapCalls)).toEqual([false]);
    await expect(window.locator('#swarm-credit-switch')).not.toBeChecked();
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    await expect(window.locator('#swarm-credit-status')).toHaveText(
      'Paying peers is off, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'Pays for faster downloads and for uploads. One switch for the whole node, as in bee.'
    );
    // swap-enable is node-wide: the ready publish CTA warns about uploads.
    await expect(window.locator('#swarm-setup-hint')).toHaveText(
      'Paying peers is off, so large uploads can stall'
    );
    await shoot(window, 'off');
  });

  test('a refused flip puts the switch back and says why', async ({ electronApp, window }) => {
    await feed(electronApp, window, { creditState: credit(), setup: setupState() });
    await electronApp.evaluate(() => {
      globalThis.__swapAnswer = () => ({
        ok: false,
        error: 'The Swarm node is still connecting to Gnosis Chain. Try again in a moment.',
      });
    });

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();

    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'The Swarm node is still connecting to Gnosis Chain. Try again in a moment.'
    );
    await expect(window.locator('#swarm-credit-switch')).toBeChecked();
  });

  test('a node version without the switch: disabled, "not supported by this node version"', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, {
      creditState: credit({
        support: 'unsupported',
        paying: null,
        depositAmount: false,
        chequebook: balance(1000, 1000),
        spend: { day: '0', week: '0', dayPlur: '0', weekPlur: '0', since: 1 },
      }),
      setup: setupState(),
    });

    await expect(window.locator('#swarm-credit-switch')).toBeDisabled();
    await expect(window.locator('#swarm-credit-switch')).not.toBeChecked();
    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'Not supported by this node version.'
    );
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    await expect(window.locator('#swarm-credit-status')).toContainText(
      'not supported by this node version'
    );
    // The rest of the Nodes tab is untouched.
    await expect(window.locator('#swarm-chequebook-group')).toBeVisible();
    await shoot(window, 'unsupported');
  });

  test('low credit offers a top-up of any amount', async ({ electronApp, window }) => {
    await feed(electronApp, window, {
      creditState: credit({ chequebook: balance(300, 1000) }),
      // Spent in cheques peers have not cashed: the on-chain deposit is full,
      // which no longer matters for adding an amount.
      setup: setupState({ needsTopUp: false }),
    });

    await expect(window.locator('#swarm-credit-status')).toHaveText(
      'The credit is low. When it runs out, downloads and uploads go back to the free tier.'
    );
    await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
    await shoot(window, 'low');

    await window.click('#swarm-credit-topup');
    await expect(window.locator('#sidebar-chequebook-deposit')).toBeVisible();
    await expect(window.locator('#chequebook-amount')).toBeVisible();
    await expect(window.locator('#chequebook-amount-presets .safe-preset')).toHaveText([
      '0.05 xBZZ≈ 85 MB fully paid',
      '0.1 xBZZ≈ 170 MB fully paid',
      '0.5 xBZZ≈ 850 MB fully paid',
    ]);
    await expect(window.locator('#chequebook-deposit-btn')).toHaveText('Top Up 0.1 xBZZ');
    // An amount is not capped by the node's target, so that row gives way to
    // the node wallet's xDAI, which the node swaps first.
    await expect(window.locator('#chequebook-target-row')).toBeHidden();
    await expect(window.locator('#chequebook-wallet-xdai')).toHaveText('0.42 xDAI');
    await expect(window.locator('#chequebook-amount-spend')).toHaveText(
      'Your node pays for this from its wallet first: it swaps up to the 0.42 xDAI it holds for xBZZ, and asks you for xDAI only if that is not enough.'
    );
    await shoot(window, 'deposit-amount-wallet');
  });

  test('empty credit: free tier for downloads and uploads, still a top-up', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, {
      creditState: credit({ chequebook: balance(0, 1000) }),
      setup: setupState({ needsTopUp: false }),
    });

    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    await expect(window.locator('#swarm-credit-status')).toHaveText(
      'The credit is used up, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
    await shoot(window, 'empty');
  });

  test.describe('an Ant from before freedom-hq/ant#126', () => {
    const legacy = { support: 'unsupported', paying: null, depositAmount: false };

    test('a short deposit tops up to the target only, no amount chooser', async ({
      electronApp,
      window,
    }) => {
      await feed(electronApp, window, {
        // Peers cashed 0.0007 of it: the on-chain deposit is below target.
        creditState: credit({ ...legacy, chequebook: balance(300, 300) }),
        setup: setupState({ needsTopUp: true, deposit: '0.0003' }),
      });
      await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
      await window.click('#swarm-credit-topup');
      await expect(window.locator('#sidebar-chequebook-deposit')).toBeVisible();
      await expect(window.locator('#chequebook-deposit-btn')).toHaveText('Top Up Deposit');
      await expect(window.locator('#chequebook-amount')).toBeHidden();
      // A target top-up: the target is what it fills to.
      await expect(window.locator('#chequebook-target-bzz')).toHaveText('0.001 xBZZ');
      await expect(window.locator('#chequebook-wallet-row')).toBeHidden();
      await shoot(window, 'legacy-deposit-screen');
    });

    test('spent but uncashed: no top-up, and says why', async ({ electronApp, window }) => {
      await feed(electronApp, window, {
        creditState: credit({ ...legacy, chequebook: balance(0, 1000) }),
        setup: setupState({ needsTopUp: false }),
      });
      await expect(window.locator('#swarm-credit-status')).toContainText(
        'still reads full on chain until peers cash'
      );
      await expect(window.locator('#swarm-credit-topup-cta')).toBeHidden();
    });
  });

  test('hidden while the node is not running', async ({ electronApp, window }) => {
    await feed(electronApp, window, {
      creditState: credit({ node: 'stopped', chequebook: undefined }),
      setup: setupState(),
    });
    await expect(window.locator('#swarm-credit-group')).toBeHidden();
  });
});

// -----------------------------------------------------------------------------
// The real services against a fake antd with freedom-hq/ant#126's routes
// -----------------------------------------------------------------------------

// Starts the fake node in the main process and points the registry at it.
// Every deposit amount costs a flat 0.06 xDAI here; the fake wallet starts
// empty, so the first deposit attempt is refused the way antd refuses it.
async function startFakeAnt(electronApp) {
  return electronApp.evaluate(async () => {
    const http = process.mainModule.require('http');
    const CB = '0x' + 'ab'.repeat(20);
    const WALLET = '0x' + 'cd'.repeat(20);
    const PRICE_WEI = 60_000_000_000_000_000n;
    const state = {
      swapEnabled: true,
      walletXdaiWei: 0n,
      depositPlur: 10_000_000_000_000n,
      puts: [],
      deposits: [],
    };
    const settlement = () => ({
      supported: true,
      swapSwitch: true,
      swapEnabled: state.swapEnabled,
      paying: state.swapEnabled,
      chequebook: CB,
    });
    const depositBody = () => ({
      chequebook: CB,
      managed: true,
      depositPlur: state.depositPlur.toString(),
      targetPlur: '10000000000000',
      shortfallPlur: '0',
      needsTopUp: false,
      walletAddress: WALLET,
      walletBzzPlur: '0',
      walletXdaiWei: state.walletXdaiWei.toString(),
      bzzToAcquirePlur: '0',
      swapInputWei: '0',
      gasReserveWei: '0',
      xdaiRequiredWei: '0',
      xdaiToSendWei: '0',
      sufficientFunds: true,
    });
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = (code, obj) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        switch (`${req.method} ${url.pathname}`) {
          case 'GET /health':
            return send(200, { status: 'ok', chainReady: true });
          case 'GET /node':
            return send(200, {
              beeMode: 'light',
              gatewayMode: false,
              chequebookEnabled: true,
              swapEnabled: state.swapEnabled,
              settlement: settlement(),
            });
          case 'GET /readiness':
            return send(200, { status: 'ready' });
          case 'GET /stamps':
            return send(200, {
              stamps: [{ batchID: 'aa'.repeat(32), usable: true, utilization: 0, depth: 20 }],
            });
          case 'GET /chequebook/address':
            return send(200, { chequebookAddress: CB });
          case 'GET /chequebook/balance':
            return send(200, {
              totalBalance: state.depositPlur.toString(),
              availableBalance: (state.depositPlur - 7_000_000_000_000n).toString(),
            });
          case 'GET /settlements':
            return send(200, { totalSent: '0', totalReceived: '0', settlements: [] });
          case 'GET /v0/settlement/deposit':
            return send(200, depositBody());
          case 'PUT /v0/settlement/swap': {
            state.puts.push({
              origin: req.headers.origin ?? null,
              contentType: req.headers['content-type'] ?? null,
              body,
            });
            state.swapEnabled = JSON.parse(body).swapEnabled === true;
            return send(200, { ...settlement(), persisted: false });
          }
          case 'POST /v0/settlement/deposit': {
            const amount = url.searchParams.get('amount');
            state.deposits.push(amount);
            if (state.walletXdaiWei < PRICE_WEI) {
              const short = Number(PRICE_WEI - state.walletXdaiWei) / 1e18;
              return send(400, {
                code: 400,
                message: `not enough xDAI: send ${short.toFixed(4)} more xDAI to your account, then try again`,
              });
            }
            state.walletXdaiWei -= PRICE_WEI;
            state.depositPlur += BigInt(amount);
            return send(200, depositBody());
          }
          default:
            return send(404, { code: 404, message: 'Not Found' });
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    globalThis.__fakeAnt = { server, state };
    const url = `http://127.0.0.1:${server.address().port}`;
    process.mainModule.require('./src/main/service-registry').updateService('ant', { api: url });
    return url;
  });
}

// The real browsing credit and publish setup services, on a node that runs,
// in place of the app's own instances (the harness runs no node).
async function wireRealServices(electronApp) {
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    const load = process.mainModule.require;
    const { createBrowsingCreditService } = load('./src/main/swarm/browsing-credit-service');
    const { createPublishSetupService } = load('./src/main/swarm/publish-setup-service');
    const running = () => ({ status: 'running', error: null });
    let setting = true;
    globalThis.__swapSetting = () => setting;
    const credit = createBrowsingCreditService({
      getNodeStatus: running,
      isManaged: () => true,
      isSwapEnabled: () => setting,
      setSwapEnabled: (enabled) => {
        setting = enabled;
        return true;
      },
      store: { get: () => null, set: () => {} },
    });
    const setup = createPublishSetupService({
      getNodeStatus: running,
      getRegistryMode: () => 'bundled',
      restartNode: async () => {},
      getTransactionStatus: async () => ({ status: 'pending' }),
      publish: (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('swarm:setup-state', state);
        }
      },
    });
    globalThis.__realServices = { credit, setup };
    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    };
    replace('swarm:credit-get-state', () => credit.getState());
    replace('swarm:credit-set-swap-enable', (_e, enabled) => credit.setSwapEnable(enabled));
    replace('swarm:setup-get-state', async () => {
      await setup.ensureFresh(0);
      return setup.getState();
    });
    replace('swarm:setup-watch', (_e, surface, on) => {
      setup.watch(`fake:${surface}`, on === true);
      return setup.getState();
    });
    replace('swarm:setup-arm', (_e, request) => setup.arm(request));
    replace('swarm:setup-cancel', (_e, opId) => setup.cancel(Number.isInteger(opId) ? opId : null));
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ant:statusUpdate', { status: 'running' });
    }
  });
}

const fakeAnt = (electronApp) =>
  electronApp.evaluate(() => {
    const { state } = globalThis.__fakeAnt;
    return {
      swapEnabled: state.swapEnabled,
      puts: state.puts,
      deposits: state.deposits,
      depositPlur: state.depositPlur.toString(),
      setting: globalThis.__swapSetting(),
    };
  });

test.describe('Nodes tab: browsing credit on an Ant with freedom-hq/ant#126', () => {
  test.beforeEach(async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealServices(electronApp);
    await openNodesTab(window);
    await window.click('.sidebar-tab[data-tab="wallet"]');
    await window.click('.sidebar-tab[data-tab="nodes"]');
  });

  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__realServices?.setup.dispose?.();
      globalThis.__realServices?.credit.dispose();
      globalThis.__fakeAnt?.server.close();
    });
  });

  test('the switch flips the running node live, no restart, and keeps the setting', async ({
    electronApp,
    window,
  }) => {
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Paying peers');
    await expect(window.locator('#swarm-credit-switch')).toBeEnabled();
    await expect(window.locator('#swarm-credit-switch')).toBeChecked();
    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'Pays for faster downloads and for uploads. One switch for the whole node, as in bee.'
    );
    await shoot(window, 'live-on');

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();

    await expect(window.locator('#swarm-credit-switch')).not.toBeChecked();
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    const off = await fakeAnt(electronApp);
    expect(off).toMatchObject({ swapEnabled: false, setting: false });
    // One PUT, JSON, and no Origin: antd's web-page guard lets main through.
    expect(off.puts).toEqual([
      { origin: null, contentType: 'application/json', body: '{"swapEnabled":false}' },
    ]);
    await shoot(window, 'live-off');

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Paying peers');
    expect(await fakeAnt(electronApp)).toMatchObject({ swapEnabled: true, setting: true });
  });

  test('top up a chosen amount: the node prices it, the pay step asks, it deposits once paid', async ({
    electronApp,
    window,
  }) => {
    await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
    await window.click('#swarm-credit-topup');
    await expect(window.locator('#chequebook-amount')).toBeVisible();
    await expect(window.locator('#chequebook-deposit-btn')).toHaveText('Top Up 0.1 xBZZ');

    await window.locator('#chequebook-amount-presets .safe-preset', { hasText: '0.5 xBZZ' }).click();
    await expect(window.locator('#chequebook-deposit-btn')).toHaveText('Top Up 0.5 xBZZ');
    await window.fill('#chequebook-amount-input', '20');
    await expect(window.locator('#chequebook-amount-error')).toHaveText(
      'Choose an amount between 0.001 and 10 xBZZ.'
    );
    await expect(window.locator('#chequebook-deposit-btn')).toBeDisabled();
    await shoot(window, 'deposit-amount-invalid');
    await window.fill('#chequebook-amount-input', '0.25');
    await expect(window.locator('#chequebook-deposit-btn')).toHaveText('Top Up 0.25 xBZZ');
    await expect(window.locator('#chequebook-amount .safe-preset.selected')).toHaveCount(0);
    await shoot(window, 'deposit-amount');

    // The node wallet is empty: nothing of it is at stake, so no spend note.
    await expect(window.locator('#chequebook-wallet-xdai')).toHaveText('0 xDAI');
    await expect(window.locator('#chequebook-amount-spend')).toBeHidden();

    await window.click('#chequebook-deposit-btn');

    await expect(window.locator('#publish-pay-label')).toHaveText(
      'Add 0.25 xBZZ to the chequebook deposit'
    );
    await expect(window.locator('#publish-pay-amount')).toHaveText('0.06 xDAI');
    expect((await fakeAnt(electronApp)).deposits).toEqual(['2500000000000000']);
    await shoot(window, 'deposit-amount-pay');

    // The xDAI arrives; the next quote (every 6 s) deposits it, once.
    await electronApp.evaluate(() => {
      globalThis.__fakeAnt.state.walletXdaiWei = 60_000_000_000_000_000n;
    });
    await expect(window.locator('#publish-done-text')).toHaveText(
      'Added 0.25 xBZZ to the chequebook deposit. It pays for faster downloads and for uploads.',
      { timeout: 15_000 }
    );
    expect(await fakeAnt(electronApp)).toMatchObject({
      deposits: ['2500000000000000', '2500000000000000'],
      depositPlur: '2510000000000000',
    });
    await shoot(window, 'deposit-amount-done');
  });

  test('a node wallet holding xDAI: the screen says it is spent first, and only that much is', async ({
    electronApp,
    window,
  }) => {
    await electronApp.evaluate(() => {
      globalThis.__fakeAnt.state.walletXdaiWei = 90_000_000_000_000_000n;
    });
    await window.click('#swarm-credit-topup');
    await expect(window.locator('#chequebook-wallet-xdai')).toHaveText('0.09 xDAI');
    await expect(window.locator('#chequebook-amount-spend')).toContainText(
      'it swaps up to the 0.09 xDAI it holds'
    );
    // xDAI lands after the screen showed 0.09: main refuses to let the node
    // swap more than the user saw, and sends nothing.
    await electronApp.evaluate(() => {
      globalThis.__fakeAnt.state.walletXdaiWei = 500_000_000_000_000_000n;
    });
    await window.click('#chequebook-deposit-btn');
    await expect(window.locator('#publish-failed-text')).toContainText(
      'more xDAI than when you chose this top-up'
    );
    expect((await fakeAnt(electronApp)).deposits).toEqual([]);
  });
});
