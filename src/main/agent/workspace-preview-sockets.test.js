'use strict';

const { EventEmitter } = require('events');
const { WorkspacePreviewSockets, socketTarget } = require('./workspace-preview-sockets');

describe('preview WebSocket authority and lifecycle', () => {
  let bridge, socket, preview, live, connect;
  beforeEach(() => {
    jest.useFakeTimers();
    live = true;
    preview = { port: 5173, socketKey: 'key' };
    socket = new EventEmitter();
    Object.assign(socket, { readyState: 1, bufferedAmount: 0, protocol: 'vite-hmr',
      terminate: jest.fn(), close: jest.fn(), send: jest.fn((_data, _options, callback) => callback()) });
    connect = jest.fn(() => socket);
    bridge = new WorkspacePreviewSockets({ isLive: () => live, connect });
  });
  afterEach(() => { bridge.dispose(); jest.useRealTimers(); });
  const open = () => bridge.request(preview, 'a'.repeat(40), {
    key: 'key', action: 'open', url: `ws://${'a'.repeat(40)}/?token=vite`, protocols: ['vite-hmr'],
  });
  const request = (id, action, fields = {}) => bridge.request(preview, 'a'.repeat(40), { key: 'key', id, action, ...fields });

  test('pins upstream port, negotiates HMR, forwards text/binary, and strips ambient credentials', async () => {
    const { id } = await open();
    expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:5173/?token=vite', ['vite-hmr'], expect.objectContaining({
      origin: 'http://127.0.0.1:5173', followRedirects: false, perMessageDeflate: false, maxPayload: 1048576,
    }));
    expect(connect.mock.calls[0][2].headers).toBeUndefined();
    socket.emit('open'); socket.emit('message', Buffer.from('{"type":"update"}'), false);
    socket.emit('message', Buffer.from([0, 255]), true);
    expect((await request(id, 'poll')).events).toEqual([
      { type: 'open', protocol: 'vite-hmr' },
      { type: 'message', binary: false, data: '{"type":"update"}' },
      { type: 'message', binary: true, data: 'AP8=' },
    ]);
    await request(id, 'send', { data: 'hello', binary: false });
    expect(socket.send).toHaveBeenCalledWith(Buffer.from('hello'), { binary: false }, expect.any(Function));
  });

  test('rejects external destinations, credentials, fragments, other ports and foreign socket IDs', async () => {
    for (const url of ['ws://example.org/', 'ws://localhost:9999/', 'ws://u:p@127.0.0.1:5173/', 'ws://127.0.0.1:5173/#x']) {
      expect(() => socketTarget(url, 'preview', 5173)).toThrow();
    }
    const { id } = await open();
    await expect(bridge.request({ ...preview }, 'preview', { key: 'key', id, action: 'poll' })).rejects.toThrow();
    await expect(request(id, 'send', { key: 'wrong', data: 'x', binary: false })).rejects.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
  });

  test('wakes one pending poll and refuses duplicate polls', async () => {
    const { id } = await open();
    const pending = request(id, 'poll');
    await expect(request(id, 'poll')).rejects.toThrow();
    socket.emit('message', Buffer.from('changed'), false);
    expect(await pending).toEqual({ events: [{ type: 'message', binary: false, data: 'changed' }] });
  });

  test('revokes open sockets and pending polls when the process ends', async () => {
    const { id } = await open();
    const pending = request(id, 'poll');
    const rejected = expect(pending).rejects.toThrow('stopped');
    live = false; jest.advanceTimersByTime(1000);
    await rejected;
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(bridge.entries.size).toBe(0);
  });

  test('bounds sockets, queued messages, abandoned pages, and close parameters', async () => {
    const { id } = await open();
    await expect(request(id, 'close', { code: 1006, reason: '' })).rejects.toThrow();
    for (let i = 0; i < 129; i++) socket.emit('message', Buffer.from('x'), false);
    expect(socket.terminate).toHaveBeenCalled();
    expect((await request(id, 'poll')).events[0]).toMatchObject({ type: 'close', code: 1009 });
    await open(); await open(); await open(); await open();
    await expect(open()).rejects.toThrow('limit');
    jest.advanceTimersByTime(31000);
    expect(bridge.entries.size).toBe(0);
  });

  test('bounds a stalled send and releases its abort listener even without a callback', async () => {
    const { id } = await open();
    socket.send.mockImplementation(() => {});
    const signal = new AbortController().signal;
    const remove = jest.spyOn(signal, 'removeEventListener');
    const pending = bridge.request(preview, 'preview', { key: 'key', id, action: 'send', data: 'x', binary: false }, signal);
    const rejected = expect(pending).rejects.toThrow('stopped');
    jest.advanceTimersByTime(5000); await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(bridge.entries.size).toBe(0);
  });
});
