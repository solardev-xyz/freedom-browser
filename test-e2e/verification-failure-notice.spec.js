// freedom-core design 0009, Failures: "The nodes panel counts verification
// failures per backend and shows "Your external node served content that
// failed verification" while any occurred in the last 10 minutes. The notice
// informs the user; it switches nothing."
//
// Renderer wiring with main's real count: the test counts failures in main's
// `dweb/verify-failures.js` as `verify-executor.js` does for a failed check,
// and the Nodes menu reads it through the status its sections already poll:
// the IPFS section from a synthetic external gateway status (as
// `ipfs-unverifiable-gateway.spec.js` drives it), the Swarm section from
// `ant:getStatus`. `verify-executor.test.js` covers which failures count, and
// `verify-failures.test.js` the 10-minute window.
const { test, expect } = require('./fixtures');

const NOTICE = 'Your external node served content that failed verification';
const GATEWAY = 'http://127.0.0.1:8080';
const ANT = 'http://127.0.0.1:1633';

// The profile on an external gateway and a reused Ant, and the two status
// handlers the Nodes menu polls, each reading main's count for the node
// serving now: the gateway's as `getNativeDiagnostics()` reads it, the Swarm
// node's through ant-manager's own reader, as its handler does.
async function externalNodes(app) {
  await app.evaluate(
    ({ ipcMain }, { gateway, ant }) => {
      const req = process.mainModule.require;
      const registry = req('./src/main/service-registry');
      const { verificationFailures } = req('./src/main/dweb/verify-failures');
      const { externalVerifyFailures } = req('./src/main/ant-manager');
      registry.updateService('ipfs', {
        api: null,
        gateway,
        externalGateway: gateway,
        mode: 'external',
        backend: 'external-gateway',
      });
      registry.updateService('ant', { api: ant, gateway: ant, mode: 'reused' });
      globalThis.__gatewayUrl = gateway;
      ipcMain.removeHandler('ipfs:getStatus');
      ipcMain.handle('ipfs:getStatus', () => ({
        status: 'running',
        error: null,
        diagnostics: {
          progress: '{"active":[],"events":[]}',
          externalGateway: globalThis.__gatewayUrl,
          externalVersion: null,
          externalNodeStats: null,
          externalSupport: { raw: true, car: true },
          externalVerify: true,
          externalVerifyFailures: verificationFailures('gateway', globalThis.__gatewayUrl),
        },
      }));
      ipcMain.removeHandler('ant:getStatus');
      ipcMain.handle('ant:getStatus', () => ({
        status: 'running',
        error: null,
        externalVerifyFailures: externalVerifyFailures(),
      }));
    },
    { gateway: GATEWAY, ant: ANT }
  );
}

// A verified request on `kind`'s node whose content failed its check, as
// verify-executor.js counts it against the backend the request captured.
const failVerification = (app, kind, url) =>
  app.evaluate(
    (_electron, { kind, url }) => {
      const { noteVerificationFailure } = process.mainModule.require(
        './src/main/dweb/verify-failures'
      );
      const ref =
        kind === 'ant'
          ? { ant: 'external', up: true, verify: true }
          : { ipfs: 'gateway', up: true, verify: true };
      noteVerificationFailure({ ref, url });
    },
    { kind, url }
  );

// The 10 minutes passing, without waiting for them.
const windowPasses = (app) =>
  app.evaluate(() => {
    process.mainModule.require('./src/main/dweb/verify-failures')._resetVerificationFailures();
  });

test.afterEach(async ({ electronApp }) => {
  await windowPasses(electronApp);
});

test('the Nodes menu says when an external gateway served content that failed verification', async ({
  electronApp,
  window,
}) => {
  await externalNodes(electronApp);
  const notice = window.locator('#ipfs-verify-failed-notice');
  const swarmNotice = window.locator('#bee-verify-failed-notice');

  await window.locator('#bee-menu-button').click();
  await expect(window.locator('.ipfs-info:has(#ipfs-verify-failed-notice)')).toHaveClass(
    /\bexternal\b/
  );
  await expect(notice).toBeHidden();

  await failVerification(electronApp, 'gateway', GATEWAY);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  await expect(notice).toHaveAttribute('role', 'status');
  // Per backend: the Swarm node failed nothing.
  await expect(swarmNotice).toBeHidden();
  // #1012's line is its own: this gateway serves raw blocks.
  await expect(window.locator('#ipfs-unverifiable-notice')).toBeHidden();

  // Another gateway's failure (a request captured before a switch) isn't
  // this one's; the window passing clears it at the next poll.
  await windowPasses(electronApp);
  await expect(notice).toBeHidden();
  await failVerification(electronApp, 'gateway', 'https://other.example');
  await expect(notice).toBeHidden();

  // Closing the menu hides it; the next open reads again.
  await failVerification(electronApp, 'gateway', GATEWAY);
  await expect(notice).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(notice).toBeHidden();
  await window.locator('#bee-menu-button').click();
  await expect(notice).toBeVisible();
});

test('the Nodes menu says when the external Swarm node served content that failed verification', async ({
  electronApp,
  window,
}) => {
  await externalNodes(electronApp);
  const menuButton = window.locator('#bee-menu-button');
  const notice = window.locator('#bee-verify-failed-notice');

  await failVerification(electronApp, 'ant', ANT);
  // Read when the section opens.
  await menuButton.click();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(window.locator('#ipfs-verify-failed-notice')).toBeHidden();

  // The window passing clears it at the Swarm section's 5 s status poll.
  await windowPasses(electronApp);
  await expect(notice).toBeHidden({ timeout: 12_000 });

  // The profile back on the bundled Swarm node: none of the external one's.
  await failVerification(electronApp, 'ant', ANT);
  await window.keyboard.press('Escape');
  await electronApp.evaluate(() => {
    process.mainModule
      .require('./src/main/service-registry')
      .updateService('ant', { mode: 'bundled' });
  });
  await menuButton.click();
  await expect(window.locator('.bee-info')).toHaveClass(/\bvisible\b/);
  await expect(notice).toBeHidden();
});
