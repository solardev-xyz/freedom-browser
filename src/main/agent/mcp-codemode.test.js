'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { McpConnectionManager, McpConnectionStore, mcpUrl, validateMcpEndpoint } = require('./mcp-connections');

const root = path.resolve(__dirname, '../../..');

test('MCP URLs cannot carry credentials, redirect schemes or non-loopback plaintext', () => {
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com/mcp', 'http://example.com/mcp',
    'https://example.com/mcp?token=secret', 'https://example.com/mcp#secret']) expect(() => mcpUrl(url)).toThrow();
  expect(mcpUrl('https://example.com/mcp')).toBe('https://example.com/mcp');
  expect(mcpUrl('http://127.0.0.1:1234/mcp')).toBe('http://127.0.0.1:1234/mcp');
});

test('remote OAuth discovery cannot downgrade into plaintext or loopback services', () => {
  for (const endpoint of ['http://127.0.0.1:1633/wallet', 'http://localhost/token', 'file:///tmp/token', 'https://user:secret@example.com/token']) {
    expect(() => validateMcpEndpoint('https://service.example/mcp', endpoint)).toThrow();
  }
  expect(validateMcpEndpoint('https://service.example/mcp', 'https://auth.example/token').hostname).toBe('auth.example');
  expect(validateMcpEndpoint('http://127.0.0.1:1234/mcp', 'http://127.0.0.1:1234/token').protocol).toBe('http:');
});

test('stopping discovery does not wait for an unresponsive connection attempt', async () => {
  const manager = new McpConnectionManager({ store: { read: () => [{ id: 'fixture', name: 'Fixture', url: 'https://example.com/mcp' }] } });
  manager.connect = jest.fn(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = manager.discover(undefined, '', controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(manager.connect).toHaveBeenCalledTimes(1);
});

test('MCP credential storage rejects plaintext fallback, symlinks and cross-profile state', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-mcp-store-'));
  const store = new McpConnectionStore({ dataDir, safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text',
  } });
  store.write([{ id: 'a'.repeat(24), name: 'Test', url: 'https://example.com/mcp' }]);
  expect(() => store.saveCredentials('a'.repeat(24), { serverUrl: 'https://example.com/mcp', tokens: {} })).toThrow(/keyring/);
  const other = new McpConnectionStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-mcp-other-')) });
  fs.copyFileSync(store.file, other.file);
  expect(() => other.read()).toThrow(/invalid/);
  const linked = new McpConnectionStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-mcp-link-')) });
  fs.symlinkSync(store.file, linked.file);
  expect(() => linked.read()).toThrow(/unsafe/);
});

