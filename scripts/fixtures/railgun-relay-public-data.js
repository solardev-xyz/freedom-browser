/** Witness-free verifier-side reconstruction for a fixed public fixture.
 * No producer assembly helper is imported. No membership/spending authority. */
const assert = require('assert/strict');
const { AbiCoder, Interface, keccak256, toUtf8Bytes } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const {
  TRANSACT_ABI,
  validateRailgunPrivateTransaction,
} = require('../../src/main/wallet/railgun-private-policy');
const { normalizeRailgunPoiPayload } = require('../../src/main/wallet/railgun-poi-payload');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
function field(v) {
  assert.equal(typeof v, 'string');
  assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(v) < FIELD);
  return BigInt(v);
}
function proof(v) {
  shape(v, ['pi_a', 'pi_b', 'pi_c']);
  const point = (x) => {
    assert.equal(typeof x, 'string');
    assert.match(x, /^(?:0|[1-9][0-9]{0,76})$/);
    assert.ok(BigInt(x) < BASE);
    return x;
  };
  const pair = (p) => {
    assert.ok(Array.isArray(p) && p.length === 2);
    return p.map(point);
  };
  assert.ok(Array.isArray(v.pi_b) && v.pi_b.length === 2);
  return {
    pi_a: [...pair(v.pi_a), '1'],
    pi_b: [...v.pi_b.map(pair), ['1', '0']],
    pi_c: [...pair(v.pi_c), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
function expectedVector(poseidon) {
  // Public coordinates of published fixture spending constants07/09; never keys.
  const sender = poseidon([
    14422859473778768188622151430526693594403470008420308922992775064941455773685n,
    7592518773672929099542717438998516546396504563265155469693554058278098107299n,
    123n,
  ]);
  const fee = poseidon([
    12413163600793827339124387033787304747178281335716960105995444885879464409721n,
    8010389973639104762288114662299334843185477277610438054266062296539834190376n,
    456n,
  ]);
  const npkIn = poseidon([sender, BigInt('0x' + '01'.repeat(16))]);
  const npks = [
    poseidon([fee, BigInt('0x' + '02'.repeat(16))]),
    poseidon([sender, BigInt('0x' + '03'.repeat(16))]),
  ];
  const token = BigInt(pins.wrappedNative);
  const leaf = poseidon([npkIn, token, 1000n]);
  let root = leaf;
  for (let i = 0; i < 16; i++) root = poseidon((10245 >> i) & 1 ? [0n, root] : [root, 0n]);
  const commitments = [poseidon([npks[0], token, 100n]), poseidon([npks[1], token, 900n])];
  const nullifier = poseidon([123n, 10245n]);
  let listRoot = poseidon([leaf, npkIn, 10245n]);
  for (let i = 0; i < 16; i++)
    listRoot = poseidon((5 >> i) & 1 ? [BigInt(i + 1), listRoot] : [listRoot, BigInt(i + 1)]);
  const position = 199999n * 65536n + 199999n;
  const blinds = commitments.map((v, i) => poseidon([v, npks[i], position + BigInt(i)]));
  return { root, nullifier, commitments, listRoot, blinds, position };
}
function assertPublicShape(raw, expectedGas) {
  assert.ok(expectedGas === 0 || expectedGas === 1);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 32768);
  shape(raw, ['domain', 'minGasPrice', 'transaction', 'poi']);
  assert.equal(raw.domain, 'public-fixture-relay-pre-poi-v1');
  assert.equal(raw.minGasPrice, expectedGas);
  shape(raw.transaction, ['chainId', 'to', 'value', 'data']);
  assert.equal(raw.transaction.chainId, pins.chainId);
  assert.equal(raw.transaction.to, pins.proxy);
  assert.equal(raw.transaction.value, '0');
  assert.equal(typeof raw.transaction.data, 'string');
  assert.match(raw.transaction.data, /^0x(?:[0-9a-f]{2}){1,4096}$/);
  shape(raw.poi, [
    'proof',
    'txidMerkleroot',
    'poiMerkleroots',
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield',
  ]);
  field(raw.poi.txidMerkleroot);
  assert.ok(Array.isArray(raw.poi.poiMerkleroots) && raw.poi.poiMerkleroots.length === 1);
  assert.ok(
    Array.isArray(raw.poi.blindedCommitmentsOut) && raw.poi.blindedCommitmentsOut.length === 2
  );
  raw.poi.poiMerkleroots.forEach(field);
  raw.poi.blindedCommitmentsOut.forEach(field);
  assert.equal(raw.poi.railgunTxidIfHasUnshield, '0x00');
  proof(raw.poi.proof);
}
function validatePublicCase(raw, expectedGas, poseidon) {
  assertPublicShape(raw, expectedGas);
  assert.ok(expectedGas === 0 || expectedGas === 1);
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 32768);
  shape(raw, ['domain', 'minGasPrice', 'transaction', 'poi']);
  assert.equal(raw.domain, 'public-fixture-relay-pre-poi-v1');
  assert.equal(raw.minGasPrice, expectedGas);
  shape(raw.transaction, ['chainId', 'to', 'value', 'data']);
  assert.equal(raw.transaction.chainId, pins.chainId);
  assert.equal(raw.transaction.to, pins.proxy);
  assert.equal(raw.transaction.value, '0');
  assert.equal(typeof raw.transaction.data, 'string');
  assert.match(raw.transaction.data, /^0x(?:[0-9a-f]{2}){1,4096}$/);
  const abi = new Interface([TRANSACT_ABI]);
  const [txs] = abi.decodeFunctionData('transact', raw.transaction.data);
  assert.equal(txs.length, 1);
  assert.equal(abi.encodeFunctionData('transact', [txs]), raw.transaction.data);
  const tx = txs[0],
    bound = tx.boundParams,
    expected = expectedVector(poseidon);
  assert.equal(bound.treeNumber, 0n);
  assert.equal(bound.chainID, BigInt(pins.chainId));
  assert.equal(bound.minGasPrice, BigInt(expectedGas));
  assert.equal(bound.unshield, 0n);
  assert.equal(bound.adaptContract, '0x' + '0'.repeat(40));
  assert.equal(bound.adaptParams, hex(0n));
  assert.equal(bound.commitmentCiphertext.length, 2);
  for (const cipher of bound.commitmentCiphertext) {
    assert.ok(cipher.annotationData.length <= 514 && cipher.memo === '0x');
    assert.notEqual(cipher.blindedSenderViewingKey, hex(0n));
    assert.notEqual(cipher.blindedReceiverViewingKey, hex(0n));
  }
  assert.equal(tx.unshieldPreimage.npk, hex(0n));
  assert.equal(tx.unshieldPreimage.value, 0n);
  assert.equal(tx.unshieldPreimage.token.tokenType, 0n);
  assert.equal(tx.unshieldPreimage.token.tokenSubID, 0n);
  assert.equal(tx.unshieldPreimage.token.tokenAddress, '0x' + '0'.repeat(40));
  assert.equal(field(tx.merkleRoot), expected.root);
  assert.deepEqual(tx.nullifiers.map(field), [expected.nullifier]);
  assert.deepEqual(tx.commitments.map(field), expected.commitments);
  const cipherType =
    '(bytes32[4] ciphertext,bytes32 blindedSenderViewingKey,bytes32 blindedReceiverViewingKey,bytes annotationData,bytes memo)';
  const type = `(uint16 treeNumber,uint72 minGasPrice,uint8 unshield,uint64 chainID,address adaptContract,bytes32 adaptParams,${cipherType}[] commitmentCiphertext)`;
  const boundHash = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([type], [bound]))) % FIELD;
  const merkleZero = BigInt(keccak256(toUtf8Bytes('Railgun'))) % FIELD;
  const paddedNullifiers = [expected.nullifier, ...Array(12).fill(merkleZero)];
  const paddedCommitments = [...expected.commitments, ...Array(11).fill(merkleZero)];
  const txid = poseidon([poseidon(paddedNullifiers), poseidon(paddedCommitments), boundHash]);
  let preRoot = poseidon([txid, 0n, expected.position]);
  for (let i = 0; i < 16; i++) preRoot = poseidon([preRoot, 0n]);
  shape(raw.poi, [
    'proof',
    'txidMerkleroot',
    'poiMerkleroots',
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield',
  ]);
  assert.equal(field(raw.poi.txidMerkleroot), preRoot);
  assert.deepEqual(raw.poi.poiMerkleroots.map(field), [expected.listRoot]);
  assert.deepEqual(raw.poi.blindedCommitmentsOut.map(field), expected.blinds);
  assert.equal(raw.poi.railgunTxidIfHasUnshield, '0x00');
  const p = tx.proof;
  const txProof = proof({
    pi_a: [p.a.x, p.a.y].map(String),
    pi_b: [
      [p.b.x[1], p.b.x[0]],
      [p.b.y[1], p.b.y[0]],
    ].map((row) => row.map(String)),
    pi_c: [p.c.x, p.c.y].map(String),
  });
  const poiProof = proof(raw.poi.proof);
  // Existing semantic gates must remain closed, even when math verifies.
  assert.throws(
    () =>
      validateRailgunPrivateTransaction(raw.transaction, {
        kind: 'railgun-private-transfer',
        tree: 0,
        merkleRoot: tx.merkleRoot,
        nullifier: tx.nullifiers[0],
        commitment: tx.commitments[1],
        boundParamsHash: hex(boundHash),
      }),
    { code: 'RAILGUN_PRIVATE_TRANSACTION_REFUSED' }
  );
  assert.throws(
    () =>
      normalizeRailgunPoiPayload({
        ...raw.poi,
        listKey: REQUIRED_LIST,
        txidMerkleroot: raw.poi.txidMerkleroot.slice(2),
        poiMerkleroots: raw.poi.poiMerkleroots.map((v) => v.slice(2)),
        txidMerklerootIndex: 0,
      }),
    { code: 'RAILGUN_POI_PAYLOAD_REFUSED' }
  );
  return {
    transactionSignals: [expected.root, boundHash, expected.nullifier, ...expected.commitments],
    poiSignals: [...expected.blinds, 0n, preRoot, 0n, expected.listRoot, merkleZero, merkleZero],
    transactionProof: txProof,
    poiProof,
  };
}
module.exports = { validatePublicCase, expectedVector, assertPublicShape };
