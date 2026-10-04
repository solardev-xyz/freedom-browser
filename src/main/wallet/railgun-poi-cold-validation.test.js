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
jest.mock('./railgun-txid-policy', () => ({
  getRailgunTxidPolicy: jest.fn(() => mock.txidPolicy),
}));
jest.mock('./railgun-account-txid', () => ({
  openRailgunAccountTxid: jest.fn((options) => mock.openTxid(options)),
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
const {
  validateRailgunRetainedPoi,
  validateRailgunRetainedPoiHistory,
} = require('./railgun-poi-cold-validation');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { captureRailgunOwnOperationSelector } = require('./railgun-own-operation');
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
      'validateRailgunRetainedPoiHistory',
    ]);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
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

// New historical composition keeps real structural normalizers and account
// phases. Utility cryptography and authenticated mirror ownership are mocked.
const runHistory = (input = options) => {
  const work = validateRailgunRetainedPoiHistory(input);
  operations.push(work);
  return work;
};
function configureHistory(unshield = false) {
  configure(unshield);
  mock.txidPolicy = hex(80);
  mock.capture.provedTransaction = {
    chainId: 11155111,
    to: mock.capture.provedTransaction.to,
    value: '0',
    data: mock.capture.provedTransaction.input,
  };
  const row = sample(unshield).row;
  const { transaction, expected } =
    require('./railgun-transact-intent').extractRailgunTransactIntent(
      mock.capture.provedTransaction
    );
  const bindingDigest = createHash('sha256')
    .update('freedom:railgun:own-selector-v1\0')
    .update(JSON.stringify(transaction))
    .digest('hex');
  mock.derived = {
    inputSha256: sha({
      archive: options.archive,
      facts: {
        nullifiers: [expected.nullifier],
        commitments: [expected.commitment],
        boundParamsHash: expected.boundParamsHash,
      },
      bindingDigest,
    }),
    bindingDigest,
    railgunTxid: hex(9),
    selectorDerived: true,
    accountAuthenticated: false,
    pathVerified: false,
    sourceAuthenticated: false,
    rootAccepted: false,
    currentCanonicalityVerified: false,
    finalityVerified: false,
    rowMetadataAuthenticated: false,
    poiVerified: false,
    globalTxidCompleteness: false,
    spendingEnabled: false,
    utilityExitObserved: true,
  };
  mock.state = {
    version: 1,
    count: 5,
    root: hex(81),
    transcript: hex(82),
    after: row.graphID,
    verificationHash: row.verificationHash,
    branches: Array(16).fill(hex(83)),
    breaks: [],
  };
  mock.checkpoint = {
    state: mock.state,
    store: { schema: 'wallet-store-v1', storeId: hex(84), count: 20, bytes: 5000, sha256: hex(85) },
    validation: { index: 4, root: mock.state.root, accepted: true },
  };
  mock.witness = {
    row,
    leaf: hex(86),
    railgunTxid: mock.derived.railgunTxid,
    rowSha256: sha(row),
    index: 2,
    elements: Array(16).fill(hex(87)),
    root: mock.state.root,
    checkpointIndex: 4,
    transcript: mock.state.transcript,
    continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(4, []),
    globalTxidCompleteness: false,
  };
  mock.historical = {
    version: 1,
    tree: 0,
    index: mock.entry.payload.txidMerklerootIndex,
    root: mock.entry.payload.txidMerkleroot,
    checkpointIndex: 4,
    checkpointRoot: mock.state.root,
    transcript: mock.state.transcript,
    localPrefixComputed: true,
    globalTxidCompleteness: false,
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  };
  mock.selector = jest.fn(async () => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'recovery');
    try {
      mock.events.push('selector');
      await mock.selectorWork();
      return { status: 'captured', capture: copy(mock.capture), derived: copy(mock.derived) };
    } finally {
      phase.release();
      mock.events.push('selector-close');
    }
  });
  mock.selectorWork = jest.fn(async () => {});
  mock.opening = jest.fn(async () => {});
  mock.mirrorDrain = jest.fn(async () => {});
  mock.inspect = jest.fn(async () => ({ checkpoint: copy(mock.checkpoint), pending: null }));
  mock.witnessRead = jest.fn(async () => ({
    witness: copy(mock.witness),
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  }));
  mock.historyRead = jest.fn(async () => copy(mock.historical));
  mock.openTxid = jest.fn(async () => {
    const phase = claimRailgunAccountPhase(mock.enrollment, 'txid');
    const aborted = new AbortController();
    const pending = new Set();
    let closing;
    const read = (name, handler) =>
      jest.fn((...args) => {
        mock.events.push(name);
        const work = Promise.resolve().then(() => handler(...args));
        pending.add(work);
        work.then(
          () => pending.delete(work),
          () => pending.delete(work)
        );
        return work;
      });
    mock.txid = {
      policy: mock.txidPolicy,
      publicIdentity: copy(mock.publicIdentity),
      signal: aborted.signal,
      inspect: read('mirror-inspect', (...args) => mock.inspect(...args)),
      witness: read('mirror-witness', (...args) => mock.witnessRead(...args)),
      historicalRoot: read('mirror-history', (...args) => mock.historyRead(...args)),
      advance: jest.fn(() => {
        throw Error('unexpected mirror repair');
      }),
      cover: jest.fn(() => {
        throw Error('unexpected full mirror source coverage');
      }),
      close: jest.fn(() => {
        aborted.abort();
        if (!closing)
          closing = (async () => {
            await Promise.allSettled([...pending]);
            await mock.mirrorDrain();
            phase.release();
            mock.events.push('mirror-close');
          })();
        return closing;
      }),
    };
    mock.events.push('mirror-open');
    try {
      await mock.opening();
      return mock.txid;
    } catch (error) {
      await mock.txid.close();
      throw error;
    }
  });
}

