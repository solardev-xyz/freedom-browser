jest.mock('../radicle-manager', () => ({
  isDisabledForProfile: jest.fn(() => false),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../radicle-api-protocol', () => ({
  serveRepoApi: jest.fn(async () => new Response('{"native":true}', { status: 200 })),
  decodeRepoApiPath: jest.fn((path) => {
    if (!path) return [];
    try {
      const segments = path.slice(1).split('/').map(decodeURIComponent);
      return segments.some(
        (segment, index) =>
          (segment === '' && index !== segments.length - 1) ||
          segment === '.' ||
          segment === '..' ||
          // eslint-disable-next-line no-control-regex
          /[\\/\u0000-\u001f\u007f]/.test(segment)
      )
        ? null
        : segments;
    } catch {
      return null;
    }
  }),
}));

const { isDisabledForProfile } = require('../radicle-manager');
const { serveRepoApi } = require('../radicle-api-protocol');
const log = require('../logger');
const {
  buildRadReference,
  handleRadRequest,
  registerRadProtocol,
  noteRadRequest,
  endRadRequest,
  MAX_RESPONSE_CHARS,
} = require('./rad-protocol');
const { LIMITS } = require('./rad-read-admission');

const RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

beforeEach(() => {
  jest.clearAllMocks();
  isDisabledForProfile.mockReturnValue(false);
});

describe('buildRadReference', () => {
  test.each([
    [`rad://${RID}`, 'rad:' + RID, '', ''],
    [`rad:${RID}/tree/main/src?x=1`, 'rad:' + RID, '/tree/main/src', '?x=1'],
  ])('parses %s without changing RID case', (input, rid, path, search) => {
    expect(buildRadReference(input)).toEqual({ ok: true, rid, path, search });
  });

  test('rejects a profile-disabled Radicle node', () => {
    isDisabledForProfile.mockReturnValue(true);
    expect(buildRadReference(`rad://${RID}`)).toMatchObject({ ok: false, status: 403 });
  });

  test.each([
    ['rad://z0OIl+invalid/tree'],
    [`rad://${RID}/../secrets`],
    [`rad://${RID}/%2e%2e/secrets`],
    [`rad://${RID}/tree/main/..%2F..%2Fsecrets`],
    [`rad://${RID}/tree/main/%5csecrets`],
    [`rad://${RID}//tree`],
    [`rad://${RID}/tree\\main`],
  ])('rejects malformed or unsafe reference %s', (input) => {
    expect(buildRadReference(input)).toBeNull();
  });
});

describe('handleRadRequest', () => {
  test('serves repository reads through the native API core', async () => {
    const response = await handleRadRequest({ url: `rad://${RID}/tree/main`, method: 'GET' });
    expect(serveRepoApi).toHaveBeenCalledWith(`rad:${RID}`, '/tree/main', {
      method: 'GET',
      search: '',
      maxResponseChars: MAX_RESPONSE_CHARS,
    });
    expect(response.status).toBe(200);
  });

  test('bounds the reads one tab can queue, by webRequest attribution (R-3)', async () => {
    const pending = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(new Response('{}'))))
    );
    let id = 1000;
    const fromTab = (webContentsId) => {
      const url = `rad://${RID}/tree/${'c'.repeat(40)}/${id}`;
      noteRadRequest({ id, url, webContentsId });
      id += 1;
      return handleRadRequest({ url, method: 'GET' });
    };
    const greedy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.PER_REQUESTER; i += 1) greedy.push(fromTab(41));
    expect((await fromTab(41)).status).toBe(503);
    const other = fromTab(42);
    expect(serveRepoApi).toHaveBeenCalledTimes(LIMITS.IN_FLIGHT);
    for (let i = 0; i < 40 && pending.length; i += 1) {
      pending.shift()();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all([...greedy, other]);
  });

  test('bounds the reads one page can queue (R-3)', async () => {
    const pending = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(new Response('{}'))))
    );
    const page = (referrer) => ({ url: `rad://${RID}/tree/main`, method: 'GET', referrer });
    const greedy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.PER_REQUESTER; i += 1) {
      greedy.push(handleRadRequest(page('https://greedy.example/app')));
    }
    const refused = await handleRadRequest(page('https://greedy.example/other'));
    expect(refused.status).toBe(503);
    expect(refused.headers.get('access-control-allow-origin')).toBe('*');

    // Another page, or the same origin in a private window, still queues.
    const other = handleRadRequest(page('https://other.example/'));
    const privateWindow = handleRadRequest(page('https://greedy.example/'), {
      session: 'private-1',
    });
    expect(serveRepoApi).toHaveBeenCalledTimes(LIMITS.IN_FLIGHT);

    while (pending.length) pending.shift()();
    for (let i = 0; i < 20 && serveRepoApi.mock.calls.length < greedy.length + 2; i += 1) {
      await Promise.resolve();
      while (pending.length) pending.shift()();
    }
    await Promise.all([...greedy, other, privateWindow]);
    expect(serveRepoApi).toHaveBeenCalledTimes(greedy.length + 2);
  });

  test('a read whose page went away never reaches the add-on (R-3)', async () => {
    const release = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve(new Response('{}'))))
    );
    const busy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT; i += 1) {
      busy.push(handleRadRequest({ url: `rad://${RID}`, method: 'GET', referrer: 'https://a/' }));
    }
    const controller = new AbortController();
    const gone = handleRadRequest({
      url: `rad://${RID}/blob/${'a'.repeat(40)}/big.bin`,
      method: 'GET',
      referrer: 'https://b/',
      signal: controller.signal,
    });
    controller.abort();
    expect((await gone).status).toBe(503);

    release.forEach((fn) => fn());
    await Promise.all(busy);
    expect(serveRepoApi).toHaveBeenCalledTimes(LIMITS.IN_FLIGHT);
  });

  test('rejects writes and malformed references', async () => {
    await expect(
      handleRadRequest({ url: `rad://${RID}`, method: 'POST' }).then((r) => r.status)
    ).resolves.toBe(405);
    await expect(
      handleRadRequest({ url: 'rad://invalid', method: 'GET' }).then((r) => r.status)
    ).resolves.toBe(400);
    expect(serveRepoApi).not.toHaveBeenCalled();
  });
});

