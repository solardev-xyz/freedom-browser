const path = require('path');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const {
  prepareRelayVector,
  assertLayout,
  assertEncryptedOutputs,
  encodeTransaction,
  hex,
  boundType,
  FIELD,
} = require('./railgun-relay-proof-data');
const { validatePublicCase, expectedVector } = require('./railgun-relay-public-data');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const engine = path.join(__dirname, 'railgun-engine/node_modules/@railgun-community/engine/dist');
const imp = (name) => require(path.join(engine, name));
const proof = {
  pi_a: ['1', '2'],
  pi_b: [
    ['3', '4'],
    ['5', '6'],
  ],
  pi_c: ['7', '8'],
};
const clone = (v) => JSON.parse(JSON.stringify(v));
let vector, raw, poseidon;
beforeAll(async () => {
  vector = await prepareRelayVector(engine, 1);
  poseidon = imp('utils/poseidon').poseidon;
  const { Prover } = imp('prover/prover');
  const dummy = await vector.transaction.generateDummyProvedTransaction(
    new Prover({
      assertArtifactExists: (i, o) => {
        expect(i).toBe(1);
        expect(o).toBe(2);
      },
    }),
    vector.request
  );
  raw = {
    domain: 'public-fixture-relay-pre-poi-v1',
    minGasPrice: 1,
    transaction: encodeTransaction(dummy),
    poi: {
      proof,
      txidMerkleroot: '0x' + vector.poiInputs.anyRailgunTxidMerklerootAfterTransaction,
      poiMerkleroots: vector.poiInputs.poiMerkleroots.map((v) => '0x' + v),
      blindedCommitmentsOut: vector.blindedOut,
      railgunTxidIfHasUnshield: '0x00',
    },
  };
});
test('real engine constructor and separate formulas agree on fee, self, input and pre-POI binding (dummy proof, not verification)', () => {
  const checked = validatePublicCase(raw, 1, poseidon);
  const pub = vector.request.publicInputs;
  expect(checked.transactionSignals).toEqual([
    pub.merkleRoot,
    pub.boundParamsHash,
    ...pub.nullifiers,
    ...pub.commitmentsOut,
  ]);
  const { Prover } = imp('prover/prover');
  const expected = new Prover({}).getPublicInputsPOI(
    vector.poiInputs.anyRailgunTxidMerklerootAfterTransaction,
    vector.blindedOut,
    vector.poiInputs.poiMerkleroots,
    '0x00',
    3,
    3
  );
  expect(checked.poiSignals).toEqual([
    ...expected.blindedCommitmentsOut,
    expected.anyRailgunTxidMerklerootAfterTransaction,
    expected.railgunTxidIfHasUnshield,
    ...expected.poiMerkleroots,
  ]);
  expect(checked.poiSignals[6]).not.toBe(0n);
  expect(checked.poiSignals[6]).not.toBe(checked.poiSignals[5]);
  expect(checked.poiSignals[6]).toBe(imp('models/merkletree-types').MERKLE_ZERO_VALUE_BIGINT);
  expect(vector.poiInputs.utxoBatchGlobalStartPositionOut).toBe(199999n * 65536n + 199999n);
});
test('zero and nonzero minimum gas change signed bound hash but preserve fixed note commitments', async () => {
  const zero = await prepareRelayVector(engine, 0);
  expect(zero.request.boundParams.minGasPrice).toBe(0n);
  expect(zero.request.publicInputs.commitmentsOut).toEqual(
    vector.request.publicInputs.commitmentsOut
  );
  expect(zero.request.publicInputs.boundParamsHash).not.toBe(
    vector.request.publicInputs.boundParamsHash
  );
  await expect(prepareRelayVector(engine, 2)).rejects.toThrow();
});
test('separate expected formulas match actual fixed fee/self commitments, blinds and list root', () => {
  const expected = expectedVector(poseidon);
  expect(expected.commitments).toEqual(vector.request.publicInputs.commitmentsOut);
  expect(expected.blinds.map(hex)).toEqual(vector.blindedOut);
  expect(expected.listRoot).toBe(BigInt('0x' + vector.poiInputs.poiMerkleroots[0]));
});
test.each([
  [
    'fee value',
    (v) => {
      v.outputs[0].value++;
    },
  ],
  [
    'self value',
    (v) => {
      v.outputs[1].value--;
    },
  ],
  [
    'fee type',
    (v) => {
      v.outputs[0].outputType = 0;
    },
  ],
  ['order', (v) => v.outputs.reverse()],
  [
    'fee receiver',
    (v) => {
      v.outputs[0].receiverAddressData = v.sender;
    },
  ],
  [
    'self receiver',
    (v) => {
      v.outputs[1].receiverAddressData = v.fee;
    },
  ],
  [
    'memo',
    (v) => {
      v.outputs[0].memoText = 'not admitted';
    },
  ],
])('layout refuses %s before proof', (_name, mutate) => {
  const l = vector.layout;
  const copy = { ...l, outputs: l.outputs.map((o) => ({ ...o })) };
  mutate(copy);
  expect(() => assertLayout(copy.note, copy.outputs, copy.sender, copy.fee)).toThrow();
});
function changeTx(value, mutate) {
  const abi = new Interface([TRANSACT_ABI]);
  const [txs] = abi.decodeFunctionData('transact', value.transaction.data);
  const decoded = txs.toArray(true);
  mutate(decoded[0]);
  value.transaction.data = abi.encodeFunctionData('transact', [decoded]);
}
test.each([
  [
    'domain',
    (v) => {
      v.domain = 'own-poi';
    },
  ],
  [
    'key-shaped extra field',
    (v) => {
      v.viewingKey = 'secret';
    },
  ],
  [
    'witness-shaped extra field',
    (v) => {
      v.poi.randomsIn = ['1'];
    },
  ],
  [
    'gas selector',
    (v) => {
      v.minGasPrice = 0;
    },
  ],
  [
    'wrong network',
    (v) => {
      v.transaction.chainId++;
    },
  ],
  [
    'wrong proxy',
    (v) => {
      v.transaction.to = '0x' + '12'.repeat(20);
    },
  ],
  [
    'root',
    (v) => {
      v.poi.txidMerkleroot = hex(1n);
    },
  ],
  [
    'list',
    (v) => {
      v.poi.poiMerkleroots = [hex(1n)];
    },
  ],
  [
    'two lists',
    (v) => {
      v.poi.poiMerkleroots.push(v.poi.poiMerkleroots[0]);
    },
  ],
  [
    'reverse blinds',
    (v) => {
      v.poi.blindedCommitmentsOut.reverse();
    },
  ],
  [
    'missing fee blind',
    (v) => {
      v.poi.blindedCommitmentsOut.shift();
    },
  ],
  [
    'public unshield marker',
    (v) => {
      v.poi.railgunTxidIfHasUnshield = hex(1n);
    },
  ],
  [
    'noncanonical zero marker',
    (v) => {
      v.poi.railgunTxidIfHasUnshield = hex(0n);
    },
  ],
  [
    'proof extra',
    (v) => {
      v.poi.proof.privateInputs = {};
    },
  ],
  [
    'negative point',
    (v) => {
      v.poi.proof.pi_a[0] = '-1';
    },
  ],
  [
    'overflow point',
    (v) => {
      v.poi.proof.pi_a[0] = '9'.repeat(77);
    },
  ],
  [
    'gas binding',
    (v) =>
      changeTx(v, (t) => {
        t[4][1] = 0n;
      }),
  ],
  [
    'commitment order',
    (v) =>
      changeTx(v, (t) => {
        t[3].reverse();
      }),
  ],
  [
    'fee commitment',
    (v) =>
      changeTx(v, (t) => {
        t[3][0] = hex(1n);
      }),
  ],
  [
    'input root',
    (v) =>
      changeTx(v, (t) => {
        t[1] = hex(1n);
      }),
  ],
  [
    'input nullifier',
    (v) =>
      changeTx(v, (t) => {
        t[2][0] = hex(1n);
      }),
  ],
  [
    'ciphertext count',
    (v) =>
      changeTx(v, (t) => {
        t[4][6].pop();
      }),
  ],
  [
    'ciphertext binding',
    (v) =>
      changeTx(v, (t) => {
        t[4][6][0][0][0] = hex(1n);
      }),
  ],
])('public verifier reconstruction refuses %s without proving', (_name, mutate) => {
  const value = clone(raw);
  mutate(value);
  expect(() => validatePublicCase(value, 1, poseidon)).toThrow();
});

