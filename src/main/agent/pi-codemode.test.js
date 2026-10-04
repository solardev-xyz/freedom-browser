'use strict';

const { serializeSessionTools } = require('./pi-codemode');

test('read batches overlap but writes and subsequent reads keep their order', async () => {
  const events = [];
  let releaseReads;
  const pendingRead = new Promise(resolve => { releaseReads = resolve; });
  const [read, write] = serializeSessionTools([
    { name: 'read', execute: async (_id, { index }) => {
      events.push(`read-${index}`);
      if (index < 3) await pendingRead;
      return index;
    } },
    { name: 'write', execute: async () => { events.push('write'); } },
  ]);
  const first = read.execute('a', { index: 1 });
  const second = read.execute('b', { index: 2 });
  const changed = write.execute('c', {});
  const later = read.execute('d', { index: 3 });
  await Promise.resolve();
  expect(events).toEqual(['read-1', 'read-2']);
  releaseReads();
  expect(await Promise.all([first, second, changed, later])).toEqual([1, 2, undefined, 3]);
  expect(events).toEqual(['read-1', 'read-2', 'write', 'read-3']);
});

test('a cancelled queued mutation never executes, and a failure does not poison later calls', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const execute = jest.fn(async (_id, { fail }) => { if (fail) throw new Error('failed'); });
  const [read, write] = serializeSessionTools([{ name: 'read', execute: () => pending }, { name: 'write', execute }]);
  const signal = new AbortController();
  const reading = read.execute('a', {});
  const cancelled = write.execute('b', {}, signal.signal);
  signal.abort();
  release();
  await reading;
  await expect(cancelled).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await expect(write.execute('c', { fail: true })).rejects.toThrow('failed');
  await write.execute('d', {});
  expect(execute).toHaveBeenCalledTimes(2);
});

