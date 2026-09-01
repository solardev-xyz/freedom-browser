'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const REQUEST_CHANNEL = 'agent:pdf-processor:request';
const RESULT_CHANNEL = 'agent:pdf-processor:result';

contextBridge.exposeInMainWorld('freedomPdfProcessor', {
  onRequest(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.once(REQUEST_CHANNEL, (_event, request) => callback(request));
  },
  respond(result) {
    ipcRenderer.send(RESULT_CHANNEL, result);
  },
});

