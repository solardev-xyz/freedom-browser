let mockIdentity,
  mockEnrollment,
  mockMode,
  mockExit,
  mockRelease,
  mockInput,
  mockCopy,
  mockCredential;
const mockQuarantine = jest.fn();
const mockStart = jest.fn(),
  mockViewingKey = Buffer.alloc(32, 7);
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
// Mock the shared intent implementation, leaving both host and result checks on one seam.
jest.mock(
  '../../../node_modules/@freedom/railgun-kohaku-adapter/src/data/railgun-private-intent',
  () => ({
    validateRailgunPrivateSigningIntent: (tx, expected) => {
      if (!['railgun-private-transfer', 'railgun-partial-unshield'].includes(expected.kind))
        throw Error('kind');
      return { ...expected, digest: tx.data };
    },
  })
);
jest.mock('./railgun-identity', () => ({
  quarantineRailgunIdentityCredentials: (...args) => mockQuarantine(...args),
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity || v.signal.aborted) throw Error('identity');
    return v.descriptor;
  },
  withRailgunViewingCredential: async (_identity, use) => {
    if (mockCredential) return mockCredential(use);
    mockCopy = use({ viewingKey: mockViewingKey });
    if (mockMode === 'late-key') {
      mockEnrollment.close();
      throw Error('cancelled');
    }
    return mockCopy;
  },
}));
const { verifyRailgunPrivateReceiver } = require('./railgun-private-receive');
let args;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = mockExit = mockRelease = mockInput = mockCopy = mockCredential = undefined;
  const controller = new AbortController();
  mockIdentity = {
    signal: controller.signal,
    descriptor: { walletId: 'a'.repeat(64), instanceId: 'self' },
  };
  mockEnrollment = {
    signal: controller.signal,
    descriptor: mockIdentity.descriptor,
    getContext: jest.fn(() => ({})),
    close: () => controller.abort(),
  };
  args = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture.asar',
    transaction: { data: '0x' + '1'.repeat(64) },
    expected: { kind: 'railgun-private-transfer' },
    recipient: 'self',
    amount: '1000',
  };
  mockStart.mockImplementation(({ broker, input, filename, binaryKey }) => {
    mockInput = JSON.parse(input);
    expect(binaryKey).toBe(true);
    expect(filename).toBe(require.resolve('./railgun-private-receive-job'));
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const ready = Promise.resolve().then(async () => {
      const key = await broker.dispatch(
        JSON.stringify({
          id: 1,
          method: 'key',
          purpose: mockMode === 'purpose' ? 'spending-sign' : 'private-receive',
        })
      );
      expect(key).not.toBe(mockViewingKey);
      expect(key.byteOffset).toBe(0);
      expect(key.buffer.byteLength).toBe(32);
      key.fill(0);
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      if (mockMode === 'replay-key')
        await broker.dispatch(JSON.stringify({ id: 2, method: 'key', purpose: 'private-receive' }));
      const value = {
        verified: true,
        transactionDigest: mockInput.transaction.data,
        recipient: mockInput.recipient,
        ...(mockInput.expected.kind === 'railgun-partial-unshield'
          ? {
              inputAmount: mockInput.inputAmount,
              unshieldAmount: mockInput.expected.unshieldAmount,
              changeAmount: (
                BigInt(mockInput.inputAmount) - BigInt(mockInput.expected.unshieldAmount)
              ).toString(),
            }
          : { amount: mockInput.amount }),
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
        guards: { attempts: 0, canaries: 1, hooks: ['test.hook'] },
      };
      if (['recipient', 'amount', 'transactionDigest', 'inventory'].includes(mockMode))
        value[mockMode] = 'wrong';
      if (mockMode === 'egress') value.guards.attempts = 1;
      if (mockMode === 'extra') value.extra = true;
      await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
    });
    return {
      ready,
      closed,
      close: () => {
        if (mockMode !== 'drain') mockExit();
      },
    };
  });
});
test('host intent checks and guarded results use the same extracted data implementation', () => {
  const local = require('./railgun-private-intent');
  const shared = require('../../../node_modules/@freedom/railgun-kohaku-adapter/src/data/railgun-private-intent');
  const results = require('./railgun-private-results');
  const host = require('@freedom/railgun-kohaku-adapter/host/data');
  expect(local.validateRailgunPrivateSigningIntent).toBe(
    shared.validateRailgunPrivateSigningIntent
  );
  expect(results.normalizeRailgunPrivateReceiver).toBe(host.normalizeRailgunPrivateReceiver);
});
test('returns intent-bound cryptographic data only after exit and never serializes the viewing key', async () => {
  const pending = verifyRailgunPrivateReceiver(args);
  args.transaction.data = 'changed';
  const value = await pending;
  expect(value).toMatchObject({
    recipientVerified: true,
    transactionDigest: '0x' + '1'.repeat(64),
    inputOwnershipVerified: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
  expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
  expect(mockViewingKey[0]).toBe(7);
});
test.each([
  'purpose',
  'replay-key',
  'recipient',
  'amount',
  'transactionDigest',
  'inventory',
  'egress',
  'extra',
  'late-key',
])('refuses %s without returning verification', async (mode) => {
  mockMode = mode;
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject({
    code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
  });
  if (mockCopy) expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
});
test.each(['identity', 'enrollment', 'recipient', 'amount', 'kind', 'cancelled'])(
  'refuses invalid %s before starting the worker',
  async (field) => {
    if (field === 'identity' || field === 'enrollment') args[field] = {};
    if (field === 'recipient') args.recipient = 'foreign';
    if (field === 'amount') args.amount = '0';
    if (field === 'kind') args.expected.kind = 'railgun-token-unshield';
    if (field === 'cancelled') args.signal = AbortSignal.abort();
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toThrow();
    expect(mockStart).not.toHaveBeenCalled();
  }
);
test('cancellation and concurrent requests cannot bypass utility exit drain', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = verifyRailgunPrivateReceiver(args).finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toThrow();
  for (let i = 0; i < 30 && !mockRelease; i++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toThrow();
  mockEnrollment.close();
  mockRelease();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await rejected;
});

const refused = {
  code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
  message: 'Railgun private receiver unavailable',
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const keyWire = JSON.stringify({ id: 1, method: 'key', purpose: 'private-receive' });
function resultWire(input) {
  return JSON.stringify({
    id: 2,
    method: 'result',
    value: {
      verified: true,
      transactionDigest: input.transaction.data,
      recipient: input.recipient,
      ...(input.inputAmount
        ? {
            inputAmount: input.inputAmount,
            unshieldAmount: input.expected.unshieldAmount,
            changeAmount: (
              BigInt(input.inputAmount) - BigInt(input.expected.unshieldAmount)
            ).toString(),
          }
        : { amount: input.amount }),
      inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      guards: { attempts: 0, canaries: 1, hooks: ['test.hook'] },
    },
  });
}
function partial() {
  delete args.amount;
  args.inputAmount = '1000';
  args.expected = { kind: 'railgun-partial-unshield', unshieldAmount: '400' };
}
test('partial returns exact explicit triplet with unchanged authority flags', async () => {
  partial();
  const value = await verifyRailgunPrivateReceiver(args);
  expect(value).toEqual({
    recipientVerified: true,
    transactionDigest: args.transaction.data,
    recipient: 'self',
    inputAmount: '1000',
    unshieldAmount: '400',
    changeAmount: '600',
    inputOwnershipVerified: false,
    spendingEnabled: false,
  });
  expect(Object.keys(mockInput)).toEqual([
    'archive',
    'descriptor',
    'transaction',
    'expected',
    'recipient',
    'inputAmount',
  ]);
  expect(Object.hasOwn(value, 'kind')).toBe(false);
  expect(Object.isFrozen(value)).toBe(true);
});
test.each(['amount', 'changeAmount', 'unshieldAmount', 'zero', 'all', 'over-cap', 'noncanonical'])(
  'partial %s refuses before utility and any credential',
  async (mode) => {
    partial();
    if (['amount', 'changeAmount', 'unshieldAmount'].includes(mode)) args[mode] = '400';
    if (mode === 'zero') args.expected.unshieldAmount = '0';
    if (mode === 'all') args.expected.unshieldAmount = '1000';
    if (mode === 'over-cap') args.inputAmount = '10000000000000001';
    if (mode === 'noncanonical') args.inputAmount = '01000';
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
    expect(mockStart).not.toHaveBeenCalled();
  }
);
test.each([0, 31, 33, 'not-bytes'])(
  'credential length/type %s refuses and cannot publish',
  async (size) => {
    mockCredential = (use) =>
      use({ viewingKey: typeof size === 'number' ? Buffer.alloc(size, 7) : size });
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
  }
);
test.each(['malformed-then-key', 'early-result', 'extra-after-result'])(
  'sticky %s aborts synchronously and cannot be rescued',
  async (mode) => {
    const attempted = [];
    let signal;
    mockStart.mockImplementation(({ broker, input }) => {
      signal = broker.signal;
      const exit = deferred();
      const ready = Promise.resolve().then(async () => {
        const final = resultWire(JSON.parse(input));
        if (mode === 'extra-after-result') {
          await broker.dispatch(keyWire);
          await broker.dispatch(final);
        }
        const bad =
          mode === 'malformed-then-key'
            ? '{'
            : mode === 'early-result'
              ? final
              : JSON.stringify({ id: 3, method: 'result', value: {} });
        const rejected = broker.dispatch(bad);
        expect(signal.aborted).toBe(true);
        await expect(rejected).rejects.toMatchObject(refused);
        for (const wire of [keyWire, final])
          await broker.dispatch(wire).then(
            () => attempted.push('rescued'),
            (e) => expect(e).toMatchObject(refused)
          );
      });
      return {
        ready,
        closed: exit.promise,
        close: () => exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' }),
      };
    });
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
    expect(attempted).toEqual([]);
    expect(signal.aborted).toBe(true);
    if (mockCopy) expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
  }
);
test.each([
  'cancel-before-copy',
  'cancel-after-copy',
  'malformed-during-loan',
  'early-result-during-loan',
])('%s retains identity until borrowed credential drains after child exit', async (mode) => {
  const gate = deferred(),
    entered = deferred(),
    exit = deferred();
  let broker, loan, key;
  const abort = new AbortController();
  args.signal = abort.signal;
  mockCredential = async (use) => {
    if (mode === 'cancel-after-copy') key = use({ viewingKey: mockViewingKey });
    entered.resolve();
    await gate.promise;
    return mode === 'cancel-after-copy' ? key : use({ viewingKey: mockViewingKey });
  };
  mockStart.mockImplementation((v) => {
    broker = v.broker;
    return {
      ready: Promise.resolve().then(() => {
        loan = broker.dispatch(keyWire);
        loan.catch(() => {});
        return entered.promise;
      }),
      closed: exit.promise,
      close: () => exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' }),
    };
  });
  let settled = false;
  const work = verifyRailgunPrivateReceiver(args).finally(() => {
    settled = true;
  });
  const failure = expect(work).rejects.toMatchObject(refused);
  await entered.promise;
  if (mode.startsWith('cancel')) abort.abort();
  else
    await expect(
      broker.dispatch(
        mode === 'malformed-during-loan'
          ? '{'
          : resultWire({ transaction: args.transaction, recipient: 'self', amount: '1000' })
      )
    ).rejects.toMatchObject(refused);
  await turn();
  expect(settled).toBe(false);
  expect(broker.signal.aborted).toBe(true);
  await expect(verifyRailgunPrivateReceiver({ ...args, signal: undefined })).rejects.toMatchObject(
    refused
  );
  expect(mockStart).toHaveBeenCalledTimes(1);
  gate.resolve();
  await failure;
  await expect(loan).rejects.toMatchObject(refused);
  if (key) expect(key.equals(Buffer.alloc(32))).toBe(true);
  expect(mockViewingKey[0]).toBe(7);
});
test.each(['success-close', 'abort-listener-close'])(
  'throwing %s still awaits the child exit and refuses without uncaught close',
  async (mode) => {
    const exit = deferred(),
      entered = deferred();
    let close;
    const abort = new AbortController();
    args.signal = abort.signal;
    mockStart.mockImplementation(({ broker, input }) => {
      close = jest.fn(() => {
        entered.resolve();
        throw Error('close detail');
      });
      return {
        ready: Promise.resolve().then(async () => {
          await broker.dispatch(keyWire);
          await broker.dispatch(resultWire(JSON.parse(input)));
          if (mode === 'abort-listener-close') abort.abort();
        }),
        closed: exit.promise,
        close,
      };
    });
    let settled = false;
    const work = verifyRailgunPrivateReceiver(args).finally(() => {
      settled = true;
    });
    const failure = expect(work).rejects.toMatchObject(refused);
    await entered.promise;
    await turn();
    expect(settled).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    await failure;
    expect(mockCopy.equals(Buffer.alloc(32))).toBe(true);
  }
);
test('late synchronous startup abort still closes returned child and awaits it', async () => {
  const abort = new AbortController(),
    exit = deferred();
  args.signal = abort.signal;
  const close = jest.fn();
  mockStart.mockImplementation(() => {
    abort.abort();
    return { ready: Promise.resolve(), closed: exit.promise, close };
  });
  let settled = false;
  const work = verifyRailgunPrivateReceiver(args).finally(() => {
    settled = true;
  });
  const failure = expect(work).rejects.toMatchObject(refused);
  await turn();
  expect(close).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await failure;
});
test('monotonic expiry before timer dispatch refuses after delayed normal child exit', async () => {
  let now = 1000;
  const spy = jest.spyOn(performance, 'now').mockImplementation(() => now);
  const exit = deferred(),
    closed = deferred();
  mockStart.mockImplementation(({ broker, input }) => ({
    ready: Promise.resolve().then(async () => {
      await broker.dispatch(keyWire);
      await broker.dispatch(resultWire(JSON.parse(input)));
    }),
    closed: exit.promise,
    close: () => closed.resolve(),
  }));
  try {
    const work = verifyRailgunPrivateReceiver(args);
    const failure = expect(work).rejects.toMatchObject(refused);
    await closed.promise;
    now += 60000;
    exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    await failure;
  } finally {
    spy.mockRestore();
  }
});
test('rejected child barrier returns no result and does not release identity exclusion', async () => {
  const exit = deferred();
  exit.promise.catch(() => {});
  mockStart.mockImplementation(({ broker, input }) => ({
    ready: Promise.resolve().then(async () => {
      await broker.dispatch(keyWire);
      await broker.dispatch(resultWire(JSON.parse(input)));
    }),
    closed: exit.promise,
    close: () => exit.reject(Error('unknown exit')),
  }));
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
  expect(mockStart).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
});

test.each([undefined, null, {}, { code: 7 }])(
  'malformed fulfilled exit %j quarantines rather than inventing child exit',
  async (value) => {
    mockStart.mockImplementation(() => ({
      ready: Promise.reject(Error('failed')),
      closed: Promise.resolve(value),
      close: () => {},
    }));
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
    expect(mockQuarantine).toHaveBeenCalledTimes(1);
    expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
  }
);

test('unknown exit quarantines before borrowed credential callback drains, even with identity already aborted', async () => {
  const entered = deferred(),
    release = deferred(),
    exit = deferred();
  exit.promise.catch(() => {});
  mockCredential = async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: mockViewingKey });
  };
  let settled = false;
  mockStart.mockImplementation(({ broker }) => ({
    ready: Promise.resolve().then(async () => {
      void broker.dispatch(keyWire).catch(() => {});
      await entered.promise;
      throw Error('failed child');
    }),
    closed: exit.promise,
    close: () => exit.reject(Error('exit not observed')),
  }));
  const work = verifyRailgunPrivateReceiver(args).catch((error) => {
    settled = true;
    return error;
  });
  await entered.promise;
  mockEnrollment.close();
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
  expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
  release.resolve();
  expect(await work).toMatchObject(refused);
  expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
  expect(mockQuarantine).toHaveBeenCalledTimes(1);
});

