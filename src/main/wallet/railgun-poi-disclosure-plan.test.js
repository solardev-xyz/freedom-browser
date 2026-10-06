// Authority boundaries are mocked; real payload/capsule normalizers, capture
// comparison, privacy handles and account phase exclusions remain in use.
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
  getRailgunPublicPolicy: jest.fn(() => {
    throw Error('unexpected caller policy');
  }),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => {
    throw Error('unexpected runtime');
  }),
}));
jest.mock('./railgun-prover-runtime', () => ({
  verifyRailgunProverRuntime: jest.fn(() => {
    throw Error('unexpected prover runtime');
  }),
}));
jest.mock('./railgun-poi-root', () => ({
  createRailgunPoiRootSource: jest.fn(() => {
    throw Error('unexpected roots');
  }),
  createRailgunPoiTxidRootSource: jest.fn(() => {
    throw Error('unexpected roots');
  }),
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

const { createHash } = require('crypto');
const { createPrivacyScope } = require('../networks/privacy-context');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { samplePartial } = require('../../../scripts/fixtures/railgun-partial-own-txid-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const {
  claimRailgunAttemptedPoiOutput: claimAttempted,
  prepareRailgunPoiDisclosurePlan: prepare,
  revalidateRailgunPoiDisclosurePlan: revalidate,
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
let options, gates, operations, plans, claims;
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
const freshOptions = () => ({ ...options, signal: new AbortController().signal });
const refused = (result) => {
  expect(result).toEqual({
    status: 'refused',
    stage: expect.stringMatching(
      /^(context|busy|store|entry|recovery|binding|reattest|final-entry|lifetime)$/
    ),
  });
};
const idle = () => {
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
};
function configure(unshield = false) {
  const partial = unshield === 'partial';
  const evidence = partial ? samplePartial() : sample(unshield),
    capsule = evidence.capsule;
  const descriptor = {
    walletId: capsule.walletId,
    instanceId: unshield ? sample().capsule.selection.recipient : capsule.selection.recipient,
    masterPublicKey: hex(3),
    spendingPublicKey: [hex(4), hex(5)],
    viewingPublicKey: hex(6),
    accountIndex: 0,
  };
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
    provedTransaction: copy(evidence.transaction),
    intent: copy(evidence.record.intent),
    projection: { included: true, blockHash: evidence.receipt.blockHash },
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
    blindedCommitmentsOut: unshield && !partial ? [] : [prefixed(22)],
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
  claims = [];
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
    beginAttempt: jest.fn(() => {
      throw Error('unexpected attempt');
    }),
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
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.recoveryStart = jest.fn(async () => {});
  mock.recoveryPost = jest.fn(async () => {});
});
afterEach(async () => {
  mock.caller.abort();
  mock.enrollmentAbort.abort();
  for (const plan of plans) plan.close();
  for (const claim of claims) claim.release();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(operations);
  await Promise.all(plans.map((plan) => plan.closed));
  expect(mock.store.prepare).not.toHaveBeenCalled();
  expect(mock.store.beginAttempt).not.toHaveBeenCalled();
  expect(mock.store.close).not.toHaveBeenCalled();
  for (const [file, name] of [
    ['./railgun-identity', 'withRailgunViewingCredential'],
    ['./railgun-own-operation', 'captureRailgunOwnOperationSelector'],
    ['./railgun-public-policy', 'getRailgunPublicPolicy'],
    ['./railgun-engine-runtime', 'verifyRailgunEngineRuntime'],
    ['./railgun-prover-runtime', 'verifyRailgunProverRuntime'],
    ['./railgun-poi-root', 'createRailgunPoiRootSource'],
    ['./railgun-poi-root', 'createRailgunPoiTxidRootSource'],
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

const summaryFor = (unshield = false) => ({
  version: 1,
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  accountIndex: 0,
  endpoint: 'https://ppoi.fdi.network',
  txidVersion: 'V2_PoseidonMerkle',
  listKey: REQUIRED_LIST,
  operation: unshield ? 'unshield' : 'transfer',
  outputCount: unshield ? 0 : 1,
  unshieldIdCategory: unshield ? 'railgun-txid' : 'absent',
  requestInventory: [
    { method: 'ppoi_validate_poi_merkleroots', count: 1 },
    { method: 'ppoi_validate_txid_merkleroot', count: 1 },
    { method: 'ppoi_submit_transact_proof', count: 1 },
  ],
  disclosureCategories: [
    'proof-related-query-timing',
    'network-session-linkability',
    'transaction-linkability',
    'request-id-local-time',
    'poi-list-root',
    'txid-root-and-index',
    'snark-proof-and-public-inputs',
    unshield ? 'unshield-railgun-txid' : 'blinded-output-commitment',
  ],
  uncertaintyCategories: [
    'service-acceptance-unqualified',
    'non-delivery-not-established',
    'safe-retry-not-established',
    'irreversible-disclosure-possible-with-uncertain-outcome',
    'no-automatic-retry',
  ],
  requestIdAllocation: 'local-time-once-at-durable-attempt',
  displayFreshnessMs: 120000,
  consentGranted: false,
  transportAuthorized: false,
  requestLimitsEnforced: false,
  proofVerified: false,
  rootsAccepted: false,
  spendingEnabled: false,
});
const assertFrozen = (value) => {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(assertFrozen);
  }
};

test.each([false, true])(
  'derives exact bounded %s inventory without authority or idle recovery phase',
  async (unshield) => {
    configure(unshield);
    const entry = copy(mock.entry),
      capture = copy(mock.capture),
      result = await run();
    expect(result.status).toBe('prepared');
    expect(Object.keys(result).sort()).toEqual([
      'close',
      'closed',
      'plan',
      'signal',
      'status',
      'summary',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.plan).toEqual({});
    expect(Reflect.ownKeys(result.plan)).toEqual([]);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(result.summary).toEqual(summaryFor(unshield));
    expect(JSON.stringify(result.summary)).toBe(JSON.stringify(summaryFor(unshield)));
    assertFrozen(result.summary);
    expect(Buffer.byteLength(JSON.stringify(result.summary))).toBeLessThanOrEqual(4096);
    expect(result.signal).toBeInstanceOf(AbortSignal);
    expect(result.signal.aborted).toBe(false);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(1);
    expect(withRailgunOwnOperationRecovery.mock.calls[0][0]).toMatchObject({
      enrollment: mock.enrollment,
      selector: entry.selector,
      timeoutMs: 15000,
    });
    expect(mock.entry).toEqual(entry);
    expect(mock.capture).toEqual(capture);
    idle();
    expect(await recheck(result)).toEqual({ status: 'current', summary: result.summary });
    expect((await recheck(result)).summary).toBe(result.summary);
    idle();
    const serialized = JSON.stringify(result.summary);
    for (const secret of [
      entry.capsuleDigest,
      entry.bindingDigest,
      entry.payloadSha256,
      entry.inputSha256,
      mock.identity.descriptor.walletId,
      mock.identity.descriptor.instanceId,
      entry.payload.txidMerkleroot,
      entry.payload.proof.pi_a.join(','),
    ])
      expect(serialized).not.toContain(secret);
    result.close();
    result.close();
    expect(result.signal.aborted).toBe(true);
    await result.closed;
    refused(await recheck(result));
    idle();
  }
);
test('exports preparation, display revalidation and fixed unwired sender without a generic issuer', () => {
  expect(Object.keys(require('./railgun-poi-disclosure-plan')).sort()).toEqual([
    'claimRailgunAttemptedPoiOutput',
    'prepareRailgunPoiDisclosurePlan',
    'revalidateRailgunPoiDisclosurePlan',
    'submitRailgunRetainedPoi',
  ]);
});
test.each([null, undefined, [], false, 1, 'PRIVATE'])(
  'invalid preparation options %# refuse without opening storage',
  async (value) => {
    const work = prepare(value);
    operations.push(work);
    refused(await work);
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each(['archive', 'policy', 'payload', 'selector', 'record', 'approved', 'timeout', 'extra'])(
  'extra caller field %s is refused',
  async (field) => {
    refused(await run({ ...options, [field]: 'PRIVATE' }));
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'capsuleDigest', 'signal'])(
  'missing required %s refuses',
  async (field) => {
    const input = { ...options };
    delete input[field];
    refused(await run(input));
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each([0, -1, 1.5, 45001, Infinity, NaN, '15000', null])(
  'invalid preparation budget %s refuses',
  async (timeoutMs) => {
    refused(await run({ ...options, timeoutMs }));
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'aborted', 'digest', 'descriptor'])(
  'forged initial %s refuses before storage',
  async (kind) => {
    const input = { ...options };
    if (['identity', 'enrollment', 'coordinator'].includes(kind)) input[kind] = { ...input[kind] };
    if (kind === 'aborted') mock.caller.abort();
    if (kind === 'digest') input.capsuleDigest = 'PRIVATE';
    if (kind === 'descriptor') mock.enrollment.descriptor.accountIndex = 1;
    refused(await run(input));
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each([
  'missing',
  'attempted',
  'digest',
  'binding',
  'selector',
  'payload-hash',
  'payload',
  'mixed-output',
])('invalid prepared entry %s cannot produce a plan', async (kind) => {
  if (kind === 'missing') mock.read.mockResolvedValue(null);
  if (kind === 'attempted') mock.entry.state = 'attempted';
  if (kind === 'digest') mock.entry.capsuleDigest = hex(999);
  if (kind === 'binding') mock.entry.bindingDigest = hex(999);
  if (kind === 'selector') mock.entry.selector.position++;
  if (kind === 'payload-hash') mock.entry.payloadSha256 = hex(999);
  if (kind === 'payload') mock.entry.payload = { private: true };
  if (kind === 'mixed-output') {
    mock.entry.payload = copy(mock.entry.payload);
    mock.entry.payload.railgunTxidIfHasUnshield = prefixed(9);
    mock.entry.payloadSha256 = sha(mock.entry.payload);
  }
  refused(await run());
  expect(plans).toHaveLength(0);
});
test.each([false, true])(
  'genuine capture operation must match normalized %s payload category',
  async (unshield) => {
    configure(unshield);
    const other = sample(!unshield);
    mock.capture.capsule = copy(other.capsule);
    mock.capture.facts.kind = other.capsule.selection.kind;
    refused(await run());
  }
);
test.each(['open', 'read', 'recovery', 'reattest', 'post'])(
  'boundary failure at %s is sanitized and releases pending owner',
  async (point) => {
    const fail = () => {
      throw Error('PRIVATE backend body');
    };
    if (point === 'open') mock.enrollment.openPoiIntents.mockImplementationOnce(fail);
    if (point === 'read') mock.read.mockImplementationOnce(fail);
    if (point === 'recovery') mock.recoveryStart.mockImplementationOnce(fail);
    if (point === 'reattest') mock.reattest.mockImplementationOnce(fail);
    if (point === 'post') mock.recoveryPost.mockImplementationOnce(fail);
    const result = await run();
    refused(result);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect((await run()).status).toBe('prepared');
  }
);
test.each([
  'capsule',
  'bindingDigest',
  'selector',
  'projection',
  'intent',
  'provedTransaction',
  'archive',
  'archive-anchor',
])('stable capture drift %s refuses display revalidation', async (field) => {
  if (field === 'archive-anchor') {
    mock.capture.record.archivedAt = 1;
    mock.capture.record.finalized = { blockHash: hex(30), blockNumber: 1 };
  }
  const result = await run();
  expect(result.status).toBe('prepared');
  if (field === 'archive') mock.capture.record.archivedAt = 1;
  else if (field === 'archive-anchor') mock.capture.record.finalized.blockHash = hex(31);
  else if (field === 'bindingDigest') mock.capture.bindingDigest = hex(44);
  else if (field === 'selector') mock.capture.selector.position++;
  else if (field === 'capsule') mock.capture.capsule.createdAt++;
  else mock.capture[field] = { changed: true };
  refused(await recheck(result));
  expect(result.signal.aborted).toBe(true);
  await result.closed;
});
test('routine journal revision and confirmations refresh preserves original summary', async () => {
  const result = await run();
  expect(result.status).toBe('prepared');
  mock.capture.record.revision = (mock.capture.record.revision || 0) + 1;
  mock.capture.record.confirmations = 100;
  expect((await recheck(result)).summary).toBe(result.summary);
  expect(result.signal.aborted).toBe(false);
});
test.each(['revision', 'payload', 'inputSha256', 'selector', 'bindingDigest', 'state'])(
  'exact stored entry drift %s revokes original plan',
  async (field) => {
    const result = await run();
    expect(result.status).toBe('prepared');
    if (field === 'revision') mock.entry.revision++;
    if (field === 'payload') {
      mock.entry.payload = copy(mock.entry.payload);
      mock.entry.payload.txidMerkleroot = hex(999);
      mock.entry.payloadSha256 = sha(mock.entry.payload);
    }
    if (field === 'inputSha256' || field === 'bindingDigest') mock.entry[field] = hex(999);
    if (field === 'selector') mock.entry.selector.position++;
    if (field === 'state') mock.entry.state = 'attempted';
    refused(await recheck(result));
    expect(result.signal.aborted).toBe(true);
  }
);
test.each([2, 3])('entry revision change on internal read %i refuses preparation', async (nth) => {
  mock.read.mockImplementation(async (count) => {
    if (count === nth) mock.entry.revision++;
    return freeze(copy(mock.entry));
  });
  refused(await run());
  expect(mock.read.mock.calls.length).toBeGreaterThanOrEqual(nth);
});
test('entry changes after outer recovery settles refuse preparation', async () => {
  mock.recoveryPost.mockImplementation(async () => {
    mock.entry.revision++;
  });
  refused(await run());
});

test.each(['identityAbort', 'enrollmentAbort', 'coordinatorAbort', 'storeAbort', 'caller'])(
  'idle %s revokes plan immediately and clears its timer',
  async (which) => {
    const result = await run();
    expect(result.status).toBe('prepared');
    mock[which].abort();
    expect(result.signal.aborted).toBe(true);
    await result.closed;
    refused(await recheck(result));
    expect(jest.getTimerCount()).toBe(0);
  }
);
test.each(['descriptor', 'policy-replacement', 'policy-mutation', 'public-generation'])(
  'mutated owner %s refuses revalidation from detached baseline',
  async (which) => {
    const result = await run();
    expect(result.status).toBe('prepared');
    if (which === 'descriptor') {
      mock.identity.descriptor.accountIndex++;
      mock.enrollment.descriptor.accountIndex++;
    }
    if (which === 'policy-replacement') mock.policy = copy(mock.policy);
    if (which === 'policy-mutation') mock.policy.fingerprint = 'PRIVATE_CHANGED';
    if (which === 'public-generation') mock.publicIdentity.generationId = hex(99);
    refused(await recheck(result));
    expect(result.signal.aborted).toBe(true);
  }
);
test.each(['descriptor', 'policy', 'public-generation'])(
  'in-place %s mutation during initial storage await refuses preparation',
  async (which) => {
    const gate = deferred();
    mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
      await gate.promise;
      return mock.store;
    });
    const pending = run();
    await until(() => mock.enrollment.openPoiIntents.mock.calls.length === 1);
    if (which === 'descriptor') {
      mock.identity.descriptor.accountIndex++;
      mock.enrollment.descriptor.accountIndex++;
    }
    if (which === 'policy') mock.policy.fingerprint = 'PRIVATE_CHANGED';
    if (which === 'public-generation') mock.publicIdentity.generationId = hex(999);
    gate.resolve();
    refused(await pending);
  }
);
test.each(['open', 'read', 'reattest', 'post'])(
  'prepare cancellation at ignored %s retains directory owner until drain',
  async (point) => {
    const gate = deferred(),
      entered = deferred();
    if (point === 'open')
      mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return mock.store;
      });
    if (point === 'read')
      mock.read.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return freeze(copy(mock.entry));
      });
    if (point === 'reattest')
      mock.reattest.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return copy(mock.capture);
      });
    if (point === 'post')
      mock.recoveryPost.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });
    let settled = false;
    const pending = run().finally(() => {
      settled = true;
    });
    await entered.promise;
    mock.caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'busy' });
    gate.resolve();
    refused(await pending);
    expect((await run(freshOptions())).status).toBe('prepared');
  }
);
test.each(['open', 'read', 'reattest', 'post'])(
  'plan close during ignored revalidation %s aborts immediately but closed waits',
  async (point) => {
    const result = await run();
    expect(result.status).toBe('prepared');
    const gate = deferred(),
      entered = deferred();
    if (point === 'open')
      mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return mock.store;
      });
    if (point === 'read')
      mock.read.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return freeze(copy(mock.entry));
      });
    if (point === 'reattest')
      mock.reattest.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return copy(mock.capture);
      });
    if (point === 'post')
      mock.recoveryPost.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });
    const pending = recheck(result);
    await entered.promise;
    let closed = false;
    result.closed.then(() => {
      closed = true;
    });
    result.close();
    expect(result.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'busy' });
    gate.resolve();
    refused(await pending);
    await result.closed;
    expect(closed).toBe(true);
    expect((await run()).status).toBe('prepared');
  }
);
test('healthy overlapping revalidation refuses busy without revoking admitted call', async () => {
  const result = await run();
  const gate = deferred();
  mock.reattest.mockImplementationOnce(async () => {
    await gate.promise;
    return copy(mock.capture);
  });
  const pending = recheck(result);
  await until(() => mock.reattest.mock.calls.length >= 3);
  expect(await recheck(result)).toEqual({ status: 'refused', stage: 'busy' });
  expect(result.signal.aborted).toBe(false);
  expect(await run()).toEqual({ status: 'refused', stage: 'busy' });
  expect(result.signal.aborted).toBe(false);
  gate.resolve();
  expect((await pending).summary).toBe(result.summary);
  expect((await recheck(result)).summary).toBe(result.summary);
});
test.each(['pre-aborted', 'later-aborted'])(
  'recognized revalidation %s caller revokes plan',
  async (mode) => {
    const result = await run(),
      caller = new AbortController(),
      gate = deferred();
    if (mode === 'pre-aborted') caller.abort();
    else
      mock.reattest.mockImplementationOnce(async () => {
        await gate.promise;
        return copy(mock.capture);
      });
    const pending = recheck(result, { signal: caller.signal });
    if (mode === 'later-aborted') {
      await until(() => mock.reattest.mock.calls.length >= 3);
      caller.abort();
      expect(result.signal.aborted).toBe(true);
      gate.resolve();
    }
    refused(await pending);
    expect(result.signal.aborted).toBe(true);
  }
);
test.each(['summary', 'copy', 'empty', 'old'])(
  'forged or obsolete %s handle cannot harm current plan',
  async (kind) => {
    const first = await run(),
      current = kind === 'old' ? await run() : first;
    const forged =
      kind === 'summary'
        ? current.summary
        : kind === 'copy'
          ? copy(current.plan)
          : kind === 'old'
            ? first.plan
            : Object.freeze({});
    refused(await recheck(current, { plan: forged }));
    expect(current.signal.aborted).toBe(false);
    expect((await recheck(current)).summary).toBe(current.summary);
  }
);
test.each(['identity', 'enrollment', 'coordinator'])(
  'wrong %s on recognized plan revokes it',
  async (field) => {
    const result = await run();
    refused(await recheck(result, { [field]: { ...options[field] } }));
    expect(result.signal.aborted).toBe(true);
  }
);
test.each(['timeoutMs', 'archive', 'approved', 'payload'])(
  'revalidation rejects extra %s and does not expose authority',
  async (field) => {
    const result = await run();
    refused(await recheck(result, { [field]: field === 'timeoutMs' ? 15000 : true }));
  }
);
test('successful replacement supersedes prior idle plan while failed candidates preserve it', async () => {
  const first = await run();
  expect(first.status).toBe('prepared');
  mock.enrollment.openPoiIntents.mockRejectedValueOnce(Error('PRIVATE failure'));
  refused(await run());
  expect(first.signal.aborted).toBe(false);
  expect((await recheck(first)).summary).toBe(first.summary);
  refused(await run({ ...options, approved: true }));
  expect(first.signal.aborted).toBe(false);
  const second = await run();
  expect(second.status).toBe('prepared');
  expect(first.signal.aborted).toBe(true);
  await first.closed;
  expect(second.signal.aborted).toBe(false);
  first.close();
  refused(await recheck(first));
  expect((await recheck(second)).summary).toBe(second.summary);
  expect(jest.getTimerCount()).toBe(1);
});
test('successful different-capsule preparation replaces same directory plan', async () => {
  const first = await run();
  configure(true);
  const second = await run();
  expect(second.status).toBe('prepared');
  expect(second.summary.operation).toBe('unshield');
  expect(first.signal.aborted).toBe(true);
  first.close();
  expect((await recheck(second)).summary).toBe(second.summary);
});
test('old abort listener cannot reenter during replacement to evict its successor', async () => {
  const first = await run();
  let reentered;
  first.signal.addEventListener(
    'abort',
    () => {
      first.close();
      reentered = run();
    },
    { once: true }
  );
  const second = await run();
  expect(second.status).toBe('prepared');
  expect(await reentered).toEqual({ status: 'refused', stage: 'busy' });
  expect(second.signal.aborted).toBe(false);
  expect((await recheck(second)).summary).toBe(second.summary);
});
test('old abort listener cancellation of replacement prevents reporting prepared success', async () => {
  const first = await run(),
    caller = new AbortController();
  first.signal.addEventListener('abort', () => caller.abort(), { once: true });
  refused(await run({ ...options, signal: caller.signal }));
  expect(first.signal.aborted).toBe(true);
  expect((await run()).status).toBe('prepared');
});
test('idle old-plan close cannot release an in-flight replacement owner', async () => {
  const first = await run(),
    gate = deferred();
  mock.read.mockImplementationOnce(async () => {
    await gate.promise;
    return freeze(copy(mock.entry));
  });
  const pending = run();
  await until(() => mock.read.mock.calls.length >= 4);
  first.close();
  expect(await run()).toEqual({ status: 'refused', stage: 'busy' });
  gate.resolve();
  const second = await pending;
  expect(second.status).toBe('prepared');
  expect((await recheck(second)).summary).toBe(second.summary);
});
test('repeated idle replacement keeps only one expiry timer and no account phase', async () => {
  for (let n = 0; n < 8; n++) {
    const current = await run();
    expect(current.status).toBe('prepared');
    expect(jest.getTimerCount()).toBe(1);
    idle();
  }
  expect(plans.filter((plan) => !plan.signal.aborted)).toHaveLength(1);
  plans.at(-1).close();
  expect(jest.getTimerCount()).toBe(0);
});

