/** Full-value private transfer destination policy. The string checks are the only
 * part main can run; it has no engine. Decoding and sent-output checks take the
 * caller's pinned engine importer and run only in guarded viewing utilities.
 * Results are data about one exact intent, never selection or signing authority.
 */
const assert = require('assert/strict');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ADDRESS = /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/;
const KIND = 'railgun-private-transfer';
// Absent marker: the historical self-transfer meaning, recipient === own instanceId.
// Present marker: an explicitly foreign destination. No 'self' value is persisted,
// so every existing self record keeps its exact bytes and digests.
const FOREIGN = 'foreign';
function isRailgunForeignTransfer(selection) {
  return Object.hasOwn(selection, 'recipientRelationship');
}
function assertRailgunPrivateTransferRecipient(selection, instanceId) {
  assert.equal(selection.kind, KIND);
  if (!isRailgunForeignTransfer(selection)) {
    assert.equal(selection.recipient, instanceId);
    return 'self';
  }
  assert.equal(selection.recipientRelationship, FOREIGN);
  assert.equal(typeof selection.recipient, 'string');
  assert.match(selection.recipient, ADDRESS);
  assert.equal(typeof instanceId, 'string');
  assert.notEqual(selection.recipient, instanceId);
  return FOREIGN;
}
const hexKey = (value) => {
  assert.ok(value instanceof Uint8Array && value.byteLength === 32);
  return Buffer.from(value).toString('hex');
};
// Strict canonical decode: version 1, all chains or exactly the pinned chain, and
// byte-identical re-encoding. Either key equal to the spending account's own key
// refuses: such an address is not a different controlled account.
function decodeRailgunForeignDestination(imp, address, own) {
  assert.equal(typeof address, 'string');
  assert.match(address, ADDRESS);
  const { decodeAddress, encodeAddress } = imp('key-derivation/bech32');
  const decoded = decodeAddress(address);
  assert.equal(decoded.version, 1);
  if (decoded.chain !== undefined) assert.deepEqual(decoded.chain, { type: 0, id: pins.chainId });
  assert.equal(encodeAddress(decoded), address);
  const masterPublicKey = decoded.masterPublicKey;
  assert.ok(typeof masterPublicKey === 'bigint' && masterPublicKey > 0n && masterPublicKey < FIELD);
  const viewingPublicKey = Uint8Array.from(decoded.viewingPublicKey);
  const viewing = hexKey(viewingPublicKey);
  assert.ok(typeof own.masterPublicKey === 'bigint');
  assert.notEqual(masterPublicKey, own.masterPublicKey);
  assert.notEqual(viewing, hexKey(Uint8Array.from(own.viewingPublicKey)));
  return Object.freeze({
    masterPublicKey,
    viewingPublicKey,
    ...(decoded.chain === undefined ? {} : { chain: Object.freeze({ type: 0, id: pins.chainId }) }),
    version: 1,
  });
}
function bundleFields(bundle) {
  assert.ok(Array.isArray(bundle.ciphertext) && bundle.ciphertext.length === 4);
  for (const value of [
    ...bundle.ciphertext,
    bundle.blindedSenderViewingKey,
    bundle.blindedReceiverViewingKey,
  ])
    assert.match(value, /^0x[0-9a-f]{64}$/);
  assert.match(bundle.annotationData, /^0x(?:[0-9a-f]{2})*$/);
  // An ordinary transfer to another account carries no memo ciphertext at all.
  assert.equal(bundle.memo, '0x');
}
const bare = (value) => value.replace(/^0x/, '');
// Sender-side recovery of the ORIGINAL foreign output from its ciphertext with the
// spending account's own viewing key (isSentNote=true), as relay reconstruction
// does. This never encrypts, regenerates or randomizes an output.
async function verifyRailgunForeignOutput(imp, options) {
  const {
    bundle,
    viewingPrivateKey,
    sender,
    destination,
    value,
    tokenHash,
    commitment,
    tokenDataGetter,
    active,
  } = options;
  assert.equal(typeof active, 'function');
  bundleFields(bundle);
  assert.ok(typeof value === 'bigint' && value > 0n);
  assert.ok(typeof commitment === 'bigint' && commitment > 0n && commitment < FIELD);
  const { TransactNote } = imp('note/transact-note');
  const { ShieldNote } = imp('note/shield-note');
  const { getSharedSymmetricKey, getNoteBlindingKeys } = imp('utils/keys-utils');
  const { OutputType } = imp('models/formatted-types');
  const { MEMO_SENDER_RANDOM_NULL } = imp('models/transaction-constants');
  const blindedSender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
  const blindedReceiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
  let symmetric;
  try {
    symmetric = await getSharedSymmetricKey(viewingPrivateKey, blindedReceiver);
    active();
    assert.ok(symmetric instanceof Uint8Array && symmetric.length === 32);
    const output = await TransactNote.decrypt(
      'V2_PoseidonMerkle',
      { type: 0, id: pins.chainId },
      sender,
      {
        iv: bundle.ciphertext[0].slice(2, 34),
        tag: bundle.ciphertext[0].slice(34),
        data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
      },
      symmetric,
      bundle.memo,
      bundle.annotationData,
      viewingPrivateKey,
      blindedReceiver,
      blindedSender,
      true,
      false,
      tokenDataGetter,
      undefined,
      undefined
    );
    active();
    assert.ok(output && typeof output === 'object');
    assert.equal(output.receiverAddressData.masterPublicKey, destination.masterPublicKey);
    assert.equal(
      hexKey(output.receiverAddressData.viewingPublicKey),
      hexKey(destination.viewingPublicKey)
    );
    assert.equal(output.value, value);
    assert.equal(bare(output.tokenHash), bare(tokenHash));
    assert.equal(output.tokenData.tokenType, 0);
    assert.equal(output.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
    assert.equal(BigInt(output.tokenData.tokenSubID), 0n);
    assert.equal(output.outputType, OutputType.Transfer);
    assert.equal(output.walletSource, 'freedomfixture');
    assert.equal(output.memoText, undefined);
    assert.match(output.random, /^[0-9a-f]{32}$/);
    // A random sender blinding value means the recipient cannot recover this
    // account's address from the note (showSenderAddressToRecipient=false).
    assert.match(output.senderRandom, /^[0-9a-f]{30}$/);
    assert.notEqual(output.senderRandom, MEMO_SENDER_RANDOM_NULL);
    assert.equal(
      ShieldNote.getNotePublicKey(destination.masterPublicKey, output.random),
      output.notePublicKey
    );
    assert.equal(
      TransactNote.getHash(output.notePublicKey, output.tokenHash, output.value),
      output.hash
    );
    assert.equal(output.hash, commitment);
    const blinded = getNoteBlindingKeys(
      sender.viewingPublicKey,
      destination.viewingPublicKey,
      output.random,
      output.senderRandom
    );
    assert.equal(hexKey(blinded.blindedSenderViewingKey), hexKey(blindedSender));
    assert.equal(hexKey(blinded.blindedReceiverViewingKey), hexKey(blindedReceiver));
    return Object.freeze({
      notePublicKey: output.notePublicKey,
      value: output.value,
      hash: output.hash,
    });
  } finally {
    if (symmetric instanceof Uint8Array) symmetric.fill(0);
  }
}
module.exports = {
  isRailgunForeignTransfer,
  assertRailgunPrivateTransferRecipient,
  decodeRailgunForeignDestination,
  verifyRailgunForeignOutput,
};
