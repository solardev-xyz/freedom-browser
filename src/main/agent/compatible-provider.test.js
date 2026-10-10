'use strict';

const { normalizeCompatibleUrl, normalizeCompatibleModels, compatibleFetch, discoverCompatibleModels, resolveCompatible, testCompatibleConnection } = require('./compatible-provider');

test('runtime uses rotated keys, preserves request observation, and blocks removed connections/models', async () => {
  let current = { kind: 'compatible', providerId: 'custom-11111111-1111-4111-8111-111111111111',
    name: 'Fixture', baseUrl: 'https://host.test/prefix/v1', models: [{ id: 'smart' }], modelId: 'smart', apiKey: 'first-fixture' };
  let model;
  const invoke = async (selected, _context, options) => options.fetch(`${selected.baseUrl}/chat/completions`);
  const runtime = {
    registerProvider: (id, config) => { model = { ...config.models[0], provider: id, baseUrl: config.baseUrl }; },
    setRuntimeApiKey: async () => {}, getModel: () => model,
    stream: invoke, streamSimple: invoke, complete: invoke, completeSimple: invoke,
  };
  const baseFetch = jest.fn(), observedFetch = jest.fn(async () => new Response('{}'));
  await resolveCompatible(current, runtime, baseFetch, () => current);
  await runtime.completeSimple(model, {}, { fetch: observedFetch });
  expect(observedFetch.mock.calls[0][1].headers.get('authorization')).toBe('Bearer first-fixture');
  current = { ...current, apiKey: 'rotated-fixture' };
  await runtime.completeSimple(model, {}, { fetch: observedFetch });
  expect(observedFetch.mock.calls[1][1].headers.get('authorization')).toBe('Bearer rotated-fixture');
  current = { ...current, models: [] };
  await expect(runtime.completeSimple(model, {}, { fetch: observedFetch })).rejects.toMatchObject({ code: 'AGENT_MODEL_UNAVAILABLE' });
  current = null;
  await expect(runtime.completeSimple(model, {}, { fetch: observedFetch })).rejects.toMatchObject({ code: 'AGENT_MODEL_UNAVAILABLE' });
  expect(observedFetch).toHaveBeenCalledTimes(2);
  expect(baseFetch).not.toHaveBeenCalled();
});

test('preserves custom API paths, including local and LAN endpoints, but refuses embedded secrets', () => {
  expect(normalizeCompatibleUrl('https://host.test/proxy/v1/')).toBe('https://host.test/proxy/v1');
  expect(normalizeCompatibleUrl('http://192.168.1.2:8000/v1')).toBe('http://192.168.1.2:8000/v1');
  for (const url of ['file:///tmp/key', 'https://user:secret@host.test/v1', 'https://host.test/v1?key=secret', 'https://host.test/v1#fragment']) {
    expect(() => normalizeCompatibleUrl(url)).toThrow();
  }
});

test('remote catalogue metadata cannot select URLs, credentials or assert capabilities', async () => {
  const fetch = jest.fn(async () => new Response(JSON.stringify({ data: [{ id: 'smart', baseUrl: 'https://foreign.test', apiKey: 'foreign', vision: true, privacy: 'tee' }] })));
  const models = await discoverCompatibleModels('https://host.test/prefix/v1', 'fixture-key', fetch);
  expect(models).toEqual([{ id: 'smart', name: 'smart', contextWindow: 32768, maxTokens: 4096, vision: false, reasoning: false, jsonSchema: false }]);
  expect(fetch.mock.calls[0][0]).toBe('https://host.test/prefix/v1/models');
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  expect(fetch.mock.calls[0][1].headers.get('authorization')).toBe('Bearer fixture-key');
  await expect(discoverCompatibleModels('https://host.test/v1', '', async () => new Response('private diagnostic', { status: 401 }))).rejects.toMatchObject({ code: 'AGENT_CUSTOM_DISCOVERY_FAILED' });
});

test('transport cannot forward credentials to another endpoint or follow redirects; keyless means no auth header', async () => {
  const fetch = jest.fn(async () => new Response('{}'));
  const request = compatibleFetch('http://localhost:1234/v1', '', fetch);
  await request('http://localhost:1234/v1/chat/completions', { headers: { authorization: 'Bearer placeholder' }, redirect: 'follow' });
  expect(fetch.mock.calls[0][1].headers.has('authorization')).toBe(false);
  expect(fetch.mock.calls[0][1].redirect).toBe('error');
  for (const url of ['https://foreign.test/v1/chat/completions', 'http://localhost:1234/v1/other', 'http://localhost:1234/v1/chat/completions/../models']) expect(() => request(url)).toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('validates manual model settings instead of trusting them as runtime configuration', () => {
  expect(normalizeCompatibleModels([{ id: 'org/model', contextWindow: 64000, maxTokens: 2048, vision: true }])[0].vision).toBe(true);
  for (const models of [[], [{ id: 'a' }, { id: 'a' }], [{ id: 'a', contextWindow: 1024, maxTokens: 2048 }], [{ id: 'a\n' }]]) expect(() => normalizeCompatibleModels(models)).toThrow();
});


test.each([
  ['success', 'tools_verified', undefined],
  ['chat-error', 'failed', 'chat'],
  ['no-deltas', 'chat_only', 'streaming'],
  ['no-tools', 'chat_only', 'toolCall'],
  ['wrong-result', 'chat_only', 'toolResult'],
])('compatibility check reports the exact stage: %s', async (mode, outcome, failedStage) => {
  const runtime = {
    streamSimple: jest.fn(() => ({
      async *[Symbol.asyncIterator]() {
        if (mode === 'chat-error') throw new Error('private diagnostic');
        if (mode !== 'no-deltas') yield { type: 'text_delta', delta: 'OK' };
      },
      result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] }),
    })),
    completeSimple: jest.fn(async (_model, context) => {
      const toolResult = context.messages.find(m => m.role === 'toolResult');
      if (toolResult) return { stopReason: 'stop', content: [{ type: 'text', text: mode === 'wrong-result' ? 'ignored' : toolResult.content[0].text }] };
      if (mode === 'no-tools') return { stopReason: 'stop', content: [{ type: 'text', text: 'No tool call' }] };
      return { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'connection_probe', arguments: { nonce: context.tools[0].parameters.properties.nonce.enum[0] } }] };
    }),
  };
  const result = await testCompatibleConnection({ maxTokens: 4096 }, runtime, new AbortController().signal);
  expect(result.outcome).toBe(outcome);
  expect(result.failedStage).toBe(failedStage);
  expect(JSON.stringify(result)).not.toContain('private diagnostic');
  if (outcome === 'tools_verified') expect(result.checks).toEqual({ chat: true, streaming: true, toolCall: true, toolResult: true });
  if (['chat-error', 'no-deltas'].includes(mode)) expect(runtime.completeSimple).not.toHaveBeenCalled();
});
