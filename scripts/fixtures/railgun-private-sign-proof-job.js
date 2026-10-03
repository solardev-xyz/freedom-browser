/** Synthetic prepare/prove side of the split-signer qualification. It receives
 * a public spending key, never a spending private key. No account or network.
 */
const assert = require('assert/strict'),
  path = require('path');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.ok(['transfer', 'unshield'].includes(input.kind));
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
  let merkleRoot = leaf;
  for (let i = 0; i < 16; i++) merkleRoot = poseidon([merkleRoot, 0n]);
  const viewingKeyPair = { privateKey: viewingKey, pubkey: viewingPublicKey };
  const wallet = {
    getUTXOMerkletree: () => ({
      getRoot: async () => hex(merkleRoot).slice(2),
      getMerkleProof: async () => ({
        leaf: hex(leaf).slice(2),
        root: hex(merkleRoot).slice(2),
        elements: Array(16).fill(hex(0n).slice(2)),
        indices: hex(0n).slice(2),
      }),
    }),
    getSpendingKeyPair: async () => ({ pubkey: publicKey }),
    getNullifyingKey: () => nullifyingKey,
    getViewingKeyPair: () => viewingKeyPair,
    viewingKeyPair,
    addressKeys,
  };
  imp('wallet/wallet-info').default.setWalletSource('freedom');
  const unshield = input.kind === 'unshield';
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
  const transaction = new Transaction(
    { type: 0, id: pins.chainId },
    note.tokenData,
    0,
    [{ note, tree: 0, position: 0 }],
    outputs,
    { contract: '0x' + '0'.repeat(40), parameters: hex(0n) }
  );
  const recipient = '0x' + '12'.repeat(20);
  if (unshield)
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
  let artifacts, privateProver, rejectedProver;
  try {
    const txRequest = await transaction.generateTransactionRequest(
      wallet,
      'V2_PoseidonMerkle',
      '',
      { minGasPrice: 0n }
    );
    const proverArchive =
      require('../../src/main/wallet/railgun-prover-runtime').verifyRailgunProverRuntime(
        input.proverArchive
      );
    artifacts = await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts({
      handle,
      directory: input.artifactDirectory,
      variant: '01x01',
    });
    const prover = new Prover({
      assertArtifactExists: (i, o) => {
        assert.equal(i, 1);
        assert.equal(o, 1);
      },
      getArtifacts: async (pub) => {
        assert.equal(pub.nullifiers.length, 1);
        assert.equal(pub.commitmentsOut.length, 1);
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
        signal,
      });
    privateProver = await openPrivateProver();
    const dummy = await transaction.generateDummyProvedTransaction(prover, txRequest);
    const expected = {
      kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
      tree: 0,
      merkleRoot: hex(txRequest.publicInputs.merkleRoot),
      nullifier: hex(txRequest.publicInputs.nullifiers[0]),
      commitment: hex(txRequest.publicInputs.commitmentsOut[0]),
      boundParamsHash: hex(txRequest.publicInputs.boundParamsHash),
      ...(unshield ? { recipient, amount: note.value.toString() } : {}),
    };
    const intent = {
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
    const reply = JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'sign', value: payload }))
    );
    assert.equal(reply.id, 1);
    const signature = reply.value;
    const start = performance.now();
    const prepared = {
      witness: txRequest,
      transaction,
      publicPreparation: {
        transaction: intent,
        expected,
        expectedHash: payload.expectedHash,
      },
    };
    const proofResult = await privateProver.prove(prepared, signature);
    assert.equal(proofResult.independentlyVerified, false);
    const finalTransaction = proofResult.transaction;
    matchRailgunPrivateProvedTransaction(intent, finalTransaction, expected);
    // Ask a new B to sign a different root, then try that otherwise valid
    // signature with the original private witness. It must fail the circuit.
    const changedRoot = txRequest.publicInputs.merkleRoot + 1n;
    const changed = {
      ...payload,
      expected: { ...expected, merkleRoot: hex(changedRoot) },
      expectedHash: messageHash({ ...txRequest.publicInputs, merkleRoot: changedRoot }),
      transaction: {
        ...intent,
        data: abi.encodeFunctionData('transact', [[{ ...dummy, merkleRoot: hex(changedRoot) }]]),
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
    viewingKey.fill(0);
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope.close();
  }
};
