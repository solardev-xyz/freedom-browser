// Genuine issuer/process assertions are explicit structural seams. Canonical
// intent/signature normalization and the fixed job's wire path are real; the
// one actual-job test mocks engine Poseidon/EDDSA and never opens an archive.
const mock = {};
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment: (value) => mock.fence(value),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.identity(...args),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => mock.archive(value),
}));
jest.mock('./railgun-process', () => ({ startRailgunProcess: (value) => mock.start(value) }));
jest.mock(
  '/signature-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    initPoseidonPromise: Promise.resolve(),
    poseidon: (...args) => mock.poseidon(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/signature-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    verifyEDDSA: (...args) => mock.verify(...args),
  }),
  { virtual: true }
);
const { createHash } = require('crypto');
const { verifyRailgunRelaySignature: verify } = require('./railgun-relay-signature-verify');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const { EXPECTED_GUARDS } = require('./railgun-relay-quote-data');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const refusal = { code: 'RAILGUN_RELAY_SIGNATURE_VERIFICATION_REFUSED' };
const unknown = { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' };
let f;
function setup() {
  const data = createRailgunRelayUnsignedData(),
    ready = deferred(),
    exit = deferred(),
    closedReached = deferred(),
    cancel = new AbortController(),
    enrollmentSignal = new AbortController(),
    identitySignal = new AbortController(),
    handle = Object.freeze({});
  const descriptor = {
    walletId: data.context.walletId,
    instanceId: data.context.self.address,
    masterPublicKey: BigInt(data.context.self.masterPublicKey).toString(16).padStart(64, '0'),
    viewingPublicKey: data.context.self.viewingPublicKey,
    spendingPublicKey: [hex(5).slice(2), hex(6).slice(2)],
    accountIndex: 0,
  };
  const enrollment = { signal: enrollmentSignal.signal, getContext: jest.fn(() => handle) },
    identity = { signal: identitySignal.signal };
  mock.fence = jest.fn((value) => {
    if (value !== enrollment) throw Error('not genuine');
  });
  mock.identity = jest.fn((value, actualHandle) => {
    if (value !== identity || actualHandle !== handle) throw Error('not genuine');
    return descriptor;
  });
  mock.archive = jest.fn(() => '/signature-engine.asar');
  const closedValue = {
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  };
  const task = {
    ready: ready.promise,
    closed: exit.promise,
    close: jest.fn(() => {
      closedReached.resolve();
      exit.resolve(closedValue);
    }),
  };
  mock.start = jest.fn((options) => {
    mock.options = options;
    return task;
  });
  mock.options = undefined;
  mock.poseidon = jest.fn(() => 11n);
  mock.verify = jest.fn(() => true);
  const signature = { R8: [hex(8), hex(9)], S: hex(10) };
  const options = {
    enrollment,
    identity,
    archive: '/signature-engine.asar',
    intent: data.draft.intent,
    recordDigest: '12'.repeat(32),
    signature,
    signal: cancel.signal,
    timeoutMs: 30000,
  };
  const intent = normalizeRailgunRelayUnsignedIntent(options.intent);
  const expected = {
    recordDigest: options.recordDigest,
    intentDigest: intent.digest,
    message: intent.data.expectedHash,
    signatureDigest: createHash('sha256')
      .update(JSON.stringify(normalizeRailgunSignature(signature)))
      .digest('hex'),
    signatureVerified: true,
  };
  const wire = () =>
    JSON.stringify({
      id: 1,
      method: 'result',
      value: {
        ...expected,
        guards: EXPECTED_GUARDS,
        inventory: require('./railgun-engine-manifest.json').inventory.sha256,
      },
    });
  return {
    options,
    expected,
    wire,
    ready,
    exit,
    task,
    closedReached,
    closedValue,
    cancel,
    enrollmentSignal,
    identitySignal,
    descriptor,
    handle,
  };
}
beforeEach(() => {
  f = setup();
});
afterEach(() => {
  f.cancel.abort();
  f.ready.resolve();
  f.exit.resolve(f.closedValue);
  jest.restoreAllMocks();
});
async function finish(work) {
  await mock.options.broker.dispatch(f.wire());
  f.ready.resolve();
  return work;
}
test('fixed keyless job receives only genuine public key and immutable original signature binding', async () => {
  const original = verify(f.options),
    value = await finish(original);
  expect(Object.isFrozen(value)).toBe(true);
  expect(value).toEqual(f.expected);
  expect(mock.options.filename).toBe(require.resolve('./railgun-relay-signature-verify-job'));
  expect(mock.options.binaryKey).toBe(false);
  expect(mock.options.startupMs).toBeGreaterThan(0);
  expect(mock.options.startupMs).toBeLessThanOrEqual(30000);
  expect(mock.options.lifetimeMs).toBe(mock.options.startupMs);
  expect(mock.options).not.toHaveProperty('storage');
  expect(mock.options).not.toHaveProperty('createProvider');
  const input = JSON.parse(mock.options.input);
  expect(Object.keys(input).sort()).toEqual([
    'archive',
    'intent',
    'recordDigest',
    'signature',
    'spendingPublicKey',
  ]);
  expect(input.spendingPublicKey).toEqual([hex(5), hex(6)]);
  expect(input.signature).toEqual(f.options.signature);
  expect(f.task.close).toHaveBeenCalledTimes(1);
  expect(f.options.enrollment.getContext).toHaveBeenCalledWith('prover', 'relay-signature-verify');
});
test('actual raw C job result envelope composes with host (engine math explicitly mocked)', async () => {
  mock.start.mockImplementation((options) => {
    mock.options = options;
    f.task.ready = require('./railgun-relay-signature-verify-job').run(options.input, {
      signal: f.cancel.signal,
      request: (wire) => options.broker.dispatch(wire),
      guardReport: () => EXPECTED_GUARDS,
    });
    return f.task;
  });
  await expect(verify(f.options)).resolves.toEqual(f.expected);
  expect(mock.verify).toHaveBeenCalledWith(11n, { R8: [8n, 9n], S: 10n }, [5n, 6n]);
  expect(mock.poseidon).toHaveBeenCalledTimes(1);
});
test.each(['walletId', 'address', 'masterPublicKey', 'viewingPublicKey'])(
  'different self %s fails before archive or child',
  async (field) => {
    if (field === 'walletId') f.descriptor.walletId = '13'.repeat(32);
    if (field === 'address') f.descriptor.instanceId = '0zk1' + 'q'.repeat(123);
    if (field === 'masterPublicKey') f.descriptor.masterPublicKey = hex(8).slice(2);
    if (field === 'viewingPublicKey') f.descriptor.viewingPublicKey = '13'.repeat(32);
    await expect(verify(f.options)).rejects.toMatchObject(refusal);
    expect(mock.archive).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
  }
);
test.each([
  'options',
  'signature',
  'point',
  'array-proxy',
  'signature-proxy',
  'signal-proxy',
  'signal-aborted',
  'signal-reason',
])('refuses %s accessors/proxies without invoking caller code', async (mode) => {
  let calls = 0;
  const getter = () => {
    calls++;
    throw Error('caller');
  };
  if (mode === 'options') Object.defineProperty(f.options, 'intent', { get: getter });
  if (mode === 'signature') Object.defineProperty(f.options.signature, 'S', { get: getter });
  if (mode === 'point') Object.defineProperty(f.options.signature.R8, '0', { get: getter });
  if (mode === 'array-proxy')
    f.options.signature.R8 = new Proxy(f.options.signature.R8, {
      get: getter,
      getPrototypeOf: getter,
    });
  if (mode === 'signature-proxy')
    f.options.signature = new Proxy(f.options.signature, { get: getter, getPrototypeOf: getter });
  if (mode === 'signal-proxy')
    f.options.signal = new Proxy(f.cancel.signal, { getPrototypeOf: getter });
  if (mode === 'signal-aborted')
    Object.defineProperty(f.options.signal, 'aborted', { get: getter });
  if (mode === 'signal-reason') Object.defineProperty(f.options.signal, 'reason', { get: getter });
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(calls).toBe(0);
  expect(mock.start).not.toHaveBeenCalled();
});
test.each([0, -1, 30001, 1.5, NaN])('refuses timeout %s before runtime', async (timeoutMs) => {
  f.options.timeoutMs = timeoutMs;
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(mock.archive).not.toHaveBeenCalled();
  expect(mock.start).not.toHaveBeenCalled();
});
test('foreign enrollment cannot run its getContext or signal getters', async () => {
  let calls = 0;
  f.options.enrollment = {
    get signal() {
      calls++;
      throw Error();
    },
    getContext() {
      calls++;
      throw Error();
    },
  };
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(calls).toBe(0);
});
test('captures mutable caller intent/signature/record digest before original ready await', async () => {
  const work = verify(f.options),
    sent = mock.options.input;
  f.options.signature.S = hex(11);
  f.options.signature.R8[0] = hex(22);
  f.options.recordDigest = '33'.repeat(32);
  f.options.intent.context.self.masterPublicKey = '8';
  expect(mock.options.input).toBe(sent);
  await expect(finish(work)).resolves.toEqual(f.expected);
});
test.each([
  'recordDigest',
  'intentDigest',
  'message',
  'signatureDigest',
  'signatureVerified',
  'inventory',
  'unknown',
  'id',
  'method',
  'missing-guards',
  'nonzero-guards',
  'hook-replaced',
  'hook-missing',
  'hook-extra',
  'duplicate',
])('refuses %s result and observes original child', async (mode) => {
  const work = verify(f.options),
    message = JSON.parse(f.wire());
  if (['recordDigest', 'intentDigest', 'message', 'signatureDigest', 'inventory'].includes(mode))
    message.value[mode] = '00'.repeat(32);
  if (mode === 'signatureVerified') message.value.signatureVerified = false;
  if (mode === 'unknown') message.value.authority = true;
  if (mode === 'id') message.id = 2;
  if (mode === 'method') message.method = 'key';
  if (mode === 'missing-guards') delete message.value.guards;
  if (mode === 'nonzero-guards') message.value.guards.attempts = 1;
  if (mode === 'hook-replaced') message.value.guards.hooks[0] = 'substitute';
  if (mode === 'hook-missing') message.value.guards.hooks.pop();
  if (mode === 'hook-extra') message.value.guards.hooks.push('extra');
  if (mode === 'duplicate') await mock.options.broker.dispatch(f.wire());
  await expect(mock.options.broker.dispatch(JSON.stringify(message))).rejects.toMatchObject(
    refusal
  );
  f.ready.resolve();
  await expect(work).rejects.toMatchObject(refusal);
  expect(f.task.close).toHaveBeenCalledTimes(1);
});
test('swallowed broker refusal cannot be followed by valid result', async () => {
  const work = verify(f.options);
  await mock.options.broker.dispatch('{}').catch(() => {});
  await expect(mock.options.broker.dispatch(f.wire())).rejects.toMatchObject(refusal);
  f.ready.resolve();
  await expect(work).rejects.toMatchObject(refusal);
});
test('held original ready and closed survive abort and concurrent owner refuses', async () => {
  f.task.close.mockImplementation(() => f.closedReached.resolve());
  const work = verify(f.options);
  let settled = false;
  work.catch(() => {
    settled = true;
  });
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(mock.start).toHaveBeenCalledTimes(1);
  f.cancel.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  f.exit.resolve(f.closedValue);
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  f.ready.reject(Error('original cancellation'));
  await expect(work).rejects.toMatchObject(refusal);
});
test('successful result and close request still wait for original closed', async () => {
  f.task.close.mockImplementation(() => f.closedReached.resolve());
  const work = verify(f.options);
  await mock.options.broker.dispatch(f.wire());
  f.ready.resolve();
  await f.closedReached.promise;
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  f.exit.resolve(f.closedValue);
  await expect(work).resolves.toEqual(f.expected);
});
test('throwing close does not skip the original closed barrier', async () => {
  f.task.close.mockImplementation(() => {
    f.closedReached.resolve();
    throw Error('close');
  });
  const work = verify(f.options);
  await mock.options.broker.dispatch(f.wire());
  f.ready.resolve();
  await f.closedReached.promise;
  let settled = false;
  work.catch(() => {
    settled = true;
  });
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  f.exit.resolve(f.closedValue);
  await expect(work).rejects.toMatchObject(refusal);
});
test.each(['reject', 'malformed', 'thenable'])(
  'unknown closed %s retains busy and original readiness',
  async (mode) => {
    f.task.close.mockImplementation(() => f.closedReached.resolve());
    let thenCalls = 0;
    if (mode === 'thenable')
      f.task.closed = {
        then() {
          thenCalls++;
        },
      };
    const work = verify(f.options);
    let settled = false;
    work.catch(() => {
      settled = true;
    });
    if (mode === 'reject') f.exit.reject(Error('unobserved'));
    if (mode === 'malformed') f.exit.resolve({ code: 'closed' });
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    f.ready.resolve();
    await expect(work).rejects.toMatchObject(unknown);
    expect(thenCalls).toBe(0);
    await expect(verify(f.options)).rejects.toMatchObject(refusal);
    expect(mock.start).toHaveBeenCalledTimes(1);
  }
);
test('malformed ready does not abandon independently captured original closed', async () => {
  let thenCalls = 0;
  f.task.ready = {
    then() {
      thenCalls++;
    },
  };
  f.task.close.mockImplementation(() => f.closedReached.resolve());
  const work = verify(f.options);
  let settled = false;
  work.catch(() => {
    settled = true;
  });
  await f.closedReached.promise;
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  f.exit.resolve(f.closedValue);
  await expect(work).rejects.toMatchObject(unknown);
  expect(thenCalls).toBe(0);
});
test.each(['fence', 'identity', 'descriptor', 'signal', 'expired', 'rollback'])(
  'rechecks %s after held original closure',
  async (mode) => {
    let now = 10;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    f.task.close.mockImplementation(() => f.closedReached.resolve());
    const work = verify(f.options);
    await mock.options.broker.dispatch(f.wire());
    f.ready.resolve();
    await f.closedReached.promise;
    if (mode === 'fence')
      mock.fence.mockImplementation(() => {
        throw Error('revoked');
      });
    if (mode === 'identity')
      mock.identity.mockImplementation(() => {
        throw Error('revoked');
      });
    if (mode === 'descriptor') f.descriptor.spendingPublicKey = [hex(7).slice(2), hex(8).slice(2)];
    if (mode === 'signal') f.identitySignal.abort();
    if (mode === 'expired') now = 30010;
    if (mode === 'rollback') now = 9;
    f.exit.resolve(f.closedValue);
    await expect(work).rejects.toMatchObject(refusal);
  }
);
test.each(['abort', 'timeout', 'clock-backwards'])(
  'post-owner %s recheck refuses before launching',
  async (mode) => {
    let now = 10;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    f.options.enrollment.getContext
      .mockImplementationOnce(() => f.handle)
      .mockImplementation(() => {
        if (mode === 'abort') f.cancel.abort();
        if (mode === 'timeout') now = 30010;
        if (mode === 'clock-backwards') now = 9;
        return f.handle;
      });
    await expect(verify(f.options)).rejects.toMatchObject(refusal);
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.archive).not.toHaveBeenCalled();
  }
);
test('runtime verification consumes the same deadline and is rechecked before launch', async () => {
  let now = 10;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mock.archive.mockImplementation(() => {
    now = 30010;
    return '/signature-engine.asar';
  });
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(mock.start).not.toHaveBeenCalled();
});
test('post-drain owner check cannot publish after a final synchronous revocation', async () => {
  const work = verify(f.options);
  await mock.options.broker.dispatch(f.wire());
  let calls = 0;
  mock.identity.mockImplementation(() => {
    calls++;
    if (calls === 3) f.cancel.abort();
    return f.descriptor;
  });
  f.ready.resolve();
  await expect(work).rejects.toMatchObject(refusal);
  expect(calls).toBe(3);
});
test.each(['code', 'exitCode', 'escalated', 'peerDisconnected'])(
  'observed invalid %s refuses verification',
  async (field) => {
    f.closedValue[field] = field === 'code' ? 'FAILED' : field === 'exitCode' ? 0 : true;
    const work = verify(f.options);
    await mock.options.broker.dispatch(f.wire());
    f.ready.resolve();
    await expect(work).rejects.toMatchObject(refusal);
  }
);