test('native helper scripts retain scoped tools, approval, activity, follow-up bindings and cancellation', () => {
  const { execFileSync } = require('node:child_process');
  const script = String.raw`
(async () => {
  const assert = require('node:assert/strict');
  const { loadPiSdk } = require('./src/main/agent/pi-sdk');
  const { createSubagentTool } = require('./src/main/agent/pi-subagent-tools');
  const { trustBuiltInToolOverride } = require('./src/main/agent/pi-trusted-tools');
  const sdk = await loadPiSdk();
  const runtime = await sdk.ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [] },
    modelsPath: null, modelsStorePath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('script-test', { baseUrl: 'https://provider.invalid/v1', api: 'openai-completions',
    models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } }] });
  await runtime.setRuntimeApiKey('script-test', 'fixture-not-a-credential');
  const model = runtime.getModel('script-test', 'test');
  const output = text => ({ content: [{ type: 'text', text }], details: {} });
  let activeCode, expectedTools, lastResult;
  let sequence = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), expectedTools.slice().sort());
    const system = body.messages.find(message => message.role === 'system').content;
    assert.match(system, /Choose codemode yourself/);
    assert.match(system, /Scripts can use only the tools supplied for your assignment/);
    assert(!system.includes('Use background helpers for parallel browser work'));
    const call = body.messages.at(-1).role !== 'tool';
    if (!call) lastResult = body.messages.at(-1).content;
    const delta = call ? { tool_calls: [{ index: 0, id: 'script-' + ++sequence, type: 'function',
      function: { name: 'codemode', arguments: JSON.stringify({ code: activeCode }) } }] } : { content: 'Report ready' };
    const chunk = { id: 'response-' + sequence, object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  for (const mode of ['read', 'edit', 'browser']) {
    const owner = { userText: 'Inspect the assigned scope', subagentAbortController: new AbortController() };
    const calls = [], progress = [], browserActions = [];
    let pass = 0, runningReads = 0, maxReads = 0, approved = false, completedWrites = 0;
    let releaseReads;
    const bothReads = new Promise(resolve => { releaseReads = resolve; });
    const writer = { controller: {}, release: () => {}, evidence: () => ({ changedFiles: completedWrites ? ['owned.md'] : [], attemptedFiles: ['owned.md'] }) };
    const browser = { controller: {}, release: () => {}, evidence: () => ({ tabIds: ['owned-tab'], browserActions }) };
    let blockSnapshot = false, snapshotStarted;
    const snapshotReady = new Promise(resolve => { snapshotStarted = resolve; });
    const tool = createSubagentTool({ sdk, model, modelRuntime: runtime, getOwner: () => owner,
      onProgress: (_owner, _title, count) => progress.push(count),
      createWriter: async (_owner, files) => { assert.deepEqual(files, ['owned.md']); return writer; },
      createBrowser: async (_owner, _signal, _id, tabIds) => { assert.deepEqual(tabIds, ['owned-tab']); return browser; },
      createTools: async (_owner, scopedWriter, scopedBrowser) => {
        const scope = ++pass;
        assert.equal(scopedWriter, mode === 'edit' ? writer.controller : undefined);
        assert.equal(scopedBrowser, mode === 'browser' ? browser : undefined);
        const define = (name, execute) => ({ name, label: name, description: name,
          parameters: { type: 'object', properties: { path: { type: 'string' }, tabId: { type: 'string' } } }, execute });
        return [
          trustBuiltInToolOverride(define('read', async (id, args, signal) => {
            signal.throwIfAborted(); assert.match(id, /^delegate_.*:/); calls.push(['read', scope, args.path]);
            if (mode === 'read' && scope === 1) {
              runningReads++; maxReads = Math.max(maxReads, runningReads);
              if (runningReads === 2) releaseReads();
              await bothReads; runningReads--;
            }
            return output('scope-' + scope);
          })),
          trustBuiltInToolOverride(define('write', async (id, args, signal) => {
            signal.throwIfAborted(); assert.match(id, /^delegate_.*:/); assert.equal(args.path, 'owned.md');
            assert(calls.some(call => call[0] === 'read' && call[2] === args.path));
            completedWrites++; calls.push(['write', scope, args.path]); return output('saved');
          })),
          define('browser_snapshot', async (id, args, signal) => {
            assert.match(id, /^delegate_.*:/); assert.equal(args.tabId, 'owned-tab'); calls.push(['snapshot', scope]);
            if (blockSnapshot) {
              snapshotStarted();
              await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
              signal.throwIfAborted();
            }
            browserActions.push({ operation: 'browser_snapshot', status: 'succeeded' }); return output('page');
          }),
          define('browser_click', async (id, args, signal) => {
            signal.throwIfAborted(); assert.match(id, /^delegate_.*:/); assert.equal(args.tabId, 'owned-tab');
            assert(calls.some(call => call[0] === 'snapshot'));
            calls.push(['approval', scope]); // The scoped controller's approval boundary is still invoked.
            if (!approved) return { ...output('declined'), isError: true };
            browserActions.push({ operation: 'browser_click', status: 'succeeded' }); return output('clicked');
          }),
          ...['bash', 'delegate_task', 'mcp_request', 'request_permissions'].map(name => define(name, () => { throw new Error('Forbidden executor reached'); })),
        ];
      },
    });
    expectedTools = mode === 'read' ? ['read', 'codemode'] : mode === 'edit' ? ['read', 'write', 'codemode'] : ['browser_snapshot', 'browser_click', 'codemode'];
    const absent = ['bash', 'delegate_task', 'mcp_request', 'request_permissions', ...(mode === 'read' ? ['write'] : mode === 'browser' ? ['read', 'write'] : ['browser_click'])];
    const inspect = absent.map(name => 'try { await tools.' + name + '({}); } catch (error) { text("' + name + '=blocked"); }').join('') + 'text("host=" + typeof process + "," + typeof fetch + "," + typeof models);';
    activeCode = inspect + (mode === 'read'
      ? 'store("marker", "retained"); text(await Promise.allSettled([tools.read({path:"a.md"}), tools.read({path:"b.md"})]));'
      : mode === 'edit' ? 'text(await tools.read({path:"owned.md"})); text(await tools.write({path:"owned.md"})); throw new Error("after-write");'
        : 'const results = await Promise.allSettled([tools.browser_snapshot({tabId:"owned-tab"}), tools.browser_click({tabId:"owned-tab"})]); for (const result of results) text(result.status === "rejected" ? String(result.reason) : result.value);');
    const params = { title: mode, task: 'Inspect scope', mode, background: true,
      ...(mode === 'edit' ? { files: ['owned.md'] } : mode === 'browser' ? { tabIds: ['owned-tab'] } : {}) };
    const started = await tool.execute('start', params);
    const taskId = started.details.subagent.taskId;
    const [report] = await tool.collect(owner);
    assert.equal(report.state, 'completed'); assert.equal(report.toolCalls, 2, mode + ': ' + lastResult);
    assert(progress.length > 0);
    if (mode !== 'edit') {
      for (const name of absent) assert(lastResult.includes(name + '=blocked'), lastResult);
      assert(lastResult.includes('host=undefined,undefined,undefined'), lastResult);
    }
    if (mode === 'edit') {
      assert.equal(completedWrites, 1); assert.deepEqual(report.changedFiles, ['owned.md']);
      assert(lastResult.includes('after-write'), lastResult);
    } else {
      if (mode === 'read') {
        assert.equal(maxReads, 2);
        activeCode = 'text(load("marker")); text(await tools.read({path:"c.md"}));';
      } else {
        assert(lastResult.includes('declined'), lastResult);
        assert.equal(report.browserActions.filter(action => action.operation === 'browser_click').length, 0);
        approved = true;
      }
      await tool.controlTools[0].execute('follow-up', { action: 'message', taskId, message: 'Continue with the current scope' });
      const [followUp] = await tool.collect(owner);
      assert.equal(followUp.state, 'completed');
      if (mode === 'read') {
        assert(lastResult.includes('retained') && lastResult.includes('scope-2'), lastResult);
        assert.equal(followUp.toolCalls, 3);
      } else {
        assert.equal(followUp.browserActions.filter(action => action.operation === 'browser_click').length, 1);
        const approvalsBeforeStop = calls.filter(call => call[0] === 'approval').length;
        blockSnapshot = true;
        await tool.controlTools[0].execute('stop-pass', { action: 'message', taskId, message: 'Inspect again' });
        await snapshotReady;
        assert.equal(await tool.stop(owner, taskId), true);
        const [stopped] = await tool.collect(owner);
        assert.equal(stopped.state, 'cancelled');
        assert.equal(owner.subagentAbortController.signal.aborted, false);
        await tool.settle(owner);
        assert.equal(calls.filter(call => call[0] === 'approval').length, approvalsBeforeStop);
      }
    }
    owner.subagentAbortController.abort();
  }
  process.stdout.write('passed');
})().catch(error => { console.error(error); process.exit(1); });
`;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 20000,
  })).toBe('passed');
}, 25000);
