/** Main-only encrypted TXID write-ahead journal. Persisted service validation is
 * historical evidence only: completing or reopening a checkpoint requires a
 * new live root receipt. No journal record grants event coverage or spending.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes, createHash } = require('crypto');
const { getPrivacyContext, createPrivacyScope } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { ZERO_NODES } = require('./railgun-public-records');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const RECORD = 'freedom-railgun-txid-v1',
  MAX_BYTES = 2 * 1024 * 1024;
const owners = new Set();
const fail = () =>
  Object.assign(new Error('Railgun TXID journal requires recovery'), {
    code: 'RAILGUN_TXID_JOURNAL_REFUSED',
  });
const check = (v) => {
  if (!v) throw fail();
};
const shape = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const field = (v) =>
  digest(v) &&
  BigInt('0x' + v) < 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const integer = (v, max = Number.MAX_SAFE_INTEGER - 1) =>
  Number.isSafeInteger(v) && v >= 0 && v <= max;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
function state(v) {
  check(
    shape(v, [
      'version',
      'count',
      'root',
      'after',
      'verificationHash',
      'branches',
      'breaks',
      'transcript',
    ])
  );
  check(v.version === 1 && integer(v.count, 8000) && field(v.root) && digest(v.transcript));
  check(
    Array.isArray(v.branches) &&
      v.branches.length === 16 &&
      v.branches.every((n) => n === null || field(n))
  );
  if (v.count === 0)
    check(
      v.root === ZERO_NODES[16] &&
        v.after === '0x00' &&
        v.verificationHash === null &&
        v.branches.every((n) => n === null) &&
        Array.isArray(v.breaks) &&
        v.breaks.length === 0 &&
        v.transcript === sha('')
    );
  else {
    check(
      typeof v.after === 'string' &&
        /^0x[0-9a-f]{192}$/.test(v.after) &&
        typeof v.verificationHash === 'string' &&
        /^0x[0-9a-f]{64}$/.test(v.verificationHash)
    );
    classifyRailgunTxidContinuity(v.count - 1, v.breaks);
  }
  return v;
}
function store(v, storeId) {
  check(
    shape(v, ['schema', 'storeId', 'count', 'bytes', 'sha256']) &&
      v.schema === 'wallet-store-v1' &&
      v.storeId === storeId &&
      integer(v.count, 32768) &&
      integer(v.bytes, 64 * 1024 * 1024) &&
      digest(v.sha256)
  );
  return v;
}
function validation(v, expected) {
  check(
    shape(v, ['index', 'root', 'service', 'accepted', 'observedAt', 'latestIndex']) &&
      v.index === expected.count - 1 &&
      v.root === expected.root &&
      v.service === 'sepolia-ppoi-fdi' &&
      v.accepted === true &&
      integer(v.latestIndex, 16 * 65536 - 1) &&
      v.latestIndex >= v.index &&
      typeof v.observedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.observedAt) &&
      Number.isFinite(Date.parse(v.observedAt))
  );
  return v;
}
function work(v) {
  check(shape(v, ['base', 'rows', 'expected']));
  state(v.base);
  state(v.expected);
  check(
    Array.isArray(v.rows) &&
      v.rows.length >= 1 &&
      v.rows.length <= 100 &&
      Buffer.byteLength(JSON.stringify(v.rows)) <= 1024 * 1024 &&
      v.expected.count === v.base.count + v.rows.length &&
      v.expected.after > v.base.after
  );
  return v;
}
async function createRailgunTxidJournal({
  handle,
  directory,
  key,
  profileGuard,
  binding,
  publicIdentity,
  policy,
  session,
  assertResult,
  assertRoot,
  create,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.deployment === 'sepolia' &&
      subject.chainId === 11155111 &&
      subject.role === 'storage' &&
      subject.operation === 'railgun-txid-v1:' + policy
  );
  check(
    typeof directory === 'string' &&
      path.isAbsolute(directory) &&
      digest(binding) &&
      digest(policy) &&
      Buffer.isBuffer(key) &&
      key.length === 32 &&
      typeof create === 'boolean' &&
      typeof assertResult === 'function' &&
      typeof assertRoot === 'function'
  );
  check(
    shape(publicIdentity, ['generationId', 'sourceId', 'publicId']) &&
      Object.values(publicIdentity).every(digest)
  );
  publicIdentity = freeze({ ...publicIdentity });
  check(
    session?.signal instanceof AbortSignal &&
      typeof session.inspectStoreIdentity === 'function' &&
      typeof session.inspectWalletState === 'function' &&
      typeof session.assertFresh === 'function'
  );
  const identity = await session.inspectStoreIdentity();
  session.assertFresh(identity);
  check(identity.format === 'paged-v2' && digest(identity.instanceId));
  const storeId = identity.instanceId;
  directory = fs.realpathSync(directory);
  const owner = getPrivacyStoragePath(handle, directory);
  check(!owners.has(owner));
  owners.add(owner);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: AbortSignal.any([context.signal, session.signal]),
  });
  const lease = randomBytes(32).toString('hex'),
    tokens = new WeakMap();
  let storage,
    current,
    closed = false,
    busy = false;
  const active = () => {
    check(!closed && !scope.signal.aborted);
    getPrivacyContext(handle);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    owners.delete(owner);
    scope.signal.removeEventListener('abort', close);
    scope.close();
  };
  scope.signal.addEventListener('abort', close, { once: true });
  function unpack(text) {
    check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_BYTES);
    const v = JSON.parse(text);
    check(
      shape(v, [
        'version',
        'binding',
        'publicIdentity',
        'storeId',
        'policy',
        'lease',
        'generation',
        'sequence',
        'checkpoint',
        'pending',
      ])
    );
    check(
      v.version === 1 &&
        v.binding === binding &&
        same(v.publicIdentity, publicIdentity) &&
        v.storeId === storeId &&
        v.policy === policy &&
        digest(v.lease) &&
        integer(v.generation) &&
        integer(v.sequence)
    );
    if (v.checkpoint !== null) {
      check(shape(v.checkpoint, ['state', 'store', 'validation']));
      state(v.checkpoint.state);
      check(v.checkpoint.state.count > 0);
      store(v.checkpoint.store, storeId);
      validation(v.checkpoint.validation, v.checkpoint.state);
    }
    if (v.pending !== null) {
      check(shape(v.pending, ['work', 'pageSha256', 'validation']));
      work(v.pending.work);
      check(v.pending.pageSha256 === sha(JSON.stringify(v.pending.work.rows)));
      validation(v.pending.validation, v.pending.work.expected);
      if (v.checkpoint) check(same(v.pending.work.base, v.checkpoint.state));
      else check(v.pending.work.base.count === 0);
    }
    return v;
  }
  const encode = (v) => {
    const text = JSON.stringify(v);
    unpack(text);
    return text;
  };
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
              publicIdentity,
              storeId,
              policy,
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
    session.assertFresh(identity);
  } catch (error) {
    close();
    throw error;
  }
  async function exclusive(run) {
    active();
    check(!busy);
    busy = true;
    try {
      return await run();
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  function owned(v) {
    check(
      v.lease === lease && v.generation === current.generation && v.sequence === current.sequence
    );
  }
  async function read() {
    const value = unpack(await storage.get(RECORD));
    active();
    owned(value);
    return value;
  }
  async function update(change) {
    await storage.update(RECORD, (text) => {
      active();
      const old = unpack(text);
      owned(old);
      current = { ...change(old), sequence: old.sequence + 1 };
      return encode(current);
    });
    active();
  }
  const root = (receipt, expected) =>
    validation(
      assertRoot(receipt, Object.freeze({ index: expected.count - 1, root: expected.root })),
      expected
    );
  const observe = async () => {
    const observed = await session.inspectWalletState();
    active();
    session.assertFresh(observed);
    store(observed, storeId);
    return observed;
  };
  function baseline(value, supplied, observed) {
    state(supplied);
    if (value.checkpoint)
      check(same(supplied, value.checkpoint.state) && same(observed, value.checkpoint.store));
    else check(supplied.count === 0 && observed.count === 0 && observed.bytes === 0);
  }
  function issue() {
    const token = Object.freeze({});
    tokens.set(token, current.sequence);
    return token;
  }
  async function prepare(input, projectionReceipt, rootReceipt) {
    const payload = work(JSON.parse(JSON.stringify(input)));
    return exclusive(async () => {
      const old = await read();
      check(old.pending === null);
      const observed = await observe();
      baseline(old, payload.base, observed);
      const projected = assertResult(projectionReceipt, 'project', {
        base: payload.base,
        rows: payload.rows,
      });
      check(
        same(projected.state, payload.expected) &&
          projected.pageSha256 === sha(JSON.stringify(payload.rows))
      );
      const accepted = root(rootReceipt, payload.expected);
      await update((value) => ({
        ...value,
        pending: { work: payload, pageSha256: projected.pageSha256, validation: accepted },
      }));
      session.assertFresh(observed);
      root(rootReceipt, payload.expected);
      return issue();
    });
  }
  async function resume(inspectReceipt, rootReceipt) {
    return exclusive(async () => {
      const old = await read();
      check(old.pending);
      const observed = await observe(),
        inspected = assertResult(inspectReceipt, 'inspect', {});
      const payload = old.pending.work;
      if (same(inspected.state, payload.base)) baseline(old, payload.base, observed);
      else check(same(inspected.state, payload.expected));
      root(rootReceipt, payload.expected);
      return issue();
    });
  }
  async function complete(token, applyReceipt, rootReceipt) {
    return exclusive(async () => {
      const old = await read();
      check(old.pending && tokens.get(token) === old.sequence);
      const payload = old.pending.work,
        observed = await observe();
      const applied = assertResult(applyReceipt, 'apply', payload);
      check(same(applied.state, payload.expected) && applied.pageSha256 === old.pending.pageSha256);
      const accepted = root(rootReceipt, payload.expected);
      await update((value) => ({
        ...value,
        checkpoint: { state: payload.expected, store: observed, validation: accepted },
        pending: null,
      }));
      tokens.delete(token);
      session.assertFresh(observed);
      root(rootReceipt, payload.expected);
    });
  }
  async function revalidate(inspectReceipt, rootReceipt) {
    return exclusive(async () => {
      const old = await read();
      check(!old.pending);
      const observed = await observe(),
        inspected = assertResult(inspectReceipt, 'inspect', {});
      baseline(old, inspected.state, observed);
      if (old.checkpoint) root(rootReceipt, old.checkpoint.state);
      else check(inspected.initialized === false);
      return freeze(JSON.parse(JSON.stringify(old.checkpoint)));
    });
  }
  return Object.freeze({
    prepare,
    resume,
    complete,
    revalidate,
    close,
    signal: scope.signal,
    readState: () => exclusive(async () => freeze(await read())),
  });
}
module.exports = { createRailgunTxidJournal, RECORD };
