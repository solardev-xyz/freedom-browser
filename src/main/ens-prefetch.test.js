const mockAbort = jest.fn();
const mockEnd = jest.fn();
// Each test gets a fresh fake request whose event listeners are stored
// so the test can simulate 'response' / 'error' / 'data' / 'end' events.
let fakeRequest;
const mockNetRequest = jest.fn(() => fakeRequest);

jest.mock('electron', () => ({
  net: { request: (opts) => mockNetRequest(opts) },
}));

jest.mock('./service-registry', () => ({
  getBeeApiUrl: () => 'http://127.0.0.1:1633',
  getIpfsGatewayUrl: () => 'http://localhost:8080',
  getRadicleApiUrl: () => 'http://127.0.0.1:8780',
}));

jest.mock('./logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { prefetchGatewayUrl, PREFETCH_TIMEOUT_MS } = require('./ens-prefetch');

const makeFakeRequest = () => {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
    },
    emit(event, ...args) {
      const ls = listeners.get(event) || [];
      for (const cb of ls) cb(...args);
    },
    end: mockEnd,
    abort: mockAbort,
    listeners,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  fakeRequest = makeFakeRequest();
  delete process.env.ENS_DISABLE_PREFETCH;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('prefetchGatewayUrl', () => {
  test('fires a GET against the bzz gateway for bzz:// URIs', () => {
    const handle = prefetchGatewayUrl('bzz://' + 'a'.repeat(64));

    expect(mockNetRequest).toHaveBeenCalledTimes(1);
    expect(mockNetRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: 'http://127.0.0.1:1633/bzz/' + 'a'.repeat(64),
    });
    expect(typeof handle.abort).toBe('function');
  });

  test('fires a GET against the ipfs gateway for ipfs:// URIs', () => {
    const cid = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';
    prefetchGatewayUrl('ipfs://' + cid);

    expect(mockNetRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: 'http://localhost:8080/ipfs/' + cid,
    });
  });

  test('ipns:// URIs return a noop handle without any network call', () => {
    const handle = prefetchGatewayUrl('ipns://docs.ipfs.io');
    expect(mockNetRequest).not.toHaveBeenCalled();
    expect(typeof handle.abort).toBe('function');
    // abort on the noop is idempotent and harmless
    handle.abort();
    handle.abort();
  });

  test('malformed URIs return a noop handle', () => {
    prefetchGatewayUrl('');
    prefetchGatewayUrl(null);
    prefetchGatewayUrl('https://example.com');
    prefetchGatewayUrl('bzz://not-a-hash');
    prefetchGatewayUrl('ipfs://');
    expect(mockNetRequest).not.toHaveBeenCalled();
  });

  test('ENS_DISABLE_PREFETCH=1 env var suppresses all network calls', () => {
    process.env.ENS_DISABLE_PREFETCH = '1';
    prefetchGatewayUrl('bzz://' + 'a'.repeat(64));
    expect(mockNetRequest).not.toHaveBeenCalled();
  });

  test('only strict "1" disables prefetch — avoids the ENS_DISABLE_PREFETCH=0 foot-gun', () => {
    // '0' and 'true' look like config intent but should NOT disable,
    // matching the Unix convention used in other env flags.
    for (const value of ['0', 'true', 'yes', 'TRUE', '']) {
      process.env.ENS_DISABLE_PREFETCH = value;
      mockNetRequest.mockClear();
      fakeRequest = makeFakeRequest();
      prefetchGatewayUrl('bzz://' + 'a'.repeat(64));
      expect(mockNetRequest).toHaveBeenCalled();
    }
  });

  test('abort() cancels the in-flight request and clears the timer', () => {
    const handle = prefetchGatewayUrl('bzz://' + 'a'.repeat(64));
    expect(mockAbort).not.toHaveBeenCalled();

    handle.abort();

    expect(mockAbort).toHaveBeenCalledTimes(1);

    // Second abort is a no-op (idempotent).
    handle.abort();
    expect(mockAbort).toHaveBeenCalledTimes(1);
  });

  test('hygiene timeout fires after PREFETCH_TIMEOUT_MS and aborts', () => {
    prefetchGatewayUrl('bzz://' + 'a'.repeat(64));
    expect(mockAbort).not.toHaveBeenCalled();

    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);

    expect(mockAbort).toHaveBeenCalledTimes(1);
  });

  test('completing naturally clears the timer (no late abort)', () => {
    prefetchGatewayUrl('bzz://' + 'a'.repeat(64));

    // Simulate response + end
    const fakeResponse = {
      on(event, cb) {
        if (event === 'end') setTimeout(cb, 0);
      },
    };
    fakeRequest.emit('response', fakeResponse);
    jest.advanceTimersByTime(1); // flush the end callback

    // Now advance past the hygiene timeout — abort should NOT fire.
    jest.advanceTimersByTime(PREFETCH_TIMEOUT_MS + 100);

    expect(mockAbort).not.toHaveBeenCalled();
  });

  test('request.error event cleans up without throwing', () => {
    prefetchGatewayUrl('bzz://' + 'a'.repeat(64));

    // Simulate a network error mid-flight.
    expect(() => fakeRequest.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
  });

  test('any thrown exception returns a noop handle (never breaks caller)', () => {
    // Force convertProtocolUrl to throw by poisoning the mock.
    mockNetRequest.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const handle = prefetchGatewayUrl('bzz://' + 'a'.repeat(64));
    expect(typeof handle.abort).toBe('function');
    handle.abort(); // does not throw
  });
});
