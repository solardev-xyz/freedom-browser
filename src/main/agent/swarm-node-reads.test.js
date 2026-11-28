/**
 * The agent's node reads on both Swarm backends (freedom-core design 0015,
 * "Every bee-js call, mapped"; the SWM-6 to SWM-9 plan's PR 8.4), against
 * one node on loopback: `GET /batches/<id>`, `GET /chainstate` and `GET
 * /bytes/<reference>` read by bee-js 13.2.0 (`stamp.getGlobal`,
 * `status.getChainState`, `data.download`: the JS backend's) and by
 * swarm-node-reads.js over ant-storage-api.js's transport (the core's
 * backend's) give the same values, or both throw. For a reply outside 2xx,
 * a body that isn't JSON and a connection the node drops, both throw the
 * same text with the same status; for a 2xx reply bee-js's schema refuses,
 * both throw.
 */

const mockNode = { url: null };
jest.mock('../service-registry', () => ({
  MODE: { BUNDLED: 'bundled', EXTERNAL: 'external', REUSED: 'reused' },
  getAntApiUrl: () => mockNode.url,
  getService: () => ({ mode: 'bundled' }),
}));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { Bee } = require('@ethersphere/bee-js');
const { startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const reads = require('./swarm-node-reads');

const BATCH = 'ab'.repeat(32);
const OWNER = 'cd'.repeat(20);
const REFERENCE = 'ef'.repeat(32);
const ENCRYPTED = 'ef'.repeat(64);

const GLOBAL = {
  batchID: BATCH,
  batchTTL: 864000,
  bucketDepth: 16,
  depth: 22,
  immutable: true,
  owner: OWNER,
  start: 80,
  value: '100000000000',
};
const CHAIN = { block: 100, chainTip: 101, totalAmount: '123456789', currentPrice: '28000' };

let node;
let bee;
// What the node answers each path with: `{ status, body, headers }`, or `{ drop: true }`.
const answers = new Map();

beforeAll(async () => {
  node = await startFakeHttpNode({
    handler: (req, res) => {
      const { pathname } = new URL(req.url, 'http://node');
      const answer = answers.get(pathname) ?? { status: 404, body: { code: 404, message: 'Not Found' } };
      if (answer.drop) {
        req.socket.destroy();
        return;
      }
      if (answer.cut) {
        // A body cut off midway: 64 KiB of the 1 MiB it declared.
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 1024 * 1024 });
        res.write(Buffer.alloc(64 * 1024, 1), () => setTimeout(() => req.socket.destroy(), 20));
        return;
      }
      const text =
        answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
      const body = Buffer.isBuffer(answer.raw) ? answer.raw : Buffer.from(text);
      res.writeHead(answer.status, { 'content-type': 'application/json', 'content-length': body.length, ...answer.headers });
      res.end(body);
    },
  });
  mockNode.url = node.origin;
  bee = new Bee(node.origin);
});

afterAll(async () => {
  await node?.close();
});

beforeEach(() => {
  answers.clear();
  node.requests.length = 0;
});

const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

/** bee-js's batch, its ID and owner as the hex their classes hold. */
const plainBatch = (batch) => ({ ...batch, batchID: batch.batchID.toHex(), owner: batch.owner.toHex() });

/**
 * Runs `js` (bee-js) and then `core` (swarm-node-reads.js) against the
 * same answer; each side's outcome and the paths it asked.
 */
async function bothBackends(js, core) {
  const jsOut = await settle(js());
  const jsPaths = node.requests.splice(0).map((r) => `${r.method} ${r.url}`);
  const coreOut = await settle(core());
  const corePaths = node.requests.splice(0).map((r) => `${r.method} ${r.url}`);
  return { js: jsOut, core: coreOut, jsPaths, corePaths };
}

/** The two outcomes agree: equal values, or both thrown (with `sameText`, the same text and status). */
function expectSame({ js, core, jsPaths, corePaths }, { sameText = true } = {}) {
  expect(corePaths).toEqual(jsPaths);
  if (js.error) {
    expect(core.error).toBeInstanceOf(Error);
    expect(core.value).toBeUndefined();
    if (sameText) {
      expect(core.error.message).toBe(js.error.message);
      expect(core.error.status).toBe(js.error.status);
    }
    return;
  }
  expect(core.error).toBeUndefined();
  expect(core.value).toEqual(js.value);
}

