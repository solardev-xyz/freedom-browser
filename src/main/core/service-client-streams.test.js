/**
 * ServiceClient's streams (design 0007, Frames and Main's side) against a
 * scripted service in a real child process (`test/helpers/
 * fake-stream-service.js`, on the JS model of fc-protocol's Sender): a
 * head, then a pull-driven body; a paused reader whose credit stays
 * bounded; cancels before the head, mid-body and after `end`; an abort; a
 * protocol error that ends the generation; and a restart while a stream is
 * open.
 *
 * Then a two-way service (freedom-core design 0014, COL-3) against
 * `test/helpers/fake-colibrid.js`: the service's `shell.colibri_fetch` to
 * a `streams: true` handler, answered with a head and main's body under
 * the service's credit; a paused service holding main to its window; the
 * service's cancel mid-body, a head it can't reserve and a body that
 * breaks its length, each failing alone; main's error answers; the codes
 * the service's own bodies end with, and no fragments. A one-way service
 * is as before: its credit is a protocol error, and a body main would
 * send is an internal error.
 */

const path = require('path');
const { spawn } = require('child_process');
const { ServiceClient, CoreError, ShellError, StreamedReply } = require('./service-client');
const {
  encodeAbort,
  encodeBegin,
  encodeStreamCredit,
  JSON_KINDS,
  MAX_DATA,
  WINDOW,
} = require('./frame');
const { fakeColibrid, testService } = require('../../../test/helpers/fake-colibrid');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'test', 'helpers', 'fake-stream-service.js');

const FAKE_SERVICE = Object.freeze({
  label: '[Fake]',
  noun: 'fake service',
  unavailableCode: 'service_unavailable',
  protocol: 1,
  helloMethod: 'fake.hello',
  helloParams: (client) => ({
    protocol: 1,
    shell_version: client.shellVersion,
    frames: ['stream'],
  }),
  validHello: (result) => (result?.protocol === 1 ? { protocol: 1, capabilities: [] } : null),
  shutdownMethod: 'fake.shutdown',
  fragments: () => false,
  streams: () => true,
  initialKinds: JSON_KINDS,
  maxPending: 512,
});

