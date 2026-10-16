const http = require('http');
const { test, expect, profileId } = require('../codex-subscription-fixtures');

const CONFIRMATION = 'Saved Ada Lovelace for Freedom — trusted input=true click=true';
const WAIT_SENTINEL = 'FREEDOM_CODEX_WAIT_SENTINEL_THAT_NEVER_APPEARS';

let server;
let baseUrl;

test.skip(
  !profileId,
  'FREEDOM_CODEX_TEST_PROFILE is not set; live subscription tests require an authenticated named profile'
);

function pageHtml(body) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/registration') {
      response.end(
        pageHtml(`
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
          </script>`)
      );
      return;
    }
    response.end(
      pageHtml(`
        <title>Agent cancellation fixture</title>
        <main><h1>Waiting room</h1><p>The requested sentinel is absent.</p></main>`)
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

async function navigate(window, url) {
  const addressInput = window.locator('[data-test="address-input"]');
  await addressInput.click();
  await addressInput.fill(url);
  await addressInput.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '')
    )
    .toBe(url);
}

async function openConfiguredAgent(window) {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await expect(window.locator('#agent-provider-status')).toContainText('ChatGPT (Codex)');
  await expect(window.locator('#agent-provider-select')).toHaveValue('openai-codex');
}

async function runTask(window, prompt) {
  await window.locator('#agent-prompt').fill(prompt);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await window.locator('#agent-run').click();
    await expect
      .poll(async () => {
        const status = (await window.locator('#agent-run-status').textContent())?.trim() || '';
        const message = (await window.locator('#agent-run-message').textContent())?.trim() || '';
        return status !== 'Idle' || Boolean(message);
      })
      .toBe(true);
    const status = (await window.locator('#agent-run-status').textContent())?.trim() || '';
    if (status !== 'Idle') return;
    const message =
      (await window.locator('#agent-run-message').textContent())?.trim() || 'unknown start error';
    if (!message.includes('not ready for the agent')) {
      throw new Error(`Agent run did not start: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Agent run did not start after the tab readiness retry window');
}

async function evaluationState(window, startedAt) {
  const operations = (await window.locator('.agent-tool-item').allTextContents()).map((label) =>
    label.replace(/^[•✓×]\s*/, '')
  );
  return {
    durationMs: Date.now() - startedAt,
    assistantOutput: (await window.locator('#agent-output').textContent())?.trim() || '',
    toolCalls: operations.length,
    operations,
    toolStates: await window.locator('.agent-tool-state').allTextContents(),
  };
}

async function recordEvaluation(name, evaluation) {
  await test.info().attach(name, {
    body: JSON.stringify(evaluation, null, 2),
    contentType: 'application/json',
  });
  console.log(`[Codex subscription evaluation] ${name} ${JSON.stringify(evaluation)}`);
}

test('completes the deterministic visible form task autonomously', async ({ window }) => {
  test.setTimeout(5 * 60_000);
  const pageUrl = `${baseUrl}/registration`;
  await navigate(window, pageUrl);
  await openConfiguredAgent(window);

  const startedAt = Date.now();
  await runTask(
    window,
    'Register Ada Lovelace for the Freedom project on this page. Submit the registration, wait until the page confirms it was saved, then report the exact confirmation.'
  );
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', {
    timeout: 4 * 60_000,
  });

  const pageConfirmation = await window.evaluate(() =>
    document
      .querySelector('webview:not(.hidden)')
      ?.executeJavaScript('document.querySelector("#confirmation").textContent')
  );
  const evaluation = {
    completed: pageConfirmation === CONFIRMATION,
    pageConfirmation,
    ...(await evaluationState(window, startedAt)),
  };
  await recordEvaluation('deterministic-form', evaluation);

  expect(pageConfirmation).toBe(CONFIRMATION);
  expect(evaluation.assistantOutput).toContain('Saved Ada Lovelace for Freedom');
  expect(evaluation.toolStates).not.toContain('×');
  expect(evaluation.toolCalls).toBeGreaterThanOrEqual(4);
});

test('Stop cancels a real Codex model stream and leaves the agent reusable', async ({
  window,
}) => {
  test.setTimeout(5 * 60_000);
  await navigate(window, `${baseUrl}/streaming`);
  await openConfiguredAgent(window);

  await runTask(
    window,
    'Without using browser tools, write a detailed 2,000-word explanation of how semantic browser automation works. Begin immediately.'
  );
  await expect(window.locator('#agent-output')).not.toHaveText('', { timeout: 2 * 60_000 });
  const startedAt = Date.now();
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'stop');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped', { timeout: 15_000 });
  const cancellationMs = Date.now() - startedAt;
  await recordEvaluation('stream-cancellation', { cancellationMs });

  expect(cancellationMs).toBeLessThan(15_000);
  await expect(window.locator('#agent-run')).toBeDisabled();
});

test('Stop cancels a real Codex declarative browser wait', async ({ window }) => {
  test.setTimeout(5 * 60_000);
  await navigate(window, `${baseUrl}/waiting`);
  await openConfiguredAgent(window);

  await runTask(
    window,
    `Use browser_wait to wait for the exact text "${WAIT_SENTINEL}" for 30000 milliseconds. Do not answer or perform another action until that wait finishes.`
  );
  const waitRow = window.locator('.agent-tool-item').filter({ hasText: /wait/i }).last();
  await expect(waitRow).toBeVisible({ timeout: 2 * 60_000 });
  const startedAt = Date.now();
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'stop');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped', { timeout: 15_000 });
  const cancellationMs = Date.now() - startedAt;
  await recordEvaluation('wait-cancellation', {
    cancellationMs,
    ...(await evaluationState(window, startedAt)),
  });

  expect(cancellationMs).toBeLessThan(15_000);
  await expect(window.locator('#agent-run')).toBeDisabled();
});

test('reads one harmless public page without side effects', async ({ window }) => {
  test.setTimeout(5 * 60_000);
  await navigate(window, 'https://example.com/');
  await openConfiguredAgent(window);

  const startedAt = Date.now();
  await runTask(
    window,
    'Read the current page and report its exact main heading plus the sentence explaining what this domain is for. Do not navigate, click, type, or submit anything.'
  );
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', {
    timeout: 4 * 60_000,
  });
  const evaluation = await evaluationState(window, startedAt);
  await recordEvaluation('public-example-domain', evaluation);

  expect(evaluation.assistantOutput).toContain('Example Domain');
  expect(evaluation.toolStates).not.toContain('×');
  expect(evaluation.toolCalls).toBeGreaterThanOrEqual(1);
});
