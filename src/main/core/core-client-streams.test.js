/**
 * CoreClient's protocol 2 (freedom-core design 0009, Streams in the core)
 * against a scripted core: the hello that settles it, and stream frames in
 * both directions on the one connection. Main's own requests' bodies come
 * from the core and end only with its verified bodies' codes; the bodies
 * main sends in answer to the core's requests (`StreamedReply`) go under
 * the core's credit and end only with a piece's codes. Protocol 2 is the
 * only one CoreClient speaks: the pinned core (0.13.0) refuses 1.
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const {
  CoreClient,
  CoreError,
  StreamedReply,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_STREAMS,
} = require('./core-client');
const {
  encodeAbort,
  encodeData,
  encodeEnd,
  encodeFrame,
  encodeStreamCredit,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  JSON_KINDS,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_JSON,
  KIND_STREAM_CREDIT,
  MAX_DATA,
  WINDOW,
  WRITER_DATA_CAP,
} = require('./frame');
const { ServiceClient } = require('./service-client');
const { attachDwebVerify, detachDwebVerify } = require('./dweb-verify');
const { createFetchAdmission } = require('../dweb/fetch-admission');

const tick = () => new Promise(setImmediate);

async function until(predicate, what) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Byte `k` of stream `id`'s body. */
function body(id, offset, length) {
  const out = Buffer.allocUnsafe(length);
  const base = (id % 251) + (offset % 251);
  for (let i = 0; i < length; i++) out[i] = (base + i) % 251;
  return out;
}

const STREAM_KIND_NAMES = {
  [KIND_DATA]: 'data',
  [KIND_END]: 'end',
  [KIND_ABORT]: 'abort',
  [KIND_STREAM_CREDIT]: 'credit',
};

/** One of main's frames as `FakeCore#wire` names it: `<method>:<id>` for a
 * request, `<type>:<id>` for its other JSON messages (`cancel:7`), and
 * `<kind>:<id>` for a stream frame (`credit:7`). */
function named(frame) {
  if (frame.kind === KIND_JSON) {
    const { type, method, id } = frame.message;
    return type === 'request' ? `${method}:${id}` : `${type}:${id}`;
  }
  return `${STREAM_KIND_NAMES[frame.kind] ?? frame.kind}:${frame.id}`;
}

/**
 * A scripted freedom-cored: `handler(message, core)` answers main's JSON
 * messages. It reads main's frames as the core does: before the hello no
 * stream frames, and from a protocol-2 hello reply on all four kinds. Main's
 * JSON messages are in `messages`, its stream frames in `streams`.
 */
class FakeCore extends EventEmitter {
  constructor(handler) {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.streams = [];
    this.wire = []; // every frame of main's, in the order the core read them (`named`)
    this.stuck = false; // stdin reads main's writes but doesn't complete them
    this.held = []; // the write callbacks `stuck` holds back
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          this.wire.push(named(frame));
          if (frame.kind !== KIND_JSON) {
            this.streams.push(frame);
            continue;
          }
          this.messages.push(frame.message);
          handler(frame.message, this);
        }
        if (this.stuck) this.held.push(callback);
        else callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  send(message) {
    this.stdout.write(encodeFrame(message));
    // The core reads stream frames from its protocol-2 hello on.
    if (message.type === 'response' && message.result?.protocol === PROTOCOL_VERSION_STREAMS) {
      this.decoder.setKinds(CORE_STREAM_KINDS);
    }
  }

  write(bytes) {
    this.stdout.write(bytes);
  }

  /** Completes the oldest write `stuck` held back; the next stays stuck. */
  completeOne() {
    this.held.shift()?.();
  }

