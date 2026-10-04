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
      context.subject.operation !== 'poi-output-recover' ||
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
  preflightRailgunOwnPoi: jest.fn((options) => mock.preflight(options)),
  preflightRailgunOwnPoiCompleted: jest.fn((options) => mock.preflight(options)),
  preflightRailgunOwnPoiForSubmission: jest.fn((options, input) => mock.preflight(options, input)),
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
  recoverRailgunPoiOutput,
  recoverRailgunPoiOutputCompleted,
  recoverRailgunPoiOutputForSubmission,
} = require('./railgun-poi-output-recovery');
const { withRailgunViewingCredential } = require('./railgun-identity');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const {
  preflightRailgunOwnPoi,
  preflightRailgunOwnPoiCompleted,
  preflightRailgunOwnPoiForSubmission,
} = require('./railgun-own-witness');
const { startRailgunProcess } = require('./railgun-process');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const prefixed = (n) => '0x' + hex(n);
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
let options, gates, operations;
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
  const ownEvidence = sample(unshield);
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
    blindedCommitmentsOut: unshield ? [] : [prefixed(22)],
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
    output: { blindedCommitmentsOut: [prefixed(22)], railgunTxidIfHasUnshield: '0x00' },
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
    expect(preflightRailgunOwnPoiCompleted).toHaveBeenCalledTimes(1);
    expect(preflightRailgunOwnPoi).not.toHaveBeenCalled();
    expect(preflightRailgunOwnPoiCompleted.mock.calls[0][0]).toMatchObject({
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
    expect(preflightRailgunOwnPoiCompleted).not.toHaveBeenCalled();
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
  await waitFor(() => preflightRailgunOwnPoiCompleted.mock.calls.length === 1);
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
  expect(preflightRailgunOwnPoiCompleted).toHaveBeenCalledTimes(1);
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
  expect(preflightRailgunOwnPoiCompleted.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(230000);
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
      expect(preflightRailgunOwnPoiCompleted).not.toHaveBeenCalled();
      expect(preflightRailgunOwnPoiForSubmission).toHaveBeenCalledTimes(1);
      const [supplied, privateInput] = preflightRailgunOwnPoiForSubmission.mock.calls[0];
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
      expect(preflightRailgunOwnPoiForSubmission).toHaveBeenCalledTimes(1);
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
    expect(preflightRailgunOwnPoiForSubmission.mock.calls[0][1]).toEqual(baseline);
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
  test('legacy output ignores an extra positional handoff and retains original preflight', async () => {
    expect((await recoverRailgunPoiOutput(options, handoff)).status).toBe('matched');
    expect(preflightRailgunOwnPoi).toHaveBeenCalledTimes(1);
    expect(preflightRailgunOwnPoiForSubmission).not.toHaveBeenCalled();
  });
});