test.each(['ciphertext', 'annotation', 'receiver'])(
  'real decrypted output check refuses changed %s',
  async (kind) => {
    const request = {
      ...vector.request,
      boundParams: {
        ...vector.request.boundParams,
        commitmentCiphertext: vector.request.boundParams.commitmentCiphertext.map((v) => ({
          ...v,
          ciphertext: [...v.ciphertext],
        })),
      },
    };
    if (kind === 'ciphertext') request.boundParams.commitmentCiphertext[0].ciphertext[1] = hex(0n);
    if (kind === 'annotation')
      request.boundParams.commitmentCiphertext[0].annotationData =
        request.boundParams.commitmentCiphertext[1].annotationData;
    const { sender, fee } = vector.layout;
    await expect(
      assertEncryptedOutputs(engine, request, sender, kind === 'receiver' ? sender : fee)
    ).rejects.toThrow();
  }
);
test('original signature refuses changed fee commitment order and value hash', () => {
  const { verifyEDDSA } = imp('utils/keys-utils');
  const pub = vector.request.publicInputs;
  const [x, y, s] = vector.request.signature;
  const signature = { R8: [x, y], S: s };
  const message = (commitments) =>
    poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...commitments]);
  expect(
    verifyEDDSA(message(pub.commitmentsOut), signature, vector.request.privateInputs.publicKey)
  ).toBe(true);
  expect(
    verifyEDDSA(
      message([...pub.commitmentsOut].reverse()),
      signature,
      vector.request.privateInputs.publicKey
    )
  ).toBe(false);
  expect(
    verifyEDDSA(
      message([pub.commitmentsOut[0] + 1n, pub.commitmentsOut[1]]),
      signature,
      vector.request.privateInputs.publicKey
    )
  ).toBe(false);
});

