const { test, expect } = require('./fixtures');

const OLLAMA_MODEL = process.env.FREEDOM_OLLAMA_TEST_MODEL?.trim();
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const EVALUATION_PAGE_URL = 'https://agent-evaluation.test/ollama-registration';
const CONFIRMATION = 'Saved Ada Lovelace for Freedom — trusted input=true click=true';

test.skip(
  !OLLAMA_MODEL,
  'FREEDOM_OLLAMA_TEST_MODEL is not set; local model qualification is opt-in'
);

async function prepareEvaluationPage(window, harness) {
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
}

async function configureOllama(window) {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('ollama');
  await window.locator('#agent-ollama-model').fill(OLLAMA_MODEL);
  await window.locator('#agent-ollama-url').fill(OLLAMA_BASE_URL);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(`Ollama · ${OLLAMA_MODEL}`);
}

test('Ollama independently completes the deterministic visible form task', async ({
  window,
  harness,
}) => {
  test.setTimeout(5 * 60_000);
  await prepareEvaluationPage(window, harness);
  await configureOllama(window);

  const startedAt = Date.now();
  await window
    .locator('#agent-prompt')
    .fill(
      'Complete this form on the current page. Enter exactly "Ada Lovelace" in Full name and exactly "Freedom" in Project. Submit the registration, wait until the page confirms it was saved, then report the exact confirmation.'
    );
  await window.locator('#agent-run').click();
  await expect
    .poll(async () => (await window.locator('#agent-run-status').textContent())?.trim() || '', {
      timeout: 4 * 60_000,
    })
    .toMatch(/^(Complete|failed)$/);

  const pageConfirmation = await window.evaluate(() =>
    document
      .querySelector('webview:not(.hidden)')
      ?.executeJavaScript('document.querySelector("#confirmation").textContent')
  );
  const operations = (await window.locator('.agent-tool-item').allTextContents()).map((label) =>
    label.replace(/^[•✓×]\s*/, '')
  );
  const toolStates = await window.locator('.agent-tool-state').allTextContents();
  const evaluation = {
    model: OLLAMA_MODEL,
    runStatus: (await window.locator('#agent-run-status').textContent())?.trim() || '',
    runMessage: (await window.locator('#agent-run-message').textContent())?.trim() || '',
    completed: pageConfirmation === CONFIRMATION,
    durationMs: Date.now() - startedAt,
    pageConfirmation,
    assistantOutput: (await window.locator('#agent-output').textContent())?.trim() || '',
    toolCalls: operations.length,
    operations,
    toolStates,
    failedToolCalls: toolStates.filter((state) => state === '×').length,
    recoveredAfterToolFailure: toolStates.includes('×') && toolStates.at(-1) === '✓',
  };
  await test.info().attach('ollama-evaluation', {
    body: JSON.stringify(evaluation, null, 2),
    contentType: 'application/json',
  });
  console.log(`[Ollama evaluation] ${JSON.stringify(evaluation)}`);

  expect(pageConfirmation).toBe(CONFIRMATION);
  expect(evaluation.assistantOutput).toContain('Saved Ada Lovelace for Freedom');
  expect(evaluation.toolCalls).toBeGreaterThanOrEqual(4);
  expect(evaluation.toolStates.at(-1)).toBe('✓');
  test.info().annotations.push({ type: 'evaluation', description: JSON.stringify(evaluation) });
});
