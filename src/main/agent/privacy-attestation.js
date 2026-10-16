'use strict';

const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const { bindEncryptionKey } = require('./privacy-encryption');

const ENDPOINTS = Object.freeze({
  venice: 'https://api.venice.ai/api/v1/tee/attestation',
  'near-ai': 'https://cloud-api.near.ai/v1/attestation/report',
});

function verifyInWorker(reports, nonce, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ status: 'unavailable' });
    const worker = new Worker(path.join(__dirname, 'privacy-attestation-worker.js'), {
      workerData: { reports, nonce }, resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => finish({ status: 'unavailable' });
    const timer = setTimeout(cancel, 30_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.once('message', finish);
    worker.once('error', cancel);
    worker.once('exit', cancel);
  });
}

async function checkProviderAttestation({ providerId, modelId, apiKey, signal,
  fetchImpl = globalThis.fetch, verify = verifyInWorker, includeTls = false, includeKeys = false }) {
  if (!ENDPOINTS[providerId]) return { status: 'unsupported' };
  const nonce = randomBytes(32).toString('hex');
  const url = new URL(ENDPOINTS[providerId]);
  url.searchParams.set('model', modelId);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('signing_algo', 'ecdsa');
  if (providerId === 'near-ai') url.searchParams.set('provider', 'near');
  if (providerId === 'near-ai' && includeTls) url.searchParams.set('include_tls_fingerprint', 'true');
  try {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetchImpl(url, { redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'x-no-aliasing': 'true' } });
    if (!response.ok) return { status: 'unavailable' };
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error('Attestation too large');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reports = providerId === 'venice' ? [data] :
      [data.gateway_attestation, ...(Array.isArray(data.model_attestations) ? data.model_attestations : [])];
    if (providerId === 'near-ai' && reports.length < 2) return { status: 'unavailable' };
    if (reports.length > 16) return { status: 'unavailable' };
    // Only CPU evidence needed by this verifier crosses the worker boundary.
    const evidence = reports.map(report => ({
      intel_quote: report?.intel_quote, signing_algo: report?.signing_algo,
      signing_address: report?.signing_address, request_nonce: report?.request_nonce,
      nonce: report?.nonce, report_data: report?.report_data,
      ...(providerId === 'near-ai' && report?.tls_cert_fingerprint !== undefined &&
        { tls_cert_fingerprint: report.tls_cert_fingerprint }),
    }));
    const checked = await verify(evidence, nonce, signal);
    if (includeKeys && ['checked', 'advisory'].includes(checked.status)) {
      if (checked.reports?.length !== reports.length) return { status: 'failed' };
      try { checked.reports = checked.reports.map((verified, index) => {
        // Gateway encryption keys are unnecessary; bind every returned model key.
        if (providerId === 'near-ai' && index === 0) return verified;
        const raw = reports[index];
        return { ...verified, encryptionKey: bindEncryptionKey(raw.signing_public_key || raw.signing_key, verified.signingAddress) };
      }); } catch { return { status: 'failed', checkedAt: Date.now(), reports: [] }; }
    }
    return checked;
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = { checkProviderAttestation, verifyInWorker };
