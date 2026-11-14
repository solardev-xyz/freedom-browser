/**
 * `shell.dweb_get` (freedom-core design 0009) against fake nodes: every
 * reply form, the request forms the core sends (chunks, ranged `/bytes`,
 * feeds, CARs with and without `entity-bytes`, a HEAD's, raw blocks, IPNS
 * records), strict params, the header bounds, the failure classes, aborts,
 * and the core's credit as the only thing that pulls a streamed body.
 * Streams run through a real CoreClient at protocol 2 against a scripted
 * core; the rest calls the handler as the client does.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const { CoreClient, ShellError } = require('./core-client');
const {
  encodeFrame,
  encodeStreamCredit,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_JSON,
  MAX_DATA,
  WINDOW,
} = require('./frame');
const {
  registerDwebShell,
  DwebShell,
  CAR_ACCEPT,
  RAW_ACCEPT,
  RECORD_ACCEPT,
  MAX_HEADER,
} = require('./dweb-shell');

const tick = () => new Promise(setImmediate);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `predicate`, up to 4 s: timers (the body idle bound) fire
 * meanwhile. */
async function until(predicate, what) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

const HEX64 = 'ab'.repeat(32);
const HEX40 = 'cd'.repeat(20);
const CID1 = 'bafybeiguwjmddvr4iiah6ekgvrovb5zfb6eg5c6loikxvxlxzlwea5dabm';
const CID0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const IPNS = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const SWARM = [
  ['swarm-chunk-retrieval-timeout', '30s'],
  ['swarm-redundancy-strategy', '3'],
  ['swarm-redundancy-fallback-mode', 'true'],
];
const CAR = `/ipfs/${CID1}/docs/index.html?format=car&dag-scope=entity`;
// CIDs that decode but aren't what the core writes: a version-2 dag-pb CID
// in base32, a version-2 libp2p-key name and a raw CID in base36.
const VERSION2 = 'bajybeialgbkxvh6e5ehdgwd5uld6yejwloaklsxpcq4v5a5izxzbopdbqy';
const KEY_VERSION2 = 'k4bv5kagsd096i2qh9huzt1dquaeefryxf81wmb09lziol1h4fqax092';
const RAW36 = 'k2cwue8xfyt8i8xatlnj19equf1vqoxslfnd9xwjltwih9ra3gh2pyme';

/** Byte `offset + i` of a body: a pattern a slice of can be checked. */
function pattern(offset, length) {
  const out = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) out[i] = (offset + i) % 251;
  return out;
}

/**
 * A node's body of `length` bytes, in `chunk`-byte reads, pulled only when
 * read: what has been read of it, whether it was cancelled. With `stall`, it
 * never answers past that many bytes; with `fail`, it errors there.
 */
