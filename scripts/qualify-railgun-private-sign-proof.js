/** Offline Electron qualification of real SDK preparation, the separate binary
 * key signer, real 1x1 proofs and a fresh witness-free verifier. Public synthetic
 * fixtures only. Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIR
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function main() {
  const [archive, proverArchive, artifactDirectory, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  for (const p of [archive, proverArchive, artifactDirectory, directory])
    assert.ok(path.isAbsolute(p));
  assert.ok(!fs.existsSync(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  require('../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  await require(path.join(engine, 'utils/poseidon')).initPoseidonPromise;
  const fixtureKey = new Uint8Array(32).fill(7);
  const spendingPublicKey = require(path.join(engine, 'utils/keys-utils'))
    .getPublicSpendingKey(fixtureKey)
    .map(hex);
  fixtureKey.fill(0);
  const sourceFiles = [
    'scripts/qualify-railgun-private-sign-proof.js',
    'scripts/fixtures/railgun-private-sign-proof-job.js',
    'src/main/wallet/railgun-spend-sign-job.js',
    'src/main/wallet/railgun-private-verify-job.js',
    'src/main/wallet/railgun-private-prover.js',
    'src/main/wallet/railgun-private-intent.js',
    'src/main/wallet/railgun-private-results.js',
    'src/main/wallet/railgun-private-signature.js',
    'src/main/wallet/railgun-private-policy.js',
    'src/main/wallet/railgun-shield-pins.json',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/wallet/railgun-prover-runtime.js',
    'src/main/wallet/railgun-prover-manifest.json',
    'src/main/wallet/railgun-artifacts.js',
    'src/main/wallet/privacy-artifacts.js',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      sourceFiles.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'synthetic-railgun-split-sign-proof',
    signal: new AbortController().signal,
  });
  const context = (role, operation) =>
    scope.getContext({
      kind: 'private-account',
      principal: 'synthetic',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role,
      operation,
    });
  const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
  const {
    validateRailgunPrivateSigningIntent,
    matchRailgunPrivateProvedTransaction,
  } = require('../src/main/wallet/railgun-private-intent');
  const {
    normalizeRailgunSpendSignature,
    normalizeRailgunPrivateVerification,
  } = require('../src/main/wallet/railgun-private-results');
  const tasks = new Set(),
    signatures = [],
    runs = [],
    refused = [];
  let captured;
  async function sign(payload, refusal) {
    let sequence = 0,
      value,
      key;
    const start = performance.now();
    const task = startRailgunProcess({
      handle: context('keystore', 'spending-sign'),
      filename: require.resolve('../src/main/wallet/railgun-spend-sign-job'),
      input: JSON.stringify(payload),
      binaryKey: true,
      startupMs: 30000,
      lifetimeMs: 60000,
      heapMb: 128,
      rssMb: 512,
      broker: {
        signal: scope.signal,
        dispatch: async (wire) => {
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          if (message.id === 1) {
            assert.deepEqual(message, { id: 1, method: 'key', purpose: 'spending-sign' });
            key = new Uint8Array(32).fill(7);
            return key;
          }
          assert.equal(message.id, 2);
          assert.equal(message.method, 'result');
          value = message.value;
          return JSON.stringify({ id: 2, value: null });
        },
      },
    });
    tasks.add(task);
    try {
      if (refusal) await assert.rejects(task.ready);
      else await task.ready;
      task.close();
      const closed = await task.closed;
      if (key) assert.ok(key.every((n) => n === 0));
      if (refusal) {
        assert.equal(value, undefined);
        assert.equal(sequence, refusal.afterKey ? 1 : 0);
        refused.push({
          case: refusal.name,
          refused: true,
          keyTransfers: sequence,
          keyWiped: !!key,
          closed,
        });
        return;
      }
      assert.equal(sequence, 2);
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(value.guards.attempts, 0);
      assert.equal(
        value.inventory,
        require('../src/main/wallet/railgun-engine-manifest.json').inventory.sha256
      );
      assert.equal(value.message, payload.expectedHash);
      assert.equal(
        value.transactionDigest,
        validateRailgunPrivateSigningIntent(payload.transaction, payload.expected).digest
      );
      signatures.push({
        keyTransfers: 1,
        keyWiped: true,
        guards: value.guards,
        elapsedMs: Math.round(performance.now() - start),
        closed,
      });
      return normalizeRailgunSpendSignature(value, payload).signature;
    } finally {
      task.close();
      await task.closed;
      tasks.delete(task);
    }
  }
  async function verify(value, reject = false) {
    let result;
    const task = startRailgunProcess({
      handle: context('prover', 'private-verify'),
      filename: require.resolve('../src/main/wallet/railgun-private-verify-job'),
      input: JSON.stringify({
        archive: proverArchive,
        artifactDirectory,
        intent: value.intent,
        transaction: value.finalTransaction,
        expected: value.expected,
      }),
      startupMs: 30000,
      lifetimeMs: 60000,
      broker: {
        signal: scope.signal,
        dispatch: async (wire) => {
          const message = JSON.parse(wire);
          assert.equal(result, undefined);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          result = message.value;
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    tasks.add(task);
    try {
      if (reject) await assert.rejects(task.ready);
      else await task.ready;
      task.close();
      const closed = await task.closed;
      if (reject) {
        assert.equal(result, undefined);
        return { refused: true, closed };
      }
      assert.equal(result.verified, true);
      assert.equal(result.guards.attempts, 0);
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(
        result.transactionDigest,
        matchRailgunPrivateProvedTransaction(value.intent, value.finalTransaction, value.expected)
          .digest
      );
      normalizeRailgunPrivateVerification(result, {
        intent: value.intent,
        transaction: value.finalTransaction,
        expected: value.expected,
      });
      return { verified: true, guards: result.guards, closed };
    } finally {
      task.close();
      await task.closed;
      tasks.delete(task);
    }
  }
  try {
    for (const kind of ['transfer', 'unshield']) {
      let sequence = 0,
        result;
      const start = performance.now();
      const task = startRailgunProcess({
        handle: context('engine', 'synthetic-prepare'),
        filename: require.resolve('./fixtures/railgun-private-sign-proof-job'),
        input: JSON.stringify({
          archive,
          proverArchive,
          artifactDirectory,
          kind,
          spendingPublicKey,
        }),
        startupMs: 120000,
        lifetimeMs: 180000,
        heapMb: 256,
        rssMb: 768,
        broker: {
          signal: scope.signal,
          dispatch: async (wire) => {
            const message = JSON.parse(wire);
            assert.equal(message.id, ++sequence);
            if (message.id < 3) {
              assert.equal(message.method, 'sign');
              captured = structuredClone(message.value);
              return JSON.stringify({ id: message.id, value: await sign(message.value) });
            }
            assert.equal(message.id, 3);
            assert.equal(message.method, 'result');
            result = message.value;
            return JSON.stringify({ id: 3, value: null });
          },
        },
      });
      tasks.add(task);
      await task.ready;
      task.close();
      const closed = await task.closed;
      tasks.delete(task);
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(sequence, 3);
      assert.equal(result.verified, true);
      assert.equal(result.wrongMessageSignatureRefused, true);
      assert.equal(result.wrongSignatureRefusedBeforeProving, true);
      assert.equal(result.guards.attempts, 0);
      const independent = await verify(result);
      const zeroProofRefused = await verify({ ...result, finalTransaction: result.intent }, true);
      runs.push({
        kind,
        verified: true,
        wrongMessageSignatureRefused: true,
        wrongSignatureRefusedBeforeProving: true,
        zeroProofRefused,
        independent,
        guards: result.guards,
        proofElapsedMs: result.proofElapsedMs,
        elapsedMs: Math.round(performance.now() - start),
        closed,
      });
      console.log(JSON.stringify({ kind, verified: true, elapsedMs: runs.at(-1).elapsedMs }));
    }
    const badHash = structuredClone(captured);
    badHash.expectedHash = hex(0n);
    await sign(badHash, { name: 'wrong-message-before-key' });
    const badKey = structuredClone(captured);
    badKey.spendingPublicKey[0] = hex(0n);
    await sign(badKey, { name: 'wrong-spending-public-key', afterKey: true });
    const badChain = structuredClone(captured);
    badChain.transaction.chainId = 1;
    await sign(badChain, { name: 'wrong-chain-before-key' });
    assert.deepEqual(hashes(), sourceSha256);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          syntheticNotes: true,
          accountsOpened: 0,
          preparationReceivedSpendingPrivateKey: false,
          networkRequests: 0,
          poiRequests: 0,
          reservationsQualified: false,
          ownedInputsQualified: false,
          submissions: 0,
          engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
          proverSha256: require('../src/main/wallet/railgun-prover-manifest.json').sha256,
          signatures,
          runs,
          refused,
          passed: true,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    for (const task of tasks) task.close();
    await Promise.all([...tasks].map((task) => task.closed));
    scope.close();
  }
}
main().then(
  () => app.exit(0),
  (e) => {
    console.error(e.stack);
    app.exit(1);
  }
);
