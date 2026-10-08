/** Main-only bootstrap port for the future Railgun owner package. Not an IPC,
 * renderer or package facade API. No consumer is activated in this slice.
 * Fixed host derivation remains here temporarily; callers cannot choose paths,
 * read the mnemonic/seed, return a key, or replace any derivation implementation.
 * Original callback errors are internal contracts and must not be serialized.
 */
const { createHash, createHmac } = require('crypto');
const { types } = require('util');
const { isMainThread } = require('worker_threads');
const { mnemonicToSeedSync } = require('@scure/bip39');
const vault = require('./vault');
const { createRailgunKeystore, createRailgunViewingKeystore } = require('./privacy-keys');
const { getPrivacyContext } = require('../networks/privacy-context');
const { getActiveProfile } = require('../profile-resolver');
const { createPrivacyProfileGuard } = require('../wallet/privacy-profile-guard');
const then = Promise.prototype.then;
const fill = Uint8Array.prototype.fill;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const unobserved = new Set();
const fail = () =>
  Object.assign(new Error('Railgun credential unavailable'), {
    code: 'RAILGUN_CREDENTIAL_REFUSED',
  });
function check(value) {
  if (!value) throw fail();
}
function observe(original, onUnobserved) {
  check(types.isPromise(original));
  return new Promise((resolve, reject) => {
    try {
      // Preserve the native original. A hostile constructor/species can make
      // observation impossible: retain the work, never pretend it drained.
      Reflect.apply(then, original, [resolve, reject]);
    } catch {
      unobserved.add(original);
      onUnobserved?.();
    }
  });
}
function capture(request) {
  check(request && typeof request === 'object' && !types.isProxy(request));
  check(Object.getPrototypeOf(request) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(request);
  check(Reflect.ownKeys(descriptors).every((key) => typeof key === 'string'));
  check(
    Reflect.ownKeys(descriptors).sort().join(',') ===
      'accountIndex,handle,purpose,signal,vaultSession'
  );
  for (const descriptor of Object.values(descriptors))
    check(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  return Object.fromEntries(Object.entries(descriptors).map(([name, item]) => [name, item.value]));
}
function createRailgunCredentialHost() {
  check(arguments.length === 0 && isMainThread && !['renderer', 'utility'].includes(process.type));
  function currentSession() {
    check(arguments.length === 0);
    const session = vault.getSessionSignal();
    check(!Reflect.apply(aborted, session, []));
    return session;
  }
  async function withMaterial(request, consume) {
    check(arguments.length === 2 && typeof consume === 'function');
    const { handle, vaultSession, accountIndex, purpose, signal } = capture(request);
    check(
      Number.isInteger(accountIndex) &&
        !Object.is(accountIndex, -0) &&
        accountIndex >= 0 &&
        accountIndex <= 65535
    );
    check(['spending-public', 'viewing', 'spending-sign', 'storage-root'].includes(purpose));
    const context = getPrivacyContext(handle),
      profile = getActiveProfile();
    const subject = context.subject;
    check(
      subject.kind === 'private-account' &&
        subject.principal === `railgun:${accountIndex}` &&
        subject.protocol === 'railgun' &&
        subject.chainId === 11155111 &&
        subject.deployment === 'sepolia'
    );
    check(
      purpose === 'storage-root'
        ? subject.role === 'storage' && subject.operation === 'railgun-account-enrollment-v1'
        : subject.role === 'keystore' &&
            (purpose === 'spending-public'
              ? subject.operation === 'spending-public'
              : purpose === 'spending-sign'
                ? ['spending-sign', 'relay-sign'].includes(subject.operation)
                : [null, 'viewing-identity'].includes(subject.operation))
    );
    const profileId = createHash('sha256')
      .update(JSON.stringify([profile.id, profile.userDataDir]))
      .digest('hex');
    check(profileId === context.profileId);
    // Capture scalar profile identity; do not let a later mutable profile object
    // silently change either the account root binding or guard destination.
    const profileSnapshot = Object.freeze({ id: profile.id, userDataDir: profile.userDataDir });
    const signals = [...new Set([signal, vaultSession, context.signal])];
    for (const value of signals) check(!Reflect.apply(aborted, value, []));
    let bytes;
    const wipe = () => {
      if (!bytes) return;
      try {
        Reflect.apply(fill, bytes, [0]);
      } catch {
        // A detached loan has no accessible bytes. Never replace the original
        // callback/unknown-exit failure or skip remaining lifetime cleanup.
      }
    };
    function active() {
      for (const value of signals) check(!Reflect.apply(aborted, value, []));
      check(vaultSession === vault.getSessionSignal());
      check(getPrivacyContext(handle) === context);
      const current = getActiveProfile();
      check(
        current.id === profileSnapshot.id && current.userDataDir === profileSnapshot.userDataDir
      );
    }
    active();
    for (const value of signals) Reflect.apply(addListener, value, ['abort', wipe, { once: true }]);
    try {
      let profileGuard;
      if (purpose === 'storage-root') {
        const mnemonic = vault.getMnemonic();
        check(typeof mnemonic === 'string' && mnemonic.length > 0);
        const seed = mnemonicToSeedSync(mnemonic);
        try {
          active();
          bytes = createHmac('sha256', seed)
            .update('Freedom Railgun account storage v1\0')
            .update(JSON.stringify([context.profileId, accountIndex, 11155111, 'sepolia']))
            .digest();
          // The guard belongs to the original enrollment context, not this
          // material callback. Catalog/store callers may retain it after this
          // root loan settles; its original context abort owns MAC-key wiping.
          profileGuard = createPrivacyProfileGuard({ handle, profile: profileSnapshot, seed });
        } finally {
          Reflect.apply(fill, seed, [0]);
        }
      } else {
        const keystore = (
          purpose === 'viewing' ? createRailgunViewingKeystore : createRailgunKeystore
        )(handle, accountIndex);
        const original = keystore.deriveBytesAt(
          `m/${purpose === 'viewing' ? 420 : 44}'/1984'/0'/0'/${accountIndex}'`
        );
        bytes = await observe(original);
      }
      active();
      check(
        bytes instanceof Uint8Array &&
          bytes.byteLength === 32 &&
          bytes.byteOffset === 0 &&
          bytes.buffer.byteLength === 32 &&
          bytes.buffer instanceof ArrayBuffer
      );
      const original = consume(
        Object.freeze(purpose === 'storage-root' ? { bytes, profileGuard } : { bytes })
      );
      const result = await observe(original, wipe);
      check(result === undefined);
      // Enrollment retains its root loan until close: it first revokes the
      // genuine context and wipes material, then releases this original callback.
      // Observed void settlement is drainage, not renewed storage authority.
      // A vault lock/profile switch may cause this teardown too. Rechecking
      // currency after it would quarantine a fully drained account until restart.
      if (!(
        purpose === 'storage-root' &&
        Reflect.apply(aborted, signal, []) &&
        Reflect.apply(aborted, context.signal, [])
      ))
        active();
    } finally {
      wipe();
      for (const value of signals) Reflect.apply(removeListener, value, ['abort', wipe]);
    }
  }
  return Object.freeze({ currentSession, withMaterial });
}
module.exports = { createRailgunCredentialHost };