test('native Pi codemode and MCP preserve approval, OAuth, cancellation, ordered calls and partial effects', () => {
  const script = String.raw`
(async () => {
  const assert = require('assert/strict');
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { McpConnectionManager, McpConnectionStore } = require('./src/main/agent/mcp-connections');
  const { loadPiSdk } = require('./src/main/agent/pi-sdk');
  const { createIsolatedPiSession } = require('./src/main/agent/pi-session-factory');
  const { createMcpTools } = require('./src/main/agent/pi-mcp-tools');
  let origin;
  let authRequired = false;
  let calls = [];
  let exchanged = 0;
  let holdSignIn = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const json = value => res.end(JSON.stringify(value));
    let body = '';
    for await (const part of req) body += part;
    if (req.url === '/resource') return json({ resource: origin + '/mcp', authorization_servers: [origin] });
    if (req.url.startsWith('/.well-known/oauth-authorization-server')) return json({ issuer: origin,
      authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'] });
    if (req.url === '/register') return json({ client_id: 'fixture-client', ...JSON.parse(body) });
    if (req.url === '/token') { exchanged++; return json({ access_token: 'fixture-access-secret', token_type: 'Bearer', refresh_token: 'fixture-refresh-secret', expires_in: 3600 }); }
    if (req.url !== '/mcp') { res.statusCode = 404; return json({}); }
    if (authRequired && req.headers.authorization !== 'Bearer fixture-access-secret') {
      res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + origin + '/resource"'); return json({});
    }
    if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
    const message = JSON.parse(body);
    if (message.id === undefined) { res.statusCode = 202; return res.end(); }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: '<script>untrusted service text</script>', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
    else if (message.method === 'tools/call') { calls.push(message.params);
      if (message.params.arguments.text === 'server-error') { res.statusCode = 500; return json({ error: 'fixture failure after effect' }); }
      if (message.params.arguments.text === 'slow') await new Promise(resolve => setTimeout(resolve, 80));
      result = { content: [{ type: 'text', text: message.params.arguments.text || 'ok' }] }; }
    else if (message.method === 'resources/list') result = { resources: [{ uri: 'fixture://note', name: 'Note' }] };
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, text: 'fixture note' }] };
    else result = {};
    json({ jsonrpc: '2.0', id: message.id, result });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-mcp-native-'));
  const storage = { isEncryptionAvailable: () => true,
    encryptString: text => Buffer.from(text.split('').reverse().join('')),
    decryptString: value => value.toString().split('').reverse().join('') };
  let opened = 0;
  const manager = new McpConnectionManager({ dataDir, safeStorage: storage,
    openExternal: async value => {
      opened++;
      if (holdSignIn) return;
      const url = new URL(value);
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('iss', origin);
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    },
  });
  let session;
  try {
    let list = await manager.add({ name: 'Fixture', url: origin + '/mcp' });
    const id = list[0].id;
    assert.equal(list[0].state, 'connected');
    assert.equal((await manager.discover(id))[0].tools[0].inputSchema.type, 'object');
    const params = { serverId: id, action: 'call', name: 'echo', arguments: { text: 'hello' } };
    await assert.rejects(manager.perform(params, async () => 'declined'), /declined/);
    assert.equal(calls.length, 0);
    const aborted = new AbortController();
    await assert.rejects(manager.perform(params, async () => { aborted.abort(); return 'approved'; }, aborted.signal));
    assert.equal(calls.length, 0);
    assert.match(JSON.stringify(await manager.perform(params, async () => 'approved')), /hello/);
    authRequired = true;
    list = await manager.reconnect(id);
    assert.equal(list[0].state, 'needs-auth');
    assert.equal(opened, 0);
    list = await manager.signIn(id);
    assert.equal(list[0].state, 'connected');
    assert.equal(opened, 1); assert.equal(exchanged, 1);
    assert(!fs.readFileSync(path.join(dataDir, 'mcp-connections.json'), 'utf8').includes('fixture-access-secret'));
    assert.equal(manager.store.credentials(id).tokens.access_token, 'fixture-access-secret');
    holdSignIn = true;
    const cancelledLogin = manager.signIn(id);
    cancelledLogin.catch(() => {});
    for (let count = 0; count < 100 && opened < 2; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(opened, 2);
    await manager.cancelSignIn(id);
    await assert.rejects(cancelledLogin);
    holdSignIn = false;
    assert.equal((await manager.signIn(id))[0].state, 'connected');
    const beforeFailure = calls.length;
    await assert.rejects(manager.perform({ ...params, arguments: { text: 'server-error' } }, async () => 'approved'), /effects may be unknown/);
    assert.equal(calls.length, beforeFailure + 1, 'A server failure must not replay an effect');
    const stopRequest = new AbortController();
    const slow = manager.perform({ ...params, arguments: { text: 'slow' } }, async () => 'approved', stopRequest.signal);
    setTimeout(() => stopRequest.abort(), 20);
    await assert.rejects(slow, /effects may be unknown/);
    const sdk = await loadPiSdk();
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(dataDir, 'auth.json'), modelsPath: null,
      modelsStorePath: path.join(dataDir, 'models.json'), refreshOnCreate: false });
    let approvals = 0;
    const tools = createMcpTools({ sdk, manager, requestApproval: async request => {
      approvals++; assert.equal(request.mcp.argumentsJSON, '{"text":"nested"}'); return 'approved';
    } });
    let running = 0;
    let maximum = 0;
    let writes = 0;
    tools.push({ name: 'probe', label: 'Probe', description: 'Probe', parameters: { type: 'object', properties: {} }, execute: async () => {
      running++; maximum = Math.max(maximum, running); writes++;
      await new Promise(resolve => setTimeout(resolve, 10)); running--;
      return { content: [{ type: 'text', text: 'probe result' }], details: {} };
    } });
    const created = await createIsolatedPiSession({ sdk, modelRuntime: runtime, model: runtime.getModels('anthropic')[0], enableCodemode: true, customTools: tools });
    session = created.session;
    assert.deepEqual(session.getActiveToolNames().sort(), ['codemode', 'mcp_discover', 'mcp_request', 'probe']);
    const events = [];
    session.subscribe(event => events.push(event));
    const run = async (code, signal = new AbortController().signal) => {
      const callId = 'code-' + session.agent.state.messages.length;
      const args = { code };
      session.agent.state.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'codemode', arguments: args }] });
      return session.agent.state.tools.find(tool => tool.name === 'codemode').execute(callId, args, signal);
    };
    const output = await run('await Promise.all([tools.probe({}), tools.probe({})]); text(await tools.mcp_request(' + JSON.stringify({ ...params, arguments: { text: 'nested' } }) + ')); text(typeof models); text(typeof process); text(typeof fetch);');
    assert(!output.isError, JSON.stringify(output));
    assert.match(JSON.stringify(output), /nested/);
    assert.equal(approvals, 1); assert.equal(maximum, 1);
    assert(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'mcp_request' && event.parentToolCallId));
    const failed = await run('await tools.probe({}); throw new Error("after write");');
    assert.equal(failed.isError, true); assert.equal(writes, 3);
    assert.equal(failed.details.calls[0].status, 'ok');
    const flooded = await run('for (let i = 0; i < 100001; i++) text("x");');
    assert.equal(flooded.isError, true);
    assert.match(JSON.stringify(flooded), /output.*limit|too many.*output|output.*exceed/i);
    const stopScript = new AbortController();
    setTimeout(() => stopScript.abort(), 30);
    const stopped = await run('while (true) {}', stopScript.signal);
    assert.equal(stopped.isError, true);
    assert.match(JSON.stringify(stopped), /abort|cancel/i);
    await assert.rejects(manager.perform(params, async () => { await manager.remove(id); return 'approved'; }), /unavailable/);
    assert.equal(manager.list().length, 0);
    console.log('native codemode MCP checks passed');
  } finally {
    session?.dispose(); await manager.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  expect(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', timeout: 30000 })).toContain('native codemode MCP checks passed');
}, 35000);
