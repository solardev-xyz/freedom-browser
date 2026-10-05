/** Verification-only replay of already issued disposable list wire. This is
 * service fixture state, not an acceptance constructor or production capability.
 * The setup process alone ran the actual POST verification and list signer. */
const { assert } = require('./railgun-native-assertions');
const copy = (v) => JSON.parse(JSON.stringify(v));
const base = {
  chainType: '0',
  chainID: '11155111',
  txidVersion: 'V2_PoseidonMerkle',
};
const providers = new WeakSet();
function requests(note, key, root) {
  return {
    ppoi_pois_per_list: {
      ...base,
      listKeys: [key],
      blindedCommitmentDatas: [note],
    },
    ppoi_merkle_proofs: {
      ...base,
      listKey: key,
      blindedCommitments: [note.blindedCommitment],
    },
    ppoi_poi_events: { ...base, listKey: key, startIndex: 0, endIndex: 0 },
    ppoi_validate_poi_merkleroots: {
      ...base,
      listKey: key,
      poiMerkleroots: [root],
    },
  };
}
function snapshot({ acceptance, payload, signature }) {
  const report = acceptance.report();
  assert.equal(report.accepted, true);
  assert.equal(report.postCalls, 1);
  assert.equal(report.verifierExits, 1);
  assert.equal(report.bindingExits, 1);
  assert.equal(report.signedEvents, 1);
  assert.equal(payload.blindedCommitmentsOut.length, 1);
  const note = {
    blindedCommitment: payload.blindedCommitmentsOut[0],
    type: 'Transact',
  };
  let req = requests(note, payload.listKey, '');
  const proofs = acceptance.answer('ppoi_merkle_proofs', req.ppoi_merkle_proofs);
  req = requests(note, payload.listKey, proofs[0].root);
  const answers = Object.fromEntries(
    Object.entries(req).map(([method, params]) => [method, acceptance.answer(method, params)])
  );
  assert.deepEqual(acceptance.report(), report);
  return {
    publicKeySpki: signature.exportPublicKey(),
    note,
    listKey: payload.listKey,
    answers,
  };
}
function replayOptions(value) {
  assert.deepEqual(Object.keys(value).sort(), ['answers', 'listKey', 'note', 'publicKeySpki']);
  const event = value.answers.ppoi_poi_events[0].signedPOIEvent;
  return {
    publicKeySpki: value.publicKeySpki,
    listKey: value.listKey,
    event: {
      index: event.index,
      blindedCommitment: event.blindedCommitment,
      type: event.type,
    },
    signature: event.signature,
  };
}
function create(value, payload) {
  value = copy(value);
  replayOptions(value);
  const records = require('../../src/main/wallet/railgun-poi-records');
  assert.equal(value.listKey, records.REQUIRED_LIST);
  assert.equal(payload.listKey, value.listKey);
  assert.deepEqual(payload.blindedCommitmentsOut, [value.note.blindedCommitment]);
  assert.equal(value.note.type, 'Transact');
  const notes = records.normalizePoiNotes([value.note]);
  const statuses = records.normalizePoiStatuses(value.answers.ppoi_pois_per_list, notes);
  assert.deepEqual(statuses, [{ ...notes[0], status: 'Valid' }]);
  const proofs = records.normalizePoiProofs(value.answers.ppoi_merkle_proofs, notes);
  assert.equal(proofs[0].indices, '0'.repeat(64));
  const event = records.verifyPoiEvent(value.answers.ppoi_poi_events, notes[0], proofs[0]);
  assert.equal(event.validatedMerkleroot, proofs[0].root);
  assert.equal(value.answers.ppoi_validate_poi_merkleroots, true);
  const expected = requests(notes[0], value.listKey, proofs[0].root);
  assert.deepEqual(Object.keys(value.answers).sort(), Object.keys(expected).sort());
  let active = true;
  const provider = Object.freeze({
    answer(method, params) {
      assert.equal(active, true);
      assert.ok(Object.hasOwn(expected, method));
      assert.deepEqual(params, expected[method]);
      return copy(value.answers[method]);
    },
    // No accepted boolean, signer, acceptPost or authority result exists here.
    report: () =>
      Object.freeze({
        savedSignedWireVerified: true,
        setupAcceptanceReissued: false,
        productionAuthority: false,
      }),
    assertChange(record) {
      assert.equal(active, true);
      assert.equal(record.type, 'Transact');
      assert.equal(record.blindedCommitment, notes[0].blindedCommitment);
    },
    close() {
      active = false;
    },
  });
  providers.add(provider);
  return provider;
}
function assertProvider(provider) {
  assert.ok(providers.has(provider));
  assert.equal(provider.report().savedSignedWireVerified, true);
  return provider;
}
module.exports = { snapshot, replayOptions, create, assertProvider };
