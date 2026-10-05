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
const { create } = require('./railgun-combined-poi-second-chain');
const { capsule } = require('./railgun-capsule-data');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { railgunTransactJournalIntent } = require('../../src/main/wallet/railgun-transact-intent');
const { inspectRailgunTransactReceipt } = require('../../src/main/wallet/railgun-transact-receipt');
const journal = require('../../src/main/wallet/private-submission-journal');
const sticky = require('./railgun-native-assertions');
const abi = new Interface([
  TRANSACT_ABI,
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
test('one distinct actual signed EOA attempt yields a production-matched full unshield receipt', async () => {
  await prepareSend();
  await request('eth_sendRawTransaction', [raw]);
  const evidence = route.evidence();
  expect(
    inspectRailgunTransactReceipt(signedRecord, evidence.transaction, evidence.receipt)
  ).toMatchObject({ status: 'matched', output: { kind: 'unshield', amount: '1000' } });
  expect(evidence.receipt.logs).toHaveLength(4);
  expect(route.report()).toMatchObject({ sends: 1, signatures: 1, journalBeforeSend: 1 });
  await expect(request('eth_sendRawTransaction', [raw])).rejects.toThrow();
});
test.each(['first input', 'old root'])(
  '%s cannot be configured for the second preflight',
  (name) => {
    if (name === 'first input') options.firstNullifier = options.selected.nullifier;
    else options.firstRoot = options.merkleRoot;
    expect(() => create(options)).toThrow();
  }
);
test.each(['nullifier', 'root', 'value', 'recipient', 'position'])(
  'stored %s drift refuses binding',
  (name) => {
    if (name === 'nullifier') stored.capsule.preparation.expected.nullifier = hex(20);
    if (name === 'root') stored.capsule.preparation.expected.merkleRoot = hex(20);
    if (name === 'value') stored.capsule.preparation.expected.amount = '999';
    if (name === 'recipient')
      stored.capsule.preparation.expected.recipient = '0x' + '22'.repeat(20);
    if (name === 'position') stored.capsule.selection.position++;
    expect(() => route.bindProved(stored)).toThrow();
  }
);
test('simulation before exact stored proof binding refuses', async () => {
  await expect(
    request('eth_estimateGas', [{ from: recipient, ...stored.provedTransaction }])
  ).rejects.toThrow();
  expect(route.report().sends).toBe(0);
});
test.each(['missing', 'changed first', 'wrong intent', 'wrong nonce', 'submitted early'])(
  'durable %s refuses before synthetic send',
  async (name) => {
    await prepareSend();
    let records = [first, signedRecord];
    if (name === 'missing') records = [first];
    if (name === 'changed first') records = [{ ...first, nonce: 10 }, signedRecord];
    if (name === 'wrong intent') records = [first, { ...signedRecord, intent: {} }];
    if (name === 'wrong nonce')
      records = [first, { ...signedRecord, nonce: signedRecord.nonce + 1 }];
    if (name === 'submitted early') records = [first, { ...signedRecord, state: 'submitted' }];
    journal.getPrivateSubmissionJournal.mockReturnValue({ list: async () => records });
    await expect(request('eth_sendRawTransaction', [raw])).rejects.toThrow();
    expect(route.report().sends).toBe(0);
    expect(sticky.record).toHaveBeenCalled();
  }
);
test('close during held journal read prevents synthetic send', async () => {
  await prepareSend();
  let resolve;
  journal.getPrivateSubmissionJournal.mockReturnValue({
    list: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const work = request('eth_sendRawTransaction', [raw]);
  route.close();
  resolve([first, signedRecord]);
  await expect(work).rejects.toThrow();
  expect(route.report().sends).toBe(0);
});
test('unrelated source and POI work delegates unchanged', async () => {
  expect(await request('ppoi_validated_txid', {}, { role: 'poi' })).toBeUndefined();
  expect(
    await request('eth_getLogs', [], { role: 'protocol-rpc', operation: null })
  ).toBeUndefined();
  expect(route.report().attempted).toEqual({});
});
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
test.each(['rootHistory', 'nullifiers'])(
  '%s admits only fresh selected change facts',
  async (method) => {
    const { who, block } = await anchor();
    const value = method === 'rootHistory' ? options.merkleRoot : options.selected.nullifier;
    const to = stored.provedTransaction.to;
    await request(
      'eth_call',
      [{ to, data: abi.encodeFunctionData(method, [0, value]) }, block],
      who
    );
    await expect(
      request(
        'eth_call',
        [
          {
            to,
            data: abi.encodeFunctionData(method, [
              0,
              method === 'rootHistory' ? options.firstRoot : options.firstNullifier,
            ]),
          },
          block,
        ],
        who
      )
    ).rejects.toThrow();
  }
);
test('01x02 request cannot reuse first proof verifier', async () => {
  const { who, block } = await anchor();
  await expect(
    request(
      'eth_call',
      [
        {
          to: stored.provedTransaction.to,
          data: abi.encodeFunctionData('getVerificationKey', [1, 2]),
        },
        block,
      ],
      who
    )
  ).rejects.toThrow();
});

async function refreshFirst() {
  const {
    createSubmissionReconciler,
  } = require('../../src/main/wallet/private-submission-reconciler');
  const observe = jest.fn(async (hash, observation, revision) => {
    expect(hash).toBe(first.hash);
    expect(revision).toBe(first.revision);
    first = { ...first, observation, revision: revision + 1 };
    return first;
  });
  const rpc = {
    request: async (method, params, valid) => {
      const response = await request(method, params);
      const result = JSON.parse(response.body).result;
      expect(valid(result)).toBeTruthy();
      return { result };
    },
  };
  const reconciler = createSubmissionReconciler({
    rpc,
    journal: { list: async () => [first], observe },
    principal: recipient,
    assertActive() {},
  });
  await reconciler.refreshResolved();
  expect(observe).toHaveBeenCalledTimes(1);
  route.assertFirstRecord(first);
}
test('actual reconciler refreshes first anchor four times while preserving prior resolution', async () => {
  const original = JSON.parse(JSON.stringify(first));
  for (let i = 0; i < 4; i++) await refreshFirst();
  expect(first.revision).toBe(original.revision + 4);
  expect(first.observation.confirmations).toBe(33);
  expect(first.resolution).toEqual(original.resolution);
  expect(route.report().firstCanonicalRefreshReads).toBe(4);
  await prepareSend();
  await request('eth_sendRawTransaction', [raw]);
  expect(route.report().journalBeforeSend).toBe(1);
});
test.each(['receipt hash', 'receipt tx', 'observation height', 'resolution anchor'])(
  'first %s mismatch refuses construction',
  (fault) => {
    if (fault === 'receipt hash') options.firstReceipt.blockHash = hex(999);
    if (fault === 'receipt tx') options.firstReceipt.transactionHash = hex(999);
    if (fault === 'observation height') options.firstRecord.observation.blockNumber++;
    if (fault === 'resolution anchor') options.firstRecord.resolution.blockHash = hex(999);
    expect(() => create(options)).toThrow();
  }
);
test.each([
  'anchor',
  'intent',
  'resolution',
  'revision',
  'depth',
  'clock',
  'status',
  'extra field',
])('refreshed first %s drift refuses before second send', async (fault) => {
  await refreshFirst();
  if (fault === 'anchor') first.observation.blockHash = hex(999);
  if (fault === 'intent') first.intent = {};
  if (fault === 'resolution') first.resolution = null;
  if (fault === 'revision') first.revision++;
  if (fault === 'depth') first.observation.confirmations++;
  if (fault === 'clock') first.observation.observedAt--;
  if (fault === 'status') first.observation.status = 'reorged';
  if (fault === 'extra field') first.extra = true;
  expect(() => route.assertFirstRecord(first)).toThrow();
  await prepareSend();
  await expect(request('eth_sendRawTransaction', [raw])).rejects.toThrow();
  expect(route.report().sends).toBe(0);
});
test('only exact first inclusion is added to the second header route', async () => {
  const reply = await request('eth_getBlockByNumber', ['0x100', false]);
  expect(JSON.parse(reply.body).result).toMatchObject({
    number: '0x100',
    hash: options.firstReceipt.blockHash,
    transactions: [first.hash],
  });
  await expect(request('eth_getBlockByNumber', ['0x101', false])).rejects.toThrow();
  expect(route.report().firstCanonicalRefreshReads).toBe(1);
});
