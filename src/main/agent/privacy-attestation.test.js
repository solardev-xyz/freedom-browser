'use strict';

const { checkProviderAttestation, verifyInWorker } = require('./privacy-attestation');

test('uses only the fixed provider host, fresh nonces, and passes public evidence to the verifier', async () => {
  const nonces = [];
  const fetchImpl = jest.fn(async (url, options) => {
    expect(url.origin).toBe('https://cloud-api.near.ai');
    expect(options.redirect).toBe('error');
    expect(options.headers.Authorization).toBe('Bearer secret');
    nonces.push(url.searchParams.get('nonce'));
    return new Response(JSON.stringify({ gateway_attestation: { nonce: nonces.at(-1) }, model_attestations: [{}], apiKey: 'ignored' }));
  });
  const verify = jest.fn(async () => ({ status: 'checked' }));
  for (let i = 0; i < 2; i++) await checkProviderAttestation({ providerId: 'near-ai', modelId: '../?host=evil.test', apiKey: 'secret', fetchImpl, verify });
  expect(nonces[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(nonces[0]).not.toBe(nonces[1]);
  expect(verify.mock.calls[0][0]).toHaveLength(2);
  expect(JSON.stringify(verify.mock.calls)).not.toContain('secret');
});

test('does not trust server verified flags or accept missing candidate evidence', async () => {
  const verify = jest.fn();
  const result = await checkProviderAttestation({ providerId: 'near-ai', modelId: 'qwen', apiKey: 'key', verify,
    fetchImpl: async () => new Response(JSON.stringify({ verified: true, gateway_attestation: {} })) });
  expect(result.status).toBe('unavailable');
  expect(verify).not.toHaveBeenCalled();
});

test('bounds response bodies and hides provider error strings', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    async () => { throw new Error('private provider credential'); }]) {
    const result = await checkProviderAttestation({ providerId: 'venice', modelId: 'qwen', apiKey: 'key', fetchImpl });
    expect(result).toEqual({ status: 'unavailable' });
  }
});

test('worker rejects malformed quotes rather than accepting provider assertions', async () => {
  const result = await verifyInWorker([{ verified: true, intel_quote: 'bad' }], 'a'.repeat(64));
  expect(result.status).toBe('failed');
  expect(result.reports).toEqual([]);
});

test('cancellation stops verification without returning success', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await verifyInWorker([], 'a'.repeat(64), controller.signal)).toEqual({ status: 'unavailable' });
});
