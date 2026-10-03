// The wallet sidebar's Nodes tab shows the Swarm node's chequebook as
// browsing credit (#488): what is left, the recent spend, whether the node
// pays peers, a top-up when it runs low, and bee's `swap-enable` switch.
//
// The pinned Ant predates the switch and the harness runs no node at all, so
// the browsing credit and publish setup IPC are replaced for this app
// instance and each node state is fed to the real renderer. Set
// CREDIT_SHOTS_DIR to keep a screenshot of every state in both themes.

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
    await expect(window.locator('#swarm-credit-topup-cta')).toBeHidden();
    await expect(window.locator('#swarm-credit-switch')).toBeChecked();
    await expect(window.locator('#swarm-credit-switch')).toBeEnabled();
    await expect(window.locator('#swarm-credit-note')).toContainText('0.75 xBZZ per GB');
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
      credit({ swapEnable: false })
    );

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();

    await expect.poll(() => electronApp.evaluate(() => globalThis.__swapCalls)).toEqual([false]);
    await expect(window.locator('#swarm-credit-switch')).not.toBeChecked();
    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    await expect(window.locator('#swarm-credit-status')).toHaveText(
      'Paying peers is off, so downloads use the free tier and may be slow, and large uploads can stall.'
    );
    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'Pays for downloads and uploads. One switch for the whole node, as in bee.'
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
        error: 'Wait for the purchase to finish before restarting the node.',
      });
    });

    await window.locator('.swarm-credit-toggle-row .toggle-switch').click();

    await expect(window.locator('#swarm-credit-toggle-hint')).toHaveText(
      'Wait for the purchase to finish before restarting the node.'
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

  test('low credit offers a top-up that opens the deposit screen', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, {
      // Peers cashed 0.0007 of it: the on-chain deposit is below target.
      creditState: credit({ chequebook: balance(300, 300) }),
      setup: setupState({ needsTopUp: true, deposit: '0.0003' }),
    });

    await expect(window.locator('#swarm-credit-status')).toHaveText(
      'The credit is low. When it runs out, downloads go back to the free tier.'
    );
    await expect(window.locator('#swarm-credit-topup-cta')).toBeVisible();
    await shoot(window, 'low');

    await window.click('#swarm-credit-topup');
    await expect(window.locator('#sidebar-chequebook-deposit')).toBeVisible();
    await expect(window.locator('#chequebook-deposit-btn')).toBeVisible();
    await shoot(window, 'deposit-screen');
  });

  test('empty credit: free tier, and no top-up while the spend is still uncashed', async ({
    electronApp,
    window,
  }) => {
    await feed(electronApp, window, {
      creditState: credit({ chequebook: balance(0, 1000) }),
      setup: setupState({ needsTopUp: false }),
    });

    await expect(window.locator('#swarm-credit-tier')).toHaveText('Free tier');
    await expect(window.locator('#swarm-credit-status')).toContainText(
      'The credit is used up, so downloads use the free tier and may be slow.'
    );
    await expect(window.locator('#swarm-credit-status')).toContainText(
      'still reads full on chain until peers cash'
    );
    await expect(window.locator('#swarm-credit-topup-cta')).toBeHidden();
    await shoot(window, 'empty');
  });

  test('hidden while the node is not running', async ({ electronApp, window }) => {
    await feed(electronApp, window, {
      creditState: credit({ node: 'stopped', chequebook: undefined }),
      setup: setupState(),
    });
    await expect(window.locator('#swarm-credit-group')).toBeHidden();
  });
});
