/** Pure fixed-public-vector composition checks. No signature/proof verification,
 * key derivation, network, clock or authority. Callers must independently verify
 * the original signed bytes and fixture recipient before admitting a producer. */
const assert = require('assert/strict');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const parser = require('./railgun-relay-wire/policy');
const oldPolicy = require('./railgun-relay-wire/policy.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const LIST = '44'.repeat(32);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const LIMITS = freeze({
  publicCaseBytes: 32768,
  plaintextBytes: 24576,
  envelopeBytes: 65536,
  resultBytes: 40000,
  producerMs: 90000,
  wireMs: 15000,
  verifierMs: 30000,
  outerMs: 180000,
  cleanupMs: 30000,
  quoteLifetimeMs: 240000,
  jsonDepth: 12,
  jsonMembers: 256,
  jsonValues: 1024,
  jsonStringBytes: 16384,
});
const POLICY = freeze({
  ...oldPolicy,
  chain: { type: 0, id: pins.chainId },
  tokenAddress: pins.wrappedNative,
  deployment: pins.proxy,
  relayAdapt: pins.relayAdapt,
  activePOIListKeys: [LIST],
  limits: { ...oldPolicy.limits, ...LIMITS, requestBytes: LIMITS.envelopeBytes },
  keyAdmission:
    'Fixed proof-recipient public fixture registry derived independently by orchestration; no arbitrary discovered peer qualification.',
});
function shape(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok([null, Object.prototype].includes(Object.getPrototypeOf(value)));
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  }
}
function hex(value, length, prefix = '') {
  assert.equal(typeof value, 'string');
  assert.match(value, new RegExp(`^${prefix}[0-9a-f]{${length * 2}}$`));
  return value;
}
function field(value, prefix = '0x') {
  hex(value, 32, prefix);
  assert.ok(BigInt(prefix ? value : '0x' + value) < FIELD);
  return value;
}
function decimal(value, maximum) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(0|[1-9][0-9]{0,76})$/);
  assert.ok(BigInt(value) < maximum);
  return value;
}
function array(value, length, check) {
  assert.ok(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  assert.equal(value.length, length);
  assert.deepEqual(Reflect.ownKeys(value), [...Array(length).keys()].map(String).concat('length'));
  value.forEach(check);
}
function proof(value) {
  shape(value, ['pi_a', 'pi_b', 'pi_c']);
  const pair = (v) => array(v, 2, (x) => decimal(x, BASE));
  pair(value.pi_a);
  array(value.pi_b, 2, pair);
  pair(value.pi_c);
}
function parse(bytes, bound) {
  assert.ok(bytes instanceof Uint8Array);
  return parser.parseBoundedJson(Uint8Array.from(bytes), LIMITS, bound);
}
function jsonBytes(value, bound) {
  const bytes = Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length <= bound);
  return bytes;
}
function assertPublicCase(value) {
  shape(value, ['domain', 'minGasPrice', 'transaction', 'poi']);
  assert.equal(value.domain, 'public-fixture-relay-pre-poi-v1');
  assert.equal(value.minGasPrice, 1);
  shape(value.transaction, ['chainId', 'to', 'value', 'data']);
  assert.equal(value.transaction.chainId, pins.chainId);
  assert.equal(value.transaction.to, pins.proxy);
  assert.equal(value.transaction.value, '0');
  assert.match(value.transaction.data, /^0x(?:[0-9a-f]{2}){1,4096}$/);
  shape(value.poi, [
    'proof',
    'txidMerkleroot',
    'poiMerkleroots',
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield',
  ]);
  proof(value.poi.proof);
  field(value.poi.txidMerkleroot);
  array(value.poi.poiMerkleroots, 1, (v) => field(v));
  array(value.poi.blindedCommitmentsOut, 2, (v) => field(v));
  assert.equal(value.poi.railgunTxidIfHasUnshield, '0x00');
  jsonBytes(value, LIMITS.publicCaseBytes);
}
function readPublicCase(bytes) {
  const value = parse(bytes, LIMITS.publicCaseBytes);
  assertPublicCase(value);
  return freeze(value);
}
function selectRelayWireInput(packetBytes, recipient, selectedAt, maximumFee) {
  // This only snapshots/checks data. Actual signature and address/key verification
  // must precede producer admission in the separately reviewed orchestration.
  shape(recipient, ['address', 'viewingPublicKey', 'masterPublicKey']);
  assert.equal(typeof recipient.address, 'string');
  assert.match(recipient.address, /^0zk1[0-9a-z]{123}$/);
  hex(recipient.viewingPublicKey, 32);
  decimal(recipient.masterPublicKey, FIELD);
  assert.ok(Number.isSafeInteger(selectedAt) && selectedAt >= 0);
  assert.equal(maximumFee, '100');
  assert.ok(packetBytes instanceof Uint8Array);
  const packet = parser.parseSignedPacket(Uint8Array.from(packetBytes), POLICY);
  const quote = packet.candidate;
  parser.validateQuoteFields(
    quote,
    { chain: POLICY.chain },
    {
      topic: POLICY.topic,
      chain: POLICY.chain,
      deployment: pins.proxy,
      nowMs: selectedAt,
      previousNowMs: selectedAt,
      activePOIListKeys: [LIST],
    },
    POLICY
  );
  assert.equal(quote.railgunAddress, recipient.address);
  shape(quote.fees, [pins.wrappedNative]);
  assert.equal(BigInt(quote.fees[pins.wrappedNative]), 10n ** 18n);
  assert.deepEqual(quote.requiredPOIListKeys, [LIST]);
  assert.equal(quote.feeExpiration, selectedAt + LIMITS.quoteLifetimeMs);
  // These fixed parameters must later equal results of the actual extracted gas
  // helper and the independently reconstructed fee commitment. No estimator claim.
  return freeze({
    signedDataHex: packet.dataHex,
    signatureHex: packet.signatureHex,
    quote,
    recipient: {
      address: recipient.address,
      viewingPublicKey: recipient.viewingPublicKey,
      masterPublicKey: recipient.masterPublicKey,
    },
    selectedAt,
    expiresAt: quote.feeExpiration,
    gasEstimate: '84',
    gasPrice: '1',
    minGasPrice: '1',
    feeAmount: '100',
    maximumFee,
  });
}
function assertSelectionCurrent(selection, nowMs, previousMs) {
  assert.ok(Number.isSafeInteger(nowMs) && Number.isSafeInteger(previousMs));
  assert.ok(previousMs >= selection.selectedAt && nowMs >= previousMs);
  assert.equal(selection.expiresAt, selection.selectedAt + LIMITS.quoteLifetimeMs);
  assert.equal(selection.quote.feeExpiration, selection.expiresAt);
  assert.ok(nowMs < selection.expiresAt && nowMs - selection.selectedAt <= LIMITS.outerMs);
}
function prePoiMap(publicCaseBytes, leaf) {
  const value = readPublicCase(publicCaseBytes);
  field(leaf, '');
  // leaf comes from independent calldata/txid reconstruction, never a supplied
  // root or an authenticated membership assertion from this pure mapper.
  return freeze({
    [LIST]: {
      [leaf]: {
        snarkProof: value.poi.proof,
        txidMerkleroot: value.poi.txidMerkleroot.slice(2),
        poiMerkleroots: value.poi.poiMerkleroots.map((v) => v.slice(2)),
        blindedCommitmentsOut: value.poi.blindedCommitmentsOut,
        railgunTxidIfHasUnshield: value.poi.railgunTxidIfHasUnshield,
      },
    },
  });
}
function publicCaseFromCommon(plaintextBytes, selection, leaf) {
  const common = parse(plaintextBytes, LIMITS.plaintextBytes);
  shape(common, [
    'transactType',
    'txidVersion',
    'to',
    'data',
    'broadcasterViewingKey',
    'chainID',
    'chainType',
    'minGasPrice',
    'feesID',
    'useRelayAdapt',
    'devLog',
    'minVersion',
    'maxVersion',
    'preTransactionPOIsPerTxidLeafPerList',
  ]);
  const fixed = {
    transactType: 'COMMON',
    txidVersion: 'V2_PoseidonMerkle',
    broadcasterViewingKey: selection.recipient.viewingPublicKey,
    chainID: pins.chainId,
    chainType: 0,
    minGasPrice: '1',
    feesID: selection.quote.feesID,
    useRelayAdapt: false,
    devLog: false,
    minVersion: '8.0.0',
    maxVersion: '8.999.0',
  };
  for (const [key, value] of Object.entries(fixed)) assert.equal(common[key], value);
  // COMMON uses upstream EIP-55 formatting; the guarded crypto job separately
  // enforces that checksum. This pure boundary only checks exact address bytes.
  assert.equal(typeof common.to, 'string');
  assert.match(common.to, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(common.to.toLowerCase(), pins.proxy);
  field(leaf, '');
  const maps = common.preTransactionPOIsPerTxidLeafPerList;
  shape(maps, [LIST]);
  shape(maps[LIST], [leaf]);
  const poi = maps[LIST][leaf];
  shape(poi, [
    'snarkProof',
    'txidMerkleroot',
    'poiMerkleroots',
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield',
  ]);
  proof(poi.snarkProof);
  field(poi.txidMerkleroot, '');
  array(poi.poiMerkleroots, 1, (v) => field(v, ''));
  const result = {
    // Domain and EOA value are absent from COMMON. They are fixed only for this
    // no-unshield fixture, which the independent calldata verifier must enforce.
    domain: 'public-fixture-relay-pre-poi-v1',
    minGasPrice: Number(common.minGasPrice),
    transaction: {
      chainId: common.chainID,
      to: common.to.toLowerCase(),
      value: '0',
      data: common.data,
    },
    poi: {
      proof: poi.snarkProof,
      txidMerkleroot: '0x' + poi.txidMerkleroot,
      poiMerkleroots: poi.poiMerkleroots.map((v) => '0x' + v),
      blindedCommitmentsOut: poi.blindedCommitmentsOut,
      railgunTxidIfHasUnshield: poi.railgunTxidIfHasUnshield,
    },
  };
  assertPublicCase(result);
  return freeze(result);
}
function assertCaseUnchanged(originalBytes, reconstructed) {
  const expected = readPublicCase(originalBytes);
  assertPublicCase(reconstructed);
  // Compare data rather than parser object prototypes. Never return original.
  assert.deepEqual(JSON.parse(JSON.stringify(reconstructed)), JSON.parse(JSON.stringify(expected)));
}
module.exports = {
  LIMITS,
  POLICY,
  LIST,
  readPublicCase,
  selectRelayWireInput,
  assertSelectionCurrent,
  prePoiMap,
  publicCaseFromCommon,
  assertCaseUnchanged,
};
