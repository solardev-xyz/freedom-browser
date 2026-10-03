/** Main-owned independent cryptographic receive check. Returns data about the
 * exact intent, never a selection, reservation or spending capability.
 */
const assert = require('assert/strict');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity, withRailgunViewingCredential } = require('./railgun-identity');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const { normalizeRailgunPrivateReceiver } = require('./railgun-private-results');
const { startRailgunProcess } = require('./railgun-process');
const pins = require('./railgun-shield-pins.json');
const busy = new WeakSet();
async function verifyRailgunPrivateReceiver({
  identity,
  enrollment,
  archive,
  transaction,
  expected,
  recipient,
  amount,
  signal,
}) {
  assert.ok(isRailgunAccountEnrollment(enrollment));
  assert.ok(signal === undefined || signal instanceof AbortSignal);
  const handle = enrollment.getContext('engine', 'private-receive');
  const descriptor = assertRailgunIdentity(identity, handle);
  assert.equal(enrollment.descriptor.walletId, descriptor.walletId);
  assert.equal(recipient, descriptor.instanceId);
  assert.match(amount, /^[1-9][0-9]{0,16}$/);
  assert.ok(BigInt(amount) <= BigInt(pins.maxQualificationAmount));
  // Capture immutable JSON data before awaiting the utility or a credential.
  const intent = Object.freeze({ ...transaction }),
    wanted = Object.freeze({ ...expected });
  const checked = validateRailgunPrivateSigningIntent(intent, wanted);
  assert.equal(checked.kind, 'railgun-private-transfer');
  archive = verifyRailgunEngineRuntime(archive);
  assert.ok(!busy.has(identity));
  busy.add(identity);
  const lifetime = AbortSignal.any([
    identity.signal,
    enrollment.signal,
    ...(signal ? [signal] : []),
  ]);
  const active = () => {
    assert.ok(!lifetime.aborted);
    assertRailgunIdentity(identity, handle);
    enrollment.getContext('engine', 'private-receive');
  };
  let task,
    result,
    sequence = 0;
  try {
    active();
    task = startRailgunProcess({
      handle,
      binaryKey: true,
      filename: require.resolve('./railgun-private-receive-job'),
      startupMs: 30000,
      lifetimeMs: 60000,
      input: JSON.stringify({
        archive,
        descriptor,
        transaction: intent,
        expected: wanted,
        recipient,
        amount,
      }),
      broker: {
        signal: lifetime,
        async dispatch(wire) {
          active();
          assert.equal(typeof wire, 'string');
          assert.ok(Buffer.byteLength(wire) <= 16384);
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          assert.equal(result, undefined);
          if (message.id === 1) {
            assert.deepEqual(message, { id: 1, method: 'key', purpose: 'private-receive' });
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
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 2);
          assert.equal(message.method, 'result');
          result = normalizeRailgunPrivateReceiver(message.value, {
            transaction: intent,
            expected: wanted,
            recipient,
            amount,
          });
          return JSON.stringify({ id: 2, value: null });
        },
      },
    });
    await task.ready;
    assert.ok(result);
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    active();
    return result;
  } catch {
    throw Object.assign(new Error('Railgun private receiver unavailable'), {
      code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
    });
  } finally {
    task?.close();
    if (task) await task.closed;
    busy.delete(identity);
  }
}
module.exports = { verifyRailgunPrivateReceiver };
