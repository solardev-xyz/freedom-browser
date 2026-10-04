/** One received-input selector in a viewing-only utility. No network, stores or
 * proofs; all reconstructed private fields remain in this disposable process. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const {
  normalizeRailgunPoiTransactSelectorInput,
} = require('./railgun-poi-transact-selector-data');
let attempted = false;
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  let key;
  try {
    assert.equal(attempted, false);
    attempted = true;
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
    const input = normalizeRailgunPoiTransactSelectorInput(JSON.parse(text));
    const inputSha256 = createHash('sha256').update(text).digest('hex');
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
    const imp = (name) =>
      require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
    await imp('utils/poseidon').initPoseidonPromise;
    active();
    const bytes = await requestKey(
      JSON.stringify({ id: 1, method: 'key', purpose: 'poi-transact-selector', inputSha256 })
    );
    assert.ok(bytes instanceof Uint8Array);
    key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(key.length, 32);
    active();
    let blindedCommitment;
    try {
      const notes = await require('./railgun-poi-reconstruct').reconstructRailgunPoiNotes({
        archive,
        descriptor: input.descriptor,
        viewingKey: key,
        capsule: input.capsule,
        creator: input.creator,
        signal,
      });
      active();
      const position = imp('poi/global-tree-position').getGlobalTreePosition(
        input.creator.tree,
        input.creator.position
      );
      blindedCommitment = imp('poi/blinded-commitment').BlindedCommitment.getForShieldOrTransact(
        input.capsule.noteHash,
        notes.inputNpk,
        position
      );
      const [note] = require('./railgun-poi-records').normalizePoiNotes([
        { type: 'Transact', blindedCommitment },
      ]);
      blindedCommitment = note.blindedCommitment;
    } finally {
      key.fill(0);
    }
    active();
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 2,
            method: 'result',
            value: {
              inputSha256,
              bindingDigest: input.bindingDigest,
              blindedCommitment,
              type: 'Transact',
              selectorDerived: true,
              receiverMatched: true,
              sourceAuthenticated: false,
              currentFinalityVerified: false,
              txidRootAccepted: false,
              membershipAuthenticated: false,
              disclosureEnabled: false,
              spendingEnabled: false,
              inventory: require('./railgun-engine-manifest.json').inventory.sha256,
              guards,
            },
          })
        )
      ),
      { id: 2, value: null }
    );
    active();
  } catch {
    throw Object.assign(new Error('Railgun Transact POI selector unavailable'), {
      code: 'RAILGUN_POI_TRANSACT_SELECTOR_REFUSED',
    });
  } finally {
    key?.fill(0);
  }
};