describe('GET /batches/<id>: bee-js stamp.getGlobal and the transport agree', () => {
  const ok = (body) => ({ status: 200, body });
  const cases = [
    ['the node’s batch', ok(GLOBAL), true],
    ['extra members dropped', ok({ ...GLOBAL, usable: true, label: 'x' }), true],
    ['an ID and owner with 0x, in capitals', ok({ ...GLOBAL, batchID: `0x${BATCH.toUpperCase()}`, owner: `0x${OWNER.toUpperCase()}` }), true],
    ['start 0 and an expired batch', ok({ ...GLOBAL, start: 0, batchTTL: 0 }), true],
    ['a negative value string', ok({ ...GLOBAL, value: '-5' }), true],
    ['no owner', ok({ ...GLOBAL, owner: undefined }), false],
    ['a short owner', ok({ ...GLOBAL, owner: OWNER.slice(2) }), false],
    ['a batch ID that is not hex', ok({ ...GLOBAL, batchID: `zz${BATCH.slice(2)}` }), false],
    ['a value that is not an integer string', ok({ ...GLOBAL, value: '1.5' }), false],
    ['a value as a number', ok({ ...GLOBAL, value: 5 }), false],
    ['batchTTL as a string', ok({ ...GLOBAL, batchTTL: '5' }), false],
    ['batchTTL past a double (JSON 1e400)', { status: 200, body: JSON.stringify(GLOBAL).replace('864000', '1e400') }, false],
    ['immutable as a number', ok({ ...GLOBAL, immutable: 1 }), false],
    ['an array', ok([GLOBAL]), false],
    ['null', ok('null'), false],
    ['an empty body', { status: 200, body: '' }, false],
  ];
  test.each(cases)('%s', async (_name, answer, valid) => {
    answers.set(`/batches/${BATCH}`, answer);
    const outcome = await bothBackends(
      async () => plainBatch(await bee.stamp.getGlobal(BATCH)),
      () => reads.getGlobalBatch(BATCH)
    );
    expect(Boolean(outcome.js.value)).toBe(valid);
    expectSame(outcome, { sameText: false });
  });

  test.each([
    ['a 404 with the node’s JSON', { status: 404, body: { code: 404, message: 'batch not found' } }],
    ['a 500 with text', { status: 500, body: 'internal failure' }],
    ['a 503 with nothing', { status: 503, body: '' }],
    ['a 2xx that is not JSON', { status: 200, body: '{"batchID":' }],
    ['a dropped connection', { drop: true }],
  ])('%s: the same text and status', async (_name, answer) => {
    answers.set(`/batches/${BATCH}`, answer);
    const outcome = await bothBackends(
      async () => plainBatch(await bee.stamp.getGlobal(BATCH)),
      () => reads.getGlobalBatch(BATCH)
    );
    expect(outcome.js.error).toBeTruthy();
    expectSame(outcome);
  });

  test('an ID given with 0x and capitals asks for the lowercase hex; one that is not an ID dials nothing', async () => {
    answers.set(`/batches/${BATCH}`, { status: 200, body: GLOBAL });
    const outcome = await bothBackends(
      async () => plainBatch(await bee.stamp.getGlobal(`0x${BATCH.toUpperCase()}`)),
      () => reads.getGlobalBatch(`0x${BATCH.toUpperCase()}`)
    );
    expect(outcome.jsPaths).toEqual([`GET /batches/${BATCH}`]);
    expectSame(outcome);
    const refused = await bothBackends(
      () => bee.stamp.getGlobal('ab'),
      () => reads.getGlobalBatch('ab')
    );
    expect(refused.jsPaths).toEqual([]);
    expectSame(refused, { sameText: false });
  });
});

