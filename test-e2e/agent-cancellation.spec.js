const { configureOllamaAgent } = require('./agent-provider-fixture');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');

const MODEL_ID = 'freedom-cancellation-fixture';
const SLOW_NAVIGATION_URL = 'https://agent-cancellation.test/slow-navigation';
const SHARED_START_URL = 'https://agent-cancellation.test/shared-start';
const STEERING_URL = 'https://agent-cancellation.test/steering';

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

function toolCallChunk(name, argumentsJson, id = `call_${name}`) {
  return completionChunk({
    delta: {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
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

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
}

function hasUserMarker(body, marker) {
  return (body.messages || []).some(
    (message) => message?.role === 'user' && contentText(message.content).includes(marker)
  );
}

function latestSnapshotElements(body) {
  for (const message of [...(body.messages || [])].reverse()) {
    if (message?.role !== 'tool') continue;
    try {
      // Pi appends the historical-evidence note after the one-line JSON envelope.
      const envelope = JSON.parse(contentText(message.content).split('\n')[0]);
      if (Array.isArray(envelope?.result?.elements)) return envelope.result.elements;
    } catch {
      // Ignore non-snapshot tool results.
    }
  }
  return [];
}

function lastToolCallId(body) {
  const message = [...(body.messages || [])]
    .reverse()
    .find((candidate) => candidate?.role === 'tool');
  return typeof message?.tool_call_id === 'string' ? message.tool_call_id : '';
}

function toolResponsesAfterLastUser(body) {
  const messages = body.messages || [];
  const lastUserIndex = messages.findLastIndex((message) => message?.role === 'user');
  return messages.slice(lastUserIndex + 1).filter((message) => message?.role === 'tool');
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

  if (prompt.includes('STEER_DO_NOT_SUBMIT')) {
    writeSse(
      response,
      completionChunk({ delta: { role: 'assistant', content: 'STEERING_APPLIED' } })
    );
    finishSse(response);
    return;
  }

  if (hasUserMarker(body, 'STEERING_APPROVAL')) {
    const submit = latestSnapshotElements(body).find(
      (element) => element?.name === 'Submit research'
    );
    if (!submit?.ref) {
      writeSse(response, toolCallChunk('browser_snapshot', '{}'));
      finishSse(response, 'tool_calls');
      return;
    }
    writeSse(
      response,
      toolCallChunk('browser_click', JSON.stringify({ ref: submit.ref }), 'call_steering_submit')
    );
    finishSse(response, 'tool_calls');
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

  if (prompt.includes('FOLLOWUP_CONTEXT')) {
    const retainedUser = (body.messages || []).some(
      (message) =>
        message?.role === 'user' && JSON.stringify(message.content).includes('FIRST_CONTEXT')
    );
    const retainedAssistant = (body.messages || []).some(
      (message) =>
        message?.role === 'assistant' && JSON.stringify(message.content).includes('READY')
    );
    writeSse(
      response,
      completionChunk({
        delta: {
          role: 'assistant',
          content: retainedUser && retainedAssistant ? 'CONTEXT_RETAINED' : 'CONTEXT_MISSING',
        },
      })
    );
    finishSse(response);
    return;
  }

  if (prompt.includes('CREATE_FIVE_TASK_TABS')) {
    const createdCount = toolResponsesAfterLastUser(body).length;
    if (createdCount < 5) {
      const articleNumber = createdCount + 1;
      writeSse(
        response,
        toolCallChunk(
          'browser_create_tab',
          JSON.stringify({ url: `https://agent-tabs.test/article-${articleNumber}` }),
          `call_create_${articleNumber}`
        )
      );
      finishSse(response, 'tool_calls');
      return;
    }
    writeSse(
      response,
      completionChunk({ delta: { role: 'assistant', content: 'FIVE_TABS_READY' } })
    );
    finishSse(response);
    return;
  }

  if (prompt.includes('AFTER_ORIGINAL_CLOSE')) {
    writeSse(
      response,
      completionChunk({ delta: { role: 'assistant', content: 'CHAT_CONTINUED' } })
    );
    finishSse(response);
    return;
  }

  if (prompt.includes('AFTER_ALL_TASK_TABS_CLOSE')) {
    if (toolResponsesAfterLastUser(body).length === 0) {
      writeSse(
        response,
        toolCallChunk(
          'browser_create_tab',
          JSON.stringify({ url: 'https://agent-tabs.test/fresh-workspace' }),
          'call_create_fresh_workspace'
        )
      );
      finishSse(response, 'tool_calls');
      return;
    }
    writeSse(
      response,
      completionChunk({ delta: { role: 'assistant', content: 'FRESH_WORKSPACE_READY' } })
    );
    finishSse(response);
    return;
  }

  writeSse(response, completionChunk({ delta: { role: 'assistant', content: 'READY' } }));
  finishSse(response);
}

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: MODEL_ID }] }));
      return;
    }
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
  await configureOllamaAgent(window, `${baseUrl}/v1`);
  await expect(window.locator('#agent-active-model-label')).toHaveText(MODEL_ID);
  await chooseApprovalMode(window, '#agent-approval-mode-every');
  await window.locator('webview:not(.hidden)').waitFor({ state: 'attached' });
}

