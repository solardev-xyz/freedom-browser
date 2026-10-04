const { test, expect } = require('./fixtures');
const http = require('http');
const path = require('path');
const repositoryRoot = path.resolve(__dirname, '..');

test('MCP services work in existing chats independently of model settings; Electron runs native codemode', async ({ window, electronApp }, testInfo) => {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'freedom-e2e-no-server' }] }));
    if (req.url !== '/mcp') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'Model unavailable in discovery-only fixture' }));
    }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
    let body = '';
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.statusCode = 202; return res.end(); }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Test notes', version: '1' } }
      : { tools: [{ name: 'find_notes', description: 'Search your notes. <img src=x onerror="window.mcpInjected=true">',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await window.locator('[data-test="agent-toggle-btn"]').click();
    await window.locator('#agent-provider-add').click();
    await window.locator('#agent-provider-choices').getByRole('button', { name: 'Ollama', exact: true }).click();
    await window.locator('#agent-provider-advanced > summary').click();
    await window.locator('#agent-ollama-url').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await window.locator('#agent-provider-save').click();
    await expect(window.locator('#agent-provider-status')).toHaveText('Connected');
    await expect(window.locator('#agent-setup-view #agent-mcp-open')).toHaveCount(0);
    await window.locator('#agent-sidebar-back').click();
    await window.locator('#agent-prompt').fill('Hello');
    await window.locator('#agent-run').click();
    await expect(window.locator('#agent-run-status')).toHaveText('Provider issue', { timeout: 15_000 });
    await expect(window.locator('#agent-model-menu-button')).toBeDisabled();
    await window.locator('#agent-prompt').fill('Keep this draft');
    await window.locator('#agent-attachment-button').click();
    await window.locator('#agent-mcp-open').click();
    await expect(window.locator('#agent-workspace-view')).toBeHidden();
    await expect(window.locator('.agent-mcp-form')).toBeHidden();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await window.locator('#agent-mcp-panel').screenshot({ path: testInfo.outputPath(`mcp-${theme}-empty.png`) });
    }
    await window.getByRole('button', { name: 'Add service', exact: true }).click();
    await expect(window.locator('[data-mcp-home]')).toBeHidden();
    await expect(window.locator('#agent-mcp-name')).toBeFocused();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await window.locator('#agent-mcp-panel').screenshot({ path: testInfo.outputPath(`mcp-${theme}-add.png`) });
    }
    await window.locator('#agent-mcp-name').fill('My notes');
    await window.locator('#agent-mcp-url').fill(`http://127.0.0.1:${server.address().port}/mcp`);
    await window.getByRole('button', { name: 'Connect service', exact: true }).click();
    const card = window.locator('.agent-mcp-card');
    await expect(card).toContainText('Connected');
    await expect(window.locator('.agent-mcp-form')).toBeHidden();
    await window.locator('#agent-sidebar-back').click();
    await expect(window.locator('#agent-workspace-view')).toBeVisible();
    await expect(window.locator('#agent-prompt')).toHaveValue('Keep this draft');
    await expect(window.locator('.agent-user-message')).toHaveText('Hello');
    await expect(window.locator('#agent-model-menu-button')).toBeDisabled();
    await window.locator('#agent-attachment-button').click();
    await window.locator('#agent-mcp-open').click();
    await window.getByRole('button', { name: 'Add service', exact: true }).click();
    await window.locator('#agent-sidebar-back').click();
    await expect(card).toBeVisible();
    await expect(window.locator('.agent-mcp-form')).toBeHidden();
    await card.locator('summary').click();
    await expect(card).toContainText('find_notes');
    await expect(card.locator('img')).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await window.locator('#agent-mcp-panel').screenshot({ path: testInfo.outputPath(`mcp-${theme}-connected.png`) });
    }
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(card).toContainText('Connected');
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(card).toHaveCount(0);
    await window.locator('#agent-sidebar-back').click();
    await window.locator('#agent-first-toggle').click();
    await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
    await window.locator('#agent-attachment-button').click();
    await window.locator('#agent-mcp-open').click();
    await expect(window.locator('#agent-mcp-panel')).toBeVisible();
    await window.locator('#agent-sidebar-back').click();
    await expect(window.locator('body')).toHaveClass(/agent-first-mode/);
    await expect(window.locator('#agent-prompt')).toHaveValue('Keep this draft');
    const codemode = await electronApp.evaluate(async (_electron, root) => {
      const require = process.getBuiltinModule('module').createRequire(`${root}/package.json`);
      const { loadPiSdk } = require(root + '/src/main/agent/pi-sdk');
      const { createIsolatedPiSession } = require(root + '/src/main/agent/pi-session-factory');
      const sdk = await loadPiSdk();
      const directory = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'freedom-electron-codemode-'));
      const runtime = await sdk.ModelRuntime.create({ authPath: directory + '/auth.json', modelsPath: null,
        modelsStorePath: directory + '/models.json', refreshOnCreate: false });
      const { session } = await createIsolatedPiSession({ sdk, modelRuntime: runtime, model: runtime.getModels('anthropic')[0], enableCodemode: true,
        customTools: [{ name: 'probe', label: 'Probe', description: 'Probe', parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'Electron native sandbox passed' }], details: {} }) }] });
      try {
        const args = { code: 'text(await tools.probe({})); text(typeof process); text(typeof models);' };
        session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', name: 'codemode', id: 'test', arguments: args }] });
        return await session.agent.state.tools.find(tool => tool.name === 'codemode').execute('test', args, new AbortController().signal);
      } finally { session.dispose(); }
    }, repositoryRoot);
    expect(codemode.isError).not.toBe(true);
    expect(JSON.stringify(codemode)).toContain('Electron native sandbox passed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('codemode worker and WebAssembly run from an Electron ASAR archive', async ({ electronApp }) => {
  const fs = require('fs');
  const os = require('os');
  const asar = require('@electron/asar');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-codemode-asar-'));
  const source = path.join(directory, 'source');
  const dependencies = path.join(repositoryRoot, 'node_modules/@earendil-works/pi-coding-agent/node_modules');
  for (const name of ['@earendil-works/pi-codemode', 'quickjs-wasi']) {
    fs.cpSync(path.join(dependencies, name), path.join(source, 'node_modules', name), { recursive: true });
  }
  fs.writeFileSync(path.join(source, 'entry.cjs'), `module.exports = async () => {
    const { CodemodeSandbox } = await import('@earendil-works/pi-codemode');
    const sandbox = new CodemodeSandbox({ tools: [{ name: 'probe', execute: async () => 'archive success' }] });
    try { return await sandbox.execute('text(await tools.probe({}));'); }
    finally { await sandbox.close(); }
  };`);
  const archive = path.join(directory, 'app.asar');
  await asar.createPackage(source, archive);
  const result = await electronApp.evaluate(async (_electron, filename) => {
    const require = process.getBuiltinModule('module').createRequire(filename);
    return await require(filename)();
  }, path.join(archive, 'entry.cjs'));
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(result)).toContain('archive success');
});
