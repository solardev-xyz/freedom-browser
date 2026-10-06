let mockVerification;
jest.mock('./railgun-relay-proof-verifier', () => ({
  verifyRailgunRelayProofs: jest.fn(async () => JSON.parse(JSON.stringify(mockVerification))),
}));
const { EXPECTED_GUARDS } = require('./railgun-relay-quote-data');
let mockEnrollment,
  mockIdentity,
  mockFenceLive,
  mockIdentityLive,
  mockDescriptor,
  mockOptions,
  mockTask,
  mockWorker,
  mockExit,
  mockHoldExit,
  mockThrowClose,
  mockStarts,
  mockClosedReached,
  mockResolveExit,
  mockRejectExit;
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment(value) {
    if (value !== mockEnrollment || !mockFenceLive) throw Error('fence unavailable');
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity(value) {
    if (value !== mockIdentity || !mockIdentityLive) throw Error('identity unavailable');
    return mockDescriptor;
  },
}));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (v) => v }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess(options) {
    mockOptions = options;
    mockStarts++;
    const closed = new Promise((resolve, reject) => {
      mockResolveExit = resolve;
      mockRejectExit = reject;
    });
    closed.catch(() => {});
    mockTask = {
      closed,
      ready: Promise.resolve().then(() => mockWorker(options)),
      close: jest.fn(() => {
        mockClosedReached.resolve();
        if (!mockHoldExit) mockResolveExit(mockExit);
        if (mockThrowClose) throw Error('close failed');
      }),
    };
    return mockTask;
  },
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  verifyRailgunRelayProof: verify,
  assertRailgunRelayProof: assertProof,
} = require('./railgun-relay-proof');
const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let scope, args, f, cancel, receiptOwners;
async function worker(options, change = () => {}) {
  const input = JSON.parse(options.input),
    chunks = [];
  for (let index = 0; index < input.recordStream.chunks; index++) {
    const reply = JSON.parse(
      await options.broker.dispatch(
        JSON.stringify({ id: index + 1, method: 'relay-verify-record', index })
      )
    );
    chunks.push(Buffer.from(reply.value.data, 'hex'));
  }
  const candidate = JSON.parse(Buffer.concat(chunks).toString());
  expect(candidate.state).toBe('ready-local');
  expect(candidate.signature).toEqual(f.record.signature);
  const value = JSON.parse(JSON.stringify({ ...f.verification, guards: EXPECTED_GUARDS }));
  change(value);
  await options.broker.dispatch(JSON.stringify({ id: chunks.length + 1, method: 'result', value }));
}
beforeEach(() => {
  f = createRailgunRelayMainProofData();
  mockVerification = f.verification;
  cancel = new AbortController();
  scope = createPrivacyScope({
    profileId: 'relay-proof-unit',
    signal: new AbortController().signal,
  });
  mockEnrollment = {
    binding: f.record.binding,
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
  };
  mockIdentity = { signal: scope.signal };
  mockFenceLive = mockIdentityLive = true;
  mockDescriptor = {
    walletId: f.record.walletId,
    spendingPublicKey: ['04'.repeat(32), '05'.repeat(32)],
  };
  mockHoldExit = mockThrowClose = false;
  mockStarts = 0;
  mockClosedReached = deferred();
  mockOptions = mockTask = null;
  receiptOwners = [];
  mockExit = {
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  };
  mockWorker = (options) => worker(options);
  args = {
    enrollment: mockEnrollment,
    identity: mockIdentity,
    archive: '/synthetic-engine.asar',
    proverArchive: '/synthetic-prover.asar',
    artifactDirectory: '/synthetic-artifacts',
    signedRecordText: f.recordText,
    proof: f.proof,
    signal: cancel.signal,
    timeoutMs: 60000,
  };
});
afterEach(() => {
  for (const value of receiptOwners) value.close();
  scope.close();
});
test('fixed keyless C issues only exact bound static evidence after observed original exit', async () => {
  const result = await verify(args);
  receiptOwners.push(result);
  expect(mockOptions.filename).toBe(require.resolve('./railgun-relay-verify-job'));
  expect(mockOptions.binaryKey).toBe(false);
  expect(mockOptions.startupMs).toBe(60000);
  expect(mockOptions.lifetimeMs).toBe(60000);
  expect(getPrivacyContext(mockOptions.handle).subject.operation).toBe('relay-verify');
  expect(Object.keys(JSON.parse(mockOptions.input)).sort()).toEqual([
    'archive',
    'artifactDirectory',
    'identityText',
    'proverArchive',
    'recordStream',
  ]);
  expect(result.process).toBe(mockExit);
  expect(assertProof(result.receipt, mockEnrollment, mockIdentity, f.recordText, f.proof)).toEqual({
    ...f.verification,
    utilityExitObserved: true,
  });
  expect(() => assertProof({}, mockEnrollment, mockIdentity, f.recordText, f.proof)).toThrow();
  expect(() => assertProof(result.receipt, {}, mockIdentity, f.recordText, f.proof)).toThrow();
  expect(() => assertProof(result.receipt, mockEnrollment, {}, f.recordText, f.proof)).toThrow();
  const changed = JSON.parse(f.recordText);
  changed.signature.S = '0x' + '0'.repeat(63) + '4';
  expect(
    require('./railgun-private-signature').normalizeRailgunSignature(changed.signature)
  ).toEqual(changed.signature);
  expect(() =>
    assertProof(result.receipt, mockEnrollment, mockIdentity, JSON.stringify(changed), f.proof)
  ).toThrow();
  result.close();
  expect(() =>
    assertProof(result.receipt, mockEnrollment, mockIdentity, f.recordText, f.proof)
  ).toThrow();
});
test.each(['fence', 'binding', 'identity', 'cap', 'signal', 'getter'])(
  'C rejects %s before any process start',
  async (mode) => {
    let reads = 0;
    if (mode === 'fence') mockFenceLive = false;
    if (mode === 'binding') mockEnrollment.binding = '00'.repeat(32);
    if (mode === 'identity') mockIdentityLive = false;
    if (mode === 'cap') args.timeoutMs = 60001;
    if (mode === 'signal') cancel.abort();
    if (mode === 'getter')
      Object.defineProperty(args, 'proof', {
        get() {
          reads++;
          return f.proof;
        },
      });
    await expect(verify(args)).rejects.toMatchObject({ code: 'RAILGUN_RELAY_PROOF_REFUSED' });
    expect(mockStarts).toBe(0);
    expect(reads).toBe(0);
  }
);
test.each([
  'key',
  'early-result',
  'skip',
  'repeated',
  'wrong-method',
  'extra',
  'swallowed-refusal',
])('C refuses %s and cannot recover by swallowing broker refusal', async (mode) => {
  mockWorker = async (options) => {
    if (mode === 'key')
      return options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'relay-sign' })
      );
    if (mode === 'early-result')
      return options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'result', value: f.verification })
      );
    if (mode === 'swallowed-refusal') {
      await options.broker.dispatch('{}').catch(() => {});
      await worker(options);
      return;
    }
    const message = {
      id: 1,
      method: mode === 'wrong-method' ? 'relay-proof-record' : 'relay-verify-record',
      index: mode === 'skip' ? 1 : 0,
    };
    if (mode === 'extra') message.extra = true;
    await options.broker.dispatch(JSON.stringify(message));
    await options.broker.dispatch(JSON.stringify({ ...message, id: 2 }));
  };
  await expect(verify(args)).rejects.toThrow();
  expect(mockTask.close).toHaveBeenCalledTimes(1);
});
test.each(['authorityGranted', 'payloadDigest', 'artifactVkeys'])(
  'C refuses altered %s even after normal streamed record',
  async (field) => {
    mockWorker = (options) =>
      worker(options, (value) => {
        value[field] = field === 'authorityGranted' ? true : {};
      });
    await expect(verify(args)).rejects.toThrow();
    expect(mockTask.close).toHaveBeenCalledTimes(1);
  }
);
test('close request does not settle held original child, and concurrent C cannot enter', async () => {
  mockHoldExit = true;
  const work = verify(args);
  await mockClosedReached.promise;
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  await expect(verify(args)).rejects.toThrow();
  expect(mockStarts).toBe(1);
  mockResolveExit(mockExit);
  const result = await work;
  receiptOwners.push(result);
});
test('throwing close still awaits original closed and refuses after actual exit', async () => {
  mockHoldExit = mockThrowClose = true;
  const work = verify(args);
  await mockClosedReached.promise;
  let settled = false;
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  mockResolveExit(mockExit);
  await expect(work).rejects.toThrow();
});
test('unknown original exit retains enrollment busy and preserves account sentinel', async () => {
  mockHoldExit = true;
  const work = verify(args);
  await mockClosedReached.promise;
  mockRejectExit(Error('unknown child'));
  await expect(work).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  mockHoldExit = false;
  await expect(verify(args)).rejects.toThrow();
  expect(mockStarts).toBe(1);
});
test.each(['exitCode', 'escalated', 'peerDisconnected', 'code'])(
  'observed invalid %s cannot issue evidence',
  async (field) => {
    mockExit[field] = field === 'exitCode' ? 0 : field === 'code' ? 'FAILED' : true;
    await expect(verify(args)).rejects.toThrow();
  }
);
test('original ready stays awaited after abort until it and original child both settle', async () => {
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockWorker = async () => {
    entered.resolve();
    await release.promise;
  };
  let settled = false;
  const work = verify(args);
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  cancel.abort();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  mockResolveExit(mockExit);
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  release.resolve();
  await expect(work).rejects.toThrow();
});
test('C captures original record/proof before held job and reattests owners at exit', async () => {
  const entered = deferred(),
    release = deferred();
  mockWorker = async (options) => {
    entered.resolve();
    await release.promise;
    await worker(options);
  };
  const work = verify(args);
  await entered.promise;
  args.signedRecordText = '{}';
  args.proof = {};
  release.resolve();
  const result = await work;
  receiptOwners.push(result);
  expect(
    assertProof(result.receipt, mockEnrollment, mockIdentity, f.recordText, f.proof)
      .authorityGranted
  ).toBe(false);
  mockFenceLive = false;
  expect(() =>
    assertProof(result.receipt, mockEnrollment, mockIdentity, f.recordText, f.proof)
  ).toThrow();
});
test.each(['identity', 'fence', 'signal'])(
  'C reattests %s after original held exit',
  async (mode) => {
    mockHoldExit = true;
    const work = verify(args);
    await mockClosedReached.promise;
    if (mode === 'identity') mockIdentityLive = false;
    if (mode === 'fence') mockFenceLive = false;
    if (mode === 'signal') cancel.abort();
    mockResolveExit(mockExit);
    await expect(work).rejects.toThrow();
  }
);

