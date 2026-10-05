/** Disposable post-submission chain/service answers below genuine retained
 * clients. Original input eligibility remains the existing signed fixture list;
 * change membership requires the separate disposable proof-verifying service. */
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const copy = (v) => JSON.parse(JSON.stringify(v));
const quantity = (v) => '0x' + BigInt(v).toString(16);
const field = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
const query =
  'query RailgunPublicTxids($after: String!) { transactions(orderBy: id_ASC, limit: 100, where: { id_gt: $after }) { id nullifiers commitments transactionHash boundParamsHash blockNumber utxoTreeIn utxoTreeOut utxoBatchStartPositionOut hasUnshield unshieldToken { tokenType tokenSubID tokenAddress } unshieldToAddress unshieldValue blockTimestamp verificationHash } }';
function graph(row) {
  const u = row.unshield;
  return {
    id: row.graphID,
    nullifiers: row.nullifiers,
    commitments: row.commitments,
    transactionHash: '0x' + row.txid,
    boundParamsHash: row.boundParamsHash,
    blockNumber: String(row.blockNumber),
    utxoTreeIn: String(row.utxoTreeIn),
    utxoTreeOut: String(row.utxoTreeOut),
    utxoBatchStartPositionOut: String(row.utxoBatchStartPositionOut),
    hasUnshield: !!u,
    unshieldToken: {
      tokenType: 'ERC20',
      tokenSubID: u?.tokenData.tokenSubID ?? field(0),
      tokenAddress: u?.tokenData.tokenAddress ?? '0x' + '0'.repeat(40),
    },
    unshieldToAddress: u?.toAddress ?? '0x' + '0'.repeat(40),
    unshieldValue: u?.value ?? '0',
    blockTimestamp: String(row.timestamp),
    verificationHash: row.verificationHash,
  };
}
// Shared fixture-only wire encoding: both projection and service use it.
exports.graph = graph;
exports.create = ({
  source,
  receipt,
  rows,
  state,
  checkpoints,
  finalized,
  header,
  accountIndex,
}) => {
  const {
    normalizeTxidPage,
    POI_URL,
    INDEXER_URL,
  } = require('../../src/main/wallet/railgun-public-services');
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  assert.ok(Array.isArray(checkpoints));
  assert.equal(checkpoints.length, rows.length);
  const knownCheckpoints = copy(checkpoints);
  knownCheckpoints.forEach((checkpoint, index) => {
    assert.equal(checkpoint.count, index + 1);
    assert.equal(checkpoint.after, rows[index].graphID);
    assert.match(checkpoint.root, /^[0-9a-f]{64}$/);
  });
  assert.deepEqual(knownCheckpoints.at(-1), state);
  const graphs = rows.map(graph);
  assert.equal(
    JSON.stringify(normalizeTxidPage(graphs, '0x00').transactions),
    JSON.stringify(rows)
  );
  const actualLogs = receipt.logs.filter(
    (log) => log.address.toLowerCase() === pins.proxy.toLowerCase()
  );
  assert.equal(actualLogs.length, 3);
  const logs = [
    ...source.logs.map((log) => ({
      ...log,
      blockNumber: quantity(log.blockNumber),
      transactionIndex: quantity(log.transactionIndex),
      logIndex: quantity(log.logIndex),
    })),
    ...actualLogs,
  ];
  const counts = { attempted: {}, validated: {}, posts: 0, postBytes: 0 };
  let payload,
    attempted,
    postGate,
    acceptance,
    postsAllowed = false;
  const changeHandles = new WeakSet();
  const key = (subject, wire) => subject.kind + ':' + subject.role + ':' + (wire.method ?? 'page');
  const add = (name, k) => {
    counts[name][k] = (counts[name][k] || 0) + 1;
  };
  const response = (wire, result) => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
  });
  return Object.freeze({
    // Private fixture facts for later second-spend continuation, never report.
    continuation: Object.freeze({
      logs: copy(actualLogs),
      rows: copy(rows),
      receipt: copy(receipt),
    }),
    bindProof(value) {
      assert.equal(payload, undefined);
      payload = copy(value);
    },
    bindChangeAcceptance(value) {
      assert.equal(acceptance, undefined);
      assert.ok(
        payload &&
          value &&
          typeof value.acceptPost === 'function' &&
          typeof value.answer === 'function'
      );
      assert.deepEqual(value.report(), {
        ...value.report(),
        accepted: false,
        postCalls: 0,
        verifierExits: 0,
        bindingExits: 0,
        signedEvents: 0,
      });
      acceptance = value;
    },
    allowPost(readAttempt, gate) {
      assert.equal(postsAllowed, false);
      attempted = readAttempt;
      postGate = gate;
      postsAllowed = true;
    },
    disablePost() {
      postsAllowed = false;
      attempted = postGate = undefined;
    },
    report: () => copy(counts),
    async route(subject, url, options, handle) {
      const started = performance.now();
      const wire = JSON.parse(options.body);
      const publicService =
        subject.kind === 'service' && subject.principal === 'railgun-public-sync';
      const scan = subject.role === 'protocol-rpc' && subject.operation === null;
      const post = wire.method === 'ppoi_submit_transact_proof';
      const roots =
        subject.kind === 'private-account' &&
        payload &&
        (wire.method === 'ppoi_validate_txid_merkleroot' ||
          (wire.method === 'ppoi_validate_poi_merkleroots' &&
            wire.params?.poiMerkleroots?.[0] === payload.poiMerkleroots[0]));
      const changeStatus =
        acceptance &&
        wire.method === 'ppoi_pois_per_list' &&
        wire.params?.blindedCommitmentDatas?.some(
          (note) => note.blindedCommitment === payload.blindedCommitmentsOut[0]
        );
      const changeQuery = changeStatus || (handle && changeHandles.has(handle));
      // An owned-list validate can equal the saved proof root. The same exact
      // root/schema assertions are valid; the other three owned-list methods
      // stay with the existing fixture's typed note + signature assertions.
      if (!publicService && !scan && !post && !roots && !changeQuery) return undefined;
      const k = key(subject, wire);
      add('attempted', k);
      assert.equal(options.method, 'POST');
      assert.equal(options.signal.aborted, false);
      assert.equal(subject.protocol, 'railgun');
      assert.equal(subject.deployment, 'sepolia');
      assert.equal(subject.chainId, 11155111);
      let result;
      if (changeQuery) {
        assert.ok(handle && typeof handle === 'object');
        assert.equal(subject.kind, 'private-account');
        assert.equal(subject.principal, 'railgun:' + accountIndex);
        assert.equal(subject.role, 'poi');
        assert.match(subject.operation, /^poi:[0-9a-f]{64}$/);
        assert.equal(url, POI_URL);
        assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
        assert.equal(wire.jsonrpc, '2.0');
        try {
          result = acceptance.answer(wire.method, wire.params);
        } catch (error) {
          sticky.record(error, 'change-list.answer');
          throw error;
        }
        if (changeStatus) changeHandles.add(handle);
      } else if (scan) {
        assert.equal(subject.kind, 'private-account');
        assert.equal(subject.principal, 'railgun:' + accountIndex);
        assert.equal(url, 'https://synthetic.invalid/railgun-partial-controller');
        assert.ok(Array.isArray(wire.params));
        if (wire.method === 'eth_chainId') {
          assert.deepEqual(wire.params, []);
          result = '0xaa36a7';
        } else if (wire.method === 'eth_getBlockByNumber') {
          assert.equal(wire.params.length, 2);
          assert.equal(wire.params[1], false);
          const n = wire.params[0] === 'finalized' ? finalized : Number(BigInt(wire.params[0]));
          assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= finalized);
          result = header(n);
        } else {
          assert.equal(wire.method, 'eth_getLogs');
          assert.equal(wire.params.length, 1);
          const filter = wire.params[0];
          assert.deepEqual(Object.keys(filter).sort(), ['address', 'fromBlock', 'toBlock']);
          assert.equal(filter.address.toLowerCase(), pins.proxy.toLowerCase());
          const from = Number(BigInt(filter.fromBlock)),
            to = Number(BigInt(filter.toBlock));
          assert.ok(from >= 0 && to >= from && to - from < 100000 && to <= finalized);
          result = logs.filter(
            (log) =>
              Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to
          );
        }
      } else if (publicService && subject.role === 'indexer') {
        assert.equal(subject.operation, null);
        assert.equal(url, INDEXER_URL);
        assert.deepEqual(Object.keys(wire).sort(), ['query', 'variables']);
        assert.equal(wire.query, query);
        assert.deepEqual(Object.keys(wire.variables), ['after']);
        assert.ok(['0x00', ...rows.map((row) => row.graphID)].includes(wire.variables.after));
        add('validated', k);
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              data: { transactions: graphs.filter((row) => row.id > wire.variables.after) },
            })
          ),
        };
      } else {
        assert.equal(subject.role, 'poi');
        assert.equal(url, POI_URL);
        assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
        assert.equal(wire.jsonrpc, '2.0');
        if (publicService) assert.equal(subject.operation, null);
        else {
          assert.equal(subject.kind, 'private-account');
          assert.equal(subject.principal, 'railgun:' + accountIndex);
          assert.match(subject.operation, /^poi:[0-9a-f]{64}$/);
        }
        if (wire.method === 'ppoi_validated_txid') {
          assert.ok(publicService);
          assert.deepEqual(wire.params, base);
          result = { validatedTxidIndex: rows.length - 1, validatedTxidMerkleroot: state.root };
        } else if (wire.method === 'ppoi_validate_txid_merkleroot') {
          // A reopened creator mirror validates its retained prefix before
          // advancing. Only the independently projected canonical prefixes
          // are accepted; private proof checks still require the full root.
          const checkpoint = (publicService ? knownCheckpoints : [state]).find(
            (value) => value.count - 1 === wire.params?.index
          );
          assert.ok(checkpoint);
          assert.deepEqual(wire.params, {
            ...base,
            tree: 0,
            index: checkpoint.count - 1,
            merkleroot: checkpoint.root,
          });
          if (!publicService) {
            assert.equal(payload.txidMerkleroot, state.root);
            assert.equal(payload.txidMerklerootIndex, rows.length - 1);
          }
          result = true;
        } else if (wire.method === 'ppoi_validate_poi_merkleroots') {
          assert.ok(payload);
          assert.deepEqual(wire.params, {
            ...base,
            listKey: payload.listKey,
            poiMerkleroots: payload.poiMerkleroots,
          });
          result = true;
        } else {
          assert.equal(wire.method, 'ppoi_submit_transact_proof');
          assert.equal(postsAllowed, true);
          assert.equal(options.maxResponseBytes, 2048);
          assert.equal(options.requireFramedResponse, true);
          const record = await attempted();
          assert.equal(record.state, 'attempted');
          const submission =
            require('../../src/main/wallet/railgun-poi-submit-data').prepareRailgunPoiSubmission({
              requestId: record.attempt.submission.requestId,
              payload: record.payload,
            });
          assert.equal(options.body, submission.body);
          assert.deepEqual(record.payload, payload);
          assert.equal(++counts.posts, 1);
          counts.postBytes = Buffer.byteLength(options.body);
          postGate?.entered();
          if (postGate) await postGate.wait;
          assert.equal(options.signal.aborted, false);
          if (acceptance) {
            assert.equal(options.timeoutMs, 10000);
            const left = Math.floor(options.timeoutMs - (performance.now() - started));
            assert.ok(left > 0);
            let reply;
            try {
              reply = await acceptance.acceptPost(options.body, {
                signal: options.signal,
                timeoutMs: left,
              });
            } catch (error) {
              sticky.record(error, 'change-list.acceptPost');
              throw error;
            }
            assert.equal(reply.status, 200);
            assert.ok(Buffer.isBuffer(reply.body) && reply.body.length <= 2048);
            const parsed = JSON.parse(reply.body.toString());
            assert.deepEqual(parsed, { jsonrpc: '2.0', id: wire.id, result: true });
            assert.deepEqual(acceptance.report(), {
              ...acceptance.report(),
              accepted: true,
              postCalls: 1,
              verifierExits: 1,
              bindingExits: 1,
              signedEvents: 1,
            });
            counts.acceptedPostElapsedMs = performance.now() - started;
            assert.ok(counts.acceptedPostElapsedMs < options.timeoutMs);
            add('validated', k);
            return reply;
          }
          result = null;
        }
      }
      add('validated', k);
      return response(wire, result);
    },
  });
};
