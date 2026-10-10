'use strict';

// Opt-in live spike. Read ONE JSON line from stdin: { baseUrl, apiKey, model }.
// Keep credentials in memory; print only synthetic test results and metadata.
// This sends small inference requests, but supplies no browser/workspace access.
const readline = require('readline');
const { randomUUID } = require('crypto');
const { loadPiSdk } = require('../src/main/agent/pi-sdk');
const { createIsolatedPiSession } = require('../src/main/agent/pi-session-factory');

async function main(config) {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Use an uncredentialed HTTPS API base URL.');
  }
  const baseUrl = base.href.replace(/\/$/, '');
  const apiKey = config.apiKey;
  const modelId = config.model;
  if (typeof apiKey !== 'string' || !apiKey || typeof modelId !== 'string' || !modelId) throw new Error('Missing probe configuration.');
  const report = (test, details) => console.log(JSON.stringify({ test, ...details }));
  const timedFetch = (url, options = {}) => {
    if (!String(url).startsWith(`${baseUrl}/`)) throw new Error('Unexpected probe destination');
    return fetch(url, { ...options, redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000) });
  };
  async function request(route, body) {
    const started = Date.now();
    const response = await timedFetch(`${baseUrl}${route}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Oversized probe response');
    let data;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const frames = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
      data = { done: frames.includes('[DONE]'), chunks: frames.filter(line => line && line !== '[DONE]').map(line => JSON.parse(line)) };
    } else { try { data = JSON.parse(text); } catch { data = {}; } }
    return { status: response.status, ms: Date.now() - started, data };
  }
  const tools = [{ type: 'function', function: { name: 'freedom_probe',
    description: 'Get a synthetic test value. No external effects.',
    parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } } }];
  const messages = [{ role: 'user', content: 'Reply with only ORBIT.' }];
  if (config.phase !== 'sessions') {
    const models = await request('/models');
    report('models', { status: models.status, ids: models.data.data?.map(m => m.id), ms: models.ms });
    for (const stream of [false, true]) {
      const result = await request('/chat/completions', { model: modelId, messages, max_tokens: 2048, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}) });
      const chunks = result.data.chunks || [];
      const text = stream ? chunks.map(c => c.choices?.[0]?.delta?.content || '').join('') : result.data.choices?.[0]?.message?.content;
      report(stream ? 'streaming-chat' : 'chat', { status: result.status, ms: result.ms, outputMatches: text?.trim() === 'ORBIT',
        returnedModel: stream ? chunks[0]?.model : result.data.model,
        finishReason: stream ? chunks.map(c => c.choices?.[0]?.finish_reason).filter(Boolean).at(-1) : result.data.choices?.[0]?.finish_reason,
        ...(stream ? { done: result.data.done, chunks: chunks.length } : {}),
        usage: stream ? chunks.find(c => c.usage)?.usage : result.data.usage });
    }
    const toolMessages = [{ role: 'user', content: 'Call freedom_probe with nonce ORBIT-731. Then reply with only the returned value.' }];
    const first = await request('/chat/completions', { model: modelId, messages: toolMessages, tools,
      tool_choice: { type: 'function', function: { name: 'freedom_probe' } }, stream: false, max_tokens: 2048 });
    const assistant = first.data.choices?.[0]?.message;
    const call = assistant?.tool_calls?.[0];
    report('tool-call', { status: first.status, valid: call?.function?.name === 'freedom_probe' &&
      JSON.parse(call.function.arguments).nonce === 'ORBIT-731', finishReason: first.data.choices?.[0]?.finish_reason });
    if (call) {
      const value = randomUUID();
      const followup = await request('/chat/completions', { model: modelId, tools, stream: false, max_tokens: 2048,
        messages: [...toolMessages, { role: 'assistant', content: assistant.content, tool_calls: assistant.tool_calls },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ value }) }] });
      report('tool-result', { status: followup.status, outputMatches: followup.data.choices?.[0]?.message?.content?.trim() === value });
    }
    const json = await request('/chat/completions', { model: modelId, stream: false, max_tokens: 2048,
      messages: [{ role: 'user', content: 'Reply with only the word POTATO.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true,
        schema: { type: 'object', properties: { value: { type: 'string', enum: ['ORBIT'] } }, required: ['value'], additionalProperties: false } } } });
    let schemaMatches = false;
    try { schemaMatches = JSON.parse(json.data.choices?.[0]?.message?.content).value === 'ORBIT'; } catch { /* Report unsupported/ignored below. */ }
    report('json-schema-conflicting-prompt', { status: json.status, schemaMatches });
    const invalid = await request('/chat/completions', { model: 'freedom-nonexistent-'+randomUUID(), messages, stream: false, max_tokens: 2048 });
    report('unknown-model', { status: invalid.status, rejected: invalid.status >= 400 });

  }

  const sdk = await loadPiSdk();
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Persistence disabled'); }, delete: async () => {} },
    modelsStore: { read: async () => undefined, write: async () => {}, delete: async () => {} } });
  const providerId = 'freedom-compatible-spike';
  runtime.registerProvider(providerId, { name: 'Compatibility spike', baseUrl, api: 'openai-completions',
    models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  // Deliberately no provider-specific compatibility flags: test Pi's defaults.
  await runtime.setRuntimeApiKey(providerId, apiKey);
  const model = runtime.getModel(providerId, modelId);
  if (config.phase !== 'sessions') {
    const context = { messages: [{ role: 'user', content: 'Reply with only PI_OK.', timestamp: Date.now() }] };
    const plain = await runtime.completeSimple(model, context, { fetch: timedFetch, maxRetries: 0, maxTokens: 2048 });
    report('pi-default-transport', { stopReason: plain.stopReason,
      outputMatches: plain.content.filter(c => c.type === 'text').map(c => c.text).join('').trim() === 'PI_OK' });
    const controller = new AbortController();
    const cancel = setTimeout(() => controller.abort(), 400);
    const cancelled = await runtime.completeSimple(model, context, { fetch: timedFetch, maxRetries: 0, signal: controller.signal });
    clearTimeout(cancel);
    report('pi-client-cancellation', { stopReason: cancelled.stopReason });

  }

  for (const codemode of [false, true]) {
    let calls = 0, output = '';
    const dispatchedTools = [];
    const value = randomUUID();
    const controlledRuntime = new Proxy(runtime, { get(target, key) {
      if (key === 'streamSimple') return (selected, ctx, options = {}) => target.streamSimple(selected, ctx,
        { ...options, fetch: timedFetch, maxRetries: 0, maxTokens: 2048 });
      const member = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    const { session } = await createIsolatedPiSession({ model, modelRuntime: controlledRuntime,
      enableCodemode: codemode, systemPrompt: 'You are a synthetic API test. Use only the provided tools. Reply with only their returned value.',
      customTools: [{ name: 'freedom_probe', label: 'Synthetic probe', description: 'Get a synthetic value. No external effects.',
        parameters: tools[0].function.parameters, execute: async (_id, args) => {
          if (args.nonce !== 'ORBIT-731') throw new Error('Incorrect probe nonce');
          calls++; return { content: [{ type: 'text', text: value }], details: {} };
        } }] });
    const stop = setTimeout(() => { void session.abort(); }, 45000);
    session.subscribe(event => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') output += event.assistantMessageEvent.delta;
      if (event.type === 'tool_execution_start') dispatchedTools.push(event.toolName);
    });
    try {
      await session.prompt(`Call freedom_probe with nonce ORBIT-731 exactly once${codemode ? ' through codemode' : ''}. Reply with only the returned value.`);
      report(codemode ? 'freedom-codemode' : 'freedom-tool-session', { calls, dispatchedTools, outputContainsResult: output.includes(value),
        ...(codemode ? { usedCodemode: dispatchedTools.includes('codemode') } : {}) });
    } finally { clearTimeout(stop); await session.dispose(); }
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', line => {
  input.close();
  Promise.resolve().then(() => main(JSON.parse(line))).catch(() => {
    // Errors may contain echoed provider payloads; never print them verbatim.
    console.error('Compatibility probe failed. No raw error or credentials were logged.');
    process.exitCode = 1;
  });
});
