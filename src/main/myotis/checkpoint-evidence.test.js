const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  checkCheckpointAge,
  checkpointQuorum,
  decodedCheckpoint,
  fetchBytes,
  headerRoot,
  verifiedCheckpoint,
  verifyFailure,
  MAX_METADATA_BYTES,
  MAX_PROOF_BYTES,
  REQUEST_MS,
} = require('./checkpoint-evidence');
const { CHECKPOINT_NETWORKS, MAX_AGE_MS, checkpointError } = require('./checkpoint-verifier');

const CAPTURES = path.resolve(__dirname, '../../../docs/audits/evidence/colibri-v3-2026-09/captures');
// The checkpoint headers inside the captures' proof.ssz, as Colibri 3's
// decode_proof returns them (the last suite re-decodes the proofs to check).
const CAPTURED_HEADERS = {
  mainnet: {
    slot: '0xe88f40',
    proposerIndex: '0x1ed63b',
    parentRoot: '0x940f771c3aa7c2c9f5ccf0d50ed13a50e32dd86af1756ffd203295000a92ecf6',
    stateRoot: '0xbab50bf32e964cf6cf55894bdd44e1cd24df390af1ae48155255434be8bfa67e',
    bodyRoot: '0x383cd7e5e27a4c33594803352130b9f06edb888ff707d49ca7b6bc2603223cc2',
  },
  gnosis: {
    slot: '0x1cbf930',
    proposerIndex: '0x86e7d',
    parentRoot: '0xd8c9b3f93c93c9c9daa254f9842842fe80e639e344a36753da45bb245b7056aa',
    stateRoot: '0x9e891c095bfe8c7962bbecb340ed3faa0f961c42fa7876f839f50654ac1e03e6',
    bodyRoot: '0x1228148bc2d158513c1ff3cdb66f7fad43133a690d24bcf5167154dff3a840e8',
  },
};

function capture(network) {
  const dir = path.join(CAPTURES, network);
  return {
    checkpoint: JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json'), 'utf8')),
    responses: JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8')),
  };
}

const NOW = Date.UTC(2026, 8, 14, 21);
const MAINNET = CHECKPOINT_NETWORKS[1];
const SLOT =
  Math.floor((NOW / 1000 - MAINNET.genesis) / MAINNET.secondsPerSlot / MAINNET.slotsPerEpoch) *
    MAINNET.slotsPerEpoch -
  MAINNET.slotsPerEpoch;
const EPOCH = SLOT / MAINNET.slotsPerEpoch;
const ROOT = '0x' + 'aa'.repeat(32);
const OTHER = '0x' + 'bb'.repeat(32);
const THIRD = '0x' + 'cc'.repeat(32);

// Mainnet's authorities, by index into its candidate pool: a root string is
// that root endorsed as finalized at the slot's epoch; an object may move the
// finalized epoch; anything missing is offline.
function authorities(answers) {
  return jest.fn(async (url) => {
    const index = MAINNET.sources.findIndex((source) => url.startsWith(source + '/'));
    const answer = answers[index];
    if (!answer) throw new Error('offline');
    const { root, epoch = EPOCH } = typeof answer === 'string' ? { root: answer } : answer;
    if (url.endsWith('/eth/v1/beacon/states/head/finality_checkpoints')) {
      return new Response(JSON.stringify({ data: { finalized: { epoch: String(epoch), root } } }));
    }
    expect(url).toBe(`${MAINNET.sources[index]}/eth/v1/beacon/blocks/${SLOT}/root`);
    return new Response(JSON.stringify({ data: { root } }));
  });
}

const contacted = (fetch) => [...new Set(fetch.mock.calls.map(([url]) => new URL(url).origin))];

