/** Main-owned viewing scan over a current identity and exclusive public snapshot.
 * The worker receives one viewing key, public identity data and scoped storage.
 */
const assert = require('assert/strict');
const { startRailgunProcess } = require('./railgun-process');
const { createRailgunWalletStorage } = require('./railgun-wallet-storage');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
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
}) {
  if (privateIntent !== undefined) assert.equal(restore, true);
  let operationInput, onIntent;
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
  const purpose = operationInput
    ? 'private-operate'
    : privateIntent === undefined
      ? 'wallet-viewing'
      : 'private-prepare';
  const descriptor = assertRailgunIdentity(identity, handle);
  assert.equal(walletId, descriptor.walletId);
  archive = verifyRailgunEngineRuntime(archive);
  const context = getPrivacyContext(handle);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, identity.signal]),
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
    sequence = 0,
    storageSequence = 0,
    intentSeen = false,
    operationReplied = false,
    offered,
    operationStatus,
    intentWork;
  try {
    task = startRailgunProcess({
      handle: scope.getContext({ ...context.subject, role: 'engine', operation: purpose }),
      binaryKey: true,
      startupMs: 120000,
      lifetimeMs: 180000,
      filename: operationInput
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
        prefixes: router.prefixes,
      }),
      broker: {
        signal: router.signal,
        async dispatch(wire) {
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          assert.equal(result, undefined);
          assertRailgunIdentity(identity, handle);
          if (message.id === 1) {
            assert.deepEqual(message, { id: 1, method: 'key', purpose });
            let output;
            try {
              return await withRailgunViewingCredential(identity, ({ viewingKey }) => {
                output = Buffer.alloc(32);
                viewingKey.copy(output);
                return output;
              });
            } catch (error) {
              output?.fill(0);
              throw error;
            }
          }
          if (message.method === 'result') {
            assert.ok(!operationInput || operationReplied);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
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
            assert.ok(operationInput && !intentSeen && !operationReplied);
            assert.ok(Buffer.byteLength(wire) <= 65536);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            router.assertIdle();
            intentSeen = true;
            // A trusted main operation handles this typed request. The callback
            // is not a key capability; it must establish its own real authority.
            const offer = require('./railgun-private-preparation').normalizeRailgunPrivateOffer(
              message.value,
              privateIntent
            );
            offered = offer;
            const operationSignal = AbortSignal.any([router.signal, scope.signal, task.signal]);
            intentWork = Promise.resolve().then(() => onIntent(offer, operationSignal));
            const response = await intentWork;
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
          const reply = JSON.parse(
            await router.dispatch(JSON.stringify({ ...message, id: ++storageSequence }))
          );
          return JSON.stringify({ ...reply, id: message.id });
        },
      },
    });
    await task.ready;
    router.assertIdle();
    task.close();
    const closed = await task.closed;
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(result);
    assertRailgunIdentity(identity, handle);
    assert.equal(result.instanceId, descriptor.instanceId);
    return { ...result, closed };
  } catch (error) {
    task?.close();
    const closed = await task?.closed;
    throw Object.assign(new Error('Railgun wallet job failed', { cause: error }), {
      code: error?.code,
      closed,
    });
  } finally {
    task?.close();
    if (task) await task.closed;
    router.close();
    scope.close();
    // A may time out while its main-side handler is draining a secondary job.
    // Keep the account phase until that handler has observed its own exits too.
    if (intentWork) await intentWork.catch(() => {});
  }
}
module.exports = { runRailgunWalletSnapshot };
