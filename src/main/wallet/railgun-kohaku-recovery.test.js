/** Fixed-owner seams are structural mocks. These tests qualify forwarding and
 * lifetime sequencing, not genuine enrollment or cryptographic authority. */
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.owners.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mock.identity(...args),
}));
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublicDestination: (...args) => mock.destination(...args),
}));
jest.mock('./railgun-private-recovery-history', () => ({
  readRailgunPrivateRecoveryHistory: (...args) => mock.history(...args),
}));
jest.mock('./railgun-private-proof-recovery', () => ({
  resumeRailgunAccountPrivateProof: (...args) => mock.resume(...args),
}));
jest.mock('./railgun-private-submission', () => ({
  submitRailgunRecoveredPrivateTransaction: (...args) => mock.submit(...args),
}));
const { createRailgunKohakuRecovery: create } = require('./railgun-kohaku-recovery');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const holdId = 'a'.repeat(64);
const code = 'RAILGUN_KOHAKU_RECOVERY_REFUSED';
let companions;
beforeEach(() => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const descriptor = Object.freeze({ walletId: 'b'.repeat(64), accountIndex: 0 });
  const parent = Object.freeze({});
  const owners = {
    identity: { signal: controllers[0].signal, descriptor, close: jest.fn() },
    enrollment: {
      signal: controllers[1].signal,
      descriptor,
      getContext: jest.fn(() => parent),
      openPrivateRecoveryStores: jest.fn(),
      close: jest.fn(),
    },
    coordinator: { signal: controllers[2].signal, close: jest.fn() },
  };
  const destination = Object.freeze({});
  mock = {
    owners,
    controllers,
    parent,
    history: jest.fn(() =>
      Promise.resolve(Object.freeze({ records: [], nextAfter: null, totalSigning: 0 }))
    ),
    resume: jest.fn(() =>
      Promise.resolve(
        Object.freeze({
          status: 'proof-stored',
          holdId,
          transactionDigest: '0x' + '1'.repeat(64),
          submissionEnabled: false,
        })
      )
    ),
    submit: jest.fn(() =>
      Promise.resolve(
        Object.freeze({ transactionHash: '0x' + '2'.repeat(64), submissionStatus: 'unknown' })
      )
    ),
  };
  mock.identity = jest.fn((value, context) => {
    expect(value).toBe(owners.identity);
    expect(context).toBe(parent);
    if (value.signal.aborted) throw Error('closed');
    return value.descriptor;
  });
  mock.destination = jest.fn((coordinator, enrollment, value) => {
    expect(coordinator).toBe(owners.coordinator);
    expect(enrollment).toBe(owners.enrollment);
    expect(value).toBe(destination);
  });
  mock.options = {
    owners,
    destination,
    archive: '/archive',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    reviewDisclosures: jest.fn(),
    reviewTransaction: jest.fn(),
    gasLimit: 1500000n,
    maxGasFee: 2000000000000000n,
    signal: controllers[3].signal,
  };
  companions = [];
});
afterEach(async () => {
  for (const c of companions) {
    c.close();
    await c.closed;
  }
  for (const owner of Object.values(mock.owners)) expect(owner.close).not.toHaveBeenCalled();
});
const open = () => {
  const c = create(mock.options);
  companions.push(c);
  return c;
};
test('construction authenticates owners but performs no storage or controller work', () => {
  const c = open();
  expect(Object.keys(c).sort()).toEqual([
    'close',
    'closed',
    'history',
    'resumeProof',
    'signal',
    'submitStored',
  ]);
  expect(Object.isFrozen(c)).toBe(true);
  expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  for (const name of ['history', 'resume', 'submit']) expect(mock[name]).not.toHaveBeenCalled();
  expect(mock.identity).toHaveBeenCalledWith(mock.owners.identity, mock.parent);
  expect(mock.destination).toHaveBeenCalledWith(
    mock.owners.coordinator,
    mock.owners.enrollment,
    mock.options.destination
  );
});
test.each(['identity', 'enrollment', 'coordinator'])(
  'copied %s refuses before invocation',
  (key) => {
    mock.options.owners = { ...mock.owners, [key]: { ...mock.owners[key] } };
    expect(() => open()).toThrow(expect.objectContaining({ code }));
    expect(mock.resume).not.toHaveBeenCalled();
  }
);
test.each([
  'destination',
  'signal',
  'archive',
  'proverArchive',
  'artifactDirectory',
  'reviewDisclosures',
  'reviewTransaction',
  'gasLimit',
  'maxGasFee',
])('invalid %s refuses without opening', (key) => {
  mock.options[key] = null;
  expect(() => open()).toThrow(expect.objectContaining({ code }));
  expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
});
test('options and owners accessors, proxies and extra keys are not evaluated', () => {
  const trap = jest.fn(() => {
    throw Error('caller code');
  });
  for (const value of [
    new Proxy({}, { getPrototypeOf: trap }),
    { ...mock.options, extra: true },
    Object.defineProperty({ ...mock.options }, 'owners', { get: trap }),
  ])
    expect(() => create(value)).toThrow(expect.objectContaining({ code }));
  mock.options.owners = Object.defineProperty({ ...mock.owners }, 'identity', { get: trap });
  expect(() => open()).toThrow(expect.objectContaining({ code }));
  expect(trap).not.toHaveBeenCalled();
});
test('exact original promises and outcomes; immediate await-history then proof then submit', async () => {
  const c = open();
  const ps = [
    Promise.resolve(Object.freeze({ records: [{ holdId }], nextAfter: null, totalSigning: 1 })),
    Promise.resolve(Object.freeze({ status: 'proof-present', holdId, submissionEnabled: false })),
    Promise.resolve(Object.freeze({ status: 'recovery-required', stage: 'prior-attempt' })),
  ];
  mock.history.mockReturnValue(ps[0]);
  mock.resume.mockReturnValue(ps[1]);
  mock.submit.mockReturnValue(ps[2]);
  const a = c.history();
  expect(a).toBe(ps[0]);
  expect(await a).toBe(await ps[0]);
  expect(mock.resume).not.toHaveBeenCalled();
  expect(mock.submit).not.toHaveBeenCalled();
  const b = c.resumeProof(holdId);
  expect(b).toBe(ps[1]);
  expect(await b).toBe(await ps[1]);
  expect(mock.submit).not.toHaveBeenCalled();
  const d = c.submitStored(holdId);
  expect(d).toBe(ps[2]);
  expect(await d).toBe(await ps[2]);
  const common = {
    identity: mock.owners.identity,
    enrollment: mock.owners.enrollment,
    coordinator: mock.owners.coordinator,
    destination: mock.options.destination,
    archive: '/archive',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    signal: c.signal,
    holdId,
  };
  expect(mock.resume).toHaveBeenCalledTimes(1);
  expect(mock.submit).toHaveBeenCalledTimes(1);
  expect(mock.history).toHaveBeenCalledTimes(1);
  expect(mock.resume).toHaveBeenCalledWith(common);
  expect(mock.submit).toHaveBeenCalledWith({
    ...common,
    reviewDisclosures: mock.options.reviewDisclosures,
    reviewTransaction: mock.options.reviewTransaction,
    gasLimit: 1500000n,
    maxGasFee: 2000000000000000n,
  });
  expect(mock.history).toHaveBeenCalledWith({
    owners: mock.owners,
    destination: mock.options.destination,
    signal: c.signal,
    after: null,
  });
});
test.each(['history', 'resumeProof', 'submitStored'])(
  '%s rejection identity and original promise survive',
  async (method) => {
    const c = open(),
      error = Object.freeze(new Error('original')),
      p = Promise.reject(error);
    mock[
      { history: 'history', resumeProof: 'resume', submitStored: 'submit' }[method]
    ].mockReturnValueOnce(p);
    const outward = c[method](method === 'history' ? null : holdId);
    expect(outward).toBe(p);
    await expect(outward).rejects.toBe(error);
    await expect(c.history()).resolves.toBeDefined();
  }
);
test.each(['history', 'resumeProof', 'submitStored'])(
  '%s remains busy across close until original settlement',
  async (method) => {
    const c = open(),
      d = deferred();
    mock[
      { history: 'history', resumeProof: 'resume', submitStored: 'submit' }[method]
    ].mockReturnValueOnce(d.promise);
    const p = c[method](method === 'history' ? null : holdId);
    expect(p).toBe(d.promise);
    await expect(c.history()).rejects.toMatchObject({ code });
    await expect(c.resumeProof(holdId)).rejects.toMatchObject({ code });
    await expect(c.submitStored(holdId)).rejects.toMatchObject({ code });
    let finished = false;
    c.closed.then(() => {
      finished = true;
    });
    c.close();
    c.close();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(c.signal.aborted).toBe(true);
    const value = Object.freeze({ status: 'original-after-abort' });
    d.resolve(value);
    expect(await p).toBe(value);
    await c.closed;
    expect(finished).toBe(true);
    await expect(c.history()).rejects.toMatchObject({ code });
    expect(mock.owners.enrollment.signal.aborted).toBe(false);
  }
);
test.each([0, 1, 2, 3])('owner/caller abort %i drains admitted work', async (index) => {
  const c = open(),
    d = deferred();
  mock.resume.mockReturnValue(d.promise);
  const p = c.resumeProof(holdId);
  let ended = false;
  c.closed.then(() => {
    ended = true;
  });
  mock.controllers[index].abort();
  await Promise.resolve();
  expect(c.signal.aborted).toBe(true);
  expect(ended).toBe(false);
  d.resolve(Object.freeze({ status: 'recovery-required', stage: 'verify' }));
  await p;
  await c.closed;
  expect(ended).toBe(true);
});
test('mutable caller options cannot retarget; explicit repeat delegates again, no cached admission', async () => {
  const c = open();
  mock.options.archive = '/different';
  mock.options.owners = {};
  await c.resumeProof(holdId);
  await c.resumeProof(holdId);
  expect(mock.resume).toHaveBeenCalledTimes(2);
  expect(mock.resume.mock.calls[1][0].archive).toBe('/archive');
  expect(mock.submit).not.toHaveBeenCalled();
});
test.each(['', 'A'.repeat(64), {}, Object.freeze({ __type: 'privateOperation' }), null])(
  'invalid selector %p invokes no controller',
  async (value) => {
    const c = open();
    await expect(c.resumeProof(value)).rejects.toMatchObject({ code });
    await expect(c.submitStored(value)).rejects.toMatchObject({ code });
    expect(mock.resume).not.toHaveBeenCalled();
    expect(mock.submit).not.toHaveBeenCalled();
  }
);
test('current owner/destination drift refuses, rather than using construction-time authorization', async () => {
  const c = open();
  mock.destination.mockImplementation(() => {
    throw Error('drift');
  });
  await expect(c.history()).rejects.toMatchObject({ code });
  expect(mock.history).not.toHaveBeenCalled();
});
test('synchronous admitted failure clears busy without replacing the original error', async () => {
  const c = open(),
    error = new Error('sync');
  mock.resume.mockImplementationOnce(() => {
    throw error;
  });
  await expect(c.resumeProof(holdId)).rejects.toBe(error);
  await expect(c.history()).resolves.toBeDefined();
});

