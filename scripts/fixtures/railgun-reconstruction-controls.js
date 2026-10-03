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
    expected.commitment = tx[3][0];
    value.preparation.expectedHash = hex(
      poseidon(
        [
          expected.merkleRoot,
          expected.boundParamsHash,
          expected.nullifier,
          expected.commitment,
        ].map(BigInt)
      )
    );
    value.preparation.transaction.data = abi.encodeFunctionData('transact', [[tx]]);
    return value;
  };
  let foreign;
  if (capsule.selection.kind === 'railgun-private-transfer') {
    imp('wallet/wallet-info').default.setWalletSource('freedom');
    const [txo] = await wallet.TXOs(),
      { note } = txo;
    const foreignKey = Buffer.alloc(32, 9);
    let viewingPublicKey;
    try {
      viewingPublicKey = await imp('utils/keys-utils').getPublicViewingKey(foreignKey);
    } finally {
      foreignKey.fill(0);
    }
    const foreignAddress = {
      masterPublicKey: wallet.addressKeys.masterPublicKey + 1n,
      viewingPublicKey,
    };
    const output = TransactNote.createTransfer(
      foreignAddress,
      wallet.addressKeys,
      note.value,
      note.tokenData,
      false,
      0,
      undefined
    );
    const chain = { type: 0, id: 11155111 };
    const tx = new Transaction(chain, note.tokenData, 0, [txo], [output], {
      contract: '0x' + '0'.repeat(40),
      parameters: hex(0n),
    });
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
    foreign = changed((value) => {
      value[3][0] = hex(request.publicInputs.commitmentsOut[0]);
      value[4][6] = request.boundParams.commitmentCiphertext;
    });
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
      await reject('foreign-output-ciphertext', { capsule: foreign });
      const commitment = changed((v) => {
        v[3][0] = hex(BigInt(v[3][0]) ^ 1n);
      });
      await reject('output-commitment', { capsule: commitment });
    } else {
      const badRecipient = copy();
      badRecipient.selection.recipient = '0x' + '34'.repeat(20);
      await reject('structural-unshield-recipient', { capsule: badRecipient });
      const recipient = '0x' + '34'.repeat(20);
      const [txo] = await wallet.TXOs();
      const retargeted = changed((tx) => {
        tx[5][0] = hex(BigInt(recipient));
        tx[3][0] = hex(
          imp('note/note-util').getNoteHash(recipient, txo.note.tokenData, txo.note.value)
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
