/** Account-level input holds. Only never-signed holds may be abandoned. Durable
 * signing records are not operation authority; the key-release API must also
 * require the registered operation and all fresh intent/selection/POI gates.
 */
const fs = require('fs'),
  path = require('path');
const { randomBytes } = require('crypto');
const { types } = require('util');
const nativeThen = Promise.prototype.then;
const { createRailgunReservationLedgerCodec } = require('./railgun-reservation-ledger');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const RECORD = 'railgun-private-reservations-v1',
  MAX_ENTRIES = 512,
  MAX_SEQUENCE = MAX_ENTRIES * 2,
  FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const owners = new Set(),
  instances = new WeakMap();
const relayMutations = new WeakMap();
const fail = (code = 'RAILGUN_RESERVATIONS_REFUSED') =>
  Object.assign(new Error('Railgun private input requires recovery'), { code });
const check = (v) => {
  if (!v) throw fail();
};
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const field = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && BigInt(v) < FIELD;
const integer = (v, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const exact = (v, keys) =>
  v &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
const FACTS = [
  'tree',
  'position',
  'nullifier',
  'noteHash',
  'kind',
  'intentDigest',
  'checkpointHash',
  'poiDigest',
];
function facts(v) {
  check(exact(v, FACTS));
  check(integer(v.tree, 65535) && integer(v.position, 65535));
  check(field(v.nullifier) && field(v.noteHash));
  check(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      v.kind
    )
  );
  check(typeof v.intentDigest === 'string' && /^0x[0-9a-f]{64}$/.test(v.intentDigest));
  check(digest(v.checkpointHash) && digest(v.poiDigest));
  return Object.freeze(Object.fromEntries(FACTS.map((key) => [key, v[key]])));
}
function signingFacts(v) {
  check(exact(v, ['submitter', 'operationId', 'gatesDigest']));
  check(typeof v.submitter === 'string' && /^0x[0-9a-f]{40}$/.test(v.submitter));
  check(BigInt(v.submitter) > 0n && digest(v.operationId) && digest(v.gatesDigest));
  return Object.freeze({
    submitter: v.submitter,
    operationId: v.operationId,
    gatesDigest: v.gatesDigest,
  });
}
function recoveryFacts(v) {
  check(exact(v, ['tree', 'position', 'nullifier', 'noteHash']));
  check(integer(v.tree, 65535) && integer(v.position, 65535));
  check(field(v.nullifier) && field(v.noteHash));
  return Object.freeze({
    tree: v.tree,
    position: v.position,
    nullifier: v.nullifier,
    noteHash: v.noteHash,
  });
}
async function createRailgunPrivateReservations({
  handle,
  directory,
  key,
  binding,
  walletId,
  profileGuard,
  create = false,
  readFloor,
  advanceFloor,
  claimRecovery,
  authorizeSigning,
  enrollment,
}) {
  // Fenced enrollment uses v4; legacy callers retain their fixed v1/v2 mode.
  // Authenticate the fixed issuer before deriving a path or creating a scope.
  const cooperative = enrollment !== undefined;
  function assertEnrollment() {
    if (!cooperative) return;
    require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
    check(
      enrollment.directory === directory &&
        enrollment.binding === binding &&
        enrollment.descriptor.walletId === walletId &&
        enrollment.getContext('storage', RECORD + ':' + walletId) === handle
    );
  }
  assertEnrollment();
  const codec = cooperative
    ? createRailgunReservationLedgerCodec({ enrollment, binding, walletId })
    : null;
  const context = getPrivacyContext(handle),
    subject = context.subject;
  check(digest(binding) && digest(walletId) && typeof create === 'boolean');
  check(
    subject.kind === 'private-account' &&
      subject.protocol === 'railgun' &&
      subject.chainId === 11155111 &&
      subject.deployment === 'sepolia' &&
      subject.role === 'storage' &&
      subject.operation === RECORD + ':' + walletId
  );
  check(
    typeof readFloor === 'function' &&
      typeof advanceFloor === 'function' &&
      typeof claimRecovery === 'function' &&
      typeof authorizeSigning === 'function'
  );
  check(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  const filename = getPrivacyStoragePath(handle, directory);
  check(!owners.has(filename));
  owners.add(filename);
  const scope = createPrivacyScope({
    profileId: context.profileId,
    signal: context.signal,
    isCurrent: () => {
      getPrivacyContext(handle);
      return true;
    },
  });
  const lease = randomBytes(32).toString('hex'),
    receipts = new WeakMap(),
    receiptOrigins = new WeakMap(),
    relayReceiptStores = new WeakMap();
  let storage,
    current,
    closed = false,
    busy = false,
    pending = 1, // Opening owns the path before its first external await.
    unknown = false,
    recovery = null;
  function finish() {
    if (closed && !pending && !unknown) owners.delete(filename);
  }
  function retain() {
    unknown = true;
    close();
    return fail('RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED');
  }
  function settle(group) {
    pending--;
    if (group) {
      group.pending--;
      if (group.done && !group.pending && !unknown) group.phase.release();
    }
    finish();
  }
  // Observe original work with the intrinsic Promise operation, never a caller's
  // then property. Failed observation permanently retains the writer and phase.
  function observe(result, group = null) {
    if (!types.isPromise(result) || types.isProxy(result)) throw retain();
    try {
      nativeThen.call(
        result,
        () => settle(group),
        () => settle(group)
      );
    } catch {
      throw retain();
    }
    return result;
  }
  async function admitted(use) {
    active();
    const group = recovery;
    pending++;
    if (group) group.pending++;
    try {
      return observe(use(), group);
    } catch (error) {
      if (!unknown) settle(group);
      throw error;
    }
  }
  // A synchronous ordinary result is already complete. Inspect descriptor chains
  // without invoking accessors; thenables/unknown chains cannot prove completion.
  function completed(value) {
    let at = value;
    for (let depth = 0; at !== null && ['object', 'function'].includes(typeof at); depth++) {
      if (depth === 16 || types.isProxy(at)) throw retain();
      const descriptor = Object.getOwnPropertyDescriptor(at, 'then');
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')
          throw retain();
        return;
      }
      at = Object.getPrototypeOf(at);
    }
  }
  // Observe actual native promises through the intrinsic operation. The envelope
  // prevents forwarding a floor value through a second thenable assimilation.
  function original(use) {
    const result = use();
    if (!types.isPromise(result) || types.isProxy(result)) {
      completed(result);
      return Promise.resolve({ value: result });
    }
    return new Promise((resolve, reject) => {
      try {
        nativeThen.call(result, (value) => resolve({ value }), reject);
      } catch {
        reject(retain());
      }
    });
  }
  function active() {
    check(!closed);
    getPrivacyContext(handle);
    assertEnrollment();
  }
  function close() {
    if (closed) return;
    closed = true;
    scope.close();
    finish();
  }
  scope.signal.addEventListener('abort', close, { once: true });
  function decode(text) {
    if (cooperative) return codec.decode(text);
    check(typeof text === 'string' && Buffer.byteLength(text) <= 512 * 1024);
    const v = JSON.parse(text);
    check(exact(v, ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries']));
    check(
      [1, 2].includes(v.version) &&
        v.binding === binding &&
        v.walletId === walletId &&
        digest(v.lease) &&
        integer(v.sequence, MAX_SEQUENCE) &&
        Array.isArray(v.entries) &&
        v.entries.length <= MAX_ENTRIES
    );
    const ids = new Set(),
      inputs = new Set();
    let transitions = 0;
    v.entries = v.entries.map((entry) => {
      check(
        exact(entry, v.version === 1 ? ['id', 'facts'] : ['id', 'facts', 'state', 'signing']) &&
          digest(entry.id) &&
          !ids.has(entry.id)
      );
      const state = v.version === 1 ? 'legacy' : entry.state;
      check(['legacy', 'held', 'signing', 'abandoned'].includes(state));
      const signing = state === 'signing' ? signingFacts(entry.signing) : null;
      if (v.version === 2 && state !== 'signing') check(entry.signing === null);
      if (state === 'signing' || state === 'abandoned') transitions++;
      const value = facts(entry.facts),
        input = value.tree + ':' + value.nullifier;
      if (state !== 'abandoned') {
        check(!inputs.has(input));
        inputs.add(input);
      }
      ids.add(entry.id);
      return Object.freeze({ id: entry.id, facts: value, state, signing });
    });
    check(v.sequence === v.entries.length + transitions);
    return { ...v, version: 2 };
  }
  function typedFloor(sequence) {
    return { version: 4, binding, walletId, sequence };
  }
  function isTypedFloor(value) {
    if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = ['version', 'binding', 'walletId', 'sequence'];
    if (Reflect.ownKeys(value).length !== keys.length) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        return false;
    }
    return (
      value.version === 4 &&
      value.binding === binding &&
      value.walletId === walletId &&
      integer(value.sequence, MAX_SEQUENCE)
    );
  }
  async function floor() {
    const { value } = await original(readFloor);
    active();
    check(value === null || integer(value, MAX_SEQUENCE) || (cooperative && isTypedFloor(value)));
    return cooperative && isTypedFloor(value) ? Object.freeze(typedFloor(value.sequence)) : value;
  }
  async function persistFloor() {
    await original(() =>
      advanceFloor(cooperative ? typedFloor(current.sequence) : current.sequence)
    );
  }
  const isPrivate = (entry) => Boolean(entry) && (!cooperative || entry.origin === 'private');
  const privateEntry = (entry) =>
    !cooperative
      ? entry
      : Object.freeze({
          id: entry.id,
          facts: entry.facts,
          state: entry.state,
          signing: entry.signing,
        });
  const terminal = (entry) =>
    ['abandoned', 'cancelled-unsigned', 'discarded-signed'].includes(entry.state);
  async function attest() {
    active();
    const value = decode(await storage.get(RECORD));
    active();
    check(value.lease === lease && JSON.stringify(value) === JSON.stringify(current));
    const minimum = await floor();
    check(
      cooperative
        ? isTypedFloor(minimum) && minimum.sequence === value.sequence
        : minimum !== null && value.sequence >= minimum
    );
    return value;
  }
  try {
    storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard,
    });
    const minimum = await floor();
    await storage.update(RECORD, (text) => {
      active();
      check(create ? text === null && minimum === null : text !== null);
      const value =
        text === null
          ? { version: 2, binding, walletId, lease, sequence: 0, entries: [] }
          : decode(text);
      if (cooperative) {
        check(text === null ? minimum === null : minimum !== null);
        if (isTypedFloor(minimum)) {
          check(value.version === 4 && value.sequence >= minimum.sequence);
        } else if (minimum !== null) {
          check(integer(minimum, MAX_SEQUENCE) && value.sequence >= minimum);
          check(
            value.version !== 4 ||
              value.entries.every((entry) =>
                ['private', 'relay-v3-never-signed'].includes(entry.origin)
              )
          );
        }
        current = codec.decode(text === null ? codec.create(lease) : codec.upgrade(text, lease));
      } else {
        check(minimum === null || value.sequence >= minimum);
        current = { ...value, lease };
      }
      return JSON.stringify(current);
    });
    active();
    await persistFloor();
    active();
    await attest();
  } catch (error) {
    close();
    throw error;
  } finally {
    settle(null);
  }
  async function reserve(input) {
    active();
    check(!busy);
    const value = facts(input);
    busy = true;
    try {
      await attest();
      if (
        current.entries.some(
          (e) =>
            !terminal(e) && e.facts.tree === value.tree && e.facts.nullifier === value.nullifier
        )
      )
        throw fail('RAILGUN_PRIVATE_INPUT_RESERVED');
      if (cooperative)
        codec.assertPrivateAvailable(JSON.stringify(current), {
          tree: value.tree,
          nullifier: value.nullifier,
        });
      else if (current.entries.length === MAX_ENTRIES) throw fail('RAILGUN_RESERVATIONS_CAPACITY');
      let entry = Object.freeze({
        id: randomBytes(32).toString('hex'),
        facts: value,
        state: 'held',
        signing: null,
      });
      await storage.update(RECORD, (text) => {
        active();
        const old = decode(text);
        check(JSON.stringify(old) === JSON.stringify(current));
        current = cooperative
          ? codec.decode(codec.apply(text, { type: 'reserve-private', id: entry.id, facts: value }))
          : { ...old, sequence: old.sequence + 1, entries: [...old.entries, entry] };
        entry = current.entries[current.entries.length - 1];
        return JSON.stringify(current);
      });
      active();
      await persistFloor();
      active();
      await attest();
      const receipt = Object.freeze({});
      receipts.set(receipt, entry);
      return receipt;
    } catch (error) {
      if (!['RAILGUN_PRIVATE_INPUT_RESERVED', 'RAILGUN_RESERVATIONS_CAPACITY'].includes(error.code))
        close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function assertReceipt(receipt) {
    active();
    check(!busy);
    const entry = receipts.get(receipt);
    check(entry && isPrivate(entry));
    receiptOrigins.get(receipt)?.assertCurrent();
    busy = true;
    try {
      const value = await attest();
      if (!value.entries.some((e) => JSON.stringify(e) === JSON.stringify(entry)))
        throw fail('RAILGUN_RESERVATION_RECEIPT_STALE');
      receiptOrigins.get(receipt)?.assertCurrent();
      return privateEntry(entry);
    } catch (error) {
      if (error.code !== 'RAILGUN_RESERVATION_RECEIPT_STALE') close();
      throw error;
    } finally {
      busy = false;
    }
  }
  // The complete state comparison is the CAS. Persist first, advance the floor,
  // then authenticate exact read-back before exposing a new state receipt.
  async function transition(entry, state, signing, assertCurrent = active) {
    check(isPrivate(entry) && entry.state === 'held' && ['signing', 'abandoned'].includes(state));
    let next = Object.freeze({ ...entry, state, signing });
    await storage.update(RECORD, (text) => {
      active();
      assertCurrent();
      const old = decode(text);
      check(JSON.stringify(old) === JSON.stringify(current));
      check(old.entries.some((e) => JSON.stringify(e) === JSON.stringify(entry)));
      current = cooperative
        ? codec.decode(
            codec.apply(text, {
              type: state === 'signing' ? 'mark-private-signing' : 'abandon-private',
              id: entry.id,
              ...(state === 'signing' ? { signing } : {}),
            })
          )
        : {
            ...old,
            sequence: old.sequence + 1,
            entries: old.entries.map((e) => (e.id === entry.id ? next : e)),
          };
      next = current.entries.find((e) => e.id === entry.id);
      return JSON.stringify(current);
    });
    active();
    assertCurrent();
    await persistFloor();
    active();
    await attest();
    assertCurrent();
    const receipt = Object.freeze({});
    receipts.set(receipt, next);
    if (state === 'signing')
      receiptOrigins.set(receipt, { kind: 'operation', assertCurrent: active });
    return receipt;
  }
  async function changeHeld(receipt, state, signing = null, permit = null) {
    active();
    check(!busy);
    const entry = receipts.get(receipt);
    check(entry && isPrivate(entry) && entry.state === 'held');
    busy = true;
    try {
      const value = await attest();
      if (!value.entries.some((e) => JSON.stringify(e) === JSON.stringify(entry)))
        throw fail('RAILGUN_RESERVATION_RECEIPT_STALE');
      const assertCurrent =
        state === 'signing' ? authorizeSigning(permit, instance, receipt, signing) : active;
      check(typeof assertCurrent === 'function');
      assertCurrent();
      return await transition(entry, state, signing, assertCurrent);
    } catch (error) {
      if (error.code !== 'RAILGUN_RESERVATION_RECEIPT_STALE') close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function abandonRecovered(input) {
    active();
    check(!busy);
    const wanted = recoveryFacts(input);
    // Enrollment supplies the genuine account-phase claim. Hold it throughout
    // recovery so no wallet/private operation can start against these inputs.
    const phase = claimRecovery();
    busy = true;
    try {
      phase.assertCurrent();
      const value = await attest();
      const entry = value.entries.find(
        (e) =>
          isPrivate(e) &&
          e.state === 'held' &&
          Object.keys(wanted).every((key) => e.facts[key] === wanted[key])
      );
      if (!entry) throw fail('RAILGUN_RESERVATION_NOT_RECOVERABLE');
      await transition(entry, 'abandoned', null, () => phase.assertCurrent());
    } catch (error) {
      if (error.code !== 'RAILGUN_RESERVATION_NOT_RECOVERABLE') close();
      throw error;
    } finally {
      busy = false;
      if (!unknown) phase.release();
    }
  }
  // Trusted controller callback: expected external refusals return values, all
  // awaits observe context.signal/deadline and drain children before returning.
  // Expiry revokes receipt use immediately; the phase is not released until the
  // callback settles, so timed-out children cannot race a new wallet operation.
  async function withSigningRecovery(use, { timeoutMs = 45000 } = {}) {
    active();
    check(!busy && typeof use === 'function');
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 175000);
    const phase = claimRecovery(),
      group = { phase, pending: 0, done: false },
      controller = new AbortController(),
      issued = [];
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    const deadline = performance.now() + timeoutMs;
    const assertCurrent = () => {
      active();
      phase.assertCurrent();
      check(!signal.aborted && performance.now() < deadline);
    };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const context = Object.freeze({ signal, deadline, assertCurrent });
    busy = true;
    try {
      assertCurrent();
      const value = await attest();
      assertCurrent();
      const records = value.entries
        .filter((e) => isPrivate(e) && e.state === 'signing')
        .map((entry) => {
          const receipt = Object.freeze({});
          receipts.set(receipt, entry);
          issued.push(receipt);
          receiptOrigins.set(receipt, { kind: 'recovery', assertCurrent });
          return Object.freeze({ receipt, entry: privateEntry(entry) });
        });
      busy = false;
      recovery = group;
      const { value: result } = await original(() => use(Object.freeze(records), context));
      check(!busy);
      assertCurrent();
      await attest();
      assertCurrent();
      completed(result);
      return result;
    } catch (error) {
      if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') {
        // Fixed trusted verifier outcome: retain this writer and recovery phase.
        // This only revokes; it grants no caller authority or recovery receipt.
        try {
          retain();
        } catch {
          /* Preserve the original unknown-exit category. */
        }
      } else close();
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const receipt of issued) {
        receipts.delete(receipt);
        receiptOrigins.delete(receipt);
      }
      busy = false;
      recovery = null;
      group.done = true;
      if (!group.pending && !unknown) phase.release();
    }
  }
  // Local read only: do this before disclosing an operation to POI/RPC.
  // reserve() repeats the conflict/capacity checks at the actual commit point.
  async function assertAvailable(input) {
    active();
    check(!busy);
    const selected = recoveryFacts(input);
    busy = true;
    try {
      const value = await attest();
      if (
        value.entries.some(
          (e) =>
            !terminal(e) &&
            e.facts.tree === selected.tree &&
            e.facts.nullifier === selected.nullifier
        )
      )
        throw fail('RAILGUN_PRIVATE_INPUT_RESERVED');
      if (cooperative)
        codec.assertPrivateAvailable(JSON.stringify(value), {
          tree: selected.tree,
          nullifier: selected.nullifier,
        });
      else if (value.entries.length === MAX_ENTRIES) throw fail('RAILGUN_RESERVATIONS_CAPACITY');
    } catch (error) {
      if (!['RAILGUN_PRIVATE_INPUT_RESERVED', 'RAILGUN_RESERVATIONS_CAPACITY'].includes(error.code))
        close();
      throw error;
    } finally {
      busy = false;
    }
  }
  async function inspect() {
    active();
    check(!busy);
    busy = true;
    try {
      const value = await attest();
      const counts = { held: 0, signing: 0, abandoned: 0, legacy: 0 };
      for (const entry of value.entries) if (isPrivate(entry)) counts[entry.state]++;
      return Object.freeze(counts);
    } catch (error) {
      close();
      throw error;
    } finally {
      busy = false;
    }
  }
  // Fixed v4 custody composition, not signing/POI authority. Both stores are
  // genuine factories bound to this exact enrollment. No caller-supplied writer,
  // custody Boolean, permit validator or generic codec proposal is accepted.
  function relayOwner(store) {
    active();
    check(cooperative && !recovery);
    require('./railgun-relay-recovery-store').assertRailgunRelayRecoveryStoreOwner(
      store,
      enrollment
    );
  }
  async function relayCall(store, use) {
    relayOwner(store);
    const { value } = await original(use);
    relayOwner(store);
    return value;
  }
  async function relayExclusive(store, use) {
    relayOwner(store);
    check(!busy);
    busy = true;
    const progress = { writeStarted: false, harmless: false };
    try {
      await attest();
      const value = await use(progress);
      relayOwner(store);
      await attest();
      relayOwner(store);
      return value;
    } catch (error) {
      if (progress.writeStarted || !progress.harmless) close();
      throw error;
    } finally {
      busy = false;
    }
  }
  const relayData = () => require('./railgun-relay-recovery-data');
  function relayEntry(id) {
    check(digest(id));
    const entry = current.entries.find((entry) => entry.id === id);
    check(entry && entry.origin === 'relay-local-v4');
    return entry;
  }
  function relayHeldFacts(row) {
    return {
      tree: row.draft.selection.tree,
      position: row.draft.selection.position,
      nullifier: row.draft.intent.expected.nullifier,
      noteHash: row.draft.noteHash,
      kind: 'railgun-relay-self-transfer',
      checkpointHash: row.checkpointHash,
      draftDigest: require('./railgun-relay-capsule').normalizeRailgunRelayDraftCapsule(row.draft)
        .digest,
      expectedHash: row.draft.intent.expectedHash,
    };
  }
  async function relayPair(store, entry) {
    const record = await relayCall(store, () => store.lookup(entry.id));
    if (record === null) {
      // A ledger-first interrupted hold cannot have admitted signing: there is
      // no signing marker. Absence is authenticated, never inferred from error.
      check(['held', 'cancelled-unsigned'].includes(entry.state) && entry.signing === null);
      return Object.freeze({
        record: null,
        interruptedStep: entry.state === 'held' ? 'append-held' : null,
        authorityGranted: false,
      });
    }
    return relayData().matchRailgunRelayLocalReservation(JSON.stringify(record), entry);
  }
  function relayReceipt(store, entry, pair) {
    const receipt = Object.freeze({});
    receipts.set(receipt, entry);
    relayReceiptStores.set(receipt, store);
    return Object.freeze({ receipt, entry, ...pair });
  }
  async function relayCheckedReceipt(store, receipt) {
    const entry = receipts.get(receipt);
    check(entry && entry.origin === 'relay-local-v4' && relayReceiptStores.get(receipt) === store);
    const actual = relayEntry(entry.id);
    check(JSON.stringify(actual) === JSON.stringify(entry));
    return { entry: actual, pair: await relayPair(store, actual) };
  }
  async function relayWrite(action, progress) {
    if (progress) progress.writeStarted = true;
    await storage.update(RECORD, (text) => {
      active();
      check(JSON.stringify(decode(text)) === JSON.stringify(current));
      current = codec.decode(codec.apply(text, action));
      return JSON.stringify(current);
    });
    active();
    await persistFloor();
    active();
    await attest();
    return relayEntry(action.id);
  }
  async function relayMutation(store, method, input) {
    relayOwner(store);
    check(busy);
    const token = Object.freeze({});
    const assertCurrent = () => {
      relayOwner(store);
      check(busy && relayMutations.has(token));
    };
    relayMutations.set(token, { store, method, input, assertCurrent, used: false });
    try {
      return await relayCall(store, () => store[method](token, input));
    } finally {
      relayMutations.delete(token);
    }
  }
  async function reserveRelay(store, text) {
    return relayExclusive(store, async (progress) => {
      const row = relayData().decodeRailgunRelayLocalRecord(text);
      check(row.state === 'held' && row.binding === binding && row.walletId === walletId);
      const action = { type: 'reserve-relay', id: row.id, facts: relayHeldFacts(row) };
      // Both capacity proposals are checked before the first ledger write. The
      // fixed recovery method checks again at its own original commit point.
      try {
        codec.apply(JSON.stringify(current), action);
      } catch (error) {
        progress.harmless = [
          'RAILGUN_PRIVATE_INPUT_RESERVED',
          'RAILGUN_RESERVATIONS_CAPACITY',
        ].includes(error.code);
        throw error;
      }
      try {
        await relayCall(store, () => store.assertHeldAvailable(text));
      } catch (error) {
        progress.harmless =
          require('./railgun-relay-recovery-store').isRailgunRelayRecoveryUnavailable(error, store);
        throw error;
      }
      const entry = await relayWrite(action, progress);
      await relayMutation(store, 'appendHeld', text);
      const pair = await relayPair(store, entry);
      check(pair.record && pair.interruptedStep === null && pair.record.state === 'held');
      return relayReceipt(store, entry, pair);
    });
  }
  async function listRelay(store) {
    return relayExclusive(store, async () => {
      // Authenticate the paired document/floor even when only ledger selectors
      // are requested. Orphan holds remain discoverable, without action receipts.
      await relayCall(store, () => store.inspect());
      return Object.freeze(
        current.entries
          .filter((entry) => entry.origin === 'relay-local-v4')
          .map(({ id, state }) => Object.freeze({ id, state }))
      );
    });
  }
  async function readRelay(store, id) {
    return relayExclusive(store, async () => {
      const entry = relayEntry(id);
      return relayReceipt(store, entry, await relayPair(store, entry));
    });
  }
  async function markRelaySigning(store, receipt) {
    return relayExclusive(store, async () => {
      const { entry, pair } = await relayCheckedReceipt(store, receipt);
      check(
        entry.state === 'held' &&
          pair.record &&
          pair.record.state === 'held' &&
          pair.interruptedStep === null
      );
      const next = await relayWrite({
        type: 'mark-relay-signing',
        id: entry.id,
        signing: {
          gatesDigest: pair.record.authorizationDigest,
          recordDigest: pair.recordDigest,
        },
      });
      await relayMutation(store, 'markSigning', entry.id);
      const joined = await relayPair(store, next);
      check(joined.record.state === 'signing-local' && joined.interruptedStep === null);
      return relayReceipt(store, next, joined);
    });
  }
  async function discardRelayLocal(store, receipt) {
    return relayExclusive(store, async () => {
      let { entry, pair } = await relayCheckedReceipt(store, receipt);
      if (['cancelled-unsigned', 'discarded-signed'].includes(entry.state))
        return relayReceipt(store, entry, pair);
      if (pair.record === null) {
        check(entry.state === 'held' && entry.signing === null);
        // Only the authenticated never-signing orphan has no tombstone to write.
        entry = await relayWrite({ type: 'cancel-relay-unsigned', id: entry.id });
        return relayReceipt(
          store,
          entry,
          Object.freeze({ record: null, interruptedStep: null, authorityGranted: false })
        );
      }
      if (pair.interruptedStep === 'mark-recovery-signing') {
        await relayMutation(store, 'markSigning', entry.id);
        pair = await relayPair(store, entry);
        check(pair.record.state === 'signing-local' && pair.interruptedStep === null);
      }
      if (!['cancelled-unsigned', 'discarded-signed'].includes(pair.record.state)) {
        await relayMutation(store, 'discardLocal', entry.id);
        pair = await relayPair(store, entry);
      }
      const signed = entry.state === 'signing-local';
      check(pair.record.state === (signed ? 'discarded-signed' : 'cancelled-unsigned'));
      check(pair.interruptedStep === (signed ? 'release-signed' : 'release-unsigned'));
      // Read the genuine authenticated tombstone before releasing the conflict.
      entry = await relayWrite({
        type: signed ? 'discard-relay-local' : 'cancel-relay-unsigned',
        id: entry.id,
      });
      const joined = await relayPair(store, entry);
      check(joined.interruptedStep === null);
      return relayReceipt(store, entry, joined);
    });
  }
  const instance = Object.freeze({
    ...(cooperative
      ? {
          reserveRelay: (store, text) => admitted(() => reserveRelay(store, text)),
          listRelay: (store) => admitted(() => listRelay(store)),
          readRelay: (store, id) => admitted(() => readRelay(store, id)),
          markRelaySigning: (store, receipt) => admitted(() => markRelaySigning(store, receipt)),
          discardRelayLocal: (store, receipt) => admitted(() => discardRelayLocal(store, receipt)),
        }
      : {}),
    reserve: (input) => admitted(() => reserve(input)),
    assertAvailable: (input) => admitted(() => assertAvailable(input)),
    assertReceipt: (receipt) => admitted(() => assertReceipt(receipt)),
    markSigning: (receipt, evidence, permit) => {
      const checked = signingFacts(evidence);
      return admitted(() => changeHeld(receipt, 'signing', checked, permit));
    },
    abandon: (receipt) => admitted(() => changeHeld(receipt, 'abandoned')),
    abandonRecovered: (input) => admitted(() => abandonRecovered(input)),
    withSigningRecovery: (use, options) => admitted(() => withSigningRecovery(use, options)),
    assertReceiptContext: (receipt, kind) => {
      active();
      const origin = receiptOrigins.get(receipt);
      check(origin && origin.kind === kind && isPrivate(receipts.get(receipt)));
      origin.assertCurrent();
    },
    inspect: () => admitted(() => inspect()),
    close,
    signal: scope.signal,
  });
  instances.set(instance, {
    binding,
    walletId,
    directory,
    profileId: context.profileId,
    principal: subject.principal,
  });
  return instance;
}
module.exports = {
  // The issuer is module-private. This fixed consumer cannot mint a capability;
  // a raw recovery-store caller has no token to present or callback to inject.
  consumeRailgunRelayReservationMutation: (token, store, method, input) => {
    const entry = relayMutations.get(token);
    check(
      entry &&
        !entry.used &&
        entry.store === store &&
        entry.method === method &&
        entry.input === input
    );
    entry.assertCurrent();
    entry.used = true;
    return entry.assertCurrent;
  },
  createRailgunPrivateReservations,
  isRailgunPrivateReservations: (v) => instances.has(v),
  assertRailgunPrivateReservationsOwner: (value, { handle, binding, walletId, directory }) => {
    const owner = instances.get(value),
      context = getPrivacyContext(handle);
    check(
      owner &&
        !value.signal.aborted &&
        owner.binding === binding &&
        owner.walletId === walletId &&
        owner.directory === directory &&
        owner.profileId === context.profileId &&
        owner.principal === context.subject.principal
    );
  },
};
