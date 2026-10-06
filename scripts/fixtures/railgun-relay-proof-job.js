/** Actual serial proof producer; all keys below belong to published test vectors.
 * No credential, storage or network broker. Only public proof/calldata leaves. */
const assert = require('assert/strict');
const path = require('path');
const { prepareRelayVector, encodeTransaction, hex } = require('./railgun-relay-proof-data');
let attempted = false;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'artifactDirectory',
    'minGasPrice',
    'proverArchive',
  ]);
  assert.ok(input.minGasPrice === 0 || input.minGasPrice === 1);
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const serial = require('../../src/main/wallet/railgun-prover-runtime').loadRailgunProverRuntime(
    input.proverArchive
  );
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { Prover } = require(path.join(engine, 'prover/prover'));
  const debug = require(path.join(engine, 'debugger/debugger')).default;
  assert.equal(debug.engineDebugger, undefined);
  const scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'public-relay-proof-fixture',
    signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-vector',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'artifacts',
  });
  const loaded = [];
  try {
    for (const variant of ['01x02', 'POI_3x3']) {
      loaded.push(
        await require('../../src/main/wallet/railgun-artifacts').loadRailgunArtifacts({
          handle,
          directory: input.artifactDirectory,
          variant,
        })
      );
      active();
    }
    const [transactionArtifacts, poiArtifacts] = loaded;
    const prover = new Prover({
      getArtifacts: async (pub) => {
        assert.equal(pub.nullifiers.length, 1);
        assert.equal(pub.commitmentsOut.length, 2);
        return transactionArtifacts;
      },
      getArtifactsPOI: async (i, o) => {
        assert.equal(i, 3);
        assert.equal(o, 3);
        return poiArtifacts;
      },
    });
    prover.setSnarkJSGroth16(serial);
    const vector = await prepareRelayVector(engine, input.minGasPrice);
    active();
    const tx = await vector.transaction.generateProvedTransaction(
      'V2_PoseidonMerkle',
      prover,
      vector.request,
      () => {}
    );
    active();
    const result = await prover.provePOI(
      vector.poiInputs,
      'public-fixture-list',
      [vector.blindedInput],
      vector.blindedOut,
      () => {}
    );
    active();
    const expected = prover.getPublicInputsPOI(
      vector.poiInputs.anyRailgunTxidMerklerootAfterTransaction,
      vector.blindedOut,
      vector.poiInputs.poiMerkleroots,
      '0x00',
      3,
      3
    );
    assert.deepEqual(result.publicInputs, expected);
    const trim = (p) => ({
      pi_a: p.pi_a.slice(0, 2).map(String),
      pi_b: p.pi_b.slice(0, 2).map((row) => row.slice(0, 2).map(String)),
      pi_c: p.pi_c.slice(0, 2).map(String),
    });
    const raw = {
      domain: 'public-fixture-relay-pre-poi-v1',
      minGasPrice: input.minGasPrice,
      transaction: encodeTransaction(tx),
      poi: {
        proof: trim(result.proof),
        txidMerkleroot: hex(
          BigInt('0x' + vector.poiInputs.anyRailgunTxidMerklerootAfterTransaction)
        ),
        poiMerkleroots: vector.poiInputs.poiMerkleroots.map((v) => hex(BigInt('0x' + v))),
        blindedCommitmentsOut: vector.blindedOut,
        railgunTxidIfHasUnshield: '0x00',
      },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= 32768);
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.equal(debug.engineDebugger, undefined);
    assert.equal(globalThis.curve_bn128, null);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({ id: 1, method: 'result', value: { publicCase: raw, guards } })
        )
      ),
      { id: 1, value: null }
    );
  } finally {
    for (const a of loaded) {
      a.wasm.fill(0);
      a.zkey.fill(0);
    }
    scope.close();
  }
};
