const { isRailgunWalletJob } = require('./railgun-job-observer');
/** Default-off disposable account probe; original utility tasks remain authoritative. */
const native = require('./railgun-native-assertions');
const { assert } = native;
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const roles = ['quote', 'construct', 'reconstruct'];
const methods = ['get', 'getMany', 'open', 'next', 'nextMany', 'seek', 'end'];
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Error('Unsigned relay fixture timeout: ' + label);
          native.record(error, label);
          reject(error);
        }, 100000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function install() {
  for (const name of [
    'railgun-account-wallet',
    'railgun-wallet-runner',
    'railgun-wallet-run',
    'railgun-relay-quote-verify',
  ])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Relay observer installed late: ' + name
    );
  const base = require('./railgun-kohaku-snapshot-native').install();
  const runtime = require(wallet + 'railgun-process');
  const original = runtime.startRailgunProcess;
  const records = [],
    rpcRequests = [],
    tasks = new WeakSet();
  let restored = false;
  const observed = function (...args) {
    const options = args[0];
    const quote = isRailgunWalletJob(options, 'railgun-relay-quote-job.js');
    const relay = isRailgunWalletJob(options, 'railgun-relay-wallet-job.js');
    if (!quote && !relay) return Reflect.apply(original, this, args);
    assert.equal(restored, false);
    const input = JSON.parse(options.input);
    const role = quote ? 'quote' : input.relayRequest !== undefined ? 'construct' : 'reconstruct';
    assert.equal(role, roles[records.length], 'Original jobs must start in order exactly once');
    if (records.length)
      assert.equal(
        records.at(-1).closedObserved,
        true,
        'Prior original task must close before next launch'
      );
    assert.equal(options.binaryKey, !quote);
    assert.equal(options.startupMs, quote ? 15000 : 30000);
    assert.equal(options.lifetimeMs, quote ? 15000 : 30000);
    assert.ok(options.broker && typeof options.broker.dispatch === 'function');
    if (quote) assert.deepEqual(Object.keys(input).sort(), ['archive', 'gas', 'quote']);
    else {
      assert.equal(input.restore, true);
      assert.deepEqual(
        Object.keys(input).sort(),
        [
          'archive',
          'checkpoint',
          'descriptor',
          'prefixes',
          role === 'construct' ? 'relayRequest' : 'relayDraftText',
          'restore',
          'walletId',
        ].sort()
      );
      if (role === 'reconstruct') {
        const previous = records[1];
        assert.ok(previous.result?.relayDraft);
        assert.equal(input.relayDraftText, JSON.stringify(previous.result.relayDraft));
      }
    }
    const row = {
      role,
      inputSha256: sha(options.input),
      input,
      messages: 0,
      methods: {},
      keyReplies: 0,
      resultMessages: 0,
      closedObserved: false,
    };
    records.push(row);
    const broker = options.broker;
    const dispatch = function (...values) {
      const message = JSON.parse(values[0]);
      assert.equal(message.id, ++row.messages);
      let method;
      if (message.method === 'key') {
        assert.equal(quote, false);
        assert.equal(message.id, 1);
        assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'purpose']);
        assert.equal(message.purpose, role === 'construct' ? 'relay-prepare' : 'relay-reconstruct');
        method = 'key:' + message.purpose;
      } else if (message.method === 'result') {
        assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
        assert.equal(row.resultMessages, 0);
        method = 'result';
      } else {
        assert.equal(quote, false);
        assert.deepEqual(Object.keys(message).sort(), ['channel', 'id', 'wire']);
        assert.ok(['public', 'wallet'].includes(message.channel));
        const inner = JSON.parse(message.wire);
        assert.ok(methods.includes(inner.method), 'Read-only broker method required');
        method = message.channel + '.' + inner.method;
      }
      row.methods[method] = (row.methods[method] ?? 0) + 1;
      assert.equal(
        row.methods.result ?? 0,
        message.method === 'result' ? 1 : 0,
        'No messages after result'
      );
      const result = Reflect.apply(broker.dispatch, this, values);
      Promise.prototype.then.call(
        result,
        (reply) => {
          try {
            if (message.method === 'key') {
              assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
              row.keyReplies++;
              assert.equal(row.keyReplies, 1);
            }
            if (message.method === 'result') {
              row.resultMessages++;
              assert.equal(row.resultMessages, 1);
              row.result = structuredClone(message.value);
            }
          } catch (error) {
            native.record(error, 'relay-preparation.broker');
          }
        },
        (error) => native.record(error, 'relay-preparation.broker.rejected')
      );
      return result;
    };
    const task = Reflect.apply(original, this, [
      { ...options, broker: { ...broker, dispatch } },
      ...args.slice(1),
    ]);
    assert.ok(task && typeof task === 'object' && !tasks.has(task));
    tasks.add(task);
    native.observeClosed(
      task.closed,
      (value) => {
        assert.equal(row.resultMessages, 1);
        assert.equal(value.code, 'RAILGUN_PROCESS_CLOSED');
        assert.equal(value.exitCode, 15);
        assert.equal(value.escalated, false);
        assert.equal(value.peerDisconnected, false);
        row.closed = structuredClone(value);
        row.closedObserved = true;
      },
      'relay-preparation.original.' + role + '.closed'
    );
    return task;
  };
  runtime.startRailgunProcess = observed;
  return Object.freeze({
    ...base,
    jobs: () => structuredClone(records),
    rpc(method, params) {
      rpcRequests.push({ method, params: structuredClone(params) });
    },
    rpcSnapshot: () => structuredClone(rpcRequests),
    resources: Object.freeze({
      ...base.resources,
      async close() {
        try {
          if (!restored) {
            restored = true;
            assert.equal(runtime.startRailgunProcess, observed);
            runtime.startRailgunProcess = original;
          }
        } finally {
          await base.resources.close();
        }
      },
    }),
  });
}
async function qualify({
  account,
  owners,
  archive,
  signal,
  profile,
  walletDirectory,
  measure,
  jobs,
  rpc,
}) {
  const accountModule = require(wallet + 'railgun-account-wallet');
  const {
    readRailgunAccountOwnedNotes: read,
    prepareRailgunAccountRelayIntent: prepare,
    restoreRailgunAccountWallet: restore,
    reserveRailgunAccountWalletHandoff: reserve,
  } = accountModule;
  const { getRailgunAccountPublicIdentity } = require(wallet + 'railgun-account-public');
  const { normalizeRailgunRelayQuote, EXPECTED_GUARDS } = require(
    wallet + 'railgun-relay-quote-data'
  );
  const { normalizeRailgunRelayDraftCapsule } = require(wallet + 'railgun-relay-capsule');
  const { encryptedFiles } = require('./railgun-kohaku-snapshot-native');
  const { assertReadProjection } = require('./railgun-kohaku-contract-oracle');
  const { buildVectors, PUBLIC_KEY, MASTER } = require('./railgun-relay-quote-native-vectors');
  const pins = require(wallet + 'railgun-shield-pins.json');
  const baseline = read(account, owners);
  assert.equal(baseline.read.received.length, 3);
  const unspent = baseline.read.received.filter((note) => note.spentTxid === false);
  assert.equal(unspent.length, 2);
  assert.equal(
    unspent.reduce((sum, note) => sum + note.amount, 0n),
    2700n
  );
  const selected = unspent.filter(
    (note) => note.amount === 700n && note.asset.contract === pins.wrappedNative
  );
  assert.equal(selected.length, 1);
  const note = selected[0];
  assert.equal(baseline.ownedPoi.filter((row) => row.id === note.id).length, 1);
  const view = account.view,
    generation = account.generationId;
  const publicIdentity = getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment);
  const policy = accountModule.getRailgunAccountWalletPolicy({
    archive,
    coordinator: owners.coordinator,
    enrollment: owners.enrollment,
  });
  const files = encryptedFiles(profile, walletDirectory),
    before = measure(),
    rpcBefore = rpc().length;
  assert.equal(before.signerFactories, 0);
  assert.deepEqual(jobs(), []);
  // Deliberately public fixture signing/address coding in main; not guarded-job work.
  const vectors = buildVectors(archive, Date.now());
  const quote = vectors.cases[0].quote,
    binding = normalizeRailgunRelayQuote(quote, vectors.gas);
  const controller = new AbortController();
  const request = {
    noteId: note.id,
    quote,
    gas: vectors.gas,
    maxFee: '100',
    signal: controller.signal,
  };
  const pending = [];
  const margin = () => {
    const remaining = binding.fields.feeExpiration - Date.now();
    assert.ok(Number.isSafeInteger(remaining) && remaining >= 90000);
    return remaining;
  };
  const margins = [margin()];
  const unchanged = () => {
    assert.deepEqual(measure(), before);
    assert.deepEqual(jobs(), []);
    assert.equal(rpc().length, rpcBefore);
    assert.deepEqual(read(account, owners), baseline);
    assert.equal(account.view, view);
    assert.deepEqual(encryptedFiles(profile, walletDirectory), files);
  };
  const rejected = async (callback) => {
    await assert.rejects(async () => callback());
    unchanged();
  };
  try {
    unchanged();
    await rejected(() => prepare(account, { ...owners, identity: {} }, request));
    await rejected(() => prepare(account, owners, { ...request, verified: true }));
    const aborted = new AbortController();
    aborted.abort();
    await rejected(() => prepare(account, owners, { ...request, signal: aborted.signal }));
    margins.push(margin());
    const work = prepare(account, owners, request);
    work.catch(() => {});
    pending.push(work);
    const atAdmission = measure();
    assert.throws(() => read(account, owners), { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
    const competing = restore(account, owners);
    competing.catch(() => {});
    pending.push(competing);
    const refusal = assert.rejects(competing, { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
    refusal.catch(() => {});
    pending.push(refusal);
    assert.throws(() => reserve(account, owners));
    assert.deepEqual(measure(), atAdmission, 'Competing same-turn admissions must add no work');
    const result = await bounded(work, 'composite');
    await refusal;
    margins.push(margin());
    const rows = jobs();
    assert.deepEqual(
      rows.map((row) => row.role),
      roles
    );
    for (const row of rows) {
      assert.equal(row.closedObserved, true);
      assert.equal(row.resultMessages, 1);
      assert.deepEqual(row.result.guards, EXPECTED_GUARDS);
      assert.equal(row.closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(row.closed.exitCode, 15);
      assert.equal(row.closed.escalated, false);
      assert.equal(row.closed.peerDisconnected, false);
      assert.equal(
        row.messages,
        Object.values(row.methods).reduce((a, b) => a + b, 0)
      );
      assert.equal(row.methods.result, 1);
    }
    assert.deepEqual(rows[0].methods, { result: 1 });
    assert.equal(rows[0].keyReplies, 0);
    assert.equal(rows[0].result.inputSha256, rows[0].inputSha256);
    assert.equal(rows[0].result.quoteSha256, binding.quoteSha256);
    assert.equal(rows[0].result.signatureVerified, true);
    assert.equal(rows[0].result.viewingPublicKey, PUBLIC_KEY);
    assert.equal(rows[0].result.masterPublicKey, MASTER);
    for (const [index, purpose] of [
      [1, 'relay-prepare'],
      [2, 'relay-reconstruct'],
    ]) {
      assert.equal(rows[index].methods['key:' + purpose], 1);
      assert.equal(rows[index].keyReplies, 1);
      assert.equal(rows[index].result.poiCalls, 0);
      assert.equal(
        rows[index].result.inventory,
        require(wallet + 'railgun-engine-manifest.json').inventory.sha256
      );
      assert.ok(Object.keys(rows[index].methods).some((key) => key.startsWith('public.')));
      assert.ok(Object.keys(rows[index].methods).some((key) => key.startsWith('wallet.')));
    }
    const draft = normalizeRailgunRelayDraftCapsule(rows[1].result.relayDraft);
    assert.equal(rows[2].input.relayDraftText, JSON.stringify(draft.data));
    assert.deepEqual(result.preparation, draft);
    assert.deepEqual(rows[1].input.relayRequest.context, draft.data.intent.context);
    assert.deepEqual(draft.data.selection, { tree: note.tree, position: note.position });
    assert.deepEqual(result.reconstruction, {
      draftDigest: draft.digest,
      expectedHash: draft.data.intent.expectedHash,
      recoveredOutputs: 2,
    });
    assert.deepEqual(rows[2].result.relayReconstruction, result.reconstruction);
    const falseGrants = [
      'reviewedPreparation',
      'reservationsChecked',
      'capsulePersisted',
      'signingEnabled',
      'proofAuthority',
      'poiQueriesPermitted',
      'relaySendPermitted',
    ];
    assert.deepEqual(
      Object.keys(result).sort(),
      ['view', 'preparation', 'reconstruction', ...falseGrants].sort()
    );
    for (const key of falseGrants) assert.equal(result[key], false);
    for (const [key, value] of Object.entries(result.preparation))
      if (!['data', 'digest'].includes(key)) assert.equal(value, false);
    assert.notEqual(account.view, view);
    assert.equal(result.view, account.view);
    await assert.rejects(view.balance());
    assert.deepEqual(read(account, owners), baseline);
    assert.equal(account.generationId, generation);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment),
      publicIdentity
    );
    assert.equal(
      accountModule.getRailgunAccountWalletPolicy({
        archive,
        coordinator: owners.coordinator,
        enrollment: owners.enrollment,
      }),
      policy
    );
    assert.ok(
      [signal, account.signal, ...Object.values(owners).map((owner) => owner.signal)].every(
        (value) => !value.aborted
      )
    );
    const handoff = reserve(account, owners);
    try {
      handoff.assertCurrent();
    } finally {
      handoff.release();
    }
    for (const [method, args] of [
      ['balance', []],
      ['notes', [undefined, true]],
    ]) {
      const value = account.view[method](...args);
      assertReadProjection(baseline.read, {
        method,
        args,
        value: await value,
        promiseReturned: value instanceof Promise,
      });
    }
    assert.deepEqual(encryptedFiles(profile, walletDirectory), files);
    // withPublicSnapshot refreshes canonical boundaries before/after its callback.
    // Derive the exact synthetic header requests from the captured checkpoint;
    // source canonicalNumbers de-duplicates anchor/from/to/(from-1).
    const checkpoint = rows[1].input.checkpoint;
    // Stage 20 precedes the recovered stage-30 plan; advance starts at previous + 1.
    assert.equal(checkpoint.anchor.number, 100);
    assert.equal(checkpoint.from, 21);
    assert.equal(checkpoint.to.number, 30);
    assert.deepEqual(rows[2].input.checkpoint, checkpoint);
    const numbers = [
      ...new Set([
        checkpoint.anchor.number,
        checkpoint.from,
        checkpoint.to.number,
        ...(checkpoint.from ? [checkpoint.from - 1] : []),
      ]),
    ];
    assert.ok(numbers.every((n) => Number.isSafeInteger(n) && n >= 0));
    const expectedRpc = Object.fromEntries(
      ['finalized', ...numbers.map((n) => '0x' + n.toString(16))].map((tag) => [tag, 2])
    );
    const rpcMap = {};
    for (const request of rpc().slice(rpcBefore)) {
      assert.equal(request.method, 'eth_getBlockByNumber');
      assert.ok(
        Array.isArray(request.params) && request.params.length === 2 && request.params[1] === false
      );
      const tag = request.params[0];
      rpcMap[tag] = (rpcMap[tag] ?? 0) + 1;
    }
    assert.deepEqual(rpcMap, expectedRpc);
    const after = measure();
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    const deltas = Object.fromEntries(
      Object.keys(before).map((key) => [key, after[key] - before[key]])
    );
    const expected = Object.fromEntries(Object.keys(before).map((key) => [key, 0]));
    Object.assign(expected, {
      rpcRequests: Object.values(expectedRpc).reduce((a, b) => a + b, 0),
      utilityStarts: 3,
      utilitySettlements: 3,
      railgunKeyRequests: 2,
      railgunKeyReplies: 2,
      brokerMessages: rows.reduce((sum, row) => sum + row.messages, 0),
    });
    assert.deepEqual(deltas, expected);
    native.assertEmpty();
    return Object.freeze({
      schema: 'railgun-unsigned-relay-preparation-native-v1',
      scenario: 'enrolled-stage30-restore',
      originalJobs: rows.map((row) => ({
        role: row.role,
        inputSha256: row.inputSha256,
        messages: row.messages,
        methods: row.methods,
        keyReplies: row.keyReplies,
        resultMessages: row.resultMessages,
        closedObserved: row.closedObserved,
        closed: row.closed,
        guards: row.result.guards,
      })),
      quoteMargins: margins,
      quoteSha256: binding.quoteSha256,
      draftDigest: draft.digest,
      syntheticCanonicalHeaderRequests: rpcMap,
      canonicalRefreshes: 2,
      liveRpcQualified: false,
      relayRestores: 2,
      recoveredOutputs: 2,
      preAdmissionRefusals: 3,
      competingAdmissionRefusals: 3,
      freshOriginalTaskIdentities: true,
      originalTasksClosedInOrder: true,
      exactSerializedDraftJoined: true,
      genuineAccountAndOwners: true,
      originalViewInvalidated: true,
      ownedProjectionAndGenerationsUnchanged: true,
      sourceEnforcedReadOnlyGrants: true,
      durableEncryptedFilesAndNamesUnchanged: true,
      handoffImmediatelyReusable: true,
      borrowedAccountRemainsUsable: true,
      quoteConstructionGuarded: false,
      syntheticSignedQuote: true,
      wholeBrowserProfileByteIdentity: false,
      liveChildCancellationQualified: false,
      reviewedPreparation: false,
      reservationsChecked: false,
      capsulePersisted: false,
      signingEnabled: false,
      proofAuthority: false,
      poiQueriesPermitted: false,
      relaySendPermitted: false,
      liveRelayQualified: false,
      gasEstimateVerified: false,
      operatorTrusted: false,
      deltas,
    });
  } finally {
    controller.abort();
    await bounded(Promise.allSettled(pending), 'original-work.cleanup');
  }
}
module.exports = { install, qualify };
