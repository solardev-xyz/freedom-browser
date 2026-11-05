'use strict';

const https = require('node:https');
const { Readable } = require('node:stream');
const { createHash, randomBytes, X509Certificate } = require('node:crypto');
const { verifyMessage } = require('ethers');
const { checkProviderAttestation } = require('./privacy-attestation');

const { createEncryptionSession, encryptChat, decryptResponse, veniceFallbackReason, normalizeVeniceText } = require('./privacy-encryption');

const ORIGIN = 'https://cloud-api.near.ai';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blockedEncryption = () => Response.json({ error: { type: 'privacy_verification_failed',
  message: 'Encrypted inference could not verify or prepare this request. No message contents were sent. Try again or choose another model.',
} }, { status: 400 });
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
  fetchImpl = globalThis.fetch, transportFactory = createNearTransport, attest = checkProviderAttestation, encrypt = false, reportEncryption = () => {} }) {
  const url = new URL(input?.url || input);
  const unsupported = () => {
    if (encrypt) {
      reportEncryption('blocked'); report({ connection: 'unavailable', response: 'unavailable' });
      return blockedEncryption();
    }
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
  let encryption;
  let sent = false;
  let connection = 'unavailable';
  try {
    evidence = await attest({ providerId: 'near-ai', modelId, apiKey, signal: requestSignal,
      includeTls: true, includeKeys: encrypt, fetchImpl: transport.fetch });
    const gateway = evidence.reports?.[0];
    if (validHardware(evidence) && gateway?.tlsFingerprint && transport.peer()) {
      connection = gateway.tlsFingerprint === transport.peer().fingerprint ? 'checked' : 'failed';
    }
    report({ hardware: evidence, connection, response: 'pending' });
    const headers = new Headers(options.headers);
    if (encrypt) {
      const reports = evidence.reports || [];
      if (!validHardware(evidence) || reports.length < 2 ||
        reports.some(r => !['UpToDate', 'OutOfDate'].includes(r.tcb)) ||
        reports.slice(1).some(r => !r.encryptionKey)) {
        throw new Error('NEAR encryption could not verify the model keys. No messages were sent.');
      }
      encryption = createEncryptionSession(reports[1].encryptionKey);
      options = { ...options, body: JSON.stringify(encryptChat(request, encryption)) };
      headers.set('X-Signing-Algo', 'ecdsa');
      headers.set('X-Client-Pub-Key', encryption.publicKey);
      headers.set('X-Model-Pub-Key', encryption.modelKey.slice(2));
      headers.set('X-Encrypt-All-Fields', 'true');
    }
    headers.set('x-no-aliasing', 'true');
    headers.set('accept-encoding', 'identity');
    let response;
    sent = true;
    if (encrypt) reportEncryption('encrypted');
    try {
      response = await transport.fetch(url, { ...options, headers, signal: requestSignal }, true);
    } catch (error) {
      // This specific error occurs before req.end, so there is no duplicate POST.
      if (error.code !== 'PRIVACY_RECONNECTED') throw error;
      transport.close();
      connection = 'unavailable';
      response = await fetchImpl(input, { ...options, headers, redirect: 'error', signal: requestSignal });
    }
    if (!response.ok || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
      encryption?.close();
      if (encrypt) reportEncryption('failed');
      report({ connection, response: 'unavailable' });
      // Drain/cancel remains the caller's responsibility; closing would truncate its error body.
      return observeResponse(response, { release: transport.close, finish: async () => {} });
    }
    const requestHash = sha256(Buffer.from(options.body, 'utf8'));
    const observed = observeResponse(response, { release: transport.close, finish: async (id, responseHash) => {
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
    return encryption ? decryptResponse(observed, encryption, ok => { if (!ok) reportEncryption('failed'); }) : observed;
  } catch (error) {
    encryption?.close();
    if (encrypt) reportEncryption(sent ? 'failed' : 'blocked');
    transport.close();
    report({ connection: 'unavailable', response: 'unavailable' });
    if (encrypt && !sent && !signal?.aborted && !options.signal?.aborted) return blockedEncryption();
    throw error;
  }
}

// Venice cannot accept native tools under E2EE. First let the same model answer
// with encrypted text, or explicitly hand off to the original tool request.
// This changes transport selection only; all tool execution still uses the
// normal Agent permissions and tool validation.
function veniceTextAttempt(body) {
  if (!body.tools?.length || (body.tool_choice && body.tool_choice !== 'auto' && body.tool_choice !== 'none')) return null;
  const text = structuredClone(body);
  delete text.tools; delete text.tool_choice; delete text.parallel_tool_calls;
  if (veniceFallbackReason(text)) return null;
  if (body.tool_choice === 'none') return { body: text };
  const marker = `FREEDOM_TOOLS_${randomBytes(12).toString('hex')}`;
  const instruction = `This is an encrypted answering step. Native tools are temporarily unavailable. ` +
    `If the current request needs a tool, browsing, checking current facts, inspecting files or taking an action, ` +
    `reply with exactly ${marker} and nothing else. The normal tool workflow will then continue. ` +
    `Never pretend to have used a tool or performed an action. Otherwise answer the user normally. ` +
    `Do not emit tool-call syntax in this step. Tools available in the subsequent workflow: ` +
    body.tools.map(tool => `${tool.function?.name}: ${tool.function?.description || ''}`).join('\n');
  const system = text.messages.find(m => m.role === 'system');
  if (system) system.content += `\n\n${instruction}`;
  else text.messages.unshift({ role: 'system', content: instruction });
  return { body: text, marker };
}

// Buffer only until the first ordinary answer text. Then replay the prefix and
// continue streaming; do not hold a whole long answer or expose the handoff token.
async function veniceAnswerOrHandoff(response, marker) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const prefix = [];
  let pending = '', content = '', size = 0, stopped = false, ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (content.trim() === marker && stopped && ended) return null;
        throw new Error('The encrypted answering step did not return an answer or a complete tool handoff.');
      }
      prefix.push(chunk.value); size += chunk.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error('Encrypted answer prefix is too large');
      pending += decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const record = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const data = record.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') { ended = true; continue; }
        if (!data) continue;
        const choice = JSON.parse(data).choices?.[0];
        if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
        if (choice?.finish_reason) stopped = choice.finish_reason === 'stop';
      }
      const start = content.trimStart();
      if (start && !marker.startsWith(start) && start.trim() !== marker) {
        if (start.startsWith(marker)) throw new Error('Invalid encrypted tool handoff');
        return new Response(new ReadableStream({
          async pull(controller) {
            if (prefix.length) { controller.enqueue(prefix.shift()); return; }
            try { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }
            catch (error) { controller.error(error); }
          },
          cancel: reason => reader.cancel(reason),
        }), { status: response.status, headers: response.headers });
      }
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

async function fetchVeniceEncrypted({ input, options = {}, modelId, apiKey, signal, report, reportEncryption, nextAttempt,
  fetchImpl = globalThis.fetch, attest = checkProviderAttestation }) {
  const url = new URL(input?.url || input);
  if (url.href !== 'https://api.venice.ai/api/v1/chat/completions' || options.method !== 'POST' || typeof options.body !== 'string') {
    reportEncryption('blocked');
    throw new Error('Unexpected Venice encryption request');
  }
  const body = JSON.parse(options.body);
  if (body.model !== modelId) throw new Error('Encryption model changed');
  const signals = [options.signal, signal].filter(Boolean);
  options = { ...options, signal: signals.length ? AbortSignal.any(signals) : undefined };
  options.signal?.throwIfAborted();
  const textBody = normalizeVeniceText(body);
  const attempt = veniceTextAttempt(textBody);
  const reason = veniceFallbackReason(attempt?.body || textBody);
  if (reason) {
    reportEncryption('unencrypted', reason);
    report({ connection: 'unavailable', response: 'unavailable' });
    return fetchImpl(input, { ...options, redirect: 'error' });
  }
  let session;
  let sent = false;
  try {
    const hardware = await attest({ providerId: 'venice', modelId, apiKey, signal: options.signal, includeKeys: true });
    report({ hardware, connection: 'unavailable', response: 'pending' });
    if (!validHardware(hardware) || hardware.reports?.length !== 1 ||
      !['UpToDate', 'OutOfDate'].includes(hardware.reports[0].tcb) || !hardware.reports[0].encryptionKey) {
      throw new Error('Venice encryption could not verify the model key. No messages were sent.');
    }
    session = createEncryptionSession(hardware.reports[0].encryptionKey);
    const headers = new Headers(options.headers);
    headers.set('X-Venice-TEE-Client-Pub-Key', session.publicKey);
    headers.set('X-Venice-TEE-Model-Pub-Key', session.modelKey);
    headers.set('X-Venice-TEE-Signing-Algo', 'ecdsa');
    const encryptedBody = JSON.stringify(encryptChat(attempt?.body || textBody, session));
    sent = true; reportEncryption('encrypted');
    const response = await fetchImpl(input, { ...options, headers, redirect: 'error',
      body: encryptedBody });
    report({ connection: 'unavailable', response: 'unavailable' });
    if (!response.ok) {
      session.close(); reportEncryption('failed'); return response;
    }
    const decrypted = decryptResponse(response, session, ok => { if (!ok) reportEncryption('failed'); });
    if (!attempt?.marker) return decrypted;
    const answer = await veniceAnswerOrHandoff(decrypted, attempt.marker);
    if (answer) return answer;
    options.signal?.throwIfAborted();
    // This is a second network request, not a retry of failed encryption.
    // Count and disclose both legs; never take this path after a crypto failure.
    if (nextAttempt) ({ report, reportEncryption } = nextAttempt());
    reportEncryption('unencrypted', 'tools');
    report({ connection: 'unavailable', response: 'unavailable' });
    return await fetchImpl(input, { ...options, redirect: 'error' });
  } catch (error) {
    session?.close(); reportEncryption(sent ? 'failed' : 'blocked');
    report({ connection: 'unavailable', response: 'unavailable' });
    if (!sent && !signal?.aborted && !options.signal?.aborted) return blockedEncryption();
    throw error;
  }
}

module.exports = { createNearTransport, verifyReceipt, observeResponse, fetchNearWithEvidence, fetchVeniceEncrypted };
