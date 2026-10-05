// Worker-thread side of web3:// document decoding (#503 item 9). Runs
// `decodeHtmlDocument` (hex check, ABI decode, keccak) for the protocol
// handler, so a multi-MB onchain app no longer stalls the main thread; see
// `onchain-html.js` and `task-worker-host.js`.
const { isMainThread, parentPort } = require('node:worker_threads');
const { decodeHtmlDocument } = require('./onchain-html');

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (message?.op !== 'decode') return;
    try {
      parentPort.postMessage({
        id: message.id,
        ok: true,
        result: decodeHtmlDocument(message.result),
      });
    } catch (err) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        code: typeof err?.code === 'string' ? err.code : undefined,
        error: String(err?.message || err).slice(0, 500),
      });
    }
  });
}
