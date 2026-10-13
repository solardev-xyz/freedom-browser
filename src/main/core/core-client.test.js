const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const path = require('path');
const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');
const {
  CoreClient,
  CoreError,
  ShellError,
  scrubbedEnv,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_INCOMING,
} = require('./core-client');
const {
  encodeBegin,
  encodeCredit,
  encodeFrame,
  frameHeader,
  FrameDecoder,
  Reassembler,
  KIND_BEGIN,
  KIND_CREDIT,
  KIND_FRAGMENT,
  KIND_JSON,
  KIND_LAST,
  MAX_MESSAGE,
  MAX_PAYLOAD,
} = require('./frame');

const tick = () => new Promise(setImmediate);
const MIB = 1024 * 1024;

function rawFrame(kind, payload) {
  const bytes = Buffer.from(payload);
  return Buffer.concat([frameHeader(kind, bytes.length), bytes]);
}

/** `message` as a fragmented response: its begin, then `pieces` fragments,
 * the last of kind 0x11. */
function fragmentFrames(message, pieces = 2) {
  const payload = Buffer.from(JSON.stringify(message));
  const size = Math.ceil(payload.length / pieces);
  const frames = [encodeBegin(message.id, payload.length)];
  for (let offset = 0; offset < payload.length; offset += size) {
    const end = Math.min(payload.length, offset + size);
    frames.push(
      rawFrame(end === payload.length ? KIND_LAST : KIND_FRAGMENT, payload.subarray(offset, end))
    );
  }
  return frames;
}

/**
 * A fake freedom-cored child that answers through a handler. Like Node's
 * ChildProcess it emits 'exit' and then 'close'; `exit(…, { close: false })`
 * holds 'close' back (stdout still open after the process is gone).
 *
 * It reads main's frames as the core does: `requests` holds every message,
 * a fragmented reply once reassembled, `wire` the kind of every frame, and
 * `credits` the 0x13 frames main returned. It gives main's credit back after
 * each fragmented reply, unless `holdCredit` is set.
 */
class FakeCore extends EventEmitter {
  constructor(handler, options = {}) {
    super();
    this.pid = 'pid' in options ? options.pid : 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = null;
    this.exitOnKill = options.exitOnKill ?? true;
    this.failKill = options.failKill ?? false; // kill emits 'error' synchronously
    this.killCalls = 0;
    this.stuck = false; // stdin accepts bytes but never completes writes
    this.held = []; // the write callbacks `stuck` holds back
    this.requests = [];
    this.wire = [];
    this.credits = 0;
    this.holdCredit = false;
    this.outstanding = new Set(); // the fake's own requests to main
    this.reassembler = new Reassembler();
    const decoder = new FrameDecoder();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of decoder.push(chunk)) {
          this.wire.push(frame.kind);
          const delivery = this.reassembler.push(frame, (id) => this.outstanding.has(id));
          if (delivery?.type === 'credit') this.credits += 1;
          if (delivery?.type !== 'message' && delivery?.type !== 'response') continue;
          const { message } = delivery;
          if (message?.type === 'response') this.outstanding.delete(message.id);
          this.requests.push(message);
          if (delivery.type === 'response' && !this.holdCredit) this.returnCredit();
          handler(message, this);
        }
        if (this.stuck) this.held.push(callback);
        else callback();
      },
      final: (callback) => {
        this.emit('stdin-closed');
        callback();
      },
    });
  }

  reply(message) {
    if (message?.type === 'request') this.outstanding.add(message.id);
    this.stdout.write(encodeFrame(message));
  }

  /** Sends `message`, a response, fragmented. */
  replyFragmented(message, pieces) {
    for (const frame of fragmentFrames(message, pieces)) this.stdout.write(frame);
  }

  /** Completes the writes `stuck` held back, and those after. */
  release() {
    this.stuck = false;
    for (const callback of this.held.splice(0)) callback();
  }

  /** Returns main's credit, as the core does once it has a reply. */
  returnCredit() {
    this.reassembler.grant();
    this.stdout.write(encodeCredit());
  }

  exit(code, signal = null, { close = true } = {}) {
    this.emit('exit', code, signal);
    if (close) setImmediate(() => this.close(code, signal));
  }

  close(code = null, signal = null) {
    this.stdout.end();
    this.emit('close', code, signal);
  }

  kill(signal) {
    this.killCalls += 1;
    if (this.failKill) {
      // Like Node's ChildProcess.kill on EPERM: 'error' before returning.
      this.emit('error', new Error('kill EPERM'));
      return false;
    }
    this.killed = signal;
    if (this.exitOnKill) setImmediate(() => this.exit(null, signal));
    return true;
  }
}

const quietLog = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

function helloResult(extra = {}) {
  return { protocol: 1, core_version: '0.1.0', capabilities: ['vault.status'], ...extra };
}

function helloHandler(extra = () => {}) {
  return (message, core) => {
    if (message.method === 'core.hello') {
      core.reply({ type: 'response', id: message.id, result: helloResult() });
    } else if (message.method === 'core.shutdown') {
      core.reply({ type: 'response', id: message.id, result: {} });
    } else {
      extra(message, core);
    }
  };
}

function makeClient(handlers, options = {}) {
  const children = [];
  let index = 0;
  const spawn = jest.fn(() => {
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    const child = new FakeCore(handler, options.child);
    children.push(child);
    return child;
  });
  const timers = [];
  const log = options.log || quietLog();
  const client = new CoreClient({
    spawn,
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    now: options.now || (() => 0),
  });
  const runTimers = (ms) => {
    for (const timer of timers.splice(0)) {
      if (!timer.cleared && timer.ms === ms) timer.fn();
      else if (!timer.cleared) timers.push(timer);
    }
  };
  return { client, spawn, children, runTimers, timers, log };
}

/** Starts a client whose core holds every non-control request unanswered. */
async function readyWithHeldRequest(options = {}) {
  const made = makeClient([helloHandler()], options);
  await made.client.start();
  const pending = made.client.request('vault.status').catch((e) => e);
  await tick();
  const held = made.children[0].requests.find((r) => r.method === 'vault.status');
  return { ...made, pending, heldId: held.id };
}

