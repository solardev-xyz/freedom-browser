let mockIdentity, mockEnrollment, mockPreparation, mockPrepared, mockMode, mockExit, mockRelease;
const mockStart = jest.fn();
const mockCredential = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mockEnrollment,
}));
const mockViewingKey = Buffer.alloc(32, 7);
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-shield-prepare', () => ({
  assertRailgunShieldPreparation: (receipt, identity, enrollment) => {
    if (
      receipt !== mockPreparation ||
      identity !== mockIdentity ||
      enrollment !== mockEnrollment ||
      identity.signal.aborted
    )
      throw Error('Invalid preparation');
    return mockPrepared;
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity) => {
    if (identity !== mockIdentity || identity.signal.aborted) throw Error('Invalid identity');
    return identity.descriptor;
  },
  withRailgunViewingCredential: (...args) => mockCredential(...args),
}));
const {
  verifyRailgunShieldReceiver,
  assertRailgunShieldReceiver,
} = require('./railgun-shield-receive');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
let copiedKey,
  scope,
  sequence = 0;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  mockExit = mockRelease = copiedKey = undefined;
  const abort = new AbortController();
  scope = createPrivacyScope({ profileId: 'shield-receive-test', signal: abort.signal });
  mockCredential.mockImplementation(async (_identity, callback) => {
    const result = callback({ viewingKey: mockViewingKey });
    if (mockMode === 'late-key') {
      mockEnrollment.close();
      throw Error('Revoked credential');
    }
    return result;
  });
  mockIdentity = { signal: abort.signal, descriptor: { instanceId: 'fixture-recipient' } };
  mockEnrollment = {
    directory: '/fixture/shield-receive-' + ++sequence,
    signal: abort.signal,
    close: () => abort.abort(),
    getContext: jest.fn((role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      })
    ),
  };
  mockPreparation = Object.freeze({});
  mockPrepared = Object.freeze({
    commitment: 'fixture-commitment',
    noteValue: '99750',
    npk: 'fixture-npk',
    recipient: 'fixture-recipient',
  });
  mockStart.mockImplementation(({ broker, binaryKey, filename }) => {
    expect(binaryKey).toBe(true);
    expect(filename).toBe(require.resolve('./railgun-shield-receive-job'));
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const ready = Promise.resolve().then(async () => {
      copiedKey = await broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'shield-receive' })
      );
      expect(copiedKey).not.toBe(mockViewingKey);
      expect(copiedKey.byteOffset).toBe(0);
      expect(copiedKey.buffer.byteLength).toBe(32);
      expect(copiedKey.equals(mockViewingKey)).toBe(true);
      // The supervisor owns/wipes this returned buffer after transferring it.
      copiedKey.fill(0);
      if (mockMode === 'drain')
        await new Promise((resolve) => {
          mockRelease = resolve;
        });
      if (mockMode === 'replay-key')
        await broker.dispatch(JSON.stringify({ id: 2, method: 'key', purpose: 'shield-receive' }));
      const value = { ...mockPrepared, verified: true, guards: { attempts: 0 }, inventory };
      if (mockMode === 'recipient') value.recipient = 'foreign';
      if (mockMode === 'commitment') value.commitment = 'foreign';
      if (mockMode === 'inventory') value.inventory = 'foreign';
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
afterEach(() => {
  scope.close();
  jest.restoreAllMocks();
});
const verify = (options = {}) =>
  verifyRailgunShieldReceiver({
    identity: mockIdentity,
    enrollment: mockEnrollment,
    preparation: mockPreparation,
    archive: '/fixture/engine.asar',
    ...options,
  });
test('receiver receipt binds the exact preparation and enrollment and expires with preparation', async () => {
  const receipt = await verify();
  expect(assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)).toBe(
    mockPrepared
  );
  expect(mockEnrollment.getContext).toHaveBeenCalledWith('engine', 'shield-receive');
  expect(copiedKey.every((v) => v === 0)).toBe(true);
  expect(mockViewingKey.every((v) => v === 7)).toBe(true);
  expect(() =>
    assertRailgunShieldReceiver({}, mockIdentity, mockEnrollment, mockPreparation)
  ).toThrow();
  expect(() =>
    assertRailgunShieldReceiver(receipt, mockIdentity, { ...mockEnrollment }, mockPreparation)
  ).toThrow();
  mockPreparation = Object.freeze({});
  expect(() =>
    assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)
  ).toThrow();
});
test.each(['recipient', 'commitment', 'inventory', 'egress', 'extra', 'replay-key', 'late-key'])(
  'refuses %s without issuing a receipt',
  async (mode) => {
    mockMode = mode;
    await expect(verify()).rejects.toThrow('Railgun shield receiver unavailable');
  }
);
test('lock during work drains the process before returning failure', async () => {
  mockMode = 'drain';
  let settled = false;
  const pending = verify().finally(() => {
    settled = true;
  });
  const rejected = expect(pending).rejects.toThrow();
  for (let n = 0; n < 20 && !mockRelease; n++) await Promise.resolve();
  expect(mockRelease).toBeDefined();
  await expect(verify()).rejects.toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
  mockEnrollment.close();
  mockRelease();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await rejected;
});

