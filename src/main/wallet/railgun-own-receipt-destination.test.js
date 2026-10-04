let mockEnrollment, mockEndpoint, mockUrls, mockSources;
const mockTransport = jest.fn(),
  mockTransportFactory = jest.fn(),
  mockHas = jest.fn(),
  mockJournalLookup = jest.fn(),
  mockNetworkLookup = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (value) => value === mockEnrollment,
}));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => mockUrls,
  getEndpointSources: () => mockSources,
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockTransportFactory(...args),
}));
jest.mock('./private-submission-journal', () => ({
  getPrivateSubmissionJournal: (...args) => mockJournalLookup(...args),
}));
jest.mock('./private-transaction-network', () => ({
  ...jest.requireActual('./private-transaction-network'),
  getPrivateTransactionNetwork: (...args) => mockNetworkLookup(...args),
}));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { getPrivateRpcDestinationDetails } = require('../networks/private-rpc');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const {
  prepareRailgunOwnReceiptReader: prepare,
  observePreparedRailgunOwnReceipt: observe,
} = require('./railgun-own-receipt');
const copy = (value) => JSON.parse(JSON.stringify(value));
const hex = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');
const originalUrl = 'https://retained-rpc.example:8443/sensitive-fixture-path';
let scope, caller, tor, fixture, input, headers, calls, prepared;
function select(url = originalUrl) {
  mockUrls = [url];
  mockSources = [{ keyed: false, coverage: { 11155111: url } }];
}
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
    ].map(([number, hash]) => [
      '0x' + number.toString(16),
      { number: '0x' + number.toString(16), hash: hex(hash) },
    ])
  );
}
function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
beforeEach(() => {
  jest.clearAllMocks();
  select();
  calls = [];
  prepared = [];
  caller = new AbortController();
  tor = new AbortController();
  mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({
    profileId: 'prepared-receipt-fixture',
    signal: new AbortController().signal,
  });
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
  setup();
  mockNetworkLookup.mockImplementation(
    jest.requireActual('./private-transaction-network').getPrivateTransactionNetwork
  );
  mockJournalLookup.mockImplementation((handle) => {
    const context = getPrivacyContext(handle);
    expect(context.subject.principal).toBe(fixture.transaction.from);
    return { has: mockHas };
  });
  mockHas.mockImplementation(async (hash) => hash === fixture.record.hash);
  mockTransportFactory.mockImplementation(() => ({ request: mockTransport, release: jest.fn() }));
  mockTransport.mockImplementation(async (handle, url, options) => {
    const context = getPrivacyContext(handle);
    expect(context.subject.kind).toBe('public-address');
    expect(context.subject.principal).toBe(fixture.transaction.from);
    expect(context.subject.role).toBe('transaction-rpc');
    const wire = JSON.parse(options.body);
    calls.push({ handle, url, method: wire.method, params: copy(wire.params) });
    let result;
    if (wire.method === 'eth_chainId') result = '0xaa36a7';
    else if (
      wire.method === 'eth_getTransactionByHash' ||
      wire.method === 'eth_getTransactionReceipt'
    ) {
      expect(wire.params).toEqual([fixture.record.hash]);
      result = wire.method === 'eth_getTransactionByHash' ? fixture.transaction : fixture.receipt;
    } else if (wire.method === 'eth_blockNumber') result = '0x136';
    else {
      expect(wire.method).toBe('eth_getBlockByNumber');
      expect(wire.params[1]).toBe(false);
      result = headers[wire.params[0] === 'finalized' ? '0x12e' : wire.params[0]];
    }
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
    };
  });
});
afterEach(async () => {
  for (const value of prepared) value.close();
  caller.abort();
  scope.close();
  tor.abort();
  await Promise.all(prepared.map((value) => value.closed));
  jest.useRealTimers();
});
function prepareReader(options = input) {
  const value = prepare(options);
  expect(value.status).toBe('prepared');
  prepared.push(value);
  return value;
}
test('preparation retains one genuine client, opaque destination and no dispatch, chain ID or journal read', () => {
  const value = prepareReader();
  expect(value).not.toBeInstanceOf(Promise);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.reader)).toBe(true);
  expect(Object.keys(value.reader)).toEqual([]);
  expect(Object.keys(value.destination)).toEqual([]);
  expect(value).toMatchObject({
    accountAuthenticated: false,
    disclosureEnabled: false,
    spendingEnabled: false,
  });
  const serialized = JSON.stringify(value);
  for (const secret of [
    originalUrl,
    fixture.record.hash,
    fixture.transaction.from,
    input.capture.bindingDigest,
  ])
    expect(serialized).not.toContain(secret);
  expect(getPrivateRpcDestinationDetails(value.destination).url).toBe(originalUrl);
  expect(mockNetworkLookup).toHaveBeenCalledTimes(1);
  expect(mockJournalLookup).not.toHaveBeenCalled();
  expect(mockHas).not.toHaveBeenCalled();
  expect(mockTransportFactory).not.toHaveBeenCalled();
  expect(mockTransport).not.toHaveBeenCalled();
});
test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'prepared exact client sends bounded real RPC reads including hidden chain ID (unshield=%s archived=%s)',
  async (unshield, archived) => {
    setup(unshield, archived);
    const value = prepareReader();
    const initialHandle = mockNetworkLookup.mock.calls[0][0];
    const result = await observe(value.reader);
    expect(result.status).toBe('observed');
    expect(result.observation.capturedRepresentation).toBe(archived ? 'archived' : 'active');
    expect(calls).toHaveLength(archived ? 17 : 16);
    expect(calls.filter(({ method }) => method === 'eth_chainId')).toHaveLength(1);
    expect(calls.filter(({ method }) => method === 'eth_getTransactionByHash')).toHaveLength(1);
    expect(calls.filter(({ method }) => method === 'eth_getTransactionReceipt')).toHaveLength(1);
    expect(calls.filter(({ method }) => method === 'eth_blockNumber')).toHaveLength(2);
    expect(calls.filter(({ method }) => method === 'eth_getBlockByNumber')).toHaveLength(
      archived ? 12 : 11
    );
    expect(calls.every(({ handle, url }) => handle === initialHandle && url === originalUrl)).toBe(
      true
    );
    expect(mockHas).toHaveBeenCalledTimes(2);
    expect(mockHas.mock.calls.every(([hash]) => hash === fixture.record.hash)).toBe(true);
    expect(mockNetworkLookup).toHaveBeenCalledTimes(1);
    expect(value.signal.aborted).toBe(true);
    await expect(value.closed).resolves.toBeUndefined();
    expect(() => getPrivateRpcDestinationDetails(value.destination)).toThrow();
    expect(() => getPrivacyContext(initialHandle)).toThrow();
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
      expect(result.observation[flag]).toBe(false);
    expect(JSON.stringify(result)).not.toContain('retained-rpc.example');
  }
);
test('registry and caller capture mutation cannot replace the retained client or transaction', async () => {
  const value = prepareReader();
  select('https://other-rpc.example/new-path');
  input.capture.projection = {};
  input.capture.record = {};
  input.capture.submitter = '0x' + '9'.repeat(40);
  const result = await observe(value.reader);
  expect(result.status).toBe('observed');
  expect(calls.every(({ url }) => url === originalUrl)).toBe(true);
  expect(result.observation.transaction.hash).toBe(fixture.transaction.hash);
  expect(mockNetworkLookup).toHaveBeenCalledTimes(1);
});
test('copied or forged reader tokens cannot acquire the genuine reader', async () => {
  const value = prepareReader();
  for (const fake of [
    {},
    { ...value.reader },
    JSON.parse(JSON.stringify(value.reader)),
    Object.create(value.reader),
    value,
    value.destination,
  ])
    expect((await observe(fake)).status).toBe('refused');
  expect(mockTransport).not.toHaveBeenCalled();
  expect(value.signal.aborted).toBe(false);
  expect((await observe(value.reader)).status).toBe('observed');
});
test('observation claim is synchronous, single-use and not revoked by overlapping or malformed calls', async () => {
  const value = prepareReader(),
    entered = gate(),
    release = gate();
  const original = mockHas.getMockImplementation();
  mockHas.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const first = observe(value.reader);
  try {
    expect((await observe(value.reader)).status).toBe('refused');
    expect((await observe(value.reader, { timeoutMs: 0 })).status).toBe('refused');
    await entered.promise;
    expect(value.signal.aborted).toBe(false);
    expect(mockHas).toHaveBeenCalledTimes(1);
    release.resolve();
    expect((await first).status).toBe('observed');
    const count = calls.length;
    expect((await observe(value.reader)).status).toBe('refused');
    expect(calls).toHaveLength(count);
  } finally {
    release.resolve();
    await first;
  }
});
test('known-hash journal refusal sends no lazy chain ID and consumes the prepared reader', async () => {
  const value = prepareReader();
  mockHas.mockResolvedValue(false);
  expect((await observe(value.reader)).status).toBe('refused');
  expect(mockHas).toHaveBeenCalledTimes(1);
  expect(mockTransport).not.toHaveBeenCalled();
  mockHas.mockResolvedValue(true);
  expect((await observe(value.reader)).status).toBe('refused');
  expect(mockTransport).not.toHaveBeenCalled();
});
test.each(['journal', 'chain-id', 'transaction', 'receipt', 'header'])(
  'close revokes immediately but closed awaits ignored %s work without later admission',
  async (boundary) => {
    const value = prepareReader(),
      entered = gate(),
      release = gate();
    const target = {
      'chain-id': 'eth_chainId',
      transaction: 'eth_getTransactionByHash',
      receipt: 'eth_getTransactionReceipt',
      header: 'eth_getBlockByNumber',
    }[boundary];
    let expectedCalls = 0;
    if (boundary === 'journal') {
      const original = mockHas.getMockImplementation();
      mockHas.mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
    } else {
      const original = mockTransport.getMockImplementation();
      let held = false;
      mockTransport.mockImplementation(async (...args) => {
        const response = await original(...args);
        if (!held && JSON.parse(args[2].body).method === target) {
          held = true;
          expectedCalls = calls.length;
          entered.resolve();
          await release.promise;
        }
        return response;
      });
    }
    let drained = false,
      settled = false;
    value.closed.then(() => {
      drained = true;
    });
    const pending = observe(value.reader).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered.promise;
      value.close();
      expect(value.signal.aborted).toBe(true);
      expect(() => getPrivateRpcDestinationDetails(value.destination)).toThrow();
      await turn();
      expect(drained).toBe(false);
      expect(settled).toBe(false);
      expect(mockEnrollment.signal.aborted).toBe(false);
      expect(caller.signal.aborted).toBe(false);
      expect((await observe(value.reader)).status).toBe('refused');
      release.resolve();
      expect((await pending).status).toBe('refused');
      await value.closed;
      expect(drained).toBe(true);
      expect(calls).toHaveLength(expectedCalls);
      expect(mockNetworkLookup).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
    }
  }
);
test.each(['caller', 'enrollment', 'tor-abort', 'tor-replacement'])(
  'prepared %s revocation refuses without constructing a replacement or sending',
  async (boundary) => {
    const value = prepareReader();
    if (boundary === 'caller') caller.abort();
    if (boundary === 'enrollment') scope.close();
    if (boundary === 'tor-abort') tor.abort();
    if (boundary === 'tor-replacement') mockEndpoint = { signal: new AbortController().signal };
    expect(() => getPrivateRpcDestinationDetails(value.destination)).toThrow();
    expect((await observe(value.reader)).status).toBe('refused');
    await value.closed;
    expect(value.signal.aborted).toBe(true);
    expect(mockNetworkLookup).toHaveBeenCalledTimes(1);
    expect(mockTransport).not.toHaveBeenCalled();
  }
);
test('unused prepared reader expires at its nonrenewing 120-second deadline without dispatch', async () => {
  jest.useFakeTimers();
  const value = prepareReader();
  await jest.advanceTimersByTimeAsync(119999);
  expect(value.signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(value.signal.aborted).toBe(true);
  await value.closed;
  expect((await observe(value.reader)).status).toBe('refused');
  expect(mockTransport).not.toHaveBeenCalled();
});
test.each(['preparation', 'operation'])(
  'observation does not renew the %s deadline and closes only after delayed chain ID drains',
  async (boundary) => {
    jest.useFakeTimers();
    const value = prepareReader(),
      entered = gate(),
      release = gate();
    await jest.advanceTimersByTimeAsync(boundary === 'preparation' ? 119990 : 1000);
    const original = mockTransport.getMockImplementation();
    mockTransport.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      entered.resolve();
      await release.promise;
      return response;
    });
    let drained = false;
    value.closed.then(() => {
      drained = true;
    });
    const pending = observe(value.reader);
    try {
      await entered.promise;
      const budget = boundary === 'preparation' ? 10 : 60000;
      await jest.advanceTimersByTimeAsync(budget - 1);
      expect(value.signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(value.signal.aborted).toBe(true);
      expect(drained).toBe(false);
      release.resolve();
      expect((await pending).status).toBe('refused');
      await value.closed;
      expect(calls.map(({ method }) => method)).toEqual(['eth_chainId']);
    } finally {
      release.resolve();
      await pending;
    }
  }
);
test('close is reentrant and does not close another healthy prepared reader or shared owners', async () => {
  const first = prepareReader(),
    second = prepareReader();
  let callbacks = 0;
  first.signal.addEventListener(
    'abort',
    () => {
      callbacks++;
      first.close();
    },
    { once: true }
  );
  first.close();
  first.close();
  await first.closed;
  expect(callbacks).toBe(1);
  expect(second.signal.aborted).toBe(false);
  expect(caller.signal.aborted).toBe(false);
  expect(scope.signal.aborted).toBe(false);
  expect((await observe(second.reader)).status).toBe('observed');
});
test.each([null, false, 0, 120001, Infinity, NaN, '1000'])(
  'invalid prepared lifetime %p refuses before network construction',
  (timeoutMs) => {
    expect(prepare({ ...input, timeoutMs }).status).toBe('refused');
    expect(mockNetworkLookup).not.toHaveBeenCalled();
    expect(mockTransport).not.toHaveBeenCalled();
  }
);
test.each([null, false, 0, 60001, Infinity, NaN, '1000'])(
  'invalid observation timeout %p does not consume a genuine reader',
  async (timeoutMs) => {
    const value = prepareReader();
    expect((await observe(value.reader, { timeoutMs })).status).toBe('refused');
    expect(mockTransport).not.toHaveBeenCalled();
    expect(value.signal.aborted).toBe(false);
    expect((await observe(value.reader, { timeoutMs: undefined })).status).toBe('observed');
  }
);
test('unknown/accessor/symbol options and invalid capture refuse without invoking caller getters or network factory', async () => {
  const getter = jest.fn();
  for (const value of [
    null,
    [],
    {},
    { ...input, network: {} },
    { ...input, url: originalUrl },
    { ...input, [Symbol('extra')]: true },
    { ...input, capture: {} },
    { ...input, capture: { ...input.capture, projection: {} } },
  ])
    expect(prepare(value).status).toBe('refused');
  const accessor = { ...input };
  Object.defineProperty(accessor, 'capture', { get: getter, enumerable: true });
  expect(prepare(accessor).status).toBe('refused');
  expect(getter).not.toHaveBeenCalled();
  expect(mockNetworkLookup).not.toHaveBeenCalled();
  const value = prepareReader();
  const injected = { url: originalUrl };
  expect((await observe(value.reader, injected)).status).toBe('refused');
  expect(mockTransport).not.toHaveBeenCalled();
  expect((await observe(value.reader)).status).toBe('observed');
});

