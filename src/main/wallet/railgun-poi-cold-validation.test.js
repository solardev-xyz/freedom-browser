// Authority boundaries are mocked; payload/capsule normalization, capture
// comparison, privacy contexts and the directory-owned account phase are real.
// These controller tests do not establish cryptographic proof validity.
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => mock.enrollments.has(value),
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: jest.fn((identity, handle) => {
    const { getPrivacyContext } = require('../networks/privacy-context');
    const context = getPrivacyContext(handle);
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
    return JSON.parse(JSON.stringify(identity.descriptor));
  }),
  withRailgunViewingCredential: jest.fn(() => {
    throw Error('unexpected direct key access');
  }),
}));
jest.mock('./railgun-public-policy', () => ({
  getRailgunPublicPolicy: (archive) => {
    if (archive !== '/fixture-engine.asar') throw Error('policy');
    return 'fixture-policy';
  },
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: jest.fn((coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      !mock.enrollments.has(enrollment) ||
      coordinator.signal.aborted ||
      !mock.publicCurrent ||
      policy !== 'fixture-policy'
    )
      throw Error('PRIVATE public identity diagnostic');
    return JSON.parse(JSON.stringify(mock.publicIdentity));
  }),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((archive) => {
    if (archive !== '/fixture-engine.asar') throw Error('engine runtime');
    return archive;
  }),
}));
jest.mock('./railgun-prover-runtime', () => ({
  verifyRailgunProverRuntime: jest.fn((archive) => {
    if (archive !== '/fixture-prover.asar') throw Error('prover runtime');
    return archive;
  }),
}));
jest.mock('./railgun-poi-output-recovery', () => ({
  recoverRailgunPoiOutput: jest.fn((options) => mock.output(options)),
}));
jest.mock('./railgun-poi-verifier', () => ({
  verifyRailgunPoiPayload: jest.fn((options) => mock.verify(options)),
}));
jest.mock('./railgun-own-operation', () => ({
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
      mock.events.push('final-open');
      await mock.recoveryStart();
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
      mock.events.push('final-close');
    }
  }),
}));
// Sentinels: the composition delegates existing output preflight and keyless
// verification. It must not add proof-specific roots, proving, sending or keys.
jest.mock('./railgun-poi-root', () => ({
  createRailgunPoiRootSource: jest.fn(() => {
    throw Error('unexpected root query');
  }),
  createRailgunPoiTxidRootSource: jest.fn(() => {
    throw Error('unexpected proof TXID root query');
  }),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn(() => {
    throw Error('unexpected direct utility');
  }),
}));
jest.mock('./railgun-own-poi-proof', () => ({
  proveRailgunOwnPoi: jest.fn(() => {
    throw Error('unexpected proof generation');
  }),
  assertRailgunOwnPoiProof: jest.fn(() => {
    throw Error('raw history restoration');
  }),
}));
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { recoverRailgunPoiOutput } = require('./railgun-poi-output-recovery');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { validateRailgunRetainedPoi } = require('./railgun-poi-cold-validation');
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
let options, gates, operations;
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
  const work = validateRailgunRetainedPoi(input);
  operations.push(work);
  return work;
};
const freshOptions = () => ({ ...options, signal: new AbortController().signal });
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
  mock.outputResult = {
    status: 'matched',
    capsuleDigest: mock.entry.capsuleDigest,
    revision: 1,
    payloadSha256: mock.entry.payloadSha256,
    outputMatched: true,
    viewingKeyReleases: unshield ? 0 : 1,
    viewingUtilityExitObserved: !unshield,
    proofVerified: false,
    originalInputReconstructed: false,
    originalRootsAccepted: false,
    membershipAuthenticated: false,
    sourceAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  };
  mock.verified = {
    payloadSha256: mock.entry.payloadSha256,
    proofVerified: true,
    independentlyVerified: true,
    utilityExitObserved: true,
    sourceAuthenticated: false,
    membershipAuthenticated: false,
    rootAccepted: false,
    metadataAuthenticated: false,
    ownershipAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  gates = [];
  operations = [];
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
    publicIdentity: { generationId: hex(1), sourceId: hex(2), publicId: hex(3) },
  };
  mock.scope = createPrivacyScope({
    profileId: 'poi-cold-validation-unit',
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
    close: jest.fn(() => {
      throw Error('unexpected caller-owned store closure');
    }),
  };
  mock.enrollment = {
    directory: '/synthetic-cold-validation-account',
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
    archive: '/fixture-engine.asar',
    proverArchive: '/fixture-prover.asar',
    artifactDirectory: '/fixture-artifacts',
    capsuleDigest: hex(1),
    signal: mock.caller.signal,
  };
  configure();
  mock.output = jest.fn(async () => {
    mock.events.push('output');
    return copy(mock.outputResult);
  });
  mock.verify = jest.fn(async ({ handle }) => {
    expect(getPrivacyContext(handle).subject).toMatchObject({
      role: 'prover',
      operation: 'poi-verify',
    });
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
    mock.events.push('verify');
    return copy(mock.verified);
  });
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.recoveryStart = jest.fn(async () => {});
  mock.recoveryPost = jest.fn(async () => {});
});
afterEach(async () => {
  mock.caller.abort();
  for (const gate of gates) gate.resolve();
  await Promise.allSettled(operations);
  expect(mock.store.prepare).not.toHaveBeenCalled();
  expect(mock.store.close).not.toHaveBeenCalled();
  expect(require('./railgun-poi-root').createRailgunPoiRootSource).not.toHaveBeenCalled();
  expect(require('./railgun-poi-root').createRailgunPoiTxidRootSource).not.toHaveBeenCalled();
  expect(require('./railgun-process').startRailgunProcess).not.toHaveBeenCalled();
  expect(require('./railgun-own-poi-proof').proveRailgunOwnPoi).not.toHaveBeenCalled();
  expect(require('./railgun-own-poi-proof').assertRailgunOwnPoiProof).not.toHaveBeenCalled();
  expect(require('./railgun-identity').withRailgunViewingCredential).not.toHaveBeenCalled();
  mock.scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test.each([false, true])(
  'validates exact retained %s payload with diagnostic-only flags',
  async (unshield) => {
    configure(unshield);
    const result = await run();
    expect(result).toEqual({
      status: 'validated',
      capsuleDigest: mock.entry.capsuleDigest,
      revision: 1,
      payloadSha256: mock.entry.payloadSha256,
      outputMatched: true,
      proofVerified: true,
      independentlyVerified: true,
      verifierExitObserved: true,
      viewingKeyReleases: unshield ? 0 : 1,
      viewingUtilityExitObserved: !unshield,
      rootAccepted: false,
      originalInputReconstructed: false,
      originalRootsAccepted: false,
      originalTxidRootCanonical: false,
      currentNoteEligibility: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(require('./railgun-poi-cold-validation'))).toEqual([
      'validateRailgunRetainedPoi',
    ]);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
    expect(mock.store.get).toHaveBeenCalledTimes(5);
    expect(mock.events).toEqual([
      'read',
      'output',
      'read',
      'verify',
      'read',
      'final-open',
      'read',
      'final-close',
      'read',
    ]);
    expect(mock.output).toHaveBeenCalledTimes(1);
    expect(mock.verify).toHaveBeenCalledTimes(1);
    const supplied = verifyRailgunPoiPayload.mock.calls[0][0];
    expect(supplied.payload).toEqual(mock.entry.payload);
    expect(supplied.payload).not.toBe(mock.entry.payload);
    expect(Object.isFrozen(supplied.payload)).toBe(true);
    expect(supplied.proverArchive).toBe(options.proverArchive);
    expect(supplied.artifactDirectory).toBe(options.artifactDirectory);
    expect(mock.window.reattest).toHaveBeenCalledTimes(1);
  }
);

test.each([
  [
    'missing option',
    (v) => {
      delete v.proverArchive;
    },
  ],
  [
    'raw payload',
    (v) => {
      v.payload = {};
    },
  ],
  [
    'raw entry',
    (v) => {
      v.entry = {};
    },
  ],
  [
    'root override',
    (v) => {
      v.rootSource = {};
    },
  ],
  [
    'writer override',
    (v) => {
      v.store = {};
    },
  ],
  [
    'callback',
    (v) => {
      v.run = () => {};
    },
  ],
  [
    'forged identity',
    (v) => {
      v.identity = {};
    },
  ],
  [
    'forged enrollment',
    (v) => {
      v.enrollment = { ...v.enrollment };
    },
  ],
  [
    'forged coordinator',
    (v) => {
      v.coordinator = { ...v.coordinator };
    },
  ],
  [
    'relative artifact path',
    (v) => {
      v.artifactDirectory = 'relative';
    },
  ],
  [
    'overlong artifact path',
    (v) => {
      v.artifactDirectory = '/' + 'x'.repeat(4096);
    },
  ],
  [
    'engine archive',
    (v) => {
      v.archive = '/wrong.asar';
    },
  ],
  [
    'prover archive',
    (v) => {
      v.proverArchive = '/wrong.asar';
    },
  ],
  [
    'digest',
    (v) => {
      v.capsuleDigest = '0x' + hex(1);
    },
  ],
  [
    'signal',
    (v) => {
      v.signal = {};
    },
  ],
  ...[0, -1, 0.5, NaN, Infinity, 300001].map((n) => [
    'timeout ' + n,
    (v) => {
      v.timeoutMs = n;
    },
  ]),
])('refuses invalid options: %s', async (_name, change) => {
  const value = { ...options };
  change(value);
  expect(await run(value)).toEqual({ status: 'refused', stage: 'context' });
  expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  expect(mock.output).not.toHaveBeenCalled();
});
test.each([null, [], 'private input', 4])('refuses malformed options %p', async (input) => {
  expect(await run(input)).toEqual({ status: 'refused', stage: 'context' });
});
test('aborted caller is refused before opening retained data', async () => {
  mock.caller.abort();
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
});
test.each([
  ['missing', () => null],
  ['wrong state', (entry) => ({ ...entry, state: 'attempted' })],
  ['wrong capsule', (entry) => ({ ...entry, capsuleDigest: hex(99) })],
  ['wrong digest', (entry) => ({ ...entry, payloadSha256: hex(99) })],
  ['extra payload key', (entry) => ({ ...entry, payload: { ...entry.payload, extra: true } })],
  ['malformed proof', (entry) => ({ ...entry, payload: { ...entry.payload, proof: {} } })],
])('refuses unauthentic-shaped stored data: %s', async (_name, change) => {
  mock.read.mockImplementation(async () => change(copy(mock.entry)));
  expect(await run()).toEqual({ status: 'refused', stage: 'stored' });
  expect(mock.output).not.toHaveBeenCalled();
});

const rewrite = (entry, what) => {
  const value = copy(entry);
  if (what === 'revision') value.revision++;
  else {
    value.payload.proof.pi_a[0] = '9';
    value.payloadSha256 = sha(normalizeRailgunPoiPayload(value.payload));
  }
  return freeze(value);
};
test.each([2, 3, 4, 5].flatMap((read) => ['revision', 'payload'].map((kind) => [read, kind])))(
  'reread %i refuses changed %s',
  async (read, kind) => {
    mock.read.mockImplementation(async (n) =>
      n === read ? rewrite(mock.entry, kind) : freeze(copy(mock.entry))
    );
    expect(await run()).toEqual({
      status: 'refused',
      stage: { 2: 'output', 3: 'verify', 4: 'final-account:callback', 5: 'final-account' }[read],
    });
    expect(mock.verify).toHaveBeenCalledTimes(read > 2 ? 1 : 0);
    expect(withRailgunOwnOperationRecovery).toHaveBeenCalledTimes(read > 3 ? 1 : 0);
  }
);
test('output recovery refusal is preserved without verifier work', async () => {
  mock.output.mockResolvedValue({ status: 'refused', stage: 'recovery:callback' });
  expect(await run()).toEqual({ status: 'refused', stage: 'output:recovery:callback' });
  expect(mock.verify).not.toHaveBeenCalled();
});
test.each([
  ['capsuleDigest', hex(99)],
  ['revision', 2],
  ['payloadSha256', hex(99)],
  ['outputMatched', false],
  ...[
    'proofVerified',
    'originalInputReconstructed',
    'originalRootsAccepted',
    'membershipAuthenticated',
    'sourceAuthenticated',
    'disclosureEnabled',
    'spendingEnabled',
  ].map((name) => [name, true]),
])('rejects output result %s mismatch', async (key, value) => {
  mock.outputResult[key] = value;
  expect(await run()).toEqual({ status: 'refused', stage: 'output' });
  expect(mock.verify).not.toHaveBeenCalled();
});
test.each([
  ['payloadSha256', hex(99)],
  ['proofVerified', false],
  ['independentlyVerified', false],
  ['utilityExitObserved', false],
  ...[
    'sourceAuthenticated',
    'membershipAuthenticated',
    'rootAccepted',
    'metadataAuthenticated',
    'ownershipAuthenticated',
    'disclosureEnabled',
    'spendingEnabled',
  ].map((name) => [name, true]),
])('rejects verifier %s mismatch without final recovery', async (key, value) => {
  mock.verified[key] = value;
  expect(await run()).toEqual({ status: 'refused', stage: 'verify' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
});
test('verifier exception is sanitized and releases its drained phase', async () => {
  mock.verify.mockRejectedValue(Error('PRIVATE payload secret'));
  expect(await run()).toEqual({ status: 'refused', stage: 'verify' });
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
});

test.each(['output', 'verify'])(
  'retains directory ownership while %s ignores cancellation',
  async (boundary) => {
    const gate = deferred(),
      entered = deferred();
    const result = boundary === 'output' ? mock.outputResult : mock.verified;
    mock[boundary].mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return copy(result);
    });
    let settled = false;
    const pending = run().then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    mock.caller.abort();
    expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
    expect(settled).toBe(false);
    if (boundary === 'verify')
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
    gate.resolve();
    expect(await pending).toEqual({ status: 'refused', stage: boundary });
    const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
    phase.release();
    expect((await run(freshOptions())).status).toBe('validated');
  }
);
test('healthy simultaneous request cannot steal the owner or disturb validation', async () => {
  const gate = deferred();
  mock.output.mockImplementationOnce(async () => {
    await gate.promise;
    return copy(mock.outputResult);
  });
  const pending = run();
  await until(() => mock.output.mock.calls.length === 1);
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  gate.resolve();
  expect((await pending).status).toBe('validated');
  expect((await run()).status).toBe('validated');
});
test('another enrollment instance for the same directory cannot bypass owner exclusion', async () => {
  const gate = deferred();
  mock.output.mockImplementationOnce(async () => {
    await gate.promise;
    return copy(mock.outputResult);
  });
  const pending = run();
  await until(() => mock.output.mock.calls.length === 1);
  const reopened = { ...mock.enrollment };
  mock.enrollments.add(reopened);
  expect(await run({ ...options, enrollment: reopened })).toEqual({
    status: 'refused',
    stage: 'context',
  });
  gate.resolve();
  expect((await pending).status).toBe('validated');
});
test('existing recovery owner prevents verifier start', async () => {
  let phase;
  mock.output.mockImplementation(async () => {
    phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
    return copy(mock.outputResult);
  });
  try {
    expect(await run()).toEqual({ status: 'refused', stage: 'verify' });
    expect(mock.verify).not.toHaveBeenCalled();
  } finally {
    phase.release();
  }
});
test('ignored final-window store read drains before releasing phase and owner', async () => {
  const gate = deferred(),
    entered = deferred();
  mock.read.mockImplementation(async (n) => {
    if (n === 4) {
      entered.resolve();
      await gate.promise;
    }
    return freeze(copy(mock.entry));
  });
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  mock.caller.abort();
  expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
  expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
  expect(settled).toBe(false);
  gate.resolve();
  // Parent revocation is checked before consuming the recovery's diagnostic.
  expect(await pending).toEqual({ status: 'refused', stage: 'final-account' });
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
  expect((await run(freshOptions())).status).toBe('validated');
});
test('ignored post-recovery read retains directory owner after account phase is released', async () => {
  const gate = deferred(),
    entered = deferred();
  mock.read.mockImplementation(async (n) => {
    if (n === 5) {
      entered.resolve();
      await gate.promise;
    }
    return freeze(copy(mock.entry));
  });
  const pending = run();
  await entered.promise;
  mock.caller.abort();
  expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'final-account' });
});

for (const boundary of ['output', 'verify', 'reattest']) {
  test.each([
    'identity',
    'enrollment',
    'coordinator',
    'store',
    'identity-binding',
    'public-generation',
  ])('revokes %s during ' + boundary, async (source) => {
    const original = mock[boundary].getMockImplementation();
    mock[boundary].mockImplementation(async (...args) => {
      const value = await original(...args);
      if (source === 'identity-binding') mock.identityCurrent = false;
      else if (source === 'public-generation') mock.publicIdentity.generationId = hex(99);
      else mock[source + 'Abort'].abort();
      return value;
    });
    expect(await run()).toEqual({
      status: 'refused',
      stage: boundary === 'reattest' ? 'final-account' : boundary,
    });
  });
}
test.each(['capsuleDigest', 'bindingDigest', 'selector'])(
  'final capture must bind retained %s',
  async (field) => {
    mock.recoveryStart.mockImplementation(async () => {
      if (field === 'selector') mock.capture.selector.position++;
      else mock.capture[field] = hex(99);
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'final-account:callback' });
  }
);
test.each([
  'capsuleDigest',
  'bindingDigest',
  'selector',
  'facts',
  'submitter',
  'capsule',
  'provedTransaction',
  'intent',
  'projection',
  'archive',
  'archive-anchor',
])('rejects within-window capture drift: %s', async (field) => {
  if (field === 'archive-anchor')
    mock.capture.record = {
      ...mock.capture.record,
      archivedAt: 1,
      finalized: { blockHash: prefixed(50) },
    };
  mock.reattest.mockImplementation(async () => {
    const capture = copy(mock.capture);
    if (field === 'archive')
      capture.record = { ...capture.record, archivedAt: 1, finalized: { blockHash: prefixed(50) } };
    else if (field === 'archive-anchor') capture.record.finalized.blockHash = prefixed(99);
    else if (field === 'selector') capture.selector.position++;
    else if (typeof capture[field] === 'string') capture[field] = hex(99);
    else capture[field] = { changed: true };
    return capture;
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'final-account:callback' });
});
test('interstage active-to-archived representation is allowed with stable retained binding', async () => {
  mock.verify.mockImplementation(async () => {
    mock.capture.record = {
      ...mock.capture.record,
      archivedAt: 1,
      finalized: { blockHash: prefixed(50) },
    };
    return copy(mock.verified);
  });
  expect((await run()).status).toBe('validated');
});
test('post-callback recovery refusal cannot become a validated diagnostic', async () => {
  mock.recoveryPost.mockRejectedValue(Error('PRIVATE post-attestation diagnostic'));
  expect(await run()).toEqual({ status: 'refused', stage: 'final-account:reattest' });
});

test('snapshots caller options before an asynchronous store open', async () => {
  const gate = deferred();
  const supplied = { ...options };
  mock.enrollment.openPoiIntents.mockImplementation(async () => {
    await gate.promise;
    return mock.store;
  });
  const pending = run(supplied);
  supplied.archive = '/wrong-engine';
  supplied.proverArchive = '/wrong-prover';
  supplied.artifactDirectory = '/wrong-artifacts';
  supplied.capsuleDigest = hex(99);
  supplied.signal = new AbortController().signal;
  supplied.coordinator = {};
  supplied.timeoutMs = 1;
  gate.resolve();
  expect((await pending).status).toBe('validated');
  expect(recoverRailgunPoiOutput.mock.calls[0][0]).toMatchObject({
    archive: '/fixture-engine.asar',
    capsuleDigest: options.capsuleDigest,
  });
  expect(verifyRailgunPoiPayload.mock.calls[0][0]).toMatchObject({
    proverArchive: '/fixture-prover.asar',
    artifactDirectory: '/fixture-artifacts',
  });
});
test('original caller signal remains authoritative after options mutation', async () => {
  const gate = deferred(),
    supplied = { ...options };
  mock.output.mockImplementation(async () => {
    await gate.promise;
    return copy(mock.outputResult);
  });
  const pending = run(supplied);
  await until(() => mock.output.mock.calls.length === 1);
  supplied.signal = new AbortController().signal;
  mock.caller.abort();
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'output' });
});

