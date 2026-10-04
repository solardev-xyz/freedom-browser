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
  withRailgunOwnOperationRecovery: withRecovery,
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
    close: jest.fn(),
    withSigningRecovery: jest.fn(async (use, { timeoutMs }) => {
      if (inRecovery) throw Error('phase busy');
      inRecovery = true;
      const controller = new AbortController();
      const deadline = performance.now() + timeoutMs;
      const assertCurrent = () => {
        if (!inRecovery || controller.signal.aborted || performance.now() >= deadline)
          throw Error('ended');
      };
      try {
        const result = await use(records, {
          signal: controller.signal,
          deadline,
          assertCurrent,
        });
        if (delayFinish)
          await new Promise((resolve) => {
            finish = resolve;
          });
        assertCurrent(); // Model the real store's post-callback lifetime check.
        return result;
      } catch (error) {
        reservations.close(); // Real withSigningRecovery fail-closes on expiry.
        throw error;
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

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const waitFor = async (check) => {
  for (let i = 0; i < 150 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
};
test('retained recovery shares capture, reattests live, detaches result, and never nests the claim', async () => {
  let window;
  const value = { nested: { accepted: true } };
  const result = await withRecovery(input, async (w) => {
    window = w;
    expect(Object.keys(w).sort()).toEqual(['assertCurrent', 'capture', 'reattest', 'signal']);
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.capture.capsule)).toBe(true);
    expect(w.capture.accountAuthenticated).toBe(false);
    w.assertCurrent(1);
    const fresh = await w.reattest();
    expect(fresh).toEqual(w.capture);
    expect(fresh).not.toBe(w.capture);
    expect(inRecovery).toBe(true);
    return value;
  });
  expect(result).toEqual({ status: 'used', value });
  value.nested.accepted = false;
  expect(result.value.nested.accepted).toBe(true);
  expect(Object.isFrozen(result.value.nested)).toBe(true);
  expect(reservations.withSigningRecovery).toHaveBeenCalledTimes(1);
  expect(mockJournal.readSnapshot).toHaveBeenCalledTimes(4);
  expect(window.signal.aborted).toBe(true);
  expect(() => window.assertCurrent()).toThrow('Railgun own recovery unavailable');
  expect(() => window.reattest()).toThrow('Railgun own recovery unavailable');
  expect(inRecovery).toBe(false);
});
test.each(['hold', 'capsule', 'projection', 'unresolved'])(
  'live %s drift refuses and cannot be swallowed by the callback',
  async (fault) => {
    const result = await withRecovery(input, async (window) => {
      if (fault === 'hold') {
        const changed = copy(entry);
        changed.signing.gatesDigest = 'a'.repeat(64);
        reservations.assertReceipt.mockResolvedValueOnce(changed);
      }
      if (fault === 'capsule') stored.authorizationDigest = 'a'.repeat(64);
      if (fault === 'projection') {
        const record = journalState.records[0],
          hash = '0x' + 'a'.repeat(64);
        record.observation.blockHash = record.resolution.blockHash = hash;
        record.resolution.railgun.transact.blockHash = hash;
        expect(require('./railgun-own-txid').projectRailgunOwnRecord(record).blockHash).toBe(hash);
      }
      if (fault === 'unresolved') journalState.records.push({ resolution: null });
      await expect(window.reattest()).rejects.toThrow('Railgun own recovery unavailable');
      expect(window.signal.aborted).toBe(true);
      return { ignored: true };
    });
    expect(result).toEqual({ status: 'refused', stage: 'reattest' });
    expect(inRecovery).toBe(false);
  }
);
test('routine refresh returns latest record with original stable binding', async () => {
  const result = await withRecovery(input, async (window) => {
    journalState.records[0].revision++;
    journalState.records[0].observation.confirmations++;
    journalState.records[0].observation.observedAt++;
    const fresh = await window.reattest();
    expect(fresh.bindingDigest).toBe(window.capture.bindingDigest);
    expect(fresh.record).toEqual(journalState.records[0]);
    expect(fresh.record).not.toEqual(window.capture.record);
    return true;
  });
  expect(result).toEqual({ status: 'used', value: true });
});
test('fresh final reattestation catches drift after callback result', async () => {
  expect(
    await withRecovery(input, () => {
      stored.authorizationDigest = 'a'.repeat(64);
      return 'result';
    })
  ).toEqual({ status: 'refused', stage: 'reattest' });
});
test('overlapping reattestation refuses synchronously without overlapping store reads', async () => {
  const gate = deferred();
  const result = await withRecovery(input, async (window) => {
    mockJournal.readSnapshot.mockImplementationOnce(async () => {
      await gate.promise;
      return copy(journalState);
    });
    const first = window.reattest();
    await waitFor(() => mockJournal.readSnapshot.mock.calls.length === 3);
    expect(() => window.reattest()).toThrow('Railgun own recovery unavailable');
    expect(mockJournal.readSnapshot).toHaveBeenCalledTimes(3);
    gate.resolve();
    await first;
    await window.reattest();
    return null;
  });
  expect(result).toEqual({ status: 'used', value: null });
});
test('discarded reattestation is observed and drained after immediate window revocation', async () => {
  const gate = deferred();
  let window,
    settled = false;
  const pending = withRecovery(input, async (w) => {
    window = w;
    mockJournal.readSnapshot.mockImplementationOnce(async () => {
      await gate.promise;
      return copy(journalState);
    });
    void w.reattest(); // Deliberately no caller rejection handler.
    await waitFor(() => mockJournal.readSnapshot.mock.calls.length === 3);
    return true;
  }).then((v) => {
    settled = true;
    return v;
  });
  await waitFor(() => window?.signal.aborted);
  expect(settled).toBe(false);
  expect(inRecovery).toBe(true);
  expect(() => window.assertCurrent()).toThrow();
  expect(() => window.reattest()).toThrow();
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'reattest' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(inRecovery).toBe(false);
  expect((await capture(input)).status).toBe('captured');
});
test.each(['caller', 'parent'])(
  '%s revocation drains a pending reattestation and callback before releasing recovery',
  async (which) => {
    const gate = deferred(),
      callbackGate = deferred();
    let window,
      settled = false;
    const pending = withRecovery(input, async (w) => {
      window = w;
      mockJournal.readSnapshot.mockImplementationOnce(async () => {
        await gate.promise;
        return copy(journalState);
      });
      const work = w.reattest();
      await expect(work).rejects.toThrow();
      await callbackGate.promise;
      return true;
    }).then((v) => {
      settled = true;
      return v;
    });
    await waitFor(() => mockJournal.readSnapshot.mock.calls.length === 3);
    if (which === 'caller') caller.abort();
    else scope.close();
    expect(window.signal.aborted).toBe(true);
    expect(() => window.assertCurrent()).toThrow();
    expect(inRecovery).toBe(true);
    expect(settled).toBe(false);
    gate.resolve();
    await Promise.resolve();
    expect(inRecovery).toBe(true);
    callbackGate.resolve();
    expect((await pending).status).toBe('refused');
    expect(inRecovery).toBe(false);
  }
);
test('callback throw is sanitized inside recovery and healthy capture remains possible', async () => {
  expect(
    await withRecovery(input, async (w) => {
      await w.reattest();
      throw Error('private callback detail');
    })
  ).toEqual({ status: 'refused', stage: 'callback' });
  expect((await capture(input)).status).toBe('captured');
});
test.each([
  'oversize',
  'undefined',
  'bigint',
  'function',
  'infinite',
  'cycle',
  'accessor',
  'capability',
  'deep',
])('rejects %s callback output without retaining authority', async (mode) => {
  let value;
  const getter = jest.fn(() => 'private');
  if (mode === 'oversize') value = 'x'.repeat(32767);
  if (mode === 'undefined') value = { omitted: undefined };
  if (mode === 'bigint') value = 1n;
  if (mode === 'function') value = () => {};
  if (mode === 'infinite') value = Infinity;
  if (mode === 'cycle') {
    value = {};
    value.self = value;
  }
  if (mode === 'accessor')
    value = Object.defineProperty({}, 'data', { enumerable: true, get: getter });
  if (mode === 'capability') value = new AbortController().signal;
  if (mode === 'deep') {
    value = {};
    for (let i = 0; i < 66; i++) value = { next: value };
  }
  expect(await withRecovery(input, () => value)).toEqual({ status: 'refused', stage: 'callback' });
  expect(getter).not.toHaveBeenCalled();
  expect((await capture(input)).status).toBe('captured');
});
test('exact 32768-byte callback JSON is accepted', async () => {
  const value = 'x'.repeat(32766);
  expect(await withRecovery(input, () => value)).toEqual({ status: 'used', value });
});
test('window margin checks strict total deadline without waiting for timer dispatch', async () => {
  jest.useFakeTimers();
  let now = 0;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    expect(
      await withRecovery({ ...input, timeoutMs: 1000 }, (window) => {
        window.assertCurrent(999);
        for (const margin of [-1, 0.1, 1000, 2000])
          expect(() => window.assertCurrent(margin)).toThrow();
        now = 500;
        window.assertCurrent(499);
        expect(() => window.assertCurrent(500)).toThrow();
        now = 1000;
        expect(() => window.assertCurrent()).toThrow();
        expect(() => window.reattest()).toThrow();
        return true;
      })
    ).toEqual({ status: 'refused', stage: 'callback' });
  } finally {
    clock.mockRestore();
  }
});
test('window revokes before recovery post-attestation and result waits for it', async () => {
  delayFinish = true;
  let window,
    settled = false;
  const pending = withRecovery(input, (w) => {
    window = w;
    return true;
  }).then((v) => {
    settled = true;
    return v;
  });
  await waitFor(() => typeof finish === 'function');
  expect(window.signal.aborted).toBe(true);
  expect(() => window.assertCurrent()).toThrow();
  expect(inRecovery).toBe(true);
  expect(settled).toBe(false);
  finish();
  expect(await pending).toEqual({ status: 'used', value: true });
});
test('invalid callback refuses before opening stores', async () => {
  expect(await withRecovery(input, null)).toEqual({ status: 'refused', stage: 'context' });
  expect(mockEnrollment.openReservations).not.toHaveBeenCalled();
});

test.each(['callback', 'reattest', 'final-reattest'])(
  'expiry during %s retains recovery until drain then follows store fail-close',
  async (when) => {
    jest.useFakeTimers();
    let now = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
    const gate = deferred(),
      entered = deferred();
    let window,
      settled = false;
    try {
      const pending = withRecovery({ ...input, timeoutMs: 1000 }, async (w) => {
        window = w;
        if (when === 'callback') {
          entered.resolve();
          await gate.promise;
        } else {
          mockJournal.readSnapshot.mockImplementationOnce(async () => {
            entered.resolve();
            await gate.promise;
            return copy(journalState);
          });
          if (when === 'reattest') await w.reattest();
        }
        return true;
      }).then((v) => {
        settled = true;
        return v;
      });
      await entered.promise;
      now = 1000; // No timer dispatch: synchronous deadlines must still reject.
      expect(() => window.assertCurrent()).toThrow();
      expect(settled).toBe(false);
      expect(inRecovery).toBe(true);
      expect(reservations.close).not.toHaveBeenCalled();
      gate.resolve();
      expect(await pending).toEqual({
        status: 'refused',
        stage: when === 'callback' ? 'callback' : 'reattest',
      });
      expect(inRecovery).toBe(false);
      expect(window.signal.aborted).toBe(true);
      expect(reservations.close).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  }
);
test('caller cancellation alone returns a refusal inside recovery without store fail-close', async () => {
  const gate = deferred();
  let window;
  const pending = withRecovery(input, async (w) => {
    window = w;
    await gate.promise;
    return true;
  });
  await waitFor(() => !!window);
  caller.abort();
  expect(window.signal.aborted).toBe(true);
  expect(inRecovery).toBe(true);
  gate.resolve();
  expect(await pending).toEqual({ status: 'refused', stage: 'callback' });
  expect(reservations.close).not.toHaveBeenCalled();
  expect((await capture({ ...input, signal: new AbortController().signal })).status).toBe(
    'captured'
  );
});
test('callback result is detached before the final asynchronous reattestation', async () => {
  const value = { stable: true };
  expect(
    await withRecovery(input, () => {
      mockJournal.readSnapshot.mockImplementationOnce(async () => {
        value.stable = false;
        return copy(journalState);
      });
      return value;
    })
  ).toEqual({ status: 'used', value: { stable: true } });
});

test('final reattestation refuses independently valid stable-projection drift after callback', async () => {
  expect(
    await withRecovery(input, () => {
      const record = journalState.records[0],
        hash = '0x' + 'b'.repeat(64);
      record.observation.blockHash = record.resolution.blockHash = hash;
      record.resolution.railgun.transact.blockHash = hash;
      expect(require('./railgun-own-txid').projectRailgunOwnRecord(record).blockHash).toBe(hash);
      return { proof: 'detached' };
    })
  ).toEqual({ status: 'refused', stage: 'reattest' });
  expect(mockJournal.readSnapshot).toHaveBeenCalledTimes(3);
  expect(reservations.close).not.toHaveBeenCalled();
});
test('retained capture preserves existing archive-transition semantics for controller comparison', async () => {
  expect(
    await withRecovery(input, async (window) => {
      const archived = copy(sample(false, true).record);
      archived.intent = copy(journalState.records[0].intent);
      journalState = { records: [], archive: [archived] };
      const fresh = await window.reattest();
      expect(fresh.bindingDigest).toBe(window.capture.bindingDigest);
      expect(fresh.record).toEqual(archived);
      expect(fresh.record).not.toEqual(window.capture.record);
      return true;
    })
  ).toEqual({ status: 'used', value: true });
});

test.each([undefined, null, false, [], 'options'])(
  'malformed recovery options %s return context refusal before stores',
  async (options) => {
    const use = jest.fn();
    expect(await withRecovery(options, use)).toEqual({ status: 'refused', stage: 'context' });
    expect(use).not.toHaveBeenCalled();
    expect(mockEnrollment.openReservations).not.toHaveBeenCalled();
  }
);

test('shorter recovery deadline bounds margins and expiry even while outer deadline remains live', async () => {
  jest.useFakeTimers();
  let now = 0;
  const clock = jest.spyOn(performance, 'now').mockImplementation(() => now);
  const original = reservations.withSigningRecovery.getMockImplementation();
  reservations.withSigningRecovery.mockImplementation((use, options) =>
    original((records, context) => use(records, { ...context, deadline: 500 }), options)
  );
  try {
    expect(
      await withRecovery({ ...input, timeoutMs: 1000 }, async (window) => {
        window.assertCurrent(499);
        expect(() => window.assertCurrent(500)).toThrow('Railgun own recovery unavailable');
        now = 100;
        window.assertCurrent(399);
        expect(() => window.assertCurrent(400)).toThrow('Railgun own recovery unavailable');
        expect((await window.reattest()).bindingDigest).toBe(window.capture.bindingDigest);
        now = 500;
        expect(() => window.assertCurrent()).toThrow('Railgun own recovery unavailable');
        expect(() => window.reattest()).toThrow('Railgun own recovery unavailable');
        return true;
      })
    ).toEqual({ status: 'refused', stage: 'callback' });
  } finally {
    clock.mockRestore();
  }
});
test.each([
  'missing',
  'undefined',
  'nan',
  'positive-infinity',
  'negative-infinity',
  'string',
  'null',
])('%s recovery deadline refuses before reading hold or entering callback', async (kind) => {
  const values = {
    undefined: undefined,
    nan: NaN,
    'positive-infinity': Infinity,
    'negative-infinity': -Infinity,
    string: '100000',
    null: null,
  };
  const original = reservations.withSigningRecovery.getMockImplementation();
  reservations.withSigningRecovery.mockImplementation((use, options) =>
    original((records, context) => {
      const altered = { ...context };
      if (kind === 'missing') delete altered.deadline;
      else altered.deadline = values[kind];
      return use(records, altered);
    }, options)
  );
  const use = jest.fn();
  expect(await withRecovery(input, use)).toEqual({ status: 'refused', stage: 'context' });
  expect(use).not.toHaveBeenCalled();
  expect(reservations.assertReceipt).not.toHaveBeenCalled();
  expect(capsules.readSigned).not.toHaveBeenCalled();
  expect(mockJournal.readSnapshot).not.toHaveBeenCalled();
  expect(inRecovery).toBe(false);
  expect(reservations.close).not.toHaveBeenCalled();
});
