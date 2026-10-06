'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');
const { createHash, X509Certificate } = require('node:crypto');
const { verifyMessage } = require('ethers');
const { checkProviderAttestation } = require('./privacy-attestation');

const ORIGIN = 'https://cloud-api.near.ai';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHardware = evidence => ['checked', 'advisory'].includes(evidence?.status);

// A private, single-socket transport per inference attempt. Refuse reconnection
// before sending the inference body; a cached certificate is not socket evidence.
function createNearTransport() {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  let peer;
  const fetch = (input, options = {}, requireSameSocket = false) => new Promise((resolve, reject) => {
    const url = new URL(input);
    if (url.origin !== ORIGIN || url.username || url.password) return reject(new Error('Unexpected privacy endpoint'));
    const headers = Object.fromEntries(new Headers(options.headers));
    headers['accept-encoding'] = 'identity';
    const req = https.request(url, { method: options.method || 'GET', headers, agent, signal: options.signal }, response => {
      const result = new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers });
      resolve(result);
    });
    req.once('error', reject);
    req.once('socket', socket => {
      const send = () => {
        if (requireSameSocket && socket !== peer?.socket) {
          req.destroy(Object.assign(new Error('Connection changed before inference'), { code: 'PRIVACY_RECONNECTED' }));
          return;
        }
        try {
          if (!socket.authorized) throw new Error('Unauthenticated TLS connection');
          if (!peer) {
            const cert = new X509Certificate(socket.getPeerCertificate().raw);
            peer = { socket, fingerprint: sha256(cert.publicKey.export({ type: 'spki', format: 'der' })) };
          }
          req.end(options.body);
        } catch { req.destroy(new Error('TLS identity unavailable')); }
      };
      if (socket.connecting) socket.once('secureConnect', send);
      else send();
    });
  });
  return { fetch, peer: () => peer, close: () => agent.destroy() };
}

function verifyReceipt(signature, evidence, modelId, requestHash, responseHash) {
  if (!validHardware(evidence)) return 'unavailable';
  if (!['gateway', 'provider_tee'].includes(signature?.signature_kind) || signature.error_code) return 'unavailable';
  if (signature.signing_algo !== 'ecdsa' || !/^0x[a-f0-9]{40}$/i.test(signature.signing_address) ||
    !/^(0x)?[a-f0-9]{130}$/i.test(signature.signature)) return 'failed';
  const scope = signature.signature_kind === 'gateway' ? 'gateway' : 'model';
  const reports = scope === 'gateway' ? evidence.reports.slice(0, 1) : evidence.reports.slice(1);
  const matches = reports.filter(r => r.signingAddress === signature.signing_address.toLowerCase());
  const expected = `${scope === 'model' ? `${modelId}:` : ''}${requestHash}:${responseHash}`;
  if (matches.length !== 1 || signature.text !== expected) return 'failed';
  try {
    const hex = signature.signature.replace(/^0x/, '');
    return verifyMessage(signature.text, `0x${hex}`).toLowerCase() === matches[0].signingAddress ? scope : 'failed';
  } catch { return 'failed'; }
}

async function fetchReceipt(id, apiKey, signal, fetchImpl) {
  const url = new URL(`/v1/signature/${encodeURIComponent(id)}`, ORIGIN);
  url.searchParams.set('signing_algo', 'ecdsa');
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchImpl(url, { redirect: 'error', signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (response.status === 404 && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 300));
      continue;
    }
    if (!response.ok) return null;
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 32 * 1024) throw new Error('Receipt too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return null;
}

