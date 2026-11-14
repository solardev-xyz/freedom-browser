/**
 * The writes on freedom-radicled (freedom-core design 0008, Methods
 * `rad.write` and `rad.unseed`, Writes, Errors; deviation `outcome-unknown`;
 * the radicled step-5 plan's B11).
 *
 * Main's own modules run here, under FREEDOM_RADICLE_BACKEND=service:
 * radicle-manager.js with a real RadicledNode on an in-process fake service
 * (fake-radicled.js), radicle-embedded.js and its service backend,
 * cob-service.js, and the provider's executeRadicleMethod with the real
 * Radicle permission store; for the private windows, main's page path
 * (page-documents.js, page-requests.js, page-radicle.js) in front of them.
 * Only the core is faked: its vault, unlocked, and the seal it answers each
 * start with.
 *
 * - **each code mapped:** every answer the service can give a write, and a
 *   success main can't read, to the provider's error;
 * - **no retry after `outcome_unknown`:** neither an answer nor a crash or a
 *   stop with the write in flight sends it again, across the restart;
 * - **the generation pick:** a write goes to the generation running when it
 *   was admitted, and nowhere else, even when a restart lands between its
 *   pick and its send;
 * - **private windows:** refused before anything is sent.
 */

const fs = require('fs');
const { useSimulatedGrantCore, testPage } = require('../../../test/helpers/simulated-grant-core');
const os = require('os');
const path = require('path');
const { loadMainModule } = require('../../../test/helpers/main-process-test-utils');
const { fakeRadicled } = require('../../../test/helpers/fake-radicled');

const DID = 'did:key:z6MkderivedFromTheVaultMnemonic00000000000000';
const NID = 'z6MkderivedFromTheVaultMnemonic00000000000000';
const ORIGIN = `bzz://${'a'.repeat(64)}`;
const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
const ISSUE_ID = 'a'.repeat(40);
const PATCH_ID = 'b'.repeat(40);
const REVISION_ID = 'd'.repeat(40);
const ID = 'c'.repeat(40);
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});
const OUTCOME_UNKNOWN_TEXT =
  'The Radicle node stopped before confirming this write; it may have been recorded.';
const OUTCOME_UNKNOWN = {
  code: -32603,
  message: OUTCOME_UNKNOWN_TEXT,
  data: { reason: 'outcome_unknown' },
};

/**
 * Each COB write as a page asks for it, and as main sends it: `rad.write`'s
 * `{ op, args }`, today's arguments by name, and today's result.
 */
const WRITES = [
  {
    method: 'radicle_createIssue',
    params: { rid: RID, title: 'Bug', description: 'Steps', labels: ['ui'] },
    sent: {
      op: 'create_issue',
      args: { rid: RID, title: 'Bug', description: 'Steps', labels: ['ui'] },
    },
    result: { id: ID },
  },
  {
    method: 'radicle_commentIssue',
    params: { rid: RID, issueId: ISSUE_ID, body: 'Same here', replyTo: ID },
    sent: {
      op: 'comment_issue',
      args: { rid: RID, issue_id: ISSUE_ID, body: 'Same here', reply_to: ID },
    },
    result: { id: ID },
  },
  {
    method: 'radicle_editIssueState',
    params: { rid: RID, issueId: ISSUE_ID, state: 'solved' },
    sent: { op: 'edit_issue_state', args: { rid: RID, issue_id: ISSUE_ID, state: 'solved' } },
    result: { id: ID, state: 'solved' },
  },
  {
    method: 'radicle_commentPatch',
    params: { rid: RID, patchId: PATCH_ID, revisionId: REVISION_ID, body: 'LGTM' },
    sent: { op: 'comment_patch', args: { rid: RID, revision_id: REVISION_ID, body: 'LGTM' } },
    result: { id: ID },
  },
];

/** The core's vault, unlocked, as the node uses it (core/vault-backend.js). */
function fakeVaultBackend() {
  return {
    status: jest.fn(async () => ({ exists: true, unlocked: true, epoch: null, fingerprint: null })),
    addresses: jest.fn(async () => ({
      user_wallets: [],
      bee_wallet: '0xbee',
      publishers: [],
      radicle: { public_key: '00', did: DID, node_id: NID },
    })),
    sealRadicleKey: jest.fn(async () => ({ ...SEALED })),
    writeNodeIdentity: jest.fn(async () => ({ status: 'installed' })),
    onVaultEvent: jest.fn(() => () => {}),
  };
}

