'use strict';

const { createHash } = require('node:crypto');
const { Wallet } = require('ethers');
const { verifyReceipt, observeResponse, fetchNearWithEvidence } = require('./privacy-request');
const hash = value => createHash('sha256').update(value).digest('hex');
const wallet = new Wallet('0x' + '12'.repeat(32)); // Public test fixture, never a funded key.
const evidence = { status: 'advisory', reports: [{ signingAddress: wallet.address.toLowerCase(), tlsFingerprint: 'a'.repeat(64) }, { signingAddress: wallet.address.toLowerCase() }] };

async function signature(kind = 'gateway', model = 'qwen', req = 'request', res = 'response') {
  const text = `${kind === 'provider_tee' ? `${model}:` : ''}${hash(req)}:${hash(res)}`;
  return { signature_kind: kind, signing_algo: 'ecdsa', signing_address: wallet.address,
    text, signature: await wallet.signMessage(text) };
}

test('binds exact bytes and scope to an independently checked preflight signer', async () => {
  const sig = await signature();
  expect(verifyReceipt(sig, evidence, 'qwen', hash('request'), hash('response'))).toBe('gateway');
  expect(verifyReceipt(sig, evidence, 'qwen', hash('request '), hash('response'))).toBe('failed');
  expect(verifyReceipt(sig, evidence, 'qwen', hash('request'), hash('response\n'))).toBe('failed');
  expect(verifyReceipt({ ...sig, signature: 'ab'.repeat(65) }, evidence, 'qwen', hash('request'), hash('response'))).toBe('failed');
  expect(verifyReceipt(sig, { status: 'failed', reports: [] }, 'qwen', hash('request'), hash('response'))).toBe('unavailable');
  expect(verifyReceipt({ ...sig, signature_kind: undefined }, evidence, 'qwen', hash('request'), hash('response'))).toBe('unavailable');
  expect(verifyReceipt(sig, { ...evidence, reports: [{ signingAddress: '0x' + 'ab'.repeat(20) }] }, 'qwen', hash('request'), hash('response'))).toBe('failed');
  const modelSig = await signature('provider_tee');
  expect(verifyReceipt(modelSig, evidence, 'qwen', hash('request'), hash('response'))).toBe('model');
  expect(verifyReceipt(modelSig, evidence, 'alias', hash('request'), hash('response'))).toBe('failed');
  expect(verifyReceipt(modelSig, { ...evidence, reports: [...evidence.reports, evidence.reports[1]] }, 'qwen', hash('request'), hash('response'))).toBe('failed');
});

