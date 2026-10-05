/** Fresh viewing-only self-transfer or partial change check. No note database, preparer witness,
 * spending key, network or prover. The exact zero-proof intent is checked first.
 */
const assert = require('assert/strict'),
  path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  const input = JSON.parse(text);
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const checked = validateRailgunPrivateSigningIntent(input.transaction, input.expected);
  const partial = checked.kind === 'railgun-partial-unshield';
  assert.ok(partial || checked.kind === 'railgun-private-transfer');
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      partial ? 'inputAmount' : 'amount',
      'archive',
      'descriptor',
      'expected',
      'recipient',
      'transaction',
    ].sort()
  );
  assert.equal(input.recipient, input.descriptor.instanceId);
  const amount = partial ? input.inputAmount : input.amount;
  assert.match(amount, /^[1-9][0-9]{0,16}$/);
  assert.ok(BigInt(amount) <= BigInt(pins.maxQualificationAmount));
  const u = partial ? BigInt(checked.unshieldAmount) : 0n;
  if (partial) assert.ok(u > 0n && u < BigInt(amount));
  const change = BigInt(amount) - u;
  const amounts = partial
    ? {
        inputAmount: amount,
        unshieldAmount: checked.unshieldAmount,
        changeAmount: change.toString(),
      }
    : { amount };
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  active();
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet'),
    { TransactNote } = imp('note/transact-note');
  const { getPublicViewingKey, getSharedSymmetricKey } = imp('utils/keys-utils');
  const { getTokenDataERC20, getTokenDataHash } = imp('note/note-util');
  const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
    'transact',
    input.transaction.data
  );
  const bundle = tx.boundParams.commitmentCiphertext[0];
  active();
  const bytes = await requestKey(
    JSON.stringify({ id: 1, method: 'key', purpose: 'private-receive' })
  );
  assert.ok(bytes instanceof Uint8Array);
  const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let symmetric;
  try {
    assert.equal(key.length, 32);
    assert.ok(!signal.aborted);
    const descriptor = input.descriptor,
      pubkey = await getPublicViewingKey(key);
    active();
    assert.equal(Buffer.from(pubkey).toString('hex'), descriptor.viewingPublicKey);
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No receiver storage or prover');
        },
      }
    );
    const wallet = new ViewOnlyWallet(
      descriptor.walletId,
      denied,
      { privateKey: key, pubkey },
      descriptor.spendingPublicKey.map((v) => BigInt('0x' + v)),
      undefined,
      denied
    );
    assert.equal(wallet.getAddress(), descriptor.instanceId);
    assert.equal(wallet.masterPublicKey.toString(16).padStart(64, '0'), descriptor.masterPublicKey);
    assert.equal(
      ViewOnlyWallet.generateID(wallet.generateShareableViewingKey()),
      descriptor.walletId
    );
    const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex'),
      receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
    symmetric = await getSharedSymmetricKey(key, sender);
    active();
    assert.ok(symmetric);
    const tokenData = getTokenDataERC20(pins.wrappedNative),
      tokenHash = getTokenDataHash(tokenData);
    const note = await TransactNote.decrypt(
      'V2_PoseidonMerkle',
      { type: 0, id: pins.chainId },
      wallet.addressKeys,
      {
        iv: bundle.ciphertext[0].slice(2, 34),
        tag: bundle.ciphertext[0].slice(34),
        data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
      },
      symmetric,
      bundle.memo,
      bundle.annotationData,
      key,
      receiver,
      sender,
      false,
      false,
      {
        getTokenDataFromHash: async (_version, _chain, value) => {
          assert.equal(value.replace(/^0x/, ''), tokenHash.replace(/^0x/, ''));
          return tokenData;
        },
      },
      undefined,
      undefined
    );
    active();
    assert.equal(note.value, change);
    assert.equal(note.tokenHash.replace(/^0x/, ''), tokenHash.replace(/^0x/, ''));
    assert.equal(note.hash, BigInt(partial ? checked.changeCommitment : checked.commitment));
    if (partial) {
      assert.equal(
        imp('note/shield-note').ShieldNote.getNotePublicKey(wallet.masterPublicKey, note.random),
        note.notePublicKey
      );
      assert.equal(note.tokenData.tokenType, 0);
      assert.equal(note.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
      assert.equal(BigInt(note.tokenData.tokenSubID), 0n);
      assert.equal(bundle.memo, '0x');
      assert.equal(note.memoText, undefined);
      const annotation = imp('note/memo').Memo.decryptNoteAnnotationData(
        bundle.annotationData,
        key
      );
      assert.equal(annotation?.outputType, imp('models/formatted-types').OutputType.Change);
      assert.equal(
        annotation.senderRandom,
        imp('models/transaction-constants').MEMO_SENDER_RANDOM_NULL
      );
      assert.equal(
        imp('note/note-util').getNoteHash(checked.recipient, tokenData, u),
        BigInt(checked.unshieldCommitment)
      );
    }
    assert.equal(TransactNote.getHash(note.notePublicKey, note.tokenHash, note.value), note.hash);
  } finally {
    key.fill(0);
    symmetric?.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 2,
          method: 'result',
          value: {
            verified: true,
            transactionDigest: checked.digest,
            recipient: input.recipient,
            ...amounts,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
            guards,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
  active();
};
