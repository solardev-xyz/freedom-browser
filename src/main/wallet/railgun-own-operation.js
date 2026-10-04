/** Detached account data for capture -> TXID -> fresh recovery composition.
 * No receipt survives this call, and no signer, network or proof authority is
 * returned. The eventual use must rederive these facts from the live stores.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const { deriveRailgunOwnSelector } = require('./railgun-own-selector');
const { getPrivateSubmissionJournal } = require('./private-submission-journal');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update('freedom:railgun:own-operation-v1\0')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
function selector(value) {
  const text = JSON.stringify(value);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 1024);
  const selected = JSON.parse(text);
  assert.deepEqual(Object.keys(selected).sort(), ['noteHash', 'nullifier', 'position', 'tree']);
  for (const key of ['tree', 'position'])
    assert.ok(Number.isSafeInteger(selected[key]) && selected[key] >= 0 && selected[key] < 65536);
  for (const key of ['noteHash', 'nullifier'])
    assert.ok(
      typeof selected[key] === 'string' &&
        /^0x[0-9a-f]{64}$/.test(selected[key]) &&
        BigInt(selected[key]) < FIELD
    );
  return Object.freeze(selected);
}
function selectJournal(snapshot, facts, intent) {
  assert.ok(snapshot.records.every((record) => record.resolution));
  const matching = [...snapshot.records, ...snapshot.archive].filter(
    (record) =>
      record.intent?.kind === 'railgun-transact' && record.intent.nullifier === facts.nullifier
  );
  assert.equal(matching.length, 1);
  const record = matching[0];
  assert.deepEqual(record.intent, intent);
  return { record, projection: projectRailgunOwnRecord(record) };
}
const refused = () =>
  Object.assign(new Error('Railgun own recovery unavailable'), {
    code: 'RAILGUN_OWN_OPERATION_REFUSED',
  });
// Copy plain JSON only: no getters, toJSON hooks, capabilities or lossy values.
function detachResult(input) {
  let nodes = 0,
    bytes = 0;
  const charge = (size) => {
    bytes += size;
    assert.ok(bytes <= 32768);
  };
  const copy = (value, depth = 0) => {
    assert.ok(++nodes <= 32768 && depth <= 64);
    if (value === null || typeof value === 'boolean') {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value === 'string') {
      assert.ok(Buffer.byteLength(value) <= 32768);
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value));
      charge(JSON.stringify(value).length);
      return value;
    }
    assert.ok(value && typeof value === 'object');
    assert.ok(
      Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value))
    );
    assert.equal(Object.getOwnPropertySymbols(value).length, 0);
    const keys = Object.keys(value);
    charge(2 + Math.max(0, keys.length - 1));
    if (Array.isArray(value)) assert.equal(keys.length, value.length);
    const entries = keys.map((key, index) => {
      if (Array.isArray(value)) assert.equal(key, String(index));
      assert.ok(Buffer.byteLength(key) <= 32768);
      if (!Array.isArray(value)) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.ok(Object.hasOwn(descriptor, 'value'));
      return [key, copy(descriptor.value, depth + 1)];
    });
    return Array.isArray(value) ? entries.map(([, v]) => v) : Object.fromEntries(entries);
  };
  const detached = copy(input),
    text = JSON.stringify(detached);
  assert.ok(Buffer.byteLength(text) <= 32768);
  return freeze(detached);
}
async function captureRailgunOwnOperation(
  { enrollment, selector: input, signal, timeoutMs = 45000 } = {},
  selectorArchive,
  use
) {
  let stage = 'context',
    scope,
    timer;
  const controller = new AbortController();
  try {
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 175000);
    const selected = selector(input);
    const parent = enrollment.getContext('engine');
    const started = performance.now(),
      deadline = started + timeoutMs;
    const lifetime = AbortSignal.any([signal, enrollment.signal, controller.signal]);
    const current = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin <= 175000);
      getPrivacyContext(parent);
      const now = performance.now();
      assert.ok(!lifetime.aborted && now >= started && now + margin < deadline);
    };
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    current();
    const reservations = await enrollment.openReservations();
    current();
    const capsules = await enrollment.openPrivateCapsules();
    current();
    const result = await reservations.withSigningRecovery(
      async (records, context) => {
        try {
          const active = (margin = 0) => {
            current(margin);
            context.assertCurrent();
            assert.ok(Number.isFinite(context.deadline));
            assert.ok(performance.now() + margin < context.deadline);
          };
          active();
          stage = 'selection';
          const matching = records.filter(({ entry }) =>
            Object.entries(selected).every(([key, value]) => entry.facts[key] === value)
          );
          assert.equal(matching.length, 1);
          const { entry, receipt } = matching[0];
          reservations.assertReceiptContext(receipt, 'recovery');
          assert.deepEqual(await reservations.assertReceipt(receipt), entry);
          active();
          stage = 'capsule';
          // Never overlap this read with another reservation call: both stores
          // use their existing exclusive authentication boundaries.
          const stored = await capsules.readSigned(receipt);
          active();
          const { capsule, provedTransaction } = stored;
          assert.equal(capsule.version, 1);
          assert.ok(
            ['railgun-private-transfer', 'railgun-token-unshield'].includes(capsule.selection.kind)
          );
          assert.equal(capsule.walletId, enrollment.descriptor.walletId);
          const submitter = entry.signing.submitter;
          const intent = railgunTransactJournalIntent({ ...provedTransaction, from: submitter });
          assert.equal(intent.intentDigest, entry.facts.intentDigest);
          if (capsule.selection.kind === 'railgun-token-unshield')
            assert.equal(capsule.selection.recipient, submitter);
          scope = createPrivacyScope({
            profileId: getPrivacyContext(parent).profileId,
            signal: AbortSignal.any([lifetime, context.signal]),
            isCurrent: () => {
              active();
              return true;
            },
          });
          const handle = scope.getContext({
            kind: 'public-address',
            principal: submitter,
            chainId: pins.chainId,
            role: 'transaction-rpc',
          });
          const journal = getPrivateSubmissionJournal(handle);
          stage = 'journal';
          const first = selectJournal(await journal.readSnapshot(), entry.facts, intent);
          active();
          let derived;
          if (selectorArchive !== undefined) {
            stage = 'selector';
            const selectorBudget = Math.min(30000, Math.floor(deadline - performance.now()) - 2000);
            assert.ok(selectorBudget >= 1);
            derived = await deriveRailgunOwnSelector({
              handle: enrollment.getContext('engine', 'own-txid-selector'),
              archive: selectorArchive,
              provedTransaction,
              signal: AbortSignal.any([lifetime, context.signal]),
              timeoutMs: selectorBudget,
            });
            active();
          }
          const reattest = async (assertActive = active) => {
            stage = 'reattest';
            assertActive();
            reservations.assertReceiptContext(receipt, 'recovery');
            assert.deepEqual(await reservations.assertReceipt(receipt), entry);
            assertActive();
            assert.deepEqual(await capsules.readSigned(receipt), stored);
            assertActive();
            const latest = selectJournal(await journal.readSnapshot(), entry.facts, intent);
            assertActive();
            assert.deepEqual(latest.projection, first.projection);
            const bindingDigest = digest({
              account: enrollment.binding,
              walletId: enrollment.descriptor.walletId,
              holdId: entry.id,
              facts: entry.facts,
              signing: entry.signing,
              capsuleDigest: stored.capsuleDigest,
              authorizationDigest: stored.authorizationDigest,
              signingDigest: stored.signingDigest,
              intent,
              projection: latest.projection,
            });
            const capture = JSON.parse(
              JSON.stringify({
                version: 1,
                bindingDigest,
                selector: selected,
                facts: entry.facts,
                submitter,
                capsule,
                capsuleDigest: stored.capsuleDigest,
                provedTransaction,
                intent,
                record: latest.record,
                projection: latest.projection,
                accountAuthenticated: false,
                sourceAuthenticated: false,
                currentFinalityVerified: false,
                txidPathVerified: false,
                txidRootAccepted: false,
                poiVerified: false,
                spendingEnabled: false,
              })
            );
            assertActive();
            return freeze(capture);
          };
          const capture = await reattest();
          if (!use) return freeze({ status: 'captured', capture, ...(derived ? { derived } : {}) });
          // Trusted main callback owns and drains any other children it starts.
          // This window neither locks the EOA journal nor grants key authority.
          const windowController = new AbortController();
          let accepting = true,
            pending,
            failed = false;
          const revoke = () => {
            accepting = false;
            windowController.abort();
          };
          const assertCurrent = (margin = 0) => {
            if (!accepting || windowController.signal.aborted) throw refused();
            try {
              active(margin);
            } catch {
              throw refused();
            }
          };
          const window = Object.freeze({
            capture,
            signal: AbortSignal.any([lifetime, context.signal, windowController.signal]),
            assertCurrent,
            reattest() {
              assertCurrent();
              if (pending) throw refused();
              // Return the exact observed promise, including when discarded.
              const work = (async () => {
                try {
                  const fresh = await reattest(assertCurrent);
                  assertCurrent();
                  return fresh;
                } catch {
                  failed = true;
                  revoke();
                  throw refused();
                }
              })();
              pending = work;
              work.then(
                () => {
                  if (pending === work) pending = undefined;
                },
                () => {
                  if (pending === work) pending = undefined;
                }
              );
              return work;
            },
          });
          let value,
            callbackFailed = false;
          try {
            stage = 'callback';
            value = await use(window);
          } catch {
            callbackFailed = true;
          } finally {
            revoke();
            if (pending) await Promise.allSettled([pending]);
          }
          if (failed) {
            stage = 'reattest';
            throw refused();
          }
          stage = 'callback';
          if (callbackFailed) throw refused();
          active();
          value = detachResult(value);
          await reattest();
          return Object.freeze({ status: 'used', value });
        } catch {
          // A missing/incomplete operation or changed observation is an expected
          // refusal, not a reason to tear down healthy reservation storage.
          return Object.freeze({ status: 'refused', stage });
        } finally {
          scope?.close();
        }
      },
      { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }
    );
    current();
    return result;
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
  }
}
module.exports = {
  // Only the callback lifetime retains recovery. No receipt/store is exposed;
  // callback-owned child jobs must be cancelled and drained before it settles.
  withRailgunOwnOperationRecovery: (options, use) => {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      typeof use !== 'function'
    )
      return Promise.resolve(Object.freeze({ status: 'refused', stage: 'context' }));
    return captureRailgunOwnOperation(options, undefined, use);
  },
  captureRailgunOwnOperation: (options) => captureRailgunOwnOperation(options),
  captureRailgunOwnOperationSelector: ({ archive, ...options } = {}) => {
    if (typeof archive !== 'string')
      return Promise.resolve(Object.freeze({ status: 'refused', stage: 'context' }));
    return captureRailgunOwnOperation(options, archive);
  },
};
