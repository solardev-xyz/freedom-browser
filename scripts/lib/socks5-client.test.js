const net = require('net');
const {
  socks5Request,
  isUsableAnswer,
  parseReply,
  request,
  greeting,
  authentication,
} = require('./socks5-client');

/**
 * A scripted SOCKS5 server: answers the greeting with `method` (in
 * `methodVersion`, 5 unless given), an RFC 1929 request with `authStatus`
 * (in `authVersion`, 1 unless given), and the request with `reply` (raw
 * bytes).
 * Records everything the client sent. `afterEach` closes it, so a failing
 * test doesn't leave it listening.
 */
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function scriptedProxy({
  method = 0x00,
  methodVersion = 0x05,
  authStatus = 0x00,
  authVersion = 0x01,
  reply,
}) {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.on('end', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let phase = 'greeting';
    socket.on('data', (chunk) => {
      seen.push(Buffer.from(chunk));
      if (phase === 'greeting') {
        socket.write(Buffer.from([methodVersion, method]));
        phase = method === 0x02 ? 'authentication' : 'request';
      } else if (phase === 'authentication') {
        socket.write(Buffer.from([authVersion, authStatus]));
        phase = 'request';
      } else {
        socket.write(reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ proxy: { host: '127.0.0.1', port: server.address().port }, seen });
    });
  });
}

const reply = (...bytes) => Buffer.from([0x05, ...bytes]);

