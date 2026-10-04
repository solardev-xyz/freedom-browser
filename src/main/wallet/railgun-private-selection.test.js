let mockWallet, mockOwners, mockBaseline;
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes(wallet, owners) {
    if (
      wallet !== mockWallet ||
      Object.keys(mockOwners).some((key) => owners[key] !== mockOwners[key])
    )
      throw Error('foreign owner');
    return mockBaseline;
  },
}));
jest.mock('./railgun-private-policy', () => ({
  ...jest.requireActual('./railgun-private-policy'),
  validateRailgunPrivateTransaction: jest.fn((tx, expected) =>
    Object.freeze({ ...tx, ...expected })
  ),
}));
const {
  openRailgunPrivateSelection,
  assertRailgunPrivateSelection,
} = require('./railgun-private-selection');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let controllers, expected;
beforeEach(() => {
  controllers = Array.from({ length: 3 }, () => new AbortController());
  mockWallet = { signal: controllers[0].signal };
  mockOwners = {
    identity: { signal: controllers[1].signal },
    enrollment: { signal: controllers[2].signal },
    coordinator: {},
  };
  mockBaseline = {
    checkpointHash: 'a'.repeat(64),
    read: {
      received: [
        {
          id: '0:1',
          tree: 0,
          position: 1,
          amount: 1000n,
          spentTxid: false,
          hash: hex(1),
          txid: hex(2),
          asset: { __type: 'erc20', contract: pins.wrappedNative },
        },
      ],
    },
    ownedPoi: [{ id: '0:1', hash: hex(1), txid: hex(2), nullifier: hex(3), type: 'Shield' }],
    trees: [{ tree: 0, root: hex(4).slice(2), length: 2 }],
  };
  expected = {
    kind: 'railgun-token-unshield',
    tree: 0,
    nullifier: hex(3),
    merkleRoot: hex(4),
    amount: '1000',
  };
});
const open = (options = {}) =>
  openRailgunPrivateSelection({ wallet: mockWallet, ...mockOwners, noteId: '0:1', ...options });
test('joins actual account selection to nullifier, tree, snapshot root and full unshield value', () => {
  const selection = open();
  const result = selection.prepare({}, expected);
  expect(assertRailgunPrivateSelection(selection, result.receipt, mockWallet, mockOwners)).toBe(
    result.observation
  );
  expect(result.observation).toMatchObject({
    ownedInputAtSnapshot: true,
    inputType: 'Shield',
    creatingTxidRequired: false,
    creatingTxidVerified: false,
    inputValueVerified: true,
    reservationsChecked: false,
    poiVerified: false,
    spendingEnabled: false,
    publicCheckpointHash: mockBaseline.checkpointHash,
  });
  expect(() => selection.assertResult({})).toThrow();
  expect(() =>
    assertRailgunPrivateSelection({ ...selection }, result.receipt, mockWallet, mockOwners)
  ).toThrow();
  expect(() =>
    assertRailgunPrivateSelection(selection, result.receipt, { ...mockWallet }, mockOwners)
  ).toThrow();
  for (const key of Object.keys(mockOwners))
    expect(() =>
      assertRailgunPrivateSelection(selection, result.receipt, mockWallet, {
        ...mockOwners,
        [key]: {},
      })
    ).toThrow();
  selection.close();
  expect(() => selection.assertResult(result.receipt)).toThrow();
});
test('private transfer selection does not claim output value or receiver verification', () => {
  const selection = open();
  const result = selection.prepare({}, { ...expected, kind: 'railgun-private-transfer' });
  expect(result.observation.inputValueVerified).toBe(false);
  expect(result.observation.spendingEnabled).toBe(false);
});
test('Transact inputs explicitly retain the creating-TXID verification gate', () => {
  mockBaseline.ownedPoi[0].type = 'Transact';
  const result = open().prepare({}, expected);
  expect(result.observation.creatingTxidRequired).toBe(true);
  expect(result.observation.creatingTxidVerified).toBe(false);
  mockBaseline.ownedPoi[0].type = 'unknown';
  expect(() => open()).toThrow();
});
test.each([
  ['nullifier', hex(8)],
  ['tree', 1],
  ['merkleRoot', hex(9)],
  ['amount', '999'],
])('refuses preparation for a different %s', (key, value) => {
  const selection = open();
  expect(() => selection.prepare({}, { ...expected, [key]: value })).toThrow();
});
test.each(['spent', 'zero', 'excess', 'token', 'missing', 'outside-tree', 'hash'])(
  'refuses %s input selection',
  (kind) => {
    const note = mockBaseline.read.received[0];
    if (kind === 'spent') note.spentTxid = hex(8);
    if (kind === 'zero') note.amount = 0n;
    if (kind === 'excess') note.amount = BigInt(pins.maxQualificationAmount) + 1n;
    if (kind === 'token') note.asset.contract = '0x' + '1'.repeat(40);
    if (kind === 'missing') mockBaseline.ownedPoi = [];
    if (kind === 'outside-tree') note.position = 2;
    if (kind === 'hash') mockBaseline.ownedPoi[0].hash = hex(9);
    expect(() => open()).toThrow();
  }
);
test.each([0, 1, 2])(
  'revocation of owner %i invalidates selection and all observations',
  (index) => {
    const selection = open(),
      result = selection.prepare({}, expected);
    controllers[index].abort();
    expect(selection.signal.aborted).toBe(true);
    expect(() => selection.assertResult(result.receipt)).toThrow();
    expect(() => selection.prepare({}, expected)).toThrow();
  }
);
test.each(['checkpoint', 'note', 'projection', 'tree'])(
  'a changed %s invalidates old input selection',
  (kind) => {
    const selection = open(),
      result = selection.prepare({}, expected);
    if (kind === 'checkpoint') mockBaseline.checkpointHash = 'b'.repeat(64);
    if (kind === 'note') mockBaseline.read.received = [{ ...mockBaseline.read.received[0] }];
    if (kind === 'projection') mockBaseline.ownedPoi = [{ ...mockBaseline.ownedPoi[0] }];
    if (kind === 'tree') mockBaseline.trees = [{ ...mockBaseline.trees[0] }];
    expect(() => selection.assertResult(result.receipt)).toThrow();
  }
);
test('forged account and mismatched enrollment cannot obtain ownership observations', () => {
  expect(() => open({ wallet: { ...mockWallet } })).toThrow();
  expect(() => open({ enrollment: { ...mockOwners.enrollment } })).toThrow();
});

