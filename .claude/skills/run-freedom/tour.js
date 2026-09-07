// Screenshot every major UI surface in both themes. Output goes to
// $SHOTS_DIR (default /tmp/freedom-shots) as <theme>-<nn>-<name>.png.
//
//   NODE_PATH=$PWD/node_modules xvfb-run -a -s "-screen 0 1440x900x24" \
//     node .claude/skills/run-freedom/tour.js [dark|light|both]
//
// Each step is isolated: a failing step is logged as "STEP FAIL" and the
// tour continues, so one broken surface does not hide the rest.

const { launch, shot, go, closeMenus, dismissOnboarding, SHOTS } = require('./lib');
const r = require('./recipes');

const SECTIONS = [
  'appearance',
  'search',
  'profile',
  'nodes',
  'startup',
  'downloads',
  'shortcuts',
  'chains',
  'rpc',
  'ens',
  'adblock',
  'permissions',
  'experimental',
  'updates',
];
const PAGES = ['downloads', 'history', 'profiles', 'payments'];

async function tour(theme) {
  const t = theme[0];
  const ctx = await launch({ theme, showBookmarkBar: true });
  const { app, win } = ctx;
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      console.log('STEP FAIL', theme, name, e.message.split('\n')[0]);
    }
  };
  const snap = (n, name) => shot(win, `${t}-${String(n).padStart(2, '0')}-${name}`);

  await snap(1, 'landing');
  await step('nodes-menu', async () => {
    await r.nodesMenu(ctx);
    await snap(2, 'nodes-menu');
    await closeMenus(win);
  });
  await step('app-menu', async () => {
    await r.appMenu(ctx, { zoomIn: true });
    await snap(3, 'app-menu');
    await closeMenus(win);
  });
  await step('find-bar', async () => {
    await r.findBar(ctx);
    await snap(4, 'find-bar');
    await win.fill('[data-test="find-bar-input"]', 'zzzz-none');
    await win.waitForTimeout(600);
    await snap(5, 'find-bar-no-match');
    await win.keyboard.press('Escape');
  });
  await step('permissions', async () => {
    await r.permissionPrompt(ctx);
    await snap(6, 'permission-prompt');
    await r.answerPermission(ctx, true);
    await win.waitForSelector('[data-test="permission-indicator"]', { state: 'visible' });
    await win.click('[data-test="permission-indicator"]');
    await win.waitForTimeout(500);
    await snap(7, 'permission-indicator-open');
    await closeMenus(win);
  });
  await step('download', async () => {
    await r.downloadShelf(ctx);
    await snap(8, 'download-shelf');
    const close = await win.$('[data-test="download-close"]');
    if (close) await close.click().catch(() => {});
  });
  await step('tabs', async () => {
    await r.tabContextMenu(ctx);
    await snap(9, 'tab-context-menu');
    await win.keyboard.press('Escape');
    await r.muteTab(ctx, { pin: true });
    await win.click('[data-test="new-tab-btn"]');
    await win.waitForTimeout(600);
    await snap(10, 'tab-pinned-muted');
  });
  await step('sidebar', async () => {
    await win.click('#wallet-toggle-btn');
    await win.waitForTimeout(800);
    await snap(11, 'sidebar-default');
    await dismissOnboarding(win);
  });
  await step('wallet-flows', async () => {
    const resolve = await r.stubWalletIpc(ctx);
    await r.sendForm(ctx);
    await snap(12, 'send-form');
    await win.fill('#send-amount', '0.001');
    await win.click('#send-continue-btn');
    await win.waitForSelector('#send-review-view', { state: 'visible' });
    await snap(13, 'send-review');
    await win.click('#send-confirm-btn');
    await win.waitForSelector('#send-pending-view', { state: 'visible' });
    await snap(14, 'send-pending');
    await resolve({ success: true, hash: '0xfeedface', recorded: true });
    await win.waitForSelector('#send-success-view', { state: 'visible' });
    await snap(15, 'send-success');
    await r.dappTxApproval(ctx);
    await snap(16, 'dapp-tx');
    await r.dappSign(ctx);
    await snap(17, 'dapp-sign');
    await r.dappConnect(ctx);
    await snap(18, 'dapp-connect');
    for (const [i, kind] of ['connect', 'publish', 'messaging', 'feed'].entries()) {
      await r.swarmApproval(ctx, kind);
      await snap(19 + i, `swarm-${kind}`);
    }
  });
  await win.click('#sidebar-close').catch(() => {});
  await step('onchain', async () => {
    await r.onchainApp(ctx);
    await snap(23, 'onchain-app');
    await r.trustPopover(ctx);
    await snap(24, 'onchain-trust-popover');
    await closeMenus(win);
  });
  await step('interstitials', async () => {
    await r.tezInterstitial(ctx, 'unverified');
    await snap(25, 'tez-unverified');
    await r.tezInterstitial(ctx, 'conflict');
    await snap(26, 'tez-conflict');
    await r.errorPage(ctx);
    await snap(27, 'error-page');
  });
  await step('settings', async () => {
    for (const [i, section] of SECTIONS.entries()) {
      await r.settings(ctx, section);
      await snap(30 + i, `settings-${section}`);
    }
    await r.shortcutConflict(ctx);
    await snap(45, 'settings-shortcut-conflict');
  });
  await step('pages', async () => {
    for (const [i, page] of PAGES.entries()) {
      await go(win, `freedom://${page}`, 1_800);
      await snap(50 + i, `page-${page}`);
    }
  });
  await step('private', async () => {
    const pw = await r.privateWindow(ctx);
    await shot(pw, `${t}-60-private-window`);
    await pw.click('#wallet-toggle-btn').catch(() => {});
    await pw.waitForTimeout(500);
    await shot(pw, `${t}-61-private-sidebar`);
  });
  await app.close();
}

(async () => {
  const which = process.argv[2] || 'both';
  const themes = which === 'both' ? ['dark', 'light'] : [which];
  for (const theme of themes) await tour(theme);
  console.log('done; screenshots in', SHOTS);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
