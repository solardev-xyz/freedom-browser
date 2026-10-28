const { expect } = require('./fixtures');

// Task-focused fixtures use the same public chrome IPC as Settings. Provider
// screens themselves are exercised by ai-onboarding/custom-provider specs.
async function configureOllamaAgent(window, baseUrl) {
  const response = await window.evaluate(
    (baseUrl) => window.electronAPI.configureOllamaAgentProvider(undefined, baseUrl),
    baseUrl
  );
  expect(response?.ok).toBe(true);
  if ((await window.locator('#agent-toggle-btn').getAttribute('aria-expanded')) === 'true')
    await window.locator('#agent-sidebar-close').click();
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
}
module.exports = { configureOllamaAgent };

async function openProviderSettings(window) {
  if ((await window.locator('#agent-toggle-btn').getAttribute('aria-expanded')) === 'true')
    await window.locator('#agent-sidebar-close').click();
  await window.evaluate(() => document.getElementById('agent-open-ai-settings').click());
  let page;
  await expect
    .poll(() => {
      page = window
        .context()
        .pages()
        .find((page) => page.url().includes('/pages/settings.html'));
      return Boolean(page);
    })
    .toBe(true);
  // With no model connected the panel goes straight to the provider picker;
  // callers start from the provider list either way.
  await expect(page).toHaveURL(/#ai\/providers(\/add)?$/);
  if (/#ai\/providers\/add$/.test(page.url()))
    await page.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'Models & providers' }).click();
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  return page;
}

// Connecting the first model opens Agent on a start page, leaving Settings in
// its own background tab (#864); a later connection leaves Settings in front.
// Either way, close the Settings tab and make sure Agent is open.
async function closeProviderSettings(window) {
  const settingsTabId = () =>
    window.evaluate(() =>
      [...document.querySelectorAll('webview')]
        .find((webview) => webview.getURL().includes('/pages/settings.html'))?.dataset.tabId ?? null
    );
  await expect.poll(settingsTabId).not.toBeNull();
  const tabId = await settingsTabId();
  await window.locator(`.tab[data-tab-id="${tabId}"] .tab-close`).click();
  await expect.poll(settingsTabId).toBeNull();
  if ((await window.locator('#agent-toggle-btn').getAttribute('aria-expanded')) !== 'true')
    await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
}
module.exports.openProviderSettings = openProviderSettings;
module.exports.closeProviderSettings = closeProviderSettings;
