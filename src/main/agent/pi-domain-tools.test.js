'use strict';

const { createDomainTools } = require('./pi-domain-tools');
const { DomainError } = require('../domains/contracts');

function fixture() {
  const service = { inspect: jest.fn(async () => ({ name: 'test.eth' })), prepare: jest.fn(async () => ({})),
    execute: jest.fn(async () => ({ operationId: 'domain_fixture', state: 'pending' })), status: jest.fn(async () => ({})) };
  const options = { sdk: { defineTool: definition => definition }, service, conversationId: 'chat',
    requestApproval: jest.fn(), onToolOutcome: jest.fn(), onPending: jest.fn() };
  return { tools: createDomainTools(options), service, options };
}
test('domain tools expose typed operations, not raw transactions or secrets', () => {
  const f = fixture();
  expect(f.tools.map(tool => tool.name)).toEqual(['domain_inspect', 'domain_prepare', 'domain_execute', 'domain_operation_status']);
  for (const tool of f.tools) {
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(Object.keys(tool.parameters.properties)).not.toEqual(expect.arrayContaining(['calldata', 'abi', 'secret']));
    expect(tool.executionMode).toBe('sequential');
  }
});
test('pending operations are retained for lifecycle continuation with the run signal', async () => {
  const f = fixture(); const controller = new AbortController();
  const tools = createDomainTools({ ...f.options, getRunSignal: () => controller.signal });
  await tools[2].execute('tool-id', { operationId: 'domain_fixture' });
  expect(f.options.onPending).toHaveBeenCalledWith('domain_fixture', true);
  expect(f.service.execute).toHaveBeenCalledWith('domain_fixture', expect.objectContaining({ conversationId: 'chat', signal: controller.signal, requestApproval: expect.any(Function) }));
  const context = f.service.execute.mock.calls[0][1];
  await context.requestApproval({ action: 'wallet_transaction' });
  expect(f.options.requestApproval).toHaveBeenCalledWith({ action: 'wallet_transaction' }, controller.signal);
});
test('RPC failures never echo calldata/preimages to model output, local domain errors stay useful', async () => {
  const f = fixture();
  f.service.execute.mockRejectedValue(new Error('secret reveal calldata fixture'));
  const result = await f.tools[2].execute('tool-id', { operationId: 'domain_fixture' });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret reveal');
  f.service.inspect.mockRejectedValue(new DomainError('DOMAIN_INVALID', 'Choose a full supported name.'));
  expect((await f.tools[0].execute('inspect', { name: 'bad' })).content[0].text).toBe('Choose a full supported name.');
});
test('a stopped run cannot begin a domain operation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  const tools = createDomainTools({ ...f.options, getRunSignal: () => controller.signal });
  expect((await tools[2].execute('tool-id', { operationId: 'domain_fixture' })).isError).toBe(true);
  expect(f.service.execute).not.toHaveBeenCalled();
});
test('large read results are shortened in memory without spilling private data to a file', async () => {
  const f = fixture();
  f.service.inspect.mockResolvedValue({ records: { text: 'x'.repeat(65000) } });
  const result = await f.tools[0].execute('inspect', { name: 'test.eth' });
  expect(result.structuredContent.result).toMatchObject({ truncated: true });
  expect(result.content[0].text.length).toBeLessThan(1000);
});
