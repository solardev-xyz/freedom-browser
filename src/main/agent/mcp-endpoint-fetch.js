'use strict';

const https = require('node:https');
const dns = require('node:dns').promises;
const { BlockList, isIP } = require('node:net');
const { Readable } = require('node:stream');

const excluded = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) excluded.addSubnet(address, prefix);
for (const [address, prefix] of [['::', 96], ['64:ff9b::', 96], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) excluded.addSubnet(address, prefix, 'ipv6');
// IANA currently allocates global IPv6 unicast only from 2000::/3.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function publicAddress(address) {
  const family = isIP(address);
  if (family === 6 && new URL(`https://[${address}]/`).hostname.startsWith('[::ffff:')) return false;
  if (family === 6 && !globalV6.check(address, 'ipv6')) return false;
  return Boolean(family && !excluded.check(address, family === 6 ? 'ipv6' : 'ipv4'));
}

async function publicEndpointAddresses(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('The service advertised a private authentication endpoint.');
  return addresses;
}

// Authentication metadata is server-controlled. Foreign origins must resolve
// publicly, and the connection uses exactly those vetted addresses, with normal
// TLS hostname verification. An explicitly connected local MCP origin retains
// its own local access; it cannot delegate that access to another origin.
function createMcpEndpointFetch(serverUrl, options = {}) {
  const origin = new URL(serverUrl).origin;
  return async (input, init = {}) => {
    options.assertEnabled?.();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const signal = AbortSignal.any([AbortSignal.timeout(30000),
      ...(init.signal ? [init.signal] : []), ...(options.featureSignal ? [options.featureSignal()] : [])]);
    if (url.origin === origin) return options.fetch(input, { ...init, signal, redirect: 'error' });
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The service advertised an unsafe authentication endpoint.');
    const addresses = await publicEndpointAddresses(url, options.lookup);
    signal.throwIfAborted();
    options.assertEnabled?.();
    const request = new Request(input, { ...init, signal, redirect: 'error', duplex: 'half' });
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    if (body?.length > 4 * 1024 * 1024) throw new Error('Authentication request is too large.');
    const headers = Object.fromEntries(request.headers);
    headers['accept-encoding'] = 'identity';
    return new Promise((resolve, reject) => {
      const connection = (options.request || https.request)(url, {
        method: request.method, headers, signal,
        lookup: (_hostname, lookupOptions, callback) => lookupOptions.all
          ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          reject(new Error('Authentication redirects must be advertised explicitly.'));
          return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [String(value)]) responseHeaders.append(key, item);
        }
        let received = 0;
        const bounded = Readable.toWeb(response).pipeThrough(new TransformStream({ transform(chunk, controller) {
          received += chunk.length;
          if (received > 4 * 1024 * 1024) {
            response.destroy();
            controller.error(new Error('Authentication response is too large.'));
          } else controller.enqueue(chunk);
        } }));
        resolve(new Response([204, 205, 304].includes(response.statusCode) || request.method === 'HEAD' ? null : bounded,
          { status: response.statusCode, headers: responseHeaders }));
      });
      connection.on('error', reject);
      connection.end(body);
    });
  };
}

module.exports = { createMcpEndpointFetch, publicAddress, publicEndpointAddresses };
