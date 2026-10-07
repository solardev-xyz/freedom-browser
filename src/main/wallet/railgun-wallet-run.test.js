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
  mockActualCapsule,
  mockWorker,
  mockCredential,
  mockLoan,
  mockBorrow,
  mockResolveClosed,
  mockRejectClosed,
  mockHoldExit,
  mockCloseFailure,
  mockQuarantine;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-private-capsule', () => ({
  normalizeRailgunPrivateCapsule: (value) =>
    jest.requireActual('./railgun-private-capsule').normalizeRailgunPrivateCapsule(value),
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
  quarantineRailgunIdentityCredentials: (identity) => mockQuarantine(identity),
  assertRailgunIdentity: () => {
    if (mockRefuse) throw Error('identity refused');
    return mockDescriptor;
  },
  withRailgunViewingCredential: async (_identity, use) => {
    mockBorrow();
    if (mockCredential) return mockCredential(use);
    const viewingKey = mockLoan ?? Buffer.alloc(32, 7);
    try {
      mockCopy = await use({ viewingKey });
      if (mockCancelledCopy) throw mockFailure || Error('identity revoked');
      return mockCopy;
    } finally {
      if (viewingKey instanceof Uint8Array) viewingKey.fill(0);
    }
  },
}));
jest.mock('./railgun-wallet-storage', () => ({ createRailgunWalletStorage: () => mockRouter }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockInput = JSON.parse(options.input);
    const controller = new AbortController();
    let resolveClosed;
    const closed = new Promise((resolve, reject) => {
      mockResolveClosed = resolveClosed = resolve;
      mockRejectClosed = reject;
    });
    const failed = new Promise((_resolve, reject) => {
      mockAbortJob = reject;
    });
    const running = (async () => {
      if (mockWorker) return mockWorker(options);
      const bytes = await options.broker.dispatch(
        JSON.stringify({
          id: 1,
          method: 'key',
          purpose: mockInput.privateRecovery
            ? 'private-recover'
            : mockInput.privateOperation
              ? 'private-operate'
              : mockInput.privateIntent
                ? 'private-prepare'
                : 'wallet-viewing',
        })
      );
      expect(options.binaryKey).toBeUndefined();
      expect(options.filename).toBeUndefined();
      expect(options.executionJob).toBe(
        mockInput.privateRecovery
          ? 'private-recover'
          : mockInput.privateOperation
            ? 'private-operate'
            : mockInput.privateIntent
              ? 'private-prepare'
              : 'wallet-viewing'
      );
      expect(bytes.byteLength).toBe(32);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(32);
      expect([...bytes]).toEqual(Array(32).fill(7));
      bytes.fill(0);
      let resultId = 2,
        extra = mockInput.privateRecovery ? { privateRecovery: { status: 'proved' } } : {};
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
        if (!mockHoldExit) resolveClosed({ code: 'RAILGUN_PROCESS_CLOSED' });
        if (mockCloseFailure) throw Error('private cleanup detail');
      }),
    });
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { runRailgunWalletSnapshot } = require('./railgun-wallet-run');
let scope, args;
beforeEach(() => {
  mockActualCapsule = null;
  mockWorker = mockCredential = mockLoan = null;
  mockBorrow = jest.fn();
  mockQuarantine = jest.fn();
  mockHoldExit = mockCloseFailure = false;
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
    cause: new Error('Railgun wallet broker unavailable'),
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
  expect([...mockCopy]).toEqual(Array(32).fill(0));
  expect(mockTask.close).toHaveBeenCalled();
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test('frozen shared revocation reasons stay intact while utility exit is drained', async () => {
  mockCancelledCopy = true;
  mockFailure = Object.freeze(Object.assign(new Error('shared reason'), { code: 'REVOKED' }));
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    cause: new Error('Railgun wallet broker unavailable'),
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const keyWire = () => JSON.stringify({ id: 1, method: 'key', purpose: 'wallet-viewing' });
const resultWire = (id) =>
  JSON.stringify({
    id,
    method: 'result',
    value: {
      instanceId: mockDescriptor.instanceId,
    },
  });
const storageWire = (id) => JSON.stringify({ id, channel: 'wallet', wire: '{}' });

test.each([
  null,
  [],
  1,
  { id: 0 },
  { id: 1.5 },
  { id: 1, method: 'key', purpose: 'other' },
  { id: 1, method: 'key', purpose: 'wallet-viewing', extra: true },
])(
  'malformed first message permanently refuses even when a child catches it (%#)',
  async (value) => {
    mockWorker = async ({ broker }) => {
      await expect(broker.dispatch(JSON.stringify(value))).rejects.toMatchObject({
        code: 'RAILGUN_WALLET_BROKER_REFUSED',
      });
      await expect(broker.dispatch(keyWire())).rejects.toMatchObject({
        code: 'RAILGUN_WALLET_BROKER_REFUSED',
      });
      await expect(broker.dispatch(resultWire(2))).rejects.toThrow('broker unavailable');
    };
    await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_BROKER_REFUSED',
    });
    expect(mockBorrow).not.toHaveBeenCalled();
  }
);
test.each([{}, 'x'.repeat(2 * 1024 * 1024 + 1), '{'])(
  'invalid wire is refused without borrowing (%#)',
  async (wire) => {
    mockWorker = async ({ broker }) => {
      await broker.dispatch(wire);
    };
    await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_BROKER_REFUSED',
    });
    expect(mockBorrow).not.toHaveBeenCalled();
  }
);
test.each([0, 31, 33, 64])('viewing loan must be exactly 32 bytes, not %i', async (size) => {
  mockLoan = Buffer.alloc(size, 7);
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
  expect(mockCopy).toBeNull();
  expect([...mockLoan]).toEqual(Array(size).fill(0));
});
test('a plain Uint8Array loan remains supported', async () => {
  mockLoan = new Uint8Array(32).fill(7);
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
});
test.each(['getter', 'proxy', 'key-proxy', 'string'])(
  'credential %s is rejected without invoking a getter or copying',
  async (mode) => {
    const accessed = jest.fn(() => Buffer.alloc(32, 7));
    let credential =
      mode === 'getter'
        ? Object.defineProperty({}, 'viewingKey', { get: accessed })
        : {
            viewingKey:
              mode === 'string'
                ? '07'.repeat(32)
                : new Proxy(Buffer.alloc(32, 7), { get: accessed }),
          };
    if (mode === 'proxy') credential = new Proxy({}, { getOwnPropertyDescriptor: accessed });
    mockCredential = async (use) => use(credential);
    await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_BROKER_REFUSED',
    });
    expect(accessed).not.toHaveBeenCalled();
    expect(mockCopy).toBeNull();
  }
);
test.each(['before-copy', 'after-copy'])(
  'cancelled run waits for original viewing callback %s and wipes refused copy',
  async (when) => {
    const entered = deferred(),
      release = deferred();
    let borrowedCopy;
    mockCredential = async (use) => {
      if (when === 'after-copy') borrowedCopy = use({ viewingKey: Buffer.alloc(32, 7) });
      entered.resolve();
      await release.promise;
      if (when === 'before-copy') borrowedCopy = use({ viewingKey: Buffer.alloc(32, 7) });
      return borrowedCopy;
    };
    let settled = false;
    const observed = runRailgunWalletSnapshot(args)
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    scope.close();
    mockAbortJob(Error('worker stopped'));
    await tick();
    expect(settled).toBe(false);
    if (borrowedCopy) expect([...borrowedCopy]).toEqual(Array(32).fill(0));
    release.resolve();
    expect(await observed).toMatchObject({
      code: 'RAILGUN_WALLET_BROKER_REFUSED',
      closed: { code: 'RAILGUN_PROCESS_CLOSED' },
    });
    if (when === 'before-copy') expect(borrowedCopy).toBeUndefined();
  }
);
test('result racing the initial loan refuses and waits for its original callback', async () => {
  const entered = deferred(),
    release = deferred();
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 7) });
  };
  mockWorker = async ({ broker }) => {
    const key = broker.dispatch(keyWire()).catch((error) => error);
    await entered.promise;
    await expect(broker.dispatch(resultWire(2))).rejects.toThrow('broker unavailable');
    release.resolve();
    await key;
  };
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
});
test('independent storage requests may complete out of order but preserve per-request ids', async () => {
  const first = deferred(),
    second = deferred();
  mockRouter.dispatch = jest.fn((wire) =>
    JSON.parse(wire).id === 1 ? first.promise : second.promise
  );
  mockWorker = async ({ broker }) => {
    (await broker.dispatch(keyWire())).fill(0);
    const one = broker.dispatch(storageWire(2)),
      two = broker.dispatch(storageWire(3));
    second.resolve(JSON.stringify({ id: 2, value: 'two' }));
    expect(JSON.parse(await two)).toEqual({ id: 3, value: 'two' });
    first.resolve(JSON.stringify({ id: 1, value: 'one' }));
    expect(JSON.parse(await one)).toEqual({ id: 2, value: 'one' });
    await broker.dispatch(resultWire(4));
  };
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
});
test('result cannot overtake pending storage even when the child catches the refusal', async () => {
  const release = deferred();
  mockRouter.dispatch = jest.fn(() => release.promise);
  mockWorker = async ({ broker }) => {
    (await broker.dispatch(keyWire())).fill(0);
    const storage = broker.dispatch(storageWire(2)).catch((error) => error);
    await expect(broker.dispatch(resultWire(3))).rejects.toThrow('broker unavailable');
    release.resolve(JSON.stringify({ id: 1, value: null }));
    await storage;
    await expect(broker.dispatch(resultWire(4))).rejects.toThrow('broker unavailable');
  };
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
});
test.each(['resolved', 'rejected'])(
  'throwing closes still drain held storage and the independently %s exit barrier',
  async (outcome) => {
    const entered = deferred(),
      release = deferred();
    mockHoldExit = true;
    mockCloseFailure = true;
    mockRouter.close.mockImplementation(() => {
      throw Error('private router cleanup detail');
    });
    mockRouter.dispatch = jest.fn(() => {
      entered.resolve();
      return release.promise;
    });
    mockWorker = async ({ broker }) => {
      (await broker.dispatch(keyWire())).fill(0);
      await broker.dispatch(storageWire(2));
    };
    let settled = false;
    const run = runRailgunWalletSnapshot(args)
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    mockAbortJob(Error('worker timeout'));
    await tick();
    expect(settled).toBe(false);
    release.resolve(JSON.stringify({ id: 1, value: null }));
    await tick();
    expect(settled).toBe(false);
    if (outcome === 'resolved') mockResolveClosed({ code: 'RAILGUN_PROCESS_CLOSED' });
    else mockRejectClosed(Error('exit observation unavailable'));
    const error = await run;
    expect(error.code).toBe(
      outcome === 'resolved' ? 'RAILGUN_WALLET_BROKER_REFUSED' : 'RAILGUN_WALLET_EXIT_UNOBSERVED'
    );
    if (outcome === 'resolved')
      expect(error.cause.message).toBe('Railgun wallet broker unavailable');
    else expect(error.cause).toBeUndefined();
    expect(error.closed).toEqual(
      outcome === 'resolved' ? { code: 'RAILGUN_PROCESS_CLOSED' } : undefined
    );
  }
);
test('a rejected exit barrier still waits for an outstanding credential callback', async () => {
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 7) });
  };
  let settled = false;
  const run = runRailgunWalletSnapshot(args)
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  mockAbortJob(Error('worker timeout'));
  await tick();
  mockRejectClosed(Error('exit observation unavailable'));
  await tick();
  expect(settled).toBe(false);
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
  release.resolve();
  expect(await run).toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
});

