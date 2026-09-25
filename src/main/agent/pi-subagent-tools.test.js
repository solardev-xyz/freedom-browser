'use strict';

const { createSubagentTool } = require('./pi-subagent-tools');
const { trustBuiltInToolOverride, isTrustedBuiltInToolOverride } = require('./pi-trusted-tools');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(overrides = {}) {
  let listener;
  const owner = { userText: 'Review my project', subagentAbortController: new AbortController() };
  const emit = event => listener?.(event);
  const report = (text = 'Found a missing null check in app.js:5.') => emit({ type: 'message_end', message: {
    role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: { totalTokens: 12 },
  } });
  const session = {
    subscribe: jest.fn(callback => { listener = callback; return jest.fn(); }),
    prompt: jest.fn(async () => report()), abort: jest.fn(async () => {}), dispose: jest.fn(),
  };
  const read = trustBuiltInToolOverride({ name: 'read', execute: jest.fn(async () => ({ content: [{ type: 'text', text: 'file' }] })) });
  const history = { name: 'workspace_history', execute: jest.fn(async () => ({ content: [] })) };
  const options = {
    getOwner: jest.fn(() => owner), model: { id: 'same-model' }, modelRuntime: { identity: 'same-runtime' },
    createSession: jest.fn(async () => ({ session })),
    createTools: jest.fn(async () => [read, history,
      ...['bash', 'write', 'edit', 'request_permissions', 'delegate_task', 'browser_navigate'].map(name => ({ name, execute: jest.fn() }))]),
    onResult: jest.fn(), onProgress: jest.fn(), ...overrides,
  };
  const tool = createSubagentTool(options);
  const run = (params = { title: 'Review', task: 'Inspect for bugs', context: 'Focus on null checks' }) => tool.execute('parent_call', params);
  return { tool, run, owner, options, session, read, history, emit, report };
}

test('isolates context, keeps the model connection and exposes only explicitly scoped read tools', async () => {
  const f = fixture();
  const result = await f.run();
  const settings = f.options.createSession.mock.calls[0][0];
  expect(settings.model).toBe(f.options.model);
  expect(settings.modelRuntime).toBe(f.options.modelRuntime);
  expect(settings.enableBuiltInSkills).toBe(false);
  expect(settings.restoredTranscript).toBeUndefined();
  expect(settings.customTools.map(tool => tool.name)).toEqual(['read', 'workspace_history']);
  expect(isTrustedBuiltInToolOverride(settings.customTools[0])).toBe(true);
  expect(JSON.parse(f.session.prompt.mock.calls[0][0])).toEqual({
    userInstructions: { userRequest: 'Review my project' }, assignment: 'Inspect for bugs', context: 'Focus on null checks',
  });
  expect(result.details.subagent).toMatchObject({ state: 'completed', totalTokens: 12, report: expect.stringContaining('app.js:5') });
  expect(f.options.onResult).toHaveBeenCalledTimes(1);
  await flush();
  expect(f.session.dispose).toHaveBeenCalledTimes(1);
});

test('history commits and review-token issuance cannot be invoked by the child', async () => {
  const f = fixture();
  f.session.prompt.mockImplementation(async () => {
    const history = f.options.createSession.mock.calls[0][0].customTools[1];
    for (const action of ['commit', 'checkpoint', 'include', 'exclude', 'review']) {
      await expect(history.execute('id', { action })).rejects.toThrow('only inspect');
    }
    await history.execute('id', { action: 'diff', path: 'a.js' });
    f.report();
  });
  await f.run();
  expect(f.history.execute).toHaveBeenCalledTimes(1);
  expect(f.history.execute.mock.calls[0][0]).toMatch(/^delegate_[a-f0-9]{24}:id$/);
});

