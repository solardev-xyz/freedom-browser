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
}) {
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
    storageSequence = 0;
  try {
    task = startRailgunProcess({
      handle: scope.getContext({ ...context.subject, role: 'engine', operation: 'wallet-viewing' }),
      binaryKey: true,
      startupMs: 120000,
      lifetimeMs: 180000,
      filename: require.resolve('./railgun-wallet-job'),
      input: JSON.stringify({
        archive,
        descriptor,
        checkpoint: snapshot.checkpoint,
        walletId,
        restore,
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
            assert.deepEqual(message, { id: 1, method: 'key', purpose: 'wallet-viewing' });
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
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            router.assertIdle();
            result = message.value;
            return JSON.stringify({ id: message.id, value: null });
          }
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
  }
}
module.exports = { runRailgunWalletSnapshot };
