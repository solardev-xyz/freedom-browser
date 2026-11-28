/**
 * The ad-block list's default IO on a remote node (freedom-core design 0015,
 * SWM-8; the SWM-6 to SWM-9 plan, PR 8.2): the feed read and each list
 * download go out on the node's transport, as ant-storage-api's reads do
 * (PR 8.1, `ant-storage-api.transport.test.js`, whose way of playing
 * Chromium this follows). What the reads return, and how they fail, is
 * pinned over a loopback node in `update-manager.test.js`.
 *
 * The real Ant backend (`antBackend()`), announcements and Ant API guard,
 * and Chromium's stack as `netGatewayFetch` drives it, over a fake
 * `net.request` (`test/helpers/fake-electron-net.js`) and a default session
 * that answers its proxy and runs the guard as Chromium's `onBeforeRequest`
 * would.
 */

const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  DEFAULTS: { ant: { apiPort: 1633 } },
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'external' }),
}));
jest.mock('../core/dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../settings-store', () => ({ loadSettings: jest.fn(() => ({ adblockEnabled: true })) }));
jest.mock('./service', () => ({
  refreshEngine: jest.fn(() => Promise.resolve()),
  getEnabledFeedCategories: jest.fn(() => ['ads', 'privacy']),
}));

// Chromium, as these tests play it: each `net.request` is handed to
// `mockChromium.onDial` once it is made, with the session it went out on.
const mockChromium = { onDial: null };
const mockDefaultSession = {
  name: 'default',
  proxy: 'DIRECT',
  resolveProxy: jest.fn(async () => mockDefaultSession.proxy),
};
jest.mock('electron', () => {
  const { FakeClientRequest } = jest.requireActual('../../../test/helpers/fake-electron-net');
  return {
    ipcMain: { handle: jest.fn() },
    webContents: { getAllWebContents: () => [] },
    net: {
      request: (options) => {
        const request = new FakeClientRequest(options);
        setImmediate(() => mockChromium.onDial(request, options.session || mockDefaultSession));
        return request;
      },
    },
    session: {
      get defaultSession() {
        return mockDefaultSession;
      },
      fromPartition: () => {
        throw new Error('a read takes no write session');
      },
    },
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Wallet } = require('ethers');
const { emitResponse } = require('../../../test/helpers/fake-electron-net');
const { isMainProcessAntDial } = require('../swarm/ant-api-main-dials');
const {
  guardAntApiRequest,
  noteAntApiUrl,
  _resetAntApiGuardForTests,
} = require('../swarm/ant-api-guard');
const { canonicalManifestForSigning } = require('./update-manifest');
const { runUpdateOnce, _defaultReadFeed, _defaultDownloadBlob } = require('./update-manager');

const REMOTE = 'https://ant.example:1633';
const SOCKS = 'SOCKS5 127.0.0.1:9150';
const OWNER = 'b818ff019bc15bc3dfbdad4ce0ab66a6f74e8f1e';
const TOPIC = '96741f799248290fa67445649f572f1c773238c1f07e2e98643c625370f9bc15';
const FEED_PATH = `/feeds/${OWNER}/${TOPIC}`;
const INDEX_HEADERS = {
  'swarm-feed-index': '0000000000000003',
  'swarm-feed-index-next': '0000000000000004',
};

const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ADS = Buffer.from('||ads.example^\n'.repeat(500));
const PRIV = Buffer.from('||track.example^\n');
const REF_ADS = 'aa'.repeat(32);
const REF_PRIV = 'bb'.repeat(32);

async function signedManifest(version) {
  const entry = (category, listId, ref, bytes) => ({
    category,
    list_id: listId,
    title: listId,
    source_url: 'u',
    license: 'l',
    ref,
    sha256: sha256(bytes),
    bytes: bytes.length,
    rule_count: 1,
  });
  const manifest = {
    schema: 1,
    version,
    generated_at: '2026-07-06T03:00:00Z',
    engines: { adblock_rs: '0.12.3' },
    platforms: {
      desktop: {
        lists: [
          entry('ads', 'easylist', REF_ADS, ADS),
          entry('privacy', 'easyprivacy', REF_PRIV, PRIV),
        ],
      },
      ios: { lists: [] },
    },
  };
  manifest.sig = await SIGNER.signMessage(canonicalManifestForSigning(manifest));
  return manifest;
}

/** Whether the session's Ant guard lets main's frameless `method` to `url` through. */
const guardSends = (method, url) =>
  guardAntApiRequest({ method, url, resourceType: 'other' }) === null;

/**
 * Chromium's side of each dial: the guard, then `answer(dial)`: `{ status,
 * headers, chunks, end }`, or null (no answer at all). `during(dial)` runs
 * while the dial is in flight. Every dial is recorded.
 */
function playChromium({ answer, during } = {}) {
  const dials = [];
  mockChromium.onDial = async (request, ses) => {
    const { method, url } = request.options;
    const dial = {
      method,
      path: url.slice(REMOTE.length),
      on: ses === mockDefaultSession ? 'session' : ses.name,
      proxy: await ses.resolveProxy(url),
      admitted: guardSends(method, url),
      headers: request.sentHeaders,
      request,
    };
    dials.push(dial);
    if (!dial.admitted) {
      request.emit('error', new Error('net::ERR_BLOCKED_BY_CLIENT'));
      return;
    }
    if (during) await during(dial);
    const reply = answer(dial);
    if (reply) dial.response = emitResponse(request, reply);
  };
  return dials;
}

// The node: the manifest at the feed, each list at /bytes, in pieces.
const nodeAnswers = (manifest) => (dial) => {
  if (dial.path === FEED_PATH) {
    const body = Buffer.from(JSON.stringify(manifest));
    return {
      status: 200,
      headers: { 'content-length': String(body.length), ...INDEX_HEADERS },
      chunks: [body.subarray(0, 10), body.subarray(10)],
    };
  }
  const blob = { [`/bytes/${REF_ADS}`]: ADS, [`/bytes/${REF_PRIV}`]: PRIV }[dial.path];
  if (!blob) return { status: 404, statusMessage: 'Not Found', chunks: ['{}'] };
  return { status: 200, chunks: [blob.subarray(0, 100), blob.subarray(100)] };
};

let loopbackFetch;
let root;

beforeEach(() => {
  mockRegistry.url = REMOTE;
  mockDefaultSession.proxy = SOCKS;
  mockChromium.onDial = () => {
    throw new Error('no dial expected');
  };
  _resetAntApiGuardForTests();
  noteAntApiUrl(REMOTE);
  // Node's fetch, which a remote node's reads must never use.
  loopbackFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('no loopback dial expected');
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adblock-remote-'));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a remote node: the feed read and the lists on the default session’s stack', () => {
  test('the feed read: one GET through the proxy, which the guard admits as announced, and only it', async () => {
    const manifest = await signedManifest(3);
    const url = `${REMOTE}${FEED_PATH}`;
    const seen = {};
    const dials = playChromium({
      answer: nodeAnswers(manifest),
      during: () => {
        seen.get = guardSends('GET', url);
        seen.head = guardSends('HEAD', url);
        seen.post = guardSends('POST', url);
        seen.otherPath = guardSends('GET', `${REMOTE}/feeds/${OWNER}/${'00'.repeat(32)}`);
        seen.worker = guardAntApiRequest({ method: 'GET', url, resourceType: 'xhr' }) === null;
      },
    });

    await expect(_defaultReadFeed()).resolves.toEqual(manifest);

    expect(
      dials.map(({ method, path: p, on, proxy, admitted }) => [method, p, on, proxy, admitted])
    ).toEqual([['GET', FEED_PATH, 'session', SOCKS, true]]);
    expect(dials[0].headers).toMatchObject({
      accept: 'application/json, text/plain, */*',
      'accept-encoding': 'identity',
    });
    expect(seen).toEqual({ get: true, head: false, post: false, otherPath: false, worker: false });
    // Released with the dial: the same GET is a page's again.
    expect(isMainProcessAntDial(url, 'GET')).toBe(false);
    expect(guardSends('GET', url)).toBe(false);
    expect(loopbackFetch).not.toHaveBeenCalled();
  });

  test('a list download: one GET through the proxy, announced for its dial, progress on each piece', async () => {
    const url = `${REMOTE}/bytes/${REF_ADS}`;
    let admittedDuring;
    const dials = playChromium({
      answer: nodeAnswers(null),
      during: () => {
        admittedDuring = guardSends('GET', url);
      },
    });
    const progress = jest.fn();

    await expect(
      _defaultDownloadBlob(REF_ADS, { signal: new AbortController().signal, progress })
    ).resolves.toEqual(ADS);

    expect(
      dials.map(({ method, path: p, on, proxy, admitted }) => [method, p, on, proxy, admitted])
    ).toEqual([['GET', `/bytes/${REF_ADS}`, 'session', SOCKS, true]]);
    expect(admittedDuring).toBe(true);
    // The headers, then each of the two pieces.
    expect(progress).toHaveBeenCalledTimes(3);
    expect(guardSends('GET', url)).toBe(false);
    expect(loopbackFetch).not.toHaveBeenCalled();
  });

  test('a whole cycle applies the update, every read through the proxy', async () => {
    const dials = playChromium({ answer: nodeAnswers(await signedManifest(5)) });
    const result = await runUpdateOnce({
      root,
      trustConfigured: true,
      sigAddress: SIGNER.address,
      activate: jest.fn(() => Promise.resolve()),
    });
    expect(result).toEqual({ status: 'applied', version: 5 });
    expect(fs.readFileSync(path.join(root, 'updated', 'easylist.txt'))).toEqual(ADS);
    expect(fs.readFileSync(path.join(root, 'updated', 'easyprivacy.txt'))).toEqual(PRIV);
    expect(dials.map(({ path: p, on, proxy, admitted }) => [p, on, proxy, admitted])).toEqual([
      [FEED_PATH, 'session', SOCKS, true],
      [`/bytes/${REF_ADS}`, 'session', SOCKS, true],
      [`/bytes/${REF_PRIV}`, 'session', SOCKS, true],
    ]);
    for (const dial of dials)
      expect(isMainProcessAntDial(`${REMOTE}${dial.path}`, 'GET')).toBe(false);
    expect(loopbackFetch).not.toHaveBeenCalled();
  });

  test('a feed read the node never answers: the cycle ends at its timeout, the dial aborted and released', async () => {
    const dials = playChromium({ answer: () => null });
    const result = await runUpdateOnce({ root, trustConfigured: true, timeoutMs: 50 });
    expect(result).toEqual({ status: 'feed_unavailable' });
    expect(dials).toHaveLength(1);
    expect(dials[0].request.aborted).toBe(true);
    expect(isMainProcessAntDial(`${REMOTE}${FEED_PATH}`, 'GET')).toBe(false);
  });

  test('a list download that goes quiet mid-body: aborted, and the request let go', async () => {
    const dials = playChromium({
      answer: () => ({ status: 200, chunks: [ADS.subarray(0, 100)], end: false }),
    });
    const controller = new AbortController();
    const progress = jest.fn();
    const downloading = _defaultDownloadBlob(REF_ADS, { signal: controller.signal, progress });
    await new Promise((resolve) => {
      const wait = () => (progress.mock.calls.length >= 2 ? resolve() : setImmediate(wait));
      wait();
    });
    controller.abort(new Error('no progress'));
    await expect(downloading).rejects.toThrow('no progress');
    expect(dials[0].request.aborted).toBe(true);
  });
});
