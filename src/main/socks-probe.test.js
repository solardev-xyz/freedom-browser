const net = require('net');
const { probeSocks5Endpoint, probeTcpEndpoint } = require('./socks-probe');

const SOCKS5_GREETING = Buffer.from([0x05, 0x01, 0x00]);
const SOCKS5_LOCAL_CONNECT_PROBE = Buffer.from([
  0x05,
  0x01,
  0x00,
  0x01,
  127,
  0,
  0,
  1,
  0,
  1,
]);

function listenWithHandler(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        endpoint: `127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('socks-probe helpers', () => {
  test('probeTcpEndpoint verifies that the listener accepts TCP without sending SOCKS bytes', async () => {
    let receivedBytes = 0;
    const { server, endpoint } = await listenWithHandler((socket) => {
      socket.on('data', (chunk) => {
        receivedBytes += chunk.length;
      });
    });

    try {
      await expect(probeTcpEndpoint(endpoint, { timeoutMs: 500 })).resolves.toBe(true);
      expect(receivedBytes).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  test('sends a complete SOCKS request after the method greeting is accepted', async () => {
    let received = Buffer.alloc(0);
    let sentMethodReply = false;
    let connectProbe = null;
    const { server, endpoint } = await listenWithHandler((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (!sentMethodReply && received.length >= SOCKS5_GREETING.length) {
          sentMethodReply = true;
          socket.write(Buffer.from([0x05, 0x00]));
        }
        if (!connectProbe && received.length >= SOCKS5_GREETING.length + SOCKS5_LOCAL_CONNECT_PROBE.length) {
          connectProbe = received.subarray(
            SOCKS5_GREETING.length,
            SOCKS5_GREETING.length + SOCKS5_LOCAL_CONNECT_PROBE.length
          );
          socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        }
      });
    });

    try {
      await expect(
        probeSocks5Endpoint(endpoint, { timeoutMs: 500, responseGraceMs: 5 })
      ).resolves.toBe(true);
      expect(received.subarray(0, SOCKS5_GREETING.length)).toEqual(SOCKS5_GREETING);
      expect(connectProbe).toEqual(SOCKS5_LOCAL_CONNECT_PROBE);
    } finally {
      await closeServer(server);
    }
  });

  test('returns false when the SOCKS server rejects all auth methods', async () => {
    let received = Buffer.alloc(0);
    const { server, endpoint } = await listenWithHandler((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        socket.write(Buffer.from([0x05, 0xff]));
      });
    });

    try {
      await expect(probeSocks5Endpoint(endpoint, { timeoutMs: 500 })).resolves.toBe(false);
      expect(received).toEqual(SOCKS5_GREETING);
    } finally {
      await closeServer(server);
    }
  });
});
