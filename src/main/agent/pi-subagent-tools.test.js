'use strict';

const { createSubagentTool } = require('./pi-subagent-tools');
const { trustBuiltInToolOverride, isTrustedBuiltInToolOverride } = require('./pi-trusted-tools');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function backgroundFixture(limits = {}) {
  const children = [];
  const f = fixture({ limits, createSession: jest.fn(async settings => {
    let listener;
    const passes = [];
    const child = { settings, passes,
      finish: (text = 'Report', tokens = 1) => {
        listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: { totalTokens: tokens } } });
        passes.at(-1).resolve();
      },
      session: { subscribe: jest.fn(fn => { listener = fn; return () => { listener = null; }; }),
        prompt: jest.fn(() => { const pass = deferred(); passes.push(pass); return pass.promise; }),
        abort: jest.fn(async () => {}), dispose: jest.fn() },
    };
    children.push(child);
    return { session: child.session };
  }) });
  const start = () => f.run({ title: 'Review', task: 'Inspect project', background: true });
  const control = (action, taskId, message) => f.tool.controlTools[0].execute('control', { action, taskId, ...(message !== undefined && { message }) });
  return { ...f, start, control, children };
}

describe('background delegation and messages', () => {
  test('returns before the helper finishes and delivers each result only once', async () => {
    const f = backgroundFixture();
    const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    expect(started.details.subagent.state).toBe('running');
    expect((await f.control('status', id)).details.helper.state).toBe('running');
    expect(f.tool.hasPending(f.owner)).toBe(true);
    const collected = f.tool.collect(f.owner);
    f.children[0].finish('Untrusted findings');
    expect(await collected).toEqual([expect.objectContaining({ report: 'Untrusted findings', state: 'completed' })]);
    expect(await f.tool.collect(f.owner)).toEqual([]);
    expect(f.options.onResult).toHaveBeenCalledWith(f.owner, expect.objectContaining({ background: true, subagent: expect.objectContaining({ state: 'completed' }) }));
    f.owner.subagentAbortController.abort(); await flush();
    expect(f.children[0].session.dispose).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('individual Stop cancels only its selected helper (background=%s)', async background => {
    const f = backgroundFixture();
    const pending = f.run({ background, tasks: [{ title: 'A', task: 'Inspect A' }, { title: 'B', task: 'Inspect B' }] });
    await flush();
    const ids = f.options.onResult.mock.calls[0][1].subagents.map(item => item.taskId);
    expect(await f.tool.stop({}, ids[0])).toBe(false);
    expect(await f.tool.stop(f.owner, 'unknown')).toBe(false);
    const read = f.children[0].settings.customTools.find(tool => tool.name === 'read');
    expect(await f.tool.stop(f.owner, ids[0])).toBe(true);
    expect(f.owner.subagentAbortController.signal.aborted).toBe(false);
    expect(f.children[1].session.abort).not.toHaveBeenCalled();
    await expect(read.execute('late', { path: 'README.md' })).rejects.toThrow('stopped');
    expect(await f.tool.stop(f.owner, ids[0])).toBe(false);
    f.children[0].finish('Late report');
    f.children[1].finish('B report'); await flush();
    const reports = background ? await f.tool.collect(f.owner) : (await pending).details.subagents;
    expect(reports.map(item => item.state)).toEqual(['cancelled', 'completed']);
    expect(reports[0].report).toBe('');
    if (background) expect((await f.control('message', ids[0], 'Restart')).isError).toBe(true);
    f.owner.subagentAbortController.abort();
  });

  test('individual Stop during setup disposes a late session without prompting it', async () => {
    const f = fixture(); const creation = deferred();
    f.options.createSession.mockReturnValue(creation.promise);
    const pending = f.run(); await flush();
    const id = f.options.onResult.mock.calls[0][1].subagent.taskId;
    expect(await f.tool.stop(f.owner, id)).toBe(true);
    expect((await pending).details.subagent.state).toBe('cancelled');
    creation.resolve({ session: f.session }); await flush();
    expect(f.session.prompt).not.toHaveBeenCalled();
    expect(f.session.dispose).toHaveBeenCalledTimes(1);
  });

  test('wait exposes a completed report without a second automatic delivery', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const waiting = f.control('wait', started.details.subagent.taskId);
    f.children[0].finish();
    expect((await waiting).details.helper.state).toBe('completed');
    expect(await f.tool.collect(f.owner)).toEqual([]);
    f.owner.subagentAbortController.abort();
  });

  test('many sequential background helpers share one cleanup listener and all dispose on Stop', async () => {
    const f = backgroundFixture();
    const { getEventListeners } = require('node:events');
    const signal = f.owner.subagentAbortController.signal;
    for (let i = 0; i < 12; i++) {
      await f.start(); await flush();
      f.children[i].finish();
      expect((await f.tool.collect(f.owner))[0].state).toBe('completed');
      expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    }
    signal.throwIfAborted();
    f.owner.subagentAbortController.abort(); await flush();
    for (const child of f.children) expect(child.session.dispose).toHaveBeenCalledTimes(1);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(await f.tool.collect(f.owner)).toEqual([]);
  });

  test('queues active messages between passes, preserving context without concurrent prompts', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    expect((await f.control('message', id, 'Also inspect keyboard access')).isError).toBe(false);
    expect(f.children[0].session.prompt).toHaveBeenCalledTimes(1);
    f.children[0].finish('First pass'); await flush();
    expect(f.children[0].session.prompt).toHaveBeenCalledTimes(2);
    expect(f.children[0].session.prompt.mock.calls[1][0]).toContain('Also inspect keyboard access');
    expect(f.options.onResult.mock.calls.every(([, value]) => (value.subagents || [value.subagent]).every(item => item.state === 'running'))).toBe(true);
    f.children[0].finish('Combined report');
    expect((await f.tool.collect(f.owner))[0].report).toBe('Combined report');
    expect(f.options.createSession).toHaveBeenCalledTimes(1);
    f.owner.subagentAbortController.abort();
  });

  test('resumes a completed helper in the same Pi session with fresh scoped tool closures', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    f.children[0].finish('Original report'); await f.tool.collect(f.owner);
    expect((await f.control('message', id, 'Check the evidence in README.md')).isError).toBe(false); await flush();
    const read = f.children[0].settings.customTools.find(tool => tool.name === 'read');
    await read.execute('follow-up-read', { path: 'README.md' });
    expect(f.read.execute).toHaveBeenCalledTimes(1);
    expect(isTrustedBuiltInToolOverride(read)).toBe(true);
    expect(f.options.createSession).toHaveBeenCalledTimes(1);
    f.children[0].finish('Checked README.md');
    expect((await f.tool.collect(f.owner))[0]).toMatchObject({ taskId: id, report: 'Checked README.md', toolCalls: 1 });
    f.owner.subagentAbortController.abort(); await flush();
    await expect(read.execute('late-read', { path: 'README.md' })).rejects.toThrow('stopped');
  });

  test('follow-up messages have no per-turn count quota', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    for (let i = 0; i < 10; i++) expect((await f.control('message', id, `Follow-up ${i}`)).isError).toBe(false);
    f.children[0].finish(); await flush();
    const prompt = JSON.parse(f.children[0].session.prompt.mock.calls[1][0]);
    expect(prompt.parentFollowUps).toHaveLength(10);
    f.children[0].finish('Combined report');
    expect((await f.tool.collect(f.owner))[0].state).toBe('completed');
    f.owner.subagentAbortController.abort();
  });

  test('completed helpers can resume repeatedly without a task-start quota', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    f.children[0].finish(); await f.tool.collect(f.owner);
    for (let i = 0; i < 6; i++) {
      expect((await f.control('message', started.details.subagent.taskId, 'Continue')).isError).toBe(false);
      await flush(); f.children[0].finish();
      expect((await f.tool.collect(f.owner))[0].state).toBe('completed');
    }
    expect(f.children).toHaveLength(1);
    f.owner.subagentAbortController.abort();
  });

  test('follow-ups retain usage counts without imposing a tool-call ceiling', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const read = f.children[0].settings.customTools.find(tool => tool.name === 'read');
    for (let i = 0; i < 30; i++) await read.execute(`first-${i}`, { path: 'README.md' });
    f.children[0].finish(); await f.tool.collect(f.owner);
    await f.control('message', started.details.subagent.taskId, 'Inspect again'); await flush();
    for (let i = 0; i < 30; i++) await read.execute(`second-${i}`, { path: 'README.md' });
    f.children[0].finish();
    expect((await f.tool.collect(f.owner))[0]).toMatchObject({ state: 'completed', toolCalls: 60 });
    expect(f.read.execute).toHaveBeenCalledTimes(60);
    f.owner.subagentAbortController.abort();
  });

  test('cancelling one wait releases the tool call without losing the owned background job', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const signal = new AbortController();
    const waiting = f.tool.controlTools[0].execute('wait', { action: 'wait', taskId: started.details.subagent.taskId }, signal.signal);
    signal.abort();
    expect((await waiting).isError).toBe(true);
    expect(f.tool.hasPending(f.owner)).toBe(true);
    f.children[0].finish('Still available');
    expect((await f.tool.collect(f.owner))[0].report).toBe('Still available');
    f.owner.subagentAbortController.abort();
  });

  test('a completed helper cannot resume while both slots are occupied', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    f.children[0].finish(); await f.tool.collect(f.owner);
    await f.run({ background: true, tasks: [{ title: 'B', task: 'Inspect B' }, { title: 'C', task: 'Inspect C' }] }); await flush();
    expect((await f.control('message', started.details.subagent.taskId, 'Check again')).isError).toBe(true);
    expect(f.options.createSession).toHaveBeenCalledTimes(3);
    f.owner.subagentAbortController.abort(); await flush();
  });

  test('Stop releases background waits even with an unresponsive provider and fences old task IDs', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    const waiting = f.control('wait', id);
    const collected = f.tool.collect(f.owner);
    f.owner.subagentAbortController.abort();
    f.owner.subagentAbortController = new AbortController();
    expect((await waiting).isError).toBe(true);
    expect(await collected).toEqual([]);
    expect((await f.control('message', id, 'Revive')).isError).toBe(true);
    f.children[0].finish('Late report'); await flush();
    expect(f.options.onResult.mock.calls.at(-1)[1].subagent.state).toBe('cancelled');
    expect(f.children[0].session.dispose).toHaveBeenCalledTimes(1);
  });

  test('rejects unknown task IDs, malformed messages and access from a different owner', async () => {
    const f = backgroundFixture(); const started = await f.start(); await flush();
    const id = started.details.subagent.taskId;
    for (const message of ['', 'x'.repeat(8001), '\u0000'.repeat(8000), null]) expect((await f.control('message', id, message)).isError).toBe(true);
    expect((await f.control('wait', 'delegate_' + 'f'.repeat(24))).isError).toBe(true);
    f.options.getOwner.mockReturnValue({ subagentAbortController: new AbortController() });
    expect((await f.control('message', id, 'Escape')).isError).toBe(true);
    f.owner.subagentAbortController.abort();
  });

  test('publishes one sibling report while the other is still active', async () => {
    const f = backgroundFixture();
    await f.run({ background: true, tasks: [{ title: 'A', task: 'Read A' }, { title: 'B', task: 'Read B' }] }); await flush();
    f.children[0].finish('A report');
    expect((await f.tool.collect(f.owner)).map(receipt => receipt.report)).toEqual(['A report']);
    expect(f.options.onResult.mock.calls.at(-1)[1].subagents.map(receipt => receipt.state)).toEqual(['completed', 'running']);
    f.children[1].finish('B report');
    expect((await f.tool.collect(f.owner)).map(receipt => receipt.report)).toEqual(['B report']);
    f.owner.subagentAbortController.abort();
  });
});

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

