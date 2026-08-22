const http = require('http');
const { test, expect } = require('./fixtures');

const MODEL_ID = 'freedom-cancellation-fixture';
const SLOW_NAVIGATION_URL = 'https://agent-cancellation.test/slow-navigation';

let server;
let baseUrl;
let streamingResponseClosed = false;

function completionChunk({ delta = {}, finishReason = null, usage }) {
  return {
    id: 'chatcmpl_freedom_fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage && { usage }),
  };
}

function writeSse(response, chunk) {
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function finishSse(response, finishReason = 'stop') {
  writeSse(
    response,
    completionChunk({
      finishReason,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  );
  response.end('data: [DONE]\n\n');
}

function toolCallChunk(name, argumentsJson) {
  return completionChunk({
    delta: {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call_${name}`,
          type: 'function',
          function: { name, arguments: argumentsJson },
        },
      ],
    },
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function userPrompt(body) {
  const message = [...(body.messages || [])]
    .reverse()
    .find((candidate) => candidate?.role === 'user');
  return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
}

function lastToolCallId(body) {
  const message = [...(body.messages || [])]
    .reverse()
    .find((candidate) => candidate?.role === 'tool');
  return typeof message?.tool_call_id === 'string' ? message.tool_call_id : '';
}

async function handleCompletion(request, response) {
  const body = await readJsonBody(request);
  const prompt = userPrompt(body);
  const toolCallId = lastToolCallId(body);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (prompt.includes('STREAM_CANCEL')) {
    writeSse(response, completionChunk({ delta: { role: 'assistant' } }));
    writeSse(response, completionChunk({ delta: { content: 'Streaming fixture started' } }));
    response.on('close', () => {
      streamingResponseClosed = true;
    });
    return;
  }

  if (prompt.includes('NAV_CANCEL')) {
    writeSse(
      response,
      toolCallChunk('browser_navigate', JSON.stringify({ url: SLOW_NAVIGATION_URL }))
    );
    finishSse(response, 'tool_calls');
    return;
  }

  if (prompt.includes('WAIT_CANCEL')) {
    writeSse(
      response,
      toolCallChunk(
        'browser_wait',
        JSON.stringify({ condition: 'text', text: 'TEXT_THAT_NEVER_APPEARS', timeoutMs: 30_000 })
      )
    );
    finishSse(response, 'tool_calls');
    return;
  }

  if (prompt.includes('The user resumed this task')) {
    if (!toolCallId) {
      writeSse(response, toolCallChunk('browser_get_tab', '{}'));
      finishSse(response, 'tool_calls');
      return;
    }
    if (toolCallId === 'call_browser_get_tab') {
      writeSse(response, toolCallChunk('browser_snapshot', '{}'));
      finishSse(response, 'tool_calls');
      return;
    }
    writeSse(response, completionChunk({ delta: { role: 'assistant', content: 'RESUMED' } }));
    finishSse(response);
    return;
  }

  writeSse(response, completionChunk({ delta: { role: 'assistant', content: 'READY' } }));
  finishSse(response);
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      handleCompletion(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
});

async function configureFixtureProvider(window) {
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await window.locator('#agent-provider-select').selectOption('ollama');
  await window.locator('#agent-ollama-model').fill(MODEL_ID);
  await window.locator('#agent-ollama-url').fill(`${baseUrl}/v1`);
  await window.locator('#agent-provider-save').click();
  await expect(window.locator('#agent-provider-status')).toContainText(`Ollama · ${MODEL_ID}`);
  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
}

async function takeOverAndExpectReusable(window) {
  const startedAt = Date.now();
  await window.locator('#agent-stop').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Taken over', { timeout: 3_000 });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  await expect(window.locator('#agent-run-message')).toHaveText('You took control of the tab');
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);

  await window.locator('#agent-prompt').fill('AFTER_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('READY');
}

test('Take over cancels a streaming provider request', async ({ window }) => {
  streamingResponseClosed = false;
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');

  await takeOverAndExpectReusable(window);
  await expect.poll(() => streamingResponseClosed).toBe(true);
});

test('Pause preserves the Pi session and resume re-observes the page', async ({ window }) => {
  streamingResponseClosed = false;
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');

  await window.locator('#agent-pause').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Paused', { timeout: 3_000 });
  await expect(window.locator('#agent-resume')).toBeVisible();
  await expect(window.locator('#agent-stop')).toBeEnabled();
  await expect(window.locator('[data-test="tab"].active')).toHaveClass(/agent-controlled/);
  await expect.poll(() => streamingResponseClosed).toBe(true);

  await window.locator('#agent-resume').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toContainText('RESUMED');
  await expect(window.locator('.agent-tool-item')).toContainText(['get tab', 'snapshot']);
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);
});

test('Pause cancels an active browser wait and the same run can resume', async ({ window }) => {
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('WAIT_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('wait');

  await window.locator('#agent-pause').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Paused', { timeout: 3_000 });
  await expect(window.locator('[data-test="tab"].active')).toHaveClass(/agent-controlled/);

  await window.locator('#agent-resume').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toContainText('RESUMED');
});

test('closing the controlled tab immediately aborts the active run', async ({ window }) => {
  streamingResponseClosed = false;
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');
  await expect(window.locator('[data-test="tab"].agent-controlled')).toHaveCount(1);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);

  const startedAt = Date.now();
  await window.locator('[data-test="tab"].agent-controlled [data-test="tab-close"]').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Tab closed', { timeout: 3_000 });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  await expect(window.locator('#agent-run-message')).toHaveText(
    'The controlled browser tab was closed'
  );
  await expect(window.locator('#agent-run')).toBeEnabled();
  await expect(window.locator('#agent-stop')).toBeDisabled();
  await expect.poll(() => streamingResponseClosed).toBe(true);

  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
  await window.locator('#agent-prompt').fill('AFTER_TAB_CLOSE');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('READY');
});

test('Take over cancels an in-flight browser navigation', async ({ window, harness }) => {
  await harness.setContentFixture(SLOW_NAVIGATION_URL, {
    body: '<!doctype html><title>Still loading</title><p>Navigation started</p>',
    holdOpen: true,
  });
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('NAV_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('navigate');
  await expect
    .poll(async () => (await harness.state()).contentActivity[SLOW_NAVIGATION_URL]?.started)
    .toBe(1);
  expect((await harness.state()).contentActivity[SLOW_NAVIGATION_URL].cancelled).toBe(0);

  await takeOverAndExpectReusable(window);
  await expect
    .poll(async () => (await harness.state()).contentActivity[SLOW_NAVIGATION_URL]?.cancelled)
    .toBe(1);
});

test('Take over cancels an active declarative wait', async ({ window }) => {
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('WAIT_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('wait');

  await takeOverAndExpectReusable(window);
});
