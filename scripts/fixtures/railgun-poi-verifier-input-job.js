/** Synthetic-only payload producer for separate-process verification. Public
 * test mnemonic and simulated membership; payload stays in host memory. */
/** Actual proof over assembled POI inputs, using public test keys and
 * simulated inclusion/membership only. No enrollment or disclosure authority. */
const assert = require('assert/strict'),
  path = require('path');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.ok(['transfer', 'unshield', 'partial'].includes(input.kind));
  const creatorKind = input.creatorKind ?? 'Shield';
  assert.ok(['Shield', 'Transact'].includes(creatorKind));
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const imp = (name) => require(path.join(engine, name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { poseidon } = imp('utils/poseidon');
  const { getPublicViewingKey, getNoteBlindingKeys, getSharedSymmetricKey } =
    imp('utils/keys-utils');
  const { WalletNode } = imp('key-derivation/wallet-node');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { Transaction } = imp('transaction/transaction');
  const { TransactNote } = imp('note/transact-note');
  const { Prover } = imp('prover/prover');
  const { Interface } = require('ethers');
  const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
  const abi = new Interface([TRANSACT_ABI]);
  const seed = require('@scure/bip39').mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  const derive = require('../../src/main/identity/railgun-key-derivation').deriveRailgunKey;
  // Distinct public-test keys for the new mode; the historical Shield vector stays unchanged.
  const keyIndex = creatorKind === 'Transact' ? 2 : 0;
  const spendKey = derive(seed, `m/44'/1984'/0'/0'/${keyIndex}'`);
  const viewingKey = derive(seed, `m/420'/1984'/0'/0'/${keyIndex}'`);
  const foreignSpendKey = derive(seed, "m/44'/1984'/0'/0'/3'");
  const foreignViewingKey = derive(seed, "m/420'/1984'/0'/0'/3'");
  seed.fill(0);
  const foreignPublicKey = imp('utils/keys-utils').getPublicSpendingKey(foreignSpendKey);
  foreignSpendKey.fill(0);
  const foreignAddressKeys = {
    masterPublicKey: WalletNode.getMasterPublicKey(
      foreignPublicKey,
      poseidon([BigInt('0x' + foreignViewingKey.toString('hex'))])
    ),
    viewingPublicKey: await getPublicViewingKey(foreignViewingKey),
  };
  if (creatorKind === 'Shield') foreignViewingKey.fill(0);
  const publicKey = imp('utils/keys-utils').getPublicSpendingKey(spendKey);
  const nullifyingKey = poseidon([BigInt('0x' + viewingKey.toString('hex'))]);
  const viewingPublicKey = await getPublicViewingKey(viewingKey);
  const addressKeys = {
    masterPublicKey: WalletNode.getMasterPublicKey(publicKey, nullifyingKey),
    viewingPublicKey,
  };
  imp('wallet/wallet-info').default.setWalletSource('freedom');
  const tokenData = imp('note/note-util').getTokenDataERC20(pins.wrappedNative);
  const note =
    creatorKind === 'Transact'
      ? TransactNote.createTransfer(
          addressKeys,
          foreignAddressKeys,
          1000n,
          tokenData,
          true,
          0,
          'public fixture'
        )
      : new ShieldNoteERC20(
          addressKeys.masterPublicKey,
          '01'.repeat(16),
          1000n,
          pins.wrappedNative
        );
  if (creatorKind === 'Transact') {
    assert.notEqual(foreignAddressKeys.masterPublicKey, addressKeys.masterPublicKey);
    assert.notDeepEqual(foreignAddressKeys.viewingPublicKey, addressKeys.viewingPublicKey);
    assert.equal(note.receiverAddressData.masterPublicKey, addressKeys.masterPublicKey);
    assert.equal(note.senderAddressData.masterPublicKey, foreignAddressKeys.masterPublicKey);
    assert.equal(note.senderRandom, imp('models/transaction-constants').MEMO_SENDER_RANDOM_NULL);
  }
  const leaf =
    creatorKind === 'Transact'
      ? note.hash
      : ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value);
  const position = 10245;
  let merkleRoot = leaf;
  for (let i = 0; i < 16; i++)
    merkleRoot = poseidon((position >> i) & 1 ? [0n, merkleRoot] : [merkleRoot, 0n]);
  const viewingKeyPair = { privateKey: viewingKey, pubkey: viewingPublicKey };
  const wallet = {
    getUTXOMerkletree: () => ({
      getRoot: async () => hex(merkleRoot).slice(2),
      getMerkleProof: async () => ({
        leaf: hex(leaf).slice(2),
        root: hex(merkleRoot).slice(2),
        elements: Array(16).fill(hex(0n).slice(2)),
        indices: hex(BigInt(position)).slice(2),
      }),
    }),
    getSpendingKeyPair: async () => ({ pubkey: publicKey }),
    getNullifyingKey: () => nullifyingKey,
    getViewingKeyPair: () => viewingKeyPair,
    viewingKeyPair,
    addressKeys,
  };
  const unshield = input.kind === 'unshield';
  const partial = input.kind === 'partial';
  const hasUnshield = unshield || partial;
  const unshieldAmount = partial ? 400n : note.value;
  const outputs = unshield
    ? []
    : [
        TransactNote.createTransfer(
          addressKeys,
          addressKeys,
          partial ? note.value - unshieldAmount : note.value,
          note.tokenData,
          partial,
          partial ? imp('models/formatted-types').OutputType.Change : 0,
          undefined
        ),
      ];
  const transaction = new Transaction(
    { type: 0, id: pins.chainId },
    note.tokenData,
    0,
    [{ note, tree: 0, position }],
    outputs,
    { contract: '0x' + '0'.repeat(40), parameters: hex(0n) }
  );
  const recipient = '0x' + '12'.repeat(20);
  if (hasUnshield)
    transaction.addUnshieldData(
      { tokenData: note.tokenData, toAddress: recipient, allowOverride: false },
      unshieldAmount
    );
  const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'synthetic-poi',
    signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'synthetic',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: pins.chainId,
    role: 'artifacts',
  });
  const loaded = [];
  try {
    const artifacts = await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts(
      { handle, directory: input.artifactDirectory, variant: partial ? '01x02' : '01x01' }
    );
    loaded.push(artifacts);
    const poiArtifacts =
      await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts({
        handle,
        directory: input.artifactDirectory,
        variant: 'POI_3x3',
      });
    loaded.push(poiArtifacts);
    const prover = new Prover({
      assertArtifactExists: (i, o) => {
        assert.equal(i, 1);
        assert.equal(o, partial ? 2 : 1);
      },
      getArtifacts: async () => artifacts,
      getArtifactsPOI: async (i, o) => {
        assert.equal(i, 3);
        assert.equal(o, 3);
        return poiArtifacts;
      },
    });
    prover.setSnarkJSGroth16(
      require('../../src/main/wallet/railgun-prover-runtime').loadRailgunProverRuntime(
        input.proverArchive
      )
    );
    const txRequest = await transaction.generateTransactionRequest(
      wallet,
      'V2_PoseidonMerkle',
      '',
      { minGasPrice: 0n }
    );
    const dummy = await transaction.generateDummyProvedTransaction(prover, txRequest);
    const pub = txRequest.publicInputs;
    const message = poseidon([
      pub.merkleRoot,
      pub.boundParamsHash,
      ...pub.nullifiers,
      ...pub.commitmentsOut,
    ]);
    const signature = imp('utils/keys-utils').signEDDSA(spendKey, message);
    spendKey.fill(0);
    const signed = { ...txRequest, signature: [...signature.R8, signature.S] };
    const proved = await prover.proveRailgun('V2_PoseidonMerkle', signed, () => {});
    assert.equal(
      await prover.verifyRailgunProof(proved.publicInputs, proved.proof, artifacts),
      true
    );
    const expected = {
      kind: partial
        ? 'railgun-partial-unshield'
        : unshield
          ? 'railgun-token-unshield'
          : 'railgun-private-transfer',
      tree: 0,
      merkleRoot: hex(pub.merkleRoot),
      nullifier: hex(pub.nullifiers[0]),
      ...(partial
        ? {
            changeCommitment: hex(pub.commitmentsOut[0]),
            unshieldCommitment: hex(pub.commitmentsOut[1]),
          }
        : { commitment: hex(pub.commitmentsOut[0]) }),
      boundParamsHash: hex(pub.boundParamsHash),
      ...(partial
        ? { recipient, unshieldAmount: unshieldAmount.toString() }
        : unshield
          ? { recipient, amount: note.value.toString() }
          : {}),
    };
    const intent = {
      chainId: pins.chainId,
      to: pins.proxy,
      value: '0',
      data: abi.encodeFunctionData('transact', [[dummy]]),
    };
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No fixture store');
        },
      }
    );
    const viewWallet = new (imp('wallet/view-only-wallet').ViewOnlyWallet)(
      '0'.repeat(64),
      denied,
      viewingKeyPair,
      publicKey,
      undefined,
      denied
    );
    const instanceId = viewWallet.getAddress();
    const descriptor = {
      walletId: imp('wallet/view-only-wallet').ViewOnlyWallet.generateID(
        viewWallet.generateShareableViewingKey()
      ),
      instanceId,
      ...(input.combinedQualification ? { accountIndex: keyIndex } : {}),
      spendingPublicKey: publicKey.map((v) => hex(v).slice(2)),
      viewingPublicKey: Buffer.from(viewingPublicKey).toString('hex'),
      masterPublicKey: hex(addressKeys.masterPublicKey).slice(2),
    };
    assert.equal(viewWallet.getNullifyingKey(), nullifyingKey);
    const capsule = {
      version: partial ? 2 : 1,
      walletId: descriptor.walletId,
      engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
      selection: {
        kind: expected.kind,
        tree: 0,
        position,
        ...(partial ? { unshieldAmount: unshieldAmount.toString() } : {}),
        recipient: hasUnshield ? recipient : instanceId,
      },
      preparation: {
        transaction: intent,
        expected,
        expectedHash: hex(message),
        recipient: hasUnshield ? recipient : instanceId,
        ...(partial
          ? {
              inputAmount: note.value.toString(),
              unshieldAmount: unshieldAmount.toString(),
              changeAmount: (note.value - unshieldAmount).toString(),
            }
          : { amount: note.value.toString() }),
      },
      noteHash: hex(leaf),
      pathElements: Array(16).fill(hex(0n)),
    };
    // Current V2 encryption only. This fixture does not construct or qualify legacy ciphertext.
    const encryptCreator = async (
      inputNote,
      senderAddressKeys = addressKeys,
      senderViewingKey = viewingKey
    ) => {
      const blind = getNoteBlindingKeys(
        senderAddressKeys.viewingPublicKey,
        inputNote.receiverAddressData.viewingPublicKey,
        inputNote.random,
        inputNote.senderRandom
      );
      const key = await getSharedSymmetricKey(senderViewingKey, blind.blindedReceiverViewingKey);
      assert.ok(key);
      try {
        const encrypted = inputNote.encryptV2(
          'V2_PoseidonMerkle',
          key,
          senderAddressKeys.masterPublicKey,
          inputNote.senderRandom,
          senderViewingKey
        );
        return {
          type: 'Transact',
          tree: 0,
          position,
          hash: hex(inputNote.hash),
          ciphertext: {
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
          },
        };
      } finally {
        key.fill(0);
      }
    };
    let creator;
    if (creatorKind === 'Transact') {
      try {
        // Synthetic received creator only; no creating transaction is proved or mined here.
        creator = await encryptCreator(note, foreignAddressKeys, foreignViewingKey);
      } finally {
        foreignViewingKey.fill(0);
      }
    } else {
      const shieldKey = Buffer.alloc(32, 6);
      let encrypted;
      try {
        encrypted = await note.serialize(shieldKey, viewingPublicKey);
      } finally {
        shieldKey.fill(0);
      }
      creator = {
        type: 'Shield',
        tree: 0,
        position,
        preimage: {
          npk: hex(note.notePublicKey),
          value: note.value.toString(),
          token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0n) },
        },
        ciphertext: encrypted.ciphertext,
      };
    }
    const reconstruct =
      require('../../src/main/wallet/railgun-poi-reconstruct').reconstructRailgunPoiNotes;
    const reconstructionArgs = () => ({
      archive,
      descriptor: structuredClone(descriptor),
      viewingKey,
      capsule: structuredClone(capsule),
      creator: structuredClone(creator),
      signal,
    });
    const recovered = await reconstruct(reconstructionArgs());
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
    assert.deepEqual(recovered.npksOut, unshield ? [] : txRequest.privateInputs.npkOut.slice(0, 1));
    assert.deepEqual(
      recovered.valuesOut,
      unshield ? [] : txRequest.privateInputs.valueOut.slice(0, 1)
    );
    const reconstructionControls = [];
    const rejectReconstruction = async (name, mutate) => {
      const altered = reconstructionArgs();
      await mutate(altered);
      // Every control reaches reconstruction with a structurally valid capsule.
      require('../../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule(
        altered.capsule
      );
      try {
        await assert.rejects(() => reconstruct(altered));
      } finally {
        if (altered.viewingKey !== viewingKey) altered.viewingKey.fill(0);
      }
      reconstructionControls.push(name);
    };
    await rejectReconstruction('wrong-viewing-key', (v) => {
      v.viewingKey = Buffer.alloc(32, 9);
    });
    await rejectReconstruction('creator-position', (v) => {
      v.creator.position++;
    });
    await rejectReconstruction('position-nullifier', (v) => {
      v.creator.position++;
      v.capsule.selection.position++;
    });
    await rejectReconstruction('nullifier-binding', (v) => {
      const [[original]] = abi.decodeFunctionData(
        'transact',
        v.capsule.preparation.transaction.data
      );
      const alteredTx = original.toArray(true);
      alteredTx[2] = [hex(123n)];
      v.capsule.preparation.transaction.data = abi.encodeFunctionData('transact', [[alteredTx]]);
      const decoded =
        require('../../src/main/wallet/railgun-transact-intent').extractRailgunTransactIntent(
          v.capsule.preparation.transaction
        );
      v.capsule.preparation.expected = decoded.expected;
      const e = decoded.expected;
      v.capsule.preparation.expectedHash = hex(
        poseidon(
          [
            e.merkleRoot,
            e.boundParamsHash,
            e.nullifier,
            ...(partial ? [e.changeCommitment, e.unshieldCommitment] : [e.commitment]),
          ].map(BigInt)
        )
      );
    });
    const flip = (v, index) =>
      v.slice(0, index) + (v[index] === '0' ? '1' : '0') + v.slice(index + 1);
    await rejectReconstruction('ciphertext-data', (v) => {
      const words =
        creatorKind === 'Transact'
          ? v.creator.ciphertext.ciphertext
          : v.creator.ciphertext.encryptedBundle;
      words[1] = flip(words[1], 2);
    });
    if (creatorKind === 'Transact') {
      await rejectReconstruction('ciphertext-tag', (v) => {
        v.creator.ciphertext.ciphertext[0] = flip(v.creator.ciphertext.ciphertext[0], 34);
      });
      await rejectReconstruction('creator-hash', (v) => {
        v.creator.hash = hex(1n);
      });
    }
    await rejectReconstruction('note-hash', (v) => {
      v.capsule.noteHash = hex(1n);
      if (creatorKind === 'Transact') v.creator.hash = hex(1n);
    });
    if (creatorKind === 'Transact') {
      const changedNote = (receiver, value, token) =>
        TransactNote.createTransfer(
          receiver,
          addressKeys,
          value,
          token,
          false,
          0,
          'public control'
        );
      for (const [name, inputNote] of [
        ['sent-only-foreign-recipient', changedNote(foreignAddressKeys, note.value, tokenData)],
        ['amount', changedNote(addressKeys, note.value - 1n, tokenData)],
        [
          'non-weth',
          changedNote(
            addressKeys,
            note.value,
            imp('note/note-util').getTokenDataERC20('0x' + '34'.repeat(20))
          ),
        ],
      ]) {
        const otherCreator = await encryptCreator(inputNote);
        if (name === 'sent-only-foreign-recipient') {
          // Prove this is a readable sent note, not merely damaged ciphertext.
          const c = otherCreator.ciphertext;
          const sender = Buffer.from(c.blindedSenderViewingKey.slice(2), 'hex');
          const receiver = Buffer.from(c.blindedReceiverViewingKey.slice(2), 'hex');
          const shared = await getSharedSymmetricKey(viewingKey, receiver);
          assert.ok(shared);
          try {
            const sent = await TransactNote.decrypt(
              'V2_PoseidonMerkle',
              { type: 0, id: pins.chainId },
              addressKeys,
              {
                iv: c.ciphertext[0].slice(2, 34),
                tag: c.ciphertext[0].slice(34),
                data: c.ciphertext.slice(1).map((v) => v.slice(2)),
              },
              shared,
              c.memo,
              c.annotationData,
              viewingKey,
              receiver,
              sender,
              true,
              false,
              { getTokenDataFromHash: async () => inputNote.tokenData },
              undefined,
              undefined
            );
            assert.equal(sent.hash, inputNote.hash);
            assert.notEqual(sent.receiverAddressData.masterPublicKey, addressKeys.masterPublicKey);
          } finally {
            shared.fill(0);
          }
        }
        await rejectReconstruction(name, (v) => {
          v.creator = otherCreator;
          v.capsule.noteHash = otherCreator.hash;
        });
      }
    } else {
      await rejectReconstruction('amount', (v) => {
        v.creator.preimage.value = '999';
      });
      await rejectReconstruction('non-weth', (v) => {
        v.creator.preimage.token.tokenAddress = '0x' + '34'.repeat(20);
      });
    }
    await rejectReconstruction('creator-shape', (v) => {
      v.creator.extra = true;
    });
    await rejectReconstruction('ciphertext-shape', (v) => {
      v.creator.ciphertext.extra = true;
    });
    if (partial) {
      const changeType = imp('models/formatted-types').OutputType.Change;
      const change = (
        receiver = addressKeys,
        value = 600n,
        type = changeType,
        memo = undefined,
        visible = true
      ) =>
        TransactNote.createTransfer(
          receiver,
          addressKeys,
          value,
          note.tokenData,
          visible,
          type,
          memo
        );
      const replaceTransaction = (v, mutate) => {
        const [[original]] = abi.decodeFunctionData(
          'transact',
          v.capsule.preparation.transaction.data
        );
        const raw = original.toArray(true);
        mutate(raw);
        v.capsule.preparation.transaction.data = abi.encodeFunctionData('transact', [[raw]]);
        const decoded =
          require('../../src/main/wallet/railgun-transact-intent').extractRailgunTransactIntent(
            v.capsule.preparation.transaction
          );
        v.capsule.preparation.expected = decoded.expected;
        const e = decoded.expected;
        v.capsule.preparation.expectedHash = hex(
          poseidon(
            [
              e.merkleRoot,
              e.boundParamsHash,
              e.nullifier,
              e.changeCommitment,
              e.unshieldCommitment,
            ].map(BigInt)
          )
        );
      };
      for (const [name, output] of [
        ['change-value-conservation', change(addressKeys, 599n)],
        [
          'change-foreign-npk-same-viewing-key',
          change({ ...addressKeys, masterPublicKey: foreignAddressKeys.masterPublicKey }),
        ],
        ['change-transfer-annotation', change(addressKeys, 600n, 0)],
        ['change-memo', change(addressKeys, 600n, changeType, 'not allowed')],
        ['change-hidden-sender', change(addressKeys, 600n, changeType, undefined, false)],
      ]) {
        const encrypted = await encryptCreator(output);
        await rejectReconstruction(name, (v) =>
          replaceTransaction(v, (raw) => {
            raw[3][0] = hex(output.hash);
            raw[4][6] = [encrypted.ciphertext];
          })
        );
      }
      await rejectReconstruction('final-unshield-preimage-hash', (v) =>
        replaceTransaction(v, (raw) => {
          raw[3][1] = hex(BigInt(raw[3][1]) + 1n);
        })
      );
      await rejectReconstruction('reversed-output-commitments', (v) =>
        replaceTransaction(v, (raw) => {
          raw[3].reverse();
        })
      );
    }
    const { ownEvidence, state, witness } =
      await require('./railgun-poi-witness-data').createPoiWitnessData({
        archive,
        capsule,
        proof: proved.proof,
      });
    const { BlindedCommitment } = imp('poi/blinded-commitment');
    const { getGlobalTreePosition } = imp('poi/global-tree-position');
    const blindedInput = BlindedCommitment.getForShieldOrTransact(
      hex(leaf),
      note.notePublicKey,
      getGlobalTreePosition(0, position)
    );
    const elements = Array.from({ length: 16 }, (_, i) => hex(BigInt(i + 1)).slice(2));
    let root = BigInt(blindedInput);
    for (let i = 0; i < 16; i++)
      root = poseidon(
        (5 >> i) & 1 ? [BigInt('0x' + elements[i]), root] : [root, BigInt('0x' + elements[i])]
      );
    const listProofs = [
      {
        leaf: blindedInput.slice(2),
        root: hex(root).slice(2),
        indices: hex(5n).slice(2),
        elements,
      },
    ];
    const publicArgs = { archive, descriptor, creator, ownEvidence, state, witness, listProofs };
    const prepare = require('../../src/main/wallet/railgun-poi-witness').prepareRailgunPoiWitness;
    const args = () => ({ ...structuredClone(publicArgs), viewingKey, signal });
    const prepared = await prepare(args());
    assert.equal(prepared.txidLeafIndex, 5);
    assert.equal(prepared.txidRootIndex, 6);
    assert.equal(
      prepared.listKey,
      require('../../src/main/wallet/railgun-poi-records').REQUIRED_LIST
    );
    assert.equal(
      prepared.inputs.railgunTxidIfHasUnshield,
      hasUnshield ? '0x' + witness.railgunTxid : '0x00'
    );
    assert.equal(
      prepared.inputs.utxoBatchGlobalStartPositionOut,
      getGlobalTreePosition(unshield ? 99999 : 1, unshield ? 99999 : 23456)
    );
    for (const k of [
      'sourceAuthenticated',
      'membershipAuthenticated',
      'rootAccepted',
      'disclosureEnabled',
      'spendingEnabled',
    ])
      assert.equal(prepared[k], false);
    const controls = [];
    const reject = async (name, mutate) => {
      const altered = args();
      mutate(altered);
      await assert.rejects(() => prepare(altered), { code: 'RAILGUN_POI_WITNESS_REFUSED' });
      controls.push(name);
    };
    await reject('caller-marker', (v) => {
      v.marker = unshield ? '0x00' : '0x' + witness.railgunTxid;
    });
    await reject('caller-output-position', (v) => {
      v.outputPosition = 3;
    });
    await reject('wrong-membership-leaf', (v) => {
      v.listProofs[0].leaf = hex(1n).slice(2);
    });
    await reject('wrong-membership-root', (v) => {
      v.listProofs[0].root = hex(1n).slice(2);
    });
    await reject('membership-index-overflow', (v) => {
      v.listProofs[0].indices = hex(65536n).slice(2);
    });
    await reject('extra-membership', (v) => {
      v.listProofs.push(v.listProofs[0]);
    });
    await reject('wrong-output-row', (v) => {
      v.ownEvidence.row.utxoBatchStartPositionOut++;
    });
    await reject('wrong-kind', (v) => {
      if (hasUnshield) delete v.ownEvidence.row.unshield;
      else v.ownEvidence.row.unshield = {};
    });
    await reject('wrong-checkpoint-index', (v) => {
      v.witness.checkpointIndex = 5;
    });
    await reject('wrong-txid-path', (v) => {
      v.witness.elements[0] = hex(1n).slice(2);
    });
    await reject('wrong-capsule', (v) => {
      v.ownEvidence.capsule.preparation.expected.nullifier = hex(1n);
    });
    await reject('extra-evidence', (v) => {
      v.ownEvidence.marker = '0x00';
    });
    const repeated = await prepare(args());
    assert.deepEqual(repeated, prepared);
    const serial = require('../../src/main/wallet/railgun-prover-runtime').loadRailgunProverRuntime(
      input.proverArchive
    );
    assert.equal(typeof serial.verify, 'function');
    const start = performance.now();
    const localProve = require('../../src/main/wallet/railgun-poi-prover').proveRailgunPoi;
    const result = await localProve({
      ...args(),
      proverArchive: input.proverArchive,
      artifactDirectory: input.artifactDirectory,
    });
    assert.equal(result.locallyVerified, true);
    assert.equal(result.independentlyVerified, false);
    assert.equal(result.disclosureEnabled, false);
    assert.equal(result.payload.txidMerklerootIndex, 6);
    assert.equal(result.payload.txidMerkleroot, state.root);
    assert.equal(
      result.payload.railgunTxidIfHasUnshield,
      hasUnshield ? '0x' + witness.railgunTxid : '0x00'
    );
    assert.deepEqual(result.payload.blindedCommitmentsOut, prepared.blindedOut);
    assert.deepEqual(result.payload.poiMerkleroots, prepared.inputs.poiMerkleroots);
    assert.equal(result.payload.listKey, prepared.listKey);
    await assert.rejects(
      () =>
        localProve({
          ...args(),
          proverArchive: input.proverArchive,
          artifactDirectory: input.artifactDirectory,
        }),
      { code: 'RAILGUN_POI_PROOF_REFUSED' }
    );
    const expectedSignals = prepared.expectedPublicInputs;
    const signals = [
      ...expectedSignals.blindedCommitmentsOut,
      expectedSignals.anyRailgunTxidMerklerootAfterTransaction,
      expectedSignals.railgunTxidIfHasUnshield,
      ...expectedSignals.poiMerkleroots,
    ];
    assert.equal(signals.length, 8);
    assert.equal(await serial.verify(poiArtifacts.vkey, signals, result.payload.proof), true);
    for (let i = 0; i < 8; i++) {
      const changed = [...signals];
      changed[i] += 1n;
      assert.equal(await serial.verify(poiArtifacts.vkey, changed, result.payload.proof), false);
    }
    let markerControl;
    if (input.combinedQualification) {
      const {
        expectedRailgunOwnPoiFields,
        bindRailgunOwnPoiPayload,
      } = require('../../src/main/wallet/railgun-own-poi-proof-data');
      const expectedFields = expectedRailgunOwnPoiFields({
        archive,
        proverArchive: input.proverArchive,
        artifactDirectory: input.artifactDirectory,
        descriptor,
        preparation: { creator, ownEvidence, state, witness },
        listProofs,
      });
      assert.deepEqual(bindRailgunOwnPoiPayload(result.payload, expectedFields), result.payload);
      if (partial || input.kind === 'transfer') {
        // Fixture-only direct SDK construction: production witness has no marker override.
        const wrongMarker = partial ? '0x00' : '0x' + witness.railgunTxid;
        const wrongInputs = { ...prepared.inputs, railgunTxidIfHasUnshield: wrongMarker };
        const wrong = await prover.provePOI(
          wrongInputs,
          prepared.listKey,
          prepared.blindedIn,
          prepared.blindedOut,
          () => {}
        );
        const wrongSignals = [...signals];
        wrongSignals[4] = BigInt(wrongMarker);
        assert.equal(await serial.verify(poiArtifacts.vkey, wrongSignals, wrong.proof), true);
        const wrongPayload =
          require('../../src/main/wallet/railgun-poi-payload').normalizeRailgunPoiPayload({
            ...result.payload,
            proof: wrong.proof,
            railgunTxidIfHasUnshield: wrongMarker,
          });
        assert.throws(() => bindRailgunOwnPoiPayload(wrongPayload, expectedFields));
        markerControl = {
          payload: wrongPayload,
          cryptographicallyVerified: true,
          applicationRefused: true,
        };
      }
    }
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    assert.equal(globalThis.curve_bn128, null);
    const value = {
      payload: result.payload,
      ...(input.combinedQualification ? { combinedBindingVerified: true, markerControl } : {}),
      kind: input.kind,
      creatorKind,
      creatorSender: creatorKind === 'Transact' ? 'foreign' : null,
      creatorSenderVisible: creatorKind === 'Transact',
      reconstructionControls,
      reconstructionCompared: true,
      legacyEncryptionQualified: false,
      verified: true,
      transactionProofVerified: true,
      controls,
      txidLeafIndex: prepared.txidLeafIndex,
      txidRootIndex: prepared.txidRootIndex,
      allPublicSignalsCompared: true,
      changedPublicSignalsRefused: 8,
      derivedMarkerMatched: true,
      repeatedAssemblyMatched: true,
      localProverMatched: true,
      secondAttemptRefused: true,
      elapsedMs: Math.round(performance.now() - start),
      guardAttempts: guardReport().attempts,
      authorityGranted: false,
      liveQueries: 0,
      submissions: 0,
    };
    assert.deepEqual(
      JSON.parse(await request(JSON.stringify({ id: 1, method: 'result', value }))),
      { id: 1, value: null }
    );
  } finally {
    spendKey.fill(0);
    viewingKey.fill(0);
    foreignViewingKey.fill(0);
    loaded.forEach((a) => {
      a.wasm.fill(0);
      a.zkey.fill(0);
    });
    scope.close();
  }
};