  /** Completes every write `stuck` held back, and those after. */
  release() {
    this.stuck = false;
    for (const callback of this.held.splice(0)) callback();
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

  /** Main's stream frames of `kind` for `id`. */
  framesOf(kind, id) {
    return this.streams.filter((frame) => frame.kind === kind && frame.id === id);
  }

  /** The bytes main sent in its data frames for `id`. */
  dataOf(id) {
    return Buffer.concat(this.framesOf(KIND_DATA, id).map((frame) => Buffer.from(frame.bytes)));
  }
}

function hello(protocol, capabilities = ['vault.status', 'fragments', 'streams']) {
  return { protocol, core_version: '0.13.0', capabilities };
}

/** Answers the hello at `protocol` (with `result` if given), shutdown, and
 * hands everything else to `extra`. */
function coreAt(protocol, extra = () => {}, result = hello(protocol)) {
  return (message, core) => {
    if (message.method === 'core.hello') {
      core.send({ type: 'response', id: message.id, result });
    } else if (message.method === 'core.shutdown') {
      core.send({ type: 'response', id: message.id, result: {} });
    } else {
      extra(message, core);
    }
  };
}

const quietLog = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

let children;
let client;
let log;

function makeClient(handler, options = {}) {
  children = [];
  log = quietLog();
  client = new CoreClient({
    spawn: jest.fn(() => {
      const child = new FakeCore(handler);
      children.push(child);
      return child;
    }),
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    shellVersion: 'test',
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
    ...options,
  });
  return client;
}

const core = () => children[children.length - 1];

afterEach(async () => {
  if (client && client.state !== 'stopped' && client.state !== 'failed') await client.stop();
  client = null;
});

/** Reads a body to its end or its error. */
async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

/** A body of `length` bytes of `body(id, …)`, in `chunk`-byte reads, that
 * counts what has been read from it, and whether it was cancelled. */
function source(id, length, chunk = MAX_DATA, { fail = null } = {}) {
  const state = { read: 0, cancelled: false };
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (state.read >= length) {
          if (fail) controller.error(fail);
          else controller.close();
          return;
        }
        const n = Math.min(chunk, length - state.read);
        controller.enqueue(new Uint8Array(body(id, state.read, n)));
        state.read += n;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

describe('protocol 2 only (1 is gone)', () => {
  test('the client speaks only protocol 2, its default: asking for 1, or 3, throws', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(PROTOCOL_VERSION_STREAMS).toBe(PROTOCOL_VERSION);
    expect(makeClient(() => {}).protocol).toBe(2);
    expect(makeClient(() => {}, { protocol: 2 }).protocol).toBe(2);
    expect(() => makeClient(() => {}, { protocol: 1 })).toThrow('unknown core protocol 1');
    expect(() => makeClient(() => {}, { protocol: 3 })).toThrow('unknown core protocol 3');
  });

  test('a stream frame before the hello settles breaks the protocol', async () => {
    // Main reads stream frames only from a valid hello on, as the core
    // does (its `before_the_hello_a_stream_frame_is_unknown`).
    makeClient((message, fake) => {
      if (message.method === 'core.hello') fake.write(encodeEnd(1));
    });
    client.start().catch(() => {});
    await until(() => log.error.mock.calls.length > 0, 'the fault');
    expect(log.error).toHaveBeenCalledWith('[Core] protocol error', { category: 'unknown_kind' });
  });

  test('a handler registered without streams is called without them, and a StreamedReply from it is an internal error', async () => {
    let seen;
    const answered = [];
    makeClient(coreAt(2, (message) => answered.push(message)));
    const body = source(1, 10);
    client.handle('shell.dweb_get', (_params, { streams }) => {
      seen = streams;
      return new StreamedReply({ status: 200, headers: [] }, body.stream);
    });
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.dweb_get', params: {} });
    await until(() => answered.length === 1, 'the reply');
    expect(seen).toBe(false);
    expect(answered[0]).toEqual({
      type: 'response',
      id: 1,
      error: { code: 'internal', message: 'Internal error' },
    });
    await until(() => body.cancelled, 'the body let go of');
  });
});

describe('the hello at protocol 2', () => {
  test('main offers fragments and streams; a valid reply says streams', async () => {
    makeClient(coreAt(PROTOCOL_VERSION_STREAMS));
    const ready = await client.start();
    expect(ready).toEqual({
      protocol: 2,
      core_version: '0.13.0',
      capabilities: ['vault.status', 'fragments', 'streams'],
      node_recovery: null,
    });
    expect(core().messages[0].params).toEqual({
      protocol: 2,
      shell_version: 'test',
      auto_lock_ms: 900000,
      frames: ['fragment', 'stream'],
    });
    expect(client.streamStats()).toEqual({
      outstanding: 0,
      ringBytes: 0,
      bodies: 0,
      outbox: 0,
      pieces: 0,
      sending: 0,
      held: 0,
      pending: 0,
    });
  });

  test('a protocol-2 reply without streams is refused', async () => {
    makeClient(coreAt(2, () => {}, hello(2, ['vault.status', 'fragments'])));
    client.start().catch(() => {});
    await until(() => log.error.mock.calls.length > 0, 'the refusal');
    expect(log.error).toHaveBeenCalledWith('[Core] invalid core.hello result');
  });

  test("a core that answers protocol 1, or refuses 2 as cores before 0.10.0 do, is a mismatch: it isn't restarted", async () => {
    for (const reply of [
      (message, fake) => fake.send({ type: 'response', id: message.id, result: hello(1) }),
      (message, fake) =>
        fake.send({
          type: 'response',
          id: message.id,
          error: { code: 'protocol_mismatch', message: 'Protocol mismatch' },
        }),
    ]) {
      makeClient(reply);
      await expect(client.start()).rejects.toThrow();
      await until(() => client.state === 'failed', 'the failure');
      expect(log.error).toHaveBeenCalledWith('[Core] protocol mismatch');
      expect(children).toHaveLength(1);
    }
  });
});

describe("main's requests' bodies from the core (dweb.verify)", () => {
  async function verifiedBody() {
    makeClient(coreAt(2));
    await client.start();
    const id = client.current.nextId;
    const answer = client.callStream('dweb.verify', { plan: {} });
    await until(() => core().messages.some((m) => m.id === id), 'the request');
    core().send({ type: 'response', id, result: { status: 200, headers: [], body: true } });
    const { result, body: stream } = await answer;
    expect(result).toEqual({ status: 200, headers: [], body: true });
    return { id, stream };
  }

  test('data, then end: the body reads whole, and what main pulls goes back as credit', async () => {
    const { id, stream } = await verifiedBody();
    const reader = stream.getReader();
    core().write(encodeData(id, body(id, 0, MAX_DATA)));
    core().write(encodeData(id, body(id, MAX_DATA, WINDOW - MAX_DATA)));
    const first = await reader.read();
    expect(Buffer.from(first.value).equals(body(id, 0, first.value.length))).toBe(true);
    await until(() => core().framesOf(KIND_STREAM_CREDIT, id).length > 0, 'credit');
    const credited = () =>
      core()
        .framesOf(KIND_STREAM_CREDIT, id)
        .reduce((n, frame) => n + frame.credit, 0);
    expect(credited()).toBe(first.value.length);
    // Within the window again: what was credited, past the first window.
    core().write(encodeData(id, body(id, WINDOW, credited())));
    core().write(encodeEnd(id));
    const parts = [Buffer.from(first.value)];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      parts.push(Buffer.from(next.value));
    }
    const length = WINDOW + first.value.length;
    expect(Buffer.concat(parts).equals(body(id, 0, length))).toBe(true);
    // Credit only for bytes main pulled before `end`.
    expect(credited()).toBeLessThanOrEqual(length);
    expect(client.streamStats()).toMatchObject({ outstanding: 0, ringBytes: 0, bodies: 0 });
  });

  test("a verified body ends with one of 0009's codes: the body errors with it", async () => {
    for (const code of ['verification_failed', 'unverifiable', 'piece_failed', 'busy']) {
      const { id, stream } = await verifiedBody();
      core().write(encodeData(id, body(id, 0, 10)));
      core().write(encodeAbort(id, code, 'm'));
      const { error } = await readAll(stream);
      expect(error).toBeInstanceOf(CoreError);
      expect(error.code).toBe(code);
      await client.stop();
    }
  });

  test("a verified body ending with a service's or a piece's code breaks the protocol", async () => {
    for (const code of ['internal', 'stopped', 'stalled']) {
      const { id, stream } = await verifiedBody();
      core().write(encodeAbort(id, code, 'm'));
      const { error } = await readAll(stream);
      expect(error.code).toBe('core_unavailable');
      expect(log.error).toHaveBeenCalledWith('[Core] protocol error', { category: 'abort_code' });
      await until(() => client.state !== 'ready', 'the generation ending');
      await client.stop();
    }
  });
});