test('concurrent C dispatch refuses sticky without abandoning the original request', async () => {
  mockWorker = async (options) => {
    const first = options.broker.dispatch(
      JSON.stringify({ id: 1, method: 'relay-verify-record', index: 0 })
    );
    const second = options.broker.dispatch(
      JSON.stringify({ id: 2, method: 'relay-verify-record', index: 1 })
    );
    await Promise.allSettled([first, second]);
    await options.broker.dispatch(
      JSON.stringify({ id: 3, method: 'result', value: f.verification })
    );
  };
  await expect(verify(args)).rejects.toThrow();
  expect(mockTask.close).toHaveBeenCalledTimes(1);
});

test('actual fixed keyless job envelope and real chunk reader compose with main owner', async () => {
  mockWorker = (options) =>
    require('./railgun-relay-verify-job').run(options.input, {
      request: (wire) => options.broker.dispatch(wire),
      signal: args.signal,
      guardReport: () => structuredClone(EXPECTED_GUARDS),
    });
  const result = await verify(args);
  receiptOwners.push(result);
  expect(result.observation).toEqual({ ...f.verification, utilityExitObserved: true });
  expect(result.observation).not.toHaveProperty('guards');
  const helper = require('./railgun-relay-proof-verifier').verifyRailgunRelayProofs;
  const last = helper.mock.calls.at(-1)[0];
  expect(JSON.parse(last.recordText).state).toBe('ready-local');
  expect(JSON.parse(last.recordText).signature).toEqual(f.record.signature);
  expect(JSON.parse(last.identityText).spendingPublicKey).toEqual(mockDescriptor.spendingPublicKey);
});
test.each([
  'missing',
  'null',
  'extra',
  'nonzero',
  'negative',
  'empty',
  'many',
  'duplicate',
  'canaries',
  'malformed-hook',
  'unknown-field',
])('C host refuses %s guards/wire before issuing receipt', async (mode) => {
  mockWorker = (options) =>
    worker(options, (value) => {
      if (mode === 'missing') delete value.guards;
      if (mode === 'null') value.guards = null;
      if (mode === 'extra') value.guards.extra = true;
      if (mode === 'nonzero') value.guards.attempts = 1;
      if (mode === 'negative') value.guards.attempts = -1;
      if (mode === 'empty') value.guards.hooks = [];
      if (mode === 'many') value.guards.hooks = Array.from({ length: 257 }, (_, i) => 'hook' + i);
      if (mode === 'duplicate') value.guards.hooks[1] = value.guards.hooks[0];
      if (mode === 'canaries') value.guards.canaries++;
      if (mode === 'malformed-hook') value.guards.hooks[0] = { name: 'hook' };
      if (mode === 'unknown-field') value.authorized = true;
    });
  await expect(verify(args)).rejects.toMatchObject({ code: 'RAILGUN_RELAY_PROOF_REFUSED' });
  expect(mockTask.close).toHaveBeenCalledTimes(1);
});