test('preparation latency consumes original display TTL and successful revalidation never renews it', async () => {
  const gate = deferred();
  mock.read.mockImplementationOnce(async () => {
    await gate.promise;
    return freeze(copy(mock.entry));
  });
  const pending = run();
  await until(() => mock.read.mock.calls.length === 1);
  await jest.advanceTimersByTimeAsync(10000);
  gate.resolve();
  const result = await pending;
  expect(result.status).toBe('prepared');
  await jest.advanceTimersByTimeAsync(100000);
  expect(result.signal.aborted).toBe(false);
  expect((await recheck(result)).summary).toBe(result.summary);
  expect(withRailgunOwnOperationRecovery.mock.calls.at(-1)[0].timeoutMs).toBe(10000);
  await jest.advanceTimersByTimeAsync(9999);
  expect(result.signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(result.signal.aborted).toBe(true);
  await result.closed;
});
test.each([undefined, 45000])(
  'preparation budget %s expires strictly and does not release ignored work',
  async (timeoutMs) => {
    const gate = deferred();
    mock.read.mockImplementationOnce(async () => {
      await gate.promise;
      return freeze(copy(mock.entry));
    });
    const pending = run(timeoutMs === undefined ? options : { ...options, timeoutMs });
    await until(() => mock.read.mock.calls.length === 1);
    await jest.advanceTimersByTimeAsync(timeoutMs ?? 15000);
    expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'busy' });
    gate.resolve();
    refused(await pending);
    expect((await run()).status).toBe('prepared');
  }
);
test.each([0, 110000])(
  'revalidation budget respects 15s cap and remaining TTL at %i',
  async (elapsed) => {
    const result = await run();
    await jest.advanceTimersByTimeAsync(elapsed);
    const gate = deferred(),
      entered = deferred();
    mock.reattest.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return copy(mock.capture);
    });
    const pending = recheck(result);
    await entered.promise;
    const budget = Math.min(15000, 120000 - elapsed);
    expect(withRailgunOwnOperationRecovery.mock.calls.at(-1)[0].timeoutMs).toBe(budget);
    await jest.advanceTimersByTimeAsync(budget);
    expect(result.signal.aborted).toBe(true);
    expect(await run()).toEqual({ status: 'refused', stage: 'busy' });
    gate.resolve();
    refused(await pending);
    await result.closed;
  }
);
test.each(['expiry', 'regression'])(
  'lazy monotonic %s check refuses even without timer dispatch',
  async (mode) => {
    let now = 100;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const result = await run();
    expect(result.status).toBe('prepared');
    now = mode === 'expiry' ? 120100 : 99;
    refused(await recheck(result));
    expect(result.signal.aborted).toBe(true);
  }
);
test('preparation deadline equality is caught without its timeout callback', async () => {
  let now = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mock.read.mockImplementationOnce(async () => {
    now = 15000;
    return freeze(copy(mock.entry));
  });
  refused(await run());
  expect(plans).toHaveLength(0);
});
test.each([false, true])(
  'old plan expiry during %s replacement does not release pending owner',
  async (fail) => {
    const first = await run();
    await jest.advanceTimersByTimeAsync(119000);
    const gate = deferred(),
      entered = deferred();
    mock.read.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      if (fail) throw Error('PRIVATE');
      return freeze(copy(mock.entry));
    });
    const pending = run();
    await entered.promise;
    await jest.advanceTimersByTimeAsync(1000);
    expect(first.signal.aborted).toBe(true);
    await first.closed;
    expect(await run()).toEqual({ status: 'refused', stage: 'busy' });
    gate.resolve();
    const second = await pending;
    if (fail) {
      refused(second);
      expect((await run()).status).toBe('prepared');
    } else {
      expect(second.status).toBe('prepared');
      expect((await recheck(second)).summary).toBe(second.summary);
    }
  }
);
test('mutable caller options are snapshotted before the first await', async () => {
  const input = { ...options },
    gate = deferred();
  mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
    await gate.promise;
    return mock.store;
  });
  const pending = run(input);
  input.capsuleDigest = hex(999);
  input.timeoutMs = 1;
  input.coordinator = {};
  input.signal = new AbortController().signal;
  gate.resolve();
  const result = await pending;
  expect(result.status).toBe('prepared');
  expect(result.summary).toEqual(summaryFor());
});
test('accessor options are refused without invoking the accessor', async () => {
  const read = jest.fn(() => mock.identity),
    input = { ...options };
  Object.defineProperty(input, 'identity', { get: read });
  refused(await run(input));
  expect(read).not.toHaveBeenCalled();
  expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
});
test('mutable retained entry returned by storage cannot mutate the private snapshot', async () => {
  mock.read.mockImplementation(async () => mock.entry);
  const result = await run();
  expect(result.status).toBe('prepared');
  mock.entry.revision++;
  refused(await recheck(result));
  expect(result.signal.aborted).toBe(true);
});
test('explicit strict reattestation rejects a late archival anchor drift', async () => {
  mock.capture.record.archivedAt = 1;
  mock.capture.record.finalized = { blockHash: hex(30), blockNumber: 1 };
  mock.reattest
    .mockImplementationOnce(async () => copy(mock.capture))
    .mockImplementationOnce(async () => {
      mock.capture.record.finalized.blockHash = hex(31);
      return copy(mock.capture);
    });
  refused(await run());
});
test('general outer recovery post-check does not expose a strict capture; later revalidation detects its drift', async () => {
  mock.recoveryPost.mockImplementationOnce(async () => {
    mock.capture.record.archivedAt = 1;
    mock.capture.record.finalized = { blockHash: hex(30), blockNumber: 1 };
  });
  const result = await run();
  expect(result.status).toBe('prepared');
  refused(await recheck(result));
  expect(result.signal.aborted).toBe(true);
});

