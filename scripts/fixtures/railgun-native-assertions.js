/** Sticky fixture-only observations. No production capability or result is replaced. */
const genuine = require('assert/strict');
const violations = [];
function record(error, label) {
  violations.push(
    Object.freeze({ label, name: error?.name === 'AssertionError' ? 'AssertionError' : 'Error' })
  );
}
const cache = new Map();
const wrap =
  (method, label) =>
  (...args) => {
    try {
      const result = method(...args);
      if (result && typeof result.then === 'function')
        return result.catch((error) => {
          record(error, label);
          throw error;
        });
      return result;
    } catch (error) {
      record(error, label);
      throw error;
    }
  };
const assertion = new Proxy(wrap(genuine, 'assert'), {
  get(_target, name) {
    const value = genuine[name];
    if (typeof value !== 'function') return value;
    if (!cache.has(name)) cache.set(name, wrap(value, 'assert.' + String(name)));
    return cache.get(name);
  },
});
function observeClosed(promise, callback, label) {
  Promise.resolve(promise).then(
    (result) => {
      try {
        callback(result);
      } catch (error) {
        record(error, label);
      }
    },
    (error) => {
      record(error, label + '.rejected');
    }
  );
}
module.exports = Object.freeze({
  assert: assertion,
  record,
  observeClosed,
  report: () => violations.map((entry) => ({ ...entry })),
  assertEmpty: () =>
    genuine.deepEqual(violations, [], 'A fixture assertion was masked by a production refusal'),
});