test('editing helper receives only its scoped controller, reports writes and releases ownership', async () => {
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ changedFiles: ['README.md'], attemptedFiles: ['README.md'], writesPending: false }) };
  const f = fixture({ createWriter: jest.fn(async () => scope) });
  const result = await f.run({ title: 'Improve README', task: 'Add setup instructions', mode: 'edit', files: ['README.md'] });
  expect(f.options.createWriter).toHaveBeenCalledWith(f.owner, ['README.md'], expect.any(AbortSignal));
  expect(f.options.createTools).toHaveBeenCalledWith(f.owner, scope.controller, undefined);
  expect(f.options.createSession.mock.calls[0][0].customTools.map(tool => tool.name)).toEqual(['read', 'write', 'edit']);
  expect(result.details.subagent).toMatchObject({ mode: 'edit', changedFiles: ['README.md'], state: 'completed' });
  expect(scope.release).toHaveBeenCalledTimes(1);
});

test('individual Stop preserves partial editing receipts and releases the writer without stopping the owner', async () => {
  const f = backgroundFixture();
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ changedFiles: ['README.md'], attemptedFiles: ['README.md', 'notes.md'], writesPending: true }) };
  f.options.createWriter = async () => scope;
  const started = await f.run({ title: 'Edit', task: 'Update docs', mode: 'edit', files: ['README.md', 'notes.md'], background: true });
  await flush();
  expect(await f.tool.stop(f.owner, started.details.subagent.taskId)).toBe(true);
  const reports = await f.tool.collect(f.owner);
  expect(reports[0]).toMatchObject({ state: 'cancelled', changedFiles: ['README.md'], attemptedFiles: ['README.md', 'notes.md'], writesPending: true });
  expect(scope.release).toHaveBeenCalledTimes(1);
  expect(f.owner.subagentAbortController.signal.aborted).toBe(false);
  f.owner.subagentAbortController.abort();
});

