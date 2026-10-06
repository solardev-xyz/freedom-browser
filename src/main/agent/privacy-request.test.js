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
