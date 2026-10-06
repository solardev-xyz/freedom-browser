// Controlled primitives only: exercise the real composition sequencing/data
// branches without running signatures, ECDH, cipher, Poseidon or proof jobs.
let mockPlaintext;
const mockVerify = jest.fn(() => true);
jest.mock('crypto', () => ({
  createPrivateKey: () => ({}),
  createPublicKey: () => ({
    export: () => Buffer.from('302a300506032b6570032100' + 'aa'.repeat(32), 'hex'),
  }),
  sign: () => Buffer.alloc(64, 1),
  verify: (...args) => mockVerify(...args),
  createDecipheriv: () => ({
    setAuthTag() {},
    update: () => Buffer.from(JSON.stringify(mockPlaintext)),
    final: () => Buffer.alloc(0),
  }),
}));
jest.mock('ethers', () => ({
  keccak256: () => '0x' + '00'.repeat(32),
  toUtf8Bytes: () => Buffer.from('Railgun'),
  getAddress: (value) => '0x' + value.slice(2).toUpperCase(),
}));
jest.mock('./railgun-relay-public-data', () => ({
  validatePublicCase: () => ({ transactionSignals: [1n, 2n, 3n, 4n, 5n] }),
}));
const { createSelection, compose } = require('./railgun-relay-wire-crypto');
const { LIST, LIMITS } = require('./railgun-relay-wire-composition');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const now = 1791230400000;
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
const original = () => ({
  domain: 'public-fixture-relay-pre-poi-v1',
  minGasPrice: 1,
  transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data: '0x01020304' },
  poi: {
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    txidMerkleroot: word(21),
    poiMerkleroots: [word(22)],
    blindedCommitmentsOut: [word(23), word(24)],
    railgunTxidIfHasUnshield: '0x00',
  },
});
function setup(change = () => {}) {
  let time = now;
  const address = '0zk1' + 'q'.repeat(123);
  const encrypted = {
    randomPubKey: 'ab'.repeat(32),
    encryptedData: ['0x' + '01'.repeat(32), '0x01'],
    sharedKey: Uint8Array.from(Array(32).fill(2)),
  };
  const context = {
    poseidon: () => 42n,
    gas: {
      EVMGasType: { Type1: 1 },
      calculateGasLimit: () => 100n,
      calculateMaximumGas: () => 100n,
      calculateBroadcasterFeeERC20Amount: () => ({
        tokenAddress: pins.wrappedNative,
        amount: 100n,
      }),
    },
    upstream: {
      ed: {
        getPublicKey: async () => Buffer.alloc(32, 0xaa),
        getSharedSecret: async () => Buffer.alloc(32, 2),
      },
      encodeAddress: () => address,
      getRailgunWalletAddressData: () => ({
        masterPublicKey: 42n,
        viewingPublicKey: Buffer.alloc(32, 0xaa),
        chain: { type: 0, id: pins.chainId },
      }),
      verifyBroadcasterSignature: async () => true,
      tryDecryptData: async () => JSON.parse(JSON.stringify(mockPlaintext)),
      OfflineClientEncryptor: {
        encryptTransaction: jest.fn(
          async (version, to, data, _address, feesID, chain, gas, adapt, map) => {
            mockPlaintext = {
              transactType: 'COMMON',
              txidVersion: version,
              to: '0x' + to.slice(2).toUpperCase(),
              data,
              broadcasterViewingKey: 'aa'.repeat(32),
              chainID: chain.id,
              chainType: chain.type,
              minGasPrice: gas.toString(),
              feesID,
              useRelayAdapt: adapt,
              devLog: false,
              minVersion: '8.0.0',
              maxVersion: '8.999.0',
              preTransactionPOIsPerTxidLeafPerList: JSON.parse(JSON.stringify(map)),
            };
            change(mockPlaintext, () => {
              time = now + LIMITS.quoteLifetimeMs;
            });
            return encrypted;
          }
        ),
      },
    },
  };
  return { context, encrypted, clock: () => time };
}
beforeEach(() => mockVerify.mockReturnValue(true));
test('actual composition branch returns detached decrypted data, never original case fallback', async () => {
  const { context, clock, encrypted } = setup();
  const selection = await createSelection(context, now),
    input = original();
  const result = await compose(context, selection, input, () => {}, clock);
  expect(result.publicCase).toEqual(input);
  expect(result.publicCase).not.toBe(input);
  expect(result.publicCase.poi.proof).not.toBe(input.poi.proof);
  expect(context.upstream.OfflineClientEncryptor.encryptTransaction).toHaveBeenCalledTimes(1);
  expect(encrypted.sharedKey.every((v) => v === 0)).toBe(true);
});
test.each([
  [
    'calldata',
    (p) => {
      p.data = '0xdeadbeef';
    },
  ],
  [
    'proof',
    (p) => {
      const leaf = Object.keys(p.preTransactionPOIsPerTxidLeafPerList[LIST])[0];
      p.preTransactionPOIsPerTxidLeafPerList[LIST][leaf].snarkProof.pi_a[0] = '99';
    },
  ],
  [
    'wrong target',
    (p) => {
      p.to = '0x' + 'ab'.repeat(20);
    },
  ],
  [
    'non-upstream target casing',
    (p) => {
      p.to = pins.proxy;
    },
  ],
  ['expired after encryption', (_p, expire) => expire()],
])('decrypted %s refuses and wipes returned shared key', async (_name, mutate) => {
  const { context, clock, encrypted } = setup(mutate);
  const selection = await createSelection(context, now);
  await expect(compose(context, selection, original(), () => {}, clock)).rejects.toThrow();
  expect(encrypted.sharedKey.every((v) => v === 0)).toBe(true);
});
test('independent signature rejection prevents encrypt admission', async () => {
  const { context, clock } = setup();
  const selection = await createSelection(context, now);
  mockVerify.mockReturnValue(false);
  await expect(compose(context, selection, original(), () => {}, clock)).rejects.toThrow();
  expect(context.upstream.OfflineClientEncryptor.encryptTransaction).not.toHaveBeenCalled();
});
test('actual fee helper result mismatch prevents encryption', async () => {
  const { context, clock } = setup();
  const selection = await createSelection(context, now);
  context.gas.calculateBroadcasterFeeERC20Amount = () => ({
    tokenAddress: pins.wrappedNative,
    amount: 101n,
  });
  await expect(compose(context, selection, original(), () => {}, clock)).rejects.toThrow();
  expect(context.upstream.OfflineClientEncryptor.encryptTransaction).not.toHaveBeenCalled();
});
