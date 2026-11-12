/**
 * The shared client on its own, configured for a service that isn't the
 * core: its handshake, shutdown, texts and log label are the service's,
 * and nothing of the core's leaks in. Everything else is CoreClient's,
 * which core-client.test.js covers whole.
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { ServiceClient, CoreError, scrubbedEnv } = require('./service-client');
const { encodeFrame, FrameDecoder, KIND_JSON } = require('./frame');

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A child that answers whole JSON messages with `handler`. */
class FakeService extends EventEmitter {
  constructor(handler) {
    super();
    this.pid = 4343;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    const decoder = new FrameDecoder();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== KIND_JSON) continue;
          this.requests.push(frame.message);
          handler(frame.message, this);
        }
        callback();
      },
      final: (callback) => {
        setImmediate(() => this.exit(0));
        callback();
      },
    });
  }

  reply(message) {
    this.stdout.write(encodeFrame(message));
  }

  exit(code) {
    this.emit('exit', code, null);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, null);
    });
  }

  kill() {
    setImmediate(() => this.exit(null));
    return true;
  }
}

const TEST_SERVICE = Object.freeze({
  label: '[Test]',
  noun: 'test service',
  unavailableCode: 'service_unavailable',
  protocol: 3,
  helloMethod: 'test.hello',
  helloParams: (client) => ({ protocol: 3, shell_version: client.shellVersion }),
  validHello: (result) =>
    result?.protocol === 3 ? { protocol: 3, capabilities: result.capabilities ?? [] } : null,
  shutdownMethod: 'test.shutdown',
  fragments: () => false,
});

