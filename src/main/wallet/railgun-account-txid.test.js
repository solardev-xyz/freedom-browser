let mockEnrollment, mockCoordinator, mockRunner, mockJournal, mockRoots, mockServices, mockSession;
const mockOpen = jest.fn(),
  mockKey = jest.fn(),
  mockCreateJournal = jest.fn(),
  mockCreateRunner = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-account-public', () => ({
  getRailgunAccountPublicIdentity: (c, e) => {
    if (c !== mockCoordinator || e !== mockEnrollment || c.signal.aborted) throw Error('public');
    return { generationId: 'a'.repeat(64), sourceId: 'b'.repeat(64), publicId: 'c'.repeat(64) };
  },
  openRailgunAccountPublicTxidStore: (...args) => mockOpen(...args),
  withRailgunAccountTxidJournalKey: (...args) => mockKey(...args),
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'd'.repeat(64) }));
jest.mock('./railgun-txid-policy', () => ({
  getRailgunTxidPolicy: () => 'e'.repeat(64),
  railgunTxidBinding: () => 'f'.repeat(64),
}));
jest.mock('./railgun-txid-runner', () => ({
  createRailgunTxidRunner: (...args) => mockCreateRunner(...args),
}));
jest.mock('./railgun-txid-journal', () => ({
  createRailgunTxidJournal: (...args) => mockCreateJournal(...args),
}));
jest.mock('./railgun-txid-root', () => ({ createRailgunTxidRootSource: () => mockRoots }));
jest.mock('./railgun-public-services', () => ({ createRailgunPublicServices: () => mockServices }));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
let scope, opened, events, state, directory, publicController, finishWorker;
beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  opened = [];
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-txid-')));
  mockEnrollment = {
    directory,
    binding: '1'.repeat(64),
    signal: scope.signal,
    profileGuard: { assert: jest.fn() },
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
  };
  publicController = new AbortController();
  mockCoordinator = { identity: { directory }, signal: publicController.signal };
  const controller = new AbortController();
  mockSession = {
    signal: controller.signal,
    closed: new Promise((resolve) => {
      finishWorker = resolve;
    }),
    close: jest.fn(() => {
      controller.abort();
      finishWorker();
    }),
  };
  mockOpen.mockImplementation(async ({ create }) => {
    if (create)
      fs.writeFileSync(path.join(directory, 'txid-' + 'e'.repeat(64) + '.sqlite'), 'fixture');
    return {
      filename: path.join(directory, 'txid-' + 'e'.repeat(64) + '.sqlite'),
      session: mockSession,
    };
  });
  mockKey.mockImplementation(async (_c, _e, _p, _t, use) => use(Buffer.alloc(32, 4)));
  state = { checkpoint: null, pending: null };
  const empty = { count: 0, root: '0'.repeat(64), after: '0x00' };
  mockRunner = {
    signal: controller.signal,
    run: jest.fn(async (mode, payload) => {
      events.push(mode);
      const current = state.pending?.work.expected ?? state.checkpoint?.state ?? empty;
      const next =
        mode === 'project'
          ? { ...current, count: payload.base.count + payload.rows.length, after: 'next' }
          : current;
      return { value: { state: next }, receipt: { mode } };
    }),
    assertResult: jest.fn(),
    close: jest.fn(),
  };
  mockCreateRunner.mockImplementation(() => mockRunner);
  mockJournal = {
    signal: controller.signal,
    readState: jest.fn(async () => structuredClone(state)),
    revalidate: jest.fn(async () => {
      events.push('revalidate');
    }),
    prepare: jest.fn(async (payload) => {
      events.push('prepare');
      state.pending = { work: payload };
      return {};
    }),
    resume: jest.fn(async () => {
      events.push('resume');
      return {};
    }),
    complete: jest.fn(async () => {
      events.push('complete');
      state = { checkpoint: { state: state.pending.work.expected }, pending: null };
    }),
    close: jest.fn(),
  };
  mockCreateJournal.mockImplementation(async ({ handle, directory }) => {
    fs.writeFileSync(getPrivacyStoragePath(handle, directory), 'fixture');
    return mockJournal;
  });
  mockRoots = {
    signal: controller.signal,
    acquire: jest.fn(async () => {
      events.push('root');
      return {};
    }),
    assertRoot: jest.fn(),
    close: jest.fn(),
  };
  mockServices = {
    signal: controller.signal,
    latestTxid: jest.fn(async () => ({ index: 1, root: '0'.repeat(64) })),
    txidPage: jest.fn(async () => ({ transactions: [{ row: 1 }, { row: 2 }, { row: 3 }] })),
    close: jest.fn(),
  };
});
afterEach(async () => {
  finishWorker();
  await Promise.all(opened.map((v) => v.close()));
  scope.close();
});
async function open(options = {}) {
  const value = await openRailgunAccountTxid({
    enrollment: mockEnrollment,
    coordinator: mockCoordinator,
    archive: '/engine.asar',
    create: true,
    ...options,
  });
  opened.push(value);
  return value;
}
test('uses owned keys and bounded live pages, validating roots before fresh projection and durable apply', async () => {
  const value = await open();
  expect(mockCreateRunner.mock.calls[0][0].binding).toBe('f'.repeat(64));
  expect(mockCreateJournal.mock.calls[0][0]).toMatchObject({
    policy: 'e'.repeat(64),
    binding: 'f'.repeat(64),
    create: true,
  });
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  events.length = 0;
  const result = await value.advance();
  expect(result.checkpoint.state.count).toBe(2);
  expect(mockJournal.prepare.mock.calls[0][0].rows).toHaveLength(2);
  expect(events).toEqual([
    'inspect',
    'project',
    'root',
    'project',
    'prepare',
    'apply',
    'root',
    'apply',
    'complete',
  ]);
  expect(typeof value.witness).toBe('function');
  await value.close();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});