const sharedListenerCounts = () => {
  const { getEventListeners } = require('events');
  return [
    mock.caller.signal,
    mock.identityAbort.signal,
    mock.enrollmentAbort.signal,
    mock.coordinatorAbort.signal,
    mock.storeAbort.signal,
  ].map((signal) => getEventListeners(signal, 'abort').length);
};
test('explicit close restores shared owner and store abort listeners to their baseline', async () => {
  const before = sharedListenerCounts(),
    result = await run();
  expect(result.status).toBe('prepared');
  expect(sharedListenerCounts()).toEqual(before.map((count) => count + 1));
  expect((await recheck(result)).status).toBe('current');
  expect(sharedListenerCounts()).toEqual(before.map((count) => count + 1));
  result.close();
  await result.closed;
  expect(sharedListenerCounts()).toEqual(before);
});
test('failed preparation restores shared listener counts before and after an existing plan', async () => {
  const before = sharedListenerCounts();
  mock.reattest.mockRejectedValueOnce(Error('PRIVATE failure'));
  refused(await run());
  expect(sharedListenerCounts()).toEqual(before);
  const first = await run(),
    liveCounts = sharedListenerCounts();
  expect(first.status).toBe('prepared');
  mock.reattest.mockRejectedValueOnce(Error('PRIVATE replacement failure'));
  refused(await run());
  expect(first.signal.aborted).toBe(false);
  expect(sharedListenerCounts()).toEqual(liveCounts);
  first.close();
  await first.closed;
  expect(sharedListenerCounts()).toEqual(before);
});
test('repeated successful replacement removes old shared listeners without accumulating them', async () => {
  const before = sharedListenerCounts();
  let current = await run();
  expect(current.status).toBe('prepared');
  const liveCounts = sharedListenerCounts();
  for (let index = 0; index < 4; index++) {
    const previous = current;
    current = await run();
    expect(current.status).toBe('prepared');
    expect(previous.signal.aborted).toBe(true);
    await previous.closed;
    expect(sharedListenerCounts()).toEqual(liveCounts);
    previous.close();
    expect(sharedListenerCounts()).toEqual(liveCounts);
  }
  current.close();
  await current.closed;
  expect(sharedListenerCounts()).toEqual(before);
});
test('old plan revalidation is busy during healthy replacement without disturbing either operation', async () => {
  const first = await run(),
    gate = deferred(),
    entered = deferred();
  mock.read.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return freeze(copy(mock.entry));
  });
  const pending = run();
  await entered.promise;
  expect(await recheck(first)).toEqual({ status: 'refused', stage: 'busy' });
  expect(first.signal.aborted).toBe(false);
  gate.resolve();
  const second = await pending;
  expect(second.status).toBe('prepared');
  expect(first.signal.aborted).toBe(true);
  expect((await recheck(second)).summary).toBe(second.summary);
});
test('explicit undefined preparation timeout keeps the default 15-second budget', async () => {
  const result = await run({ ...options, timeoutMs: undefined });
  expect(result.status).toBe('prepared');
  expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(15000);
});
test('replacement using old wrapper signal cancels the successor and does not restore old plan', async () => {
  const before = sharedListenerCounts(),
    first = await run();
  expect(first.status).toBe('prepared');
  refused(await run({ ...options, signal: first.signal }));
  expect(first.signal.aborted).toBe(true);
  await first.closed;
  refused(await recheck(first));
  expect(sharedListenerCounts()).toEqual(before);
  expect(jest.getTimerCount()).toBe(0);
  const fresh = await run();
  expect(fresh.status).toBe('prepared');
  expect((await recheck(fresh)).summary).toBe(fresh.summary);
});