function makeClient(handler) {
  const children = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new ServiceClient({
    service: TEST_SERVICE,
    spawn: jest.fn(() => {
      const child = new FakeService(handler);
      children.push(child);
      return child;
    }),
    command: '/bin/test-service',
    args: ['serve'],
    log,
    shellVersion: '9.9.9',
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  return { client, children, log };
}

const answering =
  (protocol = 3) =>
  (message, child) => {
    if (message.type !== 'request') return;
    if (message.method === 'test.hello') {
      child.reply({ type: 'response', id: message.id, result: { protocol } });
    } else if (message.method === 'test.echo') {
      child.reply({ type: 'response', id: message.id, result: message.params });
    } else if (message.method === 'test.shutdown') {
      child.reply({ type: 'response', id: message.id, result: {} });
    }
  };

describe('ServiceClient for a service other than the core', () => {
  test("handshakes with the service's hello, and serves its requests", async () => {
    const { client, children } = makeClient(answering());
    await expect(client.start()).resolves.toEqual({ protocol: 3, capabilities: [] });
    expect(children[0].requests[0]).toMatchObject({
      type: 'request',
      method: 'test.hello',
      params: { protocol: 3, shell_version: '9.9.9' },
      context: { caller: 'shell' },
    });
    await expect(client.request('test.echo', { a: 1 })).resolves.toEqual({ a: 1 });
    await client.stop();
    expect(children[0].requests.map((m) => m.method)).toContain('test.shutdown');
    expect(children[0].requests.map((m) => m.method)).not.toContain('core.shutdown');
  });

  test("its unavailability is the service's code and text", async () => {
    const { client } = makeClient(answering());
    const err = await client.request('test.echo', {}).catch((e) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect(err.code).toBe('service_unavailable');
    expect(err.message).toBe('The test service is not running');
  });

  test('its logs carry its label', async () => {
    const { client, log } = makeClient(answering(4));
    await expect(client.start()).rejects.toThrow('protocol mismatch');
    expect(log.error).toHaveBeenCalledWith('[Test] protocol mismatch');
    for (const call of [...log.error.mock.calls, ...log.warn.mock.calls, ...log.info.mock.calls]) {
      expect(String(call[0])).not.toMatch(/\[Core\]|core\.hello/);
    }
    await tick();
  });
});

/** A client whose timers are recorded and run by hand, with `extra`
 * options. */
function timedClient(service, handler, now = () => 0, extra = {}) {
  const children = [];
  const timers = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new ServiceClient({
    service,
    spawn: jest.fn(() => {
      const child = new FakeService(handler);
      children.push(child);
      return child;
    }),
    command: '/bin/test-service',
    args: ['serve'],
    log,
    now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    ...extra,
  });
  return { client, children, timers, log };
}

describe('what a service configures, and what it shares', () => {
  test("the kill after a stop waits the service's grace, 3 s by default", async () => {
    for (const [service, grace] of [
      [TEST_SERVICE, 3_000],
      [{ ...TEST_SERVICE, shutdownGraceMs: 5_000 }, 5_000],
    ]) {
      // A service that never exits on its own.
      const { client, timers } = timedClient(service, (message, child) => {
        if (message.method === 'test.hello') {
          child.reply({ type: 'response', id: message.id, result: { protocol: 3 } });
        }
      });
      await client.start();
      const armed = timers.length;
      const stopped = client.stop();
      const kill = timers.slice(armed).find((timer) => !timer.cleared);
      expect(kill.ms).toBe(grace);
      kill.fn();
      await stopped;
    }
  });

  test('a crash counts toward the back-off: 0.5 s, 2 s, then none for the third within 60 s', () => {
    let now = 0;
    const { client } = timedClient(TEST_SERVICE, answering(), () => now);
    expect(client.recordCrash()).toBe(500);
    now = 1_000;
    expect(client.recordCrash()).toBe(2_000);
    now = 59_999;
    expect(client.recordCrash()).toBeNull();

    // The window slides: one crash a minute is never three.
    const { client: steady } = timedClient(TEST_SERVICE, answering(), () => now);
    for (let i = 0; i < 5; i++) {
      now = i * 60_000;
      expect(steady.recordCrash()).toBe(500);
    }
  });

  // freedom-ipfsd's ephemeral process comes back only when a private window
  // needs it (design 0007, "Private windows"): its owner stops the client
  // from within the crash's 'exit', which no restart outlives, and starts it
  // again on demand.
  test("a stop from within a crash's exit: no restart, and start() runs it again", async () => {
    const { client, children, timers } = timedClient(TEST_SERVICE, answering());
    await client.start();
    client.on('exit', () => client.stop());
    children[0].exit(1);
    await tick();
    await tick();
    expect(client.state).toBe('stopped');
    expect(timers.filter((timer) => !timer.cleared && timer.ms === 500)).toHaveLength(0);
    expect(children).toHaveLength(1);

    await expect(client.start()).resolves.toEqual({ protocol: 3, capabilities: [] });
    expect(children).toHaveLength(2);
    client.removeAllListeners('exit');
    await client.stop();
  });

  test('a service that closes stdout as it stops is no connection failure', async () => {
    const { client, log } = timedClient(TEST_SERVICE, (message, child) => {
      if (message.method === 'test.hello') {
        child.reply({ type: 'response', id: message.id, result: { protocol: 3 } });
      } else if (message.method === 'test.shutdown') {
        // Its output closes before its exit is seen.
        child.stdout.end();
        setImmediate(() => child.exit(0));
      }
    });
    await client.start();
    await client.stop();
    expect(log.error).not.toHaveBeenCalledWith('[Test] connection failed', expect.anything());
  });
});

describe("the process's environment", () => {
  test('the scrubbed one by default; a client may give its own, asked at each spawn', async () => {
    const { client } = timedClient(TEST_SERVICE, answering());
    await client.start();
    expect(client.spawnFn.mock.calls[0][2].env).toEqual(scrubbedEnv());
    await client.stop();

    let spawns = 0;
    const env = jest.fn(() => ({ HOME: `/own/${++spawns}` }));
    const {
      client: own,
      children,
      timers,
    } = timedClient(TEST_SERVICE, answering(), () => 0, { env });
    await own.start();
    children[0].exit(1);
    await tick();
    await tick();
    timers.find((t) => !t.cleared && t.ms === 500).fn();
    await own.whenReady();
    expect(env).toHaveBeenCalledTimes(2);
    expect(own.spawnFn.mock.calls.map((call) => call[2].env)).toEqual([
      { HOME: '/own/1' },
      { HOME: '/own/2' },
    ]);
    await own.stop();
  });

  test('an environment that throws fails that spawn, as a spawn error', async () => {
    const env = () => {
      throw new Error('no directory');
    };
    const { client, timers, log } = timedClient(TEST_SERVICE, answering(), () => 0, { env });
    const exited = new Promise((resolve) => client.once('exit', resolve));
    client.start().catch(() => {});
    await expect(exited).resolves.toMatchObject({ cause: 'spawn' });
    expect(log.error).toHaveBeenCalledWith('[Test] spawn failed');
    // The crash rules apply: a restart is due.
    expect(timers.filter((t) => !t.cleared && t.ms === 500)).toHaveLength(1);
    await client.stop();
  });
});

describe('a deferred spawn (deferSpawn)', () => {
  test('waits with nothing spawned, failing nothing, then spawns once the wait ends', async () => {
    let open = false;
    let release;
    const deferSpawn = jest.fn(() =>
      open
        ? null
        : new Promise((resolve) => {
            release = resolve;
          })
    );
    const { client, children } = timedClient(TEST_SERVICE, answering(), () => 0, {
      deferSpawn,
    });
    const failed = jest.fn();
    client.on('failed', failed);
    const started = client.start();
    await tick();
    expect(children).toHaveLength(0);
    expect(client.state).toBe('starting');
    expect(client.spawnDeferred).toBe(true);
    // Another start joins the wait.
    const again = client.start();
    expect(deferSpawn).toHaveBeenCalledTimes(1);

    open = true;
    release();
    await expect(started).resolves.toEqual({ protocol: 3, capabilities: [] });
    await expect(again).resolves.toEqual({ protocol: 3, capabilities: [] });
    // Asked again once its wait ended.
    expect(deferSpawn).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(1);
    expect(client.spawnDeferred).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(client.crashTimes).toEqual([]);
    await client.stop();
  });

  test("a crash's restart waits too, as long as it takes, and the wait is no crash", async () => {
    let locked = false;
    let release;
    let now = 0;
    const deferSpawn = () =>
      locked
        ? new Promise((resolve) => {
            release = resolve;
          })
        : null;
    const { client, children, timers } = timedClient(TEST_SERVICE, answering(), () => now, {
      deferSpawn,
    });
    await client.start();
    locked = true;
    children[0].exit(1);
    await tick();
    await tick();
    timers.find((t) => !t.cleared && t.ms === 500).fn();
    expect(children).toHaveLength(1);
    expect(client.spawnDeferred).toBe(true);
    expect(client.state).toBe('starting');
    expect(client.crashTimes).toHaveLength(1);
    // Waiting past the crash window counts nothing, and fails nothing.
    now = 10 * 60_000;
    locked = false;
    release();
    await client.whenReady();
    expect(children).toHaveLength(2);
    expect(client.crashTimes).toHaveLength(1);
    expect(client.state).toBe('ready');
    await client.stop();
  });

  test('a stop ends the wait: nothing is spawned when it settles, and start() runs it again', async () => {
    let release;
    const deferSpawn = jest.fn(() =>
      deferSpawn.mock.calls.length === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : null
    );
    const { client, children } = timedClient(TEST_SERVICE, answering(), () => 0, {
      deferSpawn,
    });
    const started = client.start().catch((e) => e);
    await tick();
    await client.stop();
    expect(client.state).toBe('stopped');
    expect(client.spawnDeferred).toBe(false);
    expect(await started).toMatchObject({ code: 'service_unavailable' });
    release();
    await tick();
    await tick();
    expect(children).toHaveLength(0);
    expect(client.state).toBe('stopped');

    await expect(client.start()).resolves.toEqual({ protocol: 3, capabilities: [] });
    expect(children).toHaveLength(1);
    await client.stop();
  });

  test('a wait that rejects, or a deferral that throws, fails the client', async () => {
    for (const [deferSpawn, reason] of [
      [() => Promise.reject(new Error('gone')), 'spawn wait failed'],
      [
        () => {
          throw new Error('broken');
        },
        'spawn deferral failed',
      ],
    ]) {
      const { client, children } = timedClient(TEST_SERVICE, answering(), () => 0, {
        deferSpawn,
      });
      const failed = new Promise((resolve) => client.once('failed', resolve));
      const started = client.start().catch((e) => e);
      await expect(failed).resolves.toBe(reason);
      expect(await started).toMatchObject({ code: 'service_unavailable' });
      expect(children).toHaveLength(0);
      expect(client.state).toBe('failed');
    }
  });

  test('beforeSpawn is still the last word, after the wait', async () => {
    const order = [];
    let release;
    const deferSpawn = () => {
      order.push('defer');
      return order.length === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : null;
    };
    const beforeSpawn = () => {
      order.push('check');
      return 'the grant is refused';
    };
    const { client, children } = timedClient(TEST_SERVICE, answering(), () => 0, {
      deferSpawn,
      beforeSpawn,
    });
    const failed = new Promise((resolve) => client.once('failed', resolve));
    client.start().catch(() => {});
    await tick();
    expect(order).toEqual(['defer']);
    release();
    await expect(failed).resolves.toBe('spawn refused');
    expect(order).toEqual(['defer', 'defer', 'check']);
    expect(children).toHaveLength(0);
  });
});

// freedom-core design 0008, Errors: a start step the service answers with
// an error ends the process, which exits 0; main has read the error.
describe("exit 0 after a start step's error (endsOnError)", () => {
  /** A service whose `test.step` is answered with `reply(message, child)`. */
  const stepping = (reply) => (message, child) => {
    if (message.method === 'test.step') reply(message, child);
    else answering()(message, child);
  };
  const refuse = (message, child) =>
    child.reply({
      type: 'response',
      id: message.id,
      error: { code: 'start_failed', message: 'it did not start' },
    });
  const step = (client, options = { endsOnError: true }) =>
    client.requestTo(client.current, 'test.step', {}, { caller: 'shell' }, options);

  test('main closes stdin and arms the kill; the exit 0 fails the client, with no restart', async () => {
    const { client, children, timers } = timedClient(TEST_SERVICE, stepping(refuse));
    await client.start();
    const gen = client.current;
    const failed = new Promise((resolve) => client.once('failed', resolve));
    const exits = [];
    client.on('exit', (exit) => exits.push(exit));
    await expect(step(client)).rejects.toMatchObject({
      code: 'start_failed',
      message: 'it did not start',
    });
    // The generation is ending: nothing more goes to it.
    expect(gen.ending).toBe(true);
    expect(client.serves(gen)).toBe(false);
    expect(timers.some((t) => t.ms === 3_000)).toBe(true);
    // The fake exits 0 once its stdin closes.
    await expect(failed).resolves.toBe('start step failed');
    expect(exits).toEqual([{ code: 0, signal: null, cause: 'start_failed' }]);
    expect(timers.filter((t) => !t.cleared && t.ms === 500)).toHaveLength(0);
    expect(children).toHaveLength(1);
    // A start from there spawns a fresh process.
    await expect(client.start()).resolves.toEqual({ protocol: 3, capabilities: [] });
    expect(children).toHaveLength(2);
    await client.stop();
  });

  test('the error read from what stdout still held after the exit counts too', async () => {
    const { client, children } = timedClient(
      TEST_SERVICE,
      stepping((message, child) => {
        child.emit('exit', 0, null);
        refuse(message, child);
        setImmediate(() => {
          child.stdout.end();
          child.emit('close', 0, null);
        });
      })
    );
    await client.start();
    const failed = new Promise((resolve) => client.once('failed', resolve));
    const exits = [];
    client.on('exit', (exit) => exits.push(exit));
    await expect(step(client)).rejects.toMatchObject({ code: 'start_failed' });
    await expect(failed).resolves.toBe('start step failed');
    expect(exits).toEqual([{ code: 0, signal: null, cause: 'start_failed' }]);
    expect(children).toHaveLength(1);
  });

  test('exit 0 is a crash otherwise: after a step that succeeded, or an error not marked', async () => {
    for (const [reply, options] of [
      [
        (message, child) => child.reply({ type: 'response', id: message.id, result: {} }),
        undefined,
      ],
      [refuse, {}],
    ]) {
      const { client, children, timers } = timedClient(TEST_SERVICE, stepping(reply));
      await client.start();
      await step(client, options).catch(() => {});
      children[0].exit(0);
      await tick();
      await tick();
      expect(client.state).toBe('starting');
      expect(timers.filter((t) => !t.cleared && t.ms === 500)).toHaveLength(1);
      await client.stop();
    }
  });

  test("another end after a step's error is judged as usual: exit 70 is a crash", async () => {
    const { client, timers } = timedClient(
      TEST_SERVICE,
      stepping((message, child) => {
        refuse(message, child);
        child.exit(70);
      })
    );
    await client.start();
    const exits = [];
    client.on('exit', (exit) => exits.push(exit));
    await expect(step(client)).rejects.toMatchObject({ code: 'start_failed' });
    await tick();
    await tick();
    expect(exits).toMatchObject([{ code: 70 }]);
    expect(client.state).toBe('starting');
    expect(timers.filter((t) => !t.cleared && t.ms === 500)).toHaveLength(1);
    await client.stop();
  });
});
