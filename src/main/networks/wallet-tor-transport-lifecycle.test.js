// Deterministic delayed-close and continuation tests. HTTP/TLS/SOCKS boundaries
// are modeled here; real loopback protocol coverage is in transport.test.js.
let mock;
jest.mock('./isolated-socks', () => ({
  connectIsolatedSocks: jest.fn((options, onSocketCreated) =>
    mock.connect(options, onSocketCreated)
  ),
}));
const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { createPrivacyScope } = require('./privacy-context');
const { createWalletTorTransport } = require('./wallet-tor-transport');
class ControlledSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.closed = false;
    this.destroy = jest.fn(() => {
      this.destroyed = true;
      return this;
    });
    this.resume = jest.fn();
    this.pause = jest.fn();
    mock.sockets.push(this);
  }
  closeNow() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const turns = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let transport, scope, handle, work;
const send = (url = 'http://fixture.example/', options = {}) => {
  const promise = transport.request(handle, url, options);
  work.push(promise);
  // Capture rejection immediately even when a test deliberately delays await.
  promise.catch(() => {});
  return promise;
};
const closedObservation = () => {
  const result = { settled: false, rejected: false };
  transport.closed.then(
    () => {
      result.settled = true;
    },
    () => {
      result.rejected = true;
    }
  );
  return result;
};
function closeRequests() {
  for (const request of mock.requests) {
    if (request.closed) continue;
    request.closed = true;
    request.emit('close');
  }
}
function requestBoundary(url, options, received) {
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = jest.fn(() => {
    request.destroyed = true;
  });
  request.write = jest.fn();
  request.end = jest.fn(() => {
    options.agent.createConnection(
      {
        // Model Node forwarding request options to connection creation. Agent
        // queue/replacement ownership is covered by the real loopback suite.
        ...options,
        host: url.hostname,
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      },
      (error, socket) => {
        mock.callbacks++;
        if (error) request.emit('error', error);
        else {
          request.socket = socket;
          if (mock.respond) {
            const response = new EventEmitter();
            response.statusCode = mock.responseStatus || 200;
            response.headers = mock.responseHeaders || { 'content-length': '2' };
            response.complete = mock.responseComplete ?? true;
            response.destroy = jest.fn(() => {
              if (mock.destroyResponseEvents) {
                response.emit('error', Error('PRIVATE late response error'));
                response.emit('close');
              }
            });
            mock.responses.push(response);
            received(response);
            response.emit('data', mock.responseBody || Buffer.from('ok'));
            response.emit('end');
          }
        }
      }
    );
  });
  mock.requests.push(request);
  return request;
}
beforeEach(() => {
  mock = {
    sockets: [],
    responses: [],
    handshakes: [],
    requests: [],
    tls: [],
    callbacks: 0,
    respond: false,
    endpointAbort: new AbortController(),
  };
  mock.connect = jest.fn((options, onSocketCreated) => {
    const gate = deferred(),
      socket = new ControlledSocket();
    onSocketCreated?.(socket);
    mock.handshakes.push({ options, onSocketCreated, gate, socket });
    return gate.promise;
  });
  jest.spyOn(http, 'request').mockImplementation(requestBoundary);
  jest.spyOn(https, 'request').mockImplementation(requestBoundary);
  jest.spyOn(tls, 'connect').mockImplementation((options) => {
    const socket = new ControlledSocket();
    mock.tls.push({ options, socket });
    return socket;
  });
  scope = createPrivacyScope({
    profileId: 'transport-lifecycle',
    signal: new AbortController().signal,
  });
  handle = scope.getContext({
    kind: 'public-address',
    principal: '0x' + '1'.repeat(40),
    chainId: 1,
    role: 'rpc',
  });
  mock.endpoint = Object.freeze({
    host: '127.0.0.1',
    port: 9050,
    signal: mock.endpointAbort.signal,
  });
  mock.getEndpoint = jest.fn(() => mock.endpoint);
  transport = createWalletTorTransport({ allowHttp: true, getEndpoint: mock.getEndpoint });
  work = [];
});
afterEach(async () => {
  transport.close();
  for (const handshake of mock.handshakes) handshake.gate.resolve(handshake.socket);
  await turns();
  for (const socket of mock.sockets) socket.closeNow();
  await turns();
  for (const socket of mock.sockets) socket.closeNow();
  closeRequests();
  await Promise.allSettled(work);
  await transport.closed;
  scope.close();
  jest.restoreAllMocks();
});

