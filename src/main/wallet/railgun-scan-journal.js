/** Main-only write-ahead scan journal. Separate encrypted storage and scope are
 * supplied by the host; no engine command can reach this capability. A persisted
 * checkpoint is a recovery claim, never a balance, completeness or spend grant.
 */
const path = require('path');
const fs = require('fs');
const { emptyPublicState } = require('./railgun-public-records');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { randomBytes } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const owners = new Set();
const retentions = new WeakMap();
function readRailgunSourceRetention(token, ledgerId) {
  const entry = retentions.get(token);
  check(entry && entry.value.ledgerId === ledgerId);
  entry.assertFresh();
  return entry.value;
}
const RECORD_KEY = 'freedom-railgun-host-scan-v1';
const MAX_RECORD = 128 * 1024;
const fail = (code = 'RAILGUN_SCAN_REFUSED') =>
  Object.assign(new Error('Railgun scan unavailable'), { code });
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const integer = (value, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= 0 && value <= max;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const hash = (value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const check = (condition) => {
  if (!condition) throw fail();
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function block(value) {
  check(exact(value, ['number', 'hash']) && integer(value.number) && hash(value.hash));
  return { number: value.number, hash: value.hash };
}
function scanState(value) {
  check(exact(value, ['schema', 'storeId', 'trees', 'commitments', 'nullifiers', 'unshields']));
  check(value.schema === 'public-records-v1' && digest(value.storeId));
  check(Array.isArray(value.trees) && value.trees.length <= 256);
  const trees = value.trees.map((tree, index) => {
    check(
      exact(tree, ['tree', 'length', 'root']) &&
        tree.tree === index &&
        integer(tree.length, 65536) &&
        hash(tree.root)
    );
    check(
      BigInt(tree.root) <
        21888242871839275222246405745257275088548364400416034343698204186575808495617n
    );
    return { tree: index, length: tree.length, root: tree.root };
  });
  const namespaces = {};
  for (const name of ['commitments', 'nullifiers', 'unshields']) {
    check(
      exact(value[name], ['count', 'sha256']) &&
        integer(value[name].count, 2000000) &&
        digest(value[name].sha256)
    );
    namespaces[name] = { count: value[name].count, sha256: value[name].sha256 };
  }
  check(trees.reduce((sum, tree) => sum + tree.length, 0) === namespaces.commitments.count);
  return { schema: value.schema, storeId: value.storeId, trees, ...namespaces };
}
function plan(value) {
  check(exact(value, ['from', 'previousHash', 'to', 'anchor', 'logs', 'source', 'state']));
  check(exact(value.source, ['level', 'providersSha256', 'ledgerId', 'ledgerSha256']));
  check(
    value.source.level === 'unverified-rpc' &&
      digest(value.source.providersSha256) &&
      digest(value.source.ledgerId) &&
      digest(value.source.ledgerSha256)
  );
  check(integer(value.from) && hash(value.previousHash));
  const to = block(value.to),
    anchor = block(value.anchor);
  check(value.from <= to.number && to.number <= anchor.number);
  if (to.number === anchor.number) check(to.hash === anchor.hash);
  check(
    exact(value.logs, ['count', 'sha256']) &&
      integer(value.logs.count, 100000) &&
      digest(value.logs.sha256)
  );
  return {
    from: value.from,
    previousHash: value.previousHash,
    to,
    anchor,
    logs: { count: value.logs.count, sha256: value.logs.sha256 },
    source: { ...value.source },
    state: scanState(value.state),
  };
}
// Provider provenance can be renewed only when every content field is identical.
function sameRangeContent(left, right) {
  const normalize = (value) => {
    const result = plan(value);
    delete result.source.providersSha256;
    return JSON.stringify(result);
  };
  return normalize(left) === normalize(right);
}
function unpack(text, binding, storeId, ledgerId) {
  check(typeof text === 'string' && Buffer.byteLength(text) <= MAX_RECORD);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail();
  }
  check(
    exact(value, [
      'version',
      'binding',
      'storeId',
      'ledgerId',
      'generation',
      'lease',
      'sequence',
      'checkpoint',
      'pending',
    ])
  );
  check(
    value.version === 2 &&
      value.binding === binding &&
      value.storeId === storeId &&
      value.ledgerId === ledgerId
  );
  check(integer(value.generation) && digest(value.lease) && integer(value.sequence));
  const checkpoint = value.checkpoint === null ? null : plan(value.checkpoint);
  const pending = value.pending === null ? null : plan(value.pending);
  for (const item of [checkpoint, pending])
    if (item) check(item.state.storeId === storeId && item.source.ledgerId === ledgerId);
  if (pending) contiguous(checkpoint, pending);
  return {
    version: 2,
    binding,
    storeId,
    ledgerId,
    generation: value.generation,
    lease: value.lease,
    sequence: value.sequence,
    checkpoint,
    pending,
  };
}
function contiguous(checkpoint, next) {
  check(next.from === (checkpoint ? checkpoint.to.number + 1 : 0));
  check(next.previousHash === (checkpoint ? checkpoint.to.hash : '0x' + '0'.repeat(64)));
  if (!checkpoint) return;
  check(next.anchor.number >= checkpoint.anchor.number);
  if (next.anchor.number === checkpoint.anchor.number)
    check(next.anchor.hash === checkpoint.anchor.hash);
  check(next.source.ledgerId === checkpoint.source.ledgerId);
  check(next.state.trees.length >= checkpoint.state.trees.length);
  for (let i = 0; i < checkpoint.state.trees.length; i++) {
    const previous = checkpoint.state.trees[i],
      current = next.state.trees[i];
    if (i < checkpoint.state.trees.length - 1) check(current.length === previous.length);
    else check(current.length >= previous.length);
    if (current.length === previous.length) check(current.root === previous.root);
  }
  for (const namespace of ['commitments', 'nullifiers', 'unshields'])
    check(next.state[namespace].count >= checkpoint.state[namespace].count);
}
async function createRailgunScanJournal({
  handle,
  directory,
  key,
  profileGuard,
  binding,
  ledgerId,
  storeSession,
  assertSource,
}) {
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.role === 'storage' &&
      subject.operation === 'railgun-scan-v1'
  );
  check(
    typeof directory === 'string' &&
      path.isAbsolute(directory) &&
      digest(binding) &&
      digest(ledgerId) &&
      Buffer.isBuffer(key) &&
      key.length === 32
  );
  check(
    typeof storeSession?.inspectStoreIdentity === 'function' &&
      typeof storeSession?.assertFresh === 'function' &&
      storeSession.signal instanceof AbortSignal
  );
  const identity = await storeSession.inspectStoreIdentity();
  storeSession.assertFresh(identity);
  check(identity.format === 'paged-v2' && digest(identity.instanceId));
  const storeId = identity.instanceId;
  check(typeof assertSource === 'function');
  directory = fs.realpathSync(directory);
  const owner = getPrivacyStoragePath(handle, directory);
  if (owners.has(owner)) throw fail('RAILGUN_SCAN_BUSY');
  owners.add(owner);
  const lease = randomBytes(32).toString('hex'),
    tokens = new WeakMap();
  let storage,
    storageScope,
    current,
    closed = false,
    busy = false,
    retaining = false,
    baselineEvidence = null;
  const active = () => {
    if (closed || storeSession.signal.aborted) throw fail();
    getPrivacyContext(handle);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    baselineEvidence = null;
    owners.delete(owner);
    storageScope?.close();
    context.signal.removeEventListener('abort', close);
    storeSession.signal.removeEventListener('abort', close);
  };
  context.signal.addEventListener('abort', close, { once: true });
  storeSession.signal.addEventListener('abort', close, { once: true });
  function synchronous(assertion, expected, evidence) {
    // Returning a Promise/boolean is not synchronous host attestation. Assertions
    // must throw on stale/forged observations and return undefined on success.
    check(assertion(freeze(JSON.parse(JSON.stringify(expected))), evidence) === undefined);
    active();
  }
  function encode(value) {
    check(value.sequence < Number.MAX_SAFE_INTEGER && value.generation < Number.MAX_SAFE_INTEGER);
    const text = JSON.stringify(value);
    check(Buffer.byteLength(text) <= MAX_RECORD);
    return text;
  }
  try {
    storageScope = createPrivacyScope({
      profileId: context.profileId,
      signal: context.signal,
      isCurrent: () => {
        getPrivacyContext(handle);
        return true;
      },
    });
    const storageSubject = { ...subject };
    storage = createPrivacyStorage({
      handle: storageScope.getContext(storageSubject),
      directory,
      key,
      profileGuard,
    });
    await storage.update(RECORD_KEY, (text) => {
      active();
      const old =
        text === null
          ? {
              version: 2,
              binding,
              storeId,
              ledgerId,
              generation: 0,
              lease,
              sequence: 0,
              checkpoint: null,
              pending: null,
            }
          : unpack(text, binding, storeId, ledgerId);
      current = { ...old, generation: old.generation + 1, lease, sequence: old.sequence + 1 };
      return encode(current);
    });
    active();
    storeSession.assertFresh(identity);
  } catch (error) {
    close();
    throw error;
  }
  async function update(change) {
    active();
    if (busy || retaining) throw fail('RAILGUN_SCAN_BUSY');
    busy = true;
    try {
      await storage.update(RECORD_KEY, (text) => {
        active();
        const old = unpack(text, binding, storeId, ledgerId);
        check(
          old.lease === lease &&
            old.generation === current.generation &&
            old.sequence === current.sequence
        );
        const next = change(old);
        current = { ...next, sequence: old.sequence + 1 };
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
  async function readState() {
    active();
    if (busy || retaining) throw fail('RAILGUN_SCAN_BUSY');
    const text = await storage.get(RECORD_KEY);
    active();
    const value = unpack(text, binding, storeId, ledgerId);
    check(
      value.lease === lease &&
        value.sequence === current.sequence &&
        value.generation === current.generation
    );
    return freeze(JSON.parse(JSON.stringify(value)));
  }
  function assertState(expected, evidence) {
    storeSession.assertFresh(evidence);
    check(JSON.stringify(scanState(evidence)) === JSON.stringify(expected));
  }
  async function prepare(input, sourceEvidence) {
    const next = plan(input);
    check(next.state.storeId === storeId && next.source.ledgerId === ledgerId);
    await update((old) => {
      if (!old.pending) {
        check(baselineEvidence);
        storeSession.assertFresh(baselineEvidence);
      }
      synchronous(assertSource, next, sourceEvidence);
      contiguous(old.checkpoint, next);
      if (old.pending) check(sameRangeContent(old.pending, next));
      return { ...old, pending: next };
    });
    const token = Object.freeze({});
    tokens.set(token, { sequence: current.sequence, plan: next });
    return token;
  }
  async function complete(token, { source: sourceEvidence, state: stateEvidence }) {
    const work = tokens.get(token);
    check(work && work.sequence === current.sequence);
    await update((old) => {
      check(old.pending && JSON.stringify(old.pending) === JSON.stringify(work.plan));
      synchronous(assertSource, work.plan, sourceEvidence);
      assertState(work.plan.state, stateEvidence);
      return { ...old, checkpoint: old.pending, pending: null };
    });
    tokens.delete(token);
    try {
      assertState(work.plan.state, stateEvidence);
      baselineEvidence = stateEvidence;
    } catch {
      close();
      throw Object.assign(fail('RAILGUN_SCAN_STATE_CHANGED_AFTER_COMMIT'), {
        storageCommitted: true,
      });
    }
  }
  async function revalidate({ source: sourceEvidence, state: stateEvidence, plan: input }) {
    baselineEvidence = null;
    try {
      const value = await readState();
      check(!value.pending);
      const checkpoint = input ? plan(input) : value.checkpoint;
      if (input) check(value.checkpoint && sameRangeContent(value.checkpoint, checkpoint));
      if (checkpoint) synchronous(assertSource, checkpoint, sourceEvidence);
      assertState(checkpoint?.state ?? emptyPublicState(storeId), stateEvidence);
      if (input && JSON.stringify(checkpoint) !== JSON.stringify(value.checkpoint)) {
        await update((old) => {
          check(!old.pending && sameRangeContent(old.checkpoint, checkpoint));
          synchronous(assertSource, checkpoint, sourceEvidence);
          assertState(checkpoint.state, stateEvidence);
          return { ...old, checkpoint };
        });
        assertState(checkpoint.state, stateEvidence);
      }
      baselineEvidence = stateEvidence;
      // Diagnostic only: the journal does not establish chain trust or POI.
      return Object.freeze({
        status: value.checkpoint ? 'applied-unverified' : 'unscanned',
        sequence: current.sequence,
      });
    } catch (error) {
      baselineEvidence = null;
      throw error;
    }
  }
  async function authorizeSourceRetention() {
    const value = await readState(),
      token = Object.freeze({});
    retentions.set(token, {
      value: Object.freeze({
        ledgerId,
        checkpoint: value.checkpoint?.source.ledgerSha256 ?? null,
        pending: value.pending?.source.ledgerSha256 ?? null,
      }),
      assertFresh: () => {
        active();
        check(!busy && current.sequence === value.sequence);
      },
    });
    return token;
  }
  async function withSourceRetention(action) {
    check(typeof action === 'function');
    const token = await authorizeSourceRetention();
    let locked = false;
    try {
      readRailgunSourceRetention(token, ledgerId);
      check(!retaining);
      retaining = true;
      locked = true;
      return await action(token);
    } finally {
      if (locked) retaining = false;
      retentions.delete(token);
    }
  }
  return Object.freeze({
    prepare,
    complete,
    readState,
    revalidate,
    withSourceRetention,
    close,
  });
}
module.exports = {
  createRailgunScanJournal,
  RECORD_KEY,
  scanState,
  plan,
  sameRangeContent,
  readRailgunSourceRetention,
};
