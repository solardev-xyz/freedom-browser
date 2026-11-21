/**
 * Main's copy of the pending Safe transactions (pending-store.js), which
 * the identity core keeps (freedom-core design 0013, PRF-6(d)), against the
 * simulated core (test/helpers/simulated-store-core.js: the reference
 * store over the test's safe-pending.json). The real core is in
 * pending-store.integration.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let mockTmpDir;
jest.mock('electron', () => ({
  app: { getPath: () => mockTmpDir },
}));

jest.mock('../../core/vault-backend', () => {
  const { simulatedSafePending } = require('../../../../test/helpers/simulated-store-core');
  const pendingSim = simulatedSafePending();
  return { vaultBackend: { safePending: pendingSim.safePending, pendingSim } };
});

const pendingStore = require('./pending-store');
const { pendingSim } = require('../../core/vault-backend').vaultBackend;

const entry = (hash, signatures = []) => ({ safeTxHash: hash, threshold: 2, signatures });
const file = () => path.join(mockTmpDir, 'safe-pending.json');
// As an older build (or the core) wrote it: the reference's text.
const seed = (store) => fs.writeFileSync(file(), JSON.stringify(store, null, 2), 'utf-8');
const methods = () => pendingSim.calls.map(([method]) => method);
const storage = () =>
  Object.assign(new Error('The pending Safe transactions could not be written'), {
    code: 'storage',
  });
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** A core client as attachCore hears it: `ready` and `failed` events. */
const fakeClient = () => new EventEmitter();

beforeEach(() => {
  mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-pending-store-'));
  Object.assign(pendingSim, { moved: true, fail: null, loseReply: null, calls: [] });
  pendingStore._reset();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(mockTmpDir, { recursive: true, force: true });
});

