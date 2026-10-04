/** Public synthetic crypto only. Derives the public mnemonic's viewing key,
 * never a spending private key. Association material goes only to fixture-host
 * memory; no account, spending-proof or production key-handoff authority.
 */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'descriptor',
    'kind',
    'recipient',
    'row',
  ]);
  assert.ok(['transfer', 'unshield'].includes(input.kind));
  const supplied = input.descriptor;
  assert.deepEqual(Object.keys(supplied).sort(), [
    'accountIndex',
    'instanceId',
    'masterPublicKey',
    'spendingPublicKey',
    'viewingPublicKey',
    'walletId',
  ]);
  assert.ok(
    Number.isInteger(supplied.accountIndex) &&
      supplied.accountIndex >= 0 &&
      supplied.accountIndex <= 65535
  );
  assert.ok(Array.isArray(supplied.spendingPublicKey) && supplied.spendingPublicKey.length === 2);
  for (const value of [
    ...supplied.spendingPublicKey,
    supplied.masterPublicKey,
    supplied.viewingPublicKey,
    supplied.walletId,
  ])
    assert.match(value, /^[0-9a-f]{64}$/);
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  active();
  const { poseidon, poseidonHex } = imp('utils/poseidon');
  const { getPublicViewingKey } = imp('utils/keys-utils');
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { TransactNote } = imp('note/transact-note');
  const { Transaction } = imp('transaction/transaction');
  const { Prover } = imp('prover/prover');
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
  const { extractRailgunTransactIntent } = require('../../src/main/wallet/railgun-transact-intent');
  const seed = require('@scure/bip39').mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  let viewingKey;
  const shieldKey = Buffer.alloc(32, 8);
  const wipe = () => {
    seed.fill(0);
    viewingKey?.fill(0);
    shieldKey.fill(0);
  };
  signal.addEventListener('abort', wipe, { once: true });
  try {
    active();
    viewingKey = require('../../src/main/identity/railgun-key-derivation').deriveRailgunKey(
      seed,
      `m/420'/1984'/0'/0'/${supplied.accountIndex}'`
    );
    seed.fill(0);
    const publicKey = supplied.spendingPublicKey.map((v) => BigInt('0x' + v));
    const viewingPublicKey = await getPublicViewingKey(viewingKey);
    active();
    const viewingKeyPair = { privateKey: viewingKey, pubkey: viewingPublicKey };
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No fixture wallet storage');
        },
      }
    );
    const viewWallet = new ViewOnlyWallet(
      supplied.walletId,
      denied,
      viewingKeyPair,
      publicKey,
      undefined,
      denied
    );
    const descriptor = {
      accountIndex: supplied.accountIndex,
      instanceId: viewWallet.getAddress(),
      masterPublicKey: hex(viewWallet.masterPublicKey).slice(2),
      spendingPublicKey: publicKey.map((v) => hex(v).slice(2)),
      viewingPublicKey: Buffer.from(viewingPublicKey).toString('hex'),
      walletId: ViewOnlyWallet.generateID(viewWallet.generateShareableViewingKey()),
    };
    assert.deepEqual(descriptor, supplied);
    const nullifyingKey = poseidon([BigInt('0x' + viewingKey.toString('hex'))]);
    assert.equal(viewWallet.getNullifyingKey(), nullifyingKey);
    const addressKeys = { masterPublicKey: viewWallet.masterPublicKey, viewingPublicKey };
    imp('wallet/wallet-info').default.setWalletSource('freedom');
    const note = new ShieldNoteERC20(
      addressKeys.masterPublicKey,
      '02'.repeat(16),
      1000n,
      pins.wrappedNative
    );
    const noteHash = hex(
      ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)
    );
    const pathElements = require('../../src/main/wallet/railgun-public-records')
      .ZERO_NODES.slice(0, 16)
      .map((v) => '0x' + v);
    let merkleRoot = BigInt(noteHash);
    for (const sibling of pathElements) merkleRoot = poseidon([merkleRoot, BigInt(sibling)]);
    const wallet = {
      getUTXOMerkletree: () => ({
        getRoot: async () => hex(merkleRoot).slice(2),
        getMerkleProof: async (tree, position) => {
          assert.equal(tree, 0);
          assert.equal(position, 0);
          return {
            leaf: noteHash.slice(2),
            root: hex(merkleRoot).slice(2),
            elements: pathElements.map((v) => v.slice(2)),
            indices: hex(0).slice(2),
          };
        },
      }),
      getSpendingKeyPair: async () => ({ pubkey: publicKey }),
      getNullifyingKey: () => nullifyingKey,
      getViewingKeyPair: () => viewingKeyPair,
      viewingKeyPair,
      addressKeys,
    };
    const unshield = input.kind === 'unshield';
    if (unshield) assert.match(input.recipient, /^0x[0-9a-f]{40}$/);
    else assert.equal(input.recipient, descriptor.instanceId);
    const outputs = unshield
      ? []
      : [
          TransactNote.createTransfer(
            addressKeys,
            addressKeys,
            note.value,
            note.tokenData,
            false,
            0,
            undefined
          ),
        ];
    const transactionBuilder = new Transaction(
      { type: 0, id: pins.chainId },
      note.tokenData,
      0,
      [{ note, tree: 0, position: 0 }],
      outputs,
      { contract: '0x' + '0'.repeat(40), parameters: hex(0) }
    );
    if (unshield)
      transactionBuilder.addUnshieldData(
        { tokenData: note.tokenData, toAddress: input.recipient, allowOverride: false },
        note.value
      );
    const txRequest = await transactionBuilder.generateTransactionRequest(
      wallet,
      'V2_PoseidonMerkle',
      '',
      { minGasPrice: 0n }
    );
    active();
    const pub = txRequest.publicInputs;
    assert.equal(pub.nullifiers.length, 1);
    assert.equal(pub.commitmentsOut.length, 1);
    assert.equal(pub.nullifiers[0], TransactNote.getNullifier(nullifyingKey, 0));
    assert.equal(pub.merkleRoot, merkleRoot);
    assert.deepEqual(txRequest.privateInputs.pathElements, [pathElements.map(BigInt)]);
    assert.deepEqual(txRequest.privateInputs.leavesIndices, [0n]);
    // Only SDK zero-proof serialization. No spend prover, artifacts or signature.
    const dummy = await transactionBuilder.generateDummyProvedTransaction(
      new Prover({
        assertArtifactExists: (inputs, outputs) => {
          assert.equal(inputs, 1);
          assert.equal(outputs, 1);
        },
      }),
      txRequest
    );
    active();
    const transaction = {
      chainId: pins.chainId,
      to: pins.proxy,
      value: '0',
      data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[dummy]]),
    };
    const decoded = extractRailgunTransactIntent(transaction);
    assert.deepEqual(decoded.intent, transaction);
    assert.equal(decoded.expected.boundParamsHash, hex(pub.boundParamsHash));
    assert.equal(decoded.expected.commitment, hex(pub.commitmentsOut[0]));
    assert.equal(decoded.expected.nullifier, hex(pub.nullifiers[0]));
    const expectedHash = hex(
      poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])
    );
    const capsule = {
      version: 1,
      walletId: descriptor.walletId,
      engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
      selection: { kind: decoded.expected.kind, tree: 0, position: 0, recipient: input.recipient },
      preparation: {
        transaction: decoded.intent,
        expected: decoded.expected,
        expectedHash,
        recipient: input.recipient,
        amount: '1000',
      },
      noteHash,
      pathElements,
    };
    const encrypted = await note.serialize(shieldKey, viewingPublicKey);
    active();
    const creator = {
      type: 'Shield',
      tree: 0,
      position: 0,
      preimage: {
        npk: hex(note.notePublicKey),
        value: '1000',
        token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      },
      ciphertext: encrypted.ciphertext,
    };
    // Reconstruct within this job; never return these private fields to main.
    const recovered =
      await require('../../src/main/wallet/railgun-poi-reconstruct').reconstructRailgunPoiNotes({
        archive,
        descriptor,
        viewingKey,
        capsule,
        creator,
        signal,
      });
    assert.deepEqual(recovered.spendingPublicKey, txRequest.privateInputs.publicKey);
    assert.equal(recovered.nullifyingKey, txRequest.privateInputs.nullifyingKey);
    assert.equal(
      BigInt('0x' + recovered.token.replace(/^0x/, '')),
      txRequest.privateInputs.tokenAddress
    );
    assert.deepEqual(
      recovered.randomsIn.map((v) => BigInt('0x' + v)),
      txRequest.privateInputs.randomIn
    );
    assert.deepEqual(recovered.valuesIn, txRequest.privateInputs.valueIn);
    assert.deepEqual(recovered.utxoPositionsIn.map(BigInt), txRequest.privateInputs.leavesIndices);
    assert.equal(recovered.utxoTreeIn, 0);
    assert.equal(recovered.inputNpk, note.notePublicKey);
    assert.deepEqual(recovered.npksOut, unshield ? [] : txRequest.privateInputs.npkOut);
    assert.deepEqual(recovered.valuesOut, unshield ? [] : txRequest.privateInputs.valueOut);
    const row = {
      ...input.row,
      nullifiers: [hex(pub.nullifiers[0])],
      commitments: [hex(pub.commitmentsOut[0])],
      boundParamsHash: hex(pub.boundParamsHash),
      utxoTreeIn: 0,
      utxoTreeOut: unshield ? 99999 : 0,
      utxoBatchStartPositionOut: unshield ? 99999 : 1,
    };
    if (unshield) {
      row.unshield = {
        tokenData: creator.preimage.token,
        toAddress: input.recipient,
        value: '1000',
      };
      assert.equal(
        hex(imp('note/note-util').getNoteHash(input.recipient, note.tokenData, note.value)),
        row.commitments[0]
      );
    } else assert.equal(row.unshield, undefined);
    let projection;
    await require('./railgun-own-preflight-job').run(JSON.stringify({ archive, row }), {
      signal,
      guardReport,
      request: async (wire) => {
        assert.equal(projection, undefined);
        const message = JSON.parse(wire);
        assert.equal(message.id, 1);
        assert.equal(message.method, 'result');
        projection = message.value;
        assert.equal(projection.guards.attempts, 0);
        assert.deepEqual(projection.row.commitments, row.commitments);
        assert.deepEqual(projection.row.nullifiers, row.nullifiers);
        assert.equal(projection.row.boundParamsHash, row.boundParamsHash);
        return JSON.stringify({ id: 1, value: null });
      },
    });
    assert.ok(projection);
    const blindedCommitment = imp(
      'poi/blinded-commitment'
    ).BlindedCommitment.getForShieldOrTransact(
      noteHash,
      note.notePublicKey,
      imp('poi/global-tree-position').getGlobalTreePosition(0, 0)
    );
    const elements = Array.from({ length: 16 }, (_, i) => hex(i + 31).slice(2));
    const index = 5;
    let root = blindedCommitment.slice(2);
    for (let level = 0; level < 16; level++)
      root = poseidonHex(
        (index & (1 << level)) === 0 ? [root, elements[level]] : [elements[level], root]
      );
    const proof = {
      leaf: blindedCommitment.slice(2),
      elements,
      indices: hex(index).slice(2),
      root,
    };
    const owned =
      require('../../src/main/wallet/railgun-owned-poi-records').projectRailgunOwnedPoiRecord(
        {
          commitmentType: 'ShieldCommitment',
          tree: 0,
          position: 0,
          note: {
            notePublicKey: note.notePublicKey,
            tokenHash: note.tokenHash,
            value: note.value,
            hash: BigInt(noteHash),
          },
          blindedCommitment,
          nullifier: hex(pub.nullifiers[0]),
        },
        {
          commitmentType: 'ShieldCommitment',
          utxoTree: 0,
          utxoIndex: 0,
          hash: noteHash,
          preImage: { npk: hex(note.notePublicKey) },
          txid: hex(705),
          blockNumber: 5944700,
        },
        {
          TransactNote,
          BlindedCommitment: imp('poi/blinded-commitment').BlindedCommitment,
          getGlobalTreePosition: imp('poi/global-tree-position').getGlobalTreePosition,
        },
        hex(pub.nullifiers[0])
      );
    assert.equal(owned.blindedCommitment, blindedCommitment);
    require('../../src/main/wallet/railgun-poi-records').verifyPoiMembership(
      [proof],
      [{ blindedCommitment, type: 'Shield' }],
      (a, b) => poseidonHex([a, b])
    );
    active();
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    const wire = JSON.stringify({
      id: 1,
      method: 'result',
      value: {
        row: projection.row,
        state: projection.state,
        creator,
        noteHash,
        blindedCommitment,
        proof,
        guards,
        descriptor,
        transaction,
        pathElements,
        expectedHash,
      },
    });
    assert.ok(Buffer.byteLength(wire) <= 32768);
    assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
  } finally {
    signal.removeEventListener('abort', wipe);
    wipe();
  }
};
