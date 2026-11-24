'use strict';

const net = require('node:net');
const PREVIEW_PARTITION = 'freedom-workspace-preview';

// Chromium's HTTP restrictions do not cover WebRTC. A separate, ephemeral
// session sends all proxy-capable traffic to a local endpoint that only closes
// connections. Combined with disable_non_proxied_udp, this also covers TURN/TCP
// without giving preview pages another realm or API they can use to opt out.
async function isolatePreviewNetwork(targetSession) {
  targetSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setDevicePermissionHandler(() => false);
  targetSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  targetSession.on('will-download', event => event.preventDefault());
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  try {
    await targetSession.setProxy({ mode: 'fixed_servers',
      proxyRules: `127.0.0.1:${server.address().port}`, proxyBypassRules: 'freedom-preview://*;<-loopback>' });
    await targetSession.closeAllConnections();
  } catch (error) {
    server.close();
    throw error;
  }
  return { dispose: () => new Promise(resolve => server.close(resolve)) };
}

module.exports = { PREVIEW_PARTITION, isolatePreviewNetwork };
