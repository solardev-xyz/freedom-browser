const { test, expect } = require('./fixtures');

const FREE_PI_API_KEY = process.env.FREEDOM_FREE_PI_TEST_API_KEY?.trim();
const FREE_PI_AGENT_EVAL_ENABLED = process.env.FREEDOM_FREE_PI_AGENT_EVAL === '1';
const EVALUATION_PAGE_URL = 'https://agent-evaluation.test/registration';
const EVALUATION_CONFIRMATION = 'Saved Ada Lovelace for Freedom — trusted input=true click=true';

test.skip(
  !FREE_PI_API_KEY,
  'FREEDOM_FREE_PI_TEST_API_KEY is not set; copy .env.agent-tests.example to .env.agent-tests.local'
);

async function configureFreePi(window) {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('freepi');
  await expect(window.locator('#agent-model-select')).toHaveValue('deepseek/deepseek-v4-flash');

  await window.locator('#agent-api-key').fill(FREE_PI_API_KEY);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(
    'Free Pi · deepseek/deepseek-v4-flash'
  );
  await expect(window.locator('#agent-api-key')).toHaveValue('');
}

test('Free Pi returns text through the embedded Agent', async ({ window }) => {
  test.setTimeout(90_000);

  await configureFreePi(window);

  await window.locator('#agent-prompt').fill('Say hello in one short sentence.');
  await window.locator('#agent-run').click();

  await expect(window.locator('#agent-run-status')).toHaveText('Complete', {
    timeout: 60_000,
  });
  await expect(window.locator('#agent-output')).toContainText(/hello/i);
  await expect(window.locator('#agent-run')).toBeDisabled();
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'send');
});

test.describe('Free Pi browser-tool qualification', () => {
  test.skip(
    !FREE_PI_AGENT_EVAL_ENABLED,
    'FREEDOM_FREE_PI_AGENT_EVAL is not set to 1; the current pilot model is text-only'
  );

  test('independently completes a deterministic visible form task', async ({ window, harness }) => {
    test.setTimeout(120_000);

    await harness.setContentFixture(EVALUATION_PAGE_URL, {
      body: `<!doctype html>
      <title>Agent evaluation registration</title>
      <main>
        <h1>Registration</h1>
        <label for="full-name">Full name</label>
        <input id="full-name" aria-label="Full name">
        <label for="project">Project</label>
        <input id="project" aria-label="Project">
        <button id="submit">Submit registration</button>
        <p id="confirmation">Not submitted</p>
      </main>
      <script>
        let fullNameTrusted = false;
        let projectTrusted = false;
        document.querySelector('#full-name').addEventListener('input', (event) => {
          fullNameTrusted = event.isTrusted;
        });
        document.querySelector('#project').addEventListener('input', (event) => {
          projectTrusted = event.isTrusted;
        });
        document.querySelector('#submit').addEventListener('click', (event) => {
          const fullName = document.querySelector('#full-name').value;
          const project = document.querySelector('#project').value;
          document.querySelector('#confirmation').textContent =
            'Saved ' + fullName + ' for ' + project +
            ' — trusted input=' + (fullNameTrusted && projectTrusted) +
            ' click=' + event.isTrusted;
        });
      </script>`,
    });

    const addressInput = window.locator('[data-test="address-input"]');
    await addressInput.click();
    await addressInput.fill(EVALUATION_PAGE_URL);
    await addressInput.press('Enter');
    await expect
      .poll(() =>
        window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '')
      )
      .toBe(EVALUATION_PAGE_URL);

    await configureFreePi(window);

    const startedAt = Date.now();
    await window
      .locator('#agent-prompt')
      .fill(
        'Register Ada Lovelace for the Freedom project on this page. Submit the registration, wait until the page confirms it was saved, then report the exact confirmation.'
      );
    await window.locator('#agent-run').click();

    await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 90_000 });
    const durationMs = Date.now() - startedAt;
    const pageConfirmation = await window.evaluate(() =>
      document
        .querySelector('webview:not(.hidden)')
        ?.executeJavaScript('document.querySelector("#confirmation").textContent')
    );
    const assistantOutput = (await window.locator('#agent-output').textContent())?.trim() || '';
    const toolStates = await window.locator('.agent-tool-state').allTextContents();
    const operationLabels = (await window.locator('.agent-tool-item').allTextContents()).map(
      (label) => label.replace(/^[•✓×]\s*/, '')
    );

    const evaluation = {
      runStatus: 'Complete',
      taskSucceeded: pageConfirmation === EVALUATION_CONFIRMATION,
      durationMs,
      pageConfirmation,
      assistantOutput,
      toolCalls: operationLabels.length,
      toolStates,
      operations: operationLabels,
    };
    await test.info().attach('free-pi-evaluation', {
      body: JSON.stringify(evaluation, null, 2),
      contentType: 'application/json',
    });
    console.log(`[Free Pi evaluation] ${JSON.stringify(evaluation)}`);

    expect(pageConfirmation).toBe(EVALUATION_CONFIRMATION);
    expect(assistantOutput).toContain('Saved Ada Lovelace for Freedom');
    expect(toolStates).not.toContain('×');
    expect(operationLabels.length).toBeGreaterThanOrEqual(4);
    test.info().annotations.push({
      type: 'evaluation',
      description: JSON.stringify(evaluation),
    });
  });
});
