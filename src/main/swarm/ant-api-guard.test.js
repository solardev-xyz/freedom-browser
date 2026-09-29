const path = require('path');
const { pathToFileURL } = require('url');

jest.mock('../logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockGetAntApiUrl = jest.fn(() => null);
jest.mock('../service-registry', () => ({
  DEFAULTS: { ant: { apiPort: 1633 } },
  getAntApiUrl: () => mockGetAntApiUrl(),
}));

const {
  guardAntApiRequest,
  installAntApiGuard,
  isAntApiRequestUrl,
  isLoopbackHostname,
  noteAntApiUrl,
  _resetAntApiGuardForTests,
} = require('./ant-api-guard');
const {
  registerWebRequestHandler,
  attachWebRequestDispatcher,
  _resetWebRequestHandlers,
} = require('../webrequest-dispatcher');
const { PAGES_DIR, CHROME_INDEX } = require('../ipc-sender-policy');
const { announceMainProcessAntDial } = require('./ant-api-main-dials');

const settingsUrl = pathToFileURL(path.join(PAGES_DIR, 'settings.html')).href;
const publishUrl = pathToFileURL(path.join(PAGES_DIR, 'publish.html')).href;
const chromeUrl = pathToFileURL(CHROME_INDEX).href;

const topFrame = (url) => ({ url, parent: null });
const subFrame = (url) => ({ url, parent: topFrame('https://top.example/') });
const webview = { getType: () => 'webview' };
const browserWindow = { getType: () => 'window' };

// One request as Electron's onBeforeRequest reports it.
const req = ({
  url = 'http://127.0.0.1:1633/stamps/1/17',
  method = 'POST',
  resourceType = 'xhr',
  frame = topFrame('https://evil.example/'),
  webContents = webview,
} = {}) => ({ url, method, resourceType, frame, webContents });

beforeEach(() => {
  _resetAntApiGuardForTests();
  mockGetAntApiUrl.mockReset().mockReturnValue('http://127.0.0.1:1633');
});

describe('which web content the guard stops', () => {
  // The audit's reproduction: a POST /stamps from an https: and a bzz: page.
  test.each([
    ['https page fetch POST', req()],
    ['https page GET via fetch', req({ method: 'GET', resourceType: 'xhr' })],
    ['bzz page fetch POST', req({ frame: topFrame(`bzz://${'a'.repeat(64)}/`) })],
    [
      'ipfs page img',
      req({ method: 'GET', resourceType: 'image', frame: topFrame('ipfs://bafy/') }),
    ],
    ['data: frame', req({ frame: topFrame('data:text/html,<script>fetch()</script>') })],
    ['opaque/sandboxed frame', req({ frame: subFrame('about:srcdoc') })],
    ['cross-site top-level form POST', req({ resourceType: 'mainFrame' })],
    [
      'iframe navigation GET',
      req({ method: 'GET', resourceType: 'subFrame', frame: subFrame('https://evil.example/') }),
    ],
    [
      'websocket',
      req({ url: 'ws://127.0.0.1:1633/pss/subscribe/x', method: 'GET', resourceType: 'webSocket' }),
    ],
    ['service worker (no frame, no webContents)', req({ frame: null, webContents: undefined })],
    [
      'internal page URL in a sub-frame',
      req({ frame: { url: settingsUrl, parent: topFrame('https://evil.example/') } }),
    ],
    [
      'internal-page-looking path outside the app',
      req({ frame: topFrame('file:///home/me/Downloads/pages/settings.html') }),
    ],
    ['chrome URL loaded inside a tab', req({ frame: topFrame(chromeUrl), webContents: webview })],
  ])('%s is cancelled', (_label, details) => {
    expect(guardAntApiRequest(details)).toEqual({ cancel: true });
  });

  test('a frame that throws on access (already gone) fails closed', () => {
    const frame = {
      get url() {
        throw new Error('Render frame was disposed');
      },
      get parent() {
        throw new Error('Render frame was disposed');
      },
    };
    expect(guardAntApiRequest(req({ frame }))).toEqual({ cancel: true });
  });
});

describe('what stays allowed', () => {
  test('a top-level GET navigation typed or clicked by the user', () => {
    expect(
      guardAntApiRequest(
        req({ url: 'http://127.0.0.1:1633/bzz/abc/', method: 'GET', resourceType: 'mainFrame' })
      )
    ).toBeNull();
  });

  test.each([settingsUrl, publishUrl])('Freedom internal page %s', (url) => {
    expect(guardAntApiRequest(req({ method: 'GET', frame: topFrame(url) }))).toBeNull();
  });

  test('the chrome renderer', () => {
    expect(
      guardAntApiRequest(
        req({ method: 'GET', frame: topFrame(chromeUrl), webContents: browserWindow })
      )
    ).toBeNull();
  });

  test('requests that are not to the node pass untouched', () => {
    expect(guardAntApiRequest(req({ url: 'https://example.com/stamps' }))).toBeNull();
    expect(guardAntApiRequest(req({ url: 'http://127.0.0.1:8080/x' }))).toBeNull();
    expect(guardAntApiRequest(req({ url: 'http://93.184.216.34:8080/x' }))).toBeNull();
    expect(guardAntApiRequest(req({ url: `bzz://${'a'.repeat(64)}/x` }))).toBeNull();
  });
});

// R1-M1: the ENS prefetch of a remote external node dials through
// `net.request`, which passes session.webRequest with no frame and no
// webContents (probed in real Electron: `{resourceType: 'other'}`, no
// `webContentsId`, no `frame`) — the same shape as a worker's request.
describe('an announced main-process dial', () => {
  const REMOTE = 'http://ant.example.test:1633';
  const URL_ = `${REMOTE}/bzz/${'a'.repeat(64)}`;
  const mainDial = (over = {}) => ({
    url: URL_,
    method: 'GET',
    resourceType: 'other',
    ...over,
  });

  beforeEach(() => {
    mockGetAntApiUrl.mockReturnValue(REMOTE);
  });

  test('is cancelled until announced, allowed while announced, cancelled after release', () => {
    expect(guardAntApiRequest(mainDial())).toEqual({ cancel: true });
    const release = announceMainProcessAntDial(URL_);
    expect(guardAntApiRequest(mainDial())).toBeNull();
    expect(guardAntApiRequest(mainDial({ method: 'HEAD' }))).toBeNull();
    release();
    release(); // idempotent
    expect(guardAntApiRequest(mainDial())).toEqual({ cancel: true });
  });

  test('two overlapping dials of one URL each hold it open', () => {
    const a = announceMainProcessAntDial(URL_);
    const b = announceMainProcessAntDial(URL_);
    a();
    expect(guardAntApiRequest(mainDial())).toBeNull();
    b();
    expect(guardAntApiRequest(mainDial())).toEqual({ cancel: true });
  });

  // #445 R2-M1: the caller announces the raw string it built; webRequest
  // reports Chromium's canonical URL (the shapes below are the ones a real
  // Electron `net.request` produced; see ant-api-main-dials.js).
  test.each([
    ['a space in the path', `${URL_}/some page.html`, `${URL_}/some%20page.html`],
    ['a fragment', `${URL_}/#section`, `${URL_}/`],
    ['a kept fragment', `${URL_}/#section`, `${URL_}/#section`],
    [
      'characters only Chromium escapes',
      `${URL_}/some page {x}|^\`.html?q=a b`,
      `${URL_}/some%20page%20%7Bx%7D%7C%5E%60.html?q=a%20b`,
    ],
    ['an upper-case host', `http://ANT.example.test:1633/bzz/${'a'.repeat(64)}`, URL_],
  ])('matches the canonical form Chromium reports (%s)', (_label, announced, reported) => {
    const release = announceMainProcessAntDial(announced);
    try {
      expect(guardAntApiRequest(mainDial({ url: reported }))).toBeNull();
    } finally {
      release();
    }
    expect(guardAntApiRequest(mainDial({ url: reported }))).toEqual({ cancel: true });
  });

  test('an escaped slash still names a different path', () => {
    const release = announceMainProcessAntDial(`${URL_}/a/b`);
    try {
      expect(guardAntApiRequest(mainDial({ url: `${URL_}/a%2Fb` }))).toEqual({ cancel: true });
    } finally {
      release();
    }
  });

  test.each([
    ['a POST of the same URL', mainDial({ method: 'POST' })],
    ['a different path on the node', mainDial({ url: `${REMOTE}/stamps/1/17` })],
    ['the same URL from a page frame', mainDial({ frame: topFrame('https://evil.example/') })],
    ['the same URL from a webContents', mainDial({ webContents: webview })],
    ['the same URL with a webContentsId', mainDial({ webContentsId: 7 })],
  ])('%s is still cancelled while the dial is announced', (_label, details) => {
    const release = announceMainProcessAntDial(URL_);
    try {
      expect(guardAntApiRequest(details)).toEqual({ cancel: true });
    } finally {
      release();
    }
  });
});

describe('isAntApiRequestUrl', () => {
  test.each([
    'http://127.0.0.1:1633/stamps',
    'http://localhost:1633/stamps',
    'http://LOCALHOST:1633/stamps',
    'http://localhost.:1633/stamps',
    'http://foo.localhost:1633/stamps',
    'http://[::1]:1633/stamps',
    'http://[0:0:0:0:0:0:0:1]:1633/stamps',
    'http://[::ffff:127.0.0.1]:1633/stamps',
    'http://127.1:1633/stamps',
    'http://2130706433:1633/stamps',
    'http://0x7f000001:1633/stamps',
    'http://127.8.9.10:1633/stamps',
    'http://0.0.0.0:1633/stamps',
    'http://[::]:1633/stamps',
    'https://127.0.0.1:1633/stamps',
    'ws://localhost:1633/pss/subscribe/x',
    'wss://localhost:1633/gsoc/subscribe/x',
    // A DNS name on the node's port may resolve to loopback; this runs
    // before DNS.
    'http://127.0.0.1.nip.io:1633/stamps',
    'http://rebind.example:1633/stamps',
    // R1-F1: a node bound to 0.0.0.0 (a reused / Docker Bee with
    // `-p 1633:1633`) answers on every address of this machine — the docker
    // bridge, link-local, the LAN IP, a public IP — so on the node's port
    // every IP literal is the node too.
    'http://172.17.0.1:1633/stamps/1/17',
    'http://10.0.0.5:1633/',
    'http://192.168.1.20:1633/stamps',
    'http://169.254.1.1:1633/stamps',
    'http://93.184.216.34:1633/stamps',
    'http://[fe80::1]:1633/stamps',
    'http://[2001:db8::1]:1633/stamps',
  ])('%s is the Ant API', (url) => {
    expect(isAntApiRequestUrl(url)).toBe(true);
  });

  test.each([
    'http://127.0.0.1:1634/',
    'http://localhost:8080/',
    'http://example.com/',
    'http://10.0.0.5:8080/',
    'http://172.17.0.1:1634/',
    'ftp://127.0.0.1:1633/',
    'not a url',
  ])('%s is not', (url) => {
    expect(isAntApiRequestUrl(url)).toBe(false);
  });

  test('follows the port the node actually runs on (profile / fallback port)', () => {
    mockGetAntApiUrl.mockReturnValue('http://127.0.0.1:11633');
    expect(isAntApiRequestUrl('http://localhost:11633/wallet')).toBe(true);
  });

  test('keeps every port the node used this session, and the default', () => {
    noteAntApiUrl('http://127.0.0.1:11634');
    mockGetAntApiUrl.mockReturnValue(null); // node stopped
    expect(isAntApiRequestUrl('http://127.0.0.1:11634/wallet')).toBe(true);
    expect(isAntApiRequestUrl('http://127.0.0.1:1633/wallet')).toBe(true);
  });

  test('guards the port before the registry learns it', () => {
    mockGetAntApiUrl.mockReturnValue(null);
    expect(isAntApiRequestUrl('http://127.0.0.1:11700/stamps')).toBe(false);
    noteAntApiUrl('http://127.0.0.1:11700');
    expect(isAntApiRequestUrl('http://127.0.0.1:11700/stamps')).toBe(true);
  });

  test('guards an external node by its exact origin', () => {
    mockGetAntApiUrl.mockReturnValue('http://192.168.1.20:8633');
    expect(isAntApiRequestUrl('http://192.168.1.20:8633/stamps')).toBe(true);
    expect(isAntApiRequestUrl('http://192.168.1.20:8634/stamps')).toBe(false);
    noteAntApiUrl('https://my-node.lan');
    expect(isAntApiRequestUrl('https://my-node.lan/stamps')).toBe(true);
    expect(isAntApiRequestUrl('https://my-node.lan:443/stamps')).toBe(true);
  });

  // R4-M2: the configured spelling of a remote node was the only one guarded.
  test('guards a remote node on a non-shared port by address and by port', () => {
    noteAntApiUrl('http://192.168.1.10:1733');
    mockGetAntApiUrl.mockReturnValue(null);
    const attack = (host) =>
      guardAntApiRequest(
        req({ url: `http://${host}:1733/stamps/1/17`, frame: topFrame('https://evil.test/') })
      );
    expect(attack('192.168.1.10')).toEqual({ cancel: true });
    // The IPv4-mapped IPv6 literal of the same address (no DNS involved).
    expect(attack('[::ffff:c0a8:10a]')).toEqual({ cancel: true });
    // A DNS alias of the same machine: all-hosts on the node's port.
    expect(attack('nas.lan')).toEqual({ cancel: true });
    // Other ports on that machine are not the node.
    expect(isAntApiRequestUrl('http://192.168.1.10:1734/stamps')).toBe(false);
  });

  // R5-M1: the remote node's port used to join the session-sticky set.
  test("a remote node's port stops being all-hosts once the user switches away", () => {
    noteAntApiUrl('http://nas.lan:9000');
    mockGetAntApiUrl.mockReturnValue('http://nas.lan:9000');
    expect(isAntApiRequestUrl('http://other.example:9000/app.js')).toBe(true);
    // Back to the bundled node.
    noteAntApiUrl('http://127.0.0.1:1633');
    mockGetAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    expect(isAntApiRequestUrl('http://other.example:9000/app.js')).toBe(false);
    expect(
      guardAntApiRequest(
        req({ url: 'http://other.example:9000/app.js', method: 'GET', resourceType: 'script' })
      )
    ).toBeNull();
    // The old node's exact origin stays guarded for the session.
    expect(isAntApiRequestUrl('http://nas.lan:9000/stamps')).toBe(true);
    // Switching to a different remote node moves the all-hosts port with it.
    noteAntApiUrl('http://nas.lan:9000');
    noteAntApiUrl('http://192.168.1.10:1733');
    mockGetAntApiUrl.mockReturnValue(null);
    expect(isAntApiRequestUrl('http://other.example:9000/app.js')).toBe(false);
    expect(isAntApiRequestUrl('http://other.example:1733/stamps')).toBe(true);
    // Local ports stay sticky regardless.
    expect(isAntApiRequestUrl('http://172.17.0.1:1633/stamps')).toBe(true);
  });

  test('the live registry URL of a remote node guards its port the same way', () => {
    mockGetAntApiUrl.mockReturnValue('http://192.168.1.10:1733');
    expect(isAntApiRequestUrl('http://[::ffff:c0a8:10a]:1733/stamps')).toBe(true);
    expect(isAntApiRequestUrl('http://nas.lan:1733/stamps')).toBe(true);
  });

  test('a remote node on a shared web port guards its exact origin and mapped spelling only', () => {
    noteAntApiUrl('http://192.168.1.10:8080');
    mockGetAntApiUrl.mockReturnValue('http://192.168.1.10:8080');
    expect(isAntApiRequestUrl('http://192.168.1.10:8080/stamps')).toBe(true);
    expect(isAntApiRequestUrl('http://[::ffff:c0a8:10a]:8080/stamps')).toBe(true);
    // Other sites on 8080 keep working.
    expect(isAntApiRequestUrl('http://intranet.example:8080/app.js')).toBe(false);
    expect(isAntApiRequestUrl('http://192.168.1.11:8080/app.js')).toBe(false);
    // A mapped spelling of a *different* address is not the node.
    expect(isAntApiRequestUrl('http://[::ffff:c0a8:10b]:8080/stamps')).toBe(false);
  });
});

describe('a loopback node on a scheme-default port (#445 R2-F1)', () => {
  test.each([
    ['https://localhost', 'https:', '443'],
    ['http://127.0.0.1', 'http:', '80'],
    ['http://bee.localhost/', 'http:', '80'],
  ])('%s guards loopback on its port, not every website', (apiUrl, scheme) => {
    noteAntApiUrl(apiUrl);
    mockGetAntApiUrl.mockReturnValue(apiUrl);
    const other = scheme === 'https:' ? 'https' : 'http';
    // The node itself, on any loopback spelling, stays guarded.
    expect(isAntApiRequestUrl(`${other}://127.0.0.1/stamps/1/17`)).toBe(true);
    expect(isAntApiRequestUrl(`${other}://localhost/wallet`)).toBe(true);
    expect(guardAntApiRequest(req({ url: `${other}://localhost/stamps/1/17` }))).toEqual({
      cancel: true,
    });
    // Every other site on 80/443 keeps its subresources.
    for (const url of [
      'https://cdn.example.com/app.js',
      'https://news.example/x.css',
      'http://example.org/img.png',
      'wss://chat.example/socket',
    ]) {
      expect(isAntApiRequestUrl(url)).toBe(false);
      expect(guardAntApiRequest(req({ url, method: 'GET', resourceType: 'script' }))).toBeNull();
    }
    // Still true once the node has stopped (the port stays sticky).
    mockGetAntApiUrl.mockReturnValue(null);
    expect(isAntApiRequestUrl('https://cdn.example.com/app.js')).toBe(false);
    expect(isAntApiRequestUrl(`${other}://127.0.0.1/stamps`)).toBe(true);
  });

  test.each(['http://localhost:8080', 'http://127.0.0.1:8000', 'https://localhost:8443'])(
    'a loopback node on a shared HTTP-alternate port (%s) guards loopback only (#445 R3-M1)',
    (apiUrl) => {
      noteAntApiUrl(apiUrl);
      mockGetAntApiUrl.mockReturnValue(apiUrl);
      const { protocol, port } = new URL(apiUrl);
      const at = (host, path) => `${protocol}//${host}:${port}${path}`;
      expect(isAntApiRequestUrl(at('127.0.0.1', '/stamps/1/17'))).toBe(true);
      expect(isAntApiRequestUrl(at('localhost', '/wallet'))).toBe(true);
      expect(guardAntApiRequest(req({ url: at('localhost', '/stamps/1/17') }))).toEqual({
        cancel: true,
      });
      for (const url of [at('intranet.example', '/app.js'), at('192.168.1.1', '/ui.css')]) {
        expect(isAntApiRequestUrl(url)).toBe(false);
        expect(guardAntApiRequest(req({ url, method: 'GET', resourceType: 'script' }))).toBeNull();
      }
      // Sticky after the node stops, same as 80/443.
      mockGetAntApiUrl.mockReturnValue(null);
      expect(isAntApiRequestUrl(at('intranet.example', '/app.js'))).toBe(false);
      expect(isAntApiRequestUrl(at('127.0.0.1', '/stamps'))).toBe(true);
    }
  );

  test('a non-default node port still means every host', () => {
    noteAntApiUrl('http://127.0.0.1:11633');
    expect(isAntApiRequestUrl('http://172.17.0.1:11633/stamps')).toBe(true);
    expect(isAntApiRequestUrl('http://127.0.0.1.nip.io:11633/stamps')).toBe(true);
    // The default port and the bundled node's fallback range stay all-hosts.
    expect(isAntApiRequestUrl('http://172.17.0.1:1633/stamps')).toBe(true);
    noteAntApiUrl('http://127.0.0.1:1643');
    expect(isAntApiRequestUrl('http://192.168.1.5:1643/stamps')).toBe(true);
  });
});

test('isLoopbackHostname', () => {
  expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  expect(isLoopbackHostname('[::ffff:7f00:1]')).toBe(true);
  expect(isLoopbackHostname('[::ffff:0:0]')).toBe(true);
  expect(isLoopbackHostname('[::ffff:a00:1]')).toBe(false);
  expect(isLoopbackHostname('128.0.0.1')).toBe(false);
  expect(isLoopbackHostname('localhost.example')).toBe(false);
  expect(isLoopbackHostname('')).toBe(false);
});

describe('dispatcher wiring', () => {
  afterEach(() => _resetWebRequestHandlers());

  const attach = () => {
    let listener;
    attachWebRequestDispatcher({
      webRequest: { onBeforeRequest: (fn) => (listener = fn) },
    });
    return (details) => new Promise((resolve) => listener(details, resolve));
  };

  test('cancels through the dispatcher, ahead of later handlers', async () => {
    installAntApiGuard();
    const later = jest.fn(() => ({ redirectURL: 'http://127.0.0.1:1633/elsewhere' }));
    registerWebRequestHandler('onBeforeRequest', 'later', later);
    const dispatch = attach();
    await expect(dispatch(req())).resolves.toEqual({ cancel: true });
    expect(later).not.toHaveBeenCalled();
  });

  test('is registered fail-closed: a throw cancels', async () => {
    installAntApiGuard();
    mockGetAntApiUrl.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    const dispatch = attach();
    await expect(dispatch(req({ url: 'http://127.0.0.1:9/x' }))).resolves.toEqual({
      cancel: true,
    });
  });
});

test('index.js installs the guard first, before any session attaches the dispatcher', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const guard = src.indexOf('installAntApiGuard();');
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(src.indexOf('installRequestRewriter();'));
  expect(guard).toBeLessThan(src.indexOf('attachWebRequestDispatcher(defaultSession)'));
  expect(guard).toBeLessThan(src.indexOf('attachWebRequestDispatcher(privateSession'));
});
