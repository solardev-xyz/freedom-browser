/** Main-owned new-operation signing/proving, initially Shield inputs only.
 * Every key requires a genuine live window and B request, fresh gates and a
 * durable exact-intent signing record. No caller data grants key authority.
 * C must verify before saving; saved proof data is not submission authority.
 * EOA submission/recovery must obtain its own fresh C and chain evidence.
 */
const assert = require('assert/strict');
const { createHash, randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  readRailgunAccountOwnedNotes,
  operateRailgunAccountPrivateIntent,
  assertRailgunAccountPrivateWindow,
} = require('./railgun-account-wallet');
const {
  assertRailgunIdentity,
  signRailgunPrivateIntent,
  assertRailgunPrivateSigner,
} = require('./railgun-identity');
const { selectRailgunPrivatePreparation } = require('./railgun-private-preparation');
const {
  normalizeRailgunNewCapsule,
  digestRailgunPrivateCapsule,
} = require('./railgun-private-capsule');
const { verifyRailgunPrivateReceiver } = require('./railgun-private-receive');
const {
  openRailgunPrivateWindowPoi,
  assertRailgunPrivateWindowPoi,
} = require('./railgun-account-poi');
const {
  createRailgunPrivatePreflight,
  assertRailgunPrivatePreflight,
} = require('./railgun-private-preflight');
const { verifyRailgunPrivateProof, assertRailgunPrivateProof } = require('./railgun-private-proof');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const pins = require('./railgun-shield-pins.json');
const permits = new WeakMap(),
  completions = new WeakMap(),
  busy = new WeakSet();
const hash = (v) =>
  createHash('sha256')
    .update('freedom:railgun:private-gates-v1\0')
    .update(JSON.stringify(v))
    .digest('hex');
const fail = () =>
  Object.assign(new Error('Railgun private operation unavailable'), {
    code: 'RAILGUN_PRIVATE_OPERATION_REFUSED',
  });
