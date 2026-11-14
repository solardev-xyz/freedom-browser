/**
 * @jest-environment node
 */
'use strict';

/**
 * `swarm_sendPss` (#1062), through the result the page gets: the real
 * provider, messaging service and bee-js against a fake Ant over loopback
 * HTTP. The fake answers `POST /pss/send` the way Ant v0.5.78 does, and is
 * held to answers recorded from that release
 * (test/fixtures/ant-pss-send/v0.5.78.json). Ant reads the recipient as a
 * SEC1 key, 33 or 65 bytes; bee-js 13.2.0's own `pssSend` sends something
 * else, which Ant refuses, so main builds the request itself.
 */

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  webContents: { fromId: jest.fn() },
}));
jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  verbose: jest.fn(),
}));
jest.mock('./swarm-permissions', () => ({
  getPermission: (origin) => ({ origin, connectedAt: 1, lastUsed: 1, autoApprove: {} }),
  hasMessagingGrant: () => true,
  onRevoke: jest.fn(),
}));
// GSOC mining (a worker thread) has no part in PSS.
jest.mock('./gsoc-miner', () => ({ mineSigner: jest.fn(), joinJob: jest.fn() }));
jest.mock('./subscription-registry', () => ({ configure: jest.fn(), cancelByOrigin: jest.fn() }));
jest.mock('./publish-setup-service', () => ({ getPublishReadiness: async () => ({ ok: true }) }));
jest.mock('../ant-manager', () => ({ waitForNodeSettled: async () => true, isNodeSettled: () => true }));
jest.mock('./publish-service', () => ({}));
jest.mock('./feed-service', () => ({}));
jest.mock('./feed-store', () => ({}));
jest.mock('./publish-history', () => ({}));
jest.mock('../identity-manager', () => ({}));
let mockAntUrl = null;
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockAntUrl }));
// Batch choice is swarm-service's; here there is always one.
const BATCH_ID = 'ab'.repeat(32);
jest.mock('./swarm-service', () => ({
  ...jest.requireActual('./swarm-service'),
  selectBestBatch: async () => 'ab'.repeat(32),
}));

const { Bee, PrivateKey, Topic } = require('@ethersphere/bee-js');
const { executeSwarmMethod } = require('./swarm-provider-ipc');
const { BATCH_NOT_YET_KNOWN_MESSAGE } = require('./ant-storage-api');
const { closedLoopbackPort, startFakeHttpNode } = require('../../../test/helpers/fake-http-node');
const RECORDED = require('../../../test/fixtures/ant-pss-send/v0.5.78.json');

const ORIGIN = 'https://chat.example';
const TOPIC = 'chat';
// The recording's key: the public key of private key 0x11…11.
const KEY = new PrivateKey('11'.repeat(32)).publicKey();
const RECIPIENT = KEY.toCompressedHex(); // 66 hex, lower case
const MESSAGE = Buffer.from('hello, bob');

// ── A fake Ant: `upload_pss` at v0.5.78 (ant-gateway/src/retrieval.rs) ──

const P = 2n ** 256n - 2n ** 32n - 977n; // secp256k1's field prime

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// Rust's `hex::decode`: an even number of hex digits, either case.
function hexDecode(text) {
  return /^(?:[0-9a-fA-F]{2})*$/.test(text) ? Buffer.from(text, 'hex') : null;
}

// `Recipient::from_sec1`: a compressed (33-byte) or uncompressed (65-byte)
// SEC1 point on the curve.
function isSec1Point(bytes) {
  const big = (b) => BigInt(`0x${b.toString('hex')}`);
  if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    const x = big(bytes.subarray(1));
    if (x >= P) return false;
    const rhs = (x ** 3n + 7n) % P;
    return rhs === 0n || modPow(rhs, (P - 1n) / 2n, P) === 1n;
  }
  if (bytes.length === 65 && bytes[0] === 4) {
    const x = big(bytes.subarray(1, 33));
    const y = big(bytes.subarray(33));
    return x < P && y < P && (y * y) % P === (x ** 3n + 7n) % P;
  }
  return false;
}

function antError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: status, message }));
}