test('a writer scope returned after cancellation is released without starting a helper', async () => {
  const pending = deferred();
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({}) };
  const f = fixture({ createWriter: () => pending.promise });
  const running = f.run({ title: 'Edit', task: 'Update README', mode: 'edit', files: ['README.md'] });
  await flush(); f.owner.subagentAbortController.abort();
  expect((await running).details.subagent.state).toBe('cancelled');
  pending.resolve(scope); await flush();
  expect(scope.release).toHaveBeenCalledTimes(1);
  expect(f.options.createSession).not.toHaveBeenCalled();
});

test('editing follow-ups acquire fresh ownership and retain earlier changed-file receipts', async () => {
  const f = backgroundFixture();
  const scopes = [];
  f.options.createWriter = async () => {
    const changedFiles = scopes.length ? ['docs.md'] : ['README.md'];
    const scope = { controller: {}, release: jest.fn(), evidence: () => ({ changedFiles, attemptedFiles: changedFiles }) };
    scopes.push(scope); return scope;
  };
  const started = await f.run({ title: 'Edit', task: 'Update docs', mode: 'edit', files: ['README.md', 'docs.md'], background: true });
  await flush(); f.children[0].finish('First edit'); await f.tool.collect(f.owner);
  await f.control('message', started.details.subagent.taskId, 'Also update docs.md');
  await flush(); f.children[0].finish('Second edit');
  const receipts = await f.tool.collect(f.owner);
  expect(receipts[0].changedFiles).toEqual(['README.md', 'docs.md']);
  expect(scopes).toHaveLength(2);
  expect(scopes.every(scope => scope.release.mock.calls.length === 1)).toBe(true);
  expect(f.options.createTools).toHaveBeenLastCalledWith(f.owner, scopes[1].controller, undefined);
  f.owner.subagentAbortController.abort();
});

