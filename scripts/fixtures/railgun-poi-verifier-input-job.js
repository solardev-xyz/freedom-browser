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
  const abi = new Interface([TRANSACT_ABI]);
  const seed = require('@scure/bip39').mnemonicToSeedSync(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  );
  const derive = require('../../src/main/identity/railgun-key-derivation').deriveRailgunKey;
  const spendKey = derive(seed, "m/44'/1984'/0'/0'/0'");
  const viewingKey = derive(seed, "m/420'/1984'/0'/0'/0'");
  seed.fill(0);
  const publicKey = imp('utils/keys-utils').getPublicSpendingKey(spendKey);
  const nullifyingKey = poseidon([BigInt('0x' + viewingKey.toString('hex'))]);
  const viewingPublicKey = await getPublicViewingKey(viewingKey);
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
    [{ note, tree: 0, position }],
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
      { handle, directory: input.artifactDirectory, variant: '01x01' }
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
        assert.equal(o, 1);
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
      kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
      tree: 0,
      merkleRoot: hex(pub.merkleRoot),
      nullifier: hex(pub.nullifiers[0]),
      commitment: hex(pub.commitmentsOut[0]),
      boundParamsHash: hex(pub.boundParamsHash),
      ...(unshield ? { recipient, amount: note.value.toString() } : {}),
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
      spendingPublicKey: publicKey.map((v) => hex(v).slice(2)),
      viewingPublicKey: Buffer.from(viewingPublicKey).toString('hex'),
      masterPublicKey: hex(addressKeys.masterPublicKey).slice(2),
    };
    assert.equal(viewWallet.getNullifyingKey(), nullifyingKey);
    const capsule = {
      version: 1,
      walletId: descriptor.walletId,
      engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
      selection: {
        kind: expected.kind,
        tree: 0,
        position,
        recipient: unshield ? recipient : instanceId,
      },
      preparation: {
        transaction: intent,
        expected,
        expectedHash: hex(message),
        recipient: unshield ? recipient : instanceId,
        amount: note.value.toString(),
      },
      noteHash: hex(leaf),
      pathElements: Array(16).fill(hex(0n)),
    };
    const shieldKey = Buffer.alloc(32, 6);
    let encrypted;
    try {
      encrypted = await note.serialize(shieldKey, viewingPublicKey);
    } finally {
      shieldKey.fill(0);
    }
    const creator = {
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
      unshield ? '0x' + witness.railgunTxid : '0x00'
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
      if (unshield) delete v.ownEvidence.row.unshield;
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
      unshield ? '0x' + witness.railgunTxid : '0x00'
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
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    assert.equal(globalThis.curve_bn128, null);
    const value = {
      payload: result.payload,
      kind: input.kind,
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
    loaded.forEach((a) => {
      a.wasm.fill(0);
      a.zkey.fill(0);
    });
    scope.close();
  }
};
