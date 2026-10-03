/** Fixture-only UTXO workload measurement with a plaintext Map or --paged store.
 * Never imported by product code; holds only generated public synthetic data.
 * No quick-sync, RPC logs, wallet decryption, TXID tree or POI is exercised.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { createRequire } = require('module');
const { assertRailgunFixture } = require('./railgun-fixture-integrity');
const fixture = path.join(__dirname, 'fixtures/railgun-engine');
const r = createRequire(path.join(fixture, 'package.json'));
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
async function main() {
  const output = process.argv[2];
  assert.ok(output && path.isAbsolute(output) && !fs.existsSync(output));
  const paged = process.argv[3] === '--paged';
  let store, scope, storeOptions;
  const storageMetrics = { writes: 0, maxWriteMs: 0, maxOpenMs: 0, maxClearMs: 0 };
  const { createRailgunPagedStore } = require('../src/main/wallet/railgun-paged-store');
  const { createRailgunStoreCursor } = require('../src/main/wallet/railgun-store-cursor');
  if (paged) {
    const { createPrivacyScope } = require('../src/main/networks/privacy-context');
    scope = createPrivacyScope({
      profileId: 'synthetic-paged-volume',
      signal: new AbortController().signal,
    });
    storeOptions = {
      handle: scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'offline',
        chainId: 11155111,
        role: 'storage',
      }),
      filename: output + '.sqlite',
      key: Buffer.alloc(32, 47),
      binding: 'c'.repeat(64),
      onFatal: () => {},
    };
    store = createRailgunPagedStore({ ...storeOptions, create: true });
  }
  const inventory = assertRailgunFixture(path.join(fixture, 'node_modules'));
  const guard = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    onRefusal: () => process.exit(2),
  });
  const engine = path.dirname(r.resolve('@railgun-community/engine'));
  const { Database } = require(path.join(engine, 'database/database'));
  const { UTXOMerkletree } = require(path.join(engine, 'merkletree/utxo-merkletree'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(engine, 'utils/poseidon'));
  const { MERKLE_ZERO_VALUE } = require(path.join(engine, 'models/merkletree-types'));
  const { AbstractLevelDOWN, AbstractIterator } = r('abstract-leveldown');
  await initPoseidonPromise;
  const rangeOptions = (options) =>
    Object.fromEntries(
      Object.entries(options)
        .filter(([name]) =>
          ['gt', 'gte', 'lt', 'lte', 'limit', 'reverse', 'keys', 'values'].includes(name)
        )
        .map(([name, value]) => [
          name,
          ['gt', 'gte', 'lt', 'lte'].includes(name) ? Buffer.from(value) : value,
        ])
    );
  const values = new Map();
  let totalBytes = 0,
    openIterators = 0,
    batchActive = 0;
  const stats = {
    gets: 0,
    misses: 0,
    batches: [],
    peakBatchOverlap: 0,
    iterators: 0,
    peakIterators: 0,
    iteratorRows: 0,
    clears: 0,
    maxKeys: 0,
    maxBytes: 0,
  };
  const select = (options) => {
    let rows = [...values.values()]
      .filter(({ key }) =>
        ['gt', 'gte', 'lt', 'lte'].every((op) => {
          if (options[op] === undefined) return true;
          const n = Buffer.compare(key, Buffer.from(options[op]));
          return op === 'gt' ? n > 0 : op === 'gte' ? n >= 0 : op === 'lt' ? n < 0 : n <= 0;
        })
      )
      .sort((a, b) => Buffer.compare(a.key, b.key));
    if (options.reverse) rows.reverse();
    if (options.limit >= 0) rows = rows.slice(0, options.limit);
    return rows;
  };
  class Iterator extends AbstractIterator {
    constructor(db, options) {
      super(db);
      this.options = options;
      this.rows = paged ? [] : select(options);
      this.cursor = paged ? createRailgunStoreCursor(store, rangeOptions(options)) : null;
      this.index = 0;
      stats.iterators++;
      openIterators++;
      stats.peakIterators = Math.max(stats.peakIterators, openIterators);
    }
    _next(callback) {
      const pair = this.cursor?.next();
      const row = this.cursor ? pair && { key: pair[0], value: pair[1] } : this.rows[this.index++];
      if (row) stats.iteratorRows++;
      queueMicrotask(() =>
        row
          ? callback(
              null,
              this.options.keys === false
                ? undefined
                : this.options.keyAsBuffer === false
                  ? row.key.toString()
                  : Buffer.from(row.key),
              this.options.values === false
                ? undefined
                : this.options.valueAsBuffer === false
                  ? row.value.toString()
                  : Buffer.from(row.value)
            )
          : callback()
      );
    }
    _end(callback) {
      this.cursor?.close();
      this.rows = [];
      openIterators--;
      queueMicrotask(callback);
    }
  }
  class Memory extends AbstractLevelDOWN {
    constructor() {
      super({ snapshots: true, permanence: false });
    }
    _open(_options, callback) {
      queueMicrotask(callback);
    }
    _close(callback) {
      queueMicrotask(callback);
    }
    _get(key, options, callback) {
      stats.gets++;
      const value = paged ? store.get(Buffer.from(key)) : null;
      const row = paged
        ? value !== null && { value }
        : values.get(Buffer.from(key).toString('hex'));
      if (!row) stats.misses++;
      queueMicrotask(() =>
        row
          ? callback(
              null,
              options.asBuffer === false ? row.value.toString() : Buffer.from(row.value)
            )
          : callback(Object.assign(new Error('NotFound'), { notFound: true }))
      );
    }
    _put(key, value, options, callback) {
      this._batch([{ type: 'put', key, value }], options, callback);
    }
    _del(key, options, callback) {
      this._batch([{ type: 'del', key }], options, callback);
    }
    _batch(operations, _options, callback) {
      batchActive++;
      stats.peakBatchOverlap = Math.max(stats.peakBatchOverlap, batchActive);
      let bytes = 0;
      if (paged) {
        const start = performance.now();
        store.batch(
          operations.map(({ type, key, value }) =>
            type === 'del'
              ? { type, key: Buffer.from(key) }
              : { type, key: Buffer.from(key), value: Buffer.from(value) }
          )
        );
        storageMetrics.writes++;
        storageMetrics.maxWriteMs = Math.max(storageMetrics.maxWriteMs, performance.now() - start);
        const measured = store.stats();
        stats.maxKeys = Math.max(stats.maxKeys, measured.keys);
        stats.maxBytes = Math.max(stats.maxBytes, measured.bytes);
        totalBytes = measured.bytes;
        bytes = operations.reduce(
          (n, op) =>
            n + Buffer.byteLength(op.key) + (op.type === 'put' ? Buffer.byteLength(op.value) : 0),
          0
        );
        stats.batches.push({ operations: operations.length, bytes });
        queueMicrotask(() => {
          batchActive--;
          callback();
        });
        return;
      }
      for (const op of operations) {
        const key = Buffer.from(op.key),
          index = key.toString('hex'),
          old = values.get(index);
        totalBytes -= old ? old.key.length + old.value.length : 0;
        if (op.type === 'del') values.delete(index);
        else {
          const value = Buffer.from(op.value);
          values.set(index, { key, value });
          totalBytes += key.length + value.length;
          bytes += key.length + value.length;
        }
      }
      assert.ok(values.size <= 300000 && totalBytes <= 256 * 1024 * 1024, 'Fixture workload bound');
      stats.maxKeys = Math.max(stats.maxKeys, values.size);
      stats.maxBytes = Math.max(stats.maxBytes, totalBytes);
      stats.batches.push({ operations: operations.length, bytes });
      queueMicrotask(() => {
        batchActive--;
        callback();
      });
    }
    _iterator(options) {
      return new Iterator(this, options);
    }
    _clear(options, callback) {
      stats.clears++;
      if (paged) {
        const start = performance.now();
        store.clear(rangeOptions(options));
        storageMetrics.maxClearMs = Math.max(storageMetrics.maxClearMs, performance.now() - start);
        queueMicrotask(callback);
        return;
      }
      this._batch(
        select(options).map(({ key }) => ({ type: 'del', key })),
        {},
        callback
      );
    }
  }
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: 11155111 };
  function reference(start, count) {
    let nodes = Array.from({ length: count }, (_, i) => hex(start + i + 1)),
      zero = MERKLE_ZERO_VALUE;
    for (let level = 0; level < 16; level++) {
      const next = [];
      for (let i = 0; i < nodes.length; i += 2)
        next.push(poseidonHex([nodes[i], nodes[i + 1] ?? zero]));
      zero = poseidonHex([zero, zero]);
      nodes = next;
    }
    return nodes[0] ?? zero;
  }
  let expectedTree = 0,
    expectedLast = 0,
    expectedRoot;
  const validator = async (v, c, t, last, root) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(t, expectedTree);
    assert.equal(last, expectedLast);
    assert.equal(root, expectedRoot);
    return true;
  };
  const db = new Database(new Memory());
  const tree = await UTXOMerkletree.create(db, chain, version, validator);
  const checkpoints = [];
  let inserted = 0;
  for (const target of [1000, 10000, 70000]) {
    const start = performance.now(),
      firstBatch = stats.batches.length;
    while (inserted < target) {
      const t = Math.floor(inserted / 65536),
        index = inserted % 65536;
      const count = Math.min(10000, target - inserted, 65536 - index);
      expectedTree = t;
      expectedLast = index + count - 1;
      expectedRoot = reference(t * 65536, index + count);
      await tree.insertLeaves(
        t,
        index,
        Array.from({ length: count }, (_, i) => ({ hash: hex(inserted + i + 1), blockNumber: 1 }))
      );
      inserted += count;
    }
    // The optional encrypted backend is closed/reopened here; engine wrappers
    // also clear their caches. This remains one Node process, not supervision.
    if (paged) {
      store.close();
      const openStart = performance.now();
      store = createRailgunPagedStore(storeOptions);
      storageMetrics.maxOpenMs = Math.max(storageMetrics.maxOpenMs, performance.now() - openStart);
    }
    const coldDb = new Database(new Memory());
    const cold = await UTXOMerkletree.create(coldDb, chain, version, validator);
    const countStart = stats.iteratorRows,
      getStart = stats.gets;
    const trees = [];
    for (let t = 0; t <= Math.floor((target - 1) / 65536); t++) {
      const count = Math.min(65536, target - t * 65536);
      assert.equal(await cold.getTreeLength(t), count);
      assert.equal(await cold.getTreeLengthFromDBCount(t), count);
      const proof = await cold.getMerkleProof(t, count - 1);
      assert.equal(proof.root, reference(t * 65536, count));
      assert.equal(proof.leaf, hex(t * 65536 + count));
      let value = proof.leaf;
      proof.elements.forEach((sibling, level) => {
        value =
          ((count - 1) >> level) & 1
            ? poseidonHex([sibling, value])
            : poseidonHex([value, sibling]);
      });
      assert.equal(value, proof.root);
      trees.push({ tree: t, leaves: count, root: proof.root });
    }
    checkpoints.push({
      leaves: target,
      trees,
      keys: paged ? store.stats().keys : values.size,
      plaintextBytes: totalBytes,
      elapsedMs: Math.round(performance.now() - start),
      rssBytes: process.memoryUsage().rss,
      ...(paged
        ? {
            pages: store.stats().pages,
            directoryBytes: store.stats().directoryBytes,
            pageFill: store.stats().pageFill,
            fileBytes: fs.statSync(storeOptions.filename).size,
          }
        : {}),
      coldReads: stats.gets - getStart,
      countRows: stats.iteratorRows - countStart,
      batches: stats.batches.slice(firstBatch),
    });
    await coldDb.level.close();
  }
  const beforeClear = paged ? store.stats().keys : values.size;
  await tree.clearDataForMerkletree();
  assert.equal(paged ? store.stats().keys : values.size, 0);
  assert.equal(await tree.getTreeLength(0), 0);
  assert.equal(openIterators, 0);
  await db.level.close();
  store?.close();
  scope?.close();
  const egress = guard.report();
  assert.equal(egress.attempts, 0);
  const sources = [
    'scripts/measure-railgun-tree-storage.js',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-paged-store.js',
    'src/main/wallet/railgun-store-cursor.js',
    'scripts/fixtures/railgun-engine/runtime-integrity.json',
  ];
  const sourceSha256 = Object.fromEntries(
    sources.map((f) => [
      f,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', f)))
        .digest('hex'),
    ])
  );
  const report = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    inventory: inventory.sha256,
    sourceSha256,
    syntheticPublicData: true,
    storageFormat: paged ? 'paged-v2' : 'plaintext-map',
    ...(paged ? { storageMetrics } : {}),
    fullChainScan: false,
    checkpoints,
    stats,
    clearRemovedKeys: beforeClear,
    guards: egress.hooks.length,
    canaries: egress.canaries,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