test('original signature refuses identical bound tuple with only gas1 changed to gas0', () => {
  const request = vector.request;
  const changed = { ...request.boundParams, minGasPrice: 0n };
  const hash =
    BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([boundType(72)], [changed]))) % FIELD;
  expect(hash).not.toBe(request.publicInputs.boundParamsHash);
  const message = poseidon([
    request.publicInputs.merkleRoot,
    hash,
    ...request.publicInputs.nullifiers,
    ...request.publicInputs.commitmentsOut,
  ]);
  const [x, y, s] = request.signature;
  expect(
    imp('utils/keys-utils').verifyEDDSA(
      message,
      { R8: [x, y], S: s },
      request.privateInputs.publicKey
    )
  ).toBe(false);
  expect(changed.commitmentCiphertext).toBe(request.boundParams.commitmentCiphertext);
});

test('producer preparation actually checks both encrypted output annotations', async () => {
  const { Memo } = imp('note/memo');
  const observed = jest.spyOn(Memo, 'decryptNoteAnnotationData');
  try {
    await prepareRelayVector(engine, 0);
    expect(observed).toHaveBeenCalledTimes(2);
  } finally {
    observed.mockRestore();
  }
});

test('producer envelope retains only exact public shape and matching full guard catalog', () => {
  const { assertProducerResult, EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
  const value = { publicCase: raw, guards: EXPECTED_GUARDS };
  expect(() => assertProducerResult(value, 1)).not.toThrow();
  expect(() => assertProducerResult({ ...value, key: 'not permitted' }, 1)).toThrow();
  expect(() =>
    assertProducerResult({ ...value, guards: { attempts: 0, canaries: 1, hooks: ['hook'] } }, 1)
  ).toThrow();
  const extra = clone(raw);
  extra.poi.proof.privateInputs = [];
  expect(() => assertProducerResult({ ...value, publicCase: extra }, 1)).toThrow();
});