// Leaving setup moves the floating conversation from its column into the
// centred launcher, which plays Web Animations on the panel and composer. On
// slow CI desktops the menu click could land while that settled and the menu
// was not open afterwards (a 30s wait for its option, then a pass on retry).
// Let the move finish, then confirm the menu actually opened before choosing.
async function chooseApprovalMode(window, option) {
  const button = window.locator('#agent-approval-mode-button');
  const popover = window.locator('#agent-approval-mode-popover');
  await expect
    .poll(() =>
      window.evaluate(() =>
        document.getAnimations().filter((animation) =>
          animation.playState === 'running' &&
          animation.effect?.getComputedTiming().iterations !== Infinity
        ).length
      )
    )
    .toBe(0);
  await expect(async () => {
    if (await popover.isHidden()) await button.click();
    await expect(popover).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await window.locator(option).click();
  await expect(popover).toBeHidden();
  await expect(window.locator(option)).toHaveAttribute('aria-pressed', 'true');
}

async function openSharedStartPage(window, harness) {
  await harness.setContentFixture(SHARED_START_URL, {
    body: '<!doctype html><title>Shared start</title><p>Shared Agent context</p>',
  });
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(SHARED_START_URL);
  await address.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '')
    )
    .toBe(SHARED_START_URL);
  await expect(window.locator('#agent-page-contexts')).not.toHaveAttribute('hidden', '');
}

async function stopAndExpectReusable(window) {
  const startedAt = Date.now();
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'stop');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped', { timeout: 3_000 });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  await expect(window.locator('#agent-run-message')).toHaveText('Agent stopped.');
  await expect(window.locator('#agent-prompt')).toBeEnabled();
  await expect(window.locator('#agent-run')).toBeDisabled();
  await expect(window.locator('#agent-new-chat')).toBeEnabled();
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);

  await window.locator('#agent-prompt').fill('AFTER_CANCEL');
  await expect(window.locator('#agent-run')).toBeEnabled();
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('READY');
}

async function takeOverControlledPage(window) {
  const interlock = window.locator('[data-test="agent-page-interlock"]');
  await expect(interlock).toBeVisible();
  await interlock.click({ position: { x: 10, y: 10 } });
  await expect(window.locator('#agent-takeover-dialog')).toBeVisible();
  await window.locator('#agent-takeover-confirm').click();
  await expect(window.locator('#agent-run-status')).toHaveText('You’re in control', {
    timeout: 3_000,
  });
}

test('Stop cancels a streaming provider request', async ({ window }) => {
  streamingResponseClosed = false;
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');

  await stopAndExpectReusable(window);
  await expect.poll(() => streamingResponseClosed).toBe(true);
});

