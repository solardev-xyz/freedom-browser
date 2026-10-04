// Real account registry/catalog, source and private RPC; store/coordinator
// authority seams are explicit mocks, not native lifecycle qualification.
let mockEnrollment, mockCreateCoordinator, mockSource, mockJobs;
const mockOpen = jest.fn(),
  mockAuthorities = new WeakSet(),
  mockEnrollments = new WeakSet(),
  mockRequest = jest.fn(),
  mockTransportFactory = jest.fn();
let mockEndpoint, mockRpcUrls, mockRpcSources, mockCreatedSources;
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => mockEnrollments.has(v),
}));
jest.mock('./railgun-account-store', () => ({
  openRailgunAccountStore: (...args) => mockOpen(...args),
}));
jest.mock('./railgun-public-policy', () => ({ getRailgunPublicPolicy: () => 'a'.repeat(64) }));
jest.mock('./railgun-public-run', () => ({ createRailgunPublicJobs: () => mockJobs }));
jest.mock('./railgun-scan-source', () => ({
  ...jest.requireActual('./railgun-scan-source'),
  createRailgunScanSource: (options) => {
    mockSource = jest.requireActual('./railgun-scan-source').createRailgunScanSource(options);
    mockCreatedSources.push({ source: mockSource, handle: options.handle });
    return mockSource;
  },
}));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({}),
  getEndpoints: () => mockRpcUrls,
  getEndpointSources: () => mockRpcSources,
}));
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: (...args) => mockTransportFactory(...args),
}));
jest.mock('./railgun-scan-coordinator', () => ({
  createRailgunScanCoordinator: (...args) => mockCreateCoordinator(...args),
  assertRailgunScanCoordinator: (v) => {
    if (!mockAuthorities.has(v) || v.signal.aborted) throw Error('coordinator');
  },
}));
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { createPrivacyScope } = require('../networks/privacy-context');
const { getPrivacyStoragePath } = require('./privacy-storage');
const {
  openRailgunAccountPublic,
  getRailgunAccountPublicDestination: destination,
  assertRailgunAccountPublicDestination: assertDestination,
  assertRailgunAccountPublic,
} = require('./railgun-account-public');
const { getPrivateRpcDestinationDetails } = require('../networks/private-rpc');
const { getRailgunScanSourceDestination } = require('./railgun-scan-source');
let scope, stores, controllers, opened, metadata, publicRecords, journalPath;
const originalUrl = 'https://account-source.example:8443/private-original-path';
function select(url = originalUrl) {
  mockRpcUrls = [url];
  mockRpcSources = [{ keyed: false, coverage: { 11155111: url } }];
}
beforeEach(() => {
  jest.clearAllMocks();
  select();
  mockCreatedSources = [];
  mockEndpoint = { signal: new AbortController().signal };
  mockTransportFactory.mockImplementation(() => ({ request: mockRequest, release: jest.fn() }));
  mockRequest.mockImplementation(async () => {
    throw Error('Unexpected source query in observation-only test');
  });
  stores = [];
  controllers = [];
  opened = [];
  metadata = 0;
  publicRecords = 0;
  scope = createPrivacyScope({
    profileId: 'account-public-test',
    signal: new AbortController().signal,
  });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-account-public-'))
  );
  mockEnrollment = {
    directory,
    binding: 'b'.repeat(64),
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
    profileGuard: { assert: jest.fn(), remember: jest.fn() },
    withPublicCatalogKey: async (use) => use({ 'public-catalog': Buffer.alloc(32, 6) }),
    withPublicGenerationKeys: async (_catalog, _id, use) => mockEnrollment.withPublicKeys(use),
    withTxidGenerationKeys: jest.fn(async (_catalog, _id, _policy, use) => {
      const key = Buffer.alloc(32, 7);
      try {
        return await use({ 'txid-journal': key });
      } finally {
        key.fill(0);
      }
    }),
    withPublicKeys: async (use) => {
      const key = Buffer.alloc(32, 5);
      try {
        return await use({ 'scan-journal': key });
      } finally {
        key.fill(0);
      }
    },
  };
  mockEnrollments.add(mockEnrollment);
  journalPath = getPrivacyStoragePath(
    mockEnrollment.getContext('storage', 'railgun-scan-v1'),
    directory
  );
  mockOpen.mockImplementation(async ({ enrollment: owner, kind, create, generationId }) => {
    const filename = path.join(owner.directory, 'railgun-public-' + generationId, kind + '.sqlite');
    if (create) fs.writeFileSync(filename, 'fixture');
    const controller = new AbortController();
    controllers.push(controller);
    let done;
    const closed = new Promise((resolve) => {
      done = resolve;
    });
    const session = {
      signal: controller.signal,
      closed,
      close: jest.fn(() => {
        controller.abort();
        done();
      }),
      inspectWalletState: async () => ({ count: publicRecords, bytes: publicRecords }),
      assertFresh: jest.fn(),
    };
    const ledger = {
      signal: controller.signal,
      identity: () => '1'.repeat(64),
      stage: jest.fn(),
      visit: jest.fn(),
      visitThrough: jest.fn(),
      retain: jest.fn(),
      assertEmpty: () => {
        if (metadata) throw Error('nonempty ledger');
      },
      close: () => session.close(),
    };
    const value = { session, ledger, storeId: (kind === 'source' ? '1' : '2').repeat(64) };
    stores.push(value);
    return value;
  });
  mockJobs = { project: jest.fn(async () => ({})), apply: jest.fn(async () => ({})) };
  mockCreateCoordinator = jest.fn(async (options) => {
    journalPath = getPrivacyStoragePath(
      mockEnrollment.getContext('storage', 'railgun-scan-v1'),
      options.journalStorage.directory
    );
    fs.writeFileSync(journalPath, 'fixture');
    const controller = new AbortController();
    controllers.push(controller);
    const plan = {
      to: { number: 10, hash: '0x' + 'a'.repeat(64) },
      source: { ledgerId: '1'.repeat(64) },
      state: { storeId: '2'.repeat(64) },
    };
    const coordinator = {
      identity: { ...options.journalStorage, ledgerId: '1'.repeat(64) },
      recover: jest.fn(),
      advance: jest.fn(async () => ({ to: plan.to })),
      inspect: jest.fn(() => ({ to: plan.to })),
      withPublicSnapshot: jest.fn(async (run) => ({ value: await run(), evidence: {} })),
      assertSnapshot: () => plan,
      signal: controller.signal,
      close: () => {
        controller.abort();
        options.storeSession.close();
      },
    };
    mockAuthorities.add(coordinator);
    return coordinator;
  });
});
afterEach(async () => {
  await Promise.all(opened.map((v) => v.close()));
  scope.close();
});
async function open(create = false, mode) {
  const result = await openRailgunAccountPublic({
    enrollment: mockEnrollment,
    archive: '/engine.asar',
    create,
    ...(mode ? { mode } : {}),
  });
  opened.push(result);
  return result;
}

