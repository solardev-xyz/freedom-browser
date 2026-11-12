// Test only (page-connect.spec.js): stands in for a compromised page
// renderer, which can send the prompt channels itself (freedom-core design
// 0011, PRQ-4). In a top frame of the session it is registered on, it waits
// for main to ask (`page-connect-test:forge`, sent to that frame), reports
// its own tab in front and approves the handle main names, and reports what
// came back on a test channel the spec reads from the guest's own
// `ipc-message` event. The sender policy gives a page neither channel.
const { ipcRenderer } = require('electron');

if (globalThis.top === globalThis) {
  ipcRenderer.on('page-connect-test:forge', (_event, spec) => {
    ipcRenderer.send('page:foreground', { guest: spec.guest });
    ipcRenderer.invoke('page:decide', { handle: spec.handle, approve: true, choices: { walletIndex: 0 } }).then(
      (answer) => ipcRenderer.send('page-connect-test:forged', { answer }),
      (err) => ipcRenderer.send('page-connect-test:forged', { rejected: String(err && err.message) })
    );
  });
}