test('a short typed loan cannot spoof its intrinsic length through an own getter', async () => {
  const accessed = jest.fn(() => 32);
  mockLoan = new Uint8Array(31).fill(7);
  Object.defineProperty(mockLoan, 'byteLength', { get: accessed });
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
  expect(accessed).not.toHaveBeenCalled();
  expect(mockCopy).toBeNull();
});
test('a malformed storage reply permanently stops subsequent storage', async () => {
  mockRouter.dispatch = jest.fn(async () => JSON.stringify({ id: 900, value: null }));
  mockWorker = async ({ broker }) => {
    (await broker.dispatch(keyWire())).fill(0);
    await expect(broker.dispatch(storageWire(2))).rejects.toThrow('broker unavailable');
    await expect(broker.dispatch(storageWire(3))).rejects.toThrow('broker unavailable');
  };
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
  expect(mockRouter.dispatch).toHaveBeenCalledTimes(1);
});

test('an unobserved child exit quarantines credentials and the same identity before any new process or loan', async () => {
  mockQuarantine.mockImplementation(() => {
    mockRefuse = true;
  });
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 7) });
  };
  const run = runRailgunWalletSnapshot(args).catch((error) => error);
  await entered.promise;
  mockAbortJob(Error('worker unavailable'));
  await tick();
  mockRejectClosed(Error('private exit failure'));
  release.resolve();
  const error = await run;
  expect(error).toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(error.cause).toBeUndefined();
  expect(error.closed).toBeUndefined();
  const originalTask = mockTask;
  mockBorrow.mockClear();
  mockCredential = null;
  mockHoldExit = false;
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
  });
  expect(mockTask).toBe(originalTask);
  expect(mockBorrow).not.toHaveBeenCalled();
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
  // This unit fixture models issuer refusal only; genuine cross-identity scope
  // and loan revocation are covered by the issuer's independent tests.
  const replacement = { signal: scope.signal };
  await expect(runRailgunWalletSnapshot({ ...args, identity: replacement })).rejects.toThrow(
    'identity refused'
  );
  expect(mockTask).toBe(originalTask);
  expect(mockBorrow).not.toHaveBeenCalled();
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
});
test('an observed unsuccessful child exit does not quarantine a still-current identity', async () => {
  const entered = deferred();
  mockHoldExit = true;
  mockWorker = async ({ broker }) => {
    (await broker.dispatch(keyWire())).fill(0);
    entered.resolve();
    throw Object.assign(Error('child failed'), { code: 'RAILGUN_PROCESS_FAILED' });
  };
  const run = runRailgunWalletSnapshot(args).catch((error) => error);
  await entered.promise;
  mockAbortJob(Object.assign(Error('child failed'), { code: 'RAILGUN_PROCESS_FAILED' }));
  mockResolveClosed({ code: 'RAILGUN_PROCESS_FAILED', exitCode: 1 });
  expect(await run).toMatchObject({
    code: 'RAILGUN_PROCESS_FAILED',
    closed: { code: 'RAILGUN_PROCESS_FAILED', exitCode: 1 },
  });
  mockWorker = null;
  mockHoldExit = false;
  mockBorrow.mockClear();
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
  expect(mockBorrow).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).not.toHaveBeenCalled();
});

