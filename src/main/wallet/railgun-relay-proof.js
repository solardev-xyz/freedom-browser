/** Main-owned static proof evidence from one fixed, independently exited keyless
 * utility. Receipt custody never grants signing, storage mutation or transport. */
const assert = require('assert/strict');
const { types } = require('util');
const { createHash } = require('crypto');
const { shape } = require('./railgun-relay-quote-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { assertRailgunFencedAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  normalizeRailgunRelayProofInput,
  normalizeRailgunRelayProducedProof,
  createRailgunRelayReadyCandidate,
  normalizeRailgunRelayProofVerification,
} = require('./railgun-relay-proof-results');
const { createRailgunRelayVerifyRecordSender } = require('./railgun-relay-record-stream');
const { startRailgunProcess } = require('./railgun-process');
const receipts = new WeakMap(),
  busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun relay proof unavailable'), {
    code: 'RAILGUN_RELAY_PROOF_REFUSED',
  });
const unknown = () =>
  Object.assign(new Error('Railgun wallet exit unobserved'), {
    code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
  });
const sha = (text) => createHash('sha256').update(text).digest('hex');
async function verify(options) {
  shape(options, [
    'enrollment',
    'identity',
    'archive',
    'proverArchive',
    'artifactDirectory',
    'signedRecordText',
    'proof',
    'signal',
    'timeoutMs',
  ]);
  const { enrollment, identity, signal, timeoutMs } = options;
  assertRailgunFencedAccountEnrollment(enrollment);
  const descriptor = assertRailgunIdentity(identity, enrollment.getContext('engine'));
  assertRailgunRelaySignal(signal);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  assert.ok(!busy.has(enrollment));
  const captured = normalizeRailgunRelayProofInput(
    {
      recordText: options.signedRecordText,
      proverArchive: options.proverArchive,
      artifactDirectory: options.artifactDirectory,
      timeoutMs,
    },
    descriptor.walletId
  );
  assert.equal(
    require('./railgun-relay-recovery-data').decodeRailgunRelayLocalRecord(captured.recordText)
      .binding,
    enrollment.binding
  );
  const signedRecordText = captured.recordText,
    proof = normalizeRailgunRelayProducedProof(options.proof, signedRecordText),
    candidateText = createRailgunRelayReadyCandidate(signedRecordText, proof),
    identityText = JSON.stringify({
      walletId: descriptor.walletId,
      spendingPublicKey: [...descriptor.spendingPublicKey],
    });
  const parent = enrollment.getContext('prover', 'relay-verify'),
    context = getPrivacyContext(parent),
    started = performance.now(),
    deadline = started + timeoutMs;
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([signal, enrollment.signal, identity.signal]),
    isCurrent: () => {
      assertRailgunFencedAccountEnrollment(enrollment);
      assertRailgunIdentity(identity, parent);
      return true;
    },
  });
  let task,
    sender,
    result,
    closed,
    failure,
    closeRequested = false,
    stopping = false,
    failed = false,
    observed = false,
    sequence = 0,
    chunks = 0,
    timer;
  const pending = new Set();
  const active = () => {
    assert.ok(
      !failed &&
        !scope.signal.aborted &&
        performance.now() >= started &&
        performance.now() < deadline
    );
    assertRailgunFencedAccountEnrollment(enrollment);
    assertRailgunIdentity(identity, parent);
    getPrivacyContext(parent);
  };
  const closeTask = () => {
    if (!task || closeRequested) return;
    closeRequested = true;
    try {
      task.close();
    } catch {
      failed = true;
    }
  };
  const stop = () => {
    stopping = true;
    sender?.close();
    closeTask();
  };
  const close = () => {
    stop();
    clearTimeout(timer);
    scope.close();
  };
  const observeExit = async () => {
    assert.ok(types.isPromise(task.closed));
    const value = await task.closed;
    assert.ok(value && Number.isInteger(value.exitCode));
    observed = true;
    return value;
  };
  const dispatch = async (wire) => {
    try {
      active();
      assert.ok(!stopping && result === undefined && pending.size === 0);
      assert.equal(typeof wire, 'string');
      assert.ok(Buffer.byteLength(wire) < 65536);
      const message = JSON.parse(wire);
      assert.ok(Number.isSafeInteger(message?.id));
      assert.equal(message.id, ++sequence);
      let value;
      if (message.method === 'relay-verify-record') {
        shape(message, ['id', 'method', 'index']);
        value = sender.read({ method: message.method, index: message.index });
        chunks++;
      } else {
        shape(message, ['id', 'method', 'value']);
        assert.equal(message.method, 'result');
        assert.equal(chunks, sender.manifest.chunks);
        shape(message.value, [
          'engineSha256',
          'proverSha256',
          'artifactVkeys',
          'recordDigest',
          'draftDigest',
          'historyDigest',
          'expectedHash',
          'transactionDigest',
          'payloadDigest',
          'transactionVerified',
          'prePoiVerified',
          'historicalEventSignatureVerified',
          'historicalMembershipPathVerified',
          'inputOwnershipVerified',
          'currentMembershipVerified',
          'authorityGranted',
          'guards',
        ]);
        const { guards, ...verification } = message.value;
        shape(guards, ['attempts', 'canaries', 'hooks']);
        assert.equal(guards.attempts, 0);
        assert.ok(
          Array.isArray(guards.hooks) && guards.hooks.length > 0 && guards.hooks.length <= 256
        );
        assert.ok(
          guards.hooks.every(
            (hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook)
          )
        );
        assert.equal(new Set(guards.hooks).size, guards.hooks.length);
        assert.equal(guards.canaries, guards.hooks.length);
        result = normalizeRailgunRelayProofVerification(verification, signedRecordText, proof);
        value = null;
      }
      const reply = JSON.stringify({ id: message.id, value });
      assert.ok(Buffer.byteLength(reply) < 65536);
      return reply;
    } catch {
      failed = true;
      stop();
      throw fail();
    }
  };
  busy.add(enrollment);
  scope.signal.addEventListener('abort', stop, { once: true });
  timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    active();
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(options.archive),
      proverArchive = require('./railgun-prover-runtime').verifyRailgunProverRuntime(
        captured.proverArchive
      );
    active();
    sender = createRailgunRelayVerifyRecordSender(candidateText, scope.signal);
    task = startRailgunProcess({
      handle: scope.getContext(context.subject),
      filename: require.resolve('./railgun-relay-verify-job'),
      binaryKey: false,
      input: JSON.stringify({
        archive,
        proverArchive,
        artifactDirectory: captured.artifactDirectory,
        identityText,
        recordStream: sender.manifest,
      }),
      startupMs: timeoutMs,
      lifetimeMs: timeoutMs,
      broker: {
        signal: scope.signal,
        dispatch(wire) {
          const work = dispatch(wire);
          pending.add(work);
          work.then(
            () => pending.delete(work),
            () => pending.delete(work)
          );
          return work;
        },
      },
    });
    // Observe rejected closed independently of the ready barrier.
    assert.ok(types.isPromise(task.closed));
    task.closed.catch(() => {});
    assert.ok(types.isPromise(task.ready));
    if (stopping) closeTask();
    await task.ready;
    active();
    assert.ok(result && pending.size === 0);
    closeTask();
    closed = await observeExit();
    active();
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    assert.equal(closed.exitCode, 15);
    assert.equal(closed.escalated, false);
    assert.equal(closed.peerDisconnected, false);
  } catch (error) {
    failure = error;
  } finally {
    stop();
    try {
      if (task) closed = await observeExit();
    } catch {
      failed = true;
    }
    while (pending.size) await Promise.allSettled([...pending]);
    scope.signal.removeEventListener('abort', stop);
    if (!task || observed) busy.delete(enrollment);
  }
  if (task && !observed) {
    close();
    throw unknown();
  }
  if (failure || failed) {
    close();
    throw fail();
  }
  try {
    active();
  } catch {
    close();
    throw fail();
  }
  const receipt = Object.freeze({}),
    observation = Object.freeze({ ...result, utilityExitObserved: true });
  receipts.set(receipt, {
    enrollment,
    identity,
    signedRecordText,
    candidateText,
    candidateSha256: sha(candidateText),
    active,
    observation,
  });
  return Object.freeze({ receipt, observation, process: closed, close, signal: scope.signal });
}
async function verifyRailgunRelayProof(options) {
  try {
    return await verify(options);
  } catch (error) {
    if (error?.code === 'RAILGUN_WALLET_EXIT_UNOBSERVED') throw error;
    throw fail();
  }
}
function assertRailgunRelayProof(receipt, enrollment, identity, signedRecordText, proof) {
  try {
    const saved = receipts.get(receipt);
    assert.ok(saved && saved.enrollment === enrollment && saved.identity === identity);
    saved.active();
    assert.equal(signedRecordText, saved.signedRecordText);
    const candidateText = createRailgunRelayReadyCandidate(signedRecordText, proof);
    assert.equal(candidateText, saved.candidateText);
    assert.equal(sha(candidateText), saved.candidateSha256);
    return saved.observation;
  } catch {
    throw fail();
  }
}
module.exports = { verifyRailgunRelayProof, assertRailgunRelayProof };
