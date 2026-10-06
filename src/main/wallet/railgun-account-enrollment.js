/** Main-only account manifest and storage-key lifetime. Enrollment authenticates
 * the account, not scan readiness or spendability. Runtime/policy changes belong
 * to catalog generations. No renderer, engine or generic derivation API.
 */
const fs = require('fs'),
  path = require('path');
const { createHash, createHmac } = require('crypto');
const { mnemonicToSeedSync } = require('@scure/bip39');
const vault = require('../identity/vault');
const { getActiveProfile } = require('../profile-resolver');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { assertRailgunIdentity } = require('./railgun-identity');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { createPrivacyProfileGuard } = require('./privacy-profile-guard');
const { createRailgunWalletCatalog } = require('./railgun-wallet-catalog');
const { isRailgunPublicCatalog } = require('./railgun-public-catalog');
const { createRailgunPrivateReservations } = require('./railgun-private-reservations');
const { createRailgunPrivateCapsuleStore } = require('./railgun-private-capsule-store');
const { createRailgunPoiIntentStore } = require('./railgun-poi-intent-store');
const { openRailgunAccountFence } = require('./railgun-account-fence');
const owners = new Set(),
  instances = new WeakSet(),
  fencedInstances = new WeakMap(),
  RECORD = 'railgun-account-enrollment-v1';
