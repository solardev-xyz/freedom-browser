/** Qualification-only utility runner. Results remain behind coordinator evidence. */
const assert = require('assert/strict');
const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
const { createRailgunWalletStorage } = require('../src/main/wallet/railgun-wallet-storage');
async function runWalletSnapshot({
  handle,
  snapshot,
  walletSession,
  walletId,
  walletGrant,
  restore,
  interruptAfterWalletBatches = 0,
}) {
  assert.ok(
    Number.isSafeInteger(interruptAfterWalletBatches) &&
      interruptAfterWalletBatches >= 0 &&
      interruptAfterWalletBatches <= 128
  );
  let walletBatches = 0;
  const router = createRailgunWalletStorage({
    publicSnapshot: snapshot,
    walletSession,
    walletId,
    walletGrant,
  });
  let result,
    task,
    sequence = 0,
    storageSequence = 0;
  try {
    task = startRailgunProcess({
      handle,
      startupMs: 120000,
      lifetimeMs: 180000,
      filename: require.resolve('./fixtures/railgun-wallet-snapshot-job'),
      input: JSON.stringify({
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
          if (message.method === 'result') {
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            router.assertIdle();
            result = message.value;
            return JSON.stringify({ id: message.id, value: null });
          }
          const reply = JSON.parse(
            await router.dispatch(JSON.stringify({ ...message, id: ++storageSequence }))
          );
          if (message.channel === 'wallet' && JSON.parse(message.wire).method === 'batch') {
            walletBatches++;
            if (walletBatches === interruptAfterWalletBatches) task.close();
          }
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
    return { ...result, closed };
  } catch (error) {
    task?.close();
    if (task) error.closed = await task.closed;
    error.walletBatches = walletBatches;
    throw error;
  } finally {
    task?.close();
    if (task) await task.closed;
    router.close();
  }
}
module.exports = { runWalletSnapshot };
