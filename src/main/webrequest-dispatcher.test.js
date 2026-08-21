jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
  _resetWebRequestHandlers,
} = require('./webrequest-dispatcher');

const makeSessionMock = () => ({
  webRequest: {
    onBeforeRequest: jest.fn(),
    onBeforeSendHeaders: jest.fn(),
    onHeadersReceived: jest.fn(),
    onCompleted: jest.fn(),
    onErrorOccurred: jest.fn(),
  },
});

beforeEach(() => {
  _resetWebRequestHandlers();
});

describe('attachWebRequestDispatcher', () => {
  test('does not attach a listener for an event with no handlers', () => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    expect(session.webRequest.onBeforeRequest).not.toHaveBeenCalled();
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
    expect(session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(session.webRequest.onCompleted).not.toHaveBeenCalled();
    expect(session.webRequest.onErrorOccurred).not.toHaveBeenCalled();
  });

  test('attaches exactly one listener per event that has handlers', () => {
    registerWebRequestHandler('onBeforeRequest', 'a', () => null);
    registerWebRequestHandler('onBeforeRequest', 'b', () => null);
    registerWebRequestHandler('onHeadersReceived', 'c', () => null);
    registerWebRequestHandler('onCompleted', 'd', () => null);
    registerWebRequestHandler('onErrorOccurred', 'e', () => null);

    const session = makeSessionMock();
    attachWebRequestDispatcher(session);

    expect(session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onCompleted).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onErrorOccurred).toHaveBeenCalledTimes(1);
    expect(session.webRequest.onBeforeSendHeaders).not.toHaveBeenCalled();
  });
});

describe('registerWebRequestHandler', () => {
  test('rejects unknown events', () => {
    expect(() => registerWebRequestHandler('onWhatever', 'a', () => null))
      .toThrow(/Unsupported webRequest event/);
  });

  test('rejects duplicate registration under the same name + event', () => {
    registerWebRequestHandler('onBeforeRequest', 'rewriter', () => null);
    expect(() => registerWebRequestHandler('onBeforeRequest', 'rewriter', () => null))
      .toThrow(/already registered/);
  });

  test('allows the same name on different events (different dispatch chains)', () => {
    registerWebRequestHandler('onBeforeRequest', 'x402', () => null);
    expect(() => registerWebRequestHandler('onHeadersReceived', 'x402', () => null))
      .not.toThrow();
  });
});

// === onBeforeRequest dispatch ============================================

describe('onBeforeRequest dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onBeforeRequest.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('passes through when no handler returns an action', async () => {
    registerWebRequestHandler('onBeforeRequest', 'a', () => null);
    registerWebRequestHandler('onBeforeRequest', 'b', () => ({}));
    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({});
  });

  test('first non-empty action wins; later handlers are skipped', async () => {
    const second = jest.fn(() => ({ redirectURL: 'https://second.example/' }));
    registerWebRequestHandler('onBeforeRequest', 'first', () => ({ redirectURL: 'https://first.example/' }));
    registerWebRequestHandler('onBeforeRequest', 'second', second);

    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ redirectURL: 'https://first.example/' });
    expect(second).not.toHaveBeenCalled();
  });

  test('cancel takes effect like redirect', async () => {
    registerWebRequestHandler('onBeforeRequest', 'block', () => ({ cancel: true }));
    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ cancel: true });
  });

  test('a throwing handler is logged and skipped — subsequent handlers run', async () => {
    registerWebRequestHandler('onBeforeRequest', 'broken', () => {
      throw new Error('boom');
    });
    registerWebRequestHandler('onBeforeRequest', 'recovery', () => ({ redirectURL: 'https://ok.example/' }));

    const result = await drive({ url: 'https://example.com/' });
    expect(result).toEqual({ redirectURL: 'https://ok.example/' });
  });

  test('awaits async handlers in registration order', async () => {
    const order = [];
    registerWebRequestHandler('onBeforeRequest', 'a', async () => {
      await Promise.resolve();
      order.push('a');
      return null;
    });
    registerWebRequestHandler('onBeforeRequest', 'b', async () => {
      order.push('b');
      return { redirectURL: 'https://b.example/' };
    });
    const result = await drive({ url: 'https://example.com/' });
    expect(order).toEqual(['a', 'b']);
    expect(result).toEqual({ redirectURL: 'https://b.example/' });
  });
});