function observeWorkBaseline(value) {
  mockOpen.mockClear();
  mockRequest.mockClear();
  mockTransportFactory.mockClear();
  mockJobs.project.mockClear();
  mockJobs.apply.mockClear();
  for (const method of ['recover', 'advance', 'inspect', 'withPublicSnapshot'])
    value.coordinator[method].mockClear();
  const keys = [
    'withPublicCatalogKey',
    'withPublicGenerationKeys',
    'withPublicKeys',
    'withTxidGenerationKeys',
  ].map((name) => jest.spyOn(mockEnrollment, name));
  keys.forEach((key) => key.mockClear());
  return () => {
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockTransportFactory).not.toHaveBeenCalled();
    expect(mockJobs.project).not.toHaveBeenCalled();
    expect(mockJobs.apply).not.toHaveBeenCalled();
    for (const method of ['recover', 'advance', 'inspect', 'withPublicSnapshot'])
      expect(value.coordinator[method]).not.toHaveBeenCalled();
    keys.forEach((key) => expect(key).not.toHaveBeenCalled());
    for (const { ledger } of stores)
      for (const method of ['stage', 'visit', 'visitThrough', 'retain'])
        expect(ledger[method]).not.toHaveBeenCalled();
  };
}
test('candidate and resumed pending generation refuse observation without queries, jobs, keys or unhealthy owner', async () => {
  const candidate = await open(true);
  let noWork = observeWorkBaseline(candidate);
  const sourceObservation = getRailgunScanSourceDestination(
    mockCreatedSources[0].source,
    mockCreatedSources[0].handle
  );
  expect(getPrivateRpcDestinationDetails(sourceObservation).url).toBe(originalUrl);
  expect(() => destination(candidate.coordinator, mockEnrollment)).toThrow();
  expect(() => assertDestination(candidate.coordinator, mockEnrollment, {})).toThrow();
  noWork();
  expect(candidate.signal.aborted).toBe(false);
  await candidate.close();
  const pending = await open(false, 'pending');
  noWork = observeWorkBaseline(pending);
  expect(() => destination(pending.coordinator, mockEnrollment, pending.policy)).toThrow();
  noWork();
  expect(pending.signal.aborted).toBe(false);
  await pending.publish();
  const observation = destination(pending.coordinator, mockEnrollment);
  expect(getPrivateRpcDestinationDetails(observation).url).toBe(originalUrl);
});
test('active cold coordinator exposes the exact retained source destination without recovering or querying', async () => {
  const first = await open(true);
  await first.publish();
  await first.close();
  const cold = await open(false, 'active');
  // Readiness may be absent even though the authenticated generation is active.
  cold.coordinator.inspect.mockImplementation(() => {
    throw Error('cold, not recovered');
  });
  const noWork = observeWorkBaseline(cold);
  const observation = destination(cold.coordinator, mockEnrollment, cold.policy);
  expect(observation).toBe(
    getRailgunScanSourceDestination(
      mockCreatedSources.at(-1).source,
      mockCreatedSources.at(-1).handle
    )
  );
  expect(destination(cold.coordinator, mockEnrollment)).toBe(observation);
  expect(() =>
    assertDestination(cold.coordinator, mockEnrollment, observation, cold.policy)
  ).not.toThrow();
  expect(JSON.stringify(observation)).toBe('{}');
  expect(getPrivateRpcDestinationDetails(observation)).toMatchObject({
    url: originalUrl,
    role: 'protocol-rpc',
    chainId: 11155111,
  });
  noWork();
});
test('copied coordinator, copied observation and wrong policy refuse without revoking healthy owner', async () => {
  const value = await open(true);
  await value.publish();
  const observation = destination(value.coordinator, mockEnrollment);
  const noWork = observeWorkBaseline(value);
  for (const fake of [{}, { ...value.coordinator }, Object.create(value.coordinator)]) {
    expect(() => destination(fake, mockEnrollment)).toThrow();
    expect(() => assertDestination(fake, mockEnrollment, observation)).toThrow();
  }
  for (const fake of [
    {},
    { ...observation },
    Object.create(observation),
    JSON.parse(JSON.stringify(observation)),
  ])
    expect(() => assertDestination(value.coordinator, mockEnrollment, fake)).toThrow();
  expect(() => destination(value.coordinator, mockEnrollment, 'f'.repeat(64))).toThrow();
  expect(() =>
    assertDestination(value.coordinator, mockEnrollment, observation, 'f'.repeat(64))
  ).toThrow();
  expect(() => assertDestination(value.coordinator, mockEnrollment, observation)).not.toThrow();
  expect(value.signal.aborted).toBe(false);
  noWork();
});
test('exact enrolled owner is required even when the older general assertion accepts equivalent authenticated identity', async () => {
  const value = await open(true);
  await value.publish();
  const observation = destination(value.coordinator, mockEnrollment);
  const equivalent = { ...mockEnrollment };
  mockEnrollments.add(equivalent);
  // This mock models the enrollment authenticity seam. The new exact-owner
  // restriction must not silently change the existing general assertion API.
  expect(() =>
    assertRailgunAccountPublic(value.coordinator, equivalent, value.policy)
  ).not.toThrow();
  const noWork = observeWorkBaseline(value);
  expect(() => destination(value.coordinator, equivalent)).toThrow();
  expect(() => assertDestination(value.coordinator, equivalent, observation)).toThrow();
  expect(() => assertDestination(value.coordinator, mockEnrollment, observation)).not.toThrow();
  expect(value.signal.aborted).toBe(false);
  noWork();
});
test('registry path replacement never rebuilds a source client during observation', async () => {
  const value = await open(true);
  await value.publish();
  const original = destination(value.coordinator, mockEnrollment);
  const count = mockCreatedSources.length;
  select('https://account-source.example:8443/new-path');
  const noWork = observeWorkBaseline(value);
  expect(destination(value.coordinator, mockEnrollment)).toBe(original);
  expect(getPrivateRpcDestinationDetails(original).url).toBe(originalUrl);
  expect(mockCreatedSources).toHaveLength(count);
  noWork();
});
test('close/reopen gives a new binding and stale close cannot remove the replacement owner', async () => {
  const first = await open(true);
  await first.publish();
  const old = destination(first.coordinator, mockEnrollment);
  await first.close();
  const next = await open(false, 'active');
  const current = destination(next.coordinator, mockEnrollment);
  expect(current).not.toBe(old);
  expect(() => destination(first.coordinator, mockEnrollment)).toThrow();
  expect(() => assertDestination(next.coordinator, mockEnrollment, old)).toThrow();
  expect(() => getPrivateRpcDestinationDetails(old)).toThrow();
  await first.close();
  const noWork = observeWorkBaseline(next);
  expect(() => assertDestination(next.coordinator, mockEnrollment, current)).not.toThrow();
  expect(next.signal.aborted).toBe(false);
  noWork();
});
test.each(['enrollment', 'source-worker', 'public-worker', 'tor-replacement'])(
  'registered account destination refuses after %s lifetime change with no recovery',
  async (boundary) => {
    const value = await open(true);
    await value.publish();
    const observation = destination(value.coordinator, mockEnrollment);
    const noWork = observeWorkBaseline(value);
    if (boundary === 'enrollment') scope.close();
    if (boundary === 'source-worker') stores[0].session.close();
    if (boundary === 'public-worker') stores[1].session.close();
    if (boundary === 'tor-replacement') mockEndpoint = { signal: new AbortController().signal };
    expect(() => destination(value.coordinator, mockEnrollment)).toThrow();
    expect(() => assertDestination(value.coordinator, mockEnrollment, observation)).toThrow();
    expect(() => getPrivateRpcDestinationDetails(observation)).toThrow();
    noWork();
  }
);

