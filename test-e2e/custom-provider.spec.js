const http = require('http');
const { test, expect } = require('./fixtures');

test('custom provider discovers models, verifies tools, chats, and supports a second keyless connection', async ({ window }, testInfo) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fast' }, { id: 'smart' }] }));
    }
    const toolResult = body.messages.findLast(m => m.role === 'tool');
    const tool = body.tools?.find(t => t.function.name === 'connection_probe');
    const nonce = tool?.function.parameters.properties.nonce.enum[0];
    const delta = tool && !toolResult ? { tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: 'connection_probe', arguments: JSON.stringify({ nonce }) } }] }
      : { content: toolResult ? (typeof toolResult.content === 'string' ? toolResult.content : toolResult.content.map(c => c.text || '').join('')) : 'CUSTOM_OK' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: tool && !toolResult ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/prefix/v1`;
  try {
    await window.locator('[data-test="agent-toggle-btn"]').click();
    await window.locator('#agent-provider-add').click();
    await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI-compatible', exact: true }).click();
    await window.locator('#agent-custom-name').fill('Fixture gateway');
    await window.locator('#agent-custom-url').fill(baseUrl);
    await expect(window.locator('#agent-custom-transport')).toContainText('without transport encryption');
    await window.locator('#agent-api-key').fill('fixture-only-key');
    for (const theme of ['dark', 'light']) {
      await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await window.locator('#agent-sidebar').screenshot({ path: testInfo.outputPath(`custom-provider-connect-${theme}.png`) });
    }
    await window.locator('#agent-provider-save').click();
    await expect(window.locator('#agent-provider-status')).toHaveText('Connected', { timeout: 20000 });
    await expect(window.locator('#agent-provider-models-list')).toContainText('fast');
    await expect(window.locator('#agent-custom-url')).toBeDisabled();
    await window.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await window.locator('#agent-model-select').selectOption('smart');
    await window.locator('#agent-custom-context').fill('64000');
    await window.locator('#agent-provider-save').click();
    await expect(window.locator('#agent-model-select')).toHaveValue('smart');
    await window.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await expect(window.locator('#agent-custom-context')).toHaveValue('64000');
    await window.locator('#agent-provider-test').click();
    await expect(window.locator('#agent-provider-message')).toHaveText('Chat and tool calling verified', { timeout: 20000 });
    for (const theme of ['dark', 'light']) {
      await window.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await window.locator('#agent-sidebar').screenshot({ path: testInfo.outputPath(`custom-provider-${theme}.png`) });
    }
    await window.locator('#agent-sidebar-back').click();
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
    await window.locator('#agent-model-menu-button').click();
    await window.locator('#agent-manage-providers').click();
    await window.locator('#agent-provider-add').click();
    await window.locator('#agent-provider-choices').getByRole('button', { name: 'OpenAI-compatible', exact: true }).click();
    await window.locator('#agent-custom-name').fill('Keyless fixture');
    await window.locator('#agent-custom-url').fill(baseUrl);
    await window.locator('#agent-custom-models').fill('manual-model');
    const before = requests.length;
    await window.locator('#agent-provider-save').click();
    await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
    expect(requests.length).toBe(before);
    await window.locator('#agent-provider-advanced').evaluate(el => { el.open = true; });
    await window.locator('#agent-provider-test').click();
    await expect(window.locator('#agent-provider-message')).toHaveText('Chat and tool calling verified', { timeout: 20000 });
    expect(requests.slice(before).every(r => !r.auth)).toBe(true);
    await window.locator('#agent-provider-detail-back').click();
    await expect(window.locator('#agent-connected-provider-list')).toContainText('Fixture gateway');
    await expect(window.locator('#agent-connected-provider-list')).toContainText('Keyless fixture');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
