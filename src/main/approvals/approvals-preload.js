// The approvals document's preload (freedom-core design 0011, "The approvals
// document"; APS-1). Sandboxed and isolated: the document gets these few
// calls and nothing else. Main accepts them only from the window's own view,
// its main frame, on the packaged file (approvals-document.js).
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  if (typeof callback !== 'function') return;
  ipcRenderer.on(channel, (_event, message) => callback(message));
};

contextBridge.exposeInMainWorld(
  'approvals',
  Object.freeze({
    onPrompt: listen('page:prompt'),
    onHidden: listen('page:prompt-hidden'),
    onClosed: listen('page:prompt-closed'),
    onMoved: listen('approvals:moved'),
    onTheme: listen('approvals:theme'),
    ready: () => ipcRenderer.send('approvals:ready'),
    shown: (handle, revision) => ipcRenderer.send('approvals:shown', { handle, revision }),
    decide: (handle, approve, choices) => ipcRenderer.invoke('approvals:decide', { handle, approve, choices }),
    // A part of a view over 256 KiB (APS-4), for the prompt main shows.
    viewPart: (handle, revision, index) => ipcRenderer.invoke('approvals:view-part', { handle, revision, index }),
    // The hash-only warning in a Ledger's waiting state (freedom-core design
    // 0016, Q23; LDG-3's PR 11), and its report once it is on screen.
    onHashOnly: listen('approvals:hash-only'),
    hashOnlyShown: (handle, warning) => ipcRenderer.send('approvals:hash-only-shown', { handle, warning }),
  })
);
