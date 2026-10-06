/** Assertion controls with synthetic owners; genuine authority is native-only. */
jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const api = require('./railgun-recovery-companion-native');
const ENV = 'FREEDOM_RAILGUN_RECOVERY_COMPANION';
test('absent flag preserves every legacy mode', () => {
  for (const mode of [
    undefined,
    'change',
    'restart-setup',
    'restart-recover-stop',
    'restart-recovered-submit',
  ])
    expect(api.enabled({}, mode, 'Transact')).toBe(false);
});
test.each([
  'restart-setup',
  'restart-sign-stop',
  'restart-recover-stop',
  'restart-recovered-submit',
])('exact opt-in Shield mode %s', (mode) =>
  expect(api.enabled({ [ENV]: '1' }, mode, 'Shield')).toBe(true)
);
test.each(['', '0', 'true', 1, true, undefined, null])(
  'invalid present flag refuses %j',
  (value) => {
    expect(() => api.enabled({ [ENV]: value }, 'restart-recover-stop', 'Shield')).toThrow();
  }
);
test.each([
  'change',
  'restart-resume',
  'restart-prove-stop',
  'restart-cold-submit',
  'restart-recovered-submit-lost',
  undefined,
])('unreviewed mode refuses %s', (mode) =>
  expect(() => api.enabled({ [ENV]: '1' }, mode, 'Shield')).toThrow()
);
test('Transact opt-in refuses', () =>
  expect(() => api.enabled({ [ENV]: '1' }, 'restart-recover-stop', 'Transact')).toThrow());
