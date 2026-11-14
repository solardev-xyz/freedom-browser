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


test('requires native subscription authentication and a compatible CLI without API fallback', async () => {
  const { checkClaudeLogin } = require('./claude-cli');
  const status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' };
  const run = jest.fn(async (_file, args, options) => {
    const fs = require('fs');
    const os = require('os');
    expect(options.cwd).not.toBe(os.tmpdir());
    expect(fs.statSync(options.cwd).isDirectory()).toBe(true);
    expect(args.slice(0, 3)).toEqual(['--restricted', '--setting-sources', '']);
    return { stdout: args.includes('--version') ? '2.1.290 (Claude Code)' : JSON.stringify(status) };
  });
  const options = { executable: '/native/claude', run };
  await expect(checkClaudeLogin(options)).resolves.toBe('/native/claude');
  expect(require('fs').existsSync(run.mock.calls[0][2].cwd)).toBe(false);
  status.authMethod = 'api_key';
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_UNAVAILABLE' });
  status.authMethod = 'claude.ai';
  for (const plan of ['pro', 'max', 'team', 'enterprise']) {
    status.subscriptionType = plan;
    await expect(checkClaudeLogin(options)).resolves.toBe('/native/claude');
  }
  status.subscriptionType = 'free';
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_SUBSCRIPTION_REQUIRED' });
  run.mockResolvedValueOnce({ stdout: '2.1.100' });
  await expect(checkClaudeLogin(options)).rejects.toMatchObject({ code: 'AGENT_CLAUDE_VERSION' });
});

test.each([false, true])('retires owned CLI scratch files on shutdown or failed spawn (failure=%s)', async failure => {
  const { EventEmitter } = require('events');
  const { PassThrough } = require('stream');
  const fs = require('fs');
  const path = require('path');
  const { startClaudeProcess } = require('./claude-cli');
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = jest.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  let directory;
  const onClose = jest.fn();
  const starting = startClaudeProcess({
    executable: '/native/claude', model: 'sonnet', systemPrompt: 'Synthetic prompt', tools: [],
    signal: new AbortController().signal, checkLogin: async () => {}, onEvent: () => {}, onClose,
    spawnProcess: (_executable, _args, options) => {
      directory = options.cwd;
      expect(fs.readFileSync(path.join(directory, 'system.txt'), 'utf8')).toBe('Synthetic prompt');
      expect(fs.existsSync(path.join(directory, 'mcp.json'))).toBe(true);
      if (failure) throw new Error('Synthetic spawn failure');
      return child;
    },
  });
  if (failure) await expect(starting).rejects.toThrow('Synthetic spawn failure');
  else {
    const connection = await starting;
    await connection.close();
    expect(onClose).toHaveBeenCalledWith(null);
  }
  expect(fs.existsSync(directory)).toBe(false);
});

test('model discovery validates entries without guessing versions or duplicating the account default', () => {
  const { normalizeClaudeModels } = require('./claude-cli');
  const models = normalizeClaudeModels([
    { value: 'default', displayName: 'Default (recommended)' },
    { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true },
    { value: 'opus', displayName: 'Duplicate' },
    { value: '--injected', displayName: 'Invalid' },
    { value: 'haiku', displayName: 'Claude Haiku', resolvedModel: { invalid: true } },
    null,
  ]);
  expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'opus', name: 'Claude Opus 5.5' }, { id: 'haiku', name: 'Claude Haiku' },
  ]);
  expect(models[0].resolvedModel).toBe('claude-opus-5-5');
  expect(models[1].resolvedModel).toBeUndefined();
  expect(() => normalizeClaudeModels([])).toThrow('empty model catalogue');
  expect(() => normalizeClaudeModels({})).toThrow('model catalogue');
});

test.each(['compatible', 'extra-tool', 'missing-tool', 'api-auth'])(
  'subscription transport keeps Freedom tool authority (%s)', async configuration => {
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const fs = require('fs');
    const { startClaudeProcess } = require('./claude-cli');
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = jest.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    const execute = jest.fn(async () => ({ content: [{ type: 'text', text: 'Allowed by controller' }] }));
    const onClose = jest.fn();
    const onEvent = jest.fn();
    let endpoint;
    const connection = await startClaudeProcess({ executable: '/native/claude', model: 'sonnet',
      systemPrompt: 'Owned fixture', signal: new AbortController().signal,
      tools: [{ name: 'probe', parameters: { type: 'object' }, execute }],
      checkLogin: async () => {}, onEvent, onClose,
      spawnProcess: (_file, args, options) => {
        expect(args.slice(0, 6)).toEqual(['-p', '--restricted', '--tools', '', '--setting-sources', '']);
        expect(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks).toBe(true);
        expect(args).toContain('--strict-mcp-config');
        expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__freedom__probe');
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        endpoint = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.freedom;
        return child;
      },
    });
    const call = () => fetch(endpoint.url, { method: 'POST', headers: endpoint.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'probe' } }) });
    try {
      expect((await call()).status).toBe(409);
      expect(execute).not.toHaveBeenCalled();
      child.stdout.write(JSON.stringify({ type: 'system', subtype: 'init',
        apiKeySource: configuration === 'api-auth' ? 'environment' : 'none',
        tools: configuration === 'extra-tool' ? ['mcp__freedom__probe', 'Bash']
          : configuration === 'missing-tool' ? [] : ['mcp__freedom__probe', 'EndConversation'],
      }) + '\n');
      if (configuration === 'compatible') {
        expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ subtype: 'init' }));
        expect((await (await call()).json()).result.content[0].text).toBe('Allowed by controller');
        execute.mockRejectedValueOnce(Object.assign(new Error('Declined'), { code: 'USER_CANCELLED' }));
        expect((await (await call()).json()).result.isError).toBe(true);
        expect(execute).toHaveBeenCalledTimes(2);
        await connection.write({ type: 'user', message: 'Next turn' });
      } else {
        await connection.close();
        expect(execute).not.toHaveBeenCalled();
        expect(onEvent).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ code: 'AGENT_CLAUDE_CONFIGURATION' }));
      }
    } finally { await connection.close(); }
    expect(child.kill).toHaveBeenCalled();
  }
);

