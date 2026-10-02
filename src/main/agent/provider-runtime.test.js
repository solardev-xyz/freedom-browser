'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// Real installed Pi transport, fake HTTP only: catches adapter and onPayload drift.
test('custom providers stream tool calls and apply privacy to stream and completion paths', () => {
  const script = `
    (async () => {
      const assert = require('assert/strict');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { AgentProviderStore } = require('./src/main/agent/provider-store');
      const { AgentProviderResolver } = require('./src/main/agent/provider-resolver');
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-provider-runtime-'));
      const store = new AgentProviderStore({ dataDir, safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text), decryptString: (buffer) => buffer.toString(),
      } });
      const descriptor = { id: 'test', name: 'Test', tools: true, available: true,
        privacy: 'tee', contextWindow: 32000, maxTokens: 4096 };
      const catalog = { get: (id) => ['venice', 'near-ai', 'openrouter', 'meta'].includes(id)
        ? { updatedAt: Date.now(), models: [descriptor] } : { models: [] } };
      const resolver = new AgentProviderResolver({ store, dataDir, catalog });
      let requests = [];
      const fetch = async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body), authorization: new Headers(init.headers).get('authorization') });
        const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
            { index: 0, id: 'call_test', type: 'function', function: { name: 'inspect', arguments: '{"value":1}' } }
          ] }, finish_reason: 'tool_calls' }] };
        return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      const context = { messages: [{ role: 'user', content: 'Test', timestamp: Date.now() }],
        tools: [{ name: 'inspect', description: 'Inspect', parameters: { type: 'object', properties: { value: { type: 'number' } } } }] };
      for (const providerId of ['meta', 'venice', 'near-ai', 'openrouter']) {
        store.saveHosted({ providerId, modelId: 'test', apiKey: 'test-key' });
        store.savePreferences(providerId, { privacyPolicy: providerId === 'openrouter' ? 'zdr' : providerId === 'meta' ? 'standard' : 'tee' });
        const resolved = await resolver.resolveModel();
        const runtime = resolved.modelRuntime;
        assert(runtime.getModels('xai').length > 0);
        let lastMessage;
        for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple']) {
          const result = runtime[method](resolved.model, context, { fetch, maxRetries: 0,
            onPayload: (payload) => ({ ...payload, provider: { zdr: false }, plugins: [{ id: 'web' }],
              venice_parameters: { enable_web_search: 'on' } }),
          });
          const message = await (method.startsWith('stream') ? result.result() : result);
          lastMessage = message;
          assert.equal(message.stopReason, 'toolUse', message.errorMessage);
          assert.equal(message.content[0].type, 'toolCall');
          assert.deepEqual(message.content[0].arguments, { value: 1 });
          const sent = requests.at(-1);
          assert.equal(sent.authorization, 'Bearer test-key');
          assert.equal(sent.body.messages[0].content, 'Test');
          assert.equal(sent.body.tools[0].function.name, 'inspect');
          if (providerId === 'openrouter') {
            assert.equal(sent.body.provider.zdr, true);
            assert.equal(sent.body.provider.data_collection, 'deny');
            assert.equal(sent.body.provider.require_parameters, true);
            assert.deepEqual(sent.body.plugins, []);
          }
          if (providerId === 'venice') {
            assert.equal(sent.body.venice_parameters.enable_web_search, 'off');
            assert.equal(sent.body.venice_parameters.include_venice_system_prompt, false);
          }
        }
        const continued = await runtime.completeSimple(resolved.model, {
          ...context, messages: [...context.messages, lastMessage, {
            role: 'toolResult', toolCallId: 'call_test', toolName: 'inspect',
            content: [{ type: 'text', text: 'tool result' }], isError: false, timestamp: Date.now(),
          }],
        }, { fetch, maxRetries: 0 });
        assert.equal(continued.stopReason, 'toolUse', continued.errorMessage);
        assert(requests.at(-1).body.messages.some((item) => item.role === 'tool' && item.content === 'tool result'));
        const stopped = new AbortController();
        stopped.abort();
        const beforeAbort = requests.length;
        const aborted = await runtime.completeSimple(resolved.model, context, { fetch, signal: stopped.signal, maxRetries: 0 });
        // Pi may represent an abort during credential resolution as an error event.
        assert(['error', 'aborted'].includes(aborted.stopReason));
        assert.match(aborted.errorMessage, /abort/i);
        assert.equal(requests.length, beforeAbort);
        // Policy is re-read by an already-created runtime; no new session is needed.
        if (providerId === 'venice') {
          descriptor.privacy = 'anonymized';
          const before = requests.length;
          const rejected = await runtime.completeSimple(resolved.model, context, { fetch });
          assert.equal(rejected.stopReason, 'error');
          assert.equal(requests.length, before);
          descriptor.privacy = 'tee';
        }
      }
      assert.equal(requests.length, 20);
      process.stdout.write('20 transports and 4 cancellations passed');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result).toBe('20 transports and 4 cancellations passed');
}, 35_000);

test('OpenAI catalog additions retain native Responses transports, bundled models and OAuth', () => {
  const script = `
    (async () => {
      const assert = require('assert/strict');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { AgentProviderStore } = require('./src/main/agent/provider-store');
      const { AgentProviderResolver } = require('./src/main/agent/provider-resolver');
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-openai-models-'));
      const store = new AgentProviderStore({ dataDir, safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString(),
      } });
      const resolver = new AgentProviderResolver({ store, dataDir });
      const catalog = await resolver.getCatalog();
      for (const id of ['openai', 'openai-codex']) {
        const models = catalog.find(p => p.providerId === id).models;
        assert(models.some(m => m.id === 'gpt-6-astra'));
        assert(models.length > 1, 'Bundled models must remain available');
      }
      store.saveHosted({ providerId: 'openai', modelId: 'gpt-6-astra', apiKey: 'test-key' });
      const api = await resolver.resolveModel();
      assert.equal(api.model.api, 'openai-responses');
      assert.equal(api.thinkingLevel, 'medium');
      let sent;
      const fetch = async (url, init) => {
        const body = new Headers(init.headers).get('content-encoding') === 'zstd' ? require('zlib').zstdDecompressSync(init.body).toString() : init.body;
        sent = { url: String(url), body: JSON.parse(body) };
        return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0 } } }) + '\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      };
      const context = { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] };
      const response = await api.modelRuntime.completeSimple(api.model, context, { fetch, reasoning: api.thinkingLevel, maxRetries: 0 });
      assert.notEqual(response.stopReason, 'error', response.errorMessage);
      assert.equal(sent.body.model, 'gpt-6-astra');
      assert.equal(sent.body.reasoning.effort, 'medium');
      assert.equal(sent.url, 'https://api.openai.com/v1/responses');
      const access = 'header.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url') + '.signature';
      await store.createCredentialStore().modify('openai-codex', async () => ({ type: 'oauth', access, refresh: 'test-refresh', expires: Date.now() + 3600000 }));
      store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-6-astra' });
      const subscription = await resolver.resolveModel();
      assert.equal(subscription.model.api, 'openai-codex-responses');
      assert(subscription.modelRuntime.isUsingOAuth('openai-codex'));
      assert.equal((await subscription.modelRuntime.getAuth('openai-codex')).auth.apiKey, access);
      const chat = await subscription.modelRuntime.completeSimple(subscription.model, context, { fetch, transport: 'sse', reasoning: 'medium', maxRetries: 0 });
      assert.notEqual(chat.stopReason, 'error', chat.errorMessage);
      assert.equal(sent.url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(sent.body.reasoning.effort, 'medium');
      let discovery;
      resolver.catalog.fetch = async (url, init) => {
        discovery = { url, headers: init.headers };
        return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', visibility: 'list', context_window: 1050000, supported_reasoning_levels: [{ effort: 'medium' }] }] }));
      };
      const refreshed = await resolver.refreshModels({ providerId: 'openai-codex' });
      assert.equal(discovery.headers.Authorization, 'Bearer ' + access);
      assert.equal(discovery.headers['ChatGPT-Account-ID'], 'test-account');
      assert.deepEqual(refreshed.find(p => p.providerId === 'openai-codex').models.map(m => m.id), ['gpt-6-astra']);
      assert.equal(store.getPublicStatus().modelId, 'gpt-6-astra');
      process.stdout.write('native transports and OAuth preserved');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 30_000,
  })).toBe('native transports and OAuth preserved');
}, 35_000);