describe('checkpointQuorum', () => {
  test.each([1, 100])('chain %i seats three authorities and needs two to agree', (chainId) => {
    expect(CHECKPOINT_NETWORKS[chainId]).toMatchObject({ participants: 3, threshold: 2 });
    expect(CHECKPOINT_NETWORKS[chainId].sources.length).toBeGreaterThanOrEqual(3);
  });

  test('three agreeing authorities return their root, slot and finalized epoch', async () => {
    const fetch = authorities([ROOT, ROOT, ROOT, ROOT]);
    await expect(checkpointQuorum(SLOT, MAINNET, fetch, () => NOW)).resolves.toEqual({
      slot: SLOT,
      root: ROOT,
      finalizedEpoch: EPOCH,
      sources: MAINNET.sources.slice(0, 3),
    });
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 3));
  });

  test('every authority request is a GET to a source origin, refusing redirects', async () => {
    const fetch = authorities([ROOT, ROOT, ROOT, ROOT]);
    await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW);
    for (const [url, options] of fetch.mock.calls) {
      expect(MAINNET.sources).toContain(new URL(url).origin);
      expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    }
  });

  test('two votes reach the threshold; a failed third seat is not refilled', async () => {
    const fetch = authorities([ROOT, ROOT]);
    const result = await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW);
    expect(result.sources).toEqual(MAINNET.sources.slice(0, 2));
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 3));
  });

  test('one vote never reaches the threshold, even with every reserve tried', async () => {
    const fetch = authorities([ROOT]);
    await expect(checkpointQuorum(SLOT, MAINNET, fetch, () => NOW)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_UNAVAILABLE',
    });
    expect(contacted(fetch)).toEqual(MAINNET.sources);
  });

  test('unavailable seats are refilled from the reserves in pool order', async () => {
    const fetch = authorities([undefined, undefined, ROOT, ROOT]);
    const result = await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW);
    expect(result.sources).toEqual(MAINNET.sources.slice(2, 4));
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 5));
  });

  test('a racing authority (finalized behind the slot) gives up its seat', async () => {
    const fetch = authorities([ROOT, { root: ROOT, epoch: EPOCH - 1 }, undefined, ROOT]);
    const result = await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW);
    expect(result.sources).toEqual([MAINNET.sources[0], MAINNET.sources[3]]);
  });

  test('a 2–1 split returns the majority without consulting reserves', async () => {
    const fetch = authorities([OTHER, ROOT, ROOT, OTHER, OTHER]);
    const result = await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW);
    expect(result).toMatchObject({ root: ROOT, sources: MAINNET.sources.slice(1, 3) });
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 3));
  });

  test('three different roots are a conflict that agreeable reserves never resolve', async () => {
    const fetch = authorities([ROOT, OTHER, THIRD, ROOT, ROOT, ROOT, ROOT]);
    await expect(checkpointQuorum(SLOT, MAINNET, fetch, () => NOW)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 3));
  });

  test('a 1–1 split with no third vote is a conflict, not unavailability', async () => {
    const fetch = authorities([ROOT, OTHER]);
    await expect(checkpointQuorum(SLOT, MAINNET, fetch, () => NOW)).rejects.toMatchObject({
      code: 'CHECKPOINT_QUORUM_CONFLICT',
    });
    expect(contacted(fetch)).toEqual(MAINNET.sources);
  });

  test('every seat finalized past the wall clock is a clock error', async () => {
    const future = { root: ROOT, epoch: EPOCH + 100 };
    const fetch = authorities([future, future, future, ROOT, ROOT]);
    await expect(checkpointQuorum(SLOT, MAINNET, fetch, () => NOW)).rejects.toMatchObject({
      code: 'CHECKPOINT_CLOCK',
    });
    expect(contacted(fetch)).toEqual(MAINNET.sources.slice(0, 3));
  });

  test('diagnostics name each candidate; a throwing reporter changes nothing', async () => {
    const diagnostics = [];
    const fetch = authorities([ROOT, undefined, ROOT]);
    const result = await checkpointQuorum(SLOT, MAINNET, fetch, () => NOW, (value) => {
      diagnostics.push(value);
      throw new Error('logging failed');
    });
    expect(result.sources).toEqual([MAINNET.sources[0], MAINNET.sources[2]]);
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      source: MAINNET.sources[1], slot: SLOT, outcome: 'CHECKPOINT_UNAVAILABLE',
      stage: 'block-root', failure: 'transport',
    }));
    expect(diagnostics.filter((value) => value.outcome === 'vote')).toHaveLength(2);
  });
});

