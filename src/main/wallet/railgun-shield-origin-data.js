/** Compare supplied own-Shield origin data only. A match authenticates no owner,
 * journal, chain, source, eligibility or recipient authority. No controller uses
 * this diagnostic; a future host must acquire and reattest genuine evidence.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { getAddress, toBeHex } = require('ethers');
const { inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const { validRailgunShieldResolution } = require('./railgun-shield-resolution');
const { checkpointHash } = require('./railgun-wallet-coverage');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const result = (status) =>
  Object.freeze({
    status,
    trust: 'supplied-data',
    ownershipAuthenticated: false,
    canonicalityVerified: false,
    spendingEnabled: false,
    poiBypassEnabled: false,
  });
// Snapshot bounded plain data without executing supplied getters/iterators.
function snapshot(input) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  function copy(value, depth) {
    assert.ok(++nodes <= 300000 && depth <= 16);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      assert.ok(Number.isSafeInteger(value));
      return value;
    }
    if (typeof value === 'bigint') {
      assert.ok(value >= 0n && value < 1n << 256n);
      return value;
    }
    if (typeof value === 'string') {
      bytes += value.length * 2;
      assert.ok(value.length <= 262144 && bytes <= 8 * 1024 * 1024);
      return value;
    }
    assert.ok(value && typeof value === 'object' && !isProxy(value) && !seen.has(value));
    const array = Array.isArray(value);
    assert.equal(Object.getPrototypeOf(value), array ? Array.prototype : Object.prototype);
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    assert.ok(keys.length <= 10001);
    const output = array ? [] : {};
    if (array) {
      assert.ok(value.length <= 10000);
      assert.deepEqual(keys, [...Array(value.length).keys()].map(String).concat('length'));
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      assert.equal(typeof key, 'string');
      bytes += key.length * 2;
      assert.ok(key.length <= 256 && bytes <= 8 * 1024 * 1024);
      assert.ok(key !== '__proto__');
      const descriptor = descriptors[key];
      assert.ok(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      output[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return output;
  }
  return copy(input, 0);
}
function matchRailgunShieldOrigin(input) {
  try {
    const value = snapshot(input);
    assert.deepEqual(Object.keys(value).sort(), [
      'checkpoint',
      'owned',
      'receipt',
      'record',
      'submitter',
      'transaction',
    ]);
    const { record, transaction, receipt, owned, checkpoint } = value;
    for (const address of [value.submitter, transaction.from, receipt.from])
      assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    const submitter = getAddress(value.submitter).toLowerCase();
    assert.ok(BigInt(submitter) > 0n);
    assert.equal(getAddress(transaction.from).toLowerCase(), submitter);
    assert.equal(getAddress(receipt.from).toLowerCase(), submitter);
    // Active journal records only: archive has a different schema and freshness.
    assert.ok(['attempted', 'submitted'].includes(record.state));
    assert.ok(integer(record.attemptedAt) && integer(record.revision) && record.revision > 0);
    assert.ok(integer(record.nonce));
    assert.equal(record.observation.status, 'included');
    assert.equal(record.observation.trust, 'unverified');
    assert.ok(integer(record.observation.observedAt));
    assert.ok(integer(record.observation.blockNumber));
    assert.ok(integer(record.observation.confirmations));
    assert.ok(
      integer(record.resolution.minimumConfirmations) && record.resolution.minimumConfirmations >= 3
    );
    assert.ok(record.observation.confirmations >= record.resolution.minimumConfirmations);
    assert.ok(integer(record.resolution.reviewedAt));
    assert.equal(record.resolution.blockHash, record.observation.blockHash);
    const retained = record.resolution.railgun;
    assert.equal(retained.outcome, 'matched');
    assert.ok(validRailgunShieldResolution(retained, record));
    const shield = inspectRailgunShieldReceipt(record, transaction, receipt);
    assert.equal(shield.status, 'matched');
    assert.equal(shield.feeDeviation, false);
    assert.deepEqual(shield, retained.shield);
    assert.equal(shield.blockHash, record.observation.blockHash);
    assert.equal(BigInt(shield.blockNumber), BigInt(record.observation.blockNumber));
    assert.equal(shield.token, pins.wrappedNative);
    // Canonical checkpoint hashing checks its full normalized structure, but
    // cannot establish that a genuine coordinator ever issued this data.
    assert.ok(digest(owned.checkpointHash));
    assert.equal(checkpointHash(checkpoint), owned.checkpointHash);
    assert.ok(checkpoint.to.number >= Number(BigInt(shield.blockNumber)));
    assert.ok(checkpoint.anchor.number >= retained.finalizedBlockNumber);
    if (checkpoint.to.number === Number(BigInt(shield.blockNumber)))
      assert.equal(checkpoint.to.hash, shield.blockHash);
    if (checkpoint.anchor.number === retained.finalizedBlockNumber)
      assert.equal(checkpoint.anchor.hash, retained.finalizedBlockHash);
    assert.deepEqual(owned.trees, checkpoint.state.trees);
    const id = `${shield.tree}:${shield.position}`;
    assert.ok(Array.isArray(owned.read.received) && Array.isArray(owned.ownedPoi));
    assert.equal(owned.read.received.length, owned.ownedPoi.length);
    assert.equal(
      new Set(owned.read.received.map((note) => note.id)).size,
      owned.read.received.length
    );
    assert.equal(new Set(owned.ownedPoi.map((note) => note.id)).size, owned.ownedPoi.length);
    const notes = owned.read.received.filter((note) => note.id === id);
    const records = owned.ownedPoi.filter((note) => note.id === id);
    assert.equal(notes.length, 1);
    assert.equal(records.length, 1);
    const note = notes[0],
      creator = records[0];
    assert.equal(note.tree, shield.tree);
    assert.equal(note.position, shield.position);
    assert.ok(note.position < owned.trees[note.tree].length);
    assert.equal(note.txid, shield.transactionHash);
    assert.equal(creator.txid, note.txid);
    assert.equal(creator.type, 'Shield');
    assert.equal(creator.blockNumber, record.observation.blockNumber);
    assert.equal(creator.npk, shield.npk);
    assert.ok(
      field(creator.npk) &&
        field(creator.hash) &&
        field(creator.nullifier) &&
        field(creator.blindedCommitment)
    );
    assert.equal(note.hash, creator.hash);
    assert.equal(note.spentTxid, false);
    assert.equal(note.tag, 'unverified');
    assert.equal(typeof note.amount, 'bigint');
    assert.equal(note.amount.toString(), shield.noteValue);
    assert.ok(note.amount > 0n && note.amount <= BigInt(pins.maxQualificationAmount));
    assert.deepEqual(note.asset, { __type: 'erc20', contract: pins.wrappedNative });
    assert.equal(note.tokenHash, toBeHex(BigInt(pins.wrappedNative), 32));
    return result('matched');
  } catch {
    return result('refused');
  }
}
module.exports = { matchRailgunShieldOrigin };
