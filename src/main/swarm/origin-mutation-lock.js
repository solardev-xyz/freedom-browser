const { normalizeOrigin } = require('../../shared/origin-utils');

const tails = new Map();

/**
 * Serialize authority checks and mutations for one normalized origin.
 * A rejected task never poisons the queue for later work.
 */
function withOriginLock(origin, task) {
  const key = normalizeOrigin(origin);
  const previous = tails.get(key) || Promise.resolve();
  const result = previous.then(task, task);
  const settled = result.then(() => undefined, () => undefined);
  tails.set(key, settled);
  settled.then(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });
  return result;
}

function _resetForTests() {
  tails.clear();
}

module.exports = { withOriginLock, _resetForTests };
