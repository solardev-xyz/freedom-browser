/** Bounded data-only comparison of a supplied own receipt with a complete source
 * prefix. Only a genuine coordinator may later attest the source. A match does
 * not authenticate receipt status, calldata, account ownership or chain finality.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { inspectRailgunTransactReceipt } = require('./railgun-transact-receipt');
const { checkpointHash } = require('./railgun-wallet-coverage');
const pins = require('./railgun-shield-pins.json');
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const quantity = (v) => {
  assert.ok(typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v));
  const number = Number(BigInt(v));
  assert.ok(integer(number));
  return number;
};
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
async function collect({ record, transaction, receipt, checkpoint, visit, assertCurrent }) {
  assert.ok(typeof visit === 'function' && typeof assertCurrent === 'function');
  const text = JSON.stringify({ record, transaction, receipt, checkpoint });
  assert.ok(Buffer.byteLength(text) <= 128 * 1024);
  const input = JSON.parse(text);
  const outcome = inspectRailgunTransactReceipt(input.record, input.transaction, input.receipt);
  assert.equal(outcome.status, 'matched');
  const eventCount = outcome.operation === 'railgun-partial-unshield' ? 3 : 2;
  const checkpointDigest = checkpointHash(input.checkpoint);
  const blockNumber = quantity(input.receipt.blockNumber);
  const transactionIndex = quantity(input.receipt.transactionIndex);
  assert.ok(blockNumber <= input.checkpoint.to.number);
  const expected = input.receipt.logs
    .filter((log) => log.address?.toLowerCase() === pins.proxy)
    .map((log) => ({
      address: pins.proxy,
      blockNumber: quantity(log.blockNumber),
      blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(),
      transactionIndex: quantity(log.transactionIndex),
      logIndex: quantity(log.logIndex),
      topics: [...log.topics],
      data: log.data,
    }));
  assert.equal(expected.length, eventCount);
  assertCurrent();
  let count = 0,
    bytes = 0,
    selectedBytes = 0,
    previous,
    failed = false;
  const logs = [];
  const visited = await visit((log) => {
    count++;
    bytes += Buffer.byteLength(JSON.stringify(log) + '\n');
    assert.ok(count <= 100000 && bytes <= 128 * 1024 * 1024);
    if (failed) return;
    try {
      // Capture-local cancellation refuses admission without interrupting the
      // ledger's authentication. Its own window/lifetime still controls I/O.
      assertCurrent();
      assert.deepEqual(Object.keys(log).sort(), [
        'address',
        'blockHash',
        'blockNumber',
        'data',
        'logIndex',
        'topics',
        'transactionHash',
        'transactionIndex',
      ]);
      assert.equal(log.address, pins.proxy);
      for (const key of ['blockNumber', 'transactionIndex', 'logIndex'])
        assert.ok(integer(log[key]));
      assert.ok(
        hash(log.blockHash) &&
          hash(log.transactionHash) &&
          log.blockNumber <= input.checkpoint.to.number
      );
      if (previous) {
        assert.ok(
          log.blockNumber > previous.blockNumber ||
            (log.blockNumber === previous.blockNumber &&
              log.logIndex > previous.logIndex &&
              log.transactionIndex >= previous.transactionIndex)
        );
        if (log.blockNumber === previous.blockNumber) {
          assert.equal(log.blockHash, previous.blockHash);
          if (log.transactionIndex === previous.transactionIndex)
            assert.equal(log.transactionHash, previous.transactionHash);
        }
      }
      previous = { ...log };
      if (log.transactionHash !== outcome.transactionHash) return;
      assert.equal(log.blockNumber, blockNumber);
      assert.equal(log.blockHash, outcome.blockHash);
      assert.equal(log.transactionIndex, transactionIndex);
      selectedBytes += Buffer.byteLength(JSON.stringify(log));
      assert.ok(logs.length < eventCount && selectedBytes <= 32768);
      assert.deepEqual(log, expected[logs.length]);
      logs.push(JSON.parse(JSON.stringify(log)));
    } catch {
      failed = true;
    }
  });
  // Semantic mismatches latch while the visitor authenticates the entire prefix.
  // Cancellation/resource limits may abort, but no partial evidence escapes.
  assertCurrent();
  assert.deepEqual(visited, { count, bytes });
  assert.ok(!failed && logs.length === eventCount);
  return freeze({
    checkpointHash: checkpointDigest,
    source: {
      ledgerId: input.checkpoint.source.ledgerId,
      ledgerSha256: input.checkpoint.source.ledgerSha256,
      trust: 'unverified-rpc',
    },
    transactionHash: outcome.transactionHash,
    blockNumber,
    blockHash: outcome.blockHash,
    transactionIndex,
    logs,
    logsSha256: createHash('sha256').update(JSON.stringify(logs)).digest('hex'),
    suppliedOutcome: outcome,
    sourceAuthenticated: false,
    receiptStatusAuthenticated: false,
    accountAuthenticated: false,
    currentFinalityVerified: false,
    spendingEnabled: false,
  });
}
exports.collectRailgunOwnSource = async (options) => {
  try {
    return await collect(options);
  } catch {
    throw Object.assign(new Error('Railgun own source comparison unavailable'), {
      code: 'RAILGUN_OWN_SOURCE_REFUSED',
    });
  }
};