test('closed remains pending until close even when there has never been a request', async () => {
  const observed = closedObservation();
  await turns();
  expect(observed).toEqual({ settled: false, rejected: false });
  transport.close();
  await transport.closed;
  expect(observed).toEqual({ settled: true, rejected: false });
});
test('close promptly rejects a queued request but waits for ignored SOCKS cancellation and actual socket close', async () => {
  const pending = send(),
    observed = closedObservation(),
    first = mock.handshakes[0];
  expect(first.onSocketCreated).toEqual(expect.any(Function));
  transport.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  expect(mock.requests[0].destroy).toHaveBeenCalled();
  expect(first.socket.destroyed).toBe(true);
  await turns();
  expect(observed.settled).toBe(false);
  first.gate.resolve(first.socket);
  await turns();
  expect(mock.callbacks).toBe(1);
  expect(observed.settled).toBe(false);
  first.socket.closeNow();
  await transport.closed;
  expect(observed).toEqual({ settled: true, rejected: false });
});
test('closed waits for the late SOCKS callback even after the raw socket close was observed', async () => {
  const pending = send(),
    observed = closedObservation(),
    first = mock.handshakes[0];
  transport.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  first.socket.closeNow();
  await turns();
  expect(observed.settled).toBe(false);
  first.gate.reject(Error('PRIVATE handshake rejection'));
  await transport.closed;
  expect(mock.callbacks).toBe(1);
  expect(observed.rejected).toBe(false);
});
test('failed handshake raw socket remains tracked until its eventual close', async () => {
  const pending = send(),
    first = mock.handshakes[0];
  first.socket.destroy();
  first.gate.reject(Error('PRIVATE handshake failed'));
  await expect(pending).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
  closeRequests();
  const observed = closedObservation();
  transport.close();
  await turns();
  expect(observed.settled).toBe(false);
  first.socket.closeNow();
  await transport.closed;
  expect(observed.rejected).toBe(false);
});
test('late raw socket registration after close cannot make closed resolve ahead of its close event', async () => {
  const gate = deferred();
  let supplied;
  mock.connect.mockImplementationOnce((_options, onSocketCreated) => {
    supplied = onSocketCreated;
    return gate.promise;
  });
  const pending = send(),
    observed = closedObservation();
  transport.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  await turns();
  expect(observed.settled).toBe(false);
  const late = new ControlledSocket();
  supplied(late);
  gate.resolve(late);
  await turns();
  expect(late.destroyed).toBe(true);
  expect(observed.settled).toBe(false);
  late.closeNow();
  await transport.closed;
});
test('retired released groups stay in the drain accounting after their replacement group closes', async () => {
  const firstRequest = send(),
    first = mock.handshakes[0];
  transport.release(handle);
  await expect(firstRequest).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  const secondRequest = send(),
    second = mock.handshakes[1],
    observed = closedObservation();
  transport.close();
  await expect(secondRequest).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  second.gate.resolve(second.socket);
  second.socket.closeNow();
  await turns();
  expect(observed.settled).toBe(false);
  first.gate.resolve(first.socket);
  await turns();
  expect(observed.settled).toBe(false);
  first.socket.closeNow();
  await transport.closed;
  expect(mock.callbacks).toBe(2);
});
test.each(['raw-first', 'tls-first'])(
  'TLS cancellation waits for both physical close events (%s)',
  async (order) => {
    const pending = send('https://fixture.example/'),
      first = mock.handshakes[0];
    first.gate.resolve(first.socket);
    await turns();
    expect(mock.tls).toHaveLength(1);
    const secure = mock.tls[0].socket,
      observed = closedObservation();
    transport.close();
    await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
    closeRequests();
    expect(first.socket.destroyed).toBe(true);
    expect(secure.destroyed).toBe(true);
    const sockets = order === 'raw-first' ? [first.socket, secure] : [secure, first.socket];
    sockets[0].closeNow();
    await turns();
    expect(observed.settled).toBe(false);
    sockets[1].closeNow();
    await transport.closed;
    expect(mock.callbacks).toBe(1);
  }
);
test('failed TLS handshake settles the request but retains unclosed raw and TLS sockets', async () => {
  const pending = send('https://fixture.example/'),
    first = mock.handshakes[0];
  first.gate.resolve(first.socket);
  await turns();
  const secure = mock.tls[0].socket;
  secure.emit('error', Error('PRIVATE certificate failure'));
  await expect(pending).rejects.toMatchObject({ code: 'TOR_REQUEST_FAILED' });
  closeRequests();
  transport.close();
  const observed = closedObservation();
  secure.closeNow();
  await turns();
  expect(observed.settled).toBe(false);
  first.socket.closeNow();
  await transport.closed;
});
test('successful response does not finish transport lifetime or exempt a retained socket from drain', async () => {
  mock.respond = true;
  const pending = send(),
    first = mock.handshakes[0],
    observed = closedObservation();
  first.gate.resolve(first.socket);
  expect((await pending).body.toString()).toBe('ok');
  closeRequests();
  expect(observed.settled).toBe(false);
  transport.close();
  await turns();
  expect(observed.settled).toBe(false);
  first.socket.closeNow();
  await transport.closed;
});

