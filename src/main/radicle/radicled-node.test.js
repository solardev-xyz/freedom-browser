/**
 * The Radicle node on freedom-radicled (freedom-core design 0008, step 6),
 * against an in-process fake service (`test/helpers/fake-radicled.js`), a
 * fake core (its vault's state and events, the seal and the switch) and a
 * manual clock: the start's order, the sealed key and the throwaway one,
 * the unlock wait (at the start and for a crash's restart), the lock
 * boundary, the switch, the other start steps' errors and the Retry,
 * readiness, the restarts, the stop, the network policy and its changes
 * (plan B18), and what main's log never holds. The
 * process's supervision is radicled-client.js's (radicled-client.test.js);
 * the real binaries run in radicled-node.integration.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('electron', () => ({ app: { isPackaged: false } }), { virtual: true });
jest.mock('../service-grant', () => ({ radicleGrantRefusal: jest.fn(() => null) }));

const {
  RadicledNode,
  CRASHED,
  CONFINEMENT_REFUSED,
  GRANT_REFUSED,
  KEY_FILE_AGAIN,
  KEY_UNAVAILABLE,
  LOCK_HELD,
  REPAIRING,
  HEALTH_INTERVAL_MS,
  STATS_FRESH_MS,
} = require('./radicled-node');
const { SHUTDOWN_GRACE_MS, STATS_WATCHDOG_MS } = require('./radicled-client');
const { confinementLog } = require('../ipfs/ipfsd-client');
const { radicleGrantRefusal } = require('../service-grant');
const {
  fakeRadicled,
  statsResult,
  CONFINEMENT,
  HELLO,
  RECIPIENT,
  DID,
  NID,
} = require('../../../test/helpers/fake-radicled');
const { fakeTorEndpoint } = require('../../../test/helpers/fake-tor-endpoint');
const { RadicleNetwork } = require('./radicle-network');

const HOME = path.join('app-data', 'Freedom', 'R', '1');
const LOCK_DIR = path.join('app-data', 'Freedom', 'locks');
// What the core's seal answers: HPKE's encapsulated key and the sealed key
// with its tag, base64 (0008, "The sealed release").
const SEALED = Object.freeze({
  enc: Buffer.alloc(32, 0xa5).toString('base64'),
  ciphertext: Buffer.alloc(48, 0x5a).toString('base64'),
});

/** Timers that run only when the test advances the clock. */
function manualClock() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timers.delete(timer);
    },
    /** Runs every timer due within `ms`, in order, letting I/O settle between. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due);
        now = due.at;
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** Lets the pipes and promises run. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The core as the node sees it: the vault's state, its events, the seal and
 * the switch. `lock()` and `unlock()` change the state and send the event.
 */
function fakeKeys({ exists = true, unlocked = true } = {}) {
  const listeners = new Set();
  const keys = {
    vault: { exists, unlocked },
    listeners,
    status: jest.fn(async () => ({ exists: keys.vault.exists, unlocked: keys.vault.unlocked })),
    seal: jest.fn(async () => {
      if (!keys.vault.exists) throw coded('no_vault', 'No vault exists');
      if (!keys.vault.unlocked) throw coded('vault_locked', 'Vault is locked');
      return { ...SEALED };
    }),
    switchHome: jest.fn(async () => ({ status: 'installed' })),
    onVaultEvent: jest.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(name, data = {}) {
      for (const listener of [...listeners]) listener(name, data);
    },
    lock() {
      keys.vault.unlocked = false;
      keys.emit('vault.locked', { reason: 'manual' });
    },
    unlock() {
      keys.vault.unlocked = true;
      keys.emit('vault.unlocked', { epoch: 2 });
    },
  };
  return keys;
}

function fakeGuard() {
  return { blockReason: jest.fn(() => null), block: jest.fn(), unblock: jest.fn() };
}

let root;
let clock;
let service;
let keys;
let guard;
let log;
let nodes;
let events;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'radicled-node-'));
  clock = manualClock();
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  keys = fakeKeys();
  guard = fakeGuard();
  nodes = [];
  events = [];
  radicleGrantRefusal.mockReset();
  radicleGrantRefusal.mockReturnValue(null);
});

afterEach(async () => {
  for (const node of nodes) {
    const stopped = node.stop();
    await clock.advance(SHUTDOWN_GRACE_MS);
    await stopped;
  }
  service = null;
  fs.rmSync(root, { recursive: true, force: true });
});

function newNode(script = {}, extra = {}) {
  // One fake service per test, so a second node's children follow the
  // first's.
  if (!service) service = fakeRadicled(script);
  const spawn = (...args) => {
    events.push('spawn');
    return service.spawn(...args);
  };
  const node = new RadicledNode({
    home: HOME,
    lockDir: LOCK_DIR,
    ownHome: path.join(root, 'radicled-home'),
    keys,
    guard,
    removeStaleSocket: jest.fn(async (home) => {
      events.push(`socket:${home}`);
      return false;
    }),
    spawn,
    log,
    shellVersion: '0.9.0-test',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFailure: jest.fn(),
    onChange: jest.fn(),
    ...extra,
  });
  nodes.push(node);
  return node;
}

const child = (n = -1) => service.children.at(n);
const methods = (c) => c.requests.map((m) => m.method);
const hang = () => {};
const identityParams = () =>
  service.children.flatMap((c) => c.sent('rad.identity')).map((m) => m.params);

/** A node that has started: running, its start resolved true. */
async function running(script, extra) {
  const node = newNode(script, extra);
  const started = node.start();
  await settle();
  await expect(started).resolves.toBe(true);
  expect(node.state).toBe('running');
  return node;
}

