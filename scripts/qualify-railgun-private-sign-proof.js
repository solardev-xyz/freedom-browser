/** Offline Electron qualification of real SDK preparation, the separate binary
 * key signer, real 1x1/1x2 proofs and a fresh witness-free verifier. Public synthetic
 * fixtures only. Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIR [partial]
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function main() {
  const [archive, proverArchive, artifactDirectory, directory, mode] = process.argv.slice(2);
  assert.ok(process.argv.length === 6 || (process.argv.length === 7 && mode === 'partial'));
  const kinds = mode === 'partial' ? ['partial'] : ['transfer', 'unshield'];
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
    'scripts/fixtures/railgun-private-recovery-job.js',
    'scripts/fixtures/railgun-reconstruction-controls.js',
    'src/main/wallet/privacy-storage.js',
    'src/main/wallet/railgun-spend-sign-job.js',
    'src/main/wallet/railgun-private-verify-job.js',
    'src/main/wallet/railgun-private-prover.js',
    'src/main/wallet/railgun-private-witness.js',
    'src/main/wallet/railgun-private-capsule.js',
    'src/main/wallet/railgun-private-reconstruct.js',
    'src/main/wallet/railgun-private-preparation.js',
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
    coldRecovery = [],
    refused = [];
  const dispatches = new Set();
  const track = (use) => (wire) => {
    const work = Promise.resolve().then(() => use(wire));
    dispatches.add(work);
    work.then(
      () => dispatches.delete(work),
      () => dispatches.delete(work)
    );
    return work;
  };
  let captured, storageKey;
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
        dispatch: track(async (wire) => {
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          if (message.id === 1) {
            if (refusal?.hostChange) message[refusal.hostChange] = hex(0n);
            require('../src/main/wallet/railgun-private-results').normalizeRailgunSpendKeyRequest(
              message,
              payload
            );
            key = new Uint8Array(32).fill(7);
            return key;
          }
          assert.equal(message.id, 2);
          assert.equal(message.method, 'result');
          value = message.value;
          return JSON.stringify({ id: 2, value: null });
        }),
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
        assert.equal(sequence, refusal.afterKey || refusal.hostChange ? 1 : 0);
        refused.push({
          case: refusal.name,
          refused: true,
          keyTransfers: key ? 1 : 0,
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
        validatedKeyRequestMatched: true,
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
        dispatch: track(async (wire) => {
          const message = JSON.parse(wire);
          assert.equal(result, undefined);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          result = message.value;
          return JSON.stringify({ id: 1, value: null });
        }),
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
    for (const kind of kinds) {
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
          dispatch: track(async (wire) => {
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
          }),
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
      assert.equal(result.publicCapsuleReconstructedWitness, true);
      assert.equal(result.productionWitnessUsed, kind === 'partial');
      assert.equal(result.artifactVariant, kind === 'partial' ? '01x02' : '01x01');
      assert.equal(result.publicSignalCount, kind === 'partial' ? 5 : 4);
      assert.equal(result.oneUseProverRefused, true);
      assert.equal(result.legacyArtifactBindingRefused, kind === 'partial');
      assert.equal(result.guards.attempts, 0);
      const independent = await verify(result);
      const zeroProofRefused = await verify({ ...result, finalTransaction: result.intent }, true);
      const signalMutations = [];
      if (kind === 'partial') {
        const { Interface, AbiCoder, keccak256 } = require('ethers');
        const { TRANSACT_ABI, BOUND_PARAMS } = require('../src/main/wallet/railgun-private-policy');
        const abi = new Interface([TRANSACT_ABI]);
        const field =
          21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        for (const fieldName of [
          'merkleRoot',
          'boundParamsHash',
          'nullifier',
          'changeCommitment',
          'unshieldCommitment',
          'commitment-order',
        ]) {
          const changed = structuredClone(result);
          for (const name of ['intent', 'finalTransaction']) {
            const tx = abi.decodeFunctionData('transact', changed[name].data)[0][0].toArray(true);
            if (fieldName === 'merkleRoot') tx[1] = hex(BigInt(tx[1]) + 1n);
            else if (fieldName === 'nullifier') tx[2][0] = hex(BigInt(tx[2][0]) + 1n);
            else if (fieldName === 'changeCommitment') tx[3][0] = hex(BigInt(tx[3][0]) + 1n);
            else if (fieldName === 'unshieldCommitment') tx[3][1] = hex(BigInt(tx[3][1]) + 1n);
            else if (fieldName === 'commitment-order') tx[3] = [tx[3][1], tx[3][0]];
            else tx[4][6][0][4] = '0x1234'; // Memo changes the bound-parameters hash.
            changed[name].data = abi.encodeFunctionData('transact', [[tx]]);
            changed.expected.merkleRoot = tx[1];
            changed.expected.nullifier = tx[2][0];
            changed.expected.changeCommitment = tx[3][0];
            changed.expected.unshieldCommitment = tx[3][1];
            changed.expected.boundParamsHash = hex(
              BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [tx[4]]))) % field
            );
          }
          matchRailgunPrivateProvedTransaction(
            changed.intent,
            changed.finalTransaction,
            changed.expected
          );
          if (fieldName === 'commitment-order') {
            assert.equal(changed.expected.changeCommitment, result.expected.unshieldCommitment);
            assert.equal(changed.expected.unshieldCommitment, result.expected.changeCommitment);
            assert.notEqual(changed.expected.changeCommitment, result.expected.changeCommitment);
          } else assert.notEqual(changed.expected[fieldName], result.expected[fieldName]);
          await verify(changed, true);
          signalMutations.push(fieldName);
        }
      }
      runs.push({
        kind,
        verified: true,
        wrongMessageSignatureRefused: true,
        wrongSignatureRefusedBeforeProving: true,
        publicCapsuleReconstructedWitness: true,
        productionWitnessUsed: result.productionWitnessUsed,
        artifactVariant: result.artifactVariant,
        publicSignalCount: result.publicSignalCount,
        oneUseProverRefused: result.oneUseProverRefused,
        legacyArtifactBindingRefused: result.legacyArtifactBindingRefused,
        signalMutationsRefused: signalMutations,
        zeroProofRefused,
        independent,
        guards: result.guards,
        proofElapsedMs: result.proofElapsedMs,
        elapsedMs: Math.round(performance.now() - start),
        closed,
      });
      console.log(JSON.stringify({ kind, verified: true, elapsedMs: runs.at(-1).elapsedMs }));
    }
    const {
      normalizeRailgunPrivateCapsule,
      digestRailgunPrivateCapsule,
    } = require('../src/main/wallet/railgun-private-capsule');
    const { createPrivacyStorage } = require('../src/main/wallet/privacy-storage');
    storageKey = Buffer.alloc(32, 71);
    const storageArgs = {
      handle: context('storage', 'synthetic-public-capsules'),
      directory,
      key: storageKey,
    };
    const recoveryCases =
      mode === 'partial'
        ? [['partial', true]]
        : [
            ['transfer', true],
            ['unshield', true],
            ['transfer', false],
            ['unshield', false],
          ];
    for (const [kind, persistSignature] of recoveryCases) {
      let capsule,
        signature,
        payload,
        sequence = 0,
        stored;
      const start = performance.now();
      let task = startRailgunProcess({
        handle: context('engine', 'synthetic-interrupted-prepare'),
        filename: require.resolve('./fixtures/railgun-private-sign-proof-job'),
        input: JSON.stringify({
          archive,
          proverArchive,
          artifactDirectory,
          kind,
          spendingPublicKey,
          checkpointOnly: true,
        }),
        startupMs: 120000,
        lifetimeMs: 180000,
        broker: {
          signal: scope.signal,
          dispatch: track(async (wire) => {
            const message = JSON.parse(wire);
            assert.equal(message.id, ++sequence);
            if (sequence === 1) {
              assert.equal(message.method, 'sign');
              payload = structuredClone(message.value);
              signature = await sign(payload);
              return JSON.stringify({ id: 1, value: signature });
            }
            assert.equal(sequence, 2);
            assert.equal(message.method, 'checkpoint');
            capsule = normalizeRailgunPrivateCapsule(message.value);
            assert.deepEqual(capsule.preparation.transaction, payload.transaction);
            assert.deepEqual(capsule.preparation.expected, payload.expected);
            assert.equal(capsule.preparation.expectedHash, payload.expectedHash);
            stored = JSON.stringify({ capsule, signature: persistSignature ? signature : null });
            await createPrivacyStorage(storageArgs).set(kind, stored);
            // A has emitted no proof. Kill it while its checkpoint request awaits.
            task.close();
            return JSON.stringify({ id: 2, value: null });
          }),
        },
      });
      tasks.add(task);
      await assert.rejects(task.ready);
      const interrupted = await task.closed;
      tasks.delete(task);
      assert.equal(sequence, 2);
      assert.ok(capsule && signature);
      assert.equal(interrupted.code, 'RAILGUN_PROCESS_CLOSED');
      const restored = JSON.parse(await createPrivacyStorage(storageArgs).get(kind));
      assert.equal(JSON.stringify(restored), stored);
      assert.equal(
        digestRailgunPrivateCapsule(restored.capsule),
        digestRailgunPrivateCapsule(capsule)
      );
      const recoverySignaturesBefore = signatures.length;
      if (!persistSignature) {
        restored.signature = await sign({
          archive,
          spendingPublicKey,
          transaction: restored.capsule.preparation.transaction,
          expected: restored.capsule.preparation.expected,
          expectedHash: restored.capsule.preparation.expectedHash,
        });
        assert.deepEqual(restored.signature, signature);
      }
      let result;
      task = startRailgunProcess({
        handle: context('engine', 'synthetic-cold-recovery'),
        filename: require.resolve('./fixtures/railgun-private-recovery-job'),
        input: JSON.stringify({
          archive,
          proverArchive,
          artifactDirectory,
          spendingPublicKey,
          ...restored,
        }),
        startupMs: 120000,
        lifetimeMs: 180000,
        broker: {
          signal: scope.signal,
          dispatch: track(async (wire) => {
            const message = JSON.parse(wire);
            assert.equal(result, undefined);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            result = message.value;
            return JSON.stringify({ id: 1, value: null });
          }),
        },
      });
      tasks.add(task);
      await task.ready;
      task.close();
      const resumed = await task.closed;
      tasks.delete(task);
      assert.equal(resumed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(result.storedSignatureUsed, true);
      assert.equal(result.controls.freshPreparationCalls, 0);
      if (kind !== 'partial')
        assert.equal(result.controls.refused.length, kind === 'transfer' ? 12 : 11);
      else {
        for (const name of [
          'foreign-same-viewing-change',
          'change-value',
          'annotation',
          'ciphertext',
          'unshield-preimage',
          'swapped-commitments',
          'consistent-retargeting-signature',
        ])
          assert.ok(result.controls.refused.includes(name));
        assert.equal(result.controls.sameViewingForeignDecrypted, true);
        assert.equal(result.controls.absentMemoAccepted, true);
        assert.equal(signatures.length - recoverySignaturesBefore, 0);
      }
      assert.equal(result.guards.attempts, 0);
      assert.deepEqual(result.intent, capsule.preparation.transaction);
      assert.deepEqual(result.expected, capsule.preparation.expected);
      matchRailgunPrivateProvedTransaction(result.intent, result.finalTransaction, result.expected);
      const expected = capsule.preparation.expected;
      const originalTxid = require(
        path.join(engine, 'transaction/railgun-txid')
      ).getRailgunTransactionIDFromBigInts(
        [BigInt(expected.nullifier)],
        (kind === 'partial'
          ? [expected.changeCommitment, expected.unshieldCommitment]
          : [expected.commitment]
        ).map(BigInt),
        BigInt(expected.boundParamsHash)
      );
      assert.equal(result.railgunTxid, hex(originalTxid));
      const independent = await verify(result);
      coldRecovery.push({
        kind,
        interruptedBeforeProof: true,
        controls: result.controls,
        encryptedCapsuleReopened: true,
        samePublicIntent: true,
        sameRailgunTxid: true,
        notePosition: capsule.selection.position,
        storedSignatureUsed: persistSignature,
        originalMessageResigned: !persistSignature,
        deterministicSignatureMatched: !persistSignature,
        recoverySpendingKeyTransfers: signatures.length - recoverySignaturesBefore,
        independent,
        interrupted,
        resumed,
        elapsedMs: Math.round(performance.now() - start),
        guards: result.guards,
      });
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
    await sign(captured, {
      name: 'host-refuses-key-request-digest',
      hostChange: 'transactionDigest',
    });
    await sign(captured, { name: 'host-refuses-key-request-message', hostChange: 'expectedHash' });
    await Promise.allSettled([...dispatches]);
    assert.equal(dispatches.size, 0);
    assert.equal(tasks.size, 0);
    assert.deepEqual(hashes(), sourceSha256);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          mode: mode || 'legacy',
          syntheticNotes: true,
          syntheticScanAndOwnership: true,
          productionPartialAdmissionEnabled: false,
          deployedVerifierEqualityQualified: false,
          changeIngestionQualified: false,
          changeSpendEligibilityQualified: false,
          twoSpendLifecycleQualified: false,
          utilityExitsObserved: true,
          admittedBrokerCallbacksDrained: true,
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
          coldRecovery,
          refused,
          passed: true,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    scope.close();
    for (const task of tasks) task.close();
    await Promise.allSettled([...dispatches]);
    await Promise.all([...tasks].map((task) => task.closed));
    storageKey?.fill(0);
  }
}
main().then(
  () => app.exit(0),
  (e) => {
    console.error(e.stack);
    app.exit(1);
  }
);
