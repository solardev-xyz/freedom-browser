/**
 * CoreClient's protocol 2 (freedom-core design 0009, Streams in the core)
 * against a scripted core: the hello that settles it, and stream frames in
 * both directions on the one connection. Main's own requests' bodies come
 * from the core and end only with its verified bodies' codes; the bodies
 * main sends in answer to the core's requests (`StreamedReply`) go under
 * the core's credit and end only with a piece's codes. Protocol 1, which
 * the pinned core speaks, stays exactly as it was.
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
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_JSON,
  KIND_STREAM_CREDIT,
  MAX_DATA,
  WINDOW,
  WRITER_DATA_CAP,
} = require('./frame');

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

/**
 * A scripted freedom-cored: `handler(message, core)` answers main's JSON
 * messages. It reads main's frames as the core does: at protocol 1 no
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
    this.stuck = false; // stdin reads main's writes but doesn't complete them
    this.held = []; // the write callbacks `stuck` holds back
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
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
  return { protocol, core_version: '0.10.0', capabilities };
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

describe('the core at protocol 1 (the pinned core)', () => {
  test('main asks for protocol 1 with fragments only, and reads no stream frame', async () => {
    makeClient(coreAt(PROTOCOL_VERSION, () => {}, hello(1, ['vault.status', 'fragments'])));
    const ready = await client.start();
    expect(ready.protocol).toBe(1);
    expect(core().messages[0]).toEqual({
      type: 'request',
      id: 1,
      method: 'core.hello',
      params: { protocol: 1, shell_version: 'test', auto_lock_ms: 900000, frames: ['fragment'] },
      context: { caller: 'shell' },
    });
    expect(client.streamStats()).toBeNull();
    // A stream frame from a protocol-1 core breaks the protocol.
    core().write(encodeEnd(1));
    await until(() => log.error.mock.calls.length > 0, 'the fault');
    expect(log.error).toHaveBeenCalledWith('[Core] protocol error', { category: 'unknown_kind' });
  });

  test('a streams handler is called without streams, and a StreamedReply is an internal error', async () => {
    let seen;
    const answered = [];
    makeClient(
      coreAt(PROTOCOL_VERSION, (message) => answered.push(message), hello(1, ['fragments']))
    );
    const body = source(1, 10);
    client.handle(
      'shell.dweb_get',
      (_params, { streams }) => {
        seen = streams;
        return new StreamedReply({ status: 200, headers: [] }, body.stream);
      },
      { streams: true }
    );
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
    makeClient(coreAt(PROTOCOL_VERSION_STREAMS), { protocol: 2 });
    const ready = await client.start();
    expect(ready).toEqual({
      protocol: 2,
      core_version: '0.10.0',
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
    makeClient(
      coreAt(2, () => {}, hello(2, ['vault.status', 'fragments'])),
      { protocol: 2 }
    );
    client.start().catch(() => {});
    await until(() => log.error.mock.calls.length > 0, 'the refusal');
    expect(log.error).toHaveBeenCalledWith('[Core] invalid core.hello result');
  });

  test("a core that answers protocol 1, or refuses 2 as the pinned core does, is a mismatch: it isn't restarted", async () => {
    for (const reply of [
      (message, fake) => fake.send({ type: 'response', id: message.id, result: hello(1) }),
      (message, fake) =>
        fake.send({
          type: 'response',
          id: message.id,
          error: { code: 'protocol_mismatch', message: 'Protocol mismatch' },
        }),
    ]) {
      makeClient(reply, { protocol: 2 });
      await expect(client.start()).rejects.toThrow();
      await until(() => client.state === 'failed', 'the failure');
      expect(log.error).toHaveBeenCalledWith('[Core] protocol mismatch');
      expect(children).toHaveLength(1);
    }
  });

  test('only protocols 1 and 2 are known', () => {
    expect(() => makeClient(() => {}, { protocol: 3 })).toThrow('unknown core protocol 3');
  });
});

describe("main's requests' bodies from the core (dweb.verify)", () => {
  async function verifiedBody() {
    makeClient(coreAt(2), { protocol: 2 });
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
      }),
      { protocol: 2 }
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
