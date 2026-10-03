/** Enrolled public scan lifetime. Main owns paths, keys, runtime and coordinator;
 * only this composition can attest the enrolled source/public-store binding.
 */
const fs = require('fs'),
  path = require('path');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { openRailgunAccountStore } = require('./railgun-account-store');
const { createRailgunPublicJobs } = require('./railgun-public-run');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { createRailgunScanSource } = require('./railgun-scan-source');
const {
  createRailgunScanCoordinator,
  assertRailgunScanCoordinator,
} = require('./railgun-scan-coordinator');
const { getPrivacyStoragePath } = require('./privacy-storage');
const { createRailgunPublicCatalog } = require('./railgun-public-catalog');
const { readRailgunScanUpgradeHeight } = require('./railgun-scan-journal');
const { assertRailgunSessionDirectoryClosed } = require('./railgun-session-worker');
const { assertRailgunAccountStoreDirectoryClosed } = require('./railgun-store-owners');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const owners = new Map(),
  coordinators = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun public state requires recovery'), {
    code: 'RAILGUN_ACCOUNT_PUBLIC_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function exists(filename) {
  try {
    const stat = fs.lstatSync(filename);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function openRailgunAccountPublic({
  enrollment,
  archive,
  create = false,
  mode = create ? 'new' : 'active',
}) {
  check(isRailgunAccountEnrollment(enrollment) && typeof create === 'boolean');
  check(['new', 'pending', 'active'].includes(mode));
  const handle = enrollment.getContext('engine'),
    context = getPrivacyContext(handle);
  const policy = getRailgunPublicPolicy(archive);
  check(!owners.has(enrollment.directory));
  const owner = {};
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: enrollment.signal,
    isCurrent: () => {
      enrollment.getContext('engine');
      return true;
    },
  });
  const subject = { ...context.subject };
  delete subject.operation;
  const engineHandle = scope.getContext(subject),
    rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' });
  owners.set(enrollment.directory, owner);
  let sourceStore, publicStore, source, coordinator, onAbort, catalog, generation, candidate;
  const pending = new Set();
  const watched = [];
  const active = () => {
    check(!scope.signal.aborted);
    enrollment.getContext('engine');
  };
  const track = (run) => {
    active();
    const task = Promise.resolve().then(run);
    pending.add(task);
    task.then(
      () => pending.delete(task),
      () => pending.delete(task)
    );
    return task;
  };
  async function close() {
    for (const signal of watched) signal.removeEventListener('abort', onAbort);
    const stop = () => {
      coordinator?.close();
      source?.close();
      sourceStore?.ledger.close();
      publicStore?.session.close();
    };
    stop();
    scope.close();
    await Promise.allSettled([...pending]);
    // An opener already in flight may have returned its worker during draining.
    stop();
    await Promise.all([sourceStore?.session.closed, publicStore?.session.closed]);
    catalog?.close();
    if (owners.get(enrollment.directory) === owner) owners.delete(enrollment.directory);
  }
  onAbort = () => {
    close().catch(() => {});
  };
  const watch = (signal) => {
    check(!signal.aborted);
    watched.push(signal);
    signal.addEventListener('abort', onAbort, { once: true });
  };
  watch(scope.signal);
  try {
    const catalogHandle = scope.getContext({
      ...subject,
      role: 'storage',
      operation: 'railgun-public-catalog-v1',
    });
    const catalogFile = getPrivacyStoragePath(catalogHandle, enrollment.directory);
    enrollment.profileGuard.assert(catalogFile);
    const initializeCatalog = !exists(catalogFile);
    check(!initializeCatalog || create);
    let initialHeight = -1;
    if (initializeCatalog) {
      assertRailgunAccountStoreDirectoryClosed(enrollment.directory);
      assertRailgunSessionDirectoryClosed(enrollment.directory);
      const legacyHandle = scope.getContext({
        ...subject,
        role: 'storage',
        operation: 'railgun-scan-v1',
      });
      const legacyFile = getPrivacyStoragePath(legacyHandle, enrollment.directory);
      enrollment.profileGuard.assert(legacyFile);
      if (exists(legacyFile)) {
        initialHeight = await enrollment.withPublicKeys((keys) =>
          readRailgunScanUpgradeHeight({
            handle: legacyHandle,
            directory: enrollment.directory,
            key: keys['scan-journal'],
            binding: enrollment.binding,
            profileGuard: enrollment.profileGuard,
          })
        );
      } else {
        check(
          !exists(path.join(enrollment.directory, 'source.sqlite')) &&
            !exists(path.join(enrollment.directory, 'public.sqlite'))
        );
      }
    }
    catalog = await enrollment.withPublicCatalogKey((keys) =>
      createRailgunPublicCatalog({
        handle: catalogHandle,
        directory: enrollment.directory,
        key: keys['public-catalog'],
        binding: enrollment.binding,
        create: initializeCatalog,
        initialHeight,
        profileGuard: enrollment.profileGuard,
      })
    );
    active();
    watch(catalog.signal);
    if (mode === 'new') candidate = generation = await catalog.begin(policy);
    else if (mode === 'pending') candidate = generation = catalog.resume();
    else generation = catalog.activeFor(policy);
    check(generation && generation.policy === policy);
    const open = async (kind) => {
      const filename = path.join(generation.directory, kind + '.sqlite');
      enrollment.profileGuard.assert(filename);
      const present = exists(filename);
      check(present || candidate);
      return openRailgunAccountStore({
        enrollment,
        kind,
        generationId: generation.id,
        publicCatalog: catalog,
        create: !present,
      });
    };
    await track(async () => {
      sourceStore = await open('source');
      active();
      watch(sourceStore.ledger.signal);
    });
    await track(async () => {
      publicStore = await open('public');
      active();
      watch(publicStore.session.signal);
    });
    const journalHandle = scope.getContext({
      ...subject,
      role: 'storage',
      operation: 'railgun-scan-v1',
    });
    const journalFile = getPrivacyStoragePath(journalHandle, generation.directory);
    enrollment.profileGuard.assert(journalFile);
    const initializeJournal = !exists(journalFile);
    check(!initializeJournal || candidate);
    if (initializeJournal) {
      sourceStore.ledger.assertEmpty();
      // The whole-store digest counts every record, including unknown namespaces.
      const empty = await publicStore.session.inspectWalletState();
      publicStore.session.assertFresh(empty);
      check(empty.count === 0 && empty.bytes === 0);
    }
    const jobs = createRailgunPublicJobs({ handle: engineHandle, archive });
    source = createRailgunScanSource({
      handle: rpcHandle,
      ledger: sourceStore.ledger,
      beforeAcquire: ({ to }) => catalog.protect(generation.id, to),
      projectRange: (...args) => track(() => jobs.project(...args)),
    });
    await track(async () => {
      coordinator = await enrollment.withPublicGenerationKeys(catalog, generation.id, (keys) =>
        createRailgunScanCoordinator({
          handle: engineHandle,
          storeSession: publicStore.session,
          source,
          journalStorage: {
            directory: generation.directory,
            key: keys['scan-journal'],
            binding: enrollment.binding,
            policy,
            create: initializeJournal,
            profileGuard: enrollment.profileGuard,
          },
          applyRange: (...args) => track(() => jobs.apply(...args)),
        })
      );
    });
    active();
    check(!coordinator.signal.aborted);
    coordinators.set(coordinator, {
      binding: enrollment.binding,
      policy,
      catalog,
      generationId: generation.id,
      sourceId: sourceStore.storeId,
      publicId: publicStore.storeId,
    });
    watch(coordinator.signal);
    const publish = async () => {
      active();
      if (!candidate) return;
      const snapshot = await coordinator.withPublicSnapshot(() => undefined);
      await catalog.publish(candidate, coordinator, snapshot.evidence);
      candidate = null;
    };
    return Object.freeze({
      coordinator,
      policy,
      generationId: generation.id,
      close,
      signal: scope.signal,
      publish: () => track(publish),
      async advance(range) {
        return track(async () => {
          const result = await coordinator.advance(range);
          if (candidate && result.to.number >= catalog.inspect().highWater) await publish();
          return result;
        });
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
function assertRailgunAccountPublic(coordinator, enrollment, policy) {
  check(isRailgunAccountEnrollment(enrollment));
  const entry = coordinators.get(coordinator);
  check(entry && entry.binding === enrollment.binding);
  check(policy === undefined || entry.policy === policy);
  entry.catalog.assertActive(entry.generationId, entry.policy);
  assertRailgunScanCoordinator(coordinator, enrollment.getContext('engine'));
  return entry.policy;
}
function getRailgunAccountPublicIdentity(coordinator, enrollment, policy) {
  assertRailgunAccountPublic(coordinator, enrollment, policy);
  const { generationId, sourceId, publicId } = coordinators.get(coordinator);
  return Object.freeze({ generationId, sourceId, publicId });
}
async function openRailgunAccountPublicTxidStore({
  coordinator,
  enrollment,
  policy,
  txidPolicy,
  create,
}) {
  assertRailgunAccountPublic(coordinator, enrollment, policy);
  const entry = coordinators.get(coordinator);
  const opened = await openRailgunAccountStore({
    enrollment,
    kind: 'txid',
    publicCatalog: entry.catalog,
    generationId: entry.generationId,
    txidPolicy,
    create,
  });
  try {
    assertRailgunAccountPublic(coordinator, enrollment, policy);
    return opened;
  } catch (error) {
    opened.session.close();
    await opened.session.closed;
    throw error;
  }
}
async function withRailgunAccountTxidJournalKey(coordinator, enrollment, policy, txidPolicy, use) {
  assertRailgunAccountPublic(coordinator, enrollment, policy);
  const entry = coordinators.get(coordinator);
  const result = await enrollment.withTxidGenerationKeys(
    entry.catalog,
    entry.generationId,
    txidPolicy,
    (keys) => use(keys['txid-journal'])
  );
  assertRailgunAccountPublic(coordinator, enrollment, policy);
  return result;
}
module.exports = {
  openRailgunAccountPublic,
  assertRailgunAccountPublic,
  getRailgunAccountPublicIdentity,
  openRailgunAccountPublicTxidStore,
  withRailgunAccountTxidJournalKey,
};
