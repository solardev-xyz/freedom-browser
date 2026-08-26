const mockResolveSessionToken = jest.fn();

class MockWebSocket {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.onceListeners = {};
    this.onListeners = {};
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  once(event, cb) {
    if (event === 'open') {
      setImmediate(() => {
        cb();
        if (MockWebSocket.closeAfterOpen) {
          setImmediate(() => {
            if (this.onceListeners.close) {
              this.onceListeners.close(1006);
            }
          });
        }
      });
      return;
    }
    this.onceListeners[event] = cb;
  }

  on(event, cb) {
    this.onListeners[event] = cb;
  }

  send(payload) {
    const req = JSON.parse(payload);
    this.lastRequest = req;
    if (!MockWebSocket.replyEnabled) {
      return;
    }
    setImmediate(() => {
      const onMessage = this.onListeners.message;
      if (onMessage) {
        onMessage(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: ['0xAbc'] })));
      }
    });
  }

  close() {
    this.closed = true;
  }

  terminate() {
    this.terminated = true;
  }
}
MockWebSocket.instances = [];
MockWebSocket.replyEnabled = true;
MockWebSocket.closeAfterOpen = false;

jest.mock('ws', () => MockWebSocket);
jest.mock('./session-token', () => ({
  resolveSessionToken: () => mockResolveSessionToken(),
}));

const { rpcRequest } = require('./transport');

beforeEach(() => {
  MockWebSocket.instances.length = 0;
  MockWebSocket.replyEnabled = true;
  MockWebSocket.closeAfterOpen = false;
  mockResolveSessionToken.mockReset().mockReturnValue(null);
});

describe('rpcRequest', () => {
  test('sends the Freedom Origin header derived from the WS URL', async () => {
    await expect(rpcRequest('eth_accounts', [])).resolves.toEqual(['0xAbc']);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].opts.headers.Origin).toBe('https://freedom.browser');
  });

  test('attaches the session token as a Bearer header when available', async () => {
    mockResolveSessionToken.mockReturnValue('tok-123');
    await expect(rpcRequest('eth_accounts', [])).resolves.toEqual(['0xAbc']);
    const { headers } = MockWebSocket.instances[0].opts;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  test('omits the Authorization header when no token exists', async () => {
    await expect(rpcRequest('eth_accounts', [])).resolves.toEqual(['0xAbc']);
    expect(MockWebSocket.instances[0].opts.headers).not.toHaveProperty('Authorization');
  });

  test('never puts the token in the request URL', async () => {
    mockResolveSessionToken.mockReturnValue('tok-123');
    await rpcRequest('eth_accounts', []);
    expect(MockWebSocket.instances[0].url).not.toContain('tok-123');
  });

  test('rejects promptly when the server closes without a response', async () => {
    MockWebSocket.closeAfterOpen = true;
    MockWebSocket.replyEnabled = false;
    // A long timeout proves the close path fails fast: if the close handler
    // regresses, this rejects with a timeout error instead.
    await expect(rpcRequest('eth_accounts', [], { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: 'VAUGHAN_DISCONNECTED',
    });
  });

  test('times out and terminates the socket when no response arrives', async () => {
    MockWebSocket.replyEnabled = false;
    jest.useFakeTimers();
    try {
      const pending = rpcRequest('eth_accounts', [], { timeoutMs: 50 });
      // Attach the rejection handler before advancing timers so the timeout
      // rejection is not "handled asynchronously".
      const assertion = expect(pending).rejects.toMatchObject({ code: 'VAUGHAN_DISCONNECTED' });
      // Flush the mocked 'open' event, then let the timeout fire.
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(60);
      await assertion;
      expect(MockWebSocket.instances[0].terminated).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
