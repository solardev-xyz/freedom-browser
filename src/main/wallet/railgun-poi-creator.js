/** Private main-state creator extraction from a supplied full source visit.
 * Only a genuine coordinator can authenticate the source. Position matching
 * does not establish ownership, current canonicality or Shield note hash.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { SHIELD_EVENT } = require('./railgun-shield-receipt');
const { PRIVATE_EVENTS } = require('./railgun-transact-receipt');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPrivateCreatorEvents } = require('./railgun-private-creator');
const { assertRailgunPoiCreatorEvents } = require('./railgun-poi-creator-data');
const { checkpointHash } = require('./railgun-wallet-coverage');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([SHIELD_EVENT, ...PRIVATE_EVENTS]);
const topics = ['Shield', 'Transact'].map((name) => abi.getEvent(name).topicHash);
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
async function collect(
  { capsule: supplied, checkpoint, visit, assertCurrent },
  transact = false,
  retained = false
) {
  const retainTransaction = transact || retained;
  assert.ok(typeof visit === 'function' && typeof assertCurrent === 'function');
  const text = JSON.stringify({ capsule: supplied, checkpoint });
  assert.ok(Buffer.byteLength(text) <= 128 * 1024);
  const input = JSON.parse(text),
    capsule = normalizeRailgunPrivateCapsule(input.capsule);
  const { tree, position } = capsule.selection;
  const checkpointDigest = checkpointHash(input.checkpoint);
  assert.ok(input.checkpoint.state.trees[tree]?.length > position);
  let count = 0,
    bytes = 0,
    previous,
    failed = false,
    selected,
    group,
    selectedGroup;
  const lengths = [];
  const transactionHashes = new Set();
  assertCurrent();
  const visited = await visit((log) => {
    count++;
    bytes += Buffer.byteLength(JSON.stringify(log) + '\n');
    assert.ok(count <= 100000 && bytes <= 128 * 1024 * 1024);
    if (failed) return;
    try {
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
      for (const k of ['blockNumber', 'logIndex', 'transactionIndex']) assert.ok(integer(log[k]));
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
      assert.ok(
        Array.isArray(log.topics) &&
          log.topics.length >= 1 &&
          log.topics.length <= 4 &&
          log.topics.every(hash)
      );
      if (retainTransaction) {
        if (
          !group ||
          group.hash !== log.transactionHash ||
          group.block !== log.blockNumber ||
          group.index !== log.transactionIndex
        ) {
          // Reappearance of the selected transaction is an inconsistent group,
          // even if a later event does not contain the selected output.
          assert.ok(!selected || log.transactionHash !== selected.origin.transactionHash);
          group = {
            hash: log.transactionHash,
            block: log.blockNumber,
            index: log.transactionIndex,
            logs: [],
            bytes: 0,
            overflow: false,
            repeated: transactionHashes.has(log.transactionHash),
          };
          transactionHashes.add(log.transactionHash);
        }
        group.bytes += Buffer.byteLength(JSON.stringify(log));
        if (
          group.logs.length >= 3 ||
          group.bytes > 32768 ||
          typeof log.data !== 'string' ||
          log.data.length > 8194
        )
          group.overflow = true;
        if (!group.overflow) group.logs.push(JSON.parse(JSON.stringify(log)));
      }
      if (!topics.includes(log.topics[0])) return;
      assert.equal(log.topics.length, 1);
      assert.ok(
        typeof log.data === 'string' &&
          /^0x(?:[0-9a-f]{2})+$/.test(log.data) &&
          log.data.length <= 2 * 1024 * 1024
      );
      const event = abi.parseLog(log),
        a = event.args;
      assert.deepEqual(abi.encodeEventLog(event.fragment, a), {
        data: log.data,
        topics: log.topics,
      });
      assert.ok(a.treeNumber < 65536n && a.startPosition < 65536n);
      const shield = event.name === 'Shield',
        values = shield ? a.commitments : a.hash;
      assert.ok(values.length <= 65536 && a.startPosition + BigInt(values.length) <= 65536n);
      assert.equal(values.length, (shield ? a.shieldCiphertext : a.ciphertext).length);
      if (shield) assert.equal(values.length, a.fees.length);
      else assert.ok(values.length > 0);
      const number = Number(a.treeNumber),
        start = Number(a.startPosition);
      assert.ok(number < 256);
      if (!values.length) {
        assert.equal(number, Math.max(0, lengths.length - 1));
        assert.equal(start, lengths[number] ?? 0);
        return;
      }
      if (number === lengths.length) {
        assert.equal(start, 0);
        if (number) assert.ok(lengths[number - 1] + values.length > 65536);
        lengths.push(0);
      }
      assert.equal(number, lengths.length - 1);
      assert.equal(start, lengths[number]);
      lengths[number] += values.length;
      const offset = position - start;
      if (Number(a.treeNumber) !== tree || offset < 0 || offset >= values.length) return;
      assert.equal(selected, undefined); // Reject ambiguity across either creator kind.
      let creator;
      if (shield) {
        const p = values[offset],
          c = a.shieldCiphertext[offset];
        assert.ok(BigInt(p.npk) < FIELD);
        assert.equal(p.token.tokenType, 0n);
        assert.equal(p.token.tokenAddress.toLowerCase(), pins.wrappedNative);
        assert.equal(p.token.tokenSubID, 0n);
        assert.ok(p.value > 0n && p.value + a.fees[offset] < 1n << 120n);
        assert.equal(p.value.toString(), capsule.preparation.amount);
        creator = {
          type: 'Shield',
          tree,
          position,
          preimage: {
            npk: p.npk,
            token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
            value: p.value.toString(), // Already net; never subtract event fee again.
          },
          ciphertext: { encryptedBundle: [...c.encryptedBundle], shieldKey: c.shieldKey },
        };
      } else {
        assert.equal(values[offset], capsule.noteHash);
        const c = a.ciphertext[offset];
        creator = {
          type: 'Transact',
          tree,
          position,
          hash: values[offset],
          ciphertext: {
            ciphertext: [...c.ciphertext],
            blindedSenderViewingKey: c.blindedSenderViewingKey,
            blindedReceiverViewingKey: c.blindedReceiverViewingKey,
            annotationData: c.annotationData,
            memo: c.memo,
          },
        };
      }
      if (retainTransaction) selectedGroup = group;
      selected = {
        creator,
        origin: {
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          transactionIndex: log.transactionIndex,
          logIndex: log.logIndex,
          tree,
          startPosition: start,
          outputOffset: offset,
        },
        logSha256: createHash('sha256').update(JSON.stringify(log)).digest('hex'),
      };
    } catch {
      failed = true;
    }
  });
  // No partial evidence escapes if the visitor's final authentication fails.
  assertCurrent();
  assert.deepEqual(visited, { count, bytes });
  assert.ok(!failed && selected);
  assert.deepEqual(
    lengths,
    input.checkpoint.state.trees.map((t) => t.length)
  );
  let transaction;
  if (transact) assert.equal(selected.creator.type, 'Transact');
  if (retainTransaction && selected.creator.type === 'Transact') {
    assert.ok(
      selectedGroup &&
        !selectedGroup.overflow &&
        !selectedGroup.repeated &&
        (selectedGroup.logs.length === 2 || selectedGroup.logs.length === 3)
    );
    const note = {
      type: 'Transact',
      txid: selected.origin.transactionHash,
      hash: capsule.noteHash,
      tree,
      position,
      blockNumber: selected.origin.blockNumber,
    };
    const { events } = assertRailgunPoiCreatorEvents({
      note,
      events: normalizeRailgunPrivateCreatorEvents(selectedGroup.logs),
    });
    assert.equal(events.at(-1).logIndex, selected.origin.logIndex);
    transaction = {
      note,
      events,
      logsSha256: createHash('sha256').update(JSON.stringify(selectedGroup.logs)).digest('hex'),
    };
  }
  return freeze({
    ...selected,
    ...(transaction ? { transaction } : {}),
    noteHash: capsule.noteHash,
    checkpointHash: checkpointDigest,
    source: {
      ledgerId: input.checkpoint.source.ledgerId,
      ledgerSha256: input.checkpoint.source.ledgerSha256,
      trust: 'unverified-rpc',
    },
    creatorHashCompared: selected.creator.type === 'Transact',
    sourceAuthenticated: false,
    ownershipAuthenticated: false,
    currentCanonicalityVerified: false,
    txidMembershipVerified: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
}
exports.collectRailgunPoiCreator = async (options) => {
  try {
    return await collect(options);
  } catch {
    throw Object.assign(new Error('Railgun POI creator unavailable'), {
      code: 'RAILGUN_POI_CREATOR_REFUSED',
    });
  }
};

// Fixed internal variant for post-spend Transact membership provenance only.
exports.collectRailgunPoiTransactCreator = async (options) => {
  try {
    return await collect(options, true);
  } catch {
    throw Object.assign(new Error('Railgun POI creator unavailable'), {
      code: 'RAILGUN_POI_CREATOR_REFUSED',
    });
  }
};

// Fixed retained-input variant: the selected source event determines the type;
// authentication belongs to the genuine capture wrapper. Shield keeps its
// preimage shape; Transact requires the complete bounded creating group.
exports.collectRailgunPoiRetainedCreator = async (options) => {
  try {
    return await collect(options, false, true);
  } catch {
    throw Object.assign(new Error('Railgun POI creator unavailable'), {
      code: 'RAILGUN_POI_CREATOR_REFUSED',
    });
  }
};