test('editing admission cannot broaden a read-only grant or admit two writers', async () => {
  const createWriter = jest.fn(async () => { throw Object.assign(new Error('private path'), { code: 'PROJECT_READ_ONLY' }); });
  const f = fixture({ createWriter });
  const task = { title: 'Edit', task: 'Improve README', mode: 'edit', files: ['README.md'] };
  expect((await f.run({ tasks: [task, task] })).isError).toBe(true);
  expect(createWriter).not.toHaveBeenCalled();
  const result = await f.run(task);
  expect(result.details.subagent.report).toContain('request_permissions');
  expect(result.details.subagent.report).not.toContain('private path');
  expect(f.options.createSession).not.toHaveBeenCalled();
});

test('stopping an editing helper retains partial write evidence and releases its scope', async () => {
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ changedFiles: ['README.md'], attemptedFiles: ['README.md', 'app.js'], writesPending: true }) };
  const f = fixture({ createWriter: async () => scope });
  f.session.prompt.mockImplementation(() => new Promise(() => {}));
  const running = f.run({ title: 'Edit', task: 'Update app', mode: 'edit', files: ['README.md', 'app.js'] });
  await flush(); f.owner.subagentAbortController.abort();
  const result = await running;
  expect(result.details.subagent).toMatchObject({ state: 'cancelled', mode: 'edit', changedFiles: ['README.md'], attemptedFiles: ['README.md', 'app.js'], writesPending: true });
  expect(scope.release).toHaveBeenCalledTimes(1);
});

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
  expect(f.options.onResult.mock.calls.filter(([, value]) => !value.background)).toHaveLength(1);
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
  expect(f.options.onResult.mock.calls.filter(([, value]) => !value.background)).toHaveLength(1);
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

test('completed foreground helpers free their slots without a per-turn start quota', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) expect((await f.run()).details.subagent.state).toBe('completed');
  expect(f.options.createSession).toHaveBeenCalledTimes(6);
});

