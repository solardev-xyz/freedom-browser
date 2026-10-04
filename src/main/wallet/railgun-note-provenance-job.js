/** Detached, keyless TXID path and single-row creator-event comparison.
 * Input is public evidence, not authenticated source/ownership authority.
 * No store, wallet key, network or signing broker is available to this job.
 */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { createHash } = require('crypto');
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  assert.ok(!signal.aborted);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'events',
    'note',
    'noteWitness',
    'state',
  ]);
  const normalized = require('./railgun-txid-note-witness').normalizeRailgunNoteTxidWitness(
    input.noteWitness,
    input.state,
    input.note
  );
  const hasUnshield = Boolean(normalized.witness.row.unshield);
  // Only the complete, unambiguous single-row creator is supported. The known
  // omitted service outputs remain inadmissible even in a mixed event group.
  const coverage = require('./railgun-txid-events').matchRailgunTxidEvents({
    blockNumber: normalized.note.blockNumber,
    txid: normalized.note.txid.slice(2),
    events: input.events,
    rows: [normalized.witness.row],
  });
  assert.equal(coverage.matchedRows, 1);
  assert.equal(coverage.knownOmissions, 0);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  assert.ok(!signal.aborted);
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: (a, b) => poseidonHex([a, b]),
    transactionHash: createRailgunTransactionWithHash,
    verificationHash: calculateRailgunTransactionVerificationHash,
    zeroNodes: require('./railgun-public-records').ZERO_NODES,
  });
  projection.verifyWitness(input.state, normalized.witness);
  assert.ok(!signal.aborted);
  if (hasUnshield) {
    const { getNoteHash, assertValidNoteToken } = require(path.join(root, 'note/note-util'));
    const unshield = normalized.witness.row.unshield;
    const value = BigInt(unshield.value);
    assertValidNoteToken(unshield.tokenData, value);
    const commitment = getNoteHash(unshield.toAddress, unshield.tokenData, value);
    assert.equal(
      '0x' + commitment.toString(16).padStart(64, '0'),
      normalized.witness.row.commitments.at(-1)
    );
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            inputSha256: createHash('sha256').update(text).digest('hex'),
            pathVerified: true,
            suppliedCreatorEventsMatched: true,
            ...(hasUnshield ? { unshieldCommitmentVerified: true } : {}),
            ownershipVerified: false,
            eventSourceAuthenticated: false,
            rootAccepted: false,
            spendingEnabled: false,
            coverage,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
