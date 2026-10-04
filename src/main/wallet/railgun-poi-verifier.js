/** Fresh keyless POI verification with the same pinned cryptographic runtime.
 * A diagnostic only: checkpoint index/list metadata are hash-bound, not SNARK
 * signals. No ownership, current membership, root or disclosure authority.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const path = require('path');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const fail = () =>
  Object.assign(new Error('Railgun POI verification unavailable'), {
    code: 'RAILGUN_POI_VERIFICATION_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
async function verify({
  handle,
  proverArchive,
  artifactDirectory,
  payload,
  signal,
  timeoutMs = 30000,
}) {
  const parent = getPrivacyContext(handle);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
  assert.equal(parent.subject.kind, 'private-account');
  assert.equal(parent.subject.protocol, 'railgun');
  assert.equal(parent.subject.chainId, 11155111);
  assert.equal(parent.subject.deployment, 'sepolia');
  assert.equal(parent.subject.role, 'prover');
  assert.equal(parent.subject.operation, 'poi-verify');
  // Normalize synchronously before any await; caller mutation cannot replace it.
  const normalized = normalizeRailgunPoiPayload(payload);
  const payloadSha256 = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  assert.ok(typeof artifactDirectory === 'string' && path.isAbsolute(artifactDirectory));
  const input = JSON.stringify({
    proverArchive: verifyRailgunProverRuntime(proverArchive),
    artifactDirectory,
    payload: normalized,
  });
  assert.ok(Buffer.byteLength(input) <= 32768);
  const digest = createHash('sha256').update(input).digest('hex');
  const scope = createPrivacyScope({
    profileId: parent.profileId,
    signal: AbortSignal.any([signal, parent.signal]),
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const started = performance.now(),
    deadline = started + timeoutMs;
  let task,
    result,
    closed = false;
  const active = () => {
    if (
      closed ||
      scope.signal.aborted ||
      performance.now() < started ||
      performance.now() >= deadline
    )
      throw fail();
    getPrivacyContext(handle);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    scope.close();
    task?.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  const timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  try {
    active();
    task = startRailgunProcess({
      handle: scope.getContext(parent.subject),
      filename: require.resolve('./railgun-poi-verify-job'),
      input,
      startupMs: Math.min(30000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          try {
            active();
            assert.equal(result, undefined);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const message = JSON.parse(wire);
            shape(message, ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            const value = message.value;
            shape(value, [
              'inputSha256',
              'payloadSha256',
              'proofVerified',
              'sourceAuthenticated',
              'membershipAuthenticated',
              'rootAccepted',
              'disclosureEnabled',
              'spendingEnabled',
              'guards',
              'proverSha256',
            ]);
            assert.equal(value.inputSha256, digest);
            assert.equal(value.payloadSha256, payloadSha256);
            assert.equal(value.proofVerified, true);
            for (const key of [
              'sourceAuthenticated',
              'membershipAuthenticated',
              'rootAccepted',
              'disclosureEnabled',
              'spendingEnabled',
            ])
              assert.equal(value[key], false);
            assert.equal(value.proverSha256, require('./railgun-prover-manifest.json').sha256);
            shape(value.guards, ['attempts', 'canaries', 'hooks']);
            const { attempts, canaries, hooks } = value.guards;
            assert.equal(attempts, 0);
            assert.ok(Array.isArray(hooks) && hooks.length >= 1 && hooks.length <= 256);
            assert.ok(
              hooks.every((hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook))
            );
            assert.equal(new Set(hooks).size, hooks.length);
            assert.equal(canaries, hooks.length);
            result = Object.freeze({
              inputSha256: digest,
              payloadSha256,
              proofVerified: true,
              independentlyVerified: true,
              sourceAuthenticated: false,
              membershipAuthenticated: false,
              rootAccepted: false,
              metadataAuthenticated: false,
              ownershipAuthenticated: false,
              disclosureEnabled: false,
              spendingEnabled: false,
            });
            return JSON.stringify({ id: 1, value: null });
          } catch (error) {
            // Refusal revokes this attempt before another message can be admitted.
            close();
            throw error;
          }
        },
      },
    });
    await task.ready;
    active();
    assert.ok(result);
    task.close();
    const exited = await task.closed;
    assert.equal(exited.code, 'RAILGUN_PROCESS_CLOSED');
    active();
    return Object.freeze({ ...result, utilityExitObserved: true });
  } finally {
    clearTimeout(timer);
    close();
    if (task) await task.closed;
  }
}
exports.verifyRailgunPoiPayload = async (options) => {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
};
