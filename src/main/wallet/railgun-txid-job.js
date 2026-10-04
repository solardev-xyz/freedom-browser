/** Guarded public TXID computation. Main owns the page, apply window and root
 * validation. The utility receives only a bounded store broker, never a path,
 * encryption key, account secret, network endpoint or signing capability.
 */
const assert = require('assert/strict'),
  path = require('path');
const { createHash } = require('crypto');
const { createRequire } = require('module');
const { promisify } = require('util');
async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'mode']);
  assert.ok(
    [
      'project',
      'apply',
      'witness',
      'note-witness',
      'historical-root',
      'inspect',
      'coverage',
    ].includes(input.mode)
  );
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: (a, b) => poseidonHex([a, b]),
    transactionHash: createRailgunTransactionWithHash,
    verificationHash: calculateRailgunTransactionVerificationHash,
    zeroNodes: require('./railgun-public-records').ZERO_NODES,
  });
  let sequence = 0;
  const call = async (message) => {
    assert.ok(!signal.aborted);
    const id = ++sequence;
    const reply = JSON.parse(await request(JSON.stringify({ ...message, id })));
    assert.equal(reply.id, id);
    assert.deepEqual(Object.keys(reply).sort(), ['id', 'value']);
    return reply.value;
  };
  const payload = await call({ method: 'input' });
  assert.ok(payload && Buffer.byteLength(JSON.stringify(payload)) <= 2 * 1024 * 1024 - 128);
  const remote = require('./railgun-remote').createRailgunRemote({
    ...r('abstract-leveldown'),
    signal,
    send: async (wire) => {
      const { id, method, args } = JSON.parse(wire);
      return JSON.stringify({ id, value: await call({ method, args }) });
    },
  });
  const db = remote.leveldown;
  await promisify(db.open.bind(db))();
  const get = promisify(db.get.bind(db)),
    batch = promisify(db.batch.bind(db));
  const read = async (key) => {
    try {
      return (await get(key)).toString('utf8');
    } catch (error) {
      if (error.notFound) return null;
      throw error;
    }
  };
  const stored = await read('txid:state');
  const current = stored === null ? projection.empty() : projection.inspect(JSON.parse(stored));
  // The existing authenticated whole-store observer caps records at 32,768.
  // Rows, lookups and Merkle nodes use fewer than 4*N+17 records. Keep this
  // initial durable mirror below that bound; larger histories need review.
  assert.ok(Number.isSafeInteger(current.count) && current.count >= 0 && current.count <= 8000);
  let value;
  if (input.mode === 'inspect') {
    assert.deepEqual(Object.keys(payload), []);
    value = { state: current, initialized: stored !== null };
  } else if (input.mode === 'coverage') {
    assert.deepEqual(Object.keys(payload).sort(), ['plan', 'state']);
    assert.deepEqual(current, payload.state);
    const ethers = r('ethers');
    const abi = new ethers.Interface(require(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')));
    value = {
      coverage: await require('./railgun-txid-coverage').compareRailgunTxidCoverage({
        state: current,
        plan: payload.plan,
        read,
        inspectRecord: projection.inspectRecord,
        nextBatch: () => call({ method: 'sourceNext' }),
        abi,
        ethers,
        qualifiedThrough: require('./railgun-public-policy').QUALIFIED_THROUGH,
      }),
    };
  } else if (input.mode === 'note-witness') {
    assert.deepEqual(Object.keys(payload).sort(), ['note', 'state']);
    assert.deepEqual(current, payload.state);
    value = {
      noteWitness: await require('./railgun-txid-note-witness').findRailgunNoteTxidWitness({
        state: current,
        note: payload.note,
        read,
        projection,
      }),
    };
  } else if (input.mode === 'witness') {
    assert.deepEqual(Object.keys(payload).sort(), ['state', 'txid']);
    assert.deepEqual(current, payload.state);
    value = { witness: await projection.witness(current, payload.txid, read) };
  } else if (input.mode === 'historical-root') {
    // The expected historical root stays in main. Compute only from the exact
    // authenticated current checkpoint and the requested prefix boundary.
    assert.deepEqual(Object.keys(payload).sort(), ['index', 'state']);
    assert.deepEqual(current, payload.state);
    assert.ok(
      Number.isSafeInteger(payload.index) &&
        payload.index >= 0 &&
        payload.index <= 7999 &&
        payload.index < current.count
    );
    value = { historicalRoot: await projection.historicalRoot(current, payload.index, read) };
  } else {
    assert.deepEqual(
      Object.keys(payload).sort(),
      input.mode === 'apply' ? ['base', 'expected', 'rows'] : ['base', 'rows']
    );
    assert.ok(
      Array.isArray(payload.rows) && payload.rows.length >= 1 && payload.rows.length <= 100
    );
    assert.ok(
      Number.isSafeInteger(payload.base?.count) &&
        payload.base.count >= 0 &&
        payload.base.count + payload.rows.length <= 8000
    );
    if (input.mode === 'apply' && JSON.stringify(current) === JSON.stringify(payload.expected)) {
      assert.equal(current.count, payload.base.count + payload.rows.length);
      // A crash after SQLite commit but before host-journal completion may
      // replay only the same rows at exactly the same positions and root.
      const replayLookups = new Set();
      for (let n = 0; n < payload.rows.length; n++) {
        const txid = createRailgunTransactionWithHash(payload.rows[n]).railgunTxid;
        const proof = await projection.witness(current, txid, read);
        assert.equal(proof.index, payload.base.count + n);
        assert.deepEqual(proof.row, payload.rows[n]);
        replayLookups.add('txid:lookup:' + txid);
      }
      // Recompute from the supplied base as well, binding its entire frontier,
      // cursor, continuity and transcript to the already committed result.
      const replay = await projection.append(payload.base, payload.rows, async (key) =>
        replayLookups.has(key) ? null : read(key)
      );
      assert.deepEqual(replay.state, current);
      value = { state: current, replayed: true };
    } else {
      assert.deepEqual(current, payload.base);
      const result = await projection.append(current, payload.rows, read);
      if (input.mode === 'apply') {
        assert.deepEqual(result.state, payload.expected);
        await remote.withTransaction(async () => {
          // The host grants this job exclusive store dispatch. Recheck before
          // the single atomic write group; no other job may mutate this store.
          assert.equal(await read('txid:state'), stored);
          await batch(result.writes.map(({ key, value }) => ({ type: 'put', key, value })));
        });
        assert.equal(await read('txid:state'), JSON.stringify(result.state));
      }
      value = { state: result.state, replayed: false };
    }
    value.pageSha256 = createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex');
  }
  value.guards = guardReport();
  value.inventory = require('./railgun-engine-manifest.json').inventory.sha256;
  assert.equal(value.guards.attempts, 0);
  assert.equal(await call({ method: 'result', value }), null);
}
module.exports = { run };
