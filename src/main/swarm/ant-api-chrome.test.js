jest.mock('../logger', () => ({ debug: jest.fn(), warn: jest.fn() }));
const mockGetAntApiUrl = jest.fn();
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockGetAntApiUrl() }));

const { antApiGet, CHROME_ANT_ENDPOINTS } = require('./ant-api-chrome');

beforeEach(() => {
  mockGetAntApiUrl.mockReset().mockReturnValue('http://127.0.0.1:1633');
});

describe('antApiGet (chrome → main Ant API reads, security audit O-1)', () => {
  test('GETs an allowlisted endpoint and parses JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{"peers":[1,2]}', { status: 200 }));
    await expect(antApiGet('/peers', { fetchImpl })).resolves.toEqual({
      ok: true,
      status: 200,
      data: { peers: [1, 2] },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:1633/peers');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  test('passes non-OK statuses and non-JSON bodies through as data: null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(antApiGet('/readiness', { fetchImpl })).resolves.toEqual({
      ok: false,
      status: 503,
      data: null,
    });
  });

  test.each([
    '/stamps/1/17',
    '/wallet/withdraw',
    '/chequebook/deposit?amount=1',
    '/../x',
    'http://evil/',
    42,
    null,
  ])('refuses %p without contacting the node', async (endpoint) => {
    const fetchImpl = jest.fn();
    const result = await antApiGet(endpoint, { fetchImpl });
    expect(result.error).toBe('Unsupported Ant API endpoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports a node that is not ready or unreachable as an error', async () => {
    mockGetAntApiUrl.mockReturnValue(null);
    const fetchImpl = jest.fn();
    await expect(antApiGet('/health', { fetchImpl })).resolves.toMatchObject({
      error: 'Ant endpoint is not ready',
    });
    mockGetAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    fetchImpl.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(antApiGet('/health', { fetchImpl })).resolves.toMatchObject({
      error: 'Ant API unreachable',
    });
  });

  test('covers every endpoint the chrome reads', () => {
    // Keep in sync with fetchAntJson / ant-ui.js callers in src/renderer.
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'renderer', 'lib');
    const files = [
      path.join(root, 'ant-ui.js'),
      ...fs
        .readdirSync(path.join(root, 'wallet'))
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map((f) => path.join(root, 'wallet', f)),
    ];
    const used = new Set();
    for (const file of files) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/fetchAntJson\('([^']+)'\)/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    for (const endpoint of used) expect(CHROME_ANT_ENDPOINTS.has(endpoint)).toBe(true);
  });
});
