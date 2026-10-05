let mockEnrollment, mockIdentity, mockSession, mockCoverage, mockJournal, mockRunner, mockView;
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
  checkpointHash: (value) => JSON.stringify(value),
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
  restoreRailgunAccountWallet,
  recoverRailgunAccountPrivateProof,
  prepareRailgunAccountPrivateIntent,
  operateRailgunAccountPrivateIntent,
  assertRailgunAccountPrivateWindow,
} = require('./railgun-account-wallet');
let scope, options, directory, generation, events, state;
beforeEach(() => {
  jest.clearAllMocks();
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
