/** Main-owned public generations. Every generation owns its source ledger, public
 * store and journal. Rebuilds retain old files and cannot truncate another ledger.
 * A durable requested-height floor precedes acquisition and survives interruption.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { assertRailgunScanCoordinator } = require('./railgun-scan-coordinator');
const { assertRailgunScanDirectoryClosed } = require('./railgun-scan-journal');
const { assertRailgunSessionDirectoryClosed } = require('./railgun-session-worker');
const { assertRailgunAccountStoreDirectoryClosed } = require('./railgun-store-owners');
const RECORD = 'railgun-public-catalog-v1',
  MAX_GENERATIONS = 72;
const owners = new Set(),
  instances = new WeakSet();
const fail = (code = 'RAILGUN_PUBLIC_CATALOG_REFUSED') =>
  Object.assign(new Error('Railgun public generation requires recovery'), { code });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const height = (v) => Number.isSafeInteger(v) && v >= -1;
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
async function createRailgunPublicCatalog({
  handle,
  directory,
  key,
  binding,
  create = false,
  initialHeight = -1,
  profileGuard,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(digest(binding) && typeof create === 'boolean' && height(initialHeight));
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'storage' &&
      subject.operation === RECORD
  );
  check(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  const owner = getPrivacyStoragePath(handle, directory);
  check(!owners.has(owner));
  owners.add(owner);
  const lease = randomBytes(32).toString('hex'),
    candidates = new WeakSet();
  let storage,
    current,
    closed = false,
    busy = false;
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: context.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const active = () => {
    check(!closed);
    getPrivacyContext(handle);
  };
  function close() {
    if (closed) return;
    closed = true;
    owners.delete(owner);
    scope.close();
  }
  scope.signal.addEventListener('abort', close, { once: true });
  const folder = (id) => path.join(directory, 'railgun-public-' + id);
  function assertClosed(id) {
    const target = folder(id);
    profileGuard?.assert(path.join(target, 'source.sqlite'));
    assertRailgunAccountStoreDirectoryClosed(target);
    assertRailgunSessionDirectoryClosed(target);
    assertRailgunScanDirectoryClosed(target);
  }
  function generation(v, published) {
    if (v === null) return null;
    check(exact(v, published ? ['id', 'policy', 'storeId', 'ledgerId', 'to'] : ['id', 'policy']));
    check(digest(v.id) && digest(v.policy));
    if (published) check(digest(v.storeId) && digest(v.ledgerId) && height(v.to) && v.to >= 0);
    return Object.freeze({ ...v });
  }
  function decode(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 16384);
    const v = JSON.parse(text);
    check(
      exact(v, [
        'version',
        'binding',
        'lease',
        'sequence',
        'highWater',
        'active',
        'pending',
        'generations',
      ])
    );
    check(
      v.version === 1 &&
        v.binding === binding &&
        digest(v.lease) &&
        Number.isSafeInteger(v.sequence) &&
        v.sequence >= 0 &&
        height(v.highWater)
    );
    check(
      Array.isArray(v.generations) &&
        v.generations.length <= MAX_GENERATIONS &&
        v.generations.every(digest) &&
        new Set(v.generations).size === v.generations.length
    );
    const selected = { active: generation(v.active, true), pending: generation(v.pending, false) };
    for (const value of Object.values(selected)) if (value) check(v.generations.includes(value.id));
    check(!selected.active || selected.active.to <= v.highWater);
    check(!selected.active || selected.active.id !== selected.pending?.id);
    return { ...v, ...selected };
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
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  function selected(id) {
    active();
    check(!busy && digest(id));
    const value = current.active?.id === id ? current.active : current.pending;
    check(value?.id === id);
    return Object.freeze({ ...value, directory: folder(id) });
  }
  function candidate(value) {
    const target = folder(value.id);
    profileGuard?.assert(path.join(target, 'source.sqlite'));
    if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
    const stat = fs.lstatSync(target);
    check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(target) === target);
    const token = Object.freeze({ ...value, directory: target });
    candidates.add(token);
    return token;
  }
  try {
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
              version: 1,
              binding,
              lease,
              sequence: 0,
              highWater: initialHeight,
              active: null,
              pending: null,
              generations: [],
            }
          : decode(text);
      current = { ...old, lease, sequence: old.sequence + 1 };
      return encode(current);
    });
    active();
  } catch (error) {
    close();
    throw error;
  }
  async function begin(policy) {
    active();
    check(!busy && digest(policy));
    if (current.pending?.policy === policy) throw fail('RAILGUN_PUBLIC_PENDING_REQUIRES_RESUME');
    if (current.generations.length >= MAX_GENERATIONS)
      throw fail('RAILGUN_PUBLIC_CATALOG_CAPACITY');
    const attest = () => {
      for (const entry of [current.active, current.pending]) if (entry) assertClosed(entry.id);
    };
    attest();
    const next = { id: randomBytes(32).toString('hex'), policy };
    await update((old) => {
      attest();
      return { ...old, pending: next, generations: [...old.generations, next.id] };
    });
    return candidate(next);
  }
  async function protect(id, to) {
    selected(id);
    check(height(to) && to >= 0);
    if (current.active?.id !== id || to <= current.highWater) return;
    await update((old) => {
      check([old.active?.id, old.pending?.id].includes(id));
      return { ...old, highWater: Math.max(old.highWater, to) };
    });
  }
  async function publish(token, coordinator, evidence) {
    active();
    check(!busy && candidates.has(token) && current.pending?.id === token.id);
    const previousId = current.active?.id;
    const attest = () => {
      assertRailgunScanCoordinator(coordinator, handle);
      const identity = coordinator.identity;
      check(
        identity &&
          identity.directory === token.directory &&
          identity.policy === token.policy &&
          identity.binding === binding
      );
      const plan = coordinator.assertSnapshot(evidence);
      check(plan.to.number >= current.highWater && plan.source.ledgerId === identity.ledgerId);
      if (previousId) assertClosed(previousId);
      return {
        id: token.id,
        policy: token.policy,
        storeId: plan.state.storeId,
        ledgerId: plan.source.ledgerId,
        to: plan.to.number,
      };
    };
    attest();
    await update((old) => {
      const next = attest();
      return { ...old, active: next, highWater: Math.max(old.highWater, next.to), pending: null };
    });
    try {
      attest();
    } catch (error) {
      close();
      throw Object.assign(error, { storageCommitted: true });
    }
    candidates.delete(token);
  }
  const instance = Object.freeze({
    binding,
    directory,
    signal: scope.signal,
    close,
    begin,
    protect,
    publish,
    selected,
    inspect() {
      active();
      check(!busy);
      return Object.freeze({
        active: current.active && Object.freeze({ ...current.active }),
        pending: current.pending && Object.freeze({ ...current.pending }),
        highWater: current.highWater,
        retained: current.generations.length,
      });
    },
    resume() {
      active();
      check(!busy && current.pending);
      return candidate(current.pending);
    },
    activeFor(policy) {
      active();
      check(!busy && digest(policy));
      return current.active?.policy === policy ? selected(current.active.id) : null;
    },
    assertActive(id, policy) {
      active();
      check(!busy && current.active?.id === id && current.active.policy === policy);
    },
  });
  instances.add(instance);
  return instance;
}
module.exports = {
  createRailgunPublicCatalog,
  isRailgunPublicCatalog: (value) => instances.has(value),
};