// Incremental hashing avoids retaining or teeing a potentially large answer.
// Only a bounded SSE line/JSON body is held to discover its completion ID.
function observeResponse(response, { finish, release }) {
  const reader = response.body?.getReader();
  if (!reader) { release(); void finish(null, null); return response; }
  const hash = createHash('sha256');
  const decoder = new TextDecoder();
  const streaming = response.headers.get('content-type')?.includes('text/event-stream');
  let pending = '', id = null, invalid = false, ended = false;
  const parse = text => {
    try {
      const candidate = JSON.parse(text)?.id;
      if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,240}$/.test(candidate)) {
        if (id && candidate !== id) invalid = true;
        id = candidate;
      }
    } catch { /* SSE comments and [DONE] have no completion ID. */ }
  };
  const settle = async completed => {
    if (ended) return;
    ended = true;
    release();
    await finish(completed && !invalid ? id : null, completed ? hash.digest('hex') : null);
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          pending += decoder.decode();
          if (!streaming) parse(pending);
          else if (pending.startsWith('data:')) parse(pending.slice(5).trim());
          await settle(true);
          controller.close();
          return;
        }
        hash.update(value);
        pending += decoder.decode(value, { stream: true });
        if (streaming) {
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.startsWith('data:')) parse(line.slice(5).trim());
          }
        }
        if (pending.length > 1024 * 1024) { pending = ''; invalid = true; }
        controller.enqueue(value);
      } catch (error) { await settle(false); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); await settle(false); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function fetchNearWithEvidence({ input, options = {}, modelId, apiKey, signal, report,
  fetchImpl = globalThis.fetch, transportFactory = createNearTransport, attest = checkProviderAttestation }) {
  const url = new URL(input?.url || input);
  const unsupported = () => {
    report({ connection: 'unavailable', response: 'unavailable' });
    return fetchImpl(input, options);
  };
  // Unsupported SDK shapes keep their original transport and have no upgraded coverage.
  if (url.href !== `${ORIGIN}/v1/chat/completions` || typeof options.body !== 'string' || options.method !== 'POST') {
    return unsupported();
  }
  let request;
  try { request = JSON.parse(options.body); } catch { return unsupported(); }
  if (request.model !== modelId) return unsupported();
  const combined = [options.signal, signal].filter(Boolean);
  const requestSignal = combined.length ? AbortSignal.any(combined) : undefined;
  const transport = transportFactory();
  let evidence;
  let connection = 'unavailable';
  try {
    evidence = await attest({ providerId: 'near-ai', modelId, apiKey, signal: requestSignal,
      includeTls: true, fetchImpl: transport.fetch });
    const gateway = evidence.reports?.[0];
    if (validHardware(evidence) && gateway?.tlsFingerprint && transport.peer()) {
      connection = gateway.tlsFingerprint === transport.peer().fingerprint ? 'checked' : 'failed';
    }
    report({ hardware: evidence, connection, response: 'pending' });
    const headers = new Headers(options.headers);
    headers.set('x-no-aliasing', 'true');
    headers.set('accept-encoding', 'identity');
    let response;
    try {
      response = await transport.fetch(url, { ...options, headers, signal: requestSignal }, true);
    } catch (error) {
      // This specific error occurs before req.end, so there is no duplicate POST.
      if (error.code !== 'PRIVACY_RECONNECTED') throw error;
      transport.close();
      connection = 'unavailable';
      response = await fetchImpl(input, { ...options, headers, signal: requestSignal });
    }
    if (!response.ok || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
      report({ connection, response: 'unavailable' });
      // Drain/cancel remains the caller's responsibility; closing would truncate its error body.
      return observeResponse(response, { release: transport.close, finish: async () => {} });
    }
    const requestHash = sha256(Buffer.from(options.body, 'utf8'));
    return observeResponse(response, { release: transport.close, finish: async (id, responseHash) => {
      let result = 'unavailable';
      try {
        if (id && responseHash && validHardware(evidence) && !requestSignal?.aborted) {
          const receiptSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...combined]);
          const signature = await fetchReceipt(id, apiKey, receiptSignal, fetchImpl);
          result = verifyReceipt(signature, evidence, modelId, requestHash, responseHash);
        }
      } catch { /* Missing receipts never become a successful verification. */ }
      report({ connection, response: result });
    } });
  } catch (error) {
    transport.close();
    report({ connection: 'unavailable', response: 'unavailable' });
    throw error;
  }
}

module.exports = { createNearTransport, verifyReceipt, observeResponse, fetchNearWithEvidence };
