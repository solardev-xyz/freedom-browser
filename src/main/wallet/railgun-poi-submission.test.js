// Genuine plans, prepared receipt readers, normalizers, comparisons and account
// phases are real. Cryptographic validation, storage authority and network I/O
// are mocked; these tests qualify sender composition, not proof or service truth.
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => mock.enrollments.has(value),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: jest.fn((identity, handle) => {
    const context = require('../networks/privacy-context').getPrivacyContext(handle);
    if (
      identity !== mock.identity ||
      identity.signal.aborted ||
      !mock.identityCurrent ||
      context.subject.kind !== 'private-account' ||
      context.subject.role !== 'engine' ||
      context.subject.protocol !== 'railgun' ||
      context.subject.chainId !== 11155111 ||
      context.subject.principal !== 'railgun:0' ||
      context.subject.deployment !== 'sepolia'
    )
      throw Error('PRIVATE identity diagnostic');
    return identity.descriptor;
  }),
  withRailgunViewingCredential: jest.fn(() => {
    throw Error('unexpected key');
  }),
}));
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublic: jest.fn((coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      !mock.enrollments.has(enrollment) ||
      coordinator.signal.aborted ||
      !mock.publicCurrent ||
      (policy !== undefined && policy !== mock.policy)
    )
      throw Error('PRIVATE registered policy');
    return mock.policy;
  }),
  getRailgunAccountPublicDestination: jest.fn(() => mock.sourceDestination),
  assertRailgunAccountPublicDestination: jest.fn((coordinator, enrollment, destination) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      destination !== mock.sourceDestination ||
      !mock.publicCurrent
    )
      throw Error('source destination');
  }),
  getRailgunAccountPublicIdentity: jest.fn((coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      !mock.enrollments.has(enrollment) ||
      coordinator.signal.aborted ||
      !mock.publicCurrent ||
      policy !== mock.policy
    )
      throw Error('PRIVATE public identity');
    return mock.publicIdentity;
  }),
}));
jest.mock('./railgun-public-policy', () => ({
  getRailgunPublicPolicy: jest.fn(() => mock.policy),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((value) => {
    if (value !== mock.archive) throw Error('archive');
    return value;
  }),
}));
jest.mock('./railgun-prover-runtime', () => ({
  verifyRailgunProverRuntime: jest.fn((value) => {
    if (value !== mock.proverArchive) throw Error('prover archive');
    return value;
  }),
}));
jest.mock('./railgun-poi-root', () => ({
  createRailgunPoiRootSource: jest.fn((options) => mock.makeRoot('list', options)),
  createRailgunPoiTxidRootSource: jest.fn((options) => mock.makeRoot('txid', options)),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn(() => {
    throw Error('unexpected utility');
  }),
}));
jest.mock('./railgun-own-poi-proof', () => ({
  proveRailgunOwnPoi: jest.fn(() => {
    throw Error('unexpected proof');
  }),
}));
jest.mock('./railgun-own-witness', () => ({
  preflightRailgunRetainedPoiCompleted: jest.fn(() => {
    throw Error('unexpected retained preflight');
  }),
  preflightRailgunRetainedPoiForSubmission: jest.fn(() => {
    throw Error('unexpected retained submission preflight');
  }),
  preflightRailgunOwnPoi: jest.fn(() => {
    throw Error('unexpected preflight');
  }),
}));
jest.mock('../networks/private-rpc', () => ({
  getPrivateRpcDestinationDetails: jest.fn((destination) => {
    if (![mock.sourceDestination, mock.receiptDestination].includes(destination))
      throw Error('unknown destination');
    return {
      version: 1,
      url:
        destination === mock.sourceDestination
          ? 'https://source.example/private/path'
          : 'https://receipt.example/another/private/path',
      chainId: 11155111,
      role: destination === mock.sourceDestination ? 'protocol-rpc' : 'transaction-rpc',
      transport: 'tor-experimental',
    };
  }),
  createPrivateRpc: jest.fn(() => {
    throw Error('unexpected transport');
  }),
}));
jest.mock('./railgun-own-operation', () => ({
  captureRailgunOwnOperationSelector: jest.fn((options) => mock.selector(options)),
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    const { claimRailgunAccountPhase } = jest.requireActual('./railgun-account-phase');
    let phase;
    let live = true;
    const deadline = performance.now() + options.timeoutMs;
    const current = (margin = 0) => {
      if (!live || options.signal.aborted || performance.now() + margin >= deadline)
        throw Error('PRIVATE recovery lifetime');
      phase.assertCurrent();
    };
    try {
      phase = claimRailgunAccountPhase(options.enrollment, 'recovery');
      mock.events.push('recovery-open');
      await mock.recoveryStart(options);
      current();
      mock.window = {
        capture: JSON.parse(JSON.stringify(mock.capture)),
        signal: options.signal,
        assertCurrent: jest.fn(current),
        reattest: jest.fn(async () => {
          current();
          const capture = await mock.reattest();
          current();
          return capture;
        }),
      };
      let value;
      try {
        value = await use(mock.window);
      } catch {
        return { status: 'refused', stage: 'callback' };
      }
      current();
      live = false;
      await mock.recoveryPost();
      if (options.signal.aborted || performance.now() >= deadline) throw Error('post-recovery');
      return { status: 'used', value };
    } catch {
      return { status: 'refused', stage: 'reattest' };
    } finally {
      live = false;
      phase?.release();
      mock.events.push('recovery-close');
    }
  }),
}));

jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: jest.fn((handle) => {
    mock.receiptHandles.add(handle);
    return mock.network;
  }),
  getPrivateTransactionNetworkDestination: jest.fn(() => mock.receiptDestination),
  assertPrivateTransactionNetworkDestination: jest.fn((network, handle, destination) => {
    if (
      network !== mock.network ||
      !mock.receiptHandles.has(handle) ||
      destination !== mock.receiptDestination ||
      !mock.receiptCurrent
    )
      throw Error('receipt destination');
  }),
}));
jest.mock('./railgun-poi-cold-validation', () => ({
  validateRailgunRetainedPoiForSubmission: jest.fn((...args) => mock.validate(...args)),
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: jest.fn(() => mock.makeTransport()),
}));
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const { prepareRailgunPoiSubmission } = require('./railgun-poi-submit-data');
const {
  assertPreparedRailgunOwnReceipt,
  observePreparedRailgunOwnReceipt,
} = require('./railgun-own-receipt');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  prepareRailgunPoiDisclosurePlan: prepare,
  revalidateRailgunPoiDisclosurePlan: revalidate,
  submitRailgunRetainedPoi: submit,
} = require('./railgun-poi-disclosure-plan');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const prefixed = (n) => '0x' + hex(n);
const copy = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
let options, gates, operations, plans;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
};
const until = async (check) => {
  for (let n = 0; n < 300 && !check(); n++) await Promise.resolve();
  expect(check()).toBe(true);
};
const run = (input = options) => {
  const work = prepare(input).then((value) => {
    if (value.status === 'prepared') plans.push(value);
    return value;
  });
  operations.push(work);
  return work;
};
const recheck = (result, overrides = {}) => {
  const work = revalidate({
    plan: result.plan,
    identity: options.identity,
    enrollment: options.enrollment,
    coordinator: options.coordinator,
    signal: new AbortController().signal,
    ...overrides,
  });
  operations.push(work);
  return work;
};
const idle = () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
};
function configure(unshield = false) {
  const evidence = sample(unshield),
    capsule = evidence.capsule;
  const descriptor = {
    walletId: capsule.walletId,
    instanceId: unshield ? sample().capsule.selection.recipient : capsule.selection.recipient,
    masterPublicKey: hex(3),
    spendingPublicKey: [hex(4), hex(5)],
    viewingPublicKey: hex(6),
    accountIndex: 0,
  };
  mock.evidence = evidence;
  mock.evidence.receipt.gasUsed = '0x10000';
  mock.identity.descriptor = copy(descriptor);
  mock.enrollment.descriptor = copy(descriptor);
  mock.capture = {
    capsuleDigest: digestRailgunPrivateCapsule(capsule),
    bindingDigest: hex(100),
    selector: {
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      noteHash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
    },
    capsule: copy(capsule),
    facts: { kind: capsule.selection.kind },
    submitter: evidence.transaction.from,
    provedTransaction: {
      chainId: 11155111,
      to: evidence.transaction.to,
      value: '0',
      data: evidence.transaction.input,
    },
    intent: copy(evidence.record.intent),
    projection: projectRailgunOwnRecord(evidence.record),
    record: copy(evidence.record),
  };
  const payload = normalizeRailgunPoiPayload({
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(20)],
    txidMerkleroot: hex(21),
    txidMerklerootIndex: 3,
    blindedCommitmentsOut: unshield ? [] : [prefixed(22)],
    railgunTxidIfHasUnshield: unshield ? prefixed(9) : '0x00',
  });
  mock.entry = {
    capsuleDigest: mock.capture.capsuleDigest,
    bindingDigest: mock.capture.bindingDigest,
    selector: copy(mock.capture.selector),
    payload,
    payloadSha256: sha(payload),
    inputSha256: hex(23),
    revision: 1,
    state: 'prepared',
  };
  options.capsuleDigest = mock.entry.capsuleDigest;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  gates = [];
  operations = [];
  plans = [];
  mock = {
    caller: new AbortController(),
    identityAbort: new AbortController(),
    enrollmentAbort: new AbortController(),
    coordinatorAbort: new AbortController(),
    storeAbort: new AbortController(),
    enrollments: new Set(),
    events: [],
    identityCurrent: true,
    publicCurrent: true,
    policy: { version: 1, fingerprint: 'PRIVATE_POLICY' },
    publicIdentity: { generationId: hex(1), sourceId: hex(2), publicId: hex(3) },
  };
  mock.scope = createPrivacyScope({
    profileId: 'poi-disclosure-plan-unit',
    signal: mock.enrollmentAbort.signal,
  });
  mock.identity = { signal: mock.identityAbort.signal };
  mock.coordinator = { signal: mock.coordinatorAbort.signal };
  mock.read = jest.fn(async () => freeze(copy(mock.entry)));
  mock.store = {
    signal: mock.storeAbort.signal,
    get: jest.fn(async (digest) => {
      expect(digest).toBe(options.capsuleDigest);
      mock.events.push('read');
      return mock.read(mock.store.get.mock.calls.length);
    }),
    prepare: jest.fn(() => {
      throw Error('unexpected writer');
    }),
    beginAttempt: jest.fn((value) => mock.begin(value)),
    close: jest.fn(() => {
      throw Error('unexpected shared close');
    }),
  };
  mock.enrollment = {
    directory: '/synthetic-disclosure-plan-account',
    signal: mock.enrollmentAbort.signal,
    getContext: jest.fn((role, operation) =>
      mock.scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      })
    ),
    openPoiIntents: jest.fn(async () => mock.store),
  };
  mock.enrollments.add(mock.enrollment);
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    capsuleDigest: hex(1),
    signal: mock.caller.signal,
  };
  configure();
  setupSender();
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.recoveryStart = jest.fn(async () => {});
  mock.recoveryPost = jest.fn(async () => {});
});
afterEach(async () => {
  mock.caller.abort();
  mock.enrollmentAbort.abort();
  for (const plan of plans) plan.close();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(operations);
  await Promise.all(plans.map((plan) => plan.closed));
  expect(mock.store.prepare).not.toHaveBeenCalled();
  expect(mock.store.close).not.toHaveBeenCalled();
  for (const [file, name] of [
    ['./railgun-identity', 'withRailgunViewingCredential'],
    ['./railgun-own-operation', 'captureRailgunOwnOperationSelector'],
    ['./railgun-process', 'startRailgunProcess'],
    ['./railgun-own-poi-proof', 'proveRailgunOwnPoi'],
    ['./railgun-own-witness', 'preflightRailgunOwnPoi'],
    ['./railgun-own-witness', 'preflightRailgunRetainedPoiCompleted'],
    ['./railgun-own-witness', 'preflightRailgunRetainedPoiForSubmission'],
    ['../networks/private-rpc', 'createPrivateRpc'],
  ])
    expect(require(file)[name]).not.toHaveBeenCalled();
  mock.scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function setupSender() {
  mock.archive = Object.freeze({ archive: 'engine' });
  mock.proverArchive = Object.freeze({ archive: 'prover' });
  mock.sourceDestination = Object.freeze({});
  mock.receiptDestination = Object.freeze({});
  mock.receiptCurrent = true;
  mock.receiptHandles = new WeakSet();
  mock.network = {
    signal: mock.coordinatorAbort.signal,
    request: jest.fn(async (_chain, method, params) => {
      mock.events.push('rpc:' + method);
      const evidence = mock.evidence;
      if (method === 'eth_getTransactionByHash') return { result: copy(evidence.transaction) };
      if (method === 'eth_getTransactionReceipt') return { result: copy(evidence.receipt) };
      if (method === 'eth_blockNumber') return { result: '0x136' };
      expect(method).toBe('eth_getBlockByNumber');
      const tag = params[0] === 'finalized' ? '0x12e' : params[0];
      const hash = { '0x123': 200, '0x12c': 201, '0x12d': 202, '0x12e': 203 }[tag];
      expect(hash).toBeDefined();
      return { result: { number: tag, hash: prefixed(hash) } };
    }),
  };
  mock.validationResult = () => ({
    status: 'validated',
    capsuleDigest: mock.entry.capsuleDigest,
    revision: mock.entry.revision,
    payloadSha256: mock.entry.payloadSha256,
    outputMatched: true,
    proofVerified: true,
    independentlyVerified: true,
    verifierExitObserved: true,
    historicalRootMatchesLocalMirror: true,
    ownTxidIncludedBySavedIndex: true,
    localMirrorCheckpointMatched: true,
    originalRootsAccepted: false,
    rootAccepted: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
  mock.validate = jest.fn(async (args, handoff) => {
    mock.events.push('validate');
    mock.handoff = handoff;
    expect(handoff.sourceDestination).toBe(mock.sourceDestination);
    expect(handoff.destination).toBe(mock.receiptDestination);
    expect(handoff.entry).toEqual(mock.entry);
    expect(handoff.capture).toEqual(mock.capture);
    expect(args.signal.aborted).toBe(false);
    assertPreparedRailgunOwnReceipt(handoff.reader, {
      enrollment: args.enrollment,
      capture: handoff.capture,
      destination: handoff.destination,
    });
    const observed = await observePreparedRailgunOwnReceipt(handoff.reader);
    expect(observed.status).toBe('observed');
    mock.events.push('validated');
    return mock.validationResult();
  });
  mock.roots = {};
  mock.acquire = jest.fn(async () => {});
  mock.makeRoot = jest.fn((kind, args) => {
    expect(mock.review.mock.calls).toHaveLength(2);
    const context = getPrivacyContext(args.handle);
    expect(context.subject.role).toBe('poi');
    expect(args.root).toBe(
      kind === 'list' ? mock.entry.payload.poiMerkleroots[0] : mock.entry.payload.txidMerkleroot
    );
    if (kind === 'txid') expect(args.index).toBe(mock.entry.payload.txidMerklerootIndex);
    const controller = new AbortController();
    const receipt = Object.freeze({});
    const observation = Object.freeze({ accepted: true });
    let at;
    const root = {
      signal: controller.signal,
      closed: Promise.resolve(),
      close: jest.fn(() => controller.abort()),
      acquire: jest.fn(async (options) => {
        at = performance.now();
        mock.events.push('root:' + kind);
        await mock.acquire(kind, options);
        if (controller.signal.aborted) throw Error('closed root');
        return { receipt, observation };
      }),
      assertResult: jest.fn((given, margin = 0) => {
        if (
          given !== receipt ||
          controller.signal.aborted ||
          at === undefined ||
          performance.now() - at + margin >= 60000
        )
          throw Error('stale root');
        return observation;
      }),
    };
    mock.roots[kind] = root;
    return root;
  });
  mock.begin = jest.fn(async (args) => {
    expect(args).toEqual({
      capsuleDigest: mock.entry.capsuleDigest,
      expectedRevision: mock.entry.revision,
      expectedPayloadSha256: mock.entry.payloadSha256,
      signal: expect.any(AbortSignal),
    });
    expect(args.signal.aborted).toBe(false);
    expect(mock.entry.state).toBe('prepared');
    const attemptedAt = Date.now();
    const submission = prepareRailgunPoiSubmission({
      payload: mock.entry.payload,
      requestId: attemptedAt,
    });
    mock.entry = { ...mock.entry, state: 'attempted', attempt: { attemptedAt, submission } };
    mock.events.push('persisted');
    return {
      status: 'attempted',
      capsuleDigest: mock.entry.capsuleDigest,
      revision: mock.entry.revision,
      payloadSha256: mock.entry.payloadSha256,
      attemptedAt,
      bodySha256: submission.bodySha256,
      disclosureEnabled: false,
      spendingEnabled: false,
    };
  });
  mock.transportClosed = Promise.resolve();
  mock.post = jest.fn(async (_handle, url, request) => {
    expect(mock.entry.state).toBe('attempted');
    expect(url).toBe('https://ppoi.fdi.network');
    expect(request.body).toBe(mock.entry.attempt.submission.body);
    mock.events.push('post');
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: mock.entry.attempt.attemptedAt, result: true })
      ),
    };
  });
  mock.makeTransport = jest.fn(() => {
    mock.transport = {
      request: jest.fn((...args) => mock.post(...args)),
      close: jest.fn(),
      closed: mock.transportClosed,
    };
    return mock.transport;
  });
  mock.review = jest.fn(async (request, { signal }) => {
    expect(signal.aborted).toBe(false);
    idle();
    mock.events.push('review:' + request.purpose);
    return true;
  });
}
const sendOptions = (plan, changes = {}) => ({
  identity: mock.identity,
  enrollment: mock.enrollment,
  coordinator: mock.coordinator,
  archive: mock.archive,
  proverArchive: mock.proverArchive,
  artifactDirectory: '/synthetic/artifacts',
  plan: plan.plan,
  review: mock.review,
  signal: mock.caller.signal,
  ...changes,
});
const send = (plan, changes = {}) => {
  const pending = submit(sendOptions(plan, changes));
  operations.push(pending);
  return pending;
};
const freshPlan = async () => {
  const result = await run();
  expect(result.status).toBe('prepared');
  return result;
};
const noPost = () => {
  expect(mock.makeTransport).not.toHaveBeenCalled();
  expect(mock.post).not.toHaveBeenCalled();
};

