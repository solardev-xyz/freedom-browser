/** Cold synthetic recovery. Only public test viewing material is constructed
 * here; the capsule and stored signature came from a different, exited utility.
 */
const assert = require('assert/strict');
const path = require('path');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  const input = JSON.parse(text);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  const publicKey = input.spendingPublicKey.map(BigInt),
    nullifyingKey = 123n;
  const viewingKey = Buffer.alloc(32, 8);
  let prover;
  try {
    const position = input.capsule.selection.position;
    const pubkey = await imp('utils/keys-utils').getPublicViewingKey(viewingKey);
    const addressKeys = {
      masterPublicKey: imp('key-derivation/wallet-node').WalletNode.getMasterPublicKey(
        publicKey,
        nullifyingKey
      ),
      viewingPublicKey: pubkey,
    };
    const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
    const note = new ShieldNoteERC20(
      addressKeys.masterPublicKey,
      '01'.repeat(16),
      1000n,
      pins.wrappedNative
    );
    const leaf = ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value);
    const instanceId = imp('key-derivation/bech32').encodeAddress(addressKeys);
    const descriptor = {
      walletId: '1'.repeat(64),
      instanceId,
      spendingPublicKey: input.spendingPublicKey.map((v) => v.slice(2)),
    };
    const wallet = {
      addressKeys,
      viewingKeyPair: { privateKey: viewingKey, pubkey },
      getAddress: () => instanceId,
      getNullifyingKey: () => nullifyingKey,
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
      received: [{ tree: 0, position, hash: hex(leaf).slice(2), value: '1000', spentTxid: false }],
      ownedPoi: [
        {
          id: `0:${position}`,
          hash: hex(leaf),
          nullifier: hex(
            imp('note/transact-note').TransactNote.getNullifier(nullifyingKey, position)
          ),
        },
      ],
    };
    prover =
      await require('../../src/main/wallet/railgun-private-prover').createRailgunPrivateProver({
        archive,
        proverArchive: input.proverArchive,
        artifactDirectory: input.artifactDirectory,
        spendingPublicKey: input.spendingPublicKey,
        intentKind: input.capsule.selection.kind,
        signal,
      });
    const { prepared, proved, controls } =
      await require('./railgun-reconstruction-controls').runControls(
        { archive, wallet, descriptor, scan, capsule: input.capsule, signal },
        async (reconstructed) => prover.prove(reconstructed, input.signature),
        async (retargeted) => {
          const rejected =
            await require('../../src/main/wallet/railgun-private-prover').createRailgunPrivateProver(
              {
                archive,
                proverArchive: input.proverArchive,
                artifactDirectory: input.artifactDirectory,
                spendingPublicKey: input.spendingPublicKey,
                intentKind: input.capsule.selection.kind,
                signal,
              }
            );
          let reached = false;
          try {
            await assert.rejects(() =>
              rejected.prove(
                {
                  ...retargeted,
                  transaction: {
                    generateProvedTransaction() {
                      reached = true;
                      throw Error('Must reject first');
                    },
                  },
                },
                input.signature
              )
            );
            assert.equal(reached, false);
          } finally {
            rejected.close();
          }
        }
      );
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    const pub = prepared.witness.publicInputs;
    const railgunTxid = hex(
      imp('transaction/railgun-txid').getRailgunTransactionIDFromBigInts(
        pub.nullifiers,
        pub.commitmentsOut,
        pub.boundParamsHash
      )
    );
    const value = {
      intent: prepared.publicPreparation.transaction,
      expected: prepared.publicPreparation.expected,
      finalTransaction: proved.transaction,
      railgunTxid,
      guards: guardReport(),
      storedSignatureUsed: true,
      controls,
    };
    assert.deepEqual(
      JSON.parse(await request(JSON.stringify({ id: 1, method: 'result', value }))),
      { id: 1, value: null }
    );
  } finally {
    viewingKey.fill(0);
    prover?.close();
  }
};