describe('the start', () => {
  test('spawn, hello, the seal to its recipient, rad.identity, rad.reconcile, rad.start, then running on a live stats reply', async () => {
    const node = await running();
    expect(service.children).toHaveLength(1);
    expect(methods(child(0))).toEqual([
      'rad.hello',
      'rad.identity',
      'rad.reconcile',
      'rad.start',
      'rad.stats',
    ]);
    // The core sealed the key to the recipient hello named, and main passed
    // the reply on as it came.
    expect(keys.seal).toHaveBeenCalledTimes(1);
    expect(keys.seal).toHaveBeenCalledWith(RECIPIENT);
    expect(child(0).sent('rad.identity')[0].params).toEqual({ sealed: SEALED });
    expect(child(0).sent('rad.start')[0].params).toEqual({ alias: 'FreedomBrowser' });
    expect(node.isUp()).toBe(true);
    expect(node.activeIdentity()).toEqual({
      did: DID,
      nid: NID,
      alias: 'FreedomBrowser',
      ephemeral: false,
    });
  });

  test("the stale control socket is checked, on the home, before the start's first spawn only", async () => {
    const node = await running();
    expect(events).toEqual([`socket:${HOME}`, 'spawn']);
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    await settle();
    expect(node.state).toBe('running');
    expect(events).toEqual([`socket:${HOME}`, 'spawn', 'spawn']);
  });

  test('a stop while the stale socket waits for its gate spawns nothing', async () => {
    let signal;
    const node = newNode(
      {},
      {
        removeStaleSocket: jest.fn((_home, options) => {
          signal = options.signal;
          return new Promise((resolve) =>
            options.signal.addEventListener('abort', () => resolve(false))
          );
        }),
      }
    );
    const started = node.start();
    await settle();
    await node.stop();
    expect(signal.aborted).toBe(true);
    await expect(started).resolves.toBe(false);
    await settle();
    expect(service.children).toHaveLength(0);
  });

  test('no_vault gives a throwaway key: rad.identity { ephemeral: true }', async () => {
    keys.vault.exists = false;
    keys.vault.unlocked = false;
    const node = await running();
    expect(keys.seal).toHaveBeenCalledWith(RECIPIENT);
    expect(identityParams()).toEqual([{ ephemeral: true }]);
    expect(node.activeIdentity().ephemeral).toBe(true);
  });

  test.each([
    ['core_unavailable', 'The identity core is not running'],
    ['internal', 'Internal error'],
    ['invalid_argument', 'Invalid recipient'],
    ['busy', 'Busy'],
  ])("the seal's %s gives no throwaway key: the start fails", async (code, message) => {
    keys.seal.mockRejectedValue(coded(code, message));
    const node = newNode();
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(KEY_UNAVAILABLE);
    expect(identityParams()).toEqual([]);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
  });

  test("a vault that can't be read fails the start, and spawns nothing", async () => {
    keys.status.mockRejectedValue(coded('core_unavailable', 'The identity core is not running'));
    const node = newNode();
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(KEY_UNAVAILABLE);
    expect(service.children).toHaveLength(0);
  });

  test('a rad.identity reply for another identity than asked for fails the start', async () => {
    const node = newNode({
      identity: (m, c) => c.result(m.id, { did: DID, nid: NID, ephemeral: true }),
    });
    await expect(node.start()).resolves.toBe(false);
    expect(methods(child(0))).not.toContain('rad.reconcile');
  });

  test.each([
    [77, CONFINEMENT_REFUSED],
    [75, LOCK_HELD],
  ])('exit %i before the hello: no restart, and the reason', async (code, reason) => {
    const node = newNode({ hello: (_m, c) => setImmediate(() => c.exit(code)) });
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(reason);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
  });

  test("main's grant check refuses: nothing spawns, and the reason is fixed text", async () => {
    radicleGrantRefusal.mockReturnValue('it lies inside another profile');
    const node = newNode();
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(GRANT_REFUSED);
    expect(service.children).toHaveLength(0);
  });
});

describe('while the vault is locked (0008, "When the node can start")', () => {
  test('a start spawns nothing until vault.unlocked, and waits as no failure', async () => {
    keys.vault.unlocked = false;
    const node = newNode();
    const started = node.start();
    await settle();
    await clock.advance(120_000);
    expect(service.children).toHaveLength(0);
    expect(node.state).toBe('starting');
    expect(node.onChange).toHaveBeenCalledWith('waiting', node);
    // Another vault event asks again, and the vault is still locked.
    keys.emit('vault.locked', { reason: 'auto' });
    await settle();
    expect(service.children).toHaveLength(0);

    keys.unlock();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children).toHaveLength(1);
    expect(identityParams()).toEqual([{ sealed: SEALED }]);
    expect(node.onChange.mock.calls.filter(([s]) => s === 'waiting')).toHaveLength(1);
  });

  test('a lock while the node runs stops nothing', async () => {
    const node = await running();
    keys.lock();
    await clock.advance(30_000);
    expect(node.state).toBe('running');
    expect(service.children).toHaveLength(1);
    expect(child(0).sent('rad.shutdown')).toHaveLength(0);
  });

  test('a crash restart that falls due while locked waits for the unlock, and the wait is no crash', async () => {
    const node = await running();
    keys.lock();
    child(0).exit(70);
    await settle();
    expect(node.state).toBe('restarting');
    expect(node.onChange).toHaveBeenCalledWith('restarting', node);
    await clock.advance(500);
    await clock.advance(30_000);
    expect(service.children).toHaveLength(1);
    expect(node.onChange).toHaveBeenCalledWith('waiting', node);

    keys.unlock();
    await settle();
    expect(service.children).toHaveLength(2);
    expect(node.state).toBe('running');
    expect(node.onChange).toHaveBeenLastCalledWith('running', node);

    // One crash so far: the next one restarts after 2 s, not 10 s, and
    // nothing gives up.
    child(1).exit(70);
    await settle();
    await clock.advance(1_999);
    expect(service.children).toHaveLength(2);
    await clock.advance(1);
    expect(service.children).toHaveLength(3);
    expect(node.onFailure).not.toHaveBeenCalled();
    // Every start sealed its key: none ran with a throwaway one.
    expect(identityParams()).toEqual([{ sealed: SEALED }, { sealed: SEALED }, { sealed: SEALED }]);
  });

  test('a lock before the seal reply ends the start: the process goes, and the start waits', async () => {
    // The vault locks after the spawn's check and before the core hands
    // the seal's reply to its writer: the core answers vault_locked.
    keys.seal.mockImplementationOnce(async () => {
      keys.lock();
      throw coded('vault_locked', 'Vault is locked');
    });
    const node = newNode();
    const started = node.start();
    await settle();
    expect(service.children).toHaveLength(1);
    expect(child(0).sent('rad.identity')).toHaveLength(0);
    expect(child(0).sent('rad.shutdown')).toHaveLength(1);
    expect(child(0).exited).toBe(true);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
    expect(node.state).toBe('starting');

    keys.unlock();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children).toHaveLength(2);
    expect(identityParams()).toEqual([{ sealed: SEALED }]);
  });

  test('a lock after the seal reply stops nothing: not rad.identity, a long rad.reconcile, nor rad.start', async () => {
    let finishReconcile;
    keys.seal.mockImplementationOnce(async () => {
      setImmediate(() => keys.lock());
      return { ...SEALED };
    });
    const node = newNode({
      reconcile: (m, c) => {
        finishReconcile = () =>
          c.result(m.id, { was_dirty: true, repaired: {}, quarantined: { count: 0, first: [] } });
      },
      start: (m, c) => {
        keys.lock();
        c.result(m.id, { did: DID, nid: NID, alias: 'FreedomBrowser' });
      },
    });
    const started = node.start();
    await settle();
    expect(keys.vault.unlocked).toBe(false);
    await clock.advance(240_000);
    finishReconcile();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children).toHaveLength(1);
    expect(child(0).sent('rad.shutdown')).toHaveLength(0);
  });

  test('a stop during the wait ends it: nothing spawns at the unlock', async () => {
    keys.vault.unlocked = false;
    const node = newNode();
    const started = node.start();
    await settle();
    await node.stop();
    await expect(started).resolves.toBe(false);
    expect(keys.listeners.size).toBe(0);
    keys.unlock();
    await settle();
    expect(service.children).toHaveLength(0);
  });

  test('a vault created or deleted while waiting: the start goes on, and the seal decides the key', async () => {
    keys.vault.unlocked = false;
    const node = newNode();
    const started = node.start();
    await settle();
    // Deleted: no vault, so a throwaway key, from the core's no_vault.
    keys.vault.exists = false;
    keys.emit('vault.locked', { reason: 'delete' });
    await settle();
    await expect(started).resolves.toBe(true);
    expect(identityParams()).toEqual([{ ephemeral: true }]);
  });
});

