/** Encrypted pointer to the last qualified derived-cache generation. A rebuild
 * lives in a fresh directory and becomes active only after journal readiness.
 * Old generations and interrupted candidates remain on disk for recovery.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { assertRailgunSessionDirectoryClosed } = require('./railgun-session-worker');
const { assertRailgunAccountStoreDirectoryClosed } = require('./railgun-store-owners');
const {
  isRailgunWalletJournal,
  assertRailgunWalletGenerationClosed,
} = require('./railgun-wallet-journal');
const RECORD = 'railgun-wallet-catalog-v1',
  owners = new Set();
const MAX_RETIRED = 64;
const fail = () =>
  Object.assign(new Error('Railgun wallet catalog unavailable'), {
    code: 'RAILGUN_WALLET_CATALOG_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
async function createRailgunWalletCatalog({
  handle,
  directory,
  key,
  binding,
  walletId,
  create = false,
  profileGuard,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(digest(binding) && digest(walletId) && typeof create === 'boolean');
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'storage' &&
      subject.operation === 'railgun-wallet-catalog-v1:' + walletId
  );
  check(path.isAbsolute(directory));
  directory = fs.realpathSync(directory);
  const owner = getPrivacyStoragePath(handle, directory);
  check(!owners.has(owner));
  owners.add(owner);
  const lease = randomBytes(32).toString('hex'),
    candidates = new WeakMap();
  let scope,
    storage,
    current,
    closed = false,
    busy = false;
  const active = () => {
    check(!closed);
    getPrivacyContext(handle);
  };
  function close() {
    if (closed) return;
    closed = true;
    owners.delete(owner);
    scope?.close();
    context.signal.removeEventListener('abort', close);
  }
  context.signal.addEventListener('abort', close, { once: true });
  function generation(v, published = false) {
    if (v === null) return null;
    check(
      exact(v, published ? ['id', 'policy', 'storeId'] : ['id', 'policy']) &&
        digest(v.id) &&
        digest(v.policy)
    );
    if (published) check(digest(v.storeId));
    return Object.freeze({ ...v });
  }
  function decode(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 16384);
    const v = JSON.parse(text);
    check(
      exact(v, [
        'version',
        'walletId',
        'binding',
        'lease',
        'sequence',
        'active',
        'pending',
        'generations',
        ...(v.version === 2 ? ['retired'] : []),
      ]) &&
        [1, 2].includes(v.version) &&
        v.walletId === walletId &&
        v.binding === binding &&
        digest(v.lease) &&
        Number.isSafeInteger(v.sequence) &&
        v.sequence >= 0
    );
    const retired = v.version === 1 ? [] : v.retired;
    check(
      Array.isArray(retired) &&
        retired.length <= MAX_RETIRED &&
        retired.every(digest) &&
        new Set(retired).size === retired.length &&
        retired.every((id) => !v.generations.includes(id))
    );
    check(
      Array.isArray(v.generations) &&
        v.generations.length <= 8 &&
        v.generations.every(digest) &&
        new Set(v.generations).size === v.generations.length
    );
    for (const value of [v.active, v.pending]) if (value) check(v.generations.includes(value.id));
    return {
      ...v,
      version: 2,
      retired,
      active: generation(v.active, true),
      pending: generation(v.pending),
    };
  }
  function encode(v) {
    check(v.sequence < Number.MAX_SAFE_INTEGER);
    const text = JSON.stringify(v);
    check(Buffer.byteLength(text) <= 16384);
    return text;
  }
  async function update(change) {
    active();
    check(!busy);
    busy = true;
    try {
      await storage.update(RECORD, (text) => {
        active();
        const old = decode(text);
        check(old.lease === lease && old.sequence === current.sequence);
        current = { ...change(old), sequence: old.sequence + 1 };
        return encode(current);
      });
      active();
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  function folder(id) {
    return path.join(directory, 'railgun-cache-' + id);
  }
  function directoryFor(id, createDirectory) {
    const target = folder(id);
    if (createDirectory) fs.mkdirSync(target, { mode: 0o700 });
    const stat = fs.lstatSync(target);
    check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(target) === target);
    return target;
  }
  function candidate(value) {
    const token = Object.freeze({
      id: value.id,
      policy: value.policy,
      directory: directoryFor(value.id, false),
    });
    candidates.set(token, current.sequence);
    return token;
  }
  try {
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: context.signal,
      isCurrent: () => {
        getPrivacyContext(handle);
        return true;
      },
    });
    storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard,
    });
    await storage.update(RECORD, (text) => {
      active();
      check(create ? text === null : text !== null);
      const old =
        text === null
          ? {
              version: 2,
              walletId,
              binding,
              lease,
              sequence: 0,
              active: null,
              pending: null,
              generations: [],
              retired: [],
            }
          : decode(text);
      current = { ...old, lease, sequence: old.sequence + 1 };
      return encode(current);
    });
    active();
  } catch {
    close();
    throw fail();
  }
  async function begin(policy) {
    active();
    check(!busy);
    check(digest(policy));
    if (current.generations.length >= 8)
      throw Object.assign(fail(), { code: 'RAILGUN_WALLET_CATALOG_CAPACITY' });
    const next = { id: randomBytes(32).toString('hex'), policy };
    await update((old) => {
      check(old.generations.length < 8);
      return { ...old, pending: next, generations: [...old.generations, next.id] };
    });
    try {
      directoryFor(next.id, true);
      return candidate(next);
    } catch {
      close();
      throw fail();
    }
  }
  async function inspectState() {
    active();
    check(!busy);
    busy = true;
    try {
      const value = decode(await storage.get(RECORD));
      active();
      check(value.lease === lease && value.sequence === current.sequence);
      return value;
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
    }
  }
  async function inspect() {
    const value = await inspectState();
    return Object.freeze({ active: value.active, pending: value.pending });
  }
  async function inspectRetention() {
    const value = await inspectState();
    return Object.freeze({
      inactive: Object.freeze(
        value.generations.filter((id) => id !== value.active?.id && id !== value.pending?.id)
      ),
      retired: Object.freeze([...value.retired]),
      retiredLimit: MAX_RETIRED,
      listed: value.generations.length,
    });
  }
  async function retireInactive() {
    const observed = await inspectState();
    active();
    check(!busy && observed.sequence === current.sequence);
    const inactive = observed.generations.filter(
      (id) => id !== observed.active?.id && id !== observed.pending?.id
    );
    if (!inactive.length) return Object.freeze([]);
    if (observed.retired.length >= MAX_RETIRED)
      throw Object.assign(fail(), { code: 'RAILGUN_WALLET_RETIRED_CAPACITY' });
    const ids = inactive.slice(0, MAX_RETIRED - observed.retired.length);
    const attest = () => {
      for (const id of ids) {
        const location = folder(id);
        assertRailgunAccountStoreDirectoryClosed(location);
        profileGuard?.assert(path.join(location, 'wallet.sqlite'));
        try {
          const stat = fs.lstatSync(location);
          check(
            stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(location) === location
          );
        } catch (error) {
          // An authenticated candidate can have been recorded before mkdir.
          // Missing inventoried files already refuse above; retain the id anyway.
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        assertRailgunWalletGenerationClosed(location);
        assertRailgunSessionDirectoryClosed(location);
      }
    };
    attest();
    await update((old) => {
      check(old.sequence === observed.sequence);
      for (const id of ids)
        check(id !== old.active?.id && id !== old.pending?.id && old.generations.includes(id));
      attest();
      return {
        ...old,
        generations: old.generations.filter((id) => !ids.includes(id)),
        retired: [...old.retired, ...ids],
      };
    });
    return Object.freeze(ids);
  }
  async function resume() {
    const value = await inspect();
    check(value.pending);
    return candidate(value.pending);
  }
  async function publish(token, journal) {
    active();
    check(isRailgunWalletJournal(journal));
    check(candidates.get(token) === current.sequence && current.pending?.id === token.id);
    const previousId = current.active?.id;
    function attest() {
      check(isRailgunWalletJournal(journal));
      if (previousId) assertRailgunWalletGenerationClosed(directoryFor(previousId, false));
      const identity = journal.identity;
      check(
        identity &&
          identity.walletId === walletId &&
          identity.policy === token.policy &&
          digest(identity.storeId) &&
          identity.directory === directoryFor(token.id, false)
      );
      const ready = journal.assertReady();
      check(ready.status === 'wallet-scanned-unverified' && ready.spendableGranted === false);
      return { id: token.id, policy: token.policy, storeId: identity.storeId };
    }
    attest(); // Expected refusal (e.g. a living old view) must not close the catalog.
    await update((old) => {
      check(old.pending?.id === token.id);
      return { ...old, active: attest(), pending: null };
    });
    try {
      attest();
    } catch {
      close();
      throw Object.assign(fail(), { storageCommitted: true });
    }
    candidates.delete(token);
  }
  return Object.freeze({
    begin,
    resume,
    inspect,
    inspectRetention,
    retireInactive,
    publish,
    close,
    signal: scope.signal,
    activeFor(policy) {
      active();
      check(!busy && digest(policy));
      if (!current.active || current.active.policy !== policy) return null;
      return Object.freeze({
        ...current.active,
        directory: directoryFor(current.active.id, false),
      });
    },
  });
}
module.exports = { createRailgunWalletCatalog };
