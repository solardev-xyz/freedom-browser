// The fork watch's "update Freedom" notice (#586), rendered from a synthetic
// status: no native node, no peers. The advisory itself is validated in main
// (myotis-process.test.js); this pins what reaches the user on the Nodes
// card and in Settings' chain source status.
const { test, expect } = require('./fixtures');

const settingsEval = (window, script) =>
  window.evaluate(async (source) => {
    const webview = [...document.querySelectorAll('webview')].find((candidate) => {
      try {
        return /settings/.test(candidate.getURL() || '');
      } catch {
        return false;
      }
    });
    if (!webview || typeof webview.executeJavaScript !== 'function') return null;
    return webview.executeJavaScript(source);
  }, script);

async function advisoryState(app, advisories, gnosisExtra = {}) {
  await app.evaluate(({ ipcMain, BrowserWindow }, { advisories, gnosisExtra }) => {
    const base = {
      available: true,
      supported: true,
      running: true,
      version: '0.1.14',
      peerCount: 9,
    };
    const statuses = {
      1: {
        ...base,
        chainId: 1,
        state: 'ready',
        finalizedBlockNumber: 25690000,
        upgradeAdvisory: advisories[1],
      },
      100: {
        ...base,
        chainId: 100,
        state: 'syncing',
        finalizedBlockNumber: 43210000,
        upgradeAdvisory: advisories[100],
        ...gnosisExtra,
      },
    };
    ipcMain.removeHandler('myotis:getStatus');
    ipcMain.handle('myotis:getStatus', (_event, id = 1) => statuses[Number(id)] || statuses[1]);
    for (const win of BrowserWindow.getAllWindows()) {
      for (const status of Object.values(statuses))
        win.webContents.send('myotis:statusUpdate', status);
    }
  }, { advisories, gnosisExtra });
}

const inTwelveDays = () => Math.floor(Date.now() / 1000) + 12 * 86400 + 3600;

for (const theme of ['dark', 'light']) {
  test.describe(`Myotis upgrade advisory (${theme})`, () => {
    test.use({ seedSettings: { theme } });

    test('shows the update notice on each chain card and in Settings, and clears it', async ({
      electronApp,
      window,
    }, testInfo) => {
      await advisoryState(electronApp, {
        1: {
          phase: 'SCHEDULED',
          activationTime: inTwelveDays(),
          forkId: '0x6c1d9423',
          observedPeers: 4,
        },
        100: { phase: 'ACTIVE', activationTime: 0, forkId: '0x00000000', observedPeers: 3 },
      });
      await window.locator('#bee-menu-button').click();

      const ethereum = window.locator('#myotis-upgrade-message');
      await expect(ethereum).toBeVisible();
      await expect(window.locator('#myotis-upgrade-text')).toContainText(
        'An Ethereum network upgrade that this version of Freedom doesn’t know about is coming in 12 days ('
      );
      await expect(window.locator('#myotis-upgrade-text')).toContainText(
        'Update Freedom before then to keep verified reads. Update from the bottom of the main menu.'
      );
      await expect(window.locator('#myotis-upgrade-detail')).toHaveText(
        'Reported by 4 peer networks, not verified. It doesn’t change how Freedom checks answers.'
      );
      // Still ready and still Ready: the advisory is display-only.
      await expect(window.locator('#myotis-state-text')).toHaveText('Ready');

      const gnosis = window.locator('#myotis-gnosis-upgrade-message');
      await expect(gnosis).toBeVisible();
      await expect(window.locator('#myotis-gnosis-upgrade-text')).toHaveText(
        'The Gnosis network has upgraded and this version of Freedom can’t follow it. ' +
          'This node can’t verify until you update; Freedom uses your other Gnosis sources meanwhile. ' +
          'Update from the bottom of the main menu.'
      );
      // The detail is its own line under the sentence, not run on after it.
      const [textBox, detailBox] = await Promise.all([
        window.locator('#myotis-gnosis-upgrade-text').boundingBox(),
        window.locator('#myotis-gnosis-upgrade-detail').boundingBox(),
      ]);
      expect(detailBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);

      await ethereum.scrollIntoViewIfNeeded();
      await window
        .locator('#bee-menu-dropdown')
        .screenshot({ path: testInfo.outputPath(`nodes-ethereum-${theme}.png`) });
      await gnosis.scrollIntoViewIfNeeded();
      await window
        .locator('#bee-menu-dropdown')
        .screenshot({ path: testInfo.outputPath(`nodes-gnosis-${theme}.png`) });
      await window.keyboard.press('Escape');

      await window.evaluate(() => document.getElementById('settings-btn')?.click());
      const badge = (cid) =>
        settingsEval(
          window,
          `location.hash = 'networks/${cid}'; new Promise((resolve) => setTimeout(() => resolve(
            document.querySelector('[data-access-kind="read"][data-access-source="myotis"] .resolver-badge')?.textContent ?? null
          ), 50))`
        );
      await expect.poll(() => badge(1), { timeout: 15_000 }).toBe('Ready — update Freedom');
      await expect.poll(() => badge(100), { timeout: 15_000 }).toBe('Update Freedom — open Nodes');
      await settingsEval(
        window,
        `document.querySelector('[data-access-source="myotis"]').scrollIntoView({ block: 'center' })`
      );
      await window.screenshot({ path: testInfo.outputPath(`settings-gnosis-${theme}.png`) });

      // Precedence (settings.js sourceStatus): the advisory outranks a
      // checkpoint recovery / paused sync — the likeliest cause of either —
      // but not an installation recovery, which already says to update.
      const active = { phase: 'ACTIVE', activationTime: 0, forkId: '0x6c1d9423', observedPeers: 3 };
      // Settings re-reads Myotis status on a hashchange into Networks, and the
      // badge already reads "Update Freedom — open Nodes" from above: hop via
      // chain 1 so each poll is a fresh read, not the cached one.
      const freshBadge100 = async () => {
        await badge(1);
        return badge(100);
      };
      // Each with-advisory step follows the same state without one, so a
      // badge left over from the previous step can't satisfy it.
      const steps = [
        [{ state: 'recovering' }, 'Updating checkpoint', 'Update Freedom — open Nodes'],
        [
          { state: 'recovery-blocked', recovery: { reason: 'stalled' } },
          'Syncing slowly — open Nodes',
          'Update Freedom — open Nodes',
        ],
        [
          { state: 'recovery-blocked', recovery: { reason: 'installation' } },
          'Update or reinstall — open Nodes',
          'Update or reinstall — open Nodes',
        ],
        // Turned off, client still exiting: nothing to update for.
        [{ state: 'off', running: false }, 'Off', 'Off'],
      ];
      for (const [extra, without, withAdvisory] of steps) {
        await advisoryState(electronApp, { 1: null, 100: null }, extra);
        await expect.poll(freshBadge100, { timeout: 15_000 }).toBe(without);
        await advisoryState(electronApp, { 1: null, 100: active }, extra);
        await expect.poll(freshBadge100, { timeout: 15_000 }).toBe(withAdvisory);
      }

      await advisoryState(electronApp, { 1: null, 100: null });
      await expect.poll(() => badge(1), { timeout: 15_000 }).toBe('Ready');
      await expect.poll(() => badge(100), { timeout: 15_000 }).toBe('Syncing');
      await expect(ethereum).toBeHidden();
      await expect(gnosis).toBeHidden();
    });
  });
}