test('issuer cleanup failure cannot mask unknown exit or skip original callback drainage', async () => {
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockQuarantine.mockImplementation(() => {
    throw Error('private issuer cleanup detail');
  });
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 7) });
  };
  let settled = false;
  const run = runRailgunWalletSnapshot(args)
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  mockAbortJob(Error('worker failed'));
  await tick();
  mockRejectClosed(Error('exit unavailable'));
  await tick();
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
  expect(settled).toBe(false);
  release.resolve();
  const error = await run;
  expect(error.code).toBe('RAILGUN_WALLET_EXIT_UNOBSERVED');
  expect(error.cause).toBeUndefined();
  expect(error.closed).toBeUndefined();
});

function recoveryArgs() {
  mockActualCapsule = require('../../../scripts/fixtures/railgun-capsule-data').capsule(
    mockDescriptor.walletId
  );
  return {
    ...args,
    restore: true,
    privateRecovery: {
      capsule: mockActualCapsule,
      signature: {
        R8: ['0x' + '1'.padStart(64, '0'), '0x' + '2'.padStart(64, '0')],
        S: '0x' + '3'.padStart(64, '0'),
      },
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    },
  };
}
test('recovery uses its fixed viewing-key job and carries only the canonical original data', async () => {
  const options = recoveryArgs();
  const value = await runRailgunWalletSnapshot(options);
  expect(value.privateRecovery).toEqual({ status: 'proved' });
  expect(mockInput.privateRecovery).toEqual(options.privateRecovery);
  expect(mockInput.privateIntent).toBeUndefined();
  expect(mockInput.privateOperation).toBeUndefined();
  expect(mockBorrow).toHaveBeenCalledTimes(1);
  expect([...mockCopy]).toEqual(Array(32).fill(0));
});
test.each([
  'restore',
  'mixed-intent',
  'mixed-operation',
  'foreign-wallet',
  'extra-option',
  'bad-signature',
])('recovery %s input refuses before any viewing credential or worker', async (mode) => {
  const options = recoveryArgs();
  if (mode === 'restore') options.restore = false;
  if (mode === 'mixed-intent') options.privateIntent = {};
  if (mode === 'mixed-operation') options.privateOperation = {};
  if (mode === 'foreign-wallet') options.privateRecovery.capsule.walletId = '2'.repeat(64);
  if (mode === 'extra-option') options.privateRecovery.onIntent = () => {};
  if (mode === 'bad-signature') options.privateRecovery.signature.S = 'bad';
  await expect(runRailgunWalletSnapshot(options)).rejects.toThrow();
  expect(mockTask).toBeNull();
  expect(mockBorrow).not.toHaveBeenCalled();
});
test.each(['private-intent', 'extra-operation', 'duplicate-result'])(
  'recovery broker refuses %s messages',
  async (mode) => {
    mockWorker = async ({ broker }) => {
      (
        await broker.dispatch(JSON.stringify({ id: 1, method: 'key', purpose: 'private-recover' }))
      ).fill(0);
      if (mode === 'private-intent')
        await broker.dispatch(JSON.stringify({ id: 2, method: 'private-intent', value: {} }));
      else {
        await broker.dispatch(
          JSON.stringify({
            id: 2,
            method: 'result',
            value: {
              instanceId: mockDescriptor.instanceId,
              privateRecovery: { status: 'proved' },
              ...(mode === 'extra-operation' ? { privateOperation: { status: 'refused' } } : {}),
            },
          })
        );
        if (mode === 'duplicate-result')
          await broker.dispatch(JSON.stringify({ id: 3, method: 'result', value: {} }));
      }
    };
    await expect(runRailgunWalletSnapshot(recoveryArgs())).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_BROKER_REFUSED',
    });
    expect(mockQuarantine).not.toHaveBeenCalled();
  }
);
test('recovery cancellation holds the original viewing loan until drain and quarantines unobserved child exit', async () => {
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 7) });
  };
  let settled = false;
  const run = runRailgunWalletSnapshot(recoveryArgs())
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  mockAbortJob(Error('child unavailable'));
  await tick();
  mockRejectClosed(Error('no observed exit'));
  await tick();
  expect(settled).toBe(false);
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
  release.resolve();
  expect(await run).toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
});

