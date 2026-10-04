// Worker-thread side of GSOC signer mining (#503). bee-js's gsocMine is a
// synchronous loop of pure-JS secp256k1 key derivations — 16-930 ms per
// proximity-12 topic across 12 topics measured on Electron's main thread
// (#504), where it froze every window; a topic whose search runs to bee-js's
// 0xffff-key cap takes ~5 s before it gives up. The main process sends one
// job at a time (`gsoc-miner.js`) and can stop a runaway one with
// `worker.terminate()`.
//
// The mining itself is bee-js's own `messaging.gsocMine`, called with exactly
// the inputs the main thread used to pass, so a topic still mines to the same
// signer. bee-js's gsocMine never touches the Bee instance's network context;
// the URL below is only there to construct one.
const { isMainThread, parentPort } = require('node:worker_threads');

let bee = null;

function mine({ targetOverlay, identifier, proximity }) {
  if (!bee) {
    const { Bee } = require('@ethersphere/bee-js');
    bee = new Bee('http://127.0.0.1:1633');
  }
  const signer = bee.messaging.gsocMine(
    Uint8Array.from(targetOverlay),
    Uint8Array.from(identifier),
    proximity
  );
  return signer.toHex();
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (message?.type !== 'mine') return;
    try {
      parentPort.postMessage({ type: 'result', id: message.id, ok: true, signer: mine(message) });
    } catch (err) {
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        ok: false,
        error: String(err?.message || err).slice(0, 500),
      });
    }
  });
}

module.exports = { mine };
