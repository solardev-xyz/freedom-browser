'use strict';

const { claudeEnvironment, createToolBridge, MAX_BRIDGE_REQUEST_BYTES } = require('./claude-cli');

test('subscription subprocess does not inherit API credentials or runtime injection', () => {
  expect(claudeEnvironment({ HOME: '/home/test', PATH: '/bin', ANTHROPIC_API_KEY: 'not-a-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'not-a-token', NODE_OPTIONS: '--require injected',
    ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: '/foreign' })).toEqual({ HOME: '/home/test', PATH: '/bin' });
});

describe('Claude local tool bridge', () => {
  let bridge, abort, calls, endpoint;
  beforeEach(async () => {
    abort = new AbortController();
    calls = jest.fn(async (_id, args, signal) => { signal.throwIfAborted(); return { content: [{ type: 'text', text: args.value }] }; });
    bridge = await createToolBridge([{ name: 'probe', description: 'Probe', parameters: { type: 'object', properties: {} }, execute: calls }], abort.signal);
    endpoint = bridge.config.mcpServers.freedom;
  });
  afterEach(async () => { abort.abort(); await bridge.close(); });
  function request(method, params, headers = {}) {
    return fetch(endpoint.url, { method: 'POST', headers: { ...endpoint.headers, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  }
  test('rejects unauthenticated and browser-origin requests before executing', async () => {
    expect((await request('tools/call', { name: 'probe' }, { Authorization: '' })).status).toBe(403);
    expect((await request('tools/call', { name: 'probe' }, { Origin: 'https://page.test' })).status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });
  test('only dispatches registered tools and propagates the owned abort signal', async () => {
    expect((await (await request('tools/call', { name: 'Bash' })).json()).error.code).toBe(-32601);
    const response = await (await request('tools/call', { name: 'probe', arguments: { value: 'read' } })).json();
    expect(response.result.content).toEqual([{ type: 'text', text: 'read' }]);
    expect(calls).toHaveBeenCalledWith(expect.any(String), { value: 'read' }, abort.signal);
    abort.abort();
    expect((await request('tools/call', { name: 'probe' })).status).toBe(410);
    expect(calls).toHaveBeenCalledTimes(1);
  });
  test('controller remains pending until approval resolves and can deny without effects', async () => {
    let settle;
    calls.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const response = request('tools/call', { name: 'probe' });
    while (!settle) await new Promise(resolve => setTimeout(resolve, 5));
    settle({ isError: true, content: [{ type: 'text', text: 'User declined' }] });
    expect((await (await response).json()).result.isError).toBe(true);
  });
  test('rejects oversized requests before dispatch', async () => {
    expect((await request('tools/call', { name: 'probe', arguments: { value: 'x'.repeat(MAX_BRIDGE_REQUEST_BYTES) } })).status).toBe(413);
    expect(calls).not.toHaveBeenCalled();
  });
  test('preserves a declined action without exposing arbitrary exception details', async () => {
    calls.mockRejectedValueOnce(Object.assign(new Error('private diagnostic'), { code: 'USER_CANCELLED' }));
    const response = await (await request('tools/call', { name: 'probe' })).json();
    expect(response.result).toEqual({ isError: true, content: [{ type: 'text', text: 'The user declined or cancelled this action. It was not performed. Do not retry.' }] });
  });
});


test('refuses local or cached managed policies before starting Claude', async () => {
  const { assertUnmanagedClaude } = require('./claude-cli');
  const exec = jest.fn(async () => { throw Object.assign(new Error('absent'), { code: 1 }); });
  await assertUnmanagedClaude({ platform: 'darwin', exists: async () => false, exec });
  expect(exec).toHaveBeenCalledWith('/usr/bin/defaults', ['read', 'com.anthropic.claudecode'], expect.any(Object));
  await expect(assertUnmanagedClaude({ platform: 'linux', exists: async p => p.endsWith('remote-settings.json'), exec })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_MANAGED' });
  await expect(assertUnmanagedClaude({ platform: 'darwin', exists: async () => false, exec: async () => ({ stdout: '{}' }) })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_MANAGED' });
  await expect(assertUnmanagedClaude({ platform: 'linux', exists: async () => { throw new Error('unreadable'); } })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_MANAGED' });
});


test('requires native subscription authentication and a compatible CLI without API fallback', async () => {
  const { checkClaudeLogin } = require('./claude-cli');
  const checkPolicy = jest.fn(async () => {});
  const status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
  const run = jest.fn(async (_file, args) => ({ stdout: args[0] === '--version' ? '2.1.290 (Claude Code)' : JSON.stringify(status) }));
  const options = { executable: '/native/claude', run, checkPolicy };
  await expect(checkClaudeLogin(options)).resolves.toBe('/native/claude');
  status.authMethod = 'api_key';
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_UNAVAILABLE' });
  status.authMethod = 'claude.ai'; status.subscriptionType = 'team';
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_MANAGED' });
  run.mockResolvedValueOnce({ stdout: '2.1.100' });
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_VERSION' });
});
