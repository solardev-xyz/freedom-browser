// Controlled socket events verify the internal allocation observer and failure
// lifetime independently of OS timing. Native SOCKS traffic is covered by the
// wallet Tor transport loopback suite.
let mockSockets;
jest.mock('net', () => {
  const { EventEmitter } = require('events');
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.connect = jest.fn();
      this.write = jest.fn();
      this.pause = jest.fn();
      this.unshift = jest.fn();
      this.destroy = jest.fn(() => {
        this.destroyed = true;
        return this;
      });
      mockSockets.push(this);
    }
  }
  return { Socket };
});
const { connectIsolatedSocks } = require('./isolated-socks');
let options, caller, endpoint;
const connect = (observer, input = options) => {
  const promise = connectIsolatedSocks(input, observer);
  promise.catch(() => {});
  return promise;
};
function succeed(socket) {
  socket.emit('connect');
  socket.emit('data', Buffer.from([5, 2]));
  socket.emit('data', Buffer.from([1, 0]));
  socket.emit('data', Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
}
beforeEach(() => {
  jest.useFakeTimers();
  mockSockets = [];
  caller = new AbortController();
  endpoint = new AbortController();
  options = {
    endpoint: { host: '127.0.0.1', port: 9050, signal: endpoint.signal },
    hostname: 'rpc.example.test',
    port: 443,
    token: 'a'.repeat(64),
    signal: caller.signal,
    timeoutMs: 1000,
  };
});
afterEach(() => {
  caller.abort();
  endpoint.abort();
  for (const socket of mockSockets) socket.emit('close');
  jest.useRealTimers();
});

test.each([null, false, 1, {}, []])(
  'invalid observer %# refuses before allocating a socket',
  async (observer) => {
    await expect(connect(observer)).rejects.toMatchObject({ code: 'INVALID_SOCKS_REQUEST' });
    expect(mockSockets).toEqual([]);
  }
);
test.each(['endpoint', 'hostname', 'token', 'port', 'timeout'])(
  'invalid %s cannot reach the observer',
  async (fault) => {
    const input = { ...options };
    if (fault === 'endpoint') input.endpoint = { ...options.endpoint, host: 'PRIVATE.example' };
    if (fault === 'hostname') input.hostname = 'https://PRIVATE.example';
    if (fault === 'token') input.token = 'PRIVATE';
    if (fault === 'port') input.port = 0;
    if (fault === 'timeout') input.timeoutMs = 0;
    const observer = jest.fn();
    await expect(connect(observer, input)).rejects.toMatchObject({ code: 'INVALID_SOCKS_REQUEST' });
    expect(observer).not.toHaveBeenCalled();
    expect(mockSockets).toEqual([]);
  }
);
test('observer is called once after error/close handlers but before connect and sees the exact returned socket', async () => {
  let observed;
  const observer = jest.fn((socket) => {
    observed = socket;
    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(socket.listenerCount('close')).toBeGreaterThan(0);
    expect(socket.connect).not.toHaveBeenCalled();
  });
  const pending = connect(observer),
    socket = mockSockets[0];
  expect(observer).toHaveBeenCalledTimes(1);
  expect(socket.connect).toHaveBeenCalledWith(9050, '127.0.0.1');
  succeed(socket);
  expect(await pending).toBe(observed);
  expect(socket.pause).toHaveBeenCalledTimes(1);
  expect(socket.destroy).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
test('optional observer omission preserves the SOCKS protocol handshake', async () => {
  const pending = connect(),
    socket = mockSockets[0];
  succeed(socket);
  expect(await pending).toBe(socket);
  expect(socket.write.mock.calls[0][0]).toEqual(Buffer.from([5, 1, 2]));
  expect(socket.write.mock.calls[2][0].subarray(0, 5)).toEqual(
    Buffer.from([5, 1, 0, 3, options.hostname.length])
  );
});
test.each(['throw', 'destroy', 'close', 'error', 'caller-abort', 'endpoint-abort'])(
  'observer %s refuses without initiating connect and retains safe late-error handling',
  async (mode) => {
    const observer = jest.fn((socket) => {
      if (mode === 'throw') throw Error('PRIVATE observer details');
      if (mode === 'destroy') socket.destroy();
      if (mode === 'close') socket.emit('close');
      if (mode === 'error') socket.emit('error', Error('PRIVATE socket error'));
      if (mode === 'caller-abort') caller.abort();
      if (mode === 'endpoint-abort') endpoint.abort();
    });
    const error = await connect(observer).catch((value) => value),
      socket = mockSockets[0];
    expect(error).toMatchObject({
      code: expect.stringMatching(/^(SOCKS_|PRIVACY_)/),
      message: 'Isolated SOCKS connection failed',
    });
    expect(error.message).not.toContain('PRIVATE');
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(() => socket.emit('error', Error('late'))).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  }
);
test.each(['protocol', 'connection', 'closed', 'timeout', 'caller-abort', 'endpoint-abort'])(
  'observer retains the socket across %s rejection until its own close notification',
  async (mode) => {
    let closeObserved = false;
    const pending = connect((socket) =>
        socket.once('close', () => {
          closeObserved = true;
        })
      ),
      socket = mockSockets[0];
    if (mode === 'protocol') socket.emit('data', Buffer.from([5, 0]));
    if (mode === 'connection') socket.emit('error', Error('PRIVATE connection failed'));
    if (mode === 'closed') socket.emit('close');
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(1000);
    if (mode === 'caller-abort') caller.abort();
    if (mode === 'endpoint-abort') endpoint.abort();
    await expect(pending).rejects.toMatchObject({
      code: expect.stringMatching(/^(SOCKS_|PRIVACY_)/),
    });
    expect(socket.destroyed).toBe(true);
    expect(closeObserved).toBe(mode === 'closed');
    if (mode !== 'closed') socket.emit('close');
    expect(closeObserved).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  }
);
test('the observer does not prevent isolated credentials from being wiped after write completion', async () => {
  const pending = connect(jest.fn()),
    socket = mockSockets[0];
  socket.emit('connect');
  socket.emit('data', Buffer.from([5, 2]));
  const [authentication, written] = socket.write.mock.calls[1];
  expect(authentication.toString()).toContain(options.token);
  written();
  expect(authentication.every((byte) => byte === 0)).toBe(true);
  socket.emit('data', Buffer.from([1, 0, 5, 0, 0, 1, 127, 0, 0, 1, 0, 1]));
  expect(await pending).toBe(socket);
});
