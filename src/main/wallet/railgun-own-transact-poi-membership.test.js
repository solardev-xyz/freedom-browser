const { createHash } = require('crypto');
let mock;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mock.enrollment,
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => {
    if (value !== '/selector.asar') throw Error('PRIVATE archive');
    return value;
  },
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'public-policy' }));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (coordinator, enrollment, policy) => {
    if (
      coordinator !== mock.coordinator ||
      enrollment !== mock.enrollment ||
      policy !== 'public-policy' ||
      !mock.publicCurrent
    )
      throw Error('PRIVATE public');
    return { ...mock.publicIdentity };
  },
}));
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (identity, handle) => {
    const context = require('../networks/privacy-context').getPrivacyContext(handle);
    if (
      identity !== mock.identity ||
      identity.signal.aborted ||
      !mock.identityCurrent ||
      !['poi-transact-selector', 'poi-prove'].includes(context.subject.operation)
    )
      throw Error('PRIVATE identity');
    return JSON.parse(JSON.stringify(identity.descriptor));
  },
  withRailgunViewingCredential: jest.fn((identity, use) => {
    if (identity !== mock.identity) throw Error('PRIVATE identity');
    return mock.credential(use);
  }),
}));
jest.mock('./railgun-own-witness', () => ({
  captureRailgunOwnTransactPoiMembershipInput: jest.fn((options) => mock.preflight(options)),
  preflightRailgunOwnPoi: jest.fn((options) => mock.shieldPreflight(options)),
}));
jest.mock('./railgun-own-operation', () => ({
  captureRailgunOwnOperation: jest.fn((options) => mock.recapture(options)),
  withRailgunOwnOperationRecovery: jest.fn(async (options, use) => {
    const claim = require('./railgun-account-phase').claimRailgunAccountPhase(
      mock.enrollment,
      'recovery'
    );
    mock.phase = true;
    const deadline = performance.now() + options.timeoutMs;
    const current = (margin = 0) => {
      claim.assertCurrent();
      if (options.signal.aborted || performance.now() + margin >= deadline)
        throw Error('PRIVATE recovery');
    };
    mock.window = {
      signal: options.signal,
      capture: JSON.parse(JSON.stringify(mock.capture)),
      assertCurrent: jest.fn(current),
      reattest: jest.fn(async () => {
        current();
        const value = await mock.reattest();
        current();
        return value;
      }),
    };
    try {
      const value = await use(mock.window);
      current();
      return { status: 'used', value };
    } catch {
      return { status: 'refused', stage: 'callback' };
    } finally {
      mock.phase = false;
      claim.release();
    }
  }),
}));
jest.mock('./railgun-process', () => ({
  startRailgunProcess: jest.fn((options) => {
    if (!mock.phase) throw Error('PRIVATE phase');
    let readyYes, readyNo, exitYes, exitNo;
    const ready = new Promise((yes, no) => {
      readyYes = yes;
      readyNo = no;
    });
    const closed = new Promise((yes, no) => {
      exitYes = yes;
      exitNo = no;
    });
    const task = {
      options,
      ready,
      closed,
      close: jest.fn(() => {
        mock.closedCalls++;
        if (!mock.holdExit) exitYes({ code: 'RAILGUN_PROCESS_CLOSED' });
        if (mock.closeThrows) throw Error('PRIVATE close');
      }),
    };
    const job = {
      options,
      task,
      readyYes,
      readyNo,
      exit: () => exitYes({ code: 'RAILGUN_PROCESS_CLOSED' }),
      rejectExit: () => exitNo(Error('PRIVATE exit')),
      send: (value) =>
        options.broker.dispatch(typeof value === 'string' ? value : JSON.stringify(value)),
    };
    mock.jobs.push(job);
    Promise.resolve()
      .then(() => mock.script(job))
      .then(readyYes, readyNo);
    return task;
  }),
}));
jest.mock('./railgun-poi-source', () => ({
  MAX_AGE_MS: 60000,
  createRailgunPoiSource: jest.fn((options) => mock.sourceFactory(options)),
}));
jest.mock('./railgun-txid-root', () => ({
  createRailgunTxidRootSource: jest.fn((handle) => mock.rootFactory(handle)),
}));
jest.mock('./railgun-poi-membership', () => ({
  verifyRailgunPoiMembership: jest.fn((options) => mock.verify(options)),
  assertRailgunPoiMembership: jest.fn((receipt, handle, margin = 0) => {
    if (receipt !== mock.membershipReceipt) throw Error('PRIVATE receipt');
    mock.source.assertResult(mock.sourceReceipt, margin);
    require('../networks/privacy-context').getPrivacyContext(handle);
    return mock.verified;
  }),
}));
jest.mock('./railgun-poi-shield-selector', () => ({
  deriveRailgunPoiShieldSelector: jest.fn(async () => ({
    selectorDerived: true,
    utilityExitObserved: true,
    blindedCommitment: hex(77),
    bindingDigest: 'd'.repeat(64),
    inputSha256: 'e'.repeat(64),
  })),
}));
jest.mock('./railgun-prover-runtime', () => ({ verifyRailgunProverRuntime: (value) => value }));
jest.mock('./railgun-poi-verifier', () => ({
  verifyRailgunPoiPayload: () => {
    throw Error('No POI proving');
  },
}));
jest.mock('./railgun-poi-prover', () => {
  throw Error('No prover');
});
jest.mock('./railgun-poi-intent-store', () => {
  throw Error('No store');
});
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { deriveRailgunOwnTransactPoiSelector: derive } = require('./railgun-poi-transact-selector');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
let scope, caller, identityOwner, options;
function configure(unshield = false) {
  const evidence = sample(unshield),
    capsule = evidence.capsule;
  const descriptor = {
    walletId: capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: hex(3).slice(2),
    spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
    viewingPublicKey: hex(6).slice(2),
    accountIndex: 0,
  };
  mock.identity.descriptor = copy(descriptor);
  mock.enrollment.descriptor = copy(descriptor);
  const creator = {
    type: 'Transact',
    tree: capsule.selection.tree,
    position: capsule.selection.position,
    hash: capsule.noteHash,
    ciphertext: {
      ciphertext: [hex(7), hex(8), hex(9), hex(10)],
      blindedSenderViewingKey: hex(11),
      blindedReceiverViewingKey: hex(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  mock.capture = {
    capsule,
    record: evidence.record,
    bindingDigest: 'b'.repeat(64),
    capsuleDigest: 'c'.repeat(64),
    selector: {
      tree: 0,
      position: 1,
      noteHash: capsule.noteHash,
      nullifier: capsule.preparation.expected.nullifier,
    },
    facts: { kind: capsule.selection.kind },
    submitter: evidence.transaction.from,
    provedTransaction: evidence.transaction,
    intent: evidence.record.intent,
    projection: { included: true, blockHash: evidence.receipt.blockHash },
  };
  mock.historical = {
    status: 'captured',
    state: { count: 2, root: hex(88).slice(2) },
    publicIdentity: copy(mock.publicIdentity),
    publicPolicy: 'public-policy',
    creatorClassification: {
      type: 'Transact',
      legacy: false,
      blockNumber: require('./railgun-owned-poi-records').POI_LAUNCH_BLOCK,
    },
    observations: { archiveAnchorChecked: true },
    creatorProvenance: {
      note: {
        type: 'Transact',
        tree: creator.tree,
        position: creator.position,
        hash: creator.hash,
      },
    },
    capture: copy(mock.capture),
    poiPreparation: { creator, ownEvidence: evidence },
  };
  options.selector = copy(mock.capture.selector);
}
const key = (job) => ({
  id: 1,
  method: 'key',
  purpose: 'poi-transact-selector',
  inputSha256: sha(job.options.input),
});
const result = (job) => ({
  id: 2,
  method: 'result',
  value: {
    inputSha256: sha(job.options.input),
    bindingDigest: JSON.parse(job.options.input).bindingDigest,
    blindedCommitment: hex(77),
    type: 'Transact',
    selectorDerived: true,
    receiverMatched: true,
    sourceAuthenticated: false,
    currentFinalityVerified: false,
    txidRootAccepted: false,
    membershipAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    guards: { attempts: 0, canaries: 1, hooks: ['network'] },
  },
});
async function healthy(job) {
  const bytes = await job.send(key(job));
  mock.keyCopies.push(bytes);
  await job.send(result(job));
}
beforeEach(() => {
  jest.clearAllMocks();
  scope = createPrivacyScope({ profileId: 'selector-test', signal: new AbortController().signal });
  caller = new AbortController();
  identityOwner = new AbortController();
  mock = {
    publicCurrent: true,
    identityCurrent: true,
    publicIdentity: {
      generationId: '1'.repeat(64),
      publicId: '2'.repeat(64),
      sourceId: '3'.repeat(64),
    },
    identity: { signal: identityOwner.signal },
    enrollment: {
      directory: '/selector-test',
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
    },
    coordinator: { signal: scope.signal },
    jobs: [],
    keyCopies: [],
    phase: false,
    holdExit: false,
    closeThrows: false,
    closedCalls: 0,
    script: healthy,
  };
  options = {
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    archive: '/selector.asar',
    selector: {},
    signal: caller.signal,
  };
  configure();
  mock.preflight = jest.fn(async () => copy(mock.historical));
  mock.recapture = jest.fn(async () => ({ status: 'captured', capture: copy(mock.capture) }));
  mock.reattest = jest.fn(async () => copy(mock.capture));
  mock.credential = jest.fn(async (use) => {
    const bytes = Buffer.alloc(32, 17);
    mock.credentialBytes = bytes;
    try {
      return await use({ viewingKey: bytes });
    } finally {
      bytes.fill(0);
    }
  });
});
afterEach(() => {
  for (const job of mock.jobs) job.exit();
  caller.abort();
  for (const op of mock.opened || []) op.close?.();
  mock.sourceExit?.();
  scope.close();
  identityOwner.abort();
  jest.useRealTimers();
});
const {
  openRailgunOwnTransactPoiMembership: openTransact,
  openRailgunOwnPoiMembership: openShield,
  assertRailgunOwnPoiMembership: attest,
} = require('./railgun-own-poi-membership');
const { getPrivacyContext } = require('../networks/privacy-context');
const { REQUIRED_LIST } = require('./railgun-poi-records');
let clock;
beforeEach(() => {
  clock = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  mock.opened = [];
  mock.trace = [];
  mock.rootReceipt = {};
  mock.sourceReceipt = {};
  mock.membershipReceipt = {};
  mock.rootCurrent = true;
  mock.rootClosed = false;
  mock.holdSource = false;
  mock.rootAcquire = jest.fn(async (_point) => {
    mock.trace.push('root');
    return mock.rootReceipt;
  });
  mock.rootFactory = jest.fn((handle) => {
    expect(mock.phase).toBe(false);
    mock.rootHandle = handle;
    mock.rootStarted = performance.now();
    mock.rootPoint = { index: mock.historical.state.count - 1, root: mock.historical.state.root };
    mock.rootObservation = Object.freeze({
      ...mock.rootPoint,
      accepted: true,
      latestIndex: 20,
      service: 'sepolia-ppoi-fdi',
    });
    mock.roots = {
      signal: new AbortController().signal,
      acquire: jest.fn(async (point) => {
        expect(point).toEqual(mock.rootPoint);
        return mock.rootAcquire(point);
      }),
      assertRoot: jest.fn((receipt, point, margin = 0) => {
        getPrivacyContext(handle);
        if (
          receipt !== mock.rootReceipt ||
          !mock.rootCurrent ||
          mock.rootClosed ||
          clock + margin >= mock.rootStarted + 60000
        )
          throw Error('PRIVATE root');
        expect(point).toEqual(mock.rootPoint);
        return mock.rootObservation;
      }),
      close: jest.fn(() => {
        mock.trace.push('root-close');
        mock.rootClosed = true;
        mock.rootClose?.();
      }),
    };
    return mock.roots;
  });
  mock.observed = {
    listKey: REQUIRED_LIST,
    statuses: [{ type: 'Transact', blindedCommitment: hex(77), status: 'Valid' }],
    rootsAccepted: true,
    proofs: [
      {
        leaf: hex(77).slice(2),
        indices: hex(0).slice(2),
        root: hex(90).slice(2),
        elements: Array(16).fill(hex(0).slice(2)),
      },
    ],
    events: [
      {
        signedPOIEvent: {
          index: 0,
          type: 'Transact',
          blindedCommitment: hex(77),
          signature: '0'.repeat(128),
        },
        validatedMerkleroot: hex(90).slice(2),
      },
    ],
    membershipVerified: false,
  };
  mock.acquire = jest.fn(async () => {
    mock.trace.push('list');
    return { receipt: mock.sourceReceipt, observation: mock.observed };
  });
  mock.sourceFactory = jest.fn(({ handle, notes }) => {
    expect(mock.phase).toBe(false);
    mock.listHandle = handle;
    mock.notes = notes;
    mock.trace.push('source');
    const controller = new AbortController();
    const closed = new Promise((resolve) => {
      mock.sourceExit = resolve;
    });
    mock.source = {
      signal: AbortSignal.any([controller.signal, getPrivacyContext(handle).signal]),
      closed,
      acquire: jest.fn(async (options) => {
        mock.listStarted = clock;
        getPrivacyContext(handle);
        return mock.acquire(options);
      }),
      assertResult: jest.fn((receipt, margin = 0) => {
        getPrivacyContext(handle);
        if (
          receipt !== mock.sourceReceipt ||
          mock.source.signal.aborted ||
          clock + margin >= mock.listStarted + 60000
        )
          throw Error('PRIVATE list');
        return mock.observed;
      }),
      close: jest.fn(() => {
        mock.trace.push('list-close');
        controller.abort();
        if (!mock.holdSource) mock.sourceExit();
        mock.sourceClose?.();
      }),
    };
    return mock.source;
  });
  mock.verify = jest.fn(async (options) => {
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
    mock.trace.push('verify');
    mock.verifyOptions = options;
    mock.verified = { ...mock.observed, membershipVerified: true };
    return { receipt: mock.membershipReceipt, observation: mock.verified };
  });
  const recapture = mock.recapture.getMockImplementation();
  mock.recapture.mockImplementation(async (options) => {
    mock.trace.push('capture');
    return recapture(options);
  });
  mock.historical.poiPreparation.state = copy(mock.historical.state);
  mock.historical.poiPreparation.witness = {};
  mock.shieldPreflight = jest.fn(async () => {
    const value = copy(mock.historical);
    value.creatorClassification.type = 'Shield';
    value.poiPreparation.creator.type = 'Shield';
    return value;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});
const run = async (input) => {
  const result = await openTransact(input || options);
  mock.opened.push(result);
  return result;
};
const modes = (input = options) => ({
  diagnostic: () => derive(input),
  transact: () => run(input),
  shield: () => {
    const { identity: _identity, ...rest } = input;
    return openShield(rest);
  },
});
async function assertAllBusy() {
  for (const invoke of Object.values(modes({ ...options, signal: new AbortController().signal })))
    expect((await invoke()).status).toBe('refused');
}
test.each([false, true])(
  'genuine registry typed membership, unshield=%s, retains historical root only',
  async (unshield) => {
    configure(unshield);
    mock.historical.poiPreparation.state = copy(mock.historical.state);
    mock.historical.poiPreparation.witness = {};
    const op = await run();
    expect(op.status).toBe('verified');
    expect(mock.trace).toEqual([
      'capture',
      'root',
      'source',
      'list',
      'root-close',
      'verify',
      'capture',
    ]);
    expect(mock.notes).toEqual([{ type: 'Transact', blindedCommitment: hex(77) }]);
    expect(mock.credential).toHaveBeenCalledTimes(1);
    expect(mock.preflight).toHaveBeenCalledTimes(1);
    expect(mock.recapture).toHaveBeenCalledTimes(2);
    expect(mock.roots.acquire).toHaveBeenCalledWith({ index: 1, root: hex(88).slice(2) });
    expect(getPrivacyContext(mock.listHandle).subject).toMatchObject({
      kind: 'private-account',
      role: 'poi',
      principal: 'railgun:0',
    });
    expect(() => getPrivacyContext(mock.rootHandle)).toThrow();
    expect(mock.verifyOptions.timeoutMs).toBeLessThanOrEqual(10000);
    expect(mock.source.acquire.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(30000);
    expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
    expect(op.observation).toMatchObject({
      inputType: 'Transact',
      recordedRoot: mock.rootObservation,
      accountAuthenticated: false,
      sourceAuthenticated: false,
      currentFinalityVerified: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    expect(Object.isFrozen(op.observation.creatorProvenance)).toBe(true);
    expect(() => attest({ ...op.receipt }, mock.enrollment, mock.coordinator)).toThrow();
    expect(() => attest(op.receipt, { ...mock.enrollment }, mock.coordinator)).toThrow();
  }
);
test('root service context has exact public-only tuple and no operation', async () => {
  let subject;
  const original = mock.rootFactory.getMockImplementation();
  mock.rootFactory.mockImplementation((handle) => {
    subject = getPrivacyContext(handle);
    return original(handle);
  });
  expect((await run()).status).toBe('verified');
  expect(subject.subject).toEqual({
    kind: 'service',
    principal: 'railgun-public-sync',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'public-services',
    operation: null,
  });
  expect(subject.requirements).toEqual({
    origin: 'tor',
    content: 'public',
    correctness: 'any',
    maxAgeMs: null,
  });
});
test('root expiry after acquisition transition is allowed while list remains fresh', async () => {
  mock.rootAcquire.mockImplementation(async () => {
    clock += 14999;
    return mock.rootReceipt;
  });
  mock.acquire.mockImplementation(async () => {
    clock += 29999;
    return { receipt: mock.sourceReceipt, observation: mock.observed };
  });
  const originalVerify = mock.verify.getMockImplementation();
  mock.verify.mockImplementation(async (arg) => {
    expect(mock.rootClosed).toBe(true);
    clock += 9000;
    return originalVerify(arg);
  });
  mock.recapture.mockImplementation(async () => {
    if (mock.rootClosed) clock += 9000;
    return { status: 'captured', capture: copy(mock.capture) };
  });
  const op = await run();
  expect(op.status).toBe('verified');
  expect(clock - mock.rootStarted).toBe(62998);
  expect(clock - mock.listStarted).toBe(47999);
  const calls = mock.roots.assertRoot.mock.calls.length;
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
  expect(mock.roots.assertRoot).toHaveBeenCalledTimes(calls);
  clock = mock.listStarted + 60000;
  expect(() => attest(op.receipt, mock.enrollment, mock.coordinator)).toThrow();
});
test.each(['root', 'source', 'leaf', 'index', 'type', 'status', 'list', 'proofs', 'verifier'])(
  'semantic %s mismatch cannot publish membership',
  async (fault) => {
    if (fault === 'root') mock.rootCurrent = false;
    if (fault === 'source')
      mock.acquire.mockImplementation(async () => ({
        receipt: mock.sourceReceipt,
        observation: { ...mock.observed },
      }));
    if (fault === 'leaf') mock.observed.proofs[0].leaf = hex(78).slice(2);
    if (fault === 'index') mock.observed.events[0].signedPOIEvent.index = 1;
    if (fault === 'type') mock.observed.events[0].signedPOIEvent.type = 'Shield';
    if (fault === 'status') mock.observed.statuses[0].status = 'Missing';
    if (fault === 'list') mock.observed.listKey = 'different';
    if (fault === 'proofs') mock.observed.proofs.push(copy(mock.observed.proofs[0]));
    if (fault === 'verifier')
      mock.verify.mockImplementation(async () => ({
        receipt: mock.membershipReceipt,
        observation: { membershipVerified: false, proofs: mock.observed.proofs },
      }));
    expect((await run()).status).toBe('refused');
    if (fault === 'root') expect(mock.sourceFactory).not.toHaveBeenCalled();
  }
);
test.each(['before-query', 'after-query'])('strict archival drift at %s refuses', async (at) => {
  let count = 0;
  mock.recapture.mockImplementation(async () => {
    const capture = copy(mock.capture);
    if (++count === (at === 'before-query' ? 1 : 2)) capture.record.archivedAt = 1;
    return { status: 'captured', capture };
  });
  expect((await run()).status).toBe('refused');
  if (at === 'before-query') expect(mock.rootFactory).not.toHaveBeenCalled();
});
test.each(['root-expiry', 'list-expiry', 'generation'])(
  'acquisition completion %s cannot enter historical transition',
  async (fault) => {
    mock.acquire.mockImplementation(async () => {
      if (fault === 'root-expiry') clock = mock.rootStarted + 60000;
      if (fault === 'list-expiry') clock = mock.listStarted + 60000;
      if (fault === 'generation') mock.publicIdentity.generationId = '9'.repeat(64);
      return { receipt: mock.sourceReceipt, observation: mock.observed };
    });
    expect((await run()).status).toBe('refused');
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['throw', 'cancel'])(
  'root cleanup %s refuses and waits independently held list closure',
  async (fault) => {
    mock.holdSource = true;
    const entered = gate();
    mock.rootClose = () => {
      entered.resolve();
      if (fault === 'throw') throw Error('PRIVATE close');
      caller.abort();
    };
    let settled = false;
    const pending = run().then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    try {
      await turn();
      expect(settled).toBe(false);
      expect(mock.source.signal.aborted).toBe(true);
      await assertAllBusy();
    } finally {
      mock.sourceExit();
    }
    expect((await pending).status).toBe('refused');
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
test.each(['work-first', 'source-first'])(
  'verifier and list drain in %s order keep shared owner',
  async (order) => {
    mock.holdSource = true;
    const entered = gate(),
      release = gate();
    const original = mock.verify.getMockImplementation();
    mock.verify.mockImplementation(async (args) => {
      entered.resolve();
      await release.promise;
      return original(args);
    });
    let settled = false;
    const pending = run().then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    caller.abort();
    try {
      if (order === 'work-first') release.resolve();
      else mock.sourceExit();
      await turn();
      expect(settled).toBe(false);
      await assertAllBusy();
      if (order === 'work-first') mock.sourceExit();
      else release.resolve();
      expect((await pending).status).toBe('refused');
    } finally {
      release.resolve();
      mock.sourceExit();
      await pending;
    }
  }
);
test('successful operation excludes all three modes until genuine list barrier then healthy diagnostic reopens', async () => {
  mock.holdSource = true;
  const op = await run();
  expect(op.status).toBe('verified');
  await assertAllBusy();
  op.close();
  let closed = false;
  op.closed.then(() => {
    closed = true;
  });
  await turn();
  expect(closed).toBe(false);
  await assertAllBusy();
  expect(() => attest(op.receipt, mock.enrollment, mock.coordinator)).toThrow();
  mock.sourceExit();
  await op.closed;
  expect((await derive(options)).status).toBe('derived');
});
test.each(['diagnostic', 'transact', 'shield'])(
  'pending %s preflight owns all modes synchronously',
  async (mode) => {
    const entered = gate(),
      release = gate();
    const target = mode === 'shield' ? mock.shieldPreflight : mock.preflight;
    const original = target.getMockImplementation();
    target.mockImplementation(async (arg) => {
      entered.resolve();
      await release.promise;
      return original(arg);
    });
    const pending = modes()[mode]();
    await entered.promise;
    try {
      await assertAllBusy();
    } finally {
      caller.abort();
      release.resolve();
    }
    expect((await pending).status).toBe('refused');
  }
);
test('cancelled root acquisition ignores cancellation but retains owner until actual work settles', async () => {
  const entered = gate(),
    release = gate();
  mock.rootAcquire.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return mock.rootReceipt;
  });
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  caller.abort();
  try {
    await turn();
    expect(mock.rootClosed).toBe(true);
    expect(settled).toBe(false);
    await assertAllBusy();
    expect(mock.sourceFactory).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe('refused');
});
test('actual Shield-only proof data refuses genuine Transact receipt before additional credential or utility', async () => {
  const op = await run();
  expect(op.status).toBe('verified');
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
  const data = require('./railgun-own-poi-proof-data');
  const input = {
    archive: options.archive,
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor: mock.identity.descriptor,
    preparation: op.observation.poiPreparation,
    listProofs: op.observation.membership.proofs,
  };
  expect(() => data.normalizeRailgunOwnPoiProofInput(input)).toThrow();
  const jobs = mock.jobs.length,
    credentials = mock.credential.mock.calls.length,
    recaptures = mock.recapture.mock.calls.length;
  const proof = await require('./railgun-own-poi-proof').proveRailgunOwnPoi({
    identity: mock.identity,
    enrollment: mock.enrollment,
    coordinator: mock.coordinator,
    archive: options.archive,
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    membershipReceipt: op.receipt,
    signal: caller.signal,
  });
  expect(proof).toEqual({ status: 'refused', stage: 'context' });
  expect(mock.jobs).toHaveLength(jobs);
  expect(mock.credential).toHaveBeenCalledTimes(credentials);
  expect(mock.recapture).toHaveBeenCalledTimes(recaptures);
  expect(attest(op.receipt, mock.enrollment, mock.coordinator)).toBe(op.observation);
});

test('selector child exit and pending key work exclude Shield and both Transact routes before root', async () => {
  const entered = gate(),
    release = gate();
  mock.credential.mockImplementation(async (use) => {
    entered.resolve();
    await release.promise;
    return use({ viewingKey: Buffer.alloc(32, 17) });
  });
  mock.script = async (job) => {
    job.send(key(job)).catch(() => {});
    await entered.promise;
  };
  let settled = false;
  const pending = run().then((value) => {
    settled = true;
    return value;
  });
  await entered.promise;
  try {
    await turn();
    expect(settled).toBe(false);
    await assertAllBusy();
    expect(mock.rootFactory).not.toHaveBeenCalled();
    expect(mock.sourceFactory).not.toHaveBeenCalled();
    expect(() => claimRailgunAccountPhase(mock.enrollment, 'recovery')).toThrow();
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe('refused');
  expect(mock.phase).toBe(false);
});
test.each(['verifier', 'recapture'])(
  'list expiry during %s never publishes after root transition',
  async (at) => {
    if (at === 'verifier')
      mock.verify.mockImplementation(async () => {
        clock = mock.listStarted + 60000;
        mock.verified = { ...mock.observed, membershipVerified: true };
        return { receipt: mock.membershipReceipt, observation: mock.verified };
      });
    else
      mock.recapture.mockImplementation(async () => {
        if (mock.rootClosed) clock = mock.listStarted + 60000;
        return { status: 'captured', capture: copy(mock.capture) };
      });
    expect((await run()).status).toBe('refused');
    expect(mock.rootClosed).toBe(true);
  }
);
test('throwing list close still retains shared ownership until actual closed settles', async () => {
  mock.holdSource = true;
  const op = await run();
  expect(op.status).toBe('verified');
  mock.sourceClose = () => {
    throw Error('PRIVATE list close');
  };
  let closed = false;
  op.closed.then(() => {
    closed = true;
  });
  expect(() => op.close()).not.toThrow();
  await turn();
  expect(closed).toBe(false);
  await assertAllBusy();
  mock.sourceExit();
  await op.closed;
  expect((await derive(options)).status).toBe('derived');
});
test.each(['missing', 'rejected'])(
  'invalid %s list drain barrier never becomes owner-release evidence',
  async (mode) => {
    mock.enrollment.directory = '/permanently-invalid-list-barrier-' + mode;
    const original = mock.sourceFactory.getMockImplementation();
    mock.sourceFactory.mockImplementation((options) => {
      const source = original(options);
      if (mode === 'missing') delete source.closed;
      else source.closed = Promise.reject(Error('PRIVATE barrier'));
      return source;
    });
    let settled = false;
    run().then(() => {
      settled = true;
    });
    await turn();
    await turn();
    expect(mock.source.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    await assertAllBusy();
    expect(mock.verify).not.toHaveBeenCalled();
  }
);
