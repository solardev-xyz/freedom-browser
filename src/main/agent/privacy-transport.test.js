'use strict';

const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { X509Certificate, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
jest.mock('node:https', () => ({ Agent: jest.fn(() => ({ destroy: jest.fn() })), request: jest.fn() }));
const https = require('node:https');
const { createNearTransport } = require('./privacy-request');
const cert = new X509Certificate(fs.readFileSync(path.join(__dirname, '../../../test/fixtures/ccip-gateway-tls/ccip-gateway-test.crt')));
const socket = () => Object.assign(new EventEmitter(), { connecting: false, authorized: true, getPeerCertificate: () => ({ raw: cert.raw }) });

function mockRequest(peer) {
  let req;
  https.request.mockImplementationOnce((_url, _options, callback) => {
    req = new EventEmitter();
    req.end = jest.fn(() => {
      const response = Readable.from([Buffer.from('{}')]);
      Object.assign(response, { statusCode: 200, headers: {} });
      callback(response);
    });
    req.destroy = error => req.emit('error', error);
    queueMicrotask(() => req.emit('socket', peer));
    return req;
  });
  return () => req;
}

test('uses the actual peer SPKI and sends inference only on that same socket', async () => {
  const transport = createNearTransport();
  const peer = socket();
  mockRequest(peer);
  await (await transport.fetch('https://cloud-api.near.ai/v1/attestation/report')).text();
  const expected = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  expect(transport.peer().fingerprint).toBe(expected);
  const request = mockRequest(peer);
  await (await transport.fetch('https://cloud-api.near.ai/v1/chat/completions', { method: 'POST', body: 'sensitive' }, true)).text();
  expect(request().end).toHaveBeenCalledWith('sensitive');
  transport.close();
});

test('rejects a replacement socket before any prompt bytes, even with the same certificate', async () => {
  const transport = createNearTransport();
  mockRequest(socket());
  await (await transport.fetch('https://cloud-api.near.ai/v1/attestation/report')).text();
  const request = mockRequest(socket());
  await expect(transport.fetch('https://cloud-api.near.ai/v1/chat/completions', { body: 'sensitive' }, true)).rejects.toMatchObject({ code: 'PRIVACY_RECONNECTED' });
  expect(request().end).not.toHaveBeenCalled();
  await expect(transport.fetch('https://evil.test')).rejects.toThrow('Unexpected privacy endpoint');
  transport.close();
});
