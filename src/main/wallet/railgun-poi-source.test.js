let mockEndpoint;
const mockRequest = jest.fn(),
  mockClose = jest.fn();
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest, close: mockClose }),
}));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunPoiSource, MAX_AGE_MS } = require('./railgun-poi-source');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => n.toString(16).padStart(64, '0');
const events = require('../../../scripts/fixtures/railgun-poi-signed-event.json');
const notes = [{ blindedCommitment: events[0].signedPOIEvent.blindedCommitment, type: 'Shield' }];
const proof = {
  leaf: notes[0].blindedCommitment.slice(2),
  elements: Array(16).fill(hex(0)),
  indices: hex(0),
  root: hex(9),
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
let scope, handle, source, replyStatus, accepted;
beforeEach(() => {
  jest.clearAllMocks();
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({ profileId: 'poi-test', signal: new AbortController().signal });
  handle = scope.getContext(subject);
  replyStatus = 'Valid';
  accepted = true;
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
});
afterEach(() => {
  source?.close();
  source = undefined;
  scope.close();
  jest.restoreAllMocks();
});
const open = () => (source = createRailgunPoiSource({ handle, notes }));
test('fixed requests use an isolated account operation and only issue service observations', async () => {
  const client = open(),
    { receipt, observation } = await client.acquire();
  expect(client.assertResult(receipt)).toBe(observation);
  expect(observation).toMatchObject({
    rootsAccepted: true,
    membershipVerified: false,
    spendingEnabled: false,
  });
  expect(mockRequest.mock.calls.map(([, , options]) => JSON.parse(options.body).method)).toEqual([
    'ppoi_pois_per_list',
    'ppoi_merkle_proofs',
    'ppoi_poi_events',
    'ppoi_validate_poi_merkleroots',
  ]);
  for (const [h, url, options] of mockRequest.mock.calls) {
    const c = getPrivacyContext(h);
    expect(c.subject).toEqual(subject);
    expect(c.isolationToken).not.toBe(getPrivacyContext(handle).isolationToken);
    expect(url).toBe('https://ppoi.fdi.network');
    expect(JSON.parse(options.body).params).toMatchObject({
      chainType: '0',
      chainID: '11155111',
      txidVersion: 'V2_PoseidonMerkle',
    });
  }
  expect(client.submit).toBeUndefined();
  const again = await client.acquire();
  expect(() => client.assertResult(receipt)).toThrow();
  expect(client.assertResult(again.receipt)).toBe(again.observation);
  expect(() => client.assertResult({})).toThrow();
});
test.each(['Missing', 'ShieldBlocked', 'ProofSubmitted'])(
  'advisory %s never fetches proofs or grants membership',
  async (value) => {
    replyStatus = value;
    const result = await open().acquire();
    expect(result.observation).toMatchObject({
      proofs: null,
      rootsAccepted: false,
      membershipVerified: false,
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test('negative root acceptance stays negative', async () => {
  accepted = false;
  const result = await open().acquire();
  expect(source.assertResult(result.receipt).rootsAccepted).toBe(false);
});
test.each(['error', 'id', 'http', 'large', 'json', 'field', 'root-type'])(
  'invalid %s reply closes and sanitizes the error',
  async (kind) => {
    const normal = mockRequest.getMockImplementation();
    mockRequest.mockImplementation(async (...args) => {
      const reply = await normal(...args),
        value = JSON.parse(reply.body);
      if (kind === 'error') value.error = { message: 'sensitive remote payload' };
      if (kind === 'id') value.id = 'other';
      if (kind === 'http') reply.status = 302;
      if (kind === 'field') value.result = { extra: 'no' };
      if (
        kind === 'root-type' &&
        JSON.parse(args[2].body).method === 'ppoi_validate_poi_merkleroots'
      )
        value.result = 'true';
      reply.body =
        kind === 'large'
          ? Buffer.alloc(32769)
          : Buffer.from(kind === 'json' ? '{' : JSON.stringify(value));
      return reply;
    });
    const client = open();
    await expect(client.acquire()).rejects.toThrow('Railgun POI source unavailable');
    expect(client.signal.aborted).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
  }
);
test.each(['lock', 'endpoint', 'overlap'])(
  'in-flight %s cannot expose stale observations',
  async (kind) => {
    const normal = mockRequest.getMockImplementation();
    let release;
    mockRequest.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return normal(...args);
    });
    const client = open(),
      pending = client.acquire();
    if (kind === 'overlap') {
      await expect(client.acquire()).rejects.toThrow();
      release();
      expect((await pending).observation.rootsAccepted).toBe(true);
    } else {
      const refused = expect(pending).rejects.toThrow();
      if (kind === 'lock') scope.close();
      else mockEndpoint = { signal: new AbortController().signal };
      release();
      await refused;
    }
  }
);
test('receipts expire, reject clock rollback, and are tied to this client', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const client = open(),
    result = await client.acquire();
  now = 99;
  expect(() => client.assertResult(result.receipt)).toThrow();
  now = 100 + MAX_AGE_MS;
  expect(() => client.assertResult(result.receipt)).toThrow();
  now = 100;
  const other = createRailgunPoiSource({ handle, notes });
  expect(() => other.assertResult(result.receipt)).toThrow();
  other.close();
  client.close();
  expect(() => client.assertResult(result.receipt)).toThrow();
});
test('public sync, wrong chain, unscoped operations and stronger requirements are refused before I/O', () => {
  for (const change of [
    { kind: 'service' },
    { principal: 'railgun:65536' },
    { principal: 'railgun:00' },
    { chainId: 1 },
    { deployment: 'mainnet' },
    { role: 'public-services' },
    { operation: undefined },
  ]) {
    expect(() =>
      createRailgunPoiSource({ handle: scope.getContext({ ...subject, ...change }), notes })
    ).toThrow();
  }
  expect(() =>
    createRailgunPoiSource({ handle: scope.getContext(subject, { correctness: 'proof' }), notes })
  ).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
