/** Public synthetic crypto only. Derives the public mnemonic's viewing key,
 * never a spending private key. Association material goes only to fixture-host
 * memory; no account, spending-proof or production key-handoff authority.
 * Optional Transact creators are SDK-encrypted 1x1 self/foreign transfers from
 * Shield position 0 to receiver position 1, followed by the selected own spend.
 * Optional partial creators instead use 1500 in, 1000 ordinary out and 500
 * unshielded: self output is SDK Change; foreign output is a received Transfer.
 * Both serialized transactions use dummy proofs, never a valid chain spend.
 */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  const creatorKind = input.creatorKind ?? 'Shield';
  const senderKind = input.senderKind ?? 'self';
  const partialCreator = Object.hasOwn(input, 'creatorMode');
  if (partialCreator) {
    assert.equal(input.creatorMode, 'partial');
    assert.equal(creatorKind, 'Transact');
  }
  assert.ok(['Shield', 'Transact'].includes(creatorKind));
  assert.ok(['self', 'foreign'].includes(senderKind));
  assert.ok(creatorKind === 'Transact' || senderKind === 'self');
  const transact = creatorKind === 'Transact';
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      'archive',
      'descriptor',
      'kind',
      'recipient',
      'row',
      ...(Object.hasOwn(input, 'creatorKind') ? ['creatorKind'] : []),
      ...(Object.hasOwn(input, 'senderKind') ? ['senderKind'] : []),
      ...(partialCreator ? ['creatorMode'] : []),
      ...(transact ? ['creatorRow'] : []),
      ...(senderKind === 'foreign' ? ['senderDescriptor'] : []),
    ].sort()
  );
  assert.ok(['transfer', 'unshield'].includes(input.kind));
  const validateDescriptor = (value) => {
    assert.deepEqual(Object.keys(value).sort(), [
      'accountIndex',
      'instanceId',
      'masterPublicKey',
      'spendingPublicKey',
      'viewingPublicKey',
      'walletId',
    ]);
    assert.ok(
      Number.isInteger(value.accountIndex) && value.accountIndex >= 0 && value.accountIndex <= 65535
    );
    assert.ok(Array.isArray(value.spendingPublicKey) && value.spendingPublicKey.length === 2);
    for (const field of [
      ...value.spendingPublicKey,
      value.masterPublicKey,
      value.viewingPublicKey,
      value.walletId,
    ])
      assert.match(field, /^[0-9a-f]{64}$/);
  };
  const supplied = input.descriptor;
  validateDescriptor(supplied);
  if (senderKind === 'foreign') {
    validateDescriptor(input.senderDescriptor);
    assert.notEqual(input.senderDescriptor.accountIndex, supplied.accountIndex);
  }
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
  const { OutputType } = imp('models/formatted-types');
  const { Transaction } = imp('transaction/transaction');
  const { Prover } = imp('prover/prover');
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
  const { extractRailgunTransactIntent } = require('../../src/main/wallet/railgun-transact-intent');
  const seed = require('@scure/bip39').mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  let viewingKey, foreignViewingKey;
  const shieldKey = Buffer.alloc(32, 8);
  const wipe = () => {
    seed.fill(0);
    viewingKey?.fill(0);
    foreignViewingKey?.fill(0);
    shieldKey.fill(0);
  };
  signal.addEventListener('abort', wipe, { once: true });
  try {
    active();
    viewingKey = require('../../src/main/identity/railgun-key-derivation').deriveRailgunKey(
      seed,
      `m/420'/1984'/0'/0'/${supplied.accountIndex}'`
    );
    if (senderKind === 'foreign')
      foreignViewingKey =
        require('../../src/main/identity/railgun-key-derivation').deriveRailgunKey(
          seed,
          `m/420'/1984'/0'/0'/${input.senderDescriptor.accountIndex}'`
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
    let sender = { addressKeys, publicKey, nullifyingKey, viewingKeyPair };
    if (senderKind === 'foreign') {
      const foreign = input.senderDescriptor;
      const foreignPublicKey = foreign.spendingPublicKey.map((v) => BigInt('0x' + v));
      const foreignViewingPublicKey = await getPublicViewingKey(foreignViewingKey);
      active();
      const pair = { privateKey: foreignViewingKey, pubkey: foreignViewingPublicKey };
      const foreignWallet = new ViewOnlyWallet(
        foreign.walletId,
        denied,
        pair,
        foreignPublicKey,
        undefined,
        denied
      );
      assert.deepEqual(
        {
          accountIndex: foreign.accountIndex,
          instanceId: foreignWallet.getAddress(),
          masterPublicKey: hex(foreignWallet.masterPublicKey).slice(2),
          spendingPublicKey: foreignPublicKey.map((v) => hex(v).slice(2)),
          viewingPublicKey: Buffer.from(foreignViewingPublicKey).toString('hex'),
          walletId: ViewOnlyWallet.generateID(foreignWallet.generateShareableViewingKey()),
        },
        foreign
      );
      const foreignNullifyingKey = poseidon([BigInt('0x' + foreignViewingKey.toString('hex'))]);
      assert.equal(foreignWallet.getNullifyingKey(), foreignNullifyingKey);
      assert.notEqual(foreignWallet.masterPublicKey, viewWallet.masterPublicKey);
      assert.notDeepEqual(foreignViewingPublicKey, viewingPublicKey);
      assert.notDeepEqual(foreignPublicKey, publicKey);
      sender = {
        addressKeys: {
          masterPublicKey: foreignWallet.masterPublicKey,
          viewingPublicKey: foreignViewingPublicKey,
        },
        publicKey: foreignPublicKey,
        nullifyingKey: foreignNullifyingKey,
        viewingKeyPair: pair,
      };
    }
    imp('wallet/wallet-info').default.setWalletSource('freedom');
    let note = new ShieldNoteERC20(
      sender.addressKeys.masterPublicKey,
      '02'.repeat(16),
      partialCreator ? 1500n : 1000n,
      pins.wrappedNative
    );
    let noteHash = hex(
      ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)
    );
    let pathElements = require('../../src/main/wallet/railgun-public-records')
      .ZERO_NODES.slice(0, 16)
      .map((v) => '0x' + v);
    let merkleRoot = BigInt(noteHash);
    for (const sibling of pathElements) merkleRoot = poseidon([merkleRoot, BigInt(sibling)]);
    const walletFor = (party, leaf, elements, root, index) => ({
      getUTXOMerkletree: () => ({
        getRoot: async () => hex(root).slice(2),
        getMerkleProof: async (tree, position) => {
          assert.equal(tree, 0);
          assert.equal(position, index);
          return {
            leaf: leaf.slice(2),
            root: hex(root).slice(2),
            elements: elements.map((v) => v.slice(2)),
            indices: hex(index).slice(2),
          };
        },
      }),
      getSpendingKeyPair: async () => ({ pubkey: party.publicKey }),
      getNullifyingKey: () => party.nullifyingKey,
      getViewingKeyPair: () => party.viewingKeyPair,
      viewingKeyPair: party.viewingKeyPair,
      addressKeys: party.addressKeys,
    });
    let creator, priorShield, creatorRow, creatorTransaction;
    const position = transact ? 1 : 0;
    if (transact) {
      assert.equal(input.creatorRow.unshield, undefined);
      assert.ok(input.creatorRow.blockNumber <= input.row.blockNumber);
      const shieldHash = noteHash;
      const encryptedShield = await note.serialize(shieldKey, sender.addressKeys.viewingPublicKey);
      active();
      priorShield = {
        type: 'Shield',
        tree: 0,
        position: 0,
        preimage: {
          npk: hex(note.notePublicKey),
          value: note.value.toString(),
          token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
        },
        ciphertext: encryptedShield.ciphertext,
      };
      // The pinned SDK exposes Change through createTransfer's output type,
      // not a separate createChange factory. A foreign receiver is never change.
      const selfChange = partialCreator && senderKind === 'self';
      const received = TransactNote.createTransfer(
        addressKeys,
        sender.addressKeys,
        partialCreator ? 1000n : note.value,
        note.tokenData,
        selfChange || senderKind === 'foreign',
        selfChange ? OutputType.Change : OutputType.Transfer,
        undefined
      );
      assert.equal(received.receiverAddressData.masterPublicKey, addressKeys.masterPublicKey);
      assert.equal(received.senderAddressData.masterPublicKey, sender.addressKeys.masterPublicKey);
      assert.equal(received.value, 1000n);
      assert.equal(received.memoText, undefined);
      assert.equal(received.outputType, selfChange ? OutputType.Change : OutputType.Transfer);
      const builder = new Transaction(
        { type: 0, id: pins.chainId },
        note.tokenData,
        0,
        [{ note, tree: 0, position: 0 }],
        [received],
        { contract: '0x' + '0'.repeat(40), parameters: hex(0) }
      );
      const creatorUnshieldRecipient = '0x' + '12'.repeat(20);
      let creatorUnshieldCommitment;
      if (partialCreator) {
        builder.addUnshieldData(
          { tokenData: note.tokenData, toAddress: creatorUnshieldRecipient, allowOverride: false },
          500n
        );
        creatorUnshieldCommitment = imp('note/note-util').getNoteHash(
          creatorUnshieldRecipient,
          note.tokenData,
          500n
        );
        assert.equal(note.value, received.value + 500n);
      }
      const creatorRequest = await builder.generateTransactionRequest(
        walletFor(sender, noteHash, pathElements, merkleRoot, 0),
        'V2_PoseidonMerkle',
        '',
        { minGasPrice: 0n }
      );
      active();
      const cp = creatorRequest.publicInputs;
      assert.deepEqual(cp.nullifiers, [TransactNote.getNullifier(sender.nullifyingKey, 0)]);
      assert.deepEqual(
        cp.commitmentsOut,
        partialCreator ? [received.hash, creatorUnshieldCommitment] : [received.hash]
      );
      assert.equal(cp.merkleRoot, merkleRoot);
      assert.deepEqual(creatorRequest.privateInputs.valueIn, [partialCreator ? 1500n : 1000n]);
      assert.deepEqual(
        creatorRequest.privateInputs.valueOut,
        partialCreator ? [1000n, 500n] : [1000n]
      );
      assert.deepEqual(creatorRequest.privateInputs.pathElements, [pathElements.map(BigInt)]);
      assert.deepEqual(creatorRequest.privateInputs.leavesIndices, [0n]);
      const dummyCreator = await builder.generateDummyProvedTransaction(
        new Prover({
          assertArtifactExists: (inputs, outputs) => {
            assert.equal(inputs, 1);
            assert.equal(outputs, partialCreator ? 2 : 1);
          },
        }),
        creatorRequest
      );
      active();
      creatorTransaction = {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[dummyCreator]]),
      };
      const decodedCreator = extractRailgunTransactIntent(creatorTransaction);
      assert.deepEqual(decodedCreator.intent, creatorTransaction);
      assert.equal(decodedCreator.expected.boundParamsHash, hex(cp.boundParamsHash));
      if (partialCreator) {
        assert.equal(decodedCreator.expected.kind, 'railgun-partial-unshield');
        assert.equal(decodedCreator.expected.changeCommitment, hex(received.hash));
        assert.equal(decodedCreator.expected.unshieldCommitment, hex(creatorUnshieldCommitment));
        assert.equal(decodedCreator.expected.unshieldAmount, '500');
        assert.equal(decodedCreator.expected.recipient, creatorUnshieldRecipient);
      } else assert.equal(decodedCreator.expected.commitment, hex(received.hash));
      assert.equal(decodedCreator.expected.nullifier, hex(cp.nullifiers[0]));
      assert.equal(creatorRequest.boundParams.commitmentCiphertext.length, 1);
      creator = {
        type: 'Transact',
        tree: 0,
        position,
        hash: hex(received.hash),
        ciphertext: JSON.parse(JSON.stringify(creatorRequest.boundParams.commitmentCiphertext[0])),
      };
      creatorRow = {
        ...input.creatorRow,
        nullifiers: [hex(cp.nullifiers[0])],
        commitments: cp.commitmentsOut.map(hex),
        boundParamsHash: hex(cp.boundParamsHash),
        utxoTreeIn: 0,
        utxoTreeOut: 0,
        utxoBatchStartPositionOut: 1,
        ...(partialCreator
          ? {
              unshield: {
                tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
                toAddress: creatorUnshieldRecipient,
                value: '500',
              },
            }
          : {}),
      };
      note = received;
      noteHash = hex(note.hash);
      pathElements = [shieldHash, ...pathElements.slice(1)];
      merkleRoot = BigInt(noteHash);
      for (let level = 0; level < 16; level++)
        merkleRoot = poseidon(
          (position & (1 << level)) === 0
            ? [merkleRoot, BigInt(pathElements[level])]
            : [BigInt(pathElements[level]), merkleRoot]
        );
    }
    const wallet = walletFor(
      { addressKeys, publicKey, nullifyingKey, viewingKeyPair },
      noteHash,
      pathElements,
      merkleRoot,
      position
    );
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
      [{ note, tree: 0, position }],
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
    assert.equal(pub.nullifiers[0], TransactNote.getNullifier(nullifyingKey, position));
    if (transact) assert.notEqual(pub.nullifiers[0], BigInt(creatorRow.nullifiers[0]));
    assert.equal(pub.merkleRoot, merkleRoot);
    assert.deepEqual(txRequest.privateInputs.pathElements, [pathElements.map(BigInt)]);
    assert.deepEqual(txRequest.privateInputs.leavesIndices, [BigInt(position)]);
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
      selection: { kind: decoded.expected.kind, tree: 0, position, recipient: input.recipient },
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
    if (!transact) {
      const encrypted = await note.serialize(shieldKey, viewingPublicKey);
      active();
      creator = {
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
    }
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
      utxoBatchStartPositionOut: unshield ? 99999 : position + 1,
    };
    if (unshield) {
      row.unshield = {
        tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
        toAddress: input.recipient,
        value: '1000',
      };
      assert.equal(
        hex(imp('note/note-util').getNoteHash(input.recipient, note.tokenData, note.value)),
        row.commitments[0]
      );
    } else assert.equal(row.unshield, undefined);
    let projection;
    if (transact) {
      const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = imp(
        'transaction/railgun-txid'
      );
      const txids =
        require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
          hashPair: (a, b) => poseidonHex([a, b]),
          transactionHash: createRailgunTransactionWithHash,
          verificationHash: calculateRailgunTransactionVerificationHash,
          zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
        });
      creatorRow.verificationHash = calculateRailgunTransactionVerificationHash(
        undefined,
        creatorRow.nullifiers[0]
      );
      row.verificationHash = calculateRailgunTransactionVerificationHash(
        creatorRow.verificationHash,
        row.nullifiers[0]
      );
      const values = new Map();
      const read = async (key) => values.get(key) ?? null;
      const appended = await txids.append(txids.empty(), [creatorRow, row], read);
      for (const { key, value } of appended.writes) values.set(key, value);
      assert.equal(appended.state.count, 2);
      assert.deepEqual(appended.state.breaks, []);
      const creatorWitness =
        await require('../../src/main/wallet/railgun-txid-note-witness').findRailgunNoteTxidWitness(
          {
            state: appended.state,
            note: {
              type: 'Transact',
              txid: '0x' + creatorRow.txid,
              hash: noteHash,
              tree: 0,
              position,
              blockNumber: creatorRow.blockNumber,
            },
            read,
            projection: txids,
          }
        );
      assert.equal(creatorWitness.witness.index, 0);
      assert.equal(creatorWitness.outputIndex, 0);
      assert.equal(creatorWitness.witness.checkpointIndex, 1);
      const ownRecord = txids.inspectRecord(await read('txid:row:1'));
      const ownWitness = await txids.witness(appended.state, ownRecord.railgunTxid, read);
      assert.equal(ownWitness.index, 1);
      assert.equal(ownWitness.checkpointIndex, 1);
      assert.equal(ownWitness.root, creatorWitness.witness.root);
      projection = { row, state: appended.state };
    } else {
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
    }
    assert.ok(projection);
    const blindedCommitment = imp(
      'poi/blinded-commitment'
    ).BlindedCommitment.getForShieldOrTransact(
      noteHash,
      note.notePublicKey,
      imp('poi/global-tree-position').getGlobalTreePosition(0, position)
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
          commitmentType: transact ? 'TransactCommitmentV2' : 'ShieldCommitment',
          tree: 0,
          position,
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
          commitmentType: transact ? 'TransactCommitmentV2' : 'ShieldCommitment',
          utxoTree: 0,
          utxoIndex: position,
          hash: noteHash,
          ...(!transact ? { preImage: { npk: hex(note.notePublicKey) } } : {}),
          txid: transact ? creatorRow.txid : hex(705),
          blockNumber: transact ? creatorRow.blockNumber : 5944700,
        },
        {
          TransactNote,
          BlindedCommitment: imp('poi/blinded-commitment').BlindedCommitment,
          getGlobalTreePosition: imp('poi/global-tree-position').getGlobalTreePosition,
        },
        hex(pub.nullifiers[0])
      );
    assert.equal(owned.blindedCommitment, blindedCommitment);
    assert.equal(owned.type, creatorKind);
    require('../../src/main/wallet/railgun-poi-records').verifyPoiMembership(
      [proof],
      [{ blindedCommitment, type: creatorKind }],
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
        ...(transact ? { priorShield, creatorRow, creatorTransaction } : {}),
      },
    });
    assert.ok(Buffer.byteLength(wire) <= 32768);
    assert.deepEqual(JSON.parse(await request(wire)), { id: 1, value: null });
  } finally {
    signal.removeEventListener('abort', wipe);
    wipe();
  }
};
