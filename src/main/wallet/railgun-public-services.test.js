let mockEndpoint;
const mockRequest = jest.fn(),
  mockClose = jest.fn();
jest.mock('../networks/wallet-tor-transport', () => ({
  createWalletTorTransport: () => ({ request: mockRequest, close: mockClose }),
}));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  createRailgunPublicServices,
  normalizeTxidPage,
  normalizeTxidStatus,
  POI_URL,
  INDEXER_URL,
} = require('./railgun-public-services');
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const graphID = (n) => hash(n) + '0'.repeat(128);
const row = () => ({
  id: graphID(10),
  nullifiers: [hash(1)],
  commitments: [hash(2)],
  transactionHash: hash(3),
  boundParamsHash: hash(4),
  blockNumber: '10',
  utxoTreeIn: '0',
  utxoTreeOut: '0',
  utxoBatchStartPositionOut: '0',
  hasUnshield: false,
  unshieldToken: { tokenType: 'ERC20', tokenSubID: '0x00', tokenAddress: '0x' + '0'.repeat(40) },
  unshieldToAddress: '0x' + '0'.repeat(40),
  unshieldValue: '0',
  blockTimestamp: '100',
  verificationHash: hash(5),
});
let scope, handle, services;
beforeEach(() => {
  jest.clearAllMocks();
  mockEndpoint = { signal: new AbortController().signal };
  scope = createPrivacyScope({ profileId: 'services-test', signal: new AbortController().signal });
  handle = scope.getContext({
    kind: 'service',
    principal: 'railgun-public-sync',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'public-services',
  });
  mockRequest.mockImplementation(async (_handle, _url, options) => {
    const body = JSON.parse(options.body);
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify(
          body.method
            ? {
                jsonrpc: '2.0',
                id: body.id,
                result: { validatedTxidIndex: 2, validatedTxidMerkleroot: hash(1).slice(2) },
              }
            : { data: { transactions: [row()] } }
        )
      ),
    };
  });
});
afterEach(() => {
  services?.close();
  services = undefined;
  scope.close();
});
test('only bounded public queries reach separate role contexts and pinned endpoints', async () => {
  services = createRailgunPublicServices(handle);
  expect(await services.latestTxid()).toEqual({ index: 2, root: hash(1).slice(2) });
  const page = await services.txidPage();
  expect(page.transactions[0]).toMatchObject({
    graphID: graphID(10),
    blockNumber: 10,
    txid: hash(3).slice(2),
    version: 'V2',
  });
  expect(Object.isFrozen(page.transactions[0].commitments)).toBe(true);
  expect(page.exhausted).toBe(true);
  expect(
    mockRequest.mock.calls.map(([h, url]) => [getPrivacyContext(h).subject.role, url])
  ).toEqual([
    ['poi', POI_URL],
    ['indexer', INDEXER_URL],
  ]);
  expect(mockRequest.mock.calls[1][2].body).toContain('limit: 100');
  expect(services.trust.level).toBe('unverified-service');
  expect(services.submit).toBeUndefined();
});
test.each(['id', 'error', 'status', 'oversize', 'json', 'root', 'index'])(
  'malformed %s reply closes capability and never returns source data',
  async (kind) => {
    mockRequest.mockImplementation(async (_h, _u, options) => {
      const body = JSON.parse(options.body),
        result = { validatedTxidIndex: 2, validatedTxidMerkleroot: hash(1).slice(2) };
      if (kind === 'root') result.validatedTxidMerkleroot = 'f'.repeat(64);
      if (kind === 'index') result.validatedTxidIndex = -1;
      const data = { jsonrpc: '2.0', id: kind === 'id' ? 'wrong' : body.id, result };
      if (kind === 'error') data.error = { message: 'private detail' };
      return {
        status: kind === 'status' ? 302 : 200,
        body:
          kind === 'oversize'
            ? Buffer.alloc(1024 * 1024 + 1)
            : Buffer.from(kind === 'json' ? '{' : JSON.stringify(data)),
      };
    });
    services = createRailgunPublicServices(handle);
    await expect(services.latestTxid()).rejects.toThrow('Railgun public service unavailable');
    expect(services.signal.aborted).toBe(true);
    expect(mockClose).toHaveBeenCalledTimes(1);
    await expect(services.txidPage()).rejects.toThrow();
  }
);
test.each(['lock', 'endpoint'])('late response after %s cannot return data', async (kind) => {
  let release;
  const reply = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return reply(...args);
  });
  services = createRailgunPublicServices(handle);
  const pending = services.latestTxid();
  const rejected = expect(pending).rejects.toThrow();
  if (kind === 'lock') scope.close();
  else mockEndpoint = { signal: new AbortController().signal };
  release();
  await rejected;
  expect(services.signal.aborted).toBe(true);
});
test('wrong purpose, chain or requested correctness never obtains a transport capability', () => {
  for (const change of [
    { role: 'poi' },
    { kind: 'private-account' },
    { principal: 'railgun:0' },
    { chainId: 1 },
    { deployment: 'mainnet' },
    { operation: 'spend' },
  ]) {
    const subject = { ...getPrivacyContext(handle).subject, operation: undefined, ...change };
    expect(() => createRailgunPublicServices(scope.getContext(subject))).toThrow();
  }
  const subject = { ...getPrivacyContext(handle).subject, operation: undefined };
  expect(() =>
    createRailgunPublicServices(scope.getContext(subject, { correctness: 'proof' }))
  ).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('status accepts exactly one known root field and bounds field elements', () => {
  expect(
    normalizeTxidStatus({ validatedTxidIndex: 0, validatedMerkleroot: hash(1).slice(2) })
  ).toEqual({ index: 0, root: hash(1).slice(2) });
  expect(() =>
    normalizeTxidStatus({
      validatedTxidIndex: 0,
      validatedMerkleroot: hash(1).slice(2),
      validatedTxidMerkleroot: hash(2).slice(2),
    })
  ).toThrow();
});
test.each([
  'duplicate',
  'backward',
  'block',
  'oversize',
  'field',
  'fraction',
  'tree',
  'position',
  'unshield',
  'extra',
])('indexer %s data refuses', (kind) => {
  const value = row();
  let data = [value],
    after = '0x00';
  if (kind === 'duplicate') data = [value, value];
  if (kind === 'backward') after = graphID(11);
  if (kind === 'block') value.blockNumber = '11';
  if (kind === 'oversize') data = Array(101).fill(value);
  if (kind === 'field') value.nullifiers = ['0x' + 'f'.repeat(64)];
  if (kind === 'fraction') value.blockTimestamp = '1.5';
  if (kind === 'tree') value.utxoTreeIn = '4294967296';
  if (kind === 'position') value.utxoBatchStartPositionOut = '65536';
  if (kind === 'unshield') value.unshieldValue = '-1';
  if (kind === 'extra') value.secret = 'no';
  expect(() => normalizeTxidPage(data, after)).toThrow();
});

test('unshield-only permits the sentinel pair or a real batch position, rejecting mixed sentinels', () => {
  const value = {
    ...row(),
    hasUnshield: true,
    utxoTreeOut: '99999',
    utxoBatchStartPositionOut: '99999',
  };
  expect(normalizeTxidPage([value], '0x00').transactions[0]).toMatchObject({
    utxoTreeOut: 99999,
    utxoBatchStartPositionOut: 99999,
    unshield: { value: '0' },
  });
  expect(
    normalizeTxidPage([{ ...value, utxoTreeOut: '0', utxoBatchStartPositionOut: '1448' }], '0x00')
      .transactions[0].utxoBatchStartPositionOut
  ).toBe(1448);
  for (const change of [
    { hasUnshield: false },
    { utxoTreeOut: '0' },
    { utxoBatchStartPositionOut: '0' },
    { commitments: [hash(2), hash(6)] },
  ])
    expect(() => normalizeTxidPage([{ ...value, ...change }], '0x00')).toThrow();
});

test('public root validation preserves a negative service answer and rejects nonboolean claims', async () => {
  services = createRailgunPublicServices(handle);
  const checkpoint = { tree: 0, index: 2, root: hash(1).slice(2) };
  mockRequest.mockImplementationOnce(async (_h, _u, options) => {
    const request = JSON.parse(options.body);
    expect(request.method).toBe('ppoi_validate_txid_merkleroot');
    expect(request.params).toMatchObject({ tree: 0, index: 2, merkleroot: checkpoint.root });
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: false })),
    };
  });
  expect(await services.validateTxidRoot(checkpoint)).toBe(false);
  expect(services.signal.aborted).toBe(false);
  for (const value of [
    { ...checkpoint, tree: 16 },
    { ...checkpoint, index: 65536 },
    { ...checkpoint, root: 'f'.repeat(64) },
    { ...checkpoint, address: 'no' },
  ])
    expect(() => services.validateTxidRoot(value)).toThrow();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await expect(services.validateTxidRoot(checkpoint)).rejects.toThrow();
  expect(services.signal.aborted).toBe(true);
});
