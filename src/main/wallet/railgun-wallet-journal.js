/** Main-owned durable wallet scan state. Coverage positions live in encrypted
 * host-only cache pages; this journal keeps only source/cache identities and
 * bounded set digests. Read readiness never grants chain trust, POI or spending.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { plan: normalizePlan } = require('./railgun-scan-journal');
const {
  kinds,
  checkpointHash,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
  assertRailgunWalletCheckpointFollows: follows,
} = require('./railgun-wallet-coverage');
const owners = new Set(),
  RECORD_KEY = 'railgun-wallet-journal-v1';
const instances = new WeakSet(),
  liveGenerations = new Map();
function assertRailgunWalletGenerationClosed(directory) {
  check(!liveGenerations.has(fs.realpathSync(directory)));
}
const fail = () =>
  Object.assign(new Error('Railgun wallet journal unavailable'), {
    code: 'RAILGUN_WALLET_JOURNAL_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
function walletState(v, storeId) {
  check(
    exact(v, ['schema', 'storeId', 'count', 'bytes', 'sha256']) &&
      v.schema === 'wallet-store-v1' &&
      v.storeId === storeId &&
      integer(v.count, 32768) &&
      integer(v.bytes, 64 * 1024 * 1024) &&
      digest(v.sha256)
  );
  return { schema: v.schema, storeId, count: v.count, bytes: v.bytes, sha256: v.sha256 };
}
function summary(v) {
  check(exact(v, kinds));
  return Object.fromEntries(
    kinds.map((kind) => {
      check(
        exact(v[kind], ['count', 'sha256']) &&
          integer(v[kind].count, 10000) &&
          digest(v[kind].sha256)
      );
      return [kind, { count: v[kind].count, sha256: v[kind].sha256 }];
    })
  );
}
function target(v) {
  check(exact(v, ['plan', 'hash']));
  const plan = normalizePlan(v.plan);
  check(v.hash === checkpointHash(plan));
  return { plan, hash: v.hash };
}
function createRailgunWalletJournal(options) {
  return openJournal(options, false);
}
/** Existing completed state only: no lease acquisition, rotation or repair. */
function openRailgunWalletJournalReadOnly(options) {
  check(options && !Object.hasOwn(options, 'create'));
  return openJournal(options, true);
}
async function openJournal(
  {
    handle,
    directory,
    key,
    binding,
    walletId,
    policy,
    storeSession,
    coverageStore,
    coordinator,
    assertScan,
    create = false,
    profileGuard,
  },
  readOnly
) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(digest(binding) && digest(walletId) && digest(policy) && typeof create === 'boolean');
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'storage' &&
      subject.operation === 'railgun-wallet-v1:' + walletId
  );
  check(path.isAbsolute(directory) && Buffer.isBuffer(key) && key.length === 32);
  check(
    typeof storeSession?.inspectWalletState === 'function' &&
      typeof storeSession.closed?.then === 'function' &&
      typeof storeSession.assertFresh === 'function' &&
      typeof coverageStore?.assertCoverage === 'function' &&
      coverageStore.session === storeSession &&
      typeof assertScan === 'function' &&
      typeof coordinator?.assertSnapshot === 'function'
  );
  let identity, storeId;
  directory = fs.realpathSync(directory);
  const owner = getPrivacyStoragePath(handle, directory);
  check(!owners.has(owner));
  owners.add(owner);
  let lease = readOnly ? undefined : randomBytes(32).toString('hex');
  const tokens = new WeakMap();
  let initializing = true;
  let closed = false,
    busy = false,
    current,
    ready = null,
    storage,
    scope;
  let lifetime;
  const releaseGeneration = () => {
    if (lifetime?.journalClosed && lifetime?.workerClosed) {
      const live = liveGenerations.get(directory);
      live?.delete(lifetime);
      if (live?.size === 0) liveGenerations.delete(directory);
    }
  };
  const active = () => {
    check(
      !closed &&
        !storeSession.signal.aborted &&
        !coverageStore.signal.aborted &&
        !coordinator.signal.aborted
    );
    getPrivacyContext(handle);
  };
  function releaseOwner() {
    if (!closed || initializing || busy) return;
    if (lifetime) lifetime.journalClosed = true;
    releaseGeneration();
    owners.delete(owner);
  }
  function close() {
    if (closed) return;
    closed = true;
    releaseOwner();
    ready = null;
    scope?.close();
    for (const signal of [
      context.signal,
      storeSession.signal,
      coverageStore.signal,
      coordinator.signal,
    ])
      signal.removeEventListener('abort', close);
  }
  for (const signal of [
    context.signal,
    storeSession.signal,
    coverageStore.signal,
    coordinator.signal,
  ])
    signal.addEventListener('abort', close, { once: true });
  lifetime = { journalClosed: false, workerClosed: false };
  if (!liveGenerations.has(directory)) liveGenerations.set(directory, new Set());
  liveGenerations.get(directory).add(lifetime);
  storeSession.closed.then(() => {
    lifetime.workerClosed = true;
    releaseGeneration();
  }, close);
  function unpack(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= 128 * 1024);
    const v = JSON.parse(text);
    check(
      exact(v, [
        'version',
        'binding',
        'walletId',
        'policy',
        'storeId',
        'lease',
        'generation',
        'sequence',
        'checkpoint',
        'pending',
      ]) &&
        v.version === 1 &&
        v.binding === binding &&
        v.walletId === walletId &&
        v.policy === policy &&
        v.storeId === storeId &&
        digest(v.lease) &&
        integer(v.generation) &&
        integer(v.sequence)
    );
    let checkpoint = null;
    if (v.checkpoint !== null) {
      check(exact(v.checkpoint, ['target', 'wallet', 'coverage']));
      checkpoint = {
        target: target(v.checkpoint.target),
        wallet: walletState(v.checkpoint.wallet, storeId),
        coverage: summary(v.checkpoint.coverage),
      };
    }
    const pending = v.pending === null ? null : target(v.pending);
    if (pending) follows(checkpoint?.target.plan, pending.plan);
    return { ...v, checkpoint, pending };
  }
  function encode(v) {
    check(v.sequence < Number.MAX_SAFE_INTEGER && v.generation < Number.MAX_SAFE_INTEGER);
    const text = JSON.stringify(v);
    check(Buffer.byteLength(text) <= 128 * 1024);
    return text;
  }
  try {
    active();
    if (readOnly) {
      check(typeof profileGuard?.assertRegistered === 'function');
      profileGuard.assertRegistered(owner);
    }
    identity = await storeSession.inspectStoreIdentity();
    active();
    storeSession.assertFresh(identity);
    check(identity.format === 'paged-v2' && digest(identity.instanceId));
    storeId = identity.instanceId;
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: context.signal,
      isCurrent: () => {
        getPrivacyContext(handle);
        return true;
      },
    });
    if (readOnly) {
      check(typeof profileGuard?.assertRegistered === 'function');
      profileGuard.assertRegistered(owner);
    }
    storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard: readOnly
        ? {
            assert: (file) => profileGuard.assertRegistered(file),
            remember: (file) => profileGuard.assertRegistered(file),
          }
        : profileGuard,
    });
    if (readOnly) {
      current = unpack(await storage.get(RECORD_KEY));
      check(current.checkpoint && !current.pending);
      lease = current.lease;
    } else
      await storage.update(RECORD_KEY, (text) => {
        active();
        check(create ? text === null : text !== null);
        const old =
          text === null
            ? {
                version: 1,
                binding,
                walletId,
                policy,
                storeId,
                lease,
                generation: 0,
                sequence: 0,
                checkpoint: null,
                pending: null,
              }
            : unpack(text);
        current = { ...old, lease, generation: old.generation + 1, sequence: old.sequence + 1 };
        return encode(current);
      });
    active();
    storeSession.assertFresh(identity);
  } catch {
    close();
    throw fail();
  } finally {
    initializing = false;
    releaseOwner();
  }
  function owned(v) {
    check(
      v.lease === lease && v.generation === current.generation && v.sequence === current.sequence
    );
  }
  async function update(change) {
    check(!readOnly);
    active();
    check(!busy);
    busy = true;
    try {
      await storage.update(RECORD_KEY, (text) => {
        active();
        const old = unpack(text);
        owned(old);
        const next = change(old);
        current = { ...next, sequence: old.sequence + 1 };
        return encode(current);
      });
      active();
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
      releaseOwner();
    }
  }
  async function readState() {
    active();
    check(!busy);
    busy = true;
    try {
      const text = await storage.get(RECORD_KEY);
      active();
      const value = unpack(text);
      owned(value);
      return freeze(value);
    } catch {
      close();
      throw fail();
    } finally {
      busy = false;
      releaseOwner();
    }
  }
  async function prepare(input) {
    const plan = normalizePlan(input),
      next = { plan, hash: checkpointHash(plan) };
    ready = null;
    await update((old) => {
      follows(old.checkpoint?.target.plan, plan);
      follows(old.pending?.plan, plan);
      return { ...old, pending: next };
    });
    const token = Object.freeze({});
    tokens.set(token, { sequence: current.sequence, target: next });
    return token;
  }
  function attest(targetValue, { snapshot, state, coverage, receipt }, mode) {
    active();
    const plan = normalizePlan(coordinator.assertSnapshot(snapshot));
    check(checkpointHash(plan) === targetValue.hash);
    check(coverageStore.assertCoverage(coverage, receipt) === undefined);
    check(checkpointHash(coverage.checkpoint) === targetValue.hash);
    const normalized = normalizeRailgunWalletCoverage(plan, coverage.coverage),
      sets = summarizeRailgunWalletCoverage(normalized);
    check(JSON.stringify(sets) === JSON.stringify(summary(coverage.summary)));
    check(storeSession.assertFresh(state) === undefined);
    const wallet = walletState(state, storeId);
    check(wallet.count > 0);
    check(
      assertScan(receipt, {
        session: storeSession,
        walletId,
        policy,
        checkpoint: plan,
        summary: sets,
        state,
        mode,
      }) === undefined
    );
    return { target: { plan, hash: targetValue.hash }, wallet, coverage: summary(sets) };
  }
  async function complete(token, evidence) {
    const work = tokens.get(token);
    check(work && work.sequence === current.sequence);
    ready = null;
    await update((old) => {
      check(old.pending?.hash === work.target.hash);
      const next = attest(work.target, evidence);
      if (old.checkpoint?.target.hash === next.target.hash) {
        check(JSON.stringify(old.checkpoint.coverage) === JSON.stringify(next.coverage));
        check(JSON.stringify(old.checkpoint.wallet) === JSON.stringify(next.wallet));
      }
      return { ...old, pending: null, checkpoint: next };
    });
    try {
      const next = attest(work.target, evidence);
      check(JSON.stringify(next) === JSON.stringify(current.checkpoint));
      ready = { sequence: current.sequence, evidence: Object.freeze({ ...evidence }) };
    } catch {
      close();
      throw Object.assign(fail(), { storageCommitted: true });
    }
    tokens.delete(token);
  }
  async function revalidate(evidence) {
    ready = null;
    const value = await readState();
    check(value.checkpoint && !value.pending);
    const next = attest(value.checkpoint.target, evidence, 'restore');
    check(
      JSON.stringify(next.wallet) === JSON.stringify(value.checkpoint.wallet) &&
        JSON.stringify(next.coverage) === JSON.stringify(value.checkpoint.coverage)
    );
    ready = { sequence: current.sequence, evidence: Object.freeze({ ...evidence }) };
    return assertReady();
  }
  function assertReady() {
    active();
    check(
      !busy &&
        ready &&
        ready.sequence === current.sequence &&
        current.checkpoint &&
        !current.pending
    );
    const next = attest(current.checkpoint.target, ready.evidence);
    check(
      JSON.stringify(next.wallet) === JSON.stringify(current.checkpoint.wallet) &&
        JSON.stringify(next.coverage) === JSON.stringify(current.checkpoint.coverage)
    );
    return freeze({
      status: 'wallet-scanned-unverified',
      to: { ...next.target.plan.to },
      coverage: next.coverage,
      spendableGranted: false,
    });
  }
  function assertReceipt(receipt) {
    const readiness = assertReady();
    check(ready.evidence.receipt === receipt);
    return readiness;
  }
  const instance = Object.freeze({
    identity: Object.freeze({ walletId, policy, storeId, directory }),
    ...(readOnly ? {} : { prepare, complete }),
    readState,
    revalidate,
    assertReady,
    assertReceipt,
    close,
    signal: scope.signal,
  });
  instances.add(instance);
  return instance;
}
module.exports = {
  createRailgunWalletJournal,
  openRailgunWalletJournalReadOnly,
  RECORD_KEY,
  isRailgunWalletJournal: (value) => instances.has(value),
  assertRailgunWalletGenerationClosed,
};
