const { Interface } = require('ethers');
const { transactionIntent } = require('./private-transaction-intent');
const { SHIELD_ABI } = require('./railgun-shield-policy');
const { SHIELD_EVENT, inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const pins = require('./railgun-shield-pins.json');
const prepared = require('../../../docs/qualification/railgun-shield-account-2026-10-03.json')
  .prepared[0];
const abi = new Interface([...SHIELD_ABI, SHIELD_EVENT]);
const hash = '0x' + 'a'.repeat(64),
  blockHash = '0x' + 'b'.repeat(64),
  owner = '0x' + 'c'.repeat(40);
function fixture(feeDelta = 0n) {
  const tx = {
    chainId: '0xaa36a7',
    from: owner,
    to: pins.relayAdapt,
    value: '0x' + BigInt(prepared.value).toString(16),
    input: prepared.data,
    hash,
    nonce: '0x0',
    blockHash,
    blockNumber: '0xb4911f',
  };
  const record = {
    hash,
    nonce: 0,
    intent: transactionIntent('railgun-native-shield', { ...tx, data: tx.input }),
  };
  const [, calls] = abi.decodeFunctionData('multicall', tx.input);
  const [requests] = abi.decodeFunctionData('shield', calls[1].data);
  const value = BigInt(prepared.noteValue) - feeDelta;
  const args = [
    0,
    123,
    [[prepared.npk, [0, pins.wrappedNative, 0], value]],
    [requests[0].ciphertext],
    [BigInt(prepared.value) - value],
  ];
  const encoded = abi.encodeEventLog('Shield', args);
  const log = {
    ...encoded,
    address: pins.proxy,
    transactionHash: hash,
    blockHash,
    blockNumber: tx.blockNumber,
    logIndex: '0x4',
    removed: false,
  };
  const receipt = {
    transactionHash: hash,
    from: owner,
    to: pins.relayAdapt,
    status: '0x1',
    blockHash,
    blockNumber: tx.blockNumber,
    logs: [log],
  };
  return { tx, record, receipt, log, args };
}
test.each([0n, 1n, -1n])('matches exact note and records actual fee deviation %s', (delta) => {
  const { tx, record, receipt } = fixture(delta);
  expect(inspectRailgunShieldReceipt(record, tx, receipt)).toMatchObject({
    status: 'matched',
    npk: prepared.npk,
    noteValue: (BigInt(prepared.noteValue) - delta).toString(),
    feeDeviation: delta !== 0n,
    spendingEnabled: false,
    trust: 'unverified-rpc',
  });
});
test.each([
  'missing',
  'duplicate',
  'emitter',
  'npk',
  'token',
  'value',
  'ciphertext',
  'trailing',
  'removed',
  'block',
  'hash',
  'nonce',
  'chain',
  'calldata',
  'status',
  'tree',
  'position',
  'sender',
])('rejects %s anomaly without a completion grant', (mode) => {
  const f = fixture();
  if (mode === 'missing') f.receipt.logs = [];
  if (mode === 'duplicate') f.receipt.logs.push({ ...f.log });
  if (mode === 'emitter') f.log.address = pins.relayAdapt;
  if (mode === 'npk') f.args[2][0][0] = blockHash;
  if (mode === 'token') f.args[2][0][1][1] = pins.proxy;
  if (mode === 'value') f.args[2][0][2] += 1n;
  if (mode === 'ciphertext')
    f.args[3] = [
      [['0x' + '1'.repeat(64), '0x' + '2'.repeat(64), '0x' + '3'.repeat(64)], blockHash],
    ];
  if (mode === 'tree') f.args[0] = 65536;
  if (mode === 'position') f.args[1] = 65536;
  if (['npk', 'token', 'value', 'ciphertext', 'tree', 'position'].includes(mode))
    Object.assign(f.log, abi.encodeEventLog('Shield', f.args));
  if (mode === 'trailing') f.log.data += '00';
  if (mode === 'removed') f.log.removed = true;
  if (mode === 'block') f.log.blockHash = hash;
  if (mode === 'hash') f.receipt.transactionHash = blockHash;
  if (mode === 'nonce') f.tx.nonce = '0x1';
  if (mode === 'chain') f.tx.chainId = '0x1';
  if (mode === 'calldata') f.tx.input += '00';
  if (mode === 'status') f.receipt.status = '0x0';
  if (mode === 'sender') f.receipt.from = pins.proxy;
  expect(inspectRailgunShieldReceipt(f.record, f.tx, f.receipt)).toMatchObject({
    status: 'anomaly',
    spendingEnabled: false,
  });
});

test('the independently captured Sepolia Shield payload decodes with the pinned tuple layout', () => {
  const report = require('../../../docs/qualification/railgun-sepolia-governance-2026-10-03.json');
  const log = report.logs.find(
    (v) =>
      v.transactionHash === '0x96cc3fc506d3547ca2da23021ec2e0709bcb1bf9a277b28cac4843342812c97f' &&
      v.logIndex === 176
  );
  expect(log.topics).toEqual([
    '0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b',
  ]);
  const args = abi.decodeEventLog('Shield', log.data, log.topics);
  expect(args.treeNumber).toBe(0n);
  expect(args.startPosition).toBe(10194n);
  expect(args.commitments[0].npk).toBe(
    '0x1f950a2ad9f344a03960719e9818a287c7ec0ee8f6c6c975519a6e019b8747a9'
  );
  expect(args.commitments[0].token.tokenAddress.toLowerCase()).toBe(pins.wrappedNative);
  expect(args.commitments[0].value).toBe(1002506265664160401n);
  expect(args.fees[0]).toBe(2512547031739750n);
  expect(args.shieldCiphertext[0].shieldKey).toBe(
    '0x3b6654addb6a525e5c620934416c8f7c0e4ccd5d409dd651b01672ae4c9c547a'
  );
  expect(abi.encodeEventLog('Shield', args).data).toBe(log.data);
});
