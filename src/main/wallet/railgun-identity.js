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
  relaySigners = new WeakMap(),
  unobservedRelayWork = new Set(),
  unknownRelayFailures = new WeakSet(),
  signing = new WeakSet();
// Process-lifetime quarantine deliberately survives identity/vault replacement.
// The key is the same stable owner used for identity opening, not a caller ID.
const quarantinedOwners = new Set(),
  ownerScopes = new Map(),
  ownerLoans = new Map();
function retainLoan(owner, key) {
  // A previously admitted derivation may finish after quarantine. Wipe before
  // any subsequent asynchronous reattestation or credential callback can run.
  if (quarantinedOwners.has(owner)) key.fill(0);
  if (!ownerLoans.has(owner)) ownerLoans.set(owner, new Set());
  ownerLoans.get(owner).add(key);
  return () => {
    key.fill(0);
    const loans = ownerLoans.get(owner);
    loans?.delete(key);
    if (loans?.size === 0) ownerLoans.delete(owner);
  };
}
/** Trusted hosts call only after an issued identity's child exit is unobserved.
 * No currency check: the original lifetime may already be revoked. There is no
 * reset or account-selector API; a fresh application process is required. */
function quarantineRailgunIdentityCredentials(identity) {
  const saved = identities.get(identity);
  if (!saved) throw fail();
  quarantinedOwners.add(saved.owner);
  for (const key of ownerLoans.get(saved.owner) || []) key.fill(0);
  // Closing one scope can synchronously remove it or trigger a reopen attempt.
  // Quarantine is installed first, and every current sibling is revoked.
  for (const scope of [...(ownerScopes.get(saved.owner) || [])]) scope.close();
}
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const fail = () =>
  Object.assign(new Error('Railgun identity unavailable'), { code: 'RAILGUN_IDENTITY_REFUSED' });
