/** Fixed POI submission bytes only.
 * No network, proof verification or disclosure permission. The stored payload and
 * wire body are privacy-sensitive and belong only in encrypted main-owned state.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const POI_URL = 'https://ppoi.fdi.network';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const fail = () =>
  Object.assign(new Error('Railgun POI submission data unavailable'), {
    code: 'RAILGUN_POI_SUBMISSION_DATA_REFUSED',
  });
function build(input) {
  shape(input, ['requestId', 'payload']);
  const { requestId } = input;
  assert.ok(Number.isSafeInteger(requestId) && requestId > 0);
  const payload = normalizeRailgunPoiPayload(input.payload);
  // Pinned SDK TransactProofData uses snarkProof with snarkjs coordinate order.
  // Match its field order and numeric ID shape. A controller allocates the
  // timestamp once and persists these bytes; transport fingerprints still differ,
  // and actual service acceptance remains separately unqualified.
  // In particular, do not apply the Solidity pi_b swap or add witness fields.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'ppoi_submit_transact_proof',
    params: {
      chainType: '0',
      chainID: '11155111',
      txidVersion: 'V2_PoseidonMerkle',
      listKey: payload.listKey,
      transactProofData: {
        snarkProof: payload.proof,
        poiMerkleroots: payload.poiMerkleroots,
        txidMerkleroot: payload.txidMerkleroot,
        txidMerklerootIndex: payload.txidMerklerootIndex,
        blindedCommitmentsOut: payload.blindedCommitmentsOut,
        railgunTxidIfHasUnshield: payload.railgunTxidIfHasUnshield,
      },
    },
    id: requestId,
  });
  assert.ok(Buffer.byteLength(body) <= 18432);
  return Object.freeze({
    version: 1,
    endpoint: POI_URL,
    requestId,
    payload,
    payloadSha256: sha(JSON.stringify(payload)),
    body,
    bodySha256: sha(body),
  });
}
function prepareRailgunPoiSubmission(input) {
  try {
    return build(input);
  } catch {
    throw fail();
  }
}
function normalizeRailgunPoiSubmission(input) {
  try {
    const text = JSON.stringify(input);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 40000);
    const value = JSON.parse(text);
    shape(value, [
      'version',
      'endpoint',
      'requestId',
      'payload',
      'payloadSha256',
      'body',
      'bodySha256',
    ]);
    const expected = build({ requestId: value.requestId, payload: value.payload });
    // Exact body bytes (including ID and ordering) survive persistence. Even a
    // caller-recomputed digest cannot introduce a different method or endpoint.
    assert.deepEqual(value, expected);
    return expected;
  } catch {
    throw fail();
  }
}
module.exports = { prepareRailgunPoiSubmission, normalizeRailgunPoiSubmission };
