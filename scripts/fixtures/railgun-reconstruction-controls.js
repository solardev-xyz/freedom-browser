/** Real-engine tampering controls, run in the synthetic cold recovery utility. */
const assert = require('assert/strict');
const path = require('path');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
const {
  reconstructRailgunPrivateWitness,
} = require('../../src/main/wallet/railgun-private-reconstruct');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.runControls = async (args, prove, rejectRetargeted) => {
  const { capsule, wallet, archive, descriptor } = args;
  const partial = capsule.selection.kind === 'railgun-partial-unshield';
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { TransactNote } = imp('note/transact-note'),
    { Transaction } = imp('transaction/transaction');
  const { poseidon } = imp('utils/poseidon');
  const abi = new Interface([TRANSACT_ABI]);
  const copy = () => JSON.parse(JSON.stringify(capsule));
  const changed = (mutate) => {
    const value = copy(),
      tx = abi
        .decodeFunctionData('transact', value.preparation.transaction.data)[0][0]
        .toArray(true);
    mutate(tx);
    const expected = value.preparation.expected;
    expected.boundParamsHash = hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [tx[4]]))) % FIELD
    );
    if (partial) {
      expected.changeCommitment = tx[3][0];
      expected.unshieldCommitment = tx[3][1];
    } else expected.commitment = tx[3][0];
    value.preparation.expectedHash = hex(
      poseidon(
        [
          expected.merkleRoot,
          expected.boundParamsHash,
          expected.nullifier,
          ...(partial
            ? [expected.changeCommitment, expected.unshieldCommitment]
            : [expected.commitment]),
        ].map(BigInt)
      )
    );
    value.preparation.transaction.data = abi.encodeFunctionData('transact', [[tx]]);
    return value;
  };
  let foreign, wrongChange, wrongAnnotation;
  let sameViewingForeignDecrypted = false;
  if (capsule.selection.kind === 'railgun-private-transfer' || partial) {
    imp('wallet/wallet-info').default.setWalletSource('freedom');
    const [txo] = await wallet.TXOs(),
      { note } = txo;
    const foreignKey = Buffer.alloc(32, 9);
    let viewingPublicKey;
    try {
      viewingPublicKey = partial
        ? wallet.addressKeys.viewingPublicKey
        : await imp('utils/keys-utils').getPublicViewingKey(foreignKey);
    } finally {
      foreignKey.fill(0);
    }
    const createOutput = async (receiver, value) => {
      const output = TransactNote.createTransfer(
        receiver,
        wallet.addressKeys,
        value,
        note.tokenData,
        partial,
        partial ? imp('models/formatted-types').OutputType.Change : 0,
        undefined
      );
      const tx = new Transaction({ type: 0, id: 11155111 }, note.tokenData, 0, [txo], [output], {
        contract: '0x' + '0'.repeat(40),
        parameters: hex(0n),
      });
      if (partial)
        tx.addUnshieldData(
          {
            tokenData: note.tokenData,
            toAddress: capsule.selection.recipient,
            allowOverride: false,
          },
          BigInt(capsule.preparation.unshieldAmount)
        );
      const request = await tx.generateTransactionRequest(
        {
          ...wallet,
          getUTXOMerkletree: () => ({
            getRoot: async () => capsule.preparation.expected.merkleRoot.slice(2),
            getMerkleProof: async () => ({
              leaf: capsule.noteHash.slice(2),
              root: capsule.preparation.expected.merkleRoot.slice(2),
              elements: capsule.pathElements.map((v) => v.slice(2)),
              indices: hex(BigInt(capsule.selection.position)).slice(2),
            }),
          }),
          getSpendingKeyPair: async () => ({
            pubkey: descriptor.spendingPublicKey.map((v) => BigInt('0x' + v)),
          }),
          getViewingKeyPair: () => wallet.viewingKeyPair,
        },
        'V2_PoseidonMerkle',
        '',
        { minGasPrice: 0n }
      );
      return changed((value) => {
        value[3][0] = hex(request.publicInputs.commitmentsOut[0]);
        value[4][6] = request.boundParams.commitmentCiphertext;
      });
    };
    const amount = partial ? BigInt(capsule.preparation.changeAmount) : note.value;
    foreign = await createOutput(
      { masterPublicKey: wallet.addressKeys.masterPublicKey + 1n, viewingPublicKey },
      amount
    );
    if (partial) {
      wrongChange = await createOutput(wallet.addressKeys, amount + 1n);
      const { Memo } = imp('note/memo');
      const annotation = Memo.createEncryptedNoteAnnotationDataV2(
        imp('models/formatted-types').OutputType.Transfer,
        imp('models/transaction-constants').MEMO_SENDER_RANDOM_NULL,
        'freedom',
        wallet.viewingKeyPair.privateKey
      );
      wrongAnnotation = changed((tx) => {
        tx[4][6][0][3] = '0x' + annotation.replace(/^0x/, '');
      });
      const [[foreignTx]] = abi.decodeFunctionData(
        'transact',
        foreign.preparation.transaction.data
      );
      const bundle = foreignTx.boundParams.commitmentCiphertext[0];
      const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
      const shared = await imp('utils/keys-utils').getSharedSymmetricKey(
        wallet.viewingKeyPair.privateKey,
        sender
      );
      assert.ok(shared);
      try {
        const decrypted = await TransactNote.decrypt(
          'V2_PoseidonMerkle',
          { type: 0, id: 11155111 },
          wallet.addressKeys,
          {
            iv: bundle.ciphertext[0].slice(2, 34),
            tag: bundle.ciphertext[0].slice(34),
            data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
          },
          shared,
          bundle.memo,
          bundle.annotationData,
          wallet.viewingKeyPair.privateKey,
          Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex'),
          sender,
          false,
          false,
          wallet.tokenDataGetter,
          undefined,
          undefined
        );
        assert.equal(decrypted.value, amount);
        assert.equal(decrypted.tokenHash, note.tokenHash);
        assert.equal(
          imp('note/shield-note').ShieldNote.getNotePublicKey(
            wallet.addressKeys.masterPublicKey,
            decrypted.random
          ),
          decrypted.notePublicKey
        );
        assert.notEqual(hex(decrypted.hash), foreign.preparation.expected.changeCommitment);
        sameViewingForeignDecrypted = true;
      } finally {
        shared.fill(0);
      }
    }
  }
  const { ByteUtils } = imp('utils/bytes');
  const { AES } = imp('utils/encryption/aes');
  const hooks = [
    [TransactNote, 'createTransfer'],
    [TransactNote.prototype, 'encryptV2'],
    [Transaction.prototype, 'generateTransactionRequest'],
    [TransactNote, 'getNoteRandom'],
    [TransactNote, 'getSenderRandom'],
    [ByteUtils, 'randomHex'],
    [AES, 'encryptGCM'],
    [AES, 'encryptCTR'],
  ];
  const original = hooks.map(([owner, name]) => owner[name]);
  let forbiddenCalls = 0;
  const forbidden = () => {
    forbiddenCalls++;
    throw Error('Reconstruction generated new randomness');
  };
  hooks.forEach(([owner, name]) => {
    owner[name] = forbidden;
  });
  const refused = [];
  const reject = async (name, change) => {
    await assert.rejects(() => reconstructRailgunPrivateWitness({ ...args, ...change }));
    refused.push(name);
  };
  try {
    const badPath = copy();
    badPath.pathElements[0] = hex(1n);
    await reject('path', { capsule: badPath });
    const badHash = copy();
    badHash.noteHash = hex(1n);
    await reject('note-hash', { capsule: badHash });
    const badWallet = copy();
    badWallet.walletId = '2'.repeat(64);
    await reject('wallet', { capsule: badWallet });
    await reject('descriptor', {
      descriptor: { ...descriptor, spendingPublicKey: ['0'.repeat(64), '0'.repeat(64)] },
    });
    await reject('spent', {
      wallet: {
        ...wallet,
        TXOs: async () => (await wallet.TXOs()).map((v) => ({ ...v, spendtxid: hex(9n) })),
      },
    });
    await reject('amount', {
      scan: { ...args.scan, received: args.scan.received.map((v) => ({ ...v, value: '999' })) },
    });
    const badBound = copy();
    badBound.preparation.expected.boundParamsHash = hex(1n);
    await reject('structural-bound-hash', { capsule: badBound });
    const badMessage = copy();
    badMessage.preparation.expectedHash = hex(1n);
    await reject('message', { capsule: badMessage });
    if (foreign) {
      const cipher = changed((v) => {
        v[4][6][0][0][1] = hex(BigInt(v[4][6][0][0][1]) ^ 1n);
      });
      await reject('ciphertext', { capsule: cipher });
      await reject(partial ? 'foreign-same-viewing-change' : 'foreign-output-ciphertext', {
        capsule: foreign,
      });
      const commitment = changed((v) => {
        v[3][0] = hex(BigInt(v[3][0]) ^ 1n);
      });
      await reject('output-commitment', { capsule: commitment });
    }
    if (!foreign || partial) {
      const badRecipient = copy();
      badRecipient.selection.recipient = '0x' + '34'.repeat(20);
      await reject('structural-unshield-recipient', { capsule: badRecipient });
      const recipient = '0x' + '34'.repeat(20);
      const [txo] = await wallet.TXOs();
      const retargeted = changed((tx) => {
        tx[5][0] = hex(BigInt(recipient));
        tx[3][partial ? 1 : 0] = hex(
          imp('note/note-util').getNoteHash(
            recipient,
            txo.note.tokenData,
            partial ? BigInt(capsule.preparation.unshieldAmount) : txo.note.value
          )
        );
      });
      retargeted.selection.recipient = retargeted.preparation.recipient = recipient;
      retargeted.preparation.expected.recipient = recipient;
      const validButUnauthorized = await reconstructRailgunPrivateWitness({
        ...args,
        capsule: retargeted,
      });
      await rejectRetargeted(validButUnauthorized);
      refused.push('consistent-retargeting-signature');
    }
    let absentMemoAccepted = false;
    if (partial) {
      // Normalize these coherently rebound wire mutations before testing ownership.
      const normalize =
        require('../../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule;
      for (const [name, value] of [
        ['change-value', wrongChange],
        ['annotation', wrongAnnotation],
      ]) {
        normalize(value);
        await reject(name, { capsule: value });
      }
      const swapped = changed((tx) => {
        tx[3] = [tx[3][1], tx[3][0]];
      });
      normalize(swapped);
      await reject('swapped-commitments', { capsule: swapped });
      const badPreimage = changed((tx) => {
        tx[5][2] += 1n;
      });
      await reject('unshield-preimage', { capsule: badPreimage });
      const wrongKey = Buffer.alloc(32, 9);
      try {
        await reject('viewing-key', {
          wallet: { ...wallet, viewingKeyPair: { ...wallet.viewingKeyPair, privateKey: wrongKey } },
        });
      } finally {
        wrongKey.fill(0);
      }
      const [[originalTx]] = abi.decodeFunctionData(
        'transact',
        capsule.preparation.transaction.data
      );
      assert.equal(originalTx.boundParams.commitmentCiphertext[0].memo, '0x');
      assert.equal(
        imp('note/memo').Memo.decryptNoteAnnotationData(
          originalTx.boundParams.commitmentCiphertext[0].annotationData,
          wallet.viewingKeyPair.privateKey
        ).outputType,
        imp('models/formatted-types').OutputType.Change
      );
      // SDK undefined memo round-trips to the exact empty ABI bytes, without a rewrite.
      const noMemo = await reconstructRailgunPrivateWitness(args);
      assert.deepEqual(noMemo.publicPreparation.transaction, capsule.preparation.transaction);
      absentMemoAccepted = true;
    }
    const restored = await reconstructRailgunPrivateWitness(args);
    let reachedProver = false;
    await assert.rejects(() =>
      restored.transaction.generateProvedTransaction(
        'V2_PoseidonMerkle',
        {
          proveRailgun: () => {
            reachedProver = true;
            throw Error('Must refuse first');
          },
        },
        { ...restored.witness, publicInputs: { ...restored.witness.publicInputs, merkleRoot: 1n } },
        () => {}
      )
    );
    assert.equal(reachedProver, false);
    refused.push('substituted-facade-input');
    const proved = await prove(restored);
    assert.equal(forbiddenCalls, 0);
    return {
      prepared: restored,
      proved,
      controls: {
        refused,
        ...(partial ? { sameViewingForeignDecrypted, absentMemoAccepted } : {}),
        freshPreparationCalls: forbiddenCalls,
        forbiddenHooks: hooks.map(([, name]) => name),
      },
    };
  } finally {
    hooks.forEach(([owner, name], i) => {
      owner[name] = original[i];
    });
  }
};
