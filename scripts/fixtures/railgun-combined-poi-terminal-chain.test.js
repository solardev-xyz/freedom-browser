jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { create, graph } = require('./railgun-combined-poi-chain');
const { vector } = require('./railgun-combined-poi-terminal-test-data.fixture');
const { rowFromSecond } = require('./railgun-combined-poi-terminal-data');
const {
  normalizeTxidPage,
  POI_URL,
  INDEXER_URL,
} = require('../../src/main/wallet/railgun-public-services');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
let chain, old, next, subject, payload;
const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
const ask = async (method, params, who = subject) =>
  JSON.parse(
    (
      await chain.route(
        who,
        POI_URL,
        {
          method: 'POST',
          signal: new AbortController().signal,
          body: JSON.stringify({ id: '1', jsonrpc: '2.0', method, params }),
        },
        {}
      )
    ).body
  ).result;
beforeEach(() => {
  const v = vector();
  const rows = normalizeTxidPage([graph(v.first.ownEvidence.row)], '0x00').transactions;
  const state = {
    count: 1,
    root: hex(41).slice(2),
    after: rows[0].graphID,
    transcript: hex(51).slice(2),
  };
  chain = create({
    source: { logs: [] },
    receipt: v.first.ownEvidence.receipt,
    rows,
    state,
    checkpoints: [state],
    finalized: 300,
    header: v.header,
    accountIndex: 0,
  });
  old = chain.inspectHistory();
  const { row } = rowFromSecond(v.second, v.first, v.header);
  const all = normalizeTxidPage(
    [...rows.map(graph), graph({ ...row, verificationHash: hex(66) })],
    '0x00'
  ).transactions;
  const final = {
    count: 2,
    root: hex(42).slice(2),
    after: all[1].graphID,
    transcript: hex(52).slice(2),
  };
  next = {
    receipt: v.second.receipt,
    rows: all,
    state: final,
    checkpoints: [state, final],
    finalized: 321,
  };
  payload = {
    txidMerkleroot: state.root,
    txidMerklerootIndex: 0,
    poiMerkleroots: [hex(1).slice(2)],
  };
  chain.bindProof(payload);
  subject = {
    kind: 'service',
    principal: 'railgun-public-sync',
    role: 'poi',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    operation: null,
  };
});
test('one atomic append preserves old continuation and both known roots, private proof remains old', async () => {
  const continuation = copy(chain.continuation);
  chain.appendFinalizedUnshield(next);
  expect(chain.continuation).toEqual(continuation);
  expect(await ask('ppoi_validated_txid', base)).toEqual({
    validatedTxidIndex: 1,
    validatedTxidMerkleroot: next.state.root,
  });
  for (const [index, state] of old.checkpoints.concat(next.state).entries())
    expect(
      await ask('ppoi_validate_txid_merkleroot', {
        ...base,
        tree: 0,
        index,
        merkleroot: state.root,
      })
    ).toBe(true);
  const privateSubject = {
    ...subject,
    kind: 'private-account',
    principal: 'railgun:0',
    operation: 'poi:' + 'a'.repeat(64),
  };
  expect(
    await ask(
      'ppoi_validate_txid_merkleroot',
      { ...base, tree: 0, index: 0, merkleroot: old.state.root },
      privateSubject
    )
  ).toBe(true);
  await expect(
    ask(
      'ppoi_validate_txid_merkleroot',
      { ...base, tree: 0, index: 1, merkleroot: next.state.root },
      privateSubject
    )
  ).rejects.toThrow();
  expect(() => chain.appendFinalizedUnshield(next)).toThrow();
});
test.each([
  [
    'changed prior row',
    (n) => {
      n.rows[0].timestamp++;
    },
  ],
  [
    'changed prior transcript',
    (n) => {
      n.checkpoints[0] = { ...n.checkpoints[0], transcript: '0'.repeat(64) };
    },
  ],
  [
    'rewritten prefix key order',
    (n) => {
      const { version, ...rest } = n.rows[0];
      n.rows[0] = { ...rest, version };
    },
  ],
  [
    'wrong graph slot',
    (n) => {
      n.rows[1].graphID = n.rows[1].graphID.slice(0, -1) + '1';
      n.state.after = n.rows[1].graphID;
    },
  ],
  [
    'ordinary output coordinates',
    (n) => {
      n.rows[1].utxoTreeOut = 0;
      n.rows[1].utxoBatchStartPositionOut = 2;
    },
  ],
  [
    'wrong nullifier',
    (n) => {
      n.rows[1].nullifiers = [hex(555)];
    },
  ],
  [
    'reused nullifier',
    (n) => {
      n.rows[1].nullifiers = n.rows[0].nullifiers;
    },
  ],
  [
    'spurious Transact log',
    (n) => {
      n.receipt.logs.push(copy(chain.continuation.logs.at(-1)));
    },
  ],
  [
    'missing fee transfer',
    (n) => {
      n.receipt.logs.splice(2, 1);
    },
  ],
  [
    'different final state',
    (n) => {
      n.state = { ...n.state, count: 5 };
    },
  ],
  [
    'unfinalized row',
    (n) => {
      n.finalized = 310;
    },
  ],
])('rejects %s without changing retained head', async (_name, mutate) => {
  const changed = copy(next);
  mutate(changed);
  expect(() => chain.appendFinalizedUnshield(changed)).toThrow();
  expect(chain.inspectHistory()).toEqual(old);
  // A failed append does not burn the valid fixture continuation.
  chain.appendFinalizedUnshield(next);
  expect(chain.inspectHistory().state).toEqual(next.state);
});
test('new source page retains first events and adds only original second Nullified/Unshield metadata', async () => {
  chain.appendFinalizedUnshield(next);
  const who = { ...subject, kind: 'private-account', principal: 'railgun:0', role: 'protocol-rpc' };
  const read = async (from, to) =>
    JSON.parse(
      (
        await chain.route(
          who,
          'https://synthetic.invalid/railgun-partial-controller',
          {
            method: 'POST',
            signal: new AbortController().signal,
            body: JSON.stringify({
              id: '1',
              method: 'eth_getLogs',
              params: [
                {
                  address: pins.proxy,
                  fromBlock: '0x' + from.toString(16),
                  toBlock: '0x' + to.toString(16),
                },
              ],
            }),
          },
          {}
        )
      ).body
    ).result;
  expect(await read(0, 300)).toEqual(chain.continuation.logs);
  expect(await read(301, 321)).toEqual([next.receipt.logs[0], next.receipt.logs[3]]);
});
test('existing cursor gets only terminal row; unknown cursor refuses', async () => {
  chain.appendFinalizedUnshield(next);
  const query =
    'query RailgunPublicTxids($after: String!) { transactions(orderBy: id_ASC, limit: 100, where: { id_gt: $after }) { id nullifiers commitments transactionHash boundParamsHash blockNumber utxoTreeIn utxoTreeOut utxoBatchStartPositionOut hasUnshield unshieldToken { tokenType tokenSubID tokenAddress } unshieldToAddress unshieldValue blockTimestamp verificationHash } }';
  const page = (after) =>
    chain.route(
      { ...subject, role: 'indexer' },
      INDEXER_URL,
      {
        method: 'POST',
        signal: new AbortController().signal,
        body: JSON.stringify({ query, variables: { after } }),
      },
      {}
    );
  expect(JSON.parse((await page(old.state.after)).body).data.transactions).toEqual([
    graph(next.rows[1]),
  ]);
  expect(JSON.parse((await page(next.state.after)).body).data.transactions).toEqual([]);
  await expect(page(hex(3))).rejects.toThrow();
});
