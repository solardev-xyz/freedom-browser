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
  await expect(page).toHaveURL(/#ai\/providers$/);
  await expect(page.locator('#agent-provider-add')).toBeVisible();
  return page;
}

async function closeProviderSettings(window) {
  await expect
    .poll(() =>
      window.evaluate(() =>
        document.querySelector('webview:not(.hidden)')?.getURL().includes('/pages/settings.html')
      )
    )
    .toBe(true);
  await window.locator('.tab.active .tab-close').click();
  await expect
    .poll(() =>
      window.evaluate(() =>
        document.querySelector('webview:not(.hidden)')?.getURL().includes('/pages/settings.html')
      )
    )
    .toBe(false);
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
}
module.exports.openProviderSettings = openProviderSettings;
module.exports.closeProviderSettings = closeProviderSettings;
