/** Main-only, vault-bound Railgun identity. Raw spending material is transferred
 * once to a dedicated public-key derivation utility, never to a wallet scanner.
 * No signing API is exposed. An issued identity expires with its vault/profile.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createRailgunKeystore, createRailgunViewingKeystore } = require('../identity/privacy-keys');
const { openPrivacySession } = require('./privacy-session');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { startRailgunProcess } = require('./railgun-process');
const vault = require('../identity/vault');
const identities = new WeakMap(),
  owners = new Set();
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
    identities.set(identity, { handle, vaultSignal, view, accountIndex });
    assertRailgunIdentity(identity);
    return identity;
  } catch {
    close();
    throw fail();
  }
}
module.exports = { openRailgunIdentity, assertRailgunIdentity, withRailgunViewingCredential };
