const { createHash } = require('crypto');
const {
  prepareRailgunPoiSubmission: prepare,
  normalizeRailgunPoiSubmission: normalize,
} = require('./railgun-poi-submit-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { bindRailgunOwnPoiPayload } = require('./railgun-own-poi-proof-data');
const requestId = 1791086400000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
const copy = (value) => JSON.parse(JSON.stringify(value));
const payload = (unshield = false) => ({
  listKey: REQUIRED_LIST,
  proof: {
    pi_a: ['1', '2'],
    pi_b: [
      ['3', '4'],
      ['5', '6'],
    ],
    pi_c: ['7', '8'],
  },
  poiMerkleroots: [hex(3).slice(2)],
  txidMerkleroot: hex(4).slice(2),
  txidMerklerootIndex: 6,
  blindedCommitmentsOut: unshield ? [] : [hex(5)],
  railgunTxidIfHasUnshield: unshield ? hex(6) : '0x00',
});
test.each([false, true])(
  'pinned SDK field mapping and persistence round trip preserve exact bytes, unshield=%s',
  (unshield) => {
    const input = payload(unshield),
      result = prepare({ requestId, payload: input });
    const wire = JSON.parse(result.body);
    // Contract expectation is the pinned shared-models TransactProofData schema,
    // not Solidity encoding: snarkProof, unchanged pi_b and exact prefixed markers.
    expect(wire).toEqual({
      jsonrpc: '2.0',
      id: requestId,
      method: 'ppoi_submit_transact_proof',
      params: {
        chainType: '0',
        chainID: '11155111',
        txidVersion: 'V2_PoseidonMerkle',
        listKey: REQUIRED_LIST,
        transactProofData: {
          snarkProof: input.proof,
          poiMerkleroots: input.poiMerkleroots,
          txidMerkleroot: input.txidMerkleroot,
          txidMerklerootIndex: 6,
          blindedCommitmentsOut: input.blindedCommitmentsOut,
          railgunTxidIfHasUnshield: input.railgunTxidIfHasUnshield,
        },
      },
    });
    expect(result.endpoint).toBe('https://ppoi.fdi.network');
    expect(result.payloadSha256).toBe(hash(JSON.stringify(result.payload)));
    expect(result.bodySha256).toBe(hash(result.body));
    expect(result.bodySha256).toBe(
      unshield
        ? '4814d74ba6158f891ae553d9f91253119f4ae8d8c3267cdb431033c913be4540'
        : 'ddf57ca3c602d78d229600090a689d153cdfbcf732bfe17f8e301f921c977f7a'
    );
    expect(normalize(copy(result))).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload.proof.pi_b[0])).toBe(true);
    input.proof.pi_b[0][0] = '99';
    expect(result.payload.proof.pi_b[0]).toEqual(['3', '4']);
  }
);
test.each(['', String(requestId), 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])(
  'invalid request ID refuses %#',
  (id) => {
    expect(() => prepare({ requestId: id, payload: payload() })).toThrow(
      'Railgun POI submission data unavailable'
    );
  }
);
test.each([null, [], {}, { endpoint: 'https://other.invalid' }])(
  'invalid builder options refuse %#',
  (value) => {
    expect(() => prepare(value)).toThrow('Railgun POI submission data unavailable');
  }
);
test('caller cannot introduce endpoint or method options', () => {
  for (const extra of [{ endpoint: 'https://other.invalid' }, { method: 'other' }])
    expect(() => prepare({ requestId, payload: payload(), ...extra })).toThrow();
});
test.each(['method', 'chain', 'version', 'list', 'proof-order', 'request-id', 'extra-witness'])(
  'changed %s wire refuses even with recomputed wire digest',
  (kind) => {
    const value = copy(prepare({ requestId, payload: payload() }));
    const wire = JSON.parse(value.body);
    if (kind === 'method') wire.method = 'ppoi_pois_per_list';
    if (kind === 'chain') wire.params.chainID = '1';
    if (kind === 'version') wire.params.txidVersion = 'V3';
    if (kind === 'list') wire.params.listKey = '0'.repeat(64);
    if (kind === 'proof-order') wire.params.transactProofData.snarkProof.pi_b[0].reverse();
    if (kind === 'request-id') wire.id = requestId + 1;
    if (kind === 'extra-witness') wire.params.transactProofData.privateInputs = 'secret-sentinel';
    value.body = JSON.stringify(wire);
    value.bodySha256 = hash(value.body);
    expect(() => normalize(value)).toThrow('Railgun POI submission data unavailable');
  }
);
test.each([
  'endpoint',
  'record-version',
  'payload-digest',
  'body-digest',
  'extra-key',
  'whitespace',
  'oversize',
])('changed %s record refuses', (kind) => {
  const value = copy(prepare({ requestId, payload: payload() }));
  if (kind === 'endpoint') value.endpoint = 'https://other.invalid';
  if (kind === 'record-version') value.version = 2;
  if (kind === 'payload-digest') value.payloadSha256 = '0'.repeat(64);
  if (kind === 'body-digest') value.bodySha256 = '0'.repeat(64);
  if (kind === 'extra-key') value.secret = 'secret-sentinel';
  if (kind === 'whitespace') {
    value.body = JSON.stringify(JSON.parse(value.body), null, 2);
    value.bodySha256 = hash(value.body);
  }
  if (kind === 'oversize') value.body = 'a'.repeat(40001);
  expect(() => normalize(value)).toThrow('Railgun POI submission data unavailable');
});
test('normalization establishes data shape only and cannot authenticate a proof', () => {
  const input = payload();
  input.proof.pi_a = ['0', '0'];
  const value = prepare({ requestId, payload: input });
  expect(normalize(copy(value)).payload.proof.pi_a).toEqual(['0', '0']);
  expect(value).not.toHaveProperty('proofVerified');
  expect(value).not.toHaveProperty('disclosureEnabled');
});
test.each([false, true])(
  'payload digest agrees with the proof/checks payload binder, unshield=%s',
  (unshield) => {
    const input = payload(unshield);
    const bound = bindRailgunOwnPoiPayload(input, {
      listKey: input.listKey,
      poiMerkleroots: input.poiMerkleroots,
      txidMerkleroot: input.txidMerkleroot,
      txidMerklerootIndex: input.txidMerklerootIndex,
      railgunTxidIfHasUnshield: input.railgunTxidIfHasUnshield,
      outputCount: unshield ? 0 : 1,
    });
    expect(prepare({ requestId, payload: input }).payloadSha256).toBe(hash(JSON.stringify(bound)));
  }
);
