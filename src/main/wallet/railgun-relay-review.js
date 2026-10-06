/** Local main-owned fee/peer preference only. Requires a LIVE wallet with a
 * completed read; completedOnly handles cannot reserve its real handoff.
 * Owners are borrowed. No persistence, POI, spending or transport grant. */
const assert = require('assert/strict');
const path = require('path');
const { isProxy } = require('util').types;
const {
  readRailgunAccountOwnedNotes,
  reserveRailgunAccountWalletHandoff,
} = require('./railgun-account-wallet');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { selectRailgunPrivatePreparation } = require('./railgun-private-preparation');
const { verifyRailgunRelayQuote } = require('./railgun-relay-quote-verify');
const {
  shape,
  freeze,
  decimal,
  normalizeRailgunRelayQuote,
  assertQuoteCurrent,
} = require('./railgun-relay-quote-data');
const pins = require('./railgun-shield-pins.json');
const fail = () =>
  Object.assign(new Error('Railgun local relay review unavailable'), {
    code: 'RAILGUN_RELAY_REVIEW_REFUSED',
  });
function createRailgunRelayReview(options) {
  try {
    return create(options);
  } catch {
    throw fail();
  }
}
function create(options) {
  shape(options, ['account', 'owners', 'archive', 'signal', 'review']);
  shape(options.owners, ['identity', 'enrollment', 'coordinator']);
  const { account, archive, signal, review } = options;
  const owners = Object.freeze({ ...options.owners });
  assert.ok(typeof archive === 'string' && path.isAbsolute(archive));
  assert.equal(typeof review, 'function');
  readRailgunAccountOwnedNotes(account, owners);
  const signals = [
    signal,
    account.signal,
    owners.identity.signal,
    owners.enrollment.signal,
    owners.coordinator.signal,
  ];
  assert.ok(signals.every((v) => v instanceof AbortSignal && !isProxy(v) && !v.aborted));
  const controller = new AbortController();
  const lifetime = AbortSignal.any([...signals, controller.signal]);
  let closing = false,
    used = false,
    busy = false,
    handoff,
    timer,
    cleanupError;
  let resolveClosed, rejectClosed;
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  closed.catch(() => {});
  function finish() {
    if (!closing || busy) return;
    clearTimeout(timer);
    lifetime.removeEventListener('abort', close);
    // An unobserved child retains exclusion; never pretend it drained.
    if (cleanupError) {
      rejectClosed(fail());
      return;
    }
    try {
      handoff?.release();
      handoff = null;
    } catch {
      rejectClosed(fail());
      return;
    }
    resolveClosed();
  }
  function close() {
    closing = true;
    controller.abort();
    finish();
  }
  function current() {
    assert.ok(!closing && !lifetime.aborted);
    const owned = readRailgunAccountOwnedNotes(account, owners);
    const publicIdentity = getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment);
    assert.ok(!closing && !lifetime.aborted);
    return { owned, publicIdentity, view: account.view, generationId: account.generationId };
  }
  current();
  lifetime.addEventListener('abort', close, { once: true });
  function selected(before, noteId) {
    const owned = before.owned;
    const selection = selectRailgunPrivatePreparation(owned, {
      kind: 'railgun-private-transfer',
      noteId,
      recipient: owned.read.instanceId,
    });
    const notes = owned.read.received.filter((n) => n.id === noteId);
    const records = owned.ownedPoi.filter((n) => n.id === noteId);
    assert.equal(notes.length, 1);
    assert.equal(records.length, 1);
    assert.ok(['Shield', 'Transact'].includes(records[0].type));
    assert.equal(notes[0].hash, records[0].hash);
    assert.equal(notes[0].txid, records[0].txid);
    return freeze(
      structuredClone({
        selection,
        note: notes[0],
        record: records[0],
        instanceId: owned.read.instanceId,
        checkpointHash: owned.checkpointHash,
        publicIdentity: before.publicIdentity,
        generationId: before.generationId,
      })
    );
  }
  function reviewLocal(request) {
    try {
      assert.ok(!used && !busy);
      used = true;
      shape(request, ['noteId', 'quote', 'gas', 'maxFee']);
      assert.ok(
        typeof request.noteId === 'string' &&
          request.noteId.length > 0 &&
          request.noteId.length <= 160
      );
      const noteId = request.noteId;
      const binding = normalizeRailgunRelayQuote(request.quote, request.gas);
      const cap = decimal(request.maxFee, BigInt(pins.maxQualificationAmount));
      assert.ok(cap > 0n && BigInt(binding.feeAmount) <= cap);
      const before = current(),
        baseline = selected(before, noteId);
      assert.ok(BigInt(binding.feeAmount) < baseline.note.amount);
      const start = performance.now(),
        deadline = start + 45000;
      let wall = Date.now();
      const receiptExpiresAt = Math.min(wall + 45000, binding.fields.feeExpiration);
      assertQuoteCurrent(binding, wall, wall);
      assert.ok(binding.fields.feeExpiration - wall <= 300000);
      handoff = reserveRailgunAccountWalletHandoff(account, owners);
      busy = true;
      timer = setTimeout(close, Math.min(45000, binding.fields.feeExpiration - wall));
      timer.unref?.();
      const attest = () => {
        const now = performance.now(),
          date = Date.now();
        assert.ok(now >= start && now < deadline);
        assertQuoteCurrent(binding, date, wall);
        wall = date;
        handoff?.assertCurrent();
        const after = current();
        assert.equal(after.view, before.view);
        assert.deepEqual(selected(after, noteId), baseline);
        const end = performance.now(),
          endWall = Date.now();
        assert.ok(end >= start && end < deadline);
        assertQuoteCurrent(binding, endWall, wall);
        wall = endWall;
        assert.ok(!closing && !lifetime.aborted);
      };
      let succeeded = false;
      const work = (async () => {
        try {
          attest();
          const verified = await verifyRailgunRelayQuote({
            enrollment: owners.enrollment,
            archive,
            quote: binding.quote,
            gas: binding.gas,
            signal: lifetime,
          });
          attest();
          const summary = freeze({
            purpose: 'railgun-local-relay-review-v1',
            localReviewOnly: true,
            chainId: pins.chainId,
            proxy: pins.proxy,
            token: pins.wrappedNative,
            recipient: baseline.instanceId,
            inputAmount: baseline.note.amount.toString(),
            feeAmount: binding.feeAmount,
            maximumFee: cap.toString(),
            netAmount: (baseline.note.amount - BigInt(binding.feeAmount)).toString(),
            gas: binding.gas,
            gasLimitMultiplierBps: 12000,
            feeRateAtomicPerNativeUnit: BigInt(binding.fields.fees[pins.wrappedNative]).toString(),
            gasLimit: binding.gasLimit,
            maximumGasWei: binding.maximumGasWei,
            gasEstimateVerified: false,
            signedQuote: binding.quote,
            quoteSha256: binding.quoteSha256,
            signedBytesSha256: binding.signedBytesSha256,
            expiresAt: binding.fields.feeExpiration,
            peerAddress: binding.fields.railgunAddress,
            viewingPublicKey: verified.viewingPublicKey,
            masterPublicKey: verified.masterPublicKey,
            signatureVerified: true,
            operatorTrusted: false,
            requiredPOIListKeys: binding.fields.requiredPOIListKeys,
            selection: {
              noteId,
              tree: baseline.selection.tree,
              position: baseline.selection.position,
              checkpointHash: baseline.checkpointHash,
              walletGenerationId: baseline.generationId,
              publicGenerationId: baseline.publicIdentity.generationId,
            },
            futureRelayExposures: [
              'proved-transaction',
              'pre-transaction-poi',
              'fee',
              'exchange-public-key',
            ],
            permitsSigning: false,
            permitsPoiQueries: false,
            permitsRelaySend: false,
          });
          attest();
          const reviewStart = performance.now();
          const reviewTimer = setTimeout(close, 30000);
          reviewTimer.unref?.();
          let approved;
          try {
            approved = await review(summary, Object.freeze({ signal: lifetime }));
          } finally {
            clearTimeout(reviewTimer);
          }
          attest();
          const now = performance.now();
          assert.ok(now >= reviewStart && now - reviewStart < 30000);
          assert.equal(approved, true);
          // There is deliberately no exported receipt consumer/promotion API.
          const receipt = Object.freeze({ signal: lifetime, expiresAt: receiptExpiresAt });
          attest();
          try {
            handoff.release();
          } catch (error) {
            cleanupError = error;
            throw error;
          }
          handoff = null;
          attest();
          succeeded = true;
          return Object.freeze({ summary, receipt });
        } catch (error) {
          if (error?.code === 'RAILGUN_RELAY_QUOTE_DRAIN_FAILED') cleanupError = error;
          close();
          throw fail();
        } finally {
          busy = false;
          // The receipt remains locally current only until explicit close, owner
          // revocation or the bounded original review/quote lifetime.
          if (!succeeded) close();
          else if (closing) finish();
        }
      })();
      work.catch(() => {});
      return work;
    } catch {
      close();
      return Promise.reject(fail());
    }
  }
  return Object.freeze({ reviewLocal, close, closed, signal: lifetime });
}
module.exports = { createRailgunRelayReview };