test('elapsed time does not stop a helper, but Stop still detaches an unresponsive provider', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture();
    f.session.prompt.mockImplementation(() => new Promise(() => {}));
    const pending = f.run(); await flush();
    jest.advanceTimersByTime(60 * 60 * 1000); await flush();
    expect(f.session.abort).not.toHaveBeenCalled();
    expect(f.options.onResult.mock.calls.every(([, value]) => (value.subagents || [value.subagent]).every(item => item.state === 'running'))).toBe(true);
    f.owner.subagentAbortController.abort();
    expect((await pending).details.subagent).toMatchObject({ state: 'cancelled', durationMs: 3600000 });
    await flush(); expect(f.session.abort).toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('more than twelve model responses and large streamed output still produce a report', async () => {
  const f = fixture();
  f.session.prompt.mockImplementation(async () => {
    for (let i = 0; i < 20; i++) {
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(4000) } });
      f.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [], usage: { totalTokens: 15000 } } });
    }
    f.report('Final report');
  });
  expect((await f.run()).details.subagent).toMatchObject({ state: 'completed', report: 'Final report', totalTokens: 300012 });
});

test('shortens retained reports without cancelling, and handles missing reports and provider errors safely', async () => {
  const f = fixture();
  f.session.prompt.mockImplementation(async () => f.report('x'.repeat(40000)));
  const large = (await f.run()).details.subagent;
  expect(large).toMatchObject({ state: 'completed', reportTruncated: true });
  expect(large.report).toHaveLength(12000);
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

test.each(['single', 'parallel', 'background'])('installed Pi completes isolated delegation (%s) without an external provider', mode => {
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
      const mode = ${JSON.stringify(mode)};
      const parallel = mode !== "single";
      const background = mode === "background";
      const requests = [];
      let childStarts = 0; let release;
      const barrier = new Promise(resolve => { release = resolve; });
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); requests.push(body);
        const index = requests.length;
        const parent = body.tools.some(tool => tool.function.name === 'delegate_task');
        const hasResult = body.messages.some(message => message.role === 'tool');
        const call = !hasResult;
        const args = parent ? (parallel ? { tasks: [
          { title: 'First', task: 'Read README.md', context: 'context-first' },
          { title: 'Second', task: 'Read README.md', context: 'context-second' },
        ] } : { title: 'Inspect', task: 'Read README.md and report', context: 'selected context' }) : { path: 'README.md' };
        if (!parent && call && parallel) {
          if (++childStarts === 2 && !background) release();
          await barrier; // Both real Pi sessions must reach the transport concurrently.
        }
        if (parent && hasResult && background) release(); // Parent reaches its own next response while children are waiting.
        if (parent && background && call) args.background = true;
        const delta = call ? { tool_calls: [{ index: 0, id: 'call-' + index, type: 'function',
          function: { name: parent ? 'delegate_task' : 'read', arguments: JSON.stringify(args) } }] }
          : { content: parent ? 'The helpers inspected the README.' : 'README.md describes a solar-system app.' };
        const chunk = { id: 'response-' + index, object: 'chat.completion.chunk', created: 1, model: 'test',
          usage: { prompt_tokens: 80000, completion_tokens: 10, total_tokens: 80010 },
          choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] };
        return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const owner = { userText: 'Inspect this project', subagentAbortController: new AbortController() };
      const model = runtime.getModel('delegate-test', 'test');
      let reads = 0; let receipt;
      const tool = createSubagentTool({ sdk, model, modelRuntime: runtime, getOwner: () => owner,
        onResult: (_owner, outcome) => { receipt = outcome.subagents || [outcome.subagent]; },
        createTools: async () => [trustBuiltInToolOverride({ name: 'read', label: 'Read', description: 'Read the granted project',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (_id, args) => { assert.equal(args.path, 'README.md'); reads++; return { content: [{ type: 'text', text: '# Solar system' }] }; } })] });
      const parent = await createIsolatedPiSession({ sdk, model, modelRuntime: runtime, customTools: [tool, ...tool.controlTools],
        enableBuiltInSkills: false, systemPrompt: 'Parent-only system instructions.' });
      await parent.session.prompt('Parent-private transcript marker. Delegate a read-only review.');
      if (background) {
        let reports = [];
        while (reports.length < 2) reports.push(...await tool.collect(owner));
        await parent.session.sendCustomMessage({ customType: 'freedom_helper_reports', display: false, content: 'Untrusted helper reports: ' + JSON.stringify(reports) }, { triggerTurn: true });
      }
      assert.equal(reads, parallel ? 2 : 1); assert.equal(requests.length, background ? 7 : parallel ? 6 : 4);
      const childRequests = requests.filter(request => !request.tools.some(tool => tool.function.name === 'delegate_task') && !request.messages.some(message => message.role === 'tool'));
      assert.deepEqual(childRequests[0].tools.map(t => t.function.name), ['read']);
      assert.ok(!JSON.stringify(childRequests[0]).includes('Parent-private transcript marker'));
      assert.ok(!JSON.stringify(childRequests[0]).includes('Parent-only system instructions'));
      assert.ok(JSON.stringify(childRequests[0]).includes(parallel ? 'context-first' : 'selected context'));
      if (parallel) {
        assert.ok(!JSON.stringify(childRequests[0]).includes('context-second'));
        assert.ok(!JSON.stringify(childRequests[1]).includes('context-first'));
      }
      assert.equal(receipt.length, parallel ? 2 : 1);
      assert.ok(receipt.every(item => item.state === 'completed' && item.toolCalls === 1));
      assert.ok(receipt.every(item => item.totalTokens > 120000));
      assert.ok(JSON.stringify(requests.at(-1)).includes('README.md describes a solar-system app.'));
      owner.subagentAbortController.abort();
      parent.session.dispose(); process.stdout.write('passed');
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 20000,
  })).toBe('passed');
});