describe('socks5-client', () => {
  test('a RESOLVE without credentials offers no-auth alone and reads one address', async () => {
    const server = await scriptedProxy({ reply: reply(0x00, 0x00, 0x01, 8, 8, 4, 4, 0, 0) });
    const result = await socks5Request(server.proxy, { command: 'resolve', name: 'example.com' });
    expect(result).toEqual({ code: 0, address: { ip: '8.8.4.4' } });
    expect(server.seen[0]).toEqual(Buffer.from([0x05, 0x01, 0x00]));
    expect(server.seen[1]).toEqual(
      Buffer.concat([
        Buffer.from([0x05, 0xf0, 0x00, 0x03, 11]),
        Buffer.from('example.com'),
        Buffer.from([0, 0]),
      ])
    );
  });

  test('a RESOLVE with credentials offers user/pass alone and sends them', async () => {
    const server = await scriptedProxy({
      method: 0x02,
      reply: Buffer.concat([reply(0x00, 0x00, 0x04), Buffer.alloc(15), Buffer.from([1, 0, 0])]),
    });
    const result = await socks5Request(
      server.proxy,
      { command: 'resolve', name: 'example.com' },
      { credentials: { username: 'u', password: 'pw' } }
    );
    expect(result).toEqual({ code: 0, address: { ip: '0:0:0:0:0:0:0:1' } });
    expect(server.seen[0]).toEqual(Buffer.from([0x05, 0x01, 0x02]));
    expect(server.seen[1]).toEqual(Buffer.from([0x01, 1, 0x75, 2, 0x70, 0x77]));
  });

  test('a proxy that picks another method fails the request, with no fallback', async () => {
    const server = await scriptedProxy({
      method: 0x00,
      reply: reply(0x00, 0x00, 0x01, 1, 1, 1, 1, 0, 0),
    });
    await expect(
      socks5Request(
        server.proxy,
        { command: 'resolve', name: 'example.com' },
        { credentials: { username: 'u', password: 'pw' } }
      )
    ).rejects.toThrow('refused the authentication method');
    // Nothing but the greeting was sent.
    expect(server.seen).toHaveLength(1);
  });

  test('a method selection in another version fails the request, before it is sent', async () => {
    const server = await scriptedProxy({
      methodVersion: 0x04,
      reply: reply(0x00, 0x00, 0x01, 8, 8, 4, 4, 0, 0),
    });
    await expect(
      socks5Request(server.proxy, { command: 'resolve', name: 'example.com' })
    ).rejects.toThrow('method selection is outside the protocol');
    expect(server.seen).toHaveLength(1);
  });

  test('an RFC 1929 reply in another version fails the request, before it is sent', async () => {
    const server = await scriptedProxy({
      method: 0x02,
      authVersion: 0x05,
      reply: reply(0x00, 0x00, 0x01, 8, 8, 4, 4, 0, 0),
    });
    await expect(
      socks5Request(
        server.proxy,
        { command: 'resolve', name: 'example.com' },
        { credentials: { username: 'u', password: 'pw' } }
      )
    ).rejects.toThrow('RFC 1929 reply is outside the protocol');
    // The greeting and the credentials, no request.
    expect(server.seen).toHaveLength(2);
  });

  test('refused credentials fail the request', async () => {
    const server = await scriptedProxy({ method: 0x02, authStatus: 0x01, reply: reply() });
    await expect(
      socks5Request(
        server.proxy,
        { command: 'resolve', name: 'example.com' },
        { credentials: { username: 'u', password: 'pw' } }
      )
    ).rejects.toThrow('refused the credentials');
  });

  test('a CONNECT carries the IP literal it is given', async () => {
    const server = await scriptedProxy({ reply: reply(0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0) });
    await socks5Request(server.proxy, { command: 'connect', ip: '2001:db8::1', port: 443 });
    expect(server.seen[1]).toEqual(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x04, 0x20, 0x01, 0x0d, 0xb8]),
        Buffer.alloc(11),
        Buffer.from([1, 0x01, 0xbb]),
      ])
    );
  });

  test('a reply code is reported, not thrown', async () => {
    const server = await scriptedProxy({ reply: reply(0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0) });
    const result = await socks5Request(server.proxy, {
      command: 'resolve',
      name: 'nowhere.example',
    });
    expect(result.code).toBe(4);
  });

  test('only one IPv4 or IPv6 address is a usable answer', () => {
    expect(isUsableAnswer({ ip: '93.184.215.14' })).toBe(true);
    expect(isUsableAnswer({ ip: '2606:2800:21f:cb07:6820:80da:af6b:8b2c' })).toBe(true);
    for (const answer of [
      { ip: '0.0.0.0' },
      { ip: '0:0:0:0:0:0:0:0' },
      { name: 'a.example' },
      null,
    ]) {
      expect(isUsableAnswer(answer)).toBe(false);
    }
  });

  test('replies outside the protocol are refused; partial ones wait', () => {
    expect(parseReply(Buffer.from([0x05, 0x00, 0x00]))).toBeNull();
    expect(parseReply(Buffer.from([0x05, 0x00, 0x00, 0x01, 1, 2]))).toBeNull();
    expect(() => parseReply(Buffer.from([0x04, 0x00, 0x00, 0x01]))).toThrow('outside the protocol');
    expect(() => parseReply(Buffer.from([0x05, 0x00, 0x01, 0x01]))).toThrow('outside the protocol');
    expect(() => parseReply(Buffer.from([0x05, 0x00, 0x00, 0x09]))).toThrow('unknown address type');
    expect(parseReply(Buffer.from([0x05, 0x00, 0x00, 0x03, 1, 0x61, 0, 0]))).toEqual({
      code: 0,
      address: { name: 'a' },
      length: 8,
    });
  });

  test('an IPv6 literal ending in dotted IPv4 is encoded byte for byte', () => {
    const head = Buffer.from([0x05, 0x01, 0x00, 0x04]);
    const port = Buffer.from([0x01, 0xbb]);
    const mapped = Buffer.concat([
      head,
      Buffer.alloc(10),
      Buffer.from([0xff, 0xff, 0xc0, 0x00, 0x02, 0x01]),
      port,
    ]);
    expect(request(0x01, { ip: '::ffff:192.0.2.1', port: 443 })).toEqual(mapped);
    expect(request(0x01, { ip: '0:0:0:0:0:ffff:192.0.2.1', port: 443 })).toEqual(mapped);
    expect(request(0x01, { ip: '64:ff9b::198.51.100.7', port: 443 })).toEqual(
      Buffer.concat([
        head,
        Buffer.from([0x00, 0x64, 0xff, 0x9b]),
        Buffer.alloc(8),
        Buffer.from([198, 51, 100, 7]),
        port,
      ])
    );
    expect(() => request(0x01, { ip: 'fe80::1%eth0', port: 443 })).toThrow('zone');
  });

  test('requests, greetings and credentials are bounded and well formed', () => {
    expect(greeting(null)).toEqual(Buffer.from([0x05, 0x01, 0x00]));
    expect(greeting({ username: 'u', password: 'p' })).toEqual(Buffer.from([0x05, 0x01, 0x02]));
    expect(() => request(0xf0, { name: '' })).toThrow();
    expect(() => request(0xf0, { name: 'a'.repeat(256) })).toThrow();
    expect(() => authentication({ username: '', password: 'p' })).toThrow();
    expect(request(0x01, { ip: '127.0.0.1', port: 9050 })).toEqual(
      Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x23, 0x5a])
    );
  });
});
