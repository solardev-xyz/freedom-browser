'use strict';

const vm = require('vm');
const { TextEncoder } = require('util');
const { previewSocketScript } = require('./workspace-preview-client');

describe('preview browser WebSocket adapter', () => {
  let window, calls, poll;
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  beforeEach(() => {
    calls = [];
    window = {
      URL, TextEncoder, EventTarget, Event, MessageEvent, DOMException, Blob, ArrayBuffer, Uint8Array, AbortSignal,
      reportError: jest.fn(), setTimeout: (callback) => { callback(); },
      CloseEvent: class extends Event { constructor(type, values) { super(type); Object.assign(this, values); } },
      location: new URL('https://preview.test/'), setInterval: jest.fn(), clearInterval: jest.fn(),
      addEventListener: jest.fn(), atob, btoa,
    };
    window.window = window;
    window.fetch = jest.fn(async (url, options) => {
      const input = JSON.parse(options.body); calls.push(input);
      if (input.action === 'poll') return new Promise(resolve => {
        poll = events => resolve({ ok: true, json: async () => ({ events }) });
      });
      return { ok: true, json: async () => input.action === 'open' ? { id: 'socket' } : { ok: true } };
    });
    vm.runInNewContext(previewSocketScript('key', 5173, 'process-one'), window);
  });

  test('supports the HMR connection/event/send/close lifecycle without direct localhost access', async () => {
    const socket = new window.WebSocket('ws://preview.test/?token=vite', 'vite-hmr');
    const opened = jest.fn(), message = jest.fn(), closed = jest.fn();
    socket.addEventListener('open', opened); socket.onmessage = message; socket.onclose = closed;
    expect(() => socket.send('too early')).toThrow();
    await flush(); poll([{ type: 'open', protocol: 'vite-hmr' }]); await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(window.WebSocket.OPEN);
    expect(socket.protocol).toBe('vite-hmr');
    poll([{ type: 'message', binary: false, data: '{"type":"update"}' }]); await flush();
    expect(message.mock.calls[0][0].data).toBe('{"type":"update"}');
    socket.send('ping'); await flush();
    expect(calls).toContainEqual({ action: 'send', key: 'key', id: 'socket', binary: false, data: 'ping' });
    expect(socket.bufferedAmount).toBe(0);
    socket.close(); await flush();
    poll([{ type: 'close', code: 1000, reason: '', wasClean: true }]); await flush();
    expect(closed).toHaveBeenCalledTimes(1); expect(socket.readyState).toBe(window.WebSocket.CLOSED);
    expect(window.fetch.mock.calls.every(([url]) => url === '/.freedom-preview/socket')).toBe(true);
    expect(window.fetch.mock.calls.every(([, options]) => options.credentials === 'omit')).toBe(true);
  });

  test('denies unrelated hosts/ports and invalid protocols before any request', () => {
    for (const url of ['ws://example.com', 'ws://127.0.0.1:4000/', 'ws://user@preview.test/']) {
      expect(() => new window.WebSocket(url)).toThrow();
    }
    expect(() => new window.WebSocket('ws://preview.test/', ['vite-hmr', 'vite-hmr'])).toThrow();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('copies sent binary data and isolates application handler errors from the connection', async () => {
    const socket = new window.WebSocket('ws://preview.test/');
    socket.onopen = () => { throw new Error('Application handler'); };
    await flush(); poll([{ type: 'open', protocol: '' }]); await flush();
    expect(window.reportError).toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
    const data = new Uint8Array([0, 255]); socket.send(data); data[1] = 0;
    await flush();
    expect(calls).toContainEqual(expect.objectContaining({ action: 'send', binary: true, data: 'AP8=' }));
  });

  test('retries only pre-admission busy refusals, never ambiguous send failures', async () => {
    const socket = new window.WebSocket('ws://preview.test/');
    await flush(); poll([{ type: 'open', protocol: '' }]); await flush();
    window.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    socket.send('once'); await flush();
    expect(calls.filter(call => call.action === 'send')).toHaveLength(1);
    expect(socket.readyState).toBe(1);
    window.fetch.mockRejectedValueOnce(new Error('Lost response'));
    socket.send('uncertain'); await flush();
    expect(calls.filter(call => call.action === 'send')).toHaveLength(1);
    expect(socket.readyState).toBe(3);
  });
});