describe('GET /chainstate: bee-js status.getChainState and the transport agree', () => {
  const ok = (body) => ({ status: 200, body });
  const cases = [
    ['the chain’s state', ok(CHAIN), true],
    ['with minimumValidityBlocks', ok({ ...CHAIN, minimumValidityBlocks: 17280 }), true],
    ['a price below the floor', ok({ ...CHAIN, currentPrice: '23999' }), true],
    ['a price that is not a number', ok({ ...CHAIN, currentPrice: 'abc' }), true],
    ['a fractional price', ok({ ...CHAIN, currentPrice: '24000.5' }), true],
    ['an empty price', ok({ ...CHAIN, currentPrice: '' }), true],
    ['extra members dropped', ok({ ...CHAIN, reserve: 3 }), true],
    ['minimumValidityBlocks null', ok({ ...CHAIN, minimumValidityBlocks: null }), false],
    ['a total that is not an integer string', ok({ ...CHAIN, totalAmount: 'x' }), false],
    ['no chain tip', ok({ ...CHAIN, chainTip: undefined }), false],
    ['the block as a string', ok({ ...CHAIN, block: '100' }), false],
    ['the price as a number', ok({ ...CHAIN, currentPrice: 28000 }), false],
    ['an empty body', { status: 200, body: '' }, false],
  ];
  test.each(cases)('%s', async (_name, answer, valid) => {
    answers.set('/chainstate', answer);
    const outcome = await bothBackends(() => bee.status.getChainState(), () => reads.getChainState());
    expect(Boolean(outcome.js.value)).toBe(valid);
    expectSame(outcome, { sameText: false });
  });

  test.each([
    ['a 503 with the node’s JSON', { status: 503, body: { code: 503, message: 'syncing' } }],
    ['a 500 with pretty JSON', { status: 500, body: '{\n  "code": 500,\n  "message": "x"\n}' }],
    ['a dropped connection', { drop: true }],
  ])('%s: the same text and status', async (_name, answer) => {
    answers.set('/chainstate', answer);
    const outcome = await bothBackends(() => bee.status.getChainState(), () => reads.getChainState());
    expect(outcome.js.error).toBeTruthy();
    expectSame(outcome);
  });
});

describe('GET /bytes/<reference>: bee-js data.download and the transport agree on reachability', () => {
  const download = (reference) => async () => {
    await bee.data.download(reference);
    return true;
  };

  test('the whole body, 2 MiB, read and dropped; an encrypted reference; an empty body', async () => {
    answers.set(`/bytes/${REFERENCE}`, { status: 200, raw: Buffer.alloc(2 * 1024 * 1024, 7) });
    expectSame(await bothBackends(download(REFERENCE), () => reads.verifyReachable(REFERENCE)));
    answers.set(`/bytes/${ENCRYPTED}`, { status: 200, raw: Buffer.from('x') });
    expectSame(await bothBackends(download(ENCRYPTED), () => reads.verifyReachable(ENCRYPTED)));
    answers.set(`/bytes/${REFERENCE}`, { status: 200, raw: Buffer.alloc(0) });
    const empty = await bothBackends(download(REFERENCE), () => reads.verifyReachable(REFERENCE));
    expect(empty.core.value).toBe(true);
    expectSame(empty);
  });

  test('a body cut off midway is no retrieval on either', async () => {
    answers.set(`/bytes/${REFERENCE}`, { cut: true });
    const outcome = await bothBackends(download(REFERENCE), () => reads.verifyReachable(REFERENCE));
    expect(outcome.js.error).toBeTruthy();
    expectSame(outcome, { sameText: false });
  });

  test.each([
    ['a 404 with the node’s JSON', { status: 404, body: { code: 404, message: 'Not Found' } }],
    ['a 500 with text', { status: 500, body: 'retrieval failed' }],
    ['a dropped connection', { drop: true }],
  ])('%s: the same text and status', async (_name, answer) => {
    answers.set(`/bytes/${REFERENCE}`, answer);
    const outcome = await bothBackends(download(REFERENCE), () => reads.verifyReachable(REFERENCE));
    expect(outcome.js.error).toBeTruthy();
    expectSame(outcome);
  });

  test('a reference that is not one dials nothing', async () => {
    await expect(reads.verifyReachable('ab')).rejects.toThrow('Invalid reference');
    expect(node.requests).toEqual([]);
  });

  test('without a node, nothing is dialled: getBee’s "Swarm node is not ready"', async () => {
    const url = mockNode.url;
    mockNode.url = null;
    try {
      await expect(reads.verifyReachable(REFERENCE)).rejects.toThrow('Swarm node is not ready');
      await expect(reads.getChainState()).rejects.toThrow('Swarm node is not ready');
    } finally {
      mockNode.url = url;
    }
    expect(node.requests).toEqual([]);
  });
});
