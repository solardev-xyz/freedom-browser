/** Completed, host-supplied data only. This restricted synchronous host is not
 * Kohaku's generic Host or a Freedom ownership/spending authority. Callbacks are
 * trusted application code; their returned snapshot data is bounded and copied.
 */
const assert = require('assert/strict');
const { isProxy, isAsyncFunction, isPromise } = require('util').types;
const { dispatchRailgunKohakuRead } = require('./railgun-kohaku-read-dispatch');
const {
  normalizeRailgunKohakuReadFilter,
  projectRailgunKohakuBalance,
  projectRailgunKohakuNotes,
} = require('./railgun-kohaku-read-data');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Kohaku snapshot read unavailable'), {
    code: 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED',
  });
function shape(value, keys) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function synchronous(fn) {
  assert.equal(typeof fn, 'function');
  assert.ok(!isProxy(fn) && !isAsyncFunction(fn));
}
function syncResult(value) {
  // A contract-violating native Promise is observed only to avoid an unhandled
  // rejection. It is never awaited or advertised as drained by this adapter.
  if (isPromise(value)) {
    Promise.prototype.then.call(value, undefined, () => {});
    throw fail();
  }
  return value;
}
function hash(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^0x[0-9a-f]{64}$/);
  return value;
}
// This validates read-data shape, not tokenHash preimages or ownership.
function snapshotData(snapshot) {
  shape(snapshot, ['instanceId', 'received']);
  assert.equal(typeof snapshot.instanceId, 'string');
  assert.match(snapshot.instanceId, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  const values = snapshot.received;
  assert.ok(
    Array.isArray(values) &&
      !isProxy(values) &&
      Object.getPrototypeOf(values) === Array.prototype &&
      values.length <= 10000
  );
  assert.equal(Reflect.ownKeys(values).length, values.length + 1);
  const positions = new Set(),
    received = [];
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
    const note = descriptor.value;
    shape(note, [
      'id',
      'tree',
      'position',
      'txid',
      'hash',
      'tokenHash',
      'asset',
      'amount',
      'tag',
      'spentTxid',
    ]);
    for (const value of [note.tree, note.position])
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    // Completed coverage is bounded by at most 256 public trees of 65536 leaves.
    assert.ok(note.tree < 256 && note.position < 65536);
    const previous = received.at(-1);
    assert.ok(
      !previous ||
        previous.tree < note.tree ||
        (previous.tree === note.tree && previous.position < note.position)
    );
    assert.equal(note.id, `${note.tree}:${note.position}`);
    assert.ok(!positions.has(note.id));
    positions.add(note.id);
    assert.equal(typeof note.amount, 'bigint');
    assert.ok(note.amount >= 0n && note.amount < 1n << 120n);
    assert.equal(note.tag, 'unverified');
    const asset = note.asset;
    assert.ok(asset && !isProxy(asset));
    const kind = Object.getOwnPropertyDescriptor(asset, '__type');
    assert.ok(kind && Object.hasOwn(kind, 'value'));
    assert.ok(['native', 'erc20', 'erc721', 'erc1155'].includes(kind.value));
    const keys = kind.value === 'native' ? ['__type'] : ['__type', 'contract'];
    if (['erc721', 'erc1155'].includes(kind.value)) keys.push('tokenId');
    shape(asset, keys);
    if (kind.value !== 'native') assert.match(asset.contract, /^0x[0-9a-f]{40}$/);
    if (keys.includes('tokenId')) {
      assert.equal(typeof asset.tokenId, 'bigint');
      assert.ok(asset.tokenId >= 0n && asset.tokenId < 1n << 256n);
    }
    if (kind.value === 'erc721') assert.equal(note.amount, 1n);
    // Copy the validated fields explicitly: own data properties need not be
    // enumerable, so object spread could silently erase an asset discriminator.
    const copiedAsset = { __type: kind.value };
    if (kind.value !== 'native') copiedAsset.contract = asset.contract;
    if (keys.includes('tokenId')) copiedAsset.tokenId = asset.tokenId;
    assert.ok(BigInt(hash(note.hash)) < FIELD);
    received.push(
      Object.freeze({
        id: note.id,
        tree: note.tree,
        position: note.position,
        txid: hash(note.txid),
        hash: note.hash,
        tokenHash: hash(note.tokenHash),
        asset: Object.freeze(copiedAsset),
        amount: note.amount,
        tag: 'unverified',
        spentTxid: note.spentTxid === false ? false : hash(note.spentTxid),
      })
    );
  }
  return Object.freeze({ instanceId: snapshot.instanceId, received: Object.freeze(received) });
}
function detached(values) {
  return values.map((value) => ({ ...value, asset: { ...value.asset } }));
}
function createRailgunKohakuSnapshotPlugin(options) {
  try {
    shape(options, ['host', 'signal']);
    shape(options.host, ['capture', 'signal']);
    const { host, signal } = options;
    const capture = host.capture,
      hostSignal = host.signal;
    synchronous(capture);
    assert.ok(signal instanceof AbortSignal && hostSignal instanceof AbortSignal);
    assert.ok(!signal.aborted && !hostSignal.aborted);
    const lifetime = AbortSignal.any([signal, hostSignal]),
      controller = new AbortController();
    const work = new Set();
    let closed = false,
      admissions = 0,
      resolveClosed;
    const drained = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const current = () => {
      assert.ok(!closed && !lifetime.aborted);
    };
    function finish() {
      if (!closed || admissions || work.size) return;
      lifetime.removeEventListener('abort', close);
      resolveClosed();
    }
    function close() {
      if (!closed) {
        closed = true;
        controller.abort();
      }
      finish();
    }
    const ports = Object.freeze({
      capture() {
        current();
        const captured = syncResult(capture.call(host));
        shape(captured, ['snapshot', 'assertCurrent']);
        const recheck = captured.assertCurrent;
        synchronous(recheck);
        const data = snapshotData(captured.snapshot);
        current();
        return {
          recheck: () => {
            // Exact undefined excludes custom thenables without invoking them.
            assert.equal(syncResult(recheck.call(captured)), undefined);
          },
          view: {
            instanceId: () => data.instanceId,
            balance: (assets) =>
              detached(
                projectRailgunKohakuBalance(data.received, normalizeRailgunKohakuReadFilter(assets))
              ),
            notes: (assets, includeSpent = false) =>
              detached(
                projectRailgunKohakuNotes(
                  data.received,
                  normalizeRailgunKohakuReadFilter(assets),
                  includeSpent
                )
              ),
          },
        };
      },
      recheck(captured) {
        current();
        captured.recheck();
        current();
      },
      retain(pending) {
        work.add(pending);
        const settled = () => {
          work.delete(pending);
          finish();
        };
        pending.then(settled, settled);
        return pending;
      },
      refused: fail,
    });
    const read = (method, args) => {
      // Admission precedes trusted callbacks, including reentrant close during
      // capture or projection, before the dispatcher can retain a Promise.
      admissions++;
      const pending = dispatchRailgunKohakuRead(ports, method, args);
      const settled = () => {
        admissions--;
        finish();
      };
      pending.then(settled, settled);
      return pending;
    };
    const plugin = Object.freeze({
      instanceId: () => read('instanceId', []),
      balance: (assets) => read('balance', [assets]),
      notes: (assets, includeSpent) => read('notes', [assets, includeSpent]),
      provenance: 'host-supplied',
      signal: controller.signal,
      close,
      closed: drained,
    });
    lifetime.addEventListener('abort', close, { once: true });
    if (lifetime.aborted) close();
    return plugin;
  } catch {
    throw fail();
  }
}
module.exports = { createRailgunKohakuSnapshotPlugin };
