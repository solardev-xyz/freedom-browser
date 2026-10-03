let mockWallet, mockIdentity, mockEnrollment, mockCoordinator, mockSnapshot, mockObservation;
let mockSource, mockSourceArgs, mockStaleSource, mockStaleMembership;
let mockWindow, mockWindowData, mockBusy, mockWindowController;
jest.mock('./railgun-account-wallet', () => ({
  readRailgunAccountOwnedNotes: (wallet, owners) => {
    if (
      wallet !== mockWallet ||
      owners.identity !== mockIdentity ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator ||
      mockWallet.signal.aborted ||
      mockBusy
    )
      throw Error('wrong owner');
    return mockSnapshot;
  },
  assertRailgunAccountPrivateWindow: (window, wallet, owners, margin = 0) => {
    if (
      window !== mockWindow ||
      wallet !== mockWallet ||
      owners.identity !== mockIdentity ||
      owners.enrollment !== mockEnrollment ||
      owners.coordinator !== mockCoordinator ||
      mockWindowData.signal.aborted ||
      performance.now() + margin >= mockWindowData.deadline
    )
      throw Error('window refused');
    return mockWindowData;
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
  openRailgunPrivateWindowPoi: openWindow,
  assertRailgunPrivateWindowPoi: attestWindow,
} = require('./railgun-account-poi');
let scope, controller, args;
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  scope = createPrivacyScope({ profileId: 'owned-poi-test', signal: controller.signal });
  mockWallet = { signal: scope.signal };
  mockIdentity = { signal: scope.signal };
  mockCoordinator = {};
  mockBusy = false;
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
      {
        id: '0:1',
        blockNumber: 5944769,
        blindedCommitment: '0x' + '1'.repeat(64),
        type: 'Shield',
        nullifier: '0x' + '9'.repeat(64),
      },
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
  mockWindow = Object.freeze({});
  mockWindowController = new AbortController();
  Object.assign(mockSnapshot.read.received[0], { tree: 0, position: 1 });
  mockSnapshot.ownedPoi[0].hash = '0x' + '3'.repeat(64);
  mockWindowData = Object.freeze({
    owned: mockSnapshot,
    selection: { tree: 0, position: 1 },
    signal: mockWindowController.signal,
    deadline: performance.now() + 175000,
  });
});
afterEach(() => scope.close());
test('a caller cannot mutate the diagnostic selected list to skip later ownership checks', async () => {
  const operation = open(args),
    result = await operation.acquire();
  args.noteIds.length = 0;
  mockSnapshot = { ...mockSnapshot, ownedPoi: [{ ...mockSnapshot.ownedPoi[0] }] };
  expect(() => operation.assertResult(result.receipt)).toThrow();
  operation.close();
});
test('window POI uses the captured input while ordinary owned reads are busy and keeps distinct receipt brands', async () => {
  const diagnostic = open(args),
    diagnosticResult = await diagnostic.acquire();
  mockBusy = true;
  const operation = openWindow({ ...args, window: mockWindow, noteIds: ['0:999'] });
  const result = await operation.acquire();
  expect(attestWindow(operation, result.receipt, mockWallet, args, mockWindow, 1000)).toMatchObject(
    {
      membershipVerified: true,
      spendingEnabled: false,
      txidProvenanceVerified: false,
      input: {
        id: '0:1',
        tree: 0,
        position: 1,
        type: 'Shield',
        checkpointHash: mockSnapshot.checkpointHash,
        nullifier: mockSnapshot.ownedPoi[0].nullifier,
        blindedCommitment: mockSnapshot.ownedPoi[0].blindedCommitment,
      },
    }
  );
  expect(mockSourceArgs.notes).toEqual([
    { blindedCommitment: mockSnapshot.ownedPoi[0].blindedCommitment, type: 'Shield' },
  ]);
  expect(() => attest(operation, result.receipt, mockWallet, args)).toThrow();
  expect(() =>
    attestWindow(diagnostic, diagnosticResult.receipt, mockWallet, args, mockWindow)
  ).toThrow();
  expect(() => attestWindow(operation, result.receipt, mockWallet, args, {})).toThrow();
  expect(() => attestWindow(operation, {}, mockWallet, args, mockWindow)).toThrow();
  expect(() => attestWindow(operation, result.receipt, {}, args, mockWindow)).toThrow();
  expect(mockSource.assertResult).toHaveBeenCalledWith(expect.any(Object), 1000);
  expect(mockVerify.mock.calls.at(-1)[0].timeoutMs).toBeGreaterThan(0);
  expect(mockVerify.mock.calls.at(-1)[0].timeoutMs).toBeLessThanOrEqual(45000);
  mockWindowController.abort();
  expect(() => operation.assertResult(result.receipt)).toThrow();
  operation.close();
  diagnostic.close();
});
test('separate window attempts receive separate POI circuit scopes even for the same selected input', () => {
  const first = openWindow({ ...args, window: mockWindow });
  const a = getPrivacyContext(mockSourceArgs.handle);
  const second = openWindow({ ...args, window: mockWindow });
  const b = getPrivacyContext(mockSourceArgs.handle);
  expect(a.subject.operation).not.toBe(b.subject.operation);
  expect(a.isolationToken).not.toBe(b.isolationToken);
  first.close();
  second.close();
});
test('negative root acceptance is an advisory refusal without a membership worker', async () => {
  mockObservation.rootsAccepted = false;
  const operation = openWindow({ ...args, window: mockWindow });
  const result = await operation.acquire();
  expect(result.observation.membershipVerified).toBe(false);
  expect(result.status).toBe('refused');
  expect(result.receipt).toBeUndefined();
  expect(() => attestWindow(operation, result.receipt, mockWallet, args, mockWindow)).toThrow();
  expect(mockVerify).not.toHaveBeenCalled();
  operation.close();
});
test.each(['Missing', 'ShieldBlocked', 'ProofSubmitted'])(
  'non-qualifying window status %s returns no receipt',
  async (status) => {
    mockObservation.statuses = [{ status }];
    const operation = openWindow({ ...args, window: mockWindow });
    const result = await operation.acquire();
    expect(result.status).toBe('refused');
    expect(result.receipt).toBeUndefined();
    expect(mockVerify).not.toHaveBeenCalled();
    operation.close();
  }
);
test('controller budget bounds a stuck window status request and source request options', async () => {
  jest.useFakeTimers();
  try {
    const operation = openWindow({ ...args, window: mockWindow });
    mockSource.acquire.mockImplementation(({ timeoutMs }) => {
      expect(timeoutMs).toBe(1200);
      const signal = getPrivacyContext(mockSourceArgs.handle).signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('transport aborted')), { once: true });
      });
    });
    const refused = expect(operation.acquire({ timeoutMs: 1200 })).rejects.toThrow(
      'transport aborted'
    );
    await jest.advanceTimersByTimeAsync(1200);
    await refused;
    expect(operation.signal.aborted).toBe(true);
    expect(mockVerify).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
