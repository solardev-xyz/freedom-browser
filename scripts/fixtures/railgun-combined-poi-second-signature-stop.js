/** Intercept only a successfully committed second B reply. Authority and saved
 * bytes are unchanged; A sees refusal and its host must retain unfinished state. */
const { assert } = require('./railgun-native-assertions');
const copy = (v) => JSON.parse(JSON.stringify(v));
function create() {
  let saved,
    count = 0;
  return Object.freeze({
    async after(job, phase, message, reply, { reservations, capsules }) {
      if (
        job !== 'railgun-private-operate-job.js' ||
        phase !== 'second-prove' ||
        message.method !== 'private-intent'
      )
        return reply;
      assert.equal(count, 0);
      const response = JSON.parse(reply);
      assert.equal(response.id, message.id);
      assert.equal(response.value.status, 'signed');
      assert.equal(message.value.capsule.version, 1);
      assert.equal(message.value.capsule.selection.kind, 'railgun-token-unshield');
      assert.equal((await reservations.inspect()).signing, 2);
      const inspected = await capsules.inspect();
      assert.equal(inspected.records, 2);
      assert.equal(inspected.signatures, 2);
      assert.equal(inspected.proofs, 1);
      saved = copy({
        capsule: message.value.capsule,
        signature: response.value.signature,
      });
      count++;
      return JSON.stringify({ id: message.id, value: { status: 'refused' } });
    },
    assertStopped(stored) {
      assert.equal(count, 1);
      assert.deepEqual(stored.capsule, saved.capsule);
      assert.deepEqual(stored.signature, saved.signature);
      assert.equal(stored.provedTransaction, null);
    },
    report: () => ({ interceptedCommittedSignatureReplies: count }),
  });
}
module.exports = { create };
