/** Qualification-only sender recovery; caller supplies actual pinned engine APIs. */
const assert = require('assert/strict');
// Only the exact receiver viewing-key comparison can admit a semantic refusal.
const receiverViewingKeyErrors = new WeakSet();
function assertReceiver(output, expected) {
  assert.equal(output.receiverAddressData.masterPublicKey, expected.masterPublicKey);
  assert.ok(output.receiverAddressData.viewingPublicKey instanceof Uint8Array);
  assert.equal(output.receiverAddressData.viewingPublicKey.length, 32);
  const actualKey = Buffer.from(output.receiverAddressData.viewingPublicKey);
  const expectedKey = Buffer.from(expected.viewingPublicKey);
  try {
    assert.deepEqual(actualKey, expectedKey);
  } catch (error) {
    receiverViewingKeyErrors.add(error);
    throw error;
  }
}
async function recoverOutput({
  api,
  bundle,
  sender,
  senderKey,
  tokenDataGetter,
  expected,
  commitment,
  active,
  observed,
}) {
  active();
  assert.equal(bundle.memo, '0x');
  assert.match(bundle.annotationData, /^0x[0-9a-f]+$/);
  const blindedSender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
  const blindedReceiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
  const symmetric = await api.getSharedSymmetricKey(senderKey, blindedReceiver);
  assert.ok(symmetric instanceof Uint8Array && symmetric.length === 32);
  try {
    active();
    let output;
    try {
      output = await api.TransactNote.decrypt(
        'V2_PoseidonMerkle',
        { type: 0, id: 11155111 },
        sender,
        {
          iv: bundle.ciphertext[0].slice(2, 34),
          tag: bundle.ciphertext[0].slice(34),
          data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
        },
        symmetric,
        bundle.memo,
        bundle.annotationData,
        senderKey,
        blindedReceiver,
        blindedSender,
        true,
        false,
        tokenDataGetter,
        undefined,
        undefined
      );
    } catch (error) {
      observed.decryptError = error;
      throw error;
    }
    observed.decrypted = true;
    active();
    assertReceiver(output, expected);
    assert.equal(output.value, expected.amount);
    assert.equal(output.tokenData.tokenType, 0);
    assert.equal(output.tokenData.tokenAddress.toLowerCase(), expected.token);
    assert.equal(BigInt(output.tokenData.tokenSubID), 0n);
    assert.equal(output.tokenHash.replace(/^0x/, ''), expected.tokenHash.replace(/^0x/, ''));
    assert.equal(output.random, expected.random);
    assert.equal(output.senderRandom, expected.senderRandom);
    assert.equal(output.outputType, expected.outputType);
    assert.equal(output.walletSource, 'freedom');
    assert.equal(output.memoText, undefined);
    assert.equal(
      output.notePublicKey,
      api.getNotePublicKey(expected.masterPublicKey, output.random)
    );
    assert.equal(
      output.hash,
      api.TransactNote.getHash(output.notePublicKey, output.tokenHash, output.value)
    );
    assert.equal(output.hash, commitment);
    const blinded = api.getNoteBlindingKeys(
      sender.viewingPublicKey,
      expected.viewingPublicKey,
      output.random,
      output.senderRandom
    );
    assert.deepEqual(Buffer.from(blinded.blindedSenderViewingKey), blindedSender);
    assert.deepEqual(Buffer.from(blinded.blindedReceiverViewingKey), blindedReceiver);
    active();
    return output;
  } finally {
    symmetric.fill(0);
  }
}
function aesWrapperFailure(error, filename) {
  if (!(error instanceof Error) || error.message !== 'Unable to decrypt ciphertext.') return false;
  if (typeof error.stack !== 'string') return false;
  const frames = error.stack.split('\n').filter((line) => /^\s+at /.test(line));
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Pinned engine 9.6.0 wrapper throw. This does not attribute its backend cause.
  return (
    frames.length > 0 &&
    new RegExp('^\\s+at AES\\.decryptGCM \\(' + escaped + ':88:\\d+\\)$').test(frames[0])
  );
}
async function expectRefusal(action, mustDecrypt, aesFilename, active) {
  const observed = {};
  let error;
  try {
    await action(observed);
  } catch (caught) {
    error = caught;
  }
  active();
  assert.ok(error !== null && typeof error === 'object', 'Negative control must throw');
  if (mustDecrypt) {
    assert.equal(observed.decrypted, true);
    assert.ok(receiverViewingKeyErrors.has(error), 'Expected exact receiver viewing-key assertion');
    assert.equal(error.code, 'ERR_ASSERTION');
  } else {
    assert.equal(observed.decrypted, undefined);
    assert.equal(observed.decryptError, error, 'Expected original decrypt-stage error');
    assert.ok(aesWrapperFailure(error, aesFilename), 'Expected pinned AES wrapper failure');
  }
  return observed;
}
module.exports = { assertReceiver, recoverOutput, expectRefusal };
