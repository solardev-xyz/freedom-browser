let mockEnrollment, mockIdentity, mockMode, mockRelease, mockExit;
const mockStart = jest.fn();
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (v) => {
    if (v !== mockIdentity || v.signal.aborted) throw Error('Identity refused');
    return v.descriptor;
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const {
  prepareRailgunNativeShield,
  assertRailgunShieldPreparation,
  MAX_AGE_MS,
} = require('./railgun-shield-prepare');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const pins = require('./railgun-shield-pins.json');
const { Interface } = require('ethers');
const abi = new Interface(SHIELD_ABI);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
let scope,
  sequence = 0;
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const amount = '100000000000000';
function jobResult() {
  const request = {
    preimage: {
      npk: hex(7),
      token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: 0 },
      value: amount,
    },
    ciphertext: { encryptedBundle: [hex(1), hex(2), hex(3)], shieldKey: hex(4) },
  };
  const data = abi.encodeFunctionData('multicall', [
    true,
    [
      { to: pins.relayAdapt, data: abi.encodeFunctionData('wrapBase', [amount]), value: 0 },
      { to: pins.relayAdapt, data: abi.encodeFunctionData('shield', [[request]]), value: 0 },
    ],
  ]);
  return {
    npk: hex(7),
    commitment: hex(8),
    noteValue: '99750000000000',
    transaction: { chainId: 11155111, to: pins.relayAdapt, value: amount, data },
    guards: { attempts: 0 },
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockRelease = undefined;
  mockExit = undefined;
  scope = createPrivacyScope({ profileId: 'shield-test', signal: new AbortController().signal });
  mockIdentity = {
    signal: scope.signal,
    descriptor: { walletId: 'a'.repeat(64), instanceId: 'public-fixture-recipient' },
  };
  mockEnrollment = {
    directory: '/fixture/shield-prepare-' + ++sequence,
    descriptor: { walletId: mockIdentity.descriptor.walletId },
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  mockStart.mockImplementation(({ broker }) => {
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const close = () => {
      if (mockMode !== 'drain') mockExit();
    };
    const ready = Promise.resolve().then(async () => {
      const input = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' })));
      expect(input.value).toEqual({ amount, recipient: mockIdentity.descriptor.instanceId });
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      const result = jobResult();
      if (mockMode === 'inventory') result.inventory = 'wrong';
      if (mockMode === 'egress') result.guards.attempts = 1;
      if (mockMode === 'net') result.noteValue = amount;
      if (mockMode === 'commitment') result.commitment = '0x' + 'f'.repeat(64);
      if (mockMode === 'target') result.transaction.to = pins.proxy;
      if (mockMode === 'extra') result.secret = 'not allowed';
      await broker.dispatch(JSON.stringify({ id: 2, method: 'result', value: result }));
    });
    return { ready, closed, close };
  });
});
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
const prepare = (options = {}) =>
  prepareRailgunNativeShield({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount,
    ...options,
  });
test('own-recipient preparation is bound, immutable, short-lived and invalidated by another prepare', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const first = await prepare();
  expect(first.prepared).toMatchObject({
    recipient: mockIdentity.descriptor.instanceId,
    commitment: hex(8),
    signingEnabled: false,
    deploymentVerified: false,
  });
  expect(assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)).toBe(
    first.prepared
  );
  expect(Object.isFrozen(first.prepared)).toBe(true);
  expect(() => assertRailgunShieldPreparation({}, mockIdentity, mockEnrollment)).toThrow();
  now = 99;
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  now = 100 + MAX_AGE_MS;
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  now = 100;
  const second = await prepare();
  expect(() =>
    assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  expect(assertRailgunShieldPreparation(second.receipt, mockIdentity, mockEnrollment)).toBe(
    second.prepared
  );
  scope.close();
  expect(() =>
    assertRailgunShieldPreparation(second.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
});
test.each(['inventory', 'egress', 'net', 'commitment', 'target', 'extra'])(
  'utility %s mutation cannot produce preparation',
  async (kind) => {
    mockMode = kind;
    await expect(prepare()).rejects.toThrow('Railgun shield preparation unavailable');
  }
);
test('revocation drains utility before releasing the preparation owner', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = prepare().finally(() => {
    settled = true;
  });
  const refused = expect(pending).rejects.toThrow();
  for (let n = 0; n < 10 && !mockRelease; n++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(prepare()).rejects.toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
  scope.close();
  mockRelease();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await refused;
});
test('forged enrollment/identity, changed wallet and zero amount fail before compute', async () => {
  const input = {
    identity: mockIdentity,
    enrollment: mockEnrollment,
    archive: '/fixture/engine.asar',
    amount,
  };
  for (const change of [
    { enrollment: { ...mockEnrollment } },
    { identity: { ...mockIdentity } },
    { amount: '0' },
  ])
    await expect(prepareRailgunNativeShield({ ...input, ...change })).rejects.toThrow();
  mockEnrollment.descriptor.walletId = 'b'.repeat(64);
  await expect(prepare()).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});

const refusal = {
  code: 'RAILGUN_SHIELD_PREPARATION_REFUSED',
  message: 'Railgun shield preparation unavailable',
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const inputWire = JSON.stringify({ id: 1, method: 'input' });
const resultWire = () => JSON.stringify({ id: 2, method: 'result', value: jobResult() });
function controlled(run, { holdExit = false, throwClose = false } = {}) {
  const exit = deferred();
  let options;
  const close = jest.fn(() => {
    if (!holdExit) exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    if (throwClose) throw Error('private cleanup information');
  });
  mockStart.mockImplementation((value) => {
    options = value;
    return { ready: Promise.resolve().then(() => run(value.broker)), closed: exit.promise, close };
  });
  return { exit, close, options: () => options };
}
const valid = async (broker) => {
  await broker.dispatch(inputWire);
  await broker.dispatch(resultWire());
};
function phaseAvailable() {
  const phase = claimRailgunAccountPhase(mockEnrollment, 'recovery');
  phase.release();
}
function phaseBusy() {
  let unexpected;
  try {
    expect(() => {
      unexpected = claimRailgunAccountPhase(mockEnrollment, 'recovery');
    }).toThrow(expect.objectContaining({ code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }));
  } finally {
    unexpected?.release();
  }
}
test.each([
  { signal: null },
  { signal: false },
  { signal: {} },
  { signal: AbortSignal.abort() },
  { timeoutMs: 0 },
  { timeoutMs: -1 },
  { timeoutMs: 180001 },
  { timeoutMs: 1.5 },
  { timeoutMs: Infinity },
  { timeoutMs: '1000' },
])('invalid lifetime %p refuses before phase/utility', async (options) => {
  await expect(prepare(options)).rejects.toMatchObject(refusal);
  expect(mockStart).not.toHaveBeenCalled();
  phaseAvailable();
});
test.each([1, 120001, 180000])(
  'bounded %i ms config preserves receipt and return shape',
  async (timeoutMs) => {
    jest.spyOn(performance, 'now').mockReturnValue(10);
    const task = controlled(valid);
    const result = await prepare({ timeoutMs });
    expect(Object.keys(result).sort()).toEqual(['prepared', 'receipt']);
    expect(task.options()).toMatchObject({
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
    });
    phaseAvailable();
  }
);
test.each(['wallet', 'txid', 'recovery'])(
  'real %s phase refuses preparation before launch',
  async (kind) => {
    const phase = claimRailgunAccountPhase(mockEnrollment, kind);
    try {
      await expect(prepare()).rejects.toMatchObject(refusal);
      expect(mockStart).not.toHaveBeenCalled();
    } finally {
      phase.release();
    }
  }
);
test('phase refusal does not invalidate the previous preparation generation', async () => {
  const first = await prepare();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  try {
    await expect(prepare()).rejects.toMatchObject(refusal);
  } finally {
    phase.release();
  }
  expect(assertRailgunShieldPreparation(first.receipt, mockIdentity, mockEnrollment)).toBe(
    first.prepared
  );
});
test.each(['malformed', 'early-result', 'duplicate-input', 'extra-after-result'])(
  'caught %s cannot rescue preparation with subsequent valid broker traffic',
  async (mode) => {
    let caught;
    const task = controlled(async (broker) => {
      if (mode === 'duplicate-input' || mode === 'extra-after-result')
        await broker.dispatch(inputWire);
      if (mode === 'extra-after-result') await broker.dispatch(resultWire());
      const bad =
        mode === 'malformed'
          ? '{private malformed data'
          : mode === 'early-result'
            ? resultWire()
            : inputWire;
      const rejected = broker.dispatch(bad).catch((error) => {
        caught = error;
      });
      expect(broker.signal.aborted).toBe(true);
      await rejected;
      await expect(broker.dispatch(inputWire)).rejects.toMatchObject(refusal);
      await expect(broker.dispatch(resultWire())).rejects.toMatchObject(refusal);
    });
    await expect(prepare()).rejects.toMatchObject(refusal);
    expect(caught).toMatchObject(refusal);
    expect(task.close).toHaveBeenCalledTimes(1);
    phaseAvailable();
  }
);
test('caller cancellation after result waits actual exit and permanently revokes receipt admission', async () => {
  const caller = new AbortController();
  const task = controlled(valid, { holdExit: true });
  let settled = false;
  const work = prepare({ signal: caller.signal }).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  phaseBusy();
  caller.abort();
  await tick();
  expect(settled).toBe(false);
  expect(task.options().broker.signal.aborted).toBe(true);
  phaseBusy();
  task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await refused;
  phaseAvailable();
});
test('successful receipt remains bound to caller lifetime after child shutdown', async () => {
  const caller = new AbortController();
  const result = await prepare({ signal: caller.signal });
  expect(assertRailgunShieldPreparation(result.receipt, mockIdentity, mockEnrollment)).toBe(
    result.prepared
  );
  caller.abort();
  expect(() =>
    assertRailgunShieldPreparation(result.receipt, mockIdentity, mockEnrollment)
  ).toThrow();
  phaseAvailable();
});
test.each(['cancel', 'refuse'])(
  'synchronous %s during factory closes late-returned task',
  async (mode) => {
    const caller = new AbortController(),
      exit = deferred();
    const close = jest.fn(() => exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' }));
    let dispatch;
    mockStart.mockImplementation(({ broker }) => {
      if (mode === 'cancel') caller.abort();
      else dispatch = broker.dispatch('{malformed').catch(() => {});
      return { ready: Promise.resolve(), close, closed: exit.promise };
    });
    await expect(prepare({ signal: caller.signal })).rejects.toMatchObject(refusal);
    await dispatch;
    expect(close).toHaveBeenCalledTimes(1);
    phaseAvailable();
  }
);
test.each(['success', 'abort'])(
  'throwing close on %s still awaits child exit without uncaught callback error',
  async (mode) => {
    const caller = new AbortController(),
      hold = deferred();
    const task = controlled(
      async (broker) => {
        await valid(broker);
        if (mode === 'abort') await hold.promise;
      },
      { holdExit: true, throwClose: true }
    );
    const work = prepare({ signal: caller.signal });
    const refused = expect(work).rejects.toMatchObject(refusal);
    await tick();
    if (mode === 'abort') {
      expect(() => caller.abort()).not.toThrow();
      hold.resolve();
    }
    await tick();
    phaseBusy();
    task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    await refused;
    expect(task.close).toHaveBeenCalledTimes(1);
    phaseAvailable();
  }
);
test('rejected closure is sanitized and never releases unproven phase drainage', async () => {
  const task = controlled(valid, { holdExit: true });
  const work = prepare();
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  task.exit.reject(Error('private exit detail'));
  await refused;
  phaseBusy();
});
test.each(['regression', 'equal-deadline'])(
  'monotonic %s refuses without timer dispatch',
  async (mode) => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    controlled(async (broker) => {
      await broker.dispatch(inputWire);
      now = mode === 'regression' ? 99 : 110;
      await broker.dispatch(resultWire());
    });
    await expect(prepare({ timeoutMs: 10 })).rejects.toMatchObject(refusal);
    phaseAvailable();
  }
);
test('active timeout closes child while retaining phase through observed exit', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const hold = deferred();
  const task = controlled(
    async (broker) => {
      await broker.dispatch(inputWire);
      await hold.promise;
    },
    { holdExit: true }
  );
  const work = prepare({ timeoutMs: 30 });
  const refused = expect(work).rejects.toMatchObject(refusal);
  try {
    await tick();
    jest.advanceTimersByTime(30);
    expect(task.options().broker.signal.aborted).toBe(true);
    phaseBusy();
    hold.resolve();
    task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    await refused;
    phaseAvailable();
  } finally {
    jest.useRealTimers();
  }
});

test('recovery phase is claimed synchronously before invoking the utility factory', async () => {
  const task = controlled(valid);
  const start = mockStart.getMockImplementation();
  mockStart.mockImplementation((options) => {
    phaseBusy();
    return start(options);
  });
  const work = prepare();
  expect(mockStart).toHaveBeenCalledTimes(1);
  await work;
  expect(task.close).toHaveBeenCalledTimes(1);
  phaseAvailable();
});
