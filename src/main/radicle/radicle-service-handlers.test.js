/**
 * The `rad:` and `radapi:` handlers on freedom-radicled (freedom-core design
 * 0008, Main's side, "Reads take admission and cancel", and "JSON results";
 * deviations `rad-admission`, `read-deadline` and `size-caps`; the radicled
 * step-5 plan's B8), main's side of 0008 §Tests first, "The handlers": the
 * production handlers (rad-protocol.js, radicle-api-protocol.js), main's
 * dweb admission and radicle-embedded.js, over a real RadicledNode on an
 * in-process fake service (fake-radicled.js) that answers `rad.read` as the
 * service does, under 0007's credit.
 *
 * - routing: each endpoint is one `rad.read`, with the op and args 0008's
 *   export→route table gives it, streamed into the response; one test per
 *   composed op (`readme_at`, `repo_meta`, `repos_meta`, `issues_page`,
 *   `patches_page`, `node_info`), each admitted through main's dweb
 *   admission, and a 503 when the service's read pool refuses it `busy`;
 * - admission: a slot for the request's whole life, its body included;
 *   admission's 503 when it is full; a request that waits, and one aborted
 *   while it waits; the other callers' slots untouched;
 * - cancel: the page's abort before the head and mid-body sends `cancel`;
 *   a session's close stops its reads; `HEAD` cancels the body after the
 *   head;
 * - a paused reader holds one ring and is never timed out, while a pull
 *   left unanswered for 60 s fails the body;
 * - the service exiting mid-body;
 * - the COB pages fenced during a repair and under quarantine, the file
 *   reads not;
 * - the statuses and texts by the service's code, `rad:`'s fixed texts
 *   (#1050), and private windows' logs;
 * - the raw endpoint (0008, "The blob API", "Ranges", "The raw endpoint";
 *   deviation `blob-api`): one `rad.blob` per request, its range from the
 *   Range header and `head_only` for a HEAD; 200, 206 and 416 with their
 *   headers; the inert types; a HEAD answering as its GET; the visibility
 *   check, admission and cancel as every other path's.
 *
 * The golden vectors on the real binary are the contract suite's handlers
 * (`FREEDOM_RADICLE_CONTRACT_BACKEND=radicled`); the B1 harness replays
 * freedom-core's vectors through the same handlers (radicle-vectors.test.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));
jest.mock('../radicle-manager', () => ({ isDisabledForProfile: jest.fn(() => false) }));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const log = require('../logger');
const embedded = require('../radicle-embedded');
const api = require('../radicle-api-protocol');
const rad = require('./rad-protocol');
const admission = require('../dweb/fetch-admission');
const { runWithPrivateLogContext } = require('../private/private-log-context');
const { RadicledNode } = require('./radicled-node');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');

const KIB = 1024;
const MIB = 1024 * KIB;
/** A data frame's most, and the one ring main keeps per stream (0007). */
const CHUNK = 64 * KIB;
const RING = 128 * KIB;

const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const BARE = RID.slice('rad:'.length);
const OTHER_RID = 'rad:z2M1tqMip5a9U8HJBZG5vnuSL24dC';
const REV = 'a'.repeat(40);
const ISSUE = 'b'.repeat(40);
const PUBLIC = JSON.stringify({ rid: RID, name: 'repo', visibility: { type: 'public' } });
const PRIVATE = JSON.stringify({ rid: RID, name: 'repo', visibility: { type: 'private' } });
const RAD_HEADERS = [
  ['access-control-allow-origin', '*'],
  ['content-type', 'application/json'],
];
const RADAPI_HEADERS = [['content-type', 'application/json']];

/** Lets the pipes and promises run. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** A JSON text of exactly `bytes` bytes: `{"pad":"x…x"}`. */
function jsonOf(bytes) {
  return JSON.stringify({ pad: 'x'.repeat(bytes - '{"pad":""}'.length) });
}

/** What a promise has done so far, without waiting for it. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error })
  );
  return state;
}

let root;
let nodes;
let previousBackend;

beforeAll(() => {
  previousBackend = process.env.FREEDOM_RADICLE_BACKEND;
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
});

afterAll(() => {
  if (previousBackend === undefined) delete process.env.FREEDOM_RADICLE_BACKEND;
  else process.env.FREEDOM_RADICLE_BACKEND = previousBackend;
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-handlers-'));
  nodes = [];
  jest.clearAllMocks();
});

afterEach(async () => {
  jest.useRealTimers();
  embedded.setServiceNodeSource(null);
  for (const node of nodes) await node.stop();
  fs.rmSync(root, { recursive: true, force: true });
  // Every request in a test has given its slot back.
  expect(admission.dwebFetchStats()).toEqual({ active: 0, waiting: 0 });
});

/**
 * A running node whose service answers each `rad.read` through `read(op,
 * args, message, child)` (by default: the repository is public, and
 * nothing else is answered), and each of the script's other methods (`{
 * blob }`) as it says, named to radicle-embedded.js as the service node.
 */
