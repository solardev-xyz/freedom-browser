/**
 * vault-backend's requests under their hang watchdogs (freedom-core design
 * 0001, "Deadlines, cancellation and commit"), through the real CoreClient
 * and a fake freedom-cored child, on Jest's fake clock: 45 s on the vault
 * queue, 15 s for an immediate method. A watchdog that fires kills the core,
 * which fails the request `core_unavailable`; the core is restarted, a lost
 * mutation is reconciled, and the mutation queue moves on.
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const { CoreClient, RESTART_DELAYS_MS } = require('./core-client');
const { encodeFrame, FrameDecoder, KIND_JSON } = require('./frame');

const FP = 'a'.repeat(64);
const FP_AFTER = 'b'.repeat(64);
const MNEMONIC = 'abandon about';
const ticks = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await new Promise(setImmediate);
};

/**
 * A freedom-cored child that answers `core.hello` and `core.shutdown`, and
 * everything else through `handler(message)`: a result to reply with, or
 * `undefined` to hold the request unanswered. SIGKILL exits it.
 */
class FakeChild extends EventEmitter {
  constructor(handler) {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = null;
    this.requests = [];
    const decoder = new FrameDecoder();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== KIND_JSON || frame.message.type !== 'request') continue;
          this.onRequest(frame.message, handler);
        }
        callback();
      },
      final: (callback) => {
        setImmediate(() => this.exit(0, null));
        callback();
      },
    });
  }

  onRequest(message, handler) {
    this.requests.push(message);
    let result;
    if (message.method === 'core.hello') {
      result = { protocol: 1, core_version: '0.1.0', capabilities: [] };
    } else if (message.method === 'core.shutdown') {
      result = {};
    } else {
      result = handler(message);
    }
    if (result !== undefined) this.answer(message.id, result);
  }

  answer(id, result) {
    this.stdout.write(encodeFrame({ type: 'response', id, result }));
  }

  methods() {
    return this.requests.map((m) => m.method);
  }

  held(method) {
    return this.requests.find((m) => m.method === method);
  }

  kill(signal) {
    this.killed = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  exit(code, signal) {
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, signal);
    });
  }
}

/** A CoreClient whose nth process answers with handlers[n] (the last one
 * after that), and the vault backend on it. */
async function setup(handlers) {
  const children = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const client = new CoreClient({
    spawn: jest.fn(() => {
      const child = new FakeChild(handlers[Math.min(children.length, handlers.length - 1)]);
      children.push(child);
      return child;
    }),
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
  });
  jest.resetModules();
  jest.doMock('./core-process', () => ({ getCoreClient: () => client }));
  const mod = require('./vault-backend');
  mod._internal.reset();
  await client.start();
  return { client, children, log, ...mod };
}

/** Moves the fake clock on by `ms`, then lets the pipes and the exits run. */
async function advance(ms) {
  jest.advanceTimersByTime(ms);
  await ticks();
}

