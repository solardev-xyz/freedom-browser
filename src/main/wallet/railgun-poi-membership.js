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
    sequence = 0;
  try {
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-poi-job'),
      input: JSON.stringify({ archive }),
      startupMs: Math.min(120000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: source.signal,
        async dispatch(wire) {
          check(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
          assertRailgunPoiSource(source, handle);
          check(source.assertResult(receipt) === observation);
          const message = JSON.parse(wire);
          check(message.id === ++sequence && !result);
          if (message.method === 'input') {
            check(!supplied && Object.keys(message).length === 2);
            supplied = true;
            return JSON.stringify({ id: message.id, value: { notes, proofs: observation.proofs } });
          }
          check(supplied && message.method === 'result' && Object.keys(message).length === 3);
          check(
            message.value?.inventory === inventory &&
              message.value.guards?.attempts === 0 &&
              JSON.stringify(message.value.proofs) === JSON.stringify(observation.proofs)
          );
          result = message.value;
          return JSON.stringify({ id: message.id, value: null });
        },
      },
    });
    await task.ready;
    check(result);
    task.close();
    check((await task.closed).code === 'RAILGUN_PROCESS_CLOSED');
    assertRailgunPoiSource(source, handle);
    check(source.assertResult(receipt) === observation);
    const verified = Object.freeze({
      ...observation,
      membershipVerified: true,
      spendingEnabled: false,
    });
    const membershipReceipt = Object.freeze({});
    receipts.set(membershipReceipt, { handle, source, receipt, observation, verified });
    return Object.freeze({ receipt: membershipReceipt, observation: verified });
  } catch {
    source.close();
    throw fail();
  } finally {
    task?.close();
    if (task) await task.closed;
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
