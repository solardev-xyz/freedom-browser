/** Main-owned recoverability check bound to a genuine preparation and enrolled
 * identity. The process supervisor must explicitly permit this viewing-key job.
 */
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { assertRailgunShieldPreparation } = require('./railgun-shield-prepare');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const inventory = require('./railgun-engine-manifest.json').inventory.sha256;
const receipts = new WeakMap();
const busy = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun shield receiver unavailable'), {
    code: 'RAILGUN_SHIELD_RECEIVER_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
async function verifyRailgunShieldReceiver({ identity, enrollment, preparation, archive }) {
  const prepared = assertRailgunShieldPreparation(preparation, identity, enrollment);
  const handle = enrollment.getContext('engine', 'shield-receive');
  const descriptor = assertRailgunIdentity(identity, handle);
  archive = verifyRailgunEngineRuntime(archive);
  check(!busy.has(preparation));
  busy.add(preparation);
  let task,
    result,
    sequence = 0;
  const active = () => {
    check(assertRailgunShieldPreparation(preparation, identity, enrollment) === prepared);
    assertRailgunIdentity(identity, handle);
  };
  try {
    task = startRailgunProcess({
      handle,
      binaryKey: true,
      filename: require.resolve('./railgun-shield-receive-job'),
      input: JSON.stringify({ archive, descriptor, prepared }),
      startupMs: 120000,
      lifetimeMs: 180000,
      broker: {
        signal: AbortSignal.any([identity.signal, enrollment.signal]),
        async dispatch(wire) {
          active();
          check(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
          const message = JSON.parse(wire);
          check(message.id === ++sequence && !result);
          if (message.id === 1) {
            check(
              Object.keys(message).length === 3 &&
                message.method === 'key' &&
                message.purpose === 'shield-receive'
            );
            let output;
            try {
              return await withRailgunViewingCredential(identity, ({ viewingKey }) => {
                active();
                output = Buffer.alloc(32);
                viewingKey.copy(output);
                return output;
              });
            } catch (error) {
              output?.fill(0);
              throw error;
            }
          }
          check(
            message.id === 2 && message.method === 'result' && Object.keys(message).length === 3
          );
          const value = message.value;
          check(
            value &&
              Object.keys(value).length === 7 &&
              value.verified === true &&
              value.inventory === inventory &&
              value.guards?.attempts === 0 &&
              ['commitment', 'noteValue', 'npk', 'recipient'].every((k) => value[k] === prepared[k])
          );
          result = true;
          return JSON.stringify({ id: message.id, value: null });
        },
      },
    });
    await task.ready;
    check(result);
    task.close();
    check((await task.closed).code === 'RAILGUN_PROCESS_CLOSED');
    active();
    const receipt = Object.freeze({});
    receipts.set(receipt, { identity, enrollment, preparation, prepared });
    return receipt;
  } catch {
    throw fail();
  } finally {
    task?.close();
    if (task) await task.closed;
    busy.delete(preparation);
  }
}
function assertRailgunShieldReceiver(receipt, identity, enrollment, preparation) {
  const entry = receipts.get(receipt);
  check(
    entry &&
      entry.identity === identity &&
      entry.enrollment === enrollment &&
      entry.preparation === preparation
  );
  check(assertRailgunShieldPreparation(preparation, identity, enrollment) === entry.prepared);
  return entry.prepared;
}
module.exports = { verifyRailgunShieldReceiver, assertRailgunShieldReceiver };