const pair = {
  first: { entry: { id: 'a'.repeat(64), facts: { kind: 'railgun-partial-unshield' } } },
  second: { entry: { id: 'b'.repeat(64), facts: { kind: 'railgun-token-unshield' } } },
};
const page = (proved) => ({
  totalSigning: 2,
  nextAfter: null,
  records: [
    { holdId: pair.first.entry.id, kind: 'railgun-partial-unshield', localState: 'proof-present' },
    {
      holdId: pair.second.entry.id,
      kind: 'railgun-token-unshield',
      localState: proved ? 'proof-present' : 'signed-unfinished',
    },
  ],
});
test('discovery joins exact local selector, kind, state and complete page', async () => {
  expect(await api.history({ history: async () => page(false) }, pair, false)).toBe(
    pair.second.entry.id
  );
});
test.each(['id', 'kind', 'state', 'page', 'total', 'extra'])(
  'history drift refuses %s',
  async (mutation) => {
    const value = page(false);
    if (mutation === 'id') value.records[1].holdId = 'c'.repeat(64);
    if (mutation === 'kind') value.records[1].kind = 'railgun-private-transfer';
    if (mutation === 'state') value.records[1].localState = 'proof-present';
    if (mutation === 'page') value.nextAfter = value.records[1].holdId;
    if (mutation === 'total') value.totalSigning++;
    if (mutation === 'extra') value.records.push({ ...value.records[1] });
    await expect(api.history({ history: async () => value }, pair, false)).rejects.toThrow();
  }
);
test('file scope permits exact observed reopen files only', () => {
  const old = {
    accounts: { reservations: 'a', capsules: 'b', manifest: 'c', other: 'd' },
    submissions: { first: 'e' },
  };
  const next = JSON.parse(JSON.stringify(old));
  next.accounts.reservations = 'new';
  const writes = [{ file: 'profile/wallet-railgun-accounts/reservations' }];
  expect(() => api.unchangedFiles(old, next, writes)).not.toThrow();
  next.accounts.other = 'changed';
  expect(() => api.unchangedFiles(old, next, writes)).toThrow();
  expect(() => api.unchangedFiles(old, next, [{ file: 'profile/identity/vault' }])).toThrow();
});
function submissionSetup({ copyPromise = false, wrongValue = false } = {}) {
  jest.resetModules();
  const entries = [],
    companions = [];
  const controller = new AbortController();
  const h = {
    identity: {},
    enrollment: {},
    publicAccount: { coordinator: {} },
    pair,
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    signal: controller.signal,
    activity: () => ({ jobs: 0 }),
    recoveryCompanion: {
      report: () => ({
        heldResults: 0,
        originalCalls: entries.length,
        originalSettlements: entries.length,
      }),
      entry: (i) => entries[i],
    },
  };
  const destination = {};
  jest.doMock('../../src/main/wallet/railgun-account-public', () => ({
    getRailgunAccountPublicDestination: () => destination,
  }));
  jest.doMock('../../src/main/wallet/railgun-kohaku-recovery', () => ({
    createRailgunKohakuRecovery: jest.fn((options) => {
      expect(options.owners.enrollment).toBe(h.enrollment);
      let finish;
      const companion = {
        history: async () => page(true),
        closed: new Promise((resolve) => {
          finish = resolve;
        }),
        close: jest.fn(() => finish()),
        submitStored(id) {
          expect(id).toBe(pair.second.entry.id);
          const value =
            entries.length === 0
              ? { hash: 'same' }
              : { status: 'recovery-required', stage: 'prior-attempt' };
          const promise = Promise.resolve(value);
          entries.push({ promise, value: wrongValue ? { ...value } : value });
          return copyPromise ? promise.then((v) => v) : promise;
        },
      };
      companions.push(companion);
      return companion;
    }),
  }));
  const helper = require('./railgun-recovery-companion-native');
  const input = {
    identity: h.identity,
    enrollment: h.enrollment,
    coordinator: h.publicAccount.coordinator,
    signal: h.signal,
    holdId: pair.second.entry.id,
    gasLimit: 1500000n,
    maxGasFee: 2000000000000000n,
    reviewDisclosures: () => true,
    reviewTransaction: () => true,
  };
  return { helper, h, input, entries, companions };
}
afterEach(() => {
  jest.dontMock('../../src/main/wallet/railgun-kohaku-recovery');
  jest.dontMock('../../src/main/wallet/railgun-account-public');
  jest.dontMock('./railgun-combined-poi-second-recovery-data');
  jest.resetModules();
});
test('submission preserves exact delegate Promise/value for ack and explicit prior-attempt refusals', async () => {
  const s = submissionSetup(),
    submitter = await s.helper.submission(s.h);
  try {
    for (let i = 0; i < 3; i++) {
      const pending = submitter.submit(s.input);
      expect(pending).toBe(s.entries[i].promise);
      expect(await pending).toBe(s.entries[i].value);
    }
    expect(submitter.report()).toMatchObject({
      originalPromiseAndOutcomeIdentity: true,
      explicitPriorAttemptRefusals: 2,
    });
  } finally {
    await submitter.close();
  }
  expect(s.companions.every((v) => v.close.mock.calls.length >= 1)).toBe(true);
});
test('copied original promise fails the fixture before claiming identity', async () => {
  const s = submissionSetup({ copyPromise: true }),
    submitter = await s.helper.submission(s.h);
  try {
    expect(() => submitter.submit(s.input)).toThrow();
  } finally {
    await submitter.close();
  }
});
test('copied observed value is sticky through close and cannot qualify report', async () => {
  const s = submissionSetup({ wrongValue: true }),
    submitter = await s.helper.submission(s.h);
  await submitter.submit(s.input);
  expect(() => submitter.report()).toThrow();
  await expect(submitter.close()).rejects.toThrow();
  expect(s.companions.every((v) => v.close.mock.calls.length >= 1)).toBe(true);
});
function recoverySetup(mutation, realSticky = false) {
  jest.resetModules();
  if (realSticky)
    jest.doMock('./railgun-native-assertions', () =>
      jest.requireActual('./railgun-native-assertions')
    );
  const assert = require('assert/strict');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const states = [],
    entries = [],
    writes = [];
  let phase,
    released = false,
    release,
    wake;
  const reached = new Promise((resolve) => {
    wake = resolve;
  });
  const signal = new AbortController().signal;
  const stores = () => {
    const a = new AbortController(),
      b = new AbortController();
    return {
      reservations: { signal: a.signal },
      capsules: { signal: b.signal },
      abort() {
        a.abort();
        b.abort();
      },
    };
  };
  const old = stores(),
    next = stores();
  const activity = {
    audit: Object.fromEntries(
      [
        'starts',
        'exits',
        'attemptedResults',
        'admittedResults',
        'keyRequests',
        'keyReplies',
        'modes',
      ].map((k) => [k, {}])
    ),
    storageWorkers: { starts: 2, exits: 0, pending: 2 },
    services: {
      transportCreates: 0,
      transportEntries: 0,
      poiMethods: {},
      publicServiceMethods: {},
    },
    chain: { posts: 0, attempted: {}, validated: {} },
    roleMethods: {},
    eoa: { sends: 0 },
  };
  const files = {
    accounts: { reservations: 'r', capsules: 'c', manifest: 'm' },
    submissions: { first: 'unchanged' },
  };
  const data = clone(pair);
  data.first.stored = { signature: 'first' };
  data.second.stored = { signature: 'second', provedTransaction: null };
  const h = {
    pair: data,
    sealed: { records: {} },
    signal,
    identity: { signal },
    publicAccount: { coordinator: { signal } },
    enrollment: {
      signal,
      async openPrivateRecoveryStores() {
        if (phase !== 'second-recovery-companion-reopen') return old;
        if (!writes.length) {
          for (const [record, file] of [
            ['railgun-private-reservations-v1', 'reservations'],
            ['railgun-private-reservations-floor-v1', 'manifest'],
            ['railgun-private-capsules-v1', 'capsules'],
            ['railgun-private-capsules-floor-v1', 'manifest'],
          ])
            writes.push({ record, file: 'profile/wallet-railgun-accounts/' + file });
          for (const key of Object.keys(files.accounts)) files.accounts[key] += '-reopen';
        }
        return next;
      },
    },
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    wire: {
      checkpoint: { from: 0, to: { number: 1 }, anchor: { number: 1 } },
      receipt: { logs: [] },
    },
    source: { logs: [] },
    phase: (value) => {
      phase = value;
    },
    activity: () => clone(activity),
    profileSnapshot: () => clone(files),
    companionStorageReport: () => clone(writes),
    pendingChildren: () => 0,
    unwipedLoans: () => 0,
    adoptStores: jest.fn(),
    journal: () => ({ list: async () => [{}] }),
  };
  const headers = require('./railgun-combined-poi-restart-counts').expectedHeaders(
    h.wire.checkpoint,
    []
  );
  const methods = {
    'private-account:protocol-rpc:eth_chainId': 1,
    'private-account:protocol-rpc:eth_getBlockByNumber': headers * 2,
    'private-account:protocol-rpc:eth_getLogs': 2,
  };
  function entry(promise) {
    const row = { promise, settled: false };
    entries.push(row);
    promise.then((value) => {
      row.value = value;
      row.settled = true;
    });
    return promise;
  }
  h.recoveryCompanion = {
    reached,
    entry: (i) => entries[i],
    report: () => ({
      heldResults: 1,
      originalCalls: entries.length,
      originalSettlements: entries.filter((v) => v.settled).length,
    }),
    release() {
      if (!released) {
        released = true;
        release?.();
      }
    },
    pendingAtClose(actualSignal, a, b) {
      assert.equal(actualSignal.aborted, true);
      assert.equal(a.signal.aborted, false);
      assert.equal(b.signal.aborted, false);
      assert.equal(entries[0].settled, false);
      return { sourceDerivedCancellationCause: true };
    },
  };
  jest.doMock('../../src/main/wallet/railgun-account-public', () => ({
    getRailgunAccountPublicDestination: () => ({}),
  }));
  jest.doMock('./railgun-combined-poi-second-recovery-data', () => ({
    signedHashes: () => h.sealed.records,
    readUnfinishedPair: async () =>
      mutation === 'signature'
        ? { ...data, second: { ...data.second, stored: { signature: 'changed' } } }
        : clone(data),
  }));
  jest.doMock('../../src/main/wallet/railgun-kohaku-recovery', () => ({
    createRailgunKohakuRecovery() {
      const index = states.length,
        control = new AbortController();
      let finish,
        closing = false,
        work;
      const closed = new Promise((resolve) => {
        finish = resolve;
      });
      const value = {
        signal: control.signal,
        closed,
        close() {
          closing = true;
          control.abort();
          if (!work || mutation === 'early-close') finish();
        },
        history: async () => {
          if (closing)
            throw Object.assign(Error('closed'), { code: 'RAILGUN_KOHAKU_RECOVERY_REFUSED' });
          if (index === 1) {
            if (mutation === 'close-stores') old.abort();
            if (mutation !== 'history-allowed')
              throw Object.assign(Error('phase'), {
                code: 'RAILGUN_PRIVATE_RECOVERY_HISTORY_REFUSED',
              });
          }
          return page(false);
        },
        submitStored: () =>
          Promise.reject(
            Object.assign(Error('closed'), { code: 'RAILGUN_KOHAKU_RECOVERY_REFUSED' })
          ),
        resumeProof(id) {
          if (closing)
            return Promise.reject(
              Object.assign(Error('closed'), { code: 'RAILGUN_KOHAKU_RECOVERY_REFUSED' })
            );
          if (index === 1)
            return entry(
              Promise.resolve({ status: 'refused', stage: 'admission', submissionEnabled: false })
            );
          if (index === 2)
            return entry(
              Promise.resolve({
                status: entries.length === 2 ? 'proof-stored' : 'proof-present',
                holdId: id,
              })
            );
          const jobs = {
            'railgun-public-job.js': 2,
            'railgun-wallet-job.js': 1,
            'railgun-private-recover-job.js': 1,
            'railgun-private-verify-job.js': 1,
          };
          for (const k of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
            activity.audit[k] = clone(jobs);
          for (const k of ['keyRequests', 'keyReplies'])
            activity.audit[k] = { 'railgun-wallet-job.js': 1, 'railgun-private-recover-job.js': 1 };
          activity.storageWorkers.starts++;
          activity.storageWorkers.exits++;
          activity.services.transportCreates++;
          activity.roleMethods = clone(methods);
          activity.chain.attempted = clone(methods);
          activity.chain.validated = clone(methods);
          work = entry(
            new Promise((resolve) => {
              release = () => {
                old.abort();
                resolve({
                  status: 'recovery-required',
                  stage: 'verify',
                  holdId: id,
                  submissionEnabled: false,
                });
              };
            })
          );
          work.then(() => {
            if (closing) finish();
          });
          wake();
          return work;
        },
      };
      states.push(value);
      return value;
    },
  }));
  const helper = require('./railgun-recovery-companion-native');
  const success = jest.fn(async (supplied) => {
    await supplied.resumeProof(data.second.entry.id);
    await supplied.resumeProof(data.second.entry.id);
    return { report: { originalProofSlotFilled: true }, sealed: {} };
  });
  return { helper, h, success, states, wasReleased: () => released };
}
test('held cancellation, phase competition, authentic reopen and explicit continuation assertions compose', async () => {
  const s = recoverySetup();
  const result = await s.helper.recover(s.h, s.success);
  expect(result.report.recoveryCompanion).toMatchObject({
    competingHistoryPhaseRefused: true,
    closeWaitedForOriginalSettlement: true,
    borrowedOwnersReopenedAndReused: true,
  });
  expect(s.h.adoptStores).toHaveBeenCalledTimes(1);
  expect(s.success).toHaveBeenCalledTimes(1);
  expect(s.wasReleased()).toBe(true);
});
test.each(['early-close', 'close-stores', 'history-allowed', 'signature'])(
  'refuses %s and still releases callback / drains companions',
  async (mutation) => {
    const s = recoverySetup(mutation);
    await expect(s.helper.recover(s.h, s.success)).rejects.toThrow();
    expect(s.wasReleased()).toBe(true);
    expect(s.states.every((v) => v.signal.aborted)).toBe(true);
    expect(s.success).not.toHaveBeenCalled();
  }
);

test('held cancellation does not record a sticky assertion when the losing settlement branch later fulfills', async () => {
  const s = recoverySetup(undefined, true);
  try {
    await s.helper.recover(s.h, s.success);
    await Promise.resolve();
    expect(require('./railgun-native-assertions').report()).toEqual([]);
  } finally {
    jest.doMock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
  }
});
