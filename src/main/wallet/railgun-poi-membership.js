/** Compose genuine service observations with isolated local membership checks.
 * Receipts expire/revoke with the originating service operation. They attest no
 * wallet ownership, canonical provenance, unspent state or spending permission.
 */
const { getPrivacyContext } = require('../networks/privacy-context');
const { assertRailgunPoiSource } = require('./railgun-poi-source');
const { startRailgunProcess } = require('./railgun-process');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const receipts = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun POI membership unavailable'), {
    code: 'RAILGUN_POI_MEMBERSHIP_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
async function verifyRailgunPoiMembership({
  handle,
  source,
  receipt,
  archive,
  timeoutMs = 180000,
}) {
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 180000);
  const notes = assertRailgunPoiSource(source, handle);
  const observation = source.assertResult(receipt);
  check(
    observation.rootsAccepted === true && observation.statuses.every((n) => n.status === 'Valid')
  );
  archive = verifyRailgunEngineRuntime(archive);
  let task,
    result,
    supplied = false,
    sequence = 0,
    accepting = true,
    refused = false,
    closeFailed = false,
    taskCloseRequested = false,
    sourceCloseRequested = false;
  const controller = new AbortController();
  const current = () => {
    check(!refused && !closeFailed && !source.signal.aborted);
    assertRailgunPoiSource(source, handle);
    check(source.assertResult(receipt) === observation);
  };
  const closeTask = () => {
    // A refusal can occur synchronously inside startRailgunProcess, before it
    // returns its handle. Do not mark an absent task as already closed.
    if (!task || taskCloseRequested) return;
    taskCloseRequested = true;
    try {
      task.close();
    } catch {
      closeFailed = true;
    }
  };
  const refuse = () => {
    // This is also an abort listener. Set the irreversible latch before any
    // reentrant cleanup, and never let one throwing close skip the other.
    refused = true;
    accepting = false;
    controller.abort();
    closeTask();
    if (!sourceCloseRequested) {
      sourceCloseRequested = true;
      try {
        source.close();
      } catch {
        closeFailed = true;
      }
    }
  };
  const dispatch = async (wire) => {
    try {
      check(accepting);
      current();
      check(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
      const message = JSON.parse(wire);
      check(message.id === ++sequence && !result);
      let response;
      if (message.method === 'input') {
        check(!supplied && Object.keys(message).length === 2);
        supplied = true;
        response = JSON.stringify({ id: message.id, value: { notes, proofs: observation.proofs } });
      } else {
        check(supplied && message.method === 'result' && Object.keys(message).length === 3);
        check(
          message.value?.inventory === inventory &&
            message.value.guards?.attempts === 0 &&
            JSON.stringify(message.value.proofs) === JSON.stringify(observation.proofs)
        );
        result = message.value;
        response = JSON.stringify({ id: message.id, value: null });
      }
      current();
      return response;
    } catch {
      // Refuse before returning the rejected promise to the supervisor. A
      // caught malformed call followed by valid traffic cannot rescue this job.
      refuse();
      throw fail();
    }
  };
  source.signal.addEventListener('abort', refuse, { once: true });
  try {
    current();
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-poi-job'),
      input: JSON.stringify({ archive }),
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: AbortSignal.any([source.signal, controller.signal]),
        dispatch,
      },
    });
    if (refused) closeTask();
    await task.ready;
    current();
    check(result);
    accepting = false;
    closeTask();
    if (closeFailed) refuse();
    check((await task.closed).code === 'RAILGUN_PROCESS_CLOSED');
    current();
  } catch {
    refuse();
  } finally {
    accepting = false;
    try {
      closeTask();
      if (closeFailed) refuse();
    } finally {
      try {
        // A throwing close never releases the caller before actual child exit.
        if (task) await task.closed;
      } catch {
        refuse();
      } finally {
        source.signal.removeEventListener('abort', refuse);
      }
    }
  }
  // Publish only after all awaited cleanup and a final live service check.
  try {
    current();
    const verified = Object.freeze({
      ...observation,
      membershipVerified: true,
      spendingEnabled: false,
    });
    const membershipReceipt = Object.freeze({});
    receipts.set(membershipReceipt, { handle, source, receipt, observation, verified });
    return Object.freeze({ receipt: membershipReceipt, observation: verified });
  } catch {
    refuse();
    throw fail();
  }
}
function assertRailgunPoiMembership(receipt, handle, minimumRemainingMs = 0) {
  const entry = receipts.get(receipt);
  check(entry);
  getPrivacyContext(entry.handle);
  assertRailgunPoiSource(entry.source, handle);
  check(entry.source.assertResult(entry.receipt, minimumRemainingMs) === entry.observation);
  return entry.verified;
}
module.exports = { verifyRailgunPoiMembership, assertRailgunPoiMembership };
