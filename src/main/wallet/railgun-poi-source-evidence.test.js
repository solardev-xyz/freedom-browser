const mockTransactCreator = jest.fn(),
  mockCreator = jest.fn(),
  mockOwn = jest.fn();
jest.mock('./railgun-poi-creator', () => ({
  collectRailgunPoiCreator: (...args) => mockCreator(...args),
  collectRailgunPoiTransactCreator: (...args) => mockTransactCreator(...args),
}));
jest.mock('./railgun-own-source', () => ({
  collectRailgunOwnSource: (...args) => mockOwn(...args),
}));
const { collectRailgunPoiSourceEvidence: collect } = require('./railgun-poi-source-evidence');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
let options, seen, mode, ended;
beforeEach(() => {
  jest.clearAllMocks();
  mode = '';
  seen = [[], []];
  ended = false;
  const collector =
    (index) =>
    async ({ visit, assertCurrent }) => {
      if (mode === `early-${index}`) throw Error('before register');
      const totals = await visit((log) => {
        seen[index].push(log);
        if (mode === `resource-${index}`) throw Error('resource bound');
      });
      assertCurrent();
      if (mode === `semantic-${index}`) throw Error('latched semantic mismatch');
      expect(ended).toBe(true);
      expect(totals).toEqual({ count: 3, bytes: 9 });
      return Object.freeze({
        checkpointHash: 'same',
        source: Object.freeze({ ledgerId: 'same' }),
        ...(index
          ? { blockNumber: 2, transactionIndex: 4 }
          : { origin: { blockNumber: 1, transactionIndex: 0 } }),
      });
    };
  mockCreator.mockImplementation(collector(0));
  mockTransactCreator.mockImplementation(collector(0));
  mockOwn.mockImplementation(collector(1));
  options = {
    ...sample(),
    checkpoint: {},
    assertCurrent: jest.fn(),
    visit: jest.fn(async (fn) => {
      for (let i = 0; i < 3; i++) await fn(i);
      ended = true;
      return { count: 3, bytes: 9 };
    }),
  };
});
test('both collectors see each log in the same single visit, then emit one frozen observation', async () => {
  const value = await collect(options);
  expect(options.visit).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);
  expect(value).toMatchObject({
    checkpointHash: 'same',
    sourceAuthenticated: false,
    ownershipAuthenticated: false,
    currentCanonicalityVerified: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
  expect(Object.isFrozen(value)).toBe(true);
});
test.each([0, 1])(
  'collector %s early refusal settles both and performs no source visit',
  async (i) => {
    mode = `early-${i}`;
    await expect(collect(options)).rejects.toMatchObject({
      code: 'RAILGUN_POI_SOURCE_EVIDENCE_REFUSED',
    });
    expect(options.visit).not.toHaveBeenCalled();
  }
);
test.each([0, 1])('collector %s late semantic refusal emits no partial observation', async (i) => {
  mode = `semantic-${i}`;
  await expect(collect(options)).rejects.toThrow('Railgun POI source evidence unavailable');
  expect(ended).toBe(true);
  expect(seen).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);
});
test.each([0, 1])(
  'collector %s resource failure propagates through the actual visitor',
  async (i) => {
    mode = `resource-${i}`;
    let observedFailure = false;
    options.visit = jest.fn(async (fn) => {
      try {
        await fn(0);
      } catch (e) {
        observedFailure = true;
        throw e;
      }
    });
    await expect(collect(options)).rejects.toThrow();
    expect(observedFailure).toBe(true);
    expect(ended).toBe(false);
  }
);
test('a final ledger failure rejects both collectors even after delivery', async () => {
  options.visit = jest.fn(async (fn) => {
    for (let i = 0; i < 3; i++) await fn(i);
    throw Error('MAC failure');
  });
  await expect(collect(options)).rejects.toThrow();
  expect(seen).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);
});
test.each(['checkpoint', 'source', 'future-creator', 'same-transaction'])(
  'refuses %s discrepancy after both complete',
  async (fault) => {
    const original = mockCreator.getMockImplementation();
    mockCreator.mockImplementation(async (args) => {
      const result = { ...(await original(args)) };
      if (fault === 'checkpoint') result.checkpointHash = 'different';
      if (fault === 'source') result.source = { ledgerId: 'different' };
      if (fault === 'future-creator') result.origin = { blockNumber: 3, transactionIndex: 0 };
      if (fault === 'same-transaction') result.origin = { blockNumber: 2, transactionIndex: 4 };
      return result;
    });
    await expect(collect(options)).rejects.toThrow();
    expect(ended).toBe(true);
  }
);
test('copies all supplied fields before collectors can await or mutate callers', async () => {
  const original = mockCreator.getMockImplementation();
  mockCreator.mockImplementation((args) => {
    options.capsule.noteHash = 'changed';
    return original(args);
  });
  await collect(options);
  expect(mockCreator.mock.calls[0][0].capsule.noteHash).toBe(sample().capsule.noteHash);
});
test('a last-moment revocation refuses after both observations fulfill', async () => {
  let completed = 0;
  for (const mock of [mockCreator, mockOwn]) {
    const original = mock.getMockImplementation();
    mock.mockImplementation(async (args) => {
      const result = await original(args);
      completed++;
      return result;
    });
  }
  options.assertCurrent.mockImplementation(() => {
    if (completed === 2) throw Error('revoked');
  });
  await expect(collect(options)).rejects.toThrow();
  expect(completed).toBe(2);
  expect(ended).toBe(true);
});