function source(length, { chunk = 16 * 1024, stall = null, fail = null } = {}) {
  const state = { read: 0, cancelled: false };
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (stall !== null && state.read >= stall) return new Promise(() => {});
        if (fail !== null && state.read >= fail) {
          controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
          return undefined;
        }
        if (state.read >= length) {
          controller.close();
          return undefined;
        }
        const n = Math.min(chunk, length - state.read);
        controller.enqueue(new Uint8Array(pattern(state.read, n)));
        state.read += n;
        return undefined;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

/**
 * A fake node behind a captured backend: `answer(init)` gives each attempt's
 * Response (or throws). Every attempt's `init` is kept.
 */
function fakeNode(kind, answer) {
  const node = { attempts: [] };
  node.backend = {
    ref: kind === 'ant' ? { ant: 'external', up: true } : { ipfs: 'gateway', up: true },
    url: 'http://node.test',
    request: jest.fn(async (init) => {
      node.attempts.push(init);
      return answer(init, node.attempts.length);
    }),
  };
  return node;
}

function plan(node, { attempts = 1, idleMs = 10_000, headersMs = 30_000 } = {}) {
  return {
    verify: {
      node,
      retry: {
        statuses: node === 'ant' ? [500, 502, 503, 504] : [],
        on_error: node === 'ant',
        attempts,
        delays_ms: Array.from({ length: attempts - 1 }, () => 1),
      },
      timers: {
        queue_ms: null,
        headers_ms: node === 'ant' ? headersMs : null,
        body_idle_ms: idleMs,
      },
    },
  };
}

const chunk = (address = HEX64) => ({
  path: `/chunks/${address}`,
  headers: SWARM,
  stream: false,
  max_bytes: 4201,
});
const bytes = (from, to, reference = HEX64) => ({
  path: `/bytes/${reference}`,
  headers: [...SWARM, ['range', `bytes=${from}-${to}`]],
  stream: true,
  max_bytes: null,
});
const feed = () => ({
  path: `/feeds/${HEX40}/${HEX64}`,
  headers: [...SWARM, ['swarm-only-root-chunk', 'true']],
  stream: false,
  max_bytes: 65_536,
});
const car = (path = CAR) => ({
  path,
  headers: [['accept', CAR_ACCEPT]],
  stream: true,
  max_bytes: null,
});
const raw = (cid = CID1) => ({
  path: `/ipfs/${cid}?format=raw`,
  headers: [['accept', RAW_ACCEPT]],
  stream: true,
  max_bytes: 2 * 1024 * 1024,
});
const record = (name = IPNS) => ({
  path: `/ipns/${name}?format=ipns-record`,
  headers: [['accept', RECORD_ACCEPT]],
  stream: false,
  max_bytes: 10_240,
});

const quietLog = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('the handler, as the client calls it', () => {
  let log;
  let shell;
  beforeEach(() => {
    log = quietLog();
    shell = new DwebShell({ log });
  });

  /** Opens `dweb.verify` 7 of generation 1 on `node`'s backend. */
  function open(node, nodeName, options) {
    return shell.open(
      { generation: 1, id: 7 },
      { backend: node.backend, plan: plan(nodeName, options) }
    );
  }

  function get(
    piece,
    { generation = 1, signal = new AbortController().signal, charge = () => true } = {}
  ) {
    return shell.get({ for: 7, ...piece }, { signal, charge, streams: true, generation });
  }

  const refused = (promise) =>
    expect(promise).rejects.toEqual(expect.objectContaining({ code: 'invalid_argument' }));

  test('a chunk: one GET through the captured backend, read whole, with only the headers the core reads', async () => {
    const body = pattern(0, 4104);
    const node = fakeNode(
      'ant',
      () =>
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
            etag: '"x"',
            'set-cookie': 'a=b',
            'swarm-tag': '1',
          },
        })
    );
    open(node, 'ant', { headersMs: 12_345 });
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const reply = await get(chunk());
      expect(reply).toEqual({
        status: 200,
        headers: [
          ['content-type', 'application/octet-stream'],
          ['content-length', '4104'],
        ],
        body_base64: body.toString('base64'),
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(node.attempts).toHaveLength(1);
    const [init] = node.attempts;
    expect(init.path).toBe(`/chunks/${HEX64}`);
    expect(init.method).toBe('GET');
    expect([...init.headers]).toEqual([...new Headers(SWARM)]);
    expect(init.headersTimeoutMs).toBe(12_345);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(shell.stats()).toEqual({ verifies: 1, pieces: 0 });
  });

  test("a feed lookup's index header passes; a node's own 404 is a whole reply, not a failure", async () => {
    const node = fakeNode('ant', ({ path }) =>
      path.startsWith('/feeds/')
        ? new Response('soc', { status: 200, headers: { 'swarm-feed-index': '000000000000002a' } })
        : new Response('{"code":404}', {
            status: 404,
            headers: { 'content-type': 'application/json' },
          })
    );
    open(node, 'ant');
    await expect(get(feed())).resolves.toEqual({
      status: 200,
      headers: [
        ['content-type', 'text/plain;charset=UTF-8'],
        ['swarm-feed-index', '000000000000002a'],
      ],
      body_base64: Buffer.from('soc').toString('base64'),
    });
    await expect(get(chunk())).resolves.toEqual({
      status: 404,
      headers: [['content-type', 'application/json']],
      body_base64: Buffer.from('{"code":404}').toString('base64'),
    });
  });

  test('an IPNS record is read whole from the gateway, without its content-length', async () => {
    const node = fakeNode(
      'gateway',
      () =>
        new Response('record', {
          status: 200,
          headers: { 'content-type': RECORD_ACCEPT, 'content-length': '6' },
        })
    );
    open(node, 'ipfs');
    await expect(get(record())).resolves.toEqual({
      status: 200,
      headers: [['content-type', RECORD_ACCEPT]],
      body_base64: Buffer.from('record').toString('base64'),
    });
    expect([...node.attempts[0].headers]).toEqual([['accept', RECORD_ACCEPT]]);
    expect(node.attempts[0].headersTimeoutMs).toBeNull();
  });

  test("a content-length beside a content-encoding isn't the body's, so it is dropped", async () => {
    const node = fakeNode(
      'ant',
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-encoding': 'gzip', 'content-length': '999999' },
        })
    );
    open(node, 'ant');
    const reply = await get(chunk());
    expect(reply.headers).toEqual([['content-type', 'text/plain;charset=UTF-8']]);
  });

  test("Ant's retries: a 503 then a 200, the 503's body cancelled first; ten 500s answer the last", async () => {
    const first = source(1000);
    const node = fakeNode('ant', (_init, n) =>
      n === 1 ? new Response(first.stream, { status: 503 }) : new Response('ok', { status: 200 })
    );
    open(node, 'ant', { attempts: 10 });
    const reply = await get(chunk());
    expect(reply.status).toBe(200);
    expect(first.cancelled).toBe(true);
    expect(node.attempts).toHaveLength(2);

    const always = fakeNode('ant', () => new Response('busy', { status: 500 }));
    shell.open(
      { generation: 1, id: 8 },
      { backend: always.backend, plan: plan('ant', { attempts: 10 }) }
    );
    const last = await shell.get(
      { for: 8, ...chunk() },
      { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
    );
    expect(last).toMatchObject({
      status: 500,
      body_base64: Buffer.from('busy').toString('base64'),
    });
    expect(always.attempts).toHaveLength(10);
  });

  test.each([
    [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'unreachable'],
    [Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }), 'unreachable'],
    [Object.assign(new Error('dns'), { cause: { code: 'ENOTFOUND' } }), 'unreachable'],
    [Object.assign(new Error('bee fetch timed out'), { code: 'ATTEMPT_TIMEOUT' }), 'error'],
    [new Error('anything else'), 'error'],
    [new DOMException('aborted', 'AbortError'), 'aborted'],
  ])('a dial that throws %s is failed: %s', async (error, failed) => {
    const node = fakeNode('ant', () => {
      throw error;
    });
    open(node, 'ant', { attempts: 3 });
    await expect(get(chunk())).resolves.toEqual({ failed });
  });

  test("a retry's log names only an error code, never text from the node (F-6)", async () => {
    const leak = 'no /ipfs/secret-page?next=https://private.example';
    const node = fakeNode('ant', () => {
      throw Object.assign(new Error('dial failed'), { code: leak });
    });
    open(node, 'ant', { attempts: 2 });
    await expect(get(chunk())).resolves.toEqual({ failed: 'error' });
    expect(node.attempts).toHaveLength(2);
    const lines = log.debug.mock.calls
      .map((args) => args.join(' '))
      .filter((l) => l.includes('retry'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(status=error)');
    expect(lines.join('\n')).not.toContain('secret-page');
    expect(lines.join('\n')).not.toContain('private.example');
  });

  test('too_large: a whole piece declaring more than max_bytes, or reading more; a raw block declaring more', async () => {
    const declared = source(10);
    let answer = () =>
      new Response(declared.stream, { status: 200, headers: { 'content-length': '4202' } });
    const node = fakeNode('ant', () => answer());
    open(node, 'ant');
    await expect(get(chunk())).resolves.toEqual({ failed: 'too_large' });
    expect(declared.cancelled).toBe(true);
    expect(declared.read).toBe(0);

    const long = source(100_000, { chunk: 1000 });
    answer = () => new Response(long.stream, { status: 200 });
    await expect(get(chunk())).resolves.toEqual({ failed: 'too_large' });
    expect(long.cancelled).toBe(true);
    // Read only one chunk past the bound.
    expect(long.read).toBeLessThanOrEqual(4201 + 1000);
    // Exactly at the bound is whole.
    const exact = source(4201, { chunk: 1000 });
    answer = () => new Response(exact.stream, { status: 200 });
    expect((await get(chunk())).body_base64).toBe(pattern(0, 4201).toString('base64'));

    const ipfs = fakeNode(
      'ant',
      () =>
        new Response('x', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
        })
    );
    // A raw block from an Ant-shaped backend whose length is trusted: the
    // gateway's own transport decodes, so its lengths aren't, below.
    const raws = new DwebShell({ log });
    raws.open(
      { generation: 1, id: 7 },
      {
        backend: { ...ipfs.backend, ref: { ipfs: 'native', up: true } },
        plan: plan('ipfs'),
      }
    );
    await expect(
      raws.get(
        { for: 7, ...raw() },
        { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
      )
    ).resolves.toEqual({ failed: 'too_large' });
  });

  test('a header value past 8 KiB fails the piece (error), logged; one at 8 KiB passes', async () => {
    let type = 'x'.repeat(MAX_HEADER + 1);
    const node = fakeNode(
      'ant',
      () => new Response('x', { status: 200, headers: { 'content-type': type } })
    );
    open(node, 'ant');
    await expect(get(chunk())).resolves.toEqual({ failed: 'error' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('past the reply bounds'));
    // obs-text counts as the UTF-8 it is written in.
    type = `${'x'.repeat(MAX_HEADER - 1)}é`;
    await expect(get(chunk())).resolves.toEqual({ failed: 'error' });
    type = 'x'.repeat(MAX_HEADER);
    const reply = await get(chunk());
    expect(reply.headers).toEqual([['content-type', type]]);
  });

  test('the reply never carries more than the four headers, a repeated one as one', async () => {
    const node = fakeNode('ant', () => {
      const headers = new Headers();
      for (let i = 0; i < 20; i++) headers.append('content-type', `t${i}`);
      for (let i = 0; i < 20; i++) headers.append(`x-${i}`, 'y');
      headers.append('content-range', 'bytes 0-0/1');
      headers.append('swarm-feed-index', '01');
      headers.append('content-length', '1');
      return new Response('x', { status: 200, headers });
    });
    open(node, 'ant');
    const reply = await get(chunk());
    expect(reply.headers.map(([name]) => name)).toEqual([
      'content-type',
      'content-length',
      'content-range',
      'swarm-feed-index',
    ]);
    expect(reply.headers.length).toBeLessThanOrEqual(8);
  });

  test("main's pool: a whole body past it is busy", async () => {
    const node = fakeNode('ant', () => new Response(pattern(0, 4000), { status: 200 }));
    open(node, 'ant');
    await expect(get(chunk(), { charge: () => false })).rejects.toEqual(
      expect.objectContaining({ code: 'busy' })
    );
    // The base64 copy is charged too.
    let calls = 0;
    await expect(get(chunk(), { charge: () => ++calls < 2 })).rejects.toEqual(
      expect.objectContaining({ code: 'busy' })
    );
  });

  test('a stalled whole body is an error once the body idle timer fires, and the node is let go of', async () => {
    const stalled = source(10_000, { stall: 1000, chunk: 500 });
    const node = fakeNode('ant', () => new Response(stalled.stream, { status: 200 }));
    open(node, 'ant', { idleMs: 30 });
    await expect(get(chunk())).resolves.toEqual({ failed: 'error' });
    expect(stalled.cancelled).toBe(true);
  });

  describe('params, read strictly before any dial', () => {
    let node;
    beforeEach(() => {
      node = fakeNode('ant', () => new Response('x'));
      open(node, 'ant');
    });
    afterEach(() => {
      expect(node.backend.request).not.toHaveBeenCalled();
    });

    test.each([
      ['an unknown member', { ...chunk(), extra: 1 }],
      ['a missing member', (({ max_bytes: _m, ...rest }) => rest)(chunk())],
      ['for as text', { ...chunk(), for: '7' }],
      ['for zero', { ...chunk(), for: 0 }],
      ['path not a string', { ...chunk(), path: ['/chunks/x'] }],
      ['stream as text', { ...chunk(), stream: 'false' }],
      ['max_bytes as text', { ...chunk(), max_bytes: '4201' }],
      ['max_bytes negative', { ...chunk(), max_bytes: -1 }],
      ['max_bytes fractional', { ...chunk(), max_bytes: 1.5 }],
      ['headers an object', { ...chunk(), headers: Object.fromEntries(SWARM) }],
      ['a header triple', { ...chunk(), headers: [...SWARM.slice(1), ['a', 'b', 'c']] }],
      ['a header value not text', { ...chunk(), headers: [...SWARM.slice(1), [SWARM[0][0], 30]] }],
    ])('%s is invalid_argument, logged as a core fault', async (_what, params) => {
      await refused(
        shell.get(
          { for: 7, ...params },
          { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
        )
      );
      expect(log.error).toHaveBeenCalledWith('[Core] shell.dweb_get refused (shape)');
    });

    test('params that are not an object', async () => {
      for (const params of [null, [], 'x']) {
        await refused(
          shell.get(params, {
            signal: new AbortController().signal,
            charge: () => true,
            streams: true,
            generation: 1,
          })
        );
      }
    });

    test.each([
      ['uppercase hex', chunk(HEX64.toUpperCase())],
      ['63 hex', chunk(HEX64.slice(1))],
      ['a 128-hex (encrypted) reference', chunk(HEX64 + HEX64)],
      ['a bzz path', { ...chunk(), path: `/bzz/${HEX64}/index.html` }],
      ['a chunk with a query', { ...chunk(), path: `/chunks/${HEX64}?x=1` }],
      ['a chunk below its address', { ...chunk(), path: `/chunks/${HEX64}/x` }],
      ['a feed with a short owner', { ...feed(), path: `/feeds/${HEX40.slice(2)}/${HEX64}` }],
      ['an IPFS path on Ant', raw()],
      ['a climb', { ...chunk(), path: `/chunks/../bytes/${HEX64}` }],
    ])("Ant's path forms: %s is refused at path", async (_what, piece) => {
      await refused(get(piece));
      expect(log.error).toHaveBeenCalledWith('[Core] shell.dweb_get refused (path)');
    });

    test.each([
      ['a missing retrieval header', { ...chunk(), headers: SWARM.slice(1) }],
      [
        'a retrieval header at another value',
        { ...chunk(), headers: [[SWARM[0][0], '60s'], ...SWARM.slice(1)] },
      ],
      ['an extra header', { ...chunk(), headers: [...SWARM, ['user-agent', 'x']] }],
      ['a repeated header', { ...chunk(), headers: [...SWARM, SWARM[0]] }],
      ['a range on a chunk', { ...chunk(), headers: [...SWARM, ['range', 'bytes=0-1']] }],
      ['bytes without its range', { ...bytes(0, 1), headers: SWARM }],
      ['a reversed range', bytes(10, 9)],
      ['an open range', { ...bytes(0, 1), headers: [...SWARM, ['range', 'bytes=0-']] }],
      ['a suffix range', { ...bytes(0, 1), headers: [...SWARM, ['range', 'bytes=-5']] }],
      ['two ranges', { ...bytes(0, 1), headers: [...SWARM, ['range', 'bytes=0-1,4-5']] }],
      ['a feed without root-chunk-only', { ...feed(), headers: SWARM }],
      [
        'root-chunk-only at false',
        { ...feed(), headers: [...SWARM, ['swarm-only-root-chunk', 'false']] },
      ],
      ['an uppercase name', { ...chunk(), headers: SWARM.map(([n, v]) => [n.toUpperCase(), v]) }],
    ])("Ant's headers: %s is refused at header", async (_what, piece) => {
      await refused(get(piece));
      expect(log.error).toHaveBeenCalledWith('[Core] shell.dweb_get refused (header)');
    });

    test.each([
      ['a chunk streamed', { ...chunk(), stream: true }, 'stream'],
      ['bytes whole', { ...bytes(0, 1), stream: false }, 'stream'],
      ['a feed streamed', { ...feed(), stream: true }, 'stream'],
      ['a chunk with no bound', { ...chunk(), max_bytes: null }, 'max_bytes'],
      ['a chunk past 64 KiB', { ...chunk(), max_bytes: 65_537 }, 'max_bytes'],
      ['a chunk bound of 0', { ...chunk(), max_bytes: 0 }, 'max_bytes'],
      ['bytes with a bound', { ...bytes(0, 1), max_bytes: 100 }, 'max_bytes'],
    ])("Ant's stream and bound: %s is refused at %s", async (_what, piece, at) => {
      await refused(get(piece));
      expect(log.error).toHaveBeenCalledWith(`[Core] shell.dweb_get refused (${at})`);
    });

    test('a `for` that was never opened is a fault; one that has ended is refused quietly', async () => {
      await refused(
        shell.get(
          { for: 99, ...chunk() },
          { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
        )
      );
      expect(log.error).toHaveBeenCalledWith('[Core] shell.dweb_get refused (for)');
      log.error.mockClear();
      const ended = shell.open(
        { generation: 1, id: 12 },
        { backend: node.backend, plan: plan('ant') }
      );
      ended.close();
      ended.close();
      await refused(
        shell.get(
          { for: 12, ...chunk() },
          { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
        )
      );
      // An earlier ID, never opened, is below the highest: the race's case.
      await refused(
        shell.get(
          { for: 3, ...chunk() },
          { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
        )
      );
      expect(log.error).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalled();
    });

    test("another generation's request of the same ID is not this one", async () => {
      await refused(get(chunk(), { generation: 2 }));
      expect(log.error).toHaveBeenCalledWith('[Core] shell.dweb_get refused (for)');
    });
  });

  describe("IPFS's forms", () => {
    let node;
    beforeEach(() => {
      node = fakeNode('gateway', () => new Response('x'));
      open(node, 'ipfs');
    });

    test.each([
      ['the root alone', `/ipfs/${CID1}?format=car&dag-scope=entity`],
      ['a path below it', CAR],
      ['an encoded segment', `/ipfs/${CID1}/a%20b/c%2Fd.html?format=car&dag-scope=entity`],
      ['a range from an offset', `${CAR}&entity-bytes=100:*`],
      ['a suffix', `${CAR}&entity-bytes=-500:*`],
      ['a closed range', `${CAR}&entity-bytes=100:199`],
      ["GatewayCore's refused range", `${CAR}&entity-bytes=0:0`],
      ["a HEAD's sniff", `${CAR}&entity-bytes=0:512`],
      ['a CIDv0 index', `/ipfs/${CID0}?format=car&dag-scope=entity`],
    ])('a CAR: %s', async (_what, path) => {
      const reply = await get(car(path));
      expect(reply.result ?? reply).toMatchObject({ status: 200 });
      expect(node.attempts.at(-1)).toMatchObject({ path, method: 'GET' });
      expect([...node.attempts.at(-1).headers]).toEqual([['accept', CAR_ACCEPT]]);
      reply.discard?.();
    });

    test('raw blocks, a CIDv1 and a CIDv0, and a record', async () => {
      for (const piece of [
        raw(),
        raw(CID0),
        record(),
        record('bafzaajaiaejcbzdibmxyzdjbbehgvizh6g5tikvy47mshdy6gwbruvgwvd24seje'),
      ]) {
        const reply = await get(piece);
        expect(reply.result ?? reply).toMatchObject({ status: 200 });
        reply.discard?.();
      }
      expect(node.attempts.map(({ path }) => path)).toEqual([
        `/ipfs/${CID1}?format=raw`,
        `/ipfs/${CID0}?format=raw`,
        `/ipns/${IPNS}?format=ipns-record`,
        '/ipns/bafzaajaiaejcbzdibmxyzdjbbehgvizh6g5tikvy47mshdy6gwbruvgwvd24seje?format=ipns-record',
      ]);
    });

    test.each([
      [
        'an uppercase CIDv1',
        car(`/ipfs/${CID1.toUpperCase()}?format=car&dag-scope=entity`),
        'path',
      ],
      // Text in a CID's alphabet that isn't a CID the core could write.
      ['a raw block of an incomplete base32 quantum', raw('ba'), 'path'],
      [
        'a CAR of an incomplete base32 quantum',
        car('/ipfs/ba?format=car&dag-scope=entity'),
        'path',
      ],
      ['a raw block of a truncated CIDv1', raw(CID1.slice(0, -2)), 'path'],
      ["a raw block whose CIDv1's padding bits aren't zero", raw(`${CID1.slice(0, -1)}n`), 'path'],
      ['a raw block of a CIDv1 with a character more', raw(`${CID1}a`), 'path'],
      ['a raw block of a version-2 CID', raw(VERSION2), 'path'],
      ['a CAR of a version-2 CID', car(`/ipfs/${VERSION2}?format=car&dag-scope=entity`), 'path'],
      ['a raw block of a CIDv0 below its multihash', raw(`Qm${'1'.repeat(44)}`), 'path'],
      ['a raw block of a CIDv0 above its multihash', raw(`Qm${'z'.repeat(44)}`), 'path'],
      [
        'a CAR of a malformed CIDv0',
        car(`/ipfs/Qm${'z'.repeat(44)}?format=car&dag-scope=entity`),
        'path',
      ],
      ['a raw block of a CIDv0 one character short', raw(CID0.slice(0, -1)), 'path'],
      ['a record of text that is not a CID', record('kNOTACID'), 'path'],
      ['a record of an uppercase base36 key', record(`k${IPNS.slice(1).toUpperCase()}`), 'path'],
      [
        'a record of a base36 key with an uppercase character',
        record(`${IPNS.slice(0, -1)}V`),
        'path',
      ],
      ['a record of a truncated base36 key', record(IPNS.slice(0, -1)), 'path'],
      ['a record of a dag-pb CID', record(CID1), 'path'],
      ['a record of a raw CID in base36', record(RAW36), 'path'],
      ['a record of a version-2 key', record(KEY_VERSION2), 'path'],
      ['a record of a CIDv0', record(CID0), 'path'],
      ['a record of an IPNS name too long to be a CID', record(`k${'1'.repeat(270)}`), 'path'],
      ['a CAR without its query', car(`/ipfs/${CID1}/docs`), 'path'],
      ['a CAR with another query', car(`${CAR}&foo=1`), 'path'],
      ['a CAR with a fragment', car(`${CAR}#x`), 'path'],
      ['a CAR with a bad range', car(`${CAR}&entity-bytes=a:b`), 'path'],
      [
        'a CAR whose path climbs',
        car(`/ipfs/${CID1}/%2e%2e/x?format=car&dag-scope=entity`),
        'path',
      ],
      [
        'a CAR whose path climbs as written',
        car(`/ipfs/${CID1}/../x?format=car&dag-scope=entity`),
        'path',
      ],
      ['a CAR on ipns', car(`/ipns/${IPNS}?format=car&dag-scope=entity`), 'path'],
      ['a raw block below its CID', raw(`${CID1}/x`), 'path'],
      ['a raw block with another format', { ...raw(), path: `/ipfs/${CID1}?format=car` }, 'path'],
      ['a record for a CID path', record(`${IPNS}/x`), 'path'],
      ['a DNSLink name', record('example.com'), 'path'],
      ['an Ant path on IPFS', chunk(), 'path'],
      ['a CAR with the raw accept', { ...car(), headers: [['accept', RAW_ACCEPT]] }, 'header'],
      [
        'a CAR with a range',
        {
          ...car(),
          headers: [
            ['accept', CAR_ACCEPT],
            ['range', 'bytes=0-1'],
          ],
        },
        'header',
      ],
      ['a raw block without accept', { ...raw(), headers: [] }, 'header'],
      [
        'a record with a second accept',
        {
          ...record(),
          headers: [
            ['accept', RECORD_ACCEPT],
            ['accept', RECORD_ACCEPT],
          ],
        },
        'header',
      ],
      ['a raw block whole', { ...raw(), stream: false }, 'stream'],
      ['a CAR whole', { ...car(), stream: false }, 'stream'],
      ['a record streamed', { ...record(), stream: true }, 'stream'],
      ['a raw block past 2 MiB', { ...raw(), max_bytes: 2 * 1024 * 1024 + 1 }, 'max_bytes'],
      ['a raw block with no bound', { ...raw(), max_bytes: null }, 'max_bytes'],
      ['a CAR with a bound', { ...car(), max_bytes: 1000 }, 'max_bytes'],
      ['a record past 64 KiB', { ...record(), max_bytes: 65_537 }, 'max_bytes'],
    ])('%s is refused at %s, before any dial', async (_what, piece, at) => {
      await refused(get(piece));
      expect(log.error).toHaveBeenCalledWith(`[Core] shell.dweb_get refused (${at})`);
      expect(node.backend.request).not.toHaveBeenCalled();
    });
  });

  test('without the duplex there is no shell.dweb_get', async () => {
    await expect(
      shell.get(
        { for: 7, ...chunk() },
        { signal: new AbortController().signal, charge: () => true, streams: false, generation: 1 }
      )
    ).rejects.toEqual(new ShellError('unknown_method'));
  });

  test('open() takes only a captured backend and its own verify plan', () => {
    const node = fakeNode('ant', () => new Response('x'));
    const key = { generation: 1, id: 20 };
    expect(() => shell.open(key, { backend: node.backend, plan: plan('ipfs') })).toThrow(TypeError);
    expect(() => shell.open(key, { backend: node.backend, plan: { fetch: {} } })).toThrow(
      TypeError
    );
    expect(() => shell.open(key, { backend: { ref: {} }, plan: plan('ant') })).toThrow(TypeError);
    expect(() =>
      shell.open({ generation: 1, id: 0 }, { backend: node.backend, plan: plan('ant') })
    ).toThrow(TypeError);
    shell.open(key, { backend: node.backend, plan: plan('ant') });
    expect(() => shell.open(key, { backend: node.backend, plan: plan('ant') })).toThrow(TypeError);
  });

  test("the request's end, its page's abort or its session's close stops a dial", async () => {
    for (const how of ['close', 'signal', 'stop']) {
      const page = new AbortController();
      const session = new AbortController();
      let dialSignal;
      const node = fakeNode('ant', ({ signal }) => {
        dialSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        );
      });
      const fresh = new DwebShell({ log });
      const handle = fresh.open(
        { generation: 1, id: 7 },
        {
          backend: node.backend,
          plan: plan('ant', { attempts: 10 }),
          signal: page.signal,
          stop: session.signal,
        }
      );
      const pending = fresh.get(
        { for: 7, ...chunk() },
        { signal: new AbortController().signal, charge: () => true, streams: true, generation: 1 }
      );
      await until(() => dialSignal, 'the dial');
      expect(fresh.stats()).toEqual({ verifies: 1, pieces: 1 });
      if (how === 'close') handle.close();
      if (how === 'signal') page.abort();
      if (how === 'stop') session.abort();
      await expect(pending).resolves.toEqual({ failed: 'aborted' });
      // No retry after the abort.
      expect(node.attempts).toHaveLength(1);
      expect(fresh.stats()).toEqual({ verifies: 0, pieces: 0 });
    }
  });

  test('a request whose session had closed is never opened for long', () => {
    const session = new AbortController();
    session.abort();
    const node = fakeNode('ant', () => new Response('x'));
    shell.open(
      { generation: 1, id: 30 },
      { backend: node.backend, plan: plan('ant'), stop: session.signal }
    );
    expect(shell.stats().verifies).toBe(0);
  });
});

/**
 * A scripted freedom-cored at protocol 2: it answers the hello and
 * shutdown, sends `shell.dweb_get`s, and reads main's replies and stream
 * frames as the core does.
 */
class FakeCore extends EventEmitter {
  constructor() {
    super();
    this.pid = 4343;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.streams = [];
    this.nextId = 1;
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (bytes, _encoding, callback) => {
        for (const frame of this.decoder.push(bytes)) {
          if (frame.kind !== KIND_JSON) {
            this.streams.push(frame);
            continue;
          }
          this.messages.push(frame.message);
          this.onMessage(frame.message);
        }
        callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  onMessage(message) {
    if (message.method === 'core.hello') {
      // The pinned core: protocol 2, streams from the hello on.
      this.send({
        type: 'response',
        id: message.id,
        result: { protocol: 2, core_version: '0.15.0', capabilities: ['fragments', 'streams'] },
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
    } else if (message.method === 'core.shutdown') {
      this.send({ type: 'response', id: message.id, result: {} });
    }
  }

  send(message) {
    this.stdout.write(encodeFrame(message));
  }

  /** A `shell.dweb_get` for main's request `forId`: its ID. */
  ask(forId, piece) {
    const id = this.nextId++;
    this.send({
      type: 'request',
      id,
      method: 'shell.dweb_get',
      params: { for: forId, ...piece },
      context: { caller: 'core' },
    });
    return id;
  }

  credit(id, n) {
    this.stdout.write(encodeStreamCredit(id, n));
  }

  cancel(id) {
    this.send({ type: 'cancel', id });
  }

  reply(id) {
    return this.messages.find((m) => m.type === 'response' && m.id === id);
  }

  framesOf(kind, id) {
    return this.streams.filter((frame) => frame.kind === kind && frame.id === id);
  }

  dataOf(id) {
    return Buffer.concat(this.framesOf(KIND_DATA, id).map((frame) => Buffer.from(frame.bytes)));
  }

  ended(id) {
    return this.framesOf(KIND_END, id).length > 0 || this.framesOf(KIND_ABORT, id).length > 0;
  }

  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, signal);
    });
  }

  kill(signal) {
    setImmediate(() => this.exit(null, signal));
    return true;
  }
}

describe('through the core client at protocol 2', () => {
  let client;
  let core;
  let shell;
  let log;

  async function start() {
    log = quietLog();
    client = new CoreClient({
      spawn: jest.fn(() => {
        core = new FakeCore();
        return core;
      }),
      command: '/bin/freedom-cored',
      args: ['serve'],
      log,
      shellVersion: 'test',
      grantRoot: os.tmpdir(),
      setTimer: (fn, ms) => ({ fn, ms }),
      clearTimer: () => {},
    });
    shell = registerDwebShell(client, { log });
    await client.start();
  }

  afterEach(async () => {
    if (client && client.state !== 'stopped' && client.state !== 'failed') await client.stop();
    client = null;
  });

  /** Main's `dweb.verify`, as the handler for `{ verify }` plans sends it:
   * opened under the ID and generation `onSent` reports. */
  function verify(node, nodeName, options = {}) {
    let handle = null;
    let key = null;
    const answered = client
      .callStream(
        'dweb.verify',
        { plan: plan(nodeName, options) },
        { caller: 'shell' },
        {
          onSent: (id, generation) => {
            key = { id, generation };
            handle = shell.open(key, {
              backend: node.backend,
              plan: plan(nodeName, options),
              stop: options.stop ?? null,
            });
          },
        }
      )
      .catch(() => {});
    return {
      get handle() {
        return handle;
      },
      get key() {
        return key;
      },
      answered,
    };
  }

  /** Credits every byte main has sent of `id`, past the `credited` it has
   * already, until it ends. */
  async function drain(id, credited = 0) {
    while (!core.ended(id)) {
      const sent = core.dataOf(id).length;
      if (sent > credited) {
        core.credit(id, sent - credited);
        credited = sent;
      }
      await tick();
    }
  }

  test("onSent names main's request and its generation: the core's `for`", async () => {
    await start();
    const node = fakeNode('ant', () => new Response('chunk', { status: 200 }));
    const v = verify(node, 'ant');
    expect(v.key).toEqual({ id: expect.any(Number), generation: client.current.number });
    await until(() => core.messages.find((m) => m.method === 'dweb.verify'), 'the request');
    const sent = core.messages.find((m) => m.method === 'dweb.verify');
    expect(sent.id).toBe(v.key.id);
    const id = core.ask(v.key.id, chunk());
    await until(() => core.reply(id), 'the reply');
    expect(core.reply(id)).toEqual({
      type: 'response',
      id,
      result: {
        status: 200,
        headers: [['content-type', 'text/plain;charset=UTF-8']],
        body_base64: Buffer.from('chunk').toString('base64'),
      },
    });
  });

  test('a refusal reaches the core as invalid_argument', async () => {
    await start();
    const node = fakeNode('ant', () => new Response('x'));
    const v = verify(node, 'ant');
    const id = core.ask(v.key.id, { ...chunk(), extra: true });
    await until(() => core.reply(id), 'the reply');
    expect(core.reply(id).error).toEqual({ code: 'invalid_argument', message: 'Invalid argument' });
    const failed = core.ask(v.key.id, chunk(HEX64.slice(2)));
    await until(() => core.reply(failed), 'the reply');
    expect(core.reply(failed).error.code).toBe('invalid_argument');
  });

  test('a ranged /bytes stream: the head, then the bytes under credit, then end', async () => {
    await start();
    const body = source(300_000);
    const node = fakeNode(
      'ant',
      () =>
        new Response(body.stream, {
          status: 206,
          headers: { 'content-range': 'bytes 1000-300999/400000', 'content-length': '300000' },
        })
    );
    const v = verify(node, 'ant');
    const id = core.ask(v.key.id, bytes(1000, 300_999));
    await until(() => core.reply(id), 'the head');
    expect(core.reply(id).result).toEqual({
      status: 206,
      headers: [
        ['content-length', '300000'],
        ['content-range', 'bytes 1000-300999/400000'],
      ],
      body: true,
    });
    await drain(id);
    expect(core.framesOf(KIND_END, id)).toHaveLength(1);
    expect(core.dataOf(id).equals(pattern(0, 300_000))).toBe(true);
    expect([...node.attempts[0].headers]).toContainEqual(['range', 'bytes=1000-300999']);
    await until(() => shell.stats().pieces === 0, 'the piece freed');
    expect(body.cancelled).toBe(false);
  });

  test("credit backpressure: without the core's credit main sends one window, and reads the node no further than a chunk past it", async () => {
    await start();
    const body = source(1024 * 1024, { chunk: 16 * 1024 });
    const node = fakeNode('gateway', () => new Response(body.stream, { status: 200 }));
    const v = verify(node, 'ipfs', { idleMs: 40 });
    const id = core.ask(v.key.id, car());
    await until(() => core.dataOf(id).length === WINDOW, 'the first window');
    // Past the body idle bound, with no credit: no read is pending, so
    // nothing stalls.
    await sleep(120);
    expect(core.dataOf(id).length).toBe(WINDOW);
    expect(body.read).toBeLessThanOrEqual(WINDOW + MAX_DATA);
    expect(core.ended(id)).toBe(false);
    // Each credit lets that much more go, and no more.
    core.credit(id, 10_000);
    await until(() => core.dataOf(id).length === WINDOW + 10_000, 'the credited bytes');
    for (let i = 0; i < 20; i++) await tick();
    expect(core.dataOf(id).length).toBe(WINDOW + 10_000);
    expect(body.read).toBeLessThanOrEqual(WINDOW + 10_000 + MAX_DATA);
    await drain(id, 10_000);
    expect(core.framesOf(KIND_END, id)).toHaveLength(1);
    expect(core.dataOf(id).equals(pattern(0, 1024 * 1024))).toBe(true);
  });

  test("one 8 MiB chunk from the node goes out 64 KiB at a time, only as the core's credit allows", async () => {
    await start();
    const length = 8 * 1024 * 1024;
    const body = source(length, { chunk: length });
    const node = fakeNode('gateway', () => new Response(body.stream, { status: 200 }));
    const v = verify(node, 'ipfs');
    const id = core.ask(v.key.id, car());
    await until(() => core.dataOf(id).length === WINDOW, 'the first window');
    for (let i = 0; i < 20; i++) await tick();
    expect(core.dataOf(id).length).toBe(WINDOW);
    const stats = client.streamStats();
    expect(stats.held + stats.pending).toBeLessThanOrEqual(WINDOW + MAX_DATA);
    await drain(id);
    expect(core.framesOf(KIND_END, id)).toHaveLength(1);
    expect(core.dataOf(id).equals(pattern(0, length))).toBe(true);
    for (const frame of core.framesOf(KIND_DATA, id)) {
      expect(frame.bytes.length).toBeLessThanOrEqual(MAX_DATA);
    }
    await until(() => shell.stats().pieces === 0, 'the piece freed');
  });

  test("main's body idle timer: a node that stops while the core has credit ends the stream stalled", async () => {
    await start();
    const body = source(500_000, { stall: 20_000, chunk: 10_000 });
    const node = fakeNode(
      'ant',
      () =>
        new Response(body.stream, {
          status: 206,
          headers: { 'content-range': 'bytes 0-499999/500000' },
        })
    );
    const v = verify(node, 'ant', { idleMs: 40 });
    const id = core.ask(v.key.id, bytes(0, 499_999));
    await until(() => core.ended(id), 'the abort');
    expect(core.framesOf(KIND_ABORT, id)[0]).toMatchObject({ code: 'stalled' });
    expect(core.dataOf(id).length).toBeLessThanOrEqual(20_000);
    expect(body.cancelled).toBe(true);
    await until(() => shell.stats().pieces === 0, 'the piece freed');
  });

  test("the node's body failing mid-stream ends it body_stream_error", async () => {
    await start();
    const body = source(100_000, { fail: 30_000, chunk: 10_000 });
    const node = fakeNode('gateway', () => new Response(body.stream, { status: 200 }));
    const v = verify(node, 'ipfs');
    const id = core.ask(v.key.id, raw());
    await until(() => core.ended(id), 'the abort');
    expect(core.framesOf(KIND_ABORT, id)[0]).toMatchObject({ code: 'body_stream_error' });
    // An abort purges what wasn't written yet: a prefix, at most what the
    // node sent.
    expect(core.dataOf(id).equals(pattern(0, core.dataOf(id).length))).toBe(true);
    expect(core.dataOf(id).length).toBeLessThanOrEqual(30_000);
    expect(body.cancelled).toBe(false);
  });

  test('a raw block past its 2 MiB after the head ends body_stream_error, read one chunk past it at most', async () => {
    await start();
    const max = 2 * 1024 * 1024;
    const body = source(max + 100_000, { chunk: 50_000 });
    const node = fakeNode('gateway', () => new Response(body.stream, { status: 200 }));
    const v = verify(node, 'ipfs');
    const id = core.ask(v.key.id, raw());
    await until(() => core.reply(id), 'the head');
    await drain(id);
    expect(core.framesOf(KIND_ABORT, id)[0]).toMatchObject({ code: 'body_stream_error' });
    expect(core.dataOf(id).length).toBeLessThanOrEqual(max);
    expect(body.read).toBeLessThanOrEqual(max + 50_000);
    expect(body.cancelled).toBe(true);
  });

  test("the core's cancel mid-dial aborts the dial; mid-body it ends cancelled and lets the node go", async () => {
    await start();
    let dialSignal = null;
    const held = fakeNode('ant', ({ signal }) => {
      dialSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      );
    });
    const v = verify(held, 'ant');
    const id = core.ask(v.key.id, chunk());
    await until(() => dialSignal, 'the dial');
    core.cancel(id);
    await until(() => core.reply(id), 'the reply');
    expect(dialSignal.aborted).toBe(true);
    expect(core.reply(id).error.code).toBe('cancelled');

    const body = source(1_000_000);
    const streaming = fakeNode('ant', () => new Response(body.stream, { status: 206 }));
    const w = verify(streaming, 'ant');
    const piece = core.ask(w.key.id, bytes(0, 999_999));
    await until(() => core.dataOf(piece).length > 0, 'the body');
    core.cancel(piece);
    await until(() => core.ended(piece), 'the abort');
    expect(core.framesOf(KIND_ABORT, piece)[0]).toMatchObject({ code: 'cancelled' });
    expect(body.cancelled).toBe(true);
    await until(() => shell.stats().pieces === 0, 'the pieces freed');
  });

  test.each([
    ["its dweb.verify's end", 'close', car(), 'body_stream_error'],
    ["its session's close", 'stop', car(), 'body_stream_error'],
    ["the node's failure", 'fail', car(), 'body_stream_error'],
    ["the node's failure under a raw block's bound", 'fail', raw(), 'body_stream_error'],
    ["the core's cancel", 'cancel', car(), 'cancelled'],
  ])(
    'a piece that has filled its window ends at once on %s, with no more credit',
    async (_what, how, piece, code) => {
      await start();
      const session = new AbortController();
      // A body that never ends, and can fail while nothing reads it.
      const node = { read: 0, cancelled: false, controller: null };
      const body = new ReadableStream(
        {
          start(controller) {
            node.controller = controller;
          },
          pull(controller) {
            controller.enqueue(new Uint8Array(pattern(node.read, 16 * 1024)));
            node.read += 16 * 1024;
          },
          cancel() {
            node.cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      const gateway = fakeNode('gateway', () => new Response(body, { status: 200 }));
      const v = verify(gateway, 'ipfs', { stop: session.signal });
      const id = core.ask(v.key.id, piece);
      await until(() => core.dataOf(id).length === WINDOW, 'the first window');
      // The window is full and no credit comes: nothing reads the body.
      for (let i = 0; i < 20; i++) await tick();
      expect(core.dataOf(id).length).toBe(WINDOW);
      expect(core.ended(id)).toBe(false);
      const read = node.read;
      if (how === 'close') v.handle.close();
      else if (how === 'stop') session.abort();
      else if (how === 'cancel') core.cancel(id);
      else node.controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      for (let i = 0; i < 3; i++) await tick();
      expect(core.framesOf(KIND_ABORT, id)).toEqual([expect.objectContaining({ code })]);
      expect(core.framesOf(KIND_END, id)).toEqual([]);
      expect(core.dataOf(id).length).toBe(WINDOW);
      expect(node.read).toBe(read);
      // The node let go of (a failed one has nothing to cancel), and nothing
      // of the piece held.
      expect(node.cancelled).toBe(how !== 'fail');
      expect(client.current.pieces.has(id)).toBe(false);
      expect(shell.stats().pieces).toBe(0);
      expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
    }
  );

  test('a streamed piece with no body ends at once; HEAD verifies ask GET pieces', async () => {
    await start();
    const node = fakeNode('gateway', () => new Response(null, { status: 204 }));
    const v = verify(node, 'ipfs');
    const id = core.ask(v.key.id, car(`${CAR}&entity-bytes=0:512`));
    await until(() => core.ended(id), 'the end');
    expect(core.reply(id).result).toEqual({ status: 204, headers: [], body: true });
    expect(core.framesOf(KIND_END, id)).toHaveLength(1);
    expect(node.attempts[0].method).toBe('GET');
  });

  test('a failed dial reaches the core as { failed }', async () => {
    await start();
    const node = fakeNode('ant', () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    });
    const v = verify(node, 'ant');
    const id = core.ask(v.key.id, bytes(0, 10));
    await until(() => core.reply(id), 'the reply');
    expect(core.reply(id)).toEqual({ type: 'response', id, result: { failed: 'unreachable' } });
    expect(core.framesOf(KIND_DATA, id)).toEqual([]);
  });
});
