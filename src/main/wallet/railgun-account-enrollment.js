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
const owners = new Set(),
  instances = new WeakSet(),
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
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
async function openRailgunAccountEnrollment({ identity, create = false }) {
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
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([parent.signal, identity.signal, vaultSignal]),
    isCurrent: () => {
      assertRailgunIdentity(identity, parentHandle);
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
  let rootKey, catalog, guard, manifest, reservations, openingReservations;
  const borrowed = new Set();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    rootKey?.fill(0);
    borrowed.forEach((key) => key.fill(0));
    catalog?.close();
    reservations?.close();
    scope.close();
    owners.delete(file);
  }
  scope.signal.addEventListener('abort', close, { once: true });
  function active() {
    check(!closed);
    assertRailgunIdentity(identity, handle);
    check(vaultSignal === vault.getSessionSignal());
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
        Object.keys(v).sort().join(',') === 'account,status' &&
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
      await manifest.update(RECORD, (text) => {
        active();
        check(text === null);
        return JSON.stringify({ account: expected, status: 'pending' });
      });
      current = await manifest.get(RECORD);
    }
    check(current !== null);
    const enrolled = state(current);
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
        return JSON.stringify({ account: expected, status: 'active' });
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
  async function openReservations() {
    active();
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
      guard.assert(target);
      const floorRecord = 'railgun-private-reservations-floor-v1';
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
        check(Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 1024);
        await manifest.update(floorRecord, (text) => {
          active();
          check(sequence >= (decodeFloor(text) ?? 0));
          return JSON.stringify({ version: 1, binding, sequence });
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
        profileGuard: guard,
        create: !fs.existsSync(target),
        readFloor,
        advanceFloor,
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
  const instance = Object.freeze({
    descriptor,
    binding,
    directory: accountDirectory,
    catalog,
    profileGuard: guard,
    signal: scope.signal,
    close,
    openReservations,
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
      check(['engine', 'storage', 'protocol-rpc'].includes(role));
      const next = { ...subject, role };
      delete next.operation;
      if (operation !== undefined) next.operation = operation;
      return scope.getContext(next);
    },
  });
  instances.add(instance);
  return instance;
}
module.exports = {
  openRailgunAccountEnrollment,
  isRailgunAccountEnrollment: (value) => instances.has(value),
};