test('turning AI off aborts a streaming request and restores the conversation after re-enabling', async ({ window }) => {
  streamingResponseClosed = false;
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: false }));
  await expect(window.locator('#agent-toggle-btn')).toBeHidden();
  await expect(window.locator('#agent-sidebar')).toBeHidden();
  await expect.poll(() => streamingResponseClosed).toBe(true);
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped');
  const state = await window.evaluate(() => window.electronAPI.getAgentState());
  expect(state.state.status).toBe('ready');
  const blocked = await window.evaluate(() => window.electronAPI.startAgent({ rendererTabId: 1, prompt: 'Should not run' }));
  expect(blocked).toMatchObject({ ok: false, error: { code: 'AGENT_DISABLED' } });
  await window.evaluate(() => window.electronAPI.saveSettings({ enableAi: true }));
  await window.locator('#agent-toggle-btn').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');
  await window.locator('#agent-prompt').fill('AFTER_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete');
  await expect(window.locator('.agent-output').last()).toHaveText('READY');
});

test('a project chat persists its first model and resumes it after a real restart despite a different default', async ({ electronApp, window, relaunchApp }) => {
  await configureFixtureProvider(window);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-model-pin-project-'));
  test.info().annotations.push({ type: 'fixture', description: project });
  await electronApp.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, project);
  await window.locator('#agent-attachment-button').click();
  await window.locator('#agent-open-project').click();
  await expect(window.locator('#agent-run-message')).toContainText('Project opened');
  await window.locator('#agent-prompt').fill('AFTER_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete');
  const before = await window.evaluate(() => window.electronAPI.getAgentState());
  expect(before.state).toMatchObject({ providerId: 'ollama', modelId: MODEL_ID });
  const configured = await window.evaluate(baseUrl => window.electronAPI.configureCompatibleAgentProvider({
    providerId: 'openai-compatible', name: 'Different new-chat default', baseUrl: `${baseUrl}/v1`,
    models: [{ id: 'new-default' }],
  }), baseUrl);
  expect(configured.ok).toBe(true);
  await electronApp.close();
  const restarted = await relaunchApp();
  const chrome = await restarted.firstWindow();
  await chrome.waitForSelector('#agent-toggle-btn', { state: 'visible' });
  const restored = await chrome.evaluate(id => window.electronAPI.openAgentSession(id), before.state.conversationId);
  expect(restored).toMatchObject({ ok: true, state: { providerId: 'ollama', modelId: MODEL_ID } });
  const profile = await chrome.evaluate(() => window.electronAPI.getAgentProviderStatus());
  expect(profile.status.modelId).toBe('new-default');
  await chrome.reload();
  await chrome.locator('#agent-toggle-btn').click();
  await chrome.locator('#agent-prompt').fill('AFTER_CANCEL again');
  await chrome.locator('#agent-run').click();
  await expect(chrome.locator('#agent-run-status')).toHaveText('Complete');
  const after = await chrome.evaluate(() => window.electronAPI.getAgentState());
  expect(after.state).toMatchObject({ providerId: 'ollama', modelId: MODEL_ID });
  await expect(chrome.locator('.agent-output').last()).toHaveText('READY');
});

test('follow-up prompts retain Pi context and the visible chat across sidebar reopen', async ({
  window,
}) => {
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('FIRST_CONTEXT');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('READY');

  await window.locator('#agent-sidebar-close').click();
  await window.locator('[data-test="agent-toggle-btn"]').click();
  await expect(window.locator('.agent-user-message')).toHaveText(['FIRST_CONTEXT']);
  await expect(window.locator('.agent-output')).toHaveText(['READY']);
  await expect(window.locator('#agent-model-menu-button')).toBeDisabled();
  await expect(window.locator('#agent-approval-mode-button')).toBeEnabled();

  await window.locator('#agent-prompt').fill('FOLLOWUP_CONTEXT');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('CONTEXT_RETAINED');
  await expect(window.locator('.agent-user-message')).toHaveText([
    'FIRST_CONTEXT',
    'FOLLOWUP_CONTEXT',
  ]);
  await expect(window.locator('.agent-output')).toHaveText(['READY', 'CONTEXT_RETAINED']);
});

