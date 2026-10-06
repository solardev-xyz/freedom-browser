let mockEnrollment, mockFenceLive;
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment(value) {
    if (value !== mockEnrollment || !mockFenceLive) throw Error('fence unavailable');
  },
}));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (value) => value }));
const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
let mockDescriptor,
  mockRouter,
  mockOptions,
  mockTask,
  mockWorker,
  mockLoan,
  mockCredential,
  mockQuarantine,
  mockHoldExit,
  mockExit,
  mockResolveExit,
  mockRejectExit,
  mockStarts,
  mockCloseReached;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: () => mockDescriptor,
  quarantineRailgunIdentityCredentials: (identity) => mockQuarantine(identity),
  withRailgunViewingCredential: async (_identity, use) => mockCredential(use),
}));
jest.mock('./railgun-wallet-storage', () => ({ createRailgunWalletStorage: () => mockRouter }));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: (options) => {
    mockStarts++;
    mockOptions = options;
    const controller = new AbortController();
    const closed = new Promise((resolve, reject) => {
      mockResolveExit = resolve;
      mockRejectExit = reject;
    });
    closed.catch(() => {});
    const ready = Promise.resolve().then(() => mockWorker(options));
    mockTask = {
      ready,
      closed,
      signal: controller.signal,
      close: jest.fn(() => {
        controller.abort();
        mockCloseReached.resolve();
        if (!mockHoldExit) mockResolveExit(mockExit);
      }),
    };
    return mockTask;
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { runRailgunWalletSnapshot: run } = require('./railgun-wallet-run');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let scope, args, data, cancel;
async function worker(options, change = () => {}) {
  const input = JSON.parse(options.input),
    purpose = input.relayRequest
      ? 'relay-prepare'
      : input.relayDraftText
        ? 'relay-reconstruct'
        : 'wallet-viewing';
  const key = await options.broker.dispatch(JSON.stringify({ id: 1, method: 'key', purpose }));
  expect(key.byteLength).toBe(32);
  expect(key.byteOffset).toBe(0);
  expect(key.buffer.byteLength).toBe(32);
  expect([...key]).toEqual(Array(32).fill(7));
  const draft = normalizeRailgunRelayDraftCapsule(data.draft);
  const value = {
    instanceId: mockDescriptor.instanceId,
    ...(input.relayRequest
      ? { relayDraft: data.draft }
      : input.relayDraftText
        ? {
            relayReconstruction: {
              draftDigest: draft.digest,
              expectedHash: draft.data.intent.expectedHash,
              recoveredOutputs: 2,
            },
          }
        : {}),
  };
  change(value);
  await options.broker.dispatch(JSON.stringify({ id: 2, method: 'result', value }));
  return key;
}
beforeEach(() => {
  data = createRailgunRelayUnsignedData();
  cancel = new AbortController();
  scope = createPrivacyScope({ profileId: 'relay-run-unit', signal: new AbortController().signal });
  mockDescriptor = { walletId: data.context.walletId, instanceId: data.context.self.address };
  mockStarts = 0;
  mockCloseReached = deferred();
  mockHoldExit = false;
  mockOptions = mockTask = null;
  mockQuarantine = jest.fn();
  mockExit = {
    code: 'RAILGUN_PROCESS_CLOSED',
    exitCode: 15,
    escalated: false,
    peerDisconnected: false,
  };
  mockLoan = Buffer.alloc(32, 7);
  mockCredential = jest.fn(async (use) => {
    try {
      return await use({ viewingKey: mockLoan });
    } finally {
      mockLoan.fill(0);
    }
  });
  mockRouter = {
    signal: scope.signal,
    prefixes: {},
    assertIdle: jest.fn(),
    close: jest.fn(),
    dispatch: jest.fn(),
  };
  mockWorker = (options) => worker(options);
  args = {
    handle: scope.getContext({
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'engine',
    }),
    archive: '/synthetic-engine.asar',
    identity: { signal: scope.signal },
    snapshot: { checkpoint: {} },
    walletId: data.context.walletId,
    restore: true,
    walletSession: {},
    walletGrant: {},
    relayRequest: data.request,
    relaySignal: cancel.signal,
  };
});
afterEach(() => scope.close());
test.each(['construct', 'reconstruct'])(
  '%s uses only fixed viewing purpose, binary credential and 30s budgets',
  async (mode) => {
    if (mode === 'reconstruct') {
      delete args.relayRequest;
      args.relayDraftText = JSON.stringify(normalizeRailgunRelayDraftCapsule(data.draft).data);
    }
    const result = await run(args);
    expect(mockOptions.binaryKey).toBe(true);
    expect(mockOptions.startupMs).toBe(30000);
    expect(mockOptions.lifetimeMs).toBe(30000);
    expect(mockOptions.filename).toBe(require.resolve('./railgun-relay-wallet-job'));
    expect(mockCredential).toHaveBeenCalledTimes(1);
    expect([...mockLoan]).toEqual(Array(32).fill(0));
    expect(mockOptions.input).not.toContain('07'.repeat(32));
    expect(JSON.parse(mockOptions.input).privateOperation).toBeUndefined();
    expect(result.closed).toBe(mockExit);
    expect(mockTask.close).toHaveBeenCalledTimes(1);
    expect(mockRouter.close).toHaveBeenCalledTimes(1);
  }
);
test.each(['private-operate', 'wallet-viewing', 'spending-sign', 'relay-reconstruct'])(
  'construct refuses wrong key purpose %s without any loan',
  async (purpose) => {
    mockWorker = (options) =>
      options.broker.dispatch(JSON.stringify({ id: 1, method: 'key', purpose }));
    await expect(run(args)).rejects.toMatchObject({ code: 'RAILGUN_WALLET_BROKER_REFUSED' });
    expect(mockCredential).not.toHaveBeenCalled();
    expect(mockTask.close).toHaveBeenCalledTimes(1);
  }
);
test.each([
  'private-intent',
  'wrong-kind',
  'wrong-context',
  'private-result',
  'dual-result',
  'reconstruction-extra',
])('refuses %s and drains original child', async (mode) => {
  if (mode === 'reconstruction-extra') {
    delete args.relayRequest;
    args.relayDraftText = JSON.stringify(normalizeRailgunRelayDraftCapsule(data.draft).data);
  }
  if (mode === 'private-intent')
    mockWorker = async (options) => {
      await options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'relay-prepare' })
      );
      return options.broker.dispatch(
        JSON.stringify({ id: 2, method: 'private-intent', value: {} })
      );
    };
  else
    mockWorker = (options) =>
      worker(options, (value) => {
        if (mode === 'wrong-kind')
          value.relayDraft.intent.expected.kind = 'railgun-private-transfer';
        if (mode === 'wrong-context') value.relayDraft.intent.context.self.masterPublicKey = '9';
        if (mode === 'private-result') value.privatePreparation = {};
        if (mode === 'dual-result') value.relayReconstruction = {};
        if (mode === 'reconstruction-extra') value.relayReconstruction.authority = true;
      });
  await expect(run(args)).rejects.toMatchObject({
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
    closed: mockExit,
  });
  expect(mockTask.close).toHaveBeenCalledTimes(1);
  expect(mockRouter.close).toHaveBeenCalledTimes(1);
});
test.each(['privateIntent', 'privateOperation', 'privateRecovery', 'relayDraftText'])(
  'dual %s fails before child/storage work',
  async (field) => {
    args[field] = {};
    await expect(run(args)).rejects.toThrow();
    expect(mockStarts).toBe(0);
    expect(mockCredential).not.toHaveBeenCalled();
  }
);
test('ordinary route refuses injected relay output', async () => {
  delete args.relayRequest;
  delete args.relaySignal;
  mockWorker = (options) =>
    worker(options, (value) => {
      value.relayDraft = data.draft;
    });
  await expect(run(args)).rejects.toMatchObject({ code: 'RAILGUN_WALLET_BROKER_REFUSED' });
});
test('serializes a detached request before first credential await', async () => {
  const entered = deferred(),
    release = deferred();
  mockCredential = jest.fn(async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: mockLoan });
  });
  const work = run(args);
  await entered.promise;
  args.relayRequest.context.self.masterPublicKey = '99';
  expect(args.relayRequest.context.self.masterPublicKey).toBe('99');
  expect(JSON.parse(mockOptions.input).relayRequest.context.self.masterPublicKey).toBe('7');
  release.resolve();
  await work;
});
test('close is not exit: held original child must settle before successful return', async () => {
  mockHoldExit = true;
  const emitted = deferred();
  mockWorker = async (options) => {
    await worker(options);
    emitted.resolve();
  };
  let settled = false;
  const work = run(args).then((v) => {
    settled = true;
    return v;
  });
  await emitted.promise;
  await mockCloseReached.promise;
  expect(mockTask.close).toHaveBeenCalled();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  mockResolveExit(mockExit);
  await work;
  expect(settled).toBe(true);
});
test('abort retains an outstanding original credential callback and child exit', async () => {
  const entered = deferred(),
    release = deferred();
  mockHoldExit = true;
  mockCredential = jest.fn(async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: mockLoan });
  });
  let settled = false;
  const work = run(args).then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      return error;
    }
  );
  await entered.promise;
  cancel.abort();
  await Promise.resolve();
  expect(mockTask.close).toHaveBeenCalled();
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  mockResolveExit(mockExit);
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  release.resolve();
  const error = await work;
  expect(error.code).toBe('RAILGUN_WALLET_BROKER_REFUSED');
  expect(mockRouter.close).toHaveBeenCalled();
});
test('unknown original exit quarantines and refuses identity reuse', async () => {
  mockHoldExit = true;
  const emitted = deferred();
  mockWorker = async (options) => {
    await worker(options);
    emitted.resolve();
  };
  const work = run(args);
  await emitted.promise;
  mockRejectExit(Error('unknown original exit'));
  await expect(work).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
  expect(mockRouter.close).toHaveBeenCalled();
  const starts = mockStarts;
  await expect(run(args)).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(mockStarts).toBe(starts);
});
test.each(['exitCode', 'escalated', 'peerDisconnected'])(
  'refuses unexpected %s after observed child close',
  async (field) => {
    mockExit = { ...mockExit, [field]: field === 'exitCode' ? 0 : true };
    await expect(run(args)).rejects.toThrow();
    expect(mockRouter.close).toHaveBeenCalled();
  }
);
test('pre-aborted signal fails before child; proxy and own getter never execute', async () => {
  cancel.abort();
  await expect(run(args)).rejects.toThrow();
  expect(mockStarts).toBe(0);
  let calls = 0;
  args.relaySignal = new Proxy(new AbortController().signal, {
    getPrototypeOf() {
      calls++;
      return AbortSignal.prototype;
    },
  });
  await expect(run(args)).rejects.toThrow();
  expect(calls).toBe(0);
  for (const property of ['aborted', 'reason']) {
    const genuine = new AbortController();
    Object.defineProperty(genuine.signal, property, {
      get() {
        calls++;
        return true;
      },
    });
    args.relaySignal = genuine.signal;
    await expect(run(args)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(mockStarts).toBe(0);
  }
  const derived = new AbortController().signal;
  Object.setPrototypeOf(derived, Object.create(AbortSignal.prototype));
  args.relaySignal = derived;
  await expect(run(args)).rejects.toThrow();
  expect(mockStarts).toBe(0);
});

function proofSetup() {
  const f = createRailgunRelayMainProofData();
  mockEnrollment = { binding: f.record.binding, getContext: () => args.handle };
  mockFenceLive = true;
  delete args.relayRequest;
  args.relayProof = f.proofInput;
  args.relayEnrollment = mockEnrollment;
  mockWorker = async (options) => {
    const input = JSON.parse(options.input);
    const key = await options.broker.dispatch(
      JSON.stringify({ id: 1, method: 'key', purpose: 'relay-prove-local' })
    );
    await options.broker.dispatch(
      JSON.stringify({ id: 2, channel: 'public', wire: JSON.stringify({ id: 1, method: 'get' }) })
    );
    const chunks = [];
    for (let index = 0; index < input.recordStream.chunks; index++) {
      const reply = JSON.parse(
        await options.broker.dispatch(
          JSON.stringify({ id: 3 + index, method: 'relay-proof-record', index })
        )
      );
      chunks.push(Buffer.from(reply.value.data, 'hex'));
    }
    expect(Buffer.concat(chunks).toString()).toBe(f.recordText);
    await options.broker.dispatch(
      JSON.stringify({
        id: 3 + chunks.length,
        method: 'result',
        value: { instanceId: mockDescriptor.instanceId, relayProof: f.proof },
      })
    );
    return key;
  };
  mockRouter.dispatch.mockImplementation(async (wire) =>
    JSON.stringify({ id: JSON.parse(wire).id, value: null })
  );
  return f;
}
test('fixed producer shares key/storage/chunk sequence with exact 110s cap and observed close', async () => {
  const f = proofSetup(),
    result = await run(args);
  expect(mockOptions.filename).toBe(require.resolve('./railgun-relay-prove-job'));
  expect(mockOptions.binaryKey).toBe(true);
  expect(mockOptions.startupMs).toBe(110000);
  expect(mockOptions.lifetimeMs).toBe(110000);
  expect(JSON.parse(mockOptions.input).recordText).toBeUndefined();
  expect(result.relayProof).toEqual(f.proof);
  expect(mockRouter.dispatch).toHaveBeenCalledTimes(1);
  expect(mockTask.close).toHaveBeenCalledTimes(1);
});
test.each(['fence', 'binding', 'dual', 'cap', 'unsigned', 'record-accessor'])(
  'producer rejects %s before key or launch',
  async (mode) => {
    const f = proofSetup();
    if (mode === 'fence') mockFenceLive = false;
    if (mode === 'binding') mockEnrollment.binding = '00'.repeat(32);
    if (mode === 'dual') args.relayDraftText = JSON.stringify(f.record.draft);
    if (mode === 'cap') args.relayProof.timeoutMs = 110001;
    if (mode === 'unsigned')
      args.relayProof.recordText = JSON.stringify({ ...f.record, state: 'held', signature: null });
    let reads = 0;
    if (mode === 'record-accessor')
      Object.defineProperty(args.relayProof, 'recordText', {
        get() {
          reads++;
          return f.recordText;
        },
      });
    await expect(run(args)).rejects.toThrow();
    expect(mockStarts).toBe(0);
    expect(mockCredential).not.toHaveBeenCalled();
    expect(reads).toBe(0);
  }
);
test.each(['before-chunks', 'repeat', 'skip', 'wrong-method', 'wrong-result', 'fence-after-key'])(
  'producer refuses %s and drains original exit',
  async (mode) => {
    const f = proofSetup();
    mockWorker = async (options) => {
      await options.broker.dispatch(
        JSON.stringify({ id: 1, method: 'key', purpose: 'relay-prove-local' })
      );
      if (mode === 'fence-after-key') mockFenceLive = false;
      if (mode === 'before-chunks')
        return options.broker.dispatch(
          JSON.stringify({
            id: 2,
            method: 'result',
            value: { instanceId: mockDescriptor.instanceId, relayProof: f.proof },
          })
        );
      const message = {
        id: 2,
        method: mode === 'wrong-method' ? 'relay-verify-record' : 'relay-proof-record',
        index: mode === 'skip' ? 1 : 0,
      };
      await options.broker.dispatch(JSON.stringify(message));
      if (mode === 'repeat') return options.broker.dispatch(JSON.stringify({ ...message, id: 3 }));
      if (mode === 'wrong-result')
        return options.broker.dispatch(
          JSON.stringify({
            id: 3,
            method: 'result',
            value: { relayProof: { ...f.proof, payloadDigest: '0'.repeat(64) } },
          })
        );
    };
    await expect(run(args)).rejects.toThrow();
    expect(mockTask.close).toHaveBeenCalledTimes(1);
  }
);
test('producer holds original exit despite successful result, and preserves unknown barrier', async () => {
  proofSetup();
  mockHoldExit = true;
  const work = run(args);
  await mockCloseReached.promise;
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
  mockRejectExit(Error('unknown'));
  await expect(work).rejects.toMatchObject({ code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
  expect(mockQuarantine).toHaveBeenCalledWith(args.identity);
});
test('ordinary route rejects producer result', async () => {
  const f = createRailgunRelayMainProofData();
  delete args.relayRequest;
  delete args.relaySignal;
  mockWorker = (options) =>
    worker(options, (value) => {
      value.relayProof = f.proof;
    });
  await expect(run(args)).rejects.toThrow();
});

test('producer drains held original storage even when a concurrent chunk causes immediate refusal', async () => {
  proofSetup();
  const entered = deferred(),
    release = deferred();
  mockRouter.dispatch.mockImplementation(() => {
    entered.resolve();
    return release.promise;
  });
  mockWorker = async (options) => {
    await options.broker.dispatch(
      JSON.stringify({ id: 1, method: 'key', purpose: 'relay-prove-local' })
    );
    const storage = options.broker.dispatch(
      JSON.stringify({ id: 2, channel: 'public', wire: JSON.stringify({ id: 1, method: 'get' }) })
    );
    storage.catch(() => {});
    return options.broker.dispatch(
      JSON.stringify({ id: 3, method: 'relay-proof-record', index: 0 })
    );
  };
  let settled = false;
  const work = run(args);
  work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await entered.promise;
  await mockCloseReached.promise;
  await new Promise(setImmediate);
  expect(settled).toBe(false);
  release.resolve(JSON.stringify({ id: 1, value: null }));
  await expect(work).rejects.toThrow();
});
