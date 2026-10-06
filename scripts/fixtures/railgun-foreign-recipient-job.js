/** Disposable public-mnemonic accounts for the foreign-recipient qualification.
 * Account 0 is the enrolled sender A, 1 the recipient B and 2 an unrelated account
 * C, all derived from the published test mnemonic, never from a vault, profile or
 * user key. The receipt mode runs the production per-leaf wallet classifier, the
 * engine's per-leaf wallet scan and the production POI reconstruction over one
 * Transact event built from the real proved calldata. No store, network, prover,
 * signer, submission or disclosure capability.
 */
const assert = require('assert/strict'),
  path = require('path'),
  { createRequire } = require('module');
const { Interface } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHAIN = Object.freeze({ type: 0, id: pins.chainId });
const VERSION = 'V2_PoseidonMerkle';
const ADDRESS = /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/;
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const bare = (value) => {
  assert.equal(typeof value, 'string');
  return value.replace(/^0x/, '').toLowerCase();
};
// The genuine identity job's descriptor shape, from the public derivation paths.
async function deriveAccounts(imp, signal) {
  const { deriveRailgunKey } = require('../../src/main/identity/railgun-key-derivation');
  const { getPublicSpendingKey, getPublicViewingKey } = imp('utils/keys-utils');
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
  const denied = new Proxy(
    {},
    {
      get() {
        throw Error('No fixture store or prover');
      },
    }
  );
  const seed = require('@scure/bip39').mnemonicToSeedSync(MNEMONIC);
  const accounts = [];
  try {
    for (const accountIndex of [0, 1, 2]) {
      const spending = deriveRailgunKey(seed, `m/44'/1984'/0'/0'/${accountIndex}'`);
      let spendingPublicKey;
      try {
        spendingPublicKey = getPublicSpendingKey(spending);
      } finally {
        spending.fill(0);
      }
      const viewingKey = deriveRailgunKey(seed, `m/420'/1984'/0'/0'/${accountIndex}'`);
      const account = { viewingKey };
      accounts.push(account);
      const pair = { privateKey: viewingKey, pubkey: await getPublicViewingKey(viewingKey) };
      assert.ok(!signal.aborted);
      const probe = new ViewOnlyWallet(
        '0'.repeat(64),
        denied,
        pair,
        spendingPublicKey,
        undefined,
        denied
      );
      const walletId = ViewOnlyWallet.generateID(probe.generateShareableViewingKey());
      account.wallet = new ViewOnlyWallet(
        walletId,
        denied,
        pair,
        spendingPublicKey,
        undefined,
        denied
      );
      account.descriptor = {
        instanceId: account.wallet.getAddress(),
        masterPublicKey: hex(account.wallet.masterPublicKey),
        spendingPublicKey: spendingPublicKey.map(hex),
        viewingPublicKey: Buffer.from(pair.pubkey).toString('hex'),
        walletId,
        accountIndex,
      };
      assert.match(account.descriptor.instanceId, ADDRESS);
    }
    assert.equal(new Set(accounts.map((account) => account.descriptor.instanceId)).size, 3);
    return accounts;
  } catch (error) {
    for (const account of accounts) account.viewingKey.fill(0);
    throw error;
  } finally {
    seed.fill(0);
  }
}
function outputOf(data) {
  const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData('transact', data);
  assert.equal(tx.nullifiers.length, 1);
  assert.equal(tx.commitments.length, 1);
  assert.equal(tx.boundParams.commitmentCiphertext.length, 1);
  assert.equal(tx.unshieldPreimage.value, 0n);
  const c = tx.boundParams.commitmentCiphertext[0];
  return {
    tree: Number(tx.boundParams.treeNumber),
    nullifier: tx.nullifiers[0],
    commitment: tx.commitments[0],
    ciphertext: {
      ciphertext: [...c.ciphertext],
      blindedSenderViewingKey: c.blindedSenderViewingKey,
      blindedReceiverViewingKey: c.blindedReceiverViewingKey,
      annotationData: c.annotationData,
      memo: c.memo,
    },
  };
}
async function receipt(input, { imp, archive, accounts, signal }) {
  const [sender, recipient, unrelated] = accounts;
  const active = () => assert.ok(!signal.aborted);
  assert.deepEqual(input.descriptor, sender.descriptor);
  const capsule =
    require('../../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule(
      input.capsule
    );
  const { selection, preparation } = capsule;
  assert.equal(capsule.walletId, sender.descriptor.walletId);
  assert.equal(selection.kind, 'railgun-private-transfer');
  assert.equal(selection.recipientRelationship, 'foreign');
  assert.equal(selection.recipient, recipient.descriptor.instanceId);
  const value = BigInt(preparation.amount),
    expected = preparation.expected;
  // The proved calldata carries the reviewed output and the signed ciphertext.
  const proved = outputOf(input.provedData);
  assert.deepEqual(proved, outputOf(preparation.transaction.data));
  assert.equal(proved.tree, selection.tree);
  assert.equal(proved.commitment, expected.commitment);
  assert.equal(proved.nullifier, expected.nullifier);
  const position = input.outputPosition;
  assert.ok(Number.isSafeInteger(position) && position > 0 && position < 65536);
  // The supplied event is parsed and formatted exactly as the public scan does.
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const ethers = r('ethers');
  const sourceAbi = new ethers.Interface(
    require(path.join(root, 'abi/V2.1/RailgunSmartWallet.json'))
  );
  const { parseRailgunSourceEvent } = require('../../src/main/wallet/railgun-event-projector');
  const event = parseRailgunSourceEvent(
    sourceAbi,
    { topics: [...input.event.topics], data: input.event.data },
    0,
    ethers
  );
  assert.equal(event.name, 'Transact');
  assert.equal(Number(event.args.treeNumber), selection.tree);
  assert.equal(Number(event.args.startPosition), position);
  assert.deepEqual([...event.args.hash], [expected.commitment]);
  const { V2Events } = imp('contracts/railgun-smart-wallet/V2/V2-events');
  const formatted = V2Events.formatTransactEvent(
    event.args,
    input.transactionHash,
    input.blockNumber,
    undefined
  );
  assert.equal(formatted.commitments.length, 1);
  const [leaf] = formatted.commitments;
  assert.equal(leaf.commitmentType, 'TransactCommitmentV2');
  assert.equal(leaf.utxoTree, selection.tree);
  assert.equal(leaf.utxoIndex, position);
  assert.equal(bare(leaf.hash), bare(expected.commitment));
  const plain = (data) => JSON.parse(JSON.stringify(data));
  assert.deepEqual(
    plain(leaf.ciphertext),
    plain(V2Events.formatCommitmentCiphertext(proved.ciphertext))
  );
  // The wallet job's runtime; the scan sets the same resolver as token getter.
  const runtime = {
    ...imp('note/note-util'),
    ...imp('note/shield-note'),
    ...imp('note/transact-note'),
    ...imp('utils/keys-utils'),
    ...imp('utils/encryption/aes'),
    ...imp('note/memo'),
    ...imp('utils/bytes'),
  };
  const {
    createRailgunTokenResolver,
    inspectRailgunTransact,
  } = require('../../src/main/wallet/railgun-wallet-records');
  const msgpack = createRequire(path.join(root, 'wallet/abstract-wallet.js'))('msgpack-lite');
  const scan = async ({ wallet }) => {
    const tokenResolver = createRailgunTokenResolver({
      sourceTokens: [],
      getTokenDataHash: runtime.getTokenDataHash,
      getTokenDataERC20: runtime.getTokenDataERC20,
    });
    const inspected = await inspectRailgunTransact({ ...runtime, leaf, wallet, tokenResolver });
    active();
    wallet.tokenDataGetter = tokenResolver;
    const puts = await wallet.createScannedDBCommitments(
      VERSION,
      leaf,
      wallet.getViewingKeyPair().privateKey,
      selection.tree,
      CHAIN,
      position,
      position + 1
    );
    active();
    tokenResolver.assertComplete();
    const key = (name) => wallet[name](CHAIN, selection.tree, position).join(':');
    const receive = puts.filter((put) => put.key === key('getWalletReceiveCommitmentDBPrefix'));
    const sent = puts.filter((put) => put.key === key('getWalletSentCommitmentDBPrefix'));
    assert.ok(puts.every((put) => put.type === 'put'));
    assert.equal(receive.length + sent.length, puts.length);
    return {
      inspected: { ...inspected },
      tokenResolver,
      receive: receive.map((put) => msgpack.decode(put.value)),
      sent: sent.map((put) => msgpack.decode(put.value)),
    };
  };
  const { TransactNote } = imp('note/transact-note');
  const { ShieldNote } = imp('note/shield-note');
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const { getGlobalTreePosition } = imp('poi/global-tree-position');
  const { OutputType } = imp('models/formatted-types');
  const globalPosition = getGlobalTreePosition(selection.tree, position);
  // B: an ordinary received note of the full value with no sender address.
  const asRecipient = await scan(recipient);
  assert.deepEqual(asRecipient.inspected, { status: 'matched', receive: true, sent: false });
  assert.equal(asRecipient.sent.length, 0);
  assert.equal(asRecipient.receive.length, 1);
  const [stored] = asRecipient.receive;
  assert.equal(stored.spendtxid, false);
  assert.equal(stored.senderAddress ?? undefined, undefined);
  assert.equal(stored.decrypted.senderAddress ?? undefined, undefined);
  assert.equal(stored.decrypted.memoText ?? undefined, undefined);
  assert.equal(stored.decrypted.recipientAddress, recipient.descriptor.instanceId);
  assert.equal(bare(stored.txid), bare(input.transactionHash));
  const note = await TransactNote.deserialize(
    VERSION,
    CHAIN,
    stored.decrypted,
    recipient.wallet.getViewingKeyPair().privateKey,
    asRecipient.tokenResolver
  );
  active();
  assert.equal(note.senderAddressData, undefined);
  assert.equal(note.value, value);
  assert.equal(note.hash, BigInt(expected.commitment));
  assert.equal(
    ShieldNote.getNotePublicKey(recipient.wallet.masterPublicKey, note.random),
    note.notePublicKey
  );
  assert.equal(
    bare(stored.blindedCommitment),
    bare(
      BlindedCommitment.getForShieldOrTransact(
        expected.commitment,
        note.notePublicKey,
        globalPosition
      )
    )
  );
  // A: only its own sent record of an ordinary Transfer to B; never a receipt.
  const asSender = await scan(sender);
  assert.deepEqual(asSender.inspected, { status: 'matched', receive: false, sent: true });
  assert.equal(asSender.receive.length, 0);
  assert.equal(asSender.sent.length, 1);
  assert.equal(asSender.sent[0].recipientAddress, recipient.descriptor.instanceId);
  assert.equal(asSender.sent[0].outputType, OutputType.Transfer);
  assert.equal(bare(asSender.sent[0].blindedCommitment), bare(stored.blindedCommitment));
  // C: the output is not addressed to an unrelated account in either direction.
  const asUnrelated = await scan(unrelated);
  assert.deepEqual(asUnrelated.inspected, { status: 'not-addressed', receive: false, sent: false });
  assert.equal(asUnrelated.receive.length + asUnrelated.sent.length, 0);
  // A's POI reconstruction blinds B's received note, not an output of A's own.
  const { reconstructRailgunPoiNotes } = require('../../src/main/wallet/railgun-poi-reconstruct');
  const options = {
    archive,
    descriptor: sender.descriptor,
    viewingKey: sender.viewingKey,
    capsule: input.capsule,
    creator: input.creator,
    signal,
  };
  const notes = await reconstructRailgunPoiNotes(options);
  active();
  assert.deepEqual(notes.npksOut, [note.notePublicKey]);
  assert.deepEqual(notes.valuesOut, [value]);
  assert.equal(
    TransactNote.getHash(notes.npksOut[0], note.tokenHash, notes.valuesOut[0]),
    BigInt(expected.commitment)
  );
  assert.notEqual(
    notes.npksOut[0],
    ShieldNote.getNotePublicKey(sender.wallet.masterPublicKey, note.random)
  );
  const blindedOutput = BlindedCommitment.getForShieldOrTransact(
    expected.commitment,
    notes.npksOut[0],
    globalPosition
  );
  assert.equal(bare(blindedOutput), bare(stored.blindedCommitment));
  // A destination changed after review fails the sent-output check here too.
  const altered = JSON.parse(JSON.stringify(input.capsule));
  altered.selection.recipient = unrelated.descriptor.instanceId;
  altered.preparation.recipient = unrelated.descriptor.instanceId;
  await assert.rejects(() => reconstructRailgunPoiNotes({ ...options, capsule: altered }));
  active();
  return {
    mode: 'receipt',
    accounts: accounts.map((account) => account.descriptor),
    creatorType: input.creator.type,
    recipient: {
      classification: asRecipient.inspected.status,
      receivedRecords: 1,
      sentRecords: 0,
      senderAddressHidden: true,
      memoAbsent: true,
      fullValue: true,
      npk: '0x' + hex(note.notePublicKey),
      blindedCommitment: '0x' + bare(stored.blindedCommitment),
    },
    sender: {
      classification: asSender.inspected.status,
      receivedRecords: 0,
      sentRecords: 1,
      sentRecipientIsDestination: true,
      outputType: 'Transfer',
    },
    unrelated: {
      classification: asUnrelated.inspected.status,
      receivedRecords: 0,
      sentRecords: 0,
    },
    poi: {
      npkOutIsRecipientNpk: true,
      valueOutIsFullValue: true,
      outputHashIsReviewedCommitment: true,
      blindedOutputIsRecipientBlindedCommitment: true,
      alteredDestinationRefused: true,
    },
  };
}
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.ok(['addresses', 'receipt'].includes(input.mode));
  assert.deepEqual(
    Object.keys(input).sort(),
    input.mode === 'addresses'
      ? ['archive', 'mode']
      : [
          'archive',
          'blockNumber',
          'capsule',
          'creator',
          'descriptor',
          'event',
          'mode',
          'outputPosition',
          'provedData',
          'transactionHash',
        ]
  );
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  assert.ok(!signal.aborted);
  const accounts = await deriveAccounts(imp, signal);
  let value;
  try {
    if (input.mode === 'addresses') {
      // A's own keys under the pinned-chain encoding: a different string that
      // main's string policy reviews as foreign and the utilities must refuse.
      const ownChainAddress = imp('key-derivation/bech32').encodeAddress({
        ...accounts[0].wallet.addressKeys,
        chain: CHAIN,
      });
      assert.match(ownChainAddress, ADDRESS);
      assert.notEqual(ownChainAddress, accounts[0].descriptor.instanceId);
      value = {
        mode: 'addresses',
        accounts: accounts.map((account) => account.descriptor),
        ownChainAddress,
      };
    } else value = await receipt(input, { imp, archive, accounts, signal });
  } finally {
    for (const account of accounts) account.viewingKey.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'result', value: { ...value, guards } }))
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
