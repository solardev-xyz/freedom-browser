/** Connected, disposable partial lifecycle. Every admission/receipt/record is
 * production-issued; service replies and the two review callbacks are fixtures.
 * Same-process encrypted reopen is not process restart or change eligibility. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const copy = (v) => JSON.parse(JSON.stringify(v));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const delta = (a, b) =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] || 0) - (b[k] || 0)])
  );
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
exports.createAudit = () => {
  let fault = false;
  const facts = {
    outputInputs: 0,
    changedOutputs: 0,
    attemptedResults: {},
    admittedResults: {},
    keyRequests: {},
    keyReplies: {},
    starts: {},
    exits: {},
    guards: {},
    modes: {},
  };
  const forbidden = new Set([
    'blindedCommitmentsOut',
    'railgunTxidIfHasUnshield',
    'payload',
    'listProofs',
    'viewingPrivateKey',
    'spendingPrivateKey',
  ]);
  const walk = (v) => {
    if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        assert.equal(forbidden.has(k), false);
        walk(x);
      }
  };
  return {
    snapshot: () => copy(facts),
    fault: (value) => {
      fault = value;
    },
    start(options) {
      const job = path.basename(options.filename);
      facts.starts[job] = (facts.starts[job] || 0) + 1;
      if (job === 'railgun-txid-job.js') {
        const mode = JSON.parse(options.input).mode;
        facts.modes[mode] = (facts.modes[mode] || 0) + 1;
      }
      if (job === 'railgun-poi-output-recover-job.js') {
        const input = JSON.parse(options.input);
        walk(input);
        assert.deepEqual(Object.keys(input).sort(), [
          'archive',
          'binding',
          'descriptor',
          'preparation',
        ]);
        assert.equal(input.preparation.ownEvidence.capsule.version, 2);
        assert.equal(
          input.preparation.ownEvidence.capsule.preparation.expected.kind,
          'railgun-partial-unshield'
        );
        facts.outputInputs++;
      }
      return job;
    },
    before(job, wire) {
      const m = JSON.parse(wire);
      if (m.method === 'key') facts.keyRequests[job] = (facts.keyRequests[job] || 0) + 1;
      if (['result', 'jobResult'].includes(m.method)) {
        facts.attemptedResults[job] = (facts.attemptedResults[job] || 0) + 1;
        if (m.value?.guards) {
          assert.equal(m.value.guards.attempts, 0);
          assert.equal(m.value.guards.canaries, m.value.guards.hooks.length);
          assert.ok(m.value.guards.canaries > 0);
          facts.guards[job] = (facts.guards[job] || 0) + 1;
        }
        if (fault && job === 'railgun-poi-output-recover-job.js') {
          const out = m.value.output;
          assert.equal(out.blindedCommitmentsOut.length, 1);
          out.blindedCommitmentsOut[0] =
            '0x' +
            (BigInt(out.blindedCommitmentsOut[0]) === 1n ? 2n : 1n).toString(16).padStart(64, '0');
          facts.changedOutputs++;
          return JSON.stringify(m);
        }
      }
      return wire;
    },
    admitted(job, message) {
      if (message.method === 'key') facts.keyReplies[job] = (facts.keyReplies[job] || 0) + 1;
      if (['result', 'jobResult'].includes(message.method))
        facts.admittedResults[job] = (facts.admittedResults[job] || 0) + 1;
    },
    closed(job, value) {
      assert.ok(['RAILGUN_PROCESS_CLOSED', 'RAILGUN_SESSION_REVOKED'].includes(value.code));
      assert.ok(Number.isInteger(value.exitCode));
      facts.exits[job] = (facts.exits[job] || 0) + 1;
    },
  };
};
exports.run = async (h) => {
  const {
    archive,
    proverArchive,
    artifactDirectory,
    identity,
    selector,
    capture,
    chain,
    audit,
    inputCreator,
  } = h;
  let { enrollment, publicAccount } = h,
    store,
    membership;
  const runs = [];
  let continuation;
  const setPhase = (name) => h.phase('combined-' + name);
  const common = () => ({
    identity,
    enrollment,
    coordinator: publicAccount.coordinator,
    archive,
    signal: enrollment.signal,
  });
  const activity = () => copy({ ...h.activity(), chain: chain.report(), audit: audit.snapshot() });
  const assertDrain = () => {
    sticky.assertEmpty();
    assert.equal(h.pendingChildren(), 0);
    const s = audit.snapshot();
    assert.deepEqual(s.starts, s.exits);
    assert.equal(h.unwipedLoans(), 0);
  };
  const proofModule = require('../../src/main/wallet/railgun-own-poi-proof');
  const membershipModule = require('../../src/main/wallet/railgun-own-poi-membership');
  const options = () => ({ ...common(), capsuleDigest: capture.capsuleDigest });
  const cold = () => ({ ...options(), proverArchive, artifactDirectory });
  const output = require('../../src/main/wallet/railgun-poi-output-recovery');
  const validation = require('../../src/main/wallet/railgun-poi-cold-validation');
  const checks = require('../../src/main/wallet/railgun-own-poi-checks');
  const plans = require('../../src/main/wallet/railgun-poi-disclosure-plan');
  const { getPrivacyStoragePath } = require('../../src/main/wallet/privacy-storage');
  const { claimRailgunAccountPhase } = require('../../src/main/wallet/railgun-account-phase');
  const privateRecords = async () => {
    const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
    let signed;
    await reservations.withSigningRecovery(async (records, context) => {
      assert.equal(records.length, 1);
      context.assertCurrent();
      signed = {
        entry: copy(records[0].entry),
        stored: copy(await capsules.readSigned(records[0].receipt)),
      };
      context.assertCurrent();
    });
    return signed;
  };
  const durable = async () => {
    const encrypted = {};
    for (const [name, subject] of Object.entries({
      intent: 'railgun-poi-intents-v1:',
      reservations: 'railgun-private-reservations-v1:',
      capsules: 'railgun-private-capsules-v1:',
    })) {
      const file = getPrivacyStoragePath(
        enrollment.getContext('storage', subject + enrollment.descriptor.walletId),
        enrollment.directory
      );
      encrypted[name] = sha(fs.readFileSync(file));
    }
    const manifest = path.join(
      path.dirname(enrollment.directory),
      path.basename(enrollment.directory).replace(/^account-/, '') + '.json'
    );
    return {
      entry: copy(await store.get(capture.capsuleDigest)),
      inspect: await store.inspect(),
      journal: await h.journal().readSnapshot(),
      privateRecords: await privateRecords(),
      encrypted,
      manifest: sha(fs.readFileSync(manifest)),
    };
  };
  const nonzero = (value) => Object.fromEntries(Object.entries(value).filter(([, n]) => n));
  const verifyActivity = (
    before,
    {
      queried = true,
      viewing = 1,
      verify = 0,
      history = 0,
      roots = 0,
      posts = 0,
      handshake = false,
      substituted = false,
    } = {}
  ) => {
    const after = activity(),
      t = Number(inputCreator === 'Transact'),
      q = Number(queried);
    const expected = {
      'railgun-public-job.js': q,
      'railgun-own-selector-job.js': q * (1 + history),
      'railgun-own-txid-job.js': q,
      'railgun-note-provenance-job.js': q * t,
      'railgun-txid-job.js': q * (3 + 2 * t + 5 * history),
      'railgun-poi-output-recover-job.js': viewing,
      'railgun-poi-verify-job.js': verify,
    };
    assert.deepEqual(nonzero(delta(after.audit.starts, before.audit.starts)), nonzero(expected));
    assert.deepEqual(nonzero(delta(after.audit.exits, before.audit.exits)), nonzero(expected));
    assert.deepEqual(
      nonzero(delta(after.audit.attemptedResults, before.audit.attemptedResults)),
      nonzero(expected)
    );
    const admitted = {
      ...expected,
      'railgun-poi-output-recover-job.js': substituted ? 0 : viewing,
    };
    assert.deepEqual(
      nonzero(delta(after.audit.admittedResults, before.audit.admittedResults)),
      nonzero(admitted)
    );
    assert.deepEqual(nonzero(delta(after.audit.guards, before.audit.guards)), nonzero(expected));
    assert.deepEqual(
      nonzero(delta(after.audit.keyRequests, before.audit.keyRequests)),
      nonzero({ 'railgun-poi-output-recover-job.js': viewing })
    );
    assert.deepEqual(
      nonzero(delta(after.audit.keyReplies, before.audit.keyReplies)),
      nonzero({ 'railgun-poi-output-recover-job.js': viewing })
    );
    assert.deepEqual(
      nonzero(delta(after.audit.modes, before.audit.modes)),
      nonzero({
        inspect: q * (2 + t + 3 * history),
        witness: q * (1 + history),
        'note-witness': q * t,
        'historical-root': q * history,
      })
    );
    const traffic = {
      'public-address:transaction-rpc:eth_chainId': q,
      'public-address:transaction-rpc:eth_getTransactionByHash': q,
      'public-address:transaction-rpc:eth_getTransactionReceipt': q,
      'public-address:transaction-rpc:eth_blockNumber': 2 * q,
      'public-address:transaction-rpc:eth_getBlockByNumber': 11 * q,
      'private-account:protocol-rpc:eth_chainId': Number(handshake),
      // Final range anchor == to; 3 distinct numbered boundaries + finalized,
      // four canonical passes, one actual partial-event block.
      'private-account:protocol-rpc:eth_getBlockByNumber': 17 * q,
      'private-account:protocol-rpc:eth_getLogs': q,
      'service:poi:ppoi_validated_txid': q * (3 + t + 3 * history),
      'service:poi:ppoi_validate_txid_merkleroot': q * (3 + t + 3 * history),
      'private-account:poi:ppoi_validate_poi_merkleroots': roots,
      'private-account:poi:ppoi_validate_txid_merkleroot': roots,
      'private-account:poi:ppoi_submit_transact_proof': posts,
    };
    assert.deepEqual(nonzero(delta(after.roleMethods, before.roleMethods)), nonzero(traffic));
    assert.deepEqual(after.services.poiMethods, before.services.poiMethods);
    assert.deepEqual(after.chain.attempted, after.chain.validated);
    return { jobs: nonzero(expected), methods: nonzero(traffic), allRoleAdmissionsChecked: true };
  };
  const run = async (
    name,
    fn,
    expected,
    stage,
    {
      viewing = 1,
      verify = 0,
      history = 0,
      queried = true,
      roots = 0,
      handshake = false,
      substituted = false,
    } = {}
  ) => {
    setPhase(name);
    const before = activity(),
      disk = await durable(),
      start = performance.now(),
      timingStart = h.timings().length;
    let result;
    try {
      result = await fn();
      assert.equal(result.status, expected, 'connected stage ' + (result.stage ?? 'none'));
      if (stage) assert.equal(result.stage, stage);
      if (expected === 'matched') {
        assert.equal(result.outputMatched, true);
        assert.equal(result.viewingKeyReleases, 1);
        assert.equal(result.viewingUtilityExitObserved, true);
      }
      if (['matched', 'validated'].includes(expected))
        for (const flag of [
          'originalRootsAccepted',
          'membershipAuthenticated',
          'sourceAuthenticated',
          'disclosureEnabled',
          'spendingEnabled',
        ])
          assert.equal(result[flag], false);
      if (expected === 'validated') {
        assert.equal(result.outputMatched, true);
        assert.equal(result.proofVerified, true);
        assert.equal(result.verifierExitObserved, true);
        if (history) assert.equal(result.historicalRootMatchesLocalMirror, true);
      }
    } finally {
      result?.close?.();
      if (result?.closed) await result.closed;
      audit.fault(false);
    }
    assertDrain();
    assert.deepEqual(await durable(), disk);
    const timings = h.timings().slice(timingStart);
    if (queried) {
      assert.equal(timings.filter((v) => v.name === 'retained-source').length, 1);
      assert.equal(timings.filter((v) => v.name === 'retained-preflight').length, 1);
      const tail = timings.find(
        (v) => v.name === 'retained-preflight'
      ).sourceReturnToPreflightCompletionMs;
      assert.ok(Number.isSafeInteger(tail) && tail >= 0 && tail < 55000);
    } else assert.deepEqual(timings, []);
    const exact = verifyActivity(before, {
      viewing,
      verify,
      history,
      queried,
      roots,
      handshake,
      substituted,
    });
    const after = activity(),
      jobs = delta(after.audit.starts, before.audit.starts),
      keys = delta(after.audit.keyReplies, before.audit.keyReplies);
    assert.equal(jobs['railgun-own-poi-prove-job.js'] || 0, 0);
    assert.equal(jobs['railgun-spend-sign-job.js'] || 0, 0);
    assert.equal(jobs['railgun-poi-output-recover-job.js'] || 0, viewing);
    assert.equal(keys['railgun-poi-output-recover-job.js'] || 0, viewing);
    assert.equal(jobs['railgun-poi-verify-job.js'] || 0, verify);
    assert.equal(
      (after.audit.modes['historical-root'] || 0) - (before.audit.modes['historical-root'] || 0),
      history
    );
    if (!queried) assert.deepEqual(after, before);
    assert.equal(after.chain.posts, before.chain.posts);
    // No original-input owned-query requalification in retained diagnostics.
    assert.deepEqual(after.services.poiMethods, before.services.poiMethods);
    runs.push({
      mode: name,
      status: result.status,
      ...(stage ? { stage } : {}),
      elapsedMs: Math.round(performance.now() - start),
      jobs,
      keys,
      originalProofRootPairsExpected: roots,
      exact,
      timings,
      durableBytesUnchanged: true,
      childrenDrained: true,
    });
    return result;
  };
  try {
    setPhase('membership');
    membership = await (
      inputCreator === 'Shield'
        ? membershipModule.openRailgunOwnPoiMembership
        : membershipModule.openRailgunOwnTransactPoiMembership
    )({
      ...(inputCreator === 'Transact' ? { identity } : {}),
      enrollment,
      coordinator: publicAccount.coordinator,
      archive,
      signal: enrollment.signal,
      selector,
    });
    if (membership.status !== 'verified')
      console.error(
        JSON.stringify({
          diagnostic: 'combined-membership',
          status: membership.status,
          stage: membership.stage,
        })
      );
    assert.equal(membership.status, 'verified', 'membership stage ' + membership.stage);
    const observed = membershipModule.assertRailgunOwnPoiMembership(
      membership.receipt,
      enrollment,
      publicAccount.coordinator,
      1000
    );
    assert.equal(observed.capture.capsule.version, 2);
    assert.equal(observed.poiPreparation.creator.type, inputCreator);
    assert.equal(observed.capture.bindingDigest, capture.bindingDigest);
    assert.deepEqual(observed.capture.capsule, capture.capsule);
    const preparation = observed.poiPreparation;
    assert.deepEqual(preparation.ownEvidence.row, chain.continuation.rows.at(-1));
    assert.deepEqual(preparation.ownEvidence.receipt, chain.continuation.receipt);
    assert.deepEqual(preparation.witness.row, preparation.ownEvidence.row);
    continuation = {
      ownEvidence: copy(preparation.ownEvidence),
      state: copy(preparation.state),
      witness: copy(preparation.witness),
      events: copy(chain.continuation.logs),
      rows: copy(chain.continuation.rows),
    };
    const beforeProof = activity();
    setPhase('proof');
    const proof = await proofModule.proveRailgunOwnPoi({
      ...common(),
      proverArchive,
      artifactDirectory,
      membershipReceipt: membership.receipt,
    });
    assert.equal(proof.status, 'proved', 'proof stage ' + proof.stage);
    assert.equal(proof.separatelyVerified, true);
    assert.equal(proof.utilityExitObserved, true);
    for (const flag of [
      'accountAuthenticated',
      'sourceAuthenticated',
      'currentFinalityVerified',
      'membershipAuthenticated',
      'rootAccepted',
      'disclosureEnabled',
      'spendingEnabled',
    ])
      assert.equal(proof[flag], false);
    assert.equal(proof.payload.blindedCommitmentsOut.length, 1);
    assert.ok(BigInt(proof.payload.railgunTxidIfHasUnshield) > 0n);
    assert.deepEqual(activity().methods, beforeProof.methods);
    assert.deepEqual(chain.report(), beforeProof.chain);
    assert.deepEqual(activity().services, beforeProof.services);
    chain.bindProof(proof.payload);
    membership.close();
    await membership.closed;
    membership = null;
    proofModule.assertRailgunOwnPoiProof(proof, enrollment, publicAccount.coordinator);
    assertDrain();
    runs.push({
      mode: 'genuine-typed-membership-and-combined-proof',
      typedOriginalInputOnly: true,
      outputCount: 1,
      unshieldMarker: true,
      membershipClosedBeforePersistence: true,
      separateVerifierExited: true,
      noChangeEligibility: true,
    });
    setPhase('prepare');
    store = await enrollment.openPoiIntents();
    const beforePrepare = activity();
    const emptyDocument = await h.storeObserver.document(store);
    assert.equal(emptyDocument.version, 1);
    assert.equal(emptyDocument.sequence, 0);
    assert.deepEqual(emptyDocument.entries, []);
    assert.deepEqual(
      await store.prepare({
        proof: { ...proof },
        coordinator: publicAccount.coordinator,
        signal: enrollment.signal,
      }),
      { status: 'refused', stage: 'context' }
    );
    const prepared = await store.prepare({
      proof,
      coordinator: publicAccount.coordinator,
      signal: enrollment.signal,
    });
    assert.equal(prepared.status, 'prepared', 'prepare stage ' + prepared.stage);
    let entry = await store.get(capture.capsuleDigest);
    assert.equal(entry.state, 'prepared');
    const preparedDocument = await h.storeObserver.document(store);
    assert.equal(preparedDocument.version, 3);
    assert.equal(preparedDocument.sequence, 1);
    assert.equal(preparedDocument.lease, emptyDocument.lease);
    assert.deepEqual(preparedDocument.entries, [entry]);
    assert.deepEqual(entry.payload, proof.payload);
    assert.equal((await store.inspect()).reservedTransitions, 3);
    assert.deepEqual(activity(), beforePrepare);
    const noOpBaseline = await durable();
    assert.equal(
      (
        await store.prepare({
          proof,
          coordinator: publicAccount.coordinator,
          signal: enrollment.signal,
        })
      ).status,
      'prepared'
    );
    assert.deepEqual(await durable(), noOpBaseline);
    runs.push({
      mode: 'genuine-v3-prepare',
      identicalPrepareBytesUnchanged: true,
      copiedProofRefused: true,
      prepared: true,
      reservedTransitions: 3,
      documentBefore: { version: 1, sequence: 0 },
      documentAfter: { version: 3, sequence: 1 },
    });
    await run(
      'checks',
      () =>
        checks.openRailgunOwnPoiChecks({
          archive,
          enrollment,
          coordinator: publicAccount.coordinator,
          proof,
          signal: enrollment.signal,
        }),
      'checked',
      null,
      { viewing: 0, roots: 1 }
    );
    const reopen = async (before = undefined) => {
      before ??= await durable();
      store.close();
      await store.closed;
      store = null;
      await publicAccount.close();
      publicAccount = null;
      enrollment.close();
      enrollment =
        await require('../../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity }
        );
      publicAccount =
        await require('../../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
          enrollment,
          archive,
        });
      h.adopt(enrollment, publicAccount);
      store = await enrollment.openPoiIntents({ existingOnly: true });
      // Lease/floor initialization precedes exact operation byte baselines.
      const io = activity();
      assert.deepEqual(await privateRecords(), before.privateRecords);
      assert.deepEqual(activity(), io);
      const after = await durable();
      for (const key of ['entry', 'inspect', 'journal', 'privateRecords'])
        assert.deepEqual(after[key], before[key]);
      assert.throws(() =>
        proofModule.assertRailgunOwnPoiProof(proof, enrollment, publicAccount.coordinator)
      );
    };
    const beforeOldReader = await durable();
    runs.push({ mode: 'prepared-v3-old-reader', ...(await h.storeObserver.oldReader(store)) });
    await reopen(beforeOldReader);
    await run(
      'prepared-rejects-attempted-route',
      () => output.recoverRailgunAttemptedPoiOutput(options()),
      'refused',
      'stored',
      { viewing: 0, queried: false }
    );
    await run(
      'wrong-output',
      () => {
        audit.fault(true);
        return output.recoverRailgunPoiOutput(options());
      },
      'refused',
      'recovery:callback',
      { handshake: true, substituted: true }
    );
    await run('prepared-output', () => output.recoverRailgunPoiOutput(options()), 'matched');
    await run(
      'cold-validation',
      () => validation.validateRailgunRetainedPoi(cold()),
      'validated',
      null,
      { verify: 1 }
    );
    await run(
      'retained-history',
      () => validation.validateRailgunRetainedPoiHistory(cold()),
      'validated',
      null,
      { verify: 1, history: 1 }
    );
    const send = async (mode) => {
      setPhase('sender-' + mode);
      const before = activity(),
        disk = await durable(),
        timingStart = h.timings().length;
      const plan = await plans.prepareRailgunPoiDisclosurePlan({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        capsuleDigest: capture.capsuleDigest,
        signal: enrollment.signal,
      });
      assert.equal(plan.status, 'prepared');
      assert.deepEqual(activity(), before);
      const entered = deferred(),
        release = deferred(),
        purposes = [];
      if (mode === 'accept')
        chain.allowPost(() => store.get(capture.capsuleDigest), {
          entered: entered.resolve,
          wait: release.promise,
        });
      const opts = {
        ...common(),
        proverArchive,
        artifactDirectory,
        plan: plan.plan,
        review: async (request, { signal }) => {
          assert.equal(signal.aborted, false);
          assert.ok(Object.isFrozen(request));
          assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 8192);
          purposes.push(request.purpose);
          assert.equal(request.operation, 'partial-unshield');
          assert.equal(request.outputCount, 1);
          const second = purposes.length === 2;
          assert.equal(request.purpose, second ? 'submit-retained-poi' : 'validate-retained-poi');
          assert.deepEqual(
            request.destinations,
            second
              ? [{ role: 'poi-service', origin: 'https://ppoi.fdi.network' }]
              : [
                  { role: 'source-rpc', origin: 'https://synthetic.invalid' },
                  { role: 'receipt-rpc', origin: 'https://synthetic.invalid' },
                  { role: 'poi-service', origin: 'https://ppoi.fdi.network' },
                ]
          );
          for (const key of ['consentGranted', 'transportAuthorized', 'requestLimitsEnforced'])
            assert.equal(request[key], false);
          const lease = claimRailgunAccountPhase(enrollment, 'recovery');
          lease.release();
          assert.deepEqual(await store.get(capture.capsuleDigest), entry);
          if (!second) {
            assert.deepEqual(activity(), before);
            return mode !== 'deny-validation';
          }
          assertDrain();
          return mode !== 'deny-submission';
        },
      };
      let timer, result;
      const work = plans.submitRailgunRetainedPoi(opts);
      try {
        if (mode === 'accept') {
          await Promise.race([
            entered.promise,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error('Fixture POST entry timeout')), 180000);
            }),
            work.then(() => {
              throw Error('Sender settled before POST');
            }),
          ]);
          const held = activity();
          assert.equal((await store.get(capture.capsuleDigest)).state, 'attempted');
          assert.deepEqual(await output.recoverRailgunAttemptedPoiOutput(options()), {
            status: 'refused',
            stage: 'busy',
          });
          assert.deepEqual(activity(), held);
          let closed = false;
          sticky.observeClosed(
            plan.closed,
            () => {
              closed = true;
            },
            'plan.held'
          );
          await Promise.resolve();
          assert.equal(closed, false);
          release.resolve();
        }
        result = await work;
      } finally {
        clearTimeout(timer);
        release.resolve();
        plan.close();
        await work.catch(() => {});
        await plan.closed;
        chain.disablePost();
      }
      assertDrain();
      assert.equal(result.status, mode === 'accept' ? 'recovery-required' : 'refused');
      assert.equal(
        result.stage,
        mode === 'accept'
          ? 'response'
          : mode === 'deny-validation'
            ? 'review-validation'
            : 'review-submit'
      );
      if (mode === 'accept') {
        entry = await store.get(capture.capsuleDigest);
        assert.equal(entry.state, 'attempted');
        assert.equal((await store.inspect()).reservedTransitions, 2);
        const attemptedDocument = await h.storeObserver.document(store);
        assert.equal(attemptedDocument.version, 3);
        assert.equal(attemptedDocument.sequence, 2);
        assert.deepEqual(attemptedDocument.entries, [entry]);
        assert.equal(chain.report().posts, 1);
        assert.equal(result.response.classification, 'rpc-result');
        assert.equal(result.response.matchingEnvelope, true);
        assert.equal(result.response.acceptanceVerified, false);
        assert.deepEqual(entry.payload, disk.entry.payload);
        assert.deepEqual(await privateRecords(), disk.privateRecords);
      } else assert.deepEqual(await durable(), disk);
      if (mode === 'deny-validation') assert.deepEqual(activity(), before);
      const exact = verifyActivity(before, {
        queried: mode !== 'deny-validation',
        viewing: Number(mode !== 'deny-validation'),
        verify: Number(mode !== 'deny-validation'),
        history: Number(mode !== 'deny-validation'),
        roots: Number(mode === 'accept'),
        posts: Number(mode === 'accept'),
      });
      const timings = h.timings().slice(timingStart);
      if (mode !== 'deny-validation') {
        assert.equal(timings.filter((v) => v.name === 'retained-source').length, 1);
        assert.equal(timings.filter((v) => v.name === 'retained-preflight').length, 1);
        const tail = timings.find(
          (v) => v.name === 'retained-preflight'
        ).sourceReturnToPreflightCompletionMs;
        assert.ok(Number.isSafeInteger(tail) && tail >= 0 && tail < 55000);
      } else assert.deepEqual(timings, []);
      assert.equal(h.activity().keys['spending-sign'], 1);
      runs.push({
        mode: 'sender-' + mode,
        timings,
        exact,
        status: result.status,
        stage: result.stage,
        reviews: purposes.length,
        posts: mode === 'accept' ? 1 : 0,
        fixtureReviewNotHumanConsent: true,
        serviceAcceptanceEstablished: false,
        heldPostExcludedAttemptedRecovery: mode === 'accept',
      });
    };
    await send('deny-validation');
    await send('deny-submission');
    await send('accept');
    const beforeAttemptedReader = await durable();
    runs.push({ mode: 'attempted-v3-old-reader', ...(await h.storeObserver.oldReader(store)) });
    await reopen(beforeAttemptedReader);
    await run(
      'attempted-no-new-review-plan',
      () =>
        plans.prepareRailgunPoiDisclosurePlan({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          capsuleDigest: capture.capsuleDigest,
          signal: enrollment.signal,
        }),
      'refused',
      'entry',
      { viewing: 0, queried: false }
    );
    await run(
      'attempted-rejects-prepared-route',
      () => output.recoverRailgunPoiOutput(options()),
      'refused',
      'stored',
      { viewing: 0, queried: false }
    );
    await run(
      'attempted-wrong-output',
      () => {
        audit.fault(true);
        return output.recoverRailgunAttemptedPoiOutput(options());
      },
      'refused',
      'recovery:callback',
      { handshake: true, substituted: true }
    );
    const recovered = await run(
      'attempted-output',
      () => output.recoverRailgunAttemptedPoiOutput(options()),
      'matched'
    );
    for (const flag of [
      'eligibilityEstablished',
      'attemptOutcomeKnown',
      'submissionAccepted',
      'retryEnabled',
    ])
      assert.equal(recovered[flag], false);
    assert.equal(chain.report().posts, 1);
    assert.equal(audit.snapshot().changedOutputs, 2);
    sticky.assertEmpty();
    return {
      continuation,
      report: {
        runs,
        sameProcessColdReopen: true,
        actualChangeAcceptance: false,
        secondSpendQualified: false,
        originalInputMembershipSimulated: true,
        attemptReservesRemaining: 2,
        postResponseAcceptance: false,
      },
    };
  } finally {
    audit.fault(false);
    membership?.close?.();
    if (membership?.closed) await membership.closed;
    store?.close();
    if (store?.closed) await store.closed;
    // Return genuine latest owners to outer finally even if a cold stage fails.
    h.adopt(enrollment, publicAccount);
  }
};