test.each(['RAILGUN_PROCESS_CLOSED', 'RAILGUN_PROCESS_FAILED'])(
  'observed failure %s does not quarantine and allows a healthy retry',
  async (code) => {
    mockStart.mockImplementationOnce(() => ({
      ready: Promise.reject(Error('job failed')),
      closed: Promise.resolve({ code }),
      close: () => {},
    }));
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
    expect(mockQuarantine).not.toHaveBeenCalled();
    await expect(verifyRailgunPrivateReceiver(args)).resolves.toHaveProperty(
      'recipientVerified',
      true
    );
    expect(mockQuarantine).not.toHaveBeenCalled();
  }
);

test('startup failure before a task exists never quarantines issued identity', async () => {
  mockStart.mockImplementationOnce(() => {
    throw Error('startup unavailable');
  });
  await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
  expect(mockQuarantine).not.toHaveBeenCalled();
  await expect(verifyRailgunPrivateReceiver(args)).resolves.toHaveProperty(
    'recipientVerified',
    true
  );
});

test.each(['missing', 'throwing-getter'])(
  '%s child exit barrier quarantines with the bounded receiver error',
  async (kind) => {
    mockStart.mockImplementation(() => {
      const task = { ready: Promise.reject(Error('failed')), close: () => {} };
      if (kind === 'throwing-getter')
        Object.defineProperty(task, 'closed', {
          get() {
            throw Error('private barrier detail');
          },
        });
      return task;
    });
    const error = await verifyRailgunPrivateReceiver(args).catch((error) => error);
    expect(error).toMatchObject(refused);
    expect(error.message).toBe('Railgun private receiver unavailable');
    expect(mockQuarantine).toHaveBeenCalledTimes(1);
    expect(mockQuarantine).toHaveBeenCalledWith(mockIdentity);
  }
);

