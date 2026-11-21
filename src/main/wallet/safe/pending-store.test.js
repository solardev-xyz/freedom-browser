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
  Object.assign(pendingSim, { moved: true, fail: null, calls: [] });
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

  test('a core that fails to start settles the first load; ready then tries its own', async () => {
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
