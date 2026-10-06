/** Fixed retained PUBLIC fixture only. Sender key08; never fee key0a or producer. */
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const basis = require('./railgun-relay-retained-basis.json');
const { validatePublicCase } = require('./railgun-relay-public-data');
const {
  assertReceiver,
  recoverOutput,
  expectRefusal,
} = require('./railgun-relay-sender-recovery-data');
const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
const PUBLIC_CASE_SHA = '3b415653aa2a797af98c41f7f56bb60b3dd877cca6bd0f47904633876aad3b38';
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
let attempted = false;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'publicCaseText']);
  assert.equal(typeof input.publicCaseText, 'string');
  assert.equal(Buffer.byteLength(input.publicCaseText), 5285);
  assert.equal(sha(input.publicCaseText), PUBLIC_CASE_SHA);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const keys = imp('utils/keys-utils'),
    { TransactNote } = imp('note/transact-note');
  const { ShieldNote } = imp('note/shield-note');
  const { getTokenDataERC20, getTokenDataHash } = imp('note/note-util');
  const api = {
    TransactNote,
    getNotePublicKey: ShieldNote.getNotePublicKey,
    getSharedSymmetricKey: keys.getSharedSymmetricKey,
    getNoteBlindingKeys: keys.getNoteBlindingKeys,
  };
  const raw = JSON.parse(input.publicCaseText);
  validatePublicCase(raw, 1, poseidon); // Structural/public signal joins only; no proof verification.
  const abi = new Interface([TRANSACT_ABI]),
    [transactions] = abi.decodeFunctionData('transact', raw.transaction.data);
  assert.equal(abi.encodeFunctionData('transact', [transactions]), raw.transaction.data);
  const tx = transactions[0],
    originalData = raw.transaction.data;
  const bundles = tx.boundParams.commitmentCiphertext.map((v) => ({
    ciphertext: [...v.ciphertext],
    blindedSenderViewingKey: v.blindedSenderViewingKey,
    blindedReceiverViewingKey: v.blindedReceiverViewingKey,
    annotationData: v.annotationData,
    memo: v.memo,
  }));
  const originalBundles = JSON.stringify(bundles);
  // Provenance: prepareRelayVector source initializes viewingKey=Buffer.alloc(32,8).
  const senderKey = Buffer.alloc(32, 8);
  let publicKey;
  const results = [];
  try {
    publicKey = await keys.getPublicViewingKey(senderKey);
    active();
    const nodePublic = crypto
      .createPublicKey(
        crypto.createPrivateKey({
          key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), senderKey]),
          format: 'der',
          type: 'pkcs8',
        })
      )
      .export({ format: 'der', type: 'spki' });
    assert.equal(
      nodePublic.toString('hex'),
      '302a300506032b6570032100' + Buffer.from(publicKey).toString('hex')
    );
    const sender = {
      masterPublicKey: poseidon([
        14422859473778768188622151430526693594403470008420308922992775064941455773685n,
        7592518773672929099542717438998516546396504563265155469693554058278098107299n,
        123n,
      ]),
      viewingPublicKey: publicKey,
    };
    const fee = {
      masterPublicKey: poseidon([
        ...basis.feePublicCoordinates.map(BigInt),
        BigInt(basis.publicNullifyingValue),
      ]),
      viewingPublicKey: Buffer.from(basis.publicViewingKeyHex, 'hex'),
    };
    const tokenData = getTokenDataERC20(pins.wrappedNative),
      tokenHash = getTokenDataHash(tokenData);
    const tokenDataGetter = {
      async getTokenDataFromHash(version, chain, value) {
        assert.equal(version, 'V2_PoseidonMerkle');
        assert.deepEqual(chain, { type: 0, id: pins.chainId });
        assert.equal(value.replace(/^0x/, ''), tokenHash.replace(/^0x/, ''));
        return tokenData;
      },
    };
    const expected = [fee, sender].map((receiver, index) => ({
      ...receiver,
      amount: index ? 900n : 100n,
      random: (index ? '03' : '02').repeat(16),
      senderRandom: (index ? '05' : '04').repeat(15),
      outputType: index ? 0 : 1,
      token: pins.wrappedNative,
      tokenHash,
    }));
    const run = (index, bundle = bundles[index], receiver = expected[index], observed = {}) =>
      recoverOutput({
        api,
        bundle,
        sender,
        senderKey,
        tokenDataGetter,
        expected: receiver,
        commitment: BigInt(tx.commitments[index]),
        active,
        observed,
      });
    for (let index = 0; index < 2; index++) {
      await run(index);
      active();
      results.push({ id: index ? 'self-sender-recovery' : 'fee-sender-recovery', accepted: true });
    }
    const refuse = async (id, action, mustDecrypt) => {
      const observed = await expectRefusal(
        action,
        mustDecrypt,
        path.join(archive, 'node_modules/@railgun-community/engine/dist/utils/encryption/aes.js'),
        active
      );
      results.push({
        id,
        refused: true,
        originalCiphertextDecryptedBeforeRefusal: observed.decrypted === true,
        exactFailureCauseIndependentlyAttributed: false,
      });
    };
    const flip = (value, index) =>
      value.slice(0, index) +
      (parseInt(value[index], 16) ^ 1).toString(16) +
      value.slice(index + 1);
    await refuse(
      'ciphertext-tamper',
      (observed) =>
        run(
          0,
          {
            ...bundles[0],
            ciphertext: [
              bundles[0].ciphertext[0],
              flip(bundles[0].ciphertext[1], 2),
              ...bundles[0].ciphertext.slice(2),
            ],
          },
          expected[0],
          observed
        ),
      false
    );
    // CTR senderRandom byte only: original GCM ciphertext/tag is unchanged.
    await refuse(
      'annotation-sender-random-tamper',
      (observed) =>
        run(
          0,
          { ...bundles[0], annotationData: flip(bundles[0].annotationData, 36) },
          expected[0],
          observed
        ),
      true
    );
    await refuse(
      'recipient-substitution',
      (observed) =>
        run(0, bundles[0], { ...expected[0], viewingPublicKey: sender.viewingPublicKey }, observed),
      true
    );
    const fallback = TransactNote.unblindViewingPublicKey(
      expected[0].random,
      undefined,
      expected[0].senderRandom,
      false
    );
    assert.equal(fallback.length, 0);
    assert.throws(() =>
      assertReceiver(
        {
          receiverAddressData: { masterPublicKey: fee.masterPublicKey, viewingPublicKey: fallback },
        },
        expected[0]
      )
    );
    results.push({
      id: 'empty-unblind-fallback-guard',
      refused: true,
      scope:
        'Actual upstream fallback value checked by strict identity guard; not a corrupted-ciphertext recovery claim',
    });
    assert.equal(JSON.stringify(bundles), originalBundles);
    assert.equal(abi.encodeFunctionData('transact', [transactions]), originalData);
    assert.equal(
      require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
        input.archive
      ),
      archive
    );
    active();
    assert.deepEqual(guardReport(), EXPECTED_GUARDS);
    const value = {
      publicCaseSha256: PUBLIC_CASE_SHA,
      engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
      senderKeySource: 'Published fixture viewingKey=Buffer.alloc(32,8)',
      senderViewingPublicKey: Buffer.from(publicKey).toString('hex'),
      senderPublicKeyNodeCompared: true,
      results,
      orderedAmounts: ['100', '900'],
      ciphertextAndCalldataUnchanged: true,
      feeRecipientPrivateKeyUsed: false,
      spendingKeyUsed: false,
      proofProduced: false,
      proofReverified: false,
      productionCapsuleImplemented: false,
      serviceAcceptanceQualified: false,
      authorityGranted: false,
      guards: guardReport(),
    };
    assert.deepEqual(
      JSON.parse(await request(JSON.stringify({ id: 1, method: 'result', value }))),
      { id: 1, value: null }
    );
    active();
  } finally {
    senderKey.fill(0);
  }
};
