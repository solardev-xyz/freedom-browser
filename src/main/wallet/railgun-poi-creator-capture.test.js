let mockEnrollment, mockCoordinator, mockGeneration;
const mockCollect = jest.fn();
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
  getRailgunAccountPublicIdentity: () =>
    Object.freeze({ generationId: mockGeneration, sourceId: 'source', publicId: 'public' }),
}));
jest.mock('./railgun-poi-creator', () => ({
  collectRailgunPoiCreator: (...args) => mockCollect(...args),
}));
jest.mock('./railgun-wallet-coverage', () => ({
  checkpointHash: (value) => JSON.stringify(value),
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  captureRailgunPoiCreator: capture,
  assertRailgunPoiCreator: attest,
} = require('./railgun-poi-creator-capture');
let scope, controller, publicController, input, ready, finalize, deferred, mode, captures;
beforeEach(() => {
  jest.clearAllMocks();
  mode = 'valid';
  deferred = false;
  ready = null;
  captures = [];
  mockGeneration = 'generation';
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
      if (!ready || token !== ready || mode === 'snapshot') throw Error('stale');
      return {
        version: mode === 'checkpoint' ? 2 : 1,
        source: { ledgerId: mode === 'ledger' ? 'wrong' : 'source' },
      };
    }),
  };
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
  input = {
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    capsule: { noteHash: 'fixed', selection: { tree: 0, position: 1 } },
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
    await expect(start()).rejects.toMatchObject({ code: 'RAILGUN_POI_CREATOR_CAPTURE_REFUSED' });
  }
);
test('a semantic refusal completes the snapshot and permits a later capture', async () => {
  mockCollect.mockRejectedValueOnce(Error('mismatched caller capsule'));
  await expect(start()).rejects.toMatchObject({ code: 'RAILGUN_POI_CREATOR_CAPTURE_REFUSED' });
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
    else expect(result.code).toBe('RAILGUN_POI_CREATOR_CAPTURE_REFUSED');
    deferred = false;
    const next = await start(competitor);
    expect(next.observation.sourceAuthenticated).toBe(true);
    expect(mockCoordinator.withPublicSnapshot).toHaveBeenCalledTimes(2);
  }
);
test('copies supplied capsule before the first asynchronous snapshot work', async () => {
  const original = mockCoordinator.withPublicSnapshot.getMockImplementation();
  mockCoordinator.withPublicSnapshot.mockImplementation(async (run) => {
    input.capsule.noteHash = 'changed';
    input.capsule.selection.position = 99;
    return original(run);
  });
  await start();
  const captured = mockCollect.mock.calls[0][0];
  expect(captured.capsule).toEqual({ noteHash: 'fixed', selection: { tree: 0, position: 1 } });
});
test('refuses forged owners and already-cancelled requests before snapshot entry', async () => {
  await expect(capture({ ...input, coordinator: {} })).rejects.toThrow();
  await expect(capture({ ...input, enrollment: {} })).rejects.toThrow();
  controller.abort();
  await expect(capture(input)).rejects.toThrow();
  expect(mockCoordinator.withPublicSnapshot).not.toHaveBeenCalled();
});
