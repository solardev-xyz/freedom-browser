let mockEnrollment, mockIdentity, mockSession, mockCoverage, mockJournal, mockRunner, mockView;
const mockOpenStore = jest.fn(),
  mockCreateJournal = jest.fn(),
  mockRead = jest.fn();
const mockAssertCoordinator = jest.fn();
const mockAssertPublic = jest.fn();
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (...args) => mockAssertPublic(...args),
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'a'.repeat(64) }));
jest.mock('./railgun-scan-coordinator', () => ({
  assertRailgunScanCoordinator: (...args) => mockAssertCoordinator(...args),
}));
jest.mock('./railgun-wallet-policy', () => ({ getRailgunWalletPolicy: () => '2'.repeat(64) }));
jest.mock('./railgun-wallet-coverage', () => ({
  checkpointHash: (value) => JSON.stringify(value),
}));
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
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  openRailgunAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  restoreRailgunAccountWallet,
  prepareRailgunAccountPrivateIntent,
} = require('./railgun-account-wallet');
let scope, options, directory, generation, events, state;
beforeEach(() => {
  jest.clearAllMocks();
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
      withPublicSnapshot: async (run) => ({ value: await run({ checkpoint: {} }), evidence: {} }),
      assertSnapshot: () => ({}),
    },
  };
  generation.policy = options.policy = getRailgunAccountWalletPolicy(options);
});
afterEach(async () => {
  mockSession.close();
  await mockSession.closed;
  scope.close();
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
  finish();
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
    ownedPoi: [{ id: '0:1', nullifier: '0x' + '1'.repeat(64) }],
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