test.each([false, true])(
  'genuine %s plan reviews twice and submits one exact persisted envelope',
  async (unshield) => {
    configure(unshield);
    const plan = await freshPlan();
    const result = await send(plan);
    expect(result).toMatchObject({
      status: 'recovery-required',
      stage: 'response',
      response: {
        classification: 'rpc-result',
        acceptanceVerified: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      },
    });
    expect(mock.review.mock.calls.map(([request]) => request.purpose)).toEqual([
      'validate-retained-poi',
      'submit-retained-poi',
    ]);
    expect(mock.validate).toHaveBeenCalledTimes(1);
    expect(mock.network.request).toHaveBeenCalledTimes(15);
    expect(mock.makeRoot).toHaveBeenCalledTimes(2);
    expect(mock.store.beginAttempt).toHaveBeenCalledTimes(1);
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect(mock.post.mock.calls[0][2]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mock.entry.attempt.submission.body,
      timeoutMs: 10000,
      maxResponseBytes: 2048,
      requireFramedResponse: true,
    });
    expect(mock.events.indexOf('persisted')).toBeLessThan(mock.events.indexOf('post'));
    expect(mock.events.indexOf('validated')).toBeLessThan(
      mock.events.indexOf('review:submit-retained-poi')
    );
    expect(mock.transport.close).toHaveBeenCalled();
    expect(plan.signal.aborted).toBe(true);
    await plan.closed;
    expect((await send(plan)).status).toBe('refused');
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(mock.entry.payloadSha256);
    expect(JSON.stringify(result)).not.toContain('private/path');
    expect(JSON.stringify(result)).not.toContain(String(mock.entry.attempt.attemptedAt));
  }
);

