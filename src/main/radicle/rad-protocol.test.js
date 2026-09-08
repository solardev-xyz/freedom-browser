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
const { buildRadReference, handleRadRequest, registerRadProtocol } = require('./rad-protocol');

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
    });
    expect(response.status).toBe(200);
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