test('pre-aborted preparation refuses before creating a client', () => {
  caller.abort();
  expect(prepare(input).status).toBe('refused');
  expect(mockNetworkLookup).not.toHaveBeenCalled();
  expect(mockJournalLookup).not.toHaveBeenCalled();
  expect(mockTransport).not.toHaveBeenCalled();
});
test('close immediately after synchronous claim cancels before the first journal or transport admission', async () => {
  const value = prepareReader();
  const pending = observe(value.reader);
  value.close();
  expect(value.signal.aborted).toBe(true);
  expect((await pending).status).toBe('refused');
  await value.closed;
  expect(mockHas).not.toHaveBeenCalled();
  expect(mockJournalLookup).not.toHaveBeenCalled();
  expect(mockTransport).not.toHaveBeenCalled();
});
test.each(['wrong-chain', 'lost-chain-response'])(
  'failed %s is not retried by the single-use reader and leaks no error details',
  async (fault) => {
    const value = prepareReader();
    const original = mockTransport.getMockImplementation();
    mockTransport.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      if (fault === 'lost-chain-response') throw Error(originalUrl + ' PRIVATE provider failure');
      const wire = JSON.parse(response.body.toString('utf8'));
      wire.result = '0x1';
      return { ...response, body: Buffer.from(JSON.stringify(wire)) };
    });
    const result = await observe(value.reader);
    expect(result.status).toBe('refused');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('retained-rpc.example');
    expect((await observe(value.reader)).status).toBe('refused');
    expect(calls.map(({ method }) => method)).toEqual(['eth_chainId']);
  }
);
test('reader cleanup removes its explicit listeners from both scoped and retained network lifetimes', async () => {
  const { getEventListeners } = require('events');
  const value = prepareReader({ ...input, timeoutMs: undefined });
  const network = mockNetworkLookup.mock.results[0].value;
  expect(getEventListeners(value.signal, 'abort')).toHaveLength(1);
  expect(getEventListeners(network.signal, 'abort')).toHaveLength(1);
  value.close();
  await value.closed;
  expect(getEventListeners(value.signal, 'abort')).toHaveLength(0);
  expect(getEventListeners(network.signal, 'abort')).toHaveLength(0);
  expect(mockTransport).not.toHaveBeenCalled();
});
