let mockEnrollment, mockFenceLive;
jest.mock('./railgun-account-enrollment', () => ({
  assertRailgunFencedAccountEnrollment(value) {
    if (value !== mockEnrollment || !mockFenceLive) throw Error('fence unavailable');
  },
}));
const {
  createRailgunRelayMainProofData,
} = require('../../../scripts/fixtures/railgun-relay-main-proof-data');
let mockAssertIdentity;
jest.mock('./railgun-identity', () => ({
  assertRailgunIdentity: (...args) => mockAssertIdentity(...args),
}));
const { createRailgunWalletRunner } = require('./railgun-wallet-runner');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
// Structural store/job seams; real coverage, read, owned-note and draft normalizers.
function setup(mode = 'construct', identity, enrollment) {
  const f = createRailgunRelayUnsignedData(),
    inventory = '1'.repeat(64),
    policy = '2'.repeat(64);
  const checkpoint = {
    from: 0,
    previousHash: hex(0),
    to: { number: 10, hash: hex(10) },
    anchor: { number: 100, hash: hex(100) },
    logs: { count: 0, sha256: inventory },
    source: {
      level: 'unverified-rpc',
      providersSha256: inventory,
      ledgerId: inventory,
      ledgerSha256: inventory,
    },
    state: {
      schema: 'public-records-v1',
      storeId: inventory,
      trees: [{ tree: 0, length: 8, root: hex(7) }],
      commitments: { count: 8, sha256: inventory },
      nullifiers: { count: 0, sha256: inventory },
      unshields: { count: 0, sha256: inventory },
    },
  };
  const cancel = new AbortController(),
    snapshotCancel = new AbortController(),
    sessionCancel = new AbortController();
  const state = {
    schema: 'wallet-store-v1',
    storeId: '4'.repeat(64),
    count: 0,
    bytes: 0,
    sha256: '5'.repeat(64),
  };
  const session = {
    signal: sessionCancel.signal,
    inspectWalletState: jest.fn(async () => ({ ...state })),
    assertFresh: jest.fn(),
  };
  const grant = { getStatus: jest.fn(() => ({ readOnly: true, writeAttempts: 0 })) };
  const store = {
    session,
    beginRestore: jest.fn(() => grant),
    beginEngine: jest.fn(() => grant),
    finishRestore: jest.fn(),
    finishEngine: jest.fn(),
    close: jest.fn(),
  };
  const result = {
    closed: {
      code: 'RAILGUN_PROCESS_CLOSED',
      exitCode: 15,
      escalated: false,
      peerDisconnected: false,
    },
    inventory,
    spendableGranted: false,
    poiCalls: 0,
    guards: { attempts: 0, hooks: ['synthetic'], canaries: 1 },
    instanceId: f.context.self.address,
    received: [
      {
        tree: 0,
        position: 7,
        hash: hex(12),
        txid: hex(20),
        value: '700',
        spentTxid: false,
        tokenHash: hex(BigInt(pins.wrappedNative)),
        tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      },
    ],
    ownedPoi: [
      {
        id: '0:7',
        hash: hex(12),
        txid: hex(20),
        npk: hex(1),
        nullifier: hex(8),
        blindedCommitment: hex(2),
        type: 'Shield',
        blockNumber: 1,
      },
    ],
    sent: [],
    scannedLeaves: 8,
    expectedReceived: [{ tree: 0, position: 7 }],
    expectedSent: [],
    quarantine: [],
    unrecoverableSent: [],
  };
  const draft = normalizeRailgunRelayDraftCapsule(f.draft);
  const proofData = mode === 'prove' ? createRailgunRelayMainProofData() : undefined;
  if (proofData) {
    result.relayProof = proofData.proof;
    result.ownedPoi[0].blindedCommitment = proofData.record.history.note.blindedCommitment;
    result.ownedPoi[0].type = proofData.record.history.note.type;
  } else if (mode === 'construct') result.relayDraft = f.draft;
  else
    result.relayReconstruction = {
      draftDigest: draft.digest,
      expectedHash: draft.data.intent.expectedHash,
      recoveredOutputs: 2,
    };
  const runJob = jest.fn(async () => result),
    runner = createRailgunWalletRunner({ runJob, inventory, policy, identity, enrollment });
  const args = {
    snapshot: { checkpoint, signal: snapshotCancel.signal },
    walletSession: session,
    coverageStore: store,
    walletId: f.context.walletId,
    relaySignal: cancel.signal,
    ...(proofData
      ? { relayProof: proofData.proofInput }
      : mode === 'construct'
        ? { relayRequest: f.request }
        : { relayDraftText: JSON.stringify(draft.data) }),
  };
  const run = () =>
    runner[
      mode === 'prove'
        ? 'proveRelayReadOnly'
        : mode === 'construct'
          ? 'prepareRelayReadOnly'
          : 'reconstructRelayReadOnly'
    ](args);
  return {
    ...f,
    mode,
    run,
    runner,
    args,
    result,
    runJob,
    store,
    session,
    grant,
    state,
    cancel,
    snapshotCancel,
    sessionCancel,
  };
}
test.each(['construct', 'reconstruct'])(
  '%s is read-only and binds actual normalized owned note/context',
  async (mode) => {
    const f = setup(mode),
      completed = await f.run();
    expect(f.store.beginRestore).toHaveBeenCalledTimes(1);
    expect(f.store.beginEngine).not.toHaveBeenCalled();
    expect(f.runJob.mock.calls[0][0].walletGrant).toBe(f.grant);
    expect(completed.readOnly).toEqual({ readOnly: true, writeAttempts: 0 });
    expect(f.store.finishRestore).toHaveBeenCalledWith(completed.receipt);
    expect(completed.relayOwned.read.received[0].amount).toBe(700n);
    expect(completed.relayOwned.ownedPoi[0].nullifier).toBe(hex(8));
    if (mode === 'construct') expect(completed.relayDraft.reviewedPreparation).toBe(false);
    else expect(completed.relayReconstruction).toEqual(f.result.relayReconstruction);
  }
);
test.each([
  'amount',
  'spent',
  'nullifier',
  'root',
  'self',
  'note',
  'wallet',
  'engine',
  'context',
  'wrong-result',
  'private',
  'write',
  'state',
  'exit',
  'escalated',
  'disconnect',
  'reconstruction-extra',
])('refuses changed %s before finishRestore', async (change) => {
  const f = setup(change === 'reconstruction-extra' ? 'reconstruct' : 'construct');
  if (change === 'amount') f.result.received[0].value = '701';
  if (change === 'spent') f.result.received[0].spentTxid = hex(30);
  if (change === 'nullifier') f.result.ownedPoi[0].nullifier = hex(30);
  if (change === 'root') f.args.snapshot.checkpoint.state.trees[0].root = hex(30);
  if (change === 'self') f.result.instanceId = '0zk1' + 'q'.repeat(123);
  if (change === 'note') {
    f.result.received[0].hash = hex(30);
    f.result.ownedPoi[0].hash = hex(30);
  }
  if (change === 'wallet') f.result.relayDraft.walletId = '33'.repeat(32);
  if (change === 'engine') f.result.relayDraft.engineSha256 = '33'.repeat(32);
  if (change === 'context') f.result.relayDraft.intent.context.self.masterPublicKey = '9';
  if (change === 'wrong-result') f.result.relayReconstruction = {};
  if (change === 'private') f.result.privatePreparation = {};
  if (change === 'write') f.grant.getStatus.mockReturnValue({ readOnly: true, writeAttempts: 1 });
  if (change === 'state')
    f.runJob.mockImplementation(async () => {
      f.state.sha256 = '6'.repeat(64);
      return f.result;
    });
  if (change === 'exit') f.result.closed.exitCode = 0;
  if (change === 'escalated') f.result.closed.escalated = true;
  if (change === 'disconnect') f.result.closed.peerDisconnected = true;
  if (change === 'reconstruction-extra') f.result.relayReconstruction.authorized = true;
  await expect(f.run()).rejects.toThrow();
  expect(f.store.finishRestore).not.toHaveBeenCalled();
  expect(f.store.close).toHaveBeenCalledTimes(1);
});
test('captures context before first state await without freezing caller input', async () => {
  const f = setup(),
    hold = deferred(),
    entered = deferred();
  f.session.inspectWalletState.mockImplementationOnce(() => {
    entered.resolve();
    return hold.promise;
  });
  const work = f.run();
  await entered.promise;
  f.args.relayRequest.context.self.masterPublicKey = '99';
  expect(f.args.relayRequest.context.self.masterPublicKey).toBe('99');
  hold.resolve({ ...f.state });
  await work;
  expect(f.runJob.mock.calls[0][0].relayRequest.context.self.masterPublicKey).toBe('7');
});
test.each(['initial', 'inspect', 'job', 'final-inspect'])(
  'cancellation at %s prevents completion',
  async (where) => {
    const f = setup();
    if (where === 'initial') f.cancel.abort();
    if (where === 'inspect')
      f.session.inspectWalletState.mockImplementationOnce(async () => {
        f.cancel.abort();
        return { ...f.state };
      });
    if (where === 'job')
      f.runJob.mockImplementation(async () => {
        f.cancel.abort();
        return f.result;
      });
    if (where === 'final-inspect')
      f.session.inspectWalletState
        .mockImplementationOnce(async () => ({ ...f.state }))
        .mockImplementationOnce(async () => {
          f.cancel.abort();
          return { ...f.state };
        });
    await expect(f.run()).rejects.toThrow();
    expect(f.store.finishRestore).not.toHaveBeenCalled();
    if (['initial', 'inspect'].includes(where)) expect(f.runJob).not.toHaveBeenCalled();
  }
);
test.each(['privateIntent', 'privateOperation', 'privateRecovery', 'relayDraftText'])(
  'construct refuses dual mode %s before any store/job',
  async (name) => {
    const f = setup();
    f.args[name] = {};
    await expect(f.run()).rejects.toThrow();
    expect(f.session.inspectWalletState).not.toHaveBeenCalled();
    expect(f.runJob).not.toHaveBeenCalled();
  }
);
test.each(['relayRequest', 'relayDraftText', 'relaySignal'])(
  'ordinary route refuses %s',
  async (name) => {
    const f = setup();
    const value = f.args[name] ?? 'not admitted';
    delete f.args.relayRequest;
    delete f.args.relaySignal;
    f.args[name] = value;
    await expect(f.runner.restoreReadOnly(f.args)).rejects.toThrow();
    expect(f.runJob).not.toHaveBeenCalled();
  }
);
test('ordinary route refuses a relay result without issuing receipt', async () => {
  const f = setup();
  delete f.args.relayRequest;
  delete f.args.relaySignal;
  await expect(f.runner.restoreReadOnly(f.args)).rejects.toThrow();
  expect(f.store.finishRestore).not.toHaveBeenCalled();
});
test('relay signal proxy/getter cannot invoke caller code', async () => {
  const f = setup();
  let calls = 0;
  f.args.relaySignal = new Proxy(f.cancel.signal, {
    getPrototypeOf() {
      calls++;
      return AbortSignal.prototype;
    },
  });
  await expect(f.run()).rejects.toThrow();
  expect(calls).toBe(0);
  expect(f.runJob).not.toHaveBeenCalled();
  for (const property of ['aborted', 'reason']) {
    const g = setup();
    Object.defineProperty(g.cancel.signal, property, {
      get() {
        calls++;
        return true;
      },
    });
    await expect(g.run()).rejects.toThrow();
    expect(calls).toBe(0);
    expect(g.runJob).not.toHaveBeenCalled();
  }
  const h = setup();
  Object.setPrototypeOf(h.cancel.signal, Object.create(AbortSignal.prototype));
  await expect(h.run()).rejects.toThrow();
  expect(h.runJob).not.toHaveBeenCalled();
});

