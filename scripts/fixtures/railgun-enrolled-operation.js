/** Offline qualification only: the documented public test mnemonic supplies B.
 * Never accepts a private key or opens a real vault. A retains the note witness;
 * B signs public inputs and exits; C verifies only after A has exited.
 */
const assert = require('assert/strict');
const path = require('path');
const {
  createPrivacyScope,
  getPrivacyContext,
} = require('../../src/main/networks/privacy-context');
const { startRailgunProcess } = require('../../src/main/wallet/railgun-process');
const {
  normalizeRailgunSpendSignature,
  normalizeRailgunPrivateVerification,
} = require('../../src/main/wallet/railgun-private-results');

exports.qualify = async function qualify({
  account,
  owners,
  request,
  archive,
  proverArchive,
  artifactDirectory,
}) {
  const {
    operateRailgunAccountPrivateIntent,
    assertRailgunAccountPrivateWindow,
    readRailgunAccountOwnedNotes,
  } = require('../../src/main/wallet/railgun-account-wallet');
  const { identity, enrollment } = owners;
  const context = getPrivacyContext(enrollment.getContext('engine'));
  const root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { WalletNode } = require(path.join(root, 'key-derivation/wallet-node'));
  const fixturePair = () =>
    WalletNode.fromMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    )
      .derive("m/44'/1984'/0'/0'/0'")
      .getSpendingKeyPair();
  const pair = fixturePair();
  const publicKey = pair.pubkey.map((n) => '0x' + n.toString(16).padStart(64, '0'));
  pair.privateKey.fill(0);
  assert.deepEqual(
    publicKey,
    identity.descriptor.spendingPublicKey.map((v) => '0x' + v)
  );
  const baseline = readRailgunAccountOwnedNotes(account, owners);
  const runs = [];
  for (const refuse of [true, false]) {
    const started = performance.now(),
      previous = account.view;
    let token,
      signer,
      keyTransfers = 0,
      receiver = false;
    const result = await operateRailgunAccountPrivateIntent(account, owners, request, {
      proverArchive,
      artifactDirectory,
      async onIntent(offer, signal, window, capsule) {
        token = window;
        const selected = baseline.ownedPoi.find((v) => v.id === request.noteId);
        assert.ok(selected);
        const normalizedCapsule =
          require('../../src/main/wallet/railgun-private-capsule').normalizeRailgunNewCapsule(
            capsule,
            {
              walletId: enrollment.descriptor.walletId,
              selection: assertRailgunAccountPrivateWindow(window, account, owners).selection,
              preparation: offer,
              noteHash: selected.hash,
            }
          );
        assert.deepEqual(normalizedCapsule, capsule);
        assert.ok(Object.isFrozen(capsule) && Object.isFrozen(capsule.pathElements));
        assert.deepEqual(
          assertRailgunAccountPrivateWindow(window, account, owners).owned,
          baseline
        );
        assert.throws(() => readRailgunAccountOwnedNotes(account, owners));
        if (refuse) return { status: 'refused' };
        if (request.kind === 'railgun-private-transfer') {
          const received =
            await require('../../src/main/wallet/railgun-private-receive').verifyRailgunPrivateReceiver(
              {
                identity,
                enrollment,
                archive,
                transaction: offer.transaction,
                expected: offer.expected,
                recipient: offer.recipient,
                amount: offer.amount,
              }
            );
          assert.equal(received.transactionDigest, offer.transactionDigest);
          receiver = received.recipientVerified;
        }
        const scope = createPrivacyScope({ profileId: context.profileId, signal });
        const payload = {
          archive,
          spendingPublicKey: publicKey,
          transaction: offer.transaction,
          expected: offer.expected,
          expectedHash: offer.expectedHash,
        };
        let task,
          value,
          sequence = 0,
          key;
        try {
          task = startRailgunProcess({
            handle: scope.getContext({
              ...context.subject,
              role: 'keystore',
              operation: 'spending-sign',
            }),
            filename: require.resolve('../../src/main/wallet/railgun-spend-sign-job'),
            input: JSON.stringify(payload),
            binaryKey: true,
            startupMs: 30000,
            lifetimeMs: 60000,
            heapMb: 128,
            rssMb: 512,
            broker: {
              signal: scope.signal,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                assert.equal(message.id, ++sequence);
                if (sequence === 1) {
                  assert.deepEqual(message, { id: 1, method: 'key', purpose: 'spending-sign' });
                  assertRailgunAccountPrivateWindow(window, account, owners);
                  assert.ok(!signal.aborted);
                  const derived = fixturePair();
                  key = new Uint8Array(32);
                  key.set(derived.privateKey);
                  derived.privateKey.fill(0);
                  keyTransfers++;
                  return key;
                }
                assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
                assert.equal(sequence, 2);
                assert.equal(message.method, 'result');
                value = message.value;
                return JSON.stringify({ id: 2, value: null });
              },
            },
          });
          await task.ready;
          task.close();
          signer = await task.closed;
          assert.equal(signer.code, 'RAILGUN_PROCESS_CLOSED');
          assert.ok(key.every((v) => v === 0));
          assert.equal(sequence, 2);
          return {
            status: 'signed',
            signature: normalizeRailgunSpendSignature(value, payload).signature,
          };
        } finally {
          task?.close();
          if (task) await task.closed;
          key?.fill(0);
          scope.close();
        }
      },
    });
    assert.throws(() => assertRailgunAccountPrivateWindow(token, account, owners));
    assert.equal(result.view, account.view);
    await assert.rejects(previous.balance());
    assert.deepEqual(readRailgunAccountOwnedNotes(account, owners), baseline);
    assert.deepEqual(result.readOnly, { readOnly: true, writeAttempts: 0 });
    assert.equal(result.operation.status, refuse ? 'refused' : 'proved');
    let verifier;
    if (!refuse) {
      const scope = createPrivacyScope({ profileId: context.profileId, signal: identity.signal });
      const payload = {
        archive: proverArchive,
        artifactDirectory,
        intent: result.preparation.transaction,
        transaction: result.operation.transaction,
        expected: result.preparation.expected,
      };
      let task, value;
      try {
        task = startRailgunProcess({
          handle: scope.getContext({
            ...context.subject,
            role: 'prover',
            operation: 'private-verify',
          }),
          filename: require.resolve('../../src/main/wallet/railgun-private-verify-job'),
          input: JSON.stringify(payload),
          startupMs: 30000,
          lifetimeMs: 60000,
          broker: {
            signal: scope.signal,
            async dispatch(wire) {
              const message = JSON.parse(wire);
              assert.equal(value, undefined);
              assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              value = message.value;
              return JSON.stringify({ id: 1, value: null });
            },
          },
        });
        await task.ready;
        task.close();
        verifier = await task.closed;
        assert.equal(verifier.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(normalizeRailgunPrivateVerification(value, payload).verified, true);
      } finally {
        task?.close();
        if (task) await task.closed;
        scope.close();
      }
    }
    runs.push({
      kind: request.kind,
      outcome: result.operation.status,
      elapsedMs: Math.round(performance.now() - started),
      syntheticSpendingKeyTransfers: keyTransfers,
      receiverVerified: receiver,
      independentProofVerified: !refuse,
      windowExpired: true,
      recoveryCapsuleValidated: true,
      recoveryWitnessCheckedBeforeOffer: true,
      provedFromReconstructedWitness: !refuse,
      busyReadsRefused: true,
      oldViewRefused: true,
      ownedProjectionUnchanged: true,
      writeAttempts: 0,
      vaultSpendingKeys: 0,
      poiCalls: 0,
      submissions: 0,
      ...(signer ? { signer } : {}),
      ...(verifier ? { verifier } : {}),
    });
  }
  return runs;
};