const refusal = {
  code: 'RAILGUN_SHIELD_RECEIVER_REFUSED',
  message: 'Railgun shield receiver unavailable',
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
const keyWire = JSON.stringify({ id: 1, method: 'key', purpose: 'shield-receive' });
const resultWire = () =>
  JSON.stringify({
    id: 2,
    method: 'result',
    value: { ...mockPrepared, verified: true, guards: { attempts: 0 }, inventory },
  });
function controlled(run, { holdExit = false, throwClose = false } = {}) {
  const exit = deferred();
  let options;
  const close = jest.fn(() => {
    if (!holdExit) exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    if (throwClose) throw Error('private cleanup detail');
  });
  mockStart.mockImplementation((value) => {
    options = value;
    return { ready: Promise.resolve().then(() => run(value.broker)), closed: exit.promise, close };
  });
  return { exit, close, options: () => options };
}
const valid = async (broker) => {
  copiedKey = await broker.dispatch(keyWire);
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
  { timeoutMs: 0.5 },
  { timeoutMs: Infinity },
  { timeoutMs: '30000' },
])('invalid lifetime %p refuses before phase/utility/key', async (options) => {
  await expect(verify(options)).rejects.toMatchObject(refusal);
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockCredential).not.toHaveBeenCalled();
  phaseAvailable();
});
test.each([1, 120001, 180000])(
  'bounded %i ms configuration keeps opaque receiver receipt',
  async (timeoutMs) => {
    jest.spyOn(performance, 'now').mockReturnValue(50);
    const task = controlled(valid);
    const receipt = await verify({ timeoutMs });
    expect(Object.keys(receipt)).toEqual([]);
    expect(
      assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)
    ).toBe(mockPrepared);
    expect(task.options()).toMatchObject({
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
    });
    expect(copiedKey.every((byte) => byte === 0)).toBe(true);
    phaseAvailable();
  }
);
test.each(['wallet', 'txid', 'recovery'])(
  'existing %s phase prevents receiver key admission',
  async (kind) => {
    const phase = claimRailgunAccountPhase(mockEnrollment, kind);
    try {
      await expect(verify()).rejects.toMatchObject(refusal);
      expect(mockStart).not.toHaveBeenCalled();
      expect(mockCredential).not.toHaveBeenCalled();
    } finally {
      phase.release();
    }
  }
);
test.each([
  Buffer.alloc(31),
  Buffer.alloc(33),
  new Uint8Array(0),
  Array(32).fill(7),
  'a'.repeat(32),
  null,
])('credential must be actual exact 32 bytes (%p)', async (key) => {
  mockCredential.mockImplementation(async (_identity, use) => use({ viewingKey: key }));
  controlled(valid);
  await expect(verify()).rejects.toMatchObject(refusal);
  phaseAvailable();
});
test('exact Uint8Array credential is copied separately and host wipes borrowed output after success', async () => {
  const key = new Uint8Array(32).fill(9);
  mockCredential.mockImplementation(async (_identity, use) => use({ viewingKey: key }));
  controlled(async (broker) => {
    copiedKey = await broker.dispatch(keyWire);
    expect([...copiedKey]).toEqual([...key]);
    expect(copiedKey.buffer).not.toBe(key.buffer);
    await broker.dispatch(resultWire());
  });
  await verify();
  expect(key.every((byte) => byte === 9)).toBe(true);
  expect(copiedKey.every((byte) => byte === 0)).toBe(true);
});
test.each(['malformed', 'wrong-purpose', 'wrong-id', 'early-result', 'extra-after-result'])(
  'caught %s is permanently refused even with valid following messages',
  async (mode) => {
    let failure;
    const task = controlled(async (broker) => {
      if (mode === 'extra-after-result') await valid(broker);
      const wire =
        mode === 'malformed'
          ? '{private secret'
          : mode === 'wrong-purpose'
            ? JSON.stringify({ id: 1, method: 'key', purpose: 'other' })
            : mode === 'wrong-id'
              ? JSON.stringify({ id: 0, method: 'key', purpose: 'shield-receive' })
              : resultWire();
      const rejected = broker.dispatch(wire).catch((error) => {
        failure = error;
      });
      expect(broker.signal.aborted).toBe(true);
      await rejected;
      await expect(broker.dispatch(keyWire)).rejects.toMatchObject(refusal);
      await expect(broker.dispatch(resultWire())).rejects.toMatchObject(refusal);
    });
    await expect(verify()).rejects.toMatchObject(refusal);
    expect(failure).toMatchObject(refusal);
    expect(mockCredential).toHaveBeenCalledTimes(mode === 'extra-after-result' ? 1 : 0);
    expect(task.close).toHaveBeenCalledTimes(1);
    phaseAvailable();
  }
);
test.each(['early-result', 'malformed', 'abort'])(
  '%s while derivation is pending retains phase AFTER child exit and admits no key copy',
  async (mode) => {
    const derive = deferred(),
      caller = new AbortController();
    let invoked = false,
      keyWork,
      failure;
    mockCredential.mockImplementation(async (_identity, use) => {
      await derive.promise;
      invoked = true;
      return use({ viewingKey: mockViewingKey });
    });
    const task = controlled(async (broker) => {
      keyWork = broker.dispatch(keyWire);
      keyWork.catch(() => {});
      if (mode === 'abort') caller.abort();
      else
        failure = await broker
          .dispatch(mode === 'early-result' ? resultWire() : '{bad')
          .catch((error) => error);
      // Simulate utility exit while a borrowed dispatch is still pending.
    });
    let settled = false;
    const work = verify({ signal: caller.signal }).finally(() => {
      settled = true;
    });
    const refused = expect(work).rejects.toMatchObject(refusal);
    await tick();
    expect(task.close).toHaveBeenCalledTimes(1);
    await task.exit.promise;
    expect(settled).toBe(false);
    expect(invoked).toBe(false);
    phaseBusy();
    if (mode !== 'abort') expect(failure).toMatchObject(refusal);
    derive.resolve();
    await expect(keyWork).rejects.toMatchObject(refusal);
    await refused;
    expect(copiedKey).toBeUndefined();
    phaseAvailable();
  }
);
test('cancellation after credential copy wipes it while credential callback and child still drain', async () => {
  const borrowed = deferred(),
    caller = new AbortController();
  let output, keyWork;
  mockCredential.mockImplementation(async (_identity, use) => {
    output = use({ viewingKey: mockViewingKey });
    await borrowed.promise;
    return output;
  });
  const task = controlled(
    async (broker) => {
      keyWork = broker.dispatch(keyWire);
      keyWork.catch(() => {});
      await keyWork;
    },
    { holdExit: true }
  );
  const work = verify({ signal: caller.signal });
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  expect(output.every((byte) => byte === 7)).toBe(true);
  caller.abort();
  expect(output.length).toBe(32);
  expect(output.every((byte) => byte === 0)).toBe(true);
  task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await tick();
  phaseBusy();
  borrowed.resolve();
  await expect(keyWork).rejects.toMatchObject(refusal);
  await refused;
  phaseAvailable();
});
test.each(['cancel', 'refuse'])(
  'synchronous factory %s closes late task exactly once',
  async (mode) => {
    const caller = new AbortController(),
      exit = deferred();
    const close = jest.fn(() => exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' }));
    mockStart.mockImplementation(({ broker }) => {
      if (mode === 'cancel') caller.abort();
      else broker.dispatch('{bad').catch(() => {});
      return { ready: Promise.resolve(), closed: exit.promise, close };
    });
    await expect(verify({ signal: caller.signal })).rejects.toMatchObject(refusal);
    expect(mockCredential).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    phaseAvailable();
  }
);
test.each(['success', 'abort'])('throwing close on %s cannot skip observed exit', async (mode) => {
  const caller = new AbortController(),
    readyGate = deferred();
  const task = controlled(
    async (broker) => {
      await valid(broker);
      if (mode === 'abort') await readyGate.promise;
    },
    { holdExit: true, throwClose: true }
  );
  const work = verify({ signal: caller.signal });
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  if (mode === 'abort') {
    expect(() => caller.abort()).not.toThrow();
    readyGate.resolve();
  }
  await tick();
  phaseBusy();
  task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await refused;
  phaseAvailable();
  expect(copiedKey.every((byte) => byte === 0)).toBe(true);
});
test('rejected child closure still awaits borrowed derivation and retains unproven phase', async () => {
  const derive = deferred();
  let keyWork;
  mockCredential.mockImplementation(async (_identity, use) => {
    await derive.promise;
    return use({ viewingKey: mockViewingKey });
  });
  const task = controlled(
    async (broker) => {
      keyWork = broker.dispatch(keyWire);
      keyWork.catch(() => {});
    },
    { holdExit: true }
  );
  let settled = false;
  const work = verify().finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  task.exit.reject(Error('private barrier detail'));
  await tick();
  expect(settled).toBe(false);
  phaseBusy();
  derive.resolve();
  await expect(keyWork).rejects.toMatchObject(refusal);
  await refused;
  phaseBusy();
});
test.each(['regression', 'equal-deadline'])(
  'clock %s in derived credential callback refuses before copying',
  async (mode) => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockCredential.mockImplementation(async (_identity, use) => {
      now = mode === 'regression' ? 99 : 110;
      return use({ viewingKey: mockViewingKey });
    });
    controlled(valid);
    await expect(verify({ timeoutMs: 10 })).rejects.toMatchObject(refusal);
    expect(copiedKey).toBeUndefined();
    phaseAvailable();
  }
);
test('caller abort revokes completed receiver receipt without changing prepared receipt', async () => {
  const caller = new AbortController();
  const receipt = await verify({ signal: caller.signal });
  expect(assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)).toBe(
    mockPrepared
  );
  caller.abort();
  expect(() =>
    assertRailgunShieldReceiver(receipt, mockIdentity, mockEnrollment, mockPreparation)
  ).toThrow();
  phaseAvailable();
});
test('timer revokes pending derivation, waits exit and borrowed callback before phase release', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  const derive = deferred();
  mockCredential.mockImplementation(async (_identity, use) => {
    await derive.promise;
    return use({ viewingKey: mockViewingKey });
  });
  const task = controlled(valid, { holdExit: true });
  const work = verify({ timeoutMs: 30 });
  const refused = expect(work).rejects.toMatchObject(refusal);
  try {
    await tick();
    jest.advanceTimersByTime(30);
    expect(task.options().broker.signal.aborted).toBe(true);
    phaseBusy();
    task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    derive.resolve();
    await refused;
    phaseAvailable();
  } finally {
    jest.useRealTimers();
  }
});

test('receiver phase is claimed synchronously before utility startup', async () => {
  controlled(valid);
  const start = mockStart.getMockImplementation();
  mockStart.mockImplementation((options) => {
    phaseBusy();
    return start(options);
  });
  const work = verify();
  expect(mockStart).toHaveBeenCalledTimes(1);
  await work;
  phaseAvailable();
});
test('cancellation after valid result before child exit prevents receiver publication', async () => {
  const caller = new AbortController();
  const task = controlled(valid, { holdExit: true });
  let settled = false;
  const work = verify({ signal: caller.signal }).finally(() => {
    settled = true;
  });
  const refused = expect(work).rejects.toMatchObject(refusal);
  await tick();
  expect(task.close).toHaveBeenCalledTimes(1);
  caller.abort();
  await tick();
  expect(settled).toBe(false);
  phaseBusy();
  expect(copiedKey.every((byte) => byte === 0)).toBe(true);
  task.exit.resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
  await refused;
  phaseAvailable();
});
