let mockEnrollment, mockIdentity, mockSession, mockCoverage, mockJournal, mockRunner, mockView;
let mockCheckpointHash = (value) => JSON.stringify(value);
const mockCompletedStore = jest.fn();
const mockQuarantine = jest.fn();
const mockOpenStore = jest.fn(),
  mockCreateJournal = jest.fn(),
  mockRead = jest.fn();
const mockAssertCoordinator = jest.fn();
const mockCompletedOutcome = jest.fn();
const mockAssertPublic = jest.fn();
const mockDestination = Object.freeze({});
const mockAssertDestination = jest.fn();
const mockReadOnlyJournal = jest.fn();
const mockRelayPoiLifetime = jest.fn();
jest.mock('./railgun-account-poi', () => ({
  getRailgunRelayPoiLifetime: (...args) => mockRelayPoiLifetime(...args),
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (...args) => mockAssertPublic(...args),
  assertRailgunAccountPublicDestination: (...args) => mockAssertDestination(...args),
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'a'.repeat(64) }));
jest.mock('./railgun-scan-coordinator', () => ({
  assertRailgunScanCoordinator: (...args) => mockAssertCoordinator(...args),
  getRailgunCompletedSnapshotOutcome: (...args) => mockCompletedOutcome(...args),
}));
jest.mock('./railgun-wallet-policy', () => ({ getRailgunWalletPolicy: () => '2'.repeat(64) }));
jest.mock('./railgun-wallet-coverage', () => ({
  checkpointHash: (value) => mockCheckpointHash(value),
}));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-identity', () => ({
  quarantineRailgunIdentityCredentials: (...args) => mockQuarantine(...args),
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity) throw Error('identity');
    return v.descriptor;
  },
}));
jest.mock('./railgun-account-store', () => ({
  openRailgunAccountStore: (...args) => mockOpenStore(...args),
  openRailgunCompletedAccountStore: (...args) => mockCompletedStore(...args),
}));
jest.mock('./railgun-wallet-runner', () => ({ createRailgunAccountRunner: () => mockRunner }));
jest.mock('./railgun-wallet-coverage-store', () => ({
  createRailgunWalletCoverageStore: () => mockCoverage,
  createRailgunCompletedWalletCoverageStore: () => mockCoverage,
}));
jest.mock('./railgun-wallet-journal', () => ({
  createRailgunWalletJournal: (...args) => mockCreateJournal(...args),
  openRailgunWalletJournalReadOnly: (...args) => mockReadOnlyJournal(...args),
}));
jest.mock('./railgun-kohaku-read', () => ({
  createRailgunKohakuRead: (...args) => mockRead(...args),
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  openRailgunAccountWallet,
  openRailgunCompletedAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  readRailgunCompletedAccountPrivateInput,
  restoreRailgunAccountWallet,
  recoverRailgunAccountPrivateProof,
  prepareRailgunAccountPrivateIntent,
  operateRailgunAccountPrivateIntent,
  assertRailgunAccountPrivateWindow,
} = require('./railgun-account-wallet');
let scope, options, directory, generation, events, state;
beforeEach(() => {
  mockCheckpointHash = (value) => JSON.stringify(value);
  jest.clearAllMocks();
  mockRelayPoiLifetime.mockImplementation(() => {
    throw Error('unregistered POI source');
  });
  mockCompletedOutcome.mockImplementation(() => {
    throw Error('unknown outcome');
  });
  mockAssertPublic.mockImplementation(() => ({
    generationId: 'a'.repeat(64),
    sourceId: 'b'.repeat(64),
    publicId: 'c'.repeat(64),
  }));
  events = [];
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-wallet-')));
  generation = { id: '1'.repeat(64), policy: '2'.repeat(64), storeId: '3'.repeat(64), directory };
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  mockIdentity = { descriptor: { walletId: '4'.repeat(64), accountIndex: 0 } };
  mockEnrollment = {
    directory,
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
      inspectRetention: jest.fn(async () => ({ listed: 2 })),
      retireInactive: jest.fn(async () => {
        events.push('retire');
        return [];
      }),
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
      exited({ exitCode: 0 });
    }),
    inspectWalletState: jest.fn(async () => ({ state: true })),
    assertFresh: jest.fn(),
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
    readOwned: jest.fn(() => Object.freeze({ ownedPoi: [], checkpointHash: '6'.repeat(64) })),
    assertScan: jest.fn(),
    run: jest.fn(async () => {
      events.push('scan');
      return { receipt: {}, coverage: {} };
    }),
    restoreReadOnly: jest.fn(async () => {
      events.push('read-only-restore');
      return { receipt: {}, coverage: {}, readOnly: { readOnly: true, writeAttempts: 0 } };
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
      withPublicSnapshot: async (run) => ({
        value: await run({ checkpoint: {}, signal: scope.signal }),
        evidence: {},
      }),
      assertSnapshot: () => ({}),
    },
  };
  generation.policy = options.policy = getRailgunAccountWalletPolicy(options);
});
afterEach(async () => {
  mockSession.close();
  await mockSession.closed;
  scope.close();
  jest.restoreAllMocks();
});
test('a TXID phase refuses wallet opening before a generation or worker changes', async () => {
  const phase = claimRailgunAccountPhase(mockEnrollment, 'txid');
  try {
    await expect(openRailgunAccountWallet({ ...options, mode: 'new' })).rejects.toThrow();
    expect(mockOpenStore).not.toHaveBeenCalled();
    expect(mockEnrollment.catalog.begin).not.toHaveBeenCalled();
  } finally {
    phase.release();
  }
});
test('an open wallet view holds its phase until its storage worker has exited', async () => {
  const value = await openRailgunAccountWallet(options);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  let finish;
  mockSession.closed = new Promise((resolve) => {
    finish = resolve;
  });
  const closing = value.close();
  await Promise.resolve();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  finish({ exitCode: 0 });
  await closing;
  const phase = claimRailgunAccountPhase(mockEnrollment, 'txid');
  phase.release();
});
test('foreign or obsolete enrolled public authority refuses before opening any wallet store', async () => {
  mockAssertPublic.mockImplementationOnce(() => {
    throw Error('public binding');
  });
  await expect(openRailgunAccountWallet(options)).rejects.toThrow('public binding');
  expect(mockOpenStore).not.toHaveBeenCalled();
});
test('new generation retires only when the listed-generation slots are full', async () => {
  mockEnrollment.catalog.inspectRetention.mockResolvedValue({ listed: 8 });
  const result = await openRailgunAccountWallet({ ...options, mode: 'new' });
  expect(mockEnrollment.catalog.retireInactive).toHaveBeenCalledTimes(1);
  expect(events.indexOf('retire')).toBeLessThan(events.indexOf('prepare'));
  await result.close();
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

test('account restoration swaps its view and owned receipt only after journal revalidation', async () => {
  const opened = await openRailgunAccountWallet(options),
    originalView = opened.view;
  const originalReceipt = mockRead.mock.calls[0][0].receipt;
  mockRead.mockImplementation(() => {
    events.push('new-view');
    return { restored: true };
  });
  events.length = 0;
  const restoredView = await restoreRailgunAccountWallet(opened, options);
  expect(events).toEqual(['read-only-restore', 'coverage-read', 'revalidate', 'new-view']);
  expect(opened.view).toBe(restoredView);
  expect(opened.view).not.toBe(originalView);
  readRailgunAccountOwnedNotes(opened, options);
  const renewedReceipt = mockRunner.readOwned.mock.calls.at(-1)[0];
  expect(renewedReceipt).not.toBe(originalReceipt);
  expect(mockRead.mock.calls.at(-1)[0].receipt).toBe(renewedReceipt);
  expect(mockJournal.revalidate.mock.calls.at(-1)[0].receipt).toBe(renewedReceipt);
  expect(mockCoverage.write).not.toHaveBeenCalled();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  await opened.close();
});
function preparationFixture() {
  const owned = {
    checkpointHash: '6'.repeat(64),
    read: {
      instanceId: 'self',
      received: [
        {
          id: '0:1',
          tree: 0,
          position: 1,
          amount: 1000n,
          spentTxid: false,
          asset: { __type: 'erc20', contract: require('./railgun-shield-pins.json').wrappedNative },
        },
      ],
    },
    ownedPoi: [{ id: '0:1', hash: '0x' + '3'.repeat(64), nullifier: '0x' + '1'.repeat(64) }],
    trees: [{ tree: 0, root: '0x' + '2'.repeat(64), length: 2 }],
  };
  mockRunner.readOwned.mockImplementation(() => owned);
  mockRunner.prepareReadOnly = jest.fn(async () => ({
    receipt: {},
    coverage: {},
    readOnly: { readOnly: true, writeAttempts: 0 },
    preparation: { spendingEnabled: false, witnessRetained: false },
  }));
  return { owned, request: { kind: 'railgun-private-transfer', noteId: '0:1', recipient: 'self' } };
}
test('preparation re-attests, compares captured values and swaps to a diagnostic result', async () => {
  const { request } = preparationFixture(),
    opened = await openRailgunAccountWallet(options),
    old = opened.view;
  mockRead.mockImplementation(() => ({}));
  const result = await prepareRailgunAccountPrivateIntent(opened, options, request);
  expect(result.view).toBe(opened.view);
  expect(result.view).not.toBe(old);
  expect(result.preparation).toMatchObject({ spendingEnabled: false, witnessRetained: false });
  expect(mockRunner.prepareReadOnly).toHaveBeenCalledWith(
    expect.objectContaining({
      privateIntent: {
        kind: request.kind,
        tree: 0,
        position: 1,
        recipient: 'self',
      },
    })
  );
  expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
  await opened.close();
});
function operationFixture() {
  const value = preparationFixture();
  jest
    .spyOn(require('./railgun-private-capsule'), 'normalizeRailgunNewCapsule')
    .mockImplementation((_capsule, owned) => {
      expect(owned.noteHash).toBe(value.owned.ownedPoi[0].hash);
      return { capsule: true };
    });
  jest
    .spyOn(require('./railgun-private-preparation'), 'normalizeRailgunPrivatePreparation')
    .mockImplementation((raw, captured) => {
      expect(raw).toEqual({ intent: 'public' });
      expect(captured.read).toBe(value.owned.read);
      return { transactionDigest: 'digest' };
    });
  mockRunner.operateReadOnly = jest.fn(async ({ privateOperation }) => {
    const reply = await privateOperation.onIntent(
      { intent: 'public', transactionDigest: 'digest' },
      mockSession.signal
    );
    return {
      receipt: {},
      coverage: {},
      readOnly: { readOnly: true, writeAttempts: 0 },
      preparation: { spendingEnabled: false },
      operation: { status: reply.status },
    };
  });
  return value;
}
test('private windows bind exact owners and captured data, expire after the run and preserve refusal as a result', async () => {
  jest.spyOn(performance, 'now').mockReturnValue(141048.33140849692);
  const { owned, request } = operationFixture();
  const opened = await openRailgunAccountWallet(options);
  let token;
  const operation = {
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    onIntent: async (offer, signal, window) => {
      token = window;
      const data = assertRailgunAccountPrivateWindow(window, opened, options, 1000);
      expect(data.owned).toBe(owned);
      expect(data.selection.position).toBe(1);
      expect(data.deadline - data.started).toBeCloseTo(175000, 6);
      expect(signal.aborted).toBe(false);
      expect(offer.transactionDigest).toBe('digest');
      expect(() => assertRailgunAccountPrivateWindow({ ...window }, opened, options)).toThrow();
      for (const key of ['identity', 'enrollment', 'coordinator'])
        expect(() =>
          assertRailgunAccountPrivateWindow(window, opened, { ...options, [key]: {} })
        ).toThrow();
      expect(() => assertRailgunAccountPrivateWindow(window, {}, options)).toThrow();
      expect(() => assertRailgunAccountPrivateWindow(window, opened, options, 175000)).toThrow();
      expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
      return { status: 'refused' };
    },
  };
  const result = await operateRailgunAccountPrivateIntent(opened, options, request, operation);
  expect(result.operation).toEqual({ status: 'refused' });
  expect(opened.signal.aborted).toBe(false);
  expect(() => readRailgunAccountOwnedNotes(opened, options)).not.toThrow();
  expect(() => assertRailgunAccountPrivateWindow(token, opened, options)).toThrow();
  await opened.close();
});
test.each(['clock', 'abort'])(
  'private window %s invalidation refuses a late authorizer reply',
  async (mode) => {
    const { request } = operationFixture();
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const opened = await openRailgunAccountWallet(options);
    const operation = {
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
      onIntent: async () => {
        if (mode === 'clock') now += 175000;
        else mockSession.close();
        return { status: 'refused' };
      },
    };
    await expect(
      operateRailgunAccountPrivateIntent(opened, options, request, operation)
    ).rejects.toThrow();
    expect(opened.signal.aborted).toBe(true);
  }
);
test('the genuine token refuses immediately when A dies while the authorizer drains', async () => {
  const { request } = operationFixture();
  const opened = await openRailgunAccountWallet(options);
  const job = new AbortController();
  let release, entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  mockRunner.operateReadOnly.mockImplementation(async ({ privateOperation }) => {
    await privateOperation.onIntent({ intent: 'public', transactionDigest: 'digest' }, job.signal);
    throw Error('A exited');
  });
  let token,
    settled = false;
  const run = operateRailgunAccountPrivateIntent(opened, options, request, {
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    async onIntent(_offer, signal, window) {
      token = window;
      expect(assertRailgunAccountPrivateWindow(window, opened, options).signal).toBe(signal);
      entered();
      await pending;
      return { status: 'refused' };
    },
  })
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await started;
  job.abort();
  expect(() => assertRailgunAccountPrivateWindow(token, opened, options)).toThrow();
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  release();
  expect(await run).toBeInstanceOf(Error);
  expect(settled).toBe(true);
});
test('operation rejects substituted offers before the trusted authorizer runs', async () => {
  const { request } = operationFixture();
  const opened = await openRailgunAccountWallet(options);
  const onIntent = jest.fn();
  mockRunner.operateReadOnly.mockImplementation(async ({ privateOperation }) =>
    privateOperation.onIntent({ intent: 'other', transactionDigest: 'digest' }, mockSession.signal)
  );
  await expect(
    operateRailgunAccountPrivateIntent(opened, options, request, {
      onIntent,
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    })
  ).rejects.toThrow();
  expect(onIntent).not.toHaveBeenCalled();
});
test('unsupported preparation refuses before a window and preserves the current account', async () => {
  const { request } = preparationFixture(),
    opened = await openRailgunAccountWallet(options),
    old = opened.view;
  await expect(
    prepareRailgunAccountPrivateIntent(opened, options, { ...request, recipient: 'foreign' })
  ).rejects.toThrow();
  expect(mockRunner.prepareReadOnly).not.toHaveBeenCalled();
  expect(opened.signal.aborted).toBe(false);
  expect(opened.view).toBe(old);
  expect(() => readRailgunAccountOwnedNotes(opened, options)).not.toThrow();
  expect(() => prepareRailgunAccountPrivateIntent(opened, options)).toThrow();
  await opened.close();
});
test.each(['checkpointHash', 'ownedPoi', 'trees', 'read'])(
  'changed restored %s refuses preparation without swapping',
  async (field) => {
    const { request, owned } = preparationFixture(),
      opened = await openRailgunAccountWallet(options),
      old = opened.view;
    const changed = structuredClone(owned);
    if (field === 'read') changed.read.received[0].amount++;
    else if (field === 'checkpointHash') changed.checkpointHash = '7'.repeat(64);
    else changed[field] = [];
    mockRunner.readOwned.mockImplementationOnce(() => owned).mockImplementation(() => changed);
    await expect(prepareRailgunAccountPrivateIntent(opened, options, request)).rejects.toThrow();
    expect(opened.view).toBe(old);
    expect(opened.signal.aborted).toBe(true);
  }
);
test.each(['identity', 'enrollment', 'coordinator'])(
  'foreign %s cannot restore an account',
  async (owner) => {
    const opened = await openRailgunAccountWallet(options);
    expect(() => restoreRailgunAccountWallet(opened, { ...options, [owner]: {} })).toThrow();
    expect(() => restoreRailgunAccountWallet({}, options)).toThrow();
    expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
    await opened.close();
  }
);
test('a changed checkpoint refuses before the read-only job and closes the account', async () => {
  const opened = await openRailgunAccountWallet(options);
  options.coordinator.withPublicSnapshot = async (run) => ({
    value: await run({ checkpoint: { changed: true } }),
    evidence: {},
  });
  await expect(restoreRailgunAccountWallet(opened, options)).rejects.toThrow();
  expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
  expect(opened.signal.aborted).toBe(true);
});
test('coordinator contention before entering the window leaves the current account usable', async () => {
  const opened = await openRailgunAccountWallet(options),
    original = opened.view;
  options.coordinator.withPublicSnapshot = async () => {
    throw Error('busy');
  };
  await expect(restoreRailgunAccountWallet(opened, options)).rejects.toThrow();
  expect(opened.view).toBe(original);
  expect(opened.signal.aborted).toBe(false);
  expect(() => readRailgunAccountOwnedNotes(opened, options)).not.toThrow();
  expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
  expect(mockCoverage.close).not.toHaveBeenCalled();
  await opened.close();
});
test.each(['job', 'coverage', 'journal', 'view'])(
  'failed %s cannot expose a partial replacement',
  async (stage) => {
    const opened = await openRailgunAccountWallet(options),
      original = opened.view;
    const refuse = () => {
      throw Error('refused');
    };
    if (stage === 'job') mockRunner.restoreReadOnly.mockImplementationOnce(refuse);
    if (stage === 'coverage') mockCoverage.read.mockImplementationOnce(refuse);
    if (stage === 'journal') mockJournal.revalidate.mockImplementationOnce(refuse);
    if (stage === 'view') mockRead.mockImplementationOnce(refuse);
    await expect(restoreRailgunAccountWallet(opened, options)).rejects.toThrow();
    expect(opened.view).toBe(original);
    expect(opened.signal.aborted).toBe(true);
    expect(() => readRailgunAccountOwnedNotes(opened, options)).toThrow();
  }
);
test('busy restoration excludes other reads/restores and close drains it before releasing the phase', async () => {
  const opened = await openRailgunAccountWallet(options);
  let finish;
  mockRunner.restoreReadOnly.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const restoring = restoreRailgunAccountWallet(opened, options);
  const refused = expect(restoring).rejects.toThrow();
  await Promise.resolve();
  expect(() => readRailgunAccountOwnedNotes(opened, options)).toThrow();
  await expect(restoreRailgunAccountWallet(opened, options)).rejects.toThrow();
  const closing = opened.close();
  await Promise.resolve();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  finish({ receipt: {}, coverage: {} });
  await refused;
  await closing;
  const phase = claimRailgunAccountPhase(mockEnrollment, 'txid');
  phase.release();
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

test('public generation cutover changes wallet policy and permits replacing the stranded pending candidate', async () => {
  const oldPolicy = options.policy;
  mockEnrollment.catalog.inspect.mockResolvedValue({ pending: { ...generation } });
  mockAssertPublic.mockImplementation(() => ({
    generationId: 'd'.repeat(64),
    sourceId: 'e'.repeat(64),
    publicId: 'f'.repeat(64),
  }));
  const nextPolicy = getRailgunAccountWalletPolicy(options);
  expect(nextPolicy).not.toBe(oldPolicy);
  await expect(
    openRailgunAccountWallet({ ...options, policy: undefined, mode: 'pending' })
  ).rejects.toThrow();
  expect(mockOpenStore).not.toHaveBeenCalled();
  generation.policy = options.policy = nextPolicy;
  const opened = await openRailgunAccountWallet({ ...options, mode: 'new' });
  expect(mockEnrollment.catalog.begin).toHaveBeenCalledWith(nextPolicy);
  await opened.close();
});
test.each(['generationId', 'sourceId', 'publicId'])(
  'wallet policy binds authenticated public %s',
  (field) => {
    mockAssertPublic.mockImplementation(() => ({
      generationId: 'a'.repeat(64),
      sourceId: 'b'.repeat(64),
      publicId: 'c'.repeat(64),
      [field]: 'f'.repeat(64),
    }));
    expect(getRailgunAccountWalletPolicy(options)).not.toBe(options.policy);
  }
);

test('owned-note reads require the genuine opened wallet and exact account/coordinator owners', async () => {
  const wallet = await openRailgunAccountWallet(options);
  const owners = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    coordinator: options.coordinator,
  };
  expect(readRailgunAccountOwnedNotes(wallet, owners).ownedPoi).toEqual([]);
  expect(mockRunner.readOwned).toHaveBeenCalled();
  expect(() => readRailgunAccountOwnedNotes({ ...wallet }, owners)).toThrow();
  for (const key of ['identity', 'enrollment', 'coordinator'])
    expect(() => readRailgunAccountOwnedNotes(wallet, { ...owners, [key]: {} })).toThrow();
  await wallet.close();
  expect(() => readRailgunAccountOwnedNotes(wallet, owners)).toThrow();
});
test('owned-note reads recheck public generation and runner journal freshness', async () => {
  const wallet = await openRailgunAccountWallet(options);
  const owners = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    coordinator: options.coordinator,
  };
  mockAssertPublic.mockImplementationOnce(() => {
    throw Error('generation changed');
  });
  expect(() => readRailgunAccountOwnedNotes(wallet, owners)).toThrow('generation changed');
  mockRunner.readOwned.mockImplementationOnce(() => {
    throw Error('checkpoint changed');
  });
  expect(() => readRailgunAccountOwnedNotes(wallet, owners)).toThrow('checkpoint changed');
  await wallet.close();
});

test('account capsule mismatch never reaches the authorizer and drains the operation', async () => {
  const { request } = operationFixture(),
    opened = await openRailgunAccountWallet(options),
    onIntent = jest.fn();
  require('./railgun-private-capsule').normalizeRailgunNewCapsule.mockImplementationOnce(() => {
    throw Error('capsule mismatch');
  });
  await expect(
    operateRailgunAccountPrivateIntent(opened, options, request, {
      onIntent,
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    })
  ).rejects.toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  expect(onIntent).not.toHaveBeenCalled();
  expect(mockSession.signal.aborted).toBe(true);
});

test('real account normalizers refuse a capsule with a different owned note hash after broker validation', async () => {
  const { owned } = preparationFixture();
  const capsule = require('../../../scripts/fixtures/railgun-capsule-data').capsule(
    mockEnrollment.descriptor.walletId
  );
  capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
  owned.ownedPoi[0].hash = capsule.noteHash;
  owned.ownedPoi[0].nullifier = capsule.preparation.expected.nullifier;
  owned.trees[0].root = capsule.preparation.expected.merkleRoot;
  const offer = require('./railgun-private-preparation').normalizeRailgunPrivateOffer(
    capsule.preparation,
    capsule.selection
  );
  capsule.noteHash = '0x' + '0'.repeat(63) + '9';
  const checked = require('./railgun-private-capsule').normalizeRailgunNewCapsule(capsule, {
    walletId: mockEnrollment.descriptor.walletId,
    selection: capsule.selection,
    preparation: offer,
  });
  mockRunner.operateReadOnly = jest.fn(async ({ privateOperation }) =>
    privateOperation.onIntent(offer, mockSession.signal, checked)
  );
  const opened = await openRailgunAccountWallet(options),
    onIntent = jest.fn();
  await expect(
    operateRailgunAccountPrivateIntent(
      opened,
      options,
      { kind: capsule.selection.kind, noteId: '0:1', recipient: capsule.selection.recipient },
      { onIntent, proverArchive: '/prover.asar', artifactDirectory: '/artifacts' }
    )
  ).rejects.toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  expect(onIntent).not.toHaveBeenCalled();
  expect(mockSession.signal.aborted).toBe(true);
});

function creatorFixture() {
  const f = operationFixture();
  Object.assign(f.owned.ownedPoi[0], {
    type: 'Transact',
    txid: '0x' + '4'.repeat(64),
    blockNumber: 10,
  });
  Object.assign(f.owned.read.received[0], {
    hash: f.owned.ownedPoi[0].hash,
    txid: f.owned.ownedPoi[0].txid,
  });
  const visit = jest.fn(async (visitor) => {
    await visitor({ marker: 'captured' });
    return { count: 1, bytes: 1 };
  });
  options.coordinator.withPublicSnapshot = async (run) => ({
    value: await run({ checkpoint: {}, signal: scope.signal, visitSource: visit }),
    evidence: {},
  });
  const observation = Object.freeze({
    checkpointHash: '{}',
    events: Object.freeze([]),
    spendingEnabled: false,
  });
  const collect = jest
    .spyOn(require('./railgun-private-creator'), 'collectRailgunPrivateCreator')
    .mockImplementation(async (input) => {
      input.assertCurrent();
      expect(input.note).toEqual({
        type: 'Transact',
        txid: f.owned.ownedPoi[0].txid,
        hash: f.owned.ownedPoi[0].hash,
        tree: 0,
        position: 1,
        blockNumber: 10,
      });
      expect(input.visit).toBe(visit);
      await input.visit(() => {});
      input.assertCurrent();
      return observation;
    });
  return { ...f, collect, visit, observation };
}
test('creator capture uses the retained snapshot once and issues only window-bound source evidence', async () => {
  const {
    readRailgunAccountPrivateCreator: capture,
    assertRailgunAccountPrivateCreator: attest,
  } = require('./railgun-account-wallet');
  const f = creatorFixture(),
    opened = await openRailgunAccountWallet(options);
  let token, receipt;
  await operateRailgunAccountPrivateIntent(opened, options, f.request, {
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    onIntent: async (_offer, _signal, window) => {
      token = window;
      const pending = capture(window, opened, options);
      expect(() => capture(window, opened, options)).toThrow();
      const value = await pending;
      receipt = value.receipt;
      expect(value.observation).toEqual({
        ...f.observation,
        transactionDigest: 'digest',
        eventSourceAuthenticated: true,
      });
      expect(attest(receipt, window, opened, options)).toBe(value.observation);
      expect(() => attest({ ...receipt }, window, opened, options)).toThrow();
      expect(() => attest(receipt, {}, opened, options)).toThrow();
      expect(() => attest(receipt, window, {}, options)).toThrow();
      for (const key of ['identity', 'enrollment', 'coordinator'])
        expect(() => attest(receipt, window, opened, { ...options, [key]: {} })).toThrow();
      expect(() => attest(receipt, window, opened, options, 175000)).toThrow();
      return { status: 'refused' };
    },
  });
  expect(f.visit).toHaveBeenCalledTimes(1);
  expect(f.collect).toHaveBeenCalledTimes(1);
  expect(() => attest(receipt, token, opened, options)).toThrow();
  expect(() => capture(token, opened, options)).toThrow();
  await opened.close();
});
test.each(['shield', 'spent', 'hash', 'transaction', 'duplicate'])(
  'creator capture refuses %s selected ownership before visiting',
  async (mode) => {
    const { readRailgunAccountPrivateCreator: capture } = require('./railgun-account-wallet');
    const f = creatorFixture(),
      opened = await openRailgunAccountWallet(options);
    await operateRailgunAccountPrivateIntent(opened, options, f.request, {
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
      onIntent: async (_offer, _signal, window) => {
        if (mode === 'shield') f.owned.ownedPoi[0].type = 'Shield';
        if (mode === 'spent') f.owned.read.received[0].spentTxid = '0x' + '5'.repeat(64);
        if (mode === 'hash') f.owned.read.received[0].hash = '0x' + '5'.repeat(64);
        if (mode === 'transaction') f.owned.read.received[0].txid = '0x' + '5'.repeat(64);
        if (mode === 'duplicate') f.owned.read.received.push({ ...f.owned.read.received[0] });
        expect(() => capture(window, opened, options)).toThrow();
        return { status: 'refused' };
      },
    });
    expect(f.visit).not.toHaveBeenCalled();
    expect(f.collect).not.toHaveBeenCalled();
    await opened.close();
  }
);
test('a handler cannot release the phase or leak rejection from an unobserved creator capture', async () => {
  const { readRailgunAccountPrivateCreator: capture } = require('./railgun-account-wallet');
  const f = creatorFixture(),
    opened = await openRailgunAccountWallet(options);
  let release,
    entered,
    token,
    settled = false;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  f.collect.mockImplementation(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return f.observation;
  });
  const pending = operateRailgunAccountPrivateIntent(opened, options, f.request, {
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    onIntent: async (_offer, _signal, window) => {
      token = window;
      void capture(window, opened, options);
      entered();
      return { status: 'refused' };
    },
  });
  const done = pending.then((v) => {
    settled = true;
    return v;
  });
  await ready;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(() => assertRailgunAccountPrivateWindow(token, opened, options)).toThrow();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  release();
  expect((await done).operation.status).toBe('refused');
  await new Promise((resolve) => setImmediate(resolve));
  await opened.close();
});

test('only the genuine current account can reserve a handoff that survives its closure', async () => {
  const { reserveRailgunAccountWalletHandoff: reserve } = require('./railgun-account-wallet');
  const opened = await openRailgunAccountWallet(options);
  expect(() => reserve({ ...opened }, options)).toThrow();
  for (const key of ['identity', 'enrollment', 'coordinator'])
    expect(() => reserve(opened, { ...options, [key]: {} })).toThrow();
  const handoff = reserve(opened, options);
  expect(() => reserve(opened, options)).toThrow();
  await opened.close();
  expect(() => reserve(opened, options)).toThrow();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'txid', handoff.token);
  phase.release();
  handoff.release();
});
test.each(['new', 'pending', 'advance'])('handoff cannot open wallet in %s mode', async (mode) => {
  await expect(openRailgunAccountWallet({ ...options, mode, handoff: {} })).rejects.toThrow();
  expect(mockOpenStore).not.toHaveBeenCalled();
  expect(mockEnrollment.catalog.begin).not.toHaveBeenCalled();
});

test('failed replacement wallet drains before phase release and cannot release the staging reservation', async () => {
  const original = claimRailgunAccountPhase(mockEnrollment, 'wallet'),
    handoff = original.reserveHandoff();
  original.release();
  let entered,
    finish,
    settled = false;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  mockSession.closed = new Promise((resolve) => {
    finish = resolve;
  });
  mockJournal.revalidate.mockImplementation(async () => {
    entered();
    throw Error('restoration refused');
  });
  const opening = openRailgunAccountWallet({ ...options, handoff: handoff.token });
  const observed = opening.catch((error) => {
    settled = true;
    return error;
  });
  try {
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid', handoff.token)).toThrow();
    finish({ exitCode: 0 });
    expect(await observed).toBeInstanceOf(Error);
    handoff.assertCurrent();
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
    const next = claimRailgunAccountPhase(mockEnrollment, 'wallet', handoff.token);
    next.release();
  } finally {
    finish({ exitCode: 0 });
    await observed;
    handoff.release();
  }
});

test.each(['prepare', 'operate'])(
  'partial %s captures real normalized selection and preserves the wallet window',
  async (route) => {
    const f =
      require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData();
    f.capsule.walletId = mockEnrollment.descriptor.walletId;
    f.capsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
    const owned = { ...f.owned, checkpointHash: '6'.repeat(64) };
    owned.ownedPoi[0].hash = f.capsule.noteHash;
    mockRunner.readOwned.mockReturnValue(owned);
    mockRead.mockImplementation(() => ({}));
    const offer = require('./railgun-private-preparation').normalizeRailgunPrivateOffer(
      f.capsule.preparation,
      f.capsule.selection
    );
    const result = {
      receipt: {},
      coverage: {},
      readOnly: { readOnly: true, writeAttempts: 0 },
      preparation: { ...offer, spendingEnabled: false, witnessRetained: false },
    };
    mockRunner.prepareReadOnly = jest.fn(async () => result);
    mockRunner.operateReadOnly = jest.fn(async ({ privateOperation }) => {
      const reply = await privateOperation.onIntent(offer, mockSession.signal, f.capsule);
      return { ...result, operation: { status: reply.status } };
    });
    const opened = await openRailgunAccountWallet(options);
    const onIntent = jest.fn(async (value, signal, window, capsule) => {
      expect(value).toMatchObject(offer);
      expect(capsule.version).toBe(2);
      expect(capsule.selection).toEqual(f.capsule.selection);
      expect(assertRailgunAccountPrivateWindow(window, opened, options).selection).toEqual(
        f.capsule.selection
      );
      expect(signal.aborted).toBe(false);
      return { status: 'refused' };
    });
    try {
      const outcome =
        route === 'prepare'
          ? await prepareRailgunAccountPrivateIntent(opened, options, f.request)
          : await operateRailgunAccountPrivateIntent(opened, options, f.request, {
              onIntent,
              proverArchive: '/prover.asar',
              artifactDirectory: '/artifacts',
            });
      expect(outcome.preparation).toEqual({
        ...offer,
        spendingEnabled: false,
        witnessRetained: false,
      });
      const runner = route === 'prepare' ? mockRunner.prepareReadOnly : mockRunner.operateReadOnly;
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({ privateIntent: f.capsule.selection })
      );
      expect(onIntent).toHaveBeenCalledTimes(route === 'prepare' ? 0 : 1);
      expect(opened.signal.aborted).toBe(false);
    } finally {
      await opened.close();
    }
  }
);

