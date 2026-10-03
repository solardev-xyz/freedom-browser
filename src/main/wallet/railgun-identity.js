/** Main-only, vault-bound Railgun identity. Raw spending material is transferred
 * once to a dedicated public-key derivation utility, never to a wallet scanner.
 * Signing is restricted to a dedicated utility and a one-use controller permit.
 * An issued identity expires with its vault/profile.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunKeystore, createRailgunViewingKeystore } = require('../identity/privacy-keys');
const { openPrivacySession } = require('./privacy-session');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const vault = require('../identity/vault');
const identities = new WeakMap(),
  owners = new Set(),
  signers = new WeakMap(),
  signing = new WeakSet();
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun identity unavailable'), { code: 'RAILGUN_IDENTITY_REFUSED' });
const field = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && BigInt('0x' + s) < FIELD;
function assertRailgunIdentity(identity, expectedHandle) {
  const saved = identities.get(identity);
  if (!saved || identity.signal.aborted) throw fail();
  const context = getPrivacyContext(saved.handle);
  if (expectedHandle !== undefined) {
    const expected = getPrivacyContext(expectedHandle);
    assert.equal(expected.profileId, context.profileId);
    for (const key of ['kind', 'principal', 'protocol', 'deployment', 'chainId'])
      assert.equal(expected.subject[key], context.subject[key]);
  }
  if (saved.vaultSignal !== vault.getSessionSignal()) throw fail();
  return identity.descriptor;
}
async function withRailgunViewingCredential(identity, use) {
  assertRailgunIdentity(identity);
  assert.equal(typeof use, 'function');
  const saved = identities.get(identity),
    key = await saved.view.deriveBytesAt(`m/420'/1984'/0'/0'/${saved.accountIndex}'`);
  const wipe = () => key.fill(0);
  identity.signal.addEventListener('abort', wipe, { once: true });
  try {
    assertRailgunIdentity(identity);
    const result = await use({
      viewingKey: key,
      spendingPublicKey: identity.descriptor.spendingPublicKey,
    });
    assertRailgunIdentity(identity);
    return result;
  } finally {
    identity.signal.removeEventListener('abort', wipe);
    wipe();
  }
}
async function openRailgunIdentity({ archive, accountIndex = 0 }) {
  assert.ok(Number.isInteger(accountIndex) && accountIndex >= 0 && accountIndex <= 65535);
  archive = verifyRailgunEngineRuntime(archive);
  const parent = openPrivacySession(),
    vaultSignal = vault.getSessionSignal();
  const subject = {
    kind: 'private-account',
    principal: `railgun:${accountIndex}`,
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'keystore',
  };
  const parentHandle = parent.getContext(subject),
    context = getPrivacyContext(parentHandle);
  const owner = JSON.stringify([context.profileId, accountIndex]);
  assert.ok(!owners.has(owner));
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([parent.signal, vaultSignal]),
    isCurrent: () => {
      getPrivacyContext(parentHandle);
      return vaultSignal === vault.getSessionSignal();
    },
  });
  const handle = scope.getContext(subject);
  let keystore, view;
  try {
    keystore = createRailgunKeystore(handle, accountIndex);
    view = createRailgunViewingKeystore(handle, accountIndex);
  } catch (error) {
    scope.close();
    throw error;
  }
  owners.add(owner);
  let task;
  const close = () => scope.close();
  const releaseOwner = () => {
    if (scope.signal.aborted && !task) owners.delete(owner);
  };
  scope.signal.addEventListener('abort', releaseOwner, { once: true });
  async function derive(purpose, spendingPublicKey) {
    let sequence = 0,
      result,
      guards;
    const keyPath = `m/${purpose === 'spending-public' ? 44 : 420}'/1984'/0'/0'/${accountIndex}'`;
    task = startRailgunProcess({
      handle: scope.getContext({ ...subject, operation: purpose }),
      filename: require.resolve('./railgun-identity-job'),
      binaryKey: true,
      input: JSON.stringify({
        archive,
        purpose,
        ...(spendingPublicKey ? { spendingPublicKey } : {}),
      }),
      startupMs: 30000,
      lifetimeMs: 60000,
      heapMb: 128,
      rssMb: 512,
      broker: {
        signal: scope.signal,
        async dispatch(wire) {
          getPrivacyContext(handle);
          const message = JSON.parse(wire);
          assert.equal(message.id, ++sequence);
          if (message.id === 1) {
            assert.deepEqual(message, { id: 1, method: 'key', purpose });
            const bytes = await (purpose === 'spending-public' ? keystore : view).deriveBytesAt(
              keyPath
            );
            try {
              getPrivacyContext(handle);
              // Ownership passes to the supervisor, which wipes even a late
              // reply after closure. The key is never hex/JSON serialized here.
              return bytes;
            } catch (error) {
              bytes.fill(0);
              throw error;
            }
          }
          assert.equal(message.id, 2);
          assert.deepEqual(Object.keys(message).sort(), ['guards', 'id', 'method', 'value']);
          assert.equal(message.method, 'result');
          result = message.value;
          guards = message.guards;
          return JSON.stringify({ id: 2, value: null });
        },
      },
    });
    try {
      await task.ready;
      task.close();
      const closed = await task.closed;
      assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
      getPrivacyContext(handle);
      assert.equal(sequence, 2);
      assert.equal(guards?.attempts, 0);
      assert.ok(Array.isArray(guards.hooks) && guards.hooks.length > 0);
      assert.equal(new Set(guards.hooks).size, guards.hooks.length);
      assert.equal(guards.canaries, guards.hooks.length);
      return result;
    } finally {
      task.close();
      await task.closed;
      task = null;
      releaseOwner();
    }
  }
  try {
    const spending = await derive('spending-public');
    assert.deepEqual(Object.keys(spending), ['spendingPublicKey']);
    assert.ok(
      Array.isArray(spending.spendingPublicKey) &&
        spending.spendingPublicKey.length === 2 &&
        spending.spendingPublicKey.every(field)
    );
    const result = await derive('viewing-identity', spending.spendingPublicKey);
    assert.deepEqual(Object.keys(result).sort(), [
      'instanceId',
      'masterPublicKey',
      'spendingPublicKey',
      'viewingPublicKey',
      'walletId',
    ]);
    assert.deepEqual(result.spendingPublicKey, spending.spendingPublicKey);
    assert.ok(field(result.masterPublicKey));
    for (const k of ['walletId', 'viewingPublicKey']) assert.match(result[k], /^[0-9a-f]{64}$/);
    assert.match(result.instanceId, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
    const descriptor = Object.freeze({
      ...result,
      spendingPublicKey: Object.freeze([...result.spendingPublicKey]),
      accountIndex,
    });
    const identity = Object.freeze({ descriptor, signal: scope.signal, close });
    identities.set(identity, { handle, vaultSignal, view, keystore, accountIndex });
    assertRailgunIdentity(identity);
    return identity;
  } catch {
    close();
    throw fail();
  }
}
// No callback receives raw key bytes. The controller must issue an exact,
// one-use permit only after B validates its request and durable signing exists.
async function signPrivateIntent({
  identity,
  archive,
  transaction,
  expected,
  expectedHash,
  signal,
  onKeyRequest,
  timeoutMs = 60000,
}) {
  assertRailgunIdentity(identity);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.equal(typeof onKeyRequest, 'function');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  assert.ok(!signing.has(identity));
  const payload = Object.freeze({
    archive: verifyRailgunEngineRuntime(archive),
    spendingPublicKey: Object.freeze(identity.descriptor.spendingPublicKey.map((v) => '0x' + v)),
    transaction: Object.freeze({ ...transaction }),
    expected: Object.freeze({ ...expected }),
    expectedHash,
  });
  require('./railgun-private-intent').validateRailgunPrivateSigningIntent(
    payload.transaction,
    payload.expected
  );
  const saved = identities.get(identity),
    context = getPrivacyContext(saved.handle),
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([identity.signal, signal]),
      isCurrent: () => {
        assertRailgunIdentity(identity);
        return true;
      },
    });
  let handle;
  try {
    handle = scope.getContext({ ...context.subject, operation: 'spending-sign' });
  } catch (error) {
    scope.close();
    throw error;
  }
  const token = Object.freeze({});
  let task,
    sequence = 0,
    value;
  const current = () => {
    assertRailgunIdentity(identity);
    assert.ok(!scope.signal.aborted && task && !task.signal.aborted);
    getPrivacyContext(handle);
  };
  const requests = new Set();
  async function dispatch(wire) {
    current();
    assert.equal(typeof wire, 'string');
    assert.ok(Buffer.byteLength(wire) <= 16384);
    const message = JSON.parse(wire);
    assert.equal(message.id, ++sequence);
    const results = require('./railgun-private-results');
    if (sequence === 1) {
      const request = results.normalizeRailgunSpendKeyRequest(message, payload);
      const permit = await onKeyRequest(request, token);
      current();
      const gate = require('./railgun-private-operation').consumeRailgunPrivateSigningPermit(
        permit,
        identity,
        token
      );
      await gate.assertCurrent();
      current();
      const bytes = await saved.keystore.deriveBytesAt(`m/44'/1984'/0'/0'/${saved.accountIndex}'`);
      const wipe = () => bytes.fill(0);
      scope.signal.addEventListener('abort', wipe, { once: true });
      try {
        await gate.assertCurrent();
        current();
        // Ownership passes directly to the supervisor, which always wipes
        // after its binary reply (including closure during this dispatch).
        return bytes;
      } catch (error) {
        wipe();
        throw error;
      } finally {
        scope.signal.removeEventListener('abort', wipe);
      }
    }
    assert.equal(sequence, 2);
    assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
    assert.equal(message.method, 'result');
    value = results.normalizeRailgunSpendSignature(message.value, payload);
    return JSON.stringify({ id: 2, value: null });
  }
  signing.add(identity);
  signers.set(token, { identity, payload, current, signal: scope.signal });
  try {
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-spend-sign-job'),
      input: JSON.stringify(payload),
      binaryKey: true,
      startupMs: Math.min(30000, timeoutMs),
      lifetimeMs: timeoutMs,
      heapMb: 128,
      rssMb: 512,
      broker: {
        signal: scope.signal,
        dispatch(wire) {
          const pending = dispatch(wire);
          requests.add(pending);
          pending.then(
            () => requests.delete(pending),
            () => requests.delete(pending)
          );
          return pending;
        },
      },
    });
    await task.ready;
    current();
    assert.ok(value && sequence === 2);
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    assertRailgunIdentity(identity);
    assert.ok(!scope.signal.aborted);
    return value;
  } catch {
    throw Object.assign(new Error('Railgun private signing unavailable'), {
      code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
    });
  } finally {
    signers.delete(token);
    scope.close();
    task?.close();
    if (task) await task.closed;
    // A child can exit while its host durability callback is still pending.
    // Keep identity exclusion until that callback has observed revocation.
    await Promise.allSettled([...requests]);
    signing.delete(identity);
  }
}
async function signRailgunPrivateIntent(options) {
  try {
    return await signPrivateIntent(options);
  } catch {
    throw Object.assign(new Error('Railgun private signing unavailable'), {
      code: 'RAILGUN_PRIVATE_SIGNING_REFUSED',
    });
  }
}
function assertRailgunPrivateSigner(token, identity, { transaction, expected, expectedHash }) {
  const value = signers.get(token);
  assert.ok(value && value.identity === identity);
  value.current();
  assert.deepEqual(value.payload.transaction, transaction);
  assert.deepEqual(value.payload.expected, expected);
  assert.equal(value.payload.expectedHash, expectedHash);
  return value.signal;
}
module.exports = {
  openRailgunIdentity,
  assertRailgunIdentity,
  withRailgunViewingCredential,
  signRailgunPrivateIntent,
  assertRailgunPrivateSigner,
};
