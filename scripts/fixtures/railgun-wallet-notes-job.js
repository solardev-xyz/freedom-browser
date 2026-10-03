/** Offline note semantics probe. The viewing vector and encryption keys below
 * are public test fixtures, never user material. No signing or network grant.
 */
const guards = require('../../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
  onRefusal: () => process.exit(2),
});
const assert = require('assert/strict'),
  path = require('path'),
  fs = require('fs'),
  { createRequire } = require('module');
async function main() {
  const [directory, mode, scenario = 'normal'] = process.argv.slice(2);
  const scanMode = 'guarded';
  assert.ok(
    [
      'normal',
      'corrupt',
      'wrong-npk',
      'foreign',
      'nft-missing',
      'nft-known',
      'wrong-npk-nft',
      'same-range-spent',
      'transact',
      'transact-mismatch',
      'engine-drop',
    ].includes(scenario)
  );
  const sourceSha256 = Object.fromEntries(
    [
      'scripts/fixtures/railgun-wallet-notes-job.js',
      'scripts/railgun-fixture-integrity.js',
      'src/main/wallet/railgun-leveldown.js',
      'src/main/wallet/railgun-paged-store.js',
      'src/main/wallet/railgun-store-cursor.js',
      'src/main/wallet/railgun-event-projector.js',
      'src/main/wallet/railgun-process-guards.js',
      'src/main/wallet/railgun-wallet-records.js',
    ].map((file) => [
      file,
      require('crypto')
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '../..', file)))
        .digest('hex'),
    ])
  );
  assert.ok(path.isAbsolute(directory) && ['create', 'cold', 'spent', 'cold-spent'].includes(mode));
  const fixture = path.join(__dirname, 'railgun-engine');
  const inventory = require('../railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  const r = createRequire(path.join(fixture, 'package.json')),
    root = path.dirname(r.resolve('@railgun-community/engine'));
  const { Database } = require(path.join(root, 'database/database'));
  const { ViewOnlyWallet } = require(path.join(root, 'wallet/view-only-wallet'));
  require(path.join(root, 'wallet/wallet-info')).default.setWalletSource('freedomfixture');
  const { UTXOMerkletree } = require(path.join(root, 'merkletree/utxo-merkletree'));
  const { ShieldNoteERC20 } = require(path.join(root, 'note/erc20/shield-note-erc20'));
  const { V2Events } = require(path.join(root, 'contracts/railgun-smart-wallet/V2/V2-events'));
  const { POI } = require(path.join(root, 'poi/poi'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  const { MERKLE_ZERO_VALUE } = require(path.join(root, 'models/merkletree-types'));
  await initPoseidonPromise;
  let poiCalls = 0;
  POI.init(
    [{ key: 'public-fixture-list', type: 'Active', name: 'Fixture', description: 'Offline test' }],
    new Proxy(
      {},
      {
        get: () => async () => {
          poiCalls++;
          throw new Error('No POI capability');
        },
      }
    )
  );
  const { createPrivacyScope } = require('../../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'public-note-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'storage',
  });
  const store = require('../../src/main/wallet/railgun-paged-store').createRailgunPagedStore({
    handle,
    filename: path.join(directory, 'notes.sqlite'),
    key: Buffer.alloc(32, 71),
    binding: '7'.repeat(64),
    create: mode === 'create',
    onFatal: () => scope.close(),
  });
  const leveldown = require('../../src/main/wallet/railgun-leveldown').createRailgunLeveldown({
    ...r('abstract-leveldown'),
    store,
  });
  const db = new Database(leveldown),
    chain = { type: 0, id: 11155111 },
    version = 'V2_PoseidonMerkle';
  const shared =
    '82a57670726976d94034326232623861643234306331323630396633623265363865656137613636373330306437373332633335346238373338343266373433313135313836303066a473707562d94061316166356531353935616330303736303734646465653034323737356230363365366434653666313966613632633333323935636336643363646635313165';
  const refuse = () => {
    throw new Error('No proving or signing capability');
  };
  const wallet = await ViewOnlyWallet.fromShareableViewingKey(
    db,
    '72'.repeat(32),
    shared,
    undefined,
    new Proxy({}, { get: () => refuse })
  );
  const token = '0x' + '12'.repeat(20),
    txid = '34'.repeat(32),
    spentTxid = '56'.repeat(32);
  let expected, leaves;
  if (mode === 'create') {
    const shields = [];
    for (const [index, value] of [1000n, 2000n].entries()) {
      let note = new ShieldNoteERC20(
        wallet.masterPublicKey,
        (index ? '22' : '11').repeat(16),
        value,
        token
      );
      if (index === 0 && ['nft-missing', 'nft-known', 'wrong-npk-nft'].includes(scenario)) {
        const { ShieldNoteNFT } = require(path.join(root, 'note/nft/shield-note-nft'));
        note = new ShieldNoteNFT(wallet.masterPublicKey, '11'.repeat(16), 1n, {
          tokenType: 1,
          tokenAddress: token,
          tokenSubID: '0x' + '00'.repeat(31) + '01',
        });
      }
      const recipient =
        index === 0 && scenario === 'foreign'
          ? await require(path.join(root, 'utils/keys-utils')).getPublicViewingKey(
              Buffer.alloc(32, 99)
            )
          : wallet.viewingPublicKey;
      shields.push(await note.serialize(Uint8Array.from(Buffer.alloc(32, index + 1)), recipient));
    }
    if (scenario === 'corrupt') shields[0].ciphertext.encryptedBundle[0] = '0x' + 'ff'.repeat(32);
    if (['wrong-npk', 'wrong-npk-nft'].includes(scenario))
      shields[0].preimage.npk = '0x' + '00'.repeat(31) + '01';
    const { Interface } = require('ethers');
    const abi = new Interface(
      JSON.parse(fs.readFileSync(path.join(root, 'abi/V2.1/RailgunSmartWallet.json')))
    );
    let encoded;
    if (scenario.startsWith('transact')) {
      const { TransactNote } = require(path.join(root, 'note/transact-note'));
      const { getTokenDataERC20 } = require(path.join(root, 'note/note-util'));
      const { getNoteBlindingKeys, getSharedSymmetricKey } = require(
        path.join(root, 'utils/keys-utils')
      );
      const hashes = [],
        ciphertexts = [];
      for (const amount of [1000n, 2000n]) {
        const note = TransactNote.createTransfer(
          wallet.addressKeys,
          wallet.addressKeys,
          amount,
          getTokenDataERC20(token),
          true,
          0,
          'public fixture'
        );
        const blind = getNoteBlindingKeys(
          wallet.viewingPublicKey,
          wallet.viewingPublicKey,
          note.random,
          note.senderRandom
        );
        const key = await getSharedSymmetricKey(
          wallet.viewingKeyPair.privateKey,
          blind.blindedReceiverViewingKey
        );
        const encrypted = note.encryptV2(
          version,
          key,
          wallet.masterPublicKey,
          note.senderRandom,
          wallet.viewingKeyPair.privateKey
        );
        key.fill(0);
        hashes.push(note.hash);
        ciphertexts.push({
          ciphertext: [
            '0x' + encrypted.noteCiphertext.iv + encrypted.noteCiphertext.tag,
            ...encrypted.noteCiphertext.data.map((v) => '0x' + v),
          ],
          blindedSenderViewingKey:
            '0x' + Buffer.from(blind.blindedSenderViewingKey).toString('hex'),
          blindedReceiverViewingKey:
            '0x' + Buffer.from(blind.blindedReceiverViewingKey).toString('hex'),
          annotationData: '0x' + encrypted.annotationData.replace(/^0x/, ''),
          memo: '0x' + encrypted.noteMemo.replace(/^0x/, ''),
        });
      }
      if (scenario === 'transact-mismatch') hashes[0] = 1n;
      encoded = abi.encodeEventLog(abi.getEvent('Transact'), [
        0,
        0,
        hashes.map((hash) => '0x' + hash.toString(16).padStart(64, '0')),
        ciphertexts,
      ]);
    } else
      encoded = abi.encodeEventLog(abi.getEvent('Shield'), [
        0,
        0,
        shields.map((v) => v.preimage),
        shields.map((v) => v.ciphertext),
        [0, 0],
      ]);
    const log = { ...encoded, transactionHash: '0x' + txid, blockNumber: 100, logIndex: 0 };
    const projector =
      require('../../src/main/wallet/railgun-event-projector').createRailgunEventProjector({
        abi,
        V2Events,
        poseidonHex,
        zero: MERKLE_ZERO_VALUE,
      });
    leaves = projector.add(log).leaves;
    expected = projector.finish('a'.repeat(64));
    fs.writeFileSync(path.join(directory, 'public-state.json'), JSON.stringify(expected), {
      flag: 'wx',
      mode: 0o600,
    });
  } else expected = JSON.parse(fs.readFileSync(path.join(directory, 'public-state.json')));
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, number, last, root) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(number, 0);
    assert.equal(last, 1);
    assert.equal('0x' + root, expected.trees[0].root);
    return true;
  });
  if (mode === 'create') await tree.insertLeaves(0, 0, leaves);
  assert.equal(await tree.getTreeLength(0), 2);
  assert.equal('0x' + (await tree.getRoot(0)), expected.trees[0].root);
  await wallet.loadUTXOMerkletree(version, tree);
  if (scenario === 'same-range-spent') {
    const { TransactNote } = require(path.join(root, 'note/transact-note'));
    await tree.nullify([
      {
        treeNumber: 0,
        nullifier: TransactNote.getNullifier(wallet.nullifyingKey, 0)
          .toString(16)
          .padStart(64, '0'),
        txid: spentTxid,
        blockNumber: 100,
      },
    ]);
  }
  let ticked = 0,
    resolver,
    preflight = [];
  let scanLeaves = await tree.getCommitmentRange(0, 0, 1);
  {
    const {
      createRailgunTokenResolver,
      inspectRailgunShield,
      inspectRailgunTransact,
    } = require('../../src/main/wallet/railgun-wallet-records');
    const { getTokenDataHash, getTokenDataERC20 } = require(path.join(root, 'note/note-util'));
    const { ShieldNote } = require(path.join(root, 'note/shield-note'));
    const { getSharedSymmetricKey } = require(path.join(root, 'utils/keys-utils'));
    resolver = createRailgunTokenResolver({
      sourceTokens: scanLeaves
        .filter((leaf) => leaf.commitmentType === 'ShieldCommitment')
        .map((leaf) => leaf.preImage.token)
        .filter(
          (token) => token.tokenType === 0 || !['nft-missing', 'wrong-npk-nft'].includes(scenario)
        ),
      getTokenDataHash,
      getTokenDataERC20,
    });
    wallet.tokenDataGetter = resolver;
    try {
      for (const leaf of scanLeaves)
        preflight.push(
          await (
            leaf.commitmentType === 'ShieldCommitment'
              ? inspectRailgunShield
              : inspectRailgunTransact
          )({
            TransactNote: require(path.join(root, 'note/transact-note')).TransactNote,
            AES: require(path.join(root, 'utils/encryption/aes')).AES,
            Memo: require(path.join(root, 'note/memo')).Memo,
            ByteUtils: require(path.join(root, 'utils/bytes')).ByteUtils,
            leaf,
            wallet,
            ShieldNote,
            getSharedSymmetricKey,
            getTokenDataHash,
            tokenResolver: resolver,
          })
        );
    } catch {
      assert.equal(scenario, 'nft-missing');
      assert.throws(() => resolver.assertComplete());
      fs.writeFileSync(
        path.join(directory, mode + '.json'),
        JSON.stringify(
          {
            mode,
            scenario,
            scanMode,
            sourceSha256,
            inventory: inventory.sha256,
            scanRefused: true,
            reason: 'source-token-preimage-unavailable',
            spendableGranted: false,
            balancePublished: false,
            guards: guards.report(),
            poiCalls,
          },
          null,
          2
        ),
        { flag: 'wx', mode: 0o600 }
      );
      store.close();
      scope.close();
      return;
    }
    scanLeaves = scanLeaves.map((leaf, index) =>
      preflight[index].status === 'matched' ? leaf : undefined
    );
  }
  const { TransactNote: Note } = require(path.join(root, 'note/transact-note'));
  const originalDeserialize = Note.deserialize;
  if (scenario === 'engine-drop')
    Note.deserialize = async (...args) => {
      if (BigInt('0x' + args[2].value.replace(/^0x/, '')) === 1000n)
        throw new Error('Injected deserialization failure');
      return originalDeserialize.apply(Note, args);
    };
  try {
    if (mode === 'create')
      await wallet.scanLeaves(version, scanLeaves, 0, chain, 0, () => ticked++);
  } finally {
    Note.deserialize = originalDeserialize;
  }
  let txos = await wallet.TXOs(version, chain);
  const dropped =
    ['corrupt', 'foreign', 'nft-missing', 'transact-mismatch', 'engine-drop'].includes(scenario) ||
    ['wrong-npk', 'wrong-npk-nft'].includes(scenario);
  assert.equal(txos.length, dropped ? 1 : 2);

  let mismatchedNotes = 0;
  assert.deepEqual(
    txos.map((v) => v.note.value),
    dropped ? [2000n] : scenario === 'nft-known' ? [1n, 2000n] : [1000n, 2000n]
  );
  for (const txo of txos) {
    const leaf = await tree.getCommitment(0, txo.position);
    if (txo.note.hash.toString(16).padStart(64, '0') !== leaf.hash) mismatchedNotes++;
    else assert.notEqual(scenario === 'wrong-npk' && txo.position === 0, true);
    assert.equal(txo.note.tokenData.tokenAddress.toLowerCase(), token);
  }
  if (mode === 'spent') {
    await tree.nullify([
      { treeNumber: 0, nullifier: txos[0].nullifier, txid: spentTxid, blockNumber: 101 },
    ]);
    wallet.invalidateCommitmentsCache(chain);
    txos = await wallet.TXOs(version, chain);
  }
  assert.equal(mismatchedNotes, 0);
  const spent = ['spent', 'cold-spent'].includes(mode) || scenario === 'same-range-spent';
  for (const txo of txos)
    assert.equal(txo.spendtxid, spent && txo.position === 0 ? spentTxid : false);
  {
    const { TransactNote } = require(path.join(root, 'note/transact-note'));
    let validation;
    try {
      validation =
        await require('../../src/main/wallet/railgun-wallet-records').validateRailgunWalletRecords({
          txos,
          expectedReceived: preflight.flatMap((value, position) =>
            value.receive ? [{ tree: 0, position }] : []
          ),
          trees: expected.trees,
          readCommitment: (treeNumber, position) => tree.getCommitment(treeNumber, position),
          readNullifier: (nullifier, treeNumber) => tree.getNullifierTxid(nullifier, treeNumber),
          nullifyingKey: wallet.nullifyingKey,
          getNullifier: TransactNote.getNullifier,
          tokenResolver: resolver,
        });
    } catch (error) {
      assert.equal(scenario, 'engine-drop');
      assert.match(error.message, /Missing authenticated wallet note/);
      fs.writeFileSync(
        path.join(directory, mode + '.json'),
        JSON.stringify(
          {
            mode,
            scenario,
            scanMode,
            sourceSha256,
            inventory: inventory.sha256,
            scanRefused: true,
            reason: 'matched-note-missing-after-scan',
            spendableGranted: false,
            balancePublished: false,
            guards: guards.report(),
            poiCalls,
          },
          null,
          2
        ),
        { flag: 'wx', mode: 0o600 }
      );
      store.close();
      scope.close();
      return;
    }
    assert.equal(validation.accepted.length, txos.length);
    await require('../../src/main/wallet/railgun-wallet-records').validateRailgunSentRecords({
      sent: await wallet.getSentCommitments(version, chain),
      expectedSent: preflight.flatMap((value, position) =>
        value.sent ? [{ tree: 0, position }] : []
      ),
      trees: expected.trees,
      readCommitment: (treeNumber, position) => tree.getCommitment(treeNumber, position),
      tokenResolver: resolver,
    });
  }
  const balances = await wallet.getTokenBalances(version, chain, false);
  const erc20Balance = Object.values(balances).find(
    (value) => value.tokenData.tokenType === 0
  ).balance;
  assert.equal(erc20Balance, spent || dropped || scenario === 'nft-known' ? 2000n : 3000n);
  assert.deepEqual(
    txos.map((v) => POI.getBalanceBucket(v)),
    dropped
      ? [scenario.startsWith('transact') ? 'MissingExternalPOI' : 'ShieldPending']
      : spent
        ? ['Spent', 'ShieldPending']
        : scenario.startsWith('transact')
          ? ['MissingExternalPOI', 'MissingExternalPOI']
          : ['ShieldPending', 'ShieldPending']
  );
  assert.equal(poiCalls, 0);
  assert.equal(guards.report().attempts, 0);
  const report = {
    mode,
    scenario,
    scanMode,
    preflight,
    sourceSha256,
    mismatchedNotes,
    excludedBeforeEngine: preflight.filter((value) => value.status !== 'matched').length,
    inventory: inventory.sha256,
    notes: txos.length,
    values: txos.map((v) => v.note.value.toString()),
    spent: txos.map((v) => v.spendtxid !== false),
    observedBalance: erc20Balance.toString(),
    buckets: txos.map((v) => POI.getBalanceBucket(v)),
    ticked,
    poiCalls,
    guards: guards.report(),
    spendableGranted: false,
    liveRpc: false,
    syntheticHistory: true,
  };
  fs.writeFileSync(path.join(directory, mode + '.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  store.close();
  scope.close();
}
main().then(
  () => process.exit(0),
  (error) => {
    for (let cause = error; cause; cause = cause.cause) console.error(cause.stack);
    process.exit(1);
  }
);