test.each(['construct', 'reconstruct'])(
  '%s reauthenticates identity after held final state inspection, independent of live signals',
  async (mode) => {
    const identity = Object.freeze({}),
      entered = deferred(),
      release = deferred();
    let live = true;
    mockAssertIdentity = jest.fn((candidate) => {
      expect(candidate).toBe(identity);
      if (!live)
        throw Object.assign(new Error('synthetic identity revoked'), { code: 'IDENTITY_REVOKED' });
      return { walletId: '11'.repeat(32), instanceId: '0zk1' + 'p'.repeat(123) };
    });
    const f = setup(mode, identity);
    f.session.inspectWalletState
      .mockImplementationOnce(async () => ({ ...f.state }))
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      });
    const work = f.run();
    await entered.promise;
    expect(f.runJob).toHaveBeenCalledTimes(1);
    live = false;
    for (const signal of [f.cancel.signal, f.snapshotCancel.signal, f.sessionCancel.signal])
      expect(signal.aborted).toBe(false);
    release.resolve({ ...f.state });
    await expect(work).rejects.toMatchObject({ code: 'IDENTITY_REVOKED' });
    expect(f.store.finishRestore).not.toHaveBeenCalled();
    expect(f.store.close).toHaveBeenCalledTimes(1);
  }
);

