'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createMcpEndpointFetch, publicAddress } = require('./mcp-endpoint-fetch');

test.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.2.3', '100.64.1.2',
  '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1'])('refuses private or reserved authentication address %s', address => {
  expect(publicAddress(address)).toBe(false);
});

test('allows a deliberately connected local service but never a foreign private authentication host', async () => {
  const fetch = jest.fn(async () => new Response('{}'));
  const request = jest.fn();
  const guarded = createMcpEndpointFetch('http://localhost:8123/mcp', { fetch, request,
    lookup: async () => [{ address: '192.168.1.2', family: 4 }] });
  await guarded('http://localhost:8123/token');
  expect(fetch).toHaveBeenCalledWith('http://localhost:8123/token', expect.objectContaining({ redirect: 'error' }));
  await expect(guarded('https://authentication.test/token')).rejects.toThrow('private authentication endpoint');
  expect(request).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('pins public DNS results to the TLS connection and refuses redirects', async () => {
  const lookup = jest.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const request = jest.fn((_url, options, onResponse) => {
    const callback = jest.fn();
    options.lookup('authentication.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    const connection = new EventEmitter();
    connection.end = () => {
      const response = new PassThrough();
      response.statusCode = 302;
      response.headers = { location: 'https://127.0.0.1/private' };
      onResponse(response);
    };
    return connection;
  });
  const guarded = createMcpEndpointFetch('https://service.test/mcp', { fetch: jest.fn(), lookup, request });
  await expect(guarded('https://authentication.test/token')).rejects.toThrow('redirects');
  expect(request).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledTimes(1);
});

test('feature shutdown prevents authentication traffic', async () => {
  const fetch = jest.fn();
  const guarded = createMcpEndpointFetch('https://service.test/mcp', {
    fetch, assertEnabled: () => { throw new Error('AI is disabled'); },
  });
  await expect(guarded('https://service.test/token')).rejects.toThrow('AI is disabled');
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['64:ff9b:1::1', 'fec0::1', '100:0:0:1::1', '3fff::1', '5f00::1', '3ffe::1', '4000::1'])('rejects non-global IPv6 %s before connecting, including mixed answers', async address => {
  expect(publicAddress(address)).toBe(false);
  for (const answers of [[{ address, family: 6 }], [{ address: '2606:4700:4700::1111', family: 6 }, { address, family: 6 }]]) {
    const request = jest.fn();
    const guarded = createMcpEndpointFetch('https://service.test/mcp', { fetch: jest.fn(), request, lookup: async () => answers });
    await expect(guarded('https://authentication.test/token')).rejects.toThrow('private authentication endpoint');
    expect(request).not.toHaveBeenCalled();
  }
});

test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('retains public IPv4 and IPv6 destination %s', address => {
  expect(publicAddress(address)).toBe(true);
});
