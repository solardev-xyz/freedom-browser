const net = require('net');
const { once } = require('events');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

// Controlled SOCKS peer. It records credentials and names, then forwards only
// to the test server's loopback port, without resolving the supplied name.
async function proxy(targetPort, behavior = 'normal') {
  const sockets = new Set();
  const records = [];
  let greeted;
  const greeting = new Promise((resolve) => {
    greeted = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let data = Buffer.alloc(0);
    let phase = 0;
    const record = { id: records.length };
    records.push(record);
    function receive(chunk) {
      data = Buffer.concat([data, chunk]);
      if (phase === 0 && data.length >= 3) {
        record.greeting = [...data.subarray(0, 3)];
        greeted();
        data = data.subarray(3);
        phase = 1;
        if (behavior === 'stall') return;
        if (behavior === 'downgrade') {
          socket.write(Buffer.from([5, 0]));
          return;
        }
        socket.write(Buffer.from([5]));
        setImmediate(() => {
          if (!socket.destroyed) socket.write(Buffer.from([2]));
        });
      }
      if (phase === 1 && data.length >= 2) {
        const userEnd = 2 + data[1];
        if (data.length <= userEnd || data.length < userEnd + 1 + data[userEnd]) return;
        record.user = data.subarray(2, userEnd).toString();
        record.token = data.subarray(userEnd + 1, userEnd + 1 + data[userEnd]).toString();
        data = data.subarray(userEnd + 1 + data[userEnd]);
        phase = 2;
        socket.write(Buffer.from([1, behavior === 'auth-failure' ? 1 : 0]));
      }
      if (phase === 2 && data.length >= 5 && data.length >= 7 + data[4]) {
        record.addressType = data[3];
        record.hostname = data.subarray(5, 5 + data[4]).toString();
        record.port = data.readUInt16BE(5 + data[4]);
        phase = 3;
        if (behavior === 'bad-reply') {
          socket.write(Buffer.from([5, 0, 1, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const upstream = net.connect(targetPort, '127.0.0.1');
        sockets.add(upstream);
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        socket.on('close', () => upstream.destroy());
        upstream.once('connect', () => {
          socket.removeListener('data', receive);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
          socket.pipe(upstream).pipe(socket);
        });
      }
    }
    socket.on('data', receive);
  });
  const port = await listen(server);
  const controller = new AbortController();
  return {
    records,
    sockets,
    controller,
    greeting,
    endpoint: Object.freeze({ host: '127.0.0.1', port, generation: 1, signal: controller.signal }),
    async close() {
      controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { listen, proxy };
