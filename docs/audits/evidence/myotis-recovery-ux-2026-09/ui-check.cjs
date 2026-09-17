const fs = require('fs');
const path = require('path');
// Real Electron renderer with simulated service statuses and action handlers.
// This checks presentation/routing, not native recovery or proof verification.
const root = path.resolve(__dirname, '../../../..');
process.env.FB_ROOT = process.env.MYOTIS_UX_ROOT || root;
const { launch, closeMenus } = require(path.join(root, '.claude/skills/run-freedom/lib.js'));
const { expect } = require(path.join(root, 'node_modules/@playwright/test'));
const before = Boolean(process.env.MYOTIS_UX_ROOT);
const out = path.join(root, 'docs/audits/evidence/myotis-recovery-ux-2026-09');
fs.mkdirSync(out, { recursive: true });
async function send(ctx, kind) {
  await ctx.app.evaluate(({ ipcMain, BrowserWindow }, kind) => {
    const off = { chainId: 1, available: true, supported: true, running: false, state: 'off', version: '0.1.10' };
    const status = { ...off, chainId: 100, running: true, state: 'recovery-blocked',
      recovery: { phase: 'blocked', reason: kind, canRetry: !['installation','unsupported'].includes(kind), attempt: 1 } };
    if (kind === 'slow') {
      status.state = 'recovering'; status.recovery = { phase: 'checking', takingLonger: true, canRetry: false, attempt: 2 };
    }
    if (kind === 'installation') { status.available = false; status.running = false; status.state = 'unavailable'; }
    if (kind === 'ready') { status.state = 'ready'; delete status.recovery; }
    globalThis.myotisUxCalls ||= [];
    for (const [channel, action] of [['myotis:repairSyncData','repair'],['myotis:recoveryHelp','help'],['myotis:retryCheckpoint','retry']]) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, id) => { globalThis.myotisUxCalls.push({ action, id }); return status; });
    }
    ipcMain.removeHandler('myotis:getStatus');
    ipcMain.handle('myotis:getStatus', (_event, id = 1) => id === 100 ? status : off);
    for (const win of BrowserWindow.getAllWindows()) for (const s of [off,status]) win.webContents.send('myotis:statusUpdate', s);
  }, kind);
}
(async () => {
  for (const theme of ['dark','light']) {
    const ctx = await launch({ theme });
    try {
      for (const kind of ['storage','storage-io','ownership','installation','slow']) {
        if (before && ['storage-io','slow'].includes(kind)) continue;
        await closeMenus(ctx.win);
        await send(ctx, kind);
        if (kind === 'slow') {
          const notice = ctx.win.locator('#myotis-recovery-notice');
          await expect(notice).toBeVisible();
          await expect(notice).toContainText('Still trying automatically');
          await notice.screenshot({ path: path.join(out, `after-slow-${theme}.png`) });
          await ctx.win.locator('#myotis-recovery-notice-close').click();
          await send(ctx, kind);
          await expect(notice).toBeHidden();
          await send(ctx, 'quorum-conflict');
          await expect(notice).toBeVisible();
          await send(ctx, 'ready');
          await expect(notice).toBeHidden();
          continue;
        }
        await ctx.win.locator('#bee-menu-button').click();
        if (!before || kind !== 'installation') await ctx.win.locator('#myotis-gnosis-info').scrollIntoViewIfNeeded();
        if (!before) {
          const message = ctx.win.locator('#myotis-gnosis-recovery-message');
          await expect(message).toBeVisible();
          const help = ctx.win.locator('#myotis-gnosis-recovery-help');
          await expect(help).toBeVisible();
          await help.click();
          if (kind === 'storage') {
            await expect(ctx.win.locator('#myotis-gnosis-retry-checkpoint')).toHaveText('Repair sync data');
            await ctx.win.locator('#myotis-gnosis-retry-checkpoint').click();
          }
          if (kind === 'installation') await expect(ctx.win.locator('#myotis-gnosis-retry-checkpoint')).toBeHidden();
        }
        await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
        await ctx.win.waitForTimeout(150);
        await ctx.win.locator('#bee-menu-dropdown').screenshot({ path: path.join(out, `${before ? 'before' : 'after'}-${kind}-${theme}.png`) });
      }
      if (!before) {
        const calls = await ctx.app.evaluate(() => globalThis.myotisUxCalls);
        expect(calls.filter(c => c.action === 'repair')).toEqual([{ action: 'repair', id: 100 }]);
        expect(calls.filter(c => c.action === 'help')).toHaveLength(4);
      }
      console.log(JSON.stringify({ theme, phase: before ? 'before' : 'after', passed: true, simulatedStatus: true }));
    } finally { await ctx.app.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
