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
async function captureRailgunOwnOperation({
  enrollment,
  selector: input,
  signal,
  timeoutMs = 45000,
} = {}) {
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
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(!lifetime.aborted && performance.now() >= started && performance.now() < deadline);
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
          const active = () => {
            current();
            context.assertCurrent();
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
          stage = 'reattest';
          reservations.assertReceiptContext(receipt, 'recovery');
          assert.deepEqual(await reservations.assertReceipt(receipt), entry);
          active();
          assert.deepEqual(await capsules.readSigned(receipt), stored);
          active();
          const latest = selectJournal(await journal.readSnapshot(), entry.facts, intent);
          active();
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
          active();
          return freeze({ status: 'captured', capture });
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
module.exports = { captureRailgunOwnOperation };