describe('loading', () => {
  test("nothing is pending until the core's store loads (G29); then each entry is, and ready resolves", async () => {
    seed({ 5: entry('0x05', [{ signer: '0xA', data: '0x01' }]), 12: entry('0x0c') });
    const client = fakeClient();
    pendingStore.attachCore(client);
    expect(pendingStore.getPending(5)).toBeNull();
    expect(pendingStore.listPendingIndexes()).toEqual([]);
    let ready = false;
    pendingStore.ready.then(() => (ready = true));
    await flush();
    expect(ready).toBe(false);
    expect(pendingSim.calls).toEqual([]);

    client.emit('ready');
    await pendingStore.ready;
    expect(ready).toBe(true);
    expect(methods()).toEqual(['safe_pending.list', 'safe_pending.get', 'safe_pending.get']);
    expect(pendingStore.listPendingIndexes()).toEqual([5, 12]);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05', [{ signer: '0xA', data: '0x01' }]));
    // The same object while it lives.
    expect(pendingStore.getPending(5)).toBe(pendingStore.getPending(5));
  });

  test("each start of the core loads it again: an unchanged entry keeps its object, a changed one doesn't, a gone one goes", async () => {
    seed({ 5: entry('0x05'), 6: entry('0x06'), 7: entry('0x07') });
    const client = fakeClient();
    pendingStore.attachCore(client);
    client.emit('ready');
    await pendingStore.ready;
    const five = pendingStore.getPending(5);
    const six = pendingStore.getPending(6);

    // Written meanwhile as the core writes it (a lost answer's write, say).
    seed({ 5: entry('0x05'), 6: entry('0x66'), 8: entry('0x08') });
    client.emit('ready');
    await flush();
    expect(pendingStore.getPending(5)).toBe(five);
    expect(pendingStore.getPending(6)).not.toBe(six);
    expect(pendingStore.getPending(6)).toEqual(entry('0x66'));
    expect(pendingStore.getPending(7)).toBeNull();
    expect(pendingStore.listPendingIndexes()).toEqual([5, 6, 8]);
  });

  test('a first load that fails leaves nothing pending, and ready loads again, rejecting as that fails', async () => {
    seed({ 5: entry('0x05') });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient();
    pendingStore.attachCore(client);
    pendingSim.moved = false;
    client.emit('ready');
    await expect(pendingStore.ready).rejects.toMatchObject({ code: 'requirement_unmet' });
    expect(error).toHaveBeenCalledWith(
      '[SafePending] Failed to load the pending Safe transactions (requirement_unmet):',
      "The core can't take this request"
    );
    expect(pendingStore.getPending(5)).toBeNull();
    // Once the core can answer, the next wait loads it.
    pendingSim.moved = true;
    await pendingStore.ready;
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  test('a core that gives up fails the wait for its load; a later wait tries a load of its own', async () => {
    const client = fakeClient();
    pendingStore.attachCore(client);
    pendingSim.fail = () => {
      throw Object.assign(new Error('The identity core is not running'), {
        code: 'core_unavailable',
      });
    };
    const waiting = pendingStore.ready;
    client.emit('failed', 'spawn');
    await expect(waiting).rejects.toMatchObject({ code: 'core_unavailable' });
    expect(methods()).toEqual([]);
    await expect(pendingStore.ready).rejects.toMatchObject({ code: 'core_unavailable' });
    expect(methods()).toEqual(['safe_pending.list']);
  });

  test('with no core attached, ready loads at once', async () => {
    seed({ 9: entry('0x09') });
    await pendingStore.ready;
    expect(pendingStore.getPending(9)).toEqual(entry('0x09'));
    // Loaded: the next wait asks nothing.
    await pendingStore.ready;
    expect(methods()).toEqual(['safe_pending.list', 'safe_pending.get']);
  });

  test("a Safe forgotten while a load is out (its deletion) isn't brought back by that load", async () => {
    seed({ 5: entry('0x05') });
    await pendingStore.ready;
    const gate = deferred();
    pendingSim.fail = (method) => (method === 'safe_pending.get' ? gate.promise : undefined);
    const client = fakeClient();
    pendingStore.attachCore(client);
    client.emit('ready');
    await flush();
    expect(methods().at(-1)).toBe('safe_pending.get');
    pendingStore.forgetPending(5);
    gate.resolve();
    await flush();
    expect(pendingStore.getPending(5)).toBeNull();
  });
});

describe('writes', () => {
  test("a set reaches the copy only once the core has answered it, as the very object set, in the reference's text", async () => {
    await pendingStore.ready;
    pendingSim.calls = [];
    const gate = deferred();
    pendingSim.fail = () => gate.promise;
    const value = entry('0x05');
    const setting = pendingStore.setPending(5, value);
    await flush();
    expect(pendingStore.getPending(5)).toBeNull();
    gate.resolve();
    await setting;
    expect(pendingStore.getPending(5)).toBe(value);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(JSON.stringify({ 5: value }, null, 2));
    expect(pendingSim.calls).toEqual([['safe_pending.set', { index: 5, entry: value }]]);

    await pendingStore.clearPending(5);
    expect(pendingStore.getPending(5)).toBeNull();
    expect(fs.readFileSync(file(), 'utf-8')).toBe('{}');
  });

  test('writes go to the core one at a time, in the order made', async () => {
    await pendingStore.ready;
    const gate = deferred();
    const order = [];
    pendingSim.fail = async (method, params) => {
      order.push(`start ${method} ${params.index}`);
      if (params.index === 5) await gate.promise;
    };
    const first = pendingStore.setPending(5, entry('0x05'));
    const second = pendingStore.clearPending(6);
    await flush();
    expect(order).toEqual(['start safe_pending.set 5']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['start safe_pending.set 5', 'start safe_pending.clear 6']);
  });

  test('a set the core reports failed throws, and the index is read again from the core as a new object, the store as it was', async () => {
    seed({ 5: entry('0x05') });
    await pendingStore.ready;
    const held = pendingStore.getPending(5);
    const before = fs.readFileSync(file(), 'utf-8');
    pendingSim.fail = (method) => {
      if (method === 'safe_pending.set') throw storage();
    };
    // A caller adds to the entry in place, as the signature loops do.
    held.signatures = [{ signer: '0xA', data: '0x01' }];
    await expect(pendingStore.setPending(5, held)).rejects.toMatchObject({ code: 'storage' });
    const now = pendingStore.getPending(5);
    expect(now).not.toBe(held);
    expect(now).toEqual(entry('0x05'));
    expect(methods().slice(-2)).toEqual(['safe_pending.set', 'safe_pending.get']);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(before);
  });

  test("a failed write whose read can't be answered falls back to the entry the core last confirmed, as a new object", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await pendingStore.setPending(5, entry('0x05'));
    const held = pendingStore.getPending(5);
    pendingSim.fail = () => {
      throw Object.assign(new Error('The identity core is not running'), {
        code: 'core_unavailable',
      });
    };
    held.superseded = true;
    await expect(pendingStore.setPending(5, held)).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(pendingStore.getPending(5)).not.toBe(held);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
    expect(warn).toHaveBeenCalledWith(
      '[SafePending] A pending Safe transaction could not be read again (core_unavailable):',
      'The identity core is not running'
    );
    // A new SafeTx main never had confirmed: nothing.
    await expect(pendingStore.setPending(6, entry('0x06'))).rejects.toMatchObject({
      code: 'core_unavailable',
    });
    expect(pendingStore.getPending(6)).toBeNull();
  });

  test('a clear the core reports failed throws, and the entry stays, read again as a new object', async () => {
    await pendingStore.setPending(5, entry('0x05'));
    const held = pendingStore.getPending(5);
    pendingSim.fail = (method) => {
      if (method === 'safe_pending.clear') throw storage();
    };
    await expect(pendingStore.clearPending(5)).rejects.toMatchObject({ code: 'storage' });
    expect(pendingStore.getPending(5)).not.toBe(held);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  test("on a core that didn't take the store every request fails requirement_unmet, and nothing is written", async () => {
    pendingSim.moved = false;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(pendingStore.setPending(5, entry('0x05'))).rejects.toMatchObject({
      code: 'requirement_unmet',
    });
    await expect(pendingStore.clearPending(5)).rejects.toMatchObject({ code: 'requirement_unmet' });
    await expect(pendingStore.ready).rejects.toMatchObject({ code: 'requirement_unmet' });
    expect(fs.existsSync(file())).toBe(false);
    expect(pendingStore.getPending(5)).toBeNull();
  });

  // Codex round 3 on #1298: a write goes only over the entry its caller read,
  // checked right before it is sent. Two writes of one index don't race to
  // the last word: the second, made over the entry the first replaced, is
  // refused.
  describe('a write queued behind another of the same index', () => {
    beforeEach(async () => {
      seed({ 5: entry('0x05') });
      await pendingStore.ready;
      pendingSim.calls = [];
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    const failFirstSet = () => {
      let sets = 0;
      pendingSim.fail = (method) => {
        if (method === 'safe_pending.set' && ++sets === 1) throw storage();
      };
    };

    test('a set, after one that failed and read the entry again: refused, unsent', async () => {
      const held = pendingStore.getPending(5);
      failFirstSet();
      const first = pendingStore.setPending(5, entry('0x05', [{ signer: '0xA', data: '0x01' }]));
      const second = pendingStore.setPending(5, entry('0x05', [{ signer: '0xB', data: '0x02' }]));
      await expect(first).rejects.toMatchObject({ code: 'storage' });
      await expect(second).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(methods()).toEqual(['safe_pending.set', 'safe_pending.get']);
      expect(pendingStore.getPending(5)).not.toBe(held);
      expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
      expect(JSON.parse(pendingSim.text())).toEqual({ 5: entry('0x05') });
    });

    test('a clear, after a set that failed and read the entry again: refused, unsent', async () => {
      failFirstSet();
      const first = pendingStore.setPending(5, entry('0x55'));
      const second = pendingStore.clearPending(5);
      await expect(first).rejects.toMatchObject({ code: 'storage' });
      await expect(second).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(methods()).toEqual(['safe_pending.set', 'safe_pending.get']);
      expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
    });

    test('a set or a clear, after a set that replaced the entry: refused, unsent', async () => {
      const replacement = entry('0x56');
      const first = pendingStore.setPending(5, replacement);
      const second = pendingStore.setPending(5, entry('0x57'));
      const third = pendingStore.clearPending(5);
      await first;
      await expect(second).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      await expect(third).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(methods()).toEqual(['safe_pending.set']);
      expect(pendingStore.getPending(5)).toBe(replacement);
    });

    test('the same object written again, in turn, goes: each write is over the entry it read', async () => {
      const held = pendingStore.getPending(5);
      held.signatures = [{ signer: '0xA', data: '0x01' }];
      const first = pendingStore.setPending(5, held);
      held.superseded = true;
      const second = pendingStore.setPending(5, held);
      await Promise.all([first, second]);
      expect(methods()).toEqual(['safe_pending.set', 'safe_pending.set']);
      expect(pendingStore.getPending(5)).toBe(held);
    });
  });

  test('a write that may not survive a power loss is applied, and logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const set = pendingSim.safePending.set;
    pendingSim.safePending.set = async (...args) => ({ ...(await set(...args)), durable: false });
    try {
      await pendingStore.setPending(5, entry('0x05'));
    } finally {
      pendingSim.safePending.set = set;
    }
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
    expect(warn).toHaveBeenCalledWith(
      '[SafePending] A pending Safe transaction was saved, but it may not survive a power loss yet (the flush after the rename failed)'
    );
  });
});

// Codex round 1 on #1298: the copy is one core process's. From an exit (or
// a new `ready`) until that process's load succeeds, nothing reads or acts
// on it; an entry keeps its object only where the reload confirms it.
describe('each core process', () => {
  const sig = (n) => ({ signer: `0x${n}`, data: '0x01' });
  let client;
  beforeEach(async () => {
    seed({ 5: entry('0x05'), 6: entry('0x06') });
    client = fakeClient();
    pendingStore.attachCore(client);
    client.emit('ready');
    await pendingStore.ready;
    pendingSim.calls = [];
  });
  const gateList = () => {
    const gate = deferred();
    pendingSim.fail = (method) => (method === 'safe_pending.list' ? gate.promise : undefined);
    return gate;
  };
  const settledYet = (promise) => {
    const state = { settled: false };
    promise.then(
      () => (state.settled = true),
      () => (state.settled = true)
    );
    return state;
  };

  test("an exit makes the copy unavailable at once; the next process's load gates ready and every write, and confirms what it keeps", async () => {
    const five = pendingStore.getPending(5);
    const six = pendingStore.getPending(6);
    client.emit('exit');
    expect(pendingStore.getPending(5)).toBeNull();
    expect(pendingStore.listPendingIndexes()).toEqual([]);
    const waiting = settledYet(pendingStore.ready);
    const writing = pendingStore.setPending(7, entry('0x07'));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(pendingSim.calls).toEqual([]);

    const gate = gateList();
    client.emit('ready');
    // Written meanwhile (a lost answer's write): the next load finds it.
    seed({ 5: entry('0x05'), 6: entry('0x66') });
    await flush();
    expect(waiting.settled).toBe(false);
    expect(pendingStore.getPending(5)).toBeNull();
    expect(methods()).toEqual(['safe_pending.list']);

    gate.resolve();
    await pendingStore.ready;
    await writing;
    expect(waiting.settled).toBe(true);
    // Confirmed as it was: the same object. Changed: a new one.
    expect(pendingStore.getPending(5)).toBe(five);
    expect(pendingStore.getPending(6)).not.toBe(six);
    expect(pendingStore.getPending(6)).toEqual(entry('0x66'));
    expect(pendingStore.getPending(7)).toEqual(entry('0x07'));
    expect(methods()).toEqual([
      'safe_pending.list',
      'safe_pending.get',
      'safe_pending.get',
      'safe_pending.set',
    ]);
  });

  test('a new ready with no exit seen makes the copy unavailable until its own load', async () => {
    const gate = gateList();
    client.emit('ready');
    expect(pendingStore.getPending(5)).toBeNull();
    const waiting = settledYet(pendingStore.ready);
    await flush();
    expect(waiting.settled).toBe(false);
    gate.resolve();
    await pendingStore.ready;
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  test("an entry changed in place and never confirmed isn't kept by the reload: the core's is a new object", async () => {
    const held = pendingStore.getPending(5);
    held.signatures = [sig(1)];
    client.emit('exit');
    client.emit('ready');
    await pendingStore.ready;
    expect(pendingStore.getPending(5)).not.toBe(held);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  test('a process whose load fails leaves everything stopped until a load succeeds', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    client.emit('exit');
    pendingSim.moved = false;
    client.emit('ready');
    await expect(pendingStore.ready).rejects.toMatchObject({ code: 'requirement_unmet' });
    expect(pendingStore.getPending(5)).toBeNull();
    expect(pendingStore.listPendingIndexes()).toEqual([]);
    await expect(pendingStore.setPending(5, entry('0x55'))).rejects.toMatchObject({
      code: 'requirement_unmet',
    });
    await expect(pendingStore.clearPending(5)).rejects.toMatchObject({ code: 'requirement_unmet' });
    expect(methods().filter((method) => method !== 'safe_pending.list')).toEqual([]);
    expect(pendingSim.text()).toBe(JSON.stringify({ 5: entry('0x05'), 6: entry('0x06') }, null, 2));
    pendingSim.moved = true;
    await pendingStore.ready;
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  // Codex round 2 on #1298: a write queued under the old process.
  describe('a write queued before the process changed', () => {
    const coreDown = () =>
      Object.assign(new Error('The identity core is not running'), { code: 'core_unavailable' });
    let failFirst;
    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      // The first write, of index 6, held in the core until the process ends.
      const held = new Promise((_resolve, reject) => {
        failFirst = reject;
      });
      held.catch(() => {});
      pendingSim.fail = (method, params) =>
        method === 'safe_pending.set' && params.index === 6 ? held : undefined;
    });
    async function restartWith(store) {
      client.emit('exit');
      seed(store);
      client.emit('ready');
      failFirst(coreDown());
    }

    test("a set waits for the successor's load, and never writes over its different entry", async () => {
      const first = pendingStore.setPending(6, entry('0x66'));
      const held = pendingStore.getPending(5);
      held.signatures = [sig(1)];
      const second = pendingStore.setPending(5, held);
      await flush();
      expect(methods()).toEqual(['safe_pending.set']);
      await restartWith({ 5: entry('0x55'), 6: entry('0x06') });
      await expect(first).rejects.toMatchObject({ code: 'core_unavailable' });
      await expect(second).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(methods()).toEqual([
        'safe_pending.set',
        'safe_pending.get',
        'safe_pending.list',
        'safe_pending.get',
        'safe_pending.get',
      ]);
      expect(JSON.parse(pendingSim.text())[5]).toEqual(entry('0x55'));
      expect(pendingStore.getPending(5)).toEqual(entry('0x55'));
    });

    test("a set over an entry the successor's load kept goes, after that load", async () => {
      const first = pendingStore.setPending(6, entry('0x66'));
      const second = pendingStore.setPending(5, entry('0x57'));
      await flush();
      await restartWith({ 5: entry('0x05'), 6: entry('0x06') });
      await expect(first).rejects.toMatchObject({ code: 'core_unavailable' });
      await second;
      expect(methods()).toEqual([
        'safe_pending.set',
        'safe_pending.get',
        'safe_pending.list',
        'safe_pending.get',
        'safe_pending.get',
        'safe_pending.set',
      ]);
      expect(pendingStore.getPending(5)).toEqual(entry('0x57'));
    });

    test("a clear waits for the successor's load, and never clears its different entry", async () => {
      const first = pendingStore.setPending(6, entry('0x66'));
      const second = pendingStore.clearPending(5);
      await flush();
      await restartWith({ 5: entry('0x55'), 6: entry('0x06') });
      await expect(first).rejects.toMatchObject({ code: 'core_unavailable' });
      await expect(second).rejects.toMatchObject({ code: 'SAFE_DISCARDED' });
      expect(methods()).not.toContain('safe_pending.clear');
      expect(JSON.parse(pendingSim.text())[5]).toEqual(entry('0x55'));
    });
  });

  test("an older process's load that fails after a newer ready doesn't fail the newer one's wait", async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let failOld;
    const old = new Promise((_resolve, reject) => {
      failOld = reject;
    });
    old.catch(() => {});
    let lists = 0;
    pendingSim.fail = (method) =>
      method === 'safe_pending.list' && ++lists === 1 ? old : undefined;
    client.emit('ready');
    const waiting = pendingStore.ready;
    client.emit('ready');
    failOld(
      Object.assign(new Error('The identity core is not running'), { code: 'core_unavailable' })
    );
    await expect(waiting).resolves.toBeUndefined();
    expect(lists).toBe(2);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
  });

  describe('a write the core applied and then lost the answer to', () => {
    const lose = (method) => {
      pendingSim.loseReply = (called) => called === method;
    };
    const failReads = () => {
      pendingSim.fail = (method) => {
        if (method === 'safe_pending.get') {
          throw Object.assign(new Error('The identity core is not running'), {
            code: 'core_unavailable',
          });
        }
      };
    };
    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      pendingSim.loseReply = null;
    });

    test('a set: it throws, and the entry is the one the core read back, a new object', async () => {
      const held = pendingStore.getPending(5);
      held.signatures = [sig(1)];
      lose('safe_pending.set');
      await expect(pendingStore.setPending(5, held)).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      const now = pendingStore.getPending(5);
      expect(now).not.toBe(held);
      expect(now).toEqual(entry('0x05', [sig(1)]));
      expect(methods()).toEqual(['safe_pending.set', 'safe_pending.get']);
    });

    test("a set whose read back fails: the last confirmed entry, new, until the restart's load gives the core's, new again", async () => {
      const held = pendingStore.getPending(5);
      held.signatures = [sig(1)];
      lose('safe_pending.set');
      failReads();
      await expect(pendingStore.setPending(5, held)).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      const fallback = pendingStore.getPending(5);
      expect(fallback).not.toBe(held);
      expect(fallback).toEqual(entry('0x05'));
      client.emit('exit');
      expect(pendingStore.getPending(5)).toBeNull();
      pendingSim.fail = null;
      client.emit('ready');
      await pendingStore.ready;
      const reloaded = pendingStore.getPending(5);
      expect(reloaded).not.toBe(held);
      expect(reloaded).not.toBe(fallback);
      expect(reloaded).toEqual(entry('0x05', [sig(1)]));
    });

    test('a clear: it throws, and the entry is gone, as the core read it back', async () => {
      lose('safe_pending.clear');
      await expect(pendingStore.clearPending(5)).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      expect(pendingStore.getPending(5)).toBeNull();
      expect(pendingStore.listPendingIndexes()).toEqual([6]);
    });

    test("a clear whose read back fails: the entry as last confirmed, new, until the restart's load drops it", async () => {
      const held = pendingStore.getPending(5);
      lose('safe_pending.clear');
      failReads();
      await expect(pendingStore.clearPending(5)).rejects.toMatchObject({
        code: 'core_unavailable',
      });
      expect(pendingStore.getPending(5)).not.toBe(held);
      expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
      client.emit('exit');
      pendingSim.fail = null;
      client.emit('ready');
      await pendingStore.ready;
      expect(pendingStore.getPending(5)).toBeNull();
      expect(pendingStore.listPendingIndexes()).toEqual([6]);
    });
  });
});

describe("a deleted Safe's entry", () => {
  test('forgetPending drops it from the copy, asking the core nothing; refreshPending reads it again', async () => {
    await pendingStore.setPending(5, entry('0x05'));
    pendingSim.calls = [];
    pendingStore.forgetPending(5);
    expect(pendingStore.getPending(5)).toBeNull();
    expect(pendingSim.calls).toEqual([]);
    // Still the core's (its removal failed before the clear): read again.
    await pendingStore.refreshPending(5);
    expect(pendingStore.getPending(5)).toEqual(entry('0x05'));
    expect(methods()).toEqual(['safe_pending.get']);
  });
});
