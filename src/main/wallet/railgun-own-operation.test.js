const mockDerive = jest.fn();
jest.mock('./railgun-own-selector', () => ({
  deriveRailgunOwnSelector: (...args) => mockDerive(...args),
}));
let mockEnrollment, mockJournal, mockHandle;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mockEnrollment,
}));
jest.mock('./private-submission-journal', () => ({
  getPrivateSubmissionJournal: (handle) => {
    require('../networks/privacy-context').getPrivacyContext(handle);
    mockHandle = handle;
    return mockJournal;
  },
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  captureRailgunOwnOperation: capture,
  captureRailgunOwnOperationSelector: captureSelector,
} = require('./railgun-own-operation');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const copy = (value) => JSON.parse(JSON.stringify(value));
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
let scope,
  caller,
  reservations,
  capsules,
  entry,
  stored,
  records,
  journalState,
  receipt,
  inRecovery,
  input,
  finish,
  delayFinish;
function configure(unshield = false, archived = false) {
  const fixture = sample(unshield, archived);
  const capsule = fixture.capsule;
  const submitter = unshield ? capsule.selection.recipient : fixture.transaction.from;
  const provedTransaction = {
    chainId: 11155111,
    to: fixture.transaction.to,
    value: '0',
    data: fixture.transaction.input,
  };
  const intent = railgunTransactJournalIntent({ ...provedTransaction, from: submitter });
  fixture.record.intent = { ...intent };
  entry = {
    id: '3'.repeat(64),
    state: 'signing',
    facts: {
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      nullifier: intent.nullifier,
      noteHash: capsule.noteHash,
      kind: capsule.selection.kind,
      intentDigest: intent.intentDigest,
      checkpointHash: '4'.repeat(64),
      poiDigest: '5'.repeat(64),
    },
    signing: { submitter, operationId: '6'.repeat(64), gatesDigest: '7'.repeat(64) },
  };
  stored = {
    holdId: entry.id,
    capsule,
    capsuleDigest: digestRailgunPrivateCapsule(capsule),
    authorizationDigest: '8'.repeat(64),
    signingDigest: '9'.repeat(64),
    provedTransaction,
  };
  records = [{ entry, receipt }];
  journalState = {
    records: archived ? [] : [fixture.record],
    archive: archived ? [fixture.record] : [],
  };
  const { tree, position, nullifier, noteHash } = entry.facts;
  input = {
    enrollment: mockEnrollment,
    signal: caller.signal,
    selector: { tree, position, nullifier, noteHash },
  };
}
beforeEach(() => {
  mockDerive.mockReset();
  caller = new AbortController();
  scope = createPrivacyScope({ profileId: 'own-operation', signal: new AbortController().signal });
  receipt = Object.freeze({});
  inRecovery = false;
  delayFinish = false;
  finish = null;
  reservations = {
    assertReceiptContext: jest.fn((value, kind) => {
      if (!inRecovery || value !== receipt || kind !== 'recovery') throw Error('receipt');
    }),
    assertReceipt: jest.fn(async (value) => {
      reservations.assertReceiptContext(value, 'recovery');
      return copy(entry);
    }),
    withSigningRecovery: jest.fn(async (use) => {
      if (inRecovery) throw Error('phase busy');
      inRecovery = true;
      const controller = new AbortController();
      try {
        const result = await use(records, {
          signal: controller.signal,
          assertCurrent: () => {
            if (!inRecovery || controller.signal.aborted) throw Error('ended');
          },
        });
        if (delayFinish)
          await new Promise((resolve) => {
            finish = resolve;
          });
        return result;
      } finally {
        inRecovery = false;
        controller.abort();
      }
    }),
  };
  capsules = {
    readSigned: jest.fn(async (value) => {
      reservations.assertReceiptContext(value, 'recovery');
      return copy(stored);
    }),
  };
  mockEnrollment = {
    descriptor: { walletId: '1'.repeat(64) },
    binding: '2'.repeat(64),
    signal: scope.signal,
    getContext: () =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        chainId: 11155111,
        protocol: 'railgun',
        deployment: 'sepolia',
        role: 'engine',
      }),
    openReservations: jest.fn(async () => reservations),
    openPrivateCapsules: jest.fn(async () => capsules),
  };
  mockJournal = { readSnapshot: jest.fn(async () => copy(journalState)) };
  configure();
});
afterEach(() => {
  caller.abort();
  scope.close();
  jest.useRealTimers();
});
test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('captures %s/%s from scoped stores as detached data only', async (unshield, archived) => {
  configure(unshield, archived);
  const result = await capture(input);
  expect(result).toHaveProperty('capture');
  expect(result.status).toBe('captured');
  expect(result.capture).toMatchObject({
    version: 1,
    bindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    capsuleDigest: stored.capsuleDigest,
    intent: journalState.records[0]?.intent ?? journalState.archive[0].intent,
    accountAuthenticated: false,
    sourceAuthenticated: false,
    currentFinalityVerified: false,
    txidPathVerified: false,
    txidRootAccepted: false,
    poiVerified: false,
    spendingEnabled: false,
  });
  expect(result.capture.holdId).toBeUndefined();
  expect(result.capture.receipt).toBeUndefined();
  expect(Object.isFrozen(result.capture.record)).toBe(true);
  expect(Object.isFrozen(result.capture.capsule.pathElements)).toBe(true);
  expect(inRecovery).toBe(false);
  expect(() => getPrivacyContext(mockHandle)).toThrow();
  expect(mockJournal.readSnapshot).toHaveBeenCalledTimes(2);
  stored.provedTransaction.data = 'changed';
  expect(result.capture.provedTransaction.data).not.toBe('changed');
});
test.each([
  'missing',
  'duplicate',
  'incomplete',
  'wrong-proof',
  'unresolved-sibling',
  'duplicate-journal',
  'reorg',
  'changed-capsule',
])('refuses %s without leaking snapshots or throwing from recovery', async (mode) => {
  if (mode === 'missing') records = [];
  if (mode === 'duplicate') records.push(records[0]);
  if (mode === 'incomplete') capsules.readSigned.mockRejectedValue(Error('not ready'));
  if (mode === 'wrong-proof') journalState.records[0].intent.digest = '0x' + 'f'.repeat(64);
  if (mode === 'unresolved-sibling')
    journalState.records.push({ hash: 'sibling', resolution: null });
  if (mode === 'duplicate-journal') journalState.archive.push(journalState.records[0]);
  if (mode === 'reorg')
    mockJournal.readSnapshot
      .mockImplementationOnce(async () => copy(journalState))
      .mockImplementationOnce(async () => {
        const next = copy(journalState);
        next.records[0].resolution = null;
        return next;
      });
  if (mode === 'changed-capsule')
    capsules.readSigned
      .mockImplementationOnce(async () => copy(stored))
      .mockImplementationOnce(async () => ({ ...stored, authorizationDigest: 'a'.repeat(64) }));
  const result = await capture(input);
  expect(result).toEqual({ status: 'refused', stage: expect.any(String) });
  expect(inRecovery).toBe(false);
});
test('normal refresh and archival preserve the comparison digest with different raw records', async () => {
  const first = await capture(input);
  journalState.records[0].revision++;
  journalState.records[0].observation.confirmations++;
  journalState.records[0].observation.observedAt++;
  const refreshed = await capture(input);
  expect(refreshed.capture.bindingDigest).toBe(first.capture.bindingDigest);
  configure(false, true);
  const archived = await capture(input);
  expect(archived.capture.bindingDigest).toBe(first.capture.bindingDigest);
  expect(archived.capture.record).not.toEqual(first.capture.record);
});
test('two independently valid but different inclusions refuse at projection comparison', async () => {
  const changed = copy(journalState);
  const record = changed.records[0],
    blockHash = '0x' + 'a'.repeat(64);
  record.observation.blockHash = record.resolution.blockHash = blockHash;
  record.resolution.railgun.transact.blockHash = blockHash;
  expect(require('./railgun-own-txid').projectRailgunOwnRecord(record).blockHash).toBe(blockHash);
  mockJournal.readSnapshot.mockResolvedValueOnce(copy(journalState)).mockResolvedValueOnce(changed);
  expect(await capture(input)).toEqual({ status: 'refused', stage: 'reattest' });
  expect(mockJournal.readSnapshot).toHaveBeenCalledTimes(2);
});
test.each(['refresh', 'archive', 'key-order'])(
  '%s between the two reads preserves binding and returns the latest complete record',
  async (mode) => {
    const baseline = await capture(input);
    const latest = copy(journalState);
    if (mode === 'refresh') {
      latest.records[0].revision++;
      latest.records[0].observation.confirmations++;
      latest.records[0].observation.observedAt++;
    }
    if (mode === 'archive') {
      latest.archive = [sample(false, true).record];
      latest.archive[0].intent = copy(latest.records[0].intent);
      latest.records = [];
    }
    if (mode === 'key-order')
      latest.records[0].intent = Object.fromEntries(
        Object.entries(latest.records[0].intent).reverse()
      );
    mockJournal.readSnapshot
      .mockResolvedValueOnce(copy(journalState))
      .mockResolvedValueOnce(latest);
    const result = await capture(input);
    expect(result.status).toBe('captured');
    expect(result.capture.bindingDigest).toBe(baseline.capture.bindingDigest);
    expect(result.capture.record).toEqual(latest.records[0] ?? latest.archive[0]);
  }
);
test('input is pinned before opening stores and final completion rechecks caller cancellation', async () => {
  const wanted = { ...input.selector };
  mockEnrollment.openReservations.mockImplementation(async () => {
    input.selector.position++;
    return reservations;
  });
  const result = await capture(input);
  expect(result.capture.selector).toEqual(wanted);
  input.selector = wanted;
  mockEnrollment.openReservations.mockResolvedValue(reservations);
  delayFinish = true;
  let settled = false;
  const pending = capture(input).then((value) => {
    settled = true;
    return value;
  });
  for (let i = 0; i < 80 && !finish; i++) await Promise.resolve();
  expect(finish).toEqual(expect.any(Function));
  caller.abort();
  expect(settled).toBe(false);
  expect(inRecovery).toBe(true);
  finish();
  expect((await pending).status).toBe('refused');
  expect(inRecovery).toBe(false);
});
test('invalid enrollment and selectors refuse before store acquisition', async () => {
  for (const options of [
    undefined,
    { ...input, enrollment: {} },
    { ...input, selector: {} },
    { ...input, selector: { ...input.selector, position: 65536 } },
    { ...input, timeoutMs: 175001 },
  ])
    expect((await capture(options)).status).toBe('refused');
  caller.abort();
  expect((await capture(input)).status).toBe('refused');
  expect(mockEnrollment.openReservations).not.toHaveBeenCalled();
});

