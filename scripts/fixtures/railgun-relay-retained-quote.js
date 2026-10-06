/** Public-only retained fixture checks. No signing, key derivation or producer.
 * The caller authenticates context modules before supplying these helpers. */
'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const basis = require('./railgun-relay-retained-basis.json');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { validatePublicCase } = require('./railgun-relay-public-data');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function verifyRetainedQuote(context, publicCaseBytes, signedQuoteBytes, active) {
  // Snapshot before the first await. Parsing is not signature acceptance.
  assert.ok(publicCaseBytes instanceof Uint8Array && signedQuoteBytes instanceof Uint8Array);
  const publicBytes = Buffer.from(publicCaseBytes),
    quoteBytes = Buffer.from(signedQuoteBytes);
  const publicCase = data.readPublicCase(publicBytes);
  const packet = parser.parseSignedPacket(quoteBytes, data.POLICY);
  active();
  const publicKey = Buffer.from(basis.publicViewingKeyHex, 'hex');
  assert.equal(publicKey.length, 32);
  const masterPublicKey = context.poseidon([
    ...basis.feePublicCoordinates.map(BigInt),
    BigInt(basis.publicNullifyingValue),
  ]);
  const address = context.upstream.encodeAddress({
    masterPublicKey,
    viewingPublicKey: Uint8Array.from(publicKey),
    chain: data.POLICY.chain,
  });
  assert.equal(packet.candidate.railgunAddress, address);
  const decoded = context.upstream.getRailgunWalletAddressData(address);
  assert.equal(decoded.masterPublicKey, masterPublicKey);
  assert.deepEqual(Buffer.from(decoded.viewingPublicKey), publicKey);
  assert.deepEqual(decoded.chain, data.POLICY.chain);
  assert.equal(
    await context.upstream.verifyBroadcasterSignature(
      packet.signatureHex,
      packet.dataHex,
      decoded.viewingPublicKey
    ),
    true
  );
  active();
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    crypto.verify(null, packet.signedBytes, key, Buffer.from(packet.signatureHex, 'hex')),
    true
  );
  // A reproducible historical policy point, NOT evidence of original/current time.
  const expiry = packet.candidate.feeExpiration;
  assert.ok(Number.isSafeInteger(expiry));
  const historicalEvaluationAt = expiry - data.LIMITS.quoteLifetimeMs;
  assert.ok(Number.isSafeInteger(historicalEvaluationAt) && historicalEvaluationAt >= 0);
  const selection = data.selectRelayWireInput(
    quoteBytes,
    {
      address,
      viewingPublicKey: publicKey.toString('hex'),
      masterPublicKey: masterPublicKey.toString(),
    },
    historicalEvaluationAt,
    basis.maximumFee
  );
  for (const name of ['feesID', 'identifier', 'version'])
    assert.equal(selection.quote[name], basis[name]);
  assert.equal(selection.gasEstimate, basis.gasEstimate);
  assert.equal(selection.gasPrice, basis.gasPrice);
  assert.equal(selection.feeAmount, basis.feeAmount);
  assert.equal(selection.minGasPrice, '1');
  assert.equal(context.gas.EVMGasType.Type1, 1);
  const details = {
    evmGasType: context.gas.EVMGasType.Type1,
    gasEstimate: BigInt(basis.gasEstimate),
    gasPrice: BigInt(basis.gasPrice),
  };
  assert.equal(context.gas.calculateGasLimit(details.gasEstimate), 100n);
  assert.equal(context.gas.calculateMaximumGas(details), 100n);
  const fee = context.gas.calculateBroadcasterFeeERC20Amount(
    { tokenAddress: pins.wrappedNative, feePerUnitGas: selection.quote.fees[pins.wrappedNative] },
    details
  );
  assert.equal(fee.tokenAddress, pins.wrappedNative);
  assert.equal(fee.amount, BigInt(basis.feeAmount));
  assert.ok(fee.amount <= BigInt(basis.maximumFee) && fee.amount < 2n ** 120n);
  assert.ok(BigInt(selection.minGasPrice) < 2n ** 72n);
  const checked = validatePublicCase(publicCase, 1, context.poseidon);
  const feeNpk = context.poseidon([decoded.masterPublicKey, BigInt('0x' + basis.feeNoteRandomHex)]);
  const feeCommitment = context.poseidon([feeNpk, BigInt(fee.tokenAddress), fee.amount]);
  assert.equal(checked.transactionSignals[3], feeCommitment);
  active();
  return Object.freeze({
    publicCaseSha256: sha(publicBytes),
    signedQuoteSha256: sha(quoteBytes),
    publicKeyBasisSha256: basis.independentPublicKeyBasisSha256,
    signedDataSha256: sha(packet.signedBytes),
    originalQuoteSignatureVerified: true,
    publicRecipientAndFeeCommitmentBound: true,
    historicalEvaluationAt,
    historicalEvaluationDerivedFromExpiry: true,
    historicalWallClockEstablished: false,
    currentQuoteAdmission: false,
    uniqueQuoteCalldataCommitment: false,
    encryptionTranscriptReplayed: false,
    feeCiphertextDecryptableByBroadcaster: false,
    serviceAcceptanceQualified: false,
    authorityGranted: false,
  });
}
module.exports = { verifyRetainedQuote };