describe('parallel read-only assignments', () => {
  const tasks = [
    { title: 'Structure', task: 'Inspect structure', context: 'structure-only context' },
    { title: 'Accessibility', task: 'Inspect accessibility', context: 'accessibility-only context' },
  ];
  function parallelFixture(limits = {}) {
    const children = [];
    const f = fixture({ limits, createSession: jest.fn(async settings => {
      const done = deferred();
      let listener;
      const child = {
        settings, done, emit: event => listener?.(event),
        finish: (text, tokens = 1) => {
          listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
            content: [{ type: 'text', text }], usage: { totalTokens: tokens } } });
          done.resolve();
        },
        session: { subscribe: jest.fn(fn => { listener = fn; return jest.fn(); }),
          prompt: jest.fn(() => done.promise), abort: jest.fn(async () => {}), dispose: jest.fn() },
      };
      children.push(child);
      return { session: child.session };
    }) });
    return { ...f, children, batch: () => f.run({ tasks }) };
  }

  test('both helpers start before either finishes; contexts and reports remain independent and ordered', async () => {
    const f = parallelFixture();
    const pending = f.batch(); await flush();
    expect(f.children).toHaveLength(2);
    expect(f.children.every(child => child.session.prompt.mock.calls.length === 1)).toBe(true);
    expect(f.children[0].session.prompt.mock.calls[0][0]).not.toContain('accessibility-only');
    expect(f.children[1].session.prompt.mock.calls[0][0]).not.toContain('structure-only');
    expect((await f.run()).details.subagent.state).toBe('limited');
    f.children[1].finish('Accessibility report'); await flush();
    expect(f.options.onResult.mock.calls.at(-1)[1].subagents.map(item => item.state)).toEqual(['running', 'completed']);
    f.children[0].finish('Structure report');
    const result = await pending;
    expect(result.details.subagents.map(item => item.report)).toEqual(['Structure report', 'Accessibility report']);
    expect(new Set(result.details.subagents.map(item => item.taskId)).size).toBe(2);
    expect(result.isError).toBe(false);
  });

  test('rejects mixed forms, malformed batches and insufficient concurrency slots before starting either helper', async () => {
    const f = parallelFixture({ concurrency: 1 });
    expect((await f.batch()).details.subagent.state).toBe('limited');
    for (const input of [{ tasks, title: 'mixed' }, { tasks: [tasks[0]] }, { tasks: [...tasks, tasks[0]] }, { tasks: [tasks[0], { title: 'Empty' }] }]) {
      expect((await f.run(input)).details.subagent.state).toBe('failed');
    }
    expect(f.children).toHaveLength(0);
  });

  test('one failed helper does not discard the successful sibling report', async () => {
    const f = parallelFixture(); const pending = f.batch(); await flush();
    f.children[0].done.resolve();
    f.children[1].finish('Useful findings');
    const result = await pending;
    expect(result.details.subagents.map(item => item.state)).toEqual(['failed', 'completed']);
    expect(result.details.subagents[1].report).toBe('Useful findings');
  });

  test('Stop cancels both helpers and ignores late results', async () => {
    const f = parallelFixture(); const pending = f.batch(); await flush();
    f.children.forEach(child => child.session.abort.mockImplementation(() => new Promise(() => {})));
    f.owner.subagentAbortController.abort();
    expect((await pending).details.subagents.map(item => item.state)).toEqual(['cancelled', 'cancelled']);
    f.children.forEach(child => child.finish('Late result'));
    await flush();
    expect(f.options.onResult.mock.calls.filter(([, value]) => !value.background)).toHaveLength(1);
    expect(f.children.every(child => child.session.dispose.mock.calls.length === 1)).toBe(true);
  });

  test('a completed report survives cancellation of the remaining helper', async () => {
    const f = parallelFixture(); const pending = f.batch(); await flush();
    f.children[0].finish('Completed before steering'); await flush();
    f.owner.subagentAbortController.abort();
    expect((await pending).details.subagents.map(item => item.state)).toEqual(['completed', 'cancelled']);
  });

  test('the Mercury/Venus usage no longer cancels either sibling and counts remain accurate', async () => {
    const f = parallelFixture(); const pending = f.batch(); await flush();
    for (const [i, tokens] of [81806, 47594].entries()) f.children[i].emit({ type: 'message_end', message: { role: 'assistant',
      stopReason: 'toolUse', content: [], usage: { totalTokens: tokens } } });
    await flush();
    expect(f.children.every(child => child.session.abort.mock.calls.length === 0)).toBe(true);
    expect(f.options.onResult.mock.calls.every(([, value]) => (value.subagents || [value.subagent]).every(item => item.state === 'running'))).toBe(true);
    f.children[0].finish('Mercury report'); f.children[1].finish('Venus report');
    expect((await pending).details.subagents).toEqual([
      expect.objectContaining({ state: 'completed', report: 'Mercury report', totalTokens: 81807 }),
      expect.objectContaining({ state: 'completed', report: 'Venus report', totalTokens: 47595 }),
    ]);
  });

  test('both helpers can keep using tools beyond the former shared ceiling', async () => {
    const f = parallelFixture(); const pending = f.batch(); await flush();
    const reads = f.children.map(child => child.settings.customTools.find(tool => tool.name === 'read'));
    for (let i = 0; i < 30; i++) for (const read of reads) await read.execute(String(i), { path: 'README.md' });
    f.children[0].finish('A report'); f.children[1].finish('B report');
    expect((await pending).details.subagents.map(item => [item.state, item.toolCalls])).toEqual([['completed', 30], ['completed', 30]]);
    expect(f.read.execute).toHaveBeenCalledTimes(60);
  });

  test('long-running siblings complete independently without a shared time ceiling', async () => {
    jest.useFakeTimers();
    try {
      const f = parallelFixture(); const pending = f.batch(); await flush();
      jest.advanceTimersByTime(3600000);
      f.children[0].finish('Done'); await flush();
      jest.advanceTimersByTime(3600000); await flush();
      expect(f.children[1].session.abort).not.toHaveBeenCalled();
      f.children[1].finish('Also done');
      expect((await pending).details.subagents.map(item => [item.state, item.durationMs])).toEqual([['completed', 3600000], ['completed', 7200000]]);
    } finally { jest.useRealTimers(); }
  });

});

