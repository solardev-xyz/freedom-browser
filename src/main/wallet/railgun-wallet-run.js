/** Main-owned viewing scan over a current identity and exclusive public snapshot.
 * The worker receives one viewing key, public identity data and scoped storage.
 */
const assert = require('assert/strict');
const { types } = require('util');
const unobservedExits = new WeakSet();
const exitUnobserved = () =>
  Object.assign(new Error('Railgun wallet exit unobserved'), {
    code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
  });
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
).get;
const brokerFailure = () =>
  Object.assign(new Error('Railgun wallet broker unavailable'), {
    code: 'RAILGUN_WALLET_BROKER_REFUSED',
  });
const { startRailgunProcess } = require('./railgun-process');
const { createRailgunWalletStorage } = require('./railgun-wallet-storage');
const {
  assertRailgunIdentity,
  withRailgunViewingCredential,
  quarantineRailgunIdentityCredentials,
} = require('./railgun-identity');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
async function runRailgunWalletSnapshot({
  identity,
  archive,
  handle,
  snapshot,
  walletSession,
  walletId,
  walletGrant,
  restore,
  privateIntent,
  privateOperation,
  privateRecovery,
  relayRequest,
  relayDraftText,
  relaySignal,
}) {
  if (privateIntent !== undefined) assert.equal(restore, true);
  let relayInput, relayDraft;
  const relay = relayRequest !== undefined || relayDraftText !== undefined;
  if (relay) {
    assert.equal(restore, true);
    for (const value of [privateIntent, privateOperation, privateRecovery])
      assert.equal(value, undefined);
    const data = require('./railgun-relay-wallet-data');
    data.assertRailgunRelaySignal(relaySignal);
    if (relayRequest !== undefined) {
      assert.equal(relayDraftText, undefined);
      relayInput = data.normalizeRailgunRelayRequest(relayRequest, walletId);
    } else relayDraft = data.parseRailgunRelayDraft(relayDraftText, walletId);
  } else assert.equal(relaySignal, undefined);
  let operationInput, onIntent, recoveryInput;
  if (privateRecovery !== undefined) {
    assert.equal(restore, true);
    assert.equal(privateIntent, undefined);
    assert.equal(privateOperation, undefined);
    recoveryInput = require('./railgun-private-recovery-data').normalizeRailgunPrivateRecoveryInput(
      privateRecovery,
      { walletId }
    );
    recoveryInput = Object.freeze({
      ...recoveryInput,
      proverArchive: require('./railgun-prover-runtime').verifyRailgunProverRuntime(
        recoveryInput.proverArchive
      ),
    });
  }
  if (privateOperation !== undefined) {
    assert.ok(privateIntent && restore === true);
    assert.deepEqual(Object.keys(privateOperation).sort(), [
      'artifactDirectory',
      'onIntent',
      'proverArchive',
    ]);
    assert.equal(typeof privateOperation.onIntent, 'function');
    assert.ok(require('path').isAbsolute(privateOperation.artifactDirectory));
    onIntent = privateOperation.onIntent;
    operationInput = Object.freeze({
      proverArchive: require('./railgun-prover-runtime').verifyRailgunProverRuntime(
        privateOperation.proverArchive
      ),
      artifactDirectory: privateOperation.artifactDirectory,
    });
  }
  const purpose = relay
    ? relayInput
      ? 'relay-prepare'
      : 'relay-reconstruct'
    : recoveryInput
      ? 'private-recover'
      : operationInput
        ? 'private-operate'
        : privateIntent === undefined
          ? 'wallet-viewing'
          : 'private-prepare';
  if (unobservedExits.has(identity)) throw exitUnobserved();
  const descriptor = assertRailgunIdentity(identity, handle);
  assert.equal(walletId, descriptor.walletId);
  archive = verifyRailgunEngineRuntime(archive);
  const context = getPrivacyContext(handle);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, identity.signal, ...(relay ? [relaySignal] : [])]),
    isCurrent: () => {
      assertRailgunIdentity(identity, handle);
      return true;
    },
  });
  let router;
  try {
    router = createRailgunWalletStorage({
      publicSnapshot: snapshot,
      walletSession,
      walletId,
      walletGrant,
    });
  } catch (error) {
    scope.close();
    throw error;
  }
  let result,
    task,
    closed,
    failure,
    sequence = 0,
    storageSequence = 0,
    intentSeen = false,
    operationReplied = false,
    offered,
    operationStatus,
    keyCopy,
    keyDelivered = false,
    failed = false,
    stopping = false,
    closeRequested = false,
    exitObserved = false;
  const pending = new Set(),
    controller = new AbortController(),
    lifetime = AbortSignal.any([router.signal, scope.signal]);
  const observeExit = async () => {
    const barrier = task.closed;
    assert.ok(barrier && typeof barrier.then === 'function');
    const value = await barrier;
    assert.ok(value && typeof value.code === 'string');
    exitObserved = true;
    return value;
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
    keyCopy?.fill(0);
    controller.abort();
    closeTask();
  };
  const active = () => {
    assert.ok(!failed && !stopping && !lifetime.aborted && !task?.signal.aborted);
    assertRailgunIdentity(identity, handle);
    getPrivacyContext(handle);
  };
  const dispatch = async (wire) => {
    try {
      active();
      assert.equal(typeof wire, 'string');
      assert.ok(Buffer.byteLength(wire) <= 2 * 1024 * 1024);
      const message = JSON.parse(wire);
      assert.ok(message && typeof message === 'object' && !Array.isArray(message));
      assert.ok(Number.isSafeInteger(message.id));
      assert.equal(message.id, ++sequence);
      assert.equal(result, undefined);
      if (message.id === 1) {
        assert.equal(pending.size, 0);
        assert.deepEqual(message, { id: 1, method: 'key', purpose });
        const output = await withRailgunViewingCredential(identity, (credential) => {
          active();
          assert.ok(credential && !types.isProxy(credential));
          const loan = Object.getOwnPropertyDescriptor(credential, 'viewingKey');
          assert.ok(loan && Object.hasOwn(loan, 'value'));
          const viewingKey = loan.value;
          assert.ok(
            !keyCopy &&
              !types.isProxy(viewingKey) &&
              types.isUint8Array(viewingKey) &&
              typedArrayByteLength.call(viewingKey) === 32
          );
          keyCopy = Buffer.alloc(32);
          keyCopy.set(viewingKey);
          return keyCopy;
        });
        active();
        assert.ok(output === keyCopy && keyCopy?.byteLength === 32);
        keyDelivered = true;
        return output;
      }
      assert.ok(keyDelivered);
      if (message.method === 'result') {
        assert.equal(pending.size, 0);
        assert.ok(!operationInput || operationReplied);
        assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
        if (relay) {
          assert.ok(message.value && typeof message.value === 'object');
          for (const name of ['privatePreparation', 'privateOperation', 'privateRecovery'])
            assert.equal(message.value[name], undefined);
          if (relayInput) {
            assert.equal(message.value.relayReconstruction, undefined);
            const draft = require('./railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(
              message.value.relayDraft
            );
            assert.equal(draft.data.walletId, walletId);
            assert.deepEqual(draft.data.selection, relayInput.selection);
            assert.deepEqual(draft.data.intent.context, relayInput.context);
            message.value.relayDraft = draft.data;
          } else {
            assert.equal(message.value.relayDraft, undefined);
            message.value.relayReconstruction =
              require('./railgun-relay-wallet-data').normalizeRailgunRelayReconstruction(
                message.value.relayReconstruction,
                relayDraft
              );
          }
        } else {
          assert.equal(message.value?.relayDraft, undefined);
          assert.equal(message.value?.relayReconstruction, undefined);
        }
        if (recoveryInput) {
          assert.ok(message.value && typeof message.value === 'object');
          assert.equal(message.value.privatePreparation, undefined);
          assert.equal(message.value.privateOperation, undefined);
          assert.equal(message.value.privateRecovery?.status, 'proved');
        } else assert.equal(message.value?.privateRecovery, undefined);
        if (operationInput) {
          assert.deepEqual(
            require('./railgun-private-preparation').normalizeRailgunPrivateOffer(
              message.value.privatePreparation,
              privateIntent
            ),
            offered
          );
          assert.equal(
            message.value.privateOperation?.status,
            operationStatus === 'signed' ? 'proved' : 'refused'
          );
        }
        router.assertIdle();
        result = message.value;
        return JSON.stringify({ id: message.id, value: null });
      }
      if (message.method === 'private-intent') {
        assert.equal(pending.size, 0);
        assert.ok(operationInput && !intentSeen && !operationReplied);
        assert.ok(Buffer.byteLength(wire) <= 65536);
        assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
        router.assertIdle();
        intentSeen = true;
        // A trusted main operation handles this typed request. The callback
        // is not a key capability; it must establish its own real authority.
        const offer = require('./railgun-private-preparation').normalizeRailgunPrivateOffer(
          message.value.preparation,
          privateIntent
        );
        assert.deepEqual(Object.keys(message.value).sort(), ['capsule', 'preparation']);
        const capsule = require('./railgun-private-capsule').normalizeRailgunNewCapsule(
          message.value.capsule,
          { walletId, selection: privateIntent, preparation: offer }
        );
        offered = offer;
        const operationSignal = AbortSignal.any([
          router.signal,
          scope.signal,
          task.signal,
          controller.signal,
        ]);
        const response = await onIntent(offer, operationSignal, capsule);
        active();
        assert.ok(!operationSignal.aborted);
        assertRailgunIdentity(identity, handle);
        router.assertIdle();
        getPrivacyContext(handle);
        let value;
        if (response?.status === 'refused') {
          assert.deepEqual(Object.keys(response), ['status']);
          value = { status: 'refused' };
        } else {
          assert.deepEqual(Object.keys(response).sort(), ['signature', 'status']);
          assert.equal(response.status, 'signed');
          value = {
            status: 'signed',
            signature: require('./railgun-private-signature').normalizeRailgunSignature(
              response.signature
            ),
          };
        }
        operationReplied = true;
        operationStatus = value.status;
        return JSON.stringify({ id: message.id, value });
      }
      assert.equal(intentSeen, false);
      assert.deepEqual(Object.keys(message).sort(), ['channel', 'id', 'wire']);
      assert.ok(message.channel === 'public' || message.channel === 'wallet');
      assert.equal(typeof message.wire, 'string');
      const storageSequenceForReply = ++storageSequence;
      const reply = JSON.parse(
        await router.dispatch(JSON.stringify({ ...message, id: storageSequenceForReply }))
      );
      active();
      assert.equal(reply.id, storageSequenceForReply);
      return JSON.stringify({ ...reply, id: message.id });
    } catch {
      failed = true;
      stop();
      throw brokerFailure();
    }
  };
  lifetime.addEventListener('abort', stop, { once: true });

  try {
    active();
    task = startRailgunProcess({
      handle: scope.getContext({ ...context.subject, role: 'engine', operation: purpose }),
      binaryKey: true,
      startupMs: relay ? 30000 : 120000,
      lifetimeMs: relay ? 30000 : 180000,
      filename: relay
        ? require.resolve('./railgun-relay-wallet-job')
        : recoveryInput
          ? require.resolve('./railgun-private-recover-job')
          : operationInput
            ? require.resolve('./railgun-private-operate-job')
            : privateIntent === undefined
              ? require.resolve('./railgun-wallet-job')
              : require.resolve('./railgun-private-prepare-job'),
      input: JSON.stringify({
        archive,
        descriptor,
        checkpoint: snapshot.checkpoint,
        walletId,
        restore,
        ...(privateIntent === undefined ? {} : { privateIntent }),
        ...(operationInput ? { privateOperation: operationInput } : {}),
        ...(recoveryInput ? { privateRecovery: recoveryInput } : {}),
        ...(relayInput ? { relayRequest: relayInput } : {}),
        ...(relayDraft ? { relayDraftText } : {}),
        prefixes: router.prefixes,
      }),
      broker: {
        signal: controller.signal,
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
    if (stopping) closeTask();
    await task.ready;
    active();
    assert.equal(pending.size, 0);
    router.assertIdle();
    closeTask();
    closed = await observeExit();
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    if (relay) {
      assert.equal(closed.exitCode, 15);
      assert.equal(closed.escalated, false);
      assert.equal(closed.peerDisconnected, false);
    }
    assert.ok(!failed && !lifetime.aborted);
    assert.ok(result);
    assertRailgunIdentity(identity, handle);
    assert.equal(result.instanceId, descriptor.instanceId);
  } catch (error) {
    failure = error;
  } finally {
    lifetime.removeEventListener('abort', stop);
    stop();
    // Closing is a request, not evidence of exit. Each cleanup is independent:
    // even a throwing close or rejected child barrier must drain borrowed work.
    for (const close of [() => router.close(), () => scope.close()]) {
      try {
        close();
      } catch {
        failed = true;
      }
    }
    try {
      if (task) closed = await observeExit();
    } catch {
      // A rejected barrier is not an observed child exit.
      failed = true;
      closed = undefined;
    } finally {
      // A missing exit quarantines credential issuance immediately, including
      // sibling identities for this profile/account, while borrowed work drains.
      // The account owner also retains its phase on this distinct outcome.
      if (task && !exitObserved) {
        unobservedExits.add(identity);
        try {
          quarantineRailgunIdentityCredentials(identity);
        } catch {
          // Never let a revocation/cleanup error mask the unknown-exit outcome
          // that the account owner uses to retain its independent phase lock.
        }
      }
      while (pending.size) await Promise.allSettled([...pending]);
      keyCopy?.fill(0);
    }
  }
  if (unobservedExits.has(identity)) throw exitUnobserved();
  if (failure || failed) {
    // Broker and cleanup errors never expose callback errors or key-bearing input.
    throw Object.assign(
      new Error('Railgun wallet job failed', {
        cause: failed ? brokerFailure() : failure,
      }),
      {
        code: failed ? 'RAILGUN_WALLET_BROKER_REFUSED' : failure?.code,
        closed,
      }
    );
  }
  return { ...result, closed };
}
module.exports = { runRailgunWalletSnapshot };
