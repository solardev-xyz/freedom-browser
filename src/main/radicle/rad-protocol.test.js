jest.mock('../service-registry', () => ({
  getRadicleApiUrl: jest.fn(() => 'http://127.0.0.1:8780'),
}));

jest.mock('../settings-store', () => ({
  loadSettings: jest.fn(() => ({ enableRadicleIntegration: true })),
}));

jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { buildHttpdUrl, sanitizeRequestHeaders, handleRadRequest } = require('./rad-protocol');
const { getRadicleApiUrl } = require('../service-registry');
const { loadSettings } = require('../settings-store');

// Mixed-case base58 RID — case preservation is the reason the `rad` scheme
// is registered non-standard, so every fixture here must exercise it.
const RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const API = 'http://127.0.0.1:8780';

describe('buildHttpdUrl', () => {
  beforeEach(() => {
    getRadicleApiUrl.mockReturnValue(API);
    loadSettings.mockReturnValue({ enableRadicleIntegration: true });
  });

  // {rad:// form, bare URN form} × {no path, path (+query)} — RID case must
  // survive every variant.
  test.each([
    ['rad://<rid>', `rad://${RID}`, `${API}/api/v1/repos/rad:${RID}`],
    ['bare rad:<rid>', `rad:${RID}`, `${API}/api/v1/repos/rad:${RID}`],
    [
      'rad://<rid> with path and query',
      `rad://${RID}/tree/main/src?x=1`,
      `${API}/api/v1/repos/rad:${RID}/tree/main/src?x=1`,
    ],
    ['bare rad:<rid> with path', `rad:${RID}/issues`, `${API}/api/v1/repos/rad:${RID}/issues`],
  ])('maps %s to the httpd repo endpoint', (_name, input, expected) => {
    expect(buildHttpdUrl(input)).toEqual({ ok: true, url: expected });
  });

  test('rejects when Radicle integration is disabled', () => {
    loadSettings.mockReturnValue({ enableRadicleIntegration: false });
    expect(buildHttpdUrl(`rad://${RID}`)).toMatchObject({
      ok: false,
      status: 403,
      message: 'Radicle integration is disabled',
    });
  });

  test('returns 503 when the Radicle endpoint is not hydrated', () => {
    getRadicleApiUrl.mockReturnValue(null);
    expect(buildHttpdUrl(`rad://${RID}`)).toMatchObject({
      ok: false,
      status: 503,
      message: 'Radicle node is not ready',
    });
  });

  test.each([
    ['non-base58 characters', 'rad://z0OIl+invalid/tree'],
    ['missing z prefix', 'rad://3gqcJUoA1n9HaHKufZs5FCSGazv5'],
    ['too short', 'rad://zabc'],
    ['empty host', 'rad://'],
    ['empty urn', 'rad:'],
  ])('rejects invalid RID: %s', (_name, url) => {
    expect(buildHttpdUrl(url)).toBeNull();
  });

  test.each([
    ['dot-dot segment', `rad://${RID}/../v1/sessions`],
    ['dot segment', `rad://${RID}/./tree`],
    ['encoded dot-dot', `rad://${RID}/%2e%2e/v1/sessions`],
    ['encoded dot-dot mixed case', `rad://${RID}/%2E%2e/x`],
    ['backslash', `rad://${RID}/tree\\main`],
    ['empty segment', `rad://${RID}//tree`],
  ])('rejects path traversal: %s', (_name, url) => {
    expect(buildHttpdUrl(url)).toBeNull();
  });

  test('query string is not scanned for traversal', () => {
    expect(buildHttpdUrl(`rad://${RID}/tree?q=..`)).toEqual({
      ok: true,
      url: `${API}/api/v1/repos/rad:${RID}/tree?q=..`,
    });
  });
});

describe('sanitizeRequestHeaders', () => {
  test('strips origin-identifying and hop-by-hop headers, keeps the rest', () => {
    const headers = sanitizeRequestHeaders(
      new Headers({
        Accept: 'application/json',
        Origin: `rad://${RID}`,
        Referer: `rad://${RID}/tree`,
        Cookie: 'a=1',
        Authorization: 'Bearer x',
        Connection: 'keep-alive',
        Host: 'whatever',
      })
    );
    expect(headers.get('accept')).toBe('application/json');
    for (const name of ['origin', 'referer', 'cookie', 'authorization', 'connection', 'host']) {
      expect(headers.get(name)).toBeNull();
    }
  });
});