test('Take over preserves the Pi session and resume re-observes the page', async ({
  window,
  harness,
}) => {
  streamingResponseClosed = false;
  await openSharedStartPage(window, harness);
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('STREAM_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-output')).toHaveText('Streaming fixture started');

  await takeOverControlledPage(window);
  await expect(window.locator('#agent-run')).toHaveAttribute('data-action', 'resume');
  const controlledTab = window.locator('[data-test="tab"].active');
  await expect(controlledTab).toHaveClass(/agent-controlled/);
  await expect(controlledTab).toHaveCSS('box-shadow', 'none');
  await expect(controlledTab).toHaveCSS('background-image', /linear-gradient/);
  await expect.poll(() => streamingResponseClosed).toBe(true);

  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toContainText('RESUMED');
  await expect(window.locator('.agent-tool-item')).toContainText([
    'Checked Shared start',
    'Read Shared start',
  ]);
  await expect(window.locator('[data-test="tab"].active')).not.toHaveClass(/agent-controlled/);
});

test('the approval composer requires a decision before further steering', async ({
  window,
  harness,
}) => {
  await harness.setContentFixture(STEERING_URL, {
    body: `<!doctype html><title>Steering</title><main>
      <h1>Research submission</h1>
      <button type="button">Submit research</button>
    </main>`,
  });
  const address = window.locator('[data-test="address-input"]');
  await address.click();
  await address.fill(STEERING_URL);
  await address.press('Enter');
  await expect
    .poll(() =>
      window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || '')
    )
    .toBe(STEERING_URL);
  await configureFixtureProvider(window);

  await window.locator('#agent-prompt').fill('STEERING_APPROVAL');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-approval')).toBeVisible({ timeout: 5_000 });
  await expect(window.locator('#agent-approval-action')).toContainText('Submit research');

  await expect(window.locator('#agent-prompt')).toBeDisabled();
  await expect(window.locator('#agent-run')).toBeHidden();
  await expect(window.locator('.agent-guidance-message')).toHaveCount(0);
  await expect(window.locator('#agent-approval')).toBeVisible();

  await window.locator('#agent-approval-stop').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Stopped', { timeout: 5_000 });
  await expect(window.locator('#agent-approval')).toBeHidden();
});