test.each(['empty', 'copy', 'wrapper', 'foreign'])(
  'forged %s plan leaves the genuine idle plan healthy',
  async (kind) => {
    const plan = await freshPlan();
    const forged = {
      empty: {},
      copy: { ...plan.plan },
      wrapper: plan,
      foreign: Object.freeze({ token: 'foreign' }),
    }[kind];
    expect((await send(plan, { plan: forged })).status).toBe('refused');
    expect(plan.signal.aborted).toBe(false);
    expect(mock.review).not.toHaveBeenCalled();
    expect(mock.network.request).not.toHaveBeenCalled();
    expect((await send(plan)).status).toBe('recovery-required');
    expect(mock.post).toHaveBeenCalledTimes(1);
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'policy', 'generation', 'descriptor'])(
  '%s owner drift burns recognized plan before review or queries',
  async (kind) => {
    const plan = await freshPlan();
    const change = {};
    if (['identity', 'enrollment', 'coordinator'].includes(kind)) change[kind] = { ...mock[kind] };
    if (kind === 'policy') mock.policy = { ...mock.policy, version: 2 };
    if (kind === 'generation')
      mock.publicIdentity = { ...mock.publicIdentity, generationId: hex(900) };
    if (kind === 'descriptor') mock.identity.descriptor.accountIndex++;
    expect((await send(plan, change)).status).toBe('refused');
    expect(plan.signal.aborted).toBe(true);
    expect(mock.review).not.toHaveBeenCalled();
    expect(mock.network.request).not.toHaveBeenCalled();
    noPost();
  }
);
test.each([
  'payload',
  'capsuleDigest',
  'sourceDestination',
  'receipt',
  'validation',
  'transport',
  'url',
  'requestId',
  'approved',
  'response',
])('caller %s injection is refused before review', async (key) => {
  const plan = await freshPlan();
  expect((await send(plan, { [key]: {} })).status).toBe('refused');
  expect(mock.review).not.toHaveBeenCalled();
  expect(mock.network.request).not.toHaveBeenCalled();
  noPost();
});
test.each([0, -1, 0.5, NaN, Infinity, 1, 60000, 200000, 789999, 840001])(
  'invalid timeout %s is refused before work',
  async (timeoutMs) => {
    const plan = await freshPlan();
    expect((await send(plan, { timeoutMs })).status).toBe('refused');
    expect(mock.review).not.toHaveBeenCalled();
    expect(mock.network.request).not.toHaveBeenCalled();
    expect(
      require('./private-transaction-network').getPrivateTransactionNetwork
    ).not.toHaveBeenCalled();
    noPost();
  }
);
test('busy reentry, preparation and revalidation cannot revoke the admitted review owner', async () => {
  const plan = await freshPlan(),
    gate = deferred();
  mock.review.mockImplementationOnce(async () => {
    idle();
    await gate.promise;
    return true;
  });
  const pending = send(plan);
  await until(() => mock.review.mock.calls.length === 1);
  expect((await send(plan)).status).toBe('refused');
  expect((await recheck(plan)).status).toBe('refused');
  expect((await run()).status).toBe('refused');
  expect(plan.signal.aborted).toBe(false);
  expect(mock.network.request).not.toHaveBeenCalled();
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  expect(mock.post).toHaveBeenCalledTimes(1);
});
describe.each([1, 2])('review %i', (reviewNumber) => {
  test.each(['false', 'undefined', 'truthy-object', 'throw'])(
    '%s refuses without admitting its protected disclosure',
    async (kind) => {
      const plan = await freshPlan();
      mock.review.mockImplementation(async (request) => {
        idle();
        if (mock.review.mock.calls.length !== reviewNumber) return true;
        expect(request.purpose).toBe(
          reviewNumber === 1 ? 'validate-retained-poi' : 'submit-retained-poi'
        );
        expect(mock.makeRoot).not.toHaveBeenCalled();
        if (reviewNumber === 1) expect(mock.network.request).not.toHaveBeenCalled();
        if (kind === 'throw') throw Error('PRIVATE review failure');
        return kind === 'truthy-object' ? { approved: true } : kind === 'false' ? false : undefined;
      });
      const result = await send(plan);
      expect(result.status).toBe('refused');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
      expect(mock.network.request).toHaveBeenCalledTimes(reviewNumber === 1 ? 0 : 15);
      expect(mock.makeRoot).not.toHaveBeenCalled();
      expect(mock.begin).not.toHaveBeenCalled();
      noPost();
      expect((await send(plan)).status).toBe('refused');
      expect(mock.review).toHaveBeenCalledTimes(reviewNumber);
    }
  );
  test.each(['caller', 'old-plan-close', 'deadline'])(
    '%s cancellation drains ignored review and retains directory ownership',
    async (cause) => {
      const plan = await freshPlan(),
        gate = deferred();
      mock.review.mockImplementation(async () => {
        idle();
        if (mock.review.mock.calls.length === reviewNumber) await gate.promise;
        return true;
      });
      let settled = false,
        closed = false;
      plan.closed.then(() => {
        closed = true;
      });
      const pending = send(plan).then((result) => {
        settled = true;
        return result;
      });
      await until(() => mock.review.mock.calls.length === reviewNumber);
      if (cause === 'caller') mock.caller.abort();
      if (cause === 'old-plan-close') plan.close();
      if (cause === 'deadline')
        await jest.advanceTimersByTimeAsync(reviewNumber === 1 ? 30000 : 60000);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(closed).toBe(false);
      expect((await run({ ...options, signal: new AbortController().signal })).status).toBe(
        'refused'
      );
      gate.resolve();
      expect((await pending).status).toBe('refused');
      await plan.closed;
      expect(mock.makeRoot).not.toHaveBeenCalled();
      expect(mock.begin).not.toHaveBeenCalled();
      noPost();
    }
  );
});
test.each([60001, 120000])('plan age %sms cannot start sender or renew display', async (age) => {
  const plan = await freshPlan();
  await jest.advanceTimersByTimeAsync(age);
  expect((await send(plan)).status).toBe('refused');
  expect(mock.review).not.toHaveBeenCalled();
  expect(mock.network.request).not.toHaveBeenCalled();
});
test('successful first review promotes only the claimed invocation past original display expiry', async () => {
  const plan = await freshPlan();
  await jest.advanceTimersByTimeAsync(60000);
  const original = mock.validate.getMockImplementation();
  mock.validate.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    await jest.advanceTimersByTimeAsync(120001);
    expect(plan.signal.aborted).toBe(false);
    expect((await recheck(plan)).status).toBe('refused');
    return result;
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.post).toHaveBeenCalledTimes(1);
  expect(mock.validate.mock.calls[0][0].timeoutMs).toBe(600000);
});
test('first review and strict post-review reattestation cannot renew the original display window', async () => {
  const plan = await freshPlan();
  await jest.advanceTimersByTimeAsync(60000);
  let starts = 0;
  mock.recoveryStart.mockImplementation(async () => {
    starts++;
    await jest.advanceTimersByTimeAsync(starts === 1 ? 14999 : 15000);
  });
  mock.review.mockImplementationOnce(async () => {
    await jest.advanceTimersByTimeAsync(29999);
    return true;
  });
  expect((await send(plan)).status).toBe('refused');
  expect(mock.validate).not.toHaveBeenCalled();
  expect(mock.network.request).not.toHaveBeenCalled();
  noPost();
});
test.each([790000, 840000])(
  'accepted total budget %s retains the fixed validation ceiling',
  async (timeoutMs) => {
    const plan = await freshPlan();
    expect((await send(plan, { timeoutMs })).status).toBe('recovery-required');
    expect(mock.validate.mock.calls[0][0].timeoutMs).toBe(600000);
    expect(mock.post).toHaveBeenCalledTimes(1);
  }
);
test('insufficient total headroom at promotion refuses locally without a receipt query', async () => {
  const plan = await freshPlan();
  const details = require('../networks/private-rpc').getPrivateRpcDestinationDetails;
  const original = details.getMockImplementation();
  details.mockImplementationOnce((...args) => {
    jest.advanceTimersByTime(31000);
    return original(...args);
  });
  mock.review.mockImplementationOnce(async () => {
    await jest.advanceTimersByTimeAsync(29001);
    return true;
  });
  expect((await send(plan, { timeoutMs: 790000 })).status).toBe('refused');
  expect(mock.review).toHaveBeenCalledTimes(1);
  expect(mock.validate).not.toHaveBeenCalled();
  expect(mock.network.request).not.toHaveBeenCalled();
  noPost();
});
test.each(['source', 'receipt'])(
  '%s destination replacement during first review never selects a replacement client',
  async (kind) => {
    const plan = await freshPlan();
    mock.review.mockImplementationOnce(async () => {
      if (kind === 'source') mock.sourceDestination = Object.freeze({});
      else mock.receiptDestination = Object.freeze({});
      return true;
    });
    expect((await send(plan)).status).toBe('refused');
    expect(mock.network.request).not.toHaveBeenCalled();
    expect(mock.validate).not.toHaveBeenCalled();
    expect(
      require('./private-transaction-network').getPrivateTransactionNetwork
    ).toHaveBeenCalledTimes(1);
    noPost();
  }
);
test.each(['before-validation', 'before-roots'])(
  '%s archive evolution is strict and blocks later disclosure',
  async (point) => {
    const plan = await freshPlan();
    mock.review.mockImplementation(async () => {
      if (mock.review.mock.calls.length === (point === 'before-validation' ? 1 : 2))
        mock.capture.record = {
          ...mock.capture.record,
          archivedAt: 1,
          finalized: { number: 301, hash: prefixed(202) },
        };
      return true;
    });
    expect((await send(plan)).status).toBe('refused');
    if (point === 'before-validation') expect(mock.network.request).not.toHaveBeenCalled();
    expect(mock.makeRoot).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    noPost();
  }
);
test('post-attempt archive evolution preserves one POST when stable capture facts still match', async () => {
  const plan = await freshPlan();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    mock.capture.record = {
      ...mock.capture.record,
      archivedAt: 1,
      finalized: { number: 301, hash: prefixed(202) },
    };
    return result;
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.post).toHaveBeenCalledTimes(1);
});
test.each([
  'bindingDigest',
  'selector',
  'facts',
  'submitter',
  'capsule',
  'capsuleDigest',
  'provedTransaction',
  'intent',
  'projection',
])('post-attempt stable %s drift leaves an uncertain attempt with zero POST', async (field) => {
  const plan = await freshPlan();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    mock.capture[field] =
      typeof mock.capture[field] === 'string'
        ? 'changed'
        : { ...mock.capture[field], changed: true };
    return result;
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.entry.state).toBe('attempted');
  noPost();
  expect((await send(plan)).status).toBe('refused');
  expect(mock.begin).toHaveBeenCalledTimes(1);
});

