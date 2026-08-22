const { test, expect } = require('./fixtures');

test('Agent sidebar configures hosted and local models and reports the run lifecycle', async ({
  window,
}) => {
  const toggle = window.locator('[data-test="agent-toggle-btn"]');
  const panel = window.locator('#agent-sidebar');

  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(panel).not.toHaveClass(/collapsed/);
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
  await window.locator('#agent-provider-clear').click();
  await expect(window.locator('#agent-provider-status')).toHaveText('Not configured');

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

  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
  await window.locator('#agent-prompt').fill('Summarize this page');
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-run-status')).toHaveText('failed', { timeout: 15_000 });
  await expect(window.locator('#agent-run-message')).toHaveText(
    'The model provider request failed'
  );
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
});
