/** Keyless lookup-key derivation from submitted calldata. The private association
 * must stay in main; this detached result grants no account or chain authority.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const { extractRailgunTransactIntent } = require('./railgun-transact-intent');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun own selector unavailable'), {
    code: 'RAILGUN_OWN_SELECTOR_REFUSED',
  });
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
async function derive({ handle, archive, provedTransaction, signal, timeoutMs = 30000 }) {
  const parent = getPrivacyContext(handle);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000);
  assert.equal(parent.subject.kind, 'private-account');
  assert.equal(parent.subject.protocol, 'railgun');
  assert.equal(parent.subject.chainId, 11155111);
  assert.equal(parent.subject.deployment, 'sepolia');
  assert.equal(parent.subject.role, 'engine');
  assert.equal(parent.subject.operation, 'own-txid-selector');
  const { transaction, expected } = extractRailgunTransactIntent(provedTransaction);
  const partial = expected.kind === 'railgun-partial-unshield';
  const bindingDigest = createHash('sha256')
    .update(`freedom:railgun:own-selector-v${partial ? 2 : 1}\0`)
    .update(JSON.stringify(transaction))
    .digest('hex');
  const facts = {
    nullifiers: [expected.nullifier],
    commitments: partial
      ? [expected.changeCommitment, expected.unshieldCommitment]
      : [expected.commitment],
    boundParamsHash: expected.boundParamsHash,
  };
  for (const field of [...facts.nullifiers, ...facts.commitments, facts.boundParamsHash]) {
    assert.match(field, /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(field) < FIELD);
  }
  const input = JSON.stringify({
    archive: verifyRailgunEngineRuntime(archive),
    facts,
    bindingDigest,
    ...(partial ? { intentKind: expected.kind } : {}),
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
      filename: require.resolve('./railgun-own-selector-job'),
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
              'bindingDigest',
              'railgunTxid',
              'selectorDerived',
              'sourceAuthenticated',
              'rootAccepted',
              'spendingEnabled',
              'guards',
              'inventory',
            ]);
            assert.equal(value.inputSha256, digest);
            assert.equal(value.bindingDigest, bindingDigest);
            assert.match(value.railgunTxid, /^[0-9a-f]{64}$/);
            assert.ok(BigInt('0x' + value.railgunTxid) < FIELD);
            assert.equal(value.selectorDerived, true);
            for (const key of ['sourceAuthenticated', 'rootAccepted', 'spendingEnabled'])
              assert.equal(value[key], false);
            assert.equal(
              value.inventory,
              require('./railgun-engine-manifest.json').inventory.sha256
            );
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
              railgunTxid: value.railgunTxid,
              selectorDerived: true,
              accountAuthenticated: false,
              pathVerified: false,
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
          } catch (error) {
            // Refusal is permanent before the dispatch rejection reaches the
            // supervisor. Queued valid traffic cannot recover this attempt.
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
exports.deriveRailgunOwnSelector = async (options) => {
  try {
    return await derive(options);
  } catch {
    throw fail();
  }
};