describe('handleRadRequest', () => {
  beforeEach(() => {
    getRadicleApiUrl.mockReturnValue(API);
    loadSettings.mockReturnValue({ enableRadicleIntegration: true });
  });

  const makeRequest = (url, { method = 'GET', headers = {} } = {}) => ({
    url,
    method,
    headers: new Headers(headers),
    signal: undefined,
  });

  test('proxies GET to the httpd repo endpoint and adds CORS header', async () => {
    const upstream = new Response('{"name":"heartwood"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const fetchImpl = jest.fn(async () => upstream);

    const response = await handleRadRequest(makeRequest(`rad://${RID}/tree/main`), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${API}/api/v1/repos/rad:${RID}/tree/main`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await expect(response.text()).resolves.toBe('{"name":"heartwood"}');
  });

  test('passes through non-2xx statuses from httpd', async () => {
    const fetchImpl = jest.fn(async () => new Response('not found', { status: 404 }));
    const response = await handleRadRequest(makeRequest(`rad://${RID}`), { fetchImpl });
    expect(response.status).toBe(404);
  });

  test('rejects non-read methods with 405', async () => {
    const fetchImpl = jest.fn();
    const response = await handleRadRequest(makeRequest(`rad://${RID}`, { method: 'POST' }), {
      fetchImpl,
    });
    expect(response.status).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('allows HEAD', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 200 }));
    const response = await handleRadRequest(makeRequest(`rad://${RID}`, { method: 'HEAD' }), {
      fetchImpl,
    });
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${API}/api/v1/repos/rad:${RID}`,
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  test('returns 400 for malformed rad URLs', async () => {
    const fetchImpl = jest.fn();
    const response = await handleRadRequest(makeRequest('rad://not-a-rid'), { fetchImpl });
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      code: 400,
      message: 'invalid rad reference',
    });
  });

  test('returns 403 when the integration is disabled', async () => {
    loadSettings.mockReturnValue({ enableRadicleIntegration: false });
    const response = await handleRadRequest(makeRequest(`rad://${RID}`), { fetchImpl: jest.fn() });
    expect(response.status).toBe(403);
  });

  test('returns 503 when httpd is unreachable', async () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    const fetchImpl = jest.fn(async () => {
      throw err;
    });
    const response = await handleRadRequest(makeRequest(`rad://${RID}`), { fetchImpl });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      code: 503,
      message: 'radicle httpd unreachable',
    });
  });

  test('returns 502 on other fetch failures', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('boom');
    });
    const response = await handleRadRequest(makeRequest(`rad://${RID}`), { fetchImpl });
    expect(response.status).toBe(502);
  });

  test('strips origin/cookie headers before proxying', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await handleRadRequest(
      makeRequest(`rad://${RID}`, { headers: { Cookie: 'a=1', Accept: 'application/json' } }),
      { fetchImpl }
    );
    const init = fetchImpl.mock.calls[0][1];
    expect(init.headers.get('cookie')).toBeNull();
    expect(init.headers.get('accept')).toBe('application/json');
  });
});


// PRIVATE MODE GUARD (request logging) — same contract as the bzz handler:
// registration decides whether the persistent main.log records the rad URL.
describe('registerRadProtocol private sessions', () => {
  const log = require('../logger');
  const { registerRadProtocol } = require('./rad-protocol');

  function fakeSession() {
    const handlers = new Map();
    return {
      handlers,
      protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) },
    };
  }

  function loggedText() {
    return [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    getRadicleApiUrl.mockReturnValue(API);
    // Disabled integration is the semantic-failure path that logs the URL
    // without touching the network.
    loadSettings.mockReturnValue({ enableRadicleIntegration: false });
  });

  test('a private session redacts the rad URL', async () => {
    const session = fakeSession();
    registerRadProtocol(session, { privatePartition: 'private-abcd' });

    await session.handlers.get('rad')({ url: `rad://${RID}/tree/main/secret.md`, headers: {} });

    const text = loggedText();
    expect(text).not.toContain(RID);
    expect(text).not.toContain('secret.md');
    // The reason itself names nothing browsing-identifying, so it survives
    // redaction — a private window's log still says why the request failed.
    expect(text).toContain('403 for rad://<private>: Radicle integration is disabled');
  });

  test('a normal session keeps the full diagnostic URL', async () => {
    const session = fakeSession();
    registerRadProtocol(session);

    await session.handlers.get('rad')({ url: `rad://${RID}/tree/main/secret.md`, headers: {} });

    expect(loggedText()).toContain(`rad://${RID}/tree/main/secret.md`);
  });
});