test('Take over cancels an active browser wait and the same run can resume', async ({
  window,
  harness,
}) => {
  await openSharedStartPage(window, harness);
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('WAIT_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('Waiting for');

  await takeOverControlledPage(window);
  await expect(window.locator('[data-test="tab"].active')).toHaveClass(/agent-controlled/);

  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toContainText('RESUMED');
});

async function openAgentPane(window, pane) {
  const toggle = window.locator(`#agent-${pane}-sidebar-toggle`);
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function exitAgentFirst(window) {
  await openAgentPane(window, 'session');
  await window.locator('#agent-mode-toggle').click();
  await window.locator('#agent-mode-browser').click();
}

test('a conversation survives its original and then all task tabs closing', async ({
  electronApp,
  window,
  harness,
}) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 800));
  for (let index = 1; index <= 5; index += 1) {
    await harness.setContentFixture(`https://agent-tabs.test/article-${index}`, {
      body: `<!doctype html><title>Article ${index}</title><p>Article ${index}</p>`,
    });
  }
  await harness.setContentFixture('https://agent-tabs.test/fresh-workspace', {
    body: '<!doctype html><title>Fresh workspace</title><p>Fresh workspace</p>',
  });
  await configureFixtureProvider(window);
  await expect(window.locator('#agent-page-contexts')).toBeHidden();
  await window.locator('#agent-prompt').fill('CREATE_FIVE_TASK_TABS');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 10_000 });
  await expect(window.locator('#agent-output')).toHaveText('FIVE_TABS_READY');
  await expect(window.locator('[data-test="tab"]')).toHaveCount(6);
  await expect(window.locator('[data-test="tab"].agent-owned')).toHaveCount(5);
  const activeOwnedTab = window.locator('[data-test="tab"].active.agent-owned');
  await expect(activeOwnedTab).toHaveCSS('box-shadow', 'none');
  await expect(activeOwnedTab).toHaveCSS('background-image', /linear-gradient/);

  await window.locator('[data-test="agent-first-toggle"]').click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('5');
  await expect(window.locator('#agent-task-page-list .tab:not([hidden])')).toHaveCount(5);
  await expect(window.locator('#agent-task-page-list .tab.active.agent-owned')).toHaveCSS(
    'background-image',
    /linear-gradient/
  );
  await expect(window.locator('#agent-task-pages-empty')).toHaveCSS('display', 'none');
  await openAgentPane(window, 'workspace');
  await expect(window.locator('#agent-page-surface webview:not(.hidden)')).toBeVisible();
  const compactTabStrip = await window.locator('#agent-task-page-list').evaluate((list) => {
    const tabs = [...list.querySelectorAll('.tab:not([hidden])')];
    const activeRect = list.querySelector('.tab.active:not([hidden])')?.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    return {
      scrollsHorizontally: list.scrollWidth > list.clientWidth,
      widths: tabs.map((tab) => tab.getBoundingClientRect().width),
      heights: tabs.map((tab) => tab.getBoundingClientRect().height),
      tops: tabs.map((tab) => tab.getBoundingClientRect().top),
      activeTabIsVisible:
        activeRect && activeRect.left >= listRect.left && activeRect.right <= listRect.right,
    };
  });
  expect(compactTabStrip.scrollsHorizontally).toBe(true);
  expect(compactTabStrip.widths.every((width) => width <= 140)).toBe(true);
  expect(compactTabStrip.heights.every((height) => height <= 30)).toBe(true);
  expect(new Set(compactTabStrip.tops).size).toBe(1);
  expect(compactTabStrip.activeTabIsVisible).toBe(true);
  const wheelScrollMovedTabs = await window.locator('#agent-task-page-list').evaluate((list) => {
    const before = list.scrollLeft;
    const deltaY = before > 0 ? -48 : 48;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    return list.scrollLeft !== before;
  });
  expect(wheelScrollMovedTabs).toBe(true);
  await window.locator('#agent-task-page-list .tab:not([hidden])').first().click();
  await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
  await expect(window.locator('#agent-page-surface .content')).toBeVisible();
  await exitAgentFirst(window);

  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);

  await window.locator('#agent-prompt').fill('AFTER_ORIGINAL_CLOSE');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });
  await expect(window.locator('#agent-output')).toHaveText('CHAT_CONTINUED');
  await expect(window.locator('.agent-user-message')).toHaveCount(2);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(3);
  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await window.locator('[data-test="tab"]').nth(0).locator('[data-test="tab-close"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(1);

  await window.locator('#agent-prompt').fill('AFTER_ALL_TASK_TABS_CLOSE');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 10_000 });
  await expect(window.locator('#agent-output')).toHaveText('FRESH_WORKSPACE_READY');
  await expect(window.locator('[data-test="tab"]')).toHaveCount(2);
  await expect(window.locator('[data-test="tab"].active')).toContainText('Fresh workspace');
});