describe('the switch (0008, "The switch")', () => {
  const keyFilePresent = (step) => ({
    [step]: (m, c) => {
      if (service.children.indexOf(c) === 0)
        c.error(m.id, 'key_file_present', 'keys/radicle exists');
      else if (step === 'identity') c.result(m.id, { did: DID, nid: NID, ephemeral: false });
      else c.result(m.id, { did: DID, nid: NID, alias: 'FreedomBrowser' });
    },
  });

  test.each(['identity', 'start'])(
    'key_file_present from rad.%s: once the process exits, the core switches the home, then the start runs once more',
    async (step) => {
      let exitedAtSwitch = null;
      keys.switchHome.mockImplementation(async () => {
        exitedAtSwitch = child(0).exited;
        return { status: 'installed' };
      });
      const node = await running(keyFilePresent(step), { switchAlias: () => 'MyAlias' });
      expect(keys.switchHome).toHaveBeenCalledTimes(1);
      // No wipe: the switch keeps the home's data and names the old
      // identity in node/dirty.
      expect(keys.switchHome).toHaveBeenCalledWith({
        node: 'radicle',
        home: HOME,
        alias: 'MyAlias',
        custody: 'sealed',
      });
      expect(exitedAtSwitch).toBe(true);
      expect(service.children).toHaveLength(2);
      expect(guard.unblock).toHaveBeenCalledTimes(1);
      expect(guard.block).not.toHaveBeenCalled();
      expect(node.onFailure).not.toHaveBeenCalled();
    }
  );

  test('key_file_present again after the switch is an error: the switch runs once', async () => {
    const node = newNode({
      identity: (m, c) => c.error(m.id, 'key_file_present', 'keys/radicle exists'),
    });
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(KEY_FILE_AGAIN);
    expect(keys.switchHome).toHaveBeenCalledTimes(1);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(2);
  });

  test.each([
    ['pending_recovery', ['pending_recovery']],
    ['corrupt', ['corrupt']],
  ])("a switch that ends %s keeps the node blocked, and doesn't start", async (status, blocked) => {
    keys.switchHome.mockResolvedValue({ status, reconciled: true });
    const node = newNode(keyFilePresent('identity'));
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(
      `The Radicle data's switch to the service did not finish (${status})`
    );
    expect(guard.block.mock.calls.map(([s]) => s)).toEqual(blocked);
    expect(guard.unblock).not.toHaveBeenCalled();
    expect(service.children).toHaveLength(1);
  });

  test.each([
    ['lock_held', [], 'The Radicle home is in use'],
    ['node_identity_corrupt', [], "The key file's public key can't be read"],
    ['core_unavailable', ['pending_recovery'], 'The identity core is not running'],
  ])('a switch refused with %s: the start fails', async (code, blocked, message) => {
    keys.switchHome.mockRejectedValue(coded(code, message));
    const node = newNode(keyFilePresent('identity'));
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(
      `The Radicle data couldn't be switched to the service: ${message}`
    );
    expect(guard.block.mock.calls.map(([s]) => s)).toEqual(blocked);
    expect(service.children).toHaveLength(1);
  });

  test('a node identity write in progress holds the switch back', async () => {
    guard.blockReason.mockReturnValue('Node identity is being updated');
    const node = newNode(keyFilePresent('identity'));
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe('Node identity is being updated');
    expect(keys.switchHome).not.toHaveBeenCalled();
  });
});

describe("the other start steps' errors (0008, Errors)", () => {
  test.each([
    ['reconcile', 'deadline', 'the reconciliation deadline passed', REPAIRING],
    [
      'reconcile',
      'recovery_failed',
      'the COB cache could not be read',
      'the COB cache could not be read',
    ],
    ['start', 'start_failed', 'failed to bind', 'failed to bind'],
    ['identity', 'bad_sealed_key', 'the sealed key does not open', 'the sealed key does not open'],
  ])('rad.%s answers %s: the error state, and no restart', async (step, code, message, reason) => {
    const node = newNode({ [step]: (m, c) => c.error(m.id, code, message) });
    await expect(node.start()).resolves.toBe(false);
    expect(node.failureReason).toBe(reason);
    expect(node.failureCode).toBe(code);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(1);
    expect(keys.switchHome).not.toHaveBeenCalled();
  });

  test('a restart that fails a start step after the node ran: the manager hears why', async () => {
    let reconciles = 0;
    const node = await running({
      reconcile: (m, c) => {
        reconciles += 1;
        if (reconciles === 1)
          c.result(m.id, { was_dirty: false, repaired: {}, quarantined: { count: 0, first: [] } });
        else c.error(m.id, 'recovery_failed', 'storage is unreadable');
      },
    });
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    expect(node.onFailure).toHaveBeenCalledWith('storage is unreadable', node);
    expect(node.state).toBe('failed');
  });

  test("Retry after the deadline: the manager's next start spawns a fresh process, which runs", async () => {
    let reconciles = 0;
    const script = {
      reconcile: (m, c) => {
        reconciles += 1;
        if (reconciles === 1) c.error(m.id, 'deadline', 'the reconciliation deadline passed');
        else
          c.result(m.id, { was_dirty: true, repaired: {}, quarantined: { count: 0, first: [] } });
      },
    };
    const first = newNode(script);
    await expect(first.start()).resolves.toBe(false);
    expect(first.failureReason).toBe(REPAIRING);
    await first.stop();
    const retry = newNode(script);
    await expect(retry.start()).resolves.toBe(true);
    expect(service.children).toHaveLength(2);
    expect(child(1).sent('rad.reconcile')).toHaveLength(1);
  });
});