const fail = () =>
  Object.assign(new Error('Railgun account requires recovery'), {
    code: 'RAILGUN_ACCOUNT_ENROLLMENT_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const hash = (v) => createHash('sha256').update(v).digest('hex');
function directory(target, create = false) {
  if (create) {
    fs.mkdirSync(target, { mode: 0o700 });
    if (process.platform !== 'win32') {
      const fd = fs.openSync(path.dirname(target), 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  const stat = fs.lstatSync(target);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(target) === target);
  return target;
}
function regularFileIfPresent(target) {
  try {
    const stat = fs.lstatSync(target);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}
async function openAccountEnrollment({ identity, create = false }, cooperative) {
  check(typeof create === 'boolean');
  const descriptor = assertRailgunIdentity(identity),
    parent = openPrivacySession(),
    profile = getActiveProfile(),
    vaultSignal = vault.getSessionSignal();
  const subject = {
    kind: 'private-account',
    principal: `railgun:${descriptor.accountIndex}`,
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'storage',
    operation: RECORD,
  };
  const parentHandle = parent.getContext(subject),
    context = getPrivacyContext(parentHandle);
  assertRailgunIdentity(identity, parentHandle);
  check(!vaultSignal.aborted && vault.getMnemonic());
  // A moved or aliased profile must be deliberately recovered; don't redirect
  // persistent account state through symlinks or silently change its identity.
  directory(profile.userDataDir);
  let fence;
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([parent.signal, identity.signal, vaultSignal]),
    isCurrent: () => {
      assertRailgunIdentity(identity, parentHandle);
      fence?.assertCurrent();
      return vaultSignal === vault.getSessionSignal();
    },
  });
  const base = path.join(profile.userDataDir, 'wallet-railgun-accounts');
  let handle, file, accountDirectory;
  try {
    handle = scope.getContext(subject);
    file = getPrivacyStoragePath(handle, base);
    accountDirectory = path.join(base, 'account-' + path.basename(file, '.json'));
  } catch (error) {
    scope.close();
    throw error;
  }
  if (owners.has(file)) {
    scope.close();
    throw fail();
  }
  owners.add(file);
  let rootKey,
    catalog,
    guard,
    manifest,
    reservations,
    openingReservations,
    capsules,
    openingCapsules,
    poiIntents,
    openingPoiIntents,
    relayRecovery,
    openingRelayRecovery;
  const borrowed = new Set();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    // A synchronous enrollment close cannot establish original-work drainage.
    // Marked accounts retain their main connection until this process exits.
    fence?.retainUntilExit();
    rootKey?.fill(0);
    borrowed.forEach((key) => key.fill(0));
    catalog?.close();
    capsules?.close();
    poiIntents?.close();
    relayRecovery?.close();
    reservations?.close();
    scope.close();
    owners.delete(file);
  }
  scope.signal.addEventListener('abort', close, { once: true });
  function active() {
    check(!closed);
    assertRailgunIdentity(identity, handle);
    check(vaultSignal === vault.getSessionSignal());
    fence?.assertCurrent();
    check(!closed);
  }
  function derive(purpose, generation = null) {
    active();
    return createHmac('sha256', rootKey)
      .update(JSON.stringify([1, purpose, generation]))
      .digest();
  }
  const expected = JSON.stringify({
    version: 1,
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    descriptor,
  });
  const binding = hash(expected);
  function state(text) {
    const v = JSON.parse(text);
    check(
      v &&
        (Object.keys(v).sort().join(',') === 'account,status' ||
          (Object.keys(v).sort().join(',') === 'account,status,writerFence' &&
            v.writerFence === 'main-sqlite-v1')) &&
        v.account === expected &&
        ['pending', 'active'].includes(v.status)
    );
    return v;
  }
  try {
    const seed = mnemonicToSeedSync(vault.getMnemonic());
    let key;
    try {
      rootKey = createHmac('sha256', seed)
        .update('Freedom Railgun account storage v1\0')
        .update(JSON.stringify([context.profileId, descriptor.accountIndex, 11155111, 'sepolia']))
        .digest();
      // Shared profile inventory bootstraps before account namespace creation.
      // The account fence does not serialize other profiles/accounts/protocols.
      guard = createPrivacyProfileGuard({ handle, profile, seed });
      directory(base, !fs.existsSync(base));
      regularFileIfPresent(file);
      key = derive('account-manifest');
      manifest = createPrivacyStorage({ handle, directory: base, key, profileGuard: guard });
    } finally {
      seed.fill(0);
      key?.fill(0);
    }
    let current = await manifest.get(RECORD);
    active();
    if (create) {
      check(current === null && !fs.existsSync(accountDirectory));
      // Both current-build creation paths claim the same absent namespace before
      // writing pending state. Never adopt/recreate an interrupted empty slot.
      directory(accountDirectory, true);
      if (cooperative) {
        fence = openRailgunAccountFence({ directory: accountDirectory, create: true });
        if (closed) fence.retainUntilExit();
        active();
      }
      await manifest.update(RECORD, (text) => {
        active();
        check(text === null);
        return JSON.stringify({
          account: expected,
          status: 'pending',
          ...(cooperative ? { writerFence: 'main-sqlite-v1' } : {}),
        });
      });
      current = await manifest.get(RECORD);
    }
    check(current !== null);
    const enrolled = state(current);
    const marked = Object.hasOwn(enrolled, 'writerFence');
    check(!cooperative || marked);
    // A downgraded marker must not select an unfenced path while the cooperative
    // file remains, including malformed or dangling-link substitutions.
    if (!marked) check(!regularFileIfPresent(path.join(accountDirectory, 'writer-fence.sqlite')));
    if (marked && !fence) {
      directory(accountDirectory);
      fence = openRailgunAccountFence({ directory: accountDirectory, create: false });
      if (closed) fence.retainUntilExit();
      active();
      const locked = await manifest.get(RECORD);
      active();
      check(locked === current);
      state(locked);
    }
    // Marked interrupted creation requires explicit recovery, not an implicit
    // catalog/lease repair. Legacy pending enrollment keeps its prior behavior.
    check(!marked || create || enrolled.status === 'active');
    directory(accountDirectory, enrolled.status === 'pending' && !fs.existsSync(accountDirectory));
    const catalogHandle = scope.getContext({
      ...subject,
      operation: 'railgun-wallet-catalog-v1:' + descriptor.walletId,
    });
    const catalogFile = getPrivacyStoragePath(catalogHandle, accountDirectory);
    regularFileIfPresent(catalogFile);
    guard.assert(catalogFile);
    const catalogCreate = enrolled.status === 'pending' && !fs.existsSync(catalogFile);
    const catalogKey = derive('wallet-catalog');
    try {
      catalog = await createRailgunWalletCatalog({
        handle: catalogHandle,
        directory: accountDirectory,
        key: catalogKey,
        binding,
        walletId: descriptor.walletId,
        create: catalogCreate,
        profileGuard: guard,
      });
    } finally {
      catalogKey.fill(0);
    }
    active();
    if (enrolled.status === 'pending')
      await manifest.update(RECORD, (text) => {
        active();
        check(text === current);
        return JSON.stringify({ ...enrolled, status: 'active' });
      });
    active();
  } catch (error) {
    close();
    if (error.code?.startsWith('PRIVATE_PROFILE_')) throw error;
    throw fail();
  }
  async function withKeys(purposes, generation, use) {
    active();
    check(typeof use === 'function');
    const keys = Object.fromEntries(
      purposes.map((purpose) => [purpose, derive(purpose, generation)])
    );
    Object.values(keys).forEach((key) => borrowed.add(key));
    try {
      const result = await use(Object.freeze(keys));
      active();
      return result;
    } finally {
      Object.values(keys).forEach((key) => {
        borrowed.delete(key);
        key.fill(0);
      });
    }
  }
  const registeredGuard = {
    assert: (target) => guard.assertRegistered(target),
    remember: (target) => guard.assertRegistered(target),
  };
  const privateStorageTarget = (kind) => {
    const handle = scope.getContext({
      ...subject,
      operation: `railgun-private-${kind}-v1:` + descriptor.walletId,
    });
    return getPrivacyStoragePath(handle, accountDirectory);
  };
  const assertPrivateStorageRegistered = (kind) => {
    const target = privateStorageTarget(kind);
    check(regularFileIfPresent(target));
    guard.assertRegistered(target);
    active();
  };
  async function openReservations(existingOnly = false) {
    active();
    if (existingOnly) assertPrivateStorageRegistered('reservations');
    if (reservations && !reservations.signal.aborted) return reservations;
    check(!openingReservations);
    openingReservations = true;
    let key;
    try {
      const reservationHandle = scope.getContext({
        ...subject,
        operation: 'railgun-private-reservations-v1:' + descriptor.walletId,
      });
      const target = getPrivacyStoragePath(reservationHandle, accountDirectory);
      regularFileIfPresent(target);
      (existingOnly ? registeredGuard : guard).assert(target);
      const floorRecord = 'railgun-private-reservations-floor-v1';
      const decodeFloor = (text) => {
        if (text === null) return null;
        const value = JSON.parse(text);
        if (value?.version === 4) {
          check(
            fence &&
              Object.keys(value).sort().join(',') === 'binding,sequence,version,walletId' &&
              value.binding === binding &&
              value.walletId === descriptor.walletId &&
              Number.isSafeInteger(value.sequence) &&
              value.sequence >= 0 &&
              value.sequence <= 1024
          );
          return Object.freeze({ ...value });
        }
        check(
          value &&
            Object.keys(value).sort().join(',') === 'binding,sequence,version' &&
            value.version === 1 &&
            value.binding === binding &&
            Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 &&
            value.sequence <= 1024
        );
        return value.sequence;
      };
      const readFloor = async () => {
        active();
        const value = state(await manifest.get(RECORD));
        active();
        check(value.status === 'active');
        const result = decodeFloor(await manifest.get(floorRecord));
        active();
        return result;
      };
      const advanceFloor = async (sequence) => {
        active();
        const typed = typeof sequence === 'object' && sequence !== null;
        const next = typed ? decodeFloor(JSON.stringify(sequence)) : sequence;
        check(
          typed
            ? fence && next?.version === 4
            : !fence && Number.isSafeInteger(next) && next >= 0 && next <= 1024
        );
        await manifest.update(floorRecord, (text) => {
          active();
          const previous = decodeFloor(text);
          check(typed || previous?.version !== 4);
          check((typed ? next.sequence : next) >= (previous?.sequence ?? previous ?? 0));
          return JSON.stringify(typed ? next : { version: 1, binding, sequence: next });
        });
        active();
      };
      key = derive('private-reservations');
      reservations = await createRailgunPrivateReservations({
        handle: reservationHandle,
        directory: accountDirectory,
        key,
        binding,
        walletId: descriptor.walletId,
        profileGuard: existingOnly ? registeredGuard : guard,
        create: !existingOnly && !fs.existsSync(target),
        readFloor,
        advanceFloor,
        ...(fence ? { enrollment: instance } : {}),
        authorizeSigning: (permit, heldStore, receipt, evidence) =>
          require('./railgun-private-capsule-store').consumeRailgunCapsuleSigningPermit(
            permit,
            capsules,
            heldStore,
            receipt,
            evidence
          ),
        claimRecovery: () =>
          require('./railgun-account-phase').claimRailgunAccountPhase(instance, 'recovery'),
      });
      active();
      return reservations;
    } finally {
      key?.fill(0);
      openingReservations = false;
    }
  }
  // Fixed fenced storage port only. Opening authenticates local custody, not
  // review, proof validity, a signing permit or permission to release a hold.
  async function openRelayRecoveryStore(options = {}) {
    check(options && typeof options === 'object' && !require('util').types.isProxy(options));
    const keys = Reflect.ownKeys(options);
    check(keys.length <= 1 && keys.every((name) => name === 'existingOnly'));
    require('./railgun-relay-quote-data').shape(options, keys);
    const existingOnly = Object.hasOwn(options, 'existingOnly') ? options.existingOnly : false;
    active();
    assertRailgunFencedAccountEnrollment(instance);
    check(typeof existingOnly === 'boolean');
    const record = 'railgun-relay-local-recovery-v4',
      relayHandle = scope.getContext({ ...subject, operation: record + ':' + descriptor.walletId }),
      target = getPrivacyStoragePath(relayHandle, accountDirectory),
      present = regularFileIfPresent(target);
    if (existingOnly) {
      check(present);
      guard.assertRegistered(target);
    } else guard.assert(target);
    if (relayRecovery && !relayRecovery.signal.aborted) return relayRecovery;
    check(!openingRelayRecovery);
    openingRelayRecovery = true;
    let key;
    try {
      const floorRecord = 'railgun-relay-local-recovery-floor-v4';
      const decodeFloor = (text) => {
        if (text === null) return null;
        const value = JSON.parse(text);
        check(
          value &&
            Object.keys(value).sort().join(',') === 'binding,sequence,version,walletId' &&
            value.version === 4 &&
            value.binding === binding &&
            value.walletId === descriptor.walletId &&
            Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 &&
            value.sequence <=
              require('./railgun-relay-recovery-data').RAILGUN_RELAY_LOCAL_LIMITS.sequence
        );
        return Object.freeze({ ...value });
      };
      const readFloor = async () => {
        active();
        const value = state(await manifest.get(RECORD));
        active();
        check(value.status === 'active');
        const minimum = decodeFloor(await manifest.get(floorRecord));
        active();
        return minimum;
      };
      const advanceFloor = async (value) => {
        active();
        const next = decodeFloor(JSON.stringify(value));
        check(next !== null);
        await manifest.update(floorRecord, (text) => {
          active();
          check(next.sequence >= (decodeFloor(text)?.sequence ?? 0));
          return JSON.stringify(next);
        });
        active();
      };
      key = derive('relay-local-recovery-v4');
      borrowed.add(key);
      relayRecovery =
        await require('./railgun-relay-recovery-store').createRailgunRelayRecoveryStore({
          enrollment: instance,
          handle: relayHandle,
          directory: accountDirectory,
          key,
          binding,
          walletId: descriptor.walletId,
          profileGuard: guard,
          create: !existingOnly && !present,
          readFloor,
          advanceFloor,
        });
      active();
      return relayRecovery;
    } finally {
      key?.fill(0);
      borrowed.delete(key);
      openingRelayRecovery = false;
    }
  }
  async function openPrivateCapsules(existingOnly = false) {
    active();
    if (existingOnly) assertPrivateStorageRegistered('capsules');
    if (capsules && !capsules.signal.aborted) return capsules;
    check(!openingCapsules);
    openingCapsules = true;
    let key;
    try {
      const held = await openReservations(existingOnly);
      active();
      const capsuleHandle = scope.getContext({
        ...subject,
        operation: 'railgun-private-capsules-v1:' + descriptor.walletId,
      });
      const target = getPrivacyStoragePath(capsuleHandle, accountDirectory);
      regularFileIfPresent(target);
      (existingOnly ? registeredGuard : guard).assert(target);
      const floorRecord = 'railgun-private-capsules-floor-v1';
      const decodeFloor = (text) => {
        if (text === null) return null;
        const value = JSON.parse(text);
        check(
          value &&
            Object.keys(value).sort().join(',') === 'binding,sequence,version' &&
            value.version === 1 &&
            value.binding === binding &&
            Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 &&
            value.sequence <= 96
        );
        return value.sequence;
      };
      const readFloor = async () => {
        active();
        const value = state(await manifest.get(RECORD));
        active();
        check(value.status === 'active');
        const result = decodeFloor(await manifest.get(floorRecord));
        active();
        return result;
      };
      const advanceFloor = async (sequence) => {
        active();
        check(Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 96);
        await manifest.update(floorRecord, (text) => {
          active();
          check(sequence >= (decodeFloor(text) ?? 0));
          return JSON.stringify({ version: 1, binding, sequence });
        });
        active();
      };
      key = derive('private-capsules');
      capsules = await createRailgunPrivateCapsuleStore({
        handle: capsuleHandle,
        directory: accountDirectory,
        key,
        binding,
        walletId: descriptor.walletId,
        profileGuard: existingOnly ? registeredGuard : guard,
        reservations: held,
        create: !existingOnly && !fs.existsSync(target),
        readFloor,
        advanceFloor,
      });
      active();
      return capsules;
    } finally {
      key?.fill(0);
      openingCapsules = false;
    }
  }
  async function openPrivateRecoveryStores() {
    active();
    const phase = require('./railgun-account-phase').claimRailgunAccountPhase(instance, 'recovery');
    try {
      // Check both files before either ordinary lease/floor opener can write.
      // This route may authenticate/refresh existing journals, but never creates
      // recovery history or registers an unknown file as a side effect.
      assertPrivateStorageRegistered('reservations');
      assertPrivateStorageRegistered('capsules');
      const capsules = await openPrivateCapsules(true);
      phase.assertCurrent();
      active();
      return Object.freeze({ reservations, capsules });
    } finally {
      phase.release();
    }
  }
  async function openPoiIntents(options = {}) {
    let existingOnly;
    try {
      check(options && typeof options === 'object' && !Array.isArray(options));
      const keys = Reflect.ownKeys(options);
      check(keys.length <= 1 && keys.every((name) => name === 'existingOnly'));
      existingOnly = Object.hasOwn(options, 'existingOnly') ? options.existingOnly : false;
      check(typeof existingOnly === 'boolean');
    } catch {
      throw fail();
    }
    active();
    let intentHandle, target;
    const locate = () => {
      intentHandle = scope.getContext({
        ...subject,
        operation: 'railgun-poi-intents-v1:' + descriptor.walletId,
      });
      target = getPrivacyStoragePath(intentHandle, accountDirectory);
    };
    // Review/recovery must not create missing history, even when a cached
    // instance exists. Refuse before inventory checks, key derivation or writes.
    if (existingOnly) {
      locate();
      check(regularFileIfPresent(target));
    }
    if (poiIntents && !poiIntents.signal.aborted) return poiIntents;
    check(!openingPoiIntents);
    openingPoiIntents = true;
    let key;
    try {
      if (poiIntents) await poiIntents.closed;
      active();
      if (!intentHandle) locate();
      // Repeat after a retired store's drain; presence before that await is
      // insufficient. The factory also receives create:false to close the race.
      const present = regularFileIfPresent(target);
      if (existingOnly) check(present);
      guard.assert(target);
      const floorRecord = 'railgun-poi-intents-floor-v1';
      const decodeFloor = (text) => {
        if (text === null) return null;
        const value = JSON.parse(text);
        check(
          value &&
            Object.keys(value).sort().join(',') === 'binding,sequence,version' &&
            value.version === 1 &&
            value.binding === binding &&
            Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 &&
            value.sequence <= 128
        );
        return value.sequence;
      };
      const readFloor = async () => {
        active();
        const value = state(await manifest.get(RECORD));
        active();
        check(value.status === 'active');
        const result = decodeFloor(await manifest.get(floorRecord));
        active();
        return result;
      };
      const advanceFloor = async (sequence) => {
        active();
        check(Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 128);
        await manifest.update(floorRecord, (text) => {
          active();
          check(sequence >= (decodeFloor(text) ?? 0));
          return JSON.stringify({ version: 1, binding, sequence });
        });
        active();
      };
      key = derive('poi-intents');
      borrowed.add(key);
      poiIntents = await createRailgunPoiIntentStore({
        enrollment: instance,
        handle: intentHandle,
        directory: accountDirectory,
        key,
        binding,
        walletId: descriptor.walletId,
        profileGuard: guard,
        create: existingOnly ? false : !fs.existsSync(target),
        readFloor,
        advanceFloor,
      });
      active();
      return poiIntents;
    } finally {
      key?.fill(0);
      borrowed.delete(key);
      openingPoiIntents = false;
    }
  }
  const instance = Object.freeze({
    descriptor,
    binding,
    directory: accountDirectory,
    catalog,
    profileGuard: guard,
    signal: scope.signal,
    close,
    openReservations: () => openReservations(),
    openPrivateCapsules: () => openPrivateCapsules(),
    openPrivateRecoveryStores,
    openRelayRecoveryStore,
    openPoiIntents,
    // Trusted host composition only. Callers must not retain copies of these
    // borrowed buffers; a worker must own/wipe any explicitly copied key.
    withPublicKeys: (use) => withKeys(['source-ledger', 'public-store', 'scan-journal'], null, use),
    withPublicCatalogKey: (use) => withKeys(['public-catalog'], null, use),
    async withPublicGenerationKeys(publicCatalog, id, use) {
      active();
      check(
        isRailgunPublicCatalog(publicCatalog) &&
          publicCatalog.binding === binding &&
          publicCatalog.directory === accountDirectory
      );
      const generation = publicCatalog.selected(id);
      directory(generation.directory);
      return withKeys(['source-ledger', 'public-store', 'scan-journal'], id, use);
    },
    async withTxidGenerationKeys(publicCatalog, id, policy, use) {
      active();
      check(
        isRailgunPublicCatalog(publicCatalog) &&
          publicCatalog.binding === binding &&
          publicCatalog.directory === accountDirectory &&
          typeof policy === 'string' &&
          /^[0-9a-f]{64}$/.test(policy)
      );
      const generation = publicCatalog.selected(id);
      publicCatalog.assertActive(id, generation.policy);
      directory(generation.directory);
      check(typeof generation.storeId === 'string' && /^[0-9a-f]{64}$/.test(generation.storeId));
      return withKeys(['txid-store', 'txid-journal'], [id, generation.storeId, policy], use);
    },
    async withGenerationKeys(id, use) {
      active();
      check(typeof id === 'string' && /^[0-9a-f]{64}$/.test(id));
      const current = await catalog.inspect();
      active();
      check([current.active?.id, current.pending?.id].includes(id));
      directory(path.join(accountDirectory, 'railgun-cache-' + id));
      return withKeys(['wallet-store', 'wallet-journal'], id, use);
    },
    getContext(role, operation) {
      active();
      check(
        ['engine', 'storage', 'protocol-rpc'].includes(role) ||
          (role === 'prover' && ['private-verify', 'poi-verify'].includes(operation))
      );
      const next = { ...subject, role };
      delete next.operation;
      if (operation !== undefined) next.operation = operation;
      return scope.getContext(next);
    },
  });
  instances.add(instance);
  if (fence) fencedInstances.set(instance, active);
  return instance;
}
function openRailgunAccountEnrollment(options) {
  return openAccountEnrollment(options, false);
}
function openRailgunCooperativeAccountEnrollment(options) {
  return openAccountEnrollment(options, true);
}
function assertRailgunFencedAccountEnrollment(value) {
  const current = fencedInstances.get(value);
  check(current);
  current();
}
module.exports = {
  openRailgunAccountEnrollment,
  openRailgunCooperativeAccountEnrollment,
  assertRailgunFencedAccountEnrollment,
  isRailgunAccountEnrollment: (value) => instances.has(value),
};