test('discovery checks bridge status without inference, ignores unrelated responses, and closes its child', async () => {
  const { discoverClaudeModels } = require('./claude-cli');
  const close = jest.fn(async () => {});
  const write = jest.fn();
  const startProcess = jest.fn(async options => {
    expect(options.tools).toEqual([]);
    write.mockImplementation(message => {
      expect(message.type).toBe('control_request');
      if (message.request.subtype === 'mcp_status') {
        options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
          response: { mcpServers: [{ name: 'freedom', status: 'connected' }] } } });
        return;
      }
      expect(message.request.subtype).toBe('initialize');
      options.onEvent({ type: 'control_response', response: { request_id: 'foreign', subtype: 'success' } });
      options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
        response: { models: [{ value: 'sonnet', displayName: 'Sonnet 5.5' }] } } });
    });
    return { write, close };
  });
  const models = await discoverClaudeModels({ startProcess, findExecutable: async () => '/native/claude' });
  expect(models[0].name).toBe('Claude Sonnet 5.5');
  expect(write).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(1);
  expect(startProcess.mock.calls[0][0].signal.aborted).toBe(true);
});

test('discovery closes on cancellation and protocol failure', async () => {
  const { discoverClaudeModels } = require('./claude-cli');
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    const close = jest.fn(async () => {});
    await expect(discoverClaudeModels({ signal: controller.signal, findExecutable: async () => '/native/claude',
      startProcess: async options => ({ close, write(message) {
        if (cancel) controller.abort();
        else options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'error' } });
      } }),
    })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_UNAVAILABLE' });
    expect(close).toHaveBeenCalledTimes(1);
  }
});


test.each([[], [{ name: 'freedom', status: 'disabled' }], [{ name: 'other', status: 'connected' }]].map(servers => [servers]))(
  'discovery rejects a blocked or replaced Freedom bridge (%j)', async mcpServers => {
    const { discoverClaudeModels } = require('./claude-cli');
    const close = jest.fn();
    await expect(discoverClaudeModels({ findExecutable: async () => '/native/claude', startProcess: async options => ({ close,
      write(message) {
        options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
          response: message.request.subtype === 'initialize'
            ? { models: [{ value: 'sonnet', displayName: 'Sonnet' }] } : { mcpServers } } });
      },
    }) })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_CONFIGURATION' });
    expect(close).toHaveBeenCalledTimes(1);
  }
);


test('discovery waits for a pending bridge to connect without sending a user message', async () => {
  const { discoverClaudeModels } = require('./claude-cli');
  let checks = 0;
  const writes = [];
  const models = await discoverClaudeModels({ findExecutable: async () => '/native/claude', startProcess: async options => ({ close() {},
    write(message) {
      writes.push(message);
      options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
        response: message.request.subtype === 'initialize' ? { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
          : { mcpServers: [{ name: 'freedom', status: ++checks === 1 ? 'pending' : 'connected' }] } } });
    },
  }) });
  expect(models[0].id).toBe('sonnet');
  expect(checks).toBe(2);
  expect(writes.every(message => message.type === 'control_request')).toBe(true);
});


test('discovery reports unsupported bridge status as a CLI compatibility issue', async () => {
  const { discoverClaudeModels } = require('./claude-cli');
  await expect(discoverClaudeModels({ findExecutable: async () => '/native/claude', startProcess: async options => ({ close() {},
    write(message) {
      options.onEvent({ type: 'control_response', response: message.request.subtype === 'initialize'
        ? { request_id: message.request_id, subtype: 'success', response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] } }
        : { request_id: message.request_id, subtype: 'error', error: 'Unsupported fixture protocol' } });
    },
  }) })).rejects.toMatchObject({ code: 'AGENT_CLAUDE_VERSION' });
});

test('discovery cannot save an alias-only connection when its bridge never becomes ready', async () => {
  jest.useFakeTimers();
  try {
    const { discoverClaudeModels } = require('./claude-cli');
    const close = jest.fn();
    const pending = discoverClaudeModels({ findExecutable: async () => '/native/claude', startProcess: async options => ({ close,
      write(message) {
        options.onEvent({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success',
          response: message.request.subtype === 'initialize' ? { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
            : { mcpServers: [{ name: 'freedom', status: 'pending' }] } } });
      },
    }) });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'AGENT_CLAUDE_CONFIGURATION' });
    await jest.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
