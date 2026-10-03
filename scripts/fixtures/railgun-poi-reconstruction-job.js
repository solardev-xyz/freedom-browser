/** Disposable public-mnemonic fixture. Real 1x1 proof and viewing-only POI
 * reconstruction, synthetic inclusion/list paths; no live account or network. */
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
    const reconstruct =
      require('../../src/main/wallet/railgun-poi-reconstruct').reconstructRailgunPoiNotes;
    const args = { archive, descriptor, viewingKey, capsule, creator, signal };
    const recovered = await reconstruct(args);
    assert.equal(recovered.nullifyingKey, txRequest.privateInputs.nullifyingKey);
    assert.deepEqual(
      recovered.randomsIn.map((v) => BigInt('0x' + v)),
      txRequest.privateInputs.randomIn
    );
    assert.deepEqual(recovered.valuesIn, txRequest.privateInputs.valueIn);
    assert.deepEqual(recovered.npksOut, unshield ? [] : txRequest.privateInputs.npkOut);
    assert.deepEqual(recovered.valuesOut, unshield ? [] : txRequest.privateInputs.valueOut);
    // Reconstruction must work without a wallet scan and must not weaken the
    // separate pre-spend routine's strict unspent-note condition.
    const controls = [];
    const reject = async (name, changed) => {
      await assert.rejects(() => reconstruct({ ...args, ...changed }));
      controls.push(name);
    };
    await reject('position', { creator: { ...creator, position: position + 1 } });
    await reject('net-value', {
      creator: { ...creator, preimage: { ...creator.preimage, value: '999' } },
    });
    await reject('note-hash', { capsule: { ...capsule, noteHash: hex(1n) } });
    await reject('wrong-viewing-key', { viewingKey: Buffer.alloc(32, 9) });
    await reject('foreign-identity', { descriptor: { ...descriptor, instanceId: '0zk1wrong' } });
    const badCipher = structuredClone(creator);
    badCipher.ciphertext.encryptedBundle[0] = hex(1n);
    await reject('creator-ciphertext', { creator: badCipher });
    const { BlindedCommitment } = imp('poi/blinded-commitment');
    const { getGlobalTreePosition } = imp('poi/global-tree-position');
    const { getRailgunTransactionIDFromBigInts, getRailgunTxidLeafHash } = imp(
      'transaction/railgun-txid'
    );
    const { verifyMerkleProof } = imp('merkletree/merkle-proof');
    const syntheticPath = (leaf) => {
      const index = 5,
        elements = Array.from({ length: 16 }, (_, i) => hex(BigInt(i + 1)).slice(2));
      let root = BigInt('0x' + leaf.replace(/^0x/, ''));
      for (let i = 0; i < 16; i++)
        root = poseidon(
          (index >> i) & 1 ? [BigInt('0x' + elements[i]), root] : [root, BigInt('0x' + elements[i])]
        );
      return {
        leaf: leaf.replace(/^0x/, ''),
        indices: hex(BigInt(index)).slice(2),
        root: hex(root).slice(2),
        elements,
      };
    };
    const railgunTxid = getRailgunTransactionIDFromBigInts(
      pub.nullifiers,
      pub.commitmentsOut,
      pub.boundParamsHash
    );
    const globalOut = getGlobalTreePosition(unshield ? 99999 : 0, unshield ? 99999 : 23456);
    const txidProof = syntheticPath(getRailgunTxidLeafHash(railgunTxid, 0n, globalOut));
    const blindedIn = [
      BlindedCommitment.getForShieldOrTransact(
        hex(leaf),
        recovered.inputNpk,
        getGlobalTreePosition(0, position)
      ),
    ];
    const membership = syntheticPath(blindedIn[0]);
    assert.equal(verifyMerkleProof(txidProof), true);
    assert.equal(verifyMerkleProof(membership), true);
    const blindedOut = unshield
      ? []
      : [
          BlindedCommitment.getForShieldOrTransact(
            expected.commitment,
            recovered.npksOut[0],
            globalOut
          ),
        ];
    const poiInputs = {
      anyRailgunTxidMerklerootAfterTransaction: txidProof.root,
      boundParamsHash: expected.boundParamsHash,
      nullifiers: [expected.nullifier],
      commitmentsOut: [expected.commitment],
      spendingPublicKey: recovered.spendingPublicKey,
      nullifyingKey: recovered.nullifyingKey,
      token: recovered.token,
      randomsIn: recovered.randomsIn,
      valuesIn: recovered.valuesIn,
      utxoPositionsIn: recovered.utxoPositionsIn,
      utxoTreeIn: recovered.utxoTreeIn,
      npksOut: recovered.npksOut,
      valuesOut: recovered.valuesOut,
      utxoBatchGlobalStartPositionOut: globalOut,
      railgunTxidIfHasUnshield: unshield
        ? BlindedCommitment.getForUnshield(hex(railgunTxid))
        : '0x00',
      railgunTxidMerkleProofIndices: txidProof.indices,
      railgunTxidMerkleProofPathElements: txidProof.elements,
      poiMerkleroots: [membership.root],
      poiInMerkleProofIndices: [membership.indices],
      poiInMerkleProofPathElements: [membership.elements],
    };
    const changes = {
      random: () => {
        poiInputs.randomsIn = ['02'.repeat(16)];
      },
      nullifying: () => {
        poiInputs.nullifyingKey += 1n;
      },
      output: () => {
        assert.ok(!unshield);
        poiInputs.npksOut = [poiInputs.npksOut[0] + 1n];
      },
      unshield: () => {
        assert.ok(unshield);
        poiInputs.railgunTxidIfHasUnshield = hex(railgunTxid + 1n);
      },
      txid: () => {
        poiInputs.anyRailgunTxidMerklerootAfterTransaction = hex(
          BigInt('0x' + txidProof.root) + 1n
        );
      },
      list: () => {
        poiInputs.poiMerkleroots = [hex(BigInt('0x' + membership.root) + 1n)];
      },
    };
    const markerCharacterization =
      input.fault === 'marker-omitted' || input.fault === 'marker-added';
    if (markerCharacterization) {
      assert.equal(input.fault, unshield ? 'marker-omitted' : 'marker-added');
      poiInputs.railgunTxidIfHasUnshield = unshield ? '0x00' : hex(railgunTxid);
      assert.notEqual(poiInputs.railgunTxidIfHasUnshield, unshield ? hex(railgunTxid) : '0x00');
    }
    const start = performance.now();
    let verified = false,
      circuitRejected = false;
    if (input.fault && !markerCharacterization) {
      assert.ok(Object.hasOwn(changes, input.fault));
      changes[input.fault]();
      // This is the first POI prove call in this fresh process, so no valid
      // public-input cache entry can mask private-witness corruption.
      await assert.rejects(
        () => prover.provePOI(poiInputs, 'synthetic', blindedIn, blindedOut, () => {}),
        (error) => {
          assert.equal(error.message, 'Unable to generate POI proof');
          assert.equal(error.cause?.message, 'SnarkJS failed to fullProvePOI');
          assert.match(error.cause?.cause?.message, /Assert Failed/);
          return true;
        }
      );
      circuitRejected = true;
    } else {
      const result = await prover.provePOI(poiInputs, 'synthetic', blindedIn, blindedOut, () => {});
      assert.equal(await prover.verifyPOIProof(result.publicInputs, result.proof, 3, 3), true);
      const changed = {
        ...result.publicInputs,
        poiMerkleroots: [...result.publicInputs.poiMerkleroots],
      };
      changed.poiMerkleroots[0] += 1n;
      assert.equal(await prover.verifyPOIProof(changed, result.proof, 3, 3), false);
      const changedOutput = {
        ...result.publicInputs,
        blindedCommitmentsOut: [...result.publicInputs.blindedCommitmentsOut],
      };
      changedOutput.blindedCommitmentsOut[0] += 1n;
      assert.equal(await prover.verifyPOIProof(changedOutput, result.proof, 3, 3), false);
      verified = true;
    }
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    assert.equal(globalThis.curve_bn128, null);
    const value = {
      kind: input.kind,
      fault: input.fault || null,
      transactionProofVerified: true,
      reconstructionCompared: true,
      controls,
      verified,
      circuitRejected,
      elapsedMs: Math.round(performance.now() - start),
      membershipSynthetic: true,
      inclusionSynthetic: true,
      submissions: 0,
      liveQueries: 0,
      spendingEnabled: false,
      guards: guardReport(),
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
