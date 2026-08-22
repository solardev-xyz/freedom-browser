const { test, expect } = require('./fixtures');

const FREE_PI_API_KEY = process.env.FREEDOM_FREE_PI_TEST_API_KEY?.trim();

test.skip(
  !FREE_PI_API_KEY,
  'FREEDOM_FREE_PI_TEST_API_KEY is not set; copy .env.agent-tests.example to .env.agent-tests.local'
);

test('Free Pi completes a real embedded Agent request', async ({ window }) => {
  test.setTimeout(90_000);

  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('freepi');
  await expect(window.locator('#agent-model-select')).toHaveValue('deepseek/deepseek-v4-flash');

  await window.locator('#agent-api-key').fill(FREE_PI_API_KEY);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(
    'Free Pi · deepseek/deepseek-v4-flash'
  );
  await expect(window.locator('#agent-api-key')).toHaveValue('');

  await window
    .locator('#agent-prompt')
    .fill('Reply with exactly FREE_PI_OK. Do not use browser tools.');
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', {
    timeout: 60_000,
  });
  await expect(window.locator('#agent-output')).toContainText('FREE_PI_OK');
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
});