test('mismatched capsule/record binding refuses before either collector starts', async () => {
  options.record.intent.nullifier = '0x' + '1'.repeat(64);
  await expect(collect(options)).rejects.toThrow();
  expect(mockCreator).not.toHaveBeenCalled();
  expect(mockOwn).not.toHaveBeenCalled();
  expect(options.visit).not.toHaveBeenCalled();
});

const collectTransact =
  require('./railgun-poi-source-evidence').collectRailgunPoiTransactSourceEvidence;
test('fixed Transact source evidence selects its full-group collector in exactly one shared visit', async () => {
  const value = await collectTransact(options);
  expect(mockTransactCreator).toHaveBeenCalledTimes(1);
  expect(mockCreator).not.toHaveBeenCalled();
  expect(mockOwn).toHaveBeenCalledTimes(1);
  expect(options.visit).toHaveBeenCalledTimes(1);
  expect(seen).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);
  expect(value).toMatchObject({
    sourceAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
});
test.each(['early-0', 'early-1', 'semantic-0', 'semantic-1', 'resource-0', 'resource-1'])(
  'fixed Transact source evidence drains/refuses %s without legacy fallback',
  async (fault) => {
    mode = fault;
    await expect(collectTransact(options)).rejects.toMatchObject({
      code: 'RAILGUN_POI_SOURCE_EVIDENCE_REFUSED',
    });
    expect(mockCreator).not.toHaveBeenCalled();
    if (fault.startsWith('early')) expect(options.visit).not.toHaveBeenCalled();
    if (fault.startsWith('semantic')) {
      expect(ended).toBe(true);
      expect(seen).toEqual([
        [0, 1, 2],
        [0, 1, 2],
      ]);
    }
  }
);
test('fixed Transact source evidence cannot return after a late authenticated-prefix failure', async () => {
  options.visit.mockImplementation(async (fn) => {
    for (let i = 0; i < 3; i++) await fn(i);
    throw Error('private suffix corruption');
  });
  await expect(collectTransact(options)).rejects.toMatchObject({
    code: 'RAILGUN_POI_SOURCE_EVIDENCE_REFUSED',
  });
  expect(seen).toEqual([
    [0, 1, 2],
    [0, 1, 2],
  ]);
});