async function running(read = () => {}, script = {}) {
  const service = fakeRadicled({
    ...script,
    read: (message, child) => {
      const { op, args } = message.params;
      if (read(op, args, message, child) === undefined && op === 'repo_info') {
        child.readReply(message.id, PUBLIC);
      }
    },
  });
  const node = new RadicledNode({
    home: path.join(root, 'home'),
    lockDir: path.join(root, 'locks'),
    ownHome: path.join(root, 'radicled-home'),
    keys: {
      status: async () => ({ exists: true, unlocked: true }),
      seal: async () => ({ enc: 'ZW5j', ciphertext: 'Y2lwaGVydGV4dA==' }),
      switchHome: async () => ({ status: 'installed' }),
      onVaultEvent: () => () => {},
    },
    guard: { blockReason: () => null, block() {}, unblock() {} },
    removeStaleSocket: async () => false,
    spawn: service.spawn,
    log: { info() {}, warn() {}, error() {} },
    shellVersion: 'jest',
    // Inert: the node's own timers (its stats poll, the watchdogs, its
    // restarts) never fire.
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  nodes.push(node);
  void node.start();
  await settle();
  expect(node.generation).not.toBeNull();
  embedded.setServiceNodeSource(() => node);
  return { service, child: service.children[0], node };
}

/**
 * A read handler answering by op: a string is the read's JSON text; `{
 * error: [code, message] }` its error; a function is called with `(message,
 * child)`. An op it doesn't list goes unanswered, but `repo_info`, which is
 * public.
 */
function answers(map) {
  return (op, _args, message, child) => {
    if (!Object.hasOwn(map, op)) return undefined;
    const answer = map[op];
    if (typeof answer === 'function') answer(message, child);
    else if (typeof answer === 'string') child.readReply(message.id, answer);
    else child.error(message.id, ...answer.error);
    return true;
  };
}

/** The `rad.read` requests a child got, as `{ op, args }`. */
const reads = (child) => child.sent('rad.read').map((message) => message.params);
/** The read of `op` a child got. */
const readOf = (child, op) => child.sent('rad.read').find((message) => message.params.op === op);

/** A `rad:` request for `path` in the fixture repository. */
function radGet(pathname, { method = 'GET', signal, partition = null } = {}) {
  return rad.handleRadRequest(new Request(`rad://${BARE}${pathname}`, { method, signal }), {
    partition,
  });
}

/** A `radapi:` request for `path`. */
function radapiGet(pathname, { method = 'GET', signal, partition = null } = {}) {
  return api.handleRadicleApiRequest(new Request(`radapi://local${pathname}`, { method, signal }), {
    partition,
  });
}

/** A `rad:` request as onBeforeSendHeaders tags it in `webSession`, and the
 * function that reports it aborted (net::ERR_ABORTED), as webRequest does
 * when its page goes away. */
let nextId = 1;
function tagged(webSession, pathname) {
  const id = nextId++;
  const url = `rad:${BARE}${pathname}`;
  const { requestHeaders } = rad.tagRadRequest(
    { id, url, webContentsId: 7, requestHeaders: {} },
    { session: webSession }
  );
  const response = rad.handleRadRequest(
    { url, method: 'GET', headers: new Headers(requestHeaders) },
    { webSession }
  );
  const abort = () =>
    rad.endRadRequest({ id, url, error: 'net::ERR_ABORTED' }, { session: webSession });
  return { response, abort };
}

/** An answer's status, headers and body text. */
async function answered(response) {
  return {
    status: response.status,
    headers: [...response.headers].map(([name, value]) => [name, value]),
    body: response.body ? await response.text() : null,
  };
}

/** A head of `total` bytes, then `bytes` of them, and nothing more yet. */
function stall(child, id, total, bytes) {
  child.readHead(id, total);
  child.sender.push(id, bytes);
  child.pump();
}

describe('routing: each endpoint is one rad.read, streamed', () => {
  const PAGE = '{"page":[]}';
  // [endpoint, path, the read it sends]
  const RAD_ROUTES = [
    ['repository root (repo_meta, composed)', '', { op: 'repo_meta', args: { rid: RID } }],
    [
      'readme (readme_at, composed)',
      `/readme/${REV}`,
      { op: 'readme_at', args: { rid: RID, revision: REV } },
    ],
    [
      'issues (issues_page, composed)',
      '/issues?status=open&page=2&perPage=5',
      { op: 'issues_page', args: { rid: RID, status: 'open', page: '2', per_page: '5' } },
    ],
    [
      'patches (patches_page, composed), the raw query strings or null',
      '/patches?perPage=abc',
      { op: 'patches_page', args: { rid: RID, status: null, page: null, per_page: 'abc' } },
    ],
    [
      'tree (tree_at)',
      `/tree/${REV}/src/lib`,
      { op: 'tree_at', args: { rid: RID, revision: REV, path: 'src/lib' } },
    ],
    [
      'blob (blob_at)',
      `/blob/${REV}/docs/a%20b.md`,
      { op: 'blob_at', args: { rid: RID, revision: REV, path: 'docs/a b.md' } },
    ],
    [
      'commits (commits), the page bounds as main reads them',
      `/commits?parent=${REV}&page=3&perPage=1000`,
      { op: 'commits', args: { rid: RID, parent: REV, page: 3, per_page: 100 } },
    ],
    ['commit (commit)', `/commits/${REV}`, { op: 'commit', args: { rid: RID, revision: REV } }],
    [
      'stats (repo_stats)',
      `/stats/tree/${REV}`,
      { op: 'repo_stats', args: { rid: RID, revision: REV } },
    ],
    ['remotes (remotes)', '/remotes', { op: 'remotes', args: { rid: RID } }],
    ['issue (issue)', `/issues/${ISSUE}`, { op: 'issue', args: { rid: RID, issue_id: ISSUE } }],
    ['patch (patch)', `/patches/${ISSUE}`, { op: 'patch', args: { rid: RID, patch_id: ISSUE } }],
  ];

  test.each(RAD_ROUTES)(
    'rad: %s: the visibility read, then the route, in one slot held until the body ends',
    async (_name, pathname, route) => {
      const body = jsonOf(3 * CHUNK);
      let held = null;
      const { child } = await running(
        answers({
          [route.op]: (message, c) => {
            held = admission.dwebFetchStats();
            c.readReply(message.id, body);
          },
        })
      );
      const response = await radGet(pathname);
      expect(reads(child)).toEqual([{ op: 'repo_info', args: { rid: RID } }, route]);
      // Admitted once, through the dweb admission, for the request's life.
      expect(held).toEqual({ active: 1, waiting: 0 });
      expect(admission.dwebFetchStats().active).toBe(1);
      expect(await answered(response)).toEqual({ status: 200, headers: RAD_HEADERS, body });
      expect(admission.dwebFetchStats().active).toBe(0);
      expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
      // Nothing was collected but the visibility read, released at once.
      expect(embedded.collectionBudget().held).toBe(0);
    }
  );

  test.each([
    [
      'the listing (repos_meta, composed)',
      '/api/v1/repos',
      { op: 'repos_meta', args: {} },
      'stream',
    ],
    [
      'a repository (repo_meta, composed), no visibility read',
      `/api/v1/repos/${encodeURIComponent(RID)}`,
      { op: 'repo_meta', args: { rid: RID } },
      'stream',
    ],
    [
      'its issues (issues_page, composed)',
      `/api/v1/repos/${encodeURIComponent(RID)}/issues`,
      { op: 'issues_page', args: { rid: RID, status: null, page: null, per_page: null } },
      'stream',
    ],
    [
      'node stats (node_info, composed, collected)',
      '/api/v1/stats',
      { op: 'node_info', args: {} },
      'node_info',
    ],
    ['node health (status, collected)', '/', { op: 'status', args: {} }, 'status'],
  ])('radapi: %s', async (_name, pathname, route, kind) => {
    const texts = {
      stream: PAGE,
      node_info: '{"connected_peers":4,"repos_total":2,"repos_error":null}',
      status: '{"version":"1.2.3","connectedPeers":4}',
    };
    let held = null;
    const { child } = await running(
      answers({
        [route.op]: (message, c) => {
          held = admission.dwebFetchStats();
          c.readReply(message.id, texts[kind]);
        },
      })
    );
    const response = await radapiGet(pathname);
    expect(reads(child)).toEqual([route]);
    expect(held).toEqual({ active: 1, waiting: 0 });
    const expected = {
      stream: PAGE,
      node_info: '{"repos":{"total":2},"peers":{"connected":4}}',
      status: '{"version":"1.2.3","mode":"embedded"}',
    }[kind];
    expect(await answered(response)).toEqual({
      status: 200,
      headers: RADAPI_HEADERS,
      body: expected,
    });
    expect(embedded.collectionBudget().held).toBe(0);
  });

  test.each([
    ['readme_at', `/readme/${REV}`, radGet],
    ['repo_meta', '', radGet],
    ['issues_page', '/issues', radGet],
    ['patches_page', '/patches', radGet],
    ['repos_meta', '/api/v1/repos', radapiGet],
    ['node_info', '/api/v1/stats', radapiGet],
  ])(
    "%s refused busy by the service's read pool: 503, and the slot back",
    async (op, pathname, get) => {
      const { child } = await running(
        answers({ [op]: { error: ['busy', 'the read pool is full'] } })
      );
      const response = await get(pathname);
      expect(readOf(child, op)).toBeDefined();
      const { status, body } = await answered(response);
      expect(status).toBe(503);
      // `rad:` gives main's text; `radapi:` the service's.
      expect(JSON.parse(body)).toEqual({
        error: get === radGet ? 'Radicle is busy; try again' : 'the read pool is full',
      });
    }
  );

  test("main's own refusals send nothing past the visibility read, as today", async () => {
    const { child } = await running();
    for (const [pathname, status, error] of [
      ['/tree/main', 400, 'missing revision'],
      [`/blob/${REV}`, 400, 'missing path'],
      ['/commits?parent=main', 400, 'missing parent revision'],
      [`/commits/${REV}/x`, 400, 'invalid commit path'],
      ['/stats/branch', 400, 'invalid stats path'],
      ['/wiki', 404, 'unsupported endpoint: wiki'],
    ]) {
      const { status: got, body } = await answered(await radGet(pathname));
      expect([got, JSON.parse(body)]).toEqual([status, { error }]);
    }
    expect(new Set(reads(child).map((read) => read.op))).toEqual(new Set(['repo_info']));
    // A HEAD gets the refusal's head.
    const head = await radGet('/tree/main', { method: 'HEAD' });
    expect(head.status).toBe(400);
    expect(head.body).toBeNull();
  });
});

describe('the visibility check', () => {
  test('a private repository answers as one that is not stored, and nothing more is read', async () => {
    const { child } = await running(
      answers({
        repo_info: PRIVATE,
      })
    );
    const missing = await answered(await radGet('/remotes'));
    expect(missing).toEqual({
      status: 404,
      headers: RAD_HEADERS,
      body: '{"error":"repository not found"}',
    });
    expect(reads(child)).toEqual([{ op: 'repo_info', args: { rid: RID } }]);
  });

  test('a repository the node does not have: the same answer', async () => {
    await running(answers({ repo_info: { error: ['not_found', 'repository not found'] } }));
    expect(await answered(await radGet('/remotes'))).toEqual({
      status: 404,
      headers: RAD_HEADERS,
      body: '{"error":"repository not found"}',
    });
  });

  test('radapi: reads private repositories, with no visibility read', async () => {
    const { child } = await running(answers({ remotes: '[]' }));
    const response = await radapiGet(`/api/v1/repos/${encodeURIComponent(RID)}/remotes`);
    expect(await response.text()).toBe('[]');
    expect(reads(child)).toEqual([{ op: 'remotes', args: { rid: RID } }]);
  });
});

describe('admission', () => {
  /** Takes every active slot of the dweb admission; returns their release. */
  async function fillActive() {
    const held = [];
    for (let i = 0; i < admission.MAX_ACTIVE; i++) held.push(await admission.acquireDwebFetch({}));
    return () => {
      for (const slot of held) slot.release();
    };
  }

  test('a full admission: 503 at once for rad: and radapi:, and nothing reaches the service', async () => {
    const { child } = await running(answers({ remotes: '[]' }));
    const releaseActive = await fillActive();
    const waiting = [];
    for (let i = 0; i < admission.MAX_WAITING; i++) waiting.push(admission.acquireDwebFetch({}));
    expect(admission.dwebFetchStats()).toEqual({
      active: admission.MAX_ACTIVE,
      waiting: admission.MAX_WAITING,
    });
    try {
      // rad:'s own refusals keep its `{ code, message }` shape.
      expect(await answered(await radGet('/remotes'))).toEqual({
        status: 503,
        headers: [
          ['access-control-allow-origin', '*'],
          ['content-type', 'application/json; charset=utf-8'],
        ],
        body: JSON.stringify({ code: 503, message: 'Radicle is busy; try again' }),
      });
      expect(await answered(await radapiGet('/api/v1/repos'))).toEqual({
        status: 503,
        headers: RADAPI_HEADERS,
        body: '{"error":"Radicle is busy; try again"}',
      });
      expect(reads(child)).toEqual([]);
    } finally {
      // Each waiter freed as it is granted, so the next gets its turn.
      const freed = waiting.map((granted) => granted.then((slot) => slot.release()));
      releaseActive();
      await Promise.all(freed);
    }
  });

  test('a request waits for a slot, and reads once one is free', async () => {
    const { child } = await running(answers({ remotes: '[]' }));
    const releaseActive = await fillActive();
    const call = track(radGet('/remotes'));
    await settle();
    expect(admission.dwebFetchStats().waiting).toBe(1);
    expect(reads(child)).toEqual([]);
    releaseActive();
    await settle();
    expect(call.settled).toBe(true);
    expect(await call.value.text()).toBe('[]');
  });

  test('a page that goes away while its request waits leaves the queue, and reads nothing', async () => {
    const { child } = await running(answers({ remotes: '[]' }));
    const releaseActive = await fillActive();
    try {
      const web = {};
      const { response, abort } = tagged(web, '/remotes');
      await settle();
      expect(admission.dwebFetchStats().waiting).toBe(1);
      abort();
      const { status, body } = await answered(await response);
      expect(status).toBe(503);
      expect(JSON.parse(body)).toEqual({ code: 503, message: 'request cancelled' });
      expect(admission.dwebFetchStats().waiting).toBe(0);
    } finally {
      releaseActive();
    }
    expect(reads(child)).toEqual([]);
  });

  test("the handlers' reads take none of the other callers' 64 + 64 slots", async () => {
    // Every other caller's slot taken, and their queue full: their reads hang.
    const { child } = await running(answers({ remotes: '[]', status: () => {} }));
    const others = [];
    const controller = new AbortController();
    for (let i = 0; i < 128; i++) {
      others.push(
        embedded.callStream('status', {}, { signal: controller.signal }).catch((err) => err)
      );
    }
    await settle();
    await expect(embedded.callStream('status', {})).rejects.toMatchObject({ code: 'busy' });
    // A handler's read still goes, in its dweb slot.
    expect(await (await radGet('/remotes')).text()).toBe('[]');
    controller.abort();
    await Promise.all(others);
    expect(readOf(child, 'remotes')).toBeDefined();
  });
});

describe('cancel', () => {
  test("the page's abort before the head: cancel goes, 503 for nobody, the slot back", async () => {
    const { child } = await running(answers({ remotes: () => {} }));
    const web = {};
    const { response, abort } = tagged(web, '/remotes');
    await settle();
    expect(readOf(child, 'remotes')).toBeDefined();
    abort();
    const { status, body } = await answered(await response);
    expect([status, JSON.parse(body)]).toEqual([503, { error: 'request cancelled' }]);
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'remotes').id]);
  });

  test("the page's abort mid-body: the body fails, cancel goes, the slot is back", async () => {
    const { child } = await running(
      answers({ commit: (message, c) => c.readReply(message.id, jsonOf(MIB)) })
    );
    const web = {};
    const { response, abort } = tagged(web, `/commits/${REV}`);
    const res = await response;
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    expect((await reader.read()).value.byteLength).toBeLessThanOrEqual(CHUNK);
    expect(admission.dwebFetchStats().active).toBe(1);
    abort();
    await expect(reader.read()).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'commit').id]);
    expect(admission.dwebFetchStats().active).toBe(0);
    expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
  });

  test('radapi: the request signal cancels it mid-body', async () => {
    const { child } = await running(
      answers({ repos_meta: (message, c) => c.readReply(message.id, jsonOf(MIB)) })
    );
    const controller = new AbortController();
    const res = await radapiGet('/api/v1/repos', { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'repos_meta').id]);
  });

  test('a body Chromium cancels (its own cancel) sends cancel and frees the slot', async () => {
    const { child } = await running(
      answers({ commit: (message, c) => c.readReply(message.id, jsonOf(MIB)) })
    );
    const res = await radGet(`/commits/${REV}`);
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'commit').id]);
    expect(admission.dwebFetchStats().active).toBe(0);
  });

  test("a private window's close stops its reads mid-body, and admits nothing more", async () => {
    const partition = `private-test-${nextId++}`;
    const { child } = await running(
      answers({ commit: (message, c) => c.readReply(message.id, jsonOf(MIB)) })
    );
    const res = await radGet(`/commits/${REV}`, { partition });
    const reader = res.body.getReader();
    await reader.read();
    admission.closeDwebSession(partition);
    await expect(reader.read()).rejects.toBeDefined();
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'commit').id]);
    expect(admission.dwebFetchStats().active).toBe(0);
    const after = await answered(await radGet('/remotes', { partition }));
    expect(after.status).toBe(503);
    expect(reads(child).filter((read) => read.op === 'remotes')).toEqual([]);
  });

  test('HEAD: the head, no body; the body is cancelled once the head has come', async () => {
    const { child } = await running(
      answers({
        tree_at: (message, c) => c.readReply(message.id, jsonOf(MIB)),
        repos_meta: '[]',
      })
    );
    const res = await radGet(`/tree/${REV}`, { method: 'HEAD' });
    expect(await answered(res)).toEqual({ status: 200, headers: RAD_HEADERS, body: null });
    await settle();
    expect(child.cancels).toEqual([readOf(child, 'tree_at').id]);
    expect(admission.dwebFetchStats().active).toBe(0);
    expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });

    const listing = await radapiGet('/api/v1/repos', { method: 'HEAD' });
    expect(listing.status).toBe(200);
    expect(listing.body).toBeNull();
  });
});

