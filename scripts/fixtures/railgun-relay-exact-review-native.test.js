/** Fixture controls use synthetic registries and messages; no engine/native execution. */
const fs = require('fs'),
  path = require('path'),
  assert = require('node:assert/strict');
const { createHash } = require('crypto');
const source = fs.readFileSync(
  path.join(__dirname, 'railgun-relay-exact-review-native.js'),
  'utf8'
);
const w = '../../src/main/wallet/';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
const closed = {
  code: 'RAILGUN_PROCESS_CLOSED',
  exitCode: 15,
  escalated: false,
  peerDisconnected: false,
  peakRssBytes: 1000,
};
function load(overrides, cached = []) {
  const errors = [];
  const native = {
    assert,
    record: (error) => errors.push(error),
    observeClosed: (promise, callback) =>
      promise.then(
        (value) => {
          try {
            callback(value);
          } catch (error) {
            errors.push(error);
          }
        },
        (error) => errors.push(error)
      ),
    assertEmpty: () => assert.deepEqual(errors, []),
  };
  const req = (name) =>
    name === './railgun-native-assertions'
      ? native
      : Object.hasOwn(overrides, name)
        ? overrides[name]
        : require(name);
  req.resolve = (name) => name;
  req.cache = Object.fromEntries(cached.map((name) => [w + name, {}]));
  const module = { exports: {} };
  Function('require', 'module', 'structuredClone', source)(req, module, clone);
  return { ...module.exports, errors };
}
const zero = {
  utilityStarts: 0,
  utilitySettlements: 0,
  workerStarts: 0,
  workerSettlements: 0,
  rejectedBarriers: 0,
  brokerMessages: 0,
  railgunKeyRequests: 0,
  railgunKeyReplies: 0,
  rpcFactories: 0,
  rpcRequests: 0,
  transportFactories: 0,
  signerFactories: 0,
  applications: 0,
  walletRestores: 0,
};
function qualification(scenario = 'accept') {
  const pins = require(w + 'railgun-shield-pins.json');
  const { normalizeRailgunRelayDraftCapsule } = require(w + 'railgun-relay-capsule');
  // Reuse the independent pure-data test vector without executing its tests.
  const file = fs.readFileSync(path.join(__dirname, w, 'railgun-relay-intent.test.js'), 'utf8');
  const prefix = file.slice(
    0,
    file.indexOf('const { normalizeRailgunRelayUnsignedIntent: normalize }')
  );
  assert.ok(prefix.length > 100);
  const localRequire = require('module').createRequire(
    path.join(__dirname, w, 'railgun-relay-intent.test.js')
  );
  const vector = Function('require', prefix + '\nreturn fixture();')(localRequire);
  const raw = vector.build();
  const fields = JSON.parse(Buffer.from(raw.context.quote.data, 'hex').toString());
  fields.feeExpiration = Date.now() + 240000;
  raw.context.quote.data = Buffer.from(JSON.stringify(fields)).toString('hex');
  const draft = normalizeRailgunRelayDraftCapsule({
    schema: 'railgun-relay-unsigned-draft-v1',
    walletId: raw.context.walletId,
    engineSha256: require(w + 'railgun-engine-manifest.json').sha256,
    selection: { tree: 0, position: 2 },
    noteHash: '0x' + '01'.repeat(32),
    pathElements: Array(16).fill('0x' + '01'.repeat(32)),
    intent: raw,
  });
  const notes = [2000n, 1000n, 700n].map((amount, position) => ({
    id: '0:' + position,
    tree: 0,
    position,
    amount,
    tag: 'unverified',
    asset: { __type: 'erc20', contract: pins.wrappedNative },
    spentTxid: position === 1 ? 'spent' : false,
  }));
  const baseline = {
    read: { instanceId: raw.context.self.address, received: notes },
    ownedPoi: notes.map((note) => ({ id: note.id })),
    checkpointHash: '11'.repeat(32),
    trees: [],
  };
  const accountController = new AbortController();
  const signal = new AbortController().signal,
    owners = Object.fromEntries(
      ['identity', 'enrollment', 'coordinator'].map((key) => [key, { signal }])
    );
  owners.identity.descriptor = { walletId: raw.context.walletId };
  owners.enrollment.getContext = () => ({});
  const publicIdentity = {
    generationId: 'aa'.repeat(32),
    sourceId: 'bb'.repeat(32),
    publicId: 'cc'.repeat(32),
  };
  const f = {
    activity: { ...zero },
    rows: [],
    rpc: [],
    files: { stable: true },
    busy: false,
    mutate: () => {},
    postRead: true,
    phaseHeld: true,
    post: { walletStateRequests: 0, walletStateReplies: 0, journalReads: 0 },
    baseline,
    draft,
    signal,
    owners,
  };
  const { projectRailgunKohakuBalance, projectRailgunKohakuNotes } = require(
    w + 'railgun-kohaku-read-data'
  );
  const view = () => {
    const current = {
      balance: async () => {
        if (f.account.view !== current || accountController.signal.aborted) throw Error('stale');
        return projectRailgunKohakuBalance(notes, null);
      },
      notes: async () => projectRailgunKohakuNotes(notes, null, true),
    };
    return current;
  };
  let closing, originalCallback;
  f.account = {
    signal: accountController.signal,
    generationId: '22'.repeat(32),
    view: view(),
    close() {
      if (closing) return closing;
      accountController.abort();
      if (f.earlyPhaseRelease) f.phaseHeld = false;
      f.activity.workerSettlements++;
      closing = (f.closeEarly ? Promise.resolve() : originalCallback).then(() => {
        f.phaseHeld = false;
      });
      return closing;
    },
  };
  const fail = () => Object.assign(Error('refused'), { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
  const api = {
    readRailgunAccountOwnedNotes: () => {
      if (f.busy || accountController.signal.aborted) throw fail();
      return baseline;
    },
    getRailgunAccountWalletPolicy: () => 'policy',
    reserveRailgunAccountWalletHandoff: () => {
      if (f.busy) throw fail();
      return { assertCurrent() {}, release() {} };
    },
    restoreRailgunAccountWallet: async () => {
      if (f.busy) throw fail();
    },
    reviewRailgunAccountRelayIntent: (account, suppliedOwners, request, review) => {
      if (f.busy) return Promise.reject(fail());
      if (suppliedOwners.identity !== owners.identity) throw fail();
      if (request.verified || request.signal.aborted) return Promise.reject(fail());
      f.busy = true;
      return Promise.resolve()
        .then(async () => {
          const guards = require(w + 'railgun-relay-quote-data').EXPECTED_GUARDS;
          const binding = require(w + 'railgun-relay-quote-data').normalizeRailgunRelayQuote(
            raw.context.quote,
            raw.context.gas
          );
          const checkpoint = { anchor: { number: 100 }, from: 21, to: { number: 30 } };
          const reconstructed = {
            draftDigest: draft.digest,
            expectedHash: draft.data.intent.expectedHash,
            recoveredOutputs: 2,
          };
          f.rows = ['quote', 'construct', 'reconstruct'].map((role, index) => ({
            role,
            inputSha256: sha('input' + index),
            input:
              index === 1
                ? { checkpoint, relayRequest: { context: raw.context } }
                : index === 2
                  ? { checkpoint, relayDraftText: JSON.stringify(draft.data) }
                  : {},
            messages: index ? 4 : 1,
            methods: index
              ? {
                  ['key:' + (index === 1 ? 'relay-prepare' : 'relay-reconstruct')]: 1,
                  'public.get': 1,
                  'wallet.get': 1,
                  result: 1,
                }
              : { result: 1 },
            keyReplies: index ? 1 : 0,
            resultMessages: 1,
            closedObserved: true,
            closed: { ...closed },
            result:
              index === 0
                ? {
                    inputSha256: sha('input0'),
                    quoteSha256: binding.quoteSha256,
                    signatureVerified: true,
                    viewingPublicKey: raw.context.peer.viewingPublicKey,
                    masterPublicKey: raw.context.peer.masterPublicKey,
                    guards,
                  }
                : {
                    guards,
                    poiCalls: 0,
                    inventory: require(w + 'railgun-engine-manifest.json').inventory.sha256,
                    ...(index === 1
                      ? { relayDraft: draft.data }
                      : { relayReconstruction: reconstructed }),
                  },
          }));
          f.rpc = [
            'finalized',
            '0x64',
            '0x15',
            '0x1e',
            '0x14',
            'finalized',
            '0x64',
            '0x15',
            '0x1e',
            '0x14',
          ].map((tag) => ({ method: 'eth_getBlockByNumber', params: [tag, false] }));
          Object.assign(f.activity, {
            rpcRequests: 10,
            utilityStarts: 3,
            utilitySettlements: 3,
            railgunKeyRequests: 2,
            railgunKeyReplies: 2,
            brokerMessages: 9,
          });
          const built = require(w + 'railgun-relay-review-summary').buildRailgunRelayReviewSummary({
            draft: draft.data,
            reconstruction: reconstructed,
            noteId: notes[2].id,
            checkpointHash: baseline.checkpointHash,
            walletGenerationId: f.account.generationId,
            publicIdentity,
          });
          originalCallback = review(
            built.summary,
            Object.freeze({ signal: accountController.signal })
          );
          if (f.settleEarly) return {};
          const decision = await originalCallback;
          if (accountController.signal.aborted) throw fail();
          assert.equal(decision, true);
          if (f.postRead)
            Object.assign(f.post, {
              walletStateRequests: 1,
              walletStateReplies: 1,
              journalReads: 1,
            });
          f.account.view = view();
          const result = {
            view: f.account.view,
            preparation: draft,
            reconstruction: reconstructed,
            status: 'accepted',
            review: built,
            reviewedPreparation: true,
            reservationsChecked: false,
            capsulePersisted: false,
            signingEnabled: false,
            proofAuthority: false,
            poiQueriesPermitted: false,
            relaySendPermitted: false,
          };
          f.mutate(result);
          return result;
        })
        .finally(() => {
          f.busy = false;
        });
    },
  };
  const loaded = load({
    [w + 'privacy-storage']: { getPrivacyStoragePath: () => '/mock/wallet/journal.json' },
    [w + 'railgun-account-phase']: {
      claimRailgunAccountPhase(enrollment, phase) {
        assert.equal(enrollment, owners.enrollment);
        assert.equal(phase, 'recovery');
        if (f.phaseHeld) throw Object.assign(Error('busy'), { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' });
        return { assertCurrent() {}, release() {} };
      },
    },
    [w + 'railgun-account-wallet']: api,
    [w + 'railgun-account-public']: {
      getRailgunAccountPublicIdentity: () => publicIdentity,
    },
    './railgun-kohaku-snapshot-native': { encryptedFiles: () => clone(f.files) },
    './railgun-relay-quote-native-vectors': {
      buildVectors: () => ({ gas: raw.context.gas, cases: [{ quote: raw.context.quote }] }),
      PUBLIC_KEY: raw.context.peer.viewingPublicKey,
      MASTER: raw.context.peer.masterPublicKey,
    },
  });
  f.run = () =>
    loaded.qualify({
      scenario,
      storage: { begin() {}, afterCallback() {}, stop() {}, snapshot: () => ({ ...f.post }) },
      account: f.account,
      owners,
      archive: '/public/engine',
      profile: '/mock/profile',
      walletDirectory: '/mock/wallet',
      measure: () => ({ ...f.activity }),
      jobs: () => clone(f.rows),
      rpc: () => clone(f.rpc),
    });
  f.errors = loaded.errors;
  return f;
}

test.each(['accept', 'held-close'])(
  'exact review %s qualifies its narrow callback/storage scope',
  async (scenario) => {
    const f = qualification(scenario),
      report = await f.run();
    expect(f.errors).toEqual([]);
    expect(report.originalJobsClosedBeforeReview).toBe(true);
    expect(report.reviewedPreparation).toBe(scenario === 'accept');
    expect(report.postReviewStorage).toEqual({
      walletStateRequests: scenario === 'accept' ? 1 : 0,
      walletStateReplies: scenario === 'accept' ? 1 : 0,
      journalReads: scenario === 'accept' ? 1 : 0,
    });
    expect(report.deltas).toEqual({
      ...zero,
      rpcRequests: 10,
      utilityStarts: 3,
      utilitySettlements: 3,
      railgunKeyRequests: 2,
      railgunKeyReplies: 2,
      brokerMessages: 9,
      workerSettlements: scenario === 'accept' ? 0 : 1,
    });
    expect(report.liveChildCancellationQualified).toBe(false);
    expect(report.competingAdmissionRefusals).toBe(4);
    expect(report.quoteMargins).toHaveLength(5);
  }
);
test.each([
  'no-post-reads',
  'summary',
  'grant',
  'wrong-worker-count',
  'storage',
  'no-view-renewal',
])('accept refuses %s', async (kind) => {
  const f = qualification();
  if (kind === 'no-post-reads') f.postRead = false;
  const old = f.account.view;
  f.mutate = (result) => {
    if (kind === 'summary') result.review = { ...result.review, summaryDigest: 'ff'.repeat(32) };
    if (kind === 'grant') result.signingEnabled = true;
    if (kind === 'wrong-worker-count') f.activity.workerSettlements++;
    if (kind === 'storage') f.files.changed = true;
    if (kind === 'no-view-renewal') result.view = f.account.view = old;
  };
  await expect(f.run()).rejects.toThrow();
});
test('held close cannot finish before the original callback settles', async () => {
  const f = qualification('held-close');
  f.closeEarly = true;
  await expect(f.run()).rejects.toThrow();
});
test('an operation settled while its callback remains held is refused', async () => {
  const f = qualification('held-close');
  f.settleEarly = true;
  await expect(f.run()).rejects.toThrow();
});
function storageObserver() {
  const { EventEmitter } = require('events');
  const post = jest.fn(function (...args) {
    return args[1];
  });
  class Worker extends EventEmitter {}
  Worker.prototype.postMessage = post;
  const read = jest.fn(function () {
    return this.result;
  });
  const fakeFs = { readFileSync: read, result: Buffer.from('opaque') };
  const base = { resources: { close: jest.fn(async () => {}) } };
  const loaded = load({
    fs: fakeFs,
    worker_threads: { Worker },
    './railgun-relay-preparation-native': { install: () => base },
  });
  const probe = loaded.install(),
    worker = new Worker();
  const message = (id) => ({ type: 'inspect', id, wire: '{"method":"walletState"}' });
  return { loaded, probe, worker, Worker, fakeFs, post, read, base, message };
}
test('storage observer delegates exact this/arguments/value and matches original worker/id with no response access', async () => {
  const f = storageObserver(),
    tail = {};
  f.probe.storage.begin('/wallet/journal');
  expect(f.worker.postMessage(f.message(1), tail)).toBe(tail);
  f.probe.storage.afterCallback();
  const value = f.message(2);
  expect(f.worker.postMessage(value, tail)).toBe(tail);
  expect(f.post.mock.calls.at(-1)).toEqual([value, tail]);
  expect(f.post.mock.contexts.at(-1)).toBe(f.worker);
  const getter = jest.fn(() => {
    throw Error('response content accessed');
  });
  f.worker.emit('message', { type: 'reply', id: 99 });
  f.worker.emit(
    'message',
    Object.defineProperty({ type: 'reply', id: 2 }, 'wire', { get: getter })
  );
  expect(f.fakeFs.readFileSync('/wallet/journal', 'utf8')).toBe(f.fakeFs.result);
  expect(f.read.mock.contexts.at(-1)).toBe(f.fakeFs);
  f.fakeFs.readFileSync('/other/file');
  expect(f.probe.storage.snapshot()).toEqual({
    walletStateRequests: 1,
    walletStateReplies: 1,
    journalReads: 1,
  });
  expect(getter).not.toHaveBeenCalled();
  f.probe.storage.stop();
  f.fakeFs.readFileSync('/wallet/journal');
  expect(f.probe.storage.snapshot().journalReads).toBe(1);
  await f.probe.resources.close();
  expect(f.Worker.prototype.postMessage).toBe(f.post);
  expect(f.fakeFs.readFileSync).toBe(f.read);
});
test.each(['different-worker', 'duplicate-reply'])(
  'storage %s is sticky without replacing original delivery',
  async (kind) => {
    const f = storageObserver();
    f.probe.storage.begin('/wallet/journal');
    f.worker.postMessage(f.message(1));
    f.probe.storage.afterCallback();
    if (kind === 'different-worker') {
      const other = new f.Worker(),
        sentinel = {};
      expect(other.postMessage(f.message(2), sentinel)).toBe(sentinel);
    } else {
      f.worker.postMessage(f.message(2));
      f.worker.emit('message', { type: 'reply', id: 2 });
      f.worker.emit('message', { type: 'reply', id: 2 });
    }
    expect(f.loaded.errors.length).toBe(1);
    await f.probe.resources.close();
  }
);
test('unobserved reply fails cleanup but restores both wrappers and drains base', async () => {
  const f = storageObserver();
  f.probe.storage.begin('/wallet/journal');
  f.worker.postMessage(f.message(1));
  f.probe.storage.afterCallback();
  f.worker.postMessage(f.message(2));
  await expect(f.probe.resources.close()).rejects.toThrow('pending');
  expect(f.Worker.prototype.postMessage).toBe(f.post);
  expect(f.fakeFs.readFileSync).toBe(f.read);
  expect(f.base.resources.close).toHaveBeenCalledTimes(1);
});
test('delegate throws retain exact original errors', async () => {
  const f = storageObserver(),
    error = Error('delegate');
  f.post.mockImplementation(() => {
    throw error;
  });
  expect(() => f.worker.postMessage({})).toThrow(error);
  f.read.mockImplementation(() => {
    throw error;
  });
  expect(() => f.fakeFs.readFileSync('/other')).toThrow(error);
  await f.probe.resources.close();
});
test.each(['railgun-account-wallet', 'railgun-session-worker'])(
  'late %s import refuses before installation',
  (name) => {
    expect(() => load({}, [name]).install()).toThrow('early');
  }
);

test('held close must retain the genuine phase claim until callback settlement', async () => {
  const f = qualification('held-close');
  f.earlyPhaseRelease = true;
  await expect(f.run()).rejects.toThrow();
});