function proofSetup() {
  const identity = Object.freeze({});
  mockEnrollment = {
    binding: createRailgunRelayMainProofData().record.binding,
    getContext: () => 'structural-engine-handle',
  };
  mockFenceLive = true;
  mockAssertIdentity = jest.fn((value) => {
    expect(value).toBe(identity);
    return { walletId: '11'.repeat(32), instanceId: '0zk1' + 'p'.repeat(123) };
  });
  return setup('prove', identity, mockEnrollment);
}
test('local proof restores readonly owned input while retaining original signed root', async () => {
  const f = proofSetup();
  f.args.snapshot.checkpoint.state.trees[0].root = hex(999);
  const result = await f.run();
  expect(result.relayProof).toEqual(f.result.relayProof);
  expect(f.store.finishRestore).toHaveBeenCalledWith(result.receipt);
  expect(result.readOnly).toEqual({ readOnly: true, writeAttempts: 0 });
  expect(f.runJob.mock.calls[0][0].relayEnrollment).toBe(mockEnrollment);
});
test.each([
  'nullifier',
  'blinded',
  'type',
  'amount',
  'spent',
  'position',
  'state',
  'private',
  'dual',
  'unsigned-result',
  'fence',
])('local proof refuses %s without finishing restore', async (mode) => {
  const f = proofSetup();
  if (mode === 'nullifier') f.result.ownedPoi[0].nullifier = hex(77);
  if (mode === 'blinded') f.result.ownedPoi[0].blindedCommitment = hex(77);
  if (mode === 'type') f.result.ownedPoi[0].type = 'Shield';
  if (mode === 'amount') f.result.received[0].value = '701';
  if (mode === 'spent') f.result.received[0].spentTxid = hex(77);
  if (mode === 'position') f.args.snapshot.checkpoint.state.trees[0].length = 7;
  if (mode === 'state')
    f.session.inspectWalletState
      .mockResolvedValueOnce({ ...f.state })
      .mockResolvedValue({ ...f.state, count: 1 });
  if (mode === 'private') f.args.privateIntent = {};
  if (mode === 'dual') f.args.relayDraftText = '{}';
  if (mode === 'unsigned-result') f.result.relayDraft = {};
  if (mode === 'fence') mockFenceLive = false;
  await expect(f.run()).rejects.toThrow();
  expect(f.store.finishRestore).not.toHaveBeenCalled();
});
test.each(['identity', 'fence', 'signal'])(
  'local proof rechecks %s after original final wallet inspection',
  async (mode) => {
    const f = proofSetup(),
      entered = deferred(),
      release = deferred();
    f.session.inspectWalletState
      .mockResolvedValueOnce({ ...f.state })
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      });
    const work = f.run();
    await entered.promise;
    if (mode === 'identity')
      mockAssertIdentity.mockImplementation(() => {
        throw Error('revoked');
      });
    if (mode === 'fence') mockFenceLive = false;
    if (mode === 'signal') f.cancel.abort();
    release.resolve({ ...f.state });
    await expect(work).rejects.toThrow();
    expect(f.store.finishRestore).not.toHaveBeenCalled();
  }
);
test('signed record is captured before first wallet inspection await', async () => {
  const f = proofSetup(),
    entered = deferred(),
    release = deferred(),
    original = f.args.relayProof.recordText;
  f.session.inspectWalletState.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const work = f.run();
  await entered.promise;
  f.args.relayProof.recordText = '{}';
  f.args.relayProof.timeoutMs = 999999;
  release.resolve({ ...f.state });
  await work;
  expect(f.runJob.mock.calls[0][0].relayProof.recordText).toBe(original);
  expect(f.runJob.mock.calls[0][0].relayProof.timeoutMs).toBe(110000);
});
test('ordinary route rejects proof input before inspecting state', async () => {
  const f = proofSetup();
  delete f.args.relaySignal;
  await expect(f.runner.restoreReadOnly(f.args)).rejects.toThrow();
  expect(f.session.inspectWalletState).not.toHaveBeenCalled();
});