describe('vault-backend hang watchdogs', () => {
  let made = null;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });

  afterEach(async () => {
    const stopped = made?.client.stop();
    await ticks();
    jest.advanceTimersByTime(3_000);
    await stopped;
    made = null;
    jest.useRealTimers();
  });

  test('a held vault.unlock fails core_unavailable at 45 s, and the core restarts', async () => {
    made = await setup([() => undefined, () => ({ addresses: { user_wallet: '0x1' } })]);
    const { client, children, log, vaultBackend, VaultBackendError } = made;
    const unlocking = vaultBackend.unlock('password1').catch((e) => e);
    await ticks();
    expect(children[0].held('vault.unlock')).toBeDefined();

    await advance(45_000 - 1);
    expect(children[0].killed).toBeNull();
    await advance(1);
    expect(children[0].killed).toBe('SIGKILL');
    const err = await unlocking;
    expect(err).toBeInstanceOf(VaultBackendError);
    expect(err.code).toBe('core_unavailable');
    expect(log.error).toHaveBeenCalledWith('[Core] request hung; restarting the core', {
      method: 'vault.unlock',
    });

    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
    await expect(vaultBackend.unlock('password1')).resolves.toEqual({
      addresses: { user_wallet: '0x1' },
    });
  });

  test('a held immediate request fails at 15 s', async () => {
    made = await setup([() => undefined, () => ({ exists: true, fingerprint: FP })]);
    const { client, children, vaultBackend } = made;
    const signing = vaultBackend.sign
      .message({ kind: 'account', index: 0 }, Buffer.from('x'))
      .catch((e) => e);
    const status = vaultBackend.status().catch((e) => e);
    await ticks();
    expect(children[0].methods()).toEqual(['core.hello', 'sign.message', 'vault.status']);

    await advance(15_000 - 1);
    expect(children[0].killed).toBeNull();
    await advance(1);
    expect(children[0].killed).toBe('SIGKILL');
    expect(await signing).toMatchObject({ code: 'core_unavailable' });
    expect(await status).toMatchObject({ code: 'core_unavailable' });

    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    await expect(vaultBackend.status()).resolves.toEqual({ exists: true, fingerprint: FP });
  });

  test('requests answered in time are unaffected', async () => {
    made = await setup([
      (m) => {
        if (m.method === 'vault.status') return { exists: true, fingerprint: FP };
        if (m.method === 'vault.unlock') return undefined; // answered by the test
        return {};
      },
    ]);
    const { children, log, vaultBackend } = made;
    await expect(vaultBackend.status()).resolves.toEqual({ exists: true, fingerprint: FP });
    const unlocking = vaultBackend.unlock('password1');
    await ticks();
    // A slow KDF: answered a moment before the watchdog.
    await advance(45_000 - 1);
    children[0].answer(children[0].held('vault.unlock').id, { addresses: {} });
    await expect(unlocking).resolves.toEqual({ addresses: {} });
    await vaultBackend.lock();

    await advance(10 * 60_000);
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  test('the mutation queue moves on after a watchdog: reconciled, then the next one', async () => {
    made = await setup([
      (m) => (m.method === 'vault.status' ? { exists: true, fingerprint: FP } : undefined),
      (m) => {
        if (m.method === 'vault.status') return { exists: true, fingerprint: FP_AFTER };
        if (m.method === 'vault.reconcile') {
          return { status: 'committed', addresses: { user_wallet: '0x2' } };
        }
        return {};
      },
    ]);
    const { client, children, vaultBackend, _internal } = made;
    const importing = vaultBackend.importVault('password1', MNEMONIC, { overwrite: true });
    const changing = vaultBackend.changePassword('password1', 'password2');
    await ticks();
    expect(children[0].methods()).toEqual(['core.hello', 'vault.status', 'vault.import']);

    await advance(45_000);
    expect(children[0].killed).toBe('SIGKILL');
    // The restarted core reconciles the import: it committed.
    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    await expect(importing).resolves.toEqual({ addresses: { user_wallet: '0x2' } });
    await expect(changing).resolves.toBeUndefined();
    expect(children[1].methods()).toEqual([
      'core.hello',
      'vault.reconcile',
      'vault.status',
      'vault.change_password',
    ]);
    expect(children[1].held('vault.reconcile').params).toMatchObject({
      op: 'import',
      fingerprint_before: FP,
      install: true,
    });
    expect(_internal.hasPending()).toBe(false);
  });

  test('a reconcile that hangs too is bounded: kept pending, and settled first next time', async () => {
    made = await setup([
      (m) => (m.method === 'vault.status' ? { exists: true, fingerprint: FP } : undefined),
      () => undefined,
      (m) => {
        if (m.method === 'vault.status') return { exists: true, fingerprint: FP_AFTER };
        if (m.method === 'vault.reconcile') return { status: 'not_committed' };
        return {};
      },
    ]);
    const { client, children, vaultBackend, _internal } = made;
    const deleting = vaultBackend.deleteVault('password1').catch((e) => e);
    const changing = vaultBackend.changePassword('password1', 'password2');
    await ticks();

    await advance(45_000);
    await advance(RESTART_DELAYS_MS[0]);
    expect(children[1].methods()).toEqual(['core.hello', 'vault.reconcile']);
    await advance(45_000);
    expect(children[1].killed).toBe('SIGKILL');
    expect(await deleting).toMatchObject({ code: 'core_unavailable' });
    expect(_internal.hasPending()).toBe(true);

    // The third core settles the delete (not committed), then the change runs.
    await advance(RESTART_DELAYS_MS[1]);
    await client.whenReady();
    await expect(changing).resolves.toBeUndefined();
    expect(children[2].methods()).toEqual([
      'core.hello',
      'vault.reconcile',
      'vault.status',
      'vault.change_password',
    ]);
    expect(_internal.hasPending()).toBe(false);
  });
});
