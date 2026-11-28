/**
 * The agent's Swarm calls on the core's backend (swarm-agent-core.js;
 * freedom-core design 0015, "Methods main calls"; the SWM-6 to SWM-9
 * plan's PR 8.4), against a scripted core client and executor: the params
 * each call sends as `shell`, the parent it opens from `onSent` (its row,
 * params, parts, transport, deadline), its watchdog, the answer read from
 * the typed form, what the core threw thrown with its fields, and the
 * result's charge released. The requests are core/swarm-own-calls.js's
 * (PR 8.3), so a result of `swarm.publish`, `swarm.stamps` or
 * `swarm.upload_status` not exactly in the core's shape, and a parent main
 * can't open, are `CoreError` `internal`. The batch choice over the core's list is
 * swarm-service.js's: for each node's `/stamps`, bee-js's choice (the JS
 * backend's) and this one over the same batches as the core normalizes
 * them pick the same batch, or throw the same error.
 */

const mockNode = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockNode.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('electron-log', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { Bee, Topic } = require('@ethersphere/bee-js');
const { CoreError } = require('../core/service-client');
const { idleWatchdogMs, watchdogMs } = require('../core/core-deadlines');
const { writeTyped } = require('../core/swarm-typed');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const { chooseBatch, createAgentSwarmCore, topicHex } = require('./swarm-agent-core');

const BATCH = 'a1'.repeat(32);
const REFERENCE = 'b2'.repeat(32);
const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OTHER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const NOW = 1_000_000;

const typed = (value) => ({ result_typed: writeTyped(value) });
const thrown = (value) => ({ error_typed: writeTyped(value) });

/**
 * The agent's calls over a scripted client and executor: `answer(method,
 * params)` gives the core's answer (or throws the protocol's error).
 */
function harness(answer, { owner = OWNER, open = null } = {}) {
  const sent = [];
  const opened = [];
  const released = [];
  const closed = [];
  const backend = { url: 'http://127.0.0.1:1633', request: () => {} };
  const client = {
    request: jest.fn(async (method, params, context, options) => {
      sent.push({ method, params, context, options });
      options.onSent?.(9, 2);
      const result = await answer(method, params, options);
      return { result, release: () => released.push(method) };
    }),
  };
  const shell = {
    open: jest.fn((ids, capture) => {
      if (open) open(ids, capture);
      opened.push({ ids, capture });
      return { close: () => closed.push(ids.id) };
    }),
  };
  const core = createAgentSwarmCore({
    coreClient: () => client,
    swarmShell: () => shell,
    nodeBackend: () => backend,
    beeWalletAddress: async () => owner,
    pool: { held: 0 },
    now: () => NOW,
  });
  return { core, client, shell, sent, opened, released, closed, backend };
}

const UPLOAD = { reference: REFERENCE, tag_uid: 7, batch: BATCH, bytes: 5 };

describe('swarm.publish without history', () => {
  test('text up to 64 KiB goes inline, pinned, not deferred, with its type and the given batch', async () => {
    const h = harness(async () => typed(UPLOAD));
    const result = await h.core.publishData('hello', { contentType: 'text/plain', batchId: BATCH });
    expect(h.sent).toHaveLength(1);
    const [{ method, params, context, options }] = h.sent;
    expect(method).toBe('swarm.publish');
    expect(context).toEqual({ caller: 'shell' });
    expect(params).toEqual({
      kind: 'data',
      parts: [{ bytes: 5, base64: Buffer.from('hello').toString('base64') }],
      content_type: 'text/plain',
      batch: BATCH,
      pin: true,
      deferred: false,
    });
    // An idle method: its idle watchdog, no total one, no deadline.
    expect(options.idleWatchdogMs).toBe(idleWatchdogMs('swarm.publish'));
    expect(options.watchdogMs).toBeUndefined();
    expect(options.pool).toBeDefined();
    expect(h.opened).toEqual([
      {
        ids: { generation: 2, id: 9 },
        capture: {
          row: 'swarm.publish:data,file',
          params,
          backend: h.backend,
          signal: options.signal,
          deadlineAt: null,
          // Inline: no part to stream.
          parts: new Map(),
        },
      },
    ]);
    expect(h.closed).toEqual([9]);
    expect(h.released).toEqual(['swarm.publish']);
    // normalizeUploadResult's.
    expect(result).toEqual({
      reference: REFERENCE,
      bzzUrl: `bzz://${REFERENCE}`,
      tagUid: 7,
      batchIdUsed: BATCH,
      bytesSize: 5,
    });
  });

  test('a file past 64 KiB is a part the core pulls; a draft asks for encryption; a tag of 0 is none', async () => {
    const h = harness(async () => typed({ ...UPLOAD, reference: REFERENCE.repeat(2), tag_uid: null, bytes: 70_000 }));
    const bytes = Buffer.alloc(70_000, 1);
    const result = await h.core.publishData(bytes, { name: 'photo.jpg', contentType: 'image/jpeg', batchId: BATCH, encrypt: true });
    expect(h.sent[0].params).toEqual({
      kind: 'data',
      parts: [{ bytes: 70_000, part: 0 }],
      name: 'photo.jpg',
      content_type: 'image/jpeg',
      encrypt: true,
      batch: BATCH,
      pin: true,
      deferred: false,
    });
    const { parts } = h.opened[0].capture;
    expect([...parts.keys()]).toEqual([0]);
    expect(parts.get(0)).toBe(bytes);
    expect(result).toMatchObject({ reference: REFERENCE.repeat(2), tagUid: null, bytesSize: 70_000 });
  });

  test('no batch, no name, no type: left to the core, as publishData leaves them to its defaults', async () => {
    const h = harness(async () => typed(UPLOAD));
    await h.core.publishData('é', {});
    expect(h.sent[0].params).toEqual({
      kind: 'data',
      parts: [{ bytes: 2, base64: Buffer.from('é', 'utf8').toString('base64') }],
      pin: true,
      deferred: false,
    });
  });

  test('a collection: a part per file, in order, deferred, with its index document', async () => {
    const h = harness(async () => typed({ ...UPLOAD, bytes: 9 }));
    const files = [
      { path: 'index.html', bytes: Buffer.from('<p>') },
      { path: 'assets/app.js', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) },
    ];
    await h.core.publishCollection(files, { indexDocument: 'index.html', batchId: BATCH, encrypt: true });
    expect(h.sent[0].params).toEqual({
      kind: 'collection',
      parts: [
        { path: 'index.html', bytes: 3, part: 0 },
        { path: 'assets/app.js', bytes: 6, part: 1 },
      ],
      index_document: 'index.html',
      encrypt: true,
      batch: BATCH,
      pin: true,
      deferred: true,
    });
    expect(h.opened[0].capture.row).toBe('swarm.publish:collection');
    expect([...h.opened[0].capture.parts.entries()]).toEqual([
      [0, files[0].bytes],
      [1, files[1].bytes],
    ]);
  });

  test("what the core threw is thrown with the fields the agent reads; the charge goes back", async () => {
    const capacity = { uploadBytes: 10, requiredBytes: 15, largestRemainingBytes: 4 };
    const h = harness(async () =>
      thrown({ message: 'No postage batch has enough capacity', code: 'POSTAGE_CAPACITY_INSUFFICIENT', capacity })
    );
    const err = await h.core.publishData('x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CoreError);
    expect(err).toMatchObject({ message: 'No postage batch has enough capacity', code: 'POSTAGE_CAPACITY_INSUFFICIENT', capacity });
    expect(h.released).toEqual(['swarm.publish']);
    const node = harness(async () => thrown({ message: 'Bad Request: {"code":400}', status: 400 }));
    await expect(node.core.publishData('x', {})).rejects.toMatchObject({ message: 'Bad Request: {"code":400}', status: 400 });
  });

  test("an answer in another form, or a result not exactly the core's, is the core's fault", async () => {
    const { tag_uid: _tag, ...noTag } = UPLOAD;
    for (const answer of [
      { result: 1 },
      { result_typed: writeTyped(1), error_typed: writeTyped({ message: 'x' }) },
      thrown({ message: 'x', extra: 1 }),
      thrown({ message: 'x', status: '400' }),
      thrown({ message: 'x', capacity: 5 }),
      thrown({ message: 'x', capacity: { uploadBytes: 1 } }),
      thrown({ message: 'x', capacity: { uploadBytes: 10, requiredBytes: 15, largestRemainingBytes: 4, extra: 1 } }),
      thrown({ message: 'x', capacity: { uploadBytes: 10, requiredBytes: 15, largestRemainingBytes: Infinity } }),
      typed({ ...UPLOAD, bytes: '5' }),
      { result_typed: { nonsense: true } },
      // swarm-own-calls.js's strict reader: one member more, one missing,
      // a reference that isn't 64 or 128 lowercase hex, a size below 0.
      typed({ ...UPLOAD, extra: 1 }),
      typed(noTag),
      typed({ ...UPLOAD, reference: REFERENCE.toUpperCase() }),
      typed({ ...UPLOAD, reference: REFERENCE.slice(2) }),
      typed({ ...UPLOAD, bytes: -1 }),
    ]) {
      const h = harness(async () => answer);
      const err = await h.core.publishData('x', {}).catch((e) => e);
      expect(err).toBeInstanceOf(CoreError);
      expect(err.code).toBe('internal');
      expect(h.released).toEqual(['swarm.publish']);
    }
  });

  test('without the core nothing is sent; a parent main cannot open ends the request', async () => {
    const none = createAgentSwarmCore({ coreClient: () => null, swarmShell: () => null });
    await expect(none.publishData('x', {})).rejects.toMatchObject({ code: 'core_unavailable' });
    let signal = null;
    const h = harness(
      async (_m, _p, options) => {
        signal = options.signal;
        throw new CoreError('cancelled', 'cancelled');
      },
      {
        open: () => {
          throw new TypeError('part 0 has no source of its length');
        },
      }
    );
    // swarm-own-calls.js's: the core's calls failing main, `internal`.
    await expect(h.core.publishData('x', {})).rejects.toMatchObject({
      name: 'CoreError',
      code: 'internal',
      message: "The request couldn't be opened for the identity core's calls",
    });
    expect(signal.aborted).toBe(true);
  });

  test('the protocol’s own errors are the client’s', async () => {
    const h = harness(async () => {
      throw new CoreError('busy', 'busy');
    });
    await expect(h.core.publishData('x', {})).rejects.toMatchObject({ name: 'CoreError', code: 'busy' });
  });
});

describe('swarm.upload_status and swarm.stamps', () => {
  test('a tag: normalizeTag’s object, under the swarm deadline, within 10 s', async () => {
    const tag = { tagUid: 7, reference: REFERENCE, split: 4, seen: 0, stored: 4, sent: 4, synced: 4, progress: 100, done: true };
    const h = harness(async () => typed(tag));
    expect(await h.core.getUploadStatus(7)).toEqual(tag);
    const [{ method, params, options }] = h.sent;
    expect([method, params]).toEqual(['swarm.upload_status', { tag_uid: 7 }]);
    expect(options.watchdogMs).toBe(watchdogMs('swarm.upload_status'));
    expect(options.idleWatchdogMs).toBeUndefined();
    expect(h.opened[0].capture).toMatchObject({ row: 'swarm.upload_status', deadlineAt: NOW + 300_000, parts: null });
    expect(options.signal.aborted).toBe(false);
  });

  /** A batch as the core's `swarm.stamps` gives it (fc-swarm-provider `batch_value`). */
  const coreBatch = (fields = {}) => ({
    batchID: BATCH,
    utilization: 0,
    usable: true,
    label: '',
    depth: 22,
    amount: '100000000000',
    bucketDepth: 16,
    blockNumber: 1000,
    immutableFlag: true,
    usage: 0,
    usageText: '0%',
    size: 100,
    remainingSize: 100,
    theoreticalSize: 100,
    duration: 5,
    exists: true,
    batchTTL: 5,
    ...fields,
  });

  test('one batch: swarm.stamps { id }', async () => {
    const batch = coreBatch();
    const h = harness(async () => typed(batch));
    expect(await h.core.getStamp(BATCH)).toEqual(batch);
    expect(h.sent[0].params).toEqual({ id: BATCH });
    expect(h.opened[0].capture.row).toBe('swarm.stamps');
  });

  test("a batch, a list or a tag not exactly in the core's shape is the core's fault", async () => {
    const { duration: _duration, ...noDuration } = coreBatch();
    const tag = { tagUid: 7, split: 4, seen: 0, stored: 4, sent: 4, synced: 4, progress: 100, done: true };
    const { done: _done, ...notDone } = tag;
    const cases = [
      ['getStamp', () => typed(noDuration), (core) => core.getStamp(BATCH)],
      ['getStamp', () => typed(coreBatch({ remainingSize: '100' })), (core) => core.getStamp(BATCH)],
      ['getStamp', () => typed(coreBatch({ batchID: BATCH.toUpperCase() })), (core) => core.getStamp(BATCH)],
      ['selectBestBatch', () => typed([coreBatch(), { batchID: BATCH }]), (core) => core.selectBestBatch(10)],
      ['selectBestBatch', () => typed(coreBatch()), (core) => core.selectBestBatch(10)],
      ['getUploadStatus', () => typed(notDone), (core) => core.getUploadStatus(7)],
      ['getUploadStatus', () => typed({ ...tag, extra: 1 }), (core) => core.getUploadStatus(7)],
    ];
    for (const [, answer, run] of cases) {
      const h = harness(async () => answer());
      await expect(run(h.core)).rejects.toMatchObject({ name: 'CoreError', code: 'internal' });
      expect(h.released).toHaveLength(1);
    }
    const listed = harness(async () => typed([coreBatch({ duration: 9 }), coreBatch({ batchID: 'c3'.repeat(32) })]));
    expect(await listed.core.selectBestBatch(10)).toBe(BATCH);
  });
});

describe('swarm.feed under the Bee wallet key', () => {
  const TOPIC = 'freedom-agent/stable-address/my-site';

  test('the topic is Topic.fromString’s; create, update with min_index, read', async () => {
    expect(topicHex(TOPIC)).toBe(Topic.fromString(TOPIC).toHex());
    expect(topicHex('tópic😀')).toBe(Topic.fromString('tópic😀').toHex());
    const answers = {
      create: { topic: topicHex(TOPIC), owner: OWNER, manifestReference: REFERENCE, bzzUrl: `bzz://${REFERENCE}` },
      update: { index: 3 },
      read: { exists: true, index: 3 },
    };
    const h = harness(async (_m, params) => typed(answers[params.op]));
    const signer = { owner: OWNER };
    expect(await h.core.createFeed(signer, TOPIC, BATCH)).toEqual(answers.create);
    expect(await h.core.updateFeed(signer, TOPIC, REFERENCE, BATCH, { minIndex: 3 })).toEqual({ index: 3 });
    expect(await h.core.updateFeed(signer, TOPIC, REFERENCE, undefined, { minIndex: 0 })).toEqual({ index: 3 });
    expect(await h.core.readFeedState(OWNER.toLowerCase(), TOPIC)).toEqual({ exists: true, index: 3 });
    const key = { kind: 'bee_wallet' };
    const topic = topicHex(TOPIC);
    expect(h.sent.map((s) => s.params)).toEqual([
      { op: 'create', key, topic, batch: BATCH },
      { op: 'update', key, topic, reference: REFERENCE, min_index: 3, batch: BATCH },
      { op: 'update', key, topic, reference: REFERENCE },
      { op: 'read', key, topic },
    ]);
    expect(h.opened.map((o) => o.capture.row)).toEqual([
      'swarm.feed:create',
      'swarm.feed:update',
      'swarm.feed:update',
      'swarm.feed:read',
    ]);
    expect(h.sent.every((s) => s.options.watchdogMs === watchdogMs('swarm.feed'))).toBe(true);
  });

  test('the signer is the Bee wallet’s owner; a locked vault is refused with swarm-signer’s text', async () => {
    const h = harness(async () => typed({}));
    expect(await h.core.feedSigner()).toEqual({ address: OWNER, signer: { owner: OWNER } });
    const locked = harness(async () => typed({}), { owner: null });
    await expect(locked.core.feedSigner()).rejects.toThrow('Vault is locked');
    await expect(locked.core.updateFeed({ owner: OWNER }, TOPIC, REFERENCE)).rejects.toThrow('Vault is locked');
    expect(locked.sent).toEqual([]);
  });

  test('nothing is written for another owner than the signer’s, and a manifest for another owner is refused', async () => {
    const h = harness(async () => typed({}), { owner: OTHER });
    await expect(h.core.updateFeed({ owner: OWNER }, TOPIC, REFERENCE, BATCH)).rejects.toThrow('identity changed');
    await expect(h.core.createFeed({ owner: OWNER }, TOPIC, BATCH)).rejects.toThrow('identity changed');
    await expect(h.core.readFeedState(OWNER, TOPIC)).rejects.toThrow('identity changed');
    expect(h.sent).toEqual([]);
    const moved = harness(async () =>
      typed({ topic: topicHex(TOPIC), owner: OTHER, manifestReference: REFERENCE, bzzUrl: `bzz://${REFERENCE}` })
    );
    await expect(moved.core.createFeed({ owner: OWNER }, TOPIC, BATCH)).rejects.toThrow('identity changed');
  });
});

describe("the batch choice over the core's list is swarm-service.js's", () => {
  const stamp = (id, fields = {}) => ({
    batchID: id.repeat(32),
    utilization: 0,
    usable: true,
    label: '',
    depth: 22,
    amount: '100000000000',
    bucketDepth: 16,
    blockNumber: 1000,
    immutableFlag: true,
    exists: true,
    batchTTL: 864000,
    ...fields,
  });
  let node;
  let stamps = [];
  beforeAll(async () => {
    node = await startFakeHttpNode({
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stamps }));
      },
    });
    mockNode.url = node.origin;
  });
  afterAll(async () => {
    await node?.close();
  });

  /**
   * The batches as the core's `swarm.stamps {}` gives them: bee-js's
   * `mapPostageBatch` (sizes in bytes, the duration in seconds) beside the
   * node's own `exists`, `propagating` and `batchTTL`.
   */
  async function coreList() {
    const mapped = await new Bee(node.origin).stamp.getAll();
    return mapped.map((batch, k) => ({
      batchID: batch.batchID.toHex(),
      usable: batch.usable,
      immutableFlag: batch.immutableFlag,
      remainingSize: batch.remainingSize.toBytes(),
      duration: batch.duration.toSeconds(),
      ...(typeof stamps[k].exists === 'boolean' && { exists: stamps[k].exists }),
      ...(typeof stamps[k].propagating === 'boolean' && { propagating: stamps[k].propagating }),
      batchTTL: stamps[k].batchTTL,
    }));
  }

  const cases = [
    ['the usable batch with room and the longest time', [stamp('a1', { batchTTL: 100 }), stamp('b2', { batchTTL: 900 }), stamp('c3', { batchTTL: 500 })], 1000],
    ['the first of equal times', [stamp('a1'), stamp('b2')], 1000],
    ['room for 1.5 times the upload only', [stamp('a1', { depth: 17, batchTTL: 900 }), stamp('b2', { batchTTL: 100 })], 4_000_000],
    ['a propagating batch when no usable one has room', [stamp('a1', { depth: 17 }), stamp('b2', { usable: false, propagating: true, batchTTL: 50 })], 4_000_000],
    ['never one the node says won’t become usable', [stamp('a1', { usable: false, propagating: false })], 1000],
    ['none usable', [stamp('a1', { usable: false, exists: true })], 1000],
    ['usable, without room', [stamp('a1', { depth: 17 }), stamp('b2', { depth: 17, utilization: 2 })], 4_000_000],
    ['no batch at all', [], 1000],
  ];
  test.each(cases)('%s', async (_name, list, bytes) => {
    stamps = list;
    jest.resetModules();
    const service = require('../swarm/swarm-service');
    for (const requireCapacity of [true, false]) {
      const js = await service.selectBestBatch(bytes, { requireCapacity }).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      const batches = await coreList();
      const core = (() => {
        try {
          return { value: chooseBatch(batches, bytes, { requireCapacity }) };
        } catch (error) {
          return { error };
        }
      })();
      if (js.error) {
        expect(core.error).toBeDefined();
        expect({ message: core.error.message, code: core.error.code, capacity: core.error.capacity }).toEqual({
          message: js.error.message,
          code: js.error.code,
          capacity: js.error.capacity,
        });
      } else {
        expect(core).toEqual(js);
      }
    }
  });
});