test('selector executes inside recovery and settles before its final attestation', async () => {
  mockDerive.mockImplementation(async (options) => {
    expect(inRecovery).toBe(true);
    expect(options.provedTransaction).toEqual(stored.provedTransaction);
    expect(options.signal.aborted).toBe(false);
    return Object.freeze({ railgunTxid: '1'.repeat(64), utilityExitObserved: true });
  });
  const result = await captureSelector({ ...input, archive: '/runtime.asar' });
  expect(result.status).toBe('captured');
  expect(result.derived.utilityExitObserved).toBe(true);
  expect(mockDerive).toHaveBeenCalledTimes(1);
  expect(inRecovery).toBe(false);
  expect(capsules.readSigned).toHaveBeenCalledTimes(2);
});
test('selector refusal returns a value inside recovery and permits another capture', async () => {
  mockDerive.mockRejectedValue(Error('selector unavailable'));
  expect(await captureSelector({ ...input, archive: '/runtime.asar' })).toEqual({
    status: 'refused',
    stage: 'selector',
  });
  expect((await capture(input)).status).toBe('captured');
});
test('selector cancellation drains the outstanding derivation before leaving recovery', async () => {
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  mockDerive.mockImplementation(async () => {
    started();
    await new Promise((resolve) => {
      release = resolve;
    });
    return {};
  });
  let settled = false;
  const pending = captureSelector({ ...input, archive: '/runtime.asar' }).then((result) => {
    settled = true;
    return result;
  });
  await entered;
  caller.abort();
  await Promise.resolve();
  expect(inRecovery).toBe(true);
  expect(settled).toBe(false);
  release();
  expect((await pending).status).toBe('refused');
  expect(inRecovery).toBe(false);
});