const field = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && BigInt('0x' + s) < FIELD;
function assertRailgunIdentity(identity, expectedHandle) {
  const saved = identities.get(identity);
  if (!saved || quarantinedOwners.has(saved.owner) || identity.signal.aborted) throw fail();
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
  const releaseLoan = retainLoan(saved.owner, key);
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
    releaseLoan();
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
  if (quarantinedOwners.has(owner)) throw fail();
  assert.ok(!owners.has(owner));
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([parent.signal, vaultSignal]),
    isCurrent: () => {
      getPrivacyContext(parentHandle);
      return !quarantinedOwners.has(owner) && vaultSignal === vault.getSessionSignal();
    },
  });
  const handle = scope.getContext(subject);
  if (!ownerScopes.has(owner)) ownerScopes.set(owner, new Set());
  ownerScopes.get(owner).add(scope);
  scope.signal.addEventListener(
    'abort',
    () => {
      const scopes = ownerScopes.get(owner);
      scopes?.delete(scope);
      if (scopes?.size === 0) ownerScopes.delete(owner);
    },
    { once: true }
  );
  owners.add(owner);
  let keystore, view;
  try {
    keystore = createRailgunKeystore(handle, accountIndex);
    view = createRailgunViewingKeystore(handle, accountIndex);
  } catch (error) {
    scope.close();
    owners.delete(owner);
    throw error;
  }
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
    const loans = new Set();
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
            const releaseLoan = retainLoan(owner, bytes);
            loans.add(releaseLoan);
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
      for (const releaseLoan of loans) releaseLoan();
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
    identities.set(identity, { handle, vaultSignal, view, keystore, accountIndex, owner });
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
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      payload.expected.kind
    )
  );
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
  const requests = new Set(),
    loans = new Set();
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
      const releaseLoan = retainLoan(saved.owner, bytes);
      loans.add(releaseLoan);
      const wipe = () => bytes.fill(0);
      scope.signal.addEventListener('abort', wipe, { once: true });
      try {
        current();
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
    for (const releaseLoan of loans) releaseLoan();
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
// Relay signing has a separate permit/token domain but shares identity signing
// exclusion. The fixed controller consumer is intentionally absent until the
// connected durable operation exists; a missing consumer fails before a loan.
async function signRelayIntent({
  identity,
  archive,
  intent,
  recordDigest,
  signal,
  onKeyRequest,
  timeoutMs = 60000,
}) {
  assertRailgunIdentity(identity);
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.equal(typeof onKeyRequest, 'function');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  assert.ok(!signing.has(identity));
  assert.match(recordDigest, /^[0-9a-f]{64}$/);
  const checked = require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(intent);
  const payload = Object.freeze({
    archive: verifyRailgunEngineRuntime(archive),
    intent: checked.data,
    recordDigest,
    spendingPublicKey: Object.freeze(identity.descriptor.spendingPublicKey.map((v) => '0x' + v)),
  });
  const saved = identities.get(identity),
    context = getPrivacyContext(saved.handle),
    revocation = new AbortController(),
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([identity.signal, signal, revocation.signal]),
      isCurrent: () => {
        assertRailgunIdentity(identity);
        return true;
      },
    });
  let handle;
  try {
    handle = scope.getContext({ ...context.subject, operation: 'relay-sign' });
  } catch (error) {
    scope.close();
    throw error;
  }
  const token = Object.freeze({});
  let task,
    sequence = 0,
    value,
    taskClosed,
    outcomeError,
    outcomeFailed = false,
    closureError,
    issued = false,
    brokerFailed = false,
    cleanupFailed = false,
    unobserved = false;
  const current = () => {
    assertRailgunIdentity(identity);
    assert.ok(!brokerFailed && !scope.signal.aborted && task && !task.signal.aborted);
    getPrivacyContext(handle);
  };
  const state = { identity, payload, current, signal: scope.signal, issuing: false },
    requests = new Set(),
    loans = new Set(),
    originals = new Set();
  function observe(original, closure = false) {
    const unknown = () => {
      unobserved = true;
      unobservedRelayWork.add(original);
      quarantineRailgunIdentityCredentials(identity);
    };
    if (!require('util').types.isPromise(original)) {
      if (closure) unknown();
      throw fail();
    }
    const observed = new Promise((resolve, reject) => {
      try {
        Promise.prototype.then.call(original, resolve, (error) => {
          if (closure) unknown();
          reject(error);
        });
      } catch (error) {
        unknown();
        reject(error);
      }
    });
    originals.add(observed);
    observed.then(
      () => originals.delete(observed),
      () => originals.delete(observed)
    );
    return observed;
  }
  function refuseBroker() {
    brokerFailed = true;
    revocation.abort();
  }
  function cleanup(callback) {
    try {
      callback();
    } catch {
      cleanupFailed = true;
    }
  }
  async function dispatch(wire) {
    try {
      current();
      assert.equal(typeof wire, 'string');
      assert.ok(Buffer.byteLength(wire) <= 16384);
      const message = JSON.parse(wire);
      assert.equal(message.id, ++sequence);
      const { shape } = require('./railgun-relay-quote-data');
      if (sequence === 1) {
        shape(message, ['id', 'method', 'purpose', 'recordDigest', 'intentDigest', 'expectedHash']);
        assert.equal(message.method, 'key');
        assert.equal(message.purpose, 'relay-sign');
        assert.equal(message.recordDigest, recordDigest);
        assert.equal(message.intentDigest, checked.digest);
        assert.equal(message.expectedHash, checked.data.expectedHash);
        const request = Object.freeze({
          recordDigest,
          intentDigest: checked.digest,
          expectedHash: checked.data.expectedHash,
        });
        const permit = await observe(onKeyRequest(request, token));
        current();
        const gate = require('./railgun-relay-operation').consumeRailgunRelaySigningPermit(
          permit,
          identity,
          token
        );
        shape(gate, ['assertCurrent', 'issued']);
        assert.equal(typeof gate.assertCurrent, 'function');
        assert.equal(typeof gate.issued, 'function');
        current();
        await observe(gate.assertCurrent());
        current();
        const bytes = await observe(
          saved.keystore.deriveBytesAt(`m/44'/1984'/0'/0'/${saved.accountIndex}'`)
        );
        const releaseLoan = retainLoan(saved.owner, bytes);
        loans.add(releaseLoan);
        const wipe = () => bytes.fill(0);
        scope.signal.addEventListener('abort', wipe, { once: true });
        try {
          current();
          await observe(gate.assertCurrent());
          current();
          // Only this synchronous extent can mark account-window credential
          // issuance. No await or caller-settable flag bridges it to the reply.
          state.issuing = true;
          try {
            const returned = gate.issued();
            // A malformed async hook still owns its original work; observe it
            // before refusal, never await it on the credential-return path.
            if (require('util').types.isPromise(returned)) observe(returned);
            assert.equal(returned, undefined);
          } finally {
            state.issuing = false;
          }
          current();
          issued = true;
          return bytes;
        } catch (error) {
          wipe();
          throw error;
        } finally {
          scope.signal.removeEventListener('abort', wipe);
        }
      }
      assert.equal(sequence, 2);
      assert.equal(issued, true);
      shape(message, ['id', 'method', 'value']);
      assert.equal(message.method, 'result');
      const result = message.value;
      shape(result, [
        'signature',
        'message',
        'recordDigest',
        'intentDigest',
        'guards',
        'inventory',
      ]);
      assert.equal(result.message, checked.data.expectedHash);
      assert.equal(result.recordDigest, recordDigest);
      assert.equal(result.intentDigest, checked.digest);
      assert.equal(result.inventory, require('./railgun-engine-manifest.json').inventory.sha256);
      shape(result.guards, ['attempts', 'canaries', 'hooks']);
      assert.equal(result.guards.attempts, 0);
      assert.ok(
        Array.isArray(result.guards.hooks) &&
          result.guards.hooks.length > 0 &&
          result.guards.hooks.length <= 256 &&
          result.guards.hooks.every(
            (hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook)
          )
      );
      assert.equal(new Set(result.guards.hooks).size, result.guards.hooks.length);
      assert.equal(result.guards.canaries, result.guards.hooks.length);
      value = Object.freeze({
        signature: require('./railgun-private-signature').normalizeRailgunSignature(
          result.signature
        ),
        message: result.message,
        recordDigest,
        intentDigest: checked.digest,
      });
      return JSON.stringify({ id: 2, value: null });
    } catch (error) {
      refuseBroker();
      throw error;
    }
  }
  signing.add(identity);
  relaySigners.set(token, state);
  try {
    task = startRailgunProcess({
      handle,
      filename: require.resolve('./railgun-relay-sign-job'),
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
    taskClosed = observe(task.closed, true);
    await observe(task.ready);
    current();
    assert.ok(value && sequence === 2 && issued && !brokerFailed);
    task.close();
    assert.equal((await taskClosed).code, 'RAILGUN_PROCESS_CLOSED');
    assertRailgunIdentity(identity);
    assert.ok(!scope.signal.aborted);
  } catch (error) {
    outcomeFailed = true;
    outcomeError = error;
  } finally {
    relaySigners.delete(token);
    cleanup(() => revocation.abort());
    cleanup(() => scope.close());
    cleanup(() => task?.close());
    if (taskClosed) {
      try {
        await taskClosed;
      } catch (error) {
        closureError = error;
      }
    }
    // Ordinary rejected callback work is settled; an unobservable original or
    // rejected child closure quarantines this owner instead of claiming drain.
    await Promise.allSettled([...requests, ...originals]);
    for (const releaseLoan of loans) cleanup(releaseLoan);
    if (!unobserved) signing.delete(identity);
  }
  if (unobserved) {
    const error = Object.assign(new Error('Railgun relay signer exit unavailable'), {
      code: 'RAILGUN_WALLET_EXIT_UNOBSERVED',
    });
    unknownRelayFailures.add(error);
    throw error;
  }
  if (closureError) throw closureError;
  if (brokerFailed || cleanupFailed) throw fail();
  if (outcomeFailed) throw outcomeError;
  return value;
}
async function signRailgunRelayIntent(options) {
  try {
    return await signRelayIntent(options);
  } catch (error) {
    if (unknownRelayFailures.delete(error)) throw error;
    throw Object.assign(new Error('Railgun relay signing unavailable'), {
      code: 'RAILGUN_RELAY_SIGNING_REFUSED',
    });
  }
}
function assertRailgunRelaySigner(token, identity, { intent, recordDigest }) {
  const value = relaySigners.get(token);
  assert.ok(value && value.identity === identity);
  value.current();
  assert.equal(value.payload.recordDigest, recordDigest);
  const checked = require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(intent);
  assert.deepEqual(value.payload.intent, checked.data);
  return value.signal;
}
function assertRailgunRelayCredentialIssuance(token, identity, options) {
  const signal = assertRailgunRelaySigner(token, identity, options);
  assert.equal(relaySigners.get(token).issuing, true);
  return signal;
}
module.exports = {
  openRailgunIdentity,
  assertRailgunIdentity,
  quarantineRailgunIdentityCredentials,
  withRailgunViewingCredential,
  signRailgunPrivateIntent,
  assertRailgunPrivateSigner,
  signRailgunRelayIntent,
  assertRailgunRelaySigner,
  assertRailgunRelayCredentialIssuance,
};