test('window acquisition deadline aborts membership but waits for its observed drain', async () => {
  jest.useFakeTimers();
  let release;
  try {
    const operation = openWindow({ ...args, window: mockWindow });
    mockVerify.mockImplementation(async ({ handle }) => {
      const signal = getPrivacyContext(handle).signal;
      await new Promise((resolve) => {
        release = resolve;
      });
      expect(signal.aborted).toBe(true);
      throw Error('membership aborted and drained');
    });
    let settled = false;
    const pending = operation
      .acquire()
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await jest.advanceTimersByTimeAsync(0);
    expect(release).toBeDefined();
    await jest.advanceTimersByTimeAsync(45000);
    expect(operation.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(settled).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
test.each(['owner', 'window', 'position', 'spent', 'prelaunch'])(
  'window input %s refuses before source construction',
  (mode) => {
    const input = { ...args, window: mockWindow };
    if (mode === 'owner') input.identity = {};
    if (mode === 'window') input.window = {};
    if (mode === 'position') mockWindowData.selection.position = 999;
    if (mode === 'spent') mockSnapshot.read.received[0].spentTxid = 'spent';
    if (mode === 'prelaunch') mockSnapshot.ownedPoi[0].blockNumber = 0;
    mockSourceArgs = undefined;
    expect(() => openWindow(input)).toThrow();
    expect(mockSourceArgs).toBeUndefined();
  }
);
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
