// Controlled algorithm/IPC seams only. No claim of native or real crypto execution.
const mock = {};
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (a) => {
    mock.auth(a);
    return a;
  },
}));
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createPublicKey: (...args) => mock.key(...args),
  verify: (...args) => mock.node(...args),
}));
jest.mock(
  '/public/engine.asar/node_modules/@railgun-community/engine/dist/key-derivation/bech32',
  () => ({
    decodeAddress: (a) => mock.decode(a),
    encodeAddress: (a) => mock.encode(a),
  }),
  { virtual: true }
);
jest.mock(
  '/public/engine.asar/node_modules/@noble/ed25519/lib/index.js',
  () => ({
    Point: { fromHex: (...args) => mock.point(...args), ZERO: {} },
    ExtendedPoint: { fromAffine: () => ({ isSmallOrder: () => mock.small }) },
    CURVE: { l: 1n << 252n },
    verify: (...args) => mock.noble(...args),
  }),
  { virtual: true }
);
const { run } = require('./railgun-relay-quote-job');
const { EXPECTED_GUARDS } = require('./railgun-relay-quote-data');
const pins = require('./railgun-shield-pins.json');
function setup() {
  const controller = new AbortController();
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 200000,
    feesID: 'public',
    railgunAddress: '0zk1' + 'q'.repeat(123),
    identifier: 'public',
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: ['44'.repeat(32)],
    reliability: 0.5,
  };
  const input = {
    archive: '/public/engine.asar',
    quote: {
      data: Buffer.from(JSON.stringify(fields)).toString('hex'),
      signature: '03'.repeat(32) + '00'.repeat(32),
    },
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
  };
  const decoded = {
    chain: { type: 0, id: pins.chainId },
    version: 1,
    viewingPublicKey: Buffer.alloc(32, 2),
    masterPublicKey: 7n,
  };
  mock.auth = jest.fn();
  mock.decode = jest.fn(() => decoded);
  mock.encode = jest.fn(() => fields.railgunAddress);
  mock.point = jest.fn((bytes) => ({
    toRawBytes: () => bytes,
    equals: () => false,
    isTorsionFree: () => true,
  }));
  mock.small = false;
  mock.key = jest.fn(() => ({ publicOnly: true }));
  mock.node = jest.fn(() => true);
  mock.noble = jest.fn(async () => true);
  const request = jest.fn(async () => JSON.stringify({ id: 1, value: null }));
  const api = {
    signal: controller.signal,
    guardReport: () => JSON.parse(JSON.stringify(EXPECTED_GUARDS)),
    request,
  };
  return { input, decoded, controller, request, api, run: () => run(JSON.stringify(input), api) };
}
test('verifies archive before exact public address and dual equations, with one result and no key request', async () => {
  const f = setup();
  await f.run();
  expect(mock.auth).toHaveBeenCalledTimes(1);
  expect(mock.point).toHaveBeenCalledTimes(2);
  expect(mock.point.mock.calls.every((c) => c[1] === true)).toBe(true);
  expect(mock.noble).toHaveBeenCalledWith(
    Buffer.from(f.input.quote.signature, 'hex'),
    Buffer.from(f.input.quote.data, 'hex'),
    Buffer.alloc(32, 2)
  );
  expect(mock.node).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.request.mock.calls[0][0]).value).toMatchObject({
    signatureVerified: true,
    operatorTrusted: false,
    spendingEnabled: false,
    disclosureEnabled: false,
  });
  expect(mock.key.mock.calls[0][0]).toMatchObject({ format: 'der', type: 'spki' });
});
test.each([
  'all-chains',
  'wrong-chain',
  'noncanonical-address',
  'master-field',
  'identity-A',
  'identity-R',
  'small-order',
  'torsion',
  'noncanonical-A',
  'noncanonical-R',
  'S-range',
  'noble',
  'node',
  'guards',
  'abort-after-noble',
  'extra-private-input',
])('cryptographic/guard boundary %s refuses without output', async (kind) => {
  const f = setup();
  if (kind === 'all-chains') f.decoded.chain = undefined;
  if (kind === 'wrong-chain') f.decoded.chain.id = 1;
  if (kind === 'noncanonical-address') mock.encode.mockReturnValue('other');
  if (kind === 'master-field') f.decoded.masterPublicKey = 1n << 255n;
  if (kind === 'small-order') mock.small = true;
  if (
    kind === 'identity-A' ||
    kind === 'identity-R' ||
    kind === 'torsion' ||
    kind === 'noncanonical-A' ||
    kind === 'noncanonical-R'
  ) {
    let calls = 0;
    mock.point.mockImplementation((bytes) => {
      calls++;
      const bad = kind.endsWith('R') ? calls === 2 : calls === 1;
      return {
        toRawBytes: () => (bad && kind.startsWith('noncanonical') ? Buffer.alloc(32) : bytes),
        equals: () => bad && kind.startsWith('identity'),
        isTorsionFree: () => !(bad && kind === 'torsion'),
      };
    });
  }
  if (kind === 'S-range') f.input.quote.signature = '03'.repeat(32) + '00'.repeat(31) + '10';
  if (kind === 'noble') mock.noble.mockResolvedValue(false);
  if (kind === 'node') mock.node.mockReturnValue(false);
  if (kind === 'guards') f.api.guardReport = () => ({ hooks: ['hook'], canaries: 1, attempts: 0 });
  if (kind === 'abort-after-noble')
    mock.noble.mockImplementation(async () => {
      f.controller.abort();
      return true;
    });
  if (kind === 'extra-private-input') f.input.noteId = 'private';
  await expect(f.run()).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});
