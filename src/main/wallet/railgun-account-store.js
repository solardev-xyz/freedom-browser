/** Trusted host composition for a single enrolled paged store. Newly initialized
 * files are published only after authenticated worker exit. Existing files are
 * always authenticated and never recreated; inventory registration is automatic.
 * This grants no scan readiness. The source/public store IDs must still match
 * their scan journal before a coordinator may use them.
 * Source returns an exclusively claimed ledger owning the worker lifetime;
 * its accompanying session permits inspection and closure, not direct dispatch.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { startRailgunSessionWorker } = require('./railgun-session-worker');
const { createRailgunSourceLedger, railgunSourceBinding } = require('./railgun-source-ledger');
const { claimRailgunAccountStore } = require('./railgun-store-owners');
const fail = () =>
  Object.assign(new Error('Railgun account store requires recovery'), {
    code: 'RAILGUN_ACCOUNT_STORE_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
function realDirectory(target) {
  const stat = fs.lstatSync(target);
  check(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(target) === target);
}
function fileExists(target) {
  try {
    const stat = fs.lstatSync(target);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function openRailgunAccountStore({
  enrollment,
  kind,
  generationId,
  create = false,
  expectedStoreId,
}) {
  check(isRailgunAccountEnrollment(enrollment));
  check(typeof create === 'boolean' && ['source', 'public', 'wallet'].includes(kind));
  check(
    kind === 'wallet'
      ? typeof generationId === 'string' && /^[0-9a-f]{64}$/.test(generationId)
      : generationId === undefined
  );
  check(
    expectedStoreId === undefined ||
      (typeof expectedStoreId === 'string' && /^[0-9a-f]{64}$/.test(expectedStoreId))
  );
  check(!create || expectedStoreId === undefined);
  const handle = enrollment.getContext('engine');
  realDirectory(enrollment.directory);
  const directory =
    kind === 'wallet'
      ? path.join(enrollment.directory, 'railgun-cache-' + generationId)
      : enrollment.directory;
  realDirectory(directory);
  const filename = path.join(directory, kind + '.sqlite');
  const release = claimRailgunAccountStore(filename);
  let worker, ledger;
  const active = () => {
    check(!enrollment.signal.aborted);
    enrollment.getContext('engine');
    realDirectory(enrollment.directory);
    realDirectory(directory);
    enrollment.profileGuard.assert(filename);
  };
  const open = async (name, key, initialize) => {
    active();
    worker = startRailgunSessionWorker({
      handle,
      storage: {
        format: 'paged-v2',
        filename: name,
        key,
        binding: kind === 'source' ? railgunSourceBinding(enrollment.binding) : enrollment.binding,
        create: initialize,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw fail();
        },
      }),
      onClose: () => {},
    });
    await worker.ready;
    const observed = await worker.inspectStoreIdentity();
    worker.assertFresh(observed);
    check(observed.format === 'paged-v2' && /^[0-9a-f]{64}$/.test(observed.instanceId));
    if (kind === 'source') {
      ledger = await createRailgunSourceLedger({
        handle: enrollment.getContext('protocol-rpc'),
        filename: name,
        binding: enrollment.binding,
        create: initialize,
        storeSession: worker,
      });
      check(ledger.identity() === observed.instanceId);
    }
    active();
    return observed.instanceId;
  };
  const use = async (keys) => {
    const key =
      keys[
        kind === 'source' ? 'source-ledger' : kind === 'public' ? 'public-store' : 'wallet-store'
      ];
    active();
    let generation;
    const selectedGeneration = async () => {
      const current = await enrollment.catalog.inspect();
      const selected = current.active?.id === generationId ? current.active : current.pending;
      check(selected?.id === generationId);
      return selected;
    };
    if (kind === 'wallet') {
      generation = await selectedGeneration();
      check(!create || generation.storeId === undefined);
    }
    check(create ? !fileExists(filename) : fileExists(filename));
    let initializedId;
    if (create) {
      // Retain interrupted initializers for review rather than deleting them.
      // Bound the number before allocating another encrypted file.
      const prefix = kind + '.init-';
      check(fs.readdirSync(directory).filter((name) => name.startsWith(prefix)).length < 8);
      const staging = path.join(directory, prefix + randomBytes(16).toString('hex') + '.sqlite');
      initializedId = await open(staging, key, true);
      ledger?.close();
      worker.close();
      await worker.closed;
      worker = null;
      ledger = null;
      active();
      check(!fileExists(filename) && fileExists(staging));
      // Serialized under the application's profile lock and this target owner.
      // Like the existing JSON atomic writer, this assumes a trusted local OS;
      // Node rename has no portable no-replace guarantee against external races.
      fs.renameSync(staging, filename);
      if (process.platform !== 'win32') {
        const fd = fs.openSync(directory, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const storeId = await open(filename, key, false);
    if (initializedId !== undefined) check(storeId === initializedId);
    if (expectedStoreId !== undefined) check(storeId === expectedStoreId);
    if (generation) {
      check(JSON.stringify(await selectedGeneration()) === JSON.stringify(generation));
      if (generation.storeId !== undefined) check(storeId === generation.storeId);
    }
    active();
    enrollment.profileGuard.remember(filename);
    return Object.freeze({ session: worker, storeId, filename, ...(ledger ? { ledger } : {}) });
  };
  try {
    const result = await (kind === 'wallet'
      ? enrollment.withGenerationKeys(generationId, use)
      : enrollment.withPublicKeys(use));
    active();
    worker.closed.then(release);
    return result;
  } catch (error) {
    ledger?.close();
    worker?.close();
    if (worker) await worker.closed;
    release();
    throw error;
  }
}
module.exports = { openRailgunAccountStore };
