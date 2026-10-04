const { Interface, Transaction, Wallet, AbiCoder, keccak256 } = require('ethers');
const { createHash } = require('crypto');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const {
  extractRailgunTransactIntent: extract,
  railgunTransactIntentBinding: binding,
  validRailgunTransactIntent: valid,
  railgunTransactJournalIntent: journal,
} = require('./railgun-transact-intent');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const { fixture } = require('../../../scripts/fixtures/railgun-transact-data');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([TRANSACT_ABI]);
test.each([
  [false, '767d0c8d1a9b87dd853c606f58dc61272ee62dd6db99f3f7401182ab40796fb4'],
  [true, 'e680d41f46b6d6cfced77cb3a8ced7a9f0fb96fcaf5ed5c9baf8e2719ed8ddce'],
])('preserves legacy %s intent bytes from the pre-partial checkpoint', (unshield, expected) => {
  const { createHash } = require('crypto');
  // Captured at 3e68ccb9 before modifying the policy or journal classifier.
  expect(
    createHash('sha256')
      .update(JSON.stringify(extract(fixture(unshield).transaction())))
      .digest('hex')
  ).toBe(expected);
});
test('partial calldata derives an explicit v2 binding without private amount claims', () => {
  const { preparation } = createRailgunPartialCapsuleData().capsule;
  const checked = validateRailgunPrivateSigningIntent(
    preparation.transaction,
    preparation.expected
  );
  const result = extract(preparation.transaction);
  expect(result.expected).toEqual(preparation.expected);
  expect(result.intentDigest).toBe(checked.digest);
  expect(binding(preparation.transaction)).toEqual({
    version: 2,
    operation: 'railgun-partial-unshield',
    tree: 0,
    merkleRoot: preparation.expected.merkleRoot,
    nullifier: preparation.expected.nullifier,
    changeCommitment: preparation.expected.changeCommitment,
    unshieldCommitment: preparation.expected.unshieldCommitment,
    boundParamsHash: preparation.expected.boundParamsHash,
    recipient: preparation.expected.recipient,
    unshieldAmount: '400',
    intentDigest: checked.digest,
  });
  expect(result.expected).not.toHaveProperty('inputAmount');
  expect(result.expected).not.toHaveProperty('changeAmount');
  expect(result.expected).not.toHaveProperty('amount');
  expect(result.expected).not.toHaveProperty('version');
  const tx = { ...preparation.transaction, from: '0x' + '34'.repeat(20) };
  const entry = journal(tx);
  expect(valid(entry)).toBe(true);
  const encoded = (domain) =>
    keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ['string', 'uint256', 'address', 'address', 'uint256', 'bytes'],
        [domain, tx.chainId, tx.from, tx.to, tx.value, tx.data]
      )
    );
  expect(entry.digest).toBe(encoded('railgun-transact-v2'));
  expect(entry.digest).not.toBe(encoded('railgun-transact'));
  expect(Object.isFrozen(entry)).toBe(true);
});
test.each([
  [
    false,
    'cbd10ac299d2855306ec2f71bcdefb88c2e1016923c880abcdf3e4888bd7c0c0',
    '7c455e7b710f8bd655034746883617c2ebc81c1f0023174926133c6d788d7bd2',
  ],
  [
    true,
    'ddaa2ae3dac5d4089a04dbc84f464bac2c6aabdf1ce4463097d898980c115b7c',
    'c75ff187f729679c8a581fc62a1417cface46de43e1674510e0a0a75e54e05e9',
  ],
])('preserves legacy %s binding and journal golden bytes', (u, b, j) => {
  const tx = fixture(u).transaction();
  const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  expect(sha(binding(tx))).toBe(b);
  expect(sha(journal(tx))).toBe(j);
  expect(valid({ ...journal(tx), version: 1 })).toBe(false);
  expect(valid({ ...journal(tx), version: 2 })).toBe(false);
});
function partialTransaction(f) {
  return { ...f.capsule.preparation.transaction, from: '0x' + '34'.repeat(20), data: f.encode() };
}
test('proof changes preserve partial binding; ordered commitment changes do not', () => {
  const f = createRailgunPartialCapsuleData();
  const before = binding(partialTransaction(f));
  f.inner.proof.a.x = 12n;
  expect(binding(partialTransaction(f))).toEqual(before);
  f.inner.commitments.reverse();
  const after = binding(partialTransaction(f));
  expect(after.changeCommitment).toBe(before.unshieldCommitment);
  expect(after.unshieldCommitment).toBe(before.changeCommitment);
  expect(after.intentDigest).not.toBe(before.intentDigest);
});
test.each([
  [
    'missing version',
    (v) => {
      delete v.version;
    },
  ],
  [
    'v1 downgrade',
    (v) => {
      v.version = 1;
    },
  ],
  [
    'unknown version',
    (v) => {
      v.version = 3;
    },
  ],
  [
    'string version',
    (v) => {
      v.version = '2';
    },
  ],
  [
    'legacy commitment',
    (v) => {
      v.commitment = v.changeCommitment;
    },
  ],
  [
    'legacy amount',
    (v) => {
      v.amount = v.unshieldAmount;
    },
  ],
  [
    'input amount',
    (v) => {
      v.inputAmount = '1000';
    },
  ],
  [
    'change amount',
    (v) => {
      v.changeAmount = '600';
    },
  ],
  [
    'unknown operation',
    (v) => {
      v.operation = 'partial';
    },
  ],
  [
    'legacy operation',
    (v) => {
      v.operation = 'railgun-token-unshield';
    },
  ],
  [
    'zero amount',
    (v) => {
      v.unshieldAmount = '0';
    },
  ],
  [
    'leading zero',
    (v) => {
      v.unshieldAmount = '0400';
    },
  ],
  [
    'numeric amount',
    (v) => {
      v.unshieldAmount = 400;
    },
  ],
  [
    'over cap',
    (v) => {
      v.unshieldAmount = (BigInt(pins.maxQualificationAmount) + 1n).toString();
    },
  ],
  [
    'out of field',
    (v) => {
      v.changeCommitment = '0x' + 'f'.repeat(64);
    },
  ],
  [
    'uppercase field',
    (v) => {
      v.unshieldCommitment = '0x' + 'A'.repeat(64);
    },
  ],
  [
    'zero recipient',
    (v) => {
      v.recipient = '0x' + '0'.repeat(40);
    },
  ],
])('rejects partial journal %s', (_name, change) => {
  const value = { ...journal(partialTransaction(createRailgunPartialCapsuleData())) };
  change(value);
  expect(valid(value)).toBe(false);
});
test.each([
  'kind',
  'version',
  'operation',
  'tree',
  'merkleRoot',
  'nullifier',
  'changeCommitment',
  'unshieldCommitment',
  'boundParamsHash',
  'recipient',
  'unshieldAmount',
  'intentDigest',
  'digest',
])('requires partial journal field %s', (key) => {
  const value = { ...journal(partialTransaction(createRailgunPartialCapsuleData())) };
  delete value[key];
  expect(valid(value)).toBe(false);
});
test.each([
  [
    'extra commitment',
    (f) => {
      f.inner.commitments.push(f.inner.commitments[0]);
    },
  ],
  [
    'missing change ciphertext',
    (f) => {
      f.inner.boundParams.commitmentCiphertext = [];
    },
  ],
  [
    'extra ciphertext',
    (f) => {
      f.inner.boundParams.commitmentCiphertext.push(f.inner.boundParams.commitmentCiphertext[0]);
    },
  ],
  [
    'transfer mode',
    (f) => {
      f.inner.boundParams.unshield = 0;
    },
  ],
  [
    'redirect mode',
    (f) => {
      f.inner.boundParams.unshield = 2;
    },
  ],
  [
    'extra nullifier',
    (f) => {
      f.inner.nullifiers.push(f.inner.nullifiers[0]);
    },
  ],
  [
    'zero recipient',
    (f) => {
      f.inner.unshieldPreimage.npk = '0x' + '0'.repeat(64);
    },
  ],
  [
    'non-WETH',
    (f) => {
      f.inner.unshieldPreimage.token.tokenAddress = pins.proxy;
    },
  ],
  [
    'zero amount',
    (f) => {
      f.inner.unshieldPreimage.value = 0;
    },
  ],
  [
    'over cap',
    (f) => {
      f.inner.unshieldPreimage.value = BigInt(pins.maxQualificationAmount) + 1n;
    },
  ],
])('refuses malformed partial calldata %s', (_name, change) => {
  const f = createRailgunPartialCapsuleData();
  change(f);
  expect(() => extract(partialTransaction(f))).toThrow('Railgun transact intent unavailable');
});
test.each([false, true])(
  'derives %s metadata and original intent from calldata only',
  async (unshield) => {
    const f = fixture(unshield),
      tx = f.transaction(),
      result = extract(tx);
    expect(result.intentDigest).toBe(
      validateRailgunPrivateSigningIntent(result.intent, result.expected).digest
    );
    expect(result.transaction).toEqual({
      chainId: tx.chainId,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    });
    expect(
      binding({ ...tx, holdId: 'forged', nullifier: 'forged', intentDigest: 'forged' })
    ).toEqual(binding(tx));
    const record = { kind: 'railgun-transact', digest: '0x' + '1'.repeat(64), ...binding(tx) };
    expect(valid(record)).toBe(true);
    expect(JSON.parse(JSON.stringify(record))).toStrictEqual(record);
    expect(binding(tx).operation).toBe(
      unshield ? 'railgun-token-unshield' : 'railgun-private-transfer'
    );
    expect(binding(tx).recipient).toBe(unshield ? f.recipient : undefined);
    const wallet = new Wallet('0x' + '11'.repeat(32));
    const signed = await wallet.signTransaction({
      ...tx,
      from: wallet.address,
      nonce: 0,
      gasLimit: 1000000,
      gasPrice: 1,
    });
    expect(binding(Transaction.from(signed))).toEqual(binding(tx));
    f.inner.proof.a.x = 12n;
    expect(f.transaction().data).not.toBe(tx.data);
    expect(binding(f.transaction())).toEqual(binding(tx));
    f.inner.merkleRoot = '0x' + '1'.repeat(64);
    expect(binding(f.transaction()).intentDigest).not.toBe(record.intentDigest);
  }
);
test.each([
  { chainId: 1 },
  { to: pins.implementation },
  { to: pins.relayAdapt },
  { value: '1' },
  { data: '0x' },
  { data: '0x' + 'ff'.repeat(4097) },
])('refuses unsupported transaction %j', (change) => {
  expect(() => binding({ ...fixture().transaction(), ...change })).toThrow(
    'Railgun transact intent unavailable'
  );
});
test.each([
  (f) => {
    f.inner.boundParams.adaptContract = pins.relayAdapt;
  },
  (f) => {
    f.inner.boundParams.unshield = 2n;
  },
  (f) => {
    f.inner.nullifiers.push(f.inner.nullifiers[0]);
  },
  (f) => {
    f.inner.commitments.push(f.inner.commitments[0]);
  },
  (f) => {
    f.inner.boundParams.minGasPrice = 1n;
  },
  (f) => {
    f.inner.boundParams.chainID = 1n;
  },
  (f) => {
    f.inner.boundParams.commitmentCiphertext = [];
  },
  (f) => {
    f.inner.unshieldPreimage.value = 1n;
  },
])('refuses unsupported routing or private transaction shape %#', (change) => {
  const f = fixture();
  change(f);
  expect(() => binding(f.transaction())).toThrow();
});
test('refuses noncanonical bytes and batched transactions', () => {
  const f = fixture(),
    tx = f.transaction();
  expect(() => binding({ ...tx, data: tx.data + '00'.repeat(32) })).toThrow();
  expect(() =>
    binding({ ...tx, data: abi.encodeFunctionData('transact', [[f.inner, f.inner]]) })
  ).toThrow();
});
test.each([
  'kind',
  'digest',
  'operation',
  'tree',
  'merkleRoot',
  'nullifier',
  'commitment',
  'boundParamsHash',
  'intentDigest',
  'recipient',
  'amount',
])('rejects malformed journal %s', (key) => {
  const value = {
    kind: 'railgun-transact',
    digest: '0x' + '1'.repeat(64),
    ...binding(fixture(true).transaction()),
  };
  expect(valid({ ...value, [key]: null })).toBe(false);
  const missing = { ...value };
  delete missing[key];
  expect(valid(missing)).toBe(false);
  expect(valid({ ...value, extra: true })).toBe(false);
});
