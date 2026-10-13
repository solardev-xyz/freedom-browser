/**
 * ServiceClient's streams (design 0007, Frames and Main's side) against a
 * scripted service in a real child process (`test/helpers/
 * fake-stream-service.js`, on the JS model of fc-protocol's Sender): a
 * head, then a pull-driven body; a paused reader whose credit stays
 * bounded; cancels before the head, mid-body and after `end`; an abort; a
 * protocol error that ends the generation; and a restart while a stream is
 * open.
 */

const path = require('path');
const { spawn } = require('child_process');
const { ServiceClient, CoreError } = require('./service-client');
const { JSON_KINDS, WINDOW } = require('./frame');

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

/** The ID the next request will take. */
const nextId = () => client.current.nextId;
const stats = () => client.request('fake.stats');

describe('ServiceClient streams', () => {
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