describe('the bodies main sends the core (shell.dweb_get with stream: true)', () => {
  /** A protocol-2 client whose streams handler answers with `answer`. */
  async function serving(answer) {
    const replies = [];
    makeClient(
      coreAt(2, (message) => {
        if (message.type === 'response') replies.push(message);
      })
    );
    client.handle('shell.dweb_get', answer, { streams: true });
    await client.start();
    return replies;
  }

  const ask = (id) =>
    core().send({ type: 'request', id, method: 'shell.dweb_get', params: { stream: true } });

  test("a head, then the body under the core's credit, then end", async () => {
    const length = 300_000;
    const piece = source(5, length);
    let seen;
    const replies = await serving((_params, { streams }) => {
      seen = streams;
      return new StreamedReply({ status: 200, headers: [['content-type', 'x']] }, piece.stream);
    });
    ask(5);
    await until(() => core().dataOf(5).length === WINDOW, 'the first window');
    expect(seen).toBe(true);
    expect(replies).toEqual([
      {
        type: 'response',
        id: 5,
        result: { status: 200, headers: [['content-type', 'x']], body: true },
      },
    ]);
    // No more than the window without credit, and at most one chunk read
    // ahead of it.
    for (let i = 0; i < 20; i++) await tick();
    expect(core().dataOf(5).length).toBe(WINDOW);
    expect(piece.read).toBeLessThanOrEqual(WINDOW + MAX_DATA);
    // The core's credit lets the rest go.
    let credited = 0;
    while (core().framesOf(KIND_END, 5).length === 0) {
      const sent = core().dataOf(5).length;
      core().write(encodeStreamCredit(5, sent - credited));
      credited = sent;
      await until(
        () => core().dataOf(5).length > sent || core().framesOf(KIND_END, 5).length > 0,
        'more of the body'
      );
    }
    expect(
      core()
        .dataOf(5)
        .equals(body(5, 0, length))
    ).toBe(true);
    expect(core().framesOf(KIND_ABORT, 5)).toEqual([]);
    expect(piece.cancelled).toBe(false);
    await until(() => client.streamStats().sending === 0, 'the request done');
    expect(client.current.incoming.size).toBe(0);
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0 });
  });

  test('the core cancels mid-body: the stream ends with cancelled, and the body is let go of', async () => {
    const piece = source(6, 1_000_000);
    let signal;
    await serving((_params, context) => {
      signal = context.signal;
      return new StreamedReply({ status: 200, headers: [] }, piece.stream);
    });
    ask(6);
    await until(() => core().dataOf(6).length > 0, 'the body');
    core().send({ type: 'cancel', id: 6 });
    await until(() => core().framesOf(KIND_ABORT, 6).length === 1, 'the abort');
    expect(core().framesOf(KIND_ABORT, 6)[0]).toMatchObject({ code: 'cancelled' });
    expect(piece.cancelled).toBe(true);
    expect(signal.aborted).toBe(true);
    await until(() => client.current.incoming.size === 0, 'the request done');
    expect(client.streamStats()).toMatchObject({ pieces: 0, sending: 0, held: 0 });
  });

  test("the body's error ends the stream with body_stream_error, or stalled when it says so", async () => {
    const failing = source(7, 10, MAX_DATA, { fail: new Error('reset') });
    const stalled = source(8, 10, MAX_DATA, {
      fail: Object.assign(new Error('idle'), { abortCode: 'stalled' }),
    });
    const internal = source(9, 10, MAX_DATA, {
      fail: Object.assign(new Error('x'), { abortCode: 'internal' }),
    });
    const bodies = { 7: failing, 8: stalled, 9: internal };
    let next = 7;
    await serving(() => new StreamedReply({ status: 200, headers: [] }, bodies[next++].stream));
    for (const id of [7, 8, 9]) {
      ask(id);
      await until(() => core().framesOf(KIND_ABORT, id).length === 1, `abort ${id}`);
      // What was written before the abort is the body's start.
      const sent = core().dataOf(id);
      expect(sent.equals(body(id, 0, sent.length))).toBe(true);
    }
    expect(core().framesOf(KIND_ABORT, 7)[0]).toMatchObject({ code: 'body_stream_error' });
    expect(core().framesOf(KIND_ABORT, 8)[0]).toMatchObject({ code: 'stalled' });
    // A piece ends only with its three codes.
    expect(core().framesOf(KIND_ABORT, 9)[0]).toMatchObject({ code: 'body_stream_error' });
  });

  test.each([
    ['a byte stream', true],
    ['a default stream', false],
  ])(
    '%s that fails with its window full and nothing reading ends at once, with no more credit',
    async (_what, bytes) => {
      let source;
      let reads = 0;
      const stream = new ReadableStream(
        bytes
          ? {
              type: 'bytes',
              start(controller) {
                source = controller;
              },
              pull(controller) {
                reads += 1;
                const request = controller.byobRequest;
                request.view.set(body(16, 0, request.view.byteLength));
                request.respond(request.view.byteLength);
              },
            }
          : {
              start(controller) {
                source = controller;
              },
              pull(controller) {
                reads += 1;
                controller.enqueue(new Uint8Array(body(16, 0, MAX_DATA)));
              },
            },
        { highWaterMark: 0 }
      );
      await serving(() => new StreamedReply({ status: 200, headers: [] }, stream));
      ask(16);
      await until(() => core().dataOf(16).length === WINDOW, 'the first window');
      for (let i = 0; i < 20; i++) await tick();
      const read = reads;
      expect(core().framesOf(KIND_ABORT, 16)).toEqual([]);
      source.error(Object.assign(new Error('idle'), { abortCode: 'stalled' }));
      for (let i = 0; i < 3; i++) await tick();
      expect(core().framesOf(KIND_ABORT, 16)).toEqual([
        expect.objectContaining({ code: 'stalled' }),
      ]);
      expect(core().dataOf(16).length).toBe(WINDOW);
      expect(reads).toBe(read);
      expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
    }
  );

  test('a body that closes with bytes still queued sends them all, under credit, then end', async () => {
    const length = 4 * MAX_DATA;
    const stream = new ReadableStream({
      start(controller) {
        for (let at = 0; at < length; at += MAX_DATA) {
          controller.enqueue(new Uint8Array(body(17, at, MAX_DATA)));
        }
        controller.close();
      },
    });
    await serving(() => new StreamedReply({ status: 200, headers: [] }, stream));
    ask(17);
    await until(() => core().dataOf(17).length === WINDOW, 'the first window');
    for (let i = 0; i < 20; i++) await tick();
    expect(core().framesOf(KIND_END, 17)).toEqual([]);
    expect(core().framesOf(KIND_ABORT, 17)).toEqual([]);
    let credited = 0;
    while (core().framesOf(KIND_END, 17).length === 0) {
      const sent = core().dataOf(17).length;
      if (sent > credited) {
        core().write(encodeStreamCredit(17, sent - credited));
        credited = sent;
      }
      await tick();
    }
    expect(
      core()
        .dataOf(17)
        .equals(body(17, 0, length))
    ).toBe(true);
    expect(core().framesOf(KIND_ABORT, 17)).toEqual([]);
  });

  test('a plain answer is the one reply; a cancel before the answer makes cancelled the one reply', async () => {
    let release;
    const late = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const replies = await serving(() => {
      calls += 1;
      return calls === 1 ? { status: 404, headers: [], body_base64: '' } : late;
    });
    ask(10);
    await until(() => replies.length === 1, 'the reply');
    expect(replies[0]).toEqual({
      type: 'response',
      id: 10,
      result: { status: 404, headers: [], body_base64: '' },
    });
    ask(11);
    await tick();
    core().send({ type: 'cancel', id: 11 });
    await until(() => replies.length === 2, 'the cancelled reply');
    expect(replies[1]).toEqual({
      type: 'response',
      id: 11,
      error: { code: 'cancelled', message: 'Cancelled' },
    });
    release({ failed: 'aborted' });
    for (let i = 0; i < 20; i++) await tick();
    expect(replies).toHaveLength(2);
    expect(client.current.incoming.size).toBe(0);
  });

  test('credit for an ended body is late; credit beyond what main sent breaks the protocol', async () => {
    const open = source(13, 1_000_000);
    let next = 12;
    await serving(
      () =>
        new StreamedReply(
          { status: 200, headers: [] },
          next++ === 12 ? source(12, 100).stream : open.stream
        )
    );
    ask(12);
    await until(() => core().framesOf(KIND_END, 12).length === 1, 'the first body');
    core().write(encodeStreamCredit(12, 100));
    ask(13);
    await until(() => core().dataOf(13).length === WINDOW, 'the second body');
    expect(log.error).not.toHaveBeenCalled();
    core().write(encodeStreamCredit(13, WINDOW + 1));
    await until(() => log.error.mock.calls.length > 0, 'the fault');
    expect(log.error).toHaveBeenCalledWith('[Core] protocol error', {
      category: 'credit_overgrant',
    });
    await until(() => open.cancelled, 'the open body let go of');
  });

  /** Queued plus read-ahead bytes, the most seen at each check. */
  function watchHeld() {
    const seen = { most: 0 };
    seen.check = () => {
      const stats = client.streamStats();
      if (stats) seen.most = Math.max(seen.most, stats.held + stats.pending);
    };
    return seen;
  }

  test('one 8 MiB chunk from a byte stream: main reads 64 KiB at a time, never past the window and one read, and credit lets it all go', async () => {
    const length = 8 * 1024 * 1024;
    const whole = body(14, 0, length);
    let pulls = 0;
    const stream = new ReadableStream(
      {
        type: 'bytes',
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(whole));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    await serving(() => new StreamedReply({ status: 200, headers: [] }, stream));
    const held = watchHeld();
    ask(14);
    await until(() => {
      held.check();
      return core().dataOf(14).length === WINDOW;
    }, 'the first window');
    // No credit comes back: nothing more is sent, or read.
    for (let i = 0; i < 20; i++) {
      await tick();
      held.check();
    }
    expect(core().dataOf(14).length).toBe(WINDOW);
    expect(client.streamStats().pending).toBeLessThanOrEqual(MAX_DATA);
    expect(held.most).toBeLessThanOrEqual(WINDOW + MAX_DATA);
    let credited = 0;
    while (core().framesOf(KIND_END, 14).length === 0) {
      const sent = core().dataOf(14).length;
      if (sent > credited) {
        core().write(encodeStreamCredit(14, sent - credited));
        credited = sent;
      }
      await tick();
      held.check();
    }
    expect(held.most).toBeLessThanOrEqual(WINDOW + MAX_DATA);
    expect(core().dataOf(14).equals(whole)).toBe(true);
    for (const frame of core().framesOf(KIND_DATA, 14)) {
      expect(frame.bytes.length).toBeLessThanOrEqual(MAX_DATA);
    }
    expect(pulls).toBe(1);
    await until(() => client.streamStats().sending === 0, 'the request done');
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
  });

  test("one 8 MiB chunk from a stream main can't bound ends the body body_stream_error, before any of it is sent", async () => {
    let cancelled = false;
    const stream = new ReadableStream(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    await serving(() => new StreamedReply({ status: 200, headers: [] }, stream));
    const held = watchHeld();
    ask(15);
    await until(() => {
      held.check();
      return core().framesOf(KIND_ABORT, 15).length === 1;
    }, 'the abort');
    expect(core().framesOf(KIND_ABORT, 15)[0]).toMatchObject({ code: 'body_stream_error' });
    expect(core().dataOf(15).length).toBe(0);
    expect(cancelled).toBe(true);
    expect(held.most).toBe(0);
    await until(() => client.streamStats().sending === 0, 'the request done');
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
  });
  test.each([
    ['byte streams', true],
    ['default streams', false],
  ])(
    "256 %s: reads started at once claim the writer's room before they start, so what it holds never passes its cap",
    async (_what, bytes) => {
      // Every read waits at the gate open when it starts; reads that start
      // while one is shut wait for it together.
      let gate;
      const shut = () => {
        let open;
        const promise = new Promise((resolve) => {
          open = resolve;
        });
        gate = { promise, open };
      };
      shut();
      let started = 0;
      const stream = () =>
        new ReadableStream(
          bytes
            ? {
                type: 'bytes',
                async pull(controller) {
                  started += 1;
                  await gate.promise;
                  const request = controller.byobRequest;
                  request.view.fill(7);
                  request.respond(request.view.byteLength);
                },
              }
            : {
                async pull(controller) {
                  started += 1;
                  await gate.promise;
                  controller.enqueue(new Uint8Array(MAX_DATA).fill(7));
                },
              },
          { highWaterMark: 0 }
        );
      await serving(() => new StreamedReply({ status: 200, headers: [] }, stream()));
      const sender = client.current.duplex.sender;
      // Queued plus reserved, checked after every call that adds to them.
      let most = 0;
      const check = () => {
        most = Math.max(most, sender.held + sender.reserved);
      };
      for (const name of ['push', 'reserve', 'claim']) {
        if (typeof sender[name] !== 'function') continue;
        const call = sender[name].bind(sender);
        sender[name] = (...args) => {
          const out = call(...args);
          check();
          return out;
        };
      }
      const settle = async () => {
        for (let i = 0; i < 20; i++) {
          await tick();
          check();
        }
      };
      // The writer takes main's first write and completes none.
      core().stuck = true;
      const fill = async () => {
        for (let id = 1; id <= 256; id++) ask(id);
        await until(() => started === 256, 'every first read');
        // The first reads come back together and fill the sender.
        let open = gate.open;
        shut();
        open();
        await settle();
        expect(sender.held).toBe(WRITER_DATA_CAP);
        expect(started).toBe(256);
        expect(most).toBeLessThanOrEqual(WRITER_DATA_CAP);
        // One write at a time completes until the room it frees starts reads.
        for (let i = 0; i < 4 && started === 256; i++) {
          core().completeOne();
          await settle();
        }
        expect(started).toBeGreaterThan(256);
        // Room for four reads of 64 KiB was freed: only four started.
        expect(started - 256).toBeLessThanOrEqual(4);
        // Every read started meanwhile comes back at once.
        open = gate.open;
        shut();
        open();
        await settle();
        expect(most).toBeLessThanOrEqual(WRITER_DATA_CAP);
        expect(client.streamStats().held + client.streamStats().pending).toBeLessThanOrEqual(
          WRITER_DATA_CAP
        );
      };
      try {
        await fill();
      } finally {
        gate.open();
        core().release();
      }
    }
  );
});

