// Structural fixture/RPC assertions with real ABI/signature/journal-intent and
// receipt normalizers. Artifact/deployment and journal authority are mocked;
// these tests do not qualify a spend proof or real enrollment.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  record: jest.fn(),
}));
jest.mock('./railgun-shield-offline-deployment', () => ({
  createOfflineShieldDeployment: () => ({
    request: () => ({ number: '0x1', hash: '0x' + 'a'.repeat(64) }),
  }),
}));
jest.mock('../../src/main/wallet/railgun-artifacts', () => ({ manifest: { '01x01': [] } }));
jest.mock('../../src/main/wallet/private-submission-journal', () => ({
  getPrivateSubmissionJournal: jest.fn(),
}));
const fs = require('fs');
const { createHash } = require('crypto');
const { Wallet, Interface } = require('ethers');
const { create, createCold, createColdLost } = require('./railgun-combined-poi-second-chain');
const { capsule } = require('./railgun-capsule-data');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { railgunTransactJournalIntent } = require('../../src/main/wallet/railgun-transact-intent');
const { inspectRailgunTransactReceipt } = require('../../src/main/wallet/railgun-transact-receipt');
const journal = require('../../src/main/wallet/private-submission-journal');
const sticky = require('./railgun-native-assertions');
const abi = new Interface([
  TRANSACT_ABI,
  'function unshieldFee() view returns (uint120)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function getVerificationKey(uint256,uint256) view returns ((string artifactsIPFSHash,(uint256 x,uint256 y) alpha1,(uint256[2] x,uint256[2] y) beta2,(uint256[2] x,uint256[2] y) gamma2,(uint256[2] x,uint256[2] y) delta2,(uint256 x,uint256 y)[] ic))',
]);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const url = 'https://synthetic.invalid/railgun-partial-controller';
const wallet = Wallet.fromPhrase(
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
);
const recipient = wallet.address.toLowerCase();
const signal = new AbortController().signal;
let route, options, stored, first, subject, readSpy, raw, signedRecord;
const wire = (method, params) => ({ jsonrpc: '2.0', id: '1', method, params });
const request = (method, params, who = subject, extra = {}) =>
  route.route(
    who,
    url,
    { method: 'POST', signal, body: JSON.stringify(wire(method, params)), ...extra },
    {}
  );
