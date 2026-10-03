/** Enrolled, own-recipient native shield construction. This produces an opaque
 * short-lived preparation, not signing/submission authority. Deployment checks,
 * sender intent and durable transaction journaling must precede any broadcast.
 */
const { getPrivacyContext } = require('../networks/privacy-context');
const { assertRailgunIdentity } = require('./railgun-identity');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { shieldAmount, validateRailgunNativeShield } = require('./railgun-shield-policy');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const receipts = new WeakMap(),
  generations = new WeakMap(),
  busy = new WeakSet();
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_AGE_MS = 120000;
const fail = () =>
  Object.assign(new Error('Railgun shield preparation unavailable'), {
    code: 'RAILGUN_SHIELD_PREPARATION_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function active(identity, enrollment) {
  check(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  const handle = enrollment.getContext('engine', 'shield-prepare');
  getPrivacyContext(handle);
  const descriptor = assertRailgunIdentity(identity, handle);
  check(descriptor.walletId === enrollment.descriptor.walletId);
  return { handle, descriptor };
}
async function prepareRailgunNativeShield({ identity, enrollment, archive, amount }) {
  const { handle, descriptor } = active(identity, enrollment);
  shieldAmount(amount);
  archive = verifyRailgunEngineRuntime(archive);
  check(!busy.has(enrollment));
  busy.add(enrollment);
  const generation = (generations.get(enrollment) ?? 0) + 1;
  generations.set(enrollment, generation);
  const signal = AbortSignal.any([identity.signal, enrollment.signal]);
  let task,
    sequence = 0,
    supplied = false,
    result;
  try {
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-shield-job'),
      input: JSON.stringify({ archive }),
      startupMs: 120000,
      lifetimeMs: 180000,
      broker: {
        signal,
        async dispatch(wire) {
          active(identity, enrollment);
          check(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
          const message = JSON.parse(wire);
          check(message.id === ++sequence && !result);
          if (message.method === 'input') {
            check(!supplied && Object.keys(message).length === 2);
            supplied = true;
            return JSON.stringify({
              id: message.id,
              value: { recipient: descriptor.instanceId, amount },
            });
          }
          check(supplied && message.method === 'result' && Object.keys(message).length === 3);
          const value = message.value;
          check(
            value &&
              Object.keys(value).length === 6 &&
              value.inventory === inventory &&
              value.guards?.attempts === 0 &&
              typeof value.commitment === 'string' &&
              /^0x[0-9a-f]{64}$/.test(value.commitment) &&
              BigInt(value.commitment) > 0n &&
              BigInt(value.commitment) < FIELD
          );
          const validated = validateRailgunNativeShield(value.transaction, {
            amount,
            npk: value.npk,
          });
          check(validated.noteValue === value.noteValue);
          result = Object.freeze({
            ...validated,
            commitment: value.commitment,
            recipient: descriptor.instanceId,
            deploymentVerified: false,
            signingEnabled: false,
          });
          return JSON.stringify({ id: message.id, value: null });
        },
      },
    });
    await task.ready;
    check(result);
    task.close();
    check((await task.closed).code === 'RAILGUN_PROCESS_CLOSED');
    active(identity, enrollment);
    const receipt = Object.freeze({});
    receipts.set(receipt, { identity, enrollment, generation, created: performance.now(), result });
    return Object.freeze({ receipt, prepared: result });
  } catch {
    throw fail();
  } finally {
    task?.close();
    if (task) await task.closed;
    busy.delete(enrollment);
  }
}
function assertRailgunShieldPreparation(receipt, identity, enrollment) {
  active(identity, enrollment);
  const entry = receipts.get(receipt),
    now = performance.now();
  check(
    entry &&
      entry.identity === identity &&
      entry.enrollment === enrollment &&
      entry.generation === generations.get(enrollment) &&
      !busy.has(enrollment) &&
      now >= entry.created &&
      now - entry.created < MAX_AGE_MS
  );
  return entry.result;
}
module.exports = { prepareRailgunNativeShield, assertRailgunShieldPreparation, MAX_AGE_MS };
