/** Trusted-main recovery of one already signed operation. Only its original
 * empty proof slot may be filled. No signing, admission, POI or submission
 * authority is created, and no signing-time disclosure is repeated.
 */
const assert = require('assert/strict');
const path = require('path');
const { types } = require('util');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { assertRailgunAccountPublicDestination } = require('./railgun-account-public');
const {
  openRailgunCompletedAccountWallet,
  recoverRailgunAccountPrivateProof,
} = require('./railgun-account-wallet');
const { verifyRailgunPrivateProof, assertRailgunPrivateProof } = require('./railgun-private-proof');
const { matchRailgunPrivateProvedTransaction } = require('./railgun-private-intent');
const busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun signed proof requires recovery'), {
    code: 'RAILGUN_PRIVATE_PROOF_RECOVERY_REFUSED',
  });

async function resumeRailgunAccountPrivateProof(options) {
  let stage = 'admission',
    selected = false,
    claimed = false,
    enrollment,
    holdId,
    account,
    proof,
    timer,
    controller,
    outcome;
  const refused = () =>
    Object.freeze({
      status: selected ? 'recovery-required' : 'refused',
      stage,
      ...(selected ? { holdId } : {}),
      submissionEnabled: false,
    });
  try {
    assert.ok(options && !types.isProxy(options));
    assert.equal(Object.getPrototypeOf(options), Object.prototype);
    const allowed = [
      'identity',
      'enrollment',
      'coordinator',
      'destination',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'holdId',
      'signal',
      'timeoutMs',
    ];
    for (const key of Reflect.ownKeys(options)) {
      assert.ok(allowed.includes(key));
      assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'));
    }
    const {
      identity,
      coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      signal,
      timeoutMs = 360000,
    } = options;
    enrollment = options.enrollment;
    holdId = options.holdId;
    assert.match(holdId, /^[0-9a-f]{64}$/);
    assert.ok(isRailgunAccountEnrollment(enrollment) && !busy.has(enrollment));
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 360000);
    assert.ok(signal === undefined || signal instanceof AbortSignal);
    for (const value of [archive, proverArchive, artifactDirectory])
      assert.ok(path.isAbsolute(value));
    const parent = enrollment.getContext('engine');
    assertRailgunIdentity(identity, parent);
    assert.equal(identity.descriptor.walletId, enrollment.descriptor.walletId);
    assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    controller = new AbortController();
    const lifetime = AbortSignal.any([
      controller.signal,
      enrollment.signal,
      identity.signal,
      coordinator.signal,
      ...(signal ? [signal] : []),
    ]);
    const started = performance.now(),
      deadline = started + timeoutMs;
    const current = () => {
      const now = performance.now();
      assert.ok(!lifetime.aborted && now >= started && now < deadline, fail());
      assertRailgunIdentity(identity, parent);
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    };
    const remaining = (maximum) => {
      current();
      return Math.max(1, Math.min(maximum, Math.floor(deadline - performance.now())));
    };
    current();
    busy.add(enrollment);
    claimed = true;
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    stage = 'history';
    const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
    current();
    const select = (records) => {
      const matches = records.filter((value) => value.entry.id === holdId);
      assert.equal(matches.length, 1);
      return matches[0];
    };
    const baseline = await reservations.withSigningRecovery(
      async (records, context) => {
        context.assertCurrent();
        current();
        const match = select(records);
        let stored;
        try {
          stored = await capsules.readSignedUnfinished(match.receipt);
        } catch (error) {
          if (error.code !== 'RAILGUN_CAPSULE_NOT_READY') throw error;
          // A previous proof write may have committed before its acknowledgment
          // failed. Report the existing slot as data, without reproving it or
          // upgrading it to fresh verification/submission authority.
          stored = await capsules.readSigned(match.receipt);
        }
        context.assertCurrent();
        current();
        assert.equal(stored.holdId, holdId);
        assert.equal(stored.capsule.walletId, enrollment.descriptor.walletId);
        assert.ok(stored.signature);
        // The issued receipt stays inside this phase; only immutable saved data
        // crosses into the separate completed-wallet restoration phase.
        return Object.freeze({ entry: match.entry, stored });
      },
      { timeoutMs: remaining(45000) }
    );
    selected = true;
    current();
    if (baseline.stored.provedTransaction !== null) {
      const checked = matchRailgunPrivateProvedTransaction(
        baseline.stored.capsule.preparation.transaction,
        baseline.stored.provedTransaction,
        baseline.stored.capsule.preparation.expected
      );
      outcome = Object.freeze({
        status: 'proof-present',
        holdId,
        transactionDigest: checked.digest,
        submissionEnabled: false,
      });
    } else {
      stage = 'wallet';
      const owners = { identity, enrollment, coordinator };
      account = await openRailgunCompletedAccountWallet({
        ...owners,
        archive,
        destination,
        signal: lifetime,
        timeoutMs: remaining(180000),
      });
      current();
      stage = 'reconstruct';
      const candidate = await recoverRailgunAccountPrivateProof(account, owners, {
        capsule: baseline.stored.capsule,
        signature: baseline.stored.signature,
        proverArchive,
        artifactDirectory,
      });
      current();
      assert.equal(candidate.status, 'proved');
      assert.equal(candidate.independentlyVerified, false);
      const evidence = Object.freeze({
        intent: baseline.stored.capsule.preparation.transaction,
        transaction: candidate.transaction,
        expected: baseline.stored.capsule.preparation.expected,
      });
      const checked = matchRailgunPrivateProvedTransaction(
        evidence.intent,
        evidence.transaction,
        evidence.expected
      );
      assert.equal(candidate.transactionDigest, checked.digest);
      stage = 'wallet-close';
      await account.close();
      account = null;
      current();
      stage = 'revalidate-history';
      const completed = await reservations.withSigningRecovery(
        async (records, context) => {
          const match = select(records);
          const unchanged = async () => {
            context.assertCurrent();
            current();
            assert.deepEqual(await reservations.assertReceipt(match.receipt), baseline.entry);
            assert.deepEqual(await capsules.readSignedUnfinished(match.receipt), baseline.stored);
            context.assertCurrent();
            current();
          };
          await unchanged();
          stage = 'verify';
          proof = await verifyRailgunPrivateProof({
            enrollment,
            proverArchive,
            artifactDirectory,
            ...evidence,
            signal: AbortSignal.any([lifetime, context.signal]),
            timeoutMs: Math.max(
              1,
              Math.min(remaining(60000), Math.floor(context.deadline - performance.now()))
            ),
          });
          context.assertCurrent();
          current();
          assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
          // Re-attest after C: an intervening completion or changed record must
          // refuse rather than replace, re-sign or retarget any saved operation.
          await unchanged();
          assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
          stage = 'proof-storage';
          await capsules.saveProvedTransaction(match.receipt, evidence.transaction);
          context.assertCurrent();
          current();
          const stored = await capsules.readSigned(match.receipt);
          assert.deepEqual(stored, {
            ...baseline.stored,
            provedTransaction: evidence.transaction,
          });
          assert.deepEqual(await reservations.assertReceipt(match.receipt), baseline.entry);
          context.assertCurrent();
          current();
          assertRailgunPrivateProof(proof.receipt, enrollment, evidence);
          return Object.freeze({
            status: 'proof-stored',
            holdId,
            transactionDigest: checked.digest,
            submissionEnabled: false,
          });
        },
        { timeoutMs: remaining(175000) }
      );
      current();
      outcome = completed;
    }
  } catch {
    outcome = refused();
  } finally {
    clearTimeout(timer);
    controller?.abort();
    try {
      // Completed-account close owns all admitted viewing/storage work and
      // retains exclusion plus issuer quarantine when exit is unobserved.
      await account?.close();
    } catch {
      outcome = refused();
    } finally {
      try {
        proof?.close();
      } catch {
        outcome = refused();
      } finally {
        if (claimed) busy.delete(enrollment);
      }
    }
  }
  return outcome;
}

module.exports = { resumeRailgunAccountPrivateProof };
