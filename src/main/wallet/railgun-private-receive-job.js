/** Fresh viewing-only self-transfer check. No note database, preparer witness,
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
  assert.deepEqual(Object.keys(input).sort(), [
    'amount',
    'archive',
    'descriptor',
    'expected',
    'recipient',
    'transaction',
  ]);
  const checked = validateRailgunPrivateSigningIntent(input.transaction, input.expected);
  assert.equal(checked.kind, 'railgun-private-transfer');
  assert.equal(input.recipient, input.descriptor.instanceId);
  assert.match(input.amount, /^[1-9][0-9]{0,16}$/);
  assert.ok(BigInt(input.amount) <= BigInt(pins.maxQualificationAmount));
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet'),
    { TransactNote } = imp('note/transact-note');
  const { getPublicViewingKey, getSharedSymmetricKey } = imp('utils/keys-utils');
  const { getTokenDataERC20, getTokenDataHash } = imp('note/note-util');
  const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
    'transact',
    input.transaction.data
  );
  const bundle = tx.boundParams.commitmentCiphertext[0];
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
    assert.equal(note.value, BigInt(input.amount));
    assert.equal(note.tokenHash.replace(/^0x/, ''), tokenHash.replace(/^0x/, ''));
    assert.equal(note.hash, BigInt(checked.commitment));
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
            amount: input.amount,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
            guards,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
};