describe("readiness (0008, Main's side)", () => {
  test('not up until a stats reply says node_alive; then up', async () => {
    let alive = false;
    const node = newNode({
      stats: (m, c) =>
        c.result(m.id, statsResult(alive ? {} : { node: 'starting', node_alive: false })),
    });
    const started = node.start();
    await settle();
    expect(node.state).toBe('starting');
    expect(node.isUp()).toBe(false);
    alive = true;
    await clock.advance(HEALTH_INTERVAL_MS);
    await expect(started).resolves.toBe(true);
    expect(node.isUp()).toBe(true);
  });

  test('rad.stats every 5 s; a reply 15 s old is not up, and the node restarts once the hung process is killed', async () => {
    let answering = true;
    const node = await running({
      stats: (m, c) => {
        if (answering) c.result(m.id, statsResult({ connected_peers: 3 }));
      },
    });
    expect(node.connectedPeers()).toBe(3);
    await clock.advance(4 * HEALTH_INTERVAL_MS);
    expect(child(0).sent('rad.stats')).toHaveLength(5);
    answering = false;
    await clock.advance(HEALTH_INTERVAL_MS);
    // The last reply is 5 s old: up. At 15 s it isn't.
    expect(node.isUp()).toBe(true);
    await clock.advance(STATS_FRESH_MS - HEALTH_INTERVAL_MS);
    expect(node.isUp()).toBe(false);
    expect(node.state).toBe('restarting');
    expect(node.onChange).toHaveBeenCalledWith('restarting', node);
    // The stats watchdog (20 s) kills the hung process: a crash, restarted.
    answering = true;
    await clock.advance(STATS_WATCHDOG_MS);
    await clock.advance(500);
    expect(service.children).toHaveLength(2);
    expect(node.state).toBe('running');
    expect(node.onChange).toHaveBeenLastCalledWith('running', node);
  });

  // Plan B10 (0008, Main's side, "The active identity belongs to the
  // generation"): the identity is `rad.identity`'s reply, one object for the
  // generation, and a crash's restart has its own.
  test("the generation's identity is rad.identity's reply, the same object while it runs, and a restart's is another", async () => {
    let throwaway = 0;
    const script = {
      identity: (message, c) => {
        throwaway += 1;
        c.result(message.id, { did: `did:key:z6MkThrowaway${throwaway}`, nid: `z6MkThrowaway${throwaway}`, ephemeral: true });
      },
      // rad.start names another DID: the node's stays rad.identity's.
      start: (message, c) => c.result(message.id, { did: 'did:key:z6MkOther', nid: 'z6MkOther', alias: 'FreedomBrowser' }),
    };
    keys.vault.exists = false;
    keys.vault.unlocked = false;
    const node = await running(script);
    const first = node.activeIdentity();
    expect(first).toEqual({
      did: 'did:key:z6MkThrowaway1',
      nid: 'z6MkThrowaway1',
      alias: 'FreedomBrowser',
      ephemeral: true,
    });
    expect(Object.isFrozen(first)).toBe(true);
    await clock.advance(HEALTH_INTERVAL_MS);
    expect(node.activeIdentity()).toBe(first);

    child(0).exit(70);
    await settle();
    expect(node.activeIdentity()).toBeNull();
    await clock.advance(500);
    expect(node.state).toBe('running');
    const second = node.activeIdentity();
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ did: 'did:key:z6MkThrowaway2', ephemeral: true });
  });

  test("a generation that ended isn't up, and its identity goes with it", async () => {
    const node = await running();
    child(0).exit(70);
    await settle();
    expect(node.isUp()).toBe(false);
    expect(node.generation).toBeNull();
    expect(node.activeIdentity()).toBeNull();
    expect(node.connectedPeers()).toBeNull();
    await expect(node.connectSeeds(15000)).rejects.toThrow('The Radicle node is not running');
  });
});

describe('crashes and restarts', () => {
  test('restarts at 0.5 s and 2 s; the third crash within 60 s gives up', async () => {
    const node = await running();
    // Each process is a generation of its own (the manager seeds each).
    const first = node.generation;
    expect(first).toEqual(expect.any(Number));
    child(0).exit(70);
    await settle();
    await clock.advance(499);
    expect(service.children).toHaveLength(1);
    await clock.advance(1);
    expect(service.children).toHaveLength(2);
    expect(node.state).toBe('running');
    expect(node.generation).toBeGreaterThan(first);
    child(1).exit(70);
    await settle();
    await clock.advance(2_000);
    expect(service.children).toHaveLength(3);
    child(2).exit(70);
    await settle();
    expect(node.state).toBe('failed');
    expect(node.onFailure).toHaveBeenCalledWith(CRASHED, node);
    await clock.advance(60_000);
    expect(service.children).toHaveLength(3);
  });
});

