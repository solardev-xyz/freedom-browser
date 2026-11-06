// freedom-core design 0009, Modes: "A gateway that fails the first [probe]
// serves `unverified`, and the nodes panel says "This gateway doesn't serve
// verifiable responses"". Renderer wiring only: a synthetic external gateway
// status drives the real Nodes menu, as `myotis-recovery.spec.js` drives
// Myotis's notices; `ipfs-manager.test.js` covers the probe and the
// diagnostics that carry its result.
const { test, expect } = require('./fixtures');

const NOTICE = "This gateway doesn't serve verifiable responses";

// The profile on an external gateway, serving, and the status the Nodes
// menu's stats poll reads: `diagnostics` as `getNativeDiagnostics()` gives it.
async function externalGateway(app, diagnostics) {
  await app.evaluate(({ ipcMain }, diagnostics) => {
    process.mainModule.require('./src/main/service-registry').updateService('ipfs', {
      api: null,
      gateway: diagnostics.externalGateway,
      externalGateway: diagnostics.externalGateway,
      mode: 'external',
      backend: 'external-gateway',
    });
    globalThis.__ipfsDiagnostics = diagnostics;
    ipcMain.removeHandler('ipfs:getStatus');
    ipcMain.handle('ipfs:getStatus', () => ({
      status: 'running',
      error: null,
      diagnostics: globalThis.__ipfsDiagnostics,
    }));
  }, diagnostics);
}

const setDiagnostics = (app, changes) =>
  app.evaluate((_electron, changes) => {
    Object.assign(globalThis.__ipfsDiagnostics, changes);
  }, changes);

test("the Nodes menu says when an external gateway can't be verified", async ({
  electronApp,
  window,
}) => {
  await externalGateway(electronApp, {
    progress: '{"active":[],"events":[]}',
    externalGateway: 'http://127.0.0.1:8080',
    externalVersion: null,
    externalNodeStats: null,
    externalSupport: { raw: false, car: false },
    externalVerify: true,
  });

  await window.locator('#bee-menu-button').click();
  const notice = window.locator('#ipfs-unverifiable-notice');
  await expect(window.locator('.ipfs-info:has(#ipfs-unverifiable-notice)')).toHaveClass(
    /\bexternal\b/
  );
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  await expect(notice).toHaveAttribute('role', 'status');

  // "Verify content from this node" off: nothing is verified anyway, and
  // Settings says so; the menu adds nothing.
  await setDiagnostics(electronApp, { externalVerify: false });
  await expect(notice).toBeHidden();
  await setDiagnostics(electronApp, { externalVerify: true });
  await expect(notice).toBeVisible();

  // A gateway with raw blocks, and one whose probe hasn't run.
  await setDiagnostics(electronApp, { externalSupport: { raw: true, car: false } });
  await expect(notice).toBeHidden();
  await setDiagnostics(electronApp, { externalSupport: { raw: false, car: false } });
  await expect(notice).toBeVisible();
  await setDiagnostics(electronApp, { externalSupport: null });
  await expect(notice).toBeHidden();
});

test("the unverifiable gateway's notice closes with the menu and goes with the gateway", async ({
  electronApp,
  window,
}) => {
  await externalGateway(electronApp, {
    progress: '{"active":[],"events":[]}',
    externalGateway: 'http://127.0.0.1:8080',
    externalVersion: null,
    externalNodeStats: null,
    externalSupport: { raw: false, car: false },
    externalVerify: true,
  });

  const menuButton = window.locator('#bee-menu-button');
  const notice = window.locator('#ipfs-unverifiable-notice');
  await menuButton.click();
  await expect(notice).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(notice).toBeHidden();
  await menuButton.click();
  await expect(notice).toBeVisible();

  // The profile back on its managed node, the menu still open.
  await electronApp.evaluate(() => {
    process.mainModule.require('./src/main/service-registry').updateService('ipfs', {
      api: null,
      gateway: null,
      mode: 'bundled',
      backend: 'freedom-ipfs',
    });
    globalThis.__ipfsDiagnostics = { nativeGatewayStats: '{"active_native_handles":0}' };
  });
  await expect(window.locator('.ipfs-info:has(#ipfs-unverifiable-notice)')).not.toHaveClass(
    /\bexternal\b/
  );
  await expect(notice).toBeHidden();
});