beforeEach(() => {
  jest.clearAllMocks();
  const bytes = Buffer.from(
    JSON.stringify({
      vk_alpha_1: ['1', '2'],
      vk_beta_2: [
        ['3', '4'],
        ['5', '6'],
      ],
      vk_gamma_2: [
        ['3', '4'],
        ['5', '6'],
      ],
      vk_delta_2: [
        ['3', '4'],
        ['5', '6'],
      ],
      IC: [['1', '2']],
    })
  );
  require('../../src/main/wallet/railgun-artifacts').manifest['01x01'] = [
    {
      kind: 'vkey',
      name: 'unit.json',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  const originalRead = fs.readFileSync;
  readSpy = jest
    .spyOn(fs, 'readFileSync')
    .mockImplementation((file, ...args) =>
      file === '/unit/unit.json' ? bytes : originalRead(file, ...args)
    );
  const c = capsule('fixture', 3),
    inner = abi.decodeFunctionData('transact', c.preparation.transaction.data)[0][0].toArray(true);
  inner[5][0] = hex(BigInt(recipient));
  c.selection.recipient = recipient;
  c.preparation.recipient = recipient;
  c.preparation.expected.recipient = recipient;
  c.preparation.transaction.data = abi.encodeFunctionData('transact', [[inner]]);
  stored = { capsule: c, provedTransaction: { ...c.preparation.transaction } };
  first = {
    hash: hex(10),
    nonce: 0,
    state: 'submitted',
    revision: 4,
    intent: { operation: 'railgun-partial-unshield' },
    observation: {
      status: 'included',
      blockNumber: 256,
      blockHash: hex(1256),
      confirmations: 13,
      observedAt: Date.now() - 1000,
      trust: 'unverified',
    },
    resolution: {
      blockHash: hex(1256),
      minimumConfirmations: 3,
      reviewedAt: Date.now() - 1000,
      railgun: {},
    },
  };
  options = {
    bytecodes: '/unit/bytecodes',
    artifactDirectory: '/unit',
    accountIndex: 0,
    selected: { type: 'Transact', id: '0:3', hash: c.noteHash, txid: hex(11), nullifier: hex(3) },
    tree: 0,
    merkleRoot: hex(1),
    amount: 1000n,
    recipient,
    firstRecord: first,
    firstNullifier: hex(12),
    firstRoot: hex(13),
    firstReceipt: {
      blockNumber: '0x100',
      blockHash: hex(1256),
      transactionHash: first.hash,
      status: '0x1',
      from: recipient,
    },
  };
  route = create(options);
  subject = {
    kind: 'public-address',
    principal: recipient,
    chainId: 11155111,
    role: 'transaction-rpc',
    operation: null,
  };
});
afterEach(() => {
  readSpy.mockRestore();
});
async function prepareSend() {
  route.bindProved(stored);
  const tx = { ...stored.provedTransaction, nonce: 1, gasLimit: 1500000n, gasPrice: 100n };
  route.assertSigning(tx);
  raw = await wallet.signTransaction(tx);
  const { Transaction } = require('ethers');
  const signed = Transaction.from(raw);
  signedRecord = {
    hash: signed.hash.toLowerCase(),
    nonce: 1,
    state: 'attempted',
    intent: railgunTransactJournalIntent(signed),
  };
  journal.getPrivateSubmissionJournal.mockReturnValue({ list: async () => [first, signedRecord] });
}
async function anchor() {
  const who = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'protocol-rpc',
    operation: 'shield-preflight',
  };
  const reply = await request('eth_getBlockByNumber', ['latest', false], who);
  return {
    who: { ...who, operation: 'private-preflight' },
    block: { blockHash: JSON.parse(reply.body).result.hash, requireCanonical: true },
  };
}

async function preflight() {
  const { who, block } = await anchor();
  for (const [method, args] of [
    ['rootHistory', [0, options.merkleRoot]],
    ['nullifiers', [0, options.selected.nullifier]],
    ['getVerificationKey', [1, 1]],
    ['unshieldFee', []],
  ]) {
    await request(
      'eth_call',
      [{ to: stored.provedTransaction.to, data: abi.encodeFunctionData(method, args) }, block],
      who
    );
  }
}
test('cold route requires one fresh complete preflight before EOA signature', async () => {
  route = createCold(options);
  route.bindProved(stored);
  expect(() => route.assertSigning({ ...stored.provedTransaction, nonce: 1 })).toThrow();
  expect(route.report().signatures).toBe(0);
  await preflight();
  route.assertSigning({ ...stored.provedTransaction, nonce: 1 });
  expect(route.report().signatures).toBe(1);
  expect(() => route.assertKeyAdmission()).toThrow();
});
test('real signature and attempted nonce observed before sole cold send', async () => {
  route = createCold(options);
  await preflight();
  await prepareSend();
  await request('eth_sendRawTransaction', [raw]);
  expect(
    inspectRailgunTransactReceipt(
      signedRecord,
      route.evidence().transaction,
      route.evidence().receipt
    ).status
  ).toBe('matched');
  expect(route.report()).toMatchObject({ signatures: 1, sends: 1, journalBeforeSend: 1 });
  expect(route.isLostReply(new Error('Disposable second submission reply lost'))).toBe(false);
});
test('cold lost response still builds exact signed receipt; only its exact error is controlled', async () => {
  route = createColdLost(options);
  await preflight();
  await prepareSend();
  let error;
  try {
    await request('eth_sendRawTransaction', [raw]);
  } catch (value) {
    error = value;
  }
  expect(error).toBeInstanceOf(Error);
  expect(route.isLostReply(error)).toBe(true);
  expect(route.isLostReply(Object.assign(new Error(error.message), error))).toBe(false);
  expect(route.report()).toMatchObject({
    signatures: 1,
    sends: 1,
    journalBeforeSend: 1,
    controlledLostReplies: 1,
  });
  expect(route.report().attempted).toEqual(route.report().validated);
  expect(sticky.record).not.toHaveBeenCalled();
  expect(
    inspectRailgunTransactReceipt(
      signedRecord,
      route.evidence().transaction,
      route.evidence().receipt
    ).status
  ).toBe('matched');
  await expect(request('eth_sendRawTransaction', [raw])).rejects.toThrow();
  expect(sticky.record).toHaveBeenCalled();
  expect(route.report().sends).toBe(1);
});
test('wrong attempted nonce fails before loss or send, not a controlled transport outcome', async () => {
  route = createColdLost(options);
  await preflight();
  await prepareSend();
  signedRecord.nonce++;
  let error;
  try {
    await request('eth_sendRawTransaction', [raw]);
  } catch (value) {
    error = value;
  }
  expect(route.isLostReply(error)).toBe(false);
  expect(sticky.record).toHaveBeenCalled();
  expect(route.report().sends).toBe(0);
});
test('cold route accepts exactly three independently observed first record refreshes', async () => {
  route = createCold(options);
  for (let i = 0; i < 3; i++) {
    await request('eth_getBlockByNumber', ['0x100', false]);
    first = {
      ...first,
      revision: first.revision + 1,
      observation: { ...first.observation, confirmations: 33, observedAt: Date.now() },
    };
    route.assertFirstRecord(first);
  }
  expect(route.report().firstCanonicalRefreshReads).toBe(3);
  expect(() => route.assertFirstRecord({ ...first, revision: first.revision + 1 })).toThrow();
});
