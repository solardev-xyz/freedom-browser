'use strict';

const { createCipheriv, createDecipheriv, hkdfSync, randomBytes } = require('node:crypto');
const { computeAddress, SigningKey } = require('ethers');

// Both providers document this ECDSA protocol. Ethers supplies the curve
// (Electron BoringSSL lacks secp256k1); native crypto supplies HKDF/AES-GCM.
// Never retain private keys in conversation history.
function publicKey(value) {
  const hex = typeof value === 'string' ? value.replace(/^0x/, '') : '';
  if (!/^(?:04)?[a-f0-9]{128}$/i.test(hex)) throw new Error('Invalid encryption public key');
  const key = Buffer.from(hex.length === 128 ? `04${hex}` : hex, 'hex');
  computeAddress(`0x${key.toString('hex')}`); // Validates the curve point.
  return key;
}

function bindEncryptionKey(key, address) {
  const normalized = publicKey(key);
  if (computeAddress(`0x${normalized.toString('hex')}`).toLowerCase() !== address?.toLowerCase()) {
    throw new Error('Encryption key does not match hardware evidence');
  }
  return normalized.toString('hex');
}

function derive(ecdh, peer) {
  const secret = Buffer.from(ecdh.computeSharedSecret(peer).slice(4, 68), 'hex');
  try { return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ecdsa_encryption', 32)); }
  finally { secret.fill(0); }
}

function encryptText(text, recipient) {
  const ephemeral = new SigningKey(randomBytes(32));
  const key = derive(ephemeral, publicKey(recipient));
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([Buffer.from(ephemeral.publicKey.slice(2), 'hex'), nonce, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('hex');
  } finally { key.fill(0); }
}

function createEncryptionSession(modelKey) {
  const recipient = publicKey(modelKey).toString('hex');
  let client = new SigningKey(randomBytes(32));
  return {
    publicKey: client.publicKey.slice(2),
    modelKey: recipient,
    encrypt: text => encryptText(text, recipient),
    decrypt(text) {
      if (text === '') return ''; // Protocol represents encrypted empty fields this way.
      try {
        if (!client || typeof text !== 'string' || !/^[a-f0-9]+$/i.test(text) || text.length % 2 || text.length < 186) throw new Error();
        const bytes = Buffer.from(text, 'hex');
        const key = derive(client, publicKey(bytes.subarray(0, 65).toString('hex')));
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(65, 77));
          decipher.setAuthTag(bytes.subarray(-16));
          return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([
            decipher.update(bytes.subarray(77, -16)), decipher.final(),
          ]));
        } finally { key.fill(0); }
      } catch { throw new Error('The encrypted response could not be authenticated. No unencrypted retry was made.'); }
    },
    close() { client = null; },
  };
}

const fields = (value, names, transform) => {
  if (!value) return;
  for (const name of names) if (typeof value[name] === 'string') value[name] = transform(value[name]);
};
const functions = (message, transform) => {
  fields(message.function_call, ['name', 'arguments'], transform);
  for (const call of message.tool_calls || []) fields(call.function, ['name', 'arguments'], transform);
};

function veniceFallbackReason(body) {
  if (!body.stream) return 'non-streaming';
  if (body.functions?.length || (body.tool_choice && !['auto', 'none'].includes(body.tool_choice)) || body.function_call ||
    body.messages?.some(m => m.tool_calls?.length || m.function_call || ['tool', 'function'].includes(m.role))) return 'tools';
  if (!Array.isArray(body.messages) || body.messages.some(m => typeof m.content !== 'string')) return 'attachments';
  // Assistant history is encrypted too (verified against the live endpoint).
  if (body.messages.some(m => !['user', 'system', 'assistant'].includes(m.role))) return 'history';
  if (body.tools?.length || body.tool_choice) return 'tools';
  return null;
}

// Pi AgentSession emits content-part arrays even for a plain text greeting.
// Flatten only known text parts; images/files/unknown parts must keep the
// unsupported-feature path. Keep the original body intact for native fallback.
function normalizeVeniceText(body) {
  const result = structuredClone(body);
  for (const message of result.messages || []) {
    if (Array.isArray(message.content) && message.content.length && message.content.every(part =>
      part?.type === 'text' && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key)))) {
      message.content = message.content.map(part => part.text).join('\n');
    }
  }
  return result;
}

