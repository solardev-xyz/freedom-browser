const { test, expect } = require('./fixtures');
const http = require('http');
const path = require('path');
const repositoryRoot = path.resolve(__dirname, '..');

test('MCP connections discover real HTTP tools and render safely in both themes; Electron runs native codemode', async ({ window, electronApp }, testInfo) => {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
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
    await window.locator('#agent-mcp-open').click();
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await window.locator('#agent-setup-view').screenshot({ path: testInfo.outputPath(`mcp-${theme}-empty.png`) });
    }
    await window.locator('#agent-mcp-name').fill('My notes');
    await window.locator('#agent-mcp-url').fill(`http://127.0.0.1:${server.address().port}/mcp`);
    await window.getByRole('button', { name: 'Connect service', exact: true }).click();
    const card = window.locator('.agent-mcp-card');
    await expect(card).toContainText('Connected');
    await card.locator('summary').click();
    await expect(card).toContainText('find_notes');
    await expect(card.locator('img')).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
      await window.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await window.locator('#agent-setup-view').screenshot({ path: testInfo.outputPath(`mcp-${theme}-connected.png`) });
    }
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(card).toContainText('Connected');
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(card).toHaveCount(0);
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
