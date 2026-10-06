/** Main-owned relay Transact staging before the held relay operation window.
 * Creator/TXID evidence is immutable data, never disclosure or signing authority.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  assertRailgunIdentity,
  quarantineRailgunIdentityCredentials,
} = require('./railgun-identity');
const { assertRailgunFencedAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy } = require('./railgun-txid-policy');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const {
  openRailgunAccountWallet,
  getRailgunAccountWalletPolicy,
  readRailgunAccountOwnedNotes,
  reserveRailgunAccountWalletHandoff,
  assertRailgunAccountRelayWindow,
} = require('./railgun-account-wallet');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { normalizeRailgunNoteTxidWitness } = require('./railgun-txid-note-witness');
const { collectRailgunPrivateCreator } = require('./railgun-private-creator');
const { verifyRailgunNoteProvenance } = require('./railgun-note-provenance');
const { checkpointHash } = require('./railgun-wallet-coverage');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const {
  shape,
  freeze,
  decimal,
  normalizeRailgunRelayQuote,
  assertQuoteCurrent,
} = require('./railgun-relay-quote-data');
const pins = require('./railgun-shield-pins.json');
const receipts = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun relay Transact staging unavailable'), {
    code: 'RAILGUN_RELAY_TRANSACT_STAGING_REFUSED',
  });
const drainFailed = () =>
  Object.assign(new Error('Railgun relay Transact staging drain unobserved'), {
    code: 'RAILGUN_RELAY_TRANSACT_STAGING_DRAIN_FAILED',
  });
const unknownExit = (error) =>
  ['RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED', 'RAILGUN_WALLET_EXIT_UNOBSERVED'].includes(
    error?.code
  );
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function captureRequest(request) {
  shape(request, ['noteId', 'quote', 'gas', 'maxFee', 'signal']);
  assertRailgunRelaySignal(request.signal);
  assert.ok(
    typeof request.noteId === 'string' && request.noteId.length > 0 && request.noteId.length <= 160
  );
  const binding = normalizeRailgunRelayQuote(request.quote, request.gas);
  const cap = decimal(request.maxFee, BigInt(pins.maxQualificationAmount));
  assert.ok(cap > 0n && BigInt(binding.feeAmount) <= cap);
  return {
    data: freeze({
      noteId: request.noteId,
      quote: binding.quote,
      gas: binding.gas,
      maxFee: request.maxFee,
    }),
    binding,
    signal: request.signal,
  };
}
function selectionSnapshot(owned, request, descriptor) {
  const notes = owned.read.received.filter((v) => v.id === request.data.noteId);
  const records = owned.ownedPoi.filter((v) => v.id === request.data.noteId);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  const note = notes[0],
    record = records[0];
  assert.equal(owned.read.instanceId, descriptor.instanceId);
  assert.equal(note.id, `${note.tree}:${note.position}`);
  for (const v of [note.tree, note.position])
    assert.ok(Number.isSafeInteger(v) && v >= 0 && v < 65536);
  assert.equal(record.type, 'Transact');
  assert.equal(record.hash, note.hash);
  assert.equal(record.txid, note.txid);
  assert.equal(note.spentTxid, false);
  assert.equal(typeof note.amount, 'bigint');
  assert.ok(
    note.amount > BigInt(request.binding.feeAmount) &&
      note.amount <= BigInt(pins.maxQualificationAmount)
  );
  assert.equal(note.asset.__type, 'erc20');
  assert.equal(note.asset.contract, pins.wrappedNative);
  assert.match(record.nullifier, /^0x[0-9a-f]{64}$/);
  return freeze(
    structuredClone({
      selection: { tree: note.tree, position: note.position },
      received: note,
      owned: record,
      checkpointHash: owned.checkpointHash,
    })
  );
}
async function stage(
  {
    account,
    owners: suppliedOwners,
    request: suppliedRequest,
    archive,
    signal,
    timeoutMs = 240000,
  },
  outcome
) {
  assertRailgunRelaySignal(signal);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 240000);
  const request = captureRequest(suppliedRequest);
  const owners = Object.freeze({
    identity: suppliedOwners.identity,
    enrollment: suppliedOwners.enrollment,
    coordinator: suppliedOwners.coordinator,
  });
  const { identity, enrollment, coordinator } = owners;
  assertRailgunFencedAccountEnrollment(enrollment);
  const parent = enrollment.getContext('engine');
  const descriptor = freeze(structuredClone(assertRailgunIdentity(identity, parent)));
  const baseline = selectionSnapshot(
    readRailgunAccountOwnedNotes(account, owners),
    request,
    descriptor
  );
  archive = verifyRailgunEngineRuntime(archive);
  const publicPolicy = getRailgunPublicPolicy(archive),
    txidPolicy = getRailgunTxidPolicy(archive);
  const walletPolicy = getRailgunAccountWalletPolicy({ archive, enrollment, coordinator });
  const publicIdentity = freeze(
    structuredClone(getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy))
  );
  const generationId = account.generationId;
  const generation = freeze(structuredClone(enrollment.catalog.activeFor(walletPolicy)));
  assert.equal(generation.id, generationId);
  const bindings = freeze(
    structuredClone({
      archive,
      publicPolicy,
      txidPolicy,
      walletPolicy,
      publicIdentity,
      generation,
      generationId,
      descriptor,
    })
  );
  const note = Object.freeze({
    type: 'Transact',
    txid: baseline.owned.txid,
    hash: baseline.owned.hash,
    tree: baseline.selection.tree,
    position: baseline.selection.position,
    blockNumber: baseline.owned.blockNumber,
  });
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([
      signal,
      request.signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
    ]),
    isCurrent: () => {
      assertRailgunFencedAccountEnrollment(enrollment);
      assertRailgunIdentity(identity, parent);
      return true;
    },
  });
  const started = performance.now(),
    deadline = started + timeoutMs;
  let wall = Date.now(),
    monotonic = started,
    handoff,
    txid,
    reopened,
    creatorWork,
    succeeded = false,
    oldClosed = false,
    drainUncertain = false,
    failure;
  const time = () => {
    const now = performance.now(),
      date = Date.now();
    try {
      assert.ok(!scope.signal.aborted && now >= monotonic && now < deadline);
      assertQuoteCurrent(request.binding, date, wall);
      monotonic = now;
      wall = date;
    } catch (error) {
      closeScope();
      throw error;
    }
  };
  const rejoin = () => {
    time();
    assertRailgunFencedAccountEnrollment(enrollment);
    assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
      publicIdentity
    );
    assert.deepEqual(enrollment.catalog.activeFor(walletPolicy), generation);
    time();
  };
  const active = () => {
    rejoin();
    handoff?.assertCurrent();
  };
  const closeScope = () => {
    try {
      scope.close();
    } catch {
      drainUncertain = true;
    }
  };
  const timer = setTimeout(closeScope, timeoutMs);
  timer.unref?.();
  const closeOwner = async (owner) => {
    try {
      await owner.close();
    } catch (error) {
      drainUncertain = true;
      throw error;
    }
  };
  try {
    active();
    assert.ok(
      request.binding.fields.feeExpiration - wall >= 120000 &&
        request.binding.fields.feeExpiration - wall <= 300000
    );
    handoff = reserveRailgunAccountWalletHandoff(account, owners);
    outcome.stage = 'closing-wallet';
    outcome.originalAccountReusable = false;
    await closeOwner(account);
    oldClosed = true;
    active();
    outcome.stage = 'txid';
    txid = await openRailgunAccountTxid({
      enrollment,
      coordinator,
      archive,
      create: false,
      checkpointOnly: true,
      handoff: handoff.token,
      signal: scope.signal,
    });
    active();
    assert.equal(txid.policy, txidPolicy);
    assert.deepEqual(txid.publicIdentity, publicIdentity);
    const before = await txid.inspect();
    active();
    assert.ok(before.checkpoint && !before.pending);
    const state = freeze(structuredClone(before.checkpoint.state));
    const found = await txid.witnessNote(note);
    active();
    const noteWitness = normalizeRailgunNoteTxidWitness(found.noteWitness, state, note);
    const after = await txid.inspect();
    active();
    assert.equal(after.pending, null);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    await closeOwner(txid);
    txid = undefined;
    active();
    outcome.stage = 'creator';
    const captured = await coordinator.withPublicSnapshot((snapshot) => {
      assert.equal(creatorWork, undefined);
      // Assign and observe the exact callback promise before invoking the
      // collector. No other expensive work precedes this fresh source visit.
      creatorWork = Promise.resolve().then(() => {
        active();
        assert.equal(checkpointHash(snapshot.checkpoint), baseline.checkpointHash);
        assert.ok(!snapshot.signal.aborted);
        return collectRailgunPrivateCreator({
          note,
          checkpoint: snapshot.checkpoint,
          visit: snapshot.visitSource,
          assertCurrent: () => {
            active();
            assert.ok(!snapshot.signal.aborted);
          },
        });
      });
      creatorWork.catch(() => {});
      return creatorWork;
    });
    assert.ok(creatorWork);
    const creator = await creatorWork;
    active();
    assert.equal(captured.value, creator);
    assert.equal(creator.checkpointHash, baseline.checkpointHash);
    assert.deepEqual(creator.note, note);
    const row = noteWitness.witness.row;
    assert.match(row.graphID, /^0x[0-9a-f]{192}$/);
    const index = BigInt('0x' + row.graphID.slice(66, 130));
    assert.ok(index <= BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(Number(index), creator.creator.transactionIndex);
    assert.equal(row.blockNumber, creator.creator.blockNumber);
    assert.equal('0x' + row.txid, creator.creator.transactionHash);
    outcome.stage = 'verifying-creator';
    const verified = await verifyRailgunNoteProvenance({
      handle: enrollment.getContext('engine', 'note-provenance'),
      archive,
      state,
      note,
      noteWitness,
      events: creator.events,
      signal: scope.signal,
      timeoutMs: Math.min(30000, Math.floor(deadline - performance.now())),
    });
    active();
    assert.equal(verified.pathVerified, true);
    assert.equal(verified.suppliedCreatorEventsMatched, true);
    assert.equal(verified.utilityExitObserved, true);
    for (const key of [
      'ownershipVerified',
      'eventSourceAuthenticated',
      'rootAccepted',
      'spendingEnabled',
    ])
      assert.equal(verified[key], false);
    assert.equal(verified.coverage.boundParamsChecked, false);
    assert.equal(verified.coverage.globalTxidCompleteness, false);
    if (row.unshield) assert.equal(verified.unshieldCommitmentVerified, true);
    assert.equal(
      verified.inputSha256,
      digest({ archive, state, note, noteWitness, events: creator.events })
    );
    assert.equal(getRailgunPublicPolicy(archive), publicPolicy);
    assert.equal(getRailgunTxidPolicy(archive), txidPolicy);
    assert.equal(getRailgunAccountWalletPolicy({ archive, enrollment, coordinator }), walletPolicy);
    outcome.stage = 'reopening-wallet';
    reopened = await openRailgunAccountWallet({
      ...owners,
      archive,
      policy: walletPolicy,
      mode: 'active',
      handoff: handoff.token,
    });
    active();
    assert.equal(reopened.generationId, generationId);
    assert.deepEqual(
      selectionSnapshot(readRailgunAccountOwnedNotes(reopened, owners), request, descriptor),
      baseline
    );
    assert.ok(!reopened.signal.aborted);
    // A later exact review still needs its existing 120-second admission margin.
    assert.ok(request.binding.fields.feeExpiration - wall >= 120000);
    const close = () => {
      clearTimeout(timer);
      closeScope();
    };
    reopened.signal.addEventListener('abort', close, { once: true });
    scope.signal.addEventListener(
      'abort',
      () => reopened.signal.removeEventListener('abort', close),
      { once: true }
    );
    const evidence = freeze({
      bindings,
      request: request.data,
      baseline,
      state,
      noteWitness,
      creator,
      verified,
      spendingEnabled: false,
    });
    const current = (window) => {
      rejoin();
      assert.ok(!reopened.signal.aborted);
      assert.equal(reopened.generationId, generationId);
      let owned;
      if (window === undefined) owned = readRailgunAccountOwnedNotes(reopened, owners);
      else {
        const data = assertRailgunAccountRelayWindow(window, reopened, owners);
        assert.deepEqual(data.selection, baseline.selection);
        assert.equal(data.checkpointHash, baseline.checkpointHash);
        owned = data.owned;
      }
      assert.deepEqual(selectionSnapshot(owned, request, descriptor), baseline);
      rejoin();
      return evidence;
    };
    current();
    const receipt = Object.freeze({});
    receipts.set(receipt, { account: reopened, owners, request, current, signal: scope.signal });
    handoff.release();
    handoff = undefined;
    succeeded = true;
    return Object.freeze({
      status: 'staged',
      account: reopened,
      receipt,
      close,
      signal: scope.signal,
      observation: Object.freeze({
        phaseHandoffComplete: true,
        stagedCreatorSourceAuthenticated: true,
        stagedWitnessVerified: true,
        rootAcceptedInOperation: false,
        spendingEnabled: false,
      }),
    });
  } catch (error) {
    failure = error;
    if (unknownExit(error)) {
      try {
        quarantineRailgunIdentityCredentials(identity);
      } catch {
        /* Exclusion still remains. */
      }
    }
    throw error;
  } finally {
    if (!succeeded) {
      clearTimeout(timer);
      closeScope();
      // The coordinator may reject its race before this original callback ends.
      if (creatorWork) await Promise.allSettled([creatorWork]);
      const closing = [];
      if (handoff && !oldClosed) closing.push(Promise.resolve().then(() => closeOwner(account)));
      if (txid) closing.push(Promise.resolve().then(() => closeOwner(txid)));
      if (reopened) closing.push(Promise.resolve().then(() => closeOwner(reopened)));
      await Promise.allSettled(closing);
      if (!drainUncertain && !unknownExit(failure)) handoff?.release();
      // Preserve a typed verifier failure over unrelated failed cleanup.
      assert.ok(!drainUncertain || unknownExit(failure), drainFailed());
    }
  }
}
exports.stageRailgunRelayTransactInput = async (options) => {
  const outcome = { stage: 'local', originalAccountReusable: true };
  try {
    return await stage(options, outcome);
  } catch (error) {
    if (unknownExit(error) || error?.code === 'RAILGUN_RELAY_TRANSACT_STAGING_DRAIN_FAILED')
      throw error;
    return Object.freeze({ status: 'refused', ...outcome });
  }
};
exports.assertRailgunRelayTransactStaging = (receipt, account, owners, request, window) => {
  try {
    const entry = receipts.get(receipt);
    assert.ok(entry && entry.account === account);
    for (const key of ['identity', 'enrollment', 'coordinator'])
      assert.equal(entry.owners[key], owners[key]);
    const captured = captureRequest(request);
    assert.equal(captured.signal, entry.request.signal);
    assert.deepEqual(captured.data, entry.request.data);
    return entry.current(window);
  } catch {
    throw fail();
  }
};
exports.assertRailgunRelayTransactStagingAvailable = (receipt, account, owners, request) => {
  try {
    const evidence = exports.assertRailgunRelayTransactStaging(receipt, account, owners, request);
    const entry = receipts.get(receipt);
    assert.ok(!entry.claimed);
    assert.ok(entry.request.binding.fields.feeExpiration - Date.now() >= 120000);
    return Object.freeze({ evidence, signal: entry.signal });
  } catch {
    throw fail();
  }
};
exports.claimRailgunRelayTransactStaging = (receipt, account, owners, request, window) => {
  try {
    assert.ok(window);
    const evidence = exports.assertRailgunRelayTransactStaging(
      receipt,
      account,
      owners,
      request,
      window
    );
    const entry = receipts.get(receipt);
    assert.ok(!entry.claimed);
    const data = assertRailgunAccountRelayWindow(window, account, entry.owners);
    assert.match(data.draftDigest, /^[0-9a-f]{64}$/);
    assert.match(data.summaryDigest, /^[0-9a-f]{64}$/);
    entry.claimed = true;
    const assertCurrent = (margin = 0) => {
      assert.equal(assertRailgunAccountRelayWindow(window, account, entry.owners, margin), data);
      assert.equal(entry.current(window), evidence);
      return evidence;
    };
    return Object.freeze({
      assertCurrent,
      signal: AbortSignal.any([entry.signal, data.signal]),
      draftDigest: data.draftDigest,
      summaryDigest: data.summaryDigest,
    });
  } catch {
    throw fail();
  }
};
