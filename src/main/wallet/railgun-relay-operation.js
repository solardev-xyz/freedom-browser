/** Fixed fresh Shield-input local relay operation. No transport or export path.
 * WeakMap permits bind genuine live owners; persisted data is never a permit.
 * All original work settles before return. Ambiguous work retains exclusion.
 */
const assert = require('assert/strict');
const { types } = require('util');
const { createHash, randomBytes } = require('crypto');
const wallet = require('./railgun-account-wallet');
const identityApi = require('./railgun-identity');
const enrollmentApi = require('./railgun-account-enrollment');
const poiApi = require('./railgun-account-poi');
const preflightApi = require('./railgun-private-preflight');
const { shape, freeze, normalizeRailgunRelayQuote } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const {
  decodeRailgunRelayLocalRecord,
  digestRailgunRelayLocalIntent,
} = require('./railgun-relay-recovery-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { verifyRailgunRelaySignature } = require('./railgun-relay-signature-verify');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const busy = new WeakSet();
const disclosures = new WeakMap(),
  signings = new WeakMap(),
  issuances = new WeakMap(),
  proofs = new WeakMap(),
  coldProofs = new WeakMap();
const hash = (value) =>
  createHash('sha256')
    .update('freedom:railgun:relay-local-gates-v4\0')
    .update(JSON.stringify(value))
    .digest('hex');
const failure = () =>
  Object.assign(new Error('Railgun relay operation refused'), {
    code: 'RAILGUN_RELAY_OPERATION_REFUSED',
  });
const unknown = () => Object.assign(failure(), { code: 'RAILGUN_WALLET_EXIT_UNOBSERVED' });
const isUnknown = (error) =>
  [
    'RAILGUN_WALLET_EXIT_UNOBSERVED',
    'RAILGUN_RELAY_CONTINUATION_DRAIN_FAILED',
    'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED',
    'RAILGUN_RESERVATIONS_DRAIN_UNOBSERVED',
  ].includes(error?.code);
function sameOwners(a, b) {
  shape(b, ['identity', 'enrollment', 'coordinator']);
  for (const key of ['identity', 'enrollment', 'coordinator']) assert.equal(a[key], b[key]);
}
function consume(map, token, account, owners, window) {
  const entry = map.get(token);
  assert.ok(entry && !entry.used && entry.live);
  assert.equal(entry.account, account);
  assert.equal(entry.window, window);
  sameOwners(entry.owners, owners);
  entry.used = true;
  entry.current();
  return entry;
}
function consumeRailgunRelayDisclosurePermit(token, account, owners, window) {
  consume(disclosures, token, account, owners, window);
}
function consumeRailgunRelaySigningPermit(token, identity, signer) {
  const entry = signings.get(token);
  assert.ok(entry && entry.live && !entry.used);
  assert.equal(entry.owners.identity, identity);
  assert.equal(entry.signer, signer);
  entry.used = true;
  entry.current();
  identityApi.assertRailgunRelaySigner(signer, identity, entry.binding);
  return Object.freeze({ assertCurrent: entry.assertKeyCurrent, issued: entry.issued });
}
function consumeRailgunRelayIssuancePermit(token, account, owners, window, signer) {
  const entry = consume(issuances, token, account, owners, window);
  assert.equal(entry.signer, signer);
  identityApi.assertRailgunRelayCredentialIssuance(signer, owners.identity, entry.binding);
  return Object.freeze({ ...entry.binding });
}
function consumeRailgunRelayProofPermit(token, account, owners, window) {
  return consume(window === undefined ? coldProofs : proofs, token, account, owners, window).value;
}
// Observe only a native original, never a caller thenable/species return.
function original(value) {
  if (!types.isPromise(value) || types.isProxy(value)) throw unknown();
  return new Promise((resolve, reject) => {
    try {
      Promise.prototype.then.call(value, resolve, reject);
    } catch {
      reject(unknown());
    }
  });
}
async function proveRailgunAccountRelayOperation(options) {
  let owner,
    admitted = false,
    unobserved = false,
    operationId,
    stage = 'admission';
  let operationLive = true;
  let signingAttempted = false,
    signatureSaved = false;
  const tokens = [];
  try {
    shape(options, [
      'account',
      'owners',
      'request',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'review',
      'reviewDisclosure',
    ]);
    shape(options.owners, ['identity', 'enrollment', 'coordinator']);
    shape(options.request, ['noteId', 'quote', 'gas', 'maxFee', 'signal']);
    const account = options.account,
      owners = Object.freeze({ ...options.owners });
    const { identity, enrollment } = owners;
    owner = enrollment;
    assert.ok(!busy.has(owner));
    enrollmentApi.assertRailgunFencedAccountEnrollment(enrollment);
    const parent = enrollment.getContext('engine');
    const descriptor = identityApi.assertRailgunIdentity(identity, parent);
    const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
    const quote = normalizeRailgunRelayQuote(options.request.quote, options.request.gas);
    assertRailgunRelaySignal(options.request.signal);
    assert.equal(typeof options.request.noteId, 'string');
    assert.match(options.request.maxFee, /^(?:0|[1-9][0-9]*)$/);
    const cancellation = new AbortController();
    const signal = AbortSignal.any([options.request.signal, cancellation.signal]);
    const request = Object.freeze({
      noteId: options.request.noteId,
      quote: quote.quote,
      gas: quote.gas,
      maxFee: options.request.maxFee,
      signal,
    });
    const { archive, proverArchive, artifactDirectory, review, reviewDisclosure } = options;
    for (const callback of [review, reviewDisclosure])
      assert.ok(typeof callback === 'function' && !types.isProxy(callback));
    for (const value of [archive, proverArchive, artifactDirectory])
      assert.ok(typeof value === 'string' && require('path').isAbsolute(value));
    const selected = baseline.ownedPoi.filter((note) => note.id === request.noteId);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].type, 'Shield');
    const input = freeze({ ...selected[0] });
    busy.add(owner);
    admitted = true;
    let reservations, recoveryStore;
    const result = await original(
      wallet.operateRailgunAccountRelayIntent(account, owners, request, {
        review,
        async onPrepared(offer, { window, signal: windowSignal }) {
          let poi,
            poiDrain,
            preflight,
            timer,
            localCurrent,
            keyRequested = false,
            operationError,
            operationFailed = false,
            closeFailed = false;
          let last = performance.now();
          const data = wallet.assertRailgunAccountRelayWindow(window, account, owners);
          const draft = normalizeRailgunRelayDraftCapsule(offer.preparation.data);
          const intent = normalizeRailgunRelayUnsignedIntent(draft.data.intent);
          assert.equal(draft.digest, data.draftDigest);
          assert.equal(offer.review.summaryDigest, data.summaryDigest);
          assert.equal(draft.data.walletId, descriptor.walletId);
          assert.equal(draft.data.noteHash, input.hash);
          assert.equal(draft.data.intent.expected.nullifier, input.nullifier);
          assert.equal(data.checkpointHash, baseline.checkpointHash);
          assert.deepEqual(draft.data.selection, data.selection);
          const current = (margin = 0) => {
            const now = performance.now();
            assert.ok(
              operationLive &&
                !signal.aborted &&
                !windowSignal.aborted &&
                now >= last &&
                now + margin < data.deadline
            );
            last = now;
            enrollmentApi.assertRailgunFencedAccountEnrollment(enrollment);
            assert.deepEqual(identityApi.assertRailgunIdentity(identity, parent), descriptor);
            if (localCurrent) localCurrent();
            else
              assert.equal(
                wallet.assertRailgunAccountRelayWindow(window, account, owners, margin),
                data
              );
          };
          const budget = (maximum, reserve) => {
            current(reserve);
            const remaining = Math.min(
              maximum,
              Math.floor(data.deadline - performance.now() - reserve)
            );
            assert.ok(remaining > 0);
            return remaining;
          };
          const mint = (map, value) => {
            const token = Object.freeze({});
            const entry = { account, owners, window, current, live: true, used: false, ...value };
            map.set(token, entry);
            tokens.push([map, token, entry]);
            return token;
          };
          try {
            current(115000);
            stage = 'disclosure';
            const disclosureSummary = freeze({
              purpose: 'railgun-relay-selected-input-disclosure-v1',
              draftDigest: draft.digest,
              summaryDigest: data.summaryDigest,
              listKey: REQUIRED_LIST,
              input: {
                id: input.id,
                noteHash: input.hash,
                nullifier: input.nullifier,
                blindedCommitment: input.blindedCommitment,
                type: 'Shield',
              },
              disclosures: ['selected-poi-membership', 'selected-nullifier-status'],
              signingEnabled: false,
              relaySendPermitted: false,
            });
            timer = setTimeout(() => cancellation.abort(), budget(30000, 115000));
            timer.unref?.();
            let decision = reviewDisclosure(
              disclosureSummary,
              Object.freeze({ signal: windowSignal })
            );
            if (types.isPromise(decision) && !types.isProxy(decision))
              decision = await original(decision);
            else if (decision !== null && ['object', 'function'].includes(typeof decision))
              throw unknown();
            clearTimeout(timer);
            timer = undefined;
            current(115000);
            assert.equal(decision, true);
            stage = 'membership';
            const disclosure = mint(disclosures, {});
            poi = poiApi.openRailgunRelayWindowPoi({
              wallet: account,
              ...owners,
              archive,
              window,
              disclosure,
            });
            wallet.retainRailgunRelayWindowPoi(window, account, owners, poi);
            poiDrain = original(poi.closed);
            poiDrain.catch(() => {});
            const acquired = await original(poi.acquire({ timeoutMs: budget(45000, 115000) }));
            current(115000);
            assert.equal(acquired.status, 'verified');
            const poiValue = poiApi.assertRailgunRelayWindowPoi(
              poi,
              acquired.receipt,
              account,
              owners,
              window
            );
            for (const [key, expected] of Object.entries({
              id: input.id,
              type: 'Shield',
              noteHash: input.hash,
              nullifier: input.nullifier,
              checkpointHash: baseline.checkpointHash,
            }))
              assert.equal(poiValue.input[key], expected);
            const history = poiApi.readRailgunRelayWindowPoiHistory(
              poi,
              acquired.receipt,
              account,
              owners,
              window
            );
            stage = 'binding';
            const binding = await original(
              wallet.prepareRailgunAccountRelayPrePoi(window, account, owners, {
                draftText: JSON.stringify(draft.data),
                history: history.data,
              })
            );
            current(90000);
            assert.equal(binding.draftDigest, draft.digest);
            assert.equal(
              binding.historyDigest,
              normalizeRailgunRelayPoiHistory(history.data).digest
            );
            assert.equal(binding.expectedHash, intent.data.expectedHash);
            stage = 'preflight';
            const preflightInput = Object.freeze({
              tree: draft.data.selection.tree,
              merkleRoot: intent.data.expected.merkleRoot,
              nullifier: input.nullifier,
              checkpointHash: baseline.checkpointHash,
              minimumBlock: baseline.read.readiness.to.number,
            });
            preflight = preflightApi.createRailgunRelayPreflight({
              enrollment,
              artifactDirectory,
              input: preflightInput,
            });
            timer = setTimeout(() => preflight.close(), budget(15000, 90000));
            timer.unref?.();
            const checked = await original(preflight.acquire());
            clearTimeout(timer);
            timer = undefined;
            current(90000);
            const preflightValue = preflightApi.assertRailgunRelayPreflight(
              preflight,
              checked.receipt,
              enrollment
            );
            assert.deepEqual(preflightValue.input, preflightInput);
            const gates = () => {
              current(90000);
              assert.equal(
                poiApi.assertRailgunRelayWindowPoi(
                  poi,
                  acquired.receipt,
                  account,
                  owners,
                  window,
                  5000
                ),
                poiValue
              );
              assert.equal(
                preflightApi.assertRailgunRelayPreflight(
                  preflight,
                  checked.receipt,
                  enrollment,
                  5000
                ),
                preflightValue
              );
            };
            gates();
            reservations = await original(enrollment.openReservations());
            gates();
            recoveryStore = await original(enrollment.openRelayRecoveryStore());
            gates();
            const authorizationDigest = hash({
              draftDigest: draft.digest,
              summaryDigest: data.summaryDigest,
              history: history.data,
              binding: binding.binding,
              poi: poiValue,
              preflight: preflightValue,
            });
            operationId = randomBytes(32).toString('hex');
            const row = decodeRailgunRelayLocalRecord(
              JSON.stringify({
                schema: 'railgun-relay-local-record-v4',
                id: operationId,
                binding: enrollment.binding,
                walletId: descriptor.walletId,
                generationId: account.generationId,
                checkpointHash: baseline.checkpointHash,
                authorizationDigest,
                draft: draft.data,
                history: history.data,
                prePoiBinding: binding.binding,
                state: 'held',
                signature: null,
                proved: null,
              })
            );
            const recordDigest = digestRailgunRelayLocalIntent(JSON.stringify(row));
            const signerBinding = Object.freeze({ intent: intent.data, recordDigest });
            stage = 'reserve';
            const held = await original(
              reservations.reserveRelay(recoveryStore, JSON.stringify(row))
            );
            gates();
            assert.equal(held.recordDigest, recordDigest);
            assert.equal(held.interruptedStep, null);
            assert.equal(held.record.state, 'held');
            stage = 'signing-marker';
            signingAttempted = true;
            await original(reservations.markRelaySigning(recoveryStore, held.receipt));
            gates();
            const pair = async (state) => {
              current();
              const value = await original(reservations.readRelay(recoveryStore, operationId));
              current();
              assert.equal(value.interruptedStep, null);
              assert.equal(value.recordDigest, recordDigest);
              assert.equal(value.record.state, state);
              assert.equal(value.entry.state, 'signing-local');
              assert.equal(value.entry.signing.recordDigest, recordDigest);
              assert.equal(value.entry.signing.gatesDigest, authorizationDigest);
              return value;
            };
            await pair('signing-local');
            gates();
            stage = 'signer';
            const signed = await original(
              identityApi.signRailgunRelayIntent({
                identity,
                archive,
                intent: intent.data,
                recordDigest,
                signal: windowSignal,
                timeoutMs: budget(15000, 75000),
                async onKeyRequest(validated, signer) {
                  assert.ok(!keyRequested);
                  keyRequested = true;
                  gates();
                  identityApi.assertRailgunRelaySigner(signer, identity, signerBinding);
                  assert.deepEqual(validated, {
                    recordDigest,
                    intentDigest: intent.digest,
                    expectedHash: intent.data.expectedHash,
                  });
                  const assertKeyCurrent = async () => {
                    gates();
                    identityApi.assertRailgunRelaySigner(signer, identity, signerBinding);
                    await pair('signing-local');
                    gates();
                    identityApi.assertRailgunRelaySigner(signer, identity, signerBinding);
                  };
                  await assertKeyCurrent();
                  return mint(signings, {
                    signer,
                    binding: signerBinding,
                    assertKeyCurrent,
                    issued() {
                      assert.ok(!localCurrent);
                      gates();
                      identityApi.assertRailgunRelayCredentialIssuance(
                        signer,
                        identity,
                        signerBinding
                      );
                      const permit = mint(issuances, { signer, binding: signerBinding });
                      const local = wallet.recordRailgunAccountRelayCredentialIssuance(
                        window,
                        account,
                        owners,
                        signer,
                        permit
                      );
                      shape(local, ['assertCurrent']);
                      assert.equal(typeof local.assertCurrent, 'function');
                      localCurrent = local.assertCurrent;
                      current();
                    },
                  });
                },
              })
            );
            current();
            assert.ok(localCurrent);
            assert.equal(signed.recordDigest, recordDigest);
            assert.equal(signed.intentDigest, intent.digest);
            assert.equal(signed.message, intent.data.expectedHash);
            stage = 'signature-verification';
            const signatureCheck = await original(
              verifyRailgunRelaySignature({
                enrollment,
                identity,
                archive,
                intent: intent.data,
                recordDigest,
                signature: signed.signature,
                signal: windowSignal,
                timeoutMs: budget(15000, 60000),
              })
            );
            current();
            assert.deepEqual(signatureCheck, {
              recordDigest,
              intentDigest: intent.digest,
              message: intent.data.expectedHash,
              signatureDigest: createHash('sha256')
                .update(JSON.stringify(signed.signature))
                .digest('hex'),
              signatureVerified: true,
            });
            await pair('signing-local');
            current();
            stage = 'signature-storage';
            await original(recoveryStore.saveSignature(operationId, signed.signature));
            current();
            const saved = await pair('signed');
            assert.deepEqual(saved.record.signature, signed.signature);
            signatureSaved = true;
            const value = Object.freeze({
              reservations,
              recoveryStore,
              operationId,
              recordText: JSON.stringify(saved.record),
              archive,
              proverArchive,
              artifactDirectory,
              assertCurrent: () => current(),
            });
            const permit = mint(proofs, { value });
            stage = 'proof';
            const staged = await original(
              wallet.completeRailgunAccountRelayProof(account, owners, { window, permit })
            );
            current();
            assert.deepEqual(staged, { status: 'proof-staged', operationId });
          } catch (error) {
            operationFailed = true;
            operationError = error;
          } finally {
            clearTimeout(timer);
            // Keep the account window live through original source closure.
            try {
              preflight?.close();
            } catch {
              closeFailed = true;
            }
            try {
              poi?.close();
            } catch {
              closeFailed = true;
            }
            if (poiDrain) {
              try {
                await poiDrain;
              } catch {
                closeFailed = true;
              }
            } else if (poi) closeFailed = true;
          }
          if (closeFailed) throw unknown();
          if (operationFailed) throw operationError;
        },
      })
    );
    assert.deepEqual(result, { status: 'ready-local', operationId });
    return Object.freeze({ status: 'ready-local', operationId });
  } catch (error) {
    if (isUnknown(error)) {
      unobserved = true;
      throw unknown();
    }
    return Object.freeze({
      status: operationId ? 'recovery-required' : 'refused',
      stage,
      ...(operationId ? { operationId, signingAttempted, signatureSaved } : {}),
    });
  } finally {
    operationLive = false;
    for (const [map, token, entry] of tokens) {
      entry.live = false;
      map.delete(token);
    }
    if (admitted && !unobserved) busy.delete(owner);
  }
}
// Existing-only discovery/actions use the original completed-account lifetime.
// No public callback, quote renewal, signer or disclosure exists in this route.
async function coldOperation(options, action) {
  let owner,
    admitted = false,
    unobserved = false,
    permit,
    permitEntry;
  let operationId,
    stage = 'cold-admission',
    live = true;
  try {
    const selected = action === 'list' ? ['after'] : ['operationId'];
    shape(options, [
      'account',
      'owners',
      'signal',
      ...selected,
      ...(action === 'resume' ? ['archive', 'proverArchive', 'artifactDirectory'] : []),
    ]);
    shape(options.owners, ['identity', 'enrollment', 'coordinator']);
    const account = options.account,
      owners = Object.freeze({ ...options.owners });
    const { identity, enrollment } = owners;
    owner = enrollment;
    assert.ok(!busy.has(owner));
    assertRailgunRelaySignal(options.signal);
    const signal = options.signal;
    const after = action === 'list' ? options.after : null;
    if (action === 'list')
      assert.ok(after === null || (typeof after === 'string' && /^[0-9a-f]{64}$/.test(after)));
    else {
      operationId = options.operationId;
      assert.match(operationId, /^[0-9a-f]{64}$/);
    }
    const paths =
      action === 'resume'
        ? Object.freeze({
            archive: options.archive,
            proverArchive: options.proverArchive,
            artifactDirectory: options.artifactDirectory,
          })
        : null;
    if (paths)
      for (const value of Object.values(paths))
        assert.ok(typeof value === 'string' && require('path').isAbsolute(value));
    enrollmentApi.assertRailgunFencedAccountEnrollment(enrollment);
    const parent = enrollment.getContext('engine');
    const descriptor = identityApi.assertRailgunIdentity(identity, parent);
    const state = wallet.readRailgunCompletedAccountRelayState(account, owners);
    assert.equal(state.walletId, descriptor.walletId);
    assert.equal(state.binding, enrollment.binding);
    assert.ok(Number.isFinite(state.deadline));
    assertRailgunRelaySignal(state.signal);
    let monotonic = performance.now();
    const current = () => {
      const now = performance.now();
      assert.ok(
        live && now >= monotonic && now < state.deadline && !signal.aborted && !state.signal.aborted
      );
      monotonic = now;
      state.assertCurrent();
      enrollmentApi.assertRailgunFencedAccountEnrollment(enrollment);
      assert.deepEqual(identityApi.assertRailgunIdentity(identity, parent), descriptor);
    };
    current();
    busy.add(owner);
    admitted = true;
    // Existing-only opens may rotate an authenticated lease/repair a lagging
    // floor. They neither create absent history nor adopt unregistered files.
    stage = 'cold-stores';
    const reservations = await original(enrollment.openReservations({ existingOnly: true }));
    current();
    const recoveryStore = await original(enrollment.openRelayRecoveryStore({ existingOnly: true }));
    current();
    const storesCurrent = () => {
      current();
      require('./railgun-private-reservations').assertRailgunPrivateReservationsOwner(
        reservations,
        {
          handle: enrollment.getContext(
            'storage',
            'railgun-private-reservations-v1:' + descriptor.walletId
          ),
          binding: enrollment.binding,
          walletId: descriptor.walletId,
          directory: enrollment.directory,
        }
      );
      require('./railgun-relay-recovery-store').assertRailgunRelayRecoveryStoreOwner(
        recoveryStore,
        enrollment
      );
    };
    storesCurrent();
    const read = async (id) => {
      storesCurrent();
      const pair = await original(reservations.readRelay(recoveryStore, id));
      storesCurrent();
      assert.equal(pair.entry.id, id);
      assert.equal(pair.entry.origin, 'relay-local-v4');
      if (pair.record !== null) {
        assert.equal(pair.record.id, id);
        assert.equal(pair.record.binding, enrollment.binding);
        assert.equal(pair.record.walletId, descriptor.walletId);
      }
      return pair;
    };
    if (action === 'list') {
      stage = 'history';
      const entries = await original(reservations.listRelay(recoveryStore));
      storesCurrent();
      assert.ok(Array.isArray(entries) && entries.length <= 512);
      const ids = new Set();
      for (const entry of entries) {
        assert.match(entry.id, /^[0-9a-f]{64}$/);
        assert.ok(!ids.has(entry.id));
        ids.add(entry.id);
      }
      const ordered = [...entries]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((row) => after === null || row.id > after);
      const records = [];
      for (const entry of ordered.slice(0, 16)) {
        const pair = await read(entry.id);
        records.push(
          Object.freeze({
            operationId: entry.id,
            reservationState: pair.entry.state,
            localState: pair.record?.state ?? 'record-unavailable',
            interruptedStep: pair.interruptedStep,
          })
        );
      }
      storesCurrent();
      return Object.freeze({
        records: Object.freeze(records),
        nextAfter: ordered.length > 16 ? records.at(-1).operationId : null,
      });
    }
    stage = 'cold-read';
    const paired = await read(operationId);
    if (action === 'discard') {
      stage = 'local-discard';
      await original(reservations.discardRelayLocal(recoveryStore, paired.receipt));
      storesCurrent();
      const ended = await read(operationId);
      assert.equal(ended.interruptedStep, null);
      assert.ok(['cancelled-unsigned', 'discarded-signed'].includes(ended.entry.state));
      if (ended.record) {
        assert.equal(ended.record.state, ended.entry.state);
        assert.equal(
          digestRailgunRelayLocalIntent(JSON.stringify(ended.record)),
          paired.recordDigest
        );
        assert.deepEqual(ended.record.signature, paired.record.signature);
        assert.deepEqual(ended.record.proved, paired.record.proved);
      } else assert.equal(ended.entry.state, 'cancelled-unsigned');
      return Object.freeze({ status: ended.entry.state, operationId });
    }
    stage = 'cold-proof';
    assert.equal(paired.interruptedStep, null);
    assert.equal(paired.entry.state, 'signing-local');
    assert.ok(
      paired.record &&
        ['signed', 'ready-local'].includes(paired.record.state) &&
        paired.record.signature
    );
    assert.equal(paired.record.history.note.type, 'Shield');
    const recordText = JSON.stringify(paired.record);
    assert.equal(paired.recordDigest, digestRailgunRelayLocalIntent(recordText));
    // Pure ownership projection only; actual custody/permit keeps original bytes.
    // No historical generation/checkpoint rewrite or current-root equality.
    const signedProjection =
      paired.record.state === 'signed'
        ? recordText
        : JSON.stringify({ ...paired.record, state: 'signed', proved: null });
    require('./railgun-relay-proof-results').bindRailgunRelayLocalOwned(signedProjection, {
      walletId: state.walletId,
      ...state.owned,
    });
    storesCurrent();
    permit = Object.freeze({});
    permitEntry = {
      account,
      owners,
      window: undefined,
      current: storesCurrent,
      live: true,
      used: false,
      value: Object.freeze({
        reservations,
        recoveryStore,
        operationId,
        recordText,
        ...paths,
        assertCurrent: storesCurrent,
      }),
    };
    coldProofs.set(permit, permitEntry);
    const result = await original(
      wallet.completeRailgunAccountRelayProof(account, owners, { permit, signal })
    );
    storesCurrent();
    assert.deepEqual(result, { status: 'ready-local', operationId });
    const ready = await read(operationId);
    assert.equal(ready.interruptedStep, null);
    assert.equal(ready.record.state, 'ready-local');
    assert.equal(ready.recordDigest, paired.recordDigest);
    assert.deepEqual(ready.record.signature, paired.record.signature);
    if (paired.record.state === 'ready-local')
      assert.equal(JSON.stringify(ready.record), recordText);
    return Object.freeze({ status: 'ready-local', operationId });
  } catch (error) {
    if (isUnknown(error)) {
      unobserved = true;
      throw unknown();
    }
    if (action === 'list') throw failure();
    return Object.freeze({ status: 'refused', stage, ...(operationId ? { operationId } : {}) });
  } finally {
    live = false;
    if (permit) {
      permitEntry.live = false;
      coldProofs.delete(permit);
    }
    if (admitted && !unobserved) busy.delete(owner);
  }
}
function listRailgunAccountRelayOperations(options) {
  return coldOperation(options, 'list');
}
function resumeRailgunAccountRelayOperation(options) {
  return coldOperation(options, 'resume');
}
function discardRailgunAccountRelayOperation(options) {
  return coldOperation(options, 'discard');
}
module.exports = {
  listRailgunAccountRelayOperations,
  resumeRailgunAccountRelayOperation,
  discardRailgunAccountRelayOperation,
  proveRailgunAccountRelayOperation,
  consumeRailgunRelayDisclosurePermit,
  consumeRailgunRelaySigningPermit,
  consumeRailgunRelayIssuancePermit,
  consumeRailgunRelayProofPermit,
};
