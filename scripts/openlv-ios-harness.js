#!/usr/bin/env node
/**
 * Cross-stack test host for the freedom-mobile (iOS) openlv wallet
 * endpoint. Plays the "freedom desktop" role over the real openlv
 * stack: a local MQTT broker for signaling plus a headless Chromium
 * page running the same vendored `openlv.esm.js` the renderer uses
 * (Node has no WebRTC, so the host session lives in a browser context,
 * exactly like the remote-signing E2E).
 *
 * The iOS simulator shares the Mac's loopback, so the XCTest suite
 * reaches both the control endpoints and the broker at 127.0.0.1.
 *
 * Control surface (http://127.0.0.1:8798):
 *   GET /uri    → {uri}   — openlv:// URI of the current host session
 *   GET /state  → {phase, uri, exchanges: [{method, response}], error}
 *   GET /reset  → reloads the host page, starting a fresh session
 *                 (each XCTest consumes one session; call this first)
 *
 * Once the wallet endpoint links up, the host sends the same sequence a
 * desktop signing job produces — eth_requestAccounts, the
 * wallet_switchEthereumChain pre-flight, then personal_sign against the
 * connected account — and records every response for the XCTest to
 * assert on.
 *
 * Run from the repo root: `npm run openlv:ios-harness`
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { startLocalMqttBroker } = require('../test/helpers/local-mqtt-broker');
const { WEBRTC_LOCAL_SWITCH } = require('../test/helpers/webrtc');

const PORT = Number(process.env.OPENLV_HARNESS_PORT) || 8798;

const MESSAGE = 'freedom openlv ios harness';

function buildHostPage(signalingUrl) {
  return `<!doctype html>
<html><body><script type="module">
import { createSession, encodeConnectionURL, mqtt, webrtc } from '/openlv.esm.js';

const report = (update) => window.__report(JSON.stringify(update));
const toHex = (text) =>
  '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('');

try {
  // The phone must never initiate requests toward the browser; answer
  // like the desktop broker does so SDK peers get an error, not a hang.
  const onIncoming = async () => ({ error: { code: -32601, message: 'Method not found' } });

  const session = await createSession(
    { p: 'mqtt', s: ${JSON.stringify(signalingUrl)} },
    mqtt,
    [webrtc()],
    onIncoming,
  );
  report({ phase: 'qr', uri: encodeConnectionURL(session.getHandshakeParameters()) });

  session.emitter.on('state_change', (state) => {
    if (state?.status) report({ phase: state.status });
  });

  await session.connect();
  await session.waitForLink();
  report({ phase: 'linked' });

  const exchange = async (method, params) => {
    const response = await session.send({ method, params });
    report({ exchange: { method, response } });
    return response;
  };

  const accounts = await exchange('eth_requestAccounts', []);
  const account = accounts?.result?.[0];
  await exchange('wallet_switchEthereumChain', [{ chainId: '0x64' }]);

  // ?mode=tx: the desktop signing-job shape for a transaction — the
  // wallet endpoint picks nonce/gas, signs, and broadcasts itself
  // (against a local anvil in the E2E). Default mode signs a message.
  if (new URLSearchParams(location.search).get('mode') === 'tx') {
    await exchange('eth_sendTransaction', [{
      from: account,
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      value: '0x2386f26fc10000',
      chainId: '0x64',
    }]);
  } else {
    await exchange('personal_sign', [toHex(${JSON.stringify(MESSAGE)}), account]);
  }

  report({ phase: 'done' });
} catch (err) {
  report({ phase: 'error', error: err?.message || String(err) });
}
</script></body></html>`;
}

async function main() {
  const broker = await startLocalMqttBroker();
  let state;
  const resetState = () => {
    state = { phase: 'starting', uri: null, exchanges: [], error: null };
  };
  resetState();
  let page = null;

  const esmBundle = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'openlv.esm.js')
  );
  const hostPage = buildHostPage(broker.url);

  const server = http.createServer((req, res) => {
    const respond = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    switch (url.pathname) {
      case '/uri':
        return respond(200, 'application/json', JSON.stringify({ uri: state.uri }));
      case '/state':
        return respond(200, 'application/json', JSON.stringify(state));
      // /reset[?mode=tx] — fresh host session; mode picks the request
      // sequence the host sends (default: personal_sign; tx: broadcast).
      case '/reset': {
        if (!page) return respond(503, 'text/plain', 'host page not up yet');
        const mode = url.searchParams.get('mode');
        resetState();
        page
          .goto(`http://127.0.0.1:${PORT}/${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`)
          .then(() => respond(200, 'application/json', '{"ok":true}'))
          .catch((err) => respond(500, 'text/plain', String(err)));
        return undefined;
      }
      case '/':
        return respond(200, 'text/html', hostPage);
      case '/openlv.esm.js':
        return respond(200, 'text/javascript', esmBundle);
      default:
        return respond(404, 'text/plain', 'not found');
    }
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  // Raw loopback ICE candidates instead of mDNS names, so the WebKit
  // peer can pair against them.
  const browser = await chromium.launch({ args: [WEBRTC_LOCAL_SWITCH] });
  page = await browser.newPage();
  page.on('console', (message) => console.log('[host page]', message.text()));
  await page.exposeFunction('__report', (updateJson) => {
    const update = JSON.parse(updateJson);
    if (update.exchange) {
      state.exchanges.push(update.exchange);
    } else {
      Object.assign(state, update);
    }
    console.log('[harness]', updateJson.slice(0, 300));
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  console.log(`[harness] control surface at http://127.0.0.1:${PORT} (uri, state)`);
  console.log(`[harness] signaling broker at ${broker.url}`);

  const shutdown = async () => {
    await browser.close().catch(() => {});
    await broker.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[harness] failed to start:', err);
  process.exit(1);
});