let root;
let saved;
let service;
let nodes;
let manager;
let provider;
let cob;
let embedded;
let permissions;
/**
 * How the fake service answers the next `rad.write` and `rad.unseed`: each
 * a function `(message, child)`, taken in order; with none left, a success.
 * A handler that answers nothing leaves the write in flight.
 */
let writeAnswers;
let unseedAnswers;

/** The `rad.write` and `rad.unseed` requests every process received. */
const sentWrites = () => service.children.flatMap((child) => child.sent('rad.write'));
const sentUnseeds = () => service.children.flatMap((child) => child.sent('rad.unseed'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  if (!predicate()) throw new Error('timed out waiting');
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicle-service-writes-'));
  const home = path.join(root, 'R');
  fs.mkdirSync(home, { recursive: true });
  saved = {
    backend: process.env.FREEDOM_RADICLE_BACKEND,
    data: process.env.FREEDOM_RADICLE_DATA,
    identity: process.env.FREEDOM_IDENTITY_DATA,
    addon: process.env.FREEDOM_RADICLE_ADDON,
  };
  process.env.FREEDOM_RADICLE_BACKEND = 'service';
  process.env.FREEDOM_RADICLE_DATA = home;
  process.env.FREEDOM_IDENTITY_DATA = path.join(root, 'identity');
  // An add-on that must never load.
  process.env.FREEDOM_RADICLE_ADDON = path.join(root, 'no-such', 'libradicle.node');
  writeAnswers = [];
  unseedAnswers = [];
  await load();
});