function encryptChat(body, session) {
  const result = structuredClone(body);
  for (const message of result.messages || []) {
    if (Array.isArray(message.content)) message.content = JSON.stringify(message.content);
    fields(message, ['content', 'reasoning_content', 'reasoning', 'name', 'refusal'], session.encrypt);
    fields(message.audio, ['data'], session.encrypt);
    functions(message, session.encrypt);
  }
  for (const tool of result.tools || []) {
    if (tool.type !== 'function' || !tool.function) throw new Error('This tool type does not support encrypted inference');
    fields(tool.function, ['name', 'description'], session.encrypt);
    if (tool.function.parameters != null) tool.function.parameters = session.encrypt(JSON.stringify(tool.function.parameters));
  }
  fields(result.tool_choice?.function, ['name'], session.encrypt);
  fields(result.function_call, ['name'], session.encrypt);
  if (result.functions?.length) throw new Error('Legacy function definitions do not support encrypted inference');
  return result;
}

function decryptChat(body, session) {
  if (body.error) throw new Error('The encrypted inference request failed');
  for (const choice of body.choices || []) {
    for (const message of [choice.message, choice.delta].filter(Boolean)) {
      fields(message, ['content', 'reasoning_content', 'reasoning', 'refusal'], session.decrypt);
      fields(message.audio, ['data'], session.decrypt);
      if (Array.isArray(message.content)) for (const part of message.content) fields(part, ['text', 'refusal'], session.decrypt);
      fields(message.nearai_tool_result, ['output'], session.decrypt);
      functions(message, session.decrypt);
    }
    for (const group of ['content', 'refusal']) for (const token of choice.logprobs?.[group] || []) {
      fields(token, ['token'], session.decrypt);
      for (const alternative of token.top_logprobs || []) fields(alternative, ['token'], session.decrypt);
    }
  }
  return body;
}

// Decrypt complete SSE records, not arbitrary network chunks. Hash/signature
// observation, when available, must run on the original ciphertext stream first.
function decryptResponse(response, session, settled = () => {}) {
  const reader = response.body?.getReader();
  const streaming = response.headers.get('content-type')?.includes('text/event-stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let pending = '', done = false, completedStream = false;
  const finish = success => { if (!done) { done = true; session.close(); settled(success); } };
  const transform = record => {
    const lines = record.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data === '[DONE]') completedStream = true;
    if (!data || data === '[DONE]') return record + '\n\n';
    const result = JSON.stringify(decryptChat(JSON.parse(data), session));
    return lines.filter(line => !line.startsWith('data:')).concat(`data: ${result}`).join('\n') + '\n\n';
  };
  const headers = new Headers(response.headers);
  headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        while (!done) {
          let emitted = false;
          const chunk = reader ? await reader.read() : { done: true };
          pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
          if (pending.length > 8 * 1024 * 1024) throw new Error();
          if (streaming) {
            let match;
            while ((match = /\r?\n\r?\n/.exec(pending))) {
              controller.enqueue(encoder.encode(transform(pending.slice(0, match.index))));
              emitted = true;
              pending = pending.slice(match.index + match[0].length);
            }
          }
          if (chunk.done) {
            if (pending) controller.enqueue(encoder.encode(streaming ? transform(pending) : JSON.stringify(decryptChat(JSON.parse(pending), session))));
            finish(true); controller.close();
          }
          if (emitted) break;
        }
      } catch {
        finish(false);
        await reader?.cancel().catch(() => {});
        controller.error(new Error('The encrypted response could not be authenticated. No unencrypted retry was made.'));
      }
    },
    async cancel(reason) { finish(completedStream); await reader?.cancel(reason); },
  }), { status: response.status, statusText: response.statusText, headers });
}

module.exports = { bindEncryptionKey, createEncryptionSession, encryptText, encryptChat,
  veniceFallbackReason, normalizeVeniceText, decryptResponse };