test('two healthy enrolled owners cannot substitute each other despite equal binding, profile and URL', async () => {
  const first = await open(true);
  await first.publish();
  const otherEnrollment = {
    ...mockEnrollment,
    directory: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'other-source-owner-'))),
  };
  mockEnrollments.add(otherEnrollment);
  const second = await openRailgunAccountPublic({
    enrollment: otherEnrollment,
    archive: '/engine.asar',
    create: true,
  });
  opened.push(second);
  await second.publish();
  const firstObservation = destination(first.coordinator, mockEnrollment);
  const secondObservation = destination(second.coordinator, otherEnrollment);
  expect(secondObservation).not.toBe(firstObservation);
  const noWork = observeWorkBaseline(first);
  expect(() => destination(first.coordinator, otherEnrollment)).toThrow();
  expect(() => destination(second.coordinator, mockEnrollment)).toThrow();
  expect(() => assertDestination(first.coordinator, mockEnrollment, secondObservation)).toThrow();
  expect(() => assertDestination(second.coordinator, otherEnrollment, firstObservation)).toThrow();
  expect(() =>
    assertDestination(first.coordinator, mockEnrollment, firstObservation)
  ).not.toThrow();
  expect(() =>
    assertDestination(second.coordinator, otherEnrollment, secondObservation)
  ).not.toThrow();
  expect(first.signal.aborted).toBe(false);
  expect(second.signal.aborted).toBe(false);
  noWork();
});
