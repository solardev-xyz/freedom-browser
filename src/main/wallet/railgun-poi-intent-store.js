/** Encrypted account-owned POI history. V1 is prepared-only; V2 also records
 * one conservative attempt, with no sender or restored disclosure authority.
 * Data rename and manifest-floor advancement are separate writes: if the latter
 * fails, ordinary reopen preserves the attempt and repairs the floor, but an old
 * ciphertext restored while the floor still lags may replay prepared state.
 * Logical one-way transitions are not cross-file atomic rollback protection.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { createPrivacyStorage, getPrivacyStoragePath } = require('./privacy-storage');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const {
  prepareRailgunPoiSubmission,
  normalizeRailgunPoiSubmission,
} = require('./railgun-poi-submit-data');
const RECORD = 'railgun-poi-intents-v1';
const MAX_RECORDS = 32,
  MAX_SEQUENCE = 128,
  MAX_REVISIONS = 4,
  FUTURE_TRANSITIONS = 3;
const owners = new Set();
const attemptTransitions = (entry) => Number(entry.state === 'attempted');
const reserved = (entries) =>
  entries.reduce((total, entry) => total + FUTURE_TRANSITIONS - attemptTransitions(entry), 0);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const digest = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_SEQUENCE;
const fail = (code = 'RAILGUN_POI_INTENT_STORE_REFUSED') =>
  Object.assign(new Error('Railgun POI intent store unavailable'), { code });
const shape = (v, keys) => {
  assert.ok(v && typeof v === 'object' && !Array.isArray(v));
  assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
};
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
async function createRailgunPoiIntentStore({
  enrollment,
  handle,
  directory,
  key,
  binding,
  walletId,
  profileGuard,
  create = false,
  readFloor,
  advanceFloor,
}) {
  // Enrollment imports this store. Proof/recovery modules import enrollment;
  // keep those imports out of initialization to preserve the module boundary.
  const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
  const context = getPrivacyContext(handle),
    subject = context.subject;
  assert.ok(isRailgunAccountEnrollment(enrollment) && !enrollment.signal.aborted);
  assert.ok(digest(binding) && digest(walletId) && typeof create === 'boolean');
  assert.equal(enrollment.binding, binding);
  assert.equal(enrollment.descriptor.walletId, walletId);
  assert.equal(enrollment.directory, directory);
  const accountContext = getPrivacyContext(enrollment.getContext('storage'));
  assert.equal(context.profileId, accountContext.profileId);
  assert.deepEqual(subject, {
    ...accountContext.subject,
    operation: RECORD + ':' + walletId,
  });
  assert.equal(subject.kind, 'private-account');
  assert.equal(subject.protocol, 'railgun');
  assert.equal(subject.chainId, 11155111);
  assert.equal(subject.deployment, 'sepolia');
  assert.equal(subject.role, 'storage');
  assert.ok(path.isAbsolute(directory) && fs.realpathSync(directory) === directory);
  assert.ok(typeof readFloor === 'function' && typeof advanceFloor === 'function');
  const filename = getPrivacyStoragePath(handle, directory);
  if (owners.has(filename)) throw fail();
  owners.add(filename);
  let scope,
    storage,
    current,
    busy = false,
    mutating = false,
    pending = 1,
    revoked = false,
    released = false,
    resolveClosed;
  const closed = new Promise((resolve) => (resolveClosed = resolve));
  const drain = () => {
    if (revoked && pending === 0 && !released) {
      released = true;
      owners.delete(filename);
      resolveClosed();
    }
  };
  const close = () => {
    if (revoked) return;
    revoked = true;
    scope?.close();
    drain();
  };
  const active = () => {
    if (revoked || enrollment.signal.aborted) throw fail();
    getPrivacyContext(handle);
    enrollment.getContext('storage');
  };
  function record(value, version = 2) {
    const attempted = value?.state === 'attempted';
    assert.ok(value?.state === 'prepared' || (version === 2 && attempted));
    shape(value, [
      'capsuleDigest',
      'bindingDigest',
      'selector',
      'payload',
      'payloadSha256',
      'inputSha256',
      'revision',
      'state',
      ...(attempted ? ['attempt'] : []),
    ]);
    assert.ok(
      digest(value.capsuleDigest) && digest(value.bindingDigest) && digest(value.inputSha256)
    );
    assert.ok(integer(value.revision) && value.revision > 0 && value.revision <= MAX_REVISIONS);
    shape(value.selector, ['tree', 'position', 'nullifier', 'noteHash']);
    for (const name of ['tree', 'position'])
      assert.ok(
        Number.isSafeInteger(value.selector[name]) &&
          value.selector[name] >= 0 &&
          value.selector[name] < 65536
      );
    for (const name of ['nullifier', 'noteHash']) {
      assert.match(value.selector[name], /^0x[0-9a-f]{64}$/);
      assert.ok(
        BigInt(value.selector[name]) <
          21888242871839275222246405745257275088548364400416034343698204186575808495617n
      );
    }
    const payload = normalizeRailgunPoiPayload(value.payload);
    assert.equal(value.payloadSha256, hash(JSON.stringify(payload)));
    let attempt;
    if (attempted) {
      shape(value.attempt, ['attemptedAt', 'submission']);
      const { attemptedAt } = value.attempt;
      assert.ok(Number.isSafeInteger(attemptedAt) && attemptedAt > 0);
      const submission = normalizeRailgunPoiSubmission(value.attempt.submission);
      assert.equal(submission.requestId, attemptedAt);
      assert.equal(submission.payloadSha256, value.payloadSha256);
      assert.deepEqual(submission.payload, payload);
      attempt = Object.freeze({ attemptedAt, submission });
    }
    const result = freeze({
      capsuleDigest: value.capsuleDigest,
      bindingDigest: value.bindingDigest,
      selector: {
        tree: value.selector.tree,
        position: value.selector.position,
        nullifier: value.selector.nullifier,
        noteHash: value.selector.noteHash,
      },
      payload,
      payloadSha256: value.payloadSha256,
      inputSha256: value.inputSha256,
      revision: value.revision,
      state: value.state,
      ...(attempted ? { attempt } : {}),
    });
    // Reserve the entire future canonical envelope now, including its duplicated
    // payload. A further 8 KiB/entry is reserved for two bounded observations.
    const envelope = prepareRailgunPoiSubmission({ payload, requestId: Number.MAX_SAFE_INTEGER });
    const maximum =
      version === 1
        ? { ...result, envelope }
        : {
            ...result,
            state: 'attempted',
            attempt: { attemptedAt: Number.MAX_SAFE_INTEGER, submission: envelope },
          };
    assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 16 * 1024);
    return result;
  }
  function decode(text) {
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 800 * 1024);
    const value = JSON.parse(text);
    shape(value, ['version', 'binding', 'walletId', 'lease', 'sequence', 'entries']);
    assert.ok(value.version === 1 || value.version === 2);
    assert.equal(value.binding, binding);
    assert.equal(value.walletId, walletId);
    assert.ok(digest(value.lease) && integer(value.sequence));
    assert.ok(Array.isArray(value.entries) && value.entries.length <= MAX_RECORDS);
    const entries = value.entries.map((entry) => record(entry, value.version));
    assert.equal(new Set(entries.map((v) => v.capsuleDigest)).size, entries.length);
    assert.equal(new Set(entries.map((v) => v.selector.nullifier)).size, entries.length);
    assert.equal(
      value.sequence,
      entries.reduce((n, v) => n + v.revision + attemptTransitions(v), 0)
    );
    assert.ok(value.sequence + reserved(entries) <= MAX_SEQUENCE);
    return {
      version: value.version,
      binding,
      walletId,
      lease: value.lease,
      sequence: value.sequence,
      entries,
    };
  }
  const encode = (value) => {
    const text = JSON.stringify(value);
    decode(text);
    return text;
  };
  const lease = randomBytes(32).toString('hex');
  async function floor() {
    const minimum = await readFloor();
    active();
    assert.ok(minimum === null || integer(minimum));
    return minimum;
  }
  async function attest() {
    active();
    const value = decode(await storage.get(RECORD));
    active();
    assert.equal(value.lease, lease);
    assert.deepEqual(value, current);
    const minimum = await floor();
    assert.ok(minimum !== null && value.sequence >= minimum);
    return value;
  }
  try {
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([context.signal, enrollment.signal]),
      isCurrent: () => {
        active();
        return true;
      },
    });
    scope.signal.addEventListener('abort', close, { once: true });
    active();
    storage = createPrivacyStorage({
      handle: scope.getContext(subject),
      directory,
      key,
      profileGuard,
    });
    const minimum = await floor();
    await storage.update(RECORD, (text) => {
      active();
      assert.ok(create ? text === null && minimum === null : text !== null);
      const value =
        text === null
          ? { version: 1, binding, walletId, lease, sequence: 0, entries: [] }
          : decode(text);
      assert.ok(minimum === null || value.sequence >= minimum);
      current = { ...value, lease };
      return encode(current);
    });
    active();
    await advanceFloor(current.sequence);
    active();
    await attest();
  } catch {
    close();
    throw fail();
  } finally {
    pending--;
    drain();
  }
  async function exclusive(use) {
    active();
    if (busy) throw fail('RAILGUN_POI_INTENT_STORE_BUSY');
    busy = true;
    pending++;
    try {
      await attest();
      return await use();
    } catch (error) {
      if (
        [
          'RAILGUN_POI_INTENT_STORE_CAPACITY',
          'RAILGUN_POI_INTENT_STORE_CONFLICT',
          'RAILGUN_POI_INTENT_STORE_STALE',
        ].includes(error.code)
      )
        throw error;
      close();
      throw fail();
    } finally {
      busy = false;
      pending--;
      drain();
    }
  }
  async function commit(next, assertCurrent, admitted = () => {}) {
    const text = encode(next);
    await storage.update(RECORD, (previous) => {
      active();
      assertCurrent();
      assert.deepEqual(decode(previous), current);
      // From this point a failure can follow an actual rename. The caller must
      // retain uncertainty, even if its update promise never resolves normally.
      admitted();
      return text;
    });
    current = next;
    active();
    await advanceFloor(current.sequence);
    active();
    await attest();
    assertCurrent();
  }
  async function persistPrepared(input, assertCurrent) {
    return exclusive(async () => {
      assertCurrent();
      const old = current.entries.find((v) => v.capsuleDigest === input.capsuleDigest);
      if (old) {
        // This guard precedes even the identical-proof/no-op branch.
        if (old.state !== 'prepared') throw fail('RAILGUN_POI_INTENT_STORE_CONFLICT');
        try {
          assert.deepEqual(old.selector, input.selector);
        } catch {
          throw fail('RAILGUN_POI_INTENT_STORE_CONFLICT');
        }
        const same = record({ ...input, revision: old.revision });
        if (JSON.stringify(old) === JSON.stringify(same)) return old;
        if (old.revision === MAX_REVISIONS) throw fail('RAILGUN_POI_INTENT_STORE_CAPACITY');
      } else if (current.entries.some((v) => v.selector.nullifier === input.selector.nullifier))
        throw fail('RAILGUN_POI_INTENT_STORE_CONFLICT');
      const count = current.entries.length + Number(!old);
      if (
        count > MAX_RECORDS ||
        current.sequence + 1 + reserved(current.entries) + (old ? 0 : FUTURE_TRANSITIONS) >
          MAX_SEQUENCE
      )
        throw fail('RAILGUN_POI_INTENT_STORE_CAPACITY');
      const entry = record({ ...input, revision: (old?.revision || 0) + 1 });
      const next = {
        ...current,
        sequence: current.sequence + 1,
        entries: old
          ? current.entries.map((v) => (v === old ? entry : v))
          : [...current.entries, entry],
      };
      await commit(next, assertCurrent);
      return entry;
    });
  }
  async function prepare(options) {
    if (mutating) return Object.freeze({ status: 'refused', stage: 'busy' });
    mutating = true;
    let stage = 'context';
    pending++;
    try {
      active();
      shape(options, ['proof', 'coordinator', 'signal']);
      const { proof, coordinator, signal } = options;
      assert.ok(signal instanceof AbortSignal && !signal.aborted);
      const { assertRailgunOwnPoiProof } = require('./railgun-own-poi-proof');
      const { bindRailgunOwnPoiPayload } = require('./railgun-own-poi-proof-data');
      const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
      const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
      const lifetime = AbortSignal.any([signal, scope.signal]);
      const history = assertRailgunOwnPoiProof(proof, enrollment, coordinator);
      const payload = bindRailgunOwnPoiPayload(history.payload, history.expected);
      assert.equal(hash(JSON.stringify(payload)), history.payloadSha256);
      const currentProof = () => {
        active();
        assert.ok(!lifetime.aborted);
        assertRailgunOwnPoiProof(proof, enrollment, coordinator);
      };
      stage = 'recovery';
      const result = await withRailgunOwnOperationRecovery(
        {
          enrollment,
          selector: history.capture.selector,
          signal: lifetime,
          timeoutMs: 15000,
        },
        async (window) => {
          const check = () => {
            try {
              currentProof();
              window.assertCurrent();
            } catch {
              throw fail('RAILGUN_POI_INTENT_STORE_STALE');
            }
          };
          check();
          assertRailgunOwnPoiCapture(window.capture, history.capture);
          assertRailgunOwnPoiCapture(await window.reattest(), history.capture);
          check();
          stage = 'persist';
          const entry = await persistPrepared(
            {
              capsuleDigest: history.capture.capsuleDigest,
              bindingDigest: history.capture.bindingDigest,
              selector: history.capture.selector,
              payload,
              payloadSha256: history.payloadSha256,
              inputSha256: history.inputSha256,
              state: 'prepared',
            },
            check
          );
          stage = 'reattest';
          assertRailgunOwnPoiCapture(await window.reattest(), history.capture);
          check();
          return {
            capsuleDigest: entry.capsuleDigest,
            payloadSha256: entry.payloadSha256,
            revision: entry.revision,
          };
        }
      );
      currentProof();
      if (result.status !== 'used') return Object.freeze({ status: 'refused', stage });
      return Object.freeze({
        status: 'prepared',
        ...result.value,
        proofAuthenticated: false,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
    } catch {
      return Object.freeze({ status: 'refused', stage });
    } finally {
      mutating = false;
      pending--;
      drain();
    }
  }
  async function beginAttempt(options) {
    if (mutating) return Object.freeze({ status: 'refused', stage: 'busy' });
    mutating = true;
    pending++;
    let stage = 'context',
      possiblyCommitted = false;
    const refused = () =>
      Object.freeze({
        status: possiblyCommitted ? 'recovery-required' : 'refused',
        stage,
      });
    try {
      active();
      shape(options, ['capsuleDigest', 'expectedRevision', 'expectedPayloadSha256', 'signal']);
      const { capsuleDigest, expectedRevision, expectedPayloadSha256, signal } = options;
      assert.ok(digest(capsuleDigest) && digest(expectedPayloadSha256));
      assert.ok(
        Number.isSafeInteger(expectedRevision) &&
          expectedRevision >= 1 &&
          expectedRevision <= MAX_REVISIONS
      );
      assert.ok(signal instanceof AbortSignal && !signal.aborted);
      const lifetime = AbortSignal.any([signal, scope.signal]);
      const currentAttempt = () => {
        active();
        if (lifetime.aborted) throw fail('RAILGUN_POI_INTENT_STORE_STALE');
      };
      stage = 'stored';
      const baseline = await exclusive(() => {
        currentAttempt();
        const entry = current.entries.find((v) => v.capsuleDigest === capsuleDigest);
        if (
          !entry ||
          entry.state !== 'prepared' ||
          entry.revision !== expectedRevision ||
          entry.payloadSha256 !== expectedPayloadSha256
        )
          throw fail('RAILGUN_POI_INTENT_STORE_CONFLICT');
        return record(entry, current.version);
      });
      currentAttempt();
      const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
      const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
      const bind = (capture) => {
        assert.equal(capture.capsuleDigest, baseline.capsuleDigest);
        assert.equal(capture.bindingDigest, baseline.bindingDigest);
        assert.deepEqual(capture.selector, baseline.selector);
      };
      let attemptedEntry;
      stage = 'recovery';
      const result = await withRailgunOwnOperationRecovery(
        { enrollment, selector: baseline.selector, signal: lifetime, timeoutMs: 15000 },
        async (window) => {
          const check = () => {
            try {
              currentAttempt();
              window.assertCurrent();
            } catch {
              throw fail('RAILGUN_POI_INTENT_STORE_STALE');
            }
          };
          check();
          bind(window.capture);
          const capture = await window.reattest();
          check();
          bind(capture);
          assertRailgunOwnPoiCapture(capture, window.capture);
          stage = 'persist';
          attemptedEntry = await exclusive(async () => {
            check();
            const old = current.entries.find((v) => v.capsuleDigest === capsuleDigest);
            // The whole detached baseline, not only caller CAS fields, is fixed.
            if (!old || old.state !== 'prepared') throw fail('RAILGUN_POI_INTENT_STORE_CONFLICT');
            assert.deepEqual(old, baseline);
            const attemptedAt = Date.now();
            if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0)
              throw fail('RAILGUN_POI_INTENT_STORE_STALE');
            const submission = prepareRailgunPoiSubmission({
              payload: baseline.payload,
              requestId: attemptedAt,
            });
            const entry = record({
              ...baseline,
              state: 'attempted',
              attempt: { attemptedAt, submission },
            });
            const next = {
              ...current,
              version: 2,
              sequence: current.sequence + 1,
              entries: current.entries.map((v) => (v === old ? entry : v)),
            };
            await commit(next, check, () => {
              possiblyCommitted = true;
            });
            return entry;
          });
          stage = 'reattest';
          const fresh = await window.reattest();
          check();
          bind(fresh);
          assertRailgunOwnPoiCapture(fresh, window.capture);
          return { checked: true };
        }
      );
      currentAttempt();
      if (result.status !== 'used') return refused();
      assert.deepEqual(result.value, { checked: true });
      assert.ok(attemptedEntry);
      // Recovery's outer post-attestation has now settled. Authenticate storage
      // once more before reporting successful completion; this is no send permit.
      await exclusive(() => {
        currentAttempt();
        assert.deepEqual(
          current.entries.find((v) => v.capsuleDigest === capsuleDigest),
          attemptedEntry
        );
      });
      currentAttempt();
      return Object.freeze({
        status: 'attempted',
        capsuleDigest,
        revision: attemptedEntry.revision,
        payloadSha256: attemptedEntry.payloadSha256,
        bodySha256: attemptedEntry.attempt.submission.bodySha256,
        attemptedAt: attemptedEntry.attempt.attemptedAt,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
    } catch {
      return refused();
    } finally {
      mutating = false;
      pending--;
      drain();
    }
  }
  return Object.freeze({
    prepare,
    beginAttempt,
    get: (capsuleDigest) =>
      exclusive(async () => {
        assert.ok(digest(capsuleDigest));
        return current.entries.find((v) => v.capsuleDigest === capsuleDigest) || null;
      }),
    list: () =>
      exclusive(async () =>
        freeze(
          current.entries.map((v) => ({
            capsuleDigest: v.capsuleDigest,
            state: v.state,
            revision: v.revision,
            payloadSha256: v.payloadSha256,
          }))
        )
      ),
    inspect: () =>
      exclusive(async () =>
        Object.freeze({
          records: current.entries.length,
          sequence: current.sequence,
          capacity: MAX_RECORDS,
          reservedTransitions: reserved(current.entries),
          freeTransitions: MAX_SEQUENCE - current.sequence - reserved(current.entries),
        })
      ),
    close,
    closed,
    signal: scope.signal,
  });
}
module.exports = {
  createRailgunPoiIntentStore: async (options) => {
    try {
      return await createRailgunPoiIntentStore(options);
    } catch {
      throw fail();
    }
  },
};
