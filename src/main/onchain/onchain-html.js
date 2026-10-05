// Decoding and hashing of an ERC-8244 `html()` result (#503 item 9).
//
// Pure and dependency-light (ethers only) so the same code runs in
// `onchain-html-worker.js` — where the protocol handler sends it, since an
// 8 MiB document takes ~0.7 s of synchronous regex + ABI decode + pure-JS
// keccak on Electron's Node — and on the main thread only as the fallback
// when that worker cannot run.
const { ethers } = require('ethers');

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const HTML_RESULT_INTERFACE = new ethers.Interface(['function html() view returns (string)']);

function tooLarge() {
  const error = new Error("html() response exceeds Freedom's 8 MiB limit");
  error.code = 'ONCHAIN_APP_TOO_LARGE';
  return error;
}

// Throws ONCHAIN_APP_TOO_LARGE for a hex result too long to hold an 8 MiB
// document. O(1): reads only the length.
function assertHtmlResultSize(result) {
  if (typeof result !== 'string') return;
  const encodedBytes = (result.length - 2) / 2;
  // ABI adds an offset, a length word, and up to 31 bytes of padding.
  if (encodedBytes > MAX_HTML_BYTES + 95) throw tooLarge();
}

function decodeHtmlResult(result) {
  if (typeof result !== 'string' || !/^0x[0-9a-f]*$/i.test(result)) {
    throw new Error('html() returned malformed ABI data');
  }
  assertHtmlResultSize(result);

  const [html] = HTML_RESULT_INTERFACE.decodeFunctionResult('html', result);
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength > MAX_HTML_BYTES) throw tooLarge();
  return html;
}

function hashHtml(html) {
  return ethers.keccak256(ethers.toUtf8Bytes(html));
}

/** `{ html, htmlHash }` for an `html()` eth_call result; throws as decodeHtmlResult. */
function decodeHtmlDocument(result) {
  const html = decodeHtmlResult(result);
  return { html, htmlHash: hashHtml(html) };
}

module.exports = {
  MAX_HTML_BYTES,
  assertHtmlResultSize,
  decodeHtmlDocument,
  decodeHtmlResult,
  hashHtml,
};