test('closed waits for an assigned ClientRequest close after its socket and connection callback drain', async () => {
  mock.respond = true;
  const pending = send(),
    first = mock.handshakes[0],
    observed = closedObservation();
  first.gate.resolve(first.socket);
  expect((await pending).body.toString()).toBe('ok');
  expect(mock.requests[0].socket).toBe(first.socket);
  transport.close();
  first.socket.closeNow();
  await turns();
  expect(mock.callbacks).toBe(1);
  expect(observed.settled).toBe(false);
  closeRequests();
  await transport.closed;
  expect(observed.rejected).toBe(false);
});
test('terminal never-assigned request needs no artificial close once actual connection and socket work drains', async () => {
  const pending = send(),
    first = mock.handshakes[0];
  transport.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(mock.requests[0].socket).toBeUndefined();
  first.gate.resolve(first.socket);
  first.socket.closeNow();
  await transport.closed;
  expect(mock.requests[0].closed).toBeUndefined();
  expect(mock.callbacks).toBe(1);
});

test('even an end event cannot return a response whose complete flag is false', async () => {
  mock.respond = true;
  mock.responseComplete = false;
  const pending = send(),
    first = mock.handshakes[0];
  first.gate.resolve(first.socket);
  await expect(pending).rejects.toMatchObject({ code: 'TOR_RESPONSE_FAILED' });
  expect(mock.responses[0].destroy).toHaveBeenCalled();
  closeRequests();
});
test.each([
  [302, { 'content-length': '2', location: 'https://PRIVATE.example' }, 'PRIVATE_REDIRECT_REFUSED'],
  [200, { 'content-length': '2', 'content-encoding': 'gzip' }, 'PRIVATE_ENCODING_REFUSED'],
  [200, {}, 'PRIVATE_FRAMING_REFUSED'],
])(
  'early status %i refusal consumes synchronous and late response errors',
  async (status, headers, code) => {
    mock.respond = true;
    mock.responseStatus = status;
    mock.responseHeaders = headers;
    mock.destroyResponseEvents = true;
    const pending = send('http://fixture.example/', { requireFramedResponse: true }),
      first = mock.handshakes[0];
    first.gate.resolve(first.socket);
    await expect(pending).rejects.toMatchObject({ code });
    const response = mock.responses[0];
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(() => response.emit('error', Error('PRIVATE even later'))).not.toThrow();
    expect(mock.callbacks).toBe(1);
    closeRequests();
  }
);
test('oversized chunk is refused before concatenation and late end cannot replace the error', async () => {
  mock.respond = true;
  mock.responseBody = Buffer.alloc(2049);
  mock.responseHeaders = { 'content-length': '2049' };
  mock.destroyResponseEvents = true;
  const pending = send('http://fixture.example/', {
      maxResponseBytes: 2048,
      requireFramedResponse: true,
    }),
    first = mock.handshakes[0];
  const concat = jest.spyOn(Buffer, 'concat');
  first.gate.resolve(first.socket);
  await expect(pending).rejects.toMatchObject({ code: 'PRIVATE_RESPONSE_TOO_LARGE' });
  expect(concat).not.toHaveBeenCalled();
  const response = mock.responses[0];
  response.emit('data', Buffer.from('late'));
  response.emit('end');
  expect(concat).not.toHaveBeenCalled();
  closeRequests();
});
test('late TLS secureConnect after cancellation cannot notify the agent twice', async () => {
  const pending = send('https://fixture.example/'),
    first = mock.handshakes[0];
  first.gate.resolve(first.socket);
  await turns();
  const secure = mock.tls[0].socket;
  transport.close();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  closeRequests();
  await turns();
  expect(mock.callbacks).toBe(1);
  secure.emit('secureConnect');
  secure.emit('error', Error('PRIVATE late TLS error'));
  await turns();
  expect(mock.callbacks).toBe(1);
  first.socket.closeNow();
  secure.closeNow();
  await transport.closed;
});

test.each([null, false, true, 0, 1, 'PRIVATE signal', {}, [], { aborted: false }])(
  'invalid caller signal %# is sanitized before endpoint lookup or request construction',
  async (signal) => {
    await expect(send('http://fixture.example/', { signal })).rejects.toMatchObject({
      code: 'INVALID_PRIVATE_REQUEST',
    });
    expect(mock.getEndpoint).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.handshakes).toHaveLength(0);
    transport.close();
    await transport.closed;
  }
);
test.each(['absent', 'undefined'])('caller signal %s remains optional', async (mode) => {
  mock.respond = true;
  const pending = send('http://fixture.example/', mode === 'absent' ? {} : { signal: undefined });
  const first = mock.handshakes[0];
  first.gate.resolve(first.socket);
  expect((await pending).body.toString()).toBe('ok');
  closeRequests();
});