describe('stop', () => {
  test("rad.shutdown; the process's exit is the proof", async () => {
    const node = await running();
    const stopped = node.stop();
    await settle();
    expect(child(0).sent('rad.shutdown')).toHaveLength(1);
    await stopped;
    expect(child(0).exited).toBe(true);
    expect(node.state).toBe('stopped');
    expect(node.isUp()).toBe(false);
  });

  test('a process that ignores rad.shutdown is killed 10 s after it', async () => {
    const node = await running({ shutdown: hang });
    let done = false;
    const stopped = node.stop().then(() => {
      done = true;
    });
    await clock.advance(SHUTDOWN_GRACE_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    await stopped;
    expect(child(0).killedWith).toBe('SIGKILL');
  });
});

describe('the network calls the manager runs once the node is up', () => {
  test('connect_seeds(15000) and the default repository clone, without progress', async () => {
    const node = await running({
      connect_seeds: (m, c) =>
        c.result(m.id, { connected: 2, target: 4, attempted: 5, elapsedMs: 9 }),
      clone: (m, c) => c.result(m.id, { ok: true }),
    });
    await expect(node.connectSeeds(15000)).resolves.toMatchObject({ connected: 2 });
    expect(child(0).sent('rad.connect_seeds')[0].params).toEqual({ timeout_ms: 15000 });
    await expect(node.cloneRepo('rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE', 120000)).resolves.toEqual({
      ok: true,
    });
    expect(child(0).sent('rad.clone')[0].params).toEqual({
      rid: 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE',
      timeout_ms: 120000,
      progress: false,
    });
  });
});

describe("a clone's progress (0008, Methods and Progress)", () => {
  const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
  const text = (event) => JSON.stringify(event);

  test("rad.progress events reach the clone's own callback, as their text, in order, until its answer", async () => {
    const clones = [];
    const node = await running({ clone: (m) => clones.push(m) });
    const first = [];
    const second = [];
    const a = node.clone(RID, 120000, { onProgress: (event) => first.push(event) });
    const b = node.clone('rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE', 5000, {
      onProgress: (event) => second.push(event),
    });
    await settle();
    expect(clones.map((m) => m.params)).toEqual([
      { rid: RID, timeout_ms: 120000, progress: true },
      { rid: 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE', timeout_ms: 5000, progress: true },
    ]);
    const [ida, idb] = clones.map((m) => m.id);
    child(0).event('rad.progress', { id: ida, event: text({ candidates: 2, phase: 'resolving' }) });
    child(0).event('rad.progress', { id: idb, event: text({ phase: 'done' }) });
    child(0).event('rad.progress', { id: ida, event: text({ phase: 'cancelled' }) });
    // Not a clone's, not a progress event, or not one at all: dropped.
    child(0).event('rad.progress', { id: 999, event: text({ phase: 'done' }) });
    child(0).event('rad.other', { id: ida, event: text({ phase: 'done' }) });
    child(0).event('rad.progress', { id: ida, event: { phase: 'done' } });
    child(0).result(idb, { ok: true });
    child(0).result(ida, { cancelled: true });
    await expect(a).resolves.toEqual({ cancelled: true });
    await expect(b).resolves.toEqual({ ok: true });
    expect(first).toEqual([
      text({ candidates: 2, phase: 'resolving' }),
      text({ phase: 'cancelled' }),
    ]);
    expect(second).toEqual([text({ phase: 'done' })]);
    expect(node.progress.size).toBe(0);
  });

  test('progress stops at the answer: an event after it, in the same read, is dropped', async () => {
    const clones = [];
    const node = await running({ clone: (m) => clones.push(m) });
    const events = [];
    const answer = node.clone(RID, 120000, { onProgress: (event) => events.push(event) });
    await settle();
    const { id } = clones[0];
    child(0).event('rad.progress', { id, event: text({ phase: 'done' }) });
    child(0).result(id, { ok: true });
    child(0).event('rad.progress', { id, event: text({ phase: 'resolving', candidates: 1 }) });
    await expect(answer).resolves.toEqual({ ok: true });
    await settle();
    expect(events).toEqual([text({ phase: 'done' })]);
  });

  test('a clone without a callback asks for no progress, and its events reach nothing', async () => {
    const clones = [];
    const node = await running({ clone: (m) => clones.push(m) });
    const answer = node.clone(RID, 120000);
    await settle();
    expect(clones[0].params.progress).toBe(false);
    child(0).event('rad.progress', { id: clones[0].id, event: text({ phase: 'done' }) });
    child(0).result(clones[0].id, { ok: true });
    await expect(answer).resolves.toEqual({ ok: true });
    expect(node.progress.size).toBe(0);
  });

  test("a callback that throws is logged by its code, and the clone's next events still come", async () => {
    const clones = [];
    const node = await running({ clone: (m) => clones.push(m) });
    const events = [];
    const answer = node.clone(RID, 120000, {
      onProgress: (event) => {
        events.push(event);
        if (events.length === 1) throw Object.assign(new Error('a path /home/x'), { code: 'boom' });
      },
    });
    await settle();
    const { id } = clones[0];
    child(0).event('rad.progress', { id, event: text({ phase: 'resolving', candidates: 1 }) });
    child(0).event('rad.progress', { id, event: text({ phase: 'done' }) });
    child(0).result(id, { ok: true });
    await answer;
    expect(events).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith('[Radicle] A clone progress callback failed', {
      code: 'boom',
    });
  });

  test("a crash's restart: the clone fails, its callback goes, and the next process's IDs reach nothing of it", async () => {
    const clones = [];
    const node = await running({ clone: (m) => clones.push(m) });
    const events = [];
    const answer = node.clone(RID, 120000, { onProgress: (event) => events.push(event) });
    await settle();
    child(0).exit(70);
    await expect(answer).rejects.toMatchObject({ code: 'radicle_unavailable' });
    expect(node.progress.size).toBe(0);
    await clock.advance(500);
    await settle();
    expect(node.generation).not.toBeNull();
    // The same ID on the new process: no callback of the old clone's.
    child(1).event('rad.progress', { id: clones[0].id, event: text({ phase: 'done' }) });
    await settle();
    expect(events).toEqual([]);
  });

  test('with no generation running, connectSeeds and clone are stopped, and nothing is sent', async () => {
    const node = newNode();
    await expect(node.connectSeeds(15000)).rejects.toMatchObject({ code: 'stopped' });
    await expect(node.clone(RID, 120000, { onProgress: () => {} })).rejects.toMatchObject({
      code: 'stopped',
    });
    await expect(node.cloneRepo(RID, 120000)).rejects.toThrow('The Radicle node is not running');
    expect(service.children).toHaveLength(0);
  });
});

// Plan B13 (0008, "The escape", Main's view): each generation's report of
// the quarantine, the stats' count, rad.quarantine_list and rad.remove_repo.
describe('the quarantine (0008, "The escape")', () => {
  const RID = 'rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5';
  const QID = '0123456789abcdef0123456789abcdef';
  const entry = (n) => ({
    rid: RID,
    qid: n.toString(16).padStart(32, '0'),
    kind: 'cache',
    step: 'cache',
    unit: null,
    since: n,
  });
  const reconciled = (count, first) => (m, c) =>
    c.result(m.id, { was_dirty: true, repaired: {}, quarantined: { count, first } });

  test("each generation keeps its report, up to 16 entries, and the stats' count from then on", async () => {
    const first = Array.from({ length: 20 }, (_, n) => entry(n));
    let count = 20;
    const onQuarantine = jest.fn();
    const node = await running(
      {
        reconcile: reconciled(20, first),
        stats: (m, c) => c.result(m.id, statsResult({ quarantined_count: count })),
      },
      { onQuarantine }
    );
    expect(node.quarantineReport()).toEqual({ count: 20, first: first.slice(0, 16) });
    expect(node.quarantinedCount()).toBe(20);
    expect(onQuarantine).not.toHaveBeenCalled();

    // An online repair quarantined another: the next stats reply says so.
    count = 21;
    await clock.advance(HEALTH_INTERVAL_MS);
    expect(node.quarantinedCount()).toBe(21);
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledWith(21, node);
    await clock.advance(HEALTH_INTERVAL_MS);
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    // The report is the reconciliation's still.
    expect(node.quarantineReport().count).toBe(20);
  });

  test("a report without a count is none; a crash's restart reports anew", async () => {
    let reconciles = 0;
    const node = await running({
      reconcile: (m, c) => {
        reconciles += 1;
        if (reconciles === 1) c.result(m.id, { was_dirty: false, repaired: {}, quarantined: {} });
        else reconciled(1, [entry(1)])(m, c);
      },
      stats: (m, c) => c.result(m.id, statsResult({ quarantined_count: reconciles === 1 ? 0 : 1 })),
    });
    expect(node.quarantineReport()).toBeNull();
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    await settle();
    expect(node.generation).not.toBeNull();
    expect(node.quarantineReport()).toEqual({ count: 1, first: [entry(1)] });
  });

  test('quarantineList is rad.quarantine_list { page } on the running generation', async () => {
    const node = await running({
      quarantine_list: (m, c) => c.result(m.id, { entries: [entry(64)], next_page: null }),
    });
    await expect(node.quarantineList(1)).resolves.toEqual({
      entries: [entry(64)],
      next_page: null,
    });
    expect(child().sent('rad.quarantine_list').map((m) => m.params)).toEqual([{ page: 1 }]);
  });

  test('removeRepo is rad.remove_repo { rid, qid } on the generation picked', async () => {
    const node = await running({
      remove_repo: (m, c) => c.result(m.id, { removed: true }),
    });
    const target = node.writeTarget();
    await expect(node.removeRepo(target, RID, QID)).resolves.toEqual({ removed: true });
    expect(child().sent('rad.remove_repo').map((m) => m.params)).toEqual([{ rid: RID, qid: QID }]);
  });

  test('not_quarantined proves nothing was removed: it is answered as it came', async () => {
    const node = await running({
      remove_repo: (m, c) => c.error(m.id, 'not_quarantined', 'no record has that qid'),
    });
    await expect(node.removeRepo(node.writeTarget(), RID, QID)).rejects.toMatchObject({
      code: 'not_quarantined',
    });
  });

  test("a crash with a removal in flight is outcome_unknown; one picked for a generation that ended isn't sent", async () => {
    const node = await running({ remove_repo: hang });
    const target = node.writeTarget();
    const removal = node.removeRepo(target, RID, QID);
    await settle();
    child(0).exit(70);
    await expect(removal).rejects.toMatchObject({ code: 'outcome_unknown' });
    await clock.advance(500);
    await settle();
    await expect(node.removeRepo(target, RID, QID)).rejects.toMatchObject({ code: 'stopped' });
    expect(child(1).sent('rad.remove_repo')).toHaveLength(0);
  });

  test('with no generation running, nothing is listed or removed', async () => {
    const node = newNode();
    expect(node.quarantineReport()).toBeNull();
    expect(node.quarantinedCount()).toBeNull();
    await expect(node.quarantineList(0)).rejects.toMatchObject({ code: 'stopped' });
    await expect(node.removeRepo(null, RID, QID)).rejects.toMatchObject({ code: 'stopped' });
    expect(service.children).toHaveLength(0);
  });
});

describe('what main holds of the key', () => {
  test("main's log never holds the recipient, enc or the ciphertext; the pipe carries only the seal's reply", async () => {
    let switched = false;
    await running({
      identity: (m, c) => {
        if (!switched) {
          switched = true;
          c.error(m.id, 'key_file_present', 'keys/radicle exists');
        } else c.result(m.id, { did: DID, nid: NID, ephemeral: false });
      },
    });
    const logged = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    for (const secretish of [RECIPIENT, SEALED.enc, SEALED.ciphertext]) {
      expect(logged).not.toContain(secretish);
      expect(logged).not.toContain(Buffer.from(secretish, 'base64').toString('hex'));
    }
    // What went down the pipe of each process: the seal's reply, as the
    // core gave it, once per process.
    expect(identityParams()).toEqual([{ sealed: SEALED }, { sealed: SEALED }]);
  });
});

describe('diagnostics (design 0010, step 5)', () => {
  test("hello's confinement is logged at each spawn; the build info is kept for the nodes panel", async () => {
    const node = await running();
    expect(log.info).toHaveBeenCalledWith(
      '[Radicle] freedom-radicled confinement',
      confinementLog(CONFINEMENT)
    );
    expect(node.version).toBe(HELLO.libradicle.version);
    expect(node.confinement).toEqual(CONFINEMENT);
    expect(node.buildInfo()).toEqual({
      name: 'libradicle',
      version: HELLO.libradicle.version,
      git_commit: HELLO.libradicle.git_commit,
      service: {
        name: 'freedom-radicled',
        version: HELLO.service_version,
        network: { mode: 'direct' },
        confinement: CONFINEMENT,
      },
    });
  });
});

/** The `--network` value `c` was spawned with. */
const networkOf = (c) => c.args[c.args.indexOf('--network') + 1];
/** The states the manager heard, in order. */
const changes = (node) => node.onChange.mock.calls.map(([state]) => state);
const SOCKS = Object.freeze({ mode: 'socks5', ip: '127.0.0.1', port: 9150 });

describe('the network policy (0008, "Modes"; plan B18)', () => {
  /** A node of a profile whose setting (`setting.routes`) says whether
   * Radicle goes through Tor, and `tor` what Tor offers. */
  function profile({ routes = true, endpoint = null, script = {}, extra = {} } = {}) {
    const tor = fakeTorEndpoint();
    if (endpoint) tor.offer(endpoint);
    const setting = { routes };
    const network = new RadicleNetwork({ routesThroughTor: () => setting.routes, tor });
    const node = newNode(script, { network, ...extra });
    return { node, tor, setting, network };
  }

  test('direct by default: spawned with --network direct', async () => {
    await running();
    expect(networkOf(child(0))).toBe('direct');
  });

  test("through Tor, the process is spawned under Tor's endpoint, which hello reports and the nodes panel shows", async () => {
    const { node } = profile({ endpoint: { ip: '127.0.0.1', port: 9150 } });
    const started = node.start();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(networkOf(child(0))).toBe('socks5:127.0.0.1:9150');
    expect(node.buildInfo().service.network).toEqual(SOCKS);
    // The whole start ran under it: the policy changes nothing else.
    expect(methods(child(0))).toEqual([
      'rad.hello',
      'rad.identity',
      'rad.reconcile',
      'rad.start',
      'rad.stats',
    ]);
  });

  test('an IPv6 endpoint goes in brackets', async () => {
    const { node } = profile({ endpoint: { ip: '::1', port: 9050 } });
    const started = node.start();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(networkOf(child(0))).toBe('socks5:[::1]:9050');
  });

  test('a hello that reports another policy than main passed is a fault: the start never goes on', async () => {
    const { node } = profile({
      endpoint: { ip: '127.0.0.1', port: 9150 },
      script: { hello: (m, c) => c.result(m.id, { ...HELLO, network: { mode: 'direct' } }) },
    });
    const started = node.start();
    await settle();
    await clock.advance(120_000);
    await expect(started).resolves.toBe(false);
    expect(keys.seal).not.toHaveBeenCalled();
    expect(service.children.flatMap((c) => c.sent('rad.identity'))).toEqual([]);
  });

  test('through Tor with no endpoint yet, nothing is spawned, nothing falls back, until Tor offers one', async () => {
    const { node, tor } = profile();
    let result = null;
    node.start().then((value) => (result = value));
    await settle();
    await clock.advance(120_000);

    // No process at all: the node stays starting, and says it waits.
    expect(service.children).toHaveLength(0);
    expect(node.state).toBe('starting');
    expect(result).toBeNull();
    expect(changes(node)).toEqual(['waiting-tor']);
    expect(keys.status).not.toHaveBeenCalled();

    tor.offer({ ip: '127.0.0.1', port: 9150 });
    await settle();
    expect(service.children).toHaveLength(1);
    expect(networkOf(child(0))).toBe('socks5:127.0.0.1:9150');
    expect(result).toBe(true);
    expect(node.state).toBe('running');
  });

  test('a stop while it waits for Tor ends the wait and its subscription', async () => {
    const { node, tor } = profile();
    const started = node.start();
    await settle();
    expect(tor.listeners.size).toBe(1);
    await node.stop();
    await expect(started).resolves.toBe(false);
    expect(tor.listeners.size).toBe(0);
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    await settle();
    expect(service.children).toHaveLength(0);
  });

  test('the setting turned off while it waits for Tor spawns a direct process', async () => {
    const { node, setting, network } = profile();
    const started = node.start();
    await settle();
    setting.routes = false;
    network.changed();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children.map(networkOf)).toEqual(['direct']);
  });

  test('a crash is restarted under the same policy', async () => {
    const { node } = profile({ endpoint: { ip: '127.0.0.1', port: 9150 } });
    const started = node.start();
    await settle();
    await expect(started).resolves.toBe(true);
    child(0).exit(70);
    await settle();
    await clock.advance(500);
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'socks5:127.0.0.1:9150',
    ]);
    expect(node.state).toBe('running');
  });

  test('a node that gave up stops listening', async () => {
    const { node, tor } = profile({
      endpoint: { ip: '127.0.0.1', port: 9150 },
      script: { reconcile: (m, c) => c.error(m.id, 'recovery_failed', 'repair failed') },
    });
    await expect(node.start()).resolves.toBe(false);
    expect(node.state).toBe('failed');
    expect(tor.listeners.size).toBe(0);
  });
});

