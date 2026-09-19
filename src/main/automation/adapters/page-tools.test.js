'use strict';

const vm = require('vm');
const { PageTools } = require('./page-tools');

function fixture({ manual = false, timeoutMs = 500 } = {}) {
  const context = new EventTarget();
  const window = {};
  const tool = {
    name: 'echo',
    description: 'Echo a value',
    window,
    inputSchema: JSON.stringify({ type: 'object', properties: { value: { type: 'string' } } }),
  };
  context.getTools = jest.fn(async () => [tool, { ...tool, name: 'child_tool', window: {} }]);
  context.executeTool = jest.fn(async (_tool, args) => args);
  const isolate = vm.createContext({
    document: {
      modelContext: context,
      forms: manual
        ? [
            {
              getAttribute: () => 'echo',
              hasAttribute: () => false,
              action: 'https://example.test/',
              method: 'post',
            },
          ]
        : [],
    },
    window,
    isSecureContext: true,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  let identity = 'document_one';
  const evaluate = (fn, args) =>
    vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`, isolate);
  const page = new PageTools({
    evaluate,
    identity: () => identity,
    url: () => 'https://example.test/',
    timeoutMs,
  });
  return {
    page,
    context,
    tool,
    isolate,
    navigate: () => {
      identity = 'document_two';
      page.invalidate();
    },
  };
}

async function request(page) {
  const { tools } = await page.list();
  const input = { toolRef: tools[0].toolRef, arguments: { value: 'hello' } };
  return { input, execution: { expectedPageTool: JSON.stringify(await page.inspect(input)) } };
}

test('native discovery excludes frames and exposes bounded untrusted schemas', async () => {
  const { page, tool } = fixture();
  expect(await page.list()).toMatchObject({
    available: true,
    untrusted: true,
    tools: [{ name: 'echo' }],
  });
  tool.description = 'a'.repeat(2_001);
  expect(await page.list()).toMatchObject({ tools: [], truncated: true });
});

test('unsupported contexts have no executable fallback', async () => {
  const { page, isolate } = fixture();
  vm.runInContext('document.modelContext = undefined', isolate);
  expect(await page.list()).toMatchObject({ available: false, tools: [] });
});

test('exact approval binds document, definition and arguments', async () => {
  const { page, context } = fixture();
  const { input, execution } = await request(page);
  await expect(page.call(input)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  await expect(
    page.call({ ...input, arguments: { value: 'changed' } }, execution)
  ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  expect(context.executeTool).not.toHaveBeenCalled();
  expect(await page.call(input, execution)).toMatchObject({
    status: 'completed',
    output: '{"value":"hello"}',
    untrusted: true,
  });
  expect(context.executeTool).toHaveBeenCalledTimes(1);
});

test.each(['event', 'definition', 'navigation', 'rediscovery', 'stop'])(
  '%s invalidates an approved reference before execution',
  async (change) => {
    const { page, context, tool, navigate } = fixture();
    const { input, execution } = await request(page);
    if (change === 'event') context.dispatchEvent(new Event('toolchange'));
    if (change === 'definition') tool.description = 'Replaced';
    if (change === 'navigation') navigate();
    if (change === 'rediscovery') await page.list();
    if (change === 'stop') page.cancel();
    await expect(page.call(input, execution)).rejects.toMatchObject({
      code: 'STALE_ELEMENT_REFERENCE',
    });
    expect(context.executeTool).not.toHaveBeenCalled();
  }
);

test('stop forwards abort but does not promise to undo website effects', async () => {
  const { page, context } = fixture();
  let signal;
  context.executeTool.mockImplementation((_tool, _args, options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const { input, execution } = await request(page);
  const abort = new AbortController();
  const pending = page.call(input, { ...execution, signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  expect(await pending).toMatchObject({ status: 'cancelled', mayHaveChanged: true });
  expect(signal.aborted).toBe(true);
});

test('timeout and navigation never replay a potentially applied call', async () => {
  const { page, context, navigate } = fixture({ timeoutMs: 60 });
  context.executeTool.mockImplementation(() => new Promise(() => {}));
  let args = await request(page);
  expect(await page.call(args.input, args.execution)).toMatchObject({
    status: 'timed_out',
    mayHaveChanged: true,
  });
  args = await request(page);
  const pending = page.call(args.input, args.execution);
  await new Promise((resolve) => setTimeout(resolve, 10));
  navigate();
  expect(await pending).toMatchObject({ status: 'outcome_unknown', mayHaveChanged: true });
  expect(context.executeTool).toHaveBeenCalledTimes(2);
  // Dispose the still-live isolated document in this simulated navigation.
  await page.bridge('cancel');
});

test('manual forms remain pending and discovery reads completion without resubmission', async () => {
  const { page, context } = fixture({ manual: true });
  let finish;
  context.executeTool.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { input, execution } = await request(page);
  expect(await page.call(input, execution)).toMatchObject({ status: 'awaiting_user' });
  await expect(page.call(input, execution)).rejects.toMatchObject({
    code: 'CAPABILITY_UNAVAILABLE',
  });
  finish('{"submitted":true}');
  await Promise.resolve();
  expect(await page.list()).toMatchObject({
    execution: { status: 'completed', output: '{"submitted":true}' },
  });
  expect(context.executeTool).toHaveBeenCalledTimes(1);
});

test('large output is bounded and raw website exceptions are not propagated', async () => {
  const { page, context } = fixture();
  context.executeTool.mockResolvedValue('x'.repeat(40_000));
  let args = await request(page);
  const result = await page.call(args.input, args.execution);
  expect(result.output).toHaveLength(32_768);
  expect(result.outputTruncated).toBe(true);
  context.executeTool.mockRejectedValue(new Error('Untrusted error body'));
  args = await request(page);
  expect(await page.call(args.input, args.execution)).toMatchObject({
    status: 'failed',
    errorCategory: 'ToolError',
  });
});

test('chrome preview filters unsupported tools without invalidating agent approval references', async () => {
  const { page, context, tool } = fixture();
  const { input, execution } = await request(page);
  context.getTools.mockResolvedValue([tool, { ...tool, name: 'unsupported', inputSchema: JSON.stringify({ $ref: '#/definitions/input' }) }]);
  const preview = await page.preview();
  expect(preview.tools).toEqual([{ name: tool.name, description: tool.description }]);
  expect(preview.truncated).toBe(true);
  expect(preview.tools[0]).not.toHaveProperty('toolRef');
  expect(context.executeTool).not.toHaveBeenCalled();
  expect(JSON.stringify(await page.inspect(input))).toBe(execution.expectedPageTool);
  expect((await page.call(input, execution)).status).toBe('completed');
});

test('chrome preview rejects results from a replaced document', async () => {
  const { page, context, navigate } = fixture();
  let finish;
  context.getTools.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = page.preview();
  navigate();
  finish([]);
  await expect(pending).rejects.toMatchObject({ code: 'STALE_ELEMENT_REFERENCE' });
});