afterEach(async () => {
  await manager?.stopRadicle();
  manager = null;
  for (const [key, name] of [
    ['backend', 'FREEDOM_RADICLE_BACKEND'],
    ['data', 'FREEDOM_RADICLE_DATA'],
    ['identity', 'FREEDOM_IDENTITY_DATA'],
    ['addon', 'FREEDOM_RADICLE_ADDON'],
  ]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Main's modules over the fake core and the fake service. */
function load() {
  const vault = fakeVaultBackend();
  nodes = [];
  service = fakeRadicled({
    identity: (message, child) =>
      child.result(message.id, { did: DID, nid: NID, ephemeral: false }),
    start: (message, child) =>
      child.result(message.id, { did: DID, nid: NID, alias: message.params?.alias ?? null }),
    write: (message, child) => {
      const answer = writeAnswers.shift();
      if (answer) answer(message, child);
      else child.result(message.id, successFor(message.params.op));
    },
    unseed: (message, child) => {
      const answer = unseedAnswers.shift();
      if (answer) answer(message, child);
      else child.result(message.id, { unseeded: true });
    },
  });
  const nodePath = require.resolve('./radicled-node');
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  loadMainModule(require.resolve('../radicle-manager'), {
    userDataDir: userData,
    extraMocks: {
      [require.resolve('../logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      [require.resolve('../core/vault-backend')]: () => ({ vaultBackend: vault }),
      [require.resolve('../service-grant')]: () => ({ radicleGrantRefusal: () => null }),
      [nodePath]: () => {
        const actual = jest.requireActual(nodePath);
        class TestRadicledNode extends actual.RadicledNode {
          static isAvailable() {
            return true;
          }
          constructor(options) {
            super({
              ...options,
              command: 'freedom-radicled',
              spawn: service.spawn,
              removeStaleSocket: async () => false,
              guard: { blockReason: () => null, block: () => {}, unblock: () => {} },
            });
            nodes.push(this);
          }
        }
        return { ...actual, RadicledNode: TestRadicledNode };
      },
    },
  });
  require('../core/node-identity-guard').setStartupRecovery(null);
  manager = require('../radicle-manager');
  provider = require('./radicle-provider-ipc');
  cob = require('./cob-service');
  embedded = require('../radicle-embedded');
  permissions = require('./radicle-permissions');
  // Connected, with the signing grant, in the identity core's store (design
  // 0012, APB-3).
  return useSimulatedGrantCore({
    radicle: {
      [ORIGIN]: { origin: ORIGIN, connectedAt: 1, lastUsed: 1, signing: true, autoApprove: { node: false, signing: false } },
    },
  });
}

/** The service's success for `op`, as libradicle's writes answer it. */
function successFor(op) {
  return op === 'edit_issue_state' ? { id: ID, state: 'solved' } : { id: ID };
}

async function startNode() {
  await expect(manager.startRadicle()).resolves.toEqual({ status: 'running', error: null });
}

/** A provider method as main's page path runs it, after the user's approval. */
async function run(method, params) {
  try {
    return {
      result: await provider.executeRadicleMethod(method, params, ORIGIN, { approval: 'user' }),
    };
  } catch (error) {
    return { error };
  }
}

/** The live process, and its generation's number. */
const live = () => ({ child: service.children.at(-1), generation: nodes.at(-1).generation });

describe("each code mapped (0008, Errors and Writes; deviation 'outcome-unknown')", () => {
  test("each COB write is rad.write with today's arguments by name, answering today's result", async () => {
    await startNode();
    for (const { method, params, result } of WRITES) {
      await expect(run(method, params)).resolves.toEqual({ result });
    }
    expect(sentWrites().map((message) => message.params)).toEqual(WRITES.map((w) => w.sent));
    // A comment with no reply sends `reply_to: null`; labels default to [].
    await run('radicle_commentIssue', { rid: RID, issueId: ISSUE_ID, body: 'Plain' });
    await run('radicle_createIssue', { rid: RID, title: 'Bare', description: 'No labels' });
    await run('radicle_commentPatch', { rid: RID, patchId: PATCH_ID, body: 'On the first' });
    expect(
      sentWrites()
        .slice(-3)
        .map((message) => message.params)
    ).toEqual([
      {
        op: 'comment_issue',
        args: { rid: RID, issue_id: ISSUE_ID, body: 'Plain', reply_to: null },
      },
      {
        op: 'create_issue',
        args: { rid: RID, title: 'Bare', description: 'No labels', labels: [] },
      },
      // The patch's first revision: its ID.
      { op: 'comment_patch', args: { rid: RID, revision_id: PATCH_ID, body: 'On the first' } },
    ]);
  });

  const refusal = (reason, message) => ({ code: 4900, message, data: { reason } });
  const CODES = [
    ['outcome_unknown', "libradicle's call failed", OUTCOME_UNKNOWN],
    [
      'busy',
      'the write queue is full',
      refusal('busy', 'Radicle is busy, and nothing was written. Try again shortly.'),
    ],
    [
      'stopped',
      'the repository is being repaired',
      refusal('stopped', "Radicle isn't taking writes right now, and nothing was written."),
    ],
    [
      'deadline',
      'past the deadline',
      refusal('deadline', "Radicle didn't start the write in time, and nothing was written."),
    ],
    [
      'quarantined',
      'the repository is quarantined',
      refusal(
        'quarantined',
        "Radicle couldn't repair this repository, so it takes no writes. Nothing was written."
      ),
    ],
    [
      'needs_vault',
      'the node runs with a throwaway key: publishing needs a vault',
      refusal(
        'needs_vault',
        "Radicle is running with a throwaway key and can't publish. Restart Radicle once your identity is set up."
      ),
    ],
    [
      'invalid_argument',
      "the title isn't one Radicle takes",
      {
        code: -32602,
        message: "Radicle refused the write's parameters",
        data: { reason: 'invalid_params' },
      },
    ],
    // libradicle's own text, answered by its category, never as it is.
    [
      'failed',
      `node thread: io error at ${path.join(os.homedir(), 'radicle', 'storage')}`,
      { code: -32603, message: 'the write failed', data: { reason: 'native_failed' } },
    ],
    [
      'not_found',
      'node thread: issue aaaaaa not found',
      { code: -32603, message: 'not found', data: { reason: 'repo_not_found' } },
    ],
    [
      'cancelled',
      'cancelled',
      { code: -32603, message: 'request cancelled', data: { reason: 'native_failed' } },
    ],
    [
      'unknown_method',
      'unknown method',
      { code: -32603, message: 'the write failed', data: { reason: 'native_failed' } },
    ],
    // Past the boundary, only a success is proven: a panic's `internal`, or
    // a code main doesn't know, is outcome_unknown.
    ['internal', 'the write panicked', OUTCOME_UNKNOWN],
    ['something_new', 'a code from a later service', OUTCOME_UNKNOWN],
  ];

  test.each(CODES)(
    '%s answers the provider error main maps it to, for every write',
    async (code, text, expected) => {
      await startNode();
      for (const { method, params } of WRITES) {
        writeAnswers.push((message, child) => child.error(message.id, code, text));
        await expect(run(method, params)).resolves.toEqual({ error: expected });
      }
      // One send each, and none again.
      await sleep(20);
      expect(sentWrites()).toHaveLength(WRITES.length);
    }
  );

  test.each([
    ['an ID that is not a string', { id: 7 }],
    ['no ID', {}],
    ['not an object', 'done'],
  ])("a success main can't read (%s) is outcome_unknown", async (_label, answer) => {
    await startNode();
    writeAnswers.push((message, child) => child.result(message.id, answer));
    await expect(run(WRITES[0].method, WRITES[0].params)).resolves.toEqual({
      error: OUTCOME_UNKNOWN,
    });
    // edit_issue_state answers its state too.
    writeAnswers.push((message, child) => child.result(message.id, { id: ID }));
    await expect(run(WRITES[2].method, WRITES[2].params)).resolves.toEqual({
      error: OUTCOME_UNKNOWN,
    });
  });

  test("radicle_unseed is rad.unseed; outcome_unknown is the same answer, and its other errors the unseed's", async () => {
    await permissions.setAutoApprove(ORIGIN, 'node', true, { page: testPage(ORIGIN) });
    await startNode();
    await expect(run('radicle_unseed', { rid: RID })).resolves.toEqual({
      result: { rid: RID, seeded: false },
    });
    expect(sentUnseeds().map((message) => message.params)).toEqual([{ rid: RID }]);
    unseedAnswers.push((message, child) => child.error(message.id, 'outcome_unknown', 'unknown'));
    await expect(run('radicle_unseed', { rid: RID })).resolves.toEqual({ error: OUTCOME_UNKNOWN });
    unseedAnswers.push((message, child) =>
      child.error(message.id, 'busy', 'the write queue is full')
    );
    await expect(run('radicle_unseed', { rid: RID })).resolves.toEqual({
      error: { code: -32603, message: 'the write failed', data: { reason: 'unseed_failed' } },
    });
    unseedAnswers.push((message, child) => child.result(message.id, { unseeded: 'yes' }));
    await expect(run('radicle_unseed', { rid: RID })).resolves.toEqual({ error: OUTCOME_UNKNOWN });
    expect(sentUnseeds()).toHaveLength(4);
  });
});

describe('no retry after outcome_unknown (0008, Writes: "Main never retries one")', () => {
  test('a crash with the write in flight is outcome_unknown, and the write is not sent again after the restart', async () => {
    await startNode();
    const first = live();
    // The process takes the write, then dies before it answers.
    writeAnswers.push(() => setImmediate(() => first.child.exit(70)));
    await expect(run(WRITES[0].method, WRITES[0].params)).resolves.toEqual({
      error: OUTCOME_UNKNOWN,
    });
    // The crash's restart is a new generation, which gets nothing of it.
    await waitUntil(() => {
      const now = nodes.at(-1).generation;
      return now !== null && now !== first.generation;
    });
    await sleep(50);
    expect(sentWrites()).toHaveLength(1);
    expect(service.children.at(-1).sent('rad.write')).toEqual([]);
    // A new write goes to the new generation.
    await expect(run(WRITES[1].method, WRITES[1].params)).resolves.toEqual({ result: { id: ID } });
    expect(service.children.at(-1).sent('rad.write')).toHaveLength(1);
  });

  test('a stop with the write in flight is outcome_unknown, and the next start sends nothing', async () => {
    await startNode();
    writeAnswers.push(() => {}); // taken, never answered
    const answer = run(WRITES[0].method, WRITES[0].params);
    await waitUntil(() => sentWrites().length === 1);
    await manager.stopRadicle();
    await expect(answer).resolves.toEqual({ error: OUTCOME_UNKNOWN });
    await startNode();
    await sleep(20);
    expect(sentWrites()).toHaveLength(1);
  });

  test('an unseed in flight when the process crashes is outcome_unknown, and not sent again', async () => {
    await permissions.setAutoApprove(ORIGIN, 'node', true, { page: testPage(ORIGIN) });
    await startNode();
    const first = live();
    unseedAnswers.push(() => setImmediate(() => first.child.exit(70)));
    await expect(run('radicle_unseed', { rid: RID })).resolves.toEqual({ error: OUTCOME_UNKNOWN });
    await waitUntil(() => {
      const now = nodes.at(-1).generation;
      return now !== null && now !== first.generation;
    });
    await sleep(50);
    expect(sentUnseeds()).toHaveLength(1);
  });

  test('cob-service answers outcome_unknown as its own error, once, with no second call', async () => {
    await startNode();
    writeAnswers.push((message, child) => child.error(message.id, 'outcome_unknown', 'unknown'));
    const write = jest.spyOn(embedded, 'createIssue');
    await expect(
      cob.createIssue({ rid: RID, title: 'Bug', description: 'Steps' })
    ).rejects.toBeInstanceOf(cob.CobOutcomeUnknownError);
    expect(write).toHaveBeenCalledTimes(1);
    expect(sentWrites()).toHaveLength(1);
  });
});

describe('the generation pick: a write goes to the generation it was admitted on, or nowhere', () => {
  test('a restart between the pick and the send: the write is refused stopped, and the new generation gets nothing', async () => {
    const { RadicleServiceBackend } = require('./radicle-service-backend');
    await startNode();
    const node = nodes.at(-1);
    const first = live();
    // The backend's one caller slot, held: the write waits for it after its pick.
    const backend = new RadicleServiceBackend({ node: () => node, maxOutstanding: 1 });
    const release = await backend.slots.take();
    const pending = backend.write('create_issue', WRITES[0].sent.args);
    // The generation it picked crashes, and the restart's is running.
    first.child.exit(70);
    await waitUntil(() => {
      const now = node.generation;
      return now !== null && now !== first.generation;
    });
    expect(manager.activeRadicleIdentity()).toMatchObject({ did: DID, ephemeral: false });
    release();
    await expect(pending).rejects.toMatchObject({ code: 'stopped' });
    expect(sentWrites()).toEqual([]);
    // A write picked now goes to the running generation.
    await expect(backend.write('create_issue', WRITES[0].sent.args)).resolves.toEqual({ id: ID });
    expect(service.children.at(-1).sent('rad.write')).toHaveLength(1);
  });

  test("the pick is in the guard's run, with its admission check: a restart while the guard waits puts the write on the generation that check saw", async () => {
    await startNode();
    const first = live();
    let letGo;
    const held = new Promise((resolve) => {
      letGo = resolve;
    });
    const picks = [];
    const node = nodes.at(-1);
    const pick = node.writeTarget.bind(node);
    node.writeTarget = () => {
      const target = pick();
      picks.push({ target, identity: manager.activeRadicleIdentity() });
      return target;
    };
    // The page's guard: it waits (a name's resolution, say), then writes.
    const guard = async (write) => {
      await held;
      return write();
    };
    const answer = cob.createIssue(WRITES[0].params, { guard });
    first.child.exit(70);
    await waitUntil(() => {
      const now = node.generation;
      return now !== null && now !== first.generation;
    });
    letGo();
    await expect(answer).resolves.toEqual({ id: ID });
    // Picked once, in the run that saw the restart's generation, and sent there.
    expect(picks).toHaveLength(1);
    expect(picks[0].target.identity).toBe(picks[0].identity);
    expect(first.child.sent('rad.write')).toEqual([]);
    expect(service.children.at(-1).sent('rad.write')).toHaveLength(1);
  });

  test('no generation running: each write is refused before anything is sent', async () => {
    await startNode();
    await manager.stopRadicle();
    for (const { method, params } of WRITES) {
      await expect(run(method, params)).resolves.toEqual({
        error: {
          code: 4900,
          message: 'Radicle node is not running',
          data: { reason: 'node-stopped' },
        },
      });
    }
    // Past the provider's check, the route's own: stopped, nothing sent.
    await expect(embedded.createIssue(RID, 'Bug', 'Steps')).rejects.toMatchObject({
      code: 'stopped',
    });
    await expect(embedded.unseedRepo(RID)).rejects.toMatchObject({ code: 'stopped' });
    expect(sentWrites()).toEqual([]);
    expect(sentUnseeds()).toEqual([]);
  });
});

describe('private windows (R-9, #953): refused before anything is sent', () => {
  const { EventEmitter } = require('events');
  const CHROME_URL = 'file:///app/src/renderer/index.html';
  let nextGuest = 1;
  let nextNonce = 1;

  class Guest extends EventEmitter {
    constructor({ private: isPrivate }) {
      super();
      this.id = nextGuest++;
      this.private = isPrivate;
      this.hostWebContents = { id: 500, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
      this.mainFrame = this.frame('about:blank');
    }

    frame(url) {
      return {
        url,
        frameTreeNodeId: 1000 + this.id,
        processId: 1,
        routingId: this.id,
        detached: false,
        send: jest.fn(),
      };
    }

    isDestroyed() {
      return false;
    }

    getType() {
      return 'webview';
    }

    getURL() {
      return this.mainFrame.url;
    }

    commit(url) {
      this.mainFrame.detached = true;
      this.mainFrame = this.frame(url);
      this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
    }
  }

  /** Main's page path over the real dispatcher, provider and service. */
  function pagePath() {
    const { createPageDocuments } = require('../page/page-documents');
    const { createPageRequests } = require('../page/page-requests');
    const { createRadicleDispatchers } = require('../page/page-radicle');
    const guests = new Map();
    const documents = createPageDocuments({
      isPrivateWebContents: (contents) => contents.private,
      isChromeIndexUrl: (url) => url === CHROME_URL,
      isAgentPage: () => false,
      windowIdOf: () => 1,
      resolveEnsContent: async () => ({ type: 'not_found' }),
    });
    const requests = createPageRequests({
      documents,
      webContentsFromId: (id) => guests.get(id),
      dispatchers: createRadicleDispatchers({ inCustody: () => false }),
      setTimer: () => null,
      clearTimer: () => {},
      chromeWindowOf: () => 1,
      sendToWindow: () => {},
      watchWindow: () => {},
    });
    const tab = (isPrivate) => {
      const guest = new Guest({ private: isPrivate });
      guests.set(guest.id, guest);
      requests.track(guest);
      guest.commit(`${ORIGIN}/app`);
      const event = { sender: guest, senderFrame: guest.mainFrame };
      const nonce = (nextNonce++).toString(16).padStart(32, '0');
      const hello = requests.hello(event, { nonce });
      return {
        hello,
        // A refusal is answered at once, a dispatched request later.
        ask: async (method, params) =>
          requests.request(event, { nonce, provider: 'radicle', method, params }),
      };
    };
    return { tab };
  }

  test("a private window's COB writes and unseed send nothing; a public window's go to the service", async () => {
    await permissions.setAutoApprove(ORIGIN, 'signing', true, { page: testPage(ORIGIN) });
    await permissions.setAutoApprove(ORIGIN, 'node', true, { page: testPage(ORIGIN) });
    await startNode();
    const { tab } = pagePath();
    const privateTab = tab(true);
    expect(privateTab.hello).toMatchObject({ ok: false, reason: 'private' });
    const PRIVATE = { error: { code: 4100, message: 'Unauthorized', data: { reason: 'private' } } };
    for (const { method, params } of WRITES) {
      await expect(privateTab.ask(method, params)).resolves.toEqual(PRIVATE);
    }
    await expect(privateTab.ask('radicle_unseed', { rid: RID })).resolves.toEqual(PRIVATE);
    expect(sentWrites()).toEqual([]);
    expect(sentUnseeds()).toEqual([]);

    // The same requests from a public window reach the service.
    const publicTab = tab(false);
    expect(publicTab.hello).toMatchObject({ ok: true });
    await expect(publicTab.ask(WRITES[0].method, WRITES[0].params)).resolves.toEqual({
      result: { id: ID },
    });
    await expect(publicTab.ask('radicle_unseed', { rid: RID })).resolves.toEqual({
      result: { rid: RID, seeded: false },
    });
    expect(sentWrites()).toHaveLength(1);
    expect(sentUnseeds()).toHaveLength(1);
  });
});
