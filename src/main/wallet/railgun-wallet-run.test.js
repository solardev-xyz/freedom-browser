let mockDescriptor,
  mockRefuse,
  mockCopy,
  mockCancelledCopy,
  mockInput,
  mockRouter,
  mockTask,
  mockFailure,
  mockOperationMode,
  mockReply,
  mockAbortJob,
  mockActualCapsule;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-private-capsule', () => ({
  normalizeRailgunNewCapsule: (value, owned) => {
    if (mockActualCapsule)
      return jest
        .requireActual('./railgun-private-capsule')
        .normalizeRailgunNewCapsule(value, owned);
    expect(value).toEqual({ recovery: true });
    expect(owned.walletId).toBe(mockDescriptor.walletId);
    return Object.freeze(value);
  },
}));
jest.mock('./railgun-private-preparation', () => ({
  normalizeRailgunPrivateOffer: (value, selection) =>
    mockActualCapsule
      ? jest
          .requireActual('./railgun-private-preparation')
          .normalizeRailgunPrivateOffer(value, selection)
      : Object.freeze({ ...value }),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: () => {
    if (mockRefuse) throw Error('identity refused');
    return mockDescriptor;
  },
  withRailgunViewingCredential: async (_identity, use) => {
    const viewingKey = Buffer.alloc(32, 7);
    try {
      mockCopy = await use({ viewingKey });
      if (mockCancelledCopy) throw mockFailure || Error('identity revoked');
      return mockCopy;
    } finally {
      viewingKey.fill(0);
    }
  },
}));
jest.mock('./railgun-wallet-storage', () => ({ createRailgunWalletStorage: () => mockRouter }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockInput = JSON.parse(options.input);
    const controller = new AbortController();
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const failed = new Promise((_resolve, reject) => {
      mockAbortJob = reject;
    });
    const running = (async () => {
      const bytes = await options.broker.dispatch(
        JSON.stringify({
          id: 1,
          method: 'key',
          purpose: mockInput.privateOperation
            ? 'private-operate'
            : mockInput.privateIntent
              ? 'private-prepare'
              : 'wallet-viewing',
        })
      );
      expect(options.binaryKey).toBe(true);
      expect(options.filename).toBe(
        require.resolve(
          mockInput.privateOperation
            ? './railgun-private-operate-job'
            : mockInput.privateIntent
              ? './railgun-private-prepare-job'
              : './railgun-wallet-job'
        )
      );
      expect(bytes.byteLength).toBe(32);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(32);
      expect([...bytes]).toEqual(Array(32).fill(7));
      bytes.fill(0);
      let resultId = 2,
        extra = {};
      if (mockInput.privateOperation && mockOperationMode !== 'early-result') {
        const offer = mockActualCapsule ? mockActualCapsule.preparation : { intent: 'captured' };
        const envelope = {
          preparation: offer,
          capsule: mockActualCapsule || { recovery: mockOperationMode !== 'bad-capsule' },
          ...(mockOperationMode === 'extra-envelope' ? { extra: true } : {}),
        };
        if (mockOperationMode === 'missing-capsule') delete envelope.capsule;
        mockReply = JSON.parse(
          await options.broker.dispatch(
            JSON.stringify({
              id: 2,
              method: 'private-intent',
              value: envelope,
            })
          )
        );
        resultId = 3;
        if (mockOperationMode === 'repeat')
          await options.broker.dispatch(
            JSON.stringify({
              id: 3,
              method: 'private-intent',
              value: envelope,
            })
          );
        if (mockOperationMode === 'late-storage')
          await options.broker.dispatch(JSON.stringify({ id: 3, channel: 'wallet', wire: '{}' }));
        extra = {
          privatePreparation: mockOperationMode === 'substitute' ? { intent: 'other' } : offer,
          privateOperation: { status: mockReply.value.status === 'signed' ? 'proved' : 'refused' },
        };
        if (mockOperationMode === 'wrong-status') extra.privateOperation.status = 'unexpected';
      }
      await options.broker.dispatch(
        JSON.stringify({
          id: resultId,
          method: 'result',
          value: { instanceId: mockDescriptor.instanceId, ...extra },
        })
      );
    })();
    const ready = Promise.race([running, failed]);
    return (mockTask = {
      ready,
      closed,
      signal: controller.signal,
      close: jest.fn(() => {
        controller.abort();
        resolveClosed({ code: 'RAILGUN_PROCESS_CLOSED' });
      }),
    });
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { runRailgunWalletSnapshot } = require('./railgun-wallet-run');
let scope, args;
beforeEach(() => {
  mockActualCapsule = null;
  mockRefuse = false;
  mockCancelledCopy = false;
  mockFailure = null;
  mockOperationMode = mockReply = null;
  mockCopy = mockTask = mockInput = null;
  mockDescriptor = { walletId: '1'.repeat(64), instanceId: '0zk1' + 'q'.repeat(123) };
  scope = createPrivacyScope({ profileId: 'view-run-test', signal: new AbortController().signal });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  mockRouter = { signal: scope.signal, prefixes: {}, assertIdle: jest.fn(), close: jest.fn() };
  args = {
    handle,
    archive: '/fixture.asar',
    identity: { signal: scope.signal },
    snapshot: { checkpoint: {} },
    walletId: mockDescriptor.walletId,
    restore: false,
    walletSession: {},
    walletGrant: {},
  };
});
afterEach(() => scope.close());
test('the viewing key is copied into a dedicated 32-byte backing buffer and never appears in JSON input', async () => {
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
  expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('revocation after making the viewing-key copy wipes it even though no response is delivered', async () => {
  mockCancelledCopy = true;
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    cause: new Error('identity revoked'),
  });
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockTask.close).toHaveBeenCalled();
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('frozen shared revocation reasons stay intact while utility exit is drained', async () => {
  mockCancelledCopy = true;
  mockFailure = Object.freeze(Object.assign(new Error('shared reason'), { code: 'REVOKED' }));
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    cause: mockFailure,
    code: 'REVOKED',
    closed: { code: 'RAILGUN_PROCESS_CLOSED' },
  });
  expect(Object.keys(mockFailure)).toEqual(['code']);
  expect([...mockCopy]).toEqual(Array(32).fill(0));
});
test('a revoked/foreign identity or wrong walletId starts no worker', async () => {
  mockRefuse = true;
  await expect(runRailgunWalletSnapshot(args)).rejects.toThrow('identity refused');
  mockActualCapsule = null;
  mockRefuse = false;
  await expect(runRailgunWalletSnapshot({ ...args, walletId: '2'.repeat(64) })).rejects.toThrow();
  expect(mockTask).toBeNull();
});
test('private preparation uses only the dedicated viewing-key entry and requires restore mode', async () => {
  const privateIntent = {
    kind: 'railgun-token-unshield',
    tree: 0,
    position: 1,
    recipient: '0x' + '12'.repeat(20),
  };
  await expect(runRailgunWalletSnapshot({ ...args, privateIntent })).rejects.toThrow();
  expect(mockTask).toBeNull();
  await runRailgunWalletSnapshot({ ...args, privateIntent, restore: true });
  expect(mockInput.privateIntent).toEqual(privateIntent);
  expect([...mockCopy]).toEqual(Array(32).fill(0));
});
function operation(onIntent = jest.fn(async () => ({ status: 'refused' }))) {
  return {
    ...args,
    restore: true,
    privateIntent: { kind: 'test' },
    privateOperation: {
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
      onIntent,
    },
  };
}
test.each(['refused', 'signed'])(
  'a typed %s operation request uses the exact entry and retains no JSON key',
  async (status) => {
    const signature = {
      R8: ['0x' + '1'.repeat(64), '0x' + '2'.repeat(64)],
      S: '0x' + '0'.repeat(63) + '1',
    };
    const onIntent = jest.fn(async (offer, signal, capsule) => {
      expect(capsule).toEqual({ recovery: true });
      expect(Object.isFrozen(capsule)).toBe(true);
      expect(Object.isFrozen(offer)).toBe(true);
      expect(signal.aborted).toBe(false);
      return status === 'signed' ? { status, signature } : { status };
    });
    const result = await runRailgunWalletSnapshot(operation(onIntent));
    expect(result.privateOperation.status).toBe(status === 'signed' ? 'proved' : 'refused');
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(mockInput.privateOperation).toEqual({
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    });
    expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
    expect(mockTask.signal.aborted).toBe(true);
  }
);
test.each([
  'repeat',
  'late-storage',
  'substitute',
  'wrong-status',
  'early-result',
  'bad-capsule',
  'extra-envelope',
])('operation protocol violation %s refuses and drains', async (mode) => {
  mockOperationMode = mode;
  await expect(runRailgunWalletSnapshot(operation())).rejects.toThrow();
  expect(mockTask.close).toHaveBeenCalled();
  expect(mockRouter.close).toHaveBeenCalled();
});
test('late signature response after task cancellation cannot be delivered', async () => {
  const onIntent = jest.fn(async (_offer, signal) => {
    mockTask.close();
    expect(signal.aborted).toBe(true);
    return { status: 'refused' };
  });
  await expect(runRailgunWalletSnapshot(operation(onIntent))).rejects.toThrow();
  expect(mockReply).toBeNull();
});
test('an exited A does not release its account run before its pending handler has drained', async () => {
  let releaseHandler, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  let settled = false;
  const run = runRailgunWalletSnapshot(
    operation(async (_offer, signal) => {
      entered(signal);
      await pending;
      return { status: 'refused' };
    })
  );
  const observed = run
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  const signal = await started;
  mockTask.close();
  mockAbortJob(Error('A timed out'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(signal.aborted).toBe(true);
  expect(mockRouter.close).toHaveBeenCalled();
  expect(settled).toBe(false);
  releaseHandler();
  expect(await observed).toBeInstanceOf(Error);
  expect(settled).toBe(true);
  expect(mockReply).toBeNull();
});
test.each([
  { status: 'refused', signature: {} },
  { status: 'signed', signature: { R8: [], S: 'key' } },
  { status: 'other' },
])('malformed operation replies are never forwarded (%#)', async (response) => {
  await expect(runRailgunWalletSnapshot(operation(async () => response))).rejects.toThrow();
  expect(mockReply).toBeNull();
});

test.each(['foreign-wallet', 'missing-capsule', 'extra-envelope'])(
  'real capsule validation refuses %s before the authorizer',
  async (mode) => {
    mockActualCapsule = require('../../../scripts/fixtures/railgun-capsule-data').capsule(
      mockDescriptor.walletId
    );
    mockActualCapsule.engineSha256 = require('./railgun-engine-manifest.json').sha256;
    const privateIntent = mockActualCapsule.selection,
      onIntent = jest.fn();
    if (mode === 'foreign-wallet') mockActualCapsule.walletId = 'f'.repeat(64);
    mockOperationMode = mode;
    await expect(
      runRailgunWalletSnapshot({ ...operation(onIntent), privateIntent })
    ).rejects.toThrow();
    expect(onIntent).not.toHaveBeenCalled();
    expect(mockTask.close).toHaveBeenCalled();
  }
);
