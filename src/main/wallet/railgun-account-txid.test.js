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
  expect(value).not.toHaveProperty('witness');
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
