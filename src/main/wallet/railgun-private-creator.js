/** Main-only bounded creator extraction from a supplied authenticated snapshot
 * visit. This helper returns data; only the account window can attest its source.
 * Source authentication is cache/RPC consistency, never a chain proof.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { checkpointHash } = require('./railgun-wallet-coverage');
const abi = new Interface(PRIVATE_EVENTS);
const pins = require('./railgun-shield-pins.json');
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
async function collectRailgunPrivateCreator({ note, checkpoint, visit, assertCurrent }) {
  assert.ok(typeof visit === 'function' && typeof assertCurrent === 'function');
  const selected = JSON.parse(JSON.stringify(note));
  assert.deepEqual(Object.keys(selected).sort(), [
    'blockNumber',
    'hash',
    'position',
    'tree',
    'txid',
    'type',
  ]);
  assert.equal(selected.type, 'Transact');
  assert.ok(hash(selected.txid) && hash(selected.hash));
  assert.ok(
    BigInt(selected.hash) <
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
  assert.ok(
    integer(selected.tree, 65535) &&
      integer(selected.position, 65535) &&
      integer(selected.blockNumber)
  );
  const captured = JSON.parse(JSON.stringify(checkpoint));
  const checkpointDigest = checkpointHash(captured);
  assert.ok(selected.blockNumber <= captured.to.number);
  assertCurrent();
  const logs = [];
  let count = 0,
    bytes = 0,
    selectedBytes = 0,
    previous,
    failure = false;
  const visited = await visit((log) => {
    assertCurrent();
    count++;
    bytes += Buffer.byteLength(JSON.stringify(log) + '\n');
    assert.ok(count <= 100000 && bytes <= 128 * 1024 * 1024);
    if (failure) return;
    try {
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
        log.blockNumber <= captured.to.number && hash(log.blockHash) && hash(log.transactionHash)
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
      if (log.transactionHash !== selected.txid) return;
      assert.equal(log.blockNumber, selected.blockNumber);
      if (logs.length) {
        assert.equal(log.transactionIndex, logs[0].transactionIndex);
        assert.equal(log.blockHash, logs[0].blockHash);
      }
      selectedBytes += Buffer.byteLength(JSON.stringify(log));
      assert.ok(logs.length < 3 && selectedBytes <= 32768);
      assert.ok(
        typeof log.data === 'string' &&
          /^0x(?:[0-9a-f]{2})+$/.test(log.data) &&
          log.data.length <= 8194
      );
      assert.ok(Array.isArray(log.topics) && log.topics.length === 1 && hash(log.topics[0]));
      logs.push(JSON.parse(JSON.stringify(log)));
    } catch {
      failure = true;
    }
  });
  // A selected semantic mismatch never short-circuits the ledger's digest
  // authentication. Do not expose a partial match before the entire visit ends.
  assertCurrent();
  assert.deepEqual(visited, { count, bytes });
  assert.ok(!failure && logs.length >= 2 && logs.length <= 3);
  const events = logs.map((log) => {
    const event = abi.parseLog(log);
    assert.ok(event);
    assert.deepEqual(abi.encodeEventLog(event.fragment, event.args), {
      data: log.data,
      topics: log.topics,
    });
    const args = event.args;
    if (event.name === 'Nullified') {
      assert.ok(args.nullifier.length >= 1 && args.nullifier.length <= 13);
      return {
        name: event.name,
        logIndex: log.logIndex,
        tree: Number(args.treeNumber),
        values: [...args.nullifier],
      };
    }
    if (event.name === 'Transact') {
      assert.ok(args.treeNumber < 65536n && args.startPosition < 65536n);
      assert.ok(
        args.hash.length >= 1 &&
          args.hash.length <= 13 &&
          new Set(args.hash).size === args.hash.length &&
          args.hash.length === args.ciphertext.length &&
          args.startPosition + BigInt(args.hash.length) <= 65536n
      );
      return {
        name: event.name,
        logIndex: log.logIndex,
        tree: Number(args.treeNumber),
        start: Number(args.startPosition),
        hashes: [...args.hash],
      };
    }
    assert.equal(event.name, 'Unshield');
    assert.ok(args.token.tokenType <= 2n && args.amount + args.fee < 1n << 120n);
    return {
      name: event.name,
      logIndex: log.logIndex,
      to: args.to.toLowerCase(),
      token: args.token.tokenAddress.toLowerCase(),
      type: Number(args.token.tokenType),
      subID: args.token.tokenSubID.toString(),
      value: (args.amount + args.fee).toString(),
    };
  });
  assert.equal(events[0].name, 'Nullified');
  assert.equal(events.at(-1).name, 'Transact');
  if (events.length === 3) assert.equal(events[1].name, 'Unshield');
  const output = events.at(-1),
    index = selected.position - output.start;
  assert.equal(output.tree, selected.tree);
  assert.ok(index >= 0 && index < output.hashes.length);
  assert.equal(output.hashes[index], selected.hash);
  assertCurrent();
  return freeze({
    note: selected,
    checkpointHash: checkpointDigest,
    source: {
      ledgerId: captured.source.ledgerId,
      ledgerSha256: captured.source.ledgerSha256,
      trust: 'unverified-rpc',
    },
    creator: {
      blockNumber: selected.blockNumber,
      blockHash: logs[0].blockHash,
      transactionHash: selected.txid,
      transactionIndex: logs[0].transactionIndex,
    },
    logsSha256: createHash('sha256').update(JSON.stringify(logs)).digest('hex'),
    events,
    txidMembershipVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  });
}
exports.collectRailgunPrivateCreator = async (options) => {
  try {
    return await collectRailgunPrivateCreator(options);
  } catch {
    throw Object.assign(new Error('Railgun private creator unavailable'), {
      code: 'RAILGUN_PRIVATE_CREATOR_REFUSED',
    });
  }
};