describe('cancellation through webRequest (R-3)', () => {
  // Electron aborts no AbortSignal for protocol.handle; webRequest reports
  // the cancellation (net::ERR_ABORTED) under the request's id instead.
  test('a queued read whose page navigated away is dropped before the add-on', async () => {
    const release = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve(new Response('{}'))))
    );
    const busy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT; i += 1) {
      const url = `rad://${RID}/tree/${'b'.repeat(40)}/${i}`;
      noteRadRequest({ id: 100 + i, url });
      busy.push(handleRadRequest({ url, method: 'GET', referrer: 'https://a/' }));
    }
    const url = `rad://${RID}/blob/${'a'.repeat(40)}/big.bin`;
    expect(noteRadRequest({ id: 7, url })).toBeNull();
    const gone = handleRadRequest({ url, method: 'GET', referrer: 'https://b/' });

    endRadRequest({ id: 7, url, error: 'net::ERR_ABORTED' });
    expect((await gone).status).toBe(503);

    release.forEach((fn) => fn());
    await Promise.all(busy);
    busy.forEach((_, i) =>
      endRadRequest({ id: 100 + i, url: `rad://${RID}/tree/${'b'.repeat(40)}/${i}` })
    );
    expect(serveRepoApi).toHaveBeenCalledTimes(LIMITS.IN_FLIGHT);
  });

  test('ids are claimed per URL in arrival order; other errors abort nothing', async () => {
    serveRepoApi.mockImplementation(async () => new Response('{}'));
    const url = `rad://${RID}`;
    noteRadRequest({ id: 1, url });
    noteRadRequest({ id: 2, url });
    // A request another webRequest handler cancelled never reaches the
    // protocol handler; its id must not be claimed by the next request.
    endRadRequest({ id: 1, url, error: 'net::ERR_BLOCKED_BY_CLIENT' });
    const served = await handleRadRequest({ url, method: 'GET' });
    expect(served.status).toBe(200);
    endRadRequest({ id: 2, url });
    // Not a rad: URL: ignored.
    expect(noteRadRequest({ id: 3, url: 'https://example.com/' })).toBeNull();
  });
});

describe('private-session logging', () => {
  function fakeSession() {
    const handlers = new Map();
    return { handlers, protocol: { handle: (scheme, fn) => handlers.set(scheme, fn) } };
  }

  function loggedText() {
    return [log.info, log.warn, log.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.join(' '))
      .join('\n');
  }

  test('redacts failed private rad URLs', async () => {
    isDisabledForProfile.mockReturnValue(true);
    const session = fakeSession();
    registerRadProtocol(session, { privatePartition: 'private-test' });
    await session.handlers.get('rad')({ url: `rad://${RID}/secret.md`, method: 'GET' });
    expect(loggedText()).not.toContain(RID);
    expect(loggedText()).toContain('rad://<private>');
  });
});