describe('foreign full-value transfer sent-output check', () => {
  const OTHER = '0zk1' + 'p'.repeat(123);
  function foreignStart(change = (value) => value) {
    mockStart.mockImplementation(({ broker, input, filename, binaryKey }) => {
      expect(binaryKey).toBe(true);
      expect(filename).toBe(require.resolve('./railgun-private-receive-job'));
      mockInput = JSON.parse(input);
      const exit = deferred();
      const ready = Promise.resolve().then(async () => {
        const key = await broker.dispatch(keyWire);
        key.fill(0);
        const wire = JSON.parse(resultWire(mockInput));
        wire.value = change({
          ...wire.value,
          ...(mockInput.recipientRelationship
            ? { recipientRelationship: mockInput.recipientRelationship }
            : {}),
        });
        await broker.dispatch(JSON.stringify(wire));
      });
      return {
        ready,
        closed: exit.promise,
        close: () => exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' }),
      };
    });
  }
  beforeEach(() => {
    args.recipient = OTHER;
    args.recipientRelationship = 'foreign';
  });
  test('the same job receives the explicit marker and returns a marker-bound result', async () => {
    foreignStart();
    const value = await verifyRailgunPrivateReceiver(args);
    expect(value).toEqual({
      recipientVerified: true,
      transactionDigest: args.transaction.data,
      recipient: OTHER,
      recipientRelationship: 'foreign',
      amount: '1000',
      inputOwnershipVerified: false,
      spendingEnabled: false,
    });
    expect(Object.keys(mockInput)).toEqual([
      'archive',
      'descriptor',
      'transaction',
      'expected',
      'recipient',
      'recipientRelationship',
      'amount',
    ]);
    expect(JSON.stringify(mockInput)).not.toContain('07'.repeat(32));
  });
  test.each([
    ['missing marker', ({ recipientRelationship: _marker, ...value }) => value],
    ['self marker', (value) => ({ ...value, recipientRelationship: 'self' })],
    ['other recipient', (value) => ({ ...value, recipient: '0zk1' + 'r'.repeat(123) })],
    ['own recipient', (value) => ({ ...value, recipient: 'self' })],
  ])('a utility result with %s is refused', async (_label, change) => {
    foreignStart(change);
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
  });
  test.each([
    ['unmarked destination', () => delete args.recipientRelationship],
    ['marker value', () => (args.recipientRelationship = 'self')],
    ['own instance', () => (args.recipient = 'self')],
    ['malformed destination', () => (args.recipient = '0zk1' + 'P'.repeat(123))],
    ['partial change', () => partial()],
  ])('%s refuses before the worker or any credential', async (_label, change) => {
    foreignStart();
    change();
    await expect(verifyRailgunPrivateReceiver(args)).rejects.toMatchObject(refused);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockCopy).toBeUndefined();
  });
});
