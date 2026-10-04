let mockEnrollment, mockEnrollments, mockHandle, mockNetwork, mockDestinationCurrent;
const mockDestination = Object.freeze({});
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => mockEnrollments.has(v),
}));
jest.mock('./private-transaction-network', () => ({
  getPrivateTransactionNetwork: (handle) => {
    mockHandle = handle;
    return mockNetwork;
  },
  getPrivateTransactionNetworkDestination: () => mockDestination,
  assertPrivateTransactionNetworkDestination: (network, handle, destination) => {
    if (
      !mockDestinationCurrent ||
      network !== mockNetwork ||
      handle !== mockHandle ||
      destination !== mockDestination
    )
      throw Error('destination');
  },
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const {
  observeRailgunOwnReceipt: observe,
  prepareRailgunOwnReceiptReader: prepareReader,
  observePreparedRailgunOwnReceipt: observePrepared,
  assertPreparedRailgunOwnReceipt: assertPrepared,
} = require('./railgun-own-receipt');
const copy = (v) => JSON.parse(JSON.stringify(v));
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
let scope, caller, fixture, input, headers, finalized, calls, preparedReaders;
function setup(unshield = false, archived = false) {
  fixture = sample(unshield, archived);
  fixture.receipt.gasUsed = '0x10000';
  input = {
    enrollment: mockEnrollment,
    signal: caller.signal,
    capture: {
      bindingDigest: '1'.repeat(64),
      submitter: fixture.transaction.from,
      record: fixture.record,
      projection: projectRailgunOwnRecord(fixture.record),
      provedTransaction: {
        chainId: 11155111,
        to: fixture.transaction.to,
        value: '0',
        data: fixture.transaction.input,
      },
    },
  };
  headers = Object.fromEntries(
    [
      [291, 200],
      [300, 201],
      [301, 202],
      [302, 203],
    ].map(([n, h]) => ['0x' + n.toString(16), { number: '0x' + n.toString(16), hash: hex(h) }])
  );
  finalized = '0x12e';
  calls = [];
  mockNetwork = {
    signal: caller.signal,
    request: jest.fn(async (chain, method, params) => {
      const context = getPrivacyContext(mockHandle);
      expect(context.subject.kind).toBe('public-address');
      expect(context.subject.principal).toBe(fixture.transaction.from);
      expect(context.subject.role).toBe('transaction-rpc');
      expect(chain).toBe(11155111);
      calls.push([method, ...params]);
      if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
        expect(params).toEqual([fixture.record.hash]);
        return {
          result: copy(
            method === 'eth_getTransactionByHash' ? fixture.transaction : fixture.receipt
          ),
        };
      }
      if (method === 'eth_blockNumber') return { result: '0x136' };
      expect(method).toBe('eth_getBlockByNumber');
      expect(params[1]).toBe(false);
      return { result: copy(headers[params[0] === 'finalized' ? finalized : params[0]]) };
    }),
    assertCanSubmit: jest.fn(),
    reconcileSubmission: jest.fn(),
  };
}
beforeEach(() => {
  mockHandle = undefined;
  mockDestinationCurrent = true;
  mockEnrollments = new WeakSet();
  preparedReaders = [];
  scope = createPrivacyScope({ profileId: 'own-receipt', signal: new AbortController().signal });
  caller = new AbortController();
  mockEnrollment = {
    signal: scope.signal,
    getContext: () =>
      scope.getContext({
        kind: 'private-account',
        principal: 'fixture',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'engine',
      }),
  };
  mockEnrollments.add(mockEnrollment);
  setup();
});
afterEach(async () => {
  caller.abort();
  scope.close();
  for (const prepared of preparedReaders) prepared.close();
  await Promise.all(preparedReaders.map((prepared) => prepared.closed));
  jest.useRealTimers();
});
test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'reads one transaction/receipt and brackets explicit anchors (unshield=%s archived=%s)',
  async (unshield, archived) => {
    setup(unshield, archived);
    const result = await observe(input);
    expect(result.status).toBe('observed');
    const data = result.observation;
    expect(data.receiptMatched).toBe(true);
    expect(data.rpcConsistencyObserved).toBe(true);
    expect(data.capturedRepresentation).toBe(archived ? 'archived' : 'active');
    expect(data.anchorsActuallyChecked.map((a) => a.kind)).toEqual(
      archived
        ? ['inclusion', 'resolution', 'archive', 'inclusion-repeat']
        : ['inclusion', 'resolution', 'inclusion-repeat']
    );
    expect(calls.filter(([m]) => m === 'eth_getTransactionByHash')).toHaveLength(1);
    expect(calls.filter(([m]) => m === 'eth_getTransactionReceipt')).toHaveLength(1);
    expect(calls).toHaveLength(archived ? 16 : 15);
    expect(data.completedMonotonicMs).toBeGreaterThanOrEqual(data.startedMonotonicMs);
    expect(Object.isFrozen(data.receipt.logs[0])).toBe(true);
    for (const flag of [
      'accountAuthenticated',
      'sourceAuthenticated',
      'currentCanonicalityVerified',
      'finalityVerified',
      'txidPathVerified',
      'txidRootAccepted',
      'poiVerified',
      'spendingEnabled',
    ])
      expect(data[flag]).toBe(false);
    expect(() => getPrivacyContext(mockHandle)).toThrow();
    expect(mockNetwork.assertCanSubmit).not.toHaveBeenCalled();
    expect(mockNetwork.reconcileSubmission).not.toHaveBeenCalled();
  }
);
test.each([
  'calldata',
  'receipt',
  'included-header',
  'resolution-anchor',
  'archive-anchor',
  'archive-ahead',
  'finality-ahead',
  'finality-behind',
])('refuses inconsistent %s without authority', async (mode) => {
  setup(false, true);
  if (mode === 'calldata') fixture.transaction.input = '0x';
  if (mode === 'receipt') fixture.receipt.status = '0x0';
  if (mode === 'included-header') headers['0x123'].hash = hex(999);
  if (mode === 'resolution-anchor') headers['0x12c'].hash = hex(999);
  if (mode === 'archive-anchor') headers['0x12d'].hash = hex(999);
  if (mode === 'archive-ahead') finalized = '0x12c';
  if (mode === 'finality-ahead') {
    finalized = '0x137';
    headers[finalized] = { number: finalized, hash: hex(999) };
  }
  if (mode === 'finality-behind') finalized = '0x123';
  const result = await observe(input);
  expect(result.status).toBe('refused');
  expect(result.observation).toBeUndefined();
  expect(() => getPrivacyContext(mockHandle)).toThrow();
});
test('refuses an inclusion header changing after the finality bracket', async () => {
  const original = mockNetwork.request.getMockImplementation();
  let reads = 0;
  mockNetwork.request.mockImplementation(async (...args) => {
    if (args[1] === 'eth_getBlockByNumber' && args[2][0] === '0x123' && ++reads === 2)
      headers['0x123'].hash = hex(999);
    return original(...args);
  });
  expect(await observe(input)).toEqual({ status: 'refused', stage: 'inclusion-repeat' });
});
test('refuses a moving finalized tag across the observation bracket', async () => {
  const original = mockNetwork.request.getMockImplementation();
  let reads = 0;
  mockNetwork.request.mockImplementation(async (...args) => {
    if (args[1] === 'eth_getBlockByNumber' && args[2][0] === 'finalized' && ++reads === 3)
      finalized = '0x12c';
    return original(...args);
  });
  expect(await observe(input)).toEqual({ status: 'refused', stage: 'finality-after' });
});
test('pins detached input before RPC begins', async () => {
  const original = mockNetwork.request.getMockImplementation();
  mockNetwork.request.mockImplementation(async (...args) => {
    input.capture.projection = {};
    return original(...args);
  });
  expect((await observe(input)).status).toBe('observed');
});
test.each(['caller', 'timeout', 'enrollment'])(
  'drains an awaited request on %s revocation',
  async (mode) => {
    jest.useFakeTimers();
    let release;
    mockNetwork.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    let settled = false;
    const pending = observe({ ...input, timeoutMs: 20 }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    if (mode === 'caller') caller.abort();
    if (mode === 'enrollment') scope.close();
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(21);
    await Promise.resolve();
    expect(settled).toBe(false);
    release({ result: fixture.transaction });
    expect((await pending).status).toBe('refused');
    expect(mockNetwork.request).toHaveBeenCalledTimes(1);
  }
);
test('rejects invalid capture/context before any network lookup', async () => {
  for (const change of [
    { capture: {} },
    { enrollment: {} },
    { capture: { ...input.capture, projection: {} } },
    { timeoutMs: 60001 },
    { capture: { ...input.capture, extra: 'x'.repeat(128 * 1024) } },
  ]) {
    expect((await observe({ ...input, ...change })).status).toBe('refused');
  }
  expect(mockHandle).toBeUndefined();
});
test('bounds a received transaction before requesting a receipt', async () => {
  mockNetwork.request.mockResolvedValue({
    result: { ...fixture.transaction, extra: 'x'.repeat(128 * 1024) },
  });
  expect(await observe(input)).toEqual({ status: 'refused', stage: 'transaction' });
  expect(mockNetwork.request).toHaveBeenCalledTimes(1);
});

const prepared = (changes = {}) => {
  const result = prepareReader({ ...input, ...changes });
  expect(result.status).toBe('prepared');
  preparedReaders.push(result);
  return result;
};
const assertionOptions = (reader, changes = {}) => ({
  enrollment: mockEnrollment,
  capture: copy(input.capture),
  destination: reader.destination,
  ...changes,
});
describe('prepared own receipt assertion', () => {
  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('asserts without query or claim (unshield=%s archived=%s)', async (unshield, archived) => {
    setup(unshield, archived);
    const reader = prepared();
    const options = assertionOptions(reader);
    expect(assertPrepared(reader.reader, options)).toBeUndefined();
    expect(assertPrepared(reader.reader, copyCaptureOptions(options))).toBeUndefined();
    expect(mockNetwork.request).not.toHaveBeenCalled();
    expect(reader.signal.aborted).toBe(false);
    expect((await observePrepared(reader.reader)).status).toBe('observed');
    expect(calls).toHaveLength(archived ? 16 : 15);
    expect(() => assertPrepared(reader.reader, options)).toThrow();
    expect((await observePrepared(reader.reader)).status).toBe('refused');
    expect(calls).toHaveLength(archived ? 16 : 15);
  });
  test.each(['empty', 'spread', 'wrapper', 'null', 'primitive'])(
    'forged %s reader cannot assert or disturb a genuine reader',
    async (kind) => {
      const reader = prepared();
      const forged = {
        empty: {},
        spread: { ...reader.reader },
        wrapper: reader,
        null: null,
        primitive: 'reader',
      }[kind];
      expect(() => assertPrepared(forged, assertionOptions(reader))).toThrow();
      expect(mockNetwork.request).not.toHaveBeenCalled();
      expect(assertPrepared(reader.reader, assertionOptions(reader))).toBeUndefined();
      expect((await observePrepared(reader.reader)).status).toBe('observed');
    }
  );
  test.each(['enrollment', 'destination', 'capture'])(
    'wrong %s refuses without consuming or revoking the genuine reader',
    async (kind) => {
      const reader = prepared();
      const options = assertionOptions(reader);
      if (kind === 'enrollment') {
        options.enrollment = { ...mockEnrollment };
        mockEnrollments.add(options.enrollment);
        expect(options.enrollment.getContext()).toBe(mockEnrollment.getContext());
      }
      if (kind === 'destination') options.destination = { ...reader.destination };
      if (kind === 'capture') options.capture.bindingDigest = '2'.repeat(64);
      expect(() => assertPrepared(reader.reader, options)).toThrow();
      expect(reader.signal.aborted).toBe(false);
      expect(mockNetwork.request).not.toHaveBeenCalled();
      expect(assertPrepared(reader.reader, assertionOptions(reader))).toBeUndefined();
      expect((await observePrepared(reader.reader)).status).toBe('observed');
    }
  );
  test.each(['record', 'projection', 'transaction', 'additional metadata'])(
    'assertion retains the entire prepared capture including %s',
    async (field) => {
      setup(false, true);
      const reader = prepared();
      const options = assertionOptions(reader);
      if (field === 'record') options.capture.record.archivedAt++;
      if (field === 'projection') options.capture.projection.blockHash = hex(999);
      if (field === 'transaction') options.capture.provedTransaction.data = '0x';
      if (field === 'additional metadata') options.capture.extra = 'new';
      expect(() => assertPrepared(reader.reader, options)).toThrow();
      expect(mockNetwork.request).not.toHaveBeenCalled();
      expect(assertPrepared(reader.reader, assertionOptions(reader))).toBeUndefined();
      expect((await observePrepared(reader.reader)).status).toBe('observed');
    }
  );
  test('later caller mutation cannot rewrite the reader snapshot', async () => {
    const original = copy(input.capture);
    const reader = prepared();
    input.capture.provedTransaction.data = '0x';
    expect(() => assertPrepared(reader.reader, assertionOptions(reader))).toThrow();
    expect(
      assertPrepared(reader.reader, assertionOptions(reader, { capture: original }))
    ).toBeUndefined();
    expect(mockNetwork.request).not.toHaveBeenCalled();
    expect((await observePrepared(reader.reader)).status).toBe('observed');
  });
  test('same enrollment rebound to another engine context does not match the retained parent', async () => {
    const reader = prepared();
    const original = mockEnrollment.getContext;
    mockEnrollment.getContext = () =>
      scope.getContext({
        kind: 'private-account',
        principal: 'another-account',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'engine',
      });
    try {
      expect(() => assertPrepared(reader.reader, assertionOptions(reader))).toThrow();
      expect(reader.signal.aborted).toBe(false);
      expect(mockNetwork.request).not.toHaveBeenCalled();
    } finally {
      mockEnrollment.getContext = original;
    }
    expect(assertPrepared(reader.reader, assertionOptions(reader))).toBeUndefined();
    expect((await observePrepared(reader.reader)).status).toBe('observed');
  });
  test.each(['missing', 'extra', 'accessor', 'null', 'undefined'])(
    'malformed %s assertion does not claim or revoke the reader',
    async (kind) => {
      const reader = prepared();
      let options = assertionOptions(reader);
      const getter = jest.fn(() => mockEnrollment);
      if (kind === 'missing') options = { enrollment: mockEnrollment, capture: input.capture };
      if (kind === 'extra') options.extra = true;
      if (kind === 'accessor')
        Object.defineProperty(options, 'enrollment', { get: getter, enumerable: true });
      if (kind === 'null') options = null;
      if (kind === 'undefined') options = undefined;
      expect(() => assertPrepared(reader.reader, options)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(reader.signal.aborted).toBe(false);
      expect(mockNetwork.request).not.toHaveBeenCalled();
      expect((await observePrepared(reader.reader)).status).toBe('observed');
    }
  );
  test.each(['caller', 'enrollment', 'network', 'destination', 'close', 'expiry'])(
    '%s revocation prevents assertion without any query',
    async (kind) => {
      jest.useFakeTimers();
      const network = new AbortController();
      mockNetwork.signal = network.signal;
      const reader = prepared({ timeoutMs: 20 });
      if (kind === 'caller') caller.abort();
      if (kind === 'enrollment') scope.close();
      if (kind === 'network') network.abort();
      if (kind === 'destination') mockDestinationCurrent = false;
      if (kind === 'close') reader.close();
      if (kind === 'expiry') await jest.advanceTimersByTimeAsync(20);
      expect(() => assertPrepared(reader.reader, assertionOptions(reader))).toThrow();
      expect(mockNetwork.request).not.toHaveBeenCalled();
      expect((await observePrepared(reader.reader)).status).toBe('refused');
      expect(mockNetwork.request).not.toHaveBeenCalled();
      await reader.closed;
    }
  );
  test('claimed reader assertion refuses immediately without cancelling its pending observation', async () => {
    const reader = prepared();
    const original = mockNetwork.request.getMockImplementation();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    mockNetwork.request.mockImplementationOnce(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = observePrepared(reader.reader);
    try {
      expect(() => assertPrepared(reader.reader, assertionOptions(reader))).toThrow();
      expect(reader.signal.aborted).toBe(false);
    } finally {
      release();
    }
    expect((await pending).status).toBe('observed');
    expect(calls).toHaveLength(15);
  });
});
function copyCaptureOptions(options) {
  return { ...options, capture: copy(options.capture) };
}