test.each([
  'refused',
  'recovery-required',
  'throw-before-reply',
  'lost-reply-after-write',
  'floor-failure',
])('beginAttempt %s never opens a POST slot', async (mode) => {
  const plan = await freshPlan();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    if (['lost-reply-after-write', 'floor-failure'].includes(mode)) await original(...args);
    if (mode.includes('reply')) throw Error('PRIVATE interrupted write');
    return { status: mode === 'refused' ? 'refused' : 'recovery-required', stage: 'persist' };
  });
  const result = await send(plan);
  expect(result.status).toBe(mode === 'refused' ? 'refused' : 'recovery-required');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  noPost();
  expect((await send(plan)).status).toBe('refused');
  expect(mock.begin).toHaveBeenCalledTimes(1);
});
test.each([
  'revision',
  'payloadSha256',
  'attemptedAt',
  'bodySha256',
  'capsuleDigest',
  'disclosureEnabled',
])('successful begin with wrong %s completion facts cannot disclose', async (field) => {
  const plan = await freshPlan();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    result[field] =
      typeof result[field] === 'number'
        ? result[field] + 1
        : field === 'disclosureEnabled'
          ? true
          : hex(999);
    return result;
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.entry.state).toBe('attempted');
  noPost();
});
test.each(['state', 'payload', 'request-id', 'canonical-body', 'added-field'])(
  'attempted readback %s mismatch closes slot before transport construction',
  async (field) => {
    const plan = await freshPlan();
    const original = mock.begin.getMockImplementation();
    mock.begin.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (field === 'state') mock.entry.state = 'prepared';
      if (field === 'payload') mock.entry.payload.proof.pi_a[0] = '9';
      if (field === 'request-id') mock.entry.attempt.attemptedAt++;
      if (field === 'canonical-body') mock.entry.attempt.submission.body += ' ';
      if (field === 'added-field') mock.entry.extra = true;
      return result;
    });
    expect((await send(plan)).status).toBe('recovery-required');
    noPost();
  }
);
test('pre-existing attempted storage cannot begin again or query', async () => {
  const plan = await freshPlan();
  await mock.begin({
    capsuleDigest: mock.entry.capsuleDigest,
    expectedRevision: 1,
    expectedPayloadSha256: mock.entry.payloadSha256,
    signal: mock.caller.signal,
  });
  mock.begin.mockClear();
  expect((await send(plan)).status).toBe('refused');
  expect(mock.review).not.toHaveBeenCalled();
  expect(mock.network.request).not.toHaveBeenCalled();
  expect(mock.begin).not.toHaveBeenCalled();
  noPost();
});
test('late successful begin remains uncertain after its admission deadline, with zero POST', async () => {
  const plan = await freshPlan(),
    gate = deferred();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    await gate.promise;
    return result;
  });
  let settled = false;
  const pending = send(plan).then((result) => {
    settled = true;
    return result;
  });
  await until(() => mock.begin.mock.calls.length === 1);
  await jest.advanceTimersByTimeAsync(15000);
  expect(settled).toBe(false);
  expect((await run({ ...options, signal: new AbortController().signal })).status).toBe('refused');
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  expect(mock.entry.state).toBe('attempted');
  noPost();
});
test.each(['list', 'txid'])(
  '%s root refusal closes sibling and drains its ignored work',
  async (failure) => {
    const plan = await freshPlan(),
      gate = deferred();
    mock.acquire.mockImplementation(async (kind) => {
      if (kind === failure) throw Error('PRIVATE root error');
      await gate.promise;
    });
    let settled = false;
    const pending = send(plan).then((result) => {
      settled = true;
      return result;
    });
    await until(() => mock.acquire.mock.calls.length === 2);
    await until(() => mock.roots.list.close.mock.calls.length > 0);
    expect(settled).toBe(false);
    expect(mock.roots.txid.signal.aborted).toBe(true);
    expect((await run()).status).toBe('refused');
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mock.begin).not.toHaveBeenCalled();
    noPost();
  }
);
test('root receipts must both retain the exact forty-second begin margin', async () => {
  const plan = await freshPlan();
  const original = mock.makeRoot.getMockImplementation();
  mock.makeRoot.mockImplementation((kind, args) => {
    const source = original(kind, args);
    if (kind === 'txid')
      source.assertResult.mockImplementation((_receipt, margin) => {
        expect(margin).toBe(40000);
        throw Error('root age plus margin equals 60000');
      });
    return source;
  });
  expect((await send(plan)).status).toBe('refused');
  expect(mock.roots.list.assertResult).toHaveBeenCalledWith(expect.any(Object), 40000);
  expect(mock.begin).not.toHaveBeenCalled();
  noPost();
});
test('root freshness is rechecked after durable begin and cannot refresh or retry', async () => {
  const plan = await freshPlan();
  const original = mock.begin.getMockImplementation();
  mock.begin.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    mock.roots.list.assertResult.mockImplementation(() => {
      throw Error('stale root');
    });
    return result;
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.acquire).toHaveBeenCalledTimes(2);
  expect(mock.begin).toHaveBeenCalledTimes(1);
  noPost();
});
test.each(['malformed', 'unmatched', 'http-failure', 'rpc-error', 'transport-failure'])(
  '%s response remains uncertain, redacted, and never retried',
  async (kind) => {
    const plan = await freshPlan();
    mock.post.mockImplementationOnce(async () => {
      if (kind === 'transport-failure') throw Error('PRIVATE transport error');
      return {
        status: kind === 'http-failure' ? 503 : 200,
        body: Buffer.from(
          kind === 'malformed'
            ? 'PRIVATE bad body'
            : JSON.stringify({
                jsonrpc: '2.0',
                id: mock.entry.attempt.attemptedAt + (kind === 'unmatched' ? 1 : 0),
                ...(kind === 'rpc-error'
                  ? { error: { code: -1, message: 'PRIVATE service detail' } }
                  : { result: true }),
              })
        ),
      };
    });
    const result = await send(plan);
    expect(result.status).toBe('recovery-required');
    expect(result.response.classification).toBe(
      kind === 'transport-failure' ? 'unavailable' : kind
    );
    expect(result.response.acceptanceVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect((await send(plan)).status).toBe('refused');
    expect(mock.post).toHaveBeenCalledTimes(1);
  }
);
test.each(['healthy', 'cancelled'])(
  'dedicated transport close drain retains owner after %s POST',
  async (kind) => {
    const plan = await freshPlan(),
      gate = deferred();
    mock.transportClosed = gate.promise;
    let settled = false,
      closed = false;
    plan.closed.then(() => {
      closed = true;
    });
    const pending = send(plan).then((result) => {
      settled = true;
      return result;
    });
    await until(() => mock.transport?.close.mock.calls.length > 0);
    if (kind === 'cancelled') plan.close();
    // Let unrelated final-read/reattest microtasks finish; the sole unresolved
    // boundary must be the dedicated transport's close promise.
    for (let tick = 0; tick < 100; tick++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    expect(() => {
      const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
      phase.release();
    }).toThrow();
    expect((await run({ ...options, signal: new AbortController().signal })).status).toBe(
      'refused'
    );
    expect(mock.post).toHaveBeenCalledTimes(1);
    gate.resolve();
    const result = await pending;
    expect(result.status).toBe('recovery-required');
    await plan.closed;
    idle();
    expect(mock.post).toHaveBeenCalledTimes(1);
  }
);
test('cancelled POST waits for both ignored request and later transport close', async () => {
  const plan = await freshPlan(),
    wire = deferred(),
    drain = deferred();
  mock.transportClosed = drain.promise;
  mock.post.mockImplementationOnce(async () => {
    await wire.promise;
    throw Error('ignored cancellation');
  });
  let settled = false;
  const pending = send(plan).then((result) => {
    settled = true;
    return result;
  });
  await until(() => mock.post.mock.calls.length === 1);
  plan.close();
  await Promise.resolve();
  expect(settled).toBe(false);
  wire.resolve();
  await until(() => mock.transport.close.mock.calls.length > 0);
  for (let tick = 0; tick < 100; tick++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(() => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
    phase.release();
  }).toThrow();
  drain.resolve();
  expect((await pending).status).toBe('recovery-required');
  expect(mock.post).toHaveBeenCalledTimes(1);
});
test('validation refusal retains its late genuine source diagnostic through cancellation', async () => {
  const plan = await freshPlan(),
    gate = deferred();
  const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
  mock.validate.mockImplementationOnce(async () => {
    await gate.promise;
    return { status: 'refused', stage: 'source', sourceOutcome };
  });
  let settled = false;
  const pending = send(plan).then((result) => {
    settled = true;
    return result;
  });
  await until(() => mock.validate.mock.calls.length === 1);
  plan.close();
  expect(settled).toBe(false);
  gate.resolve();
  expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
  expect(mock.review).toHaveBeenCalledTimes(1);
  expect(mock.makeRoot).not.toHaveBeenCalled();
  noPost();
});
test('thrown validator error cannot forge source outcome through public error fields', async () => {
  const plan = await freshPlan();
  mock.validate.mockRejectedValueOnce(
    Object.assign(Error('PRIVATE error'), {
      sourceOutcome: { fatal: false, reason: 'completed', rpcFailure: null },
    })
  );
  const result = await send(plan);
  expect(result.status).toBe('refused');
  expect(result).not.toHaveProperty('sourceOutcome');
  noPost();
});

test('review inventories expose origins and bounded scopes, with no raw endpoint paths or proof facts', async () => {
  const plan = await freshPlan();
  await send(plan);
  const [first, second] = mock.review.mock.calls.map(([request]) => request);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.destinations[0])).toBe(true);
  expect(first.destinations).toEqual([
    { role: 'source-rpc', origin: 'https://source.example' },
    { role: 'receipt-rpc', origin: 'https://receipt.example' },
    { role: 'poi-service', origin: 'https://ppoi.fdi.network' },
  ]);
  expect(first.requestInventory.reduce((count, item) => count + item.maxRequests, 0)).toBe(565);
  expect(first.requestInventory.filter((item) => item.method.startsWith('ppoi_'))).toEqual([
    { method: 'ppoi_validated_txid', maxRequests: 7 },
    { method: 'ppoi_validate_txid_merkleroot', maxRequests: 7 },
  ]);
  expect(second.requestInventory).toEqual([
    { method: 'ppoi_validate_poi_merkleroots', maxRequests: 1 },
    { method: 'ppoi_validate_txid_merkleroot', maxRequests: 1 },
    { method: 'ppoi_submit_transact_proof', maxRequests: 1 },
  ]);
  for (const request of [first, second]) {
    expect(request.consentGranted).toBe(false);
    expect(request.transportAuthorized).toBe(false);
    expect(JSON.stringify(request)).not.toContain('private/path');
    expect(JSON.stringify(request)).not.toContain(mock.entry.payloadSha256);
    expect(JSON.stringify(request)).not.toContain(mock.entry.payload.txidMerkleroot);
    expect(JSON.stringify(request)).not.toContain(mock.capture.submitter);
  }
});
test('caller option mutations during initial recovery cannot replace captured review or owners', async () => {
  const plan = await freshPlan(),
    gate = deferred();
  mock.recoveryStart.mockImplementationOnce(async () => {
    await gate.promise;
  });
  const supplied = sendOptions(plan);
  const pending = submit(supplied);
  operations.push(pending);
  await until(() => mock.recoveryStart.mock.calls.length === 2);
  supplied.plan = {};
  supplied.identity = {};
  supplied.archive = {};
  supplied.timeoutMs = 1;
  supplied.review = jest.fn(() => {
    throw Error('replacement review');
  });
  gate.resolve();
  expect((await pending).status).toBe('recovery-required');
  expect(supplied.review).not.toHaveBeenCalled();
  expect(mock.review).toHaveBeenCalledTimes(2);
  expect(mock.post).toHaveBeenCalledTimes(1);
});
test('reentrant submission from the POST boundary cannot consume a second slot or cancel its owner', async () => {
  const plan = await freshPlan();
  const original = mock.post.getMockImplementation();
  mock.post.mockImplementationOnce(async (...args) => {
    expect((await send(plan)).status).toBe('refused');
    expect(plan.signal.aborted).toBe(false);
    return original(...args);
  });
  expect((await send(plan)).status).toBe('recovery-required');
  expect(mock.begin).toHaveBeenCalledTimes(1);
  expect(mock.post).toHaveBeenCalledTimes(1);
});
test.each(['capture', 'readback', 'outer-recovery'])(
  'failure after POST in %s preserves response uncertainty without another POST',
  async (point) => {
    const plan = await freshPlan();
    const original = mock.post.getMockImplementation();
    mock.post.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      if (point === 'capture') mock.capture.bindingDigest = hex(900);
      if (point === 'readback') mock.entry.revision++;
      if (point === 'outer-recovery')
        mock.recoveryPost.mockRejectedValueOnce(Error('PRIVATE after POST'));
      return response;
    });
    const result = await send(plan);
    expect(result).toMatchObject({
      status: 'recovery-required',
      response: { classification: 'rpc-result', acceptanceVerified: false },
    });
    expect(result.stage).not.toBe('response');
    expect(mock.post).toHaveBeenCalledTimes(1);
    expect(mock.begin).toHaveBeenCalledTimes(1);
    expect((await send(plan)).status).toBe('refused');
    expect(mock.post).toHaveBeenCalledTimes(1);
  }
);
test('fixed sender and submission cores remain unwired outside their explicit production modules', () => {
  const fs = require('fs'),
    path = require('path');
  const root = path.resolve(__dirname, '../..');
  const files = [];
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) visit(filename);
      else if (item.name.endsWith('.js') && !item.name.endsWith('.test.js')) files.push(filename);
    }
  };
  visit(root);
  for (const [name, expected] of [
    ['submitRailgunRetainedPoi', ['main/wallet/railgun-poi-disclosure-plan.js']],
    ['recoverRailgunAttemptedPoiOutput', ['main/wallet/railgun-poi-output-recovery.js']],
    [
      'claimRailgunAttemptedPoiOutput',
      ['main/wallet/railgun-poi-disclosure-plan.js', 'main/wallet/railgun-poi-output-recovery.js'],
    ],
    [
      'validateRailgunRetainedPoiForSubmission',
      ['main/wallet/railgun-poi-cold-validation.js', 'main/wallet/railgun-poi-disclosure-plan.js'],
    ],
    [
      'recoverRailgunPoiOutputForSubmission',
      ['main/wallet/railgun-poi-cold-validation.js', 'main/wallet/railgun-poi-output-recovery.js'],
    ],
    ['preflightRailgunOwnPoiForSubmission', ['main/wallet/railgun-own-witness.js']],
    [
      'preflightRailgunRetainedPoiForSubmission',
      ['main/wallet/railgun-own-witness.js', 'main/wallet/railgun-poi-output-recovery.js'],
    ],
    [
      'preflightRailgunRetainedPoiCompleted',
      [
        'main/wallet/railgun-own-witness.js',
        'main/wallet/railgun-poi-output-recovery.js',
        'main/wallet/railgun-own-poi-checks.js',
      ],
    ],
  ]) {
    const actual = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes(name))
      .map((file) => path.relative(root, file))
      .sort();
    expect(actual).toEqual([...expected].sort());
  }
});