test('uses bounded 240s output, 35s verifier and 15s final admission ceilings', async () => {
  expect((await run()).status).toBe('validated');
  expect(mock.output.mock.calls[0][0].timeoutMs).toBe(240000);
  expect(mock.verify.mock.calls[0][0].timeoutMs).toBe(35000);
  expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(15000);
});
test.each([1, 49999, 50000])(
  'refuses total budget %i without consuming reserved verification/final time',
  async (timeoutMs) => {
    expect(await run({ ...options, timeoutMs })).toEqual({ status: 'refused', stage: 'output' });
    expect(mock.output).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test('strictly positive remainder above 35+15s reserve is admitted without renewal', async () => {
  expect((await run({ ...options, timeoutMs: 50001 })).status).toBe('validated');
  expect(mock.output.mock.calls[0][0].timeoutMs).toBe(1);
  expect(mock.verify.mock.calls[0][0].timeoutMs).toBe(35000);
  expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(15000);
});
test('elapsed store reads reduce output and verifier budgets against the original deadline', async () => {
  mock.read.mockImplementation(async (n) => {
    if (n === 1) await jest.advanceTimersByTimeAsync(10000);
    return freeze(copy(mock.entry));
  });
  mock.output.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(45000);
    return copy(mock.outputResult);
  });
  expect((await run({ ...options, timeoutMs: 100000 })).status).toBe('validated');
  expect(mock.output.mock.calls[0][0].timeoutMs).toBe(40000);
  // Mock output deliberately outlives its own budget: the original parent
  // deadline still caps the next stage, rather than granting a fresh 35s.
  expect(mock.verify.mock.calls[0][0].timeoutMs).toBe(30000);
  expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(15000);
});
test('output callback consuming final reserve prevents verifier startup', async () => {
  mock.output.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(85000);
    return copy(mock.outputResult);
  });
  expect(await run({ ...options, timeoutMs: 100000 })).toEqual({
    status: 'refused',
    stage: 'verify',
  });
  expect(mock.verify).not.toHaveBeenCalled();
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
});
test('deadline expiry cannot release verifier phase while ignored callback is pending', async () => {
  const gate = deferred(),
    entered = deferred();
  mock.verify.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    return copy(mock.verified);
  });
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  await jest.advanceTimersByTimeAsync(300001);
  expect(mock.verify.mock.calls[0][0].signal.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
  expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'verify' });
  const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
  phase.release();
});
test('final window enforces its final 1s margin without renewing the parent deadline', async () => {
  mock.reattest.mockImplementation(async () => {
    await jest.advanceTimersByTimeAsync(14000);
    return copy(mock.capture);
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'final-account:callback' });
});
test('deadline exhausted in a post-verifier stored read prevents final recovery', async () => {
  mock.read.mockImplementation(async (n) => {
    if (n === 3) await jest.advanceTimersByTimeAsync(300000);
    return freeze(copy(mock.entry));
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'verify' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
});

test.each(['open', 'initial-read'])(
  'retains owner while %s ignores caller cancellation',
  async (where) => {
    const gate = deferred(),
      entered = deferred();
    if (where === 'open')
      mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return mock.store;
      });
    else
      mock.read.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return freeze(copy(mock.entry));
      });
    const pending = run();
    await entered.promise;
    mock.caller.abort();
    expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
    expect(mock.output).not.toHaveBeenCalled();
    gate.resolve();
    expect(await pending).toEqual({ status: 'refused', stage: 'stored' });
    expect((await run(freshOptions())).status).toBe('validated');
  }
);
test('post-final reread cancellation does not close the shared enrollment-owned store', async () => {
  mock.read.mockImplementation(async (n) => {
    if (n === 5) mock.storeAbort.abort();
    return freeze(copy(mock.entry));
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'final-account' });
  expect(mock.store.close).not.toHaveBeenCalled();
});