describe('paused and stalled bodies', () => {
  test('a paused reader holds one ring and its slot, and is never timed out', async () => {
    const body = jsonOf(MIB);
    const { child } = await running(answers({ commit: body }));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const res = await radGet(`/commits/${REV}`);
    const reader = res.body.getReader();
    let total = (await reader.read()).value.byteLength;
    await settle(60);
    // Paused: main buffers one ring, and the service waits for credit.
    const { streams, buffered } = embedded.streamStats();
    expect(streams).toBe(1);
    expect(buffered).toBeLessThanOrEqual(RING);
    expect(child.credited).toBeLessThanOrEqual(2 * CHUNK);
    // Ten minutes asking for nothing: still held, still whole.
    jest.advanceTimersByTime(10 * 60_000);
    await settle();
    expect(admission.dwebFetchStats().active).toBe(1);
    expect(child.cancels).toEqual([]);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(MIB);
    expect(admission.dwebFetchStats().active).toBe(0);
  });

  test('a pull left unanswered for 60 s fails the body as truncated, cancels the read, frees the slot', async () => {
    const { child } = await running(
      answers({ commit: (message, c) => stall(c, message.id, MIB, Buffer.alloc(CHUNK, 0x20)) })
    );
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const res = await radGet(`/commits/${REV}`);
    const reader = res.body.getReader();
    expect((await reader.read()).value.byteLength).toBe(CHUNK);
    const next = track(reader.read());
    await settle();
    jest.advanceTimersByTime(api.BODY_IDLE_MS - 1);
    await settle();
    expect(next.settled).toBe(false);
    jest.advanceTimersByTime(1);
    await settle();
    expect(next.error).toMatchObject({ name: 'BodyIdleError' });
    expect(child.cancels).toEqual([readOf(child, 'commit').id]);
    expect(admission.dwebFetchStats().active).toBe(0);
  });
});

