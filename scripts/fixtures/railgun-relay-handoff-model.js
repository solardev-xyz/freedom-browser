'use strict';

// Design-validation fixture only. All ports, authority, keys and journal durability
// are fake test seams. This module imports no production controller or transport.
function snapshot(value) {
  const result = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(result);
}

function refusal() {
  return Object.assign(new Error('Fixture relay admission refused'), {
    code: 'FIXTURE_RELAY_REFUSED',
  });
}

function createFixtureRelayExchange({ request, key, authority, journal, transport, decode }) {
  // Only controlled, structured-cloneable public test data is admitted here.
  const input = snapshot(request);
  const exchangeKey = snapshot(key);
  let used = false;
  let closing = false;
  let stopping = false;
  let pending = 0;
  let state = 'ready';
  let sendInvoked = false;
  let responseConsumed = false;
  let cleanupError;
  let resolveClosed;
  let rejectClosed;
  let resolveResponse;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  // Keep cleanup failure observed internally without replacing the public barrier.
  Promise.prototype.then.call(closed, undefined, () => {});
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });

  function finish() {
    if (closing && !stopping && pending === 0) {
      if (cleanupError) rejectClosed(cleanupError);
      else resolveClosed();
    }
  }
  function own(invoke) {
    pending += 1;
    const settled = () => {
      pending -= 1;
      finish();
    };
    try {
      const original = invoke();
      // Register before returning; never substitute the derived promise.
      // A non-native-promise seam refuses without leaking pending accounting.
      Promise.prototype.then.call(original, settled, settled);
      return original;
    } catch (error) {
      settled();
      throw error;
    }
  }
  function retain(original) {
    return own(() => original);
  }
  function uncertain(reason) {
    if (responseConsumed) return;
    responseConsumed = true;
    resolveResponse(Object.freeze({ status: 'uncertain', reason }));
  }
  function current() {
    if (closing) throw refusal();
    const ok = authority.current();
    if (closing || !ok) throw refusal();
  }

  function admit() {
    if (used) throw refusal();
    // Latch before any authority callback; even a failed check consumes this model.
    used = true;
    current();
    const permit = authority.claim(input);
    current();
    return own(async () => {
      // begin may commit then throw. Neither success nor failure permits retry.
      state = 'uncertain';
      try {
        await journal.begin(input);
        current();
        sendInvoked = true;
        const original = transport.send(input, permit);
        retain(original);
        Promise.prototype.then.call(original, undefined, () => uncertain('send-error'));
        return Object.freeze({ send: original, response });
      } catch (error) {
        uncertain('admission-error');
        throw error;
      }
    });
  }

  function receive(message) {
    if (closing || !sendInvoked || responseConsumed) return Promise.resolve(false);
    const received = snapshot(message);
    return own(async () => {
      // decode is a fake per-key authentication oracle, NOT cryptography.
      let decoded;
      try {
        decoded = snapshot(await decode(exchangeKey, received));
      } catch (error) {
        uncertain('decode-error');
        throw error;
      }
      if (closing || responseConsumed || !decoded.authenticated) return false;
      responseConsumed = true;
      if (!decoded.valid) {
        resolveResponse(Object.freeze({ status: 'uncertain', reason: 'malformed-response' }));
        return false;
      }
      try {
        await journal.acknowledge(input, decoded.hash);
        state = 'acknowledged';
        resolveResponse(Object.freeze({ status: 'acknowledged', hash: decoded.hash }));
        return true;
      } catch (error) {
        resolveResponse(Object.freeze({ status: 'uncertain', reason: 'acknowledgement-error' }));
        throw error;
      }
    });
  }

  function close() {
    if (closing) return;
    closing = true;
    uncertain('closed');
    stopping = true;
    try {
      const original = transport.stop();
      Promise.prototype.then.call(original, undefined, (error) => {
        cleanupError = error;
      });
      retain(original);
    } catch (error) {
      cleanupError = error;
    } finally {
      stopping = false;
      finish();
    }
  }

  return Object.freeze({
    admit,
    receive,
    close,
    closed,
    inspect: () => Object.freeze({ state, used, closing, sendInvoked }),
  });
}

module.exports = { createFixtureRelayExchange };
