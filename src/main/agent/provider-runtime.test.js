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
      const { SessionPrivacy, withSessionPrivacy } = require('./src/main/agent/session-privacy');
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-provider-runtime-'));
      const store = new AgentProviderStore({ dataDir, safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(text), decryptString: (buffer) => buffer.toString(),
      } });
      const { structuredClassifierRuntime, classifierSchema } = require('./src/main/agent/classifier-response');
      const schema = classifierSchema('kind', ['ordinary', 'consequential', 'uncertain'], ['uncertainties']);
      const descriptor = { id: 'test', name: 'Test', tools: true, available: true, jsonSchema: true,
        privacy: 'tee', attestation: false, contextWindow: 32000, maxTokens: 4096 };
      const catalog = { get: (id) => ['venice', 'near-ai', 'openrouter'].includes(id)
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
      for (const providerId of ['venice', 'near-ai', 'openrouter']) {
        store.saveHosted({ providerId, modelId: 'test', apiKey: 'test-key' });
        store.savePreferences(providerId, { privacyPolicy: providerId === 'openrouter' ? 'zdr' : providerId === 'meta' ? 'standard' : 'tee' });
        const resolved = await resolver.resolveModel();
        const ledger = new SessionPrivacy();
        const runtime = withSessionPrivacy(resolved.modelRuntime, ledger, 'agent');
        assert(runtime.getModels('xai').length > 0);
        let lastMessage;
        for (const method of ['stream', 'streamSimple', 'complete', 'completeSimple']) {
          const selectedRuntime = method === 'streamSimple' ? structuredClassifierRuntime(runtime, resolved.model, schema) : runtime;
          const result = selectedRuntime[method](resolved.model, context, { fetch, maxRetries: 0,
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
          if (method === 'streamSimple') assert.deepEqual(sent.body.response_format.json_schema.schema, schema);
          else assert.equal(sent.body.response_format, undefined);
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
        assert.equal(ledger.snapshot().routes.length, 1);
        assert.equal(ledger.snapshot().routes[0].requests, 4);
        assert.equal(ledger.snapshot().routes[0].providerId, providerId);
        assert.equal(ledger.snapshot().routes[0].hardware, null);
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
      assert.equal(requests.length, 15);
      process.stdout.write('15 transports and 3 cancellations passed');
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const result = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result).toBe('15 transports and 3 cancellations passed');
}, 35_000);

test('native ChatGPT login, refresh and Meta Responses stay separate from API keys and legacy Codex', () => {
  const script = `
    (async () => {
      const assert = require('assert/strict');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { AgentProviderStore } = require('./src/main/agent/provider-store');
      const { AgentProviderResolver } = require('./src/main/agent/provider-resolver');
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-native-auth-'));
      const safeStorage = { isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() };
      const store = new AgentProviderStore({ dataDir, safeStorage });
      const resolver = new AgentProviderResolver({ store, dataDir });
      store.saveHosted({ providerId: 'openai', modelId: 'gpt-6.1-sol', apiKey: 'sk-api-test' });
      const credentials = store.createCredentialStore();
      await credentials.modify('openai-codex', async () => ({ type: 'oauth', access: 'legacy-test', refresh: 'legacy-refresh', expires: Date.now() + 3600000 }));
      store.saveSubscription({ providerId: 'openai-codex', modelId: 'gpt-6-astra' });
      const requests = [];
      globalThis.fetch = async (url, init) => {
        const body = new URLSearchParams(init.body);
        requests.push({ url: String(url), body });
        assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
        return Response.json({ access_token: body.get('grant_type') === 'refresh_token' ? 'refreshed-test' : 'chatgpt-test',
          refresh_token: 'refresh-test', id_token: 'identity-test', expires_in: 3600,
          scope: 'openid chatgpt.tokens.use.direct' });
      };
      let authorization;
      let callbackPage;
      await resolver.loginSubscription({ providerId: 'openai-chatgpt', modelId: 'gpt-6.1-sol' }, {
        signal: new AbortController().signal,
        notify: event => { if (event.type === 'auth_url') authorization = new URL(event.url); },
        prompt: async prompt => {
          assert.equal(prompt.type, 'manual_code');
          assert.equal(authorization.origin, 'https://auth.openai.com');
          assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
          assert.equal(authorization.searchParams.get('agent_name_hint'), 'Freedom Browser');
          callbackPage = new Promise((resolve, reject) => {
            require('http').get('http://127.0.0.1:1455/auth/callback?code=test-code&client_id=issued-client&state=' + authorization.searchParams.get('state'), response => {
              let body = '';
              response.on('data', chunk => body += chunk);
              response.on('end', () => resolve({ status: response.statusCode, body }));
            }).on('error', reject);
          });
          return new Promise((_resolve, reject) => prompt.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
        },
      });
      const page = await callbackPage;
      assert.equal(page.status, 200);
      assert(page.body.includes('ChatGPT connected'));
      assert(page.body.includes('alt="Freedom Browser"'));
      assert.equal(requests[0].body.get('client_id'), 'issued-client');
      assert(requests[0].body.get('code_verifier'));
      const deviceId = store.getDeviceId();
      assert.equal(authorization.searchParams.get('ext_agent_host_id'), 'urn:uuid:' + deviceId);
      const reopened = new AgentProviderStore({ dataDir, safeStorage });
      assert.equal(reopened.getDeviceId(), deviceId);
      assert.equal((await credentials.read('openai-chatgpt')).clientId, 'issued-client');
      assert.equal(store.getSelection('openai').apiKey, 'sk-api-test');
      assert.equal((await credentials.read('openai-codex')).access, 'legacy-test');
      await credentials.modify('openai-chatgpt', async previous => ({ ...previous, expires: 1 }));
      const chat = await resolver.resolveModel({ providerId: 'openai-chatgpt' });
      assert.equal(chat.model.provider, 'openai');
      assert.equal(chat.connectionProviderId, 'openai-chatgpt');
      assert.equal(chat.model.api, 'openai-responses');
      assert.equal((await chat.modelRuntime.getAuth('openai')).auth.apiKey, 'refreshed-test');
      assert.equal(requests.at(-1).body.get('grant_type'), 'refresh_token');
      assert.equal(requests.at(-1).body.get('client_id'), 'issued-client');
      const sent = [];
      const fetch = async (url, init) => {
        sent.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body) });
        const events = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'inspect', arguments: '' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'inspect', arguments: '{}' } },
          { type: 'response.completed', response: { id: 'test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        ];
        return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      };
      const context = { messages: [{ role: 'user', content: 'Inspect', timestamp: Date.now() }], tools: [
        { name: 'inspect', description: 'Inspect', parameters: { type: 'object', properties: {} } },
      ] };
      const api = await resolver.resolveModel({ providerId: 'openai' });
      store.saveHosted({ providerId: 'meta', modelId: 'muse-spark-1.3', apiKey: 'meta-test' });
      const meta = await resolver.resolveModel({ providerId: 'meta' });
      assert.equal(meta.model.api, 'openai-responses');
      assert((await resolver.getCatalog()).find(p => p.providerId === 'meta').models.length > 1);
      let mints = 0;
      globalThis.fetch = async (url, init) => {
        if (url === 'https://auth.meta.com/oidc/device/authorization/') {
          return Response.json({ device_code: 'device-fixture', user_code: 'ABCD-1234', verification_uri: 'https://auth.meta.com/device', interval: 0.001, expires_in: 300 });
        }
        if (url === 'https://auth.meta.com/oidc/device/token/') {
          assert.equal(new URLSearchParams(init.body).get('device_code'), 'device-fixture');
          return Response.json({ access_token: 'meta-identity-fixture' });
        }
        assert.equal(url, 'https://api.meta.ai/muse-code/key');
        assert.equal(init.headers.Authorization, 'Bearer meta-identity-fixture');
        return Response.json({ api_key: 'meta-subscription-fixture-' + ++mints });
      };
      const notifications = [];
      await resolver.loginSubscription({ providerId: 'meta-subscription', modelId: 'muse-spark-1.3' }, {
        signal: new AbortController().signal, notify: event => notifications.push(event),
        prompt: async () => { throw new Error('Meta should use device authorization'); },
      });
      assert.equal(notifications[0].type, 'device_code');
      assert.equal(notifications[0].userCode, 'ABCD-1234');
      assert.equal(store.getSelection('meta').apiKey, 'meta-test');
      assert.equal((await credentials.read('meta-subscription')).refresh, 'meta-identity-fixture');
      await credentials.modify('meta-subscription', async previous => ({ ...previous, expires: 1 }));
      const metaSubscription = await resolver.resolveModel({ providerId: 'meta-subscription' });
      assert.equal(metaSubscription.connectionProviderId, 'meta-subscription');
      assert.equal(metaSubscription.model.provider, 'meta');
      assert.equal((await metaSubscription.modelRuntime.getAuth('meta')).auth.apiKey, 'meta-subscription-fixture-2');
      for (const resolved of [chat, api, meta, metaSubscription]) {
        const result = await resolved.modelRuntime.completeSimple(resolved.model, context, { fetch, maxRetries: 0 });
        assert.equal(result.stopReason, 'toolUse', result.errorMessage);
        assert.equal(result.content[0].name, 'inspect');
        assert.equal(sent.at(-1).body.tools[0].name, 'inspect');
      }
      assert.deepEqual(sent.map(request => [request.url, request.auth]), [
        ['https://api.openai.com/v1/responses', 'Bearer refreshed-test'],
        ['https://api.openai.com/v1/responses', 'Bearer sk-api-test'],
        ['https://api.meta.ai/v1/responses', 'Bearer meta-test'],
        ['https://api.meta.ai/v1/responses', 'Bearer meta-subscription-fixture-2'],
      ]);
      assert(!JSON.stringify(store.getPublicStatus()).includes('refreshed-test'));
      store.remove('openai-chatgpt');
      assert.equal(await credentials.read('openai-chatgpt'), undefined);
      assert.equal(store.getSelection('openai').apiKey, 'sk-api-test');
      assert.equal((await credentials.read('openai-codex')).access, 'legacy-test');
      store.remove('meta-subscription');
      assert.equal(await credentials.read('meta-subscription'), undefined);
      assert.equal(store.getSelection('meta').apiKey, 'meta-test');
      process.stdout.write('native auth and Responses verified');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  expect(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 30_000,
  })).toBe('native auth and Responses verified');
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
