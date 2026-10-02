/**
 * The error a Swarm write throws when selectBestBatch finds no postage batch
 * with room (swarm-service.js). It carries `code: 'no-usable-stamps'`, the
 * swarm provider's 4900 reason, so freedom://publish and `window.swarm` send
 * the user to the publish setup instead of a dead end. Its own module so the
 * services' tests, which mock swarm-service wholesale, still get the real one.
 */

const NO_USABLE_BATCH_MESSAGE =
  'No usable postage batch available. Your storage is full or expired: buy more storage to publish.';

function noUsableBatchError() {
  const err = new Error(NO_USABLE_BATCH_MESSAGE);
  err.code = 'no-usable-stamps';
  return err;
}

function isNoUsableBatchError(err) {
  return err?.code === 'no-usable-stamps';
}

module.exports = { NO_USABLE_BATCH_MESSAGE, noUsableBatchError, isNoUsableBatchError };
