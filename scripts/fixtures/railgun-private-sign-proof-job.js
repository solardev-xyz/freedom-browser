/** Synthetic prepare/prove side of the split-signer qualification. It receives
 * a public spending key, never a spending private key. No account or network.
 */
const assert = require('assert/strict'),
  path = require('path');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.ok(['transfer', 'unshield', 'partial'].includes(input.kind));
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const imp = (name) => require(path.join(engine, name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { poseidon } = imp('utils/poseidon');
  const { getPublicViewingKey } = imp('utils/keys-utils');
  const { WalletNode } = imp('key-derivation/wallet-node');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { Transaction } = imp('transaction/transaction');
  const { TransactNote } = imp('note/transact-note');
  const { Prover } = imp('prover/prover');
  const { Interface } = require('ethers');
  const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
  const {
    matchRailgunPrivateProvedTransaction,
  } = require('../../src/main/wallet/railgun-private-intent');
  const abi = new Interface([TRANSACT_ABI]);
  const publicKey = input.spendingPublicKey.map(BigInt),
    nullifyingKey = 123n;
  const viewingKey = Buffer.alloc(32, 8),
    viewingPublicKey = await getPublicViewingKey(viewingKey);
  const addressKeys = {
    masterPublicKey: WalletNode.getMasterPublicKey(publicKey, nullifyingKey),
    viewingPublicKey,
  };
  const note = new ShieldNoteERC20(
    addressKeys.masterPublicKey,
    '01'.repeat(16),
    1000n,
    pins.wrappedNative
  );
  const leaf = ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value);
  const position = input.checkpointOnly ? 10245 : 0;
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
  imp('wallet/wallet-info').default.setWalletSource('freedom');
  const partial = input.kind === 'partial';
  const unshield = input.kind === 'unshield' || partial;
  const intentKind = partial
    ? 'railgun-partial-unshield'
    : unshield
      ? 'railgun-token-unshield'
      : 'railgun-private-transfer';
  const outputCount = partial ? 2 : 1;
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
  let transaction = new Transaction(
    { type: 0, id: pins.chainId },
    note.tokenData,
    0,
    [{ note, tree: 0, position }],
    outputs,
    { contract: '0x' + '0'.repeat(40), parameters: hex(0n) }
  );
  const recipient = '0x' + '12'.repeat(20);
  if (unshield && !partial)
    transaction.addUnshieldData(
      { tokenData: note.tokenData, toAddress: recipient, allowOverride: false },
      note.value
    );
  const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'synthetic-split-sign-proof',
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
  let artifacts, privateProver, rejectedProver, legacyProver;
  try {
    const instanceId = imp('key-derivation/bech32').encodeAddress(addressKeys);
    const descriptor = {
      walletId: '1'.repeat(64),
      instanceId,
      spendingPublicKey: input.spendingPublicKey.map((v) => v.slice(2)),
    };
    const restoredWallet = {
      ...wallet,
      getAddress: () => instanceId,
      TXOs: async () => [{ tree: 0, position, spendtxid: false, note: { ...note, hash: leaf } }],
      tokenDataGetter: {
        getTokenDataFromHash: async (_v, _c, hash) => {
          assert.equal(hash.replace(/^0x/, ''), note.tokenHash.replace(/^0x/, ''));
          return note.tokenData;
        },
      },
    };
    const scan = {
      instanceId,
      received: [
        {
          tree: 0,
          position,
          hash: hex(leaf).slice(2),
          value: note.value.toString(),
          spentTxid: false,
        },
      ],
      ownedPoi: [
        {
          id: `0:${position}`,
          hash: hex(leaf),
          nullifier: hex(TransactNote.getNullifier(nullifyingKey, position)),
        },
      ],
    };
    const selection = {
      kind: intentKind,
      tree: 0,
      position,
      recipient: unshield ? recipient : instanceId,
      ...(partial ? { unshieldAmount: '400' } : {}),
    };
    let original;
    if (partial) {
      original =
        await require('../../src/main/wallet/railgun-private-witness').prepareRailgunPrivateWitness(
          {
            archive,
            wallet: restoredWallet,
            descriptor,
            scan,
            selection,
            signal,
            tree: wallet.getUTXOMerkletree(),
            checkpoint: {
              state: { trees: [{ tree: 0, root: hex(merkleRoot), length: position + 1 }] },
            },
          }
        );
      transaction = original.transaction;
      assert.deepEqual(original.witness.privateInputs.valueIn, [1000n]);
      assert.deepEqual(original.witness.privateInputs.valueOut, [600n, 400n]);
      assert.equal(original.witness.publicInputs.commitmentsOut.length, 2);
    }
    const txRequest = partial
      ? original.witness
      : await transaction.generateTransactionRequest(wallet, 'V2_PoseidonMerkle', '', {
          minGasPrice: 0n,
        });
    const proverArchive =
      require('../../src/main/wallet/railgun-prover-runtime').verifyRailgunProverRuntime(
        input.proverArchive
      );
    artifacts = await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts({
      handle,
      directory: input.artifactDirectory,
      variant: partial ? '01x02' : '01x01',
    });
    const prover = new Prover({
      assertArtifactExists: (i, o) => {
        assert.equal(i, 1);
        assert.equal(o, outputCount);
      },
      getArtifacts: async (pub) => {
        assert.equal(pub.nullifiers.length, 1);
        assert.equal(pub.commitmentsOut.length, outputCount);
        return artifacts;
      },
    });
    prover.setSnarkJSGroth16(require(path.join(proverArchive, 'serial-prover.cjs')));
    const openPrivateProver = () =>
      require('../../src/main/wallet/railgun-private-prover').createRailgunPrivateProver({
        archive,
        proverArchive,
        artifactDirectory: input.artifactDirectory,
        spendingPublicKey: input.spendingPublicKey,
        ...(partial ? { intentKind } : {}),
        signal,
      });
    privateProver = await openPrivateProver();
    const dummy = partial
      ? abi.decodeFunctionData('transact', original.publicPreparation.transaction.data)[0][0]
      : await transaction.generateDummyProvedTransaction(prover, txRequest);
    const expected = partial
      ? original.publicPreparation.expected
      : {
          kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
          tree: 0,
          merkleRoot: hex(txRequest.publicInputs.merkleRoot),
          nullifier: hex(txRequest.publicInputs.nullifiers[0]),
          commitment: hex(txRequest.publicInputs.commitmentsOut[0]),
          boundParamsHash: hex(txRequest.publicInputs.boundParamsHash),
          ...(unshield ? { recipient, amount: note.value.toString() } : {}),
        };
    const intent = partial
      ? original.publicPreparation.transaction
      : {
          chainId: pins.chainId,
          to: pins.proxy,
          value: '0',
          data: abi.encodeFunctionData('transact', [[dummy]]),
        };
    const messageHash = (pub) =>
      hex(
        poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])
      );
    const payload = {
      archive,
      transaction: intent,
      expected,
      expectedHash: messageHash(txRequest.publicInputs),
      spendingPublicKey: input.spendingPublicKey,
    };
    const start = performance.now();
    let prepared = partial
      ? original
      : {
          witness: txRequest,
          transaction,
          publicPreparation: {
            transaction: intent,
            expected,
            expectedHash: payload.expectedHash,
          },
        };
    const capsule =
      require('../../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule({
        version: partial ? 2 : 1,
        walletId: descriptor.walletId,
        engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
        selection,
        preparation: partial
          ? prepared.publicPreparation
          : {
              ...prepared.publicPreparation,
              recipient: selection.recipient,
              amount: note.value.toString(),
            },
        noteHash: hex(leaf),
        pathElements: Array(16).fill(hex(0n)),
      });
    prepared =
      await require('../../src/main/wallet/railgun-private-reconstruct').reconstructRailgunPrivateWitness(
        {
          archive,
          wallet: restoredWallet,
          descriptor,
          scan,
          capsule: JSON.parse(JSON.stringify(capsule)),
          signal,
        }
      );
    assert.deepEqual(prepared.witness.privateInputs, txRequest.privateInputs);
    assert.deepEqual(prepared.witness.publicInputs, txRequest.publicInputs);
    const { AbiCoder } = require('ethers');
    const { BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
    assert.equal(
      AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [prepared.witness.boundParams]),
      AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [txRequest.boundParams])
    );
    // Do not ask B for a signature until reconstruction matches the original witness.
    const reply = JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'sign', value: payload }))
    );
    assert.equal(reply.id, 1);
    const signature = reply.value;
    if (input.checkpointOnly) {
      await request(JSON.stringify({ id: 2, method: 'checkpoint', value: capsule }));
      throw Error('Injected stop before proving');
    }
    let legacyArtifactBindingRefused = false;
    if (partial) {
      legacyProver =
        await require('../../src/main/wallet/railgun-private-prover').createRailgunPrivateProver({
          archive,
          proverArchive,
          artifactDirectory: input.artifactDirectory,
          spendingPublicKey: input.spendingPublicKey,
          signal,
        });
      let reached = false;
      await assert.rejects(() =>
        legacyProver.prove(
          {
            ...prepared,
            transaction: {
              generateProvedTransaction() {
                reached = true;
                throw Error('Legacy circuit admitted partial');
              },
            },
          },
          signature
        )
      );
      assert.equal(reached, false);
      legacyArtifactBindingRefused = true;
    }
    const proofResult = await privateProver.prove(prepared, signature);
    await assert.rejects(() => privateProver.prove(prepared, signature));
    assert.equal(proofResult.independentlyVerified, false);
    const finalTransaction = proofResult.transaction;
    matchRailgunPrivateProvedTransaction(intent, finalTransaction, expected);
    // Ask a new B to sign a different root, then try that otherwise valid
    // signature with the original private witness. It must fail the circuit.
    const changedRoot = txRequest.publicInputs.merkleRoot + 1n;
    const changedDummy = abi.decodeFunctionData('transact', intent.data)[0][0].toArray(true);
    changedDummy[1] = hex(changedRoot);
    const changed = {
      ...payload,
      expected: { ...expected, merkleRoot: hex(changedRoot) },
      expectedHash: messageHash({ ...txRequest.publicInputs, merkleRoot: changedRoot }),
      transaction: {
        ...intent,
        data: abi.encodeFunctionData('transact', [[changedDummy]]),
      },
    };
    const wrongReply = JSON.parse(
      await request(JSON.stringify({ id: 2, method: 'sign', value: changed }))
    );
    assert.equal(wrongReply.id, 2);
    rejectedProver = await openPrivateProver();
    let invalidSignatureReachedProver = false;
    await assert.rejects(() =>
      rejectedProver.prove(
        {
          ...prepared,
          transaction: {
            generateProvedTransaction: () => {
              invalidSignatureReachedProver = true;
              throw Error('Should reject before proving');
            },
          },
        },
        wrongReply.value
      )
    );
    assert.equal(invalidSignatureReachedProver, false);
    await assert.rejects(() =>
      prover.proveRailgun(
        'V2_PoseidonMerkle',
        {
          ...txRequest,
          signature: [...wrongReply.value.R8, wrongReply.value.S].map(BigInt),
        },
        () => {}
      )
    );
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 3,
            method: 'result',
            value: {
              kind: input.kind,
              verified: true,
              wrongMessageSignatureRefused: true,
              wrongSignatureRefusedBeforeProving: true,
              publicCapsuleReconstructedWitness: true,
              productionWitnessUsed: partial,
              artifactVariant: partial ? '01x02' : '01x01',
              publicSignalCount: outputCount + 3,
              oneUseProverRefused: true,
              legacyArtifactBindingRefused,
              proofElapsedMs: Math.round(performance.now() - start),
              guards: guardReport(),
              finalTransaction,
              intent,
              expected,
            },
          })
        )
      ),
      { id: 3, value: null }
    );
  } finally {
    privateProver?.close();
    rejectedProver?.close();
    legacyProver?.close();
    viewingKey.fill(0);
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope.close();
  }
};
