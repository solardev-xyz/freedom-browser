let mockEnrollment, mockCoordinator, mockGeneration, mockDestination, mockOutcomes;
const mockCollect = jest.fn(),
  mockTransactCollect = jest.fn();
let canonicalAt;
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublic: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mockCoordinator ||
      enrollment !== mockEnrollment ||
      (policy && policy !== 'policy')
    )
      throw Error('owner');
    return 'policy';
  },
  assertRailgunAccountPublicDestination: (coordinator, enrollment, destination) => {
    if (
      coordinator !== mockCoordinator ||
      enrollment !== mockEnrollment ||
      destination !== mockDestination
    )
      throw Error('destination');
    return destination;
  },
  getRailgunAccountPublicIdentity: () =>
    Object.freeze({ generationId: mockGeneration, sourceId: 'source', publicId: 'public' }),
}));
jest.mock('./railgun-scan-coordinator', () => ({
  getRailgunCompletedSnapshotOutcome: (coordinator, error) => {
    if (coordinator !== mockCoordinator || !mockOutcomes.has(error))
      throw Error('unauthenticated outcome');
    return mockOutcomes.get(error);
  },
}));
jest.mock('./railgun-poi-source-evidence', () => ({
  collectRailgunPoiSourceEvidence: (...args) => mockCollect(...args),
  collectRailgunPoiTransactSourceEvidence: (...args) => mockTransactCollect(...args),
}));
jest.mock('./railgun-wallet-coverage', () => ({
  checkpointHash: (value) => JSON.stringify(value),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  captureRailgunPoiSource: capture,
  captureRailgunPoiSourceCompleted: captureCompleted,
  assertRailgunPoiSource: attest,
} = require('./railgun-poi-source-capture');
let scope, controller, publicController, input, ready, finalize, deferred, mode, captures;
beforeEach(() => {
  jest.clearAllMocks();
  mode = 'valid';
  canonicalAt = undefined;
  deferred = false;
  ready = null;
  finalize = undefined;
  captures = [];
  mockGeneration = 'generation';
  mockDestination = Object.freeze({});
  mockOutcomes = new WeakMap();
  controller = new AbortController();
  publicController = new AbortController();
  scope = createPrivacyScope({ profileId: 'source-capture', signal: new AbortController().signal });
  mockEnrollment = {
    signal: scope.signal,
    getContext: (role) =>
      scope.getContext({
        kind: 'private-account',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        principal: 'railgun:0',
        role,
      }),
  };
  mockCoordinator = {
    signal: publicController.signal,
    withPublicSnapshot: jest.fn(async (run) => {
      ready = null;
      const value = await run({
        checkpoint: { version: 1, source: { ledgerId: 'source' } },
        signal: publicController.signal,
        visitSource: async (visit) => {
          await visit({});
          return { count: 1, bytes: 3 };
        },
      });
      if (deferred)
        await new Promise((resolve) => {
          finalize = resolve;
        });
      if (mode === 'suffix') throw Error('final authentication failed');
      ready = Object.freeze({});
      return { value, evidence: ready };
    }),
    assertSnapshot: jest.fn((token) => {
      if (
        !ready ||
        token !== ready ||
        mode === 'snapshot' ||
        (canonicalAt !== undefined && performance.now() - canonicalAt >= 60000)
      )
        throw Error('stale');
      return {
        version: mode === 'checkpoint' ? 2 : 1,
        source: { ledgerId: mode === 'ledger' ? 'wrong' : 'source' },
      };
    }),
  };
  const snapshotImpl = mockCoordinator.withPublicSnapshot.getMockImplementation();
  mockCoordinator.withCompletedPublicSnapshot = jest.fn(async (options, run) => {
    expect(options.destination).toBe(mockDestination);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return snapshotImpl(run);
  });
  mockCoordinator.recover = jest.fn(() => {
    throw Error('implicit recovery');
  });
  mockCollect.mockImplementation(async ({ checkpoint, visit, assertCurrent }) => {
    assertCurrent();
    await visit(() => {});
    assertCurrent();
    return Object.freeze({
      checkpointHash: JSON.stringify(checkpoint),
      sourceAuthenticated: false,
      creatorHashCompared: false,
      ownershipAuthenticated: false,
      currentCanonicalityVerified: false,
      spendingEnabled: false,
    });
  });
  mockTransactCollect.mockImplementation((...args) => mockCollect(...args));
  input = {
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    capsule: { noteHash: 'fixed', selection: { tree: 0, position: 1 } },
    record: { hash: 'fixed' },
    transaction: { input: 'fixed' },
    receipt: { logs: [] },
    signal: controller.signal,
  };
});
afterEach(() => {
  captures.forEach((value) => value.close());
  controller.abort();
  publicController.abort();
  scope.close();
  jest.useRealTimers();
});
const start = async (options) => {
  const result = await capture(options ?? input);
  captures.push(result);
  return result;
};
test('mints genuine source-only evidence after final snapshot assertion', async () => {
  const result = await start();
  expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
  expect(result.observation).toMatchObject({
    sourceAuthenticated: true,
    creatorHashCompared: false,
    ownershipAuthenticated: false,
    currentCanonicalityVerified: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(result.observation)).toBe(true);
  expect(Object.isFrozen(result.observation.publicIdentity)).toBe(true);
  for (const [receipt, enrollment, coordinator] of [
    [{}, mockEnrollment, mockCoordinator],
    [JSON.parse(JSON.stringify(result.receipt)), mockEnrollment, mockCoordinator],
    [result.receipt, {}, mockCoordinator],
    [result.receipt, mockEnrollment, {}],
  ])
    expect(() => attest(receipt, enrollment, coordinator)).toThrow();
  ready = null;
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
});
test.each(['suffix', 'snapshot', 'checkpoint', 'ledger'])(
  'refuses %s failure without issuing evidence',
  async (value) => {
    mode = value;
    await expect(start()).rejects.toMatchObject({ code: 'RAILGUN_POI_SOURCE_CAPTURE_REFUSED' });
  }
);
test('a semantic refusal completes the snapshot and permits a later capture', async () => {
  mockCollect.mockRejectedValueOnce(Error('mismatched caller capsule'));
  await expect(start()).rejects.toMatchObject({ code: 'RAILGUN_POI_SOURCE_CAPTURE_REFUSED' });
  expect(ready).not.toBeNull();
  expect(publicController.signal.aborted).toBe(false);
  const result = await start();
  expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
});
test.each(['caller', 'coordinator', 'enrollment', 'close', 'timeout', 'generation'])(
  'revokes existing evidence on %s',
  async (value) => {
    jest.useFakeTimers();
    const result = await start({ ...input, timeoutMs: 20 });
    if (value === 'caller') controller.abort();
    if (value === 'coordinator') publicController.abort();
    if (value === 'enrollment') scope.close();
    if (value === 'close') result.close();
    if (value === 'timeout') await jest.advanceTimersByTimeAsync(21);
    if (value === 'generation') mockGeneration = 'other';
    expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
  }
);
test.each(['success', 'caller', 'timeout'])(
  'waits for snapshot completion after %s and holds capture exclusion',
  async (value) => {
    jest.useFakeTimers();
    deferred = true;
    let settled = false;
    const outcome = start({ ...input, timeoutMs: 20 }).then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        return error;
      }
    );
    for (let n = 0; n < 12; n++) await Promise.resolve();
    expect(finalize).toEqual(expect.any(Function));
    expect(settled).toBe(false);
    expect(mockCoordinator.assertSnapshot).not.toHaveBeenCalled();
    if (value === 'caller') controller.abort();
    if (value === 'timeout') await jest.advanceTimersByTimeAsync(21);
    const competitor = { ...input, signal: new AbortController().signal };
    await expect(capture(competitor)).rejects.toThrow();
    expect(mockCoordinator.withPublicSnapshot).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finalize();
    const result = await outcome;
    if (value === 'success') expect(result.observation.sourceAuthenticated).toBe(true);
    else expect(result.code).toBe('RAILGUN_POI_SOURCE_CAPTURE_REFUSED');
    deferred = false;
    const next = await start(competitor);
    expect(next.observation.sourceAuthenticated).toBe(true);
    expect(mockCoordinator.withPublicSnapshot).toHaveBeenCalledTimes(2);
  }
);
test('copies supplied capsule before the first asynchronous snapshot work', async () => {
  const original = mockCoordinator.withPublicSnapshot.getMockImplementation();
  mockCoordinator.withPublicSnapshot.mockImplementation(async (run) => {
    input.record.hash = 'changed';
    input.receipt.logs.push('changed');
    input.transaction.input = 'changed';
    input.capsule.noteHash = 'changed';
    input.capsule.selection.position = 99;
    return original(run);
  });
  await start();
  const captured = mockCollect.mock.calls[0][0];
  expect(captured.capsule).toEqual({ noteHash: 'fixed', selection: { tree: 0, position: 1 } });
  expect(captured.record.hash).toBe('fixed');
  expect(captured.transaction.input).toBe('fixed');
  expect(captured.receipt.logs).toEqual([]);
});
test('refuses forged owners and already-cancelled requests before snapshot entry', async () => {
  await expect(capture({ ...input, coordinator: {} })).rejects.toThrow();
  await expect(capture({ ...input, enrollment: {} })).rejects.toThrow();
  controller.abort();
  await expect(capture(input)).rejects.toThrow();
  expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
});

const startCompleted = async (overrides = {}) => {
  const result = await captureCompleted({ ...input, destination: mockDestination, ...overrides });
  if (result.close) captures.push(result);
  return result;
};
test('completed capture uses only the fixed snapshot entry and mints the same restricted receipt', async () => {
  const result = await startCompleted();
  expect(result.status).toBe('captured');
  expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
  expect(result.observation).toMatchObject({
    sourceAuthenticated: true,
    ownershipAuthenticated: false,
    currentCanonicalityVerified: false,
    spendingEnabled: false,
  });
  expect(mockCoordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
  expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
  expect(mockCoordinator.recover).not.toHaveBeenCalled();
  expect(mockCoordinator.withCompletedPublicSnapshot.mock.calls[0][0].timeoutMs).toBeGreaterThan(0);
  expect(
    mockCoordinator.withCompletedPublicSnapshot.mock.calls[0][0].timeoutMs
  ).toBeLessThanOrEqual(45000);
});
test.each([undefined, {}, null])(
  'completed capture rejects missing/copied destination %# before snapshot',
  async (destination) => {
    expect(await startCompleted({ destination })).toMatchObject({
      status: 'refused',
      stage: 'context',
    });
    expect(mockCoordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
    expect(mockCollect).not.toHaveBeenCalled();
  }
);
test.each(['destination', 'generation', 'coordinator', 'enrollment'])(
  'completed receipt refuses %s replacement after capture',
  async (kind) => {
    const result = await startCompleted();
    const enrollment = mockEnrollment,
      coordinator = mockCoordinator;
    if (kind === 'destination') mockDestination = Object.freeze({});
    if (kind === 'generation') mockGeneration = 'reopened-generation';
    if (kind === 'coordinator') mockCoordinator = { ...coordinator };
    if (kind === 'enrollment') mockEnrollment = { ...enrollment };
    expect(() => attest(result.receipt, enrollment, coordinator)).toThrow();
  }
);
test('completed semantic mismatch returns data, leaves coordinator healthy and permits later capture', async () => {
  mockCollect.mockRejectedValueOnce(Error('wrong capsule semantics'));
  const refused = await startCompleted();
  expect(refused).toEqual({ status: 'refused', stage: 'match' });
  expect(publicController.signal.aborted).toBe(false);
  expect(ready).not.toBeNull();
  expect((await startCompleted()).status).toBe('captured');
  expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
});
test.each([false, true])(
  'only authenticated completed-snapshot error propagates fatal=%s diagnostic',
  async (fatal) => {
    const error = Object.assign(Error('private diagnostic'), {
      code: 'RAILGUN_SCAN_COORDINATOR_REFUSED',
    });
    const outcome = Object.freeze({
      fatal,
      reason: fatal ? 'fatal' : 'checkpoint-unavailable',
      rpcFailure: fatal ? 'response' : null,
    });
    mockOutcomes.set(error, outcome);
    mockCoordinator.withCompletedPublicSnapshot.mockRejectedValueOnce(error);
    const result = await startCompleted();
    expect(result).toEqual({ status: 'refused', stage: 'snapshot', sourceOutcome: outcome });
    expect(Object.isFrozen(result.sourceOutcome)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  }
);
test('copied public error fields cannot manufacture a source outcome', async () => {
  const error = Object.assign(Error('private diagnostic'), {
    code: 'RAILGUN_SCAN_COORDINATOR_REFUSED',
    sourceOutcome: { fatal: false, reason: 'cancelled', rpcFailure: null },
  });
  mockCoordinator.withCompletedPublicSnapshot.mockRejectedValueOnce(error);
  expect(await startCompleted()).toEqual({ status: 'refused', stage: 'snapshot' });
});
test('completed capture drains held final authentication after cancellation and retains exclusion', async () => {
  deferred = true;
  let settled = false;
  const pending = startCompleted().then((result) => {
    settled = true;
    return result;
  });
  try {
    for (let n = 0; n < 30 && !finalize; n++) await Promise.resolve();
    expect(finalize).toEqual(expect.any(Function));
    controller.abort();
    expect((await startCompleted({ signal: new AbortController().signal })).status).toBe('refused');
    expect(mockCoordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    finalize?.();
  }
  expect((await pending).status).toBe('refused');
  deferred = false;
  expect((await startCompleted({ signal: new AbortController().signal })).status).toBe('captured');
});
test('generation drift during completed collection cannot produce a source receipt', async () => {
  const original = mockCollect.getMockImplementation();
  mockCollect.mockImplementationOnce(async (options) => {
    const result = await original(options);
    mockGeneration = 'changed';
    return result;
  });
  expect((await startCompleted()).status).toBe('refused');
  expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
});

const captureTransact =
  require('./railgun-poi-source-capture').captureRailgunPoiSourceForTransactMembership;
const startTransact = async (changes = {}) => {
  const result = await captureTransact({ ...input, destination: mockDestination, ...changes });
  if (result.status === 'captured') captures.push(result);
  return result;
};
test.each([
  [undefined, 180000],
  [235000, 180000],
  [100000, 45000],
  [55001, 1],
])(
  'fixed Transact capture reserves55s from total %s and uses snapshot budget%i',
  async (timeoutMs, budget) => {
    jest.useFakeTimers();
    const result = await startTransact({ timeoutMs });
    expect(result.status).toBe('captured');
    expect(mockTransactCollect).toHaveBeenCalledTimes(1);
    expect(mockCoordinator.withCompletedPublicSnapshot.mock.calls[0][0].timeoutMs).toBe(budget);
    expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
    expect(mockCoordinator.recover).not.toHaveBeenCalled();
    expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
  }
);
test.each([null, false, 0, 55000, 235001, Infinity, NaN, 60000.5])(
  'fixed Transact capture refuses invalid total %p before snapshot work',
  async (timeoutMs) => {
    expect(await startTransact({ timeoutMs })).toEqual({ status: 'refused', stage: 'context' });
    expect(mockCoordinator.withCompletedPublicSnapshot).not.toHaveBeenCalled();
    expect(mockTransactCollect).not.toHaveBeenCalled();
  }
);
test.each(['destination', 'generation'])(
  'fixed Transact capture refuses changed %s after full snapshot completion',
  async (field) => {
    const original = mockTransactCollect.getMockImplementation();
    mockTransactCollect.mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      if (field === 'destination') mockDestination = Object.freeze({});
      else mockGeneration = 'changed';
      return value;
    });
    expect((await startTransact()).status).toBe('refused');
    expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
  }
);
test('fixed Transact capture retains actual canonical age instead of promising fresh60s at return', async () => {
  jest.useFakeTimers();
  const original = mockTransactCollect.getMockImplementation();
  mockTransactCollect.mockImplementationOnce(async (...args) => {
    await jest.advanceTimersByTimeAsync(120000);
    const value = await original(...args);
    canonicalAt = performance.now();
    await jest.advanceTimersByTimeAsync(20000); // Authenticated snapshot cleanup consumes age.
    return value;
  });
  const result = await startTransact();
  expect(result.status).toBe('captured');
  await jest.advanceTimersByTimeAsync(39999);
  expect(attest(result.receipt, mockEnrollment, mockCoordinator)).toBe(result.observation);
  await jest.advanceTimersByTimeAsync(1);
  expect(() => attest(result.receipt, mockEnrollment, mockCoordinator)).toThrow();
});
test('fixed Transact cancelled snapshot retains exclusion until ignored final authentication drains', async () => {
  deferred = true;
  let settled = false;
  const pending = startTransact().then((value) => {
    settled = true;
    return value;
  });
  try {
    for (let n = 0; n < 30 && !finalize; n++) await Promise.resolve();
    expect(finalize).toEqual(expect.any(Function));
    controller.abort();
    expect(settled).toBe(false);
    expect((await startTransact({ signal: new AbortController().signal })).status).toBe('refused');
    expect(mockCoordinator.withCompletedPublicSnapshot).toHaveBeenCalledTimes(1);
  } finally {
    finalize?.();
  }
  expect((await pending).status).toBe('refused');
  deferred = false;
  expect((await startTransact({ signal: new AbortController().signal })).status).toBe('captured');
});