// A response as fetchBytes reads it: a status, headers and a body stream.
// Chunks are pulled one read at a time, so `pull` counts what was read.
function response(chunks, { status = 200, headers = {} } = {}) {
  const pull = jest.fn((controller) => {
    if (!chunks.length) controller.close();
    else controller.enqueue(chunks.shift());
  });
  const body = new ReadableStream({ pull }, { highWaterMark: 0 });
  return { status, headers: new Headers(headers), body, pull };
}

describe('fetchBytes', () => {
  test('caps are 4 MiB for a proof and 64 KiB for metadata, within 20 s', () => {
    expect(MAX_PROOF_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_METADATA_BYTES).toBe(64 * 1024);
    expect(REQUEST_MS).toBe(20_000);
  });

  test('refuses redirects whatever the caller asks, keeping its own options', async () => {
    let seen;
    const fetch = jest.fn(async (_url, options) => {
      seen = options;
      return response([new Uint8Array([1, 2, 3])]);
    });
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'follow' };
    await expect(fetchBytes(fetch, 'https://test.invalid/p', options, 3)).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(fetch).toHaveBeenCalledWith('https://test.invalid/p', expect.any(Object));
    expect(seen).toMatchObject({ method: 'POST', headers: options.headers, body: '{}', redirect: 'error' });
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  test('a fetch that refuses a redirect is a transport failure', async () => {
    const fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    };
    await expect(fetchBytes(fetch, 'https://test.invalid', {}, MAX_METADATA_BYTES)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'transport',
    });
  });

  test.each([301, 302, 307, 308])('a %i handed back is an HTTP failure and is not followed', async (status) => {
    const fetch = jest.fn(async () => response([], { status, headers: { location: 'https://elsewhere.invalid/' } }));
    await expect(fetchBytes(fetch, 'https://test.invalid', {}, MAX_METADATA_BYTES)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'http', httpStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("Node's fetch refuses a real redirect without requesting its target", async () => {
    let targetHits = 0;
    const server = http.createServer((request, reply) => {
      if (request.url === '/target') {
        targetHits++;
        reply.end('{}');
        return;
      }
      reply.writeHead(302, { location: '/target' }).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/redirect`;
      await expect(fetchBytes(globalThis.fetch, url, { method: 'GET' }, MAX_METADATA_BYTES)).rejects.toMatchObject({
        code: 'CHECKPOINT_UNAVAILABLE', failure: 'transport',
      });
      expect(targetHits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test.each([204, 206, 404, 503])('HTTP %i is an availability failure', async (status) => {
    await expect(fetchBytes(async () => response([], { status }), 'https://test.invalid', {}, 10)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'http', httpStatus: status,
    });
  });

  test.each([MAX_METADATA_BYTES, MAX_PROOF_BYTES])('a declared length over %i is refused unread', async (limit) => {
    const reply = response([new Uint8Array(1)], { headers: { 'content-length': String(limit + 1) } });
    await expect(fetchBytes(async () => reply, 'https://test.invalid', {}, limit)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'body-limit',
    });
    expect(reply.pull).not.toHaveBeenCalled();
  });

  test.each(['-1', '1e3', '0x10', '10, 10', 'ten'])('a malformed Content-Length %p is refused', async (length) => {
    const reply = response([new Uint8Array(1)], { headers: { 'content-length': length } });
    await expect(fetchBytes(async () => reply, 'https://test.invalid', {}, 1024)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'body-limit',
    });
  });

  test.each([MAX_METADATA_BYTES, MAX_PROOF_BYTES])('exactly %i streamed bytes are read whole', async (limit) => {
    const half = limit / 2;
    const reply = response([new Uint8Array(half).fill(1), new Uint8Array(half).fill(2)], {
      headers: { 'content-length': String(limit) },
    });
    const bytes = await fetchBytes(async () => reply, 'https://test.invalid', {}, limit);
    expect(bytes.length).toBe(limit);
    expect([bytes[0], bytes[half - 1], bytes[half], bytes[limit - 1]]).toEqual([1, 1, 2, 2]);
  });

  test.each([
    ['no Content-Length', {}],
    ['a Content-Length that lies low', { 'content-length': '1' }],
  ])('one byte past the cap is refused with %s, and the body is cancelled', async (_name, headers) => {
    const reply = response([new Uint8Array(MAX_METADATA_BYTES), new Uint8Array(1), new Uint8Array(1)], { headers });
    await expect(fetchBytes(async () => reply, 'https://test.invalid', {}, MAX_METADATA_BYTES)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE', failure: 'body-limit',
    });
    // The third chunk is never pulled: reading stops at the first byte over.
    expect(reply.pull).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['no body', { status: 200, headers: new Headers(), body: null }],
    ['a body without a reader', { status: 200, headers: new Headers(), body: {} }],
  ])('%s is unavailable', async (_name, reply) => {
    await expect(fetchBytes(async () => reply, 'https://test.invalid', {}, 10)).rejects.toMatchObject({
      code: 'CHECKPOINT_UNAVAILABLE',
    });
  });

  test('a network failure is a transport failure', async () => {
    await expect(fetchBytes(async () => { throw new Error('ECONNRESET'); }, 'https://test.invalid', {}, 10))
      .rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', failure: 'transport' });
  });

  describe('the 20 s deadline', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('a silent endpoint is aborted at 20 s, not before', async () => {
      let signal;
      const fetch = (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      let settled = false;
      const result = fetchBytes(fetch, 'https://test.invalid', {}, 10);
      result.then(() => { settled = true; }, () => { settled = true; });
      await jest.advanceTimersByTimeAsync(REQUEST_MS - 1);
      expect(signal.aborted).toBe(false);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', failure: 'timeout' });
      expect(jest.getTimerCount()).toBe(0);
    });

    test('a body that stalls mid-stream times out', async () => {
      // One chunk, then the stream never yields again until the request aborts.
      const fetch = async (_url, { signal }) => ({
        status: 200,
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4));
            signal.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        }),
      });
      const result = fetchBytes(fetch, 'https://test.invalid', {}, 10);
      result.catch(() => {});
      await jest.advanceTimersByTimeAsync(REQUEST_MS);
      await expect(result).rejects.toMatchObject({ code: 'CHECKPOINT_UNAVAILABLE', failure: 'timeout' });
    });

    test('a completed read leaves no timer behind', async () => {
      await fetchBytes(async () => response([new Uint8Array(2)]), 'https://test.invalid', {}, 10);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe('headerRoot', () => {
  test.each(['mainnet', 'gnosis'])('the %s capture header hashes to its quorum-endorsed root', (network) => {
    const { checkpoint, responses } = capture(network);
    const header = CAPTURED_HEADERS[network];
    expect(Number(header.slot)).toBe(checkpoint.slot);
    expect(headerRoot(header)).toBe(checkpoint.root);
    // Every authority's recorded block-root answer for that slot agrees.
    const answers = Object.entries(responses)
      .filter(([url]) => url.endsWith(`/eth/v1/beacon/blocks/${checkpoint.slot}/root`))
      .map(([, { body }]) => '0x' + JSON.parse(body).data.root.replace(/^0x/, ''));
    expect(answers.length).toBeGreaterThanOrEqual(2);
    for (const root of answers) expect(root).toBe(checkpoint.root);
  });

  test('integer and root encodings that name the same header give the same root', () => {
    const header = CAPTURED_HEADERS.mainnet;
    const expected = capture('mainnet').checkpoint.root;
    expect(headerRoot({ ...header, slot: String(Number(header.slot)), proposerIndex: Number(header.proposerIndex) }))
      .toBe(expected);
    expect(headerRoot({
      ...header,
      slot: header.slot.toUpperCase().replace('0X', '0x'),
      parentRoot: header.parentRoot.slice(2),
      stateRoot: '0x' + header.stateRoot.slice(2).toUpperCase(),
    })).toBe(expected);
  });

  test.each(['slot', 'proposerIndex', 'parentRoot', 'stateRoot', 'bodyRoot'])('changing %s changes the root', (field) => {
    const header = CAPTURED_HEADERS.gnosis;
    const changed = field === 'slot' || field === 'proposerIndex'
      ? '0x' + (Number(header[field]) + 1).toString(16)
      : '0x' + 'ab'.repeat(32);
    expect(headerRoot({ ...header, [field]: changed })).not.toBe(headerRoot(header));
  });

  test.each([
    ['no header', null],
    ['a string', 'header'],
    ['no parentRoot', { ...CAPTURED_HEADERS.mainnet, parentRoot: undefined }],
    ['a short root', { ...CAPTURED_HEADERS.mainnet, bodyRoot: '0x' + '11'.repeat(31) }],
    ['a negative slot', { ...CAPTURED_HEADERS.mainnet, slot: -1 }],
    ['an empty hex slot', { ...CAPTURED_HEADERS.mainnet, slot: '0x' }],
    ['a slot past 2^53', { ...CAPTURED_HEADERS.mainnet, slot: '0x20000000000000' }],
  ])('%s is a mismatch', (_name, header) => {
    expect(() => headerRoot(header)).toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });
});

// A decoded proof's sync_data around a header, shaped as Colibri 3 decodes it.
function decodedProof(header = CAPTURED_HEADERS.mainnet) {
  return {
    sync_data: {
      pubkeys: Array(512).fill('0x' + '44'.repeat(48)),
      checkpoint: {
        header,
        aggregate_pubkey: '0x' + '44'.repeat(48),
        proof: Array(6).fill('0x' + '55'.repeat(32)),
      },
    },
  };
}

describe('decodedCheckpoint (sync_data checks)', () => {
  test('returns the checkpoint header slot and root', () => {
    const { checkpoint } = capture('mainnet');
    expect(decodedCheckpoint(decodedProof())).toEqual({ slot: checkpoint.slot, root: checkpoint.root });
  });

  test.each([
    ['upper-case hex aggregate key', (d) => { d.sync_data.checkpoint.aggregate_pubkey = '0x' + 'AB'.repeat(48); }],
    ['a 16-entry branch', (d) => { d.sync_data.checkpoint.proof = Array(16).fill('0x' + '55'.repeat(32)); }],
    ['a single-entry branch', (d) => { d.sync_data.checkpoint.proof = ['55'.repeat(32)]; }],
  ])('accepts %s', (_name, mutate) => {
    const decoded = decodedProof();
    mutate(decoded);
    expect(decodedCheckpoint(decoded).slot).toBe(capture('mainnet').checkpoint.slot);
  });

  test.each([
    ['no sync_data', (d) => { delete d.sync_data; }],
    ['pubkeys not an array', (d) => { d.sync_data.pubkeys = {}; }],
    ['511 pubkeys', (d) => { d.sync_data.pubkeys.pop(); }],
    ['513 pubkeys', (d) => { d.sync_data.pubkeys.push(d.sync_data.pubkeys[0]); }],
    ['no checkpoint', (d) => { delete d.sync_data.checkpoint; }],
    ['an extra checkpoint field', (d) => { d.sync_data.checkpoint.extra = 1; }],
    ['no aggregate key (legacy variant)', (d) => { delete d.sync_data.checkpoint.aggregate_pubkey; }],
    ['a 47-byte aggregate key', (d) => { d.sync_data.checkpoint.aggregate_pubkey = '0x' + '44'.repeat(47); }],
    ['an aggregate key without 0x', (d) => { d.sync_data.checkpoint.aggregate_pubkey = '44'.repeat(48); }],
    ['an empty branch', (d) => { d.sync_data.checkpoint.proof = []; }],
    ['a 17-entry branch', (d) => { d.sync_data.checkpoint.proof = Array(17).fill('0x' + '55'.repeat(32)); }],
    ['a malformed branch entry', (d) => { d.sync_data.checkpoint.proof[3] = '0x55'; }],
    ['no header', (d) => { delete d.sync_data.checkpoint.header; }],
    ['slot 0', (d) => { d.sync_data.checkpoint.header = { ...CAPTURED_HEADERS.mainnet, slot: '0x0' }; }],
    ['a malformed header root', (d) => {
      d.sync_data.checkpoint.header = { ...CAPTURED_HEADERS.mainnet, stateRoot: 'nope' };
    }],
  ])('%s is a mismatch', (_name, mutate) => {
    const decoded = decodedProof();
    mutate(decoded);
    expect(() => decodedCheckpoint(decoded)).toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });
});

describe('checkCheckpointAge', () => {
  const { slot } = capture('mainnet').checkpoint;
  const slotTime = (MAINNET.genesis + slot * MAINNET.secondsPerSlot) * 1000;

  test.each([
    ['at the slot start', slotTime],
    ['exactly one hour after it', slotTime + MAX_AGE_MS],
  ])('passes %s', (_name, now) => {
    expect(MAX_AGE_MS).toBe(60 * 60 * 1000);
    expect(() => checkCheckpointAge(slot, MAINNET, () => now)).not.toThrow();
  });

  test('one millisecond past one hour is stale', () => {
    expect(() => checkCheckpointAge(slot, MAINNET, () => slotTime + MAX_AGE_MS + 1))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_STALE' }));
  });

  test('one millisecond before the slot starts is a clock error', () => {
    expect(() => checkCheckpointAge(slot, MAINNET, () => slotTime - 1))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_CLOCK' }));
  });

  test('a slot whose start time is not a safe integer is a mismatch', () => {
    expect(() => checkCheckpointAge(Number.MAX_SAFE_INTEGER, MAINNET, () => NOW))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });
});

describe('verifiedCheckpoint', () => {
  const { checkpoint } = capture('mainnet');
  const slotTime = (MAINNET.genesis + checkpoint.slot * MAINNET.secondsPerSlot) * 1000;
  const observation = {
    slot: checkpoint.slot,
    root: checkpoint.root,
    finalizedEpoch: checkpoint.finalizedEpoch,
    sources: checkpoint.sources,
  };
  const record = (verifiedAt) => ({
    schemaVersion: 2,
    chainId: 1,
    network: 'mainnet',
    root: checkpoint.root,
    slot: checkpoint.slot,
    verifiedAt,
    sources: checkpoint.sources,
    finalizedEpoch: checkpoint.finalizedEpoch,
  });

  test("the capture's decoded header and quorum observation give its checkpoint", () => {
    expect(verifiedCheckpoint(1, MAINNET, decodedProof(), [observation], () => checkpoint.verifiedAt))
      .toEqual(record(checkpoint.verifiedAt));
  });

  test('the matching observation is chosen among others', () => {
    const others = [
      { ...observation, slot: observation.slot - 32, sources: MAINNET.sources.slice(3, 5) },
      { ...observation, root: OTHER, sources: MAINNET.sources.slice(5, 7) },
    ];
    expect(verifiedCheckpoint(1, MAINNET, decodedProof(), [...others, observation], () => checkpoint.verifiedAt).sources)
      .toEqual(checkpoint.sources);
  });

  test('no observation is an incompatible runtime, before the proof is examined', () => {
    expect(() => verifiedCheckpoint(1, MAINNET, {}, [], () => checkpoint.verifiedAt))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_INCOMPATIBLE' }));
  });

  test.each([
    ['another slot', { slot: observation.slot - 32 }],
    ['another root', { root: OTHER }],
  ])('an observation at %s does not authorize the header', (_name, change) => {
    expect(() => verifiedCheckpoint(1, MAINNET, decodedProof(), [{ ...observation, ...change }], () => checkpoint.verifiedAt))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });

  test('a malformed decoded proof is a mismatch even with a matching observation', () => {
    const decoded = decodedProof();
    decoded.sync_data.pubkeys.pop();
    expect(() => verifiedCheckpoint(1, MAINNET, decoded, [observation], () => checkpoint.verifiedAt))
      .toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });

  test.each([
    [slotTime, null],
    [slotTime + MAX_AGE_MS, null],
    [slotTime + MAX_AGE_MS + 1, 'CHECKPOINT_STALE'],
    [slotTime - 1, 'CHECKPOINT_CLOCK'],
  ])('at %i the age verdict is %s', (now, code) => {
    const run = () => verifiedCheckpoint(1, MAINNET, decodedProof(), [observation], () => now);
    if (code) expect(run).toThrow(expect.objectContaining({ code }));
    else expect(run()).toEqual(record(now));
  });

  test('a quorum record the verifier would refuse is refused here too', () => {
    expect(() => verifiedCheckpoint(1, MAINNET, decodedProof(), [{ ...observation, sources: checkpoint.sources.slice(0, 1) }],
      () => checkpoint.verifiedAt)).toThrow(expect.objectContaining({ code: 'CHECKPOINT_MISMATCH' }));
  });
});

describe('verifyFailure', () => {
  test('a lookup failure seen during verification keeps its own category', () => {
    const transport = checkpointError('CHECKPOINT_QUORUM_UNAVAILABLE');
    expect(verifyFailure('proof for latest too old', transport)).toBe(transport);
    expect(verifyFailure('invalid zk_proof!', transport)).toBe(transport);
  });

  test.each([
    ['proof for latest too old', 'CHECKPOINT_STALE'],
    ['Verification failed: Proof for Latest too old (age 900s)', 'CHECKPOINT_STALE'],
    ['invalid zk_proof!', 'CHECKPOINT_MISMATCH'],
    ['', 'CHECKPOINT_MISMATCH'],
    [undefined, 'CHECKPOINT_MISMATCH'],
  ])('%p without a lookup failure is %s', (message, code) => {
    expect(verifyFailure(message, null)).toMatchObject({ code });
  });
});

// The real pinned WASM in a fresh process, as checkpoint-verifier-worker.test.js
// runs it: decode each capture's proof.ssz and judge it at the capture's clock.
describe("the captures' decoded proofs with the real Colibri WASM", () => {
  test.each(['mainnet', 'gnosis'])('%s', (network) => {
    const dir = path.join(CAPTURES, network);
    const script = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { decode_proof } = require(${JSON.stringify(path.resolve(__dirname, '../ens/colibri-runtime.js'))});
      const { decodedCheckpoint, verifiedCheckpoint } = require(${JSON.stringify(path.join(__dirname, 'checkpoint-evidence.js'))});
      const { networkFor } = require(${JSON.stringify(path.join(__dirname, 'checkpoint-verifier.js'))});
      const dir = ${JSON.stringify(dir)};
      const original = JSON.parse(fs.readFileSync(path.join(dir, 'verified-checkpoint.json')));
      const observation = { slot: original.slot, root: original.root, finalizedEpoch: original.finalizedEpoch, sources: original.sources };
      (async () => {
        const decoded = await decode_proof(fs.readFileSync(path.join(dir, 'proof.ssz')));
        const header = decoded.sync_data.checkpoint.header;
        const result = verifiedCheckpoint(original.chainId, networkFor(original.chainId), decoded, [observation], () => original.verifiedAt);
        console.log(JSON.stringify({ header, checkpoint: decodedCheckpoint(decoded), result }));
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    const output = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000 })
      .trim().split('\n').at(-1));
    const original = capture(network).checkpoint;
    expect(output.header).toEqual(CAPTURED_HEADERS[network]);
    expect(output.checkpoint).toEqual({ slot: original.slot, root: original.root });
    const { schemaVersion, chainId, root, slot, verifiedAt, sources, finalizedEpoch } = original;
    expect(output.result).toEqual({
      schemaVersion, chainId, network, root, slot, verifiedAt, sources, finalizedEpoch,
    });
  }, 40_000);
});