describe('the service exiting', () => {
  test('mid-body: the body fails, the slot is back, and the next read is a 503', async () => {
    const { child } = await running(
      answers({
        commit: (message, c) => {
          stall(c, message.id, MIB, Buffer.alloc(CHUNK, 0x20));
          setImmediate(() => c.exit(70));
        },
      })
    );
    const res = await radGet(`/commits/${REV}`);
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toBeDefined();
    await settle();
    expect(admission.dwebFetchStats().active).toBe(0);
    expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
    expect(child.exited).toBe(true);
    // No generation runs (the node's restart timer is inert here).
    expect(await answered(await radGet('/remotes'))).toEqual({
      status: 503,
      headers: RAD_HEADERS,
      body: '{"error":"the Radicle node is not running"}',
    });
    const radapi = await answered(await radapiGet('/api/v1/repos'));
    expect(radapi.status).toBe(503);
  });

  test('before the head: a 503', async () => {
    await running(answers({ remotes: (message, c) => setImmediate(() => c.exit(70)) }));
    const { status, body } = await answered(await radGet('/remotes'));
    expect([status, JSON.parse(body)]).toEqual([503, { error: 'the Radicle node is not running' }]);
  });
});

describe('the repair fence: the COB pages', () => {
  const COB_PAGES = [
    ['issues_page', '/issues'],
    ['patches_page', '/patches'],
    ['issue', `/issues/${ISSUE}`],
    ['patch', `/patches/${ISSUE}`],
  ];
  const REPAIRING = 'the repository is being repaired';
  const QUARANTINED = `${RID} is quarantined: Radicle couldn't repair it`;

  test.each(COB_PAGES)(
    '%s during a repair: 503, while the file reads answer',
    async (op, pathname) => {
      await running(
        answers({ [op]: { error: ['stopped', REPAIRING] }, tree_at: '{"entries":[]}' })
      );
      for (const get of [
        radGet,
        (p) => radapiGet(`/api/v1/repos/${encodeURIComponent(RID)}${p}`),
      ]) {
        const { status, body } = await answered(await get(pathname));
        expect([status, JSON.parse(body)]).toEqual([503, { error: REPAIRING }]);
      }
      expect((await radGet(`/tree/${REV}`)).status).toBe(200);
    }
  );

  test.each(COB_PAGES)(
    "%s under quarantine: 503, main's text at rad:, the service's at radapi:",
    async (op, pathname) => {
      await running(
        answers({ [op]: { error: ['quarantined', QUARANTINED] }, tree_at: '{"entries":[]}' })
      );
      const page = await answered(await radGet(pathname));
      expect([page.status, JSON.parse(page.body)]).toEqual([
        503,
        { error: "the repository is quarantined: Radicle couldn't repair it" },
      ]);
      const viewer = await answered(
        await radapiGet(`/api/v1/repos/${encodeURIComponent(RID)}${pathname}`)
      );
      expect([viewer.status, JSON.parse(viewer.body)]).toEqual([503, { error: QUARANTINED }]);
      expect((await radGet(`/tree/${REV}`)).status).toBe(200);
    }
  );

  test('a write under way fences them too, with its fixed text', async () => {
    const text = "a write to the repository is under way, and its outcome isn't proven yet";
    await running(answers({ issues_page: { error: ['stopped', text] } }));
    expect(JSON.parse(await (await radGet('/issues')).text())).toEqual({ error: text });
  });
});

