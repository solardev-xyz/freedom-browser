/**
 * The shared client on its own, configured for a service that isn't the
 * core: its handshake, shutdown, texts and log label are the service's,
 * and nothing of the core's leaks in. Everything else is CoreClient's,
 * which core-client.test.js covers whole.
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { ServiceClient, CoreError } = require('./service-client');
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

describe('what a service configures, and what it shares', () => {
  /** A client whose timers are recorded and run by hand. */
  function timedClient(service, handler, now = () => 0) {
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
    });
    return { client, children, timers, log };
  }

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
