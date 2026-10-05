/** Wire tests use an actual signed public-vector payload; not main ownership. */
const assert = require('assert/strict');
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { Wallet, Transaction, Interface } = require('ethers');
const d = require('./railgun-public-cold-data');
const { transactionIntent } = require('../../src/main/wallet/private-transaction-intent');
const {
  inspectRailgunShieldReceipt,
  SHIELD_EVENT,
} = require('../../src/main/wallet/railgun-shield-receipt');
const prepared = require('../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
async function fixture() {
  const wallet = new Wallet('0x' + '01'.repeat(32));
  const tx = Transaction.from(
    await wallet.signTransaction({
      chainId: 11155111,
      to: pins.relayAdapt,
      value: prepared.value,
      data: prepared.data,
      nonce: 0,
      gasLimit: 500000,
      gasPrice: 100,
    })
  );
  const record = {
    hash: tx.hash,
    nonce: 0,
    state: 'attempted',
    intent: transactionIntent('railgun-native-shield', { from: wallet.address, ...tx.toJSON() }),
  };
  const chain = d.createChain({
    logs: [
      {
        address: pins.proxy,
        blockNumber: 2,
        blockHash: d.hash(3),
        transactionHash: d.hash(50),
        transactionIndex: 0,
        logIndex: 0,
        topics: [d.hash(1)],
        data: '0x',
      },
    ],
  });
  const checkpoint = {
    to: { number: 2, hash: d.hash(3) },
    state: { trees: [{ tree: 0, length: 7, root: d.hash(4) }] },
  };
  d.acceptSigned(chain, tx, record, checkpoint, '0x' + '12'.repeat(32));
  return { chain, record, tx };
}
test('actual signed acceptance uses total tree length, persists plain RPC without signature', async () => {
  const { chain, record } = await fixture();
  expect(chain.expected.position).toBe(7);
  expect(chain.transaction.nonce).toBe('0x0');
  expect(inspectRailgunShieldReceipt(record, chain.transaction, chain.receipt).status).toBe(
    'matched'
  );
  for (const key of ['raw', 'signature', 'r', 's', 'v', 'serialized'])
    expect(chain.transaction).not.toHaveProperty(key);
  expect(chain.headers[3].parentHash).toBe(chain.headers[2].hash);
  expect(chain.logs[1].blockNumber).toBeGreaterThan(chain.baselineTo);
});
test.each([
  'signature',
  'parent',
  'prior-log',
  'position',
  'sender',
  'ciphertext',
  'removed',
  'fee',
  'duplicate',
  'anchor',
  'unknown',
])('closed wire refuses %s mutation', async (mode) => {
  const { chain } = await fixture();
  const e = new Interface([SHIELD_EVENT]);
  if (mode === 'signature') chain.transaction.r = d.hash(7);
  if (mode === 'parent') chain.headers[3].parentHash = d.hash(9);
  if (mode === 'prior-log') chain.logs[0].blockHash = d.hash(8);
  if (mode === 'position') chain.expected.position = 0;
  if (mode === 'sender') chain.receipt.from = pins.proxy;
  if (mode === 'ciphertext' || mode === 'fee') {
    const args = e.decodeEventLog(
      'Shield',
      chain.receipt.logs[0].data,
      chain.receipt.logs[0].topics
    );
    const bundle = [...args.shieldCiphertext[0].encryptedBundle];
    if (mode === 'ciphertext') bundle[1] = d.hash(987);
    chain.receipt.logs[0].data = e.encodeEventLog('Shield', [
      args.treeNumber,
      args.startPosition,
      args.commitments,
      [[bundle, args.shieldCiphertext[0].shieldKey]],
      [args.fees[0] + (mode === 'fee' ? 1n : 0n)],
    ]).data;
    chain.logs[1].data = chain.receipt.logs[0].data;
  }
  if (mode === 'removed') chain.logs[1].removed = true;
  if (mode === 'duplicate') chain.receipt.logs.push(chain.receipt.logs[0]);
  if (mode === 'anchor') chain.finalized--;
  if (mode === 'unknown') chain.authority = true;
  expect(() => d.validateChain(chain)).toThrow();
});
test('removed baseline cannot be normalized away', () =>
  expect(() => d.sourceLog({ removed: true })).toThrow());
function credit(chain) {
  const e = chain.expected,
    id = '0:' + e.position,
    old = {
      id: '0:1',
      hash: d.hash(20),
      txid: d.hash(21),
      asset: { __type: 'erc20', contract: pins.wrappedNative },
      amount: 123n,
      spentTxid: false,
    };
  const note = {
    id,
    hash: e.commitment,
    txid: chain.transaction.hash,
    asset: { ...old.asset },
    amount: BigInt(e.noteValue),
    spentTxid: false,
  };
  const record = {
    id,
    type: 'Shield',
    npk: e.npk,
    hash: e.commitment,
    blockNumber: chain.baselineTo + 1,
  };
  const baseline = {
    notesSha256: d.receivedDigest({ read: { received: [old] }, ownedPoi: [] }),
    balanceSha256: d.digest('123'),
  };
  return {
    value: {
      read: { received: [old, note], readiness: { to: { number: chain.baselineTo + 1 } } },
      ownedPoi: [record],
      trees: [{ length: e.position + 1 }],
    },
    baseline,
  };
}
test('credit binds actual event and leaves unrelated balance intact', async () => {
  const { chain } = await fixture();
  const { value, baseline } = credit(chain);
  d.assertCredit(value, chain, baseline);
});
test.each([
  'new-value',
  'duplicate',
  'foreign-npk',
  'old-spent',
  'old-balance',
  'new-position',
  'new-hash',
  'tree',
  'checkpoint',
])('credit invariant distinguishes %s', async (mode) => {
  const { chain } = await fixture(),
    { value, baseline } = credit(chain);
  if (mode === 'new-value') value.read.received[1].amount++;
  if (mode === 'duplicate') value.read.received.push(value.read.received[1]);
  if (mode === 'foreign-npk') value.ownedPoi[0].npk = d.hash(15);
  if (mode === 'old-spent') value.read.received[0].spentTxid = d.hash(15);
  if (mode === 'old-balance') value.read.received[0].amount++;
  if (mode === 'new-position') value.read.received[1].id = '0:0';
  if (mode === 'new-hash') value.read.received[1].hash = d.hash(15);
  if (mode === 'tree') value.trees[0].length++;
  if (mode === 'checkpoint') value.read.readiness.to.number--;
  assert.throws(() => d.assertCredit(value, chain, baseline));
});
