/** Guarded fixture-only actual selected upstream crypto. Never imported by a
 * production authority path. Module loading itself performs no crypto work. */
const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
const { validatePublicCase } = require('./railgun-relay-public-data');
const { keccak256, toUtf8Bytes, getAddress } = require('ethers');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FEE_PUBLIC = [
  12413163600793827339124387033787304747178281335716960105995444885879464409721n,
  8010389973639104762288114662299334843185477277610438054266062296539834190376n,
];
const bytes = (value) => Buffer.from(JSON.stringify(value));
const plain = (value) => JSON.parse(JSON.stringify(value));
function checkedModule(filename, digest) {
  assert.ok(path.isAbsolute(filename) && fs.realpathSync(filename) === filename);
  assert.match(digest, /^[0-9a-f]{64}$/);
  const input = fs.readFileSync(filename);
  assert.equal(crypto.createHash('sha256').update(input).digest('hex'), digest);
  assert.equal(require.cache[require.resolve(filename)], undefined);
  return require(filename);
}
async function loadContext(input) {
  const manifest = require('./railgun-relay-wire/inputs').verifyBuild(
    input.wireBuild,
    input.wireBuildSha256
  );
  const upstream = checkedModule(
    path.join(input.wireBuild, 'upstream.cjs'),
    manifest.outputs['upstream.cjs'].sha256
  );
  const gas = checkedModule(input.gasBundle, input.gasBundleSha256);
  assert.deepEqual(
    Object.keys(gas).sort(),
    [
      'EVMGasType',
      'calculateBroadcasterFeeERC20Amount',
      'calculateGasLimit',
      'calculateGasPrice',
      'calculateMaximumGas',
    ].sort()
  );
  assert.equal(gas.EVMGasType.Type1, 1);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const poseidonModule = require(
    path.join(archive, 'node_modules/@railgun-community/engine/dist/utils/poseidon')
  );
  await poseidonModule.initPoseidonPromise;
  return { upstream, gas, poseidon: poseidonModule.poseidon };
}
function nodePrivate(seed) {
  return crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
}
async function recipientFor(context) {
  const seed = Buffer.alloc(32, 10);
  try {
    const signingKey = nodePrivate(seed);
    const key = crypto.createPublicKey(signingKey);
    const encoded = key.export({ format: 'der', type: 'spki' });
    assert.equal(encoded.subarray(0, 12).toString('hex'), '302a300506032b6570032100');
    const viewingPublicKey = encoded.subarray(12);
    assert.deepEqual(Buffer.from(await context.upstream.ed.getPublicKey(seed)), viewingPublicKey);
    const masterPublicKey = context.poseidon([...FEE_PUBLIC, 456n]);
    const address = context.upstream.encodeAddress({
      masterPublicKey,
      viewingPublicKey,
      chain: data.POLICY.chain,
    });
    const decoded = context.upstream.getRailgunWalletAddressData(address);
    assert.equal(decoded.masterPublicKey, masterPublicKey);
    assert.deepEqual(Buffer.from(decoded.viewingPublicKey), viewingPublicKey);
    assert.deepEqual(decoded.chain, data.POLICY.chain);
    return {
      recipient: {
        address,
        viewingPublicKey: viewingPublicKey.toString('hex'),
        masterPublicKey: masterPublicKey.toString(),
      },
      signingKey,
      publicKey: key,
    };
  } finally {
    seed.fill(0);
  }
}
function assertFee(context, selection) {
  const quoteRate = selection.quote.fees[pins.wrappedNative];
  const gasDetails = {
    evmGasType: context.gas.EVMGasType.Type1,
    gasEstimate: BigInt(selection.gasEstimate),
    gasPrice: BigInt(selection.gasPrice),
  };
  assert.equal(context.gas.calculateGasLimit(gasDetails.gasEstimate), 100n);
  assert.equal(context.gas.calculateMaximumGas(gasDetails), 100n);
  const fee = context.gas.calculateBroadcasterFeeERC20Amount(
    { tokenAddress: pins.wrappedNative, feePerUnitGas: quoteRate },
    gasDetails
  );
  assert.equal(fee.tokenAddress, pins.wrappedNative);
  assert.equal(fee.amount, 100n);
  assert.equal(fee.amount.toString(), selection.feeAmount);
  assert.ok(fee.amount <= BigInt(selection.maximumFee) && fee.amount < 2n ** 120n);
  assert.ok(BigInt(selection.minGasPrice) < 2n ** 72n);
}
async function verifySelection(context, supplied, nowMs) {
  const expected = await recipientFor(context);
  const packet = bytes({ data: supplied.signedDataHex, signature: supplied.signatureHex });
  const parsed = parser.parseSignedPacket(packet, data.POLICY);
  const decoded = context.upstream.getRailgunWalletAddressData(parsed.candidate.railgunAddress);
  assert.equal(parsed.candidate.railgunAddress, expected.recipient.address);
  assert.equal(decoded.masterPublicKey.toString(), expected.recipient.masterPublicKey);
  assert.deepEqual(
    Buffer.from(decoded.viewingPublicKey),
    Buffer.from(expected.recipient.viewingPublicKey, 'hex')
  );
  assert.deepEqual(decoded.chain, data.POLICY.chain);
  assert.equal(
    await context.upstream.verifyBroadcasterSignature(
      parsed.signatureHex,
      parsed.dataHex,
      decoded.viewingPublicKey
    ),
    true
  );
  assert.equal(
    crypto.verify(
      null,
      parsed.signedBytes,
      expected.publicKey,
      Buffer.from(parsed.signatureHex, 'hex')
    ),
    true
  );
  const selection = data.selectRelayWireInput(
    packet,
    expected.recipient,
    supplied.selectedAt,
    '100'
  );
  assert.deepEqual(plain(selection), plain(supplied));
  data.assertSelectionCurrent(selection, nowMs, selection.selectedAt);
  assertFee(context, selection);
  return selection;
}
async function createSelection(context, nowMs) {
  const { recipient, signingKey } = await recipientFor(context);
  const quote = {
    fees: { [pins.wrappedNative]: '0x' + (10n ** 18n).toString(16) },
    feeExpiration: nowMs + data.LIMITS.quoteLifetimeMs,
    feesID: 'PUBLIC-PROOF-WIRE-1',
    railgunAddress: recipient.address,
    identifier: 'PUBLIC FIXTURE ONLY',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [data.LIST],
    reliability: 0.95,
  };
  const signedBytes = bytes(quote);
  const packet = bytes({
    data: signedBytes.toString('hex'),
    signature: crypto.sign(null, signedBytes, signingKey).toString('hex'),
  });
  const selection = data.selectRelayWireInput(packet, recipient, nowMs, '100');
  // Actual verification, not the pure snapshot alone, gates producer admission.
  return verifySelection(context, selection, nowMs);
}
function independentLeaf(context, publicCase) {
  const checked = validatePublicCase(publicCase, 1, context.poseidon);
  const [, boundHash, nullifier, feeCommitment, selfCommitment] = checked.transactionSignals;
  const zero = BigInt(keccak256(toUtf8Bytes('Railgun'))) % FIELD;
  const txid = context.poseidon([
    context.poseidon([nullifier, ...Array(12).fill(zero)]),
    context.poseidon([feeCommitment, selfCommitment, ...Array(11).fill(zero)]),
    boundHash,
  ]);
  const position = 199999n * 65536n + 199999n;
  return context.poseidon([txid, 0n, position]).toString(16).padStart(64, '0');
}
function nativeDecrypt(ciphertext, sharedKey) {
  parser.validateEncryptedData(ciphertext, data.LIMITS.plaintextBytes);
  const framing = Buffer.from(ciphertext[0].slice(2), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, framing.subarray(0, 16), {
    authTagLength: 16,
  });
  decipher.setAuthTag(framing.subarray(16));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext[1].slice(2), 'hex')),
    decipher.final(),
  ]);
}
async function compose(context, selectionInput, original, active, now = Date.now) {
  active();
  let previous = now();
  const selection = await verifySelection(context, selectionInput, previous);
  active();
  const originalBytes = bytes(original);
  const leaf = independentLeaf(context, original);
  const map = data.prePoiMap(originalBytes, leaf);
  const current = () => {
    active();
    const wall = now();
    data.assertSelectionCurrent(selection, wall, previous);
    previous = wall;
  };
  current();
  const encrypted = await context.upstream.OfflineClientEncryptor.encryptTransaction(
    'V2_PoseidonMerkle',
    pins.proxy,
    original.transaction.data,
    selection.recipient.address,
    selection.quote.feesID,
    data.POLICY.chain,
    1n,
    false,
    map
  );
  let shared;
  try {
    current();
    const envelopeBytes = bytes({
      pubkey: encrypted.randomPubKey,
      encryptedData: encrypted.encryptedData,
    });
    const envelope = parser.parseRequestEnvelope(envelopeBytes, data.POLICY);
    const seed = Buffer.alloc(32, 10);
    try {
      shared = await context.upstream.ed.getSharedSecret(seed, Buffer.from(envelope.pubkey, 'hex'));
    } finally {
      seed.fill(0);
    }
    current();
    assert.deepEqual(Buffer.from(shared), Buffer.from(encrypted.sharedKey));
    assert.equal(shared.length, 32);
    assert.ok(shared.some((v) => v !== 0));
    const plaintext = nativeDecrypt(envelope.encryptedData, shared);
    assert.ok(plaintext.length <= data.LIMITS.plaintextBytes);
    const upstreamPlain = await context.upstream.tryDecryptData(envelope.encryptedData, shared);
    current();
    const parsed = parser.parseBoundedJson(plaintext, data.LIMITS, data.LIMITS.plaintextBytes);
    assert.deepEqual(plain(parsed), upstreamPlain);
    assert.equal(parsed.to, getAddress(pins.proxy));
    const reconstructed = data.publicCaseFromCommon(plaintext, selection, leaf);
    data.assertCaseUnchanged(originalBytes, reconstructed);
    assert.equal(independentLeaf(context, reconstructed), leaf);
    return {
      publicCase: reconstructed,
      checks: {
        originalQuoteRetained: true,
        sourceFeeEqualsProofFee: true,
        independentRecipientMatched: true,
        decryptedCalldataMatched: true,
        decryptedPrePoiMapMatched: true,
        decryptedInputReconstructed: true,
        upstreamAndNativeDecryptionMatched: true,
        quoteCurrentAfterEncryption: true,
        serviceAcceptanceQualified: false,
        authorityGranted: false,
      },
    };
  } finally {
    shared?.fill(0);
    encrypted.sharedKey?.fill(0);
  }
}
module.exports = { loadContext, createSelection, verifySelection, independentLeaf, compose };
