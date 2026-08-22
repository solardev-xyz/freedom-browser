const { test, expect } = require('./fixtures');

test('Agent, wallet, and menu actions remain on the address-bar row', async ({ window }) => {
  const geometry = await window.evaluate(() => {
    const rect = (selector) => {
      const { top, bottom, height } = document.querySelector(selector).getBoundingClientRect();
      return { top, bottom, center: top + height / 2 };
    };
    return {
      toolbar: rect('.toolbar'),
      address: rect('[data-test="address-input"]'),
      agent: rect('[data-test="agent-toggle-btn"]'),
      wallet: rect('#wallet-toggle-btn'),
      menu: rect('#menu-button'),
    };
  });

  expect(Math.abs(geometry.agent.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.wallet.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.menu.center - geometry.address.center)).toBeLessThanOrEqual(1);
  expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.toolbar.top);
  expect(geometry.menu.bottom).toBeLessThanOrEqual(geometry.toolbar.bottom);
});

test('Agent sidebar configures hosted and local models and reports the run lifecycle', async ({
  window,
}) => {
  const toggle = window.locator('[data-test="agent-toggle-btn"]');
  const panel = window.locator('#agent-sidebar');

  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).not.toHaveClass(/collapsed/);
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-workspace-view')).toBeHidden();
  await expect(window.locator('#agent-sidebar-title')).toHaveText('Set up Agent');
  await expect(window.locator('#agent-provider-status')).toHaveText('Not configured');

  await window.locator('#agent-provider-select').selectOption('freepi');
  await expect(window.locator('#agent-provider-privacy')).toContainText('sent to Free Pi');
  await expect(window.locator('#agent-provider-privacy')).toContainText('sensitive information');
  await expect(window.locator('#agent-model-select')).toHaveValue('deepseek/deepseek-v4-flash');
  await window.locator('#agent-api-key').fill('test-only-not-a-credential');
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(
    'Free Pi · deepseek/deepseek-v4-flash'
  );
  await expect(window.locator('#agent-api-key')).toHaveValue('');
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-setup-view')).toBeHidden();
  await expect(window.locator('#agent-active-model-label')).toHaveText('DeepSeek V4 Flash');
  await window.locator('#agent-approval-mode-button').click();
  await expect(window.locator('#agent-approval-mode-popover')).toBeVisible();
  await expect(window.locator('#agent-approval-mode-every')).toContainText(
    'Ask before every interaction'
  );
  await expect(window.locator('#agent-approval-mode-sensitive')).toBeDisabled();
  await expect(window.locator('#agent-approval-mode-sensitive')).toContainText('Coming soon');
  await expect(window.locator('#agent-approval-mode-allow')).toContainText(
    'Allow website interactions'
  );

  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu')).toBeVisible();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-setup-view')).toBeVisible();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Free Pi');

  await window.locator('#agent-provider-select').selectOption('openai-codex');
  await expect(window.locator('#agent-provider-privacy')).toContainText(
    'through your ChatGPT subscription'
  );
  await expect(window.locator('#agent-subscription-fields')).not.toHaveClass(/hidden/);
  await expect(window.locator('#agent-api-key-field')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-provider-save')).toBeHidden();
  await expect(window.locator('#agent-provider-login')).toHaveText('Continue with ChatGPT');
  await expect(window.locator('#agent-model-select')).not.toHaveValue('');

  await window.locator('#agent-provider-select').selectOption('ollama');
  await expect(window.locator('#agent-provider-privacy')).toHaveText(
    'Model requests stay on this device and are sent only to your local Ollama server.'
  );
  await expect(window.locator('#agent-hosted-fields')).toHaveClass(/hidden/);
  await expect(window.locator('#agent-ollama-fields')).not.toHaveClass(/hidden/);
  await window.locator('#agent-ollama-model').fill('freedom-e2e-no-server');
  await window.locator('#agent-provider-save').click();

  await expect(window.locator('#agent-provider-status')).toContainText(
    'Ollama · freedom-e2e-no-server'
  );
  await expect(window.locator('#agent-provider-message')).toHaveText(
    'Model saved for this profile'
  );
  await expect(window.locator('#agent-workspace-view')).toBeVisible();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await expect(window.locator('#agent-model-menu-list')).toContainText('DeepSeek V4 Flash');
  await expect(window.locator('#agent-model-menu-list')).toContainText('freedom-e2e-no-server');
  await window.getByRole('menuitemradio', { name: 'DeepSeek V4 Flash' }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText('DeepSeek V4 Flash');
  await window.locator('#agent-model-menu-button').click();
  await window.getByRole('menuitemradio', { name: 'freedom-e2e-no-server' }).click();
  await expect(window.locator('#agent-active-model-label')).toHaveText('freedom-e2e-no-server');
  await window.locator('#agent-model-menu-button').click();
  await window.locator('#agent-manage-providers').click();
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Free Pi');
  await expect(window.locator('#agent-connected-provider-list')).toContainText('Ollama');
  await window.locator('#agent-sidebar-back').click();

  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
  await window.locator('#agent-prompt').fill('Summarize this page');
  await expect(window.locator('#agent-stop')).toHaveText('Take over');
  const tabMarkedAtStart = await window.evaluate(() => {
    document.querySelector('#agent-run').click();
    return document.querySelector('[data-test="tab"].active').classList.contains('agent-controlled');
  });
  expect(tabMarkedAtStart).toBe(true);

  await expect(window.locator('#agent-run-status')).toHaveText('failed', { timeout: 15_000 });
  await expect(window.locator('#agent-run-message')).toHaveText(
    'The model provider request failed'
  );
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);
});