test('passes explicit browser tab IDs to the scope and child context, with actionable handoff failures', async () => {
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ tabIds: ['tab_parent'], browserActions: [] }) };
  const f = fixture({ createBrowser: jest.fn(async () => scope) });
  const task = { title: 'Review page', task: 'Inspect this existing page', mode: 'browser', tabIds: ['tab_parent'] };
  expect((await f.run(task)).details.subagent.state).toBe('completed');
  expect(f.options.createBrowser).toHaveBeenCalledWith(f.owner, expect.any(AbortSignal), expect.any(String), ['tab_parent']);
  expect(JSON.parse(f.session.prompt.mock.calls[0][0]).assignedTabIds).toEqual(['tab_parent']);
  f.options.createBrowser.mockRejectedValue(Object.assign(new Error('Wait for the owning helper to finish.'), { code: 'BROWSER_DELEGATION_UNAVAILABLE' }));
  expect((await f.run(task)).details.subagent).toMatchObject({ state: 'failed', report: 'Wait for the owning helper to finish.' });
});

test('a failed existing-tab reacquisition disposes the retained session without replaying the helper', async () => {
  const f = backgroundFixture();
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ tabIds: ['tab_parent'], browserActions: [] }) };
  f.options.createBrowser = jest.fn(async () => scope);
  const started = await f.run({ title: 'Browse', task: 'Inspect', mode: 'browser', tabIds: ['tab_parent'], background: true });
  await flush(); f.children[0].finish(); await f.tool.collect(f.owner);
  f.options.createBrowser.mockRejectedValue(Object.assign(new Error('Tab unavailable. List current task tabs.'), { code: 'BROWSER_DELEGATION_UNAVAILABLE' }));
  await f.control('message', started.details.subagent.taskId, 'Check again');
  expect((await f.tool.collect(f.owner))[0]).toMatchObject({ state: 'failed', report: 'Tab unavailable. List current task tabs.' });
  await flush();
  expect(f.children[0].session.dispose).toHaveBeenCalledTimes(1);
  expect(f.children[0].session.prompt).toHaveBeenCalledTimes(1);
  expect(f.options.createBrowser.mock.calls[1][3]).toEqual(['tab_parent']);
  f.owner.subagentAbortController.abort();
});