function completedOptions() {
  mockCompletedStore.mockImplementation(async () => ({
    session: mockSession,
    storeId: generation.storeId,
  }));
  state.checkpoint = {
    target: { hash: '{}', plan: {} },
    coverage: {},
    wallet: { state: true },
  };
  mockCoverage.read.mockImplementation(async () => {
    events.push('coverage-read');
    return { checkpoint: {}, summary: {}, coverage: {} };
  });
  mockEnrollment.profileGuard.assertRegistered = jest.fn();
  mockReadOnlyJournal.mockImplementation(async () => mockJournal);
  mockAssertDestination.mockImplementation((coordinator, enrollment, destination) => {
    if (
      coordinator !== options.coordinator ||
      enrollment !== mockEnrollment ||
      destination !== mockDestination
    )
      throw Error('destination');
  });
  options.coordinator.withCompletedPublicSnapshot = jest.fn(async (input, run) => {
    expect(input.destination).toBe(mockDestination);
    expect(input.signal.aborted).toBe(false);
    return { value: await run({ checkpoint: {}, signal: input.signal }), evidence: {} };
  });
  options.coordinator.withPublicSnapshot = jest.fn(() => {
    throw Error('ordinary route');
  });
  return { ...options, destination: mockDestination };
}
function completedDeferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function completedUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('fixture did not enter');
}