test.each(['Shield', 'Transact'])(
  'partial selection for %s reports recovered V and expected C, never output conservation',
  (type) => {
    mockBaseline.ownedPoi[0].type = type;
    const selection = open();
    const result = selection.prepare(
      {},
      { ...expected, kind: 'railgun-partial-unshield', unshieldAmount: '400' }
    );
    expect(result.observation).toMatchObject({
      recoveredInputAmount: '1000',
      expectedChangeAmount: '600',
      inputValueVerified: false,
      outputConservationVerified: false,
      creatingTxidRequired: type === 'Transact',
      creatingTxidVerified: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(selection.assertResult(result.receipt)).toBe(result.observation);
    controllers[0].abort();
    expect(() => selection.assertResult(result.receipt)).toThrow();
  }
);
test.each(['0', '1000', '1001'])(
  'partial selection refuses withdrawal %s against actual recovered input',
  (unshieldAmount) => {
    expect(() =>
      open().prepare({}, { ...expected, kind: 'railgun-partial-unshield', unshieldAmount })
    ).toThrow();
  }
);
test('legacy selection observations retain their exact public shape', () => {
  const value = open().prepare({}, expected).observation;
  expect(Object.keys(value)).toEqual([
    'transaction',
    'publicCheckpointHash',
    'ownedInputAtSnapshot',
    'inputType',
    'creatingTxidRequired',
    'creatingTxidVerified',
    'inputValueVerified',
    'reservationsChecked',
    'poiVerified',
    'spendingEnabled',
  ]);
});

test('real partial calldata policy composes with captured selection without proving encrypted change', () => {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const f = createRailgunPartialCapsuleData();
  mockBaseline.ownedPoi[0].nullifier = f.capsule.preparation.expected.nullifier;
  mockBaseline.trees[0].root = f.capsule.preparation.expected.merkleRoot.slice(2);
  require('./railgun-private-policy').validateRailgunPrivateTransaction.mockImplementationOnce(
    jest.requireActual('./railgun-private-policy').validateRailgunPrivateTransaction
  );
  const value = open().prepare(
    f.capsule.preparation.transaction,
    f.capsule.preparation.expected
  ).observation;
  expect(value.recoveredInputAmount).toBe('1000');
  expect(value.expectedChangeAmount).toBe('600');
  expect(value.outputConservationVerified).toBe(false);
  expect(value.transaction.proofVerified).toBe(false);
  expect(value.transaction).not.toHaveProperty('inputAmount');
});
