let mockServices;
jest.mock('./railgun-public-services', () => ({ createRailgunPublicServices: () => mockServices }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createRailgunTxidRootSource, MAX_AGE_MS } = require('./railgun-txid-root');
let source, scope, controller, point;
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'root-test', signal: new AbortController().signal });
  controller = new AbortController();
  point = { index: 100, root: '1'.repeat(64) };
  mockServices = {
    signal: controller.signal,
    close: jest.fn(() => controller.abort()),
    latestTxid: jest.fn(async () => ({ index: 110, root: '2'.repeat(64) })),
    validateTxidRoot: jest.fn(async () => true),
  };
  source = createRailgunTxidRootSource(
    scope.getContext({
      kind: 'service',
      principal: 'railgun-public-sync',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'public-services',
    })
  );
});
afterEach(() => {
  source.close();
  scope.close();
  jest.restoreAllMocks();
});
test('root receipts bind the exact point and expose only service acceptance', async () => {
  const receipt = await source.acquire(point);
  expect(mockServices.validateTxidRoot).toHaveBeenCalledWith({ tree: 0, ...point });
  expect(source.assertRoot(receipt, point)).toMatchObject({
    ...point,
    accepted: true,
    latestIndex: 110,
  });
  expect(source.assertRoot(receipt, point).spendable).toBeUndefined();
  expect(() => source.assertRoot({}, point)).toThrow();
  expect(() => source.assertRoot(receipt, { ...point, index: 101 })).toThrow();
  expect(() => source.assertRoot(receipt, { ...point, root: '2'.repeat(64) })).toThrow();
});
test.each(['unvalidated', 'ahead', 'changed-current-root', 'failure'])(
  'refuses %s without issuing evidence',
  async (kind) => {
    if (kind === 'unvalidated') mockServices.validateTxidRoot.mockResolvedValue(false);
    if (kind === 'ahead')
      mockServices.latestTxid.mockResolvedValue({ index: 99, root: point.root });
    if (kind === 'changed-current-root')
      mockServices.latestTxid.mockResolvedValue({ index: 100, root: '2'.repeat(64) });
    if (kind === 'failure')
      mockServices.validateTxidRoot.mockRejectedValue(new Error('secret URL'));
    await expect(source.acquire(point)).rejects.toMatchObject({
      code: ['unvalidated', 'changed-current-root'].includes(kind)
        ? 'RAILGUN_TXID_ROOT_REJECTED'
        : 'RAILGUN_TXID_ROOT_REFUSED',
      message: 'Railgun TXID root unavailable',
    });
    expect(mockServices.close).toHaveBeenCalled();
  }
);
test('bounds index and root before making a public query', async () => {
  for (const value of [
    { ...point, index: 8000 },
    { ...point, index: -1 },
    { ...point, root: 'f'.repeat(64) },
    { ...point, tree: 1 },
  ])
    await expect(source.acquire(value)).rejects.toThrow();
  expect(mockServices.latestTxid).not.toHaveBeenCalled();
});
test('expiry and service-lifetime revocation invalidate previously issued receipts', async () => {
  const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
  const receipt = await source.acquire(point);
  clock.mockReturnValue(1000 + MAX_AGE_MS);
  expect(() => source.assertRoot(receipt, point)).toThrow();
  clock.mockReturnValue(1001);
  controller.abort();
  expect(() => source.assertRoot(receipt, point)).toThrow();
});
test('snapshots the point before service I/O and refuses concurrent requests', async () => {
  let release;
  mockServices.latestTxid.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const expected = { ...point },
    pending = source.acquire(point);
  point.index = 101;
  await expect(source.acquire(expected)).rejects.toThrow();
  release({ index: 110, root: '2'.repeat(64) });
  const receipt = await pending;
  expect(source.assertRoot(receipt, expected).index).toBe(100);
});
