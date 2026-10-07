/** Source/controlled arithmetic and crypto seams only; no archive or crypto execution. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mockList = '43a72e714401762df66b68c26dfbdf2682aaec9f2474eca4613e424a0fbafd3c';
const mockHex = (v) => BigInt(v).toString(16).padStart(64, '0');
const mockHash = ([a, b]) => (BigInt('0x' + a) * 3n + BigInt('0x' + b) + 1n) % (1n << 240n);
let mockCrypto, mockRecords, mockPoseidon, mockVectors, mockEngine;
jest.mock('crypto', () => mockCrypto);
jest.mock('../../src/main/wallet/railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (...v) => mockEngine(...v),
}));
jest.mock('../../src/main/wallet/railgun-poi-records', () => mockRecords);
jest.mock('./railgun-relay-quote-native-vectors', () => ({
  buildVectors: (...v) => mockVectors(...v),
}));
jest.mock('../../src/main/wallet/railgun-relay-quote-data', () => ({
  ...jest.requireActual('../../src/main/wallet/railgun-relay-quote-data'),
  normalizeRailgunRelayQuote: (quote) => ({
    fields: JSON.parse(Buffer.from(quote.data, 'hex').toString()),
  }),
}));
jest.mock(
  '/fixture.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    initPoseidonPromise: Promise.resolve(),
    poseidon: (...v) => mockPoseidon(...v),
    poseidonHex: (v) => mockHex(mockHash(v)),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({ getTokenDataERC20: (token) => token, getTokenDataHash: () => '05' }),
  { virtual: true }
);
jest.mock(
  '/fixture.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({ TransactNote: { getHash: (npk, token, value) => npk + BigInt('0x' + token) + value } }),
  { virtual: true }
);
let run, input, context;
beforeEach(() => {
  jest.resetModules();
  const actual = jest.requireActual('crypto');
  const sign = (_algorithm, message) =>
    Buffer.concat([
      actual.createHash('sha256').update(message).digest(),
      actual.createHash('sha256').update(message).digest(),
    ]);
  mockCrypto = {
    ...actual,
    createPrivateKey: jest.fn(() => ({ private: true })),
    sign: jest.fn(sign),
    createPublicKey: jest.fn((value) =>
      value.private
        ? { export: () => Buffer.from('302a300506032b6570032100' + mockList, 'hex') }
        : { key: value.key.toString('hex').slice(-64) }
    ),
    verify: jest.fn(
      (_algorithm, message, key, signature) =>
        key.key === mockList && sign(null, message).equals(signature)
    ),
  };
  const filename = path.join(
    path.dirname(require.resolve('@freedom/railgun-kohaku-adapter/host/poi')),
    'src/data/railgun-poi-records.js'
  );
  // Transform only authenticated installed source bytes in memory. The Freedom
  // wrapper contains no list literal, and no installed package file is written.
  const source = require('../qualify-railgun-relay-positive')
    .deriveIsolatedPoiSource(fs.readFileSync(filename))
    .toString('utf8');
  const sandbox = {
    require: (name) => {
      expect(name).toBe('crypto');
      return mockCrypto;
    },
    module: { exports: {} },
    Buffer,
  };
  vm.runInNewContext(source, sandbox);
  mockRecords = sandbox.module.exports;
  mockPoseidon = jest.fn(([a, b, c]) => a * 3n + b + c);
  mockEngine = jest.fn(() => '/fixture.asar');
  mockVectors = jest.fn((_archive, createdAt) => ({
    gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
    cases: [
      {
        quote: {
          data: Buffer.from(
            JSON.stringify({
              feeExpiration: createdAt + 240000,
              requiredPOIListKeys: ['11'.repeat(32)],
            })
          ).toString('hex'),
        },
      },
    ],
  }));
  input = {
    archive: '/fixture.asar',
    createdAt: Date.now(),
    selected: {
      hash: '0x' + mockHex(2008),
      npk: '0x' + mockHex(3),
      tree: 0,
      position: 1,
      blindedCommitment: '0x' + mockHex(6028),
      type: 'Shield',
      amount: '2000',
    },
  };
  context = {
    signal: new AbortController().signal,
    guardReport: () => require('../../src/main/wallet/railgun-relay-quote-data').EXPECTED_GUARDS,
    request: jest
      .fn(async (text) => ({ id: JSON.parse(text).id, value: null }))
      .mockImplementation(async (text) => JSON.stringify({ id: JSON.parse(text).id, value: null })),
  };
  run = require('./railgun-relay-positive-membership-job').run;
});
test('derives public one-leaf path and exact signed list/quote using controlled primitives', async () => {
  await run(JSON.stringify(input), context);
  expect(mockPoseidon).toHaveBeenCalledWith([2008n, 3n, 1n]);
  const value = JSON.parse(context.request.mock.calls[0][0]).value;
  expect(value.proof.elements).toHaveLength(16);
  expect(new Set(value.proof.elements).size).toBeGreaterThan(1);
  expect(value.proof.leaf).toBe(input.selected.blindedCommitment.slice(2));
  expect(value.event.signedPOIEvent.blindedCommitment).toBe(input.selected.blindedCommitment);
  expect(JSON.parse(Buffer.from(value.quote.data, 'hex'))).toEqual({
    feeExpiration: input.createdAt + 240000,
    requiredPOIListKeys: [mockList],
  });
  expect(value.controls).toEqual({
    badEventRefused: true,
    productionKeyRefused: true,
    badPathRefused: true,
    otherEventAndPathVerified: true,
    otherNoteUnequal: true,
    otherEventSelectedJoinRefused: true,
  });
  expect(Object.keys(value).some((key) => /private|witness|key/i.test(key))).toBe(false);
  expect(mockCrypto.sign).toHaveBeenCalledTimes(3);
  const firstMessage = mockCrypto.sign.mock.calls[0][1].toString();
  expect(firstMessage).toBe(
    JSON.stringify({
      index: 0,
      blindedCommitment: input.selected.blindedCommitment,
      type: 'Shield',
    })
  );
});
test.each([
  'hash',
  'npk',
  'blind',
  'amount',
  'type',
  'extra',
  'tree',
  'position',
  'createdAt',
  'archive',
])('refuses changed selected %s without a result', async (kind) => {
  if (kind === 'hash') input.selected.hash = '0x' + mockHex(2009);
  if (kind === 'npk') input.selected.npk = '0x' + mockHex(4);
  if (kind === 'blind') input.selected.blindedCommitment = '0x' + mockHex(9);
  if (kind === 'amount') input.selected.amount = '1000';
  if (kind === 'type') input.selected.type = 'Transact';
  if (kind === 'extra') input.selected.verified = true;
  if (kind === 'tree') input.selected.tree = -1;
  if (kind === 'position') input.selected.position = 65536;
  if (kind === 'createdAt') input.createdAt -= 16000;
  if (kind === 'archive') input.archive = 'relative.asar';
  await expect(run(JSON.stringify(input), context)).rejects.toThrow();
  expect(context.request).not.toHaveBeenCalled();
});
test('production trust constant is not silently accepted', async () => {
  mockRecords.REQUIRED_LIST = '00'.repeat(32);
  await expect(run(JSON.stringify(input), context)).rejects.toThrow();
  expect(mockEngine).not.toHaveBeenCalled();
});
test('one attempt only, even after a rejected first input', async () => {
  await expect(run('{}', context)).rejects.toThrow();
  await expect(run(JSON.stringify(input), context)).rejects.toThrow();
  expect(context.request).not.toHaveBeenCalled();
});
test('retains original acknowledgement through cancellation and then refuses', async () => {
  let release;
  const c = new AbortController();
  context.signal = c.signal;
  context.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  let settled = false;
  const work = run(JSON.stringify(input), context);
  const observed = work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  c.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  release(JSON.stringify({ id: 1, value: null }));
  await expect(work).rejects.toThrow();
  await observed;
});
test.each(['guard', 'reply', 'large'])('refuses %s corruption', async (kind) => {
  if (kind === 'guard') context.guardReport = () => ({ attempts: 0, hooks: ['fake'], canaries: 1 });
  if (kind === 'reply') context.request.mockResolvedValue('{"id":2,"value":null}');
  await expect(
    run(kind === 'large' ? ' '.repeat(8193) : JSON.stringify(input), context)
  ).rejects.toThrow();
});
