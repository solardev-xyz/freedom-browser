'use strict';

const { createHash } = require('node:crypto');

async function runWorker(report, nonce, authenticatedData) {
  const nativeFetch = globalThis.fetch;
  let resolve;
  const result = new Promise(done => { resolve = done; });
  jest.doMock('node:worker_threads', () => ({ workerData: { reports: [report], nonce }, parentPort: { postMessage: resolve } }));
  jest.doMock('@phala/dcap-qvl', () => ({
    PHALA_PCCS_URL: 'https://pccs.phala.network', getCollateral: async () => ({}),
    QuoteVerifier: { newProd: () => ({ verify: () => ({ status: 'UpToDate', advisory_ids: [],
      report: { asTd10: () => ({ reportData: authenticatedData }) } }) }) },
  }));
  try {
    jest.isolateModules(() => require('./privacy-attestation-worker'));
    return await result;
  } finally { globalThis.fetch = nativeFetch; }
}

test('TLS report data authenticates the decoded signer, SPKI fingerprint and fresh nonce together', async () => {
  const nonce = '12'.repeat(32), fingerprint = 'ab'.repeat(32), address = '34'.repeat(20);
  const bound = createHash('sha256').update(Buffer.from(address, 'hex')).update(Buffer.from(fingerprint, 'hex')).digest();
  const authenticated = Buffer.concat([bound, Buffer.from(nonce, 'hex')]);
  const report = { intel_quote: '00'.repeat(200), signing_algo: 'ecdsa', signing_address: '0x' + address,
    request_nonce: nonce, tls_cert_fingerprint: fingerprint };
  const valid = await runWorker(report, nonce, authenticated);
  expect(valid.status).toBe('checked');
  expect(valid.reports[0]).toMatchObject({ signingAddress: '0x' + address, tlsFingerprint: fingerprint });
  for (const changed of [
    { tls_cert_fingerprint: 'cd'.repeat(32) }, { signing_address: '0x' + '56'.repeat(20) },
    { request_nonce: '99'.repeat(32) }, { tls_cert_fingerprint: undefined },
  ]) expect((await runWorker({ ...report, ...changed }, nonce, authenticated)).status).toBe('failed');
  expect((await runWorker(report, '99'.repeat(32), authenticated)).status).toBe('failed');
});
