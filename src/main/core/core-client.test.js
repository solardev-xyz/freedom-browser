const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const {
  CoreClient,
  CoreError,
  scrubbedEnv,
  RESTART_DELAYS_MS,
  MAX_PENDING,
} = require('./core-client');
const { encodeFrame, FrameDecoder } = require('./frame');

const tick = () => new Promise(setImmediate);

/**
 * A fake freedom-cored child that answers through a handler. Like Node's
 * ChildProcess it emits 'exit' and then 'close'; `exit(…, { close: false })`
 * holds 'close' back (stdout still open after the process is gone).
 */
class FakeCore extends EventEmitter {
  constructor(handler, options = {}) {
    super();
    this.pid = 'pid' in options ? options.pid : 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = null;
    this.exitOnKill = options.exitOnKill ?? true;
    this.stuck = false; // stdin accepts bytes but never completes writes
    this.requests = [];
    const decoder = new FrameDecoder();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const message of decoder.push(chunk)) {
          this.requests.push(message);
          handler(message, this);
        }
        if (!this.stuck) callback();
      },
      final: (callback) => {
        this.emit('stdin-closed');
        callback();
      },
    });
  }

  reply(message) {
    this.stdout.write(encodeFrame(message));
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
    expect(hello).toEqual(helloResult());
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
    ];
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
});
