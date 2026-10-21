const http = require('http');
const { test, expect } = require('./fixtures');

// An absent choice must remain off even when the rest of the harness opts in.
test.use({ aiEnabled: null });
let server;
let baseUrl;
let requests = 0;

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    requests += 1;
    if (request.url === '/api/tags') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: 'freedom-onboarding-fixture' }] }));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});
test.afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
});

async function guest(app, name) {
  let page;
  await expect.poll(() => {
    page = app.windows().find(page => page.url().includes(`/pages/${name}.html`));
    return Boolean(page);
  }).toBe(true);
  return page;
}

async function settings(app, window) {
  await window.locator('#address-input').fill('freedom://settings/ai');
  await window.locator('#address-input').press('Enter');
  const page = await guest(app, 'settings');
  await page.waitForLoadState('load');
  await expect(page.locator('#enable-ai')).toBeVisible();
  return page;
}

test('fresh profile discovers AI, explicitly enables it, connects in Settings and preserves its draft across disable', async ({ electronApp, window }, testInfo) => {
  const home = await guest(electronApp, 'home');
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  await expect(home.locator('#ai-invitation')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(home.locator('html')).toHaveAttribute('data-theme', theme);
    await home.screenshot({ animations: 'disabled', path: testInfo.outputPath(`home-ai-${theme}.png`) });
  }
  const before = requests;
  const blocked = await window.evaluate(() => window.electronAPI.getAgentProviderCatalog());
  expect(blocked).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
  expect(requests).toBe(before);
  await home.getByRole('link', { name: 'Explore AI' }).click();
  const page = await guest(electronApp, 'settings');
  await expect(page.locator('#enable-ai')).not.toBeChecked();
  await expect(page.locator('#ai-provider-settings')).toBeHidden();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-off-${theme}.png`) });
  }
  await page.locator('#enable-ai').check();
  await expect(window.locator('#agent-toggle-btn')).toBeVisible();
  await page.getByRole('link', { name: /Models & providers.*Connect accounts/ }).click();
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  await page.locator('#agent-provider-add').click();
  await page.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await page.locator('#agent-provider-advanced > summary').click();
  await page.locator('#agent-ollama-url').fill(baseUrl);
  await page.locator('#agent-provider-save').click();
  await expect(page.locator('#agent-provider-status')).toHaveText('Connected');
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`ai-connected-${theme}.png`) });
  }
  await page.locator('#ai-open-agent').click();
  await expect(window.locator('#agent-prompt')).toBeVisible();
  await window.locator('#agent-prompt').fill('Keep this draft while I change settings');
  // Closing the floating surface does not discard a draft.
  await window.locator('#agent-sidebar-close').click();
  await page.locator('#enable-ai').uncheck();
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  await expect(window.locator('#agent-sidebar')).toBeHidden();
  expect(await window.locator('#agent-prompt').inputValue()).toContain('Keep this draft');
  const status = await window.evaluate(() => window.electronAPI.getAgentProviderStatus());
  expect(status.status.configured).toBe(true);
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-open-agent')).toBeVisible();
  await page.locator('#ai-open-agent').click();
  await expect(window.locator('#agent-prompt')).toHaveValue('Keep this draft while I change settings');
});

test('invitation dismissal persists across a real restart without enabling AI', async ({ electronApp, window, relaunchApp }) => {
  const home = await guest(electronApp, 'home');
  await expect(home.locator('#ai-invitation')).toBeVisible();
  await home.locator('#ai-invitation-dismiss').click();
  await expect(home.locator('#ai-invitation')).toBeHidden();
  expect(await window.evaluate(() => window.electronAPI.getSettings())).toMatchObject({ enableAi: false, aiInvitationDismissed: true });
  await electronApp.close();
  const restarted = await relaunchApp();
  const restartedHome = await guest(restarted, 'home');
  await expect(restartedHome.locator('#ai-invitation')).toBeHidden();
  const chrome = await restarted.firstWindow();
  await expect(chrome.locator('#agent-toggle-btn')).toBeHidden();
});

test('AI Settings is discoverable through navigation and search at narrow width', async ({ electronApp, window }, testInfo) => {
  const page = await settings(electronApp, window);
  await expect(page.locator('.nav-item[data-target="ai"]')).toBeVisible();
  await page.locator('#settings-search').click();
  await page.locator('#settings-search').pressSequentially('Enable AI');
  await expect(page.locator('#settings-search-results')).toContainText('Enable AI features');
  await page.locator('#settings-search').fill('');
  await page.locator('#settings-search').dispatchEvent('input');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    win.setMinimumSize(320, 300);
    win.setContentSize(600, 700);
  });
  await expect(page.locator('#enable-ai')).toBeVisible();
  const bounds = await page.locator('#enable-ai').evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.right <= innerWidth && r.left >= 0;
  });
  expect(bounds).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('ai-narrow.png') });
});


test('AI subpages have breadcrumbs, history and deep links without mixing their content', async ({ electronApp, window }, testInfo) => {
  let page = await settings(electronApp, window);
  await page.locator('#enable-ai').check();
  await expect(page.locator('#ai-settings-links')).toBeVisible();
  await expect(page.locator('#agent-provider-add')).toBeHidden();
  await expect(page.locator('#voice')).toBeHidden();
  await page.getByRole('link', { name: /Models & providers.*Connect accounts/ }).click();
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#enable-ai')).toBeHidden();
  await page.locator('#agent-provider-add').click();
  await expect(page).toHaveURL(/#ai\/providers\/add$/);
  await page.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
  await expect(page).toHaveURL(/#ai\/providers\/ollama$/);
  await expect(page.locator('#ai-provider-breadcrumbs')).toHaveText('AI›Models & providers›Ollama');
  await expect(page.locator('#agent-provider-choices')).toBeHidden();
  await page.locator('#agent-provider-advanced > summary').click();
  await page.locator('#agent-ollama-url').fill(baseUrl);
  // Theme/settings broadcasts must not clear an edited connection form.
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await expect(page.locator('#agent-ollama-url')).toHaveValue(baseUrl);
    await expect(page.locator('#agent-provider-message')).not.toContainText('Loading providers');
    await page.screenshot({ path: testInfo.outputPath(`ai-provider-detail-${theme}.png`) });
  }
  await page.goBack();
  await expect(page).toHaveURL(/#ai\/providers\/add$/);
  await expect(page.locator('#agent-provider-search')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#agent-ollama-url')).toHaveValue('http://127.0.0.1:11434/v1');
  await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'AI', exact: true }).click();
  await page.getByRole('link', { name: /Voice dictation.*Choose where/ }).click();
  await expect(page).toHaveURL(/#ai\/voice$/);
  await expect(page.locator('#providers')).toBeHidden();
  await expect(page.locator('#enable-ai')).toBeHidden();
  await page.evaluate(() => { window.settingsBeforeReload = true; });
  await window.locator('#reload-btn').click();
  await expect.poll(async () => {
    page = await guest(electronApp, 'settings');
    try { return await page.evaluate(() => !window.settingsBeforeReload); }
    catch { return false; }
  }).toBe(true);
  await expect(page.locator('#ai-dictation-settings')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
    await page.screenshot({ path: testInfo.outputPath(`ai-voice-page-${theme}.png`) });
  }
  await page.evaluate(() => { location.hash = 'ai/providers/not-a-provider'; });
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  await page.evaluate(() => { location.hash = 'ai/voice'; });
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: false }));
  await expect(page).toHaveURL(/#ai$/);
  await expect(page.locator('#enable-ai')).not.toBeChecked();
  await expect(page.locator('#voice')).toBeHidden();
});