test.each(['base', 'expected'])(
  'pending durable work at %s is revalidated and completed before opening returns',
  async (stored) => {
    const payload = {
      base: { count: 0 },
      rows: [{}],
      expected: { count: 1, root: '0'.repeat(64) },
    };
    state.pending = { work: payload };
    let actual = payload[stored];
    const replays = [];
    mockRunner.run.mockImplementation(async (mode) => {
      events.push(mode);
      if (mode === 'apply') {
        replays.push(actual === payload.expected);
        actual = payload.expected;
      }
      return { value: { state: actual }, receipt: { mode } };
    });
    await open();
    expect(events).toEqual(['root', 'inspect', 'resume', 'apply', 'root', 'apply', 'complete']);
    expect(mockRunner.run).toHaveBeenCalledWith('apply', payload);
    expect(replays).toEqual([stored === 'expected', true]);
  }
);
test('a root call longer than receipt freshness is followed by a fresh replay receipt', async () => {
  const value = await open();
  jest.useFakeTimers();
  try {
    const originalRun = mockRunner.run.getMockImplementation();
    const applies = [];
    mockRunner.run.mockImplementation(async (mode, payload) => {
      const result = await originalRun(mode, payload);
      const receipt = { mode, at: performance.now() };
      if (mode === 'apply') applies.push(receipt);
      return { ...result, receipt };
    });
    mockRoots.acquire.mockImplementation(async () => {
      jest.advanceTimersByTime(61001);
      return { at: performance.now() };
    });
    const originalComplete = mockJournal.complete.getMockImplementation();
    mockJournal.complete.mockImplementation(async (token, apply, root) => {
      expect(performance.now() - applies[0].at).toBeGreaterThan(60000);
      expect(apply).toBe(applies[1]);
      expect(performance.now() - apply.at).toBeLessThan(60000);
      expect(performance.now() - root.at).toBeLessThan(60000);
      return originalComplete(token, apply, root);
    });
    await value.advance();
    expect(applies).toHaveLength(2);
    expect(mockJournal.complete).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
test('missing initialized files and forged coordinator refuse before creating a store', async () => {
  await expect(open({ create: false })).rejects.toThrow();
  await expect(open({ coordinator: { ...mockCoordinator } })).rejects.toThrow();
  expect(mockOpen).not.toHaveBeenCalled();
  const claim = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  claim.release();
});
test('root refusal prevents journal preparation and drains before another phase', async () => {
  const value = await open();
  mockRoots.acquire.mockRejectedValueOnce(Error('root refused'));
  await expect(value.advance()).rejects.toThrow('root refused');
  expect(mockJournal.prepare).not.toHaveBeenCalled();
  expect(mockRunner.run.mock.calls.filter(([mode]) => mode === 'apply')).toHaveLength(0);
  expect(value.signal.aborted).toBe(true);
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});
test('revocation retains phase until an in-flight job and storage worker both finish', async () => {
  const value = await open();
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  mockRunner.run.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  mockSession.close.mockImplementation(() => {});
  const advancing = value.advance();
  advancing.catch(() => {});
  await ready;
  publicController.abort();
  let done = false;
  const closing = value.close().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  finish({ value: { state: { count: 0 } }, receipt: {} });
  await new Promise((resolve) => setImmediate(resolve));
  expect(done).toBe(false);
  finishWorker();
  await closing;
  await expect(advancing).rejects.toThrow();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});
test('opening failure waits for a late worker before releasing its phase', async () => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const original = mockOpen.getMockImplementation();
  mockOpen.mockImplementation(async (options) => {
    const result = await original(options);
    started();
    await new Promise((resolve) => {
      finish = resolve;
    });
    return result;
  });
  const opening = open();
  opening.catch(() => {});
  await ready;
  publicController.abort();
  expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
  finish();
  await expect(opening).rejects.toThrow();
  expect(mockSession.close).toHaveBeenCalled();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});
test('a service ahead of capacity still allows the final supported row and reports the limit', async () => {
  state.checkpoint = { state: { count: 7999, root: '0'.repeat(64), after: 'previous' } };
  mockServices.latestTxid.mockResolvedValue({ index: 9000, root: '0'.repeat(64) });
  const value = await open();
  const result = await value.advance();
  expect(result.checkpoint.state.count).toBe(8000);
  expect(result.capacityReached).toBe(true);
  expect(result.serviceLatestIndex).toBe(9000);
  expect(mockJournal.prepare.mock.calls[0][0].rows).toHaveLength(1);
  const calls = mockServices.txidPage.mock.calls.length;
  expect((await value.advance()).capacityReached).toBe(true);
  expect(mockServices.txidPage).toHaveBeenCalledTimes(calls);
});
test('asynchronous worker revocation closes the composition even while idle', async () => {
  const value = await open();
  mockSession.close();
  await value.close();
  expect(value.signal.aborted).toBe(true);
  await expect(value.advance()).rejects.toThrow();
  const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
  phase.release();
});
test('coverage uses the public snapshot source and rechecks its evidence before returning diagnostics', async () => {
  const value = await open();
  await value.advance();
  const plan = {
    source: { ledgerId: 'b'.repeat(64), ledgerSha256: '9'.repeat(64) },
    to: { number: 10 },
  };
  const visit = jest.fn(),
    evidence = {};
  mockCoordinator.withPublicSnapshot = jest.fn(async (run) => ({
    value: await run({ checkpoint: plan, visitSource: visit, signal: scope.signal }),
    evidence,
  }));
  mockCoordinator.assertSnapshot = jest.fn((token) => {
    expect(token).toBe(evidence);
    return plan;
  });
  const coverage = {
    txid: { ...state.checkpoint.state },
    source: plan.source,
    checkedCount: 1,
    globalTxidCompleteness: false,
    spendingEnabled: false,
  };
  const original = mockRunner.run.getMockImplementation();
  mockRunner.run.mockImplementation(async (mode, payload, source) => {
    if (mode !== 'coverage') return original(mode, payload);
    expect(source).toEqual({ visit, signal: scope.signal });
    expect(payload.plan).toBe(plan);
    return { value: { coverage }, receipt: {} };
  });
  mockRunner.assertResult.mockReturnValue({ coverage });
  expect(await value.cover()).toBe(coverage);
  expect(mockCoordinator.assertSnapshot).toHaveBeenCalledTimes(1);
  mockCoordinator.assertSnapshot.mockImplementationOnce(() => {
    throw Error('stale source');
  });
  await expect(value.cover()).rejects.toThrow('stale source');
  expect(value.signal.aborted).toBe(true);
});
test.each(['witness', 'witnessNote'])(
  '%s returns diagnostic values after revalidation without exposing runner receipts',
  async (method) => {
    const account = await open();
    await account.advance();
    state.checkpoint.state = { ...state.checkpoint.state, transcript: '3'.repeat(64), breaks: [] };
    const row = {
      version: 'V2',
      graphID: '0x' + '1'.padStart(64, '0') + '0'.repeat(128),
      commitments: ['0x' + '1'.repeat(64)],
      nullifiers: ['0x' + '2'.repeat(64)],
      boundParamsHash: '0x' + '0'.repeat(64),
      blockNumber: 1,
      txid: '4'.repeat(64),
      timestamp: 1,
      utxoTreeIn: 0,
      utxoTreeOut: 1,
      utxoBatchStartPositionOut: 1,
      verificationHash: '0x' + '5'.repeat(64),
    };
    const witness = {
      row,
      leaf: '1'.repeat(64),
      railgunTxid: '2'.repeat(64),
      rowSha256: require('crypto').createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      index: 1,
      elements: Array(16).fill('0'.repeat(64)),
      root: state.checkpoint.state.root,
      checkpointIndex: 1,
      transcript: state.checkpoint.state.transcript,
      continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(1, []),
      globalTxidCompleteness: false,
    };
    const note = {
      type: 'Transact',
      txid: '0x' + row.txid,
      hash: row.commitments[0],
      tree: 1,
      position: 1,
      blockNumber: 1,
    };
    const observation =
      method === 'witness'
        ? witness
        : {
            note,
            outputIndex: 0,
            witness,
            ownershipVerified: false,
            eventCoverageVerified: false,
            rootAccepted: false,
            spendingEnabled: false,
          };
    const mode = method === 'witness' ? 'witness' : 'note-witness';
    const key = method === 'witness' ? 'witness' : 'noteWitness';
    const selector = method === 'witness' ? '2'.repeat(64) : note;
    mockRunner.assertResult.mockReturnValue({ [key]: observation });
    const result = await account[method](selector);
    expect(mockRunner.assertResult).toHaveBeenLastCalledWith({ mode }, mode, {
      state: state.checkpoint.state,
      [method === 'witness' ? 'txid' : 'note']: selector,
    });
    expect(result[key]).toEqual(observation);
    expect(result[key]).not.toBe(observation);
    expect(Object.isFrozen(result[key])).toBe(true);
    expect(result).not.toHaveProperty('receipt');
    expect(result).toMatchObject({
      ownershipVerified: false,
      eventCoverageVerified: false,
      rootAccepted: false,
      spendingEnabled: false,
    });
    await account.close();
    await expect(account[method](selector)).rejects.toThrow();
  }
);
test('note witness snapshots the selector at invocation and refuses stale computation', async () => {
  const account = await open();
  await account.advance();
  const note = { type: 'Transact', tree: 1 };
  mockRunner.assertResult.mockImplementation(() => {
    throw Error('stale result');
  });
  const pending = account.witnessNote(note);
  note.tree = 2;
  await expect(pending).rejects.toThrow('stale result');
  expect(mockRunner.run).toHaveBeenLastCalledWith('note-witness', {
    state: state.checkpoint.state,
    note: { type: 'Transact', tree: 1 },
  });
  expect(account.signal.aborted).toBe(true);
});
test('empty TXID journal cannot issue a note witness', async () => {
  const account = await open();
  await expect(account.witnessNote({ type: 'Transact' })).rejects.toThrow();
  expect(mockRunner.run.mock.calls.some(([mode]) => mode === 'note-witness')).toBe(false);
});

function existingCheckpoint() {
  state = {
    checkpoint: { state: { count: 1, root: '0'.repeat(64), after: 'existing' } },
    pending: null,
  };
  fs.writeFileSync(path.join(directory, 'txid-' + 'e'.repeat(64) + '.sqlite'), 'existing');
  fs.writeFileSync(
    getPrivacyStoragePath(
      mockEnrollment.getContext('storage', 'railgun-txid-v1:' + 'e'.repeat(64)),
      directory
    ),
    'existing'
  );
}
test('checkpoint-only opening revalidates existing root evidence without creating or replaying', async () => {
  existingCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  expect(events).toEqual(['root', 'inspect', 'revalidate']);
  expect(mockOpen.mock.calls[0][0].create).toBe(false);
  expect(mockCreateJournal.mock.calls[0][0].create).toBe(false);
  expect((await value.inspect()).checkpoint).toEqual(state.checkpoint);
  expect(mockJournal.resume).not.toHaveBeenCalled();
  expect(mockJournal.prepare).not.toHaveBeenCalled();
  expect(mockJournal.complete).not.toHaveBeenCalled();
});
test.each(['missing', 'pending', 'empty', 'capacity'])(
  'checkpoint-only %s state refuses before service acquisition or replay',
  async (mode) => {
    existingCheckpoint();
    if (mode === 'missing') state.checkpoint = null;
    if (mode === 'pending') state.pending = { work: { expected: state.checkpoint.state } };
    if (mode === 'empty') state.checkpoint.state.count = 0;
    if (mode === 'capacity') state.checkpoint.state.count = 8001;
    await expect(open({ create: false, checkpointOnly: true })).rejects.toMatchObject({
      code: 'RAILGUN_ACCOUNT_TXID_REFUSED',
    });
    expect(mockRoots.acquire).not.toHaveBeenCalled();
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(mockJournal.resume).not.toHaveBeenCalled();
    expect(mockJournal.complete).not.toHaveBeenCalled();
    const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
    phase.release();
  }
);
test('checkpoint-only mode refuses advance without fetching a page or modifying the journal', async () => {
  existingCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  events.length = 0;
  await expect(value.advance()).rejects.toThrow();
  expect(events).toEqual([]);
  expect(mockServices.latestTxid).not.toHaveBeenCalled();
  expect(mockServices.txidPage).not.toHaveBeenCalled();
  expect(mockJournal.prepare).not.toHaveBeenCalled();
});
test.each(['pending', 'checkpoint'])(
  'checkpoint-only witness refuses newly %s state before refreshing or computing',
  async (mode) => {
    existingCheckpoint();
    const value = await open({ create: false, checkpointOnly: true });
    if (mode === 'pending') state.pending = { work: { expected: state.checkpoint.state } };
    else state.checkpoint.state.root = '1'.repeat(64);
    events.length = 0;
    mockRoots.acquire.mockClear();
    mockRunner.run.mockClear();
    await expect(value.witness('0'.repeat(64))).rejects.toThrow();
    expect(events).toEqual([]);
    expect(mockRoots.acquire).not.toHaveBeenCalled();
    expect(mockRunner.run).not.toHaveBeenCalled();
  }
);
test('checkpoint-only mode requires existing files and rejects incompatible creation options', async () => {
  await expect(open({ create: false, checkpointOnly: true })).rejects.toThrow();
  await expect(open({ create: true, checkpointOnly: true })).rejects.toThrow();
  await expect(open({ checkpointOnly: 'true' })).rejects.toThrow();
  expect(mockOpen).not.toHaveBeenCalled();
});

test('checkpoint-only diagnostics cannot silently adopt changed store metadata with the same root', async () => {
  existingCheckpoint();
  state.checkpoint.store = { identity: 'original' };
  const value = await open({ create: false, checkpointOnly: true });
  state.checkpoint.store.identity = 'replacement';
  events.length = 0;
  await expect(value.inspect()).rejects.toThrow();
  expect(events).toEqual([]);
});

test('handoff requires checkpoint-only mode before touching public stores', async () => {
  await expect(open({ create: false, handoff: {} })).rejects.toThrow();
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
});

test('a failed handoff opening drains its worker but leaves reservation ownership with staging', async () => {
  existingCheckpoint();
  const wallet = claimRailgunAccountPhase(mockEnrollment, 'wallet'),
    handoff = wallet.reserveHandoff();
  wallet.release();
  let entered,
    settled = false;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  mockRoots.acquire.mockImplementation(async () => {
    entered();
    throw Error('root refused');
  });
  mockSession.close.mockImplementation(() => {});
  const opening = open({ create: false, checkpointOnly: true, handoff: handoff.token });
  const observed = opening.catch((error) => {
    settled = true;
    return error;
  });
  try {
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet', handoff.token)).toThrow();
    finishWorker();
    expect(await observed).toBeInstanceOf(Error);
    handoff.assertCurrent();
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
    const next = claimRailgunAccountPhase(mockEnrollment, 'wallet', handoff.token);
    next.release();
  } finally {
    finishWorker();
    await observed;
    handoff.release();
  }
});

function historicalCheckpoint(count = 5) {
  existingCheckpoint();
  state.checkpoint.state = {
    version: 1,
    count,
    root: '1'.repeat(64),
    after: '0x' + count.toString(16).padStart(64, '0') + '0'.repeat(128),
    verificationHash: '0x' + '0'.repeat(64),
    branches: Array(16).fill(null),
    breaks: [],
    transcript: '3'.repeat(64),
  };
}
function historicalFacts(index = 1, checkpoint = state.checkpoint.state) {
  return {
    version: 1,
    tree: 0,
    index,
    root: index === checkpoint.count - 1 ? checkpoint.root : '0'.repeat(64),
    checkpointIndex: checkpoint.count - 1,
    checkpointRoot: checkpoint.root,
    transcript: checkpoint.transcript,
    localPrefixComputed: true,
    globalTxidCompleteness: false,
    ownershipVerified: false,
    eventCoverageVerified: false,
    rootAccepted: false,
    spendingEnabled: false,
  };
}
test('historical root uses only fixed index/current checkpoint and returns detached diagnostics', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  const facts = historicalFacts();
  mockRunner.assertResult.mockReturnValue({ historicalRoot: facts });
  events.length = 0;
  const result = await value.historicalRoot(1);
  expect(events).toEqual(['root', 'inspect', 'revalidate', 'historical-root']);
  expect(mockRunner.run).toHaveBeenLastCalledWith('historical-root', {
    state: state.checkpoint.state,
    index: 1,
  });
  expect(mockRunner.assertResult).toHaveBeenLastCalledWith(
    { mode: 'historical-root' },
    'historical-root',
    { state: state.checkpoint.state, index: 1 }
  );
  expect(result).toEqual(facts);
  expect(result).not.toBe(facts);
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty('receipt');
  expect(result).not.toHaveProperty('expectedRoot');
  facts.root = '2'.repeat(64);
  expect(result.root).toBe('0'.repeat(64));
  expect(mockServices.txidPage).not.toHaveBeenCalled();
  expect(mockJournal.prepare).not.toHaveBeenCalled();
  expect(mockJournal.resume).not.toHaveBeenCalled();
  expect(mockJournal.complete).not.toHaveBeenCalled();
});
test.each([0, 4, 7999])('historical root handles boundary index %i', async (index) => {
  historicalCheckpoint(index === 7999 ? 8000 : 5);
  const value = await open({ create: false, checkpointOnly: true });
  mockRunner.assertResult.mockReturnValue({ historicalRoot: historicalFacts(index) });
  expect((await value.historicalRoot(index)).index).toBe(index);
});
test.each([undefined, null, '1', 1n, -1, 0.5, NaN, Infinity, 8000, {}, { valueOf: () => 1 }])(
  'historical root rejects invalid primitive index %p before scheduling work',
  async (index) => {
    historicalCheckpoint();
    const value = await open({ create: false, checkpointOnly: true });
    mockRunner.run.mockClear();
    mockRoots.acquire.mockClear();
    await expect(Promise.resolve().then(() => value.historicalRoot(index))).rejects.toThrow();
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(mockRoots.acquire).not.toHaveBeenCalled();
    expect(value.signal.aborted).toBe(false);
  }
);
test('historical root refuses index beyond the current checkpoint before historical computation', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  mockRunner.run.mockClear();
  await expect(value.historicalRoot(5)).rejects.toThrow();
  expect(mockRunner.run.mock.calls.some(([mode]) => mode === 'historical-root')).toBe(false);
});
test.each([
  ['version', 2],
  ['tree', 1],
  ['index', 2],
  ['checkpointIndex', 5],
  ['checkpointRoot', '2'.repeat(64)],
  ['transcript', '4'.repeat(64)],
  ['root', '0x' + '0'.repeat(64)],
  ['root', 'A'.repeat(64)],
  ['root', '30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001'],
  ['root', 'f'.repeat(64)],
  ['localPrefixComputed', false],
  ...[
    'globalTxidCompleteness',
    'ownershipVerified',
    'eventCoverageVerified',
    'rootAccepted',
    'spendingEnabled',
  ].map((name) => [name, true]),
  ['localPrefixComputed', 1],
  ['rootAccepted', 0],
])('historical result refuses malformed/mismatched %s=%p', async (key, replacement) => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  mockRunner.assertResult.mockReturnValue({
    historicalRoot: { ...historicalFacts(), [key]: replacement },
  });
  await expect(value.historicalRoot(1)).rejects.toMatchObject({
    code: 'RAILGUN_ACCOUNT_TXID_REFUSED',
  });
  expect(value.signal.aborted).toBe(true);
});
test.each(['extra', 'missing', 'array', 'null', 'oversize'])(
  'historical result rejects %s shape',
  async (kind) => {
    historicalCheckpoint();
    const value = await open({ create: false, checkpointOnly: true });
    let facts = historicalFacts();
    if (kind === 'extra') facts.expectedRoot = facts.root;
    if (kind === 'missing') delete facts.rootAccepted;
    if (kind === 'array') facts = [facts];
    if (kind === 'null') facts = null;
    if (kind === 'oversize') facts.root = '0'.repeat(4097);
    mockRunner.assertResult.mockReturnValue({ historicalRoot: facts });
    await expect(value.historicalRoot(1)).rejects.toThrow();
  }
);
test('latest historical root must equal the current authenticated root', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  mockRunner.assertResult.mockReturnValue({
    historicalRoot: { ...historicalFacts(4), root: '0'.repeat(64) },
  });
  await expect(value.historicalRoot(4)).rejects.toThrow();
});
test('historical root refuses an otherwise shaped stale runner receipt', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  mockRunner.assertResult.mockImplementation(() => {
    throw Error('stale job observation');
  });
  await expect(value.historicalRoot(1)).rejects.toThrow('stale job observation');
  expect(value.signal.aborted).toBe(true);
});
test.each(['pending', 'checkpoint', 'metadata'])(
  'historical checkpoint-only read rejects newly changed %s before root refresh',
  async (kind) => {
    historicalCheckpoint();
    state.checkpoint.store = { identity: 'original' };
    const value = await open({ create: false, checkpointOnly: true });
    if (kind === 'pending') state.pending = { work: { expected: state.checkpoint.state } };
    else if (kind === 'metadata') state.checkpoint.store.identity = 'replacement';
    else state.checkpoint.state.transcript = '4'.repeat(64);
    mockRunner.run.mockClear();
    mockRoots.acquire.mockClear();
    await expect(value.historicalRoot(1)).rejects.toThrow();
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(mockRoots.acquire).not.toHaveBeenCalled();
  }
);
test('historical checkpoint-only rechecks the pin on the second journal read', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  let calls = 0;
  mockJournal.readState.mockImplementation(async () => {
    const current = structuredClone(state);
    if (++calls === 2) current.checkpoint.state.transcript = '4'.repeat(64);
    return current;
  });
  mockRunner.run.mockClear();
  await expect(value.historicalRoot(1)).rejects.toThrow();
  expect(mockRunner.run.mock.calls.map(([mode]) => mode)).toEqual(['inspect']);
});
test('historical reader cannot open an old-policy-only store as the new policy', async () => {
  const oldPolicy = 'a'.repeat(64);
  const oldFile = path.join(directory, 'txid-' + oldPolicy + '.sqlite');
  const oldJournal = getPrivacyStoragePath(
    mockEnrollment.getContext('storage', 'railgun-txid-v1:' + oldPolicy),
    directory
  );
  fs.writeFileSync(oldFile, 'old-policy-sentinel');
  fs.writeFileSync(oldJournal, 'old-policy-journal');
  await expect(open({ create: false, checkpointOnly: true })).rejects.toThrow();
  expect(mockOpen).not.toHaveBeenCalled();
  expect(mockKey).not.toHaveBeenCalled();
  expect(mockRunner.run).not.toHaveBeenCalled();
  expect(fs.readFileSync(oldFile, 'utf8')).toBe('old-policy-sentinel');
  expect(fs.readFileSync(oldJournal, 'utf8')).toBe('old-policy-journal');
  expect(fs.existsSync(path.join(directory, 'txid-' + 'e'.repeat(64) + '.sqlite'))).toBe(false);
});
test('historical computation retains phase until ignored job and storage worker drain', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  let finish, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const original = mockRunner.run.getMockImplementation();
  mockRunner.run.mockImplementation((mode, input) => {
    if (mode !== 'historical-root') return original(mode, input);
    entered();
    return new Promise((resolve) => {
      finish = () => resolve({ value: { historicalRoot: historicalFacts() }, receipt: { mode } });
    });
  });
  mockSession.close.mockImplementation(() => {});
  const pending = value.historicalRoot(1);
  const refused = expect(pending).rejects.toThrow();
  let settled = false;
  try {
    await ready;
    publicController.abort();
    const closing = value.close().then(() => {
      settled = true;
    });
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(() => claimRailgunAccountPhase(mockEnrollment, 'wallet')).toThrow();
    expect(mockRunner.assertResult).not.toHaveBeenCalled();
    finishWorker();
    await closing;
    await refused;
    const phase = claimRailgunAccountPhase(mockEnrollment, 'wallet');
    phase.release();
  } finally {
    finish?.();
    finishWorker();
    await refused;
  }
});
test('overlapping historical reader refuses without closing the first computation', async () => {
  historicalCheckpoint();
  const value = await open({ create: false, checkpointOnly: true });
  let finish, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const original = mockRunner.run.getMockImplementation();
  mockRunner.assertResult.mockReturnValue({ historicalRoot: historicalFacts() });
  mockRunner.run.mockImplementation((mode, input) => {
    if (mode !== 'historical-root') return original(mode, input);
    entered();
    return new Promise((resolve) => {
      finish = () => resolve({ value: {}, receipt: { mode } });
    });
  });
  const pending = value.historicalRoot(1);
  try {
    await ready;
    await expect(value.historicalRoot(1)).rejects.toThrow();
    expect(value.signal.aborted).toBe(false);
    expect(mockSession.close).not.toHaveBeenCalled();
    finish();
    expect(await pending).toEqual(historicalFacts());
  } finally {
    finish?.();
    await pending.catch(() => {});
  }
});