test('rejects malformed and overlapping tab assignments before starting helpers', async () => {
  const f = fixture();
  const task = { title: 'Browse', task: 'Inspect', mode: 'browser' };
  for (const tabIds of [null, [], [''], ['a', 'a'], Array(5).fill('a'), [123]]) {
    expect((await f.run({ ...task, tabIds })).details.subagent.state).toBe('failed');
  }
  expect((await f.run({ ...task, mode: 'read', tabIds: ['tab_parent'] })).details.subagent.state).toBe('failed');
  expect((await f.run({ tasks: [{ ...task, tabIds: ['tab_parent'] }, { ...task, tabIds: ['tab_parent'] }] })).isError).toBe(true);
  expect(f.options.createSession).not.toHaveBeenCalled();
});

test('browser mode receives only page tools, records browser evidence, and releases its scope', async () => {
  const scope = { controller: {}, release: jest.fn(), evidence: () => ({ tabIds: ['tab_child'], browserActions: [
    { operation: 'browser_snapshot', status: 'succeeded', pageTitle: '<script>untrusted</script>', origin: 'https://example.com' },
  ], browserPending: false }) };
  const f = fixture({ createBrowser: jest.fn(async () => scope) });
  const result = await f.run({ title: 'Inspect page', task: 'Open https://example.com and summarize', mode: 'browser' });
  expect(f.options.createBrowser).toHaveBeenCalledWith(f.owner, expect.any(AbortSignal), result.details.subagent.taskId, []);
  expect(f.options.createTools).toHaveBeenCalledWith(f.owner, undefined, scope);
  expect(f.options.createSession.mock.calls[0][0].customTools.map(tool => tool.name)).toEqual(['browser_navigate']);
  expect(f.options.createSession.mock.calls[0][0].systemPrompt).toContain('assignedTabIds');
  expect(result.details.subagent).toMatchObject({ mode: 'browser', tabIds: ['tab_child'], state: 'completed', browserActions: [
    { operation: 'browser_snapshot', status: 'succeeded', origin: 'https://example.com' },
  ] });
  expect(scope.release).toHaveBeenCalledTimes(1);
});

test('a browser scope returned after Stop is released without starting a session', async () => {
  const pending = deferred(); const scope = { release: jest.fn(), evidence: () => ({}) };
  const f = fixture({ createBrowser: () => pending.promise });
  const running = f.run({ title: 'Browse', task: 'Inspect', mode: 'browser' });
  await flush(); f.owner.subagentAbortController.abort();
  expect((await running).details.subagent).toMatchObject({ mode: 'browser', state: 'cancelled' });
  pending.resolve(scope); await flush();
  expect(scope.release).toHaveBeenCalledTimes(1);
  expect(f.options.createSession).not.toHaveBeenCalled();
});

test('browser follow-ups get new tab scopes and retain cumulative evidence', async () => {
  const f = backgroundFixture(); const scopes = [];
  f.options.createBrowser = () => {
    const scope = { release: jest.fn(), evidence: () => ({ tabIds: [`tab_${scopes.length}`], browserActions: [] }) };
    scopes.push(scope); return scope;
  };
  const result = await f.run({ title: 'Browse', task: 'Inspect', mode: 'browser', background: true }); await flush();
  const id = result.details.subagent.taskId;
  f.children[0].finish(); await f.tool.collect(f.owner);
  await f.control('message', id, 'Inspect another page'); await flush();
  f.children[0].finish(); const [receipt] = await f.tool.collect(f.owner);
  expect(receipt.tabIds).toEqual(['tab_1', 'tab_2']);
  expect(scopes.every(scope => scope.release.mock.calls.length === 1)).toBe(true);
  f.owner.subagentAbortController.abort();
});
