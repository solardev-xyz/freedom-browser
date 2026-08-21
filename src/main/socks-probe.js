const net = require('net');
const { parseSocksEndpoint } = require('../shared/socks-endpoint');

const SOCKS5_NO_AUTH_GREETING = Buffer.from([0x05, 0x01, 0x00]);
const SOCKS5_LOCAL_CONNECT_PROBE = Buffer.from([
  0x05, // SOCKS version
  0x01, // CONNECT
  0x00, // reserved
  0x01, // IPv4 address
  127,
  0,
  0,
  1,
  0,
  1, // port 1
]);

function probeTcpEndpoint(endpoint, options = {}) {
  const parsed = parseSocksEndpoint(endpoint);
  if (!parsed) return Promise.resolve(false);

  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(parsed.port, parsed.host);
  });
}

function probeSocks5Endpoint(endpoint, options = {}) {
  const parsed = parseSocksEndpoint(endpoint);
  if (!parsed) return Promise.resolve(false);

  const timeoutMs = options.timeoutMs ?? 1000;
  const responseGraceMs = options.responseGraceMs ?? 50;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let phase = 'greeting';
    let responseGraceTimer = null;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (responseGraceTimer) {
        clearTimeout(responseGraceTimer);
        responseGraceTimer = null;
      }
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      // SOCKS5 greeting: version 5, one auth method, no-auth.
      socket.write(SOCKS5_NO_AUTH_GREETING);
    });
    socket.on('data', (chunk) => {
      if (phase !== 'greeting') {
        finish(true);
        return;
      }

      const acceptedNoAuth = chunk.length >= 2 && chunk[0] === 0x05 && chunk[1] !== 0xff;
      if (!acceptedNoAuth) {
        finish(false);
        return;
      }

      phase = 'connect-probe';
      socket.write(SOCKS5_LOCAL_CONNECT_PROBE, () => {
        if (settled) return;
        // The listener is healthy once it accepts the SOCKS method. Sending a
        // complete request avoids making Arti log an unfinished handshake.
        responseGraceTimer = setTimeout(() => finish(true), responseGraceMs);
      });
    });
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.connect(parsed.port, parsed.host);
  });
}

module.exports = {
  probeTcpEndpoint,
  probeSocks5Endpoint,
};
