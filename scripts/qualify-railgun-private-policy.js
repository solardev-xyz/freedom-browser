/** Offline differential: actual engine preparation with synthetic notes and
 * viewing material, no spending key exposed to preparation, and dummy proofs.
 * This does not qualify real proofs, owned notes, signing or guarded Electron.
 * node script NEW_OUTPUT_JSON
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { createRequire } = require('module');
async function main() {
  const output = process.argv[2];
  assert.equal(process.argv.length, 3);
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output));
  const fixture = path.join(__dirname, 'fixtures/railgun-engine');
  const inventory = require('./railgun-fixture-integrity').assertRailgunFixture(
    path.join(fixture, 'node_modules')
  );
  assert.equal(
    inventory.sha256,
    require('../src/main/wallet/railgun-engine-manifest.json').inventory.sha256
  );
  const r = createRequire(path.join(fixture, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const imp = (name) => require(path.join(root, name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { poseidon } = imp('utils/poseidon');
  const { getPublicSpendingKey, getPublicViewingKey, getSharedSymmetricKey } =
    imp('utils/keys-utils');
  const { WalletNode } = imp('key-derivation/wallet-node');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { ShieldNote } = imp('note/shield-note');
  const { TransactNote } = imp('note/transact-note');
  const { Transaction } = imp('transaction/transaction');
  const { Prover } = imp('prover/prover');
  const { hashBoundParamsV2 } = imp('transaction/bound-params');
  const pins = require('../src/main/wallet/railgun-shield-pins.json');
  const {
    TRANSACT_ABI,
    validateRailgunPrivateTransaction,
  } = require('../src/main/wallet/railgun-private-policy');
  const ethers = r('ethers'),
    engineAbi = new ethers.Interface(imp('abi/V2.1/RailgunSmartWallet.json'));
  const mainAbi = new (require('ethers').Interface)([TRANSACT_ABI]);
  assert.equal(
    mainAbi.getFunction('transact').selector,
    engineAbi.getFunction('transact').selector
  );
  const spendingFixture = Buffer.alloc(32, 7),
    viewingFixture = Buffer.alloc(32, 8);
  const spendingPublicKey = getPublicSpendingKey(spendingFixture);
  spendingFixture.fill(0);
  const nullifyingKey = 123n;
  const master = WalletNode.getMasterPublicKey(spendingPublicKey, nullifyingKey);
  const viewingPublicKey = await getPublicViewingKey(viewingFixture);
  const addressKeys = { masterPublicKey: master, viewingPublicKey };
  const inputNote = new ShieldNoteERC20(master, '01'.repeat(16), 1000n, pins.wrappedNative);
  const leaf = ShieldNote.getShieldNoteHash(
    inputNote.notePublicKey,
    inputNote.tokenHash,
    inputNote.value
  );
  const bare = (n) => n.toString(16).padStart(64, '0'),
    hex = (n) => '0x' + bare(n);
  const elements = Array(16).fill(bare(0n));
  let rootHash = leaf;
  for (let n = 0; n < 16; n++) rootHash = poseidon([rootHash, 0n]);
  const viewingKeys = { privateKey: viewingFixture, pubkey: viewingPublicKey };
  const wallet = {
    getUTXOMerkletree: () => ({
      getRoot: async () => bare(rootHash),
      getMerkleProof: async () => ({
        leaf: bare(leaf),
        root: bare(rootHash),
        elements,
        indices: bare(0n),
      }),
    }),
    getSpendingKeyPair: async () => ({ pubkey: spendingPublicKey }),
    getNullifyingKey: () => nullifyingKey,
    getViewingKeyPair: () => viewingKeys,
    viewingKeyPair: viewingKeys,
    addressKeys,
  };
  imp('wallet/wallet-info').default.setWalletSource('freedom');
  const results = [];
  try {
    for (const unshield of [false, true]) {
      const outputs = unshield
        ? []
        : [
            TransactNote.createTransfer(
              addressKeys,
              addressKeys,
              inputNote.value,
              inputNote.tokenData,
              false,
              0,
              undefined
            ),
          ];
      const transaction = new Transaction(
        { type: 0, id: pins.chainId },
        inputNote.tokenData,
        0,
        [{ note: inputNote, tree: 0, position: 0 }],
        outputs,
        { contract: ethers.ZeroAddress, parameters: hex(0n) }
      );
      const recipient = '0x' + '12'.repeat(20);
      if (unshield)
        transaction.addUnshieldData(
          { tokenData: inputNote.tokenData, toAddress: recipient, allowOverride: false },
          inputNote.value
        );
      const request = await transaction.generateTransactionRequest(
        wallet,
        'V2_PoseidonMerkle',
        '',
        { minGasPrice: 0n }
      );
      const prover = new Prover({
        assertArtifactExists: (inputs, outputs) => {
          assert.equal(inputs, 1);
          assert.equal(outputs, 1);
        },
      });
      const prepared = await transaction.generateDummyProvedTransaction(prover, request);
      const expected = {
        kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
        tree: 0,
        merkleRoot: hex(request.publicInputs.merkleRoot),
        nullifier: hex(request.publicInputs.nullifiers[0]),
        commitment: hex(request.publicInputs.commitmentsOut[0]),
        boundParamsHash: hex(hashBoundParamsV2(request.boundParams)),
        ...(unshield ? { recipient, amount: inputNote.value.toString() } : {}),
      };
      const tx = {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: engineAbi.encodeFunctionData('transact', [[prepared]]),
      };
      const checked = validateRailgunPrivateTransaction(tx, expected);
      assert.equal(checked.spendingEnabled, false);
      assert.equal(checked.proofVerified, false);
      if (unshield) {
        assert.equal(
          imp('note/note-util').getNoteHash(recipient, inputNote.tokenData, inputNote.value),
          request.publicInputs.commitmentsOut[0]
        );
      } else {
        const bundle = prepared.boundParams.commitmentCiphertext[0];
        const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
        const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
        const symmetric = await getSharedSymmetricKey(viewingFixture, sender);
        assert.ok(symmetric);
        try {
          const ciphertext = {
            iv: bundle.ciphertext[0].slice(2, 34),
            tag: bundle.ciphertext[0].slice(34),
            data: bundle.ciphertext.slice(1).map((item) => item.slice(2)),
          };
          const decrypt = (cipher) =>
            TransactNote.decrypt(
              'V2_PoseidonMerkle',
              { type: 0, id: pins.chainId },
              addressKeys,
              cipher,
              symmetric,
              bundle.memo,
              bundle.annotationData,
              viewingFixture,
              receiver,
              sender,
              false,
              false,
              {
                getTokenDataFromHash: async (_version, _chain, tokenHash) => {
                  assert.equal(
                    tokenHash.replace(/^0x/, ''),
                    inputNote.tokenHash.replace(/^0x/, '')
                  );
                  return inputNote.tokenData;
                },
              },
              undefined,
              undefined
            );
          const received = await decrypt(ciphertext);
          assert.equal(received.value, inputNote.value);
          assert.equal(received.tokenHash, inputNote.tokenHash);
          assert.equal(received.hash, request.publicInputs.commitmentsOut[0]);
          assert.equal(
            TransactNote.getHash(received.notePublicKey, received.tokenHash, received.value),
            received.hash
          );
          await assert.rejects(() =>
            decrypt({ ...ciphertext, data: ['00'.repeat(32), ...ciphertext.data.slice(1)] })
          );
        } finally {
          symmetric.fill(0);
        }
      }
      const originalChain = prepared.boundParams.chainID;
      prepared.boundParams.chainID = '0x0000000000000001';
      assert.throws(() =>
        validateRailgunPrivateTransaction(
          { ...tx, data: engineAbi.encodeFunctionData('transact', [[prepared]]) },
          expected
        )
      );
      prepared.boundParams.chainID = originalChain;
      results.push({
        kind: expected.kind,
        matched: true,
        wrongChainRefused: true,
        dummyProof: true,
        unshieldCommitmentChecked: unshield,
        selfTransferDecrypted: !unshield,
        corruptCiphertextRefused: !unshield,
      });
    }
  } finally {
    viewingFixture.fill(0);
  }
  const sources = [
    'scripts/qualify-railgun-private-policy.js',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-private-policy.js',
    'src/main/wallet/railgun-shield-pins.json',
    'src/main/wallet/railgun-engine-manifest.json',
  ];
  const report = {
    observedAt: new Date().toISOString(),
    inventory: inventory.sha256,
    runtime: 'integrity-checked Node fixture; not guarded Electron',
    syntheticNotes: true,
    preparationReceivedSpendingPrivateKey: false,
    transactionSelectorMatched: true,
    sourceSha256: Object.fromEntries(
      sources.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    ),
    results,
    accountsOpened: 0,
    networkRequests: 0,
    signatures: 0,
    proofsGenerated: 0,
    submissions: 0,
    passed: true,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: true, cases: results.length }));
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