describe('statuses and texts', () => {
  // [code, the service's text, status, rad:'s body]
  test.each([
    ['not_found', `revision ${REV} not found`, 404, 'not found'],
    ['failed', 'cached COB id "x": invalid', 500, 'the read failed'],
    // A text that names a path never reaches a page (#1050).
    [
      'failed',
      "failed to resolve path '/home/user/.radicle/storage/z3gq': No such file",
      500,
      'the read failed',
    ],
    [
      'too_large',
      '33554433 bytes is over the limit of 33554432',
      413,
      'repository data too large to serve here',
    ],
    ['deadline', 'past its deadline', 504, 'Radicle read timed out'],
    ['invalid_argument', 'invalid COB id "xyz"', 400, 'invalid request'],
    ['stopped', 'the Radicle service is stopping', 503, 'the Radicle service is stopping'],
    ['stopped', 'some other text', 503, 'the Radicle node is not running'],
    ['internal', 'Internal error', 500, 'the read failed'],
    // libradicle's bound, answered `failed`, keeps today's text.
    [
      'failed',
      'the tree is nested deeper than 64 levels',
      500,
      'repository data too large to serve here',
    ],
  ])('%s (%s): %i', async (code, message, status, publicText) => {
    await running(answers({ commit: { error: [code, message] } }));
    const page = await answered(await radGet(`/commits/${REV}`));
    expect(page).toEqual({
      status,
      headers: RAD_HEADERS,
      body: JSON.stringify({ error: publicText }),
    });
    const viewer = await answered(
      await radapiGet(`/api/v1/repos/${encodeURIComponent(RID)}/commits/${REV}`)
    );
    expect(viewer).toEqual({
      status,
      headers: RADAPI_HEADERS,
      body: JSON.stringify({ error: message }),
    });
  });

  test("readme_at's no readme is main's own 404 text at both", async () => {
    await running(answers({ readme_at: { error: ['not_found', 'no readme'] } }));
    expect(await (await radGet(`/readme/${REV}`)).text()).toBe('{"error":"no readme"}');
    expect(
      await (await radapiGet(`/api/v1/repos/${encodeURIComponent(RID)}/readme/${REV}`)).text()
    ).toBe('{"error":"no readme"}');
  });

  test('the listing: 500 for a failure, as today, and the refusals as they are', async () => {
    let next = ['failed', 'first failure'];
    await running(answers({ repos_meta: (message, c) => c.error(message.id, ...next) }));
    for (const [code, message, status] of [
      ['failed', 'first failure', 500],
      ['not_found', `repository ${OTHER_RID} not found`, 500],
      ['too_large', '16777217 bytes is over the limit of 16777216', 413],
      ['busy', 'the read pool is full', 503],
      ['deadline', 'past its deadline', 504],
    ]) {
      next = [code, message];
      const { status: got, body } = await answered(await radapiGet('/api/v1/repos'));
      expect([got, JSON.parse(body)]).toEqual([status, { error: message }]);
    }
    expect(log.warn).toHaveBeenCalledWith('[radapi] repository listing failed:', 'first failure');
  });

  test('the node endpoints: 503 with the text when status or the count fails, as today', async () => {
    await running(
      answers({
        status: { error: ['failed', 'node thread: the node is not running'] },
        node_info:
          '{"connected_peers":2,"repos_total":null,"repos_error":"16777217 bytes is over the limit of 16777216"}',
      })
    );
    const health = await answered(await radapiGet('/'));
    expect([health.status, JSON.parse(health.body)]).toEqual([
      503,
      { error: 'node thread: the node is not running' },
    ]);
    const stats = await answered(await radapiGet('/api/v1/stats'));
    expect([stats.status, JSON.parse(stats.body)]).toEqual([
      503,
      { error: '16777217 bytes is over the limit of 16777216' },
    ]);
  });

  test("a private window's failures are logged without the RID, the path or the text", async () => {
    const secret = "failed to resolve path '/home/user/.radicle/storage/z3gq'";
    await running(answers({ commit: { error: ['failed', secret] } }));
    const res = await runWithPrivateLogContext(true, () => radGet(`/commits/${REV}`));
    expect(res.status).toBe(500);
    await res.text();
    const lines = log.warn.mock.calls.map((call) => call.join(' '));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(BARE);
      expect(line).not.toContain(REV);
      expect(line).not.toContain('.radicle');
    }
  });

  test('outside a private window, the line names them, as today', async () => {
    await running(answers({ commit: { error: ['failed', 'cached COB id "x": invalid'] } }));
    await (await radGet(`/commits/${REV}`)).text();
    expect(log.warn).toHaveBeenCalledWith(
      '[radapi]',
      RID,
      `/commits/${REV}`,
      '→',
      'cached COB id "x": invalid'
    );
  });
});