test('session switching restores live workspaces and Claim transfers Agent tabs', async ({
  electronApp,
  window,
  harness,
}) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 800));
  for (let index = 1; index <= 5; index += 1) {
    await harness.setContentFixture(`https://agent-tabs.test/article-${index}`, {
      body: `<!doctype html><title>Article ${index}</title><p>Article ${index}</p>`,
    });
  }
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('CREATE_FIVE_TASK_TABS');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 10_000 });
  await expect(window.locator('[data-test="tab"]')).toHaveCount(6);
  await expect(window.locator('[data-test="tab"].agent-owned')).toHaveCount(5);

  await window.locator('[data-test="agent-first-toggle"]').click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('5');
  await expect(window.locator('#agent-task-page-list .tab:not([hidden])')).toHaveCount(5);
  await exitAgentFirst(window);

  await window.locator('[data-test="new-tab-btn"]').click();
  await expect(window.locator('[data-test="tab"]')).toHaveCount(7);
  await window.locator('#agent-new-chat').click();
  await expect(window.locator('#agent-empty-state')).toBeVisible();
  await window.locator('#agent-prompt').fill('SECOND_SESSION');
  await window.locator('#agent-run').click();
  await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 5_000 });

  await window.locator('[data-test="agent-first-toggle"]').click();
  await expect(window.locator('#agent-session-list .agent-session-row')).toHaveCount(2);
  await expect(window.locator('#agent-task-page-count')).toHaveText('0');

  await openAgentPane(window, 'session');
  const firstSession = window
    .locator('#agent-session-list .agent-session-row')
    .filter({ hasText: 'CREATE_FIVE_TASK_TABS' })
    .locator('.agent-session-select');
  const secondSession = window
    .locator('#agent-session-list .agent-session-row')
    .filter({ hasText: 'SECOND_SESSION' })
    .locator('.agent-session-select');
  await firstSession.click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('5');
  await expect(window.locator('#agent-task-page-list .tab:not([hidden])')).toHaveCount(5);
  await secondSession.click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('0');
  await firstSession.click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('5');
  await exitAgentFirst(window);

  const claimedTab = window.locator('[data-test="tab"].agent-owned').first();
  await claimedTab.click();
  await expect(window.locator('[data-test="address-input"]')).toHaveJSProperty('readOnly', true);
  await claimedTab.locator('[data-test="tab-agent-badge"]').click();
  await expect(window.locator('[data-test="tab"].agent-owned')).toHaveCount(4);
  await expect(window.locator('[data-test="address-input"]')).toHaveJSProperty('readOnly', false);

  await window.locator('[data-test="agent-first-toggle"]').click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('4');
  await window.locator('#agent-new-chat').click();
  await expect(window.locator('#agent-task-page-count')).toHaveText('1');
  await exitAgentFirst(window);
  await expect(window.locator('body')).not.toHaveClass(/agent-first-mode/);
  await expect(window.locator('#agent-task-pages-empty')).toHaveCSS('display', 'none');
  await expect(window.locator('#webview-container webview:not(.hidden)')).toBeVisible();
});

test('Stop cancels an in-flight browser navigation', async ({ window, harness }) => {
  await harness.setContentFixture(SLOW_NAVIGATION_URL, {
    body: '<!doctype html><title>Still loading</title><p>Navigation started</p>',
    holdOpen: true,
  });
  await openSharedStartPage(window, harness);
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('NAV_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('Navigating to');
  await expect
    .poll(async () => (await harness.state()).contentActivity[SLOW_NAVIGATION_URL]?.started)
    .toBe(1);
  expect((await harness.state()).contentActivity[SLOW_NAVIGATION_URL].cancelled).toBe(0);

  await stopAndExpectReusable(window);
  await expect
    .poll(async () => (await harness.state()).contentActivity[SLOW_NAVIGATION_URL]?.cancelled)
    .toBe(1);
});

test('Stop cancels an active declarative wait', async ({ window, harness }) => {
  await openSharedStartPage(window, harness);
  await configureFixtureProvider(window);
  await window.locator('#agent-prompt').fill('WAIT_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('Waiting for');

  await stopAndExpectReusable(window);
});

test('Find stays usable without handing keyboard input to an Agent-controlled page', async ({ window, harness }) => {
  await openSharedStartPage(window, harness);
  await configureFixtureProvider(window);
  await window.evaluate(() => document.querySelector('webview:not(.hidden)').executeJavaScript(
    'const editor = document.createElement("input"); editor.id = "custody-editor"; document.body.appendChild(editor); editor.focus(); true'
  ));
  await window.locator('#agent-prompt').fill('WAIT_CANCEL');
  await window.locator('#agent-run').click();
  await expect(window.locator('.agent-tool-item')).toContainText('Waiting for');
  await expect(window.locator('#agent-page-interlock')).toBeVisible();
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await window.locator('#find-bar-input').fill('Shared');
  await expect(window.locator('#find-bar-count')).toHaveText('1/1');
  await window.locator('#find-bar-close').click();
  await expect(window.locator('#agent-page-lock-trigger')).toBeFocused();
  await window.keyboard.type('incidentaltyping');
  const value = await window.evaluate(() => document.querySelector('webview:not(.hidden)').executeJavaScript(
    'document.getElementById("custody-editor").value'
  ));
  expect(value).toBe('');
  await expect(window.locator('#agent-takeover-dialog')).toBeHidden();
  await expect(window.locator('#agent-run-status')).toHaveText('Running');
  await stopAndExpectReusable(window);
});
