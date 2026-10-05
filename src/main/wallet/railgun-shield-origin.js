/** Local, endpoint-reattested Shield-origin diagnostic. Borrowed owners remain
 * caller-owned. A match grants no ownership, chain, recipient or spending authority.
 * Journal storage-key derivation is not Railgun viewing/spending-key issuance.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { performance } = require('perf_hooks');
const { getAddress } = require('ethers');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { readRailgunAccountOwnedNotes } = require('./railgun-account-wallet');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { readExistingPrivateSubmissionSnapshot } = require('./private-submission-journal');
const { matchRailgunShieldOrigin } = require('./railgun-shield-origin-data');
const { getWalletRecord, WALLET_TYPES } = require('../identity-manager');
const DEADLINE_MS = 10000;
const refused = () =>
  Object.freeze({
    status: 'refused',
    trust: 'supplied-data',
    ownershipAuthenticated: false,
    canonicalityVerified: false,
    spendingEnabled: false,
    poiBypassEnabled: false,
    localJournalAuthenticated: false,
    localAccountSnapshotSourceAuthenticated: false,
  });
function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !isProxy(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), [...keys].sort());
  for (const descriptor of Object.values(descriptors))
    assert.ok(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  );
}
function metadata() {
  const record = getWalletRecord(0);
  assert.ok(record && record.index === 0 && record.type === WALLET_TYPES.MNEMONIC);
  assert.equal(typeof record.address, 'string');
  assert.match(record.address, /^0x[0-9a-fA-F]{40}$/);
  const address = getAddress(record.address).toLowerCase();
  assert.ok(BigInt(address) > 0n);
  return { index: record.index, type: record.type, address };
}
// Snapshot bounded plain data without executing supplied getters/iterators.
function snapshot(input) {
  let nodes = 0,
    bytes = 0;
  const seen = new Set();
  function copy(value, depth) {
    assert.ok(++nodes <= 300000 && depth <= 16);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      assert.ok(Number.isSafeInteger(value));
      return value;
    }
    if (typeof value === 'bigint') {
      assert.ok(value >= 0n && value < 1n << 256n);
      return value;
    }
    if (typeof value === 'string') {
      bytes += value.length * 2;
      assert.ok(value.length <= 262144 && bytes <= 8 * 1024 * 1024);
      return value;
    }
    assert.ok(value && typeof value === 'object' && !isProxy(value) && !seen.has(value));
    const array = Array.isArray(value);
    assert.equal(Object.getPrototypeOf(value), array ? Array.prototype : Object.prototype);
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    assert.ok(keys.length <= 10001);
    const output = array ? [] : {};
    if (array) {
      assert.ok(value.length <= 10000);
      assert.deepEqual(keys, [...Array(value.length).keys()].map(String).concat('length'));
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      assert.equal(typeof key, 'string');
      bytes += key.length * 2;
      assert.ok(key.length <= 256 && bytes <= 8 * 1024 * 1024);
      assert.ok(key !== '__proto__');
      const descriptor = descriptors[key];
      assert.ok(Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
      output[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return output;
  }
  return copy(input, 0);
}

async function diagnoseRailgunShieldOrigin(input) {
  let scope, timer;
  const listeners = [];
  let result;
  try {
    const {
      account,
      owners: suppliedOwners,
      noteId,
      signal,
      transaction,
      receipt,
      checkpoint,
    } = exact(input, [
      'account',
      'owners',
      'noteId',
      'signal',
      'transaction',
      'receipt',
      'checkpoint',
    ]);
    const owners = exact(suppliedOwners, ['identity', 'enrollment', 'coordinator']);
    const { identity, enrollment, coordinator } = owners;
    assert.equal(typeof noteId, 'string');
    assert.match(noteId, /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,4})$/);
    assert.ok(Number(noteId.split(':')[1]) < 65536);
    // Only supplied data is snapshotted here. account.view is an intentional getter.
    const hints = snapshot({ transaction, receipt, checkpoint });
    assert.ok(isRailgunAccountEnrollment(enrollment));
    const engine = enrollment.getContext('engine');
    assertRailgunIdentity(identity, engine);
    const parent = getPrivacyContext(engine);
    // Authenticate borrowed handles before reading their lifetime/view properties.
    readRailgunAccountOwnedNotes(account, owners);
    getRailgunAccountPublicIdentity(coordinator, enrollment);
    const started = performance.now();
    const controller = new AbortController();
    const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
    for (const lifetime of new Set([
      signal,
      account.signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      parent.signal,
    ])) {
      assert.ok(lifetime && !isProxy(lifetime));
      assert.equal(aborted.call(lifetime), false);
      const cancel = () => controller.abort();
      EventTarget.prototype.addEventListener.call(lifetime, 'abort', cancel, { once: true });
      listeners.push([lifetime, cancel]);
    }
    timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const current = () => {
      assert.ok(!controller.signal.aborted && performance.now() - started < DEADLINE_MS);
      assert.ok(isRailgunAccountEnrollment(enrollment));
      assert.equal(enrollment.getContext('engine'), engine);
      assertRailgunIdentity(identity, engine);
      getPrivacyContext(engine);
    };
    const observe = () => {
      current();
      const owned = readRailgunAccountOwnedNotes(account, owners);
      const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment);
      const notes = owned.read.received.filter((note) => note.id === noteId);
      const poi = owned.ownedPoi.filter((note) => note.id === noteId);
      assert.equal(notes.length, 1);
      assert.equal(poi.length, 1);
      assert.equal(poi[0].type, 'Shield');
      return {
        owned,
        view: account.view,
        binding: snapshot({
          generationId: account.generationId,
          publicIdentity,
          checkpointHash: owned.checkpointHash,
          trees: owned.trees,
          note: notes[0],
          poi: poi[0],
          funding: metadata(),
        }),
      };
    };
    const initial = observe();
    scope = createPrivacyScope({
      profileId: parent.profileId,
      signal: controller.signal,
      isCurrent: () => {
        current();
        return true;
      },
    });
    const handle = scope.getContext({
      kind: 'public-address',
      principal: initial.binding.funding.address,
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    function select(journal, owned) {
      assert.ok(Array.isArray(journal.records));
      assert.ok(journal.records.every((record) => record.resolution));
      const candidates = journal.records.filter((record) => {
        const shield = record.resolution?.railgun?.shield;
        return shield && `${shield.tree}:${shield.position}` === noteId;
      });
      assert.equal(candidates.length, 1);
      const record = candidates[0];
      const match = matchRailgunShieldOrigin({
        ...hints,
        owned,
        record,
        submitter: initial.binding.funding.address,
      });
      assert.equal(match.status, 'matched');
      return { record: snapshot(record), match };
    }
    // Never race an admitted reader against abort. It must settle before scope disposal.
    const firstJournal = await readExistingPrivateSubmissionSnapshot(handle);
    current();
    const first = select(firstJournal, initial.owned);
    const middle = observe();
    assert.equal(middle.view, initial.view);
    assert.deepEqual(middle.binding, initial.binding);
    const lastJournal = await readExistingPrivateSubmissionSnapshot(handle);
    current();
    const last = observe();
    assert.equal(last.view, initial.view);
    assert.deepEqual(last.binding, initial.binding);
    const second = select(lastJournal, last.owned);
    assert.deepEqual(second.record, first.record);
    // Endpoint checks, not cross-file atomicity or continuing exclusion. Checkpoint
    // hashes intentionally exclude provider provenance. Public hints remain unverified.
    // Local authentication describes evidence provenance, not cryptographic note
    // ownership; all matcher authority flags deliberately remain false.
    // Synchronous matching/comparison can consume the remaining local budget.
    current();
    result = Object.freeze({
      ...second.match,
      localJournalAuthenticated: true,
      localAccountSnapshotSourceAuthenticated: true,
    });
  } catch {
    result = refused();
  } finally {
    clearTimeout(timer);
    for (const [signal, listener] of listeners)
      EventTarget.prototype.removeEventListener.call(signal, 'abort', listener);
    try {
      scope?.close();
    } catch {
      result = refused();
    }
  }
  return result;
}
module.exports = { diagnoseRailgunShieldOrigin };
