/**
 * The Radicle node on freedom-radicled (freedom-core design 0008, step 6),
 * against an in-process fake service (`test/helpers/fake-radicled.js`), a
 * fake core (its vault's state and events, the seal and the switch) and a
 * manual clock: the start's order, the sealed key and the throwaway one,
 * the unlock wait (at the start and for a crash's restart), the lock
 * boundary, the switch, the other start steps' errors and the Retry,
 * readiness, the restarts, the stop, and what main's log never holds. The
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