/** Answers `POST /pss/send` in Ant's order; `usableBatches` hold stamps. */
function fakeAntPss({ usableBatches }) {
  return (req, res, entry) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      entry.body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://ant.invalid');
      const route = /^\/pss\/send\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (req.method !== 'POST' || !route) return antError(res, 404, 'Not Found');
      if (entry.body.length > 4000) return antError(res, 400, 'pss message exceeds 4000 bytes');
      const targets = decodeURIComponent(route[2]).split(',').map((t) => hexDecode(t.trim()));
      if (targets.some((t) => !t || t.length === 0 || t.length > 3)) {
        return antError(res, 400, 'each target must be 1..=3 bytes of hex');
      }
      if (url.searchParams.has('recipient')) {
        const key = hexDecode(url.searchParams.get('recipient').trim());
        if (!key || !isSec1Point(key)) return antError(res, 400, 'invalid recipient public key');
      }
      const batch = req.headers['swarm-postage-batch-id'];
      if (!usableBatches.includes(batch)) return antError(res, 400, `batch 0x${batch} not usable`);
      res.writeHead(201);
      res.end();
    });
  };
}

// ── Helpers ──

let ant;

beforeEach(async () => {
  ant = await startFakeHttpNode({ handler: fakeAntPss({ usableBatches: [BATCH_ID] }) });
  mockAntUrl = ant.origin;
});

afterEach(async () => {
  await ant.close();
  mockAntUrl = null;
});

function sendPss(params) {
  return executeSwarmMethod(
    'swarm_sendPss',
    { topic: TOPIC, recipient: RECIPIENT, targets: 'abcd', data: MESSAGE, ...params },
    ORIGIN
  );
}

/** A node that answers every request with `status` and `body`. */
function answerAll(status, body, contentType = 'application/json') {
  ant.handle((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': contentType });
      res.end(body);
    });
  });
}

/** What bee-js 13.2.0's own pssSend threw for the node's current answer. */
async function beeJsPssSendError() {
  const bee = new Bee(mockAntUrl);
  return bee.messaging
    .pssSend(BATCH_ID, Topic.fromString(TOPIC), 'abcd', MESSAGE, RECIPIENT)
    .then(() => null, (err) => err);
}

// ── The fake against the recording ──

describe('the fake Ant', () => {
  test('answers every recorded request as Ant v0.5.78 did', async () => {
    // The recording's node held no batch: every request it could parse ended
    // at the batch check.
    ant.handle(fakeAntPss({ usableBatches: [] }));
    expect(RECORDED.ant).toBe('antd/0.5.78');
    for (const exchange of RECORDED.exchanges) {
      const res = await fetch(`${ant.origin}${exchange.path}`, {
        method: RECORDED.request.method,
        headers: RECORDED.request.headers,
        body: Buffer.from(RECORDED.request.bodyHex, 'hex'),
      });
      expect({ name: exchange.name, status: res.status, body: await res.text() }).toEqual({
        name: exchange.name,
        status: exchange.status,
        body: exchange.body,
      });
    }
  });

  test('the recording refused the bee-js forms and took the SEC1 ones', () => {
    const refused = RECORDED.exchanges
      .filter((e) => JSON.parse(e.body).message === 'invalid recipient public key')
      .map((e) => e.name);
    expect(refused.sort()).toEqual(['objectObject', 'xy128']);
    const sent = RECORDED.exchanges.find((e) => e.name === 'compressed66');
    expect(new URL(sent.path, 'http://ant.invalid').searchParams.get('recipient')).toBe(RECIPIENT);
  });
});

// ── The request main sends ──

describe('swarm_sendPss against the node', () => {
  test('sends the recipient as the 66-hex compressed key, and the node takes it', async () => {
    const result = await sendPss({ recipient: `0x${RECIPIENT.toUpperCase()}`, targets: 'ABCD' });

    expect(result).toEqual({ result: { sent: true } });
    expect(ant.requests).toHaveLength(1);
    const [request] = ant.requests;
    const url = new URL(request.url, 'http://ant.invalid');
    expect(request.method).toBe('POST');
    // <topic> is keccak256 of the topic string (bee's NewTopic); <targets>
    // is lowercased, as the provider has always sent it.
    expect(url.pathname).toBe(`/pss/send/${Topic.fromString(TOPIC).toHex()}/abcd`);
    expect(url.pathname).toBe(`/pss/send/${RECORDED.topicHex}/abcd`);
    // The query is the recipient alone: the compressed SEC1 key, lower case.
    expect([...url.searchParams]).toEqual([['recipient', RECIPIENT]]);
    expect(url.search).toBe(`?recipient=${RECIPIENT}`);
    expect(RECIPIENT).toMatch(/^0[23][0-9a-f]{64}$/);
    expect(request.headers['content-type']).toBe('application/octet-stream');
    expect(request.headers['swarm-postage-batch-id']).toBe(BATCH_ID);
    expect(request.body.equals(MESSAGE)).toBe(true);
  });

  test('sends an empty message (a ping) with an empty body', async () => {
    const result = await sendPss({ data: '' });
    expect(result).toEqual({ result: { sent: true } });
    expect(ant.requests[0].body).toHaveLength(0);
  });

  test('bee-js 13.2.0 pssSend does not send the key, and the node refuses it', async () => {
    // Why main builds the request: the same send through bee-js.
    const err = await beeJsPssSendError();
    expect(err).not.toBeNull();
    expect(err.status).toBe(400);
    expect(err.message).toBe('Bad Request: {"code":400,"message":"invalid recipient public key"}');
    const url = new URL(ant.requests[0].url, 'http://ant.invalid');
    expect(url.searchParams.get('recipient')).not.toBe(RECIPIENT);
  });

  test('the form a bee-js PublicKey holds (128 hex, x ‖ y) is refused by the node', async () => {
    const xy = KEY.toHex();
    expect(xy).toHaveLength(128);
    const res = await fetch(
      `${ant.origin}/pss/send/${RECORDED.topicHex}/abcd?recipient=${xy}`,
      { method: 'POST', headers: { 'swarm-postage-batch-id': BATCH_ID }, body: MESSAGE }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 400, message: 'invalid recipient public key' });
  });
});

