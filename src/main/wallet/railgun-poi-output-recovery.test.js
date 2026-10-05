jest.mock('./railgun-poi-shield-selector-data', () => {
  const actual = jest.requireActual('./railgun-poi-shield-selector-data');
  return {
    ...actual,
    normalizeRailgunPoiShieldInput: jest.fn(actual.normalizeRailgunPoiShieldInput),
  };
});
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: jest.fn((identity, handle) => {
    const { getPrivacyContext } = require('../networks/privacy-context');
    const context = getPrivacyContext(handle);
    if (
      identity !== mock.identity ||
      identity.signal.aborted ||
      !mock.identityCurrent ||
      context.subject.role !== 'engine' ||
      ![null, 'poi-output-recover'].includes(context.subject.operation) ||
      context.subject.principal !== 'railgun:0' ||
      context.subject.chainId !== 11155111 ||
      context.subject.protocol !== 'railgun' ||
      context.subject.deployment !== 'sepolia'
    )
      throw Error('private identity diagnostic');
    return JSON.parse(JSON.stringify(identity.descriptor));
  }),
  withRailgunViewingCredential: jest.fn((identity, use) => {
    if (identity !== mock.identity) throw Error('identity');
    return mock.credential(use);
  }),
}));
jest.mock('./railgun-public-policy', () => ({
  getRailgunPublicPolicy: (archive) => {
    if (archive !== '/fixture-engine.asar') throw Error('policy');
    return 'fixture-policy';
  },
}));
jest.mock('./railgun-account-public', () => ({
  assertRailgunAccountPublic: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      coordinator.signal.aborted ||
      !mock.publicCurrent ||
      (policy !== undefined && policy !== 'fixture-policy')
    )
      throw Error('registered policy');
    return 'fixture-policy';
  },
  getRailgunAccountPublicDestination: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      policy !== 'fixture-policy' ||
      !mock.publicCurrent
    )
      throw Error('destination owner');
    return mock.destination;
  },
  assertRailgunAccountPublicDestination: (coordinator, enrollment, destination, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      destination !== mock.destination ||
      policy !== 'fixture-policy' ||
      !mock.publicCurrent
    )
      throw Error('destination');
    return destination;
  },
  getRailgunAccountPublicIdentity: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      coordinator.signal.aborted ||
      policy !== 'fixture-policy' ||
      !mock.publicCurrent
    )
      throw Error('private coordinator diagnostic');
    return JSON.parse(JSON.stringify(mock.publicIdentity));
  },
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn((archive) => {
    if (archive !== '/fixture-engine.asar' || !mock.runtimeCurrent) throw Error('runtime');
    return archive;
  }),
}));
jest.mock('./railgun-own-witness', () => ({
  preflightRailgunOwnPoi: jest.fn(() => {
    throw Error('legacy preflight forbidden');
  }),
  preflightRailgunRetainedPoiCompleted: jest.fn((options) => mock.preflight(options)),
  preflightRailgunRetainedPoiForSubmission: jest.fn((options, input) =>
    mock.preflight(options, input)
  ),
}));
jest.mock('./railgun-own-operation', () => ({
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    if (mock.phase) return { status: 'refused', stage: 'busy' };
    mock.phase = true;
    mock.events.push('window-open');
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const deadline = performance.now() + Math.min(options.timeoutMs, mock.windowBudget);
    let accepting = true;
    const active = (margin = 0) => {
      if (
        !accepting ||
        signal.aborted ||
        !mock.phase ||
        !Number.isSafeInteger(margin) ||
        margin < 0 ||
        performance.now() + margin >= deadline
      )
        throw Error('private recovery lifetime');
    };
    mock.window = {
      capture: JSON.parse(JSON.stringify(mock.capture)),
      signal,
      assertCurrent: jest.fn(active),
      reattest: jest.fn(async () => {
        active();
        mock.events.push('reattest');
        const result = await mock.reattest();
        active();
        return result;
      }),
    };
    mock.windowAbort = () => controller.abort();
    try {
      await mock.recoveryStart();
      active();
      let value;
      try {
        value = await use(mock.window);
      } catch {
        return { status: 'refused', stage: 'callback' };
      }
      active();
      accepting = false;
      controller.abort();
      mock.events.push('recovery-post');
      await mock.recoveryPost();
      if (options.signal.aborted || performance.now() >= deadline) throw Error('outer recovery');
      return { status: 'used', value: JSON.parse(JSON.stringify(value)) };
    } catch {
      return { status: 'refused', stage: 'reattest' };
    } finally {
      accepting = false;
      controller.abort();
      mock.events.push('window-close');
      mock.phase = false;
    }
  }),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    if (!mock.phase || mock.startError) throw Error('utility startup');
    mock.events.push('job-start');
    let resolveReady,
      rejectReady,
      resolveExit,
      exited = false;
    const ready = new Promise((yes, no) => {
      resolveReady = yes;
      rejectReady = no;
    });
    const closed = new Promise((yes) => {
      resolveExit = yes;
    });
    const task = {
      options,
      ready,
      closed,
      exit() {
        if (exited) return;
        exited = true;
        mock.events.push('job-exit');
        resolveExit({ code: mock.exitCode });
      },
      close: jest.fn(() => {
        rejectReady(Error('utility closed'));
        if (!mock.deferExit) task.exit();
      }),
    };
    options.broker.signal.addEventListener('abort', () => task.close(), { once: true });
    // Exit and readiness may settle while a borrowed broker callback is pending.
    // The controller, rather than this mock, must drain that callback.
    Promise.resolve()
      .then(() => mock.scenario(options, task))
      .then(resolveReady, rejectReady);
    mock.tasks.push(task);
    mock.task = task;
    return task;
  }),
}));
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { normalizeRailgunPoiOutputRecoveryInput } = require('./railgun-poi-output-recovery-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const {
  recoverRailgunAttemptedPoiOutput,
  recoverRailgunPoiOutput,
  recoverRailgunPoiOutputCompleted,
  recoverRailgunPoiOutputForSubmission,
} = require('./railgun-poi-output-recovery');
const { withRailgunViewingCredential } = require('./railgun-identity');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const {
  preflightRailgunOwnPoi,
  preflightRailgunRetainedPoiCompleted,
  preflightRailgunRetainedPoiForSubmission,
} = require('./railgun-own-witness');
const { startRailgunProcess } = require('./railgun-process');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const prefixed = (n) => '0x' + hex(n);
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
let options, gates, operations, claims;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  const gate = { promise, resolve, reject };
  gates.push(gate);
  return gate;
};
const waitFor = async (predicate) => {
  for (let i = 0; i < 300 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
};
const run = (input = options) => {
  const work = recoverRailgunPoiOutput(input);
  operations.push(work);
  return work;
};
function configure(unshield = false) {
  // Real structural validators, not cryptographic proofs. Native qualification
  // separately supplies a real encrypted record, preflight and utility.
  const ownEvidence =
    unshield === 'partial'
      ? require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial()
      : sample(unshield);
  const capsule = ownEvidence.capsule;
  const state = { count: 5, root: hex(11), transcript: hex(12), breaks: [] };
  const witness = {
    row: copy(ownEvidence.row),
    leaf: hex(8),
    railgunTxid: hex(9),
    rowSha256: sha(JSON.stringify(ownEvidence.row)),
    index: 1,
    elements: Array(16).fill(hex(0)),
    root: state.root,
    checkpointIndex: 4,
    transcript: state.transcript,
    continuity: classifyRailgunTxidContinuity(4, []),
    globalTxidCompleteness: false,
  };
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
  const creator = {
    type: 'Shield',
    tree: 0,
    position: 1,
    preimage: {
      npk: prefixed(3),
      value: '1000',
      token: {
        tokenType: 0,
        tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
        tokenSubID: prefixed(0),
      },
    },
    ciphertext: {
      encryptedBundle: [prefixed(4), prefixed(5), prefixed(6)],
      shieldKey: prefixed(7),
    },
  };
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
    submitter: ownEvidence.transaction.from,
    provedTransaction: copy(ownEvidence.transaction),
    intent: copy(ownEvidence.record.intent),
    projection: { included: true, blockHash: ownEvidence.receipt.blockHash },
    record: copy(ownEvidence.record),
  };
  mock.fresh = {
    status: 'captured',
    publicIdentity: copy(mock.publicIdentity),
    observations: { archiveAnchorChecked: true },
    creatorClassification: { type: 'Shield', legacy: false },
    capture: copy(mock.capture),
    poiPreparation: { creator, ownEvidence, state, witness },
    witness: normalizeRailgunTxidWitness(witness, state),
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
    blindedCommitmentsOut: unshield === true ? [] : [prefixed(22)],
    railgunTxidIfHasUnshield: unshield ? prefixed(9) : '0x00',
  });
  mock.entry = {
    capsuleDigest: mock.capture.capsuleDigest,
    bindingDigest: mock.capture.bindingDigest,
    selector: copy(mock.capture.selector),
    payload,
    payloadSha256: sha(JSON.stringify(payload)),
    inputSha256: hex(23),
    revision: 1,
    state: 'prepared',
  };
  options.capsuleDigest = mock.entry.capsuleDigest;
}
function changePayload(change) {
  const payload = copy(mock.entry.payload);
  change(payload);
  mock.entry.payload = payload;
  mock.entry.payloadSha256 = sha(JSON.stringify(payload));
}
const keyWire = (job) => ({
  id: 1,
  method: 'key',
  purpose: 'poi-output-recover',
  inputSha256: sha(job.input),
});
const resultWire = (job) => ({
  id: 2,
  method: 'result',
  value: {
    recoveryInputSha256: sha(job.input),
    payloadSha256: JSON.parse(job.input).binding.payloadSha256,
    output: {
      blindedCommitmentsOut: [prefixed(22)],
      railgunTxidIfHasUnshield:
        JSON.parse(job.input).preparation.ownEvidence.capsule.selection.kind ===
        'railgun-partial-unshield'
          ? '0x' + JSON.parse(job.input).preparation.witness.railgunTxid
          : '0x00',
    },
    engineSha256: require('./railgun-engine-manifest.json').sha256,
    sourceAuthenticated: false,
    proofVerified: false,
    membershipAuthenticated: false,
    rootAccepted: false,
    disclosureEnabled: false,
    spendingEnabled: false,
    guards: { attempts: 0, canaries: 1, hooks: ['fixture.guard'] },
  },
});
async function sendKey(job) {
  const message = keyWire(job);
  mock.keyMutation(message);
  const bytes = await job.broker.dispatch(JSON.stringify(message));
  mock.copies.push(bytes);
  mock.events.push('key-copy');
  return bytes;
}
async function sendResult(job) {
  const message = resultWire(job);
  mock.resultMutation(message);
  const result = await job.broker.dispatch(JSON.stringify(message));
  mock.events.push('result');
  return result;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  gates = [];
  operations = [];
  claims = [];
  mock = {
    destination: Object.freeze({}),
    caller: new AbortController(),
    identityAbort: new AbortController(),
    enrollmentAbort: new AbortController(),
    coordinatorAbort: new AbortController(),
    storeAbort: new AbortController(),
    identityCurrent: true,
    publicCurrent: true,
    runtimeCurrent: true,
    publicIdentity: { generationId: 'current', sourceId: 'source', publicId: 'public' },
    phase: false,
    tasks: [],
    copies: [],
    borrowed: [],
    events: [],
    insideCredential: false,
    deferExit: false,
    startError: false,
    exitCode: 'RAILGUN_PROCESS_CLOSED',
    windowBudget: Infinity,
    keyMutation: () => {},
    resultMutation: () => {},
  };
  mock.scope = createPrivacyScope({
    profileId: 'output-recovery-unit',
    signal: mock.enrollmentAbort.signal,
  });
  mock.identity = { signal: mock.identityAbort.signal };
  mock.coordinator = { signal: mock.coordinatorAbort.signal };
  mock.store = {
    prepare: jest.fn(() => {
      throw Error('unexpected prepare');
    }),
    beginAttempt: jest.fn(() => {
      throw Error('unexpected attempt');
    }),
    signal: mock.storeAbort.signal,
    get: jest.fn(async () => {
      mock.events.push('store-get');
      if (mock.insideCredential) throw Error('store read inside credential');
      return copy(mock.entry);
    }),
  };
  mock.enrollment = {
    directory: '/synthetic-output-recovery-account',
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
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    archive: '/fixture-engine.asar',
    capsuleDigest: hex(1),
    signal: mock.caller.signal,
  };
  configure();
  mock.preflight = jest.fn(async () => {
    mock.events.push('preflight');
    return copy(mock.fresh);
  });
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.recoveryStart = jest.fn(async () => {});
  mock.recoveryPost = jest.fn(async () => {});
  mock.credential = jest.fn(async (use) => {
    expect(mock.phase).toBe(true);
    mock.events.push('derive');
    const key = Buffer.alloc(32, 7);
    mock.borrowed.push(key);
    mock.insideCredential = true;
    try {
      return await use({ viewingKey: key });
    } finally {
      key.fill(0);
      mock.insideCredential = false;
      mock.events.push('credential-wipe');
    }
  });
  mock.scenario = async (job) => {
    await sendKey(job);
    await sendResult(job);
  };
});
afterEach(async () => {
  mock.caller.abort();
  for (const gate of gates) gate.resolve();
  for (const task of mock.tasks) task.exit();
  await Promise.allSettled(operations);
  for (const claim of claims) claim.release();
  expect(mock.store.prepare).not.toHaveBeenCalled();
  expect(mock.store.beginAttempt).not.toHaveBeenCalled();
  mock.scope.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test.each([false, true])(
  'real binders match retained %s output without restoring broader authority',
  async (unshield) => {
    configure(unshield);
    const original = copy(mock.entry);
    const result = await run();
    expect(result).toEqual({
      status: 'matched',
      capsuleDigest: original.capsuleDigest,
      revision: 1,
      payloadSha256: original.payloadSha256,
      recoveryInputSha256: unshield ? null : sha(mock.task.options.input),
      preflightDurationMs: 0,
      viewingKeyReleases: Number(!unshield),
      viewingUtilityExitObserved: !unshield,
      outputMatched: true,
      proofVerified: false,
      originalInputReconstructed: false,
      originalRootsAccepted: false,
      membershipAuthenticated: false,
      sourceAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(mock.entry).toEqual(original);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
    expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
    expect(mock.store.get).toHaveBeenCalledTimes(5);
    expect(mock.store.get.mock.calls.every(([digest]) => digest === original.capsuleDigest)).toBe(
      true
    );
    expect(mock.store.signal.aborted).toBe(false);
    expect(mock.phase).toBe(false);
    expect(withRailgunViewingCredential).toHaveBeenCalledTimes(Number(!unshield));
    expect(startRailgunProcess).toHaveBeenCalledTimes(Number(!unshield));
    if (!unshield) {
      const job = mock.task.options;
      expect(getPrivacyContext(job.handle).subject).toMatchObject({
        kind: 'private-account',
        role: 'engine',
        operation: 'poi-output-recover',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
      });
      expect(job.filename).toBe(require.resolve('./railgun-poi-output-recover-job'));
      expect(job).toMatchObject({
        binaryKey: true,
        startupMs: 30000,
        lifetimeMs: 30000,
        heapMb: 256,
        rssMb: 512,
      });
      const input = JSON.parse(job.input);
      expect(normalizeRailgunPoiOutputRecoveryInput(input)).toEqual(input);
      expect(Object.keys(input).sort()).toEqual([
        'archive',
        'binding',
        'descriptor',
        'preparation',
      ]);
      expect(input.descriptor).toEqual(mock.enrollment.descriptor);
      expect(input.binding).toEqual({
        capsuleDigest: original.capsuleDigest,
        bindingDigest: original.bindingDigest,
        payloadSha256: original.payloadSha256,
        revision: original.revision,
      });
      expect(input.preparation.witness.checkpointIndex).toBe(4);
      expect(original.payload.txidMerklerootIndex).toBe(3);
      expect(input).not.toHaveProperty('payload');
      expect(input).not.toHaveProperty('inputSha256');
      expect(result.recoveryInputSha256).not.toBe(original.inputSha256);
      expect(mock.events.indexOf('job-exit')).toBeLessThan(mock.events.lastIndexOf('reattest'));
      expect(mock.events.indexOf('window-close')).toBeLessThan(
        mock.events.lastIndexOf('store-get')
      );
      expect(mock.copies[0]).not.toBe(mock.borrowed[0]);
      expect(mock.copies[0].every((v) => v === 0)).toBe(true);
      expect(mock.borrowed[0].every((v) => v === 0)).toBe(true);
    }
  }
);

test('same prepared record is independently recoverable twice, one viewing loan per call', async () => {
  const first = await run(),
    second = await run();
  expect(first.status).toBe('matched');
  expect(second).toEqual(first);
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(2);
  expect(startRailgunProcess).toHaveBeenCalledTimes(2);
  expect(mock.tasks[0]).not.toBe(mock.tasks[1]);
  expect(mock.entry.revision).toBe(1);
  expect(mock.copies.every((bytes) => bytes.every((v) => v === 0))).toBe(true);
});

test.each([false, true])(
  'combined payload from mocked store refuses legacy output recovery unshield=%s before keys',
  async (unshield) => {
    configure(unshield);
    changePayload((payload) => {
      payload.blindedCommitmentsOut = [prefixed(77)];
      payload.railgunTxidIfHasUnshield = '0x' + mock.fresh.witness.railgunTxid;
    });
    expect(normalizeRailgunPoiPayload(mock.entry.payload)).toEqual(mock.entry.payload);
    expect(await run()).toEqual({ status: 'refused', stage: 'binding' });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);

test.each(['store', 'record', 'payload', 'capture', 'broker', 'callback'])(
  'rejects caller-injected %s before storage or preflight',
  async (name) => {
    expect(await run({ ...options, [name]: {} })).toEqual({ status: 'refused', stage: 'context' });
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
  }
);
test.each(['identity', 'enrollment', 'coordinator', 'archive', 'capsuleDigest', 'signal'])(
  'requires exact %s option',
  async (name) => {
    const input = { ...options };
    delete input[name];
    expect(await run(input)).toEqual({ status: 'refused', stage: 'context' });
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  }
);
test.each([0, -1, 240001, 1.5, NaN, Infinity, '30000'])('rejects timeout %p', async (timeoutMs) => {
  expect(await run({ ...options, timeoutMs })).toEqual({ status: 'refused', stage: 'context' });
  expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
});
test.each(['identity', 'enrollment', 'coordinator', 'descriptor', 'aborted', 'runtime', 'context'])(
  'refuses foreign or revoked %s before key admission',
  async (kind) => {
    const input = { ...options };
    if (['identity', 'enrollment', 'coordinator'].includes(kind)) input[kind] = { ...input[kind] };
    if (kind === 'descriptor') mock.identity.descriptor.accountIndex++;
    if (kind === 'aborted') mock.caller.abort();
    if (kind === 'runtime') mock.runtimeCurrent = false;
    if (kind === 'context')
      mock.enrollment.getContext = () =>
        mock.scope.getContext({
          kind: 'private-account',
          principal: 'railgun:1',
          protocol: 'railgun',
          deployment: 'sepolia',
          chainId: 11155111,
          role: 'engine',
          operation: 'poi-output-recover',
        });
    expect(await run(input)).toEqual({ status: 'refused', stage: 'context' });
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  }
);

test.each([
  'missing',
  'attempted',
  'capsule',
  'digest',
  'payload',
  'revision-zero',
  'revision-five',
])('refuses invalid retained %s before utility launch', async (kind) => {
  if (kind === 'missing') mock.store.get.mockResolvedValue(null);
  if (kind === 'attempted') mock.entry.state = 'attempted';
  if (kind === 'capsule') mock.entry.capsuleDigest = hex(999);
  if (kind === 'digest') mock.entry.payloadSha256 = hex(999);
  if (kind === 'payload') mock.entry.payload = { invalid: true };
  if (kind === 'revision-zero') mock.entry.revision = 0;
  if (kind === 'revision-five') mock.entry.revision = 5;
  expect((await run()).status).toBe('refused');
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
});

test.each(['open', 'get'])(
  'storage busy at %s is a harmless refusal and a later attempt works',
  async (point) => {
    const method = point === 'open' ? mock.enrollment.openPoiIntents : mock.store.get;
    method.mockRejectedValueOnce(
      Object.assign(Error('busy'), { code: 'RAILGUN_POI_INTENT_STORE_BUSY' })
    );
    expect(await run()).toEqual({ status: 'refused', stage: 'stored' });
    expect(mock.store.signal.aborted).toBe(false);
    expect((await run()).status).toBe('matched');
  }
);

test.each([
  'capsule',
  'selector',
  'binding',
  'public identity',
  'anchor',
  'creator kind',
  'legacy',
  'own capsule',
  'witness',
  'row',
])('preflight %s mismatch refuses before recovery/key', async (kind) => {
  if (kind === 'capsule') mock.fresh.capture.capsuleDigest = hex(999);
  if (kind === 'selector') mock.fresh.capture.selector.position++;
  if (kind === 'binding') mock.fresh.capture.bindingDigest = hex(999);
  if (kind === 'public identity') mock.fresh.publicIdentity.generationId = 'other';
  if (kind === 'anchor') mock.fresh.observations.archiveAnchorChecked = false;
  if (kind === 'creator kind') mock.fresh.creatorClassification.type = 'Transact';
  if (kind === 'legacy') mock.fresh.creatorClassification.legacy = true;
  if (kind === 'own capsule')
    mock.fresh.poiPreparation.ownEvidence.capsule.noteHash = prefixed(999);
  if (kind === 'witness')
    mock.fresh.witness = { ...copy(mock.fresh.witness), index: mock.fresh.witness.index + 1 };
  if (kind === 'row') mock.fresh.poiPreparation.ownEvidence.row.commitments[0] = prefixed(999);
  expect(await run()).toEqual({ status: 'refused', stage: 'binding' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});

test.each(['below-leaf', 'above-checkpoint', 'marker', 'outputs', 'list-root-count', 'list-key'])(
  'saved %s refuses before keys despite coherent payload SHA',
  async (kind) => {
    changePayload((p) => {
      if (kind === 'below-leaf') p.txidMerklerootIndex = 0;
      if (kind === 'above-checkpoint') p.txidMerklerootIndex = 5;
      if (kind === 'marker') {
        p.railgunTxidIfHasUnshield = prefixed(9);
        p.blindedCommitmentsOut = [];
      }
      if (kind === 'outputs') p.blindedCommitmentsOut = [];
      if (kind === 'list-root-count') p.poiMerkleroots.push(hex(999));
      if (kind === 'list-key') p.listKey = hex(999);
    });
    expect((await run()).status).toBe('refused');
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  }
);
test.each([1, 4])(
  'saved checkpoint equality %i is allowed with original roots unchanged',
  async (index) => {
    changePayload((p) => {
      p.txidMerklerootIndex = index;
    });
    const before = copy(mock.entry);
    expect((await run()).status).toBe('matched');
    expect(mock.entry).toEqual(before);
  }
);
test.each(['marker', 'output'])(
  'unshield %s substitution refuses with zero utility/key calls',
  async (kind) => {
    configure(true);
    changePayload((p) => {
      if (kind === 'marker') p.railgunTxidIfHasUnshield = prefixed(999);
      else {
        p.railgunTxidIfHasUnshield = '0x00';
        p.blindedCommitmentsOut = [prefixed(22)];
      }
    });
    expect((await run()).status).toBe('refused');
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  }
);

test('expected preflight refusal is sanitized and performs no recovery or credential work', async () => {
  mock.preflight.mockResolvedValue({ status: 'refused', stage: 'source' });
  expect(await run()).toEqual({ status: 'refused', stage: 'preflight:source' });
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
});
test.each([2, 3, 4, 5])(
  'changed stored revision on read %i refuses at each asynchronous recheck',
  async (read) => {
    let reads = 0;
    mock.store.get.mockImplementation(async () => {
      if (++reads === read) mock.entry.revision++;
      return copy(mock.entry);
    });
    expect((await run()).status).toBe('refused');
    expect(reads).toBe(read);
    expect(withRailgunViewingCredential).toHaveBeenCalledTimes(read >= 4 ? 1 : 0);
    expect(mock.store.signal.aborted).toBe(false);
  }
);
test('a new proof/payload with the same revision is detected by exact final snapshot', async () => {
  mock.recoveryPost.mockImplementation(async () => {
    changePayload((p) => {
      p.proof.pi_a[0] = '99';
    });
  });
  expect((await run()).status).toBe('refused');
  expect(mock.events).toContain('job-exit');
});
test.each(['binding', 'archive-anchor'])(
  'current recovery capture %s must equal fresh preflight',
  async (kind) => {
    if (kind === 'binding') mock.capture.bindingDigest = hex(999);
    else {
      mock.capture.record.archivedAt = 1;
      mock.capture.record.finalized = { number: 999, hash: prefixed(999) };
    }
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);
test.each([1, 2, 3, 4])(
  'account drift on reattestation %i refuses and wipes any released copy',
  async (at) => {
    let reads = 0;
    mock.reattest.mockImplementation(async () => {
      const fresh = copy(mock.capture);
      if (++reads === at) fresh.projection.blockHash = prefixed(999);
      return fresh;
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(reads).toBe(at);
    expect(mock.copies.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(mock.store.signal.aborted).toBe(false);
  }
);

test.each(['id', 'method', 'purpose', 'hash', 'extra', 'binary-shape'])(
  'bad credential request %s refuses without deriving',
  async (kind) => {
    mock.keyMutation = (m) => {
      if (kind === 'id') m.id = 2;
      if (kind === 'method') m.method = 'derive';
      if (kind === 'purpose') m.purpose = 'poi-prove';
      if (kind === 'hash') m.inputSha256 = hex(999);
      if (kind === 'extra') m.privateKey = true;
      if (kind === 'binary-shape') m.binary = true;
    };
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(mock.events).toContain('job-exit');
    expect(mock.store.signal.aborted).toBe(false);
  }
);
test.each(['before-key', 'duplicate-key', 'duplicate-result', 'key-only', 'empty-ready'])(
  'out-of-order utility %s cannot produce a matched diagnostic',
  async (kind) => {
    mock.scenario = async (job) => {
      if (kind === 'empty-ready') return;
      if (kind === 'before-key') {
        await sendResult(job);
        return;
      }
      await sendKey(job);
      if (kind === 'duplicate-key') {
        await sendKey(job);
        return;
      }
      if (kind === 'key-only') return;
      await sendResult(job);
      await sendResult(job);
    };
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(withRailgunViewingCredential).toHaveBeenCalledTimes(
      ['before-key', 'empty-ready'].includes(kind) ? 0 : 1
    );
    expect(mock.copies.every((b) => b.every((v) => v === 0))).toBe(true);
  }
);

test('concurrent duplicate key aborts while the reserved first request is still reattesting', async () => {
  const gate = deferred(),
    entered = deferred();
  let reads = 0;
  mock.reattest.mockImplementation(async () => {
    if (++reads === 2) {
      entered.resolve();
      await gate.promise;
    }
    return copy(mock.capture);
  });
  const work = run();
  await entered.promise;
  const job = mock.task.options;
  await expect(sendKey(job)).rejects.toThrow();
  expect(job.broker.signal.aborted).toBe(true);
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(mock.phase).toBe(true);
  expect(await run({ ...options, signal: new AbortController().signal })).toEqual({
    status: 'refused',
    stage: 'context',
  });
  gate.resolve();
  expect((await work).status).toBe('refused');
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(mock.copies).toHaveLength(0);
});

test.each([
  'wire-hash',
  'payload-hash',
  'engine',
  'output',
  'output-zero',
  'output-shape',
  'marker',
  'secret',
  'outer-secret',
  'proof',
  'source',
  'membership',
  'root',
  'disclosure',
  'spending',
  'guards-attempt',
  'guards-count',
  'guards-duplicate',
  'guards-name',
  'guards-empty',
  'guards-extra',
])('result %s substitution refuses, closes child and wipes the key copy', async (kind) => {
  mock.resultMutation = (m) => {
    const v = m.value;
    if (kind === 'wire-hash') v.recoveryInputSha256 = hex(999);
    if (kind === 'payload-hash') v.payloadSha256 = hex(999);
    if (kind === 'engine') v.engineSha256 = hex(999);
    if (kind === 'output') v.output.blindedCommitmentsOut = [prefixed(999)];
    if (kind === 'output-zero') v.output.blindedCommitmentsOut = [prefixed(0)];
    if (kind === 'output-shape') v.output.blindedCommitmentsOut.push(prefixed(23));
    if (kind === 'marker') v.output.railgunTxidIfHasUnshield = prefixed(9);
    if (kind === 'secret') v.viewingKey = 'private fixture secret';
    if (kind === 'outer-secret') m.privateWitness = {};
    if (kind === 'proof') v.proofVerified = true;
    if (kind === 'source') v.sourceAuthenticated = true;
    if (kind === 'membership') v.membershipAuthenticated = true;
    if (kind === 'root') v.rootAccepted = true;
    if (kind === 'disclosure') v.disclosureEnabled = true;
    if (kind === 'spending') v.spendingEnabled = true;
    if (kind === 'guards-attempt') v.guards.attempts = 1;
    if (kind === 'guards-count') v.guards.canaries++;
    if (kind === 'guards-duplicate') {
      v.guards.hooks.push('fixture.guard');
      v.guards.canaries++;
    }
    if (kind === 'guards-name') v.guards.hooks = ['../invalid'];
    if (kind === 'guards-empty') {
      v.guards.hooks = [];
      v.guards.canaries = 0;
    }
    if (kind === 'guards-extra') v.guards.secret = 'private';
  };
  expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
  expect(mock.events).toContain('job-exit');
  expect(mock.copies).toHaveLength(1);
  expect(mock.copies[0].every((v) => v === 0)).toBe(true);
  expect(mock.borrowed[0].every((v) => v === 0)).toBe(true);
});
test.each(['oversized', 'invalid-json', 'object'])(
  'malformed %s broker wire refuses before key',
  async (kind) => {
    mock.scenario = async (job) =>
      job.broker.dispatch(
        kind === 'oversized' ? ' '.repeat(16385) : kind === 'invalid-json' ? '{' : keyWire(job)
      );
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  }
);
test.each(['start', 'exit'])('utility %s failure cannot be promoted to success', async (where) => {
  if (where === 'start') mock.startError = true;
  else mock.exitCode = 'RAILGUN_PROCESS_MEMORY_LIMIT';
  expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
  expect(mock.store.signal.aborted).toBe(false);
  expect(mock.phase).toBe(false);
});
test.each([31, 33, 0])(
  'viewing credential length %i refuses and wipes borrowed bytes',
  async (length) => {
    let borrowed;
    mock.credential.mockImplementation(async (use) => {
      borrowed = Buffer.alloc(length, 7);
      try {
        return await use({ viewingKey: borrowed });
      } finally {
        borrowed.fill(0);
      }
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(mock.copies).toHaveLength(0);
    expect(borrowed.every((v) => v === 0)).toBe(true);
  }
);

test('no store read occurs during the credential callback despite repeated account reattestation', async () => {
  let before, after;
  const credential = mock.credential.getMockImplementation();
  mock.credential.mockImplementation(async (use) =>
    credential(async (loan) => {
      before = mock.store.get.mock.calls.length;
      const result = await use(loan);
      after = mock.store.get.mock.calls.length;
      return result;
    })
  );
  expect((await run()).status).toBe('matched');
  expect(before).toBe(3);
  expect(after).toBe(before);
  expect(mock.window.reattest).toHaveBeenCalledTimes(4);
});

test.each(['identity', 'descriptor', 'public-generation', 'coordinator', 'enrollment', 'store'])(
  'revoked %s before credential copy refuses and wipes borrowed key',
  async (kind) => {
    let reads = 0;
    mock.reattest.mockImplementation(async () => {
      if (++reads === 3) {
        if (kind === 'identity') mock.identityCurrent = false;
        if (kind === 'descriptor') mock.identity.descriptor.accountIndex++;
        if (kind === 'public-generation') mock.publicIdentity.generationId = 'replaced';
        if (kind === 'coordinator') mock.coordinatorAbort.abort();
        if (kind === 'enrollment') mock.enrollmentAbort.abort();
        if (kind === 'store') mock.storeAbort.abort();
      }
      return copy(mock.capture);
    });
    expect((await run()).status).toBe('refused');
    expect(withRailgunViewingCredential).toHaveBeenCalledTimes(1);
    expect(mock.copies).toHaveLength(0);
    expect(mock.borrowed[0].every((v) => v === 0)).toBe(true);
    expect(mock.events).toContain('job-exit');
  }
);
test.each(['identity', 'public-generation', 'record', 'account'])(
  'final %s recheck after utility exit refuses late changes',
  async (kind) => {
    mock.recoveryPost.mockImplementation(async () => {
      if (kind === 'identity') mock.identityCurrent = false;
      if (kind === 'public-generation') mock.publicIdentity.generationId = 'later';
      if (kind === 'record') mock.entry.bindingDigest = hex(999);
      if (kind === 'account') throw Error('private final attestation');
    });
    expect((await run()).status).toBe('refused');
    expect(mock.events).toContain('job-exit');
    expect(mock.phase).toBe(false);
    expect(mock.store.signal.aborted).toBe(false);
  }
);

test('directory ownership is held while preflight ignores cancellation', async () => {
  const gate = deferred(),
    entered = deferred();
  mock.preflight.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return copy(mock.fresh);
  });
  const work = run();
  await entered.promise;
  mock.caller.abort();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  const freshSignal = new AbortController().signal;
  expect(await run({ ...options, signal: freshSignal })).toEqual({
    status: 'refused',
    stage: 'context',
  });
  expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
  expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
  gate.resolve();
  expect((await work).status).toBe('refused');
  expect((await run({ ...options, signal: freshSignal })).status).toBe('matched');
});

test.each(['derivation', 'pre-key-reattest', 'credential-reattest'])(
  'abort drains ignored %s after child exit before releasing recovery or owner',
  async (where) => {
    const gate = deferred(),
      entered = deferred();
    if (where === 'derivation') {
      const credential = mock.credential.getMockImplementation();
      mock.credential.mockImplementationOnce(async (use) => {
        entered.resolve();
        await gate.promise;
        return credential(use);
      });
    } else {
      let reads = 0;
      mock.reattest.mockImplementation(async () => {
        if (++reads === (where === 'pre-key-reattest' ? 2 : 3)) {
          entered.resolve();
          await gate.promise;
        }
        return copy(mock.capture);
      });
    }
    const work = run();
    await entered.promise;
    mock.caller.abort();
    await waitFor(() => mock.events.includes('job-exit'));
    let settled = false;
    work.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mock.phase).toBe(true);
    expect(mock.window.signal.aborted).toBe(true);
    const freshSignal = new AbortController().signal;
    expect(await run({ ...options, signal: freshSignal })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(startRailgunProcess).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await work).status).toBe('refused');
    expect(mock.phase).toBe(false);
    expect(mock.copies).toHaveLength(0);
    expect(mock.borrowed.every((b) => b.every((v) => v === 0))).toBe(true);
    expect(mock.store.signal.aborted).toBe(false);
    expect((await run({ ...options, signal: freshSignal })).status).toBe('matched');
  }
);

test('aborted successful-result attempt retains owner and window until deferred child exit', async () => {
  mock.deferExit = true;
  const work = run();
  await waitFor(() => mock.task?.close.mock.calls.length > 0);
  expect(mock.events).toContain('result');
  mock.caller.abort();
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mock.phase).toBe(true);
  expect(mock.task.options.broker.signal.aborted).toBe(true);
  expect(await run({ ...options, signal: new AbortController().signal })).toEqual({
    status: 'refused',
    stage: 'context',
  });
  mock.task.exit();
  expect((await work).status).toBe('refused');
  expect(mock.phase).toBe(false);
  expect(mock.copies[0].every((v) => v === 0)).toBe(true);
});

test.each(['store-read', 'final-reattest', 'outer-recovery'])(
  'cancellation retains owner through deferred %s cleanup',
  async (where) => {
    const gate = deferred(),
      entered = deferred();
    if (where === 'store-read') {
      let reads = 0;
      mock.store.get.mockImplementation(async () => {
        if (++reads === 4) {
          entered.resolve();
          await gate.promise;
        }
        return copy(mock.entry);
      });
    }
    if (where === 'final-reattest') {
      let reads = 0;
      mock.reattest.mockImplementation(async () => {
        if (++reads === 4) {
          entered.resolve();
          await gate.promise;
        }
        return copy(mock.capture);
      });
    }
    if (where === 'outer-recovery')
      mock.recoveryPost.mockImplementation(async () => {
        entered.resolve();
        await gate.promise;
      });
    const work = run();
    await entered.promise;
    expect(mock.events).toContain('job-exit');
    mock.caller.abort();
    expect(await run({ ...options, signal: new AbortController().signal })).toEqual({
      status: 'refused',
      stage: 'context',
    });
    expect(mock.phase).toBe(true);
    gate.resolve();
    expect((await work).status).toBe('refused');
    expect(mock.store.signal.aborted).toBe(false);
  }
);

test('insufficient recovery cleanup budget refuses before child startup with healthy stores', async () => {
  expect(await run({ ...options, timeoutMs: 7000 })).toEqual({
    status: 'refused',
    stage: 'recovery',
  });
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(mock.store.signal.aborted).toBe(false);
});
test('job with less than five seconds of admission margin refuses before derivation', async () => {
  expect(await run({ ...options, timeoutMs: 10000 })).toEqual({
    status: 'refused',
    stage: 'recovery:callback',
  });
  expect(startRailgunProcess).toHaveBeenCalledTimes(1);
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(mock.store.signal.aborted).toBe(false);
});
test.each([25000, 25001])(
  'admission equality or shortage at %i ms refuses after pre-key reattestation',
  async (elapsed) => {
    let reads = 0;
    mock.reattest.mockImplementation(async () => {
      if (++reads === 2) jest.advanceTimersByTime(elapsed);
      return copy(mock.capture);
    });
    expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(mock.store.signal.aborted).toBe(false);
  }
);
test('admission margin is checked again inside credential callback before copying', async () => {
  let reads = 0;
  mock.reattest.mockImplementation(async () => {
    if (++reads === 3) jest.advanceTimersByTime(25000);
    return copy(mock.capture);
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(1);
  expect(mock.copies).toHaveLength(0);
  expect(mock.borrowed[0].every((v) => v === 0)).toBe(true);
});
test('shorter real recovery-window deadline governs key admission', async () => {
  mock.windowBudget = 10000;
  expect(await run()).toEqual({ status: 'refused', stage: 'recovery:callback' });
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(mock.store.signal.aborted).toBe(false);
});

test('early job timer revokes at its exact budget and drains ignored derivation with healthy recovery stores', async () => {
  const gate = deferred(),
    entered = deferred();
  const credential = mock.credential.getMockImplementation();
  mock.credential.mockImplementationOnce(async (use) => {
    entered.resolve();
    await gate.promise;
    return credential(use);
  });
  const work = run();
  await entered.promise;
  const job = mock.task.options;
  jest.advanceTimersByTime(job.lifetimeMs - 1);
  expect(job.broker.signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  expect(job.broker.signal.aborted).toBe(true);
  await waitFor(() => mock.events.includes('job-exit'));
  expect(mock.phase).toBe(true);
  expect(mock.store.signal.aborted).toBe(false);
  expect(await run({ ...options, signal: new AbortController().signal })).toEqual({
    status: 'refused',
    stage: 'context',
  });
  gate.resolve();
  expect((await work).status).toBe('refused');
  expect(mock.copies).toHaveLength(0);
  expect(mock.phase).toBe(false);
  expect(mock.store.signal.aborted).toBe(false);
});
test('elapsed total deadline is checked even without timer dispatch', async () => {
  mock.preflight.mockImplementationOnce(async () => {
    jest.spyOn(performance, 'now').mockReturnValue(240000);
    return copy(mock.fresh);
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'preflight' });
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test('monotonic clock regression cannot extend the controller lifetime', async () => {
  jest.advanceTimersByTime(10);
  mock.preflight.mockImplementationOnce(async () => {
    jest.spyOn(performance, 'now').mockReturnValue(9);
    return copy(mock.fresh);
  });
  expect(await run()).toEqual({ status: 'refused', stage: 'preflight' });
  expect(startRailgunProcess).not.toHaveBeenCalled();
});

describe.each(['malformed-key', 'early-result'])('sticky %s protocol refusal', (fault) => {
  test.each(['same tick', 'next tick'])(
    'blocks a subsequent valid key in the %s',
    async (timing) => {
      const driven = deferred();
      let outcomes, signalAbortedAtRetry;
      mock.scenario = async (job) => {
        try {
          const message =
            fault === 'early-result' ? resultWire(job) : { ...keyWire(job), extra: true };
          const bad = job.broker.dispatch(JSON.stringify(message));
          // Observe rejection immediately without waiting for the supervisor.
          const observedBad = bad.then(
            () => 'accepted',
            () => 'refused'
          );
          if (timing === 'next tick') await Promise.resolve();
          signalAbortedAtRetry = job.broker.signal.aborted;
          const valid = sendKey(job).then(
            () => 'accepted',
            () => 'refused'
          );
          outcomes = await Promise.all([observedBad, valid]);
        } finally {
          driven.resolve();
        }
      };
      const result = await run();
      await driven.promise;
      expect(result).toEqual({ status: 'refused', stage: 'recovery:callback' });
      expect(signalAbortedAtRetry).toBe(true);
      expect(outcomes).toEqual(['refused', 'refused']);
      expect(withRailgunViewingCredential).not.toHaveBeenCalled();
      expect(mock.copies).toHaveLength(0);
      expect(mock.phase).toBe(false);
      expect(mock.store.signal.aborted).toBe(false);
    }
  );
});

test('malformed traffic during ignored derivation prevents late key copy and retains owner after child exit', async () => {
  const gate = deferred(),
    entered = deferred();
  const credential = mock.credential.getMockImplementation();
  mock.credential.mockImplementationOnce(async (use) => {
    entered.resolve();
    await gate.promise;
    return credential(use);
  });
  const work = run();
  await entered.promise;
  const job = mock.task.options;
  await expect(job.broker.dispatch(JSON.stringify({ id: 999, method: 'key' }))).rejects.toThrow();
  expect(job.broker.signal.aborted).toBe(true);
  await waitFor(() => mock.events.includes('job-exit'));
  await expect(job.broker.dispatch(JSON.stringify(keyWire(job)))).rejects.toThrow();
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(1);
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mock.phase).toBe(true);
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  gate.resolve();
  expect((await work).status).toBe('refused');
  expect(mock.copies).toHaveLength(0);
  expect(mock.borrowed[0].every((v) => v === 0)).toBe(true);
  expect(mock.phase).toBe(false);
  expect((await run()).status).toBe('matched');
});

test('extra traffic after accepted result aborts admission while actual child exit is deferred', async () => {
  mock.deferExit = true;
  const work = run();
  await waitFor(() => mock.task?.close.mock.calls.length > 0);
  const job = mock.task.options;
  expect(mock.events).toContain('result');
  const copies = mock.copies.length;
  await expect(
    job.broker.dispatch(JSON.stringify({ id: 3, method: 'result', value: null }))
  ).rejects.toThrow();
  expect(job.broker.signal.aborted).toBe(true);
  await expect(job.broker.dispatch(JSON.stringify(keyWire(job)))).rejects.toThrow();
  expect(mock.copies).toHaveLength(copies);
  expect(withRailgunViewingCredential).toHaveBeenCalledTimes(1);
  expect(mock.phase).toBe(true);
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  mock.task.exit();
  expect((await work).status).toBe('refused');
  expect(mock.copies[0].every((v) => v === 0)).toBe(true);
  expect(mock.phase).toBe(false);
});

test('a valid result cannot finish recovery before successful child exit is observed', async () => {
  mock.deferExit = true;
  const work = run();
  await waitFor(() => mock.task?.close.mock.calls.length > 0);
  let settled = false;
  work.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(mock.phase).toBe(true);
  expect(mock.events).not.toContain('window-close');
  expect(await run()).toEqual({ status: 'refused', stage: 'context' });
  mock.task.exit();
  expect((await work).status).toBe('matched');
  expect(mock.phase).toBe(false);
});

test.each([2, 3, 4, 5])(
  'unshield stored revision drift at read %i also refuses without credentials',
  async (at) => {
    configure(true);
    let reads = 0;
    mock.store.get.mockImplementation(async () => {
      if (++reads === at) mock.entry.revision++;
      return copy(mock.entry);
    });
    expect((await run()).status).toBe('refused');
    expect(reads).toBe(at);
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(mock.store.signal.aborted).toBe(false);
  }
);

test.each([false, true])(
  'valid attempted %s record refuses before all preflight, key and utility work',
  async (unshield) => {
    configure(unshield);
    const attemptedAt = 1791111111111;
    const submission = require('./railgun-poi-submit-data').prepareRailgunPoiSubmission({
      payload: mock.entry.payload,
      requestId: attemptedAt,
    });
    mock.entry = { ...mock.entry, state: 'attempted', attempt: { attemptedAt, submission } };
    const stored = JSON.stringify(mock.entry);
    for (let read = 0; read < 2; read++) {
      // A freshly detached decrypted read has the same refusal, without relying on
      // object identity or a live proof receipt. Actual reopen is a native fixture.
      mock.entry = JSON.parse(stored);
      expect(await run()).toEqual({ status: 'refused', stage: 'stored' });
    }
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(mock.credential).not.toHaveBeenCalled();
    expect(mock.store.signal.aborted).toBe(false);
    expect(JSON.stringify(mock.entry)).toBe(stored);
  }
);

test('missing existing-only POI storage refuses output recovery before preflight, keys or utility', async () => {
  mock.enrollment.openPoiIntents.mockRejectedValueOnce(
    Object.assign(Error('missing retained storage'), { code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED' })
  );
  expect((await run()).status).toBe('refused');
  expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
  expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
  expect(mock.store.get).not.toHaveBeenCalled();
  expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
  expect((await run()).status).toBe('matched');
});

const runCompleted = (input = { ...options, sourceDestination: mock.destination }) => {
  const work = recoverRailgunPoiOutputCompleted(input);
  operations.push(work);
  return work;
};
test.each([false, true])(
  'completed output recovery %s chooses the fixed preflight with exact destination',
  async (unshield) => {
    configure(unshield);
    const result = await runCompleted();
    expect(result.status).toBe('matched');
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0]).toMatchObject({
      sourceDestination: mock.destination,
      coordinator: mock.coordinator,
      enrollment: mock.enrollment,
    });
    expect(result).toMatchObject({
      sourceAuthenticated: false,
      spendingEnabled: false,
      disclosureEnabled: false,
    });
    expect(withRailgunViewingCredential).toHaveBeenCalledTimes(unshield ? 0 : 1);
  }
);
test.each([undefined, null, {}])(
  'completed output refuses copied/absent destination %# before preflight/key/utility',
  async (sourceDestination) => {
    expect((await runCompleted({ ...options, sourceDestination })).status).toBe('refused');
    expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  }
);
test.each([false, true])(
  'completed output propagates preflight fatal=%s diagnostic without key work',
  async (fatal) => {
    const sourceOutcome = Object.freeze({
      fatal,
      reason: fatal ? 'fatal' : 'prefix-unavailable',
      rpcFailure: fatal ? 'response' : null,
    });
    mock.preflight.mockResolvedValueOnce({
      status: 'refused',
      stage: 'source:snapshot',
      sourceOutcome,
    });
    expect(await runCompleted()).toMatchObject({ status: 'refused', sourceOutcome });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);
test('cancelled completed preflight is drained and late fatal diagnostic survives before any key admission', async () => {
  const gate = deferred();
  const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
  mock.preflight.mockImplementationOnce(async () => {
    await gate.promise;
    return { status: 'refused', stage: 'source:snapshot', sourceOutcome };
  });
  let settled = false;
  const pending = runCompleted().then((result) => {
    settled = true;
    return result;
  });
  await waitFor(() => preflightRailgunRetainedPoiCompleted.mock.calls.length === 1);
  mock.caller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(
    (
      await runCompleted({
        ...options,
        sourceDestination: mock.destination,
        signal: new AbortController().signal,
      })
    ).status
  ).toBe('refused');
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  gate.resolve();
  expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
  expect(withRailgunViewingCredential).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test.each(['stored-read', 'preflight', 'final-reattest'])(
  'completed destination replacement at %s invalidates recovery',
  async (boundary) => {
    const target =
      boundary === 'stored-read'
        ? mock.store.get
        : boundary === 'preflight'
          ? mock.preflight
          : mock.reattest;
    const original = target.getMockImplementation();
    target.mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      mock.destination = Object.freeze({});
      return value;
    });
    expect((await runCompleted()).status).toBe('refused');
    if (boundary !== 'final-reattest') {
      expect(withRailgunViewingCredential).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
    }
  }
);
test('completed output does not trust copied outcome properties on an arbitrary thrown exception', async () => {
  mock.preflight.mockRejectedValueOnce(
    Object.assign(Error('private'), {
      sourceOutcome: { fatal: false, reason: 'cancelled', rpcFailure: null },
    })
  );
  const result = await runCompleted();
  expect(result.status).toBe('refused');
  expect(result.sourceOutcome).toBeUndefined();
  expect(startRailgunProcess).not.toHaveBeenCalled();
});
test('completed output reduces preflight budget by elapsed retained-store work', async () => {
  const original = mock.store.get.getMockImplementation();
  mock.store.get.mockImplementationOnce(async (...args) => {
    jest.advanceTimersByTime(10000);
    return original(...args);
  });
  expect(
    (await runCompleted({ ...options, sourceDestination: mock.destination, timeoutMs: 240000 }))
      .status
  ).toBe('matched');
  expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(
    230000
  );
  expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
});

describe('fixed submission output core', () => {
  let handoff;
  const submit = (input = handoff, supplied = options) => {
    const work = recoverRailgunPoiOutputForSubmission(
      { ...supplied, sourceDestination: mock.destination },
      input
    );
    operations.push(work);
    return work;
  };
  function prepare(unshield = false) {
    configure(unshield);
    const evidence = sample(unshield);
    handoff = {
      entry: copy(mock.entry),
      capture: copy(mock.capture),
      observation: {
        transaction: copy(evidence.transaction),
        receipt: copy(evidence.receipt),
        captureBindingDigest: mock.capture.bindingDigest,
      },
    };
  }
  beforeEach(() => prepare());
  test.each([false, true])(
    'only fixed preflight receives detached receipt data, kind %s',
    async (unshield) => {
      prepare(unshield);
      expect((await submit()).status).toBe('matched');
      expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
      expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
      expect(preflightRailgunRetainedPoiForSubmission).toHaveBeenCalledTimes(1);
      const [supplied, privateInput] = preflightRailgunRetainedPoiForSubmission.mock.calls[0];
      expect(supplied.sourceDestination).toBe(mock.destination);
      expect(privateInput).toEqual(handoff);
      expect(privateInput).not.toBe(handoff);
      expect(privateInput.observation).not.toBe(handoff.observation);
      expect(mock.credential).toHaveBeenCalledTimes(unshield ? 0 : 1);
    }
  );
  test.each([undefined, null, false, {}])(
    'missing input %p refuses without ordinary preflight',
    async (input) => {
      expect(
        (
          await recoverRailgunPoiOutputForSubmission(
            { ...options, sourceDestination: mock.destination },
            input
          )
        ).status
      ).toBe('refused');
      expect(mock.preflight).not.toHaveBeenCalled();
      expect(mock.credential).not.toHaveBeenCalled();
    }
  );
  test.each(['revision', 'payloadSha256', 'extra'])(
    'requires exact stored handoff %s before preflight',
    async (field) => {
      if (field === 'revision') handoff.entry.revision++;
      if (field === 'payloadSha256') handoff.entry.payloadSha256 = hex(99);
      if (field === 'extra') handoff.observed = true;
      expect((await submit()).status).toBe('refused');
      expect(mock.preflight).not.toHaveBeenCalled();
      expect(mock.credential).not.toHaveBeenCalled();
    }
  );
  test.each(['facts', 'projection', 'archived-anchor'])(
    'fresh preflight %s drift refuses before keys',
    async (field) => {
      // Replace rather than mutate a previously frozen preflight value.
      const changed = copy(mock.fresh);
      if (field === 'archived-anchor') changed.capture.record = sample(false, true).record;
      else changed.capture[field] = { changed: true };
      mock.preflight.mockResolvedValue(changed);
      expect((await submit()).status).toBe('refused');
      expect(preflightRailgunRetainedPoiForSubmission).toHaveBeenCalledTimes(1);
      expect(mock.credential).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
    }
  );
  test('copies internal handoff before asynchronous store open', async () => {
    const gate = deferred(),
      baseline = copy(handoff);
    mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
      await gate.promise;
      return mock.store;
    });
    const pending = submit();
    await waitFor(() => mock.enrollment.openPoiIntents.mock.calls.length === 1);
    handoff.entry.revision++;
    handoff.capture.facts = { changed: true };
    handoff.observation.transaction.hash = prefixed(99);
    gate.resolve();
    expect((await pending).status).toBe('matched');
    expect(preflightRailgunRetainedPoiForSubmission.mock.calls[0][1]).toEqual(baseline);
  });
  test('late failed preflight drains, retains exclusion and preserves genuine inner outcome after abort', async () => {
    const gate = deferred();
    const sourceOutcome = Object.freeze({ fatal: true, reason: 'rpc', rpcFailure: 'response' });
    mock.preflight.mockImplementationOnce(async () => {
      await gate.promise;
      return { status: 'refused', stage: 'source', sourceOutcome };
    });
    let settled = false;
    const pending = submit().then((value) => {
      settled = true;
      return value;
    });
    await waitFor(() => mock.preflight.mock.calls.length === 1);
    mock.caller.abort();
    expect(
      (await submit(handoff, { ...options, signal: new AbortController().signal })).status
    ).toBe('refused');
    expect(mock.preflight).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    gate.resolve();
    expect(await pending).toMatchObject({ status: 'refused', sourceOutcome });
    expect(mock.credential).not.toHaveBeenCalled();
    expect(
      (await submit(handoff, { ...options, signal: new AbortController().signal })).status
    ).toBe('matched');
  });
  test('late completed result cannot authorize key release after cancellation', async () => {
    const gate = deferred();
    mock.preflight.mockImplementationOnce(async () => {
      await gate.promise;
      return copy(mock.fresh);
    });
    const pending = submit();
    await waitFor(() => mock.preflight.mock.calls.length === 1);
    mock.caller.abort();
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mock.credential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
  });
  test('ordinary output ignores an extra positional handoff and uses completed retained preflight', async () => {
    expect((await recoverRailgunPoiOutput(options, handoff)).status).toBe('matched');
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(preflightRailgunRetainedPoiForSubmission).not.toHaveBeenCalled();
  });
});

const attemptRecord = () => {
  const attemptedAt = 1791111111111;
  const submission = require('./railgun-poi-submit-data').prepareRailgunPoiSubmission({
    payload: mock.entry.payload,
    requestId: attemptedAt,
  });
  mock.entry = copy({ ...mock.entry, state: 'attempted', attempt: { attemptedAt, submission } });
};
const runAttempted = (input = options) => {
  const work = recoverRailgunAttemptedPoiOutput(input);
  operations.push(work);
  return work;
};
const sharedClaim = (changes = {}) => {
  const claim = require('./railgun-poi-disclosure-plan').claimRailgunAttemptedPoiOutput({
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    signal: new AbortController().signal,
    ...changes,
  });
  claims.push(claim);
  return claim;
};
describe('attempted-only retained output recovery', () => {
  beforeEach(() => attemptRecord());
  test.each([false, true])(
    'matches fresh %s output and preserves exact attempted state without authority',
    async (unshield) => {
      configure(unshield);
      attemptRecord();
      const entry = JSON.stringify(mock.entry);
      const result = await runAttempted();
      expect(result).toEqual({
        status: 'matched',
        recordState: 'attempted',
        attemptBodySha256: mock.entry.attempt.submission.bodySha256,
        capsuleDigest: options.capsuleDigest,
        revision: 1,
        payloadSha256: mock.entry.payloadSha256,
        recoveryInputSha256: unshield ? null : sha(mock.task.options.input),
        preflightDurationMs: 0,
        viewingKeyReleases: Number(!unshield),
        viewingUtilityExitObserved: !unshield,
        outputMatched: true,
        proofVerified: false,
        originalInputReconstructed: false,
        originalRootsAccepted: false,
        membershipAuthenticated: false,
        sourceAuthenticated: false,
        disclosureEnabled: false,
        spendingEnabled: false,
        submissionAccepted: false,
        attemptOutcomeKnown: false,
        eligibilityEstablished: false,
        retryEnabled: false,
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(mock.entry)).toBe(entry);
      expect(mock.enrollment.openPoiIntents).toHaveBeenCalledWith({ existingOnly: true });
      expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
      expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].sourceDestination).toBe(
        mock.destination
      );
      expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
      expect(preflightRailgunRetainedPoiForSubmission).not.toHaveBeenCalled();
      expect(withRailgunViewingCredential).toHaveBeenCalledTimes(Number(!unshield));
      expect(mock.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(mock.copies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      if (!unshield) {
        expect(mock.events).toContain('job-exit');
        expect(mock.task.options.input).not.toContain('"blindedCommitmentsOut"');
        expect(mock.task.options.input).not.toContain('"payload"');
        expect(mock.task.options.input).not.toContain(JSON.stringify(mock.entry.payload.proof));
      }
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
  test.each(['prepared', 'missing', 'unknown'])(
    '%s state refuses before preflight and releases its temporary shared claim',
    async (state) => {
      if (state === 'missing') mock.entry = null;
      else mock.entry.state = state;
      expect(await runAttempted()).toEqual({ status: 'refused', stage: 'stored' });
      expect(mock.preflight).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
      expect(withRailgunViewingCredential).not.toHaveBeenCalled();
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
  test.each([
    'sourceDestination',
    'reader',
    'observation',
    'entry',
    'payload',
    'selector',
    'state',
    'transport',
    'review',
    'approved',
    'proverArchive',
    'artifactDirectory',
  ])('%s caller override is refused before storage and cannot grant access', async (key) => {
    expect((await runAttempted({ ...options, [key]: {} })).status).toBe('refused');
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(sharedClaim().assertCurrent()).toBeUndefined();
  });
  test.each([
    'id',
    'body',
    'body-sha',
    'payload-sha',
    'payload',
    'endpoint',
    'extra',
    'missing',
    'revision',
  ])('invalid attempted %s binding refuses before preflight', async (field) => {
    const attempt = mock.entry.attempt;
    if (field === 'id') attempt.attemptedAt++;
    if (field === 'body') attempt.submission.body += ' ';
    if (field === 'body-sha') attempt.submission.bodySha256 = hex(999);
    if (field === 'payload-sha') attempt.submission.payloadSha256 = hex(999);
    if (field === 'payload') {
      changePayload((payload) => {
        payload.proof.pi_a[0] = '9';
      });
    }
    if (field === 'endpoint') attempt.submission.endpoint = 'https://different.invalid';
    if (field === 'extra') attempt.extra = true;
    if (field === 'missing') mock.entry.attempt = undefined;
    if (field === 'revision') mock.entry.revision = 0;
    expect(await runAttempted()).toEqual({ status: 'refused', stage: 'stored' });
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sharedClaim().assertCurrent()).toBeUndefined();
  });
  test.each([false, true])(
    'coherently wrong %s retained output still fails independent reconstruction',
    async (unshield) => {
      configure(unshield);
      changePayload((payload) => {
        if (unshield) payload.railgunTxidIfHasUnshield = prefixed(999);
        else payload.blindedCommitmentsOut = [prefixed(999)];
      });
      attemptRecord();
      const original = JSON.stringify(mock.entry);
      expect((await runAttempted()).status).toBe('refused');
      expect(mock.preflight).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mock.entry)).toBe(original);
      expect(withRailgunViewingCredential).toHaveBeenCalledTimes(Number(!unshield));
    }
  );
  test.each([2, 3, 4, 5])(
    'readback %i detects a coherently replaced canonical attempt envelope',
    async (at) => {
      let count = 0;
      mock.store.get.mockImplementation(async () => {
        if (++count === at) {
          const attemptedAt = mock.entry.attempt.attemptedAt + 1;
          mock.entry.attempt = copy({
            attemptedAt,
            submission: require('./railgun-poi-submit-data').prepareRailgunPoiSubmission({
              payload: mock.entry.payload,
              requestId: attemptedAt,
            }),
          });
        }
        return copy(mock.entry);
      });
      expect((await runAttempted()).status).toBe('refused');
      expect(count).toBe(at);
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
  test.each(['prepared', 'completed', 'submission'])(
    '%s route continues to reject attempted entries before any preflight',
    async (route) => {
      let work;
      if (route === 'prepared') work = run();
      else if (route === 'completed') work = runCompleted();
      else {
        work = recoverRailgunPoiOutputForSubmission(
          { ...options, sourceDestination: mock.destination },
          { entry: copy(mock.entry), capture: copy(mock.capture), observation: {} }
        );
        operations.push(work);
      }
      expect(await work).toEqual({ status: 'refused', stage: 'stored' });
      expect(mock.preflight).not.toHaveBeenCalled();
      expect(startRailgunProcess).not.toHaveBeenCalled();
      expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    }
  );
  test.each(['destination', 'generation'])(
    'fresh %s replacement during completed preflight prevents viewing admission',
    async (field) => {
      mock.preflight.mockImplementationOnce(async () => {
        if (field === 'destination') mock.destination = Object.freeze({});
        else mock.publicIdentity.generationId = hex(999);
        return copy(mock.fresh);
      });
      expect((await runAttempted()).status).toBe('refused');
      expect(startRailgunProcess).not.toHaveBeenCalled();
      expect(withRailgunViewingCredential).not.toHaveBeenCalled();
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
  test('original attempted diagnostic deadline expires during held store open and still drains', async () => {
    const gate = deferred();
    mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
      await gate.promise;
      return mock.store;
    });
    let settled = false;
    const pending = runAttempted().then((result) => {
      settled = true;
      return result;
    });
    await waitFor(() => mock.enrollment.openPoiIntents.mock.calls.length === 1);
    await jest.advanceTimersByTimeAsync(240000);
    expect(settled).toBe(false);
    expect(() => sharedClaim()).toThrow();
    gate.resolve();
    expect((await pending).status).toBe('refused');
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sharedClaim().assertCurrent()).toBeUndefined();
  });
  test('another genuine shared owner maps to exact busy without source diagnostic or later work', async () => {
    const claim = sharedClaim();
    expect(await runAttempted()).toEqual({ status: 'refused', stage: 'busy' });
    expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
    expect(mock.preflight).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(claim.assertCurrent()).toBeUndefined();
    claim.release();
    expect((await runAttempted()).status).toBe('matched');
  });
  test.each(['open', 'preflight', 'final-read', 'post-recovery'])(
    'cancelled %s borrowed work retains shared exclusion until complete drain',
    async (point) => {
      const gate = deferred(),
        entered = deferred();
      const hold = async () => {
        entered.resolve();
        await gate.promise;
      };
      if (point === 'open')
        mock.enrollment.openPoiIntents.mockImplementationOnce(async () => {
          await hold();
          return mock.store;
        });
      if (point === 'preflight')
        mock.preflight.mockImplementationOnce(async () => {
          await hold();
          return copy(mock.fresh);
        });
      if (point === 'post-recovery') mock.recoveryPost.mockImplementationOnce(hold);
      if (point === 'final-read') {
        const original = mock.store.get.getMockImplementation();
        mock.store.get.mockImplementation(async (...args) => {
          if (mock.events.includes('window-close')) await hold();
          return original(...args);
        });
      }
      let settled = false;
      const pending = runAttempted().then((value) => {
        settled = true;
        return value;
      });
      await entered.promise;
      mock.caller.abort();
      for (let tick = 0; tick < 30; tick++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(() => sharedClaim()).toThrow();
      expect(
        await runAttempted({
          ...options,
          capsuleDigest: hex(999),
          signal: new AbortController().signal,
        })
      ).toEqual({ status: 'refused', stage: 'busy' });
      gate.resolve();
      expect((await pending).status).toBe('refused');
      const successor = sharedClaim();
      expect(successor.assertCurrent()).toBeUndefined();
      successor.release();
      mock.store.get.mockImplementation(async () => copy(mock.entry));
      expect(
        (await runAttempted({ ...options, signal: new AbortController().signal })).status
      ).toBe('matched');
    }
  );
  test.each(['derivation', 'pre-key-reattest', 'credential-reattest'])(
    'utility exit alone cannot release shared exclusion while %s is borrowed',
    async (point) => {
      const gate = deferred(),
        entered = deferred();
      if (point === 'derivation') {
        const original = mock.credential.getMockImplementation();
        mock.credential.mockImplementationOnce(async (use) => {
          entered.resolve();
          await gate.promise;
          return original(use);
        });
      } else {
        let reads = 0;
        mock.reattest.mockImplementation(async () => {
          if (++reads === (point === 'pre-key-reattest' ? 2 : 3)) {
            entered.resolve();
            await gate.promise;
          }
          return copy(mock.capture);
        });
      }
      let settled = false;
      const pending = runAttempted().then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      mock.caller.abort();
      await waitFor(() => mock.events.includes('job-exit'));
      for (let tick = 0; tick < 30; tick++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(mock.phase).toBe(true);
      expect(() => sharedClaim()).toThrow();
      gate.resolve();
      expect((await pending).status).toBe('refused');
      expect(mock.phase).toBe(false);
      expect(mock.copies).toHaveLength(0);
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
  test('late genuine fatal source refusal survives cancellation while shared ownership drains', async () => {
    const gate = deferred();
    const sourceOutcome = Object.freeze({ fatal: true, reason: 'fatal', rpcFailure: 'response' });
    mock.preflight.mockImplementationOnce(async () => {
      await gate.promise;
      return { status: 'refused', stage: 'source:snapshot', sourceOutcome };
    });
    const pending = runAttempted();
    await waitFor(() => mock.preflight.mock.calls.length === 1);
    mock.caller.abort();
    expect(() => sharedClaim()).toThrow();
    gate.resolve();
    expect(await pending).toEqual({
      status: 'refused',
      stage: 'preflight:source:snapshot',
      sourceOutcome,
    });
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(sharedClaim().assertCurrent()).toBeUndefined();
  });
  test('prepared and submission-only routes never double-claim beneath a sender owner', async () => {
    configure();
    const claim = sharedClaim();
    expect((await run()).status).toBe('matched');
    expect((await runCompleted()).status).toBe('matched');
    const work = recoverRailgunPoiOutputForSubmission(
      { ...options, sourceDestination: mock.destination },
      { entry: copy(mock.entry), capture: copy(mock.capture), observation: {} }
    );
    operations.push(work);
    expect((await work).status).toBe('matched');
    expect(claim.assertCurrent()).toBeUndefined();
  });
});

test('non-contention claim failure still maps exact busy and fabricates no source outcome', async () => {
  attemptRecord();
  const authority = require('./railgun-identity').assertRailgunIdentity;
  const original = authority.getMockImplementation();
  authority.mockImplementationOnce(original).mockImplementationOnce(() => {
    mock.identityCurrent = false;
    throw Object.assign(Error('PRIVATE owner changed'), { sourceOutcome: { fatal: true } });
  });
  expect(await runAttempted()).toEqual({ status: 'refused', stage: 'busy' });
  expect(mock.enrollment.openPoiIntents).not.toHaveBeenCalled();
  expect(mock.preflight).not.toHaveBeenCalled();
  expect(startRailgunProcess).not.toHaveBeenCalled();
  mock.identityCurrent = true;
  expect(sharedClaim().assertCurrent()).toBeUndefined();
});
test('local output-owner contention releases only the new shared claim and preserves existing work', async () => {
  const gate = deferred();
  mock.preflight.mockImplementationOnce(async () => {
    await gate.promise;
    return copy(mock.fresh);
  });
  const pending = run();
  await waitFor(() => mock.preflight.mock.calls.length === 1);
  expect(await runAttempted()).toEqual({ status: 'refused', stage: 'context' });
  const claim = sharedClaim();
  expect(claim.assertCurrent()).toBeUndefined();
  claim.release();
  expect(mock.enrollment.openPoiIntents).toHaveBeenCalledTimes(1);
  gate.resolve();
  expect((await pending).status).toBe('matched');
});
describe.each(['prepared', 'attempted'])('%s cleanup exception drain', (route) => {
  test.each(['throw-close', 'reject-closed'])(
    '%s still drains a borrowed credential and wipes every key copy before release',
    async (failure) => {
      if (route === 'attempted') attemptRecord();
      const gate = deferred(),
        entered = deferred();
      const original = mock.credential.getMockImplementation();
      mock.credential.mockImplementationOnce(async (use) =>
        original(async (loan) => {
          const bytes = await use(loan);
          // The actual host copy exists, but the credential loan has not returned.
          mock.pendingKeyCopy = bytes;
          entered.resolve();
          await gate.promise;
          return bytes;
        })
      );
      mock.scenario = async (job, task) => {
        const borrowed = sendKey(job);
        borrowed.catch(() => {});
        await entered.promise;
        if (failure === 'throw-close') {
          const close = task.close.getMockImplementation();
          // First close is the abort listener; only the explicit cleanup call
          // throws, so the mock never manufactures an uncaught EventTarget error.
          task.close.mockImplementationOnce(close).mockImplementation(() => {
            throw Error('close failure');
          });
        } else {
          task.closed = Promise.reject(Error('closed failure'));
          task.closed.catch(() => {});
        }
        // Supervisor completion races with its still-borrowed key request.
        return {};
      };
      let settled = false;
      const pending = (route === 'attempted' ? runAttempted() : run()).then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      await waitFor(() => mock.task.close.mock.calls.length >= 1);
      for (let tick = 0; tick < 30; tick++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(mock.phase).toBe(true);
      expect(mock.pendingKeyCopy.some((byte) => byte !== 0)).toBe(true);
      expect(mock.borrowed[0].some((byte) => byte !== 0)).toBe(true);
      if (route === 'attempted') expect(() => sharedClaim()).toThrow();
      else expect((await run()).status).toBe('refused');
      gate.resolve();
      expect((await pending).status).toBe('refused');
      expect(mock.phase).toBe(false);
      expect(mock.pendingKeyCopy.every((byte) => byte === 0)).toBe(true);
      expect(mock.borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(sharedClaim().assertCurrent()).toBeUndefined();
    }
  );
});

// Structural joins only; genuine source authentication and crypto are native qualifications.
function makeTransactProofFixture(unshield = false, mixedCreator = false) {
  const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const hash = (v) =>
    require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const evidence =
    unshield === 'partial'
      ? require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial()
      : require('../../../scripts/fixtures/railgun-own-txid-data').sample(unshield);
  const descriptor = {
    walletId: evidence.capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: h(3).slice(2),
    spendingPublicKey: [h(4).slice(2), h(5).slice(2)],
    viewingPublicKey: h(6).slice(2),
    accountIndex: 0,
  };
  const creator = {
    type: 'Transact',
    tree: evidence.capsule.selection.tree,
    position: evidence.capsule.selection.position,
    hash: evidence.capsule.noteHash,
    ciphertext: {
      ciphertext: [h(7), h(8), h(9), h(10)],
      blindedSenderViewingKey: h(11),
      blindedReceiverViewingKey: h(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  const state = { count: 2, root: h(15).slice(2), transcript: h(16).slice(2), breaks: [] };
  const witnessFor = (row, index) => ({
    row: JSON.parse(JSON.stringify(row)),
    leaf: h(17 + index).slice(2),
    railgunTxid: h(19 + index).slice(2),
    rowSha256: hash(row),
    index,
    elements: Array(16).fill(h(0).slice(2)),
    root: state.root,
    checkpointIndex: 1,
    transcript: state.transcript,
    continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(1, []),
    globalTxidCompleteness: false,
  });
  const blockNumber = evidence.row.blockNumber - 1;
  const creatorRow = {
    version: 'V2',
    graphID: h(blockNumber) + h(2).slice(2) + h(0).slice(2),
    commitments: mixedCreator ? [creator.hash, h(702)] : [creator.hash],
    nullifiers: [h(700)],
    boundParamsHash: h(701),
    blockNumber,
    txid: h(706).slice(2),
    timestamp: blockNumber,
    utxoTreeIn: creator.tree,
    utxoTreeOut: creator.tree,
    utxoBatchStartPositionOut: creator.position,
    verificationHash: evidence.row.verificationHash,
    ...(mixedCreator
      ? {
          unshield: {
            tokenData: {
              tokenType: 0,
              tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
              tokenSubID: h(0),
            },
            toAddress: '0x' + '12'.repeat(20),
            value: '400',
          },
        }
      : {}),
  };
  const note = {
    type: 'Transact',
    tree: creator.tree,
    position: creator.position,
    hash: creator.hash,
    txid: h(706),
    blockNumber,
  };
  const input = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor,
    preparation: { creator, ownEvidence: evidence, state, witness: witnessFor(evidence.row, 1) },
    listProofs: [
      {
        leaf: h(21).slice(2),
        root: h(22).slice(2),
        indices: h(0).slice(2),
        elements: Array(16).fill(h(0).slice(2)),
      },
    ],
  };
  const selectorInput =
    require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
      archive: input.archive,
      descriptor,
      capsule: evidence.capsule,
      creator,
    });
  return {
    input,
    selector: {
      blindedCommitment: h(21),
      bindingDigest: selectorInput.bindingDigest,
      inputSha256: hash(selectorInput),
    },
    creatorProvenance: {
      note,
      noteWitness: {
        note,
        outputIndex: 0,
        witness: witnessFor(creatorRow, 0),
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      },
      verification: {
        ...(mixedCreator ? { unshieldCommitmentVerified: true } : {}),
        utilityExitObserved: true,
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        coverage: {
          matchedRows: 1,
          knownOmissions: 0,
          boundParamsChecked: false,
          unshieldCommitmentHashesChecked: false,
          globalTxidCompleteness: false,
        },
      },
    },
  };
}
function configureTransactOutput(unshield = false, mixedCreator = false) {
  configure(unshield);
  const fixture = makeTransactProofFixture(unshield, mixedCreator);
  fixture.input.preparation.state.count = 5;
  for (const witness of [
    fixture.input.preparation.witness,
    fixture.creatorProvenance.noteWitness.witness,
  ]) {
    witness.checkpointIndex = 4;
    witness.continuity = classifyRailgunTxidContinuity(4, []);
  }
  mock.fresh.creatorClassification.type = 'Transact';
  mock.fresh.poiPreparation = fixture.input.preparation;
  mock.fresh.witness = normalizeRailgunTxidWitness(
    fixture.input.preparation.witness,
    fixture.input.preparation.state
  );
  mock.fresh.txidPolicy = 'fixture-txid-policy';
  const origin = {
    blockNumber: 12,
    blockHash: prefixed(123),
    transactionHash: prefixed(124),
    logIndex: 0,
  };
  mock.fresh.observations.source = { checkpointHash: hex(125), creator: { origin } };
  mock.fresh.creatorProvenance = {
    ...fixture.creatorProvenance,
    publicIdentity: copy(mock.publicIdentity),
    txidPolicy: mock.fresh.txidPolicy,
    checkpointHash: hex(125),
    origin: copy(origin),
  };
  if (unshield)
    changePayload((payload) => {
      payload.railgunTxidIfHasUnshield = '0x' + fixture.input.preparation.witness.railgunTxid;
    });
}
test.each([false, true])(
  'retained source-selected Transact output %s keeps saved bytes and releases only the needed viewing credential',
  async (unshield) => {
    configureTransactOutput(unshield);
    const before = JSON.stringify(mock.entry);
    expect(await run()).toMatchObject({
      status: 'matched',
      viewingKeyReleases: Number(!unshield),
      viewingUtilityExitObserved: !unshield,
    });
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
    expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].sourceDestination).toBe(
      mock.destination
    );
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(preflightRailgunRetainedPoiForSubmission).not.toHaveBeenCalled();
    expect(mock.credential).toHaveBeenCalledTimes(Number(!unshield));
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);
test.each(
  [
    'type',
    'creator-type',
    'note-type',
    'note-tree',
    'note-position',
    'note-hash',
    'identity',
    'policy',
    'checkpoint',
    'origin',
    'state-root',
    'state-count',
    'note-path',
    'note-row',
    'output-index',
    'not-before-own',
    'verification-exit',
    'verification-path',
    'verification-events',
    'coverage-count',
    'coverage-omissions',
    'capsule',
  ].flatMap((fault) => [
    [fault, false],
    [fault, true],
  ])
)(
  'Transact retained %s mixed=%s mismatch refuses before recovery, viewing key or utility',
  async (fault, mixedCreator) => {
    configureTransactOutput(false, mixedCreator);
    const fresh = mock.fresh,
      provenance = fresh.creatorProvenance;
    if (fault === 'type') fresh.creatorClassification.type = 'Shield';
    if (fault === 'creator-type') fresh.poiPreparation.creator.type = 'Shield';
    if (fault.startsWith('note-') && ['type', 'tree', 'position', 'hash'].includes(fault.slice(5)))
      provenance.note[fault.slice(5)] = 'changed';
    if (fault === 'identity') provenance.publicIdentity = {};
    if (fault === 'policy') provenance.txidPolicy = 'other';
    if (fault === 'checkpoint') provenance.checkpointHash = hex(777);
    if (fault === 'origin') provenance.origin.logIndex++;
    if (fault === 'state-root') provenance.noteWitness.witness.root = hex(777);
    if (fault === 'state-count') provenance.noteWitness.witness.checkpointIndex--;
    if (fault === 'note-path') provenance.noteWitness.witness.elements.pop();
    if (fault === 'note-row') provenance.noteWitness.witness.row.commitments[0] = prefixed(777);
    if (fault === 'output-index') provenance.noteWitness.outputIndex = 1;
    if (fault === 'not-before-own') provenance.noteWitness.witness.index = fresh.witness.index;
    if (fault === 'verification-exit') provenance.verification.utilityExitObserved = false;
    if (fault === 'verification-path') provenance.verification.pathVerified = false;
    if (fault === 'verification-events')
      provenance.verification.suppliedCreatorEventsMatched = false;
    if (fault === 'coverage-count') provenance.verification.coverage.matchedRows = 2;
    if (fault === 'coverage-omissions') provenance.verification.coverage.knownOmissions = 1;
    if (fault === 'capsule') fresh.poiPreparation.ownEvidence.capsule.noteHash = prefixed(777);
    const before = JSON.stringify(mock.entry);
    expect(await run()).toMatchObject({ status: 'refused', stage: 'binding' });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);
test('ordinary source refusal survives cancellation and never falls back to legacy recovery', async () => {
  const sourceOutcome = Object.freeze({ fatal: false, reason: 'pending', rpcFailure: null });
  mock.preflight.mockImplementationOnce(async () => {
    mock.caller.abort();
    return { status: 'refused', stage: 'source:pending', sourceOutcome };
  });
  expect(await run()).toMatchObject({
    status: 'refused',
    stage: 'preflight:source:pending',
    sourceOutcome,
  });
  expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
  expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
  expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
  expect(mock.credential).not.toHaveBeenCalled();
});
test.each(['preflight', 'recovery'])(
  'ordinary pinned destination replacement at %s refuses without reselection',
  async (point) => {
    if (point === 'preflight')
      mock.preflight.mockImplementationOnce(async () => {
        mock.destination = Object.freeze({});
        return copy(mock.fresh);
      });
    else
      mock.recoveryStart.mockImplementationOnce(async () => {
        mock.destination = Object.freeze({});
      });
    expect((await run()).status).toBe('refused');
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(mock.credential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
  }
);

test.each([
  ['completed', false],
  ['completed', true],
  ['attempted', false],
  ['attempted', true],
  ['submission', false],
  ['submission', true],
])(
  'Transact %s output kind %s preserves its fixed route and exact stored state',
  async (route, unshield) => {
    configureTransactOutput(unshield);
    if (route === 'attempted') attemptRecord();
    const before = JSON.stringify(mock.entry);
    let result;
    if (route === 'submission') {
      const evidence = mock.fresh.poiPreparation.ownEvidence;
      const handoff = {
        entry: copy(mock.entry),
        capture: copy(mock.capture),
        observation: {
          transaction: copy(evidence.transaction),
          receipt: copy(evidence.receipt),
          captureBindingDigest: mock.capture.bindingDigest,
        },
      };
      const work = recoverRailgunPoiOutputForSubmission(
        { ...options, sourceDestination: mock.destination },
        handoff
      );
      operations.push(work);
      result = await work;
      expect(preflightRailgunRetainedPoiForSubmission).toHaveBeenCalledTimes(1);
      const [supplied, received] = preflightRailgunRetainedPoiForSubmission.mock.calls[0];
      expect(supplied.sourceDestination).toBe(mock.destination);
      expect(received).toEqual(handoff);
      expect(received).not.toBe(handoff);
      expect(preflightRailgunRetainedPoiCompleted).not.toHaveBeenCalled();
    } else {
      result = await (route === 'attempted' ? runAttempted() : runCompleted());
      expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(1);
      expect(preflightRailgunRetainedPoiCompleted.mock.calls[0][0].sourceDestination).toBe(
        mock.destination
      );
      expect(preflightRailgunRetainedPoiForSubmission).not.toHaveBeenCalled();
    }
    expect(result).toMatchObject({
      status: 'matched',
      viewingKeyReleases: Number(!unshield),
      outputMatched: true,
    });
    if (route === 'attempted')
      expect(result).toMatchObject({
        recordState: 'attempted',
        eligibilityEstablished: false,
        attemptOutcomeKnown: false,
        submissionAccepted: false,
        retryEnabled: false,
      });
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(mock.credential).toHaveBeenCalledTimes(Number(!unshield));
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);

test.each(['missing', 'pending'])(
  'ordinary retained output refuses %s completed source until independent maintenance makes it ready',
  async (reason) => {
    const sourceOutcome = Object.freeze({ fatal: false, reason, rpcFailure: null });
    mock.preflight.mockResolvedValueOnce({
      status: 'refused',
      stage: 'source:' + reason,
      sourceOutcome,
    });
    const before = JSON.stringify(mock.entry);
    expect(await run()).toMatchObject({
      status: 'refused',
      stage: 'preflight:source:' + reason,
      sourceOutcome,
    });
    expect(mock.credential).not.toHaveBeenCalled();
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.entry)).toBe(before);
    // The fixture's next completed-source response models separate maintenance;
    // the refused output invocation has no repair/replay call of its own.
    expect((await run()).status).toBe('matched');
    expect(preflightRailgunRetainedPoiCompleted).toHaveBeenCalledTimes(2);
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);

test.each(['ordinary', 'completed', 'attempted'])(
  '%s recovery refuses partial capsule with legacy transfer payload before final account or viewing work',
  async (route) => {
    const {
      createRailgunPartialCapsuleData,
    } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
    const capsule = require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(
      createRailgunPartialCapsuleData().capsule
    );
    // Preflight and retained authority are mocked. The normalized capsule is real.
    mock.fresh.capture.capsule = capsule;
    mock.fresh.poiPreparation.ownEvidence.capsule = capsule;
    if (route === 'attempted') attemptRecord();
    const before = copy(mock.entry);
    const shield = require('./railgun-poi-shield-selector-data').normalizeRailgunPoiShieldInput;
    shield.mockClear();
    const result = await (route === 'ordinary'
      ? run()
      : route === 'completed'
        ? runCompleted()
        : runAttempted());
    expect(result).toMatchObject({ status: 'refused', stage: 'binding' });
    expect(mock.preflight).toHaveBeenCalledTimes(1);
    expect(shield).not.toHaveBeenCalled();
    expect(mock.recoveryStart).not.toHaveBeenCalled();
    expect(mock.credential).not.toHaveBeenCalled();
    expect(mock.tasks).toHaveLength(0);
    expect(mock.entry).toEqual(before);
  }
);

test.each([false, true])(
  'mixed creator retained output for legacy unshield=%s preserves stored bytes',
  async (unshield) => {
    configureTransactOutput(unshield, true);
    const before = JSON.stringify(mock.entry);
    expect(await run()).toMatchObject({ status: 'matched', viewingKeyReleases: Number(!unshield) });
    expect(mock.credential).toHaveBeenCalledTimes(Number(!unshield));
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);
test.each(['missing', 'false', 'copied-legacy', 'coverage-hash'])(
  'mixed creator %s verification refuses before output key or utility',
  async (fault) => {
    configureTransactOutput(false, true);
    const provenance = mock.fresh.creatorProvenance;
    if (fault === 'missing') delete provenance.verification.unshieldCommitmentVerified;
    if (fault === 'false') provenance.verification.unshieldCommitmentVerified = false;
    if (fault === 'copied-legacy')
      provenance.verification = copy(makeTransactProofFixture().creatorProvenance.verification);
    if (fault === 'coverage-hash')
      provenance.verification.coverage.unshieldCommitmentHashesChecked = true;
    const before = JSON.stringify(mock.entry);
    expect(await run()).toMatchObject({ status: 'refused', stage: 'binding' });
    expect(withRailgunOwnOperationRecovery).not.toHaveBeenCalled();
    expect(withRailgunViewingCredential).not.toHaveBeenCalled();
    expect(startRailgunProcess).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.entry)).toBe(before);
  }
);

describe('partial retained output with mocked genuine owner/preflight boundaries', () => {
  test.each(
    ['Shield', 'Transact'].flatMap((type) =>
      ['ordinary', 'completed', 'attempted', 'submission'].map((route) => [type, route])
    )
  )(
    '%s %s keeps both outputs bound with one viewing loan and no durable mutation',
    async (type, route) => {
      if (type === 'Transact') configureTransactOutput('partial');
      else configure('partial');
      if (route === 'attempted') attemptRecord();
      const before = JSON.stringify(mock.entry);
      let result;
      if (route === 'submission') {
        const evidence = mock.fresh.poiPreparation.ownEvidence;
        const handoff = {
          entry: copy(mock.entry),
          capture: copy(mock.capture),
          observation: {
            transaction: copy(evidence.transaction),
            receipt: copy(evidence.receipt),
            captureBindingDigest: mock.capture.bindingDigest,
          },
        };
        const work = recoverRailgunPoiOutputForSubmission(
          { ...options, sourceDestination: mock.destination },
          handoff
        );
        operations.push(work);
        result = await work;
      } else
        result = await (route === 'attempted'
          ? runAttempted()
          : route === 'completed'
            ? runCompleted()
            : run());
      expect(result).toMatchObject({
        status: 'matched',
        viewingKeyReleases: 1,
        viewingUtilityExitObserved: true,
        outputMatched: true,
        spendingEnabled: false,
        disclosureEnabled: false,
        proofVerified: false,
        sourceAuthenticated: false,
      });
      if (route === 'attempted')
        expect(result).toMatchObject({
          recordState: 'attempted',
          eligibilityEstablished: false,
          attemptOutcomeKnown: false,
          submissionAccepted: false,
          retryEnabled: false,
        });
      expect(mock.credential).toHaveBeenCalledTimes(1);
      expect(mock.tasks).toHaveLength(1);
      expect(mock.events).toContain('job-exit');
      expect(mock.copies.every((b) => b.every((v) => v === 0))).toBe(true);
      expect(mock.task.options.input).not.toContain('"blindedCommitmentsOut"');
      expect(mock.task.options.input).not.toContain('"payload"');
      expect(mock.task.options.input).not.toContain('"listProofs"');
      expect(mock.store.prepare).not.toHaveBeenCalled();
      expect(mock.store.beginAttempt).not.toHaveBeenCalled();
      expect(JSON.stringify(mock.entry)).toBe(before);
    }
  );
  test.each(['wrong-T', 'zero-T', 'missing-change', 'extra-change'])(
    'partial saved %s refuses before recovery/key despite canonical payload digest',
    async (fault) => {
      configure('partial');
      changePayload((p) => {
        if (fault === 'wrong-T') p.railgunTxidIfHasUnshield = prefixed(10);
        if (fault === 'zero-T') p.railgunTxidIfHasUnshield = '0x00';
        if (fault === 'missing-change') p.blindedCommitmentsOut = [];
        if (fault === 'extra-change') p.blindedCommitmentsOut.push(prefixed(30));
      });
      const before = JSON.stringify(mock.entry);
      expect((await run()).status).toBe('refused');
      expect(mock.recoveryStart).not.toHaveBeenCalled();
      expect(mock.credential).not.toHaveBeenCalled();
      expect(mock.tasks).toHaveLength(0);
      expect(JSON.stringify(mock.entry)).toBe(before);
    }
  );
  test.each(
    ['ordinary', 'attempted'].flatMap((route) =>
      ['wrong-T', 'zero-T', 'wrong-change'].map((fault) => [route, fault])
    )
  )('partial %s worker %s fails exact host comparison after one loan', async (route, fault) => {
    configure('partial');
    if (route === 'attempted') attemptRecord();
    mock.resultMutation = (message) => {
      if (fault === 'wrong-T') message.value.output.railgunTxidIfHasUnshield = prefixed(10);
      if (fault === 'zero-T') message.value.output.railgunTxidIfHasUnshield = '0x00';
      if (fault === 'wrong-change') message.value.output.blindedCommitmentsOut = [prefixed(30)];
    };
    const before = JSON.stringify(mock.entry);
    expect((await (route === 'attempted' ? runAttempted() : run())).status).toBe('refused');
    expect(mock.credential).toHaveBeenCalledTimes(1);
    expect(mock.task.options.broker.signal.aborted).toBe(true);
    expect(mock.copies[0].every((v) => v === 0)).toBe(true);
    expect(JSON.stringify(mock.entry)).toBe(before);
  });
  test.each(['ordinary', 'attempted'])(
    'partial %s cancellation after output retains ownership until utility exit',
    async (route) => {
      configure('partial');
      if (route === 'attempted') attemptRecord();
      mock.deferExit = true;
      const before = JSON.stringify(mock.entry);
      const pending = route === 'attempted' ? runAttempted() : run();
      await waitFor(() => mock.task?.close.mock.calls.length > 0);
      mock.caller.abort();
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled).toBe(false);
      expect(mock.phase).toBe(true);
      const next = { ...options, signal: new AbortController().signal };
      expect((await (route === 'attempted' ? runAttempted(next) : run(next))).status).toBe(
        'refused'
      );
      mock.task.exit();
      expect((await pending).status).toBe('refused');
      expect(mock.phase).toBe(false);
      expect(mock.copies[0].every((v) => v === 0)).toBe(true);
      expect(JSON.stringify(mock.entry)).toBe(before);
    }
  );
});