test('Stop resolves even if the child provider never settles; late reports cannot replace cancellation', async () => {
  const f = fixture();
  f.session.prompt.mockImplementation(() => new Promise(() => {}));
  f.session.abort.mockImplementation(() => new Promise(() => {}));
  const pending = f.run();
  await flush();
  f.owner.subagentAbortController.abort();
  expect((await pending).details.subagent.state).toBe('cancelled');
  f.report('Late success');
  expect(f.options.onResult).toHaveBeenCalledTimes(1);
  await flush();
  expect(f.session.dispose).toHaveBeenCalledTimes(1);
});

test('cancellation during session construction disposes the late session without starting it', async () => {
  const f = fixture();
  const creation = deferred();
  f.options.createSession.mockReturnValue(creation.promise);
  const pending = f.run();
  await flush();
  f.owner.subagentAbortController.abort();
  expect((await pending).details.subagent.state).toBe('cancelled');
  creation.resolve({ session: f.session });
  await flush();
  expect(f.session.prompt).not.toHaveBeenCalled();
  expect(f.session.dispose).toHaveBeenCalledTimes(1);
});

test('child tools abort with their task and cannot run after it finishes or under a replacement owner', async () => {
  const f = fixture();
  const entered = deferred();
  f.session.prompt.mockImplementation(async () => {
    const read = f.options.createSession.mock.calls[0][0].customTools[0];
    await read.execute('id', { path: 'app.js' });
    entered.resolve();
    return new Promise(() => {});
  });
  const pending = f.run();
  await entered.promise;
  const signal = f.read.execute.mock.calls[0][2];
  expect(signal.aborted).toBe(false);
  f.owner.subagentAbortController.abort();
  await pending;
  expect(signal.aborted).toBe(true);
  f.options.getOwner.mockReturnValue({ subagentAbortController: new AbortController() });
  await expect(f.options.createSession.mock.calls[0][0].customTools[0].execute('id', { path: 'app.js' })).rejects.toThrow('stopped');
  expect(f.read.execute).toHaveBeenCalledTimes(1);
});

test('at most one helper runs and per-turn task budgets survive repeated delegations', async () => {
  const f = fixture({ limits: { tasks: 1 } });
  const done = deferred();
  f.session.prompt.mockImplementation(() => done.promise);
  const pending = f.run();
  await flush();
  expect((await f.run()).details.subagent.state).toBe('limited');
  f.report(); done.resolve(); await pending;
  expect((await f.run()).details.subagent.state).toBe('limited');
  expect(f.options.createSession).toHaveBeenCalledTimes(1);
});