test('invalid returned task cannot release possibly launched process ownership', async () => {
  mock.start.mockReturnValue(null);
  await expect(verify(f.options)).rejects.toMatchObject(unknown);
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(mock.start).toHaveBeenCalledTimes(1);
});
test('getContext reentry cannot start a second verifier over the same enrollment', async () => {
  let reentered;
  f.options.enrollment.getContext.mockImplementationOnce(() => {
    reentered = verify(f.options);
    reentered.catch(() => {});
    return f.handle;
  });
  const work = verify(f.options);
  await expect(reentered).rejects.toMatchObject(refusal);
  await expect(finish(work)).resolves.toEqual(f.expected);
  expect(mock.start).toHaveBeenCalledTimes(1);
});

// Native Promise species can return an unrelated thenable from intrinsic then.
// Neither ready nor closed may be represented by that caller-controlled value.
test.each(['ready', 'closed'])(
  'ignores native %s species return and retains the original',
  async (barrier) => {
    const calls = jest.fn();
    const fake = {
      then(resolve) {
        calls('then');
        resolve(barrier === 'closed' ? f.closedValue : undefined);
      },
      catch() {
        calls('catch');
        return this;
      },
    };
    function Species(executor) {
      executor(
        () => {},
        () => {}
      );
      return fake;
    }
    Object.defineProperty(f.task[barrier], 'constructor', { value: { [Symbol.species]: Species } });
    f.task.close.mockImplementation(() => f.closedReached.resolve());
    const work = verify(f.options);
    let settled = false;
    work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await mock.options.broker.dispatch(f.wire());
    if (barrier === 'ready') f.exit.resolve(f.closedValue);
    else f.ready.resolve();
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
    if (barrier === 'ready') f.ready.resolve();
    else f.exit.resolve(f.closedValue);
    await expect(work).resolves.toEqual(f.expected);
    expect(calls).not.toHaveBeenCalled();
  }
);
test('species registration failure retains quarantine after the other original closes', async () => {
  Object.defineProperty(f.task.ready, 'constructor', {
    get() {
      throw Error('registration failed');
    },
  });
  await expect(verify(f.options)).rejects.toMatchObject(unknown);
  await expect(verify(f.options)).rejects.toMatchObject(refusal);
  expect(mock.start).toHaveBeenCalledTimes(1);
});
