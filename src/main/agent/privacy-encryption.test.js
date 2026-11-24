'use strict';

const { createECDH } = require('node:crypto');
const { computeAddress } = require('ethers');
const { bindEncryptionKey, createEncryptionSession, encryptText, encryptChat, decryptResponse, veniceFallbackReason } = require('./privacy-encryption');

const model = createECDH('secp256k1');
model.setPrivateKey(Buffer.from('12'.repeat(32), 'hex')); // Unfunded, public test key.
const key = model.getPublicKey('hex');

test('encryption keys must be valid curve points bound to the checked address', () => {
  expect(bindEncryptionKey(key.slice(2), computeAddress(`0x${key}`))).toBe(key);
  expect(() => bindEncryptionKey(key, `0x${'ab'.repeat(20)}`)).toThrow('does not match');
  expect(() => bindEncryptionKey('04' + '00'.repeat(64), computeAddress(`0x${key}`))).toThrow();
});

test('encrypted messages and tool round trips never leave their sensitive fields plaintext', () => {
  const session = createEncryptionSession(key);
  const body = { messages: [{ role: 'system', content: 'SECRET system' },
    { role: 'user', content: [{ type: 'text', text: 'SECRET request' }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'SECRET function', arguments: '{"SECRET":"arg"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'SECRET result' }],
  tools: [{ type: 'function', function: { name: 'SECRET name', description: 'SECRET description', parameters: { description: 'SECRET schema' } } }],
  tool_choice: { type: 'function', function: { name: 'SECRET name' } } };
  const encrypted = encryptChat(body, session);
  expect(JSON.stringify(encrypted)).not.toContain('SECRET');
  expect(body.messages[0].content).toBe('SECRET system');
  expect(encrypted.messages[3].tool_call_id).toBe('call_1');
  session.close();
});

test('authenticates every encrypted response field and rejects plaintext/tampering', () => {
  const session = createEncryptionSession(key);
  const ciphertext = encryptText('Hello ü', session.publicKey);
  expect(session.decrypt(ciphertext)).toBe('Hello ü');
  const changed = ciphertext.slice(0, -2) + (ciphertext.endsWith('00') ? '01' : '00');
  expect(() => session.decrypt(changed)).toThrow('could not be authenticated');
  expect(() => session.decrypt('Hello ü')).toThrow('could not be authenticated');
  session.close();
  expect(() => session.decrypt(ciphertext)).toThrow('could not be authenticated');
});

test('decrypts SSE tools across one-byte chunks and cancels on malformed encrypted content', async () => {
  const session = createEncryptionSession(key);
  const encrypt = text => encryptText(text, session.publicKey);
  const record = { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: encrypt('read'), arguments: encrypt('{"path":"README.md"}') } }] } }] };
  const bytes = Buffer.from(`: keepalive\r\n\r\ndata: ${JSON.stringify(record)}\r\n\r\ndata: [DONE]\n\n`);
  let index = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (index < bytes.length) c.enqueue(bytes.subarray(index, ++index)); else c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const settled = jest.fn();
  const text = await decryptResponse(response, session, settled).text();
  expect(text).toContain('"name":"read"');
  expect(text).toContain('README.md');
  expect(text).toContain('[DONE]');
  expect(settled).toHaveBeenCalledWith(true);
  const bad = new Response('data: {"choices":[{"delta":{"content":"plaintext"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await expect(decryptResponse(bad, createEncryptionSession(key), settled).text()).rejects.toThrow('could not be authenticated');
  expect(settled).toHaveBeenLastCalledWith(false);
});

test('Venice fallback is based on request features, encrypting assistant history instead of falling back', () => {
  const body = { stream: true, messages: [{ role: 'user', content: 'hello' }] };
  expect(veniceFallbackReason(body)).toBeNull();
  expect(veniceFallbackReason({ ...body, tools: [{ type: 'function' }] })).toBe('tools');
  expect(veniceFallbackReason({ ...body, stream: false })).toBe('non-streaming');
  expect(veniceFallbackReason({ ...body, messages: [{ role: 'assistant', content: 'prior answer' }] })).toBeNull();
  expect(veniceFallbackReason({ ...body, messages: [{ role: 'user', content: [] }] })).toBe('attachments');
});

test('Venice normalizes text-only content parts without losing attachments or changing the original request', () => {
  const { normalizeVeniceText } = require('./privacy-encryption');
  const body = { stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: 'yo' }, { type: 'text', text: 'brother' }] }] };
  expect(normalizeVeniceText(body).messages[0].content).toBe('yo\nbrother');
  expect(Array.isArray(body.messages[0].content)).toBe(true);
  expect(veniceFallbackReason(normalizeVeniceText(body))).toBeNull();
  for (const part of [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } },
    { type: 'file', file: { file_id: 'test' } }, { type: 'text', text: 'yo', unknown: 'preserve me' }]) {
    const mixed = { ...body, tools: [{ type: 'function' }], messages: [{ role: 'user', content: [...body.messages[0].content, part] }] };
    expect(normalizeVeniceText(mixed)).toEqual(mixed);
    expect(veniceFallbackReason(normalizeVeniceText(mixed))).toBe('attachments');
  }
});
