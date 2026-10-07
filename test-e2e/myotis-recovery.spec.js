// Renderer/action wiring only: synthetic lifecycle states, no native node or
// public checkpoint requests. Cryptographic/live checks have separate evidence.
const { test, expect } = require('./fixtures');

async function recoveryState(app, phase, reason = 'quorum-unavailable') {
  await app.evaluate(({ ipcMain, BrowserWindow }, { phase, reason }) => {
    const off = {
      chainId: 1,
      available: true,
      supported: true,
      running: false,
      state: 'off',
      version: '0.1.14',
    };
    const status = {
      ...off,
      chainId: 100,
      running: true,
      state: phase === 'blocked' ? 'recovery-blocked' : 'recovering',
      recovery: {
        phase,
        reason,
        attempt: 3,
        canRetry: phase !== 'checking',
        takingLonger: true,
        nextRetryAt: phase === 'waiting' ? Date.now() + 300000 : null,
      },
    };
    if (phase === 'ready') {
      status.state = 'ready';
      delete status.recovery;
    }
    globalThis.myotisRetryCalls = [];
    ipcMain.removeHandler('myotis:getStatus');
    ipcMain.handle('myotis:getStatus', (_event, id = 1) => (id === 100 ? status : off));
    ipcMain.removeHandler('myotis:retryCheckpoint');
    ipcMain.handle('myotis:retryCheckpoint', (_event, id) => {
      globalThis.myotisRetryCalls.push(id);
      status.recovery = { phase: 'checking', attempt: 1, canRetry: false, takingLonger: false };
      return status;
    });
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('myotis:statusUpdate', off);
      win.webContents.send('myotis:statusUpdate', status);
    }
  }, { phase, reason });
}

for (const theme of ['dark', 'light']) {
  test.describe(`Myotis background recovery (${theme})`, () => {
    test.use({ seedSettings: { theme } });
    test('explains when a computer restart is required', async ({ electronApp, window }, testInfo) => {
      await recoveryState(electronApp, 'blocked', 'ownership');
      await window.locator('#bee-menu-button').click();
      const message = window.locator('#myotis-gnosis-recovery-message');
      await message.scrollIntoViewIfNeeded();
      await window.locator('#bee-menu-dropdown').screenshot({ path: testInfo.outputPath(`ownership-before-${theme}.png`) });
      await recoveryState(electronApp, 'blocked', 'reboot-required');
      await expect(message).toContainText('Restart your computer');
      await expect(message).toContainText('old sync data will be kept');
      await expect(window.locator('#myotis-gnosis-recovery-help')).toBeVisible();
      await window.locator('#bee-menu-dropdown').screenshot({ path: testInfo.outputPath(`ownership-after-${theme}.png`) });
      await recoveryState(electronApp, 'ready');
      await expect(message).toBeHidden();
      await expect(window.locator('#myotis-recovery-notice')).toBeHidden();
    });
    test('shows automatic retry, allows immediate retry and clears notices on success', async ({
      electronApp,
      window,
    }, testInfo) => {
      await recoveryState(electronApp, 'blocked');
      await window.locator('#bee-menu-button').click();
      const message = window.locator('#myotis-gnosis-recovery-message');
      const retry = window.locator('#myotis-gnosis-retry-checkpoint');
      await expect(message).toContainText('Check your connection and retry');
      await retry.scrollIntoViewIfNeeded();
      await window
        .locator('#bee-menu-dropdown')
        .screenshot({ path: testInfo.outputPath(`before-${theme}.png`) });

      await recoveryState(electronApp, 'waiting');
      await expect(message).toContainText('Not enough checkpoint sources available. Retrying in');
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      await expect(window.locator('#myotis-recovery-notice')).toContainText(
        'Still trying automatically'
      );
      await retry.scrollIntoViewIfNeeded();
      await window
        .locator('#bee-menu-dropdown')
        .screenshot({ path: testInfo.outputPath(`after-${theme}.png`) });
      await retry.click();
      await expect(message).toContainText('Updating sync checkpoint');
      await expect(retry).toBeHidden();
      expect(await electronApp.evaluate(() => globalThis.myotisRetryCalls)).toEqual([100]);

      await recoveryState(electronApp, 'ready');
      await expect(message).toBeHidden();
      await expect(window.locator('#myotis-recovery-notice')).toBeHidden();
    });
  });
}
