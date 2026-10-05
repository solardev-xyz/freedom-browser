// Fixture transport controls only. List helper/cryptography are deliberately
// mocked here; native composition must run both actual keyless workers.
jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  record: jest.fn(),
}));
const { create } = require('./railgun-combined-poi-chain');
const sticky = require('./railgun-native-assertions');
const { normalizeTxidPage, POI_URL } = require('../../src/main/wallet/railgun-public-services');
const { graph } = require('./railgun-combined-poi-chain');
const { samplePartial } = require('./railgun-partial-own-txid-data');
const { prepareRailgunPoiSubmission } = require('../../src/main/wallet/railgun-poi-submit-data');
const { REQUIRED_LIST } = require('../../src/main/wallet/railgun-poi-records');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const bare = (n) => hex(n).slice(2);
const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
const signal = new AbortController().signal;
const subject = {
  kind: 'private-account',
  principal: 'railgun:0',
  protocol: 'railgun',
  deployment: 'sepolia',
  chainId: 11155111,
  role: 'poi',
  operation: 'poi:' + bare(1),
};
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
let chain, helper, accepted, counts, submission, payload, record, handle;
beforeEach(() => {
  jest.clearAllMocks();
  const own = samplePartial();
  const rows = normalizeTxidPage([graph(own.row)], '0x00').transactions;
  const state = { count: 1, after: rows[0].graphID, root: bare(10) };
  chain = create({
    source: { logs: [] },
    receipt: own.receipt,
    rows,
    state,
    checkpoints: [state],
    finalized: 999,
    header: () => {
      throw Error('no headers');
    },
    accountIndex: 0,
  });
  payload = {
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [bare(12)],
    txidMerkleroot: state.root,
    txidMerklerootIndex: 0,
    blindedCommitmentsOut: [hex(11)],
    railgunTxidIfHasUnshield: hex(13),
  };
  submission = prepareRailgunPoiSubmission({ payload, requestId: 1791086400000 });
  record = {
    state: 'attempted',
    payload: submission.payload,
    attempt: { submission: { requestId: 1791086400000 } },
  };
  accepted = false;
  counts = { postCalls: 0, verifierExits: 0, bindingExits: 0, signedEvents: 0 };
  helper = {
    report: () => ({ ...counts, accepted }),
    answer: jest.fn((method, params) => {
      if (method === 'ppoi_pois_per_list') {
        expect(params).toEqual({
          ...base,
          listKeys: [REQUIRED_LIST],
          blindedCommitmentDatas: [{ blindedCommitment: hex(11), type: 'Transact' }],
        });
        return { [hex(11)]: { [REQUIRED_LIST]: accepted ? 'Valid' : 'Missing' } };
      }
      if (!accepted) throw Error('not accepted');
      return [];
    }),
    acceptPost: jest.fn(async (body) => {
      expect(body).toBe(submission.body);
      counts = { postCalls: 1, verifierExits: 1, bindingExits: 1, signedEvents: 1 };
      accepted = true;
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1791086400000, result: true })),
      };
    }),
  };
  chain.bindProof(payload);
  chain.bindChangeAcceptance(helper);
  handle = {};
});
const options = (body) => ({
  method: 'POST',
  body,
  signal,
  timeoutMs: 10000,
  maxResponseBytes: 2048,
  requireFramedResponse: true,
});
const ask = (method, params = base, h = handle, s = subject) =>
  chain.route(s, POI_URL, options(JSON.stringify({ jsonrpc: '2.0', id: 'id', method, params })), h);
const statusParams = () => ({
  ...base,
  listKeys: [REQUIRED_LIST],
  blindedCommitmentDatas: [{ blindedCommitment: hex(11), type: 'Transact' }],
});
async function post(gate = { entered: () => {}, wait: Promise.resolve() }) {
  chain.allowPost(async () => record, gate);
  return chain.route(subject, POI_URL, options(submission.body), {});
}
test('Missing until fixed POST exact payload acceptance and both worker barriers complete', async () => {
  const gate = defer(),
    entered = defer(),
    accept = defer();
  const original = helper.acceptPost.getMockImplementation();
  helper.acceptPost.mockImplementation(async (body, opts) => {
    await accept.promise;
    return original(body, opts);
  });
  expect(
    JSON.parse((await ask('ppoi_pois_per_list', statusParams())).body).result[hex(11)][
      REQUIRED_LIST
    ]
  ).toBe('Missing');
  const work = post({ entered: entered.resolve, wait: gate.promise });
  await entered.promise;
  expect(helper.acceptPost).not.toHaveBeenCalled();
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(accepted).toBe(false);
  accept.resolve();
  expect(JSON.parse((await work).body).result).toBe(true);
  expect(helper.acceptPost).toHaveBeenCalledTimes(1);
  expect(helper.acceptPost.mock.calls[0][1].signal).toBe(signal);
  expect(helper.acceptPost.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
  expect(helper.acceptPost.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(10000);
  expect(
    JSON.parse((await ask('ppoi_pois_per_list', statusParams())).body).result[hex(11)][
      REQUIRED_LIST
    ]
  ).toBe('Valid');
  expect(chain.report().attempted).toEqual(chain.report().validated);
});
test('original input POI status stays with original fixture, not acceptance helper', async () => {
  const params = statusParams();
  params.blindedCommitmentDatas[0].blindedCommitment = hex(99);
  expect(await ask('ppoi_pois_per_list', params)).toBeUndefined();
  expect(helper.answer).not.toHaveBeenCalled();
});
test('subsequent change query is tied to exact previously admitted handle', async () => {
  await ask('ppoi_pois_per_list', statusParams());
  await expect(ask('ppoi_merkle_proofs', base)).rejects.toThrow('not accepted');
  expect(sticky.record).toHaveBeenCalledWith(expect.any(Error), 'change-list.answer');
  expect(await ask('ppoi_merkle_proofs', base, {})).toBeUndefined();
});
test('acceptance rejection stays sticky even if caller catches transport failure', async () => {
  helper.acceptPost.mockRejectedValue(Error('invalid binding'));
  await expect(post()).rejects.toThrow('invalid binding');
  expect(accepted).toBe(false);
  expect(sticky.record).toHaveBeenCalledWith(expect.any(Error), 'change-list.acceptPost');
  expect(chain.report().attempted).not.toEqual(chain.report().validated);
});
test('declared acceptance before both worker exits is refused', async () => {
  const original = helper.acceptPost.getMockImplementation();
  helper.acceptPost.mockImplementation(async (...args) => {
    const r = await original(...args);
    counts.bindingExits = 0;
    return r;
  });
  await expect(post()).rejects.toThrow();
});
test.each(['body', 'record', 'scope'])('rejects mismatched %s before acceptance', async (mode) => {
  let actualSubject = subject,
    body = submission.body;
  if (mode === 'body') body = body + ' ';
  if (mode === 'record') record.state = 'prepared';
  if (mode === 'scope') actualSubject = { ...subject, principal: 'railgun:1' };
  chain.allowPost(async () => record, { entered: () => {}, wait: Promise.resolve() });
  await expect(chain.route(actualSubject, POI_URL, options(body), {})).rejects.toThrow();
  expect(helper.acceptPost).not.toHaveBeenCalled();
});
