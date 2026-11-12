// Test only (page-requests.spec.js): stands in for a compromised renderer,
// which holds `ipcRenderer` and can call `page:request` itself, past the
// app's preload (freedom-core design 0011, PRQ-2). In every frame of the
// session it is registered on, once the document has loaded, it sends one
// request with a nonce of its own making, and reports what came back on a
// test channel the spec reads from the guest's own `ipc-message` event (the
// IPC sender policy has no tier for it, and nothing in the app handles it).
const { ipcRenderer } = require('electron');

const top = globalThis.top === globalThis;
const href = globalThis.location.href;
const report = (outcome) => ipcRenderer.send('page-requests-test:forged', { top, href, outcome });

globalThis.addEventListener('DOMContentLoaded', () => {
  ipcRenderer
    .invoke('page:request', {
      nonce: '0'.repeat(32),
      provider: 'swarm',
      method: 'swarm_readChunk',
      params: { tag: 'forged' },
    })
    .then(
      (answer) => report({ answer }),
      (err) => report({ rejected: String(err && err.message) })
    );
});
