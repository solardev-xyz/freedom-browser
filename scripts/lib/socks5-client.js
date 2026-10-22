'use strict';

/**
 * A minimal SOCKS5 client for the Arti qualification
 * (`scripts/qualify-arti-resolve.js`): one request per connection, Tor's
 * `RESOLVE` extension (command 0xF0) and `CONNECT`, with no authentication
 * or with a username and password (RFC 1929), offered alone.
 *
 * It speaks the protocol exactly as freedom-ipfsd's SOCKS client does
 * (freedom-ipfs-net's `socks` module, design 0007 "The SOCKS contract"):
 * one method offered, no fallback when the proxy picks another, and a
 * `RESOLVE` answer counts only as one IPv4 or IPv6 address, never a
 * domain-typed one, `0.0.0.0` or `::`.
 */

const net = require('net');

const VERSION = 0x05;
const AUTH_VERSION = 0x01;
const NO_AUTH = 0x00;
const USER_PASS = 0x02;
const CONNECT = 0x01;
const RESOLVE = 0xf0;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

/** The greeting: one method, offered alone. */
function greeting(credentials) {
  return Buffer.from([VERSION, 0x01, credentials ? USER_PASS : NO_AUTH]);
}

/** RFC 1929's username/password request. */
function authentication({ username, password }) {
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  if (user.length < 1 || user.length > 255 || pass.length < 1 || pass.length > 255) {
    throw new Error('SOCKS5 credentials must be 1 to 255 bytes each');
  }
  return Buffer.concat([
    Buffer.from([AUTH_VERSION, user.length]),
    user,
    Buffer.from([pass.length]),
    pass,
  ]);
}

/**
 * A request: `command` for `target`, either `{ name, port }` (a domain) or
 * `{ ip, port }` (an IPv4 or IPv6 literal; an IPv6 one may end in dotted
 * IPv4, as `::ffff:192.0.2.1`, but has no zone).
 */
function request(command, target) {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port || 0);
  if (target.ip) {
    const family = net.isIP(target.ip);
    if (family === 4) {
      const octets = target.ip.split('.').map(Number);
      return Buffer.concat([Buffer.from([VERSION, command, 0x00, ATYP_IPV4, ...octets]), port]);
    }
    if (family === 6) {
      if (target.ip.includes('%')) throw new Error('an IPv6 literal with a zone');
      return Buffer.concat([
        Buffer.from([VERSION, command, 0x00, ATYP_IPV6]),
        ipv6Bytes(target.ip),
        port,
      ]);
    }
    throw new Error('not an IP literal');
  }
  const name = Buffer.from(target.name, 'ascii');
  if (name.length < 1 || name.length > 255) {
    throw new Error('a SOCKS5 name must be 1 to 255 bytes');
  }
  return Buffer.concat([
    Buffer.from([VERSION, command, 0x00, ATYP_DOMAIN, name.length]),
    name,
    port,
  ]);
}

/**
 * The 16 bytes of a valid IPv6 literal (`net.isIP` says so): its groups,
 * a dotted IPv4 suffix as the last two, and `::` as the zeros it stands
 * for.
 */
function ipv6Bytes(ip) {
  const groups = (part) => (part ? part.split(':') : []);
  const dotted = (list) => {
    const last = list[list.length - 1];
    if (last === undefined || !last.includes('.')) return list;
    const [a, b, c, d] = last.split('.').map(Number);
    return [...list.slice(0, -1), ((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
  };
  const [head, tail] = ip.split('::');
  let all;
  if (tail === undefined) {
    all = dotted(groups(head));
  } else {
    const left = groups(head);
    const right = dotted(groups(tail));
    all = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  }
  if (all.length !== 8) throw new Error('not an IPv6 literal');
  const bytes = Buffer.alloc(16);
  all.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
  return bytes;
}

function ipv6Text(bytes) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(':');
}

/**
 * Reads a reply's head and bound address from `buffer`: `null` until it has
 * all arrived; otherwise `{ code, address, length }`, `address` being
 * `{ ip }` or `{ name }`. Throws on a reply outside the protocol.
 */
function parseReply(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== VERSION || buffer[2] !== 0x00) {
    throw new Error('the SOCKS5 reply is outside the protocol');
  }
  const code = buffer[1];
  const atyp = buffer[3];
  let length;
  let address;
  if (atyp === ATYP_IPV4) {
    length = 4 + 4 + 2;
    if (buffer.length < length) return null;
    address = { ip: [...buffer.subarray(4, 8)].join('.') };
  } else if (atyp === ATYP_IPV6) {
    length = 4 + 16 + 2;
    if (buffer.length < length) return null;
    address = { ip: ipv6Text(buffer.subarray(4, 20)) };
  } else if (atyp === ATYP_DOMAIN) {
    if (buffer.length < 5) return null;
    length = 4 + 1 + buffer[4] + 2;
    if (buffer.length < length) return null;
    address = { name: buffer.subarray(5, 5 + buffer[4]).toString('ascii') };
  } else {
    throw new Error('the SOCKS5 reply has an unknown address type');
  }
  return { code, address, length };
}

/** Whether a `RESOLVE` answer is one usable address. */
function isUsableAnswer(address) {
  if (!address || !address.ip) return false;
  return address.ip !== '0.0.0.0' && !/^[0:]+$/.test(address.ip);
}

/**
 * One SOCKS5 request to `proxy` (`{ host, port }`): `{ command: 'resolve',
 * name }` or `{ command: 'connect', ip | name, port }`, with `credentials`
 * (`{ username, password }`) or none. Resolves to `{ code, address }`;
 * rejects when the proxy can't be reached, refuses the method, fails the
 * authentication, answers outside the protocol, or doesn't answer within
 * `timeoutMs`.
 */
function socks5Request(proxy, target, { credentials = null, timeoutMs = 30000 } = {}) {
  const command = target.command === 'resolve' ? RESOLVE : CONNECT;
  const body = request(command, target);
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let phase = 'greeting';
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`no SOCKS5 answer in ${phase}`)), timeoutMs);
    socket.on('connect', () => socket.write(greeting(credentials)));
    socket.on('error', (error) => finish(error));
    socket.on('close', () =>
      finish(new Error(`the SOCKS5 proxy closed the connection in ${phase}`))
    );
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          if (phase === 'greeting') {
            if (buffer.length < 2) return;
            const [version, chosen] = buffer;
            buffer = buffer.subarray(2);
            if (version !== VERSION) {
              finish(new Error('the SOCKS5 method selection is outside the protocol'));
              return;
            }
            if (chosen !== (credentials ? USER_PASS : NO_AUTH)) {
              finish(new Error('the SOCKS5 proxy refused the authentication method'));
              return;
            }
            if (credentials) {
              phase = 'authentication';
              socket.write(authentication(credentials));
            } else {
              phase = 'request';
              socket.write(body);
            }
          } else if (phase === 'authentication') {
            if (buffer.length < 2) return;
            const [version, status] = buffer;
            buffer = buffer.subarray(2);
            if (version !== AUTH_VERSION) {
              finish(new Error('the RFC 1929 reply is outside the protocol'));
              return;
            }
            if (status !== 0x00) {
              finish(new Error('the SOCKS5 proxy refused the credentials'));
              return;
            }
            phase = 'request';
            socket.write(body);
          } else {
            const reply = parseReply(buffer);
            if (!reply) return;
            finish(null, { code: reply.code, address: reply.address });
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

module.exports = {
  socks5Request,
  isUsableAnswer,
  parseReply,
  request,
  greeting,
  authentication,
};
