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
    shown: (handle) => ipcRenderer.send('approvals:shown', { handle }),
    decide: (handle, approve, choices) => ipcRenderer.invoke('approvals:decide', { handle, approve, choices }),
  })
);
