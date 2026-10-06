jest.mock('./railgun-native-assertions', () => ({
  assert: require('assert/strict'),
  assertEmpty: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-private-proof-recovery', () => ({
  resumeRailgunAccountPrivateProof: jest.fn(),
}));
jest.mock('../../src/main/wallet/railgun-account-public', () => ({
  getRailgunAccountPublicDestination: jest.fn(() => ({})),
}));
jest.mock('../../src/main/wallet/railgun-private-intent', () => ({
  matchRailgunPrivateProvedTransaction: jest.fn(() => ({
    digest: '0x' + 'a'.repeat(64),
  })),
}));
const api = require('./railgun-combined-poi-second-recovery');
const saved = require('./railgun-combined-poi-second-recovery-data');
const data = require('./railgun-combined-poi-restart-data');
const host =
  require('../../src/main/wallet/railgun-private-proof-recovery').resumeRailgunAccountPrivateProof;
const copy = (v) => JSON.parse(JSON.stringify(v));
let h, pair, actual, activity, files, record, writes, controller;
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  const entry = (id, n) => ({
    id,
    state: 'signing',
    facts: { nullifier: 'n' + n },
    signing: { submitter: 'owner' },
  });
  pair = {
    first: {
      entry: entry('1'.repeat(64), 1),
      stored: {
        holdId: '1'.repeat(64),
        signature: ['one'],
        provedTransaction: { first: true },
        capsule: {
          version: 2,
          preparation: {
            expected: { changeCommitment: 'change' },
            changeAmount: '50',
          },
        },
      },
    },
    second: {
      entry: entry('2'.repeat(64), 2),
      stored: {
        holdId: '2'.repeat(64),
        signature: ['two'],
        provedTransaction: null,
        capsule: {
          version: 1,
          selection: { kind: 'railgun-token-unshield', recipient: 'owner' },
          noteHash: 'change',
          preparation: {
            transaction: { data: 'original' },
            expected: { amount: '50' },
          },
        },
      },
    },
  };
  actual = copy(pair);
  record = {
    nonce: 1,
    revision: 5,
    observation: { blockHash: 'first-anchor', observedAt: 1, confirmations: 4 },
    resolution: { same: true },
  };
  activity = {
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
      poiMethods: {},
      publicServiceMethods: {},
      transportEntries: 0,
      transportCreates: 0,
      transportCloses: 0,
      transportReleases: 0,
      signatureChecks: 1,
    },
    chain: { posts: 0, attempted: {}, validated: {} },
    roleMethods: {},
    eoa: { sends: 0, signatures: 0, reviews: 0 },
  };
  files = {
    accounts: {
      'a/capsules': 'old-capsule',
      'a/manifest': 'old-manifest',
      'a/reservations': 'same-reservations',
    },
    submissions: { one: 'unchanged' },
    inventory: 'same',
    encryptedVault: 'same',
    publicVaultMetadata: 'same-public-metadata',
  };
  writes = { proofWrites: 0, floorWrites: 0, files: [] };
  const receipts = { first: {}, second: {} };
  const reservations = {
    withSigningRecovery: jest.fn(async (fn) =>
      fn(
        ['first', 'second'].map((k) => ({
          entry: actual[k].entry,
          receipt: receipts[k],
        })),
        { assertCurrent() {} }
      )
    ),
  };
  const capsules = {
    readSigned: jest.fn(async (receipt) =>
      receipt === receipts.first ? actual.first.stored : actual.second.stored
    ),
  };
  const retained = { state: 'attempted', revision: 1 },
    inspect = { sequence: 2, reservedTransitions: 2 };
  h = {
    identity: {},
    publicAccount: { coordinator: {} },
    enrollment: {
      openPrivateRecoveryStores: async () => ({ reservations, capsules }),
    },
    archive: '/engine',
    proverArchive: '/prover',
    artifactDirectory: '/artifacts',
    signal: controller.signal,
    pair: copy(pair),
    sealed: { records: saved.signedHashes(pair.first, pair.second, record) },
    journal: () => ({ list: async () => [copy(record)] }),
    store: {
      get: async () => copy(retained),
      inspect: async () => copy(inspect),
    },
    wire: {
      retained: { capsuleDigest: 'first' },
      checkpoint: { anchor: { number: 100 }, from: 80, to: { number: 100 } },
      receipt: { logs: [] },
    },
    source: { logs: [{ blockNumber: 90 }] },
    chain: { report: () => ({ posts: 0 }) },
    activity: () => copy(activity),
    phase: jest.fn(),
    profileSnapshot: () => copy(files),
    recoveryStorage: {
      arm: jest.fn(),
      report: () => copy(writes),
      assertComplete: jest.fn(() => {
        expect(writes.proofWrites).toBe(1);
        expect(writes.floorWrites).toBe(1);
      }),
    },
    pendingChildren: () => 0,
    unwipedLoans: () => 0,
  };
  host.mockImplementation(async (options) => {
    expect(options).toEqual({
      identity: h.identity,
      enrollment: h.enrollment,
      coordinator: h.publicAccount.coordinator,
      destination: {},
      archive: '/engine',
      proverArchive: '/prover',
      artifactDirectory: '/artifacts',
      holdId: pair.second.entry.id,
      signal: controller.signal,
      timeoutMs: 360000,
    });
    if (actual.second.stored.provedTransaction)
      return {
        status: 'proof-present',
        holdId: pair.second.entry.id,
        transactionDigest: '0x' + 'a'.repeat(64),
        submissionEnabled: false,
      };
    const jobs = {
      'railgun-public-job.js': 2,
      'railgun-wallet-job.js': 1,
      'railgun-private-recover-job.js': 1,
      'railgun-private-verify-job.js': 1,
    };
    for (const k of ['starts', 'exits', 'attemptedResults', 'admittedResults'])
      activity.audit[k] = copy(jobs);
    for (const k of ['keyRequests', 'keyReplies'])
      activity.audit[k] = {
        'railgun-wallet-job.js': 1,
        'railgun-private-recover-job.js': 1,
      };
    activity.storageWorkers.starts++;
    activity.storageWorkers.exits++;
    const methods = {
      'private-account:protocol-rpc:eth_chainId': 1,
      'private-account:protocol-rpc:eth_getBlockByNumber': 34,
      'private-account:protocol-rpc:eth_getLogs': 2,
    };
    activity.services.transportCreates++;
    activity.roleMethods = copy(methods);
    activity.chain.attempted = copy(methods);
    activity.chain.validated = copy(methods);
    actual.second.stored.provedTransaction = { data: 'real-modeled-candidate' };
    files.accounts['a/capsules'] = 'new-capsule';
    files.accounts['a/manifest'] = 'new-manifest';
    writes = {
      proofWrites: 1,
      floorWrites: 1,
      files: [
        'profile/wallet-railgun-accounts/a/capsules',
        'profile/wallet-railgun-accounts/a/manifest',
      ],
    };
    return {
      status: 'proof-stored',
      holdId: pair.second.entry.id,
      transactionDigest: '0x' + 'a'.repeat(64),
      submissionEnabled: false,
    };
  });
});
test('fixed genuine host only fills original slot, zero refresh or acceptance, duplicate query/job/write free', async () => {
  const value = await api.run(h);
  expect(host).toHaveBeenCalledTimes(2);
  expect(value.sealed.records.second.signature).toBe(data.digest(pair.second.stored.signature));
  expect(value.sealed.records.second.provedTransaction).toBe(
    data.digest(actual.second.stored.provedTransaction)
  );
  expect(value.report.secondSignedUnfinishedRecoveryQualified).toBe(false);
  expect(value.report.firstRecordRefreshReads).toBe(0);
  expect(h.pair).toEqual(pair);
  expect(h.recoveryStorage.arm).toHaveBeenCalledWith(pair.second);
});
test.each([
  'signature',
  'entry',
  'first',
  'journal',
  'inventory',
  'vault',
  'public-metadata',
  'reservations',
  'poi-query',
  'txid-job',
  'spending-key',
  'extra-header',
  'missing-exit',
  'authority',
  'unprefixed-digest',
  'short-digest',
  'different-digest',
  'preexisting-transport',
  'missing-transport',
  'extra-transport',
  'transport-release',
  'transport-close',
  'transport-entry',
  'service-signature',
  'duplicate-work',
])('refuses %s drift; no successful handoff', async (fault) => {
  const original = host.getMockImplementation();
  if (fault === 'preexisting-transport') activity.services.transportCreates = 1;
  let calls = 0;
  host.mockImplementation(async (options) => {
    const result = await original(options);
    calls++;
    if (fault === 'signature') actual.second.stored.signature = ['new'];
    if (fault === 'entry') actual.second.entry.signing.submitter = 'different';
    if (fault === 'first') actual.first.stored.provedTransaction = { different: true };
    if (fault === 'journal') record.revision++;
    if (fault === 'inventory') files.inventory = 'changed';
    if (fault === 'vault') files.encryptedVault = 'changed';
    if (fault === 'public-metadata') files.publicVaultMetadata = 'changed';
    if (fault === 'reservations') files.accounts['a/reservations'] = 'changed';
    if (fault === 'poi-query') activity.roleMethods['private-account:poi:ppoi_pois_per_list'] = 1;
    if (fault === 'txid-job') activity.audit.starts['railgun-txid-job.js'] = 1;
    if (fault === 'spending-key') activity.audit.keyRequests['railgun-spend-sign-job.js'] = 1;
    if (fault === 'extra-header')
      activity.roleMethods['private-account:protocol-rpc:eth_getBlockByNumber']++;
    if (fault === 'missing-exit') activity.audit.exits['railgun-private-recover-job.js'] = 0;
    if (fault === 'authority') result.submissionEnabled = true;
    if (fault === 'unprefixed-digest') result.transactionDigest = 'a'.repeat(64);
    if (fault === 'short-digest') result.transactionDigest = '0x' + 'a'.repeat(63);
    if (fault === 'different-digest') result.transactionDigest = '0x' + 'b'.repeat(64);
    if (fault === 'missing-transport') activity.services.transportCreates--;
    if (fault === 'extra-transport') activity.services.transportCreates++;
    if (fault === 'transport-release') activity.services.transportReleases++;
    if (fault === 'transport-close') activity.services.transportCloses++;
    if (fault === 'transport-entry') activity.services.transportEntries++;
    if (fault === 'service-signature') activity.services.signatureChecks++;
    if (fault === 'duplicate-work' && calls === 2)
      activity.audit.starts['railgun-private-recover-job.js']++;
    return result;
  });
  await expect(api.run(h)).rejects.toThrow();
});
test('held actual host cannot be reported/sealed early, cancellation does not skip its completion', async () => {
  const original = host.getMockImplementation();
  let release,
    settled = false;
  host.mockImplementation(async (o) => {
    await new Promise((r) => {
      release = r;
    });
    return original(o);
  });
  const work = api.run(h).finally(() => {
    settled = true;
  });
  const rejection = expect(work).rejects.toThrow();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  controller.abort();
  await new Promise((r) => setImmediate(r));
  expect(settled).toBe(false);
  release();
  await rejection;
  expect(host).toHaveBeenCalledTimes(1);
});
test.each(['pending-child', 'unwiped'])(
  'no completion evidence while %s remains',
  async (fault) => {
    if (fault === 'pending-child') h.pendingChildren = () => 1;
    else h.unwipedLoans = () => 1;
    await expect(api.run(h)).rejects.toThrow();
  }
);

test('explicit companion continuation reuses the successful retained source chain handshake', async () => {
  h.recoveryTransportAlreadyOpen = true;
  activity.services.transportCreates = 1;
  const original = host.getMockImplementation();
  host.mockImplementation(async (options) => {
    const value = await original(options);
    if (value.status === 'proof-stored') {
      activity.services.transportCreates--;
      delete activity.roleMethods['private-account:protocol-rpc:eth_chainId'];
      delete activity.chain.attempted['private-account:protocol-rpc:eth_chainId'];
      delete activity.chain.validated['private-account:protocol-rpc:eth_chainId'];
    }
    return value;
  });
  const result = await api.run(h);
  expect(result.report.methods['private-account:protocol-rpc:eth_chainId']).toBeUndefined();
});
test('an extra continuation chain handshake is not silently accepted', async () => {
  h.recoveryTransportAlreadyOpen = true;
  activity.services.transportCreates = 1;
  const original = host.getMockImplementation();
  host.mockImplementation(async (options) => {
    const value = await original(options);
    if (value.status === 'proof-stored') activity.services.transportCreates--;
    return value;
  });
  await expect(api.run(h)).rejects.toThrow();
});
