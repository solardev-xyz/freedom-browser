/**
 * `swarm.publish`'s watchdog (freedom-core design 0015, Deadlines and
 * cancel, D13; SWM-5's calls; the SWM-6 to SWM-9 plan's PR 8.3 and section
 * 5): main's own `swarm.publish`, sent by core/swarm-own-calls.js as
 * freedom://publish sends it, through a real CoreClient against a scripted
 * core (test/helpers/fake-swarm-core.js) on the client's clock, its parent
 * in main's executor (core/swarm-shell.js), its calls dialled to a node on
 * loopback.
 *
 * - **75 s after its last progress:** sent, it is hung 75 s on unless the
 *   core asks something naming it; an ask, and main's answer to it, move it
 *   on by 75 s; so do its part's frames and the core's credit on them, and
 *   each piece of its upload's body main takes.
 * - **315 s for a whole reply:** a whole call's ask gives the core's 300 s
 *   for the node's reply plus the margin, and so does its upload's body
 *   terminal, after which the core waits that long for the node's answer.
 * - **Never held, ended by its answer.**
 * - **The row's insert:** the core's history-store error, answered before
 *   it asked anything naming the publish, is the row's insert failing
 *   (`HistoryInsertError`, which freedom://publish lets reject the invoke);
 *   answered after an ask (here a ready check main refuses), it is a later
 *   write's, the error it was. The executor counts the asks.
 */

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
const mockRegistry = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockRegistry.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => null }));
jest.mock('./dweb-verify', () => ({ dwebVerifier: () => null }));
jest.mock('./naming', () => ({ namingDriver: () => null }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WINDOW, encodeData, encodeEnd } = require('./frame');
const { idleWatchdogMs } = require('./core-deadlines');
const {
  PUBLISH_BODY_END_MS,
  PUBLISH_PROGRESS_MS,
  PUBLISH_WHOLE_CALL_MS,
} = require('./swarm-shell');
const {
  HISTORY_FAILED_MESSAGE,
  HistoryInsertError,
  createSwarmOwnCalls,
} = require('./swarm-own-calls');
const { SwarmIoPool } = require('./swarm-io-pool');
const { antBackend } = require('../swarm/bzz-protocol');
const { fakeClock, startSwarmCore, until } = require('../../../test/helpers/fake-swarm-core');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');

jest.setTimeout(30_000);

const KIB = 1024;
const MIB = 1024 * KIB;
const BATCH = 'c3'.repeat(32);
const REFERENCE = 'ab'.repeat(32);

const calls = {
  stamps: () => ({
    form: 'stamps',
    method: 'GET',
    path: '/stamps',
    query: [],
    headers: [],
    max_bytes: MIB,
    stream: false,
  }),
  bzzFile: (name, bytes) => ({
    form: 'bzz_file',
    method: 'POST',
    path: '/bzz',
    query: [['name', name]],
    headers: [
      ['content-type', 'application/octet-stream'],
      ['swarm-postage-batch-id', BATCH],
      ['swarm-pin', 'true'],
      ['swarm-deferred-upload', 'true'],
    ],
    body: { stream: bytes },
    max_bytes: 65536,
    stream: false,
  }),
};

describe("swarm.publish's watchdog: 75 s after its last progress, 315 s for a whole reply", () => {
  let harness = null;
  let clock = null;
  let log = null;
  let node = null;
  let dir = null;
  const pending = [];

  /**
   * A node on loopback that never answers `/stamps`, and takes an upload's
   * body whole (`uploads`, its bytes) without ever answering it.
   */
  async function silentNode() {
    const uploads = [];
    const started = await startFakeHttpNode({
      handler: (req) => {
        if (req.method !== 'POST') return;
        const seen = { bytes: 0, ended: false };
        uploads.push(seen);
        req.on('data', (chunk) => {
          seen.bytes += chunk.length;
        });
        req.on('end', () => {
          seen.ended = true;
        });
      },
    });
    mockRegistry.url = started.origin;
    return Object.assign(started, { uploads });
  }

  async function start() {
    clock = fakeClock();
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    harness = await startSwarmCore({
      log,
      clock,
      deps: {
        backendKind: () => 'core',
        nodeUrl: () => mockRegistry.url,
        pool: new SwarmIoPool(),
      },
    });
    node = await silentNode();
    return harness;
  }

  /** freedom://publish's calls over the harness. */
  const own = () =>
    createSwarmOwnCalls({
      coreClient: () => harness.client,
      swarmShell: () => harness.shell,
      nodeBackend: () => antBackend(),
      pool: new SwarmIoPool(),
      log,
    });

  /** A picked file of `bytes` bytes, as freedom://publish publishes it, to `batch`. */
  async function publishing({ batch = null, bytes = 10 } = {}) {
    const file = path.join(dir, `picked-${pending.length}.txt`);
    fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
    const answer = own()
      .publish({
        kind: 'file',
        parts: [{ file, size: bytes }],
        name: path.basename(file),
        deferred: true,
        ...(batch && { batch }),
        history: { type: 'file', name: path.basename(file) },
      })
      .then(
        (result) => ({ result }),
        (error) => ({ error })
      );
    pending.push(answer);
    await until(
      () => harness.core().requests('swarm.publish').length === pending.length,
      'the publish'
    );
    const sent = harness.core().requests('swarm.publish').at(-1);
    return { id: sent.id, sent, answer, file };
  }

  /** The publish's watchdog deadline on the client's clock, or undefined once it has none. */
  const deadlineOf = (id) => harness.client.current.idleWatchdogs.get(id)?.deadline;

  /** Whether the client restarted the core for a hung request, and for which. */
  const hung = () =>
    log.error.mock.calls.filter(([text]) => text === '[Core] request hung; restarting the core');

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-watchdog-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (harness) await harness.client.stop();
    harness = null;
    await Promise.all(pending.splice(0));
    await node?.close();
    node = null;
    mockRegistry.url = null;
  });

  test("its bounds are the core's ask bounds plus 0001's margin: 75 s and 315 s", () => {
    expect(PUBLISH_PROGRESS_MS).toBe(75_000);
    expect(PUBLISH_WHOLE_CALL_MS).toBe(315_000);
    expect(PUBLISH_BODY_END_MS).toBe(315_000);
    expect(idleWatchdogMs('swarm.publish')).toBe(PUBLISH_PROGRESS_MS);
  });

  test('sent with its idle watchdog, the params freedom://publish sends, and hung 75 s on with no progress', async () => {
    await start();
    const core = harness.core();
    const p = await publishing();
    expect(p.sent.params).toEqual({
      kind: 'file',
      parts: [{ bytes: 10, part: 0 }],
      name: path.basename(p.file),
      pin: true,
      deferred: true,
      history: { type: 'file', name: path.basename(p.file) },
    });
    expect(p.sent.context).toEqual({ caller: 'shell' });
    expect(deadlineOf(p.id)).toBe(75_000);
    await clock.advance(74_999);
    expect(core.killed).toBeNull();
    await clock.advance(1);
    expect(core.killed).toBe('SIGKILL');
    expect(hung()).toEqual([
      ['[Core] request hung; restarting the core', { method: 'swarm.publish' }],
    ]);
    expect((await p.answer).error.code).toBe('core_unavailable');
  });

  test("an ask naming it, and main's answer, move it on by 75 s: hung 75 s after the last", async () => {
    await start();
    const core = harness.core();
    const p = await publishing();
    // At 60 s the core asks a ready check (the row has none, so main
    // refuses it): the ask and main's answer are progress, due at 135 s.
    await clock.advance(60_000);
    const ready = core.ready(p.id, 'publish');
    await until(() => core.reply(ready), 'the refusal');
    expect(core.reply(ready).error).toMatchObject({ code: 'invalid_argument' });
    expect(deadlineOf(p.id)).toBe(135_000);
    await clock.advance(74_999);
    expect(core.killed).toBeNull();
    await clock.advance(1);
    expect(core.killed).toBe('SIGKILL');
    expect(hung()).toEqual([
      ['[Core] request hung; restarting the core', { method: 'swarm.publish' }],
    ]);
  });

  test('a whole call gives the node 315 s from its ask: no sooner hung, even with the node silent', async () => {
    await start();
    const core = harness.core();
    const p = await publishing();
    // At 10 s the core asks `/stamps`, which the node never answers: due
    // at 325 s, not 85 s.
    await clock.advance(10_000);
    core.api(p.id, calls.stamps());
    await until(() => harness.shell.stats().calls === 1, 'the stamps dial');
    expect(deadlineOf(p.id)).toBe(325_000);
    await clock.advance(314_999);
    expect(core.killed).toBeNull();
    await clock.advance(1);
    expect(core.killed).toBe('SIGKILL');
    expect(hung()).toEqual([
      ['[Core] request hung; restarting the core', { method: 'swarm.publish' }],
    ]);
  });

  test("its part's frames and credit, and its body's pieces, move it on by 75 s; its body's terminal gives the node 315 s", async () => {
    await start();
    const core = harness.core();
    const bytes = 200 * KIB;
    const p = await publishing({ batch: BATCH, bytes });
    // At 30 s the core asks its upload: main asks for the body.
    await clock.advance(30_000);
    const call = core.api(p.id, calls.bzzFile(path.basename(p.file), bytes));
    await until(() => core.bodyFor(call), 'the swarm.body');
    const body = core.bodyFor(call);
    expect(deadlineOf(p.id)).toBe(105_000);
    // At 60 s the body's head; at 100 s the core asks the part: main's head
    // and first window are progress, due at 175 s.
    await clock.advance(30_000);
    core.respond(body.id, { bytes });
    await until(() => deadlineOf(p.id) === 135_000, "the body's head");
    await clock.advance(40_000);
    const part = core.part(p.id, 0);
    await until(() => core.dataOf(part).length === 128 * KIB, 'the first window');
    expect(deadlineOf(p.id)).toBe(175_000);
    // At 170 s the core credits the window it took: the rest and the end
    // go, due at 245 s.
    await clock.advance(70_000);
    core.credit(part, 128 * KIB);
    await until(() => core.terminal(part), "the part's end");
    expect(deadlineOf(p.id)).toBe(245_000);
    // At 240 s the core writes the body, which main takes as the node
    // reads it: due at 315 s; then its terminal: due at 555 s.
    await clock.advance(70_000);
    const data = core.dataOf(part);
    for (let at = 0; at < data.length; ) {
      // Within main's window and credit for the body.
      await until(() => WINDOW + core.creditOf(body.id) > at, "main's credit");
      const n = Math.min(64 * KIB, WINDOW + core.creditOf(body.id) - at, data.length - at);
      core.write(encodeData(body.id, data.subarray(at, at + n)));
      at += n;
    }
    await until(() => node.uploads[0]?.bytes === bytes, 'the body taken');
    expect(deadlineOf(p.id)).toBe(315_000);
    core.write(encodeEnd(body.id));
    await until(() => node.uploads[0].ended, "the body's end");
    await until(() => deadlineOf(p.id) === 555_000, "the body's terminal");
    // The node never answers: no sooner hung than 315 s after the terminal.
    await clock.advance(314_999);
    expect(core.killed).toBeNull();
    await clock.advance(1);
    expect(core.killed).toBe('SIGKILL');
    expect(hung()).toEqual([
      ['[Core] request hung; restarting the core', { method: 'swarm.publish' }],
    ]);
  });

  test('nothing holds it, and its answer ends it', async () => {
    await start();
    const core = harness.core();
    const p = await publishing();
    const release = harness.client.holdWatchdog(harness.client.current.number, p.id);
    await clock.advance(50_000);
    core.respond(p.id, {
      result_typed: {
        object: [
          ['reference', { string: REFERENCE }],
          ['tag_uid', { number: '7' }],
          ['batch', { string: BATCH }],
          ['bytes', { number: '10' }],
        ],
      },
    });
    expect(await p.answer).toEqual({
      result: { reference: REFERENCE, tag_uid: 7, batch: BATCH, bytes: 10 },
    });
    expect(deadlineOf(p.id)).toBeUndefined();
    await clock.advance(3_600_000);
    expect(core.killed).toBeNull();
    release();
    // Another, held from its start, is hung 75 s on all the same.
    const q = await publishing();
    const hold = harness.client.holdWatchdog(harness.client.current.number, q.id);
    await clock.advance(75_000);
    expect(core.killed).toBe('SIGKILL');
    hold();
  });

  describe("the core's history-store error: the row's insert before any ask, a later write's after one", () => {
    const historyFailed = {
      error_typed: { object: [['message', { string: HISTORY_FAILED_MESSAGE }]] },
    };

    test('answered before the core asked anything naming it: a HistoryInsertError', async () => {
      await start();
      const core = harness.core();
      const p = await publishing();
      core.respond(p.id, historyFailed);
      const { error } = await p.answer;
      expect(error).toBeInstanceOf(HistoryInsertError);
      expect(error.message).toBe('The publish history could not be read or written');
      expect(harness.shell.stats().parents).toBe(0);
    });

    test('answered after an ask naming it: the error it was', async () => {
      await start();
      const core = harness.core();
      const p = await publishing();
      const ready = core.ready(p.id, 'publish');
      await until(() => core.reply(ready), 'the refusal');
      core.respond(p.id, historyFailed);
      const { error } = await p.answer;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(HistoryInsertError);
      expect(error.message).toBe(HISTORY_FAILED_MESSAGE);
      // An ask for another request, here the one that ended (a race),
      // names this one not.
      const q = await publishing();
      const other = core.api(p.id, calls.stamps());
      await until(() => core.reply(other), 'the other refusal');
      expect(core.reply(other).error).toMatchObject({ code: 'invalid_argument' });
      core.respond(q.id, historyFailed);
      expect((await q.answer).error).toBeInstanceOf(HistoryInsertError);
    });
  });
});