test('completed-only open and repeated restore keep fixed read-only route and account registry', async () => {
  const input = completedOptions();
  const wallet = await openRailgunCompletedAccountWallet(input);
  try {
    expect(wallet.view).toBe(mockView);
    expect(wallet.generationId).toBe(generation.id);
    expect(readRailgunAccountOwnedNotes(wallet, options).ownedPoi).toEqual([]);
    await restoreRailgunAccountWallet(wallet, options);
    expect(mockRunner.restoreReadOnly).toHaveBeenCalledTimes(2);
    expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(2);
    expect(mockCompletedStore).toHaveBeenCalledWith({
      enrollment: mockEnrollment,
      generationId: generation.id,
      expectedStoreId: generation.storeId,
      signal: expect.any(AbortSignal),
    });
    expect(mockOpenStore).not.toHaveBeenCalled();
    expect(mockReadOnlyJournal).toHaveBeenCalledTimes(1);
    expect(mockReadOnlyJournal.mock.calls[0][0]).not.toHaveProperty('create');
    expect(mockCreateJournal).not.toHaveBeenCalled();
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(mockJournal.prepare).not.toHaveBeenCalled();
    expect(mockJournal.complete).not.toHaveBeenCalled();
    expect(mockCoverage.write).not.toHaveBeenCalled();
    expect(mockEnrollment.catalog.begin).not.toHaveBeenCalled();
    expect(mockEnrollment.catalog.publish).not.toHaveBeenCalled();
    expect(options.coordinator.withPublicSnapshot).not.toHaveBeenCalled();
  } finally {
    await wallet.close();
  }
});

test.each(['prepare', 'operate', 'handoff'])(
  'completed-only account refuses ordinary %s before any additional work',
  async (kind) => {
    const input = completedOptions();
    const wallet = await openRailgunCompletedAccountWallet(input);
    try {
      const work = () =>
        kind === 'prepare'
          ? prepareRailgunAccountPrivateIntent(wallet, options, {})
          : kind === 'operate'
            ? operateRailgunAccountPrivateIntent(wallet, options, {}, {})
            : require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(
                wallet,
                options
              );
      await expect(Promise.resolve().then(work)).rejects.toThrow();
      expect(mockRunner.restoreReadOnly).toHaveBeenCalledTimes(1);
      expect(wallet.signal.aborted).toBe(false);
    } finally {
      await wallet.close();
    }
  }
);

test.each([
  'mode',
  'handoff',
  'callback',
  'job',
  'create',
  'timeout-zero',
  'timeout-large',
  'signal',
  'destination',
])('completed-only %s admission refuses before store work', async (kind) => {
  const input = completedOptions();
  if (kind === 'timeout-zero') input.timeoutMs = 0;
  else if (kind === 'timeout-large') input.timeoutMs = 180001;
  else if (kind === 'signal') input.signal = null;
  else input[kind] = {};
  await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
  expect(mockCompletedStore).not.toHaveBeenCalled();
  expect(mockReadOnlyJournal).not.toHaveBeenCalled();
});

