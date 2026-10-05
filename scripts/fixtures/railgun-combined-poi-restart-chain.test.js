// Chain routing only. Signature/path verification uses separate actual-parser
// tests and the native POI worker; this mock creates no production authority.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  record: jest.fn(),
}));
jest.mock('./railgun-combined-poi-list-replay', () => ({ assertProvider: jest.fn((v) => v) }));
const { createReplay, graph } = require('./railgun-combined-poi-chain');
const { normalizeTxidPage, POI_URL } = require('../../src/main/wallet/railgun-public-services');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const field = (n) => BigInt(n).toString(16).padStart(64, '0');
let chain, provider, payload, subject, params, handle;
beforeEach(() => {
  const own = samplePartial(),
    rows = normalizeTxidPage([graph(own.row)], '0x00').transactions;
  const state = { count: 1, after: rows[0].graphID, root: field(8) };
  provider = { answer: jest.fn(() => ({ saved: 'wire' })) };
  chain = createReplay(
    {
      source: { logs: [] },
      receipt: own.receipt,
      rows,
      state,
      checkpoints: [state],
      finalized: 999,
      header: () => {},
      accountIndex: 0,
    },
    provider
  );
  payload = {
    listKey: REQUIRED_LIST,
    blindedCommitmentsOut: ['0x' + field(1)],
    poiMerkleroots: [field(2)],
    txidMerkleroot: field(8),
    txidMerklerootIndex: 0,
  };
  chain.bindProof(payload);
  handle = {};
  subject = {
    kind: 'private-account',
    principal: 'railgun:0',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'poi',
    operation: 'poi:' + field(3),
  };
  params = {
    chainType: '0',
    chainID: '11155111',
    txidVersion: 'V2_PoseidonMerkle',
    listKeys: [REQUIRED_LIST],
    blindedCommitmentDatas: [
      { blindedCommitment: payload.blindedCommitmentsOut[0], type: 'Transact' },
    ],
  };
});
const ask = (method, p = params, owner = subject, h = handle) =>
  chain.route(
    owner,
    POI_URL,
    {
      method: 'POST',
      signal: new AbortController().signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: p }),
    },
    h
  );
test('saved change answers require actual private account scope and retain per-handle routing', async () => {
  expect(JSON.parse((await ask('ppoi_pois_per_list')).body).result).toEqual({ saved: 'wire' });
  await ask('ppoi_merkle_proofs', { exact: 'second request' });
  expect(provider.answer).toHaveBeenCalledTimes(2);
  expect(chain.report().attempted).toEqual(chain.report().validated);
  expect(chain.report().posts).toBe(0);
});
test('replay cannot accept, enable, export or send a new POST', async () => {
  expect(() => chain.allowPost(() => {}, {})).toThrow();
  expect(() => chain.bindChangeAcceptance({})).toThrow();
  expect(() => chain.exportAcceptedBody()).toThrow();
  await expect(ask('ppoi_submit_transact_proof', {})).rejects.toThrow();
  expect(provider.answer).not.toHaveBeenCalled();
  expect(chain.report().posts).toBe(0);
});
test.each(['principal', 'protocol', 'chainId', 'operation'])(
  'wrong replay context %s refuses',
  async (key) => {
    const owner = { ...subject, [key]: key === 'chainId' ? 1 : 'wrong' };
    await expect(ask('ppoi_pois_per_list', params, owner)).rejects.toThrow();
    expect(provider.answer).not.toHaveBeenCalled();
  }
);
test('different blinded note does not get Valid from the saved wire provider', async () => {
  const different = {
    ...params,
    blindedCommitmentDatas: [{ type: 'Transact', blindedCommitment: '0x' + field(99) }],
  };
  expect(await ask('ppoi_pois_per_list', different)).toBeUndefined();
  expect(provider.answer).not.toHaveBeenCalled();
});
