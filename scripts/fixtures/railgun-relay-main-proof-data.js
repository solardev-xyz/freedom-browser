// Real canonical records/ABI; cryptographic execution and owned-core output are
// explicit structural test seams. No runtime archive, prover or key is loaded.
const { createRailgunRelayUnsignedData } = require('./railgun-relay-unsigned-data');
const {
  normalizeRailgunRelayDraftCapsule,
} = require('../../src/main/wallet/railgun-relay-capsule');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const {
  normalizeRailgunRelayPoiHistory,
} = require('../../src/main/wallet/railgun-relay-poi-history');
const {
  normalizeRailgunRelayPrePoiBinding,
} = require('../../src/main/wallet/railgun-relay-pre-poi-data');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');

function fixture(state = 'held') {
  const draft = createRailgunRelayUnsignedData().draft,
    draftDigest = normalizeRailgunRelayDraftCapsule(draft).digest;
  const proof = { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) };
  const history = {
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: '0x' + hex(1), type: 'Transact' },
    proof,
    event: {
      signedPOIEvent: {
        index: 5,
        blindedCommitment: '0x' + hex(1),
        type: 'Transact',
        signature: '12'.repeat(64),
      },
      validatedMerkleroot: hex(4),
    },
  };
  const prePoiBinding = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest,
    chainId: 11155111,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: proof,
    txidLeafHash: hex(10),
    txidMerkleroot: hex(11),
    blindedCommitmentsOut: ['0x' + hex(12), '0x' + hex(13)],
  };
  const signature = ['signed', 'ready-local'].includes(state)
    ? { R8: ['0x' + hex(1), '0x' + hex(2)], S: '0x' + hex(3) }
    : null;
  const proved =
    state === 'ready-local'
      ? {
          transaction: draft.intent.transaction,
          payload: {
            snarkProof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['3', '4'],
                ['5', '6'],
              ],
              pi_c: ['7', '8'],
            },
            txidMerkleroot: prePoiBinding.txidMerkleroot,
            poiMerkleroots: [proof.root],
            blindedCommitmentsOut: prePoiBinding.blindedCommitmentsOut,
            railgunTxidIfHasUnshield: '0x00',
          },
        }
      : null;
  return JSON.parse(
    JSON.stringify({
      schema: 'railgun-relay-local-record-v4',
      id: hex(100),
      binding: hex(101),
      walletId: draft.walletId,
      generationId: hex(102),
      checkpointHash: hex(103),
      authorizationDigest: hex(104),
      draft: normalizeRailgunRelayDraftCapsule(draft).data,
      history: normalizeRailgunRelayPoiHistory(history).data,
      prePoiBinding: normalizeRailgunRelayPrePoiBinding(prePoiBinding),
      state,
      signature,
      proved,
    })
  );
}

const { createHash } = require('crypto');
const {
  digestRailgunRelayLocalIntent,
} = require('../../src/main/wallet/railgun-relay-recovery-data');
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function createRailgunRelayMainProofData() {
  const record = fixture('signed'),
    ready = fixture('ready-local'),
    recordText = JSON.stringify(record);
  const proof = {
    recordDigest: digestRailgunRelayLocalIntent(recordText),
    draftDigest: normalizeRailgunRelayDraftCapsule(record.draft).digest,
    historyDigest: normalizeRailgunRelayPoiHistory(record.history).digest,
    expectedHash: record.draft.intent.expectedHash,
    transaction: ready.proved.transaction,
    payload: ready.proved.payload,
    transactionDigest: digest(ready.proved.transaction),
    payloadDigest: digest(ready.proved.payload),
    locallyVerified: true,
    independentlyVerified: false,
  };
  const verification = {
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    proverSha256: require('../../src/main/wallet/railgun-prover-manifest.json').sha256,
    artifactVkeys: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((variant) => [
        variant,
        require('../../src/main/wallet/railgun-artifacts').manifest[variant].find(
          (v) => v.kind === 'vkey'
        ).sha256,
      ])
    ),
    ...Object.fromEntries(
      [
        'recordDigest',
        'draftDigest',
        'historyDigest',
        'expectedHash',
        'transactionDigest',
        'payloadDigest',
      ].map((key) => [key, proof[key]])
    ),
    transactionVerified: true,
    prePoiVerified: true,
    historicalEventSignatureVerified: true,
    historicalMembershipPathVerified: true,
    inputOwnershipVerified: false,
    currentMembershipVerified: false,
    authorityGranted: false,
  };
  return {
    record,
    recordText,
    proof,
    verification,
    proofInput: {
      recordText,
      proverArchive: '/synthetic-prover.asar',
      artifactDirectory: '/synthetic-artifacts',
      timeoutMs: 110000,
    },
  };
}
module.exports = { createRailgunRelayMainProofData };