test.each(['pending', 'missing', 'checkpoint-mismatch', 'unregistered', 'policy'])(
  'completed-only %s refuses without restoration or repair',
  async (kind) => {
    const input = completedOptions();
    if (kind === 'pending') state.pending = {};
    if (kind === 'missing') state.checkpoint = null;
    if (kind === 'checkpoint-mismatch') state.checkpoint.target.hash = 'different';
    if (kind === 'unregistered')
      mockEnrollment.profileGuard.assertRegistered.mockImplementation(() => {
        throw Error('inventory');
      });
    if (kind === 'policy') generation.policy = 'f'.repeat(64);
    await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
    expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
    expect(mockJournal.prepare).not.toHaveBeenCalled();
    expect(options.coordinator.signal.aborted).toBe(false);
    expect(options.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
  }
);

test.each(['missing-coverage', 'checkpoint', 'summary', 'wallet', 'stale-wallet'])(
  'completed persisted %s mismatch refuses before source or viewing work',
  async (kind) => {
    const input = completedOptions();
    if (kind === 'missing-coverage') mockCoverage.read.mockResolvedValueOnce(null);
    if (kind === 'checkpoint') state.checkpoint.target.plan = { changed: true };
    if (kind === 'summary') state.checkpoint.coverage = { changed: true };
    if (kind === 'wallet') state.checkpoint.wallet = { state: false };
    if (kind === 'stale-wallet')
      mockSession.assertFresh.mockImplementationOnce(() => {
        throw Error('stale wallet state');
      });
    await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
    expect(options.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
    expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(mockOpenStore).not.toHaveBeenCalled();
    expect(mockCoverage.write).not.toHaveBeenCalled();
    expect(mockJournal.prepare).not.toHaveBeenCalled();
    expect(options.coordinator.signal.aborted).toBe(false);
  }
);

test('late wallet restoration rejection is data inside completed snapshot, not a shared coordinator exception', async () => {
  const input = completedOptions();
  mockRunner.restoreReadOnly.mockRejectedValueOnce(Error('wallet failure'));
  await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
  expect(await options.coordinator.withCompletedPublicSnapshot.mock.results[0].value).toEqual({
    value: null,
    evidence: {},
  });
  expect(options.coordinator.signal.aborted).toBe(false);
});

test.each(['store', 'journal', 'runner', 'revalidate'])(
  'cancellation during held %s retains genuine phase until borrowed work and child drain',
  async (kind) => {
    const input = completedOptions();
    const caller = new AbortController();
    input.signal = caller.signal;
    const gate = completedDeferred(),
      exited = completedDeferred();
    mockSession.closed = exited.promise;
    let entered = false;
    const hold = async (value) => {
      entered = true;
      await gate.promise;
      return value;
    };
    if (kind === 'store')
      mockCompletedStore.mockImplementationOnce(() => hold({ session: mockSession }));
    if (kind === 'journal')
      mockEnrollment.withGenerationKeys = async (_id, use) => {
        const value = await use({ 'wallet-journal': Buffer.alloc(32) });
        return hold(value);
      };
    if (kind === 'runner')
      mockRunner.restoreReadOnly.mockImplementationOnce(() => hold({ receipt: {}, coverage: {} }));
    if (kind === 'revalidate') mockJournal.revalidate.mockImplementationOnce(() => hold());
    let settled = false;
    const pending = openRailgunCompletedAccountWallet(input).catch((error) => {
      settled = true;
      return error;
    });
    await completedUntil(() => entered);
    caller.abort();
    exited.resolve({ exitCode: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
    gate.resolve();
    expect(await pending).toBeInstanceOf(Error);
    const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    phase.release();
    expect(options.coordinator.signal.aborted).toBe(false);
  }
);

test('completed account close drains a repeated restore even after worker exit, including reentrant close', async () => {
  const wallet = await openRailgunCompletedAccountWallet(completedOptions());
  const gate = completedDeferred();
  let entered = false;
  mockRunner.restoreReadOnly.mockImplementationOnce(async () => {
    entered = true;
    await gate.promise;
    return { receipt: {} };
  });
  const restoring = restoreRailgunAccountWallet(wallet, options).catch((error) => error);
  await completedUntil(() => entered);
  mockSession.close.mockImplementationOnce(() => {
    void wallet.close();
  });
  let closed = false;
  const closing = wallet.close().then(() => {
    closed = true;
  });
  await mockSession.closed;
  expect(closed).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  gate.resolve();
  expect(await restoring).toBeInstanceOf(Error);
  await closing;
});

test('completed lifetime checks monotonic expiry without timer delivery and current generation/destination', async () => {
  const clock = jest.spyOn(performance, 'now').mockReturnValue(100);
  const wallet = await openRailgunCompletedAccountWallet({
    ...completedOptions(),
    timeoutMs: 1000,
  });
  try {
    clock.mockReturnValue(1100);
    expect(() => readRailgunAccountOwnedNotes(wallet, options)).toThrow();
    clock.mockReturnValue(101);
    mockAssertDestination.mockImplementationOnce(() => {
      throw Error('revoked destination');
    });
    expect(() => readRailgunAccountOwnedNotes(wallet, options)).toThrow();
    generation = { ...generation, id: 'f'.repeat(64) };
    expect(() => readRailgunAccountOwnedNotes(wallet, options)).toThrow();
  } finally {
    await wallet.close();
  }
});

test('pre-aborted completed open has zero inventory/storage/source work and leaves phase free', async () => {
  const input = completedOptions();
  const caller = new AbortController();
  caller.abort();
  await expect(
    openRailgunCompletedAccountWallet({ ...input, signal: caller.signal })
  ).rejects.toThrow();
  expect(mockEnrollment.profileGuard.assertRegistered).not.toHaveBeenCalled();
  expect(mockCompletedStore).not.toHaveBeenCalled();
  expect(options.coordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  phase.release();
});

test('unregistered journal refuses before wallet worker initialization', async () => {
  const input = completedOptions();
  mockEnrollment.profileGuard.assertRegistered.mockImplementation((file) => {
    if (file.endsWith('.json')) throw Error('not registered');
  });
  await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
  expect(mockCompletedStore).not.toHaveBeenCalled();
  expect(mockReadOnlyJournal).not.toHaveBeenCalled();
});

test('completed source pending refusal never invokes wallet worker restoration or ordinary repair', async () => {
  const input = completedOptions();
  options.coordinator.withCompletedPublicSnapshot.mockRejectedValueOnce(Error('pending'));
  await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow(
    'Railgun wallet requires recovery'
  );
  expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
  expect(mockRunner.run).not.toHaveBeenCalled();
  expect(options.coordinator.withPublicSnapshot).not.toHaveBeenCalled();
  expect(options.coordinator.signal.aborted).toBe(false);
});

test('throwing journal close cannot skip worker close or release phase before actual exit', async () => {
  const wallet = await openRailgunCompletedAccountWallet(completedOptions());
  const exited = completedDeferred();
  mockSession.closed = exited.promise;
  mockJournal.close.mockImplementation(() => {
    throw Error('close fault');
  });
  let settled = false;
  const closing = wallet.close().catch((error) => {
    settled = true;
    return error;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(mockSession.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  exited.resolve({ exitCode: 0 });
  expect(await closing).toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  phase.release();
});

test('final revalidation cancellation cannot publish a late view and drains the borrowed callback', async () => {
  const input = completedOptions();
  const caller = new AbortController();
  const gate = completedDeferred();
  let entered = false;
  mockJournal.revalidate.mockImplementationOnce(async () => {
    entered = true;
    await gate.promise;
  });
  const opening = openRailgunCompletedAccountWallet({ ...input, signal: caller.signal });
  const refused = expect(opening).rejects.toThrow();
  await completedUntil(() => entered);
  caller.abort();
  await mockSession.closed;
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  expect(mockRead).not.toHaveBeenCalled();
  gate.resolve();
  await refused;
  expect(mockRead).not.toHaveBeenCalled();
});

test('completed restore overlapping caller neither issues a second source read nor closes first operation', async () => {
  const wallet = await openRailgunCompletedAccountWallet(completedOptions());
  const gate = completedDeferred();
  let entered = false;
  mockRunner.restoreReadOnly.mockImplementationOnce(async () => {
    entered = true;
    await gate.promise;
    return { receipt: {}, coverage: {} };
  });
  const first = restoreRailgunAccountWallet(wallet, options);
  await completedUntil(() => entered);
  await expect(restoreRailgunAccountWallet(wallet, options)).rejects.toThrow();
  expect(wallet.signal.aborted).toBe(false);
  expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(2);
  gate.resolve();
  await first;
  await wallet.close();
});

test.each(['open', 'restore'])(
  'completed %s preserves only genuine source failure provenance even with cancellation',
  async (kind) => {
    const caller = new AbortController();
    const input = { ...completedOptions(), signal: caller.signal };
    const wallet = kind === 'restore' ? await openRailgunCompletedAccountWallet(input) : undefined;
    const original = Error('source secret');
    const outcome = Object.freeze({ fatal: true, reason: 'rpc-failure', rpcFailure: 'response' });
    mockCompletedOutcome.mockImplementation((coordinator, error) => {
      expect(coordinator).toBe(options.coordinator);
      expect(error).toBe(original);
      return outcome;
    });
    options.coordinator.withCompletedPublicSnapshot.mockImplementationOnce(async () => {
      caller.abort();
      throw original;
    });
    const error = await (
      wallet
        ? restoreRailgunAccountWallet(wallet, options)
        : openRailgunCompletedAccountWallet(input)
    ).catch((error) => error);
    expect(error).toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED', sourceOutcome: outcome });
    expect(error.message).not.toContain('source secret');
    expect(error.sourceOutcome).toBe(outcome);
    if (wallet) await wallet.close();
  }
);

test('public generation changes while waiting for completed source refuse before viewing credential admission', async () => {
  const input = completedOptions();
  options.coordinator.withCompletedPublicSnapshot.mockImplementationOnce(async (_options, run) => {
    generation = { ...generation, id: 'f'.repeat(64) };
    return { value: await run({ checkpoint: {}, signal: scope.signal }), evidence: {} };
  });
  await expect(openRailgunCompletedAccountWallet(input)).rejects.toThrow();
  expect(mockRunner.restoreReadOnly).not.toHaveBeenCalled();
  expect(options.coordinator.signal.aborted).toBe(false);
});

test.each([false, true])(
  'unknown utility exit retains account exclusion across identity replacement (wrapped=%s)',
  async (wrapped) => {
    const input = completedOptions();
    const unknown = Object.assign(Error('unobserved'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    mockRunner.restoreReadOnly.mockRejectedValueOnce(
      wrapped ? Error('outer', { cause: unknown }) : unknown
    );
    await expect(openRailgunCompletedAccountWallet(input)).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
    });
    expect(mockSession.close).toHaveBeenCalled();
    await mockSession.closed;
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
    const original = mockEnrollment;
    mockEnrollment = { ...original };
    mockIdentity = { descriptor: { ...mockIdentity.descriptor } };
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  }
);
test('observed failed storage exit rejects close after drain but releases the phase', async () => {
  const account = await openRailgunCompletedAccountWallet(completedOptions());
  mockSession.closed = Promise.resolve({ exitCode: 1 });
  await expect(account.close()).rejects.toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  const claim = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  claim.release();
});
test('unobserved storage exit rejects close and retains the phase', async () => {
  const account = await openRailgunCompletedAccountWallet(completedOptions());
  mockSession.closed = Promise.reject(Error('missing exit evidence'));
  await expect(account.close()).rejects.toThrow();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  mockSession.closed = Promise.resolve({ exitCode: 0 });
});

test.each(['ordinary-open', 'repeated-restore'])(
  'unknown exit retains phase on %s and quarantines credentials',
  async (mode) => {
    const unknown = Object.assign(Error('unobserved'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    if (mode === 'ordinary-open') {
      mockRunner.run.mockRejectedValueOnce(unknown);
      await expect(openRailgunAccountWallet(options)).rejects.toMatchObject({
        code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
      });
    } else {
      const account = await openRailgunCompletedAccountWallet(completedOptions());
      mockRunner.restoreReadOnly.mockRejectedValueOnce(unknown);
      await expect(restoreRailgunAccountWallet(account, options)).rejects.toMatchObject({
        code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
      });
    }
    expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  }
);
test.each([undefined, null, {}, { exitCode: null }])(
  'invalid storage exit evidence %p cannot release phase',
  async (value) => {
    const account = await openRailgunCompletedAccountWallet(completedOptions());
    mockSession.closed = Promise.resolve(value);
    await expect(account.close()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  }
);

function proofRecoveryFixture(kind = 'railgun-private-transfer', creator = 'Shield') {
  const builders = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const f =
    kind === 'railgun-partial-unshield'
      ? builders.createRailgunPartialCapsuleData()
      : builders.createRailgunLegacyCapsuleData(kind);
  f.capsule.walletId = mockEnrollment.descriptor.walletId;
  mockIdentity.descriptor.instanceId = f.owned.read.instanceId;
  const txid = '0x' + '8'.repeat(64);
  Object.assign(f.owned.read.received[0], { hash: f.capsule.noteHash, txid });
  Object.assign(f.owned.ownedPoi[0], { hash: f.capsule.noteHash, txid, type: creator });
  f.owned.checkpointHash = '6'.repeat(64);
  // Current authenticated tree is deliberately newer than the original signed root.
  f.owned.trees[0].root = '0x' + '0'.repeat(63) + '9';
  mockRunner.readOwned.mockImplementation(() => f.owned);
  const recovery = {
    capsule: f.capsule,
    signature: {
      R8: ['0x' + '0'.repeat(63) + '1', '0x' + '0'.repeat(63) + '2'],
      S: '0x' + '0'.repeat(63) + '3',
    },
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
  };
  f.inner.proof.a.x = 1;
  const transaction = { ...f.capsule.preparation.transaction, data: f.encode() };
  const candidate = {
    status: 'proved',
    transaction,
    transactionDigest: require('./railgun-private-intent').matchRailgunPrivateProvedTransaction(
      f.capsule.preparation.transaction,
      transaction,
      f.capsule.preparation.expected
    ).digest,
    independentlyVerified: false,
  };
  mockRunner.recoverReadOnly = jest.fn(async () => ({
    receipt: {},
    coverage: {},
    readOnly: { readOnly: true, writeAttempts: 0 },
    recovery: candidate,
  }));
  return { ...f, recovery, candidate };
}

for (const kind of [
  'railgun-private-transfer',
  'railgun-token-unshield',
  'railgun-partial-unshield',
]) {
  test.each(['Shield', 'Transact'])(
    `fixed recovery ${kind}/%s returns candidate after revalidation with original root unchanged`,
    async (creator) => {
      const input = completedOptions(),
        f = proofRecoveryFixture(kind, creator);
      const account = await openRailgunCompletedAccountWallet(input);
      try {
        const candidate = await recoverRailgunAccountPrivateProof(account, options, f.recovery);
        expect(candidate).toEqual(f.candidate);
        expect(Object.keys(candidate).sort()).toEqual([
          'independentlyVerified',
          'status',
          'transaction',
          'transactionDigest',
        ]);
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.isFrozen(candidate.transaction)).toBe(true);
        expect(mockRunner.recoverReadOnly).toHaveBeenCalledTimes(1);
        const call = mockRunner.recoverReadOnly.mock.calls[0][0];
        expect(call.privateRecovery).toEqual(f.recovery);
        expect(call.privateRecovery.capsule).not.toBe(f.recovery.capsule);
        expect(call.privateRecovery.capsule.preparation.expected.merkleRoot).not.toBe(
          f.owned.trees[0].root
        );
        expect(call).not.toHaveProperty('privateIntent');
        expect(call).not.toHaveProperty('privateOperation');
        expect(mockJournal.revalidate).toHaveBeenCalledTimes(2);
        expect(mockJournal.prepare).not.toHaveBeenCalled();
        expect(mockJournal.complete).not.toHaveBeenCalled();
        expect(options.coordinator.withPublicSnapshot).not.toHaveBeenCalled();
        expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(2);
        expect(mockRunner.restoreReadOnly).toHaveBeenCalledTimes(1);
        await restoreRailgunAccountWallet(account, options);
        expect(mockRunner.restoreReadOnly).toHaveBeenCalledTimes(2);
      } finally {
        await account.close();
      }
    }
  );
}

test('proof recovery cannot adopt ordinary wallet accounts, copied accounts or foreign owners', async () => {
  const f = proofRecoveryFixture();
  const ordinary = await openRailgunAccountWallet(options);
  expect(() => recoverRailgunAccountPrivateProof(ordinary, options, f.recovery)).toThrow();
  await ordinary.close();
  // Separate setup after actual ordinary storage exit.
  const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  phase.release();
  expect(() => recoverRailgunAccountPrivateProof({}, options, f.recovery)).toThrow();
  expect(mockRunner.recoverReadOnly).not.toHaveBeenCalled();
});

test.each(['copy', 'identity', 'enrollment', 'coordinator'])(
  'fixed recovery refuses %s owner substitution before queries',
  async (kind) => {
    const input = completedOptions(),
      f = proofRecoveryFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    try {
      expect(() =>
        recoverRailgunAccountPrivateProof(
          kind === 'copy' ? { ...account } : account,
          kind === 'copy' ? options : { ...options, [kind]: {} },
          f.recovery
        )
      ).toThrow();
      expect(mockRunner.recoverReadOnly).not.toHaveBeenCalled();
      expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      await account.close();
    }
  }
);

test.each([
  'callback',
  'job',
  'mode',
  'missing-signature',
  'wallet',
  'relative-path',
  'signature',
  'getter',
])('closed recovery input refuses %s without poisoning healthy account', async (kind) => {
  const input = completedOptions(),
    f = proofRecoveryFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const bad = JSON.parse(JSON.stringify(f.recovery));
  if (['callback', 'job', 'mode'].includes(kind)) bad[kind] = 'not allowed';
  if (kind === 'missing-signature') delete bad.signature;
  if (kind === 'wallet') bad.capsule.walletId = 'f'.repeat(64);
  if (kind === 'relative-path') bad.proverArchive = 'relative.asar';
  if (kind === 'signature') bad.signature.S = '0x00';
  const getter = jest.fn(() => '/prover.asar');
  if (kind === 'getter')
    Object.defineProperty(bad, 'proverArchive', { enumerable: true, get: getter });
  try {
    await expect(recoverRailgunAccountPrivateProof(account, options, bad)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(mockRunner.recoverReadOnly).not.toHaveBeenCalled();
    expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
    expect(account.signal.aborted).toBe(false);
    await expect(recoverRailgunAccountPrivateProof(account, options, f.recovery)).resolves.toEqual(
      f.candidate
    );
  } finally {
    await account.close();
  }
});

test.each([
  'spent',
  'hash',
  'nullifier',
  'amount',
  'token',
  'type',
  'txid',
  'duplicate-note',
  'duplicate-record',
  'position',
  'instance',
])('current owned %s mismatch refuses before recovery utility or source query', async (kind) => {
  const input = completedOptions(),
    f = proofRecoveryFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  if (kind === 'spent') f.owned.read.received[0].spentTxid = '0x' + '1'.repeat(64);
  if (kind === 'hash') f.owned.ownedPoi[0].hash = '0x' + '1'.repeat(64);
  if (kind === 'nullifier') f.owned.ownedPoi[0].nullifier = '0x' + '1'.repeat(64);
  if (kind === 'amount') f.owned.read.received[0].amount = 999n;
  if (kind === 'token') f.owned.read.received[0].asset.contract = '0x' + '1'.repeat(40);
  if (kind === 'type') f.owned.ownedPoi[0].type = 'unknown';
  if (kind === 'txid') f.owned.ownedPoi[0].txid = '0x' + '1'.repeat(64);
  if (kind === 'duplicate-note') f.owned.read.received.push({ ...f.owned.read.received[0] });
  if (kind === 'duplicate-record') f.owned.ownedPoi.push({ ...f.owned.ownedPoi[0] });
  if (kind === 'position') f.owned.trees[0].length = 1;
  if (kind === 'instance') f.owned.read.instanceId = 'foreign';
  try {
    await expect(recoverRailgunAccountPrivateProof(account, options, f.recovery)).rejects.toThrow();
    expect(mockRunner.recoverReadOnly).not.toHaveBeenCalled();
    expect(options.coordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
  } finally {
    await account.close();
  }
});

test('recovery captures caller data before awaits and never regenerates the original intent', async () => {
  const input = completedOptions(),
    f = proofRecoveryFixture('railgun-partial-unshield');
  const account = await openRailgunCompletedAccountWallet(input);
  const original = JSON.parse(JSON.stringify(f.recovery));
  const gate = completedDeferred();
  let entered = false;
  mockJournal.readState.mockImplementationOnce(async () => {
    entered = true;
    await gate.promise;
    return state;
  });
  const work = recoverRailgunAccountPrivateProof(account, options, f.recovery);
  await completedUntil(() => entered);
  f.recovery.signature.S = '0x00';
  f.recovery.capsule.pathElements[0] = '0x00';
  f.recovery.proverArchive = '/changed.asar';
  gate.resolve();
  try {
    expect(await work).toEqual(f.candidate);
    expect(mockRunner.recoverReadOnly.mock.calls[0][0].privateRecovery).toEqual(original);
  } finally {
    await account.close();
  }
});

test.each(['type', 'creating-txid', 'checkpoint', 'spent'])(
  'late coherent %s drift refuses after genuine receipt/journal revalidation',
  async (kind) => {
    const input = completedOptions(),
      f = proofRecoveryFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    mockRunner.recoverReadOnly.mockImplementationOnce(async () => {
      if (kind === 'type') f.owned.ownedPoi[0].type = 'Transact';
      if (kind === 'creating-txid')
        f.owned.ownedPoi[0].txid = f.owned.read.received[0].txid = '0x' + '9'.repeat(64);
      if (kind === 'checkpoint') f.owned.checkpointHash = '9'.repeat(64);
      if (kind === 'spent') f.owned.read.received[0].spentTxid = '0x' + '9'.repeat(64);
      return { receipt: {}, coverage: {}, recovery: f.candidate };
    });
    await expect(recoverRailgunAccountPrivateProof(account, options, f.recovery)).rejects.toThrow();
    expect(mockJournal.revalidate).toHaveBeenCalledTimes(2);
    expect(account.signal.aborted).toBe(true);
    expect(options.coordinator.signal.aborted).toBe(false);
  }
);

test.each(['missing', 'refused', 'digest', 'extra-secret', 'verified', 'different-intent'])(
  'recovery result %s cannot escape as a candidate',
  async (kind) => {
    const input = completedOptions(),
      f = proofRecoveryFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    let recovery = { ...f.candidate };
    if (kind === 'missing') recovery = undefined;
    if (kind === 'refused') recovery = { status: 'refused' };
    if (kind === 'digest') recovery.transactionDigest = '0x' + 'f'.repeat(64);
    if (kind === 'extra-secret') recovery.witness = 'private';
    if (kind === 'verified') recovery.independentlyVerified = true;
    if (kind === 'different-intent') recovery.transaction = { ...recovery.transaction, value: '1' };
    mockRunner.recoverReadOnly.mockResolvedValueOnce({ receipt: {}, coverage: {}, recovery });
    await expect(recoverRailgunAccountPrivateProof(account, options, f.recovery)).rejects.toThrow();
    expect(account.signal.aborted).toBe(true);
  }
);

test('recovery cancellation holds the real wallet phase after storage exit until fixed runner drains', async () => {
  const input = completedOptions(),
    f = proofRecoveryFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const gate = completedDeferred();
  let entered = false,
    settled = false;
  mockRunner.recoverReadOnly.mockImplementationOnce(async () => {
    entered = true;
    await gate.promise;
    return { receipt: {}, recovery: f.candidate };
  });
  const work = recoverRailgunAccountPrivateProof(account, options, f.recovery).catch((error) => {
    settled = true;
    return error;
  });
  await completedUntil(() => entered);
  const closing = account.close();
  await mockSession.closed;
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  gate.resolve();
  expect(await work).toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  await closing;
  const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  phase.release();
});

test('recovery unknown utility exit preserves process quarantine and phase instead of returning proof data', async () => {
  const input = completedOptions(),
    f = proofRecoveryFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  mockRunner.recoverReadOnly.mockRejectedValueOnce(
    Object.assign(Error('exit unknown'), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' })
  );
  await expect(
    recoverRailgunAccountPrivateProof(account, options, f.recovery)
  ).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
});

test.each(['recover', 'restore'])(
  'held proof regeneration excludes competing %s while preserving admitted recovery',
  async (kind) => {
    const input = completedOptions(),
      f = proofRecoveryFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    const gate = completedDeferred();
    let entered = false;
    mockRunner.recoverReadOnly.mockImplementationOnce(async () => {
      entered = true;
      await gate.promise;
      return { receipt: {}, recovery: f.candidate };
    });
    const work = recoverRailgunAccountPrivateProof(account, options, f.recovery);
    await completedUntil(() => entered);
    try {
      await expect(
        kind === 'recover'
          ? recoverRailgunAccountPrivateProof(account, options, f.recovery)
          : restoreRailgunAccountWallet(account, options)
      ).rejects.toThrow();
      expect(mockRunner.recoverReadOnly).toHaveBeenCalledTimes(1);
      expect(account.signal.aborted).toBe(false);
      gate.resolve();
      expect(await work).toEqual(f.candidate);
    } finally {
      gate.resolve();
      await work.catch(() => {});
      await account.close();
    }
  }
);

test.each(['journal', 'coverage', 'generation', 'deadline'])(
  'late recovery %s failure refuses without publishing candidate',
  async (kind) => {
    const input = completedOptions(),
      f = proofRecoveryFixture();
    let now = 100;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const account = await openRailgunCompletedAccountWallet({ ...input, timeoutMs: 1000 });
    mockRunner.recoverReadOnly.mockImplementationOnce(async () => {
      if (kind === 'journal')
        mockJournal.revalidate.mockRejectedValueOnce(Error('changed persisted state'));
      if (kind === 'coverage') mockCoverage.read.mockRejectedValueOnce(Error('changed coverage'));
      if (kind === 'generation') generation = { ...generation, id: 'f'.repeat(64) };
      if (kind === 'deadline') now = 1100;
      return { receipt: {}, recovery: f.candidate };
    });
    try {
      await expect(
        recoverRailgunAccountPrivateProof(account, options, f.recovery)
      ).rejects.toThrow();
      expect(account.signal.aborted).toBe(true);
      expect(options.coordinator.signal.aborted).toBe(false);
      expect(mockJournal.complete).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      await account.close();
    }
  }
);

test('late source failure during proof recovery retains genuine outcome despite caller cancellation', async () => {
  const caller = new AbortController();
  const input = { ...completedOptions(), signal: caller.signal },
    f = proofRecoveryFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const original = Error('source detail');
  const outcome = Object.freeze({ fatal: true, reason: 'rpc-failure', rpcFailure: 'response' });
  mockCompletedOutcome.mockImplementation((coordinator, error) => {
    expect(coordinator).toBe(options.coordinator);
    expect(error).toBe(original);
    return outcome;
  });
  options.coordinator.withCompletedPublicSnapshot.mockImplementationOnce(async (_options, use) => {
    await use({ checkpoint: {}, signal: scope.signal });
    caller.abort();
    throw original;
  });
  const error = await recoverRailgunAccountPrivateProof(account, options, f.recovery).catch(
    (error) => error
  );
  expect(error).toMatchObject({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED', sourceOutcome: outcome });
  expect(error.message).not.toContain('source detail');
  expect(mockRunner.recoverReadOnly).toHaveBeenCalledTimes(1);
  await account.close();
});

// Real account registry/phase and capsule/owned-record normalizers; the completed
// worker/store/identity issuers above are controlled seams, not native evidence.
function completedInputFixture(kind = 'railgun-private-transfer', creator = 'Shield') {
  const f = proofRecoveryFixture(kind, creator);
  Object.assign(f.owned.ownedPoi[0], {
    npk: '0x' + '0'.repeat(63) + '7',
    blindedCommitment: '0x' + '0'.repeat(63) + '8',
    blockNumber: 5944700,
  });
  f.owned.read.readiness = {
    to: { number: 5944740, hash: '0x' + 'a'.repeat(64) },
  };
  return f;
}
function completedInputWork() {
  return [
    mockRunner.run,
    mockRunner.restoreReadOnly,
    mockRunner.recoverReadOnly,
    options.coordinator.withPublicSnapshot,
    options.coordinator.withCompletedPublicSnapshot,
    mockCompletedStore,
    mockOpenStore,
    mockJournal.readState,
    mockJournal.revalidate,
    mockJournal.prepare,
    mockJournal.complete,
    mockCoverage.read,
    mockCoverage.write,
    mockSession.inspectWalletState,
    mockRead,
  ].map((mock) => mock?.mock.calls.length ?? 0);
}
for (const kind of [
  'railgun-private-transfer',
  'railgun-token-unshield',
  'railgun-partial-unshield',
]) {
  test.each(['Shield', 'Transact'])(
    `completed input ${kind}/%s is synchronous bounded data at an advanced root`,
    async (creator) => {
      const input = completedOptions(),
        f = completedInputFixture(kind, creator);
      const account = await openRailgunCompletedAccountWallet(input);
      const keys = jest.spyOn(mockEnrollment, 'withGenerationKeys');
      const before = completedInputWork();
      try {
        const value = readRailgunCompletedAccountPrivateInput(account, options, f.capsule);
        expect(value).not.toBeInstanceOf(Promise);
        expect(value).toEqual({
          binding: {
            checkpointHash: f.owned.checkpointHash,
            id: '0:1',
            type: creator,
            txid: f.owned.ownedPoi[0].txid,
            noteHash: f.capsule.noteHash,
            nullifier: f.capsule.preparation.expected.nullifier,
            amount:
              kind === 'railgun-partial-unshield'
                ? f.capsule.preparation.inputAmount
                : f.capsule.preparation.amount,
          },
          ownedRecord: f.owned.ownedPoi[0],
          publicThrough: f.owned.read.readiness.to,
          generationId: account.generationId,
        });
        expect(Object.keys(value).sort()).toEqual([
          'binding',
          'generationId',
          'ownedRecord',
          'publicThrough',
        ]);
        for (const part of [value, value.binding, value.ownedRecord, value.publicThrough])
          expect(Object.isFrozen(part)).toBe(true);
        expect(value.ownedRecord).not.toBe(f.owned.ownedPoi[0]);
        expect(value.publicThrough).not.toBe(f.owned.read.readiness.to);
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(2048);
        expect(f.owned.trees[0].root).not.toBe(f.capsule.preparation.expected.merkleRoot);
        expect(completedInputWork()).toEqual(before);
        expect(keys).not.toHaveBeenCalled();
        expect(() => assertRailgunAccountPrivateWindow(value, account, options)).toThrow();
        expect(account.signal.aborted).toBe(false);
      } finally {
        await account.close();
      }
    }
  );
}

test.each(['copy', 'empty', 'identity', 'enrollment', 'coordinator'])(
  'completed input refuses %s registry substitution without later work',
  async (kind) => {
    const input = completedOptions(),
      f = completedInputFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    const before = completedInputWork();
    try {
      expect(() =>
        readRailgunCompletedAccountPrivateInput(
          kind === 'copy' ? { ...account } : kind === 'empty' ? {} : account,
          ['copy', 'empty'].includes(kind) ? options : { ...options, [kind]: {} },
          f.capsule
        )
      ).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' }));
      expect(completedInputWork()).toEqual(before);
      expect(readRailgunCompletedAccountPrivateInput(account, options, f.capsule).binding.id).toBe(
        '0:1'
      );
    } finally {
      await account.close();
    }
  }
);

test('completed input refuses an ordinary genuine account before reading its owned data', async () => {
  const f = completedInputFixture();
  const account = await openRailgunAccountWallet(options);
  const before = mockRunner.readOwned.mock.calls.length;
  try {
    expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow();
    expect(mockRunner.readOwned).toHaveBeenCalledTimes(before);
    expect(account.signal.aborted).toBe(false);
  } finally {
    await account.close();
  }
});

test.each([
  'spent',
  'note-hash',
  'record-hash',
  'nullifier',
  'amount',
  'asset',
  'type',
  'txid',
  'duplicate-note',
  'duplicate-record',
  'position',
  'instance',
  'blinded-commitment',
  'record-extra',
  'future-creator',
  'through-hash',
  'checkpoint',
])('completed input rejects current %s mismatch without utility or query', async (kind) => {
  const input = completedOptions(),
    f = completedInputFixture('railgun-partial-unshield', 'Transact');
  const account = await openRailgunCompletedAccountWallet(input);
  const before = completedInputWork();
  const note = f.owned.read.received[0],
    record = f.owned.ownedPoi[0];
  if (kind === 'spent') note.spentTxid = '0x' + 'b'.repeat(64);
  if (kind === 'note-hash') note.hash = '0x' + '1'.repeat(64);
  if (kind === 'record-hash') record.hash = '0x' + '1'.repeat(64);
  if (kind === 'nullifier') record.nullifier = '0x' + '1'.repeat(64);
  if (kind === 'amount') note.amount = 999n;
  if (kind === 'asset') note.asset.contract = '0x' + '1'.repeat(40);
  if (kind === 'type') record.type = 'Unknown';
  if (kind === 'txid') record.txid = '0x' + '1'.repeat(64);
  if (kind === 'duplicate-note') f.owned.read.received.push({ ...note });
  if (kind === 'duplicate-record') f.owned.ownedPoi.push({ ...record });
  if (kind === 'position') f.owned.trees[0].length = 1;
  if (kind === 'instance') f.owned.read.instanceId = 'foreign';
  if (kind === 'blinded-commitment') record.blindedCommitment = '0x' + 'f'.repeat(64);
  if (kind === 'record-extra') record.secret = 'must not escape';
  if (kind === 'future-creator') record.blockNumber = 5944741;
  if (kind === 'through-hash') f.owned.read.readiness.to.hash = 'unknown';
  if (kind === 'checkpoint') f.owned.checkpointHash = 'unknown';
  try {
    expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' })
    );
    expect(completedInputWork()).toEqual(before);
    expect(account.signal.aborted).toBe(false);
  } finally {
    await account.close();
  }
});

test.each([
  'version',
  'kind',
  'wallet',
  'selection',
  'extra',
  'getter',
  'nested-getter',
  'array-prototype',
  'proxy',
  'toJSON',
  'oversize',
  'cycle',
])('completed input rejects malformed %s capsule without executing caller code', async (kind) => {
  const input = completedOptions(),
    f = completedInputFixture('railgun-partial-unshield');
  const account = await openRailgunCompletedAccountWallet(input);
  const before = completedInputWork();
  let capsule = JSON.parse(JSON.stringify(f.capsule));
  const hook = jest.fn(() => f.capsule);
  const mapHook = jest.fn();
  if (kind === 'version') capsule.version = 1;
  if (kind === 'kind') capsule.selection.kind = 'unknown';
  if (kind === 'wallet') capsule.walletId = 'f'.repeat(64);
  if (kind === 'selection') capsule.selection.position = 2;
  if (kind === 'extra') capsule.receipt = {};
  if (kind === 'getter') Object.defineProperty(capsule, 'preparation', { get: hook });
  if (kind === 'nested-getter') Object.defineProperty(capsule.selection, 'kind', { get: hook });
  if (kind === 'array-prototype')
    Object.setPrototypeOf(
      capsule.pathElements,
      Object.assign(Object.create(Array.prototype), { toJSON: hook, map: mapHook })
    );
  if (kind === 'proxy') capsule = new Proxy(capsule, { ownKeys: hook, get: hook });
  if (kind === 'toJSON') capsule.toJSON = hook;
  if (kind === 'oversize') capsule.noteHash = 'a'.repeat(32769);
  if (kind === 'cycle') capsule.extra = capsule;
  try {
    expect(() => readRailgunCompletedAccountPrivateInput(account, options, capsule)).toThrow(
      expect.objectContaining({ code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' })
    );
    expect(hook).not.toHaveBeenCalled();
    expect(mapHook).not.toHaveBeenCalled();
    expect(completedInputWork()).toEqual(before);
    expect(readRailgunCompletedAccountPrivateInput(account, options, f.capsule).binding.type).toBe(
      'Shield'
    );
  } finally {
    await account.close();
  }
});

test.each(['closed', 'caller', 'generation', 'public-generation', 'destination', 'scan-receipt'])(
  'completed input refuses %s lifetime drift without restoring state',
  async (kind) => {
    const caller = new AbortController();
    const input = { ...completedOptions(), signal: caller.signal },
      f = completedInputFixture();
    const account = await openRailgunCompletedAccountWallet(input);
    const before = completedInputWork();
    if (kind === 'closed') await account.close();
    if (kind === 'caller') caller.abort();
    if (kind === 'generation') generation = { ...generation, id: 'f'.repeat(64) };
    if (kind === 'public-generation')
      mockAssertPublic.mockReturnValue({
        generationId: 'f'.repeat(64),
        sourceId: 'b'.repeat(64),
        publicId: 'c'.repeat(64),
      });
    if (kind === 'destination')
      mockAssertDestination.mockImplementation(() => {
        throw Error('revoked');
      });
    // The real runner performs this journal/source receipt assertion on readOwned.
    if (kind === 'scan-receipt')
      mockRunner.readOwned.mockImplementation(() => {
        throw Error('stale receipt');
      });
    try {
      expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow();
      expect(completedInputWork()).toEqual(before);
    } finally {
      await account.close();
    }
  }
);

test('completed input data stays detached after fixture mutations and account closure', async () => {
  const input = completedOptions(),
    f = completedInputFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const value = readRailgunCompletedAccountPrivateInput(account, options, f.capsule);
  const snapshot = JSON.stringify(value);
  f.owned.ownedPoi[0].blindedCommitment = '0x' + '1'.repeat(64);
  f.owned.read.readiness.to.number++;
  f.capsule.pathElements[0] = '0x' + '1'.repeat(64);
  await account.close();
  expect(JSON.stringify(value)).toBe(snapshot);
  expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow();
  expect(() => assertRailgunAccountPrivateWindow(value, account, options)).toThrow();
});

test('completed input lazily refuses its expired account before a timer callback fires', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const input = completedOptions(),
    f = completedInputFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const before = completedInputWork();
  try {
    now += 180000;
    expect(account.signal.aborted).toBe(false);
    expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow();
    expect(completedInputWork()).toEqual(before);
  } finally {
    await account.close();
  }
});

test('completed input cannot read through an in-flight restore, then works after its real promise drains', async () => {
  const input = completedOptions(),
    f = completedInputFixture();
  const account = await openRailgunCompletedAccountWallet(input);
  const gate = completedDeferred();
  mockRunner.restoreReadOnly.mockImplementationOnce(async () => {
    await gate.promise;
    return { receipt: {}, coverage: {}, readOnly: { readOnly: true, writeAttempts: 0 } };
  });
  const restoring = restoreRailgunAccountWallet(account, options);
  await completedUntil(() => mockRunner.restoreReadOnly.mock.calls.length === 2);
  const before = completedInputWork();
  try {
    expect(() => readRailgunCompletedAccountPrivateInput(account, options, f.capsule)).toThrow();
    expect(completedInputWork()).toEqual(before);
  } finally {
    gate.resolve();
    await restoring;
  }
  try {
    expect(readRailgunCompletedAccountPrivateInput(account, options, f.capsule).binding.id).toBe(
      '0:1'
    );
  } finally {
    await account.close();
  }
});

// Mock account-owner orchestration only. No engine, native process, real quote
// signature, account enrollment/profile or wallet decryption runs in this suite.
const { prepareRailgunAccountRelayIntent } = require('./railgun-account-wallet');
function relayFixture() {
  const originalSnapshot = options.coordinator.withPublicSnapshot;
  options.coordinator.withPublicSnapshot = (run) =>
    originalSnapshot((snapshot) => {
      let id = 0;
      return run({
        ...snapshot,
        dispatch: async (wire) => {
          const message = JSON.parse(wire);
          expect(message.id).toBe(++id);
          return JSON.stringify({ id: message.id, value: null });
        },
      });
    });
  // Jest's native structuredClone returns foreign-realm prototypes. These owner
  // mocks contain plain acyclic data/BigInts; keep their copies in this realm.
  const clone = (value) =>
    Array.isArray(value)
      ? value.map(clone)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]))
        : value;
  jest.spyOn(global, 'structuredClone').mockImplementation(clone);
  const f = preparationFixture();
  const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  Object.assign(mockIdentity.descriptor, {
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: hex(7).slice(2),
    viewingPublicKey: '02'.repeat(32),
  });
  f.owned.checkpointHash = '{}';
  f.owned.read.instanceId = mockIdentity.descriptor.instanceId;
  Object.assign(f.owned.read.received[0], { hash: hex(12), txid: '0x' + '44'.repeat(32) });
  Object.assign(f.owned.ownedPoi[0], {
    hash: hex(12),
    nullifier: hex(8),
    txid: '0x' + '44'.repeat(32),
    type: 'Shield',
  });
  f.owned.trees[0].root = hex(7);
  const fields = {
    fees: { [require('./railgun-shield-pins.json').wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: Date.now() + 240000,
    feesID: 'owner-only-test',
    railgunAddress: '0zk1' + 'p'.repeat(123),
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: require('./railgun-shield-pins.json').relayAdapt,
    requiredPOIListKeys: [],
    reliability: -1,
  };
  const abort = new AbortController();
  const request = {
    noteId: '0:1',
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '04'.repeat(64),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    maxFee: '100',
    signal: abort.signal,
  };
  const verify = jest
    .spyOn(require('./railgun-relay-quote-verify'), 'verifyRailgunRelayQuote')
    .mockImplementation(async ({ quote, gas }) => ({
      signatureVerified: true,
      quoteSha256: require('./railgun-relay-quote-data').normalizeRailgunRelayQuote(quote, gas)
        .quoteSha256,
      masterPublicKey: '8',
      viewingPublicKey: '03'.repeat(32),
    }));
  mockSession.inspectWalletState.mockImplementation(async () => ({
    storeId: generation.storeId,
    state: true,
  }));
  const owners = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    coordinator: options.coordinator,
  };
  const receipts = { first: {}, second: {} };
  const coverage = { checkpoint: {}, coverage: {}, summary: {} };
  const { AbiCoder, Interface, keccak256 } = require('ethers');
  const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
  const pins = require('./railgun-shield-pins.json');
  const zero = '0x' + '0'.repeat(40);
  const cipher = (n) => ({
    ciphertext: [hex(n), hex(n + 1), hex(n + 2), hex(n + 3)],
    blindedSenderViewingKey: hex(n + 4),
    blindedReceiverViewingKey: hex(n + 5),
    annotationData: '0x1122',
    memo: '0x',
  });
  let draft;
  mockRunner.prepareRelayReadOnly = jest.fn(async ({ relayRequest }) => {
    events.push('relay-construct');
    const bound = {
      treeNumber: 0,
      minGasPrice: 1,
      unshield: 0,
      chainID: pins.chainId,
      adaptContract: zero,
      adaptParams: hex(0),
      commitmentCiphertext: [cipher(10), cipher(20)],
    };
    const tx = {
      proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
      merkleRoot: hex(7),
      nullifiers: [hex(8)],
      commitments: [hex(9), hex(10)],
      boundParams: bound,
      unshieldPreimage: {
        npk: hex(0),
        token: { tokenType: 0, tokenAddress: zero, tokenSubID: 0 },
        value: 0,
      },
    };
    const intent = {
      transaction: {
        chainId: pins.chainId,
        to: pins.proxy,
        value: '0',
        data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[tx]]),
      },
      expected: {
        kind: 'railgun-relay-self-transfer',
        tree: 0,
        merkleRoot: hex(7),
        nullifier: hex(8),
        feeCommitment: hex(9),
        selfCommitment: hex(10),
        boundParamsHash: hex(
          BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) %
            21888242871839275222246405745257275088548364400416034343698204186575808495617n
        ),
      },
      expectedHash: hex(11),
      context: relayRequest.context,
    };
    draft = require('./railgun-relay-capsule').normalizeRailgunRelayDraftCapsule({
      schema: 'railgun-relay-unsigned-draft-v1',
      walletId: mockIdentity.descriptor.walletId,
      engineSha256: require('./railgun-engine-manifest.json').sha256,
      selection: relayRequest.selection,
      noteHash: hex(12),
      pathElements: Array.from({ length: 16 }, (_, i) => hex(i + 1)),
      intent,
    });
    return {
      receipt: receipts.first,
      coverage: coverage.coverage,
      relayOwned: structuredClone(f.owned),
      readOnly: { readOnly: true, writeAttempts: 0 },
      relayDraft: draft,
    };
  });
  mockRunner.reconstructRelayReadOnly = jest.fn(async ({ relayDraftText }) => {
    events.push('relay-reconstruct');
    expect(relayDraftText).toBe(JSON.stringify(draft.data));
    const parsed = require('./railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(
      JSON.parse(relayDraftText)
    );
    return {
      receipt: receipts.second,
      coverage: coverage.coverage,
      relayOwned: structuredClone(f.owned),
      readOnly: { readOnly: true, writeAttempts: 0 },
      relayReconstruction: {
        draftDigest: parsed.digest,
        expectedHash: parsed.data.intent.expectedHash,
        recoveredOutputs: 2,
      },
    };
  });
  const opened = async () => {
    const account = await openRailgunAccountWallet(options);
    mockCoverage.read.mockImplementation(async (receipt) => {
      events.push(receipt === receipts.first ? 'consume-first' : 'consume-second');
      return coverage;
    });
    const previous = mockRunner.readOwned.getMockImplementation();
    mockRunner.readOwned.mockImplementation((receipt) => {
      expect(receipt).not.toBe(receipts.first);
      if (receipt === receipts.second) expect(events.at(-1)).toBe('revalidate');
      return previous();
    });
    mockJournal.revalidate.mockClear();
    return account;
  };
  return { ...f, owners, request, fields, abort, verify, receipts, coverage, opened };
}
const waitRelay = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
};
test('relay preparation holds one owner window, consumes first receipt, reconstructs serialized data, then revalidates once', async () => {
  const f = relayFixture(),
    account = await f.opened(),
    old = account.view;
  mockRead.mockImplementation(() => ({}));
  const result = await prepareRailgunAccountRelayIntent(account, f.owners, f.request);
  expect(result.view).toBe(account.view);
  expect(account.view).not.toBe(old);
  expect(result.preparation.data.intent.context).toMatchObject({
    inputAmount: '1000',
    feeAmount: '100',
    selfAmount: '900',
    feeCap: '100',
  });
  for (const name of [
    'reviewedPreparation',
    'reservationsChecked',
    'capsulePersisted',
    'signingEnabled',
    'proofAuthority',
    'poiQueriesPermitted',
    'relaySendPermitted',
  ])
    expect(result[name]).toBe(false);
  expect(mockJournal.revalidate).toHaveBeenCalledTimes(1);
  expect(mockJournal.revalidate.mock.calls[0][0].receipt).toBe(f.receipts.second);
  expect(events.indexOf('consume-first')).toBeLessThan(events.indexOf('relay-reconstruct'));
  expect(mockRunner.prepareReadOnly).not.toHaveBeenCalled();
  expect(mockCoverage.write).not.toHaveBeenCalled();
  for (const call of [
    mockRunner.prepareRelayReadOnly.mock.calls[0][0],
    mockRunner.reconstructRelayReadOnly.mock.calls[0][0],
  ]) {
    expect(call.relaySignal).toBeInstanceOf(AbortSignal);
    for (const name of ['privateIntent', 'privateOperation', 'privateRecovery'])
      expect(call[name]).toBeUndefined();
  }
  const firstSnapshot = mockRunner.prepareRelayReadOnly.mock.calls[0][0].snapshot,
    secondSnapshot = mockRunner.reconstructRelayReadOnly.mock.calls[0][0].snapshot;
  expect(firstSnapshot).not.toBe(secondSnapshot);
  expect(firstSnapshot.checkpoint).toBe(secondSnapshot.checkpoint);
  expect(firstSnapshot.signal.aborted).toBe(true);
  expect(secondSnapshot.signal.aborted).toBe(true);
  await account.close();
});
test('relay quote verification holds busy/handoff, rejects ordinary restore and forged owners, and detaches caller fields', async () => {
  const f = relayFixture(),
    account = await f.opened();
  let release;
  const original = f.verify.getMockImplementation();
  f.verify.mockImplementation(async (input) => {
    await new Promise((r) => {
      release = r;
    });
    return original(input);
  });
  const work = prepareRailgunAccountRelayIntent(account, f.owners, f.request);
  work.catch(() => {});
  await waitRelay(() => !!release);
  await expect(restoreRailgunAccountWallet(account, f.owners)).rejects.toThrow();
  expect(() =>
    require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(account, f.owners)
  ).toThrow();
  expect(() => prepareRailgunAccountRelayIntent({ ...account }, f.owners, f.request)).toThrow();
  for (const key of ['identity', 'enrollment', 'coordinator'])
    expect(() =>
      prepareRailgunAccountRelayIntent(account, { ...f.owners, [key]: {} }, f.request)
    ).toThrow();
  f.request.quote.data = '00';
  f.request.gas.gasPrice = '2';
  f.request.maxFee = '1';
  release();
  const result = await work;
  expect(result.preparation.data.intent.context.gas.gasPrice).toBe('1');
  expect(result.preparation.data.intent.context.feeCap).toBe('100');
  await account.close();
});

test('fresh relay utilities each start at one through real routers on one ordered public snapshot', async () => {
  const f = relayFixture(),
    account = await f.opened();
  const { createRailgunWalletStorage } = require('./railgun-wallet-storage');
  const key = Buffer.from(require('./railgun-frontier').paths.metadata().toString()).toString(
    'base64'
  );
  const snapshots = [];
  for (const name of ['prepareRelayReadOnly', 'reconstructRelayReadOnly']) {
    const original = mockRunner[name].getMockImplementation();
    mockRunner[name].mockImplementation(async (input) => {
      const snapshot = input.snapshot;
      snapshots.push(snapshot);
      const router = createRailgunWalletStorage({
        publicSnapshot: snapshot,
        walletSession: { signal: scope.signal },
        walletId: mockIdentity.descriptor.walletId,
        walletGrant: {
          dispatch: async () => {
            throw Error('unexpected wallet access');
          },
        },
      });
      try {
        for (const id of [1, 2]) {
          const reply = JSON.parse(
            await router.dispatch(
              JSON.stringify({
                id,
                channel: 'public',
                wire: JSON.stringify({ id, method: 'get', args: { key } }),
              })
            )
          );
          expect(reply.id).toBe(id);
          expect(JSON.parse(reply.value)).toEqual({ id, value: null });
        }
        router.assertIdle();
        return await original(input);
      } finally {
        router.close();
      }
    });
  }
  const result = await prepareRailgunAccountRelayIntent(account, f.owners, f.request);
  expect(result.reconstruction.recoveredOutputs).toBe(2);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.every((snapshot) => snapshot.signal.aborted)).toBe(true);
  expect(result.view).toBe(account.view);
  await account.close();
});
test('clean quote refusal releases handoff after original work and leaves borrowed account usable', async () => {
  const f = relayFixture(),
    account = await f.opened();
  f.verify.mockRejectedValue(Error('signature refusal'));
  await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
  expect(account.signal.aborted).toBe(false);
  expect(mockRunner.prepareRelayReadOnly).not.toHaveBeenCalled();
  const handoff = require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(
    account,
    f.owners
  );
  handoff.release();
  expect(readRailgunAccountOwnedNotes(account, f.owners)).toBe(f.owned);
  await account.close();
});
test.each([
  'owned',
  'checkpoint',
  'generation',
  'public-generation',
  'identity',
  'wall-rollback',
  'expired',
  'monotonic-rollback',
  'quote-timeout',
])('relay %s change during quote refuses before wallet job', async (kind) => {
  const f = relayFixture(),
    account = await f.opened();
  let mono = 1000,
    wall = Date.now();
  jest.spyOn(performance, 'now').mockImplementation(() => mono);
  jest.spyOn(Date, 'now').mockImplementation(() => wall);
  const original = f.verify.getMockImplementation();
  f.verify.mockImplementation(async (input) => {
    const verified = await original(input);
    if (kind === 'owned') f.owned.read.received[0].amount = 999n;
    if (kind === 'checkpoint') options.coordinator.assertSnapshot = () => ({ changed: true });
    if (kind === 'generation') generation.id = 'a'.repeat(64);
    if (kind === 'public-generation')
      mockAssertPublic.mockReturnValue({ generationId: 'b'.repeat(64) });
    if (kind === 'identity') mockIdentity.descriptor.viewingPublicKey = '04'.repeat(32);
    if (kind === 'wall-rollback') wall--;
    if (kind === 'expired') wall += 240001;
    if (kind === 'monotonic-rollback') mono--;
    if (kind === 'quote-timeout') mono += 15000;
    return verified;
  });
  await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
  expect(mockRunner.prepareRelayReadOnly).not.toHaveBeenCalled();
  await account.close();
});
test.each([
  'first-owned',
  'coverage',
  'state',
  'second-owned',
  'reconstruction',
  'first-timeout',
  'second-timeout',
])('relay %s mismatch cannot publish intermediate or final view', async (kind) => {
  const f = relayFixture(),
    account = await f.opened(),
    old = account.view;
  let mono = 1000;
  jest.spyOn(performance, 'now').mockImplementation(() => mono);
  const first = mockRunner.prepareRelayReadOnly.getMockImplementation();
  mockRunner.prepareRelayReadOnly.mockImplementation(async (input) => {
    const result = await first(input);
    if (kind === 'first-owned') result.relayOwned.read.received[0].amount = 999n;
    if (kind === 'coverage') f.coverage.checkpoint = { bad: true };
    if (kind === 'state')
      mockSession.inspectWalletState.mockResolvedValue({
        storeId: generation.storeId,
        state: false,
      });
    if (kind === 'first-timeout') mono += 30000;
    return result;
  });
  const second = mockRunner.reconstructRelayReadOnly.getMockImplementation();
  mockRunner.reconstructRelayReadOnly.mockImplementation(async (input) => {
    const result = await second(input);
    if (kind === 'second-owned') result.relayOwned.read.received[0].amount = 999n;
    if (kind === 'reconstruction') result.relayReconstruction.draftDigest = 'f'.repeat(64);
    if (kind === 'second-timeout') mono += 30000;
    return result;
  });
  await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
  expect(account.view).toBe(old);
  expect(mockJournal.revalidate).not.toHaveBeenCalled();
  await account.close();
});
test.each(['quote', 'first', 'second'])(
  'account.close drains held relay %s work before releasing original phase',
  async (stage) => {
    const f = relayFixture(),
      account = await f.opened();
    let release;
    const target =
      stage === 'quote'
        ? f.verify
        : stage === 'first'
          ? mockRunner.prepareRelayReadOnly
          : mockRunner.reconstructRelayReadOnly;
    const original = target.getMockImplementation();
    target.mockImplementation(async (input) => {
      await new Promise((r) => {
        release = r;
      });
      return original(input);
    });
    const work = prepareRailgunAccountRelayIntent(account, f.owners, f.request);
    work.catch(() => {});
    await waitRelay(() => !!release);
    let closed = false;
    const closing = account.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
    release();
    await expect(work).rejects.toThrow();
    await closing;
    const phase = claimRailgunAccountPhase(mockEnrollment, 'txid');
    phase.release();
  }
);
test.each(['quote', 'first', 'second'])(
  'unknown relay %s exit quarantines identity and refuses a fresh account open',
  async (stage) => {
    const f = relayFixture(),
      account = await f.opened();
    const target =
      stage === 'quote'
        ? f.verify
        : stage === 'first'
          ? mockRunner.prepareRelayReadOnly
          : mockRunner.reconstructRelayReadOnly;
    target.mockRejectedValue(
      Object.assign(Error('unknown'), {
        code:
          stage === 'quote' ? 'RAILGUN_RELAY_QUOTE_DRAIN_FAILED' : 'RAILGUN_WALLET_EXIT_UNOBSERVED',
      })
    );
    await expect(
      prepareRailgunAccountRelayIntent(account, f.owners, f.request)
    ).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    await expect(account.close()).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
    expect(account.signal.aborted).toBe(true);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
    const starts = mockOpenStore.mock.calls.length;
    await expect(openRailgunAccountWallet(options)).rejects.toThrow();
    expect(mockOpenStore).toHaveBeenCalledTimes(starts);
    // Replacing JavaScript handles must not bypass process-wide phase exclusion.
    mockEnrollment = { ...mockEnrollment };
    mockIdentity = { descriptor: { ...mockIdentity.descriptor } };
    await expect(
      openRailgunAccountWallet({ ...options, identity: mockIdentity, enrollment: mockEnrollment })
    ).rejects.toThrow();
    expect(mockOpenStore).toHaveBeenCalledTimes(starts);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  }
);

test('relay snapshot entry refusal closes the borrowed account even before the first job', async () => {
  const f = relayFixture(),
    account = await f.opened(),
    old = account.view;
  mockSession.inspectWalletState.mockRejectedValueOnce(Error('freshness unavailable'));
  await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(mockRunner.prepareRelayReadOnly).not.toHaveBeenCalled();
  expect(mockRunner.reconstructRelayReadOnly).not.toHaveBeenCalled();
  expect(account.signal.aborted).toBe(true);
  expect(account.view).toBe(old);
  expect(() => readRailgunAccountOwnedNotes(account, f.owners)).toThrow();
  expect(mockJournal.revalidate).not.toHaveBeenCalled();
  await account.close();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});

test('completed-only account refuses relay before quote or viewing preparation', async () => {
  const input = completedOptions(),
    account = await openRailgunCompletedAccountWallet(input);
  const verify = jest.spyOn(require('./railgun-relay-quote-verify'), 'verifyRailgunRelayQuote');
  await expect(
    prepareRailgunAccountRelayIntent(
      account,
      { identity: mockIdentity, enrollment: mockEnrollment, coordinator: options.coordinator },
      {}
    )
  ).rejects.toThrow();
  expect(verify).not.toHaveBeenCalled();
  await account.close();
});
test.each([
  'missing-signal',
  'aborted-signal',
  'extra-callback',
  'request-proxy',
  'request-getter',
  'signal-proxy',
  'signal-forged-getter',
  'signal-own-getter',
])('relay request %s refuses without caller getter execution or admission', async (kind) => {
  const f = relayFixture(),
    account = await f.opened(),
    hook = jest.fn(() => {
      throw Error('caller hook');
    });
  let request = f.request;
  if (kind === 'missing-signal') delete request.signal;
  if (kind === 'aborted-signal') f.abort.abort();
  if (kind === 'extra-callback') request.onIntent = hook;
  if (kind === 'request-proxy')
    request = new Proxy(request, { ownKeys: hook, getPrototypeOf: hook });
  if (kind === 'request-getter')
    Object.defineProperty(request, 'quote', { enumerable: true, get: hook });
  if (kind === 'signal-proxy')
    request.signal = new Proxy(request.signal, { get: hook, getPrototypeOf: hook });
  if (kind === 'signal-forged-getter')
    request.signal = Object.create(AbortSignal.prototype, { aborted: { get: hook } });
  if (kind === 'signal-own-getter') Object.defineProperty(request.signal, 'aborted', { get: hook });
  await expect(prepareRailgunAccountRelayIntent(account, f.owners, request)).rejects.toThrow();
  expect(hook).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(mockRunner.prepareRelayReadOnly).not.toHaveBeenCalled();
  const handoff = require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(
    account,
    f.owners
  );
  handoff.release();
  await account.close();
});
test.each([89999, 300001])(
  'relay quote remaining margin %s refuses before verification',
  async (margin) => {
    const f = relayFixture(),
      account = await f.opened(),
      now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    f.fields.feeExpiration = now + margin;
    f.request.quote.data = Buffer.from(JSON.stringify(f.fields)).toString('hex');
    await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    await account.close();
  }
);
test.each(['deadline', 'wall-rollback'])(
  'relay final journal %s cannot publish a view',
  async (kind) => {
    const f = relayFixture(),
      account = await f.opened(),
      old = account.view;
    let mono = 1000,
      wall = Date.now();
    jest.spyOn(performance, 'now').mockImplementation(() => mono);
    jest.spyOn(Date, 'now').mockImplementation(() => wall);
    mockJournal.revalidate.mockImplementation(async () => {
      events.push('revalidate');
      if (kind === 'deadline') mono += 90000;
      else wall--;
    });
    await expect(prepareRailgunAccountRelayIntent(account, f.owners, f.request)).rejects.toThrow();
    expect(account.view).toBe(old);
    await account.close();
  }
);
test('relay first receipt consumption is a real barrier and cancellation drains it', async () => {
  const f = relayFixture(),
    account = await f.opened(),
    old = account.view;
  let release;
  mockCoverage.read.mockImplementation(async (receipt) => {
    if (receipt === f.receipts.first)
      await new Promise((r) => {
        release = r;
      });
    return f.coverage;
  });
  const work = prepareRailgunAccountRelayIntent(account, f.owners, f.request);
  work.catch(() => {});
  await waitRelay(() => !!release);
  expect(mockRunner.reconstructRelayReadOnly).not.toHaveBeenCalled();
  expect(mockJournal.revalidate).not.toHaveBeenCalled();
  expect(account.view).toBe(old);
  let closed = false;
  const closing = account.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await expect(work).rejects.toThrow();
  await closing;
});

test.each(['quote', 'first', 'second'])(
  'caller abort retains relay %s ownership until original work settles',
  async (stage) => {
    const f = relayFixture(),
      account = await f.opened();
    let release;
    const target =
      stage === 'quote'
        ? f.verify
        : stage === 'first'
          ? mockRunner.prepareRelayReadOnly
          : mockRunner.reconstructRelayReadOnly;
    const original = target.getMockImplementation();
    target.mockImplementation(async (input) => {
      await new Promise((r) => {
        release = r;
      });
      return original(input);
    });
    let finished = false;
    const work = prepareRailgunAccountRelayIntent(account, f.owners, f.request).finally(() => {
      finished = true;
    });
    work.catch(() => {});
    await waitRelay(() => !!release);
    f.abort.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() =>
      require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(account, f.owners)
    ).toThrow();
    release();
    await expect(work).rejects.toThrow();
    expect(account.signal.aborted).toBe(stage !== 'quote');
    await account.close();
  }
);
test.each(['prepare', 'operate'])(
  'legacy account %s route refuses the relay kind before any callback or runner work',
  async (route) => {
    const f = relayFixture(),
      account = await f.opened(),
      callback = jest.fn();
    const request = {
      kind: 'railgun-relay-self-transfer',
      noteId: f.request.noteId,
      recipient: f.owned.read.instanceId,
    };
    const pending =
      route === 'prepare'
        ? prepareRailgunAccountPrivateIntent(account, f.owners, request)
        : operateRailgunAccountPrivateIntent(account, f.owners, request, {
            onIntent: callback,
            proverArchive: '/unused',
            artifactDirectory: '/unused',
          });
    await expect(pending).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(mockRunner.prepareReadOnly).not.toHaveBeenCalled();
    expect(mockRunner.prepareRelayReadOnly).not.toHaveBeenCalled();
    await account.close();
  }
);

// Source model of railgun-scan-coordinator.withPublicSnapshot/assertSnapshot:
// busy rejects all tokens, prior evidence is invalidated before callback, and
// callback signal aborts before the fresh evidence token is returned.
test('relay coordinator rotates evidence across busy callback and aborted completed window', async () => {
  const f = relayFixture();
  let busy = false,
    token,
    windows = 0,
    successfulAssertions = 0;
  const callbackSignals = [];
  options.coordinator.assertSnapshot = (candidate) => {
    if (busy) throw Error('coordinator busy');
    if (!token || candidate !== token) throw Error('stale snapshot evidence');
    successfulAssertions++;
    return {};
  };
  options.coordinator.withPublicSnapshot = async (run) => {
    if (busy) throw Error('coordinator busy');
    busy = true;
    token = undefined;
    const window = new AbortController();
    callbackSignals.push(window.signal);
    let value;
    try {
      value = await run({
        checkpoint: {},
        signal: window.signal,
        dispatch: async () => {
          throw Error('unexpected read in token-only test');
        },
      });
    } finally {
      window.abort();
      busy = false;
    }
    token = Object.freeze({ window: ++windows });
    return { value, evidence: token };
  };
  const account = await f.opened();
  const priorToken = token,
    before = successfulAssertions;
  const result = await prepareRailgunAccountRelayIntent(account, f.owners, f.request);
  expect(windows).toBe(2);
  expect(mockRunner.prepareRelayReadOnly).toHaveBeenCalledTimes(1);
  expect(mockRunner.reconstructRelayReadOnly).toHaveBeenCalledTimes(1);
  expect(callbackSignals.every((signal) => signal.aborted)).toBe(true);
  expect(() => options.coordinator.assertSnapshot(priorToken)).toThrow('stale');
  expect(options.coordinator.assertSnapshot(token)).toEqual({});
  expect(successfulAssertions).toBeGreaterThan(before);
  expect(result.view).toBe(account.view);
  await account.close();
});

const { reviewRailgunAccountRelayIntent: reviewRelay } = require('./railgun-account-wallet');
function reviewedRelayFixture() {
  const f = relayFixture();
  mockCheckpointHash = (value) =>
    require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  f.owned.checkpointHash = mockCheckpointHash({});
  return f;
}
test.each([true, false, 'async-true', 'async-false'])(
  'review %s reauthenticates state before publishing, then releases handoff before close',
  async (value) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    mockRead.mockImplementation(() => ({}));
    let summary;
    const callback = jest.fn((supplied, { signal }) => {
      summary = supplied;
      expect(signal.aborted).toBe(false);
      expect(account.view).toBe(old);
      expect(mockJournal.revalidate).toHaveBeenCalledTimes(1);
      expect(() => readRailgunAccountOwnedNotes(account, f.owners)).toThrow();
      expect(() =>
        require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(account, f.owners)
      ).toThrow();
      return typeof value === 'boolean' ? value : Promise.resolve(value === 'async-true');
    });
    const result = await reviewRelay(account, f.owners, f.request, callback);
    const accepted = value === true || value === 'async-true';
    expect(result.status).toBe(accepted ? 'accepted' : 'declined');
    expect(result.reviewedPreparation).toBe(accepted);
    expect(account.view).not.toBe(old);
    expect(mockJournal.revalidate).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(1);
    if (accepted) {
      expect(result.review.summary).toBe(summary);
      expect(result.preparation.reviewedPreparation).toBe(false);
    } else {
      expect(result.preparation).toBeUndefined();
      expect(result.summaryDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    const handoff = require('./railgun-account-wallet').reserveRailgunAccountWalletHandoff(
      account,
      f.owners
    );
    handoff.release();
    expect(account.signal.aborted).toBe(false);
    await account.close();
  }
);
test.each(['undefined', 'boxed', 'thenable', 'throw', 'reject', 'close-true'])(
  'review refuses %s with sanitized failure',
  async (kind) => {
    const f = reviewedRelayFixture(),
      account = await f.opened();
    const getter = jest.fn(() => {
      throw Error('getter secret');
    });
    const callback = () => {
      if (kind === 'boxed') return new Boolean(true);
      if (kind === 'thenable') return Object.defineProperty({}, 'then', { get: getter });
      if (kind === 'throw') throw Error('callback secret');
      if (kind === 'reject') return Promise.reject(Error('callback secret'));
      if (kind === 'close-true') {
        void account.close().catch(() => {});
        return true;
      }
    };
    await expect(reviewRelay(account, f.owners, f.request, callback)).rejects.toMatchObject({
      code: 'RAILGUN_ACCOUNT_WALLET_REFUSED',
      message: 'Railgun wallet requires recovery',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(account.signal.aborted).toBe(true);
    await account.close();
  }
);
test('held callback retains operation, original close and phase; abort plus late true cannot approve', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  let release,
    entered = false,
    settled = false,
    closed = false;
  const work = reviewRelay(account, f.owners, f.request, (_summary, { signal }) => {
    entered = true;
    expect(signal.aborted).toBe(false);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await waitRelay(() => entered);
  await expect(restoreRailgunAccountWallet(account, f.owners)).rejects.toThrow();
  await expect(reviewRelay(account, f.owners, f.request, () => true)).rejects.toThrow();
  f.abort.abort();
  const drain = account.close().then(() => {
    closed = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(closed).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  release(true);
  await expect(work).rejects.toThrow('Railgun wallet requires recovery');
  await drain;
  expect(closed).toBe(true);
  const nextPhase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  nextPhase.release();
});
test.each(['constructor', 'species'])(
  'unobservable native promise %s retains exclusion without pretending utility failure',
  async (kind) => {
    const f = reviewedRelayFixture(),
      account = await f.opened();
    const original = new Promise(() => {});
    const getter = jest.fn(() => {
      throw Error('observation secret');
    });
    if (kind === 'constructor') Object.defineProperty(original, 'constructor', { get: getter });
    else
      Object.defineProperty(original, 'constructor', {
        value: Object.defineProperty({}, Symbol.species, { get: getter }),
      });
    await expect(reviewRelay(account, f.owners, f.request, () => original)).rejects.toMatchObject({
      code: 'RAILGUN_RELAY_REVIEW_DRAIN_FAILED',
    });
    await expect(account.close()).rejects.toMatchObject({
      code: 'RAILGUN_RELAY_REVIEW_DRAIN_FAILED',
    });
    expect(getter).toHaveBeenCalledTimes(1);
    expect(mockQuarantine).not.toHaveBeenCalled();
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
    await expect(restoreRailgunAccountWallet(account, f.owners)).rejects.toThrow();
  }
);
test('native promise overridden methods are unused and fulfillment is boxed without then assimilation', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  const getter = jest.fn(() => {
    throw Error('then read');
  });
  const original = Promise.resolve(true);
  Object.defineProperty(original, 'then', { get: getter });
  Object.defineProperty(original, 'catch', { get: getter });
  expect((await reviewRelay(account, f.owners, f.request, () => original)).status).toBe('accepted');
  expect(getter).not.toHaveBeenCalled();
  await account.close();
});
test.each(['state', 'journal', 'owned', 'generation', 'clock', 'elapsed'])(
  'review post-callback %s drift refuses before publishing',
  async (kind) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    // Freeze the pre-callback wall clock so a one-millisecond rollback cannot
    // accidentally equal a prior reading after real scheduling time elapses.
    if (kind === 'clock') jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    const callback = () => {
      if (kind === 'state')
        mockSession.inspectWalletState.mockResolvedValue({
          storeId: generation.storeId,
          state: 'changed',
        });
      if (kind === 'journal') mockJournal.revalidate.mockRejectedValue(Error('changed journal'));
      if (kind === 'owned') f.owned.read.received[0].amount = 999n;
      if (kind === 'generation') generation = { ...generation, id: 'f'.repeat(64) };
      if (kind === 'clock') jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 1);
      if (kind === 'elapsed')
        jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
      return true;
    };
    await expect(reviewRelay(account, f.owners, f.request, callback)).rejects.toThrow();
    expect(account.view).toBe(old);
    await account.close();
  }
);
test('review callback validation and tighter initial margin occur before jobs or handoff', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  expect(() => reviewRelay(account, f.owners, f.request, true)).toThrow();
  f.fields.feeExpiration = Date.now() + 110000;
  f.request.quote.data = Buffer.from(JSON.stringify(f.fields)).toString('hex');
  await expect(reviewRelay(account, f.owners, f.request, () => true)).rejects.toThrow();
  expect(f.verify).not.toHaveBeenCalled();
  expect(account.signal.aborted).toBe(false);
  await account.close();
});

test('fulfilled native value with a late then getter is inspected without assimilation', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  const value = {},
    original = Promise.resolve(value);
  const getter = jest.fn(() => {
    throw Error('late assimilation');
  });
  Object.defineProperty(value, 'then', { get: getter });
  await expect(reviewRelay(account, f.owners, f.request, () => original)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await account.close();
});
test.each(['inspect', 'journal'])(
  'review deadline includes pending final %s and drains it before close',
  async (step) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    let release,
      original,
      settled = false,
      closed = false;
    const work = reviewRelay(account, f.owners, f.request, () => {
      const method = step === 'inspect' ? mockSession.inspectWalletState : mockJournal.revalidate;
      original = method.getMockImplementation();
      method.mockImplementationOnce(
        (...args) =>
          new Promise((resolve, reject) => {
            release = () => Promise.resolve(original(...args)).then(resolve, reject);
          })
      );
      return false;
    });
    work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await waitRelay(() => !!release);
    jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
    const drain = account.close().then(() => {
      closed = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    release();
    await expect(work).rejects.toThrow();
    await drain;
    expect(account.view).toBe(old);
  }
);
test.each(['inspect', 'journal'])(
  'late final %s settlement checks time without relying on timer delivery',
  async (step) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    const work = reviewRelay(account, f.owners, f.request, () => {
      const method = step === 'inspect' ? mockSession.inspectWalletState : mockJournal.revalidate;
      const original = method.getMockImplementation();
      method.mockImplementationOnce(async (...args) => {
        const value = await original(...args);
        jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
        return value;
      });
      return true;
    });
    await expect(work).rejects.toThrow();
    expect(account.view).toBe(old);
    await account.close();
  }
);
test('review preparation still has a 90 second cap despite 120 second overall cap', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  const original = mockRunner.reconstructRelayReadOnly.getMockImplementation();
  mockRunner.reconstructRelayReadOnly.mockImplementation(async (...args) => {
    const value = await original(...args);
    jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 90001);
    return value;
  });
  const callback = jest.fn(() => true);
  await expect(reviewRelay(account, f.owners, f.request, callback)).rejects.toThrow();
  expect(callback).not.toHaveBeenCalled();
  await account.close();
});
test('post-review reauthentication uses the renewed coordinator token', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  const originalSnapshot = options.coordinator.withPublicSnapshot;
  let latest;
  options.coordinator.withPublicSnapshot = async (run) => {
    const result = await originalSnapshot(run);
    latest = result.evidence;
    const previous = options.coordinator.assertSnapshot;
    options.coordinator.assertSnapshot = (token) => {
      expect(token).toBe(latest);
      return previous(token);
    };
    return result;
  };
  const result = await reviewRelay(account, f.owners, f.request, () => true);
  expect(result.status).toBe('accepted');
  expect(mockJournal.revalidate.mock.calls[1][0].snapshot).toBe(latest);
  await account.close();
});

test('a callback that invalidates time before returning its pending promise is still drained', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  let release,
    entered = false,
    settled = false,
    closed = false;
  const work = reviewRelay(account, f.owners, f.request, () => {
    entered = true;
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 1);
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await waitRelay(() => entered);
  const drain = account.close().then(() => {
    closed = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(closed).toBe(false);
  release(true);
  await expect(work).rejects.toThrow();
  await drain;
});

const {
  operateRailgunAccountRelayIntent: continueRelay,
  assertRailgunAccountRelayWindow: assertRelayWindow,
  retainRailgunRelayWindowPoi: retainRelayPoi,
} = require('./railgun-account-wallet');
test.each(['normal', 'throwing-close', 'rejected-barrier'])(
  'relay continuation retains the original POI drain after an early handler return: %s',
  async (mode) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      operation = Object.freeze({});
    let release,
      reject,
      done = false,
      closed = false;
    const original = new Promise((resolve, no) => {
      release = resolve;
      reject = no;
    });
    const stop = jest.fn(() => {
      if (mode === 'throwing-close') throw Error('close failed');
    });
    // The source issuer is mocked here; account-poi tests exercise its genuine
    // WeakMap registration and exact original lifetime projection separately.
    mockRelayPoiLifetime.mockImplementation((value, wallet, owners, window) => {
      expect(value).toBe(operation);
      expect(wallet).toBe(account);
      expect(owners).toBe(f.owners);
      assertRelayWindow(window, account, owners);
      return Object.freeze({ close: stop, closed: original });
    });
    const work = continueRelay(account, f.owners, f.request, {
      review: () => true,
      onPrepared: (_offer, { window }) => retainRelayPoi(window, account, f.owners, operation),
    });
    work.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      }
    );
    await waitRelay(() => stop.mock.calls.length > 0);
    const drain = account.close();
    drain.then(
      () => {
        closed = true;
      },
      () => {
        closed = true;
      }
    );
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(done).toBe(false);
    expect(closed).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
    if (mode === 'rejected-barrier') reject(Error('source exit unobserved'));
    else release();
    if (mode === 'normal') {
      await work;
      await drain;
      claimRailgunAccountPhase(mockEnrollment, 'recovery').release();
    } else {
      await expect(work).rejects.toThrow();
      await expect(drain).rejects.toMatchObject({
        code: 'RAILGUN_RELAY_CONTINUATION_DRAIN_FAILED',
      });
      expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
    }
  }
);
test('relay window refuses an unregistered source before retaining caller work', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  await continueRelay(account, f.owners, f.request, {
    review: () => true,
    onPrepared: (_offer, { window }) => {
      expect(() =>
        retainRelayPoi(window, account, f.owners, { closed: Promise.resolve() })
      ).toThrow();
    },
  });
  await account.close();
});
test.each(['sync', 'async'])(
  'pre-key continuation %s retains owner and never grants signing',
  async (mode) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    let retained;
    const onPrepared = jest.fn((offer, { signal, window }) => {
      retained = window;
      const facts = assertRelayWindow(window, account, f.owners, 1);
      expect(facts.draftDigest).toBe(offer.preparation.digest);
      expect(facts.summaryDigest).toBe(offer.review.summaryDigest);
      expect(facts.signal).toBe(signal);
      expect(facts.owned.checkpointHash).toBe(facts.checkpointHash);
      expect(facts.owned.read.received.some((note) => note.id === f.request.noteId)).toBe(true);
      expect(facts.signingEnabled).toBe(false);
      expect(facts.proofAuthority).toBe(false);
      expect(signal.aborted).toBe(false);
      expect(Object.isFrozen(offer)).toBe(true);
      expect(Object.keys(window)).toEqual([]);
      expect(account.view).toBe(old);
      expect(() => readRailgunAccountOwnedNotes(account, f.owners)).toThrow();
      expect(() => claimRailgunAccountPhase(mockEnrollment, 'txid')).toThrow();
      expect(() => assertRelayWindow({}, account, f.owners)).toThrow();
      expect(() => assertRelayWindow(window, account, { ...f.owners, identity: {} })).toThrow();
      expect(() => assertRelayWindow(window, account, f.owners, 120000)).toThrow();
      return mode === 'async' ? Promise.resolve() : undefined;
    });
    const result = await continueRelay(account, f.owners, f.request, {
      review: () => true,
      onPrepared,
    });
    expect(result.status).toBe('continued-pre-key');
    expect(result.signingEnabled).toBe(false);
    expect(result.poiQueriesPermitted).toBe(false);
    expect(result.capsulePersisted).toBe(false);
    expect(result.relaySendPermitted).toBe(false);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(mockJournal.revalidate).toHaveBeenCalledTimes(3);
    expect(() => assertRelayWindow(retained, account, f.owners)).toThrow();
    await account.close();
  }
);
test('declined continuation never calls the prepared handler', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened(),
    onPrepared = jest.fn();
  expect(
    (await continueRelay(account, f.owners, f.request, { review: () => false, onPrepared })).status
  ).toBe('declined');
  expect(onPrepared).not.toHaveBeenCalled();
  await account.close();
});
test('continuation captures exact handler descriptors without getters or proxies', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened(),
    getter = jest.fn(),
    onPrepared = jest.fn();
  const bad = { review: () => true };
  Object.defineProperty(bad, 'onPrepared', { enumerable: true, get: getter });
  expect(() => continueRelay(account, f.owners, f.request, bad)).toThrow();
  expect(() =>
    continueRelay(
      account,
      f.owners,
      f.request,
      new Proxy({ review: () => true, onPrepared }, { ownKeys: getter })
    )
  ).toThrow();
  expect(() =>
    continueRelay(account, f.owners, f.request, {
      review: () => true,
      onPrepared,
      markLocal: () => {},
    })
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const operation = {
    review: () => {
      operation.onPrepared = () => {
        throw Error('alias');
      };
      return true;
    },
    onPrepared,
  };
  await continueRelay(account, f.owners, f.request, operation);
  expect(onPrepared).toHaveBeenCalledTimes(1);
  await account.close();
});
test('held prepared original retains close and phase after cancellation', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  let release,
    window,
    done = false,
    closed = false;
  const work = continueRelay(account, f.owners, f.request, {
    review: () => true,
    onPrepared: (_offer, value) => {
      window = value.window;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await waitRelay(() => !!release);
  await expect(restoreRailgunAccountWallet(account, f.owners)).rejects.toThrow();
  f.abort.abort();
  expect(() => assertRelayWindow(window, account, f.owners)).toThrow();
  const drain = account.close().then(() => {
    closed = true;
  });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(done).toBe(false);
  expect(closed).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  release();
  await expect(work).rejects.toThrow();
  await drain;
  expect(closed).toBe(true);
  claimRailgunAccountPhase(mockEnrollment, 'recovery').release();
});
test('original preparation callback outlives coordinator cancellation race and blocks owner release', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  const snapshot = options.coordinator.withPublicSnapshot;
  let cancel,
    release,
    closed = false,
    done = false;
  options.coordinator.withPublicSnapshot = (use) =>
    Promise.race([
      snapshot(use),
      new Promise((_resolve, reject) => {
        cancel = reject;
      }),
    ]);
  const read = mockCoverage.read.getMockImplementation();
  mockCoverage.read.mockImplementationOnce(async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return read(...args);
  });
  const handler = jest.fn();
  const work = continueRelay(account, f.owners, f.request, {
    review: () => true,
    onPrepared: handler,
  });
  work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await waitRelay(() => !!release);
  cancel(Error('coordinator cancellation'));
  for (let i = 0; i < 15; i++) await Promise.resolve();
  const drain = account.close().then(() => {
    closed = true;
  });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(done).toBe(false);
  expect(closed).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
  release();
  await expect(work).rejects.toThrow();
  await drain;
  expect(handler).not.toHaveBeenCalled();
  claimRailgunAccountPhase(mockEnrollment, 'recovery').release();
});
test.each(['quote', 'deadline', 'identity', 'generation'])(
  'prepared continuation %s drift refuses and closes without publishing',
  async (kind) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      old = account.view;
    let windowRefused = false;
    const work = continueRelay(account, f.owners, f.request, {
      review: () => true,
      onPrepared: (_offer, { window }) => {
        assertRelayWindow(window, account, f.owners);
        if (kind === 'quote') jest.spyOn(Date, 'now').mockReturnValue(f.fields.feeExpiration + 1);
        if (kind === 'deadline')
          jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
        if (kind === 'identity')
          mockIdentity.descriptor = { ...mockIdentity.descriptor, accountIndex: 1 };
        if (kind === 'generation') generation.id = 'f'.repeat(64);
        try {
          assertRelayWindow(window, account, f.owners);
        } catch {
          windowRefused = true;
        }
      },
    });
    await expect(work).rejects.toThrow();
    expect(windowRefused).toBe(true);
    expect(account.view).toBe(old);
    await account.close();
  }
);
test('prepared continuation does not renew the review deadline', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  let now = performance.now();
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  await expect(
    continueRelay(account, f.owners, f.request, {
      review: () => {
        now += 29000;
        return true;
      },
      onPrepared: (_offer, { window }) => {
        const data = assertRelayWindow(window, account, f.owners);
        expect(data.deadline - now).toBeLessThanOrEqual(1000);
        now += 1001;
      },
    })
  ).rejects.toThrow();
  await account.close();
});
test.each(['constructor', 'thenable'])(
  'unobservable prepared %s retains phase without invoking caller hooks',
  async (kind) => {
    const f = reviewedRelayFixture(),
      account = await f.opened(),
      getter = jest.fn(() => {
        throw Error('unknown');
      });
    const value = kind === 'constructor' ? Promise.resolve() : {};
    Object.defineProperty(value, kind === 'constructor' ? 'constructor' : 'then', { get: getter });
    await expect(
      continueRelay(account, f.owners, f.request, { review: () => true, onPrepared: () => value })
    ).rejects.toThrow();
    await expect(account.close()).rejects.toMatchObject({
      code: 'RAILGUN_RELAY_CONTINUATION_DRAIN_FAILED',
    });
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'recovery')).toThrow();
    expect(getter).toHaveBeenCalledTimes(kind === 'constructor' ? 1 : 0);
  }
);
test('prepared promise intrinsic observation ignores overridden then and drains late invalidation', async () => {
  const f = reviewedRelayFixture(),
    account = await f.opened();
  let release,
    entered = false,
    done = false;
  const original = new Promise((resolve) => {
    release = resolve;
  });
  original.then = jest.fn(() => {
    throw Error('override');
  });
  const work = continueRelay(account, f.owners, f.request, {
    review: () => true,
    onPrepared: () => {
      entered = true;
      jest.spyOn(performance, 'now').mockReturnValue(performance.now() + 30001);
      return original;
    },
  });
  work.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await waitRelay(() => entered);
  expect(original.then).not.toHaveBeenCalled();
  expect(done).toBe(false);
  release();
  await expect(work).rejects.toThrow();
  await account.close();
});