test('ordinary viewing broker refuses an unsolicited recovery result', async () => {
  mockWorker = async ({ broker }) => {
    (await broker.dispatch(keyWire())).fill(0);
    await broker.dispatch(
      JSON.stringify({
        id: 2,
        method: 'result',
        value: { instanceId: mockDescriptor.instanceId, privateRecovery: { status: 'proved' } },
      })
    );
  };
  await expect(runRailgunWalletSnapshot(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
});

test.each([false, true])(
  'detached provenance unknown retains account outcome through throwing cleanup=%s and original viewing exit',
  async (throwing) => {
    const entered = deferred(),
      original = deferred();
    mockHoldExit = true;
    const onIntent = jest.fn(async () => {
      entered.resolve();
      throw await original.promise;
    });
    const opts = operation(onIntent);
    let settled = false;
    const work = runRailgunWalletSnapshot(opts).catch((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    if (throwing) {
      mockQuarantine.mockImplementation(() => {
        throw Error('issuer close');
      });
      mockRouter.close.mockImplementation(() => {
        throw Error('storage close');
      });
      mockCloseFailure = true;
    }
    original.resolve(
      Object.assign(Error('detached unknown'), { code: 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED' })
    );
    await tick();
    expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
    expect(mockTask.close).toHaveBeenCalled();
    expect(settled).toBe(false);
    mockResolveClosed({ code: 'RAILGUN_PROCESS_CLOSED' });
    expect(await work).toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
    const previous = mockTask;
    mockBorrow.mockClear();
    await expect(runRailgunWalletSnapshot(opts)).rejects.toMatchObject({
      code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
    });
    expect(mockTask).toBe(previous);
    expect(mockBorrow).not.toHaveBeenCalled();
    expect(mockQuarantine).toHaveBeenCalledTimes(1);
  }
);
test('ordinary detached refusal preserves reuse after original callback and viewing exit', async () => {
  await expect(
    runRailgunWalletSnapshot(
      operation(async () => {
        throw Object.assign(Error('ordinary refusal'), { code: 'RAILGUN_NOTE_PROVENANCE_REFUSED' });
      })
    )
  ).rejects.toMatchObject({ code: 'RAILGUN_WALLET_BROKER_REFUSED' });
  expect(mockQuarantine).not.toHaveBeenCalled();
  await expect(runRailgunWalletSnapshot(args)).resolves.toMatchObject({
    instanceId: mockDescriptor.instanceId,
  });
});
