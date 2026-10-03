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
async function openRailgunAccountPublic({ enrollment, archive, create = false }) {
  check(isRailgunAccountEnrollment(enrollment) && typeof create === 'boolean');
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
  let sourceStore, publicStore, source, coordinator, onAbort;
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
    const open = async (kind) => {
      const filename = path.join(enrollment.directory, kind + '.sqlite');
      enrollment.profileGuard.assert(filename);
      const present = exists(filename);
      check(present || create);
      return openRailgunAccountStore({ enrollment, kind, create: !present });
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
    const journalFile = getPrivacyStoragePath(journalHandle, enrollment.directory);
    enrollment.profileGuard.assert(journalFile);
    const initializeJournal = !exists(journalFile);
    check(!initializeJournal || create);
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
      projectRange: (...args) => track(() => jobs.project(...args)),
    });
    await track(async () => {
      coordinator = await enrollment.withPublicKeys((keys) =>
        createRailgunScanCoordinator({
          handle: engineHandle,
          storeSession: publicStore.session,
          source,
          journalStorage: {
            directory: enrollment.directory,
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
      sourceId: sourceStore.storeId,
      publicId: publicStore.storeId,
    });
    watch(coordinator.signal);
    return Object.freeze({ coordinator, policy, close, signal: scope.signal });
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
  assertRailgunScanCoordinator(coordinator, enrollment.getContext('engine'));
  return entry.policy;
}
module.exports = { openRailgunAccountPublic, assertRailgunAccountPublic };