describe("main's frames reach the core in the order main made them", () => {
  /** Main's request `id` reached the core. */
  const asked = (id) => until(() => core().messages.some((m) => m.id === id), `request ${id}`);
  const opened = (id) =>
    core().send({ type: 'response', id, result: { status: 200, headers: [], body: true } });
  const at = (name) => core().wire.indexOf(name);

  afterEach(() => detachDwebVerify());

  test("a private partition's dweb.forget goes after the cancels of its requests, though a stream write is in flight", async () => {
    makeClient(
      coreAt(2, (message, fake) => {
        if (message.method === 'dweb.forget') {
          fake.send({ type: 'response', id: message.id, result: {} });
        }
      })
    );
    await client.start();
    const admission = createFetchAdmission();
    const sent = [];
    const shell = { open: ({ id }) => (sent.push(id), { close: () => {} }) };
    const verifier = attachDwebVerify(client, shell, {
      log: quietLog(),
      onSessionClosed: admission.onSessionClosed,
    });
    // The profile's body: main's credit for it is the write in flight.
    const profileId = client.current.nextId;
    const profile = client.callStream('dweb.verify', { plan: {} });
    await asked(profileId);
    opened(profileId);
    const profileBody = (await profile).body.getReader();
    // The partition's requests: one waiting for its head, one whose body is
    // open.
    const params = {
      plan: {},
      method: 'GET',
      partition: 'private-9',
      private: true,
      deadline_ms: 60_000,
    };
    const { signal } = admission.fence('private-9');
    const waiting = verifier.send(client.current, params, {}, signal);
    const open = verifier.send(client.current, params, {}, signal);
    expect(sent).toHaveLength(2);
    await asked(sent[1]);
    opened(sent[1]);
    await open.head;
    core().write(encodeData(profileId, body(profileId, 0, 10)));
    // The core takes main's next write, and completes none.
    core().stuck = true;
    await profileBody.read();
    expect(core().wire.at(-1)).toBe(`credit:${profileId}`);
    expect(core().held).toHaveLength(1);

    admission.closeSession('private-9');
    await expect(waiting.head).rejects.toMatchObject({ code: 'cancelled' });
    core().release();
    await until(() => at(`dweb.forget:${sent[1] + 1}`) !== -1, 'the forget');
    const forget = at(`dweb.forget:${sent[1] + 1}`);
    expect(core().messages.at(-1)).toMatchObject({
      method: 'dweb.forget',
      params: { partition: 'private-9' },
    });
    for (const id of sent) {
      expect(at(`cancel:${id}`)).toBeGreaterThan(at(`credit:${profileId}`));
      expect(at(`cancel:${id}`)).toBeLessThan(forget);
    }
  });

  test('a request never overtakes credit, a cancel, an abort or an end main made before it, and its cancel never overtakes it', async () => {
    // The core's request 8's body: ten bytes, then its end once `finish`.
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    let gave = false;
    const short = new ReadableStream(
      {
        async pull(controller) {
          if (!gave) {
            gave = true;
            controller.enqueue(new Uint8Array(10).fill(8));
            return;
          }
          await finished;
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const long = source(7, 1_000_000);
    makeClient(coreAt(2));
    client.handle(
      'shell.dweb_get',
      (params) =>
        new StreamedReply({ status: 200, headers: [] }, params.n === 7 ? long.stream : short),
      { streams: true }
    );
    await client.start();
    // Main's requests: A and B with open bodies, C waiting for its head.
    const a = client.current.nextId;
    const [b, c] = [a + 1, a + 2];
    const answers = [client.callStream('dweb.verify', {}), client.callStream('dweb.verify', {})];
    const stopC = new AbortController();
    const waiting = client.callStream('dweb.verify', {}, undefined, { signal: stopC.signal });
    await asked(c);
    opened(a);
    opened(b);
    const [bodyA, bodyB] = (await Promise.all(answers)).map((answer) => answer.body.getReader());
    core().write(encodeData(a, body(a, 0, 10)));
    core().write(encodeData(b, body(b, 0, 10)));
    // The core's requests: 7's body fills its window, 8's sends its ten
    // bytes.
    for (const n of [7, 8]) {
      core().send({
        type: 'request',
        id: n,
        method: 'shell.dweb_get',
        params: { stream: true, n },
      });
    }
    await until(
      () => core().dataOf(7).length === WINDOW && core().dataOf(8).length === 10,
      'their bodies'
    );

    // The core takes main's next write (A's credit), and completes none.
    core().stuck = true;
    await bodyA.read();
    expect(core().wire.at(-1)).toBe(`credit:${a}`);
    // Meanwhile, behind it: B's credit, C's cancel, 7's abort for the
    // core's cancel, and 8's end.
    await bodyB.read();
    stopC.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    core().send({ type: 'cancel', id: 7 });
    finish();
    for (let i = 0; i < 20; i++) await tick();
    expect(long.cancelled).toBe(true);
    expect(core().wire.at(-1)).toBe(`credit:${a}`);
    // A whole request, then its own cancel.
    const x = client.current.nextId;
    const stopX = new AbortController();
    const request = client.requestTo(client.current, 'vault.status', {}, undefined, {
      signal: stopX.signal,
    });
    stopX.abort();
    await expect(request).rejects.toMatchObject({ code: 'cancelled' });

    core().release();
    await until(() => at(`cancel:${x}`) !== -1, "the request's cancel");
    for (const earlier of [`credit:${a}`, `credit:${b}`, `cancel:${c}`, 'abort:7', 'end:8']) {
      expect([earlier, at(earlier) !== -1 && at(earlier) < at(`vault.status:${x}`)]).toEqual([
        earlier,
        true,
      ]);
    }
    expect(at(`cancel:${x}`)).toBeGreaterThan(at(`vault.status:${x}`));
    expect(core().framesOf(KIND_ABORT, 7)[0]).toMatchObject({ code: 'cancelled' });
    // Nothing more of 7 or 8, and both are done.
    expect(core().wire.slice(at('abort:7') + 1)).not.toContain('data:7');
    expect(core().framesOf(KIND_END, 8)).toHaveLength(1);
    await until(() => client.current.incoming.size === 0, "the core's requests done");
    expect(client.streamStats()).toMatchObject({ pieces: 0, sending: 0, held: 0 });
  });

  test("on a service's stream connection (design 0007), a request never overtakes main's earlier credit or cancel", async () => {
    children = [];
    log = quietLog();
    client = new ServiceClient({
      service: {
        label: '[Fake]',
        noun: 'fake service',
        unavailableCode: 'service_unavailable',
        protocol: 2,
        helloMethod: 'core.hello',
        helloParams: () => ({ protocol: 2, frames: ['stream'] }),
        validHello: (result) => (result?.protocol === 2 ? { protocol: 2, capabilities: [] } : null),
        shutdownMethod: 'core.shutdown',
        fragments: () => false,
        streams: () => true,
        initialKinds: JSON_KINDS,
        maxPending: 512,
      },
      spawn: () => {
        const child = new FakeCore(coreAt(2));
        children.push(child);
        return child;
      },
      command: '/bin/fake-service',
      args: [],
      log,
      shellVersion: 'test',
      setTimer: (fn, ms) => ({ fn, ms }),
      clearTimer: () => {},
    });
    await client.start();
    expect(client.current.duplex).toBeNull();
    // A and B with open bodies, C waiting for its head.
    const a = client.current.nextId;
    const [b, c] = [a + 1, a + 2];
    const answers = [client.callStream('fake.get', {}), client.callStream('fake.get', {})];
    const stopC = new AbortController();
    const waiting = client.callStream('fake.get', {}, undefined, { signal: stopC.signal });
    await asked(c);
    opened(a);
    opened(b);
    const [bodyA, bodyB] = (await Promise.all(answers)).map((answer) => answer.body.getReader());
    core().write(encodeData(a, body(a, 0, 10)));
    core().write(encodeData(b, body(b, 0, 10)));
    core().stuck = true;
    await bodyA.read();
    expect(core().wire.at(-1)).toBe(`credit:${a}`);
    await bodyB.read();
    stopC.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.streamStats()).toMatchObject({ outbox: 2 });
    const x = client.current.nextId;
    // Unanswered: it fails as the client stops.
    client.requestTo(client.current, 'fake.x', {}).catch(() => {});
    core().release();
    await until(() => at(`fake.x:${x}`) !== -1, 'the request');
    expect(at(`credit:${b}`)).toBeGreaterThan(at(`credit:${a}`));
    expect(at(`credit:${b}`)).toBeLessThan(at(`fake.x:${x}`));
    expect(at(`cancel:${c}`)).toBeGreaterThan(at(`credit:${a}`));
    expect(at(`cancel:${c}`)).toBeLessThan(at(`fake.x:${x}`));
  });
});
