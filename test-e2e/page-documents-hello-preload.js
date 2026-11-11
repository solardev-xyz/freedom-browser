// Test only (page-documents.spec.js): a session preload that stands in for
// the `page:hello` PRQ-2 of freedom-core design 0011 adds to
// webview-preload.js. Like that hello it makes 16 random bytes and sends them
// to main as soon as the document's preload runs, before any page script.
// It then sends one request with the same nonce once the document has
// loaded. Both go out on test channels that only the spec listens to, on the
// guest's own `ipc-message` event: the IPC sender policy has no tier for them,
// and nothing in the app handles them.
const { ipcRenderer } = require('electron');

const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const top = globalThis.top === globalThis;
const href = globalThis.location.href;

ipcRenderer.send('page-documents-test:hello', { nonce, href, top });
globalThis.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('page-documents-test:request', { nonce, href, top });
});
