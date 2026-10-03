let mockWallet, mockIdentity, mockEnrollment, mockCoordinator, mockSnapshot, mockObservation;
let mockSource, mockSourceArgs, mockStaleSource, mockStaleMembership;
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: (wallet, owners) => {
    if (
      wallet !== mockWallet ||
      owners.identity !== mockIdentity ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator ||
      mockWallet.signal.aborted
    )
      throw Error('wrong owner');
    return mockSnapshot;
  },
}));
jest.mock('./railgun-poi-source', () => ({
  createRailgunPoiSource: (options) => {
    mockSourceArgs = options;
    return mockSource;
  },
}));
const mockVerify = jest.fn();
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: (...args) => mockVerify(...args),
  assertRailgunPoiMembership: () => {
    if (mockStaleMembership) throw Error('stale membership');
  },
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  openRailgunAccountPoi: open,
  assertRailgunAccountPoi: attest,
} = require('./railgun-account-poi');
let scope, controller, args;
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  scope = createPrivacyScope({ profileId: 'owned-poi-test', signal: controller.signal });
  mockWallet = { signal: scope.signal };
  mockIdentity = { signal: scope.signal };
  mockCoordinator = {};
  mockEnrollment = {
    binding: 'a'.repeat(64),
    signal: scope.signal,
    getContext: (role) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
      }),
  };
  mockSnapshot = {
    checkpointHash: 'b'.repeat(64),
    ownedPoi: [
      { id: '0:1', blockNumber: 5944769, blindedCommitment: '0x' + '1'.repeat(64), type: 'Shield' },
    ],
    read: {
      received: [{ id: '0:1', amount: 5n, spentTxid: false }],
      readiness: { to: { number: 6000000, hash: '0x' + '2'.repeat(64) } },
    },
  };
  mockObservation = {
    statuses: [{ status: 'Valid' }],
    rootsAccepted: true,
    membershipVerified: false,
    spendingEnabled: false,
  };
  mockStaleSource = mockStaleMembership = false;
  mockSource = {
    acquire: jest.fn(async () => ({ receipt: {}, observation: mockObservation })),
    assertResult: jest.fn(() => {
      if (mockStaleSource) throw Error('stale source');
      return mockObservation;
    }),
    close: jest.fn(),
  };
  mockVerify.mockImplementation(async () => ({
    receipt: {},
    observation: { ...mockObservation, membershipVerified: true },
  }));
  args = {
    wallet: mockWallet,
    identity: mockIdentity,
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    archive: '/fixture.asar',
    noteIds: ['0:1'],
  };
});
afterEach(() => scope.close());
test('queries only selected owned commitments in a snapshot-bound private account context', async () => {
  mockSnapshot.ownedPoi.push({
    id: '0:2',
    blockNumber: 6000000,
    blindedCommitment: '0x' + '3'.repeat(64),
    type: 'Transact',
  });
  mockSnapshot.read.received.push({ id: '0:2', amount: 9n, spentTxid: false });
  const operation = open(args);
  expect(mockSourceArgs.notes).toEqual([
    { blindedCommitment: '0x' + '1'.repeat(64), type: 'Shield' },
  ]);
  const context = getPrivacyContext(mockSourceArgs.handle);
  expect(context.subject.role).toBe('poi');
  expect(context.subject.operation).toMatch(/^poi:[0-9a-f]{64}$/);
  const result = await operation.acquire();
  expect(attest(operation, result.receipt, mockWallet, args)).toMatchObject({
    ownershipAtSnapshot: true,
    membershipVerified: true,
    txidProvenanceVerified: false,
    reservationsChecked: false,
    spendingEnabled: false,
  });
  expect(mockVerify).toHaveBeenCalledTimes(1);
  operation.close();
  expect(() => operation.assertResult(result.receipt)).toThrow();
});
test.each([
  'prelaunch',
  'spent',
  'zero',
  'foreign',
  'duplicate',
  'empty',
  'too-many',
  'forged-wallet',
])('refuses %s before any POI query', (mode) => {
  if (mode === 'prelaunch') mockSnapshot.ownedPoi[0].blockNumber = 5944699;
  if (mode === 'spent') mockSnapshot.read.received[0].spentTxid = '0x' + '4'.repeat(64);
  if (mode === 'zero') mockSnapshot.read.received[0].amount = 0n;
  if (mode === 'foreign') args.noteIds = ['0:2'];
  if (mode === 'duplicate') args.noteIds = ['0:1', '0:1'];
  if (mode === 'empty') args.noteIds = [];
  if (mode === 'too-many') args.noteIds = ['0:1', '0:2', '0:3', '0:4'];
  if (mode === 'forged-wallet') args.wallet = { ...mockWallet };
  expect(() => open(args)).toThrow();
  expect(mockSource.acquire).not.toHaveBeenCalled();
});
test.each(['Missing', 'ShieldBlocked', 'ProofSubmitted'])(
  'retains %s as an observation without granting membership',
  async (status) => {
    mockObservation.statuses = [{ status }];
    const operation = open(args),
      result = await operation.acquire();
    expect(result.observation.membershipVerified).toBe(false);
    expect(result.observation.spendingEnabled).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
    operation.close();
  }
);
test.each(['snapshot', 'note-replaced', 'wallet-closed', 'source', 'membership'])(
  'revokes a receipt after %s changes',
  async (mode) => {
    const operation = open(args),
      result = await operation.acquire();
    if (mode === 'snapshot') mockSnapshot = { ...mockSnapshot, checkpointHash: 'c'.repeat(64) };
    if (mode === 'note-replaced')
      mockSnapshot = { ...mockSnapshot, ownedPoi: [{ ...mockSnapshot.ownedPoi[0] }] };
    if (mode === 'wallet-closed') controller.abort();
    if (mode === 'source') mockStaleSource = true;
    if (mode === 'membership') mockStaleMembership = true;
    expect(() => operation.assertResult(result.receipt)).toThrow();
    operation.close();
  }
);
test('a later acquire invalidates the old receipt and forged receipts or owners cannot attest', async () => {
  const operation = open(args),
    first = await operation.acquire(),
    second = await operation.acquire();
  expect(() => operation.assertResult(first.receipt)).toThrow();
  expect(() => operation.assertResult({})).toThrow();
  expect(() => attest({ ...operation }, second.receipt, mockWallet, args)).toThrow();
  expect(() => attest(operation, second.receipt, {}, args)).toThrow();
  expect(() =>
    attest(operation, second.receipt, mockWallet, { ...args, coordinator: {} })
  ).toThrow();
  expect(operation.assertResult(second.receipt)).toBe(second.observation);
  operation.close();
});
test('ownership changes during acquisition cancel the result', async () => {
  const operation = open(args);
  mockSource.acquire.mockImplementation(async () => {
    mockSnapshot = { ...mockSnapshot, checkpointHash: 'c'.repeat(64) };
    return { receipt: {}, observation: mockObservation };
  });
  await expect(operation.acquire()).rejects.toThrow();
  expect(mockSource.close).toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});