test('timeout cancels child tools and detaches an unresponsive provider', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture({ limits: { timeoutMs: 30 } });
    f.session.prompt.mockImplementation(() => new Promise(() => {}));
    const pending = f.run(); await flush();
    jest.advanceTimersByTime(31);
    expect((await pending).details.subagent.state).toBe('timed_out');
    await flush();
    expect(f.session.abort).toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('tool and shared token limits produce incomplete results rather than success', async () => {
  const f = fixture({ limits: { toolCalls: 1 } });
  f.session.prompt.mockImplementation(async () => {
    const read = f.options.createSession.mock.calls[0][0].customTools[0];
    await read.execute('1', { path: 'a' });
    await read.execute('2', { path: 'b' });
  });
  expect((await f.run()).details.subagent.state).toBe('limited');
  expect(f.read.execute).toHaveBeenCalledTimes(1);
  const tokens = fixture({ limits: { totalTokens: 20 } });
  expect((await tokens.run()).details.subagent.state).toBe('completed');
  expect((await tokens.run()).details.subagent.state).toBe('limited');
  expect((await tokens.run()).details.subagent.state).toBe('limited');
});

test('rejects oversized output, missing terminal reports and provider exceptions without exposing provider internals', async () => {
  const f = fixture({ limits: { outputChars: 20 } });
  expect((await f.run()).details.subagent.state).toBe('limited');
  const empty = fixture();
  empty.session.prompt.mockResolvedValue(undefined);
  expect((await empty.run()).details.subagent.state).toBe('failed');
  const broken = fixture();
  broken.options.createSession.mockRejectedValue(new Error('secret-token raw-provider-response'));
  const result = await broken.run();
  expect(result.details.subagent.state).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('secret-token');
});

test('does not drop user constraints to fit input or accept invalid assignments', async () => {
  const f = fixture({ getUserInstructions: () => ({ userRequest: 'x'.repeat(49000) }) });
  expect((await f.run()).details.subagent.state).toBe('limited');
  expect(f.options.createSession).not.toHaveBeenCalled();
  expect((await f.run({ title: 'Review', task: '' })).details.subagent.state).toBe('failed');
});

test('installed Pi runs parent → isolated child → scoped read → report → parent with no external provider', () => {
  const { execFileSync } = require('node:child_process');
  const script = `
    (async () => {
      const assert = require('node:assert/strict');
      const { loadPiSdk } = require('./src/main/agent/pi-sdk');
      const { createIsolatedPiSession } = require('./src/main/agent/pi-session-factory');
      const { createSubagentTool } = require('./src/main/agent/pi-subagent-tools');
      const { trustBuiltInToolOverride } = require('./src/main/agent/pi-trusted-tools');
      const sdk = await loadPiSdk();
      const runtime = await sdk.ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [] },
        modelsPath: null, modelsStorePath: null, refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerProvider('delegate-test', { baseUrl: 'https://provider.invalid/v1', api: 'openai-completions',
        models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] });
      await runtime.setRuntimeApiKey('delegate-test', 'fixture-not-a-credential');
      const requests = [];
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); requests.push(body);
        const index = requests.length;
        const args = index === 1 ? { title: 'Inspect', task: 'Read README.md and report', context: 'selected context' } : { path: 'README.md' };
        const delta = index <= 2 ? { tool_calls: [{ index: 0, id: 'call-' + index, type: 'function',
          function: { name: index === 1 ? 'delegate_task' : 'read', arguments: JSON.stringify(args) } }] }
          : { content: index === 3 ? 'README.md describes a solar-system app.' : 'The helper inspected the README.' };
        const chunk = { id: 'response-' + index, object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta, finish_reason: index <= 2 ? 'tool_calls' : 'stop' }] };
        return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const owner = { userText: 'Inspect this project', subagentAbortController: new AbortController() };
      const model = runtime.getModel('delegate-test', 'test');
      let reads = 0; let receipt;
      const tool = createSubagentTool({ sdk, model, modelRuntime: runtime, getOwner: () => owner,
        onResult: (_owner, outcome) => { receipt = outcome.subagent; },
        createTools: async () => [trustBuiltInToolOverride({ name: 'read', label: 'Read', description: 'Read the granted project',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (_id, args) => { assert.equal(args.path, 'README.md'); reads++; return { content: [{ type: 'text', text: '# Solar system' }] }; } })] });
      const parent = await createIsolatedPiSession({ sdk, model, modelRuntime: runtime, customTools: [tool],
        enableBuiltInSkills: false, systemPrompt: 'Parent-only system instructions.' });
      await parent.session.prompt('Parent-private transcript marker. Delegate a read-only review.');
      assert.equal(reads, 1); assert.equal(requests.length, 4);
      assert.deepEqual(requests[1].tools.map(t => t.function.name), ['read']);
      assert.ok(!JSON.stringify(requests[1]).includes('Parent-private transcript marker'));
      assert.ok(!JSON.stringify(requests[1]).includes('Parent-only system instructions'));
      assert.ok(JSON.stringify(requests[1]).includes('selected context'));
      assert.equal(receipt.state, 'completed'); assert.equal(receipt.toolCalls, 1);
      assert.ok(JSON.stringify(requests[3]).includes('README.md describes a solar-system app.'));
      parent.session.dispose(); process.stdout.write('passed');
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 20000,
  })).toBe('passed');
});
