/**
 * In-test MQTT-over-WebSocket broker — the local stand-in for a public
 * openlv signaling relay, shared by the jest protocol integration test
 * and the Playwright remote-signing E2E. Carries only ciphertext frames
 * either way; `aedes` is returned so tests can spy on them.
 */

const http = require('http');

async function startLocalMqttBroker() {
  const aedes = require('aedes')();
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
      await new Promise((resolve) => aedes.close(resolve));
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startLocalMqttBroker };