describe('CoreClient', () => {
  test('handshake, request and typed errors', async () => {
    const { client, children, spawn } = makeClient([
      helloHandler((message, core) => {
        if (message.method === 'vault.status') {
          core.reply({ type: 'response', id: message.id, result: { exists: false } });
        } else {
          core.reply({
            type: 'response',
            id: message.id,
            error: { code: 'vault_locked', message: 'Vault is locked' },
          });
        }
      }),
    ]);
    const hello = await client.start();
    expect(hello).toEqual({ ...helloResult(), node_recovery: null });
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('/bin/freedom-cored');
    expect(args).toEqual(['serve']);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(children[0].requests[0]).toMatchObject({
      type: 'request',
      method: 'core.hello',
      params: { protocol: 1 },
      context: { caller: 'shell' },
    });

    await expect(client.request('vault.status')).resolves.toEqual({ exists: false });
    const error = await client.request('vault.unlock', { password_b64: 'eA==' }).catch((e) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect(error.code).toBe('vault_locked');
    expect(error.message).toBe('Vault is locked');
  });

  test('scrubs the environment', () => {
    expect(
      scrubbedEnv({ PATH: '/bin', NODE_OPTIONS: '--inspect', SECRET: 'x', HOME: '/h' })
    ).toEqual({
      PATH: '/bin',
      HOME: '/h',
    });
  });

  test('a crash rejects pending requests and restarts with backoff', async () => {
    const { client, children, runTimers, pending } = await readyWithHeldRequest();
    children[0].exit(1);
    expect((await pending).code).toBe('core_unavailable');
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test('a late reply from a retired child is ignored', async () => {
    const { client, children, runTimers } = makeClient([helloHandler(), helloHandler()]);
    await client.start();
    children[0].exit(1);
    await tick();
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    children[0].reply({ type: 'response', id: 1, result: {} });
    await tick();
    expect(children[1].killed).toBeNull();
    expect(client.state).toBe('ready');
  });

  test('requestTo reaches only the process it names, and never waits', async () => {
    const answer = (message, core) =>
      core.reply({ type: 'response', id: message.id, result: { ok: true } });
    const { client, children, runTimers } = makeClient([
      helloHandler(answer),
      helloHandler(answer),
    ]);
    await client.start();
    const first = client.current;
    expect(await client.requestTo(first, 'vault.status')).toEqual({ ok: true });
    // Exited, not yet retired: request() would wait for the next process,
    // requestTo fails at once.
    expect(client.serves(first)).toBe(true);
    children[0].exit(1, null, { close: false });
    expect(client.serves(first)).toBe(false);
    await expect(client.requestTo(first, 'naming.configure')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    children[0].close(1);
    await tick();
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    await expect(client.requestTo(first, 'naming.configure')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    await expect(client.requestTo(null, 'vault.status')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(children[1].requests.map((m) => m.method)).toEqual(['core.hello']);
    expect(await client.requestTo(client.current, 'vault.status')).toEqual({ ok: true });
  });

  test('a request past its hang watchdog kills the core, which fails it; one answered clears it', async () => {
    const WATCHDOG = 135_000;
    const answer = (message, core) => {
      if (message.method === 'naming.answered') {
        core.reply({ type: 'response', id: message.id, result: {} });
      }
    };
    const { client, children, runTimers, timers } = makeClient([
      helloHandler(answer),
      helloHandler(answer),
    ]);
    await client.start();
    const gen = client.current;
    await client.requestTo(gen, 'naming.answered', {}, undefined, { watchdogMs: WATCHDOG });
    expect(timers.filter((t) => t.ms === WATCHDOG && !t.cleared)).toEqual([]);
    const hung = client
      .requestTo(gen, 'naming.resolve_content', {}, undefined, { watchdogMs: WATCHDOG })
      .catch((e) => e);
    await tick();
    expect(children[0].killed).toBeNull();
    runTimers(WATCHDOG);
    expect(children[0].killed).toBe('SIGKILL');
    expect((await hung).code).toBe('core_unavailable');
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test('exit codes that mean "do not retry" fail without restarting', async () => {
    for (const code of [64, 74, 75]) {
      const { client, children } = makeClient([helloHandler()]);
      await client.start();
      const failed = new Promise((resolve) => client.once('failed', resolve));
      children[0].exit(code);
      await failed;
      expect(client.state).toBe('failed');
      await expect(client.request('vault.status')).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      expect(children).toHaveLength(1);
    }
  });

  test('exit 76 without a mismatch is retried under the crash policy', async () => {
    const { client, children, runTimers } = makeClient([helloHandler()]);
    await client.start();
    children[0].exit(76);
    await tick();
    expect(client.state).toBe('starting');
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test('a protocol mismatch is never retried', async () => {
    const variants = [
      (m) => ({
        type: 'response',
        id: m.id,
        error: { code: 'protocol_mismatch', message: 'Protocol mismatch', data: { core: 2 } },
      }),
      (m) => ({ type: 'response', id: m.id, result: helloResult({ protocol: 2 }) }),
    ];
    for (const reply of variants) {
      const { client, children, spawn } = makeClient([
        (m, core) => m.method === 'core.hello' && core.reply(reply(m)),
      ]);
      const failed = new Promise((resolve) => client.once('failed', resolve));
      await expect(client.start()).rejects.toMatchObject({ code: 'core_unavailable' });
      await expect(failed).resolves.toBe('protocol mismatch');
      expect(children[0].killed).toBe('SIGKILL');
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });

  test('three crashes within a minute give up', async () => {
    const { client, children, runTimers } = makeClient([helloHandler()], { now: () => 1000 });
    await client.start();
    children[0].exit(1);
    await tick();
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    children[1].exit(1);
    await tick();
    runTimers(RESTART_DELAYS_MS[1]);
    await client.whenReady();
    const failed = new Promise((resolve) => client.once('failed', resolve));
    children[2].exit(1);
    await failed;
    expect(children).toHaveLength(3);
  });

  test('protocol violations kill the child', async () => {
    const { client, children } = makeClient([helloHandler()]);
    await client.start();
    children[0].reply({ type: 'response', id: 999, result: {} });
    await tick();
    expect(children[0].killed).toBe('SIGKILL');

    const second = await readyWithHeldRequest();
    second.children[0].reply({
      type: 'response',
      id: second.heldId,
      result: {},
      error: { code: 'busy', message: 'Busy' },
    });
    await tick();
    expect(second.children[0].killed).toBe('SIGKILL');
  });

  test('a missing hello reply times out and is retried', async () => {
    const { client, children, runTimers, spawn } = makeClient([() => {}]);
    const started = client.start().catch((e) => e);
    runTimers(10_000);
    await tick();
    expect(children[0].killed).toBe('SIGKILL');
    await tick();
    expect(client.state).toBe('starting');
    await client.stop();
    expect((await started).code).toBe('core_unavailable');
    runTimers(RESTART_DELAYS_MS[0]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('events are emitted', async () => {
    const { client, children } = makeClient([helloHandler()]);
    await client.start();
    const event = new Promise((resolve) =>
      client.once('event', (name, data) => resolve({ name, data }))
    );
    children[0].reply({ type: 'event', event: 'vault.locked', data: { reason: 'auto', epoch: 3 } });
    await expect(event).resolves.toEqual({
      name: 'vault.locked',
      data: { reason: 'auto', epoch: 3 },
    });
  });

  test('stop sends core.shutdown and closes stdin', async () => {
    const { client, children } = makeClient([helloHandler()]);
    await client.start();
    const closed = new Promise((resolve) => children[0].once('stdin-closed', resolve));
    const stopped = client.stop();
    await closed;
    expect(children[0].requests.map((r) => r.method)).toContain('core.shutdown');
    children[0].exit(0);
    await stopped;
    expect(client.state).toBe('stopped');
    await expect(client.request('vault.status')).rejects.toMatchObject({
      code: 'core_unavailable',
    });
  });

  test('stderr JSON lines are forwarded to the log', async () => {
    const { client, children, log } = makeClient([helloHandler()]);
    await client.start();
    children[0].stderr.write('{"level":"warn","msg":"stdin closed","id":4}\nplain text\n');
    await tick();
    expect(log.warn).toHaveBeenCalledWith('[Core] stdin closed', { id: 4 });
    expect(log.info).toHaveBeenCalledWith('[Core]', 'plain text');
  });

  describe('M1: stopping is sticky', () => {
    test('a hello reply after stop() never makes the client ready', async () => {
      let hello = null;
      const { client, children, spawn, runTimers } = makeClient([
        (m) => {
          if (m.method === 'core.hello') hello = m;
        },
      ]);
      const started = client.start().catch((e) => e);
      await tick();
      const closed = new Promise((resolve) => children[0].once('stdin-closed', resolve));
      const stopped = client.stop();
      await closed;
      children[0].reply({ type: 'response', id: hello.id, result: helloResult() });
      await tick();
      expect(client.state).toBe('stopping');
      expect((await started).code).toBe('core_unavailable');
      // Before the handshake, stop() only closes stdin (the core exits on EOF).
      expect(children[0].requests.map((r) => r.method)).toEqual(['core.hello']);
      children[0].exit(0);
      await stopped;
      expect(client.state).toBe('stopped');
      runTimers(RESTART_DELAYS_MS[0]);
      runTimers(10_000);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    test('stop() during restart backoff rejects waiters and never respawns', async () => {
      const { client, children, spawn, runTimers } = makeClient([helloHandler()]);
      await client.start();
      children[0].exit(1);
      await tick();
      const waiting = client.whenReady().catch((e) => e);
      await client.stop();
      expect((await waiting).code).toBe('core_unavailable');
      runTimers(RESTART_DELAYS_MS[0]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(client.state).toBe('stopped');
    });

    test('every stop() caller settles; start() during stopping is refused', async () => {
      const { client, children } = makeClient([helloHandler()]);
      await client.start();
      const first = client.stop();
      const second = client.stop();
      await expect(client.start()).rejects.toMatchObject({ code: 'core_unavailable' });
      children[0].exit(0);
      await Promise.all([first, second]);
      expect(client.state).toBe('stopped');
      await client.start();
      expect(client.state).toBe('ready');
    });

    test('a core that ignores shutdown is killed after the grace period', async () => {
      const { client, children, runTimers } = makeClient([helloHandler()]);
      await client.start();
      const stopped = client.stop();
      runTimers(3_000);
      expect(children[0].killed).toBe('SIGKILL');
      await stopped;
      expect(client.state).toBe('stopped');
    });
  });

  describe('M2: generations', () => {
    test('a final reply after exit is delivered; events after exit are not', async () => {
      const { client, children, pending, heldId } = await readyWithHeldRequest();
      const events = [];
      client.on('event', (name) => events.push(name));
      children[0].exit(1, null, { close: false });
      children[0].reply({ type: 'event', event: 'vault.locked', data: { reason: 'auto' } });
      children[0].reply({ type: 'response', id: heldId, result: { exists: true } });
      await expect(pending).resolves.toEqual({ exists: true });
      expect(events).toEqual([]);
      children[0].close(1);
    });

    test('requests still pending at close are rejected', async () => {
      const { children, pending } = await readyWithHeldRequest();
      children[0].exit(1, null, { close: false });
      await tick();
      children[0].close(1);
      expect((await pending).code).toBe('core_unavailable');
    });

    test('a hello reply racing the exit never makes the client ready', async () => {
      let hello = null;
      const { client, children } = makeClient([
        (m) => {
          if (m.method === 'core.hello') hello = m;
        },
      ]);
      const ready = jest.fn();
      client.on('ready', ready);
      client.start().catch(() => {});
      await tick();
      children[0].exit(1, null, { close: false });
      children[0].reply({ type: 'response', id: hello.id, result: helloResult() });
      await tick();
      expect(ready).not.toHaveBeenCalled();
      expect(client.state).toBe('starting');
      children[0].close(1);
      await tick();
      await client.stop();
    });

    test('a stuck close is bounded by the drain timer', async () => {
      const { client, children, pending, runTimers } = await readyWithHeldRequest();
      children[0].exit(1, null, { close: false });
      await tick();
      runTimers(2_000);
      expect((await pending).code).toBe('core_unavailable');
      expect(client.state).toBe('starting');
    });

    test('stderr of a retired child is ignored', async () => {
      const { client, children, runTimers, log } = makeClient([helloHandler()]);
      await client.start();
      children[0].exit(1);
      await tick();
      runTimers(RESTART_DELAYS_MS[0]);
      await client.whenReady();
      log.warn.mockClear();
      children[0].stderr.write('{"level":"warn","msg":"ghost"}\n');
      await tick();
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('M4: pipes and child errors', () => {
    test('a stdin error fails the connection', async () => {
      const { client, children, runTimers } = makeClient([helloHandler()]);
      await client.start();
      children[0].stdin.emit('error', new Error('EPIPE'));
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      await tick();
      runTimers(RESTART_DELAYS_MS[0]);
      await client.whenReady();
      expect(children).toHaveLength(2);
    });

    test('a live child closing stdout fails the connection', async () => {
      const { children, pending, log } = await readyWithHeldRequest();
      children[0].stdout.write(Buffer.from([0, 0, 0, 9, 1, 0x7b]));
      children[0].stdout.end();
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      expect(log.warn).toHaveBeenCalledWith('[Core] stdout closed in the middle of a frame');
      await tick();
      expect((await pending).code).toBe('core_unavailable');
    });

    test('a child error after spawn waits for the real exit', async () => {
      const { client, children, spawn, pending, runTimers } = await readyWithHeldRequest();
      children[0].exitOnKill = false;
      children[0].emit('error', new Error('kill failed'));
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      runTimers(RESTART_DELAYS_MS[0]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(client.state).toBe('ready');
      children[0].exit(null, 'SIGKILL');
      expect((await pending).code).toBe('core_unavailable');
      runTimers(RESTART_DELAYS_MS[0]);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    test('a spawn failure (no pid) retires the generation', async () => {
      const { client, children, runTimers } = makeClient([() => {}], {
        child: { pid: undefined },
      });
      const started = client.start().catch((e) => e);
      children[0].emit('error', new Error('ENOENT'));
      expect(children[0].killed).toBeNull();
      expect(client.state).toBe('starting');
      runTimers(RESTART_DELAYS_MS[0]);
      expect(children).toHaveLength(2);
      const stopped = client.stop();
      children[1].exit(0);
      await stopped;
      expect((await started).code).toBe('core_unavailable');
    });
  });

  describe('M5: validation', () => {
    const malformed = [
      ['null', () => null],
      ['a scalar', () => 42],
      ['an array', () => [1]],
      ['an unknown type', () => ({ type: 'nope' })],
      ['error: null', (id) => ({ type: 'response', id, error: null })],
      ['an error without a code', (id) => ({ type: 'response', id, error: { message: 'x' } })],
      ['a bad id', () => ({ type: 'response', id: -1, result: {} })],
      ['a string id', () => ({ type: 'response', id: '1', result: {} })],
      ['a bad event name', () => ({ type: 'event', event: 'NOPE', data: {} })],
      ['array event data', () => ({ type: 'event', event: 'vault.locked', data: [] })],
    ];
    test.each(malformed)('%s kills the child and rejects the request', async (_name, make) => {
      const { children, pending, heldId } = await readyWithHeldRequest();
      children[0].reply(make(heldId));
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      await tick();
      expect((await pending).code).toBe('core_unavailable');
    });

    const badHellos = [
      ['missing fields', { protocol: 1 }],
      ['null', null],
      ['a bad version', helloResult({ core_version: 'x y' })],
      ['non-string capabilities', helloResult({ capabilities: [1] })],
      ['an unknown node_recovery status', helloResult({ node_recovery: { status: 'ok' } })],
      [
        'a bad node_recovery node',
        helloResult({ node_recovery: { status: 'corrupt', node: 'x' } }),
      ],
      [
        'a bad node_recovery op id',
        helloResult({ node_recovery: { status: 'corrupt', op_id: 'a b' } }),
      ],
    ];
    test('a valid node_recovery report is kept, extra fields dropped', async () => {
      const report = { status: 'pending_recovery', op_id: 'op-1', node: 'bee' };
      const { client } = makeClient([
        (m, core) =>
          m.method === 'core.hello' &&
          core.reply({
            type: 'response',
            id: m.id,
            result: helloResult({ node_recovery: { ...report, secret: 'x' } }),
          }),
      ]);
      const hello = await client.start();
      expect(hello.node_recovery).toEqual(report);
    });

    test.each(badHellos)('a hello result with %s is refused', async (_name, result) => {
      const { client, children, spawn } = makeClient([
        (m, core) =>
          m.method === 'core.hello' && core.reply({ type: 'response', id: m.id, result }),
      ]);
      const ready = jest.fn();
      client.on('ready', ready);
      client.start().catch(() => {});
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      await tick();
      await tick();
      expect(ready).not.toHaveBeenCalled();
      expect(client.state).toBe('starting');
      expect(spawn).toHaveBeenCalledTimes(1);
      await client.stop();
    });

    test('an exhausted handshake is still bounded by the hello deadline', async () => {
      // A hello reply that fails validation must not disarm the deadline:
      // here the kill doesn't take, and the deadline kills again.
      const { client, children, runTimers } = makeClient(
        [
          (m, core) =>
            m.method === 'core.hello' && core.reply({ type: 'response', id: m.id, result: null }),
        ],
        { child: { exitOnKill: false } }
      );
      client.start().catch(() => {});
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      children[0].killed = null;
      runTimers(10_000);
      expect(children[0].killed).toBe('SIGKILL');
      children[0].exit(null, 'SIGKILL');
      await tick();
      await client.stop();
    });

    test('odd log lines are forwarded safely', async () => {
      const { client, children, log } = makeClient([helloHandler()]);
      await client.start();
      children[0].stderr.write('null\n{"level":"constructor","msg":"odd level"}\n{"msg":5}\n');
      await tick();
      expect(log.info).toHaveBeenCalledWith('[Core]', 'null');
      expect(log.info).toHaveBeenCalledWith('[Core] odd level', '');
      expect(log.info).toHaveBeenCalledWith('[Core]', '{"msg":5}');
    });
  });

  describe('M6: bounded memory', () => {
    test('requests beyond the pending limit are refused locally', async () => {
      const { client } = makeClient([helloHandler(() => {})]);
      await client.start();
      const held = [];
      for (let i = 0; i < MAX_PENDING; i += 1) {
        held.push(client.request('vault.status').catch((e) => e));
      }
      await expect(client.request('vault.status')).rejects.toMatchObject({ code: 'busy' });
    });

    test('bytes in flight are bounded, and shutdown still gets through', async () => {
      const { client, children, runTimers } = makeClient([helloHandler(() => {})]);
      await client.start();
      children[0].stuck = true;
      const big = { blob: 'x'.repeat(1000 * 1000) };
      const results = [];
      for (let i = 0; i < 12; i += 1) {
        results.push(client.request('vault.status', big).catch((e) => e));
      }
      const refused = await Promise.race([results[11], tick().then(() => 'pending')]);
      expect(refused).toMatchObject({ code: 'busy' });
      const stopped = client.stop();
      runTimers(3_000);
      await stopped;
      expect(client.state).toBe('stopped');
      for (const result of await Promise.all(results.slice(0, 8))) {
        expect(result.code).toBe('core_unavailable');
      }
    });

    test('a newline-free stderr flood is truncated, not buffered', async () => {
      const { client, children, log } = makeClient([helloHandler()]);
      await client.start();
      children[0].stderr.write('y'.repeat(100_000));
      children[0].stderr.write('z'.repeat(100_000));
      children[0].stderr.write('\nnext\n');
      await tick();
      const lines = log.info.mock.calls.map((call) => call[1]);
      expect(lines).toHaveLength(2);
      expect(lines[0].length).toBeLessThan(1100);
      expect(lines[0]).toMatch(/…\(truncated\)$/);
      expect(lines[1]).toBe('next');
    });
  });

  describe('M7: logs never carry peer text', () => {
    const SENTINEL = 'SECRET_SENTINEL_PASSWORD';
    const logged = (log) =>
      JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);

    test.each([
      ['a string id', () => ({ type: 'response', id: SENTINEL, result: {} })],
      ['an unknown type', () => ({ type: SENTINEL })],
      ['an unsolicited id', () => ({ type: 'response', id: 777, result: { SENTINEL } })],
      [
        'a bad error code',
        (id) => ({ type: 'response', id, error: { code: SENTINEL, message: SENTINEL } }),
      ],
    ])('%s', async (_name, make) => {
      const { children, heldId, log } = await readyWithHeldRequest();
      children[0].reply(make(heldId));
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      expect(logged(log)).not.toContain(SENTINEL);
    });

    test('malformed JSON', async () => {
      const { children, log } = await readyWithHeldRequest();
      const payload = Buffer.from(`{"password":"${SENTINEL}`);
      const header = Buffer.alloc(5);
      header.writeUInt32BE(payload.length + 1, 0);
      header[4] = 1;
      children[0].stdout.write(Buffer.concat([header, payload]));
      await tick();
      expect(children[0].killed).toBe('SIGKILL');
      expect(logged(log)).not.toContain(SENTINEL);
    });

    test('hello errors and extra hello fields', async () => {
      const refused = makeClient([
        (m, core) =>
          m.method === 'core.hello' &&
          core.reply({
            type: 'response',
            id: m.id,
            error: { code: 'internal', message: SENTINEL },
          }),
      ]);
      refused.client.start().catch(() => {});
      await tick();
      expect(logged(refused.log)).not.toContain(SENTINEL);
      await refused.client.stop();

      const extra = makeClient([
        (m, core) =>
          m.method === 'core.hello' &&
          core.reply({ type: 'response', id: m.id, result: helloResult({ secret: SENTINEL }) }),
      ]);
      const hello = await extra.client.start();
      expect(JSON.stringify(hello)).not.toContain(SENTINEL);
      expect(logged(extra.log)).not.toContain(SENTINEL);
    });
  });

  describe('confirmation pass', () => {
    test('a failed kill is retried on a timer, boundedly, and stop still closes stdin', async () => {
      const { client, children, runTimers } = makeClient([helloHandler()], {
        child: { failKill: true },
      });
      await client.start();
      children[0].reply({ type: 'response', id: 999, result: {} });
      await tick();
      expect(children[0].killCalls).toBe(1);
      runTimers(1_000);
      expect(children[0].killCalls).toBe(2);
      runTimers(1_000);
      expect(children[0].killCalls).toBe(3);
      runTimers(1_000);
      expect(children[0].killCalls).toBe(3);
      // stop() on the ending generation still closes stdin and arms the grace kill.
      const closed = new Promise((resolve) => children[0].once('stdin-closed', resolve));
      const stopped = client.stop();
      await closed;
      runTimers(3_000);
      expect(children[0].killCalls).toBe(4);
      children[0].exit(null, 'SIGKILL');
      await stopped;
      expect(client.state).toBe('stopped');
    });

    test('log levels of any JSON shape never throw', async () => {
      const { client, children, log } = makeClient([
        helloHandler((m, core) => core.reply({ type: 'response', id: m.id, result: { ok: true } })),
      ]);
      await client.start();
      for (const level of ['null', '5', '[]', '{"toString":null}', '"__proto__"']) {
        children[0].stderr.write(`{"level":${level},"msg":"m"}\n`);
      }
      await tick();
      expect(log.info).toHaveBeenCalledTimes(5);
      await expect(client.request('vault.status')).resolves.toEqual({ ok: true });
    });

    test('requests waiting for readiness are bounded', async () => {
      const { client, children } = makeClient([() => {}]);
      client.start().catch(() => {});
      const waiting = [];
      for (let i = 0; i < MAX_PENDING; i += 1) {
        waiting.push(client.request('vault.status').catch((e) => e));
      }
      await expect(client.request('vault.status')).rejects.toMatchObject({ code: 'busy' });
      await expect(
        client.request('vault.status', { blob: 'x'.repeat(1024 * 1024) })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      const stopped = client.stop();
      children[0].exit(0);
      for (const result of await Promise.all(waiting)) {
        expect(result.code).toBe('core_unavailable');
      }
      await stopped;
      expect(client.waitingRequests).toBe(0);
      expect(client.waitingBytes).toBe(0);

      // Bytes count too: nine ~1 MB requests exceed 8 MiB.
      const second = makeClient([() => {}]);
      second.client.start().catch(() => {});
      const big = { blob: 'y'.repeat(1000 * 1000) };
      const results = [];
      for (let i = 0; i < 9; i += 1) {
        results.push(second.client.request('vault.status', big).catch((e) => e));
      }
      expect(await results[8]).toMatchObject({ code: 'busy' });
      const secondStopped = second.client.stop();
      second.children[0].exit(0);
      await secondStopped;
    });

    test('the waiting byte budget counts method and context too', async () => {
      const { client, children } = makeClient([() => {}]);
      client.start().catch(() => {});
      const page = 'p'.repeat(500 * 1000);
      const results = [];
      for (let i = 0; i < 32; i += 1) {
        results.push(
          client.request('vault.status', {}, { caller: 'chrome', page }).catch((e) => e)
        );
      }
      // ~0.5 MB each: the 17th crosses 8 MiB.
      expect(await results[16]).toMatchObject({ code: 'busy' });
      expect(client.waitingRequests).toBe(16);
      expect(client.waitingBytes).toBeGreaterThan(8_000_000);
      await expect(
        client.request('vault.status', {}, { caller: 'chrome', page: 'q'.repeat(1024 * 1024) })
      ).rejects.toMatchObject({ code: 'invalid_argument' });
      const stopped = client.stop();
      children[0].exit(0);
      await stopped;
      expect(client.waitingBytes).toBe(0);
    });

    test('unknown error codes are never logged', async () => {
      const { client, log } = makeClient([
        (m, core) =>
          m.method === 'core.hello' &&
          core.reply({
            type: 'response',
            id: m.id,
            error: { code: 'secret_sentinel_password', message: 'x' },
          }),
      ]);
      client.start().catch(() => {});
      await tick();
      const logged = JSON.stringify(log.error.mock.calls);
      expect(logged).not.toContain('secret_sentinel_password');
      expect(log.error).toHaveBeenCalledWith('[Core] handshake refused', { code: 'unknown' });
      await client.stop();
    });

    test('retirement after the drain timeout destroys the stdio', async () => {
      const { client, children, runTimers } = makeClient([helloHandler()]);
      await client.start();
      children[0].exit(1, null, { close: false });
      await tick();
      runTimers(2_000);
      for (const name of ['stdin', 'stdout', 'stderr']) {
        expect(children[0][name].destroyed).toBe(true);
      }
      expect(children[0].listenerCount('exit')).toBe(0);
      await client.stop();
    });

    test('a real child whose pipes outlive it is released after the drain', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-client-held-'));
      const pidFile = path.join(dir, 'holder.pid');
      // A fake core: answers hello, starts a grandchild that inherits
      // stdout/stderr (so 'close' never comes), then exits.
      const script = `
        const { spawn } = require('child_process');
        const fs = require('fs');
        const { FrameDecoder, encodeFrame } = require(${JSON.stringify(require.resolve('./frame'))});
        const decoder = new FrameDecoder();
        process.stdin.on('data', (chunk) => {
          for (const { message: m } of decoder.push(chunk)) {
            if (m?.method !== 'core.hello') continue;
            const reply = { type: 'response', id: m.id,
              result: { protocol: 1, core_version: '0.0.0', capabilities: [] } };
            process.stdout.write(encodeFrame(reply), () => {
              const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],
                { stdio: ['ignore', 'inherit', 'inherit'] });
              fs.writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid));
              process.exit(1);
            });
          }
        });`;
      const spawned = [];
      const client = new CoreClient({
        spawn: (...args) => {
          const child = childProcess.spawn(...args);
          spawned.push(child);
          return child;
        },
        command: process.execPath,
        args: ['-e', script],
        log: quietLog(),
      });
      try {
        await client.start();
        const exited = new Promise((resolve) => client.once('exit', resolve));
        await exited; // retired: the drain timer fired, 'close' never came
        await client.stop();
        const child = spawned[0];
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        expect(spawned).toHaveLength(1);
      } finally {
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
        } catch {
          // Already gone.
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
  });

  describe("the core's requests", () => {
    /** A ready client whose core sends `requests` and records the replies. */
    async function served(register) {
      const made = makeClient([helloHandler()]);
      register(made.client);
      await made.client.start();
      const core = made.children[0];
      const send = (message) =>
        core.reply({ type: 'request', context: { caller: 'shell' }, ...message });
      const replies = () => core.requests.filter((m) => m.type === 'response');
      return { ...made, core, send, replies };
    }

    test('a request reaches its handler and gets one reply', async () => {
      const handler = jest.fn(async (params) => ({ status: 200, body: params.echo }));
      const { send, replies } = await served((client) => client.handle('shell.rpc', handler));
      send({ id: 1, method: 'shell.rpc', params: { echo: 'eA==' } });
      await tick();
      await tick();
      expect(handler).toHaveBeenCalledWith(
        { echo: 'eA==' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(replies()).toEqual([
        { type: 'response', id: 1, result: { status: 200, body: 'eA==' } },
      ]);
    });

    test("errors are fixed codes and messages, never a handler's text", async () => {
      const { send, replies } = await served((client) => {
        client.handle('shell.gateway', async () => {
          throw new ShellError('refused');
        });
        client.handle('shell.tezos', async () => {
          throw new Error('connect ECONNREFUSED https://key@rpc.example');
        });
      });
      send({ id: 1, method: 'shell.gateway', params: {} });
      send({ id: 2, method: 'shell.tezos', params: {} });
      send({ id: 3, method: 'shell.unknown', params: {} });
      for (let i = 0; i < 4; i++) await tick();
      expect(replies()).toEqual([
        { type: 'response', id: 3, error: { code: 'unknown_method', message: 'Unknown method' } },
        { type: 'response', id: 1, error: { code: 'refused', message: 'Refused' } },
        { type: 'response', id: 2, error: { code: 'internal', message: 'Internal error' } },
      ]);
    });

    test('a cancel aborts the handler, which still replies once', async () => {
      let signal;
      const { send, replies } = await served((client) =>
        client.handle('shell.rpc', (_params, context) => {
          signal = context.signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        })
      );
      send({ id: 7, method: 'shell.rpc', params: {} });
      await tick();
      // A cancel for nothing outstanding is ignored.
      send({ type: 'cancel', id: 99 });
      send({ type: 'cancel', id: 7 });
      for (let i = 0; i < 4; i++) await tick();
      expect(signal.aborted).toBe(true);
      expect(replies()).toEqual([
        { type: 'response', id: 7, error: { code: 'cancelled', message: 'Cancelled' } },
      ]);
    });

    test('a result too large for a frame is too_large', async () => {
      const { send, replies } = await served((client) =>
        client.handle('shell.rpc', async () => ({ body: 'x'.repeat(2 * 1024 * 1024) }))
      );
      send({ id: 1, method: 'shell.rpc', params: {} });
      for (let i = 0; i < 4; i++) await tick();
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'too_large', message: 'Too large' } },
      ]);
    });

    test('reused IDs and too many outstanding requests are protocol faults', async () => {
      const hold = () => new Promise(() => {});
      const reused = await served((client) => client.handle('shell.rpc', hold));
      reused.send({ id: 5, method: 'shell.rpc', params: {} });
      reused.send({ id: 5, method: 'shell.rpc', params: {} });
      await tick();
      expect(reused.core.killed).toBe('SIGKILL');

      const many = await served((client) => client.handle('shell.rpc', hold));
      for (let id = 1; id <= MAX_INCOMING + 1; id++)
        many.send({ id, method: 'shell.rpc', params: {} });
      await tick();
      expect(many.core.killed).toBe('SIGKILL');
    });

    test('a generation that ends aborts its handlers, and no reply goes', async () => {
      let signal;
      let finish;
      const { core, send, replies } = await served((client) =>
        client.handle('shell.rpc', (_params, context) => {
          signal = context.signal;
          return new Promise((resolve) => {
            finish = resolve;
          });
        })
      );
      send({ id: 1, method: 'shell.rpc', params: {} });
      await tick();
      core.exit(1);
      await tick();
      expect(signal.aborted).toBe(true);
      finish({ status: 200 });
      for (let i = 0; i < 3; i++) await tick();
      expect(replies()).toEqual([]);
    });

    test('a request cancelled in the same read never reaches its handler', async () => {
      const handler = jest.fn(() => new Promise(() => {}));
      const { core, replies } = await served((client) => client.handle('shell.rpc', handler));
      core.stdout.write(
        Buffer.concat([
          encodeFrame({ type: 'request', id: 1, method: 'shell.rpc', params: {} }),
          encodeFrame({ type: 'cancel', id: 1 }),
        ])
      );
      for (let i = 0; i < 4; i++) await tick();
      expect(handler).not.toHaveBeenCalled();
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'cancelled', message: 'Cancelled' } },
      ]);
    });

    test('a generation is fenced as soon as it ends: exit without close, or a fault', async () => {
      for (const end of [
        (core) => core.exit(1, null, { close: false }),
        (core) => core.reply({ type: 'bogus' }),
      ]) {
        let signal;
        let finish;
        const { core, send, replies } = await served((client) =>
          client.handle('shell.rpc', (_params, context) => {
            signal = context.signal;
            return new Promise((resolve) => {
              finish = resolve;
            });
          })
        );
        send({ id: 1, method: 'shell.rpc', params: {} });
        await tick();
        end(core);
        await tick();
        expect(signal.aborted).toBe(true);
        finish({ status: 200 });
        for (let i = 0; i < 3; i++) await tick();
        expect(replies()).toEqual([]);
      }
    });

    test('a request whose generation ended before dispatch never runs', async () => {
      const handler = jest.fn(async () => ({}));
      const { core, replies } = await served((client) => client.handle('shell.rpc', handler));
      core.stdout.write(
        Buffer.concat([
          encodeFrame({ type: 'request', id: 1, method: 'shell.rpc', params: {} }),
          encodeFrame({ type: 'bogus' }),
        ])
      );
      for (let i = 0; i < 4; i++) await tick();
      expect(handler).not.toHaveBeenCalled();
      expect(replies()).toEqual([]);
    });

    test("pending replies hold their place, and never take requests' room", async () => {
      const { client, core, send } = await served((client) =>
        client.handle('shell.rpc', async () => ({ body: 'x'.repeat(80 * 1024) }))
      );
      // stdin accepts the replies but never finishes writing them.
      core.stuck = true;
      for (let id = 1; id <= MAX_INCOMING; id++) send({ id, method: 'shell.rpc', params: {} });
      for (let i = 0; i < 6; i++) await tick();
      // 20 MiB of replies waiting: a vault request is still admitted.
      // (The stalled pipe buffers it, so it simply stays pending.)
      const lock = client.request('vault.lock').catch((e) => e);
      expect(await Promise.race([lock, tick().then(() => 'pending')])).toBe('pending');
      // Their entries are held until written: one more request is a fault.
      send({ id: MAX_INCOMING + 1, method: 'shell.rpc', params: {} });
      await tick();
      expect(core.killed).toBe('SIGKILL');
    });

    test('codes outside the fixed set, supplied text and unrepresentable results are internal', async () => {
      const { send, replies } = await served((client) => {
        client.handle('shell.gateway', async () => {
          const err = new ShellError('weird_code');
          err.message = 'https://key@rpc.example said no';
          throw err;
        });
        client.handle('shell.rpc', async () => () => {});
        client.handle('shell.tezos', async () => ({ toJSON: () => undefined }));
      });
      send({ id: 1, method: 'shell.gateway', params: {} });
      send({ id: 2, method: 'shell.rpc', params: {} });
      send({ id: 3, method: 'shell.tezos', params: {} });
      for (let i = 0; i < 6; i++) await tick();
      const internal = { code: 'internal', message: 'Internal error' };
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: internal },
        { type: 'response', id: 2, error: internal },
        { type: 'response', id: 3, error: internal },
      ]);
    });

    test('nothing comes between the dispatch check and the handler starting', async () => {
      for (const between of [
        (client, gen) => client.fence(gen),
        (client, gen) => client.onMessage(gen, { type: 'cancel', id: 1 }),
        (client) => client.stop(),
      ]) {
        const handler = jest.fn(() => new Promise(() => {}));
        const { client, replies } = await served((c) => c.handle('shell.rpc', handler));
        const gen = client.current;
        client.onMessage(gen, { type: 'request', id: 1, method: 'shell.rpc', params: {} });
        between(client, gen);
        for (let i = 0; i < 4; i++) await tick();
        expect(handler).not.toHaveBeenCalled();
        expect(replies().filter((r) => r.result)).toEqual([]);
      }
    });

    test('a cancel right after dispatch still reaches a started handler', async () => {
      const handler = jest.fn(
        (_params, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      const { client, replies } = await served((c) => c.handle('shell.rpc', handler));
      const gen = client.current;
      client.onMessage(gen, { type: 'request', id: 1, method: 'shell.rpc', params: {} });
      // Queued behind the dispatch job: the handler has started, with a live
      // signal, so it sees the abort.
      queueMicrotask(() => client.onMessage(gen, { type: 'cancel', id: 1 }));
      for (let i = 0; i < 4; i++) await tick();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'cancelled', message: 'Cancelled' } },
      ]);
    });

    test('a result that stops the client while serialized is never written', async () => {
      let stopping;
      const { client, core, send, replies } = await served((c) =>
        c.handle('shell.rpc', async () => ({
          toJSON: () => {
            stopping = c.stop();
            return { status: 200 };
          },
        }))
      );
      core.on('stdin-closed', () => core.exit(0));
      const errors = [];
      core.stdin.on('error', (err) => errors.push(err));
      send({ id: 1, method: 'shell.rpc', params: {} });
      for (let i = 0; i < 4; i++) await tick();
      await stopping;
      expect(replies()).toEqual([]);
      expect(errors).toEqual([]);
      expect(core.killCalls).toBe(0);
      expect(client.current).toBeNull();
    });

    test('a code that is not a string is internal', async () => {
      const { send, replies } = await served((client) =>
        client.handle('shell.rpc', async () => {
          throw new ShellError(['network']);
        })
      );
      send({ id: 1, method: 'shell.rpc', params: {} });
      for (let i = 0; i < 4; i++) await tick();
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'internal', message: 'Internal error' } },
      ]);
    });

    test('a result is serialized once, as it is sent', async () => {
      let calls = 0;
      const { send, replies } = await served((client) => {
        // Different by key: nothing for `result`.
        client.handle('shell.rpc', async () => ({
          toJSON: (key) => (key === '' ? { a: 1 } : undefined),
        }));
        // Different by call: its first answer is the one sent.
        client.handle('shell.tezos', async () => ({
          toJSON: () => {
            calls += 1;
            return calls === 1 ? { status: 200 } : undefined;
          },
        }));
      });
      send({ id: 1, method: 'shell.rpc', params: {} });
      send({ id: 2, method: 'shell.tezos', params: {} });
      for (let i = 0; i < 6; i++) await tick();
      expect(replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'internal', message: 'Internal error' } },
        { type: 'response', id: 2, result: { status: 200 } },
      ]);
      expect(calls).toBe(1);
    });
  });

  describe("the core's fragmented responses", () => {
    /** A ready client with two requests held: `a` and `b`. */
    async function twoHeld() {
      const made = makeClient([helloHandler()]);
      await made.client.start();
      const core = made.children[0];
      const first = made.client.request('vault.status').catch((e) => e);
      const second = made.client.request('vault.list').catch((e) => e);
      await tick();
      const [a, b] = core.requests.filter((r) => r.method?.startsWith('vault.')).map((r) => r.id);
      return { ...made, core, first, second, a, b };
    }

    test('main offers them, takes one whole, and returns the credit once its caller has it', async () => {
      const { client, core, first, a } = await twoHeld();
      expect(core.requests[0].params.frames).toEqual(['fragment']);
      const result = { big: 'x'.repeat(3 * MIB) };
      core.replyFragmented({ type: 'response', id: a, result }, 4);
      await tick();
      expect(await first).toEqual(result);
      expect(core.wire.filter((kind) => kind === KIND_CREDIT)).toHaveLength(1);
      expect(core.credits).toBe(1);
      expect(client.current.reassembler.inProgress()).toBe(false);
    });

    test('whole messages between fragments are handled at once', async () => {
      const handler = jest.fn(async () => ({}));
      const { client, core, first, second, a, b } = await twoHeld();
      client.handle('shell.rpc', handler);
      const events = [];
      client.on('event', (name) => events.push(name));
      const settled = [];
      first.then(() => settled.push('a'));
      second.then(() => settled.push('b'));
      const [begin, ...fragments] = fragmentFrames({ type: 'response', id: a, result: 'y' }, 2);
      core.stdout.write(Buffer.concat([begin, fragments[0]]));
      core.reply({ type: 'event', event: 'vault.locked', data: {} });
      core.reply({ type: 'response', id: b, result: {} });
      core.reply({ type: 'request', id: 1, method: 'shell.rpc', params: {}, context: {} });
      for (let i = 0; i < 3; i++) await tick();
      expect(events).toEqual(['vault.locked']);
      expect(settled).toEqual(['b']);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(core.credits).toBe(0);
      core.stdout.write(fragments[1]);
      await tick();
      expect(settled).toEqual(['b', 'a']);
      expect(core.credits).toBe(1);
    });

    test('with its credit back, the core may begin the next', async () => {
      const { core, first, second, a, b } = await twoHeld();
      core.replyFragmented({ type: 'response', id: a, result: 1 }, 1);
      await tick();
      core.replyFragmented({ type: 'response', id: b, result: 2 }, 3);
      expect([await first, await second]).toEqual([1, 2]);
      expect(core.credits).toBe(2);
      expect(core.killed).toBeNull();
    });

    // Each malformed sequence closes the connection, and only its fixed
    // category is logged: `a` and `b` are pending, and SENTINEL never shows.
    const SENTINEL = 'SECRET_SENTINEL';
    const response = (id, extra = { result: SENTINEL }) =>
      Buffer.from(JSON.stringify({ type: 'response', id, ...extra }));
    const begin = encodeBegin;
    const raw = rawFrame;
    test.each([
      ['begin_unknown_id', () => [begin(999, 10)]],
      ['begin_size', ({ a }) => [begin(a, MAX_MESSAGE + 1)]],
      ['begin_size', ({ a }) => [begin(a, 0)]],
      ['begin_header', ({ a }) => [raw(KIND_BEGIN, `{"id":${a},"bytes":5,"x":"${SENTINEL}"}`)]],
      ['begin_without_credit', ({ a, b }) => [begin(a, 10), begin(b, 10)]],
      ['empty_fragment', ({ a }) => [begin(a, 10), raw(KIND_FRAGMENT, '')]],
      ['empty_fragment', ({ a }) => [begin(a, 10), raw(KIND_LAST, '')]],
      ['fragment_without_begin', () => [raw(KIND_FRAGMENT, SENTINEL)]],
      ['fragment_without_begin', () => [raw(KIND_LAST, SENTINEL)]],
      ['fragment_length', ({ a }) => [begin(a, 3), raw(KIND_FRAGMENT, SENTINEL)]],
      ['fragment_length', ({ a }) => [begin(a, 30), raw(KIND_LAST, SENTINEL)]],
      ['credit_payload', () => [raw(KIND_CREDIT, SENTINEL)]],
      // This core didn't offer fragments: main holds none of its credit,
      // so none can come back.
      ['unsolicited_credit', () => [encodeCredit()]],
      // One response per request, in both orders.
      [
        'duplicate_response',
        ({ a }) => [
          begin(a, 100),
          raw(KIND_FRAGMENT, 'x'),
          encodeFrame({ type: 'response', id: a, result: SENTINEL }),
        ],
      ],
      [
        'begin_unknown_id',
        ({ a }) => [
          encodeFrame({ type: 'response', id: a, result: {} }),
          ...fragmentFrames({ type: 'response', id: a, result: SENTINEL }),
        ],
      ],
      // The reassembled message must be the response its begin named.
      [
        'fragmented_not_its_response',
        ({ a, b }) => [begin(a, response(b).length), raw(KIND_LAST, response(b))],
      ],
      [
        'fragmented_not_its_response',
        ({ a }) => {
          const request = Buffer.from(JSON.stringify({ type: 'request', id: a, method: SENTINEL }));
          return [begin(a, request.length), raw(KIND_LAST, request)];
        },
      ],
      ['invalid_json', ({ a }) => [begin(a, SENTINEL.length), raw(KIND_LAST, SENTINEL)]],
      ['invalid_utf8', ({ a }) => [begin(a, 1), raw(KIND_LAST, Buffer.from([0xff]))]],
      [
        'bad_error',
        ({ a }) => {
          const bad = response(a, { error: { code: SENTINEL, message: SENTINEL } });
          return [begin(a, bad.length), raw(KIND_LAST, bad)];
        },
      ],
      ['unknown_kind', () => [raw(0x02, SENTINEL)]],
    ])('%s closes the connection', async (category, frames) => {
      const held = await twoHeld();
      const { core, log } = held;
      core.stdout.write(Buffer.concat(frames(held)));
      await tick();
      expect(core.killed).toBe('SIGKILL');
      expect(log.error).toHaveBeenCalledWith('[Core] protocol error', { category });
      // No sequence answers `b`: it fails with the connection.
      expect((await held.second).code).toBe('core_unavailable');
      expect(core.credits).toBe(0);
      expect(JSON.stringify(log.error.mock.calls)).not.toContain(SENTINEL);
    });

    test('EOF in the middle of one discards it', async () => {
      const { client, core, first, a, log } = await twoHeld();
      const gen = client.current;
      const [begin, fragment] = fragmentFrames(
        { type: 'response', id: a, result: 'z'.repeat(MIB) },
        3
      );
      core.stdout.write(Buffer.concat([begin, fragment]));
      await tick();
      expect(gen.reassembler.inProgress()).toBe(true);
      core.stdout.end();
      await tick();
      expect(log.warn).toHaveBeenCalledWith(
        '[Core] stdout closed in the middle of a fragmented response'
      );
      expect(core.killed).toBe('SIGKILL');
      expect((await first).code).toBe('core_unavailable');
      expect(gen.reassembler.inProgress()).toBe(false);
    });

    test('one that drains after the process exited is delivered; no credit goes', async () => {
      const { core, first, a } = await twoHeld();
      core.exit(1, null, { close: false });
      core.replyFragmented({ type: 'response', id: a, result: { late: true } }, 2);
      expect(await first).toEqual({ late: true });
      expect(core.credits).toBe(0);
    });
  });

  describe("main's fragmented replies", () => {
    /** A ready client whose core offers fragments, or not, and sends it
     * requests. */
    async function served(register, { offer = true } = {}) {
      const capabilities = offer ? ['vault.status', 'fragments'] : ['vault.status'];
      const made = makeClient([
        (message, core) => {
          if (message.method !== 'core.hello') return;
          core.reply({ type: 'response', id: message.id, result: helloResult({ capabilities }) });
        },
      ]);
      register(made.client);
      await made.client.start();
      const core = made.children[0];
      const send = (message) =>
        core.reply({ type: 'request', context: { caller: 'shell' }, ...message });
      const replies = () => core.requests.filter((m) => m?.type === 'response');
      return { ...made, core, gen: made.client.current, send, replies };
    }
    const settle = async () => {
      for (let i = 0; i < 12; i++) await tick();
    };
    /** A handler answering a body of `bytes` letters. */
    const sized = (bytes) => async () => ({ body: 'x'.repeat(bytes) });
    /** The frames main wrote since the hello, by kind. */
    const wire = (core) => core.wire.slice(1);
    const W = KIND_JSON;
    const B = KIND_BEGIN;
    const F = KIND_FRAGMENT;
    const L = KIND_LAST;

    test('a reply over one frame goes as a begin and fragments, and the credit comes back', async () => {
      const { core, gen, send, replies } = await served((c) =>
        c.handle('shell.rpc', sized(3 * MIB))
      );
      send({ id: 1, method: 'shell.rpc', params: {} });
      await settle();
      expect(replies()).toEqual([
        { type: 'response', id: 1, result: { body: 'x'.repeat(3 * MIB) } },
      ]);
      // 3 MiB and its envelope: three full fragments and the rest.
      expect(wire(core)).toEqual([B, F, F, F, L]);
      expect(core.killed).toBeNull();
      expect(gen.credit).toBe(true);
      expect(gen.bulkBytes).toBe(0);
      expect(gen.incoming.size).toBe(0);
    });

    test('one that fits a frame, to a core that did not offer, or over the cap, goes whole', async () => {
      const handlers = (c) => {
        c.handle('shell.rpc', sized(MAX_PAYLOAD - 100));
        c.handle('shell.tezos', sized(MAX_MESSAGE));
      };
      const offered = await served(handlers);
      offered.send({ id: 1, method: 'shell.rpc', params: {} });
      offered.send({ id: 2, method: 'shell.tezos', params: {} });
      await settle();
      expect(offered.replies()).toEqual([
        { type: 'response', id: 1, result: { body: 'x'.repeat(MAX_PAYLOAD - 100) } },
        { type: 'response', id: 2, error: { code: 'too_large', message: 'Too large' } },
      ]);
      expect(wire(offered.core)).toEqual([W, W]);

      const refused = await served((c) => c.handle('shell.rpc', sized(2 * MIB)), { offer: false });
      refused.send({ id: 1, method: 'shell.rpc', params: {} });
      await settle();
      expect(refused.replies()).toEqual([
        { type: 'response', id: 1, error: { code: 'too_large', message: 'Too large' } },
      ]);
      expect(wire(refused.core)).toEqual([W]);
    });

    test('the next waits for the credit, while whole frames go', async () => {
      const { client, core, gen, send, replies } = await served((c) => {
        c.handle('shell.rpc', sized(2 * MIB));
        c.handle('shell.tezos', async () => ({ small: true }));
      });
      core.holdCredit = true;
      send({ id: 1, method: 'shell.rpc', params: {} });
      send({ id: 2, method: 'shell.rpc', params: {} });
      await settle();
      // 2 waits for the credit 1 spent; a reply and a request go meanwhile.
      send({ id: 3, method: 'shell.tezos', params: {} });
      await settle();
      client.request('vault.status').catch(() => {});
      await settle();
      // The core's reader refuses a begin without its credit: none came.
      expect(core.killed).toBeNull();
      expect(replies().map((r) => r.id)).toEqual([1, 3]);
      expect(wire(core)).toEqual([B, F, F, L, W, W]);
      expect(gen.bulk).toHaveLength(1);
      core.holdCredit = false;
      core.returnCredit();
      await settle();
      expect(replies().map((r) => r.id)).toEqual([1, 3, 2]);
      expect(wire(core).slice(6)).toEqual([B, F, F, L]);
      expect(core.credits).toBe(0);
      expect(gen.credit).toBe(true);
    });

    test('whole frames written meanwhile go between fragments', async () => {
      const { client, core, send, replies } = await served((c) => {
        c.handle('shell.rpc', sized(3 * MIB));
        c.handle('shell.tezos', async () => ({ small: true }));
      });
      // The pipe stalls once the begin is written...
      core.stuck = true;
      send({ id: 1, method: 'shell.rpc', params: {} });
      await settle();
      expect(wire(core)).toEqual([B]);
      // ...and a reply and a request are written meanwhile.
      send({ id: 2, method: 'shell.tezos', params: {} });
      await settle();
      client.request('vault.status').catch(() => {});
      core.release();
      await settle();
      expect(wire(core)).toEqual([B, F, W, W, F, F, L]);
      expect(replies().map((r) => r.id)).toEqual([2, 1]);
    });

    test('a cancel after begin, or while it waits for credit, changes nothing', async () => {
      const { core, send, replies } = await served((c) => c.handle('shell.rpc', sized(2 * MIB)));
      core.holdCredit = true;
      core.stuck = true;
      send({ id: 1, method: 'shell.rpc', params: {} });
      send({ id: 2, method: 'shell.rpc', params: {} });
      await settle();
      // 1 has begun, 2 waits for the credit: the core cancels both.
      core.reply({ type: 'cancel', id: 1 });
      core.reply({ type: 'cancel', id: 2 });
      core.release();
      await settle();
      core.holdCredit = false;
      core.returnCredit();
      await settle();
      const body = { body: 'x'.repeat(2 * MIB) };
      expect(replies()).toEqual([
        { type: 'response', id: 1, result: body },
        { type: 'response', id: 2, result: body },
      ]);
    });

    test('past the room for fragmented replies, a reply is busy', async () => {
      const { core, gen, send, replies } = await served((c) =>
        c.handle('shell.rpc', sized(17 * MIB))
      );
      core.stuck = true;
      send({ id: 1, method: 'shell.rpc', params: {} });
      send({ id: 2, method: 'shell.rpc', params: {} });
      await settle();
      expect(gen.bulkBytes).toBeGreaterThan(17 * MIB);
      core.release();
      await settle();
      expect(replies()).toEqual([
        { type: 'response', id: 2, error: { code: 'busy', message: 'Busy' } },
        { type: 'response', id: 1, result: { body: 'x'.repeat(17 * MIB) } },
      ]);
      expect(gen.bulkBytes).toBe(0);
    });

    test('a generation that ends writes no more of a begun reply, and drops the waiting ones', async () => {
      const { core, gen, send, replies } = await served((c) =>
        c.handle('shell.rpc', sized(2 * MIB))
      );
      core.holdCredit = true;
      core.stuck = true;
      send({ id: 1, method: 'shell.rpc', params: {} });
      send({ id: 2, method: 'shell.rpc', params: {} });
      await settle();
      core.exit(1, null, { close: false });
      expect(gen.sending).toBeNull();
      expect(gen.bulk).toEqual([]);
      core.release();
      await settle();
      expect(wire(core)).toEqual([B, F]);
      expect(replies()).toEqual([]);
      expect(gen.bulkBytes).toBe(0);
    });

    test('a credit main already holds is a protocol fault', async () => {
      const { core, log } = await served(() => {});
      core.stdout.write(encodeCredit());
      await tick();
      expect(core.killed).toBe('SIGKILL');
      expect(log.error).toHaveBeenCalledWith('[Core] protocol error', {
        category: 'unsolicited_credit',
      });
    });
  });
});
