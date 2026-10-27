const { openProviderSettings } = require('./agent-provider-fixture');
const http = require('http');
const { test, expect } = require('./fixtures');

// Choosing a provider updates the page's hash, and the hashchange handler
// that renders that route arrives a moment later. A field filled before it
// can be wiped when the form is reopened, which on a loaded runner left the
// connection name empty and the save "Not connected". The handler is what
// names the page, so wait for the heading before typing anything.
async function chooseCompatible(providerPage) {
  await providerPage.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI-compatible', exact: true }).click();
  await expect(providerPage.locator('#ai-provider-page-title')).toHaveText('OpenAI-compatible');
}

// A composer re-render (a new chat, a finished run) can close the model menu
// between the click that opened it and the click on its entry, so open it
// again until "Manage models…" is there to click.
async function manageModels(window) {
  await expect(async () => {
    if (!(await window.locator('#agent-manage-providers').isVisible())) await window.locator('#agent-model-menu-button').click();
    await window.locator('#agent-manage-providers').click({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
}

test('custom provider discovers models, verifies tools, chats, and supports a second keyless connection', async ({ window }, testInfo) => {
  const requests = [];
  let rejectTools = false;
  let holdTool = false, releaseTool;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fast' }, { id: 'smart' }] }));
    }
    if (holdTool && body.tools?.length) {
      holdTool = false;
      await new Promise(resolve => { releaseTool = resolve; });
    }
    const toolResult = body.messages.findLast(m => m.role === 'tool');
    if (rejectTools && body.tools?.length) { res.writeHead(400); return res.end('Tools unsupported'); }
    const tool = body.tools?.find(t => t.function.name === 'connection_probe');
    const nonce = tool?.function.parameters.properties.nonce.enum[0];
    const delta = tool && !toolResult ? { tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: 'connection_probe', arguments: JSON.stringify({ nonce }) } }] }
      : { content: toolResult ? (typeof toolResult.content === 'string' ? toolResult.content : toolResult.content.map(c => c.text || '').join('')) : 'CUSTOM_OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/prefix/v1`;
  // The keyless connection gets its own path on the same server, so its
  // requests can be told apart from any the first connection still sends.
  const keylessUrl = `http://127.0.0.1:${server.address().port}/keyless/v1`;
  const keylessRequests = () => requests.filter(r => r.url.startsWith('/keyless/v1/'));
  try {

  let providerPage = await openProviderSettings(window);
    await providerPage.locator('#agent-provider-add').click();
    await chooseCompatible(providerPage);
    await providerPage.locator('#agent-custom-name').fill('Fixture gateway');
    await providerPage.locator('#agent-custom-url').fill(baseUrl);
    await expect(providerPage.locator('#agent-custom-transport')).toContainText('without transport encryption');
    await providerPage.locator('#agent-api-key').fill('fixture-only-key');
    for (const theme of ['dark', 'light']) {
      await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
      await providerPage.locator('#providers').screenshot({ path: testInfo.outputPath(`custom-provider-connect-${theme}.png`) });
    }
    // Connecting the first model opens Agent on a start page and leaves this
    // Settings tab in the background (#864), but only once the page has seen
    // its own "no model" status: the next-step row shows only then. Wait for
    // it, so the switch happens on every runner and not just on a slow one,
    // then bring Settings back. A background guest gets no animation frames
    // on macOS, so an element screenshot of it waits for "stable" forever.
    await expect.poll(() => providerPage.locator('#ai-next-step').evaluate(el => !el.hidden)).toBe(true);
    await providerPage.locator('#agent-provider-save').click();
    await expect(providerPage.locator('#agent-provider-status')).toHaveText('Connected', { timeout: 20000 });
    const activeUrl = () => window.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL() || '');
    await expect.poll(activeUrl).toContain('/pages/home.html');
    await expect(window.locator('#agent-toggle-btn')).toHaveAttribute('aria-expanded', 'true');
    await window.locator('.tab', { hasText: 'Settings' }).click();
    await expect.poll(activeUrl).toContain('/pages/settings.html');
    await expect(providerPage.locator('#agent-provider-models-list')).toContainText('fast');
    // The Settings tab receives its own change broadcast before the reply.
    await providerPage.getByRole('button', { name: 'Favorite smart', exact: true }).click();
    await expect(providerPage.getByRole('button', { name: 'Unfavorite smart', exact: true })).toBeVisible();
    await expect(providerPage.locator('#agent-provider-models-list li')).toHaveCount(2);
    await expect(providerPage.locator('#agent-custom-url')).toBeDisabled();
    await expect(providerPage.locator('#agent-compatibility')).toBeVisible();
    await expect(providerPage.locator('#agent-provider-test')).toBeVisible();
    await expect(providerPage.locator('#agent-compatibility-continue')).toHaveText('Continue without checking');
    expect(requests.every(r => r.url.endsWith('/models'))).toBe(true);
    await providerPage.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await providerPage.locator('#agent-model-select').selectOption('smart');
    await providerPage.locator('#agent-custom-context').fill('64000');
    await providerPage.locator('#agent-provider-save').click();
    await expect(providerPage.locator('#agent-model-select')).toHaveValue('smart');
    await providerPage.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await expect(providerPage.locator('#agent-custom-context')).toHaveValue('64000');
    holdTool = true;
    await providerPage.locator('#agent-provider-test').click();
    await expect.poll(() => Boolean(releaseTool)).toBe(true);
    await providerPage.locator('#agent-model-select').selectOption('fast');
    releaseTool();
    await expect(providerPage.locator('#agent-provider-test')).toBeEnabled({ timeout: 20000 });
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Not checked');
    await providerPage.locator('#agent-model-select').selectOption('smart');
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Chat and tools verified', { timeout: 20000 });
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('smart:');
    await providerPage.locator('#agent-model-select').selectOption('fast');
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Not checked');
    await providerPage.locator('#agent-model-select').selectOption('smart');
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Chat and tools verified');
    for (const theme of ['dark', 'light']) {
      await window.evaluate(theme => window.electronAPI.saveSettings({ theme }), theme);
      await providerPage.locator('#agent-compatibility').screenshot({ path: testInfo.outputPath(`custom-provider-check-${theme}.png`) });
    }
    await providerPage.locator('#agent-compatibility-continue').click();
    await window.locator('#agent-prompt').fill('Reply with CUSTOM_OK.');
    await window.locator('#agent-run').click();
    await expect(window.locator('#agent-run-status')).toHaveText('Complete', { timeout: 20000 });
    await expect(window.locator('.agent-output').last()).toContainText('CUSTOM_OK');
    await window.locator('#agent-session-privacy').click();
    await expect(window.locator('#agent-session-privacy-panel')).toContainText('Fixture gateway');
    await expect(window.locator('#agent-session-privacy-panel')).toContainText(`127.0.0.1:${server.address().port}`);
    expect(requests.every(r => r.url.startsWith('/prefix/v1/'))).toBe(true);
    expect(requests.every(r => r.auth === 'Bearer fixture-only-key')).toBe(true);

    await window.locator('#agent-session-privacy').click();
    await window.locator('#agent-new-chat').click();
    await manageModels(window);
    providerPage = await openProviderSettings(window);
    await providerPage.locator('#agent-provider-add').click();
    await chooseCompatible(providerPage);
    await providerPage.locator('#agent-custom-name').fill('Keyless fixture');
    await providerPage.locator('#agent-custom-url').fill(keylessUrl);
    await providerPage.locator('#agent-custom-models').fill('manual-model');
    await providerPage.locator('#agent-provider-save').click();
    await expect(providerPage.locator('#agent-provider-status')).toHaveText('Connected');
    // Manual model IDs: saving sends nothing to the keyless endpoint. The
    // first connection (same server, its own path) may still be talking.
    expect(keylessRequests()).toEqual([]);
    rejectTools = true;
    await providerPage.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await providerPage.locator('#agent-provider-test').click();
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Chat and streaming work; tool calling failed.', { timeout: 20000 });
    await expect(providerPage.locator('#agent-compatibility-continue')).toHaveText('Continue anyway');
    await providerPage.locator('#agent-compatibility-continue').click();
    await expect(window.locator('#agent-prompt')).toBeVisible();
    await manageModels(window);
    providerPage = await openProviderSettings(window);
    await providerPage.locator('#agent-connected-provider-list').getByRole('button', { name: /Keyless fixture/ }).click();
    rejectTools = false;
    await providerPage.locator('#agent-provider-test').click();
    await expect(providerPage.locator('#agent-compatibility-result')).toContainText('Chat and tools verified', { timeout: 20000 });
    // Both checks reached the keyless endpoint, and none of them with a key.
    expect(keylessRequests().length).toBeGreaterThan(0);
    expect(keylessRequests().map(r => r.auth)).toEqual(keylessRequests().map(() => undefined));
    expect(requests.filter(r => !r.url.startsWith('/keyless/v1/')).every(r => r.url.startsWith('/prefix/v1/') && r.auth === 'Bearer fixture-only-key')).toBe(true);
    await providerPage.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'Models & providers', exact: true }).click();
    await expect(providerPage.locator('#agent-connected-provider-list')).toContainText('Fixture gateway');
    await expect(providerPage.locator('#agent-connected-provider-list')).toContainText('Keyless fixture');
  } finally { releaseTool?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// #803: "Model catalog refreshed" used to stay at the foot of a provider page
// for good, including after a refresh nobody asked for.
test('a catalog refresh reports itself only when asked for, and only briefly', async ({ window }) => {
  const modelRequests = [];
  let failing = false;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) modelRequests.push(req.url);
    if (failing) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fast' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const providerPage = await openProviderSettings(window);
    const message = providerPage.locator('#agent-provider-message');
    await providerPage.locator('#agent-provider-add').click();
    await chooseCompatible(providerPage);
    await providerPage.locator('#agent-custom-name').fill('Refresh fixture');
    await providerPage.locator('#agent-custom-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await providerPage.locator('#agent-custom-models').fill('manual-model');
    await providerPage.locator('#agent-provider-save').click();
    await expect(providerPage.locator('#agent-provider-status')).toHaveText('Connected');

    // A clicked refresh says so, then the line clears itself.
    await providerPage.locator('#agent-model-refresh').click();
    await expect(message).toHaveText('Model catalog refreshed');
    expect(modelRequests).toHaveLength(1);
    await expect(message).toHaveText('', { timeout: 8000 });

    // Opening the page on a day-old catalog refreshes it in the background,
    // with no status line before, during or after.
    await providerPage.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'Models & providers', exact: true }).click();
    await providerPage.evaluate(() => {
      const now = Date.now;
      Date.now = () => now() + 2 * 24 * 60 * 60 * 1000;
    });
    await providerPage.locator('#agent-connected-provider-list').getByRole('button', { name: /Refresh fixture/ }).click();
    await expect.poll(() => modelRequests.length).toBe(2);
    await expect(providerPage.locator('#agent-model-refresh')).toBeEnabled();
    await expect(message).toHaveText('');

    // Nor when that background refresh fails (provider down, offline): the
    // previous catalog stays in use and nobody asked.
    failing = true;
    await providerPage.locator('#ai-provider-breadcrumbs').getByRole('link', { name: 'Models & providers', exact: true }).click();
    await providerPage.locator('#agent-connected-provider-list').getByRole('button', { name: /Refresh fixture/ }).click();
    await expect.poll(() => modelRequests.length).toBe(3);
    await expect(providerPage.locator('#agent-model-refresh')).toBeEnabled();
    await expect(message).toHaveText('');
    // A clicked refresh that fails still says so.
    await providerPage.locator('#agent-model-refresh').click();
    await expect(message).toHaveText(/^Could not /);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
