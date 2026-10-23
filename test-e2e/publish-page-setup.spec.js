// freedom://publish's "Set Up Publishing" button (#719). Publishing text on a
// node with no storage shows "Publishing needs storage…" with that button; a
// click must open the wallet sidebar's publish setup. On a profile with no
// identity yet the setup screen cannot open (the sidebar shows only its
// "Set Up Your Identity" step), and the click used to do nothing at all.
//
// Driven from the real page and its real button, against the real publish
// setup service probing a fake antd that owns no storage.

const { test, expect } = require('./fixtures');
const { WALLET, startFakeAnt, wireRealService } = require('./publish-setup-fixtures');

async function openPublishPage(window, electronApp) {
  const input = window.locator('[data-test="address-input"]');
  await input.click();
  await input.fill('freedom://publish');
  await input.press('Enter');
  let page;
  await expect
    .poll(() => {
      page = electronApp.windows().find((p) => p.url().includes('/pages/publish.html'));
      return Boolean(page);
    })
    .toBe(true);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

// The issue's steps: Publish text, type, Publish, then the setup button.
async function publishTextAndClickSetup(page) {
  await page.click('#publish-text-btn');
  await page.fill('#publish-text-area', 'hello world');
  await page.click('#publish-text-submit');
  await expect(page.locator('#publish-error-text')).toHaveText(
    'Publishing needs storage. Pick a storage plan to start.'
  );
  const setup = page.locator('#publish-error-setup');
  await expect(setup).toBeVisible();
  await setup.click();
}

const sidebarOpen = (window) =>
  window.evaluate(async () => (await import('./lib/sidebar.js')).isVisible());

// Make the chrome see an identity, as after onboarding: identity:get-status
// answers with a wallet and the renderer hears `identity-ready`.
async function completeIdentity(electronApp, window) {
  await electronApp.evaluate(({ ipcMain }, wallet) => {
    ipcMain.removeHandler('identity:get-status');
    ipcMain.handle('identity:get-status', () => ({
      hasVault: true,
      isUnlocked: true,
      addresses: { userWallet: wallet },
    }));
  }, WALLET);
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('identity-ready')));
}

test.describe('freedom://publish Set Up Publishing (#719)', () => {
  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__publishSetup?.dispose();
      globalThis.__fakeAnt?.server.close();
    });
  });

  test('with no identity, opens the identity step and then the publish setup', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    const page = await openPublishPage(window, electronApp);

    await expect.poll(() => sidebarOpen(window)).toBe(false);
    await publishTextAndClickSetup(page);
    await expect.poll(() => sidebarOpen(window)).toBe(true);

    // The harness profile has no identity: the sidebar opens on its first step.
    await expect(window.locator('#sidebar-setup-cta')).toBeVisible();
    await expect(window.locator('#sidebar-publish-setup')).toBeHidden();
    await expect(window.locator('#sidebar-setup-btn')).toBeInViewport({ ratio: 1 });
    await window.screenshot({ path: test.info().outputPath('no-identity.png') });

    // Once the identity exists the click's publish setup follows.
    await completeIdentity(electronApp, window);
    await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
    await expect(window.locator('#sidebar-setup-cta')).toBeHidden();
    // No storage: the screen offers the plans.
    await expect(window.locator('#publish-setup-plans')).toBeVisible();
    await window.screenshot({ path: test.info().outputPath('setup-open.png') });
  });

  test('a later identity, without a click, does not open the publish setup', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    const page = await openPublishPage(window, electronApp);
    await publishTextAndClickSetup(page);
    await expect(window.locator('#sidebar-setup-cta')).toBeVisible();

    // The user closes the sidebar instead: the pending setup is dropped.
    await window.evaluate(async () => (await import('./lib/sidebar.js')).close());
    await completeIdentity(electronApp, window);
    await expect(window.locator('.sidebar-tabs')).toBeVisible();
    await expect(window.locator('#sidebar-publish-setup')).toBeHidden();
  });

  test('closing the onboarding dialog drops the pending publish setup', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    const page = await openPublishPage(window, electronApp);
    await publishTextAndClickSetup(page);
    await expect(window.locator('#sidebar-setup-cta')).toBeVisible();

    // Get Started, then close the dialog; the sidebar stays open.
    await window.locator('#sidebar-setup-btn').click();
    await expect(window.locator('#onboarding-modal')).toBeVisible();
    await window.locator('#onboarding-close').click();
    await expect(window.locator('#onboarding-modal')).toBeHidden();
    await expect.poll(() => sidebarOpen(window)).toBe(true);

    // An identity finished later in the session does not open the setup.
    await completeIdentity(electronApp, window);
    await expect(window.locator('.sidebar-tabs')).toBeVisible();
    await expect(window.locator('#sidebar-publish-setup')).toBeHidden();
  });

  test('with an identity, opens the publish setup', async ({ electronApp, window }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    await completeIdentity(electronApp, window);
    await expect(window.locator('.sidebar-tabs')).toBeAttached();
    const page = await openPublishPage(window, electronApp);

    await publishTextAndClickSetup(page);
    await expect(window.locator('#sidebar-publish-setup')).toBeVisible();
    // No storage: the screen offers the plans.
    await expect(window.locator('#publish-setup-plans')).toBeVisible();
  });
});

test.describe('freedom://publish with Identity & Wallet off (#719)', () => {
  test.use({ seedSettings: { enableIdentityWallet: false } });

  test.afterEach(async ({ electronApp }) => {
    await electronApp.evaluate(() => {
      globalThis.__publishSetup?.dispose();
      globalThis.__fakeAnt?.server.close();
    });
  });

  test('says where to turn the wallet on instead of offering a dead button', async ({
    electronApp,
    window,
  }) => {
    await startFakeAnt(electronApp);
    await wireRealService(electronApp);
    const page = await openPublishPage(window, electronApp);
    await page.click('#publish-text-btn');
    await page.fill('#publish-text-area', 'hello world');
    await page.click('#publish-text-submit');
    await expect(page.locator('#publish-error-text')).toHaveText(
      'Publishing needs storage. Pick a storage plan to start. Enable Identity & Wallet under Advanced to publish on Swarm.'
    );
    await expect(page.locator('#publish-error-setup')).toBeHidden();
  });
});
