let mockEndpoint, mockJobMode, mockExit, mockReleaseJob;
const mockRequest = jest.fn(),
  mockStart = jest.fn();
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest, close: jest.fn() }),
}));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('./railgun-process', () => ({ startRailgunProcess: (...args) => mockStart(...args) }));
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (v) => v }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunPoiSource, assertRailgunPoiSource } = require('./railgun-poi-source');
const {
  verifyRailgunPoiMembership,
  assertRailgunPoiMembership,
} = require('./railgun-poi-membership');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const events = require('../../../scripts/fixtures/railgun-poi-signed-event.json');
const notes = [{ blindedCommitment: events[0].signedPOIEvent.blindedCommitment, type: 'Shield' }];
const proof = {
  leaf: notes[0].blindedCommitment.slice(2),
  elements: Array(16).fill('0'.repeat(64)),
  indices: '0'.repeat(64),
  root: '1'.repeat(64),
};
const subject = {
  kind: 'private-account',
  principal: 'railgun:0',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  role: 'poi',
  operation: 'poi:' + 'a'.repeat(64),
};
let scope, handle, source, accepted, replyStatus;
beforeEach(() => {
  jest.clearAllMocks();
  mockJobMode = null;
  mockExit = undefined;
  mockReleaseJob = undefined;
  accepted = true;
  replyStatus = 'Valid';
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({
    profileId: 'membership-test',
    signal: new AbortController().signal,
  });
  handle = scope.getContext(subject);
  mockRequest.mockImplementation(async (_h, _u, options) => {
    const body = JSON.parse(options.body);
    const result =
      body.method === 'ppoi_pois_per_list'
        ? { [notes[0].blindedCommitment]: { [REQUIRED_LIST]: replyStatus } }
        : body.method === 'ppoi_merkle_proofs'
          ? [proof]
          : body.method === 'ppoi_poi_events'
            ? events
            : accepted;
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
    };
  });
  source = createRailgunPoiSource({ handle, notes });
  mockStart.mockImplementation(({ broker }) => {
    const closed = new Promise((resolve) => {
      mockExit = () => resolve({ code: 'RAILGUN_PROCESS_CLOSED' });
    });
    const close = jest.fn(() => {
      if (mockJobMode !== 'drain') mockExit();
    });
    const ready = Promise.resolve().then(async () => {
      const input = JSON.parse(await broker.dispatch(JSON.stringify({ id: 1, method: 'input' })));
      if (mockJobMode === 'drain')
        await new Promise((resolve) => {
          mockReleaseJob = resolve;
        });
      const value = { proofs: input.value.proofs, guards: { attempts: 0 }, inventory };
      if (mockJobMode === 'proof') value.proofs[0].root = '2'.repeat(64);
      if (mockJobMode === 'inventory') value.inventory = '0'.repeat(64);
      if (mockJobMode === 'egress') value.guards.attempts = 1;
      await broker.dispatch(
        JSON.stringify({ id: mockJobMode === 'sequence' ? 3 : 2, method: 'result', value })
      );
    });
    return { ready, close, closed };
  });
});
afterEach(() => {
  source.close();
  scope.close();
});
async function run(receipt) {
  return verifyRailgunPoiMembership({ handle, source, receipt, archive: '/fixture/engine.asar' });
}
test('membership receipt binds genuine service evidence, and source refresh or closure revokes it', async () => {
  const observed = await source.acquire(),
    checked = await run(observed.receipt);
  expect(checked.observation).toMatchObject({
    rootsAccepted: true,
    membershipVerified: true,
    spendingEnabled: false,
  });
  expect(assertRailgunPoiMembership(checked.receipt, handle)).toBe(checked.observation);
  expect(() => assertRailgunPoiMembership({}, handle)).toThrow();
  await source.acquire();
  expect(() => assertRailgunPoiMembership(checked.receipt, handle)).toThrow();
});
test('negative/missing service results never start a membership utility', async () => {
  accepted = false;
  let observed = await source.acquire();
  await expect(run(observed.receipt)).rejects.toThrow();
  replyStatus = 'Missing';
  observed = await source.acquire();
  await expect(run(observed.receipt)).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});
test('a window can only shorten the membership worker budget and margin inherits source age', async () => {
  const observed = await source.acquire();
  const checked = await verifyRailgunPoiMembership({
    handle,
    source,
    receipt: observed.receipt,
    archive: '/fixture/engine.asar',
    timeoutMs: 1234,
  });
  expect(mockStart.mock.calls[0][0]).toMatchObject({ startupMs: 1234, lifetimeMs: 1234 });
  expect(assertRailgunPoiMembership(checked.receipt, handle, 1000)).toBe(checked.observation);
  for (const timeoutMs of [0, -1, 0.5, 180001, NaN])
    await expect(
      verifyRailgunPoiMembership({
        handle,
        source,
        receipt: observed.receipt,
        archive: '/fixture/engine.asar',
        timeoutMs,
      })
    ).rejects.toThrow();
  expect(() => assertRailgunPoiMembership(checked.receipt, handle, 60000)).toThrow();
  expect(mockStart).toHaveBeenCalledTimes(1);
});
test.each(['proof', 'inventory', 'egress', 'sequence'])(
  'bad utility %s cannot issue evidence',
  async (mode) => {
    mockJobMode = mode;
    const observed = await source.acquire();
    await expect(run(observed.receipt)).rejects.toThrow('Railgun POI membership unavailable');
    expect(source.signal.aborted).toBe(true);
  }
);
test('revocation waits for actual utility exit before returning failure', async () => {
  mockJobMode = 'drain';
  const observed = await source.acquire();
  let settled = false;
  const pending = run(observed.receipt).finally(() => {
    settled = true;
  });
  const refused = expect(pending).rejects.toThrow();
  for (let n = 0; n < 10 && !mockReleaseJob; n++) await Promise.resolve();
  expect(mockReleaseJob).toBeDefined();
  source.close();
  mockReleaseJob();
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(settled).toBe(false);
  mockExit();
  await refused;
});
test('forged source, foreign operation, profile generation and receipts refuse before compute', async () => {
  const observed = await source.acquire();
  expect(() => assertRailgunPoiSource({ ...source }, handle)).toThrow();
  expect(() =>
    assertRailgunPoiSource(
      source,
      scope.getContext({ ...subject, operation: 'poi:' + 'b'.repeat(64) })
    )
  ).toThrow();
  const other = createPrivacyScope({
    profileId: 'membership-test',
    signal: new AbortController().signal,
  });
  expect(() => assertRailgunPoiSource(source, other.getContext(subject))).toThrow();
  other.close();
  await expect(run({})).rejects.toThrow();
  await expect(
    verifyRailgunPoiMembership({
      handle,
      source: { ...source },
      receipt: observed.receipt,
      archive: '/fixture/engine.asar',
    })
  ).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
});