test('hashes raw stream framing across arbitrary byte boundaries without changing delivered bytes', async () => {
  const bytes = Buffer.from('data: {"id":"chatcmpl-test","text":"ü"}\r\n\r\ndata: [DONE]\n\n');
  let index = 0;
  const response = new Response(new ReadableStream({ pull(c) {
    if (index === bytes.length) c.close(); else c.enqueue(bytes.subarray(index, ++index));
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const finish = jest.fn(), release = jest.fn();
  const wrapped = observeResponse(response, { finish, release });
  expect(Buffer.from(await wrapped.arrayBuffer())).toEqual(bytes);
  expect(finish).toHaveBeenCalledWith('chatcmpl-test', hash(bytes));
  expect(release).toHaveBeenCalledTimes(1);
});

test('cancelled and ambiguous streams never yield verified completion IDs', async () => {
  const finish = jest.fn();
  const wrapped = observeResponse(new Response('data: {"id":"chatcmpl-a"}\n\ndata: {"id":"chatcmpl-b"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }), { finish, release() {} });
  await wrapped.text();
  expect(finish.mock.calls[0][0]).toBeNull();
  const cancelled = observeResponse(new Response('private text'), { finish, release() {} });
  await cancelled.body.cancel();
  expect(finish).toHaveBeenLastCalledWith(null, null);
});

test('preflight happens before sending content; hashes the actual POST and reports gateway-only coverage', async () => {
  const body = JSON.stringify({ model: 'qwen', messages: [] });
  const output = JSON.stringify({ id: 'chatcmpl-test', choices: [] });
  let attested = false;
  const close = jest.fn();
  const report = jest.fn();
  const transport = { close, peer: () => ({ fingerprint: 'a'.repeat(64) }), fetch: jest.fn(async (_url, opts, same) => {
    expect(attested).toBe(true); expect(same).toBe(true);
    expect(opts.body).toBe(body); expect(opts.headers.get('x-no-aliasing')).toBe('true');
    return new Response(output);
  }) };
  const receipt = await signature('gateway', 'qwen', body, output);
  const response = await fetchNearWithEvidence({ input: 'https://cloud-api.near.ai/v1/chat/completions',
    options: { method: 'POST', body }, modelId: 'qwen', apiKey: 'secret', report,
    transportFactory: () => transport,
    attest: async args => { expect(args.includeTls).toBe(true); attested = true; return evidence; },
    fetchImpl: async url => { expect(url.origin).toBe('https://cloud-api.near.ai'); return new Response(JSON.stringify(receipt)); },
  });
  expect(await response.text()).toBe(output);
  expect(report).toHaveBeenLastCalledWith({ connection: 'checked', response: 'gateway' });
  expect(close).toHaveBeenCalledTimes(1);
});

test('reconnection loses TLS coverage, and ordinary post-send failures never trigger a duplicate POST', async () => {
  const fallback = jest.fn(async () => new Response('{"id":"chatcmpl-test"}'));
  for (const code of ['PRIVACY_RECONNECTED', 'ECONNRESET']) {
    const report = jest.fn();
    const task = fetchNearWithEvidence({ input: 'https://cloud-api.near.ai/v1/chat/completions',
      options: { method: 'POST', body: '{"model":"qwen"}' }, modelId: 'qwen', apiKey: 'secret', report,
      attest: async () => evidence, fetchImpl: fallback,
      transportFactory: () => ({ close() {}, peer: () => ({ fingerprint: 'a'.repeat(64) }),
        fetch: async () => { throw Object.assign(new Error('closed'), { code }); } }),
    });
    if (code === 'PRIVACY_RECONNECTED') {
      const response = await task; await response.text();
      expect(report.mock.calls.at(-1)[0].connection).toBe('unavailable');
    } else await expect(task).rejects.toThrow('closed');
  }
  // One fallback POST and one receipt lookup. No fallback after ECONNRESET.
  expect(fallback).toHaveBeenCalledTimes(2);
});

test('NEAR encrypts at the transport boundary and refuses invalid model evidence before POST', async () => {
  const modelKey = wallet.signingKey.publicKey.slice(2);
  const hardware = { status: 'advisory', reports: [
    { ...evidence.reports[0], tcb: 'OutOfDate' },
    { ...evidence.reports[1], tcb: 'OutOfDate', encryptionKey: modelKey },
  ] };
  const { encryptText } = require('./privacy-encryption');
  const output = 'OK';
  let requestBody, responseBody;
  const transport = { close: jest.fn(), peer: () => ({ fingerprint: 'a'.repeat(64) }), fetch: jest.fn(async (_url, opts) => {
    requestBody = opts.body;
    expect(requestBody).not.toContain('SECRET');
    expect(opts.headers.get('X-Encrypt-All-Fields')).toBe('true');
    expect(opts.headers.get('X-Model-Pub-Key')).toBe(modelKey.slice(2));
    responseBody = JSON.stringify({ id: 'test', choices: [{ message: { content: encryptText(output, opts.headers.get('X-Client-Pub-Key')) } }] });
    return new Response(responseBody);
  }) };
  const fetchImpl = jest.fn(async () => new Response(JSON.stringify(await signature('gateway', 'qwen', requestBody, responseBody))));
  const report = jest.fn(), reportEncryption = jest.fn();
  const params = { input: 'https://cloud-api.near.ai/v1/chat/completions', options: { method: 'POST', body: JSON.stringify({ model: 'qwen', messages: [{ role: 'user', content: 'SECRET' }] }) },
    modelId: 'qwen', apiKey: 'secret', report, reportEncryption, encrypt: true,
    transportFactory: () => transport, attest: async () => hardware, fetchImpl };
  const response = await fetchNearWithEvidence(params);
  expect((await response.json()).choices[0].message.content).toBe(output);
  expect(report).toHaveBeenLastCalledWith({ connection: 'checked', response: 'gateway' });
  expect(reportEncryption).toHaveBeenCalledWith('encrypted');
  transport.fetch.mockClear(); fetchImpl.mockClear();
  expect((await fetchNearWithEvidence({ ...params, attest: async () => ({ status: 'failed', reports: [] }) })).status).toBe(400);
  expect(transport.fetch).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
  expect(reportEncryption).toHaveBeenLastCalledWith('blocked');
});

test('Venice falls back only for unsupported features, never when encryption verification fails', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const fetchImpl = jest.fn(async () => new Response('{}'));
  const attest = jest.fn(async () => ({ status: 'failed', reports: [] }));
  const reportEncryption = jest.fn();
  const params = { input: 'https://api.venice.ai/api/v1/chat/completions', modelId: 'qwen', apiKey: 'secret',
    options: { method: 'POST', body: JSON.stringify({ model: 'qwen', stream: true, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }], tool_choice: 'required' }) },
    fetchImpl, attest, report: jest.fn(), reportEncryption };
  await fetchVeniceEncrypted(params);
  expect(reportEncryption).toHaveBeenCalledWith('unencrypted', 'tools');
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(attest).not.toHaveBeenCalled();
  fetchImpl.mockClear();
  const body = JSON.parse(params.options.body); delete body.tools; delete body.tool_choice;
  expect((await fetchVeniceEncrypted({ ...params, options: { ...params.options, body: JSON.stringify(body) } })).status).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
});

function veniceHarness(reply) {
  const { createECDH, hkdfSync, createDecipheriv } = require('node:crypto');
  const { encryptText } = require('./privacy-encryption');
  const modelKey = createECDH('secp256k1');
  modelKey.setPrivateKey(Buffer.from('12'.repeat(32), 'hex'));
  const decrypt = text => {
    const bytes = Buffer.from(text, 'hex');
    const key = Buffer.from(hkdfSync('sha256', modelKey.computeSecret(bytes.subarray(0, 65)), Buffer.alloc(0), 'ecdsa_encryption', 32));
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(65, 77));
    cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(77, -16)), cipher.final()]).toString();
  };
  const seen = [];
  const next = { report: jest.fn(), reportEncryption: jest.fn() };
  const params = { input: 'https://api.venice.ai/api/v1/chat/completions', modelId: 'qwen', apiKey: 'secret',
    options: { method: 'POST', body: JSON.stringify({ model: 'qwen', stream: true,
      messages: [{ role: 'system', content: 'SECRET system' }, { role: 'user', content: 'SECRET hello' },
        { role: 'assistant', content: 'SECRET earlier reply' }, { role: 'user', content: 'SECRET followup' }],
      tools: [{ type: 'function', function: { name: 'read_page', description: 'SECRET tool', parameters: { type: 'object' } } }],
    }) },
    report: jest.fn(), reportEncryption: jest.fn(), nextAttempt: jest.fn(() => next),
    attest: jest.fn(async () => ({ status: 'advisory', reports: [{ tcb: 'OutOfDate', encryptionKey: modelKey.getPublicKey('hex') }] })),
    fetchImpl: jest.fn(async (_url, options) => {
      if (!options.headers?.get('X-Venice-TEE-Client-Pub-Key')) return new Response('native tool response');
      expect(options.body).not.toContain('SECRET');
      const body = JSON.parse(options.body);
      expect(body.tools).toBeUndefined();
      expect(body.messages.map(m => decrypt(m.content))).toEqual(expect.arrayContaining(['SECRET earlier reply', 'SECRET followup']));
      const marker = decrypt(body.messages[0].content).match(/FREEDOM_TOOLS_[a-f0-9]+/)[0];
      seen.push(body);
      const parts = reply(marker);
      const records = parts.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content: encryptText(content, options.headers.get('X-Venice-TEE-Client-Pub-Key')) } }] })}\n\n`);
      return new Response(records.join('') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }),
  };
  return { params, next, seen };
}

test('Venice answers ordinary messages with tools available using encrypted text and encrypted history', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const { params } = veniceHarness(() => ['Hello', ' again']);
  const response = await fetchVeniceEncrypted(params);
  expect(await response.text()).toContain('Hello');
  expect(params.fetchImpl).toHaveBeenCalledTimes(1);
  expect(params.nextAttempt).not.toHaveBeenCalled();
  expect(params.reportEncryption).toHaveBeenCalledWith('encrypted');
  expect(params.reportEncryption).not.toHaveBeenCalledWith('unencrypted', expect.anything());
});

test('Venice accepts a complete encrypted tool handoff, records a second request and preserves native tools', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const { params, next } = veniceHarness(marker => ['\n', marker.slice(0, 10), marker.slice(10), '\n']);
  const response = await fetchVeniceEncrypted(params);
  expect(await response.text()).toBe('native tool response');
  expect(params.fetchImpl).toHaveBeenCalledTimes(2);
  expect(params.fetchImpl.mock.calls[1][1].body).toBe(params.options.body);
  expect(params.nextAttempt).toHaveBeenCalledTimes(1);
  expect(next.reportEncryption).toHaveBeenCalledWith('unencrypted', 'tools');
});

test('Venice never hands off to plaintext after corrupt or incomplete encrypted output', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  for (const corrupt of [false, true]) {
    const { params } = veniceHarness(marker => [marker.slice(0, 10)]);
    if (corrupt) params.fetchImpl.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"not encrypted"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    await expect(fetchVeniceEncrypted(params)).rejects.toThrow();
    expect(params.fetchImpl).toHaveBeenCalledTimes(1);
    expect(params.nextAttempt).not.toHaveBeenCalled();
    expect(params.reportEncryption).not.toHaveBeenCalledWith('unencrypted', expect.anything());
  }
});

test('cancelling after the encrypted tool decision prevents the unencrypted request', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const controller = new AbortController();
  const { params } = veniceHarness(marker => [marker]);
  params.signal = controller.signal;
  const network = params.fetchImpl.getMockImplementation();
  params.fetchImpl.mockImplementation(async (...args) => {
    const response = await network(...args);
    const reader = response.body.getReader();
    return new Response(new ReadableStream({ async pull(c) {
      const chunk = await reader.read();
      if (chunk.done) { controller.abort(); c.close(); } else c.enqueue(chunk.value);
    } }), { headers: response.headers });
  });
  await expect(fetchVeniceEncrypted(params)).rejects.toThrow();
  expect(params.fetchImpl).toHaveBeenCalledTimes(1);
  expect(params.nextAttempt).not.toHaveBeenCalled();
});

test('ordinary encrypted answers stream before the upstream response finishes', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const { params } = veniceHarness(() => ['Hello']);
  const network = params.fetchImpl.getMockImplementation();
  const cancelled = jest.fn();
  params.fetchImpl.mockImplementation(async (...args) => {
    const response = await network(...args);
    const text = (await response.text()).split('data: {"choices":[{"delta":{},"finish_reason"')[0];
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
      cancel: cancelled,
    }), { headers: response.headers });
  });
  const response = await fetchVeniceEncrypted(params);
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('Hello');
  await reader.cancel();
  expect(cancelled).toHaveBeenCalled();
  expect(params.nextAttempt).not.toHaveBeenCalled();
});

test('text-part messages take the encrypted path with optional tools; real attachments report their own reason', async () => {
  const { fetchVeniceEncrypted } = require('./privacy-request');
  const { params } = veniceHarness(() => ['Hello']);
  const body = JSON.parse(params.options.body);
  body.messages = body.messages.map(m => ({ ...m, content: [{ type: 'text', text: m.content }] }));
  params.options.body = JSON.stringify(body);
  expect(await (await fetchVeniceEncrypted(params)).text()).toContain('Hello');
  expect(params.reportEncryption).toHaveBeenCalledWith('encrypted');
  expect(params.reportEncryption).not.toHaveBeenCalledWith('unencrypted', expect.anything());
  body.messages.at(-1).content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } });
  params.options.body = JSON.stringify(body);
  await fetchVeniceEncrypted(params);
  expect(params.reportEncryption).toHaveBeenCalledWith('unencrypted', 'attachments');
  expect(params.fetchImpl.mock.calls.at(-1)[1].body).toBe(params.options.body);
});
