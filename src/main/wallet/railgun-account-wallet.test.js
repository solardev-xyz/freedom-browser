let mockEnrollment, mockIdentity, mockSession, mockCoverage, mockJournal, mockRunner, mockView;
const mockOpenStore = jest.fn(),
  mockCreateJournal = jest.fn(),
  mockRead = jest.fn();
const mockAssertCoordinator = jest.fn();
jest.mock('./railgun-scan-coordinator', () => ({
  assertRailgunScanCoordinator: (...args) => mockAssertCoordinator(...args),
}));
jest.mock('./railgun-wallet-policy', () => ({ getRailgunWalletPolicy: () => '2'.repeat(64) }));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity) throw Error('identity');
    return v.descriptor;
  },
}));
jest.mock('./railgun-account-store', () => ({
  openRailgunAccountStore: (...args) => mockOpenStore(...args),
}));
jest.mock('./railgun-wallet-runner', () => ({ createRailgunAccountRunner: () => mockRunner }));
jest.mock('./railgun-wallet-coverage-store', () => ({
  createRailgunWalletCoverageStore: () => mockCoverage,
}));
jest.mock('./railgun-wallet-journal', () => ({
  createRailgunWalletJournal: (...args) => mockCreateJournal(...args),
}));
jest.mock('./railgun-kohaku-read', () => ({
  createRailgunKohakuRead: (...args) => mockRead(...args),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { openRailgunAccountWallet } = require('./railgun-account-wallet');
let scope, options, directory, generation, events, state;
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-wallet-')));
  generation = { id: '1'.repeat(64), policy: '2'.repeat(64), storeId: '3'.repeat(64), directory };
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  mockIdentity = { descriptor: { walletId: '4'.repeat(64), accountIndex: 0 } };
  mockEnrollment = {
    descriptor: mockIdentity.descriptor,
    binding: '5'.repeat(64),
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        ...(operation ? { operation } : {}),
      }),
    profileGuard: { assert: jest.fn() },
    withGenerationKeys: (_id, use) => use({ 'wallet-journal': Buffer.alloc(32, 5) }),
    catalog: {
      inspect: jest.fn(async () => ({ pending: null })),
      activeFor: jest.fn(() => generation),
      begin: jest.fn(async () => ({ ...generation, storeId: undefined })),
      resume: jest.fn(async () => ({ ...generation, storeId: undefined })),
      publish: jest.fn(async () => {
        events.push('publish');
      }),
    },
  };
  fs.writeFileSync(path.join(directory, 'wallet.sqlite'), 'existing');
  fs.writeFileSync(
    getPrivacyStoragePath(
      mockEnrollment.getContext('storage', 'railgun-wallet-v1:' + mockIdentity.descriptor.walletId),
      directory
    ),
    'existing'
  );
  const controller = new AbortController();
  let exited;
  mockSession = {
    signal: controller.signal,
    closed: new Promise((resolve) => {
      exited = resolve;
    }),
    close: jest.fn(() => {
      controller.abort();
      exited();
    }),
    inspectWalletState: jest.fn(async () => ({ state: true })),
  };
  mockOpenStore.mockImplementation(async () => ({
    session: mockSession,
    storeId: generation.storeId,
  }));
  mockCoverage = {
    signal: scope.signal,
    read: jest.fn(async () => {
      events.push('coverage-read');
      return {};
    }),
    write: jest.fn(async () => {
      events.push('coverage-write');
      return {};
    }),
    close: jest.fn(() => mockSession.close()),
  };
  state = { checkpoint: {}, pending: null };
  mockJournal = {
    signal: scope.signal,
    readState: jest.fn(async () => state),
    prepare: jest.fn(async () => {
      events.push('prepare');
      return {};
    }),
    revalidate: jest.fn(async () => {
      events.push('revalidate');
    }),
    complete: jest.fn(async () => {
      events.push('complete');
    }),
    close: jest.fn(),
  };
  mockCreateJournal.mockImplementation(async () => mockJournal);
  mockRunner = {
    assertScan: jest.fn(),
    run: jest.fn(async () => {
      events.push('scan');
      return { receipt: {}, coverage: {} };
    }),
  };
  mockView = {};
  mockRead.mockImplementation(() => {
    events.push('read');
    return mockView;
  });
  options = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture.asar',
    policy: generation.policy,
    coordinator: {
      signal: scope.signal,
      withPublicSnapshot: async (run) => ({ value: await run({ checkpoint: {} }), evidence: {} }),
      assertSnapshot: () => ({}),
    },
  };
});
afterEach(async () => {
  mockSession.close();
  await mockSession.closed;
  scope.close();
});
test('active restoration authenticates the expected store before journal construction and revalidation', async () => {
  const opened = await openRailgunAccountWallet(options);
  expect(mockOpenStore).toHaveBeenCalledWith(
    expect.objectContaining({ create: false, expectedStoreId: generation.storeId })
  );
  expect(mockCreateJournal).toHaveBeenCalledWith(
    expect.objectContaining({ create: false, profileGuard: mockEnrollment.profileGuard })
  );
  expect(events).toEqual(['scan', 'coverage-read', 'revalidate', 'read']);
  expect(mockRunner.run).toHaveBeenCalledWith(expect.objectContaining({ restore: true }));
  expect(opened.view).toBe(mockView);
  await opened.close();
  expect(mockJournal.close).toHaveBeenCalled();
  expect(opened.signal.aborted).toBe(true);
});
test.each(['advance', 'new', 'pending'])(
  '%s persists intent before scanning and completion before publishing reads',
  async (mode) => {
    state = { checkpoint: null, pending: {} };
    const opened = await openRailgunAccountWallet({ ...options, mode });
    expect(mockRunner.run).toHaveBeenCalledWith(expect.objectContaining({ restore: false }));
    expect(events).toEqual([
      'prepare',
      'scan',
      'coverage-write',
      'complete',
      ...(mode === 'advance' ? [] : ['publish']),
      'read',
    ]);
    await opened.close();
  }
);
test('completed unpublished candidate restores its journal before publishing', async () => {
  const opened = await openRailgunAccountWallet({ ...options, mode: 'pending' });
  expect(events).toEqual(['scan', 'coverage-read', 'revalidate', 'publish', 'read']);
  await opened.close();
});
test('a pending generation can initialize only missing unregistered stores/journals', async () => {
  const filename = path.join(directory, 'wallet.sqlite'),
    journalFile = getPrivacyStoragePath(
      mockEnrollment.getContext('storage', 'railgun-wallet-v1:' + mockIdentity.descriptor.walletId),
      directory
    );
  fs.renameSync(filename, filename + '.preserved');
  fs.renameSync(journalFile, journalFile + '.preserved');
  state = { checkpoint: null, pending: null };
  const opened = await openRailgunAccountWallet({ ...options, mode: 'pending' });
  expect(mockOpenStore).toHaveBeenCalledWith(expect.objectContaining({ create: true }));
  expect(mockCreateJournal).toHaveBeenCalledWith(expect.objectContaining({ create: true }));
  await opened.close();
});
test.each(['identity', 'enrollment', 'policy', 'pending-journal', 'store-id'])(
  '%s refusal returns no read capability',
  async (kind) => {
    if (kind === 'identity') options.identity = {};
    if (kind === 'enrollment') options.enrollment = { ...mockEnrollment };
    if (kind === 'policy') generation.policy = '8'.repeat(64);
    if (kind === 'pending-journal') state.pending = {};
    if (kind === 'store-id') mockOpenStore.mockRejectedValueOnce(Error('store id'));
    await expect(openRailgunAccountWallet(options)).rejects.toThrow();
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockRunner.run).not.toHaveBeenCalled();
  }
);
test('publication failure closes journal/worker without exposing a view', async () => {
  mockEnrollment.catalog.publish.mockRejectedValueOnce(Error('publication'));
  await expect(openRailgunAccountWallet({ ...options, mode: 'pending' })).rejects.toThrow(
    'publication'
  );
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockSession.signal.aborted).toBe(true);
});
test('new refuses an existing pending candidate without abandoning it', async () => {
  mockEnrollment.catalog.inspect.mockResolvedValueOnce({ pending: generation });
  await expect(openRailgunAccountWallet({ ...options, mode: 'new' })).rejects.toThrow();
  expect(mockEnrollment.catalog.begin).not.toHaveBeenCalled();
  expect(mockOpenStore).not.toHaveBeenCalled();
});
test('new can rebuild an obsolete-policy candidate instead of trapping the account after an update', async () => {
  mockEnrollment.catalog.inspect.mockResolvedValueOnce({
    pending: { ...generation, policy: 'f'.repeat(64) },
  });
  const opened = await openRailgunAccountWallet({ ...options, mode: 'new' });
  expect(mockEnrollment.catalog.begin).toHaveBeenCalledWith(options.policy);
  expect(mockEnrollment.catalog.publish).toHaveBeenCalled();
  await opened.close();
});
test('a foreign coordinator or stale caller policy refuses before opening a wallet', async () => {
  mockAssertCoordinator.mockImplementationOnce(() => {
    throw Error('foreign coordinator');
  });
  await expect(openRailgunAccountWallet(options)).rejects.toThrow('foreign coordinator');
  await expect(openRailgunAccountWallet({ ...options, policy: 'f'.repeat(64) })).rejects.toThrow();
  expect(mockOpenStore).not.toHaveBeenCalled();
});
test('coordinator revocation automatically closes the journal and frees the wallet worker', async () => {
  const controller = new AbortController();
  options.coordinator.signal = controller.signal;
  const opened = await openRailgunAccountWallet(options);
  controller.abort();
  await mockSession.closed;
  expect(opened.signal.aborted).toBe(true);
  expect(mockJournal.close).toHaveBeenCalled();
  expect(mockCoverage.close).toHaveBeenCalled();
});
test('snapshot revocation waits for the actual runner after closing the storage worker', async () => {
  let finish;
  mockRunner.run.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  options.coordinator.withPublicSnapshot = async (run) => {
    run({ checkpoint: {} });
    throw Error('snapshot revoked');
  };
  let settled = false;
  const pending = openRailgunAccountWallet(options).finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toThrow('snapshot revoked');
  while (!finish || !mockSession.signal.aborted) await Promise.resolve();
  expect(settled).toBe(false);
  finish({});
  await rejected;
  expect(mockRead).not.toHaveBeenCalled();
});
