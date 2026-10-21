'use strict';

// Run with Electron. All network targets are listeners owned by this fixture.
const { app, BrowserWindow, protocol, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { PREVIEW_CSP } = require('../src/main/agent/workspace-preview-controller');
const { isolatePreviewNetwork } = require('../src/main/agent/workspace-preview-network');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-preview-network-')));
protocol.registerSchemesAsPrivileged([{ scheme: 'freedom-preview', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const deadline = setTimeout(() => app.exit(2), 20000);
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let udpPackets = 0, tcpConnections = 0;
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => udpPackets++);
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const tcp = net.createServer(socket => { tcpConnections++; socket.destroy(); });
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const check = async isolated => {
    udpPackets = 0; tcpConnections = 0;
    const target = session.fromPartition(`preview-network-${isolated}-${process.pid}`);
    target.protocol.handle('freedom-preview', () => new Response('<!doctype html><h1>Owned preview</h1>',
      { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': PREVIEW_CSP } }));
    const boundary = isolated ? await isolatePreviewNetwork(target) : null;
    const window = new BrowserWindow({ show: false, webPreferences: { session: target, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    // No preload hides constructors in this test: measure the network boundary
    // itself, including what a fresh child realm could otherwise access.
    window.webContents.setWebRTCIPHandlingPolicy(isolated ? 'disable_non_proxied_udp' : 'default');
    try {
      await window.loadURL(`freedom-preview://${'a'.repeat(40)}/index.html`);
      await window.webContents.executeJavaScript(`(async () => {
        const peer = new RTCPeerConnection({ iceTransportPolicy: 'relay', iceServers: [
          { urls: 'turn:127.0.0.1:${udp.address().port}?transport=udp', username: 'fixture', credential: 'fixture' },
          { urls: 'turn:127.0.0.1:${tcp.address().port}?transport=tcp', username: 'fixture', credential: 'fixture' }
        ] });
        peer.createDataChannel('fixture');
        await peer.setLocalDescription(await peer.createOffer());
        await new Promise(resolve => setTimeout(resolve, 2000));
        peer.close();
      })()`);
      return { udpPackets, tcpConnections };
    } finally { window.destroy(); await boundary?.dispose(); }
  };
  try {
    const control = await check(false);
    assert(control.udpPackets > 0 && control.tcpConnections > 0, 'Both owned listeners must observe the control');
    const isolated = await check(true);
    assert.equal(isolated.udpPackets, 0);
    assert.equal(isolated.tcpConnections, 0);
    console.log(JSON.stringify({ control, isolated, result: 'Preview WebRTC network boundary passed' }));
  } finally {
    udp.close(); await new Promise(resolve => tcp.close(resolve));
    clearTimeout(deadline); app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