const KEY_MARGIN_MS = 20000;
// Only this controller can mint provenance. This is deliberately separate from
// the wallet/A lifetime: submission first closes the wallet and enters recovery.
// It attests past gates, never fresh POI, chain state or permission to broadcast.
function complete({
  identity,
  enrollment,
  reservations,
  capsules,
  parent,
  entry,
  stored,
  minimumBlock,
}) {
  const started = performance.now(),
    deadline = started + 120000;
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([
      identity.signal,
      enrollment.signal,
      reservations.signal,
      capsules.signal,
    ]),
    isCurrent: () => {
      assertRailgunIdentity(identity, parent);
      return true;
    },
  });
  const receipt = Object.freeze({});
  const close = () => scope.close();
  const timer = setTimeout(close, 120000);
  timer.unref?.();
  scope.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  const freeze = (v) => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  const evidence = freeze(JSON.parse(JSON.stringify({ entry, stored, minimumBlock })));
  const assertCurrent = () => {
    assert.ok(
      !scope.signal.aborted && performance.now() >= started && performance.now() < deadline
    );
    assertRailgunIdentity(identity, parent);
    getPrivacyContext(parent);
    return evidence;
  };
  assertCurrent();
  completions.set(receipt, { identity, enrollment, assertCurrent, close, signal: scope.signal });
  return Object.freeze({ receipt, close, signal: scope.signal });
}
async function prove({ account, owners, request, archive, proverArchive, artifactDirectory }) {
  owners = Object.freeze({ ...owners });
  request = Object.freeze({ ...request });
  const { identity, enrollment, coordinator } = owners;
  assert.ok(!busy.has(enrollment));
  const baseline = readRailgunAccountOwnedNotes(account, owners);
  const selection = selectRailgunPrivatePreparation(baseline, request);
  const selected = baseline.ownedPoi.find((v) => v.id === request.noteId);
  // Creating-transaction provenance is not yet composed for Transact inputs.
  // Refuse before opening storage, a network context, a hold or a signer.
  if (selected?.type !== 'Shield')
    return Object.freeze({ status: 'refused', stage: 'input-provenance' });
  assert.equal(selected.id, `${selection.tree}:${selection.position}`);
  archive = verifyRailgunEngineRuntime(archive);
  const parent = enrollment.getContext('engine');
  assertRailgunIdentity(identity, parent);
  assert.equal(enrollment.descriptor.walletId, identity.descriptor.walletId);
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([
      identity.signal,
      enrollment.signal,
      account.signal,
      coordinator.signal,
    ]),
    isCurrent: () => {
      assertRailgunIdentity(identity, parent);
      return true;
    },
  });
  busy.add(enrollment);
  const timer = setTimeout(() => scope.close(), 240000);
  timer.unref?.();
  let reservations,
    capsules,
    held,
    signed,
    holdId,
    proof,
    signedCapsule,
    signedSignature,
    signingAttempted = false,
    stage = 'local';
  const active = () => {
    assert.ok(!scope.signal.aborted);
    assertRailgunIdentity(identity, parent);
    getPrivacyContext(parent);
  };
  try {
    reservations = await enrollment.openReservations();
    capsules = await enrollment.openPrivateCapsules();
    active();
    const input = Object.freeze({
      tree: selection.tree,
      position: selection.position,
      nullifier: selected.nullifier,
      noteHash: selected.hash,
    });
    await reservations.assertAvailable(input);
    const capacity = await capsules.inspect();
    assert.ok(capacity.records < capacity.capacity);
    // This technical path uses the vault's qualification EOA (index zero).
    // The gas payer and Shield funding address are publicly linkable.
    const signer = require('./signers').getSigner(0);
    const submitter = (await signer.getAddress()).toLowerCase();
    active();
    assert.match(submitter, /^0x[0-9a-f]{40}$/);
    assert.ok(
      BigInt(submitter) > 0n &&
        typeof signer.signTransaction === 'function' &&
        !signer.sendTransaction
    );
    if (selection.kind === 'railgun-token-unshield') assert.equal(selection.recipient, submitter);
    stage = 'submitter';
    const handle = scope.getContext({
      kind: 'public-address',
      principal: submitter,
      chainId: pins.chainId,
      role: 'transaction-rpc',
    });
    const network = require('./private-transaction-network').getPrivateTransactionNetwork(handle);
    await network.assertCanSubmit(scope.signal);
    active();
    assert.equal(
      (await network.request(pins.chainId, 'eth_getCode', [submitter, 'pending'])).result,
      '0x'
    );
    const balance = await network.request(pins.chainId, 'eth_getBalance', [submitter, 'pending']);
    assert.ok(BigInt(balance.result) >= 2000000000000000n);
    active();
    stage = 'window';
    const result = await operateRailgunAccountPrivateIntent(
      account,
      owners,
      { ...request },
      {
        proverArchive,
        artifactDirectory,
        async onIntent(offer, signal, window, capsule) {
          let poi, preflight, acquiredPoi, acquiredPreflight, permit, deadlineTimer;
          const data = assertRailgunAccountPrivateWindow(window, account, owners);
          assert.equal(data.owned.checkpointHash, baseline.checkpointHash);
          assert.deepEqual(data.selection, selection);
          const operationScope = createPrivacyScope({
            profileId: getPrivacyContext(parent).profileId,
            signal: AbortSignal.any([scope.signal, signal]),
          });
          const closeSources = () => {
            poi?.close();
            preflight?.close();
          };
          operationScope.signal.addEventListener('abort', closeSources, { once: true });
          const current = (margin = 0) => {
            active();
            assert.ok(!operationScope.signal.aborted && !signal.aborted);
            assert.equal(assertRailgunAccountPrivateWindow(window, account, owners, margin), data);
          };
          try {
            current();
            deadlineTimer = setTimeout(
              () => operationScope.close(),
              Math.max(1, Math.floor(data.deadline - performance.now()))
            );
            deadlineTimer.unref?.();
            const normalized = normalizeRailgunNewCapsule(capsule, {
              walletId: enrollment.descriptor.walletId,
              selection,
              preparation: offer,
              noteHash: selected.hash,
            });
            let receiver = null;
            stage = 'receiver';
            if (selection.kind === 'railgun-private-transfer') {
              receiver = await verifyRailgunPrivateReceiver({
                identity,
                enrollment,
                archive,
                transaction: offer.transaction,
                expected: offer.expected,
                recipient: offer.recipient,
                amount: offer.amount,
                signal: operationScope.signal,
              });
              assert.equal(receiver.transactionDigest, offer.transactionDigest);
              assert.equal(receiver.recipientVerified, true);
            }
            current(KEY_MARGIN_MS);
            stage = 'poi';
            const preflightBudget = 20000,
              signerBudget = 30000;
            const commitBy = data.deadline - KEY_MARGIN_MS - signerBudget;
            const poiBudget = Math.min(
              45000,
              Math.floor(commitBy - performance.now() - preflightBudget)
            );
            assert.ok(poiBudget > 0);
            poi = openRailgunPrivateWindowPoi({ wallet: account, ...owners, archive, window });
            acquiredPoi = await poi.acquire({ timeoutMs: poiBudget });
            current(KEY_MARGIN_MS);
            if (acquiredPoi.status !== 'verified') return { status: 'refused' };
            const poiValue = assertRailgunPrivateWindowPoi(
              poi,
              acquiredPoi.receipt,
              account,
              owners,
              window,
              KEY_MARGIN_MS
            );
            assert.equal(poiValue.input.id, selected.id);
            assert.equal(poiValue.input.nullifier, selected.nullifier);
            assert.equal(poiValue.input.noteHash, selected.hash);
            assert.equal(poiValue.input.checkpointHash, baseline.checkpointHash);
            assert.equal(poiValue.input.type, 'Shield');
            assert.equal(offer.expected.nullifier, selected.nullifier);
            stage = 'preflight';
            const preflightInput = Object.freeze({
              tree: selection.tree,
              merkleRoot: offer.expected.merkleRoot,
              nullifier: selected.nullifier,
              checkpointHash: baseline.checkpointHash,
              minimumBlock: baseline.read.readiness.to.number,
            });
            const remaining = Math.min(preflightBudget, Math.floor(commitBy - performance.now()));
            assert.ok(remaining > 0);
            preflight = createRailgunPrivatePreflight({
              enrollment,
              artifactDirectory,
              input: preflightInput,
            });
            const preflightTimer = setTimeout(() => preflight.close(), remaining);
            preflightTimer.unref?.();
            try {
              acquiredPreflight = await preflight.acquire();
            } finally {
              clearTimeout(preflightTimer);
            }
            current(KEY_MARGIN_MS);
            const preflightValue = assertRailgunPrivatePreflight(
              preflight,
              acquiredPreflight.receipt,
              enrollment,
              KEY_MARGIN_MS
            );
            assert.deepEqual(preflightValue.input, preflightInput);
            const gates = (margin = KEY_MARGIN_MS) => {
              current(margin);
              assert.equal(
                assertRailgunPrivateWindowPoi(
                  poi,
                  acquiredPoi.receipt,
                  account,
                  owners,
                  window,
                  margin
                ),
                poiValue
              );
              assert.equal(
                assertRailgunPrivatePreflight(
                  preflight,
                  acquiredPreflight.receipt,
                  enrollment,
                  margin
                ),
                preflightValue
              );
            };
            gates();
            stage = 'signer';
            const signature = await signRailgunPrivateIntent({
              identity,
              archive,
              transaction: offer.transaction,
              expected: offer.expected,
              expectedHash: offer.expectedHash,
              signal: operationScope.signal,
              timeoutMs: Math.min(
                signerBudget,
                Math.floor(data.deadline - performance.now() - KEY_MARGIN_MS)
              ),
              async onKeyRequest(validated, signerToken) {
                gates();
                assertRailgunPrivateSigner(signerToken, identity, offer);
                assert.deepEqual(validated, {
                  transactionDigest: offer.transactionDigest,
                  expectedHash: offer.expectedHash,
                });
                const authorizationDigest = hash({
                  operation: 'shield-input-private-v1',
                  submitter,
                  capsuleDigest: digestRailgunPrivateCapsule(normalized),
                  checkpointHash: baseline.checkpointHash,
                  receiver,
                  poi: poiValue,
                  preflight: preflightValue,
                  signer: validated,
                });
                stage = 'reserve';
                held = await reservations.reserve({
                  ...input,
                  kind: selection.kind,
                  intentDigest: offer.transactionDigest,
                  checkpointHash: baseline.checkpointHash,
                  poiDigest: hash(poiValue),
                });
                holdId = (await reservations.assertReceipt(held)).id;
                gates();
                assertRailgunPrivateSigner(signerToken, identity, offer);
                await capsules.put(held, normalized, authorizationDigest);
                gates();
                assertRailgunPrivateSigner(signerToken, identity, offer);
                stage = 'signing';
                // A failed durable transition may already have committed. Never
                // abandon this input after attempting the transition.
                signingAttempted = true;
                signed = await capsules.markSigning(held, {
                  submitter,
                  operationId: randomBytes(32).toString('hex'),
                  gatesDigest: authorizationDigest,
                });
                const assertKeyCurrent = async () => {
                  gates();
                  assertRailgunPrivateSigner(signerToken, identity, offer);
                  reservations.assertReceiptContext(signed, 'operation');
                  const record = await reservations.assertReceipt(signed);
                  assert.equal(record.id, holdId);
                  assert.equal(record.state, 'signing');
                  const stored = await capsules.get(holdId);
                  assert.equal(stored.capsuleDigest, digestRailgunPrivateCapsule(normalized));
                  assert.equal(stored.authorizationDigest, authorizationDigest);
                  gates();
                  assertRailgunPrivateSigner(signerToken, identity, offer);
                  reservations.assertReceiptContext(signed, 'operation');
                };
                await assertKeyCurrent();
                permit = Object.freeze({});
                permits.set(permit, { identity, signerToken, assertCurrent: assertKeyCurrent });
                return permit;
              },
            });
            current();
            assert.ok(signed);
            stage = 'signature-storage';
            await capsules.saveSignature(signed, signature.signature);
            signedCapsule = normalized;
            signedSignature = signature.signature;
            current();
            return { status: 'signed', signature: signature.signature };
          } catch {
            return { status: 'refused' };
          } finally {
            if (permit) permits.delete(permit);
            clearTimeout(deadlineTimer);
            operationScope.close();
            closeSources();
          }
        },
      }
    );
    active();
    if (result.operation.status !== 'proved')
      return Object.freeze({
        status: signingAttempted ? 'signed-unfinished' : 'refused',
        stage,
        ...(holdId ? { holdId } : {}),
      });
    assert.ok(signed && holdId);
    stage = 'proof';
    const evidence = {
      intent: result.preparation.transaction,
      transaction: result.operation.transaction,
      expected: result.preparation.expected,
    };
    proof = await verifyRailgunPrivateProof({
      enrollment,
      proverArchive,
      artifactDirectory,
      ...evidence,
      signal: scope.signal,
    });
    active();
    assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
    stage = 'proof-storage';
    await capsules.saveProvedTransaction(signed, result.operation.transaction);
    const stored = await capsules.get(holdId);
    const entry = await reservations.assertReceipt(signed);
    assert.equal(entry.id, holdId);
    assert.equal(entry.state, 'signing');
    assert.equal(entry.signing.submitter, submitter);
    assert.deepEqual(stored.capsule, signedCapsule);
    assert.deepEqual(stored.signature, signedSignature);
    assert.deepEqual(stored.provedTransaction, result.operation.transaction);
    assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
    active();
    const completion = complete({
      identity,
      enrollment,
      reservations,
      capsules,
      parent,
      entry,
      stored,
      minimumBlock: baseline.read.readiness.to.number,
    });
    return Object.freeze({ status: 'proved', holdId, completion, submissionEnabled: false });
  } catch {
    return Object.freeze({
      status: signingAttempted ? 'signed-unfinished' : 'refused',
      stage,
      ...(holdId ? { holdId } : {}),
    });
  } finally {
    // Only a known never-signing receipt may be released automatically.
    if (held && !signingAttempted) {
      try {
        await reservations.abandon(held);
      } catch {
        /* Retain uncertain state for explicit recovery. */
      }
    }
    proof?.close();
    clearTimeout(timer);
    scope.close();
    busy.delete(enrollment);
  }
}
async function proveRailgunAccountPrivateOperation(options) {
  try {
    return await prove(options);
  } catch {
    return Object.freeze({ status: 'refused', stage: 'local' });
  }
}
function consumeRailgunPrivateSigningPermit(permit, identity, signerToken) {
  const value = permits.get(permit);
  if (!value || value.identity !== identity || value.signerToken !== signerToken) throw fail();
  permits.delete(permit);
  return Object.freeze({ assertCurrent: value.assertCurrent });
}
function claimRailgunPrivateCompletion(receipt, identity, enrollment) {
  try {
    const value = completions.get(receipt);
    assert.ok(value && value.identity === identity && value.enrollment === enrollment);
    value.assertCurrent();
    completions.delete(receipt);
    return Object.freeze({
      assertCurrent: value.assertCurrent,
      close: value.close,
      signal: value.signal,
    });
  } catch {
    throw fail();
  }
}
module.exports = {
  proveRailgunAccountPrivateOperation,
  consumeRailgunPrivateSigningPermit,
  claimRailgunPrivateCompletion,
};
