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
  tagRadRequest,
  endRadRequest,
  HANDOFF_HEADER,
  MAX_RESPONSE_CHARS,
} = require('./rad-protocol');
const { LIMITS } = require('./rad-read-admission');

const RID = 'z3gqcJUoA1n9HaHKufZs5FCSGazv5';

// An Electron session, as the webRequest dispatcher names it to handlers.
const newSession = () => ({});
let nextId = 1;
// A request as onBeforeSendHeaders tags it: its webRequest id, and the
// headers the protocol handler's Request then carries.
function sent(webSession, url, webContentsId, { id = nextId++, headers = {} } = {}) {
  const { requestHeaders } = tagRadRequest(
    { id, url, webContentsId, requestHeaders: headers },
    { session: webSession }
  );
  return { id, url, headers: new Headers(requestHeaders) };
}
const fromTab = (webSession, tagged, extra = {}) =>
  handleRadRequest({ url: tagged.url, method: 'GET', headers: tagged.headers, ...extra }, {
    webSession,
  });
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

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
      signal: expect.any(AbortSignal),
    });
    expect(response.status).toBe(200);
  });

  test('bounds the reads one tab can queue, by its handoff token (R-3)', async () => {
    const pending = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(new Response('{}'))))
    );
    const web = newSession();
    // One URL for every read: the token, not the URL, names the tab.
    const url = `rad://${RID}/tree/${'c'.repeat(40)}`;
    const greedy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT + LIMITS.PER_REQUESTER; i += 1) {
      greedy.push(fromTab(web, sent(web, url, 41)));
    }
    expect((await fromTab(web, sent(web, url, 41))).status).toBe(503);
    const other = fromTab(web, sent(web, url, 42));
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

describe('the handoff from webRequest (R-3, #948 round 1)', () => {
  // Electron gives a protocol.handle handler no request id, and aborts no
  // AbortSignal for it. onBeforeSendHeaders tags each `rad:` request with a
  // token the handler reads back; webRequest's cancellation
  // (net::ERR_ABORTED) comes under the request's id.
  const held = () => {
    const pending = [];
    serveRepoApi.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(new Response('{}'))))
    );
    return pending;
  };

  test("same-URL reads from two tabs keep their own tab, whatever order the handler sees", async () => {
    const pending = held();
    const web = newSession();
    const url = `rad://${RID}/tree/${'d'.repeat(40)}`;
    const first = sent(web, url, 61);
    const second = sent(web, url, 62);
    // The handler sees the second tab's request first.
    const secondRead = fromTab(web, second);
    const firstRead = fromTab(web, first);
    await settle();
    expect(serveRepoApi).toHaveBeenCalledTimes(2);

    // Tab 61 navigates away: its read ends, and only its read.
    endRadRequest({ id: first.id, url, error: 'net::ERR_ABORTED' }, { session: web });
    expect((await firstRead).status).toBe(503);
    pending.forEach((resolve) => resolve());
    expect((await secondRead).status).toBe(200);
  });

  test('a request id in one session never cancels another session\'s read', async () => {
    const pending = held();
    const web = newSession();
    const privateWeb = newSession();
    const url = `rad://${RID}/tree/${'e'.repeat(40)}`;
    // The same id in both sessions: ids are only unique within one.
    const a = sent(web, url, 71, { id: 5 });
    const b = sent(privateWeb, url, 72, { id: 5 });
    const bRead = fromTab(privateWeb, b);
    const aRead = fromTab(web, a);
    await settle();

    // The private window navigates: its read ends; the other tab's runs on.
    endRadRequest({ id: 5, url, error: 'net::ERR_ABORTED' }, { session: privateWeb });
    expect((await bRead).status).toBe(503);
    let aDone = false;
    aRead.then(() => {
      aDone = true;
    });
    await settle();
    expect(aDone).toBe(false);

    // Then the first tab navigates too.
    endRadRequest({ id: 5, url, error: 'net::ERR_ABORTED' }, { session: web });
    expect((await aRead).status).toBe(503);
    pending.forEach((resolve) => resolve());
  });

  test('a queued read whose page navigated away is dropped before the add-on', async () => {
    const pending = held();
    const web = newSession();
    const busy = [];
    for (let i = 0; i < LIMITS.IN_FLIGHT; i += 1) {
      busy.push(fromTab(web, sent(web, `rad://${RID}/tree/${'b'.repeat(40)}`, 81)));
    }
    const gone = sent(web, `rad://${RID}/blob/${'a'.repeat(40)}/big.bin`, 82);
    const goneRead = fromTab(web, gone);
    endRadRequest({ id: gone.id, url: gone.url, error: 'net::ERR_ABORTED' }, { session: web });
    expect((await goneRead).status).toBe(503);

    pending.forEach((resolve) => resolve());
    await Promise.all(busy);
    expect(serveRepoApi).toHaveBeenCalledTimes(LIMITS.IN_FLIGHT);
  });

  test('a request that ended before its handler ran reads nothing', async () => {
    serveRepoApi.mockImplementation(async () => new Response('{}'));
    const web = newSession();
    const url = `rad://${RID}`;
    const cancelled = sent(web, url, 91);
    // Another webRequest handler cancelled it, or its page left first.
    endRadRequest({ id: cancelled.id, url, error: 'net::ERR_BLOCKED_BY_CLIENT' }, { session: web });
    expect((await fromTab(web, cancelled)).status).toBe(503);
    // A token this session never issued (a page's own header, reaching a
    // handler the tracker didn't tag) reads nothing either.
    const forged = { url, headers: new Headers({ [HANDOFF_HEADER]: 'not-a-token' }) };
    expect((await fromTab(web, forged)).status).toBe(503);
    expect(serveRepoApi).not.toHaveBeenCalled();

    // Errors other than ERR_ABORTED end a request without aborting its read.
    const served = sent(web, url, 92);
    const read = fromTab(web, served);
    expect((await read).status).toBe(200);
    endRadRequest({ id: served.id, url, error: 'net::ERR_FAILED' }, { session: web });
  });

  test('the tag replaces a page\'s own header, and a request that comes again is tagged again', () => {
    const web = newSession();
    const url = `rad://${RID}`;
    const tagged = sent(web, url, 93, {
      id: 40,
      headers: { 'X-Freedom-Rad-Req': 'chosen-by-the-page', Accept: '*/*' },
    });
    const token = tagged.headers.get(HANDOFF_HEADER);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(tagged.headers.get('accept')).toBe('*/*');
    const again = sent(web, url, 93, { id: 40 });
    expect(again.headers.get(HANDOFF_HEADER)).not.toBe(token);
    // Not a rad: URL, or no session: untouched.
    expect(tagRadRequest({ id: 41, url: 'https://example.com/' }, { session: web })).toBeNull();
    expect(tagRadRequest({ id: 42, url })).toBeNull();
  });

  test('a request without a token falls back to its own signal', async () => {
    serveRepoApi.mockImplementation(async () => new Response('{}'));
    const response = await handleRadRequest(
      { url: `rad://${RID}`, method: 'GET', headers: new Headers() },
      { webSession: newSession() }
    );
    expect(response.status).toBe(200);
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