/** Byte `k` of stream `id`'s body. */
function body(id, offset, length) {
  const out = Buffer.allocUnsafe(length);
  const base = (id % 251) + (offset % 251);
  for (let i = 0; i < length; i++) out[i] = (base + i) % 251;
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Reads a body to its end or its error: the bytes, and the error. */
async function readAll(reader) {
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

let client;
let log;

/** The ID the next request will take. */
const nextId = () => client.current.nextId;
const stats = () => client.request('fake.stats');

describe('ServiceClient streams', () => {
  beforeEach(async () => {
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    client = new ServiceClient({
      service: FAKE_SERVICE,
      spawn,
      command: process.execPath,
      args: [SCRIPT],
      log,
      shellVersion: 'test',
    });
    await client.start();
  });

  afterEach(async () => {
    await client.stop();
  });

  test('a head, then its body pulled to the end; everything is freed', async () => {
    const id = nextId();
    const { result, body: stream } = await client.callStream('fake.body', { length: 300_000 });
    expect(result).toEqual({ status: 200, body: true });
    const { bytes, error } = await readAll(stream.getReader());

    expect(error).toBeNull();
    expect(bytes.equals(body(id, 0, 300_000))).toBe(true);
    expect(client.streamStats()).toEqual({ outstanding: 0, ringBytes: 0, bodies: 0, outbox: 0 });
    const service = await stats();
    expect(service.live).toBe(0);
    expect(service.held).toBe(0);
  });

  test('a head without a body, and an error reply', async () => {
    await expect(client.callStream('fake.no_body')).resolves.toEqual({
      result: { status: 204, body: false },
      body: null,
    });
    const err = await client.callStream('fake.error').catch((e) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe('busy');
    expect(client.streamStats().outstanding).toBe(0);
  });

  test("a head that doesn't say body: true opens nothing, and its data is a protocol fault", async () => {
    const generation = client.current;
    await expect(client.callStream('fake.unsaid', { length: 1000 })).resolves.toEqual({
      result: { content_type: 'application/json', bytes: 1000 },
      body: null,
    });
    await waitFor(() => generation.retired || generation.exited, 'the generation to end');
    expect(log.error).toHaveBeenCalled();
  });

  test('a paused reader: main holds one ring, the service waits within the window', async () => {
    const id = nextId();
    const { body: stream } = await client.callStream('fake.body', { length: 2 * 1024 * 1024 });
    const reader = stream.getReader();
    const first = await reader.read();
    await sleep(300);

    // Main: at most the window in its ring, and credit for what was read.
    const held = client.streamStats();
    expect(held.ringBytes).toBe(WINDOW);
    expect(held.outbox).toBeLessThanOrEqual(2);
    expect(client.current.streams.info(id).buffered).toBeLessThanOrEqual(WINDOW);
    // The service: no more in flight than the window.
    const service = (await stats()).streams[id];
    expect(service.sent - service.credited).toBeLessThanOrEqual(WINDOW);
    expect(service.sent).toBeLessThanOrEqual(first.value.length + WINDOW);

    const rest = await readAll(reader);
    expect(rest.error).toBeNull();
    expect(Buffer.concat([first.value, rest.bytes]).equals(body(id, 0, 2 * 1024 * 1024))).toBe(
      true
    );
  });

  test('a cancel before the head: cancelled at once, and the record goes with the reply', async () => {
    const id = nextId();
    const controller = new AbortController();
    const pending = client.callStream('fake.hang', {}, undefined, { signal: controller.signal });
    await waitFor(() => client.streamStats().outstanding === 1, 'the request');
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await waitFor(() => client.streamStats().outstanding === 0, 'the cancelled reply');
    expect((await stats()).cancels).toEqual([id]);
  });

  test('a head that crossed the cancel opens a retiring stream: its frames are dropped, and no body is made', async () => {
    const id = nextId();
    const controller = new AbortController();
    // Main stops reading, so the service's head and data wait in the pipe.
    client.current.child.stdout.pause();
    const pending = client
      .callStream('fake.body', { length: 300_000 }, undefined, { signal: controller.signal })
      .catch((e) => e);
    await sleep(200);
    controller.abort();
    client.current.child.stdout.resume();

    expect(await pending).toMatchObject({ code: 'cancelled' });
    await waitFor(() => client.streamStats().outstanding === 0, 'the terminal');
    expect(client.streamStats()).toEqual({ outstanding: 0, ringBytes: 0, bodies: 0, outbox: 0 });
    expect((await stats()).cancels).toEqual([id]);
  });

  test('a cancel mid-body: the stream retires, its frames are dropped, and the next request works', async () => {
    const id = nextId();
    const { body: stream } = await client.callStream('fake.body', { length: 1024 * 1024 });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();

    await waitFor(() => client.streamStats().outstanding === 0, 'the abort to end the record');
    expect(client.streamStats()).toEqual({ outstanding: 0, ringBytes: 0, bodies: 0, outbox: 0 });
    const service = await stats();
    expect(service.cancels).toEqual([id]);
    expect(service.live).toBe(0);
    const again = await client.callStream('fake.body', { length: 10 });
    expect((await readAll(again.body.getReader())).bytes).toHaveLength(10);
  });

  test("the caller's signal after the head errors the body as cancelled", async () => {
    const controller = new AbortController();
    const { body: stream } = await client.callStream(
      'fake.body',
      { length: 1024 * 1024 },
      undefined,
      { signal: controller.signal }
    );
    const reader = stream.getReader();
    await reader.read();
    controller.abort();

    const { error } = await readAll(reader);
    expect(error).toMatchObject({ code: 'cancelled' });
    await waitFor(() => client.streamStats().outstanding === 0, 'the record to go');
  });

  test('a cancel after end: nothing is sent, and the bytes left go', async () => {
    const { body: stream } = await client.callStream('fake.body', { length: 1000 });
    const reader = stream.getReader();
    await waitFor(() => client.current.streams.info(nextId() - 1)?.state === 'eof', 'the end');
    await reader.cancel();

    expect(client.streamStats()).toEqual({ outstanding: 0, ringBytes: 0, bodies: 0, outbox: 0 });
    expect((await stats()).cancels).toEqual([]);
  });

  test('an abort errors the body with its code, after the bytes before it', async () => {
    const id = nextId();
    const { body: stream } = await client.callStream('fake.body', {
      length: 500_000,
      abort_at: 200_000,
      code: 'body_stream_error',
    });
    const { bytes, error } = await readAll(stream.getReader());

    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe('body_stream_error');
    expect(bytes.length).toBeLessThanOrEqual(200_000);
    expect(bytes.equals(body(id, 0, bytes.length))).toBe(true);
    expect(client.streamStats().outstanding).toBe(0);
  });

  test('a protocol error ends the generation: its open bodies error, and it restarts', async () => {
    const first = client.current;
    const { body: stream } = await client.callStream('fake.body', { length: 4 * 1024 * 1024 });
    const reader = stream.getReader();
    await reader.read();

    await client.request('fake.bad_frame');
    const { error } = await readAll(reader);

    expect(error).toMatchObject({ code: 'service_unavailable' });
    expect(log.error).toHaveBeenCalledWith('[Fake] protocol error', { category: 'stream_unknown' });
    await waitFor(
      () => client.current && client.current !== first && client.current.ready,
      'the restart'
    );
    const again = await client.callStream('fake.body', { length: 100 });
    expect((await readAll(again.body.getReader())).bytes).toHaveLength(100);
  });

  test('a restart while a stream is open: the old body errors, and nothing reaches the new process', async () => {
    const first = client.current;
    const { body: stream } = await client.callStream('fake.body', { length: 4 * 1024 * 1024 });
    const reader = stream.getReader();
    await reader.read();

    await expect(client.request('fake.exit', { code: 1 })).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    const { error } = await readAll(reader);
    expect(error).toMatchObject({
      code: 'service_unavailable',
      message: 'The fake service exited',
    });

    await waitFor(
      () => client.current && client.current !== first && client.current.ready,
      'the restart'
    );
    // A request captured for the old process fails, and sends nothing.
    await expect(client.requestStreamTo(first, 'fake.body', { length: 1 })).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    await reader.cancel().catch(() => {});
    expect((await stats()).cancels).toEqual([]);
    const again = await client.callStream('fake.body', { length: 100 });
    expect((await readAll(again.body.getReader())).bytes).toHaveLength(100);
  });

  test("main's outstanding requests count retiring ones, up to the service's bound", async () => {
    const controllers = [];
    const pending = [];
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      pending.push(
        client.callStream('fake.hang', {}, undefined, { signal: controller.signal }).catch((e) => e)
      );
    }
    await waitFor(() => client.streamStats().outstanding === 3, 'three requests');
    for (const controller of controllers) controller.abort();
    // Answered at once, but their records stay until the service's replies.
    expect(client.streamStats().outstanding).toBe(3);
    for (const err of await Promise.all(pending)) expect(err.code).toBe('cancelled');
    await waitFor(() => client.streamStats().outstanding === 0, 'the cancelled replies');
  });
});

// ---- a two-way service (design 0014, COL-3) --------------------------------

const tick = () => new Promise(setImmediate);

async function until(predicate, what) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A body of `length` bytes of `body(id, …)` in `chunk`-byte reads, as a
 * default stream that counts what has been read from it, and whether it
 * was cancelled. */
function source(id, length, chunk = MAX_DATA) {
  const state = { read: 0, cancelled: false };
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (state.read >= length) {
          controller.close();
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

/** `bytes` whole, as a byte stream: what main has read before a head. */
function whole(bytes) {
  return new ReadableStream(
    {
      type: 'bytes',
      pull(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
}

describe('a two-way service (design 0014, COL-3)', () => {
  let twoWay;
  let fake;

  /** A started client of `service` to a fake freedom-colibrid, whose
   * `shell.colibri_fetch` goes to `handler` (registered `streams: true`). */
  async function serving(handler, { service = testService(), script = {} } = {}) {
    fake = fakeColibrid(script);
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    twoWay = new ServiceClient({
      service,
      spawn: fake.spawn,
      command: '/bin/freedom-colibrid',
      args: ['serve', '--chain', '100', '--parent-pid', '1'],
      log,
      shellVersion: 'test',
    });
    if (handler) twoWay.handle('shell.colibri_fetch', handler, { streams: true });
    await twoWay.start();
    return fake.children[0];
  }

  afterEach(async () => {
    await twoWay?.stop();
    twoWay = null;
  });

  test("a streams handler answers the service's fetch with a head and its body, under the service's credit; everything is freed", async () => {
    const bytes = body(1, 0, 300_000);
    const calls = [];
    const child = await serving((params, context) => {
      calls.push({ params, streams: context.streams, generation: context.generation });
      return new StreamedReply({ node: 1, bytes: bytes.length }, whole(bytes));
    });
    const fetch = child.fetch(3, { type: 'beacon_api', path: 'eth/v1/beacon/headers/head' });

    await expect(fetch.done).resolves.toEqual({ bytes, node: 1 });
    expect(calls).toEqual([
      {
        params: {
          request: 3,
          type: 'beacon_api',
          method: 'get',
          path: 'eth/v1/beacon/headers/head',
          accept: 'json',
          exclude_mask: 0,
        },
        streams: true,
        generation: 1,
      },
    ]);
    // The head says `body: true`, as fc-service's asks need.
    expect(fetch.head).toEqual({ node: 1, bytes: 300_000, body: true });
    expect(child.terminals).toEqual([{ id: fetch.id, type: 'end' }]);
    await until(() => twoWay.streamStats().sending === 0, 'the request done');
    expect(twoWay.streamStats()).toMatchObject({
      outstanding: 0,
      pieces: 0,
      sending: 0,
      held: 0,
      pending: 0,
    });
    expect(child.protocolError).toBeNull();
  });

  test('credit flows: a paused service holds main to its window, and main reads no further than one read past it', async () => {
    const length = 1024 * 1024;
    const src = source(2, length);
    const child = await serving(() => new StreamedReply({ node: 0, bytes: length }, src.stream));
    const fetch = child.fetch(4, {}, { paused: true });

    await until(() => fetch.arrived === WINDOW, 'the first window');
    for (let i = 0; i < 20; i++) await tick();
    expect(fetch.arrived).toBe(WINDOW);
    expect(src.read).toBeLessThanOrEqual(WINDOW + MAX_DATA);

    fetch.resume();
    await expect(fetch.done).resolves.toEqual({ bytes: body(2, 0, length), node: 0 });
    expect(src.read).toBe(length);
    expect(child.protocolError).toBeNull();
    await until(() => twoWay.streamStats().sending === 0, 'the request done');
    expect(twoWay.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
  });

  test("the service's cancel mid-body: main aborts the body cancelled, lets go of its source, and the connection goes on", async () => {
    const sources = [];
    const signals = [];
    const child = await serving((params, { signal }) => {
      const src = source(5, 1024 * 1024);
      sources.push(src);
      signals.push(signal);
      return new StreamedReply({ node: 0, bytes: 1024 * 1024 }, src.stream);
    });
    const fetch = child.fetch(6, {}, { paused: true });
    await until(() => fetch.arrived === WINDOW, 'the first window');
    fetch.cancel();

    await expect(fetch.done).resolves.toEqual({ cancelled: true, received: 0 });
    await until(() => sources[0].cancelled, 'the source let go of');
    expect(signals[0].aborted).toBe(true);
    await until(() => child.terminals.length === 1, "main's terminal");
    expect(child.terminals).toEqual([{ id: fetch.id, type: 'abort', code: 'cancelled' }]);
    expect(child.duplex.receiver.outstanding()).toBe(0);
    await until(() => twoWay.streamStats().sending === 0, 'the request done');
    expect(twoWay.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });

    // Its other streams and its control frames go on.
    await expect(twoWay.request('colibri.stats')).resolves.toMatchObject({ open_requests: 0 });
    const again = await child.fetch(6).done;
    expect(again).toEqual({ bytes: body(5, 0, 1024 * 1024), node: 0 });
    expect(child.protocolError).toBeNull();
  });

  test("a head the service can't reserve: it cancels at once, main lets go of the body, and the fetch fails busy", async () => {
    const src = source(7, 2 * 1024 * 1024);
    const child = await serving(
      () => new StreamedReply({ node: 0, bytes: 2 * 1024 * 1024 }, src.stream)
    );
    const fetch = child.fetch(8, {}, { reserve: false });

    await expect(fetch.done).resolves.toEqual({ error: 'Colibri fetch busy' });
    await until(() => src.cancelled, 'the source let go of');
    await until(() => child.terminals.length === 1, "main's terminal");
    expect(child.terminals).toEqual([{ id: fetch.id, type: 'abort', code: 'cancelled' }]);
    expect(fetch.received).toBe(0);
    await until(() => twoWay.streamStats().sending === 0, 'the request done');
    expect(child.protocolError).toBeNull();
  });

  test("a body that breaks its head's length fails that fetch alone: longer with a cancel, shorter at its end", async () => {
    const answers = [
      () => new StreamedReply({ node: 0, bytes: 100 }, whole(body(9, 0, 200))),
      () => new StreamedReply({ node: 0, bytes: 200 }, whole(body(9, 0, 100))),
      () => new StreamedReply({ node: 2, bytes: 100 }, whole(body(9, 0, 100))),
    ];
    const child = await serving(() => answers.shift()());

    await expect(child.fetch(10).done).resolves.toEqual({ error: 'Colibri body length mismatch' });
    await expect(child.fetch(10).done).resolves.toEqual({ error: 'Colibri body length mismatch' });
    await expect(child.fetch(10).done).resolves.toEqual({ bytes: body(9, 0, 100), node: 2 });
    expect(child.protocolError).toBeNull();
  });

  test("a head's node: absent is node 0, as freedom-colibrid reads it; a present null doesn't parse", async () => {
    const answers = [
      () => new StreamedReply({ bytes: 100 }, whole(body(15, 0, 100))),
      () => new StreamedReply({ node: null, bytes: 100 }, whole(body(15, 0, 100))),
    ];
    const child = await serving(() => answers.shift()());

    await expect(child.fetch(16).done).resolves.toEqual({ bytes: body(15, 0, 100), node: 0 });
    await expect(child.fetch(16).done).resolves.toEqual({
      error: "Colibri fetch head doesn't parse",
    });
    expect(child.protocolError).toBeNull();
  });

  test("main's answers without a body: a ShellError, a result that names an error, and a head that opens none", async () => {
    const child = await serving((params) => {
      if (params.path === 'refused') throw new ShellError('refused');
      if (params.path === 'full') return { error: 'Colibri fetch pool full' };
      return { node: 0, bytes: 0 };
    });

    await expect(child.fetch(11, { path: 'refused' }).done).resolves.toEqual({ error: 'Refused' });
    await expect(child.fetch(11, { path: 'full' }).done).resolves.toEqual({
      error: 'Colibri fetch pool full',
    });
    await expect(child.fetch(11, { path: 'none' }).done).resolves.toEqual({
      error: 'Colibri fetch has no body',
    });
    await until(() => twoWay.streamStats().sending === 0, 'the requests done');
    expect(twoWay.streamStats()).toMatchObject({ pieces: 0, held: 0, pending: 0 });
  });

  test("the service's own bodies end with a service's codes: `internal` errors the body; the core's `verification_failed` is a protocol error", async () => {
    await serving(null, {
      script: {
        stats: (message, child) => {
          child.head(message.id, { body: true });
          child.body(message.id, body(12, 0, 200_000), {
            abort: { at: 100_000, code: 'internal' },
          });
        },
        checkpoint: (message, child) => {
          child.head(message.id, { body: true });
          child.writeRaw(encodeAbort(message.id, 'verification_failed', 'not a service code'));
        },
      },
    });

    const { result, body: stream } = await twoWay.callStream('colibri.stats');
    expect(result).toEqual({ body: true });
    const { error } = await readAll(stream.getReader());
    expect(error).toMatchObject({ code: 'internal' });

    const generation = twoWay.current;
    const second = await twoWay.callStream('colibri.checkpoint');
    const read = await readAll(second.body.getReader());
    expect(read.error).toMatchObject({ code: 'colibri_unavailable' });
    expect(log.error).toHaveBeenCalledWith('[Colibri] protocol error', { category: 'abort_code' });
    await until(() => generation.retired, 'the generation to end');
  });

  test("no fragments on a two-way service's connection: a begin is a protocol error", async () => {
    const child = await serving(null);
    const generation = twoWay.current;
    child.writeRaw(encodeBegin(1, 2 * 1024 * 1024));

    await until(() => generation.retired, 'the generation to end');
    expect(log.error).toHaveBeenCalledWith('[Colibri] protocol error', {
      category: 'unknown_kind',
    });
  });

  test("a one-way service is as before: a streams handler's body is an internal error, and the service's credit a protocol error", async () => {
    const src = source(13, 1000);
    const seen = [];
    const child = await serving(
      (params, { streams }) => {
        seen.push(streams);
        return new StreamedReply({ node: 0, bytes: 1000 }, src.stream);
      },
      { service: testService({ duplex: undefined, streams: () => true }) }
    );
    expect(twoWay.current.duplex).toBeNull();

    await expect(child.fetch(14).done).resolves.toEqual({ error: 'Internal error' });
    expect(seen).toEqual([false]);
    await until(() => src.cancelled, 'the body let go of');

    const generation = twoWay.current;
    child.writeRaw(encodeStreamCredit(1, 1000));
    await until(() => generation.retired, 'the generation to end');
    expect(log.error).toHaveBeenCalledWith('[Colibri] protocol error', {
      category: 'stream_direction',
    });
  });
});