describe('retained historical TXID root composition', () => {
  beforeEach(() => configureHistory());
  afterEach(() => {
    if (mock.txid) {
      expect(mock.txid.advance).not.toHaveBeenCalled();
      expect(mock.txid.cover).not.toHaveBeenCalled();
    }
  });

  test.each([false, true])('binds retained %s root to the fresh local prefix', async (unshield) => {
    configureHistory(unshield);
    const result = await runHistory();
    expect(result).toMatchObject({
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
      viewingKeyReleases: unshield ? 0 : 1,
      rootAccepted: false,
      originalRootsAccepted: false,
      originalTxidRootCanonical: false,
      globalTxidCompleteness: false,
      currentNoteEligibility: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      spendingEnabled: false,
      disclosureEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(mock.output).toHaveBeenCalledTimes(1);
    expect(mock.verify).toHaveBeenCalledTimes(1);
    expect(captureRailgunOwnOperationSelector).toHaveBeenCalledTimes(1);
    expect(captureRailgunOwnOperationSelector.mock.calls[0][0]).toMatchObject({
      enrollment: mock.enrollment,
      archive: options.archive,
      selector: mock.entry.selector,
      timeoutMs: 45000,
    });
    expect(openRailgunAccountTxid).toHaveBeenCalledWith({
      enrollment: mock.enrollment,
      coordinator: mock.coordinator,
      archive: options.archive,
      create: false,
      checkpointOnly: true,
    });
    expect(mock.txid.witness).toHaveBeenCalledWith(mock.derived.railgunTxid);
    expect(mock.txid.historicalRoot).toHaveBeenCalledWith(3);
    expect(mock.txid.historicalRoot.mock.calls[0]).toHaveLength(1);
    expect(mock.historical.root).not.toBe(mock.state.root);
    expect(mock.events.indexOf('mirror-open')).toBeGreaterThan(
      mock.events.indexOf('selector-close')
    );
    expect(mock.events.indexOf('final-open')).toBeGreaterThan(mock.events.indexOf('mirror-close'));
    expect(mock.inspect).toHaveBeenCalledTimes(2);
    expect(mock.txid.close).toHaveBeenCalled();
    expect(mock.store.get).toHaveBeenCalledTimes(7);
  });

  test.each([
    'mode',
    'stageA',
    'receipt',
    'root',
    'index',
    'witness',
    'txid',
    'selector',
    'openTxid',
  ])('rejects caller %s override without reading private records', async (key) => {
    expect(await runHistory({ ...options, [key]: {} })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(mock.store.get).not.toHaveBeenCalled();
    expect(mock.selector).not.toHaveBeenCalled();
    expect(mock.openTxid).not.toHaveBeenCalled();
  });
  test.each([0, -1, 0.5, NaN, Infinity, 540001])(
    'rejects history timeout %p',
    async (timeoutMs) => {
      expect(await runHistory({ ...options, timeoutMs })).toEqual({
        status: 'refused',
        stage: 'context',
      });
      expect(mock.output).not.toHaveBeenCalled();
    }
  );
  test('Stage A never opens or derives the new mirror phase', async () => {
    expect((await run()).status).toBe('validated');
    expect(mock.selector).not.toHaveBeenCalled();
    expect(mock.openTxid).not.toHaveBeenCalled();
  });

  test.each([4, 5, 6, 7].flatMap((read) => ['revision', 'payload'].map((kind) => [read, kind])))(
    'new reread %i refuses changed %s',
    async (read, kind) => {
      mock.read.mockImplementation(async (n) =>
        n === read ? rewrite(mock.entry, kind) : freeze(copy(mock.entry))
      );
      expect((await runHistory()).status).toBe('refused');
      if (read === 4) expect(mock.openTxid).not.toHaveBeenCalled();
      if (read <= 5) expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    }
  );
  test.each(['capsuleDigest', 'bindingDigest', 'selector'])(
    'fresh selector capture must retain %s',
    async (key) => {
      mock.selector.mockImplementation(async () => {
        const capture = copy(mock.capture);
        capture[key] = key === 'selector' ? { ...capture.selector, position: 7 } : hex(99);
        return { status: 'captured', capture, derived: copy(mock.derived) };
      });
      expect((await runHistory()).status).toBe('refused');
      expect(mock.openTxid).not.toHaveBeenCalled();
    }
  );
  test.each([
    ['railgunTxid', '0x' + hex(9)],
    ['railgunTxid', 'f'.repeat(64)],
    ['bindingDigest', hex(99)],
    ['inputSha256', 'not-a-digest'],
    ['selectorDerived', false],
    ['utilityExitObserved', false],
    ...[
      'accountAuthenticated',
      'pathVerified',
      'sourceAuthenticated',
      'rootAccepted',
      'currentCanonicalityVerified',
      'finalityVerified',
      'rowMetadataAuthenticated',
      'poiVerified',
      'globalTxidCompleteness',
      'spendingEnabled',
    ].map((key) => [key, true]),
  ])('refuses derived selector %s=%p', async (key, value) => {
    mock.derived[key] = value;
    expect((await runHistory()).status).toBe('refused');
    if (key !== 'railgunTxid' || value.startsWith('0x'))
      expect(mock.openTxid).not.toHaveBeenCalled();
  });
  test('selector refusal cannot start a mirror', async () => {
    mock.selector.mockResolvedValue({ status: 'refused', stage: 'selector' });
    expect((await runHistory()).status).toBe('refused');
    expect(mock.openTxid).not.toHaveBeenCalled();
  });
  test('missing current-policy mirror refuses without repair or fallback', async () => {
    mock.opening.mockRejectedValue(Error('PRIVATE mirror unavailable'));
    expect((await runHistory()).status).toBe('refused');
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  });

  test.each([
    'pending',
    'missing',
    'count-zero',
    'count-too-large',
    'saved-at-count',
    'saved-8000',
  ])('refuses %s before witness or prefix work', async (fault) => {
    if (fault === 'saved-at-count' || fault === 'saved-8000') {
      mock.entry.payload = {
        ...mock.entry.payload,
        txidMerklerootIndex: fault === 'saved-at-count' ? 5 : 8000,
      };
      mock.entry.payloadSha256 = sha(mock.entry.payload);
      mock.outputResult.payloadSha256 = mock.entry.payloadSha256;
      mock.verified.payloadSha256 = mock.entry.payloadSha256;
    } else {
      mock.inspect.mockImplementation(async () => ({
        checkpoint:
          fault === 'missing'
            ? null
            : {
                ...copy(mock.checkpoint),
                state: {
                  ...copy(mock.state),
                  count: fault === 'count-zero' ? 0 : fault === 'count-too-large' ? 8001 : 5,
                },
              },
        pending: fault === 'pending' ? { prepared: true } : null,
      }));
    }
    expect((await runHistory()).status).toBe('refused');
    expect(mock.witnessRead).not.toHaveBeenCalled();
    expect(mock.historyRead).not.toHaveBeenCalled();
  });
  test('own TXID must occur no later than the retained root index', async () => {
    mock.witness.index = 4;
    expect((await runHistory()).status).toBe('refused');
    expect(mock.historyRead).not.toHaveBeenCalled();
  });
  test('own TXID exactly at retained index is admitted', async () => {
    mock.witness.index = 3;
    expect((await runHistory()).status).toBe('validated');
  });
  test.each([
    ['railgunTxid', hex(99)],
    ['checkpointIndex', 3],
    ['transcript', hex(99)],
    ['root', hex(99)],
    ['rowSha256', hex(99)],
    ['globalTxidCompleteness', true],
  ])('rejects fresh witness %s drift', async (key, value) => {
    mock.witness[key] = value;
    expect((await runHistory()).status).toBe('refused');
    expect(mock.historyRead).not.toHaveBeenCalled();
  });
  test.each([
    ['version', 2],
    ['tree', 1],
    ['index', 2],
    ['root', hex(99)],
    ['checkpointIndex', 3],
    ['checkpointRoot', hex(99)],
    ['transcript', hex(99)],
    ['localPrefixComputed', false],
    ...[
      'globalTxidCompleteness',
      'ownershipVerified',
      'eventCoverageVerified',
      'rootAccepted',
      'spendingEnabled',
    ].map((key) => [key, true]),
    ['extra', true],
  ])('rejects historical facts %s=%p', async (key, value) => {
    mock.historical[key] = value;
    expect((await runHistory()).status).toBe('refused');
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  });
  test.each(['pending', 'state', 'store', 'validation'])(
    'pins the entire before/after mirror checkpoint: %s',
    async (field) => {
      mock.inspect.mockImplementation(async () => {
        const value = { checkpoint: copy(mock.checkpoint), pending: null };
        if (mock.inspect.mock.calls.length === 2) {
          if (field === 'pending') value.pending = { page: true };
          else value.checkpoint[field] = { changed: true };
        }
        return value;
      });
      expect((await runHistory()).status).toBe('refused');
      expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    }
  );

  for (const boundary of [
    'selectorWork',
    'opening',
    'inspect',
    'witnessRead',
    'historyRead',
    'mirrorDrain',
  ]) {
    test.each([
      'identity',
      'enrollment',
      'coordinator',
      'store',
      'identity-binding',
      'generation',
      'policy',
    ])('revokes %s after awaited ' + boundary, async (source) => {
      const original = mock[boundary].getMockImplementation();
      mock[boundary].mockImplementationOnce(async (...args) => {
        const value = await original(...args);
        if (source === 'identity-binding') mock.identityCurrent = false;
        else if (source === 'generation') mock.publicIdentity.generationId = hex(99);
        else if (source === 'policy') mock.txidPolicy = hex(99);
        else mock[source + 'Abort'].abort();
        return value;
      });
      expect((await runHistory()).status).toBe('refused');
      expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    });
  }
  test.each(['policy', 'publicIdentity'])(
    'refuses opened mirror with unrelated %s',
    async (field) => {
      mock.opening.mockImplementation(async () => {
        mock.txid[field] =
          field === 'policy' ? hex(99) : { ...mock.publicIdentity, sourceId: hex(99) };
      });
      expect((await runHistory()).status).toBe('refused');
      expect(mock.inspect).not.toHaveBeenCalled();
    }
  );
  test.each([
    'bindingDigest',
    'capsuleDigest',
    'selector',
    'facts',
    'submitter',
    'capsule',
    'provedTransaction',
    'intent',
    'projection',
  ])('refuses stable capture drift across the mirror: %s', async (key) => {
    mock.mirrorDrain.mockImplementation(async () => {
      if (key === 'selector') mock.capture.selector.position++;
      else if (typeof mock.capture[key] === 'string') mock.capture[key] = hex(99);
      else mock.capture[key] = { changed: true };
    });
    expect((await runHistory()).status).toBe('refused');
  });
  test('allows archival between selector capture and final recovery with unchanged stable content', async () => {
    mock.mirrorDrain.mockImplementation(async () => {
      mock.capture.record = {
        ...mock.capture.record,
        archivedAt: 1,
        finalized: { blockHash: prefixed(50) },
      };
    });
    expect((await runHistory()).status).toBe('validated');
  });
  test('refuses anchor drift between the two explicit final captures', async () => {
    mock.mirrorDrain.mockImplementation(async () => {
      mock.capture.record = {
        ...mock.capture.record,
        archivedAt: 1,
        finalized: { blockHash: prefixed(50) },
      };
    });
    mock.reattest.mockImplementation(async () => {
      const capture = copy(mock.capture);
      capture.record.finalized.blockHash = prefixed(99);
      return capture;
    });
    expect((await runHistory()).status).toBe('refused');
  });
  test.each([
    ['history', 'stage-a'],
    ['stage-a', 'history'],
    ['history', 'history'],
  ])(
    'shared owner prevents %s -> %s overlap without disturbing the first',
    async (first, second) => {
      const gate = deferred();
      mock.output.mockImplementationOnce(async () => {
        await gate.promise;
        return copy(mock.outputResult);
      });
      const initial = first === 'history' ? runHistory() : run();
      await until(() => mock.output.mock.calls.length === 1);
      expect(await (second === 'history' ? runHistory() : run())).toEqual({
        status: 'refused',
        stage: 'context',
      });
      gate.resolve();
      expect((await initial).status).toBe('validated');
      expect((await runHistory()).status).toBe('validated');
    }
  );
  test('same-directory reopened enrollment cannot bypass the shared history owner', async () => {
    const gate = deferred();
    mock.opening.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const pending = runHistory();
    await until(() => mock.opening.mock.calls.length === 1);
    const reopened = { ...mock.enrollment };
    mock.enrollments.add(reopened);
    expect(await run({ ...options, enrollment: reopened })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(await runHistory({ ...options, enrollment: reopened })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    gate.resolve();
    expect((await pending).status).toBe('validated');
  });
  test.each(['success', 'rejection'])(
    'cancelled late open %s retains ownership until handle/rejection drains',
    async (outcome) => {
      const gate = deferred();
      mock.opening.mockImplementationOnce(async () => {
        await gate.promise;
        if (outcome === 'rejection') throw Error('PRIVATE opening failure');
      });
      let settled = false;
      const pending = runHistory().then((value) => {
        settled = true;
        return value;
      });
      await until(() => mock.opening.mock.calls.length === 1);
      mock.caller.abort();
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(mock.txid.close).not.toHaveBeenCalled();
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
      expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
      expect(await runHistory(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
      gate.resolve();
      expect((await pending).status).toBe('refused');
      expect(mock.inspect).not.toHaveBeenCalled();
      expect(mock.txid.close).toHaveBeenCalled();
      const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
      phase.release();
      expect((await runHistory(freshOptions())).status).toBe('validated');
    }
  );
  test.each(['selectorWork', 'inspect', 'witnessRead', 'historyRead', 'mirrorDrain'])(
    'retains owner and phase through ignored %s cancellation',
    async (boundary) => {
      const gate = deferred();
      const original = mock[boundary].getMockImplementation();
      mock[boundary].mockImplementationOnce(async (...args) => {
        const value = await original(...args);
        await gate.promise;
        return value;
      });
      let settled = false;
      const pending = runHistory().then((value) => {
        settled = true;
        return value;
      });
      await until(() => mock[boundary].mock.calls.length === 1);
      mock.caller.abort();
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(() => claimRailgunAccountPhase(mock.enrollment, 'wallet')).toThrow();
      expect(await run(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
      expect(await runHistory(freshOptions())).toEqual({ status: 'refused', stage: 'context' });
      gate.resolve();
      expect((await pending).status).toBe('refused');
      const phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
      phase.release();
      expect((await runHistory(freshOptions())).status).toBe('validated');
    }
  );
  test('completed prefix cannot bypass a still-pending mirror process exit', async () => {
    const gate = deferred();
    mock.mirrorDrain.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const pending = runHistory();
    await until(() => mock.mirrorDrain.mock.calls.length === 1);
    expect(mock.historyRead).toHaveBeenCalledTimes(1);
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(await run()).toEqual({ status: 'refused', stage: 'context' });
    gate.resolve();
    expect((await pending).status).toBe('validated');
  });
  test('ordinary phase contention refuses rather than evicting the existing owner', async () => {
    let phase;
    mock.selector.mockImplementation(async () => {
      phase = claimRailgunAccountPhase(mock.enrollment, 'wallet');
      return { status: 'captured', capture: copy(mock.capture), derived: copy(mock.derived) };
    });
    try {
      expect((await runHistory()).status).toBe('refused');
      phase.assertCurrent();
      expect(mock.inspect).not.toHaveBeenCalled();
    } finally {
      phase?.release();
    }
  });

  test('default history budget preserves 240/35/45/180/15 second stage ceilings', async () => {
    expect((await runHistory()).status).toBe('validated');
    expect(mock.output.mock.calls[0][0].timeoutMs).toBe(240000);
    expect(mock.verify.mock.calls[0][0].timeoutMs).toBe(35000);
    expect(mock.selector.mock.calls[0][0].timeoutMs).toBe(45000);
    expect(withRailgunOwnOperationRecovery.mock.calls[0][0].timeoutMs).toBe(15000);
  });
  test.each([1, 274999, 275000])(
    'budget %i preserves all later-stage reserves',
    async (timeoutMs) => {
      expect((await runHistory({ ...options, timeoutMs })).status).toBe('refused');
      expect(mock.output).not.toHaveBeenCalled();
    }
  );
  test('positive remaining output budget is admitted above the 275-second reserve', async () => {
    expect((await runHistory({ ...options, timeoutMs: 275001 })).status).toBe('validated');
    expect(mock.output.mock.calls[0][0].timeoutMs).toBe(1);
  });
  test('smaller overall cap reduces output without extending Stage A maximum', async () => {
    expect((await runHistory({ ...options, timeoutMs: 300000 })).status).toBe('validated');
    expect(mock.output.mock.calls[0][0].timeoutMs).toBe(25000);
    expect(await run({ ...options, timeoutMs: 300001 })).toEqual({
      status: 'refused',
      stage: 'context',
    });
  });
  test('late output cannot renew verification or consume downstream reserves', async () => {
    mock.output.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(35000);
      return copy(mock.outputResult);
    });
    expect((await runHistory({ ...options, timeoutMs: 300000 })).status).toBe('validated');
    expect(mock.verify.mock.calls[0][0].timeoutMs).toBe(25000);
  });
  test('exhausted selector reserve prevents fresh selector startup', async () => {
    mock.verify.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(105000);
      return copy(mock.verified);
    });
    expect((await runHistory({ ...options, timeoutMs: 300000 })).status).toBe('refused');
    expect(mock.selector).not.toHaveBeenCalled();
    expect(mock.openTxid).not.toHaveBeenCalled();
  });
  test('mirror timer expires pending open, waits for late success, and never starts inspection', async () => {
    const gate = deferred();
    mock.opening.mockImplementationOnce(async () => {
      await gate.promise;
    });
    let settled = false;
    const pending = runHistory().then((value) => {
      settled = true;
      return value;
    });
    await until(() => mock.opening.mock.calls.length === 1);
    await jest.advanceTimersByTimeAsync(180000);
    expect(settled).toBe(false);
    expect(await run()).toEqual({ status: 'refused', stage: 'context' });
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mock.inspect).not.toHaveBeenCalled();
    expect(mock.txid.close).toHaveBeenCalled();
  });
  test('mirror work shares one 180-second clock across witness and historical root', async () => {
    mock.witnessRead.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(100000);
      return {
        witness: copy(mock.witness),
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      };
    });
    mock.historyRead.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(80000);
      return copy(mock.historical);
    });
    expect((await runHistory()).status).toBe('refused');
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(mock.txid.close).toHaveBeenCalled();
  });
  test('the original total cap shortens mirror work after prior stages consumed time', async () => {
    mock.selectorWork.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(200000);
    });
    mock.historyRead.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(85000);
      return copy(mock.historical);
    });
    expect((await runHistory({ ...options, timeoutMs: 300000 })).status).toBe('refused');
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  });
  test('caller option mutation cannot replace captured mirror dependencies or deadline', async () => {
    const gate = deferred(),
      supplied = { ...options };
    mock.selectorWork.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const pending = runHistory(supplied);
    await until(() => mock.selectorWork.mock.calls.length === 1);
    supplied.archive = '/forged';
    supplied.enrollment = {};
    supplied.coordinator = {};
    supplied.capsuleDigest = hex(99);
    supplied.timeoutMs = 1;
    supplied.signal = new AbortController().signal;
    gate.resolve();
    expect((await pending).status).toBe('validated');
    expect(openRailgunAccountTxid).toHaveBeenCalledWith({
      enrollment: options.enrollment,
      coordinator: options.coordinator,
      archive: options.archive,
      create: false,
      checkpointOnly: true,
    });
  });
  test('unshield marker must identify the freshly derived own transaction', async () => {
    configureHistory(true);
    mock.derived.railgunTxid = hex(10);
    expect((await runHistory()).status).toBe('refused');
    expect(mock.openTxid).not.toHaveBeenCalled();
  });
  test('detaches mutable selector capture before the later mirror phase', async () => {
    const captured = {
      status: 'captured',
      capture: copy(mock.capture),
      derived: copy(mock.derived),
    };
    mock.selector.mockResolvedValue(captured);
    mock.mirrorDrain.mockImplementation(async () => {
      captured.capture.projection = { changed: true };
      mock.capture.projection = { changed: true };
    });
    expect((await runHistory()).status).toBe('refused');
  });
  test('detaches the whole first checkpoint before a mutable inspect result changes', async () => {
    const inspected = { checkpoint: copy(mock.checkpoint), pending: null };
    mock.inspect.mockImplementation(async () => inspected);
    mock.historyRead.mockImplementation(async () => {
      inspected.checkpoint.store.sha256 = hex(99);
      return copy(mock.historical);
    });
    expect((await runHistory()).status).toBe('refused');
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  });
  test.each(['reattest', 'recoveryPost', 'post-final-read'])(
    'rechecks TXID policy at the final %s boundary',
    async (boundary) => {
      if (boundary === 'post-final-read') {
        mock.read.mockImplementation(async (n) => {
          if (n === 7) mock.txidPolicy = hex(99);
          return freeze(copy(mock.entry));
        });
      } else {
        const original = mock[boundary].getMockImplementation();
        mock[boundary].mockImplementation(async (...args) => {
          const value = await original(...args);
          mock.txidPolicy = hex(99);
          return value;
        });
      }
      expect((await runHistory()).status).toBe('refused');
    }
  );
});