describe('the raw endpoint', () => {
  const README = Buffer.from('# Blob fixture\n\nA repository for rad.blob and its ranges.\n');
  const OID = 'e81bcde11d78341d64424c9269816bd85772d234';
  const RAW_PATH = `/raw/${REV}/README.md`;

  /** A raw request for `pathname`: `rad:`'s, or with `api` `radapi:`'s. */
  function raw(pathname, { method = 'GET', range = null, api: viewer = false, signal } = {}) {
    const headers = range ? { Range: range } : {};
    if (viewer) {
      return api.handleRadicleApiRequest(
        new Request(`radapi://local/api/v1/repos/${encodeURIComponent(RID)}${pathname}`, {
          method,
          headers,
          signal,
        })
      );
    }
    return rad.handleRadRequest(
      new Request(`rad://${BARE}${pathname}`, { method, headers, signal })
    );
  }

  /** The `rad.blob` requests a child got. */
  const blobs = (child) => child.sent('rad.blob').map((message) => message.params);

  /** A service whose `rad.blob` serves `bytes` (README.md's by default) as
   * the service does: the range normalized, `head_only` without a body,
   * an unsatisfiable range `range_not_satisfiable` with the size. */
  function serving(bytes = README, oid = OID) {
    return (message, child) => {
      const { range, head_only: headOnly } = message.params;
      const size = bytes.length;
      let span = null;
      if (range) {
        let { start } = range;
        let end = range.end ?? size - 1;
        if ('suffix' in range) {
          if (range.suffix === 0) start = size;
          else start = Math.max(0, size - range.suffix);
          end = size - 1;
        }
        if (start >= size) {
          child.errorWithData(message.id, 'range_not_satisfiable', 'range not satisfiable', {
            size,
          });
          return;
        }
        span = { start, end: Math.min(end, size - 1) };
      }
      const served = span ? bytes.subarray(span.start, span.end + 1) : bytes;
      child.blobReply(
        message.id,
        { oid, size, range: span, body: !headOnly && served.length > 0 },
        headOnly ? Buffer.alloc(0) : served
      );
    };
  }

  /** The headers of a raw answer for `rad:` (`cors`) or `radapi:`. */
  function rawHeaders({ length, type = 'text/plain; charset=utf-8', range = null, cors = true }) {
    const headers = [
      ['accept-ranges', 'bytes'],
      ...(cors
        ? [
            ['access-control-allow-origin', '*'],
            ['access-control-expose-headers', 'Accept-Ranges, Content-Range, ETag'],
          ]
        : []),
      ['cache-control', 'public, max-age=31536000, immutable'],
      ['content-length', String(length)],
      ...(range ? [['content-range', range]] : []),
      ['content-security-policy', 'sandbox'],
      ['content-type', type],
      ['etag', `"${OID}"`],
      ['x-content-type-options', 'nosniff'],
    ];
    return headers;
  }

  test('the whole blob: one rad.blob, 200 with its bytes and the inert headers', async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    const res = await raw(RAW_PATH);
    expect(res.status).toBe(200);
    expect([...res.headers]).toEqual(rawHeaders({ length: README.length }));
    expect(Buffer.from(await res.arrayBuffer()).equals(README)).toBe(true);
    expect(blobs(child)).toEqual([
      { rid: RID, revision: REV, path: 'README.md', range: null, head_only: false },
    ]);
    expect(reads(child)).toEqual([{ op: 'repo_info', args: { rid: RID } }]);
    expect(admission.dwebFetchStats().active).toBe(0);
  });

  test('radapi: serves the viewer the same bytes, with no CORS headers and no visibility read', async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    const res = await raw(RAW_PATH, { api: true });
    expect(res.status).toBe(200);
    expect([...res.headers]).toEqual(rawHeaders({ length: README.length, cors: false }));
    expect(Buffer.from(await res.arrayBuffer()).equals(README)).toBe(true);
    expect(reads(child)).toEqual([]);
  });

  test('a private repository answers rad: as one that is not stored, and reads no blob', async () => {
    const { child } = await running(answers({ repo_info: PRIVATE }), { blob: serving() });
    for (const method of ['GET', 'HEAD']) {
      const res = await answered(await raw(RAW_PATH, { method }));
      expect(res).toEqual({
        status: 404,
        headers: RAD_HEADERS,
        body: method === 'GET' ? JSON.stringify({ error: 'repository not found' }) : null,
      });
    }
    expect(blobs(child)).toEqual([]);
  });

  test('ranges: one bytes= range is sent; 206 with Content-Range and its bytes', async () => {
    const size = README.length;
    const { child } = await running(() => undefined, { blob: serving() });
    const cases = [
      ['bytes=0-9', { start: 0, end: 9 }, 0, 9],
      ['bytes=5-', { start: 5 }, 5, size - 1],
      ['bytes=-10', { suffix: 10 }, size - 10, size - 1],
      [`bytes=5-${size + 1000}`, { start: 5, end: size + 1000 }, 5, size - 1],
    ];
    for (const [header, sent, start, end] of cases) {
      const res = await raw(RAW_PATH, { range: header });
      expect(res.status).toBe(206);
      expect([...res.headers]).toEqual(
        rawHeaders({ length: end - start + 1, range: `bytes ${start}-${end}/${size}` })
      );
      expect(Buffer.from(await res.arrayBuffer())).toEqual(README.subarray(start, end + 1));
      expect(blobs(child).pop().range).toEqual(sent);
    }
  });

  test('several ranges, or one that does not parse, are ignored: the whole blob, 200', async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    for (const header of ['bytes=0-1,4-5', 'bytes=5-2', 'bytes=abc', 'bytes=-', 'items=0-9']) {
      const res = await raw(RAW_PATH, { range: header });
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(README.length);
      expect(blobs(child).pop().range).toBeNull();
    }
  });

  test('a range past the end is 416 with the size, and is not logged', async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    const page = await answered(await raw(RAW_PATH, { range: 'bytes=58-' }));
    expect(page).toEqual({
      status: 416,
      headers: [...RAD_HEADERS, ['content-range', 'bytes */58']].sort(([a], [b]) =>
        a.localeCompare(b)
      ),
      body: JSON.stringify({ error: 'range not satisfiable' }),
    });
    const viewer = await answered(await raw(RAW_PATH, { range: 'bytes=-0', api: true }));
    expect(viewer.status).toBe(416);
    expect(viewer.headers).toContainEqual(['content-range', 'bytes */58']);
    expect(JSON.parse(viewer.body)).toEqual({ error: 'range not satisfiable' });
    expect(blobs(child).map((params) => params.range)).toEqual([{ start: 58 }, { suffix: 0 }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('HEAD: head_only, and the same status and headers as GET, with no body', async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    for (const range of [null, 'bytes=0-9', 'bytes=999999-']) {
      const get = await answered(await raw(RAW_PATH, { range }));
      const head = await answered(await raw(RAW_PATH, { method: 'HEAD', range }));
      expect({ ...head, body: get.body }).toEqual(get);
      expect(head.body).toBeNull();
    }
    expect(blobs(child).map((params) => params.head_only)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(admission.dwebFetchStats().active).toBe(0);
  });

  test('a zero-length blob: 200 with no body; any range is 416', async () => {
    const empty = Buffer.alloc(0);
    const oid = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    await running(() => undefined, { blob: serving(empty, oid) });
    const whole = await raw(`/raw/${REV}/empty.txt`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-length')).toBe('0');
    expect(whole.headers.get('etag')).toBe(`"${oid}"`);
    expect(whole.body).toBeNull();
    const ranged = await raw(`/raw/${REV}/empty.txt`, { range: 'bytes=0-' });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get('content-range')).toBe('bytes */0');
    await ranged.arrayBuffer();
  });

  test('content types come from the inert allowlist, by extension', async () => {
    await running(() => undefined, { blob: serving() });
    const types = {
      'logo.png': 'image/png',
      'photo.JPG': 'image/jpeg',
      'clip.webm': 'video/webm',
      'notes.txt': 'text/plain; charset=utf-8',
      'index.html': 'text/plain; charset=utf-8',
      'icon.svg': 'text/plain; charset=utf-8',
      'app.js': 'text/plain; charset=utf-8',
      'feed.xml': 'text/plain; charset=utf-8',
      Makefile: 'text/plain; charset=utf-8',
      'page.xhtml': 'application/octet-stream',
      'archive.tar.gz': 'application/octet-stream',
      link: 'application/octet-stream',
    };
    for (const [file, type] of Object.entries(types)) {
      const res = await raw(`/raw/${REV}/dir/${file}`);
      expect([file, res.headers.get('content-type')]).toEqual([file, type]);
      await res.arrayBuffer();
    }
  });

  test("a blob over 64 MiB is 413 for GET and HEAD, with main's fixed text on rad:", async () => {
    const message = '67108865 bytes is over the limit of 67108864';
    await running(() => undefined, {
      blob: (msg, child) => child.error(msg.id, 'too_large', message),
    });
    for (const method of ['GET', 'HEAD']) {
      const page = await answered(await raw(`/raw/${REV}/big.bin`, { method }));
      expect(page).toEqual({
        status: 413,
        headers: RAD_HEADERS,
        body:
          method === 'GET'
            ? JSON.stringify({ error: 'repository data too large to serve here' })
            : null,
      });
    }
    const viewer = await answered(await raw(`/raw/${REV}/big.bin`, { api: true }));
    expect([viewer.status, JSON.parse(viewer.body)]).toEqual([413, { error: message }]);
  });

  test("main's own refusals send no rad.blob: a path or revision missing is 400", async () => {
    const { child } = await running(() => undefined, { blob: serving() });
    for (const pathname of [`/raw/${REV}`, `/raw/${REV}/`, '/raw/main/README.md']) {
      const res = await answered(await raw(pathname));
      expect([pathname, res.status, res.body]).toEqual([
        pathname,
        400,
        JSON.stringify({ error: 'missing path' }),
      ]);
    }
    expect(blobs(child)).toEqual([]);
  });

  test('a head unlike the design, or a body longer than its head, fails the read', async () => {
    const { child } = await running(() => undefined, {
      blob: (message, c) => {
        if (message.params.path === 'bad-head') {
          c.blobReply(message.id, { oid: 'nope', size: 3, range: null }, Buffer.from('abc'));
        } else {
          c.blobReply(
            message.id,
            { oid: OID, size: 3, range: null, body: true },
            Buffer.from('abcdef')
          );
        }
      },
    });
    const bad = await answered(await raw(`/raw/${REV}/bad-head`));
    expect([bad.status, JSON.parse(bad.body)]).toEqual([500, { error: 'the read failed' }]);
    const long = await raw(`/raw/${REV}/long`);
    expect(long.status).toBe(200);
    expect(long.headers.get('content-length')).toBe('3');
    await expect(long.arrayBuffer()).rejects.toBeDefined();
    await settle();
    expect(admission.dwebFetchStats().active).toBe(0);
    expect(blobs(child)).toHaveLength(2);
  });

  test("the page's abort mid-body: the body fails, cancel goes, the slot is back", async () => {
    const big = Buffer.alloc(MIB, 7);
    const { child } = await running(() => undefined, { blob: serving(big) });
    const controller = new AbortController();
    const res = await raw(`/raw/${REV}/big.bin`, { api: true, signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body.getReader();
    expect((await reader.read()).value.byteLength).toBeLessThanOrEqual(CHUNK);
    expect(admission.dwebFetchStats().active).toBe(1);
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await settle();
    expect(child.cancels).toEqual([child.sent('rad.blob')[0].id]);
    expect(admission.dwebFetchStats().active).toBe(0);
    expect(embedded.streamStats()).toEqual({ streams: 0, buffered: 0 });
  });
});
