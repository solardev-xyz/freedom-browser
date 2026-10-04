let mockWallet, mockIdentity, mockEnrollment, mockCoordinator, mockSnapshot, mockObservation;
let mockSource, mockSourceArgs, mockStaleSource, mockStaleMembership;
let mockWindow, mockWindowData, mockBusy, mockWindowController;
let mockSourceExit, mockHoldSource, mockSourceController, mockContextThrow;
const mockScopes = [],
  mockFactory = jest.fn();
jest.mock('../networks/privacy-context', () => {
  const actual = jest.requireActual('../networks/privacy-context');
  return {
    ...actual,
    createPrivacyScope: (...args) => {
      const scope = actual.createPrivacyScope(...args);
      mockScopes.push(scope);
      return mockContextThrow
        ? {
            ...scope,
            getContext: () => {
              throw Error('PRIVATE context');
            },
          }
        : scope;
    },
  };
});
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
    return mockFactory(options);
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
  mockScopes.length = 0;
  mockContextThrow = false;
  mockHoldSource = false;
  mockFactory.mockReset();
  mockFactory.mockImplementation(() => mockSource);
  mockSourceController = new AbortController();
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
        hash: '0x' + '5'.repeat(64),
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
  const sourceClosed = new Promise((resolve) => {
    mockSourceExit = resolve;
  });
  mockSource = {
    signal: mockSourceController.signal,
    closed: sourceClosed,
    acquire: jest.fn(async () => ({ receipt: {}, observation: mockObservation })),
    assertResult: jest.fn(() => {
      if (mockStaleSource) throw Error('stale source');
      return mockObservation;
    }),
    close: jest.fn(() => {
      mockSourceController.abort();
      if (!mockHoldSource) mockSourceExit();
    }),
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
afterEach(() => {
  mockSourceExit();
  scope.close();
  jest.useRealTimers();
});
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
  expect(JSON.parse(JSON.stringify(result.observation))).toStrictEqual(result.observation);
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

const accountTurn = () => new Promise((resolve) => setImmediate(resolve));
const accountGate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const openKind = (kind) =>
  kind === 'window' ? openWindow({ ...args, window: mockWindow }) : open(args);
test.each(['account', 'window'])(
  'healthy %s retries keep one closed promise pending until terminal close',
  async (kind) => {
    mockHoldSource = true;
    const operation = openKind(kind),
      closed = operation.closed;
    let drained = false;
    closed.then(() => {
      drained = true;
    });
    mockObservation.statuses = [{ status: 'Missing' }];
    const first = await operation.acquire();
    if (kind === 'window') expect(first.status).toBe('refused');
    else expect(first.observation.membershipVerified).toBe(false);
    expect(operation.signal.aborted).toBe(false);
    expect(mockVerify).not.toHaveBeenCalled();
    mockObservation.statuses = [{ status: 'Valid' }];
    const second = await operation.acquire();
    expect(operation.assertResult(second.receipt).membershipVerified).toBe(true);
    await accountTurn();
    expect(drained).toBe(false);
    expect(operation.closed).toBe(closed);
    operation.close();
    operation.close();
    expect(operation.signal.aborted).toBe(true);
    await accountTurn();
    expect(drained).toBe(false);
    mockSourceExit();
    await closed;
    expect(drained).toBe(true);
  }
);
test.each(
  ['account', 'window'].flatMap((kind) =>
    ['work-first', 'source-first'].map((order) => [kind, order])
  )
)('%s closure waits verifier and source in %s order', async (kind, order) => {
  mockHoldSource = true;
  const entered = accountGate(),
    work = accountGate();
  mockVerify.mockImplementation(async () => {
    entered.resolve();
    await work.promise;
    return { receipt: {}, observation: { ...mockObservation, membershipVerified: true } };
  });
  const operation = openKind(kind);
  let settled = false,
    drained = false;
  operation.closed.then(() => {
    drained = true;
  });
  const pending = operation.acquire().then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      return { error };
    }
  );
  await entered.promise;
  operation.close();
  try {
    expect(operation.signal.aborted).toBe(true);
    if (order === 'work-first') work.resolve();
    else mockSourceExit();
    await accountTurn();
    expect(settled).toBe(false);
    expect(drained).toBe(false);
    if (order === 'work-first') mockSourceExit();
    else work.resolve();
    expect((await pending).error).toBeDefined();
    await operation.closed;
    expect(drained).toBe(true);
  } finally {
    work.resolve();
    mockSourceExit();
    await pending;
  }
});
test.each(['throw', 'falsy', 'reentrant'])(
  'admitted source %s failure waits drain without acquire/closed self-wait',
  async (failure) => {
    mockHoldSource = true;
    const operation = open(args);
    mockSource.acquire.mockImplementation(() => {
      if (failure === 'reentrant') operation.close();
      if (failure === 'falsy') throw undefined;
      throw Error('PRIVATE acquisition');
    });
    let settled = false;
    const pending = operation.acquire().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error) => {
        settled = true;
        return { refused: true, error };
      }
    );
    try {
      await accountTurn();
      expect(operation.signal.aborted).toBe(true);
      expect(settled).toBe(false);
      mockSourceExit();
      expect((await pending).refused).toBe(true);
      await operation.closed;
    } finally {
      mockSourceExit();
      await pending;
    }
  }
);
test('overlapping acquire refusal leaves healthy admitted work intact', async () => {
  const entered = accountGate(),
    release = accountGate();
  mockSource.acquire.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { receipt: {}, observation: mockObservation };
  });
  const operation = open(args),
    pending = operation.acquire();
  await entered.promise;
  try {
    await expect(operation.acquire()).rejects.toThrow();
    expect(operation.signal.aborted).toBe(false);
    expect(mockSource.close).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect((await pending).observation.membershipVerified).toBe(true);
  operation.close();
  await operation.closed;
});
test.each(['wallet', 'window', 'source'])(
  'idle %s revocation retains terminal wait until source drains',
  async (which) => {
    mockHoldSource = true;
    const operation = openWindow({ ...args, window: mockWindow });
    let drained = false;
    operation.closed.then(() => {
      drained = true;
    });
    if (which === 'wallet') controller.abort();
    if (which === 'window') mockWindowController.abort();
    if (which === 'source') mockSourceController.abort();
    expect(operation.signal.aborted).toBe(true);
    await accountTurn();
    expect(drained).toBe(false);
    mockSourceExit();
    await operation.closed;
    expect(mockSource.acquire).not.toHaveBeenCalled();
  }
);
test.each(['context', 'factory', 'missing-barrier', 'aborted-factory'])(
  '%s construction failure revokes its scope and cleans any returned source',
  async (fault) => {
    const count = mockScopes.length;
    if (fault === 'context') mockContextThrow = true;
    if (fault === 'factory')
      mockFactory.mockImplementationOnce(() => {
        throw Error('PRIVATE factory');
      });
    if (fault === 'missing-barrier') delete mockSource.closed;
    if (fault === 'aborted-factory')
      mockFactory.mockImplementationOnce(() => {
        mockWindowController.abort();
        return mockSource;
      });
    expect(() => openWindow({ ...args, window: mockWindow })).toThrow();
    expect(mockScopes.length).toBe(count + 1);
    expect(mockScopes.at(-1).signal.aborted).toBe(true);
    if (['missing-barrier', 'aborted-factory'].includes(fault))
      expect(mockSource.close).toHaveBeenCalled();
    expect(mockSource.acquire).not.toHaveBeenCalled();
    mockSourceExit();
    await accountTurn();
  }
);
test('rejecting source barrier revokes admission without resolving account closure', async () => {
  mockSource.closed = Promise.reject(Error('PRIVATE invalid source contract'));
  const operation = open(args);
  let drained = false;
  operation.closed.then(() => {
    drained = true;
  });
  await accountTurn();
  expect(operation.signal.aborted).toBe(true);
  expect(drained).toBe(false);
  expect(mockSource.close).toHaveBeenCalled();
  operation.close();
  await accountTurn();
  expect(drained).toBe(false);
});
test('throwing source close cannot skip scope revocation or its actual barrier', async () => {
  mockHoldSource = true;
  mockSource.close.mockImplementation(() => {
    throw Error('PRIVATE source close');
  });
  const operation = open(args);
  let drained = false;
  operation.closed.then(() => {
    drained = true;
  });
  expect(() => operation.close()).not.toThrow();
  expect(operation.signal.aborted).toBe(true);
  await accountTurn();
  expect(drained).toBe(false);
  mockSourceExit();
  await operation.closed;
});