const claimOptions = (changes = {}) => ({
  identity: mock.identity,
  enrollment: mock.enrollment,
  coordinator: mock.coordinator,
  signal: mock.caller.signal,
  ...changes,
});
const claimed = (changes = {}) => {
  const claim = claimAttempted(claimOptions(changes));
  claims.push(claim);
  return claim;
};
const CLAIM_REFUSED = {
  code: 'RAILGUN_POI_DISCLOSURE_PLAN_REFUSED',
  message: 'Railgun POI disclosure plan unavailable',
};
describe('attempted output synchronous directory claim', () => {
  test('exact frozen return offers exclusion only and opens no store or recovery phase', () => {
    const claim = claimed();
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.keys(claim).sort()).toEqual(['assertCurrent', 'release']);
    expect(claim.assertCurrent()).toBeUndefined();
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    idle();
    expect(claim.release()).toBeUndefined();
    expect(claim.release()).toBeUndefined();
    expect(() => claim.assertCurrent()).toThrow(expect.objectContaining(CLAIM_REFUSED));
  });
  test.each([undefined, null, [], false, 1, 'private'])(
    'malformed %p claim is sanitized without touching a healthy claim',
    (value) => {
      const claim = claimed();
      expect(() => claimAttempted(value)).toThrow(expect.objectContaining(CLAIM_REFUSED));
      expect(claim.assertCurrent()).toBeUndefined();
      expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    }
  );
  test.each(['identity', 'enrollment', 'coordinator', 'signal', 'extra', 'accessor'])(
    'invalid %s field cannot replace or release the existing owner',
    (kind) => {
      const claim = claimed();
      const args = claimOptions();
      const getter = jest.fn(() => mock.identity);
      if (kind === 'extra') args.directory = mock.enrollment.directory;
      else if (kind === 'accessor') Object.defineProperty(args, 'identity', { get: getter });
      else args[kind] = {};
      expect(() => claimAttempted(args)).toThrow(expect.objectContaining(CLAIM_REFUSED));
      expect(getter).not.toHaveBeenCalled();
      expect(claim.assertCurrent()).toBeUndefined();
      expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    }
  );
  test('preaborted signal cannot revoke an unrelated idle plan', async () => {
    const plan = await run();
    const caller = new AbortController();
    caller.abort();
    expect(() => claimed({ signal: caller.signal })).toThrow(
      expect.objectContaining(CLAIM_REFUSED)
    );
    expect(plan.signal.aborted).toBe(false);
    expect((await recheck(plan)).status).toBe('current');
  });
  test('healthy claim excludes plan prepare/revalidate while preserving an idle plan', async () => {
    const plan = await run();
    const claim = claimed();
    const count = mock.enrollment.openPoiIntents.mock.calls.length;
    expect((await run()).stage).toBe('busy');
    expect((await recheck(plan)).stage).toBe('busy');
    expect(plan.signal.aborted).toBe(false);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(count);
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
    expect(claim.assertCurrent()).toBeUndefined();
    claim.release();
    expect((await recheck(plan)).status).toBe('current');
  });
  test.each(['prepare', 'revalidate'])(
    'pending %s owner rejects a claim without disturbing its borrowed work',
    async (kind) => {
      const plan = kind === 'revalidate' ? await run() : undefined;
      const gate = deferred();
      mock.recoveryStart.mockImplementationOnce(async () => {
        await gate.promise;
      });
      const baseline = mock.recoveryStart.mock.calls.length;
      const pending = kind === 'prepare' ? run() : recheck(plan);
      await until(() => mock.recoveryStart.mock.calls.length > baseline);
      expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
      if (plan) expect(plan.signal.aborted).toBe(false);
      gate.resolve();
      expect((await pending).status).toBe(kind === 'prepare' ? 'prepared' : 'current');
      expect(claimed().assertCurrent()).toBeUndefined();
    }
  );
  test.each([
    'caller',
    'identity',
    'enrollment',
    'coordinator',
    'directory',
    'descriptor',
    'policy',
    'generation',
  ])(
    '%s invalidation makes assertion stale but never automatically releases exclusion',
    async (kind) => {
      const signal = new AbortController();
      const claim = claimed({ signal: signal.signal });
      const before = {
        directory: mock.enrollment.directory,
        descriptor: copy(mock.identity.descriptor),
        policy: mock.policy,
        publicIdentity: copy(mock.publicIdentity),
      };
      if (kind === 'caller') signal.abort();
      if (kind === 'identity') mock.identityCurrent = false;
      if (kind === 'enrollment') mock.enrollmentAbort.abort();
      if (kind === 'coordinator') mock.coordinatorAbort.abort();
      if (kind === 'directory') mock.enrollment.directory += '-changed';
      if (kind === 'descriptor') mock.identity.descriptor.accountIndex++;
      if (kind === 'policy') mock.policy = { ...mock.policy, version: 2 };
      if (kind === 'generation') mock.publicIdentity.generationId = hex(999);
      expect(() => claim.assertCurrent()).toThrow(expect.objectContaining(CLAIM_REFUSED));
      if (!['enrollment', 'coordinator'].includes(kind)) {
        mock.identityCurrent = true;
        mock.enrollment.directory = before.directory;
        mock.identity.descriptor = before.descriptor;
        mock.policy = before.policy;
        mock.publicIdentity = before.publicIdentity;
        expect(() => claimed({ signal: new AbortController().signal })).toThrow(
          expect.objectContaining(CLAIM_REFUSED)
        );
        claim.release();
        expect(claimed({ signal: new AbortController().signal }).assertCurrent()).toBeUndefined();
      }
    }
  );
  test('release is idempotent, invokes no abort callbacks, and cannot remove a successor', () => {
    const signal = new AbortController();
    const listener = jest.fn();
    signal.signal.addEventListener('abort', listener);
    const first = claimed({ signal: signal.signal });
    first.release();
    const second = claimed();
    first.release();
    signal.abort();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(second.assertCurrent()).toBeUndefined();
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
  });
  test('closing and expiring unrelated plans cannot unlock a live diagnostic token', async () => {
    const plan = await run();
    const claim = claimed({ signal: new AbortController().signal });
    plan.close();
    await plan.closed;
    await jest.advanceTimersByTimeAsync(120001);
    expect(claim.assertCurrent()).toBeUndefined();
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
    claim.release();
    expect((await run()).status).toBe('prepared');
  });
  test('nested synchronous owner admission cannot be overwritten by outer validation', () => {
    const identity = require('./railgun-identity').assertRailgunIdentity;
    const original = identity.getMockImplementation();
    let inner;
    identity.mockImplementationOnce((...args) => {
      inner = claimed();
      return original(...args);
    });
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
    expect(inner.assertCurrent()).toBeUndefined();
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
    inner.release();
    expect(claimed().assertCurrent()).toBeUndefined();
  });
  test('reentrant release and successor during assertion cannot rescue the stale claim', () => {
    const first = claimed();
    const identity = require('./railgun-identity').assertRailgunIdentity;
    const original = identity.getMockImplementation();
    let successor;
    identity.mockImplementationOnce((...args) => {
      first.release();
      successor = claimed();
      return original(...args);
    });
    expect(() => first.assertCurrent()).toThrow(expect.objectContaining(CLAIM_REFUSED));
    first.release();
    expect(successor.assertCurrent()).toBeUndefined();
    expect(() => claimed()).toThrow(expect.objectContaining(CLAIM_REFUSED));
  });
  test('exact same-directory enrollment aliases still share exclusion', () => {
    const first = claimed();
    const alias = { ...mock.enrollment };
    mock.enrollments.add(alias);
    expect(() => claimed({ enrollment: alias })).toThrow(expect.objectContaining(CLAIM_REFUSED));
    expect(first.assertCurrent()).toBeUndefined();
    first.release();
    expect(claimed({ enrollment: alias }).assertCurrent()).toBeUndefined();
  });
});

