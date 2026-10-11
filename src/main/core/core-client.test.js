const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { CoreClient, CoreError, scrubbedEnv, RESTART_DELAYS_MS } = require('./core-client');
const { encodeFrame, FrameDecoder } = require('./frame');

/** A fake freedom-cored child that answers through a handler. */
class FakeCore extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = null;
    const decoder = new FrameDecoder();
    this.requests = [];
    this.stdin.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        this.requests.push(message);
        handler(message, this);
      }
    });
    this.stdin.on('finish', () => this.emit('stdin-closed'));
  }

  reply(message) {
    this.stdout.write(encodeFrame(message));
  }

  exit(code, signal = null) {
    this.emit('exit', code, signal);
  }

  kill(signal) {
    this.killed = signal;
    setImmediate(() => this.exit(null, signal));
  }
}

const quietLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function helloHandler(extra = () => {}) {
  return (message, core) => {
    if (message.method === 'core.hello') {
      core.reply({
        type: 'response',
        id: message.id,
        result: { protocol: 1, core_version: '0.0.0', capabilities: [] },
      });
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
    const child = new FakeCore(handler);
    children.push(child);
    return child;
  });
  const timers = [];
  const client = new CoreClient({
    spawn,
    command: '/bin/freedom-cored',
    args: ['serve'],
    log: quietLog,
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
  return { client, spawn, children, runTimers, timers };
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
    expect(hello.protocol).toBe(1);
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
    const { client, children, runTimers } = makeClient([helloHandler(), helloHandler()]);
    await client.start();
    const pending = client.request('vault.status').catch((e) => e);
    await new Promise(setImmediate);
    children[0].exit(1);
    const error = await pending;
    expect(error.code).toBe('core_unavailable');
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test('a late reply from a retired child is ignored', async () => {
    const { client, children, runTimers } = makeClient([helloHandler(), helloHandler()]);
    await client.start();
    children[0].exit(1);
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    // The old child's stdout still delivers a reply: no effect, no kill.
    children[0].reply({ type: 'response', id: 1, result: {} });
    await new Promise(setImmediate);
    expect(children[1].killed).toBeNull();
  });

  test('exit codes that mean "do not retry" fail without restarting', async () => {
    for (const code of [64, 74, 75, 76]) {
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

  test('three crashes within a minute give up', async () => {
    const { client, children, runTimers } = makeClient([helloHandler()], { now: () => 1000 });
    await client.start();
    children[0].exit(1);
    runTimers(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    children[1].exit(1);
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
    await new Promise(setImmediate);
    expect(children[0].killed).toBe('SIGKILL');

    const second = makeClient([helloHandler()]);
    await second.client.start();
    second.children[0].reply({ type: 'response', id: 1, result: {}, error: { code: 'busy' } });
    await new Promise(setImmediate);
    expect(second.children[0].killed).toBe('SIGKILL');
  });

  test('a missing hello reply times out', async () => {
    const { client, children, runTimers } = makeClient([() => {}]);
    const started = client.start().catch((e) => e);
    runTimers(10_000);
    await new Promise(setImmediate);
    expect(children[0].killed).toBe('SIGKILL');
    client.stop();
    expect(await Promise.race([started, Promise.resolve('pending')])).toBe('pending');
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
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const child = new FakeCore(helloHandler());
    const client = new CoreClient({ spawn: () => child, command: 'x', args: [], log });
    await client.start();
    child.stderr.write('{"level":"warn","msg":"stdin closed","id":4}\nplain text\n');
    await new Promise(setImmediate);
    expect(log.warn).toHaveBeenCalledWith('[Core] stdin closed', { id: 4 });
    expect(log.info).toHaveBeenCalledWith('[Core]', 'plain text');
  });
});
