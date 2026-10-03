/** Main-owned, result-only detached verifier. This diagnostic does not mint an
 * account/window capability: authentication of events, ownership and root
 * acceptance must be composed separately before any spending admission.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const { matchRailgunOwnTxid } = require('./railgun-own-txid');
const fail = () =>
  Object.assign(new Error('Railgun own TXID verification unavailable'), {
    code: 'RAILGUN_OWN_TXID_VERIFICATION_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
async function verify({ handle, archive, state, evidence, witness, signal, timeoutMs = 30000 }) {
  const parent = getPrivacyContext(handle);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
  assert.equal(parent.subject.kind, 'private-account');
  assert.equal(parent.subject.protocol, 'railgun');
  assert.equal(parent.subject.chainId, 11155111);
  assert.equal(parent.subject.deployment, 'sepolia');
  assert.equal(parent.subject.role, 'engine');
  assert.equal(parent.subject.operation, 'own-txid-proof');
  const matched = matchRailgunOwnTxid(evidence);
  const normalized = normalizeRailgunTxidWitness(witness, state);
  assert.deepEqual(normalized.row, matched.row);
  const bindingDigest = createHash('sha256').update(JSON.stringify(matched)).digest('hex');
  const input = JSON.stringify({
    archive: verifyRailgunEngineRuntime(archive),
    state,
    witness: normalized,
    bindingDigest,
  });
  assert.ok(Buffer.byteLength(input) <= 65536);
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
      filename: require.resolve('./railgun-own-txid-job'),
      input,
      startupMs: Math.min(30000, timeoutMs),
      lifetimeMs: timeoutMs,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
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
            'bindingDigest',
            'railgunTxid',
            'pathVerified',
            'unshieldCommitmentVerified',
            'sourceAuthenticated',
            'rootAccepted',
            'spendingEnabled',
            'guards',
            'inventory',
          ]);
          assert.equal(value.inputSha256, digest);
          assert.equal(value.bindingDigest, bindingDigest);
          assert.equal(value.railgunTxid, normalized.railgunTxid);
          assert.equal(value.pathVerified, true);
          assert.equal(value.unshieldCommitmentVerified, matched.output.kind === 'unshield');
          for (const key of ['sourceAuthenticated', 'rootAccepted', 'spendingEnabled'])
            assert.equal(value[key], false);
          assert.equal(value.inventory, require('./railgun-engine-manifest.json').inventory.sha256);
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
            bindingDigest,
            railgunTxid: normalized.railgunTxid,
            root: normalized.root,
            index: normalized.index,
            checkpointIndex: normalized.checkpointIndex,
            pathVerified: true,
            unshieldCommitmentVerified: matched.output.kind === 'unshield',
            sourceAuthenticated: false,
            rootAccepted: false,
            currentCanonicalityVerified: false,
            finalityVerified: false,
            rowMetadataAuthenticated: false,
            poiVerified: false,
            globalTxidCompleteness: false,
            spendingEnabled: false,
          });
          return JSON.stringify({ id: 1, value: null });
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
exports.verifyRailgunOwnTxid = async (options) => {
  try {
    return await verify(options);
  } catch {
    throw fail();
  }
};