test.each(['output-first', 'plan-first'])(
  'cold module import order %s has no eager reverse dependency or authority work',
  (order) => {
    const forbidden = [
      './railgun-poi-cold-validation',
      './railgun-own-receipt',
      '../networks/wallet-tor-transport',
    ].map((name) => require.resolve(name));
    jest.isolateModules(() => {
      let output, plan;
      if (order === 'output-first') {
        output = require('./railgun-poi-output-recovery');
        expect(require.cache[require.resolve('./railgun-poi-disclosure-plan')]).toBeUndefined();
        plan = require('./railgun-poi-disclosure-plan');
      } else {
        plan = require('./railgun-poi-disclosure-plan');
        expect(require.cache[require.resolve('./railgun-poi-output-recovery')]).toBeUndefined();
        output = require('./railgun-poi-output-recovery');
      }
      expect(typeof plan.claimRailgunAttemptedPoiOutput).toBe('function');
      expect(typeof output.recoverRailgunAttemptedPoiOutput).toBe('function');
      for (const file of forbidden) expect(require.cache[file]).toBeUndefined();
    });
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  }
);

describe('foreign full-value transfer disclosure', () => {
  test("adds the explicit link between the other account's blinded output and this spend", async () => {
    configure(false);
    const capsule = mock.capture.capsule;
    capsule.selection.recipient = '0zk1' + 'p'.repeat(123);
    capsule.preparation.recipient = '0zk1' + 'p'.repeat(123);
    capsule.selection.recipientRelationship = 'foreign';
    mock.capture.capsuleDigest = digestRailgunPrivateCapsule(capsule);
    mock.entry.capsuleDigest = mock.capture.capsuleDigest;
    options.capsuleDigest = mock.capture.capsuleDigest;
    const result = await run();
    expect(result.status).toBe('prepared');
    const { recipientRelationship, disclosureExplanation, ...rest } = result.summary;
    expect(rest).toEqual(summaryFor());
    expect(recipientRelationship).toBe('foreign');
    expect(disclosureExplanation).toBe(
      "Submitting this proof links the other account's blinded output commitment to your spend at the POI aggregator."
    );
    expect(Object.keys(result.summary).indexOf('recipientRelationship')).toBe(
      Object.keys(result.summary).indexOf('unshieldIdCategory') + 1
    );
    expect(JSON.stringify(result.summary)).not.toContain('0zk1');
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect((await recheck(result)).status).toBe('current');
  });
  test('self-transfer summary bytes stay exactly unchanged', async () => {
    configure(false);
    const result = await run();
    expect(JSON.stringify(result.summary)).toBe(JSON.stringify(summaryFor()));
  });
});
describe('partial unshield disclosure', () => {
  test('derives both disclosures and explicit change-to-public-unshield linkage from genuine plan capture', async () => {
    configure('partial');
    const result = await run();
    expect(result.status).toBe('prepared');
    expect(result.summary).toMatchObject({
      version: 1,
      operation: 'partial-unshield',
      outputCount: 1,
      unshieldIdCategory: 'railgun-txid',
      consentGranted: false,
      transportAuthorized: false,
    });
    expect(result.summary.disclosureCategories).toEqual([
      ...summaryFor().disclosureCategories,
      'unshield-railgun-txid',
    ]);
    expect(result.summary.disclosureExplanation).toBe(
      'Submitting this proof links your blinded change output to the public unshield transaction, including its recipient address and amount, at the POI aggregator.'
    );
    expect(Object.isFrozen(result.summary)).toBe(true);
    expect(JSON.stringify(result.summary)).not.toContain(mock.capture.submitter);
    expect(JSON.stringify(result.summary)).not.toContain(
      mock.entry.payload.railgunTxidIfHasUnshield
    );
    expect((await recheck(result)).status).toBe('current');
  });
  test.each(['marker', 'count', 'version'])(
    'partial %s mismatch refuses without granting a plan',
    async (fault) => {
      configure('partial');
      if (fault === 'version') mock.capture.capsule.version = 1;
      else {
        mock.entry.payload = normalizeRailgunPoiPayload({
          ...mock.entry.payload,
          ...(fault === 'marker'
            ? { railgunTxidIfHasUnshield: '0x00' }
            : { blindedCommitmentsOut: [] }),
        });
        mock.entry.payloadSha256 = sha(mock.entry.payload);
      }
      refused(await run());
    }
  );
});