test.each([false, true].flatMap((unshield) => [false, true].map((history) => [unshield, history])))(
  'valid attempted %s record refuses cold validator history=%s before all delegated work',
  async (unshield, history) => {
    configureHistory(unshield);
    const attemptedAt = 1791111111111;
    const submission = require('./railgun-poi-submit-data').prepareRailgunPoiSubmission({
      payload: mock.entry.payload,
      requestId: attemptedAt,
    });
    mock.entry = { ...mock.entry, state: 'attempted', attempt: { attemptedAt, submission } };
    const stored = JSON.stringify(mock.entry);
    for (let read = 0; read < 2; read++) {
      mock.entry = JSON.parse(stored);
      expect(await (history ? runHistory() : run())).toEqual({
        status: 'refused',
        stage: 'stored',
      });
    }
    expect(mock.output).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
    expect(mock.selector).not.toHaveBeenCalled();
    expect(mock.openTxid).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(mock.store.signal.aborted).toBe(false);
    expect(JSON.stringify(mock.entry)).toBe(stored);
  }
);

test.each(['output-proof', 'retained-history'])(
  'missing existing-only POI storage refuses %s validation before any recovery work',
  async (kind) => {
    if (kind === 'retained-history') configureHistory();
    mock.enrollment.openPoiIntents.mockRejectedValueOnce(
      Object.assign(Error('missing retained storage'), {
        code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED',
      })
    );
    const validate = kind === 'retained-history' ? runHistory : run;
    expect((await validate()).status).toBe('refused');
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
    expect(mock.store.get).not.toHaveBeenCalled();
    expect(mock.output).not.toHaveBeenCalled();
    expect(mock.verify).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(captureRailgunOwnOperationSelector).not.toHaveBeenCalled();
    expect(openRailgunAccountTxid).not.toHaveBeenCalled();
    expect((await validate()).status).toBe('validated');
    expect(mock.enrollment.openPoiIntents).toHaveBeenLastCalledWith({ existingOnly: true });
  }
);