// === onBeforeSendHeaders dispatch ========================================

describe('onBeforeSendHeaders dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('chains headers across handlers — each sees prior modifications', async () => {
    registerWebRequestHandler('onBeforeSendHeaders', 'first', (details) => ({
      requestHeaders: { ...details.requestHeaders, 'X-First': '1' },
    }));
    registerWebRequestHandler('onBeforeSendHeaders', 'second', (details) => {
      // Must see the X-First header the previous handler added.
      expect(details.requestHeaders['X-First']).toBe('1');
      return { requestHeaders: { ...details.requestHeaders, 'X-Second': '2' } };
    });

    const result = await drive({
      url: 'https://example.com/',
      requestHeaders: { Accept: '*/*' },
    });
    expect(result.requestHeaders).toMatchObject({
      Accept: '*/*',
      'X-First': '1',
      'X-Second': '2',
    });
  });

  test('returns base headers when no handler modifies them', async () => {
    registerWebRequestHandler('onBeforeSendHeaders', 'noop', () => null);
    const result = await drive({
      url: 'https://example.com/',
      requestHeaders: { Accept: 'text/html' },
    });
    expect(result.requestHeaders).toEqual({ Accept: 'text/html' });
  });

  test('cancel from any handler short-circuits the chain', async () => {
    const after = jest.fn();
    registerWebRequestHandler('onBeforeSendHeaders', 'block', () => ({ cancel: true }));
    registerWebRequestHandler('onBeforeSendHeaders', 'after', after);

    const result = await drive({ url: 'https://example.com/', requestHeaders: {} });
    expect(result).toEqual({ cancel: true });
    expect(after).not.toHaveBeenCalled();
  });
});

// === onHeadersReceived dispatch ==========================================

describe('onHeadersReceived dispatch', () => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest.onHeadersReceived.mock.calls[0][0];
    const callback = jest.fn();
    await listener(details, callback);
    return callback.mock.calls[0][0];
  };

  test('chains response headers and forwards statusLine', async () => {
    registerWebRequestHandler('onHeadersReceived', 'tag', (details) => ({
      responseHeaders: { ...details.responseHeaders, 'X-Tagged': ['yes'] },
    }));
    const result = await drive({
      url: 'https://example.com/',
      responseHeaders: { 'Content-Type': ['text/html'] },
      statusLine: 'HTTP/1.1 200 OK',
    });
    expect(result.responseHeaders).toMatchObject({ 'X-Tagged': ['yes'] });
    expect(result.statusLine).toBe('HTTP/1.1 200 OK');
  });

  test('redirectURL short-circuits — useful for x402 navigation interstitial', async () => {
    const after = jest.fn();
    registerWebRequestHandler('onHeadersReceived', 'x402', () => ({
      redirectURL: 'freedom://x402-pay',
    }));
    registerWebRequestHandler('onHeadersReceived', 'after', after);

    const result = await drive({
      url: 'https://api.example/article',
      responseHeaders: { 'PAYMENT-REQUIRED': ['eyJzY2hlbWUi...'] },
      statusLine: 'HTTP/1.1 402 Payment Required',
    });
    expect(result).toEqual({ redirectURL: 'freedom://x402-pay' });
    expect(after).not.toHaveBeenCalled();
  });
});

// === Notification-only dispatch (onCompleted, onErrorOccurred) ===========