// ── The provider's checks of the recipient ──

describe('swarm_sendPss recipient validation', () => {
  const INVALID = {
    'x ‖ y (128 hex)': KEY.toHex(),
    'uncompressed SEC1 (130 hex)': `04${KEY.toHex()}`,
    'a 04 prefix on 64 hex': `04${RECIPIENT.slice(2)}`,
    'no prefix (64 hex)': RECIPIENT.slice(2),
    'one hex short': RECIPIENT.slice(0, 65),
    'one hex long': `${RECIPIENT}0`,
    'non-hex': `02${'zz'.repeat(32)}`,
    'empty': '',
    'missing': undefined,
    'a number': 2,
    'an array': [RECIPIENT],
  };

  test.each(Object.entries(INVALID))('refuses %s before any node request', async (_name, recipient) => {
    const result = await sendPss({ recipient });
    expect(result).toEqual({
      error: {
        code: -32602,
        message: 'recipient must be a 66-character hex compressed secp256k1 public key',
        data: { reason: 'invalid_recipient' },
      },
    });
    expect(ant.requests).toHaveLength(0);
  });

  test('refuses a key off the curve before any node request, as bee-js did', async () => {
    const offCurve = `02${'00'.repeat(32)}`; // x = 0: 7 has no square root mod p
    const result = await sendPss({ recipient: offCurve });
    expect(result.error.code).toBe(-32603);
    expect(result.error.message).toBe('bad point: is not on curve, sqrt error: Cannot find square root');
    expect(ant.requests).toHaveLength(0);
  });
});

// ── Errors the page sees ──

describe('swarm_sendPss node errors keep bee-js wording', () => {
  test.each([
    ['a JSON error', 400, JSON.stringify({ code: 400, message: 'invalid recipient public key' })],
    ['a busy miner', 503, JSON.stringify({ code: 503, message: 'pss mining is busy; retry later' })],
    ['a push failure', 502, JSON.stringify({ code: 502, message: 'no peer accepted the chunk' })],
    ['a text body', 500, 'something broke'],
    ['no body', 400, undefined],
  ])('%s', async (_name, status, body) => {
    answerAll(status, body, body && body.startsWith('{') ? 'application/json' : 'text/plain');
    const before = await beeJsPssSendError();

    const result = await sendPss();
    expect(result).toEqual({ error: { code: -32603, message: before.message } });
  });

  test('a batch the storers do not know yet is node-not-ready, as before', async () => {
    answerAll(
      422,
      JSON.stringify({
        code: 422,
        message: `pushsync: postage batch 0x${BATCH_ID} rejected by 3 peer(s) as not found on-chain`,
      })
    );
    const result = await sendPss();
    expect(result).toEqual({
      error: {
        code: 4900,
        message: BATCH_NOT_YET_KNOWN_MESSAGE,
        data: { reason: 'node-not-ready' },
      },
    });
  });

  test('a node that does not answer', async () => {
    mockAntUrl = `http://127.0.0.1:${await closedLoopbackPort()}`;
    const before = await beeJsPssSendError();
    expect(before.message).toMatch(/^fetch failed: connect ECONNREFUSED/);

    const result = await sendPss();
    expect(result).toEqual({ error: { code: -32603, message: before.message } });
  });
});
