// Test only (page-events.spec.js): reports every `page:event` that reaches
// a frame, in every frame of the session it is registered on, sub-frames
// included, so the spec can tell which frames main sent an event to
// (freedom-core design 0011, PRQ-6). It reports on a test channel the spec
// reads from the guest's own `ipc-message` event (the IPC sender policy has
// no tier for it, and nothing in the app handles it). It reports whether the
// event carried a nonce, never the nonce itself.
const { ipcRenderer } = require('electron');

const top = globalThis.top === globalThis;

ipcRenderer.on('page:event', (_event, message) => {
  ipcRenderer.send('page-events-test:heard', {
    top,
    href: globalThis.location.href,
    provider: message && message.provider,
    event: message && message.event,
    data: message && message.data,
    nonce: typeof (message && message.nonce) === 'string',
  });
});