describe('a change of network policy (0008, "Changing the policy restarts the process")', () => {
  /** A running node through Tor at `endpoint`; `setting.routes` and
   * `tor.offer()` change its policy. */
  async function routed({ script = {}, endpoint = { ip: '127.0.0.1', port: 9150 } } = {}) {
    const tor = fakeTorEndpoint();
    tor.offer(endpoint);
    const setting = { routes: true };
    const network = new RadicleNetwork({ routesThroughTor: () => setting.routes, tor });
    const node = await running(script, { network });
    return { node, tor, setting, network };
  }

  test("Tor's endpoint moving retires the generation, shuts the process down, and spawns one under the new policy, its start whole again", async () => {
    const { node, tor } = await routed();
    const before = node.writeTarget();
    const first = node.generation;
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    // Retired at once: nothing more goes to it, and it is down meanwhile.
    expect(node.writeTarget()).toBeNull();
    expect(node.isUp()).toBe(false);
    expect(node.state).toBe('restarting');
    await settle();

    const [old, next] = service.children;
    expect(old.sent('rad.shutdown')).toHaveLength(1);
    expect(old.exited).toBe(true);
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'socks5:127.0.0.1:9151',
    ]);
    // The new process's start is the whole start: its key sealed anew.
    expect(methods(next)).toEqual([
      'rad.hello',
      'rad.identity',
      'rad.reconcile',
      'rad.start',
      'rad.stats',
    ]);
    expect(keys.seal).toHaveBeenCalledTimes(2);
    expect(node.state).toBe('running');
    expect(changes(node)).toEqual(['restarting', 'running']);
    // Its generation is the node's next: never taken for the old one.
    expect(node.generation).toBeGreaterThan(first);
    // A write picked for the old process isn't sent to the new one.
    await expect(node.write(before, 'seed', { rid: 'rad:z1' })).rejects.toMatchObject({
      code: 'stopped',
    });
    expect(next.sent('rad.write')).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      '[Radicle] The network policy changed: freedom-radicled restarts'
    );
  });

  test('the setting turning off or on is a change too', async () => {
    const { node, setting, network } = await routed();
    setting.routes = false;
    network.changed();
    await settle();
    setting.routes = true;
    network.changed();
    await settle();
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'direct',
      'socks5:127.0.0.1:9150',
    ]);
    expect(service.children.slice(0, 2).every((c) => c.exited)).toBe(true);
    expect(node.state).toBe('running');
  });

  test('the setting turned on while Tor offers no endpoint: the direct process goes, and nothing runs until Tor offers one', async () => {
    const tor = fakeTorEndpoint();
    const setting = { routes: false };
    const network = new RadicleNetwork({ routesThroughTor: () => setting.routes, tor });
    const node = await running({}, { network });

    setting.routes = true;
    network.changed();
    await settle();
    await clock.advance(120_000);
    expect(child(0).sent('rad.shutdown')).toHaveLength(1);
    expect(child(0).exited).toBe(true);
    expect(service.children).toHaveLength(1);
    expect(node.state).toBe('restarting');
    expect(changes(node)).toEqual(['restarting', 'waiting-tor']);

    tor.offer({ ip: '127.0.0.1', port: 9150 });
    await settle();
    expect(service.children.map(networkOf)).toEqual(['direct', 'socks5:127.0.0.1:9150']);
    expect(node.state).toBe('running');
    expect(changes(node)).toEqual(['restarting', 'waiting-tor', 'running']);
  });

  test('Tor going down, or offering the same endpoint again, changes nothing: the process stays, and fails closed', async () => {
    const { node, tor } = await routed();
    tor.offer(null);
    await settle();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    await settle();
    expect(service.children).toHaveLength(1);
    expect(child(0).sent('rad.shutdown')).toEqual([]);
    expect(node.state).toBe('running');
  });

  test('the respawn has no back-off and counts as no crash', async () => {
    const { node, tor } = await routed();
    for (const port of [9151, 9152, 9153]) {
      tor.offer({ ip: '127.0.0.1', port });
      await settle();
    }
    expect(service.children).toHaveLength(4);
    expect(networkOf(child())).toBe('socks5:127.0.0.1:9153');
    expect(node.state).toBe('running');
    // A crash after them is the first: 0.5 s, and restarted.
    child().exit(70);
    await settle();
    await clock.advance(499);
    expect(service.children).toHaveLength(4);
    await clock.advance(1);
    expect(service.children).toHaveLength(5);
    expect(node.onFailure).not.toHaveBeenCalled();
  });

  test("changes during the old process's shutdown: one new process, under the policy in force once it has exited", async () => {
    // The old process ignores rad.shutdown: it is killed 10 s on.
    const { node, tor } = await routed({ script: { shutdown: hang } });
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    await settle();
    tor.offer({ ip: '127.0.0.1', port: 9152 });
    await settle();
    expect(service.children).toHaveLength(1);
    await clock.advance(SHUTDOWN_GRACE_MS);
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'socks5:127.0.0.1:9152',
    ]);
    expect(node.state).toBe('running');
  });

  test('a stop during the change ends it: no new process', async () => {
    const { node, tor } = await routed({ script: { shutdown: hang } });
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    await settle();
    const stopping = node.stop();
    await settle();
    await clock.advance(SHUTDOWN_GRACE_MS);
    await stopping;
    expect(service.children).toHaveLength(1);
    expect(node.state).toBe('stopped');
  });

  test("on a vault profile, the new policy's process starts only once the vault is unlocked", async () => {
    const { node, tor } = await routed();
    // A lock stops nothing while the node runs (0008)…
    keys.lock();
    await settle();
    expect(node.state).toBe('running');
    // …but a change of policy takes it down until the next unlock.
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    await settle();
    await clock.advance(120_000);
    expect(child(0).exited).toBe(true);
    expect(service.children).toHaveLength(1);
    expect(node.state).toBe('restarting');
    expect(changes(node)).toEqual(['restarting', 'waiting']);

    keys.unlock();
    await settle();
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'socks5:127.0.0.1:9151',
    ]);
    expect(identityParams()).toEqual([{ sealed: SEALED }, { sealed: SEALED }]);
    expect(node.state).toBe('running');
  });

  test("a change while the start waits for the unlock: the old wait ends with its client, and the new one's spawns once, under the new policy", async () => {
    keys.vault.unlocked = false;
    const tor = fakeTorEndpoint();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    const network = new RadicleNetwork({ routesThroughTor: () => true, tor });
    const node = newNode({}, { network });
    const started = node.start();
    await settle();
    expect(changes(node)).toEqual(['waiting']);
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    await settle();
    expect(service.children).toHaveLength(0);

    keys.unlock();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children.map(networkOf)).toEqual(['socks5:127.0.0.1:9151']);
    // Each wait for the unlock was told: the new client's too.
    expect(changes(node)).toEqual(['waiting', 'waiting']);
  });

  test('a change during the switch: the switch runs, then the process starts under the new policy', async () => {
    let switched;
    keys.switchHome.mockImplementation(
      () =>
        new Promise((resolve) => {
          switched = () => resolve({ status: 'installed' });
        })
    );
    const tor = fakeTorEndpoint();
    tor.offer({ ip: '127.0.0.1', port: 9150 });
    const network = new RadicleNetwork({ routesThroughTor: () => true, tor });
    const node = newNode(
      {
        identity: (m, c) => {
          if (service.children.indexOf(c) === 0) {
            c.error(m.id, 'key_file_present', 'keys/radicle exists');
          } else {
            c.result(m.id, { did: DID, nid: NID, ephemeral: false });
          }
        },
      },
      { network }
    );
    const started = node.start();
    await settle();
    expect(keys.switchHome).toHaveBeenCalledTimes(1);
    tor.offer({ ip: '127.0.0.1', port: 9151 });
    await settle();
    expect(service.children).toHaveLength(1);

    switched();
    await settle();
    await expect(started).resolves.toBe(true);
    expect(service.children.map(networkOf)).toEqual([
      'socks5:127.0.0.1:9150',
      'socks5:127.0.0.1:9151',
    ]);
    expect(keys.switchHome).toHaveBeenCalledTimes(1);
  });
});
