// Test only (page-budgets.spec.js): stands in for a compromised renderer,
// which can send `page:request` itself, past the app's preload and its size
// walk (freedom-core design 0011, PRQ-2). In a top frame of the session it
// is registered on, it waits for main to ask (`page-budgets-test:forge`,
// sent to that frame), builds the request main describes, sends it, and
// reports what came back on a test channel the spec reads from the guest's
// own `ipc-message` event. It doesn't know the document's nonce, so a
// request the walk lets through is then refused by the attestation.
const { ipcRenderer } = require('electron');

function build(spec) {
  if (spec.kind === 'string') return { data: 'x'.repeat(spec.length) };
  if (spec.kind === 'bigint') return { data: 1n << BigInt(spec.shift) };
  return {};
}

if (globalThis.top === globalThis) {
  ipcRenderer.on('page-budgets-test:forge', (_event, spec) => {
    const request = { nonce: '0'.repeat(32), provider: 'swarm', method: spec.method, params: build(spec) };
    ipcRenderer.invoke('page:request', request).then(
      (answer) => ipcRenderer.send('page-budgets-test:forged', { id: spec.id, answer }),
      (err) => ipcRenderer.send('page-budgets-test:forged', { id: spec.id, rejected: String(err && err.message) })
    );
  });
}
