/**
 * In-test MQTT-over-WebSocket broker — the local stand-in for a public
 * openlv signaling relay, shared by the jest protocol integration test
 * and the Playwright remote-signing E2E. Carries only ciphertext frames
 * either way; `aedes` is returned so tests can spy on them.
 */

const http = require('http');

// How long close() waits for connected clients to finish disconnecting.
const DRAIN_MS = 2000;

async function startLocalMqttBroker() {
  // aedes 1.x removed the callable default export and made startup async
  // (its persistence interface is promise-based now), so the broker has
  // to be awaited before the first connection is handed to it.
  const { Aedes } = require('aedes');
  const aedes = await Aedes.createBroker();
  const { WebSocketServer, createWebSocketStream } = require('ws');

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    aedes.handle(createWebSocketStream(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    aedes,
    url: `ws://127.0.0.1:${server.address().port}/mqtt`,
    close: async () => {
      // Let clients that are already disconnecting finish first. The openlv
      // client's close() sends DISCONNECT and starts the WebSocket close
      // handshake without waiting for it; shutting the server down in that
      // window errors the client's socket, and websocket-mqtt `console.error`s
      // the event — after the test that owned it has finished. Under
      // `jest --runInBand` that lands in the *next* suite as "Cannot log after
      // tests are done" and exits jest 1 with every test passed, so whether CI
      // went red depended on which suite jest happened to schedule next
      // (#535). Bounded: a client that never leaves is cut off as before.
      const deadline = Date.now() + DRAIN_MS;
      while (wss.clients.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => aedes.close(resolve));
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startLocalMqttBroker };
