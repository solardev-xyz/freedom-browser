'use strict';

// This worker receives public attestation evidence only, never provider credentials
// or conversation contents. Keep quote parsing and cryptography off Electron's UI thread.
const { parentPort, workerData } = require('node:worker_threads');
const { createHash, timingSafeEqual } = require('node:crypto');

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (!['https://pccs.phala.network', 'https://certificates.trustedservices.intel.com',
    'http://certificates.trustedservices.intel.com'].includes(url.origin) || url.username || url.password) {
    throw new Error('Collateral destination rejected');
  }
  // The library may follow a CRL URL from an untrusted certificate. Never allow
  // arbitrary hosts, redirects, credentials, or unbounded responses here.
  url.protocol = 'https:';
  const response = await nativeFetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Collateral unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error('Collateral too large');
    chunks.push(chunk);
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
};

const { QuoteVerifier, getCollateral, PHALA_PCCS_URL } = require('@phala/dcap-qvl');

async function verifyReport(report, nonce) {
  if (typeof report?.intel_quote !== 'string' || !/^[a-f0-9]{200,40000}$/i.test(report.intel_quote) ||
    report.intel_quote.length % 2 || !/^[a-f0-9]{64}$/i.test(nonce) ||
    report.signing_algo !== 'ecdsa' || !/^0x[a-f0-9]{40}$/i.test(report.signing_address)) {
    throw Object.assign(new Error('Evidence rejected'), { code: 'EVIDENCE_REJECTED' });
  }
  const quote = Buffer.from(report.intel_quote, 'hex');
  const collateral = await getCollateral(PHALA_PCCS_URL, quote);
  let checked;
  try {
    checked = QuoteVerifier.newProd().verify(quote, collateral, Math.floor(Date.now() / 1000));
  } catch {
    throw Object.assign(new Error('Evidence rejected'), { code: 'EVIDENCE_REJECTED' });
  }
  const td = checked.report.asTd10();
  if (!td) throw new Error('Unsupported report type');
  const identity = Buffer.from(report.signing_address.slice(2), 'hex');
  const fingerprint = report.tls_cert_fingerprint;
  if (fingerprint !== undefined && !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw Object.assign(new Error('Fingerprint rejected'), { code: 'EVIDENCE_REJECTED' });
  }
  const boundIdentity = fingerprint === undefined ? Buffer.concat([identity, Buffer.alloc(12)])
    : createHash('sha256').update(identity).update(Buffer.from(fingerprint, 'hex')).digest();
  const expected = Buffer.concat([boundIdentity, Buffer.from(nonce, 'hex')]);
  const reportData = Buffer.from(td.reportData);
  if (reportData.length !== 64 || !timingSafeEqual(expected, reportData) ||
    (report.request_nonce ?? report.nonce) !== nonce ||
    (report.report_data !== undefined && report.report_data !== reportData.toString('hex'))) {
    throw Object.assign(new Error('Evidence binding rejected'), { code: 'EVIDENCE_REJECTED' });
  }
  return {
    status: checked.status === 'UpToDate' ? 'checked' : 'advisory',
    tcb: checked.status,
    advisories: checked.advisory_ids,
    quoteHash: createHash('sha256').update(quote).digest('hex'),
    signingAddress: report.signing_address.toLowerCase(),
    ...(fingerprint && { tlsFingerprint: fingerprint.toLowerCase() }),
  };
}

// Do not forward exception strings: remote responses can put arbitrary data in them.
(async () => {
  const { reports, nonce } = workerData;
  if (!Array.isArray(reports) || !reports.length || reports.length > 16) throw new Error('Evidence count');
  const results = [];
  for (const report of reports) results.push(await verifyReport(report, nonce));
  parentPort.postMessage({ status: results.every(r => r.status === 'checked') ? 'checked' : 'advisory',
    checkedAt: Date.now(), verifier: 'dcap-qvl/0.6.5', reports: results });
})().catch(error => parentPort.postMessage({
  status: error.code === 'EVIDENCE_REJECTED' ? 'failed' : 'unavailable', checkedAt: Date.now(), reports: [],
}));
