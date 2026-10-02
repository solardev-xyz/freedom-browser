const { test, expect } = require('../live-fixtures');

const ENABLED = Boolean(process.env.FREEDOM_CODEX_TEST_PROFILE?.trim());

test.use({
  seedSettings: {
    startAntAtLaunch: false,
    startIpfsAtLaunch: false,
    enableRadicleIntegration: false,
    startRadicleAtLaunch: false,
    startTorAtLaunch: false,
  },
});

test.skip(!ENABLED, 'Set FREEDOM_CODEX_TEST_PROFILE to opt into live Codex qualification');

test('cancels real Codex device polling without configuring the disposable profile', async ({
  window,
}) => {
  test.setTimeout(2 * 60_000);
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('openai-codex');
  await expect(window.locator('#agent-model-select')).not.toHaveValue('');

  await window.locator('#agent-provider-login').click();
  await expect(window.locator('#agent-auth-user-code')).toHaveText(/[A-Z0-9-]{4,}/u, {
    timeout: 60_000,
  });
  await expect(window.locator('#agent-provider-cancel-login')).toBeVisible();

  const startedAt = Date.now();
  await window.locator('#agent-provider-cancel-login').click();
  await expect(window.locator('#agent-provider-message')).toHaveText(
    'Provider sign-in was cancelled',
    { timeout: 15_000 }
  );
  const cancellationMs = Date.now() - startedAt;

  expect(cancellationMs).toBeLessThan(15_000);
  await expect(window.locator('#agent-provider-status')).toHaveText('Not configured');
  await expect(window.locator('#agent-provider-login')).toBeVisible();
  const evaluation = { cancellationMs, configured: false };
  await test.info().attach('device-polling-cancellation', {
    body: JSON.stringify(evaluation, null, 2),
    contentType: 'application/json',
  });
  console.log(`[Codex subscription evaluation] device-polling-cancellation ${JSON.stringify(evaluation)}`);
  test.info().annotations.push({
    type: 'evaluation',
    description: JSON.stringify(evaluation),
  });
});