describe.each([
  ['onCompleted', 'onCompleted'],
  ['onErrorOccurred', 'onErrorOccurred'],
])('%s dispatch', (event, sessionMethod) => {
  const drive = async (details) => {
    const session = makeSessionMock();
    attachWebRequestDispatcher(session);
    const listener = session.webRequest[sessionMethod].mock.calls[0][0];
    await listener(details);
  };

  test('invokes every registered handler in registration order (sync)', async () => {
    const order = [];
    registerWebRequestHandler(event, 'first', (details) => {
      order.push(['first', details.id]);
    });
    registerWebRequestHandler(event, 'second', (details) => {
      order.push(['second', details.id]);
    });

    await drive({ id: 42, url: 'https://example.com/' });
    expect(order).toEqual([['first', 42], ['second', 42]]);
  });

  test('async handler does not gate the next handler (no await)', async () => {
    // Notification-only: ordering between independent observers is
    // meaningless. The second handler must run synchronously after
    // the first, even if the first is async.
    let secondRan = false;
    registerWebRequestHandler(event, 'slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    registerWebRequestHandler(event, 'fast', () => {
      secondRan = true;
    });

    await drive({ id: 1, url: 'https://example.com/' });
    expect(secondRan).toBe(true);
  });

  test('ignores handler return values (no callback to chain into)', async () => {
    registerWebRequestHandler(event, 'rogue', () => ({ cancel: true }));
    const after = jest.fn();
    registerWebRequestHandler(event, 'after', after);
    await drive({ id: 1, url: 'https://example.com/' });
    expect(after).toHaveBeenCalledTimes(1);
  });

  test('a throwing handler is logged; subsequent handlers still run', async () => {
    registerWebRequestHandler(event, 'broken', () => {
      throw new Error('boom');
    });
    const after = jest.fn();
    registerWebRequestHandler(event, 'after', after);

    await drive({ id: 1, url: 'https://example.com/' });
    expect(after).toHaveBeenCalledTimes(1);
  });
});

// Private windows attach the dispatcher with an exclude predicate so the
// x402 payment-interception handlers never observe private traffic (see
// src/main/index.js — PRIVATE MODE GUARD (x402)).
describe('attachWebRequestDispatcher exclude option', () => {
  test('excluded handlers are not attached for this session', async () => {
    const seen = [];
    registerWebRequestHandler('onBeforeSendHeaders', 'x402-capture', (details) => {
      seen.push(['x402-capture', details.id]);
      return null;
    });
    registerWebRequestHandler('onBeforeSendHeaders', 'rewriter', (details) => {
      seen.push(['rewriter', details.id]);
      return null;
    });
    registerWebRequestHandler('onHeadersReceived', 'x402-detect', (details) => {
      seen.push(['x402-detect', details.id]);
      return null;
    });

    const session = makeSessionMock();
    attachWebRequestDispatcher(session, {
      exclude: (name) => name.startsWith('x402-'),
    });

    // onHeadersReceived only had x402 handlers — nothing left to attach.
    expect(session.webRequest.onHeadersReceived).not.toHaveBeenCalled();
    expect(session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);

    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    const callback = jest.fn();
    await listener({ id: 7, requestHeaders: {} }, callback);

    expect(seen).toEqual([['rewriter', 7]]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test('a session attached without exclude still runs every handler', async () => {
    const seen = [];
    registerWebRequestHandler('onBeforeSendHeaders', 'x402-capture', (details) => {
      seen.push(['x402-capture', details.id]);
      return null;
    });
    registerWebRequestHandler('onBeforeSendHeaders', 'rewriter', (details) => {
      seen.push(['rewriter', details.id]);
      return null;
    });

    const session = makeSessionMock();
    attachWebRequestDispatcher(session);

    const listener = session.webRequest.onBeforeSendHeaders.mock.calls[0][0];
    await listener({ id: 3, requestHeaders: {} }, jest.fn());

    expect(seen).toEqual([
      ['x402-capture', 3],
      ['rewriter', 3],
    ]);
  });
});
