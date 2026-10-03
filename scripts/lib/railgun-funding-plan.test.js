const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { Wallet, Transaction } = require('ethers');
const {
  createFundingPlan,
  writeFundingPlan,
  resignFundingPlan,
  assertFundingPlan,
} = require('./railgun-funding-plan');
const wallet = new Wallet('0x' + '11'.repeat(32)); // Public fixture only.
const expected = {
  from: wallet.address.toLowerCase(),
  to: '0x' + '22'.repeat(20),
  amount: 10000000000000000n,
  maxGasFee: 500000000000000n,
  profileBinding: 'a'.repeat(64),
  destinationSha256: 'b'.repeat(64),
};
const tx = {
  chainId: 11155111,
  to: expected.to,
  value: expected.amount,
  nonce: 6,
  type: 0,
  gasLimit: 21000n,
  gasPrice: 1000000000n,
  data: '0x',
};
let raw, plan;
beforeEach(async () => {
  raw = await wallet.signTransaction(tx);
  plan = createFundingPlan(raw, expected);
});
test('durable non-secret plan reconstructs byte-identical EIP-155 funding transaction', async () => {
  const filename = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-funding-plan-')),
    'plan.json'
  );
  writeFundingPlan(filename, plan);
  const text = fs.readFileSync(filename, 'utf8');
  expect(text).not.toContain(raw);
  expect(text).not.toContain(wallet.privateKey);
  expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
  expect(await resignFundingPlan(wallet, JSON.parse(text), expected)).toBe(raw);
  expect(() => writeFundingPlan(filename, plan)).toThrow();
});
test.each([
  { chainId: 1 },
  { to: '0x' + '33'.repeat(20) },
  { value: 1n },
  { data: '0x01' },
  { gasLimit: 21001n },
  { gasPrice: 30000000000n },
  { type: 2, gasPrice: undefined, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1n },
])('refuses different funding bounds %#', async (change) => {
  const other = await wallet.signTransaction({ ...tx, ...change });
  expect(() => createFundingPlan(other, expected)).toThrow();
});
test.each(['nonce', 'hash', 'source', 'destination', 'extra'])(
  'refuses reconstruction mutation %s',
  async (mode) => {
    if (mode === 'nonce') plan.transaction.nonce++;
    if (mode === 'hash') plan.hash = '0x' + 'f'.repeat(64);
    if (mode === 'source') plan.profileBinding = 'c'.repeat(64);
    if (mode === 'destination') plan.destinationSha256 = 'c'.repeat(64);
    if (mode === 'extra') plan.transaction.extra = true;
    await expect(resignFundingPlan(wallet, plan, expected)).rejects.toThrow();
  }
);
test('incorrect signer output is refused before any network handoff', async () => {
  const signer = {
    getAddress: () => wallet.getAddress(),
    signTransaction: () => wallet.signTransaction({ ...tx, nonce: 7 }),
  };
  await expect(resignFundingPlan(signer, plan, expected)).rejects.toThrow();
  expect(Transaction.from(raw).hash).toBe(plan.hash);
  expect(assertFundingPlan(plan, expected).nonce).toBe(6);
});
