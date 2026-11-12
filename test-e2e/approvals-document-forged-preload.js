// Test only (approvals-document.spec.js): stands in for a compromised page
// renderer that sends the approvals document's channels itself (freedom-core
// design 0011, APS-1). In a top frame of the session it is registered on, it
// waits for main to ask (`approvals-test:forge`, sent to that frame), reports
// the handle and revision main names as shown and approves it, and reports
// what came back on a test channel the spec reads from the guest's own
// `ipc-message` event.
// The sender policy gives a page neither channel.
const { ipcRenderer } = require('electron');

if (globalThis.top === globalThis) {
  ipcRenderer.on('approvals-test:forge', (_event, spec) => {
    ipcRenderer.send('approvals:shown', { handle: spec.handle, revision: spec.revision });
    ipcRenderer.invoke('approvals:decide', { handle: spec.handle, approve: true }).then(
      (answer) => ipcRenderer.send('approvals-test:forged', { answer }),
      (err) => ipcRenderer.send('approvals-test:forged', { rejected: String(err && err.message) })
    );
  });
}