test.each(['before-attempt', 'pending-post', 'transport-closed'])(
  'attempted diagnostic refuses during sender %s without store work or disturbing original owner',
  async (point) => {
    const plan = await freshPlan(),
      gate = deferred();
    if (point === 'before-attempt')
      mock.review.mockImplementationOnce(async () => {
        await gate.promise;
        return true;
      });
    if (point === 'pending-post') {
      const post = mock.post.getMockImplementation();
      mock.post.mockImplementationOnce(async (...args) => {
        await gate.promise;
        return post(...args);
      });
    }
    if (point === 'transport-closed') mock.transportClosed = gate.promise;
    let settled = false;
    const pending = send(plan).then((result) => {
      settled = true;
      return result;
    });
    await until(() =>
      point === 'before-attempt'
        ? mock.review.mock.calls.length === 1
        : point === 'pending-post'
          ? mock.post.mock.calls.length === 1
          : mock.transport?.close.mock.calls.length > 0
    );
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
    expect(mock.entry.state).toBe(point === 'before-attempt' ? 'prepared' : 'attempted');
    const opens = mock.enrollment.openPoiIntents.mock.calls.length;
    const reads = mock.store.get.mock.calls.length;
    const queries = mock.network.request.mock.calls.length;
    const { recoverRailgunAttemptedPoiOutput } = require('./railgun-poi-output-recovery');
    for (const enrollment of [mock.enrollment, { ...mock.enrollment }]) {
      mock.enrollments.add(enrollment);
      const diagnostic = recoverRailgunAttemptedPoiOutput({
        identity: mock.identity,
        enrollment,
        coordinator: mock.coordinator,
        archive: mock.archive,
        capsuleDigest: mock.entry.capsuleDigest,
        signal: new AbortController().signal,
      });
      operations.push(diagnostic);
      expect(await diagnostic).toEqual({ status: 'refused', stage: 'busy' });
    }
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(opens);
    expect(mock.store.get).toHaveBeenCalledTimes(reads);
    expect(mock.network.request).toHaveBeenCalledTimes(queries);
    expect(mock.validate).toHaveBeenCalledTimes(point === 'before-attempt' ? 0 : 1);
    expect(settled).toBe(false);
    expect(plan.signal.aborted).toBe(false);
    gate.resolve();
    expect((await pending).status).toBe('recovery-required');
    expect(mock.post).toHaveBeenCalledTimes(1);
    // A fresh claimant after sender cleanup proves the diagnostic did not
    // release/reacquire or poison the original sender's shared token.
    const claim = require('./railgun-poi-disclosure-plan').claimRailgunAttemptedPoiOutput({
      identity: mock.identity,
      enrollment: mock.enrollment,
      coordinator: mock.coordinator,
      signal: new AbortController().signal,
    });
    try {
      expect(claim.assertCurrent()).toBeUndefined();
    } finally {
      claim.release();
    }
  }
);