test('caller signal proxy/accessors/substituted prototype refuse without caller code', () => {
  const hook = jest.fn(() => {
    throw Error('signal hook');
  });
  const ownAborted = new AbortController().signal;
  Object.defineProperty(ownAborted, 'aborted', { get: hook });
  const ownReason = new AbortController().signal;
  Object.defineProperty(ownReason, 'reason', { get: hook });
  const replacedPrototype = new AbortController().signal;
  Object.setPrototypeOf(replacedPrototype, Object.create(AbortSignal.prototype));
  for (const signal of [
    new Proxy(new AbortController().signal, { getPrototypeOf: hook, get: hook }),
    ownAborted,
    ownReason,
    replacedPrototype,
  ])
    expect(() => create({ ...mock.options, signal })).toThrow(expect.objectContaining({ code }));
  expect(hook).not.toHaveBeenCalled();
  expect(mock.owners.enrollment.openPrivateRecoveryStores).not.toHaveBeenCalled();
  expect(mock.history).not.toHaveBeenCalled();
});
test('foreign coordinator signal getter/proxy remains unobserved at constructor refusal', () => {
  const hook = jest.fn(() => {
    throw Error('coordinator hook');
  });
  mock.destination.mockImplementation((coordinator) => {
    if (coordinator !== mock.owners.coordinator) throw Error('foreign coordinator');
  });
  for (const coordinator of [
    Object.defineProperty({}, 'signal', { get: hook }),
    new Proxy({}, { get: hook, getPrototypeOf: hook }),
  ])
    expect(() => create({ ...mock.options, owners: { ...mock.owners, coordinator } })).toThrow(
      expect.objectContaining({ code })
    );
  expect(hook).not.toHaveBeenCalled();
  expect(mock.history).not.toHaveBeenCalled();
});
