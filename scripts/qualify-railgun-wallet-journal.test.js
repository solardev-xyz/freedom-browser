/** Executable fixture selector controls; no native runtime or authority is simulated. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, 'qualify-railgun-wallet-journal.js'), 'utf8');
function section(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  expect(begin).toBeGreaterThan(0);
  expect(finish).toBeGreaterThan(begin);
  return source.slice(begin, finish);
}
function select(overrides = {}, inputs = {}) {
  const calls = [];
  const context = {
    assert,
    path,
    process: {
      env: {
        FREEDOM_RAILGUN_KOHAKU: 'public-shield',
        FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: 'acknowledged',
        FREEDOM_RAILGUN_SHIELD_BYTECODES: '/fixture/public-bytecodes.json',
        ...overrides,
      },
    },
    composition: 'enrolled',
    snapshotFlag: undefined,
    proverArchive: undefined,
    artifactDirectory: undefined,
    ...inputs,
    require(name) {
      return {
        install(...args) {
          calls.push({ name, args });
          return 'installed';
        },
      };
    },
  };
  vm.runInNewContext(section('  const kohakuMode =', '  let kohakuQualification;'), context);
  return calls;
}
test.each(['acknowledged', 'lost-response', 'review-cancelled'])(
  'public adapter selects only existing %s route with explicit option',
  (mode) => {
    const calls = select({
      FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER: '1',
      FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: mode,
    });
    expect(calls).toEqual([
      {
        name: './fixtures/railgun-kohaku-public-integration',
        args: ['/fixture/public-bytecodes.json', mode, { publicAdapter: true }],
      },
    ]);
  }
);
test.each(['acknowledged', 'lost-response', 'review-cancelled'])(
  'default %s invocation remains two arguments with no adapter option',
  (mode) => {
    expect(select({ FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: mode })).toEqual([
      {
        name: './fixtures/railgun-kohaku-public-integration',
        args: ['/fixture/public-bytecodes.json', mode],
      },
    ]);
  }
);
test.each(['', '0', 'true', '2'])('invalid explicit public adapter flag %j refuses', (flag) => {
  expect(() => select({ FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER: flag })).toThrow();
});
test.each([undefined, 'shield-transfer', 'transact-unshield', 'other'])(
  'public adapter cannot select nonpublic mode %j',
  (mode) => {
    expect(() =>
      select(
        {
          FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER: '1',
          FREEDOM_RAILGUN_KOHAKU: mode,
          FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: undefined,
          FREEDOM_RAILGUN_SHIELD_BYTECODES: undefined,
        },
        { proverArchive: mode ? '/fixture/prover' : undefined }
      )
    ).toThrow();
  }
);
test.each([
  [{ FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER: '1' }, {}],
  [{ FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER_DENY: '1' }, {}],
  [{ FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: 'other' }, {}],
  [{ FREEDOM_RAILGUN_PRIVATE_OPERATION: 'railgun-private-transfer' }, {}],
  [{ FREEDOM_RAILGUN_KOHAKU_LOST_ACK: '1' }, {}],
  [{ FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW: '1' }, {}],
  [{}, { snapshotFlag: '1' }],
  [{}, { composition: undefined }],
  [{}, { proverArchive: '/fixture/prover' }],
  [{}, { artifactDirectory: '/fixture/artifacts' }],
])('incompatible adapter composition refuses before fixture install %#', (env, inputs) => {
  expect(() => select({ FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER: '1', ...env }, inputs)).toThrow();
});
function inventory(publicAdapterMode, publicShield = true) {
  return vm.runInNewContext(section('  const sources = [', '  const hashes =') + '\nsources;', {
    kohaku: {},
    publicShield,
    publicAdapterMode,
    privateAdapterMode: false,
    snapshotProbe: null,
    localReviewProbe: null,
    relayPreparationProbe: null,
    exactReviewProbe: null,
    require: (name) => {
      expect([
        '../docs/qualification/railgun-shield-prerequisites-2026-10-04.json',
        '../src/main/wallet/railgun-txid-policy',
        './fixtures/railgun-kohaku-adapter-sources',
      ]).toContain(name);
      return require(name);
    },
  });
}
test('public adapter inventory adds exact evidence paths only when selected', () => {
  const baseline = inventory(false),
    selected = inventory(true);
  const additions = selected.filter((name) => !baseline.includes(name));
  expect(additions).toEqual([
    'src/main/wallet/railgun-kohaku-public-host.js',
    'src/main/wallet/railgun-kohaku-public-host.test.js',
    'src/main/wallet/railgun-kohaku-public-adapter.js',
    'src/main/wallet/railgun-kohaku-public-adapter.test.js',
    'scripts/fixtures/railgun-kohaku-public-contract.d.ts',
    'scripts/fixtures/railgun-kohaku-public-conformance.js',
    'scripts/fixtures/railgun-kohaku-public-integration.test.js',
    'scripts/qualify-railgun-wallet-journal.test.js',
  ]);
  expect(selected.filter((name) => !additions.includes(name))).toEqual(baseline);
  expect(new Set(baseline).size).toBe(207);
  expect(new Set(selected).size).toBe(215);
  expect(baseline).toEqual(
    expect.arrayContaining([
      'scripts/fixtures/railgun-transact-staging-source.js',
      'scripts/fixtures/railgun-enrolled-transact-staging.js',
      'src/main/wallet/railgun-account-fence.js',
      'src/main/wallet/railgun-note-provenance-job.js',
      'src/main/wallet/railgun-txid-note-witness.js',
      'src/main/wallet/railgun-txid-root.js',
      // Loaded by railgun-private-submission.js at module load.
      'src/main/wallet/railgun-recovered-review-budget.json',
    ])
  );
  expect(baseline).toContain('scripts/fixtures/railgun-kohaku-contract-observer.js');
  expect(baseline).toContain('scripts/fixtures/railgun-kohaku-contract-observer.test.js');
  expect(baseline).toContain('src/main/wallet/railgun-kohaku-read-data.js');
  expect(baseline).toEqual(
    expect.arrayContaining(require('./fixtures/railgun-kohaku-adapter-sources').SOURCES)
  );
  expect(inventory(false, false).some((name) => additions.includes(name))).toBe(false);
});
function report(mode) {
  return {
    publicAdapterQualification: {
      readyReads: {
        calls: 13,
        genuineOwnedSnapshotCompared: true,
        detachedMutationIsolation: true,
        noAdditionalMeasuredWork: true,
        eligibilityGranted: false,
        genericHostQualified: false,
      },
      preparedReads: { calls: 3, noAdditionalMeasuredWork: true },
      closedReads: { calls: 3, noAdditionalMeasuredWork: true },
      originalSettlement: {
        acknowledgedValueEqualsRequest: mode === 'acknowledged',
        journalErrorCode: mode === 'lost-response' ? 'PRIVATE_BROADCAST_UNCERTAIN' : null,
        canonicalUncertaintyHash: mode === 'lost-response',
        status: mode === 'acknowledged' ? 'fulfilled' : 'rejected',
        fields:
          mode === 'acknowledged'
            ? {
                broadcastSource: 'string',
                chainId: 'number',
                explorerUrl: 'object',
                from: 'string',
                hash: 'string',
                nonce: 'number',
                to: 'string',
                value: 'string',
              }
            : mode === 'lost-response'
              ? { code: 'string', submissionStatus: 'string', transactionHash: 'string' }
              : { code: 'string' },
        originalValueOrErrorIdentity: true,
        genuinePublicFacadeTokenDistinct: true,
      },
      genuineAdoptingHost: true,
      readyOnlyReads: true,
      originalPublicErrorsRemainRejected: true,
      privateOutcomeUnionUsed: false,
      facadeInternalsExposed: false,
      heldOutwardBeforeCallbackRelease: mode === 'review-cancelled',
      sourceDerivedNoAdditionalRpcKeysJobs: true,
    },
    contract: { reads: [], forwarding: { checkedCalls: 1 } },
  };
}
function gate(mode, value) {
  vm.runInNewContext(
    'const kohakuQualification = JSON.parse(wire);\n' +
      section(
        '        const adapter = kohakuQualification.publicAdapterQualification;',
        '\n      } else {'
      ),
    {
      assert,
      wire: JSON.stringify(value),
      process: { env: { FREEDOM_RAILGUN_KOHAKU_PUBLIC_CASE: mode } },
    }
  );
}
test.each(['acknowledged', 'lost-response', 'review-cancelled'])(
  'bounded report gate accepts %s schema',
  (mode) => {
    expect(() => gate(mode, report(mode))).not.toThrow();
  }
);
test.each([
  ['readyReads', 'calls', 12],
  ['preparedReads', 'calls', 0],
  ['closedReads', 'calls', 0],
  ['readyReads', 'genuineOwnedSnapshotCompared', false],
  ['readyReads', 'detachedMutationIsolation', false],
  ['readyReads', 'noAdditionalMeasuredWork', false],
  ['preparedReads', 'noAdditionalMeasuredWork', false],
  ['closedReads', 'noAdditionalMeasuredWork', false],
  ['readyReads', 'eligibilityGranted', true],
  ['readyReads', 'genericHostQualified', true],
  ['originalSettlement', 'originalValueOrErrorIdentity', false],
  ['originalSettlement', 'genuinePublicFacadeTokenDistinct', false],
  ['originalSettlement', 'status', 'rejected'],
  ['originalSettlement', 'fields', { code: 'string' }],
])('report cannot claim missing independent evidence %s.%s', (object, key, value) => {
  const candidate = report('acknowledged');
  candidate.publicAdapterQualification[object][key] = value;
  expect(() => gate('acknowledged', candidate)).toThrow();
});
test.each(['lost-response', 'review-cancelled'])(
  'public %s remains rejected and requires exact own error keys',
  (mode) => {
    const candidate = report(mode);
    candidate.publicAdapterQualification.originalSettlement.status = 'fulfilled';
    expect(() => gate(mode, candidate)).toThrow();
    candidate.publicAdapterQualification.originalSettlement.status = 'rejected';
    candidate.publicAdapterQualification.originalSettlement.fields.status = 'string';
    expect(() => gate(mode, candidate)).toThrow();
  }
);
test('cancelled report needs held outward evidence and nonzero independent settlement', () => {
  const candidate = report('review-cancelled');
  candidate.publicAdapterQualification.heldOutwardBeforeCallbackRelease = false;
  expect(() => gate('review-cancelled', candidate)).toThrow();
  candidate.publicAdapterQualification.heldOutwardBeforeCallbackRelease = true;
  candidate.contract.forwarding.checkedCalls = 0;
  expect(() => gate('review-cancelled', candidate)).toThrow();
});

test.each([
  ['acknowledged', 'acknowledgedValueEqualsRequest', false],
  ['lost-response', 'journalErrorCode', 'PRIVATE_SUBMISSION_UNRESOLVED'],
  ['lost-response', 'canonicalUncertaintyHash', false],
  ['review-cancelled', 'journalErrorCode', 'PRIVATE_BROADCAST_UNCERTAIN'],
])('public %s settlement requires source-specific %s evidence', (mode, key, value) => {
  const candidate = report(mode);
  candidate.publicAdapterQualification.originalSettlement[key] = value;
  expect(() => gate(mode, candidate)).toThrow();
});

function localReviewSelection(flag, extra = {}, inputs = {}) {
  const context = {
    assert,
    process: {
      env: {
        ...(flag === undefined ? {} : { FREEDOM_RAILGUN_LOCAL_RELAY_REVIEW: flag }),
        ...extra,
      },
    },
    composition: 'enrolled',
    proverArchive: undefined,
    artifactDirectory: undefined,
    ...inputs,
  };
  vm.runInNewContext(section('  const localReviewFlag =', '  fs.mkdirSync(directory,'), context);
}
test('local review is default-off and validates its selector before output creation', () => {
  expect(() => localReviewSelection(undefined)).not.toThrow();
  expect(() => localReviewSelection('1')).not.toThrow();
  expect(source.indexOf('  const localReviewFlag =')).toBeLessThan(
    source.indexOf('  fs.mkdirSync(directory,')
  );
  expect(source).toContain("localReviewProbe && stage === 30 && attempt === 'restore'");
});
test.each(['', '0', 'true', '2'])('local review refuses unknown selector %j', (flag) => {
  expect(() => localReviewSelection(flag)).toThrow();
});
test.each([
  'FREEDOM_RAILGUN_KOHAKU',
  'FREEDOM_RAILGUN_KOHAKU_SNAPSHOT',
  'FREEDOM_RAILGUN_PRIVATE_OPERATION',
  'FREEDOM_RAILGUN_KOHAKU_PUBLIC_ADAPTER',
  'FREEDOM_RAILGUN_FUTURE_UNKNOWN',
])('local review refuses inherited %s mode', (name) => {
  expect(() => localReviewSelection('1', { [name]: '1' })).toThrow();
  expect(() => localReviewSelection(undefined, { [name]: '1' })).not.toThrow();
});
test.each([
  { composition: undefined },
  { proverArchive: '/public/prover' },
  { artifactDirectory: '/public/artifacts' },
])('local review rejects incompatible route %j', (inputs) => {
  expect(() => localReviewSelection('1', {}, inputs)).toThrow();
});
test('local review inventory adds exact 15 bounded paths only for the new selector', () => {
  const expression =
    section('  const sources = [', '\n  ];').replace('  const sources = ', '') + '\n]';
  const evaluate = (localReviewProbe) =>
    vm.runInNewContext(expression, {
      kohaku: null,
      publicShield: false,
      privateAdapterMode: false,
      publicAdapterMode: false,
      snapshotProbe: null,
      localReviewProbe,
      relayPreparationProbe: null,
      exactReviewProbe: null,
    });
  const off = evaluate(null),
    on = evaluate({});
  expect(on.length - off.length).toBe(15);
  expect(on).toContain('scripts/fixtures/railgun-relay-quote-native-vectors.js');
  expect(on).toContain('src/main/wallet/railgun-relay-review.js');
  expect(off).not.toContain('src/main/wallet/railgun-relay-review.js');
});

function relayPreparationSelection(flag, extra = {}, inputs = {}) {
  const context = {
    assert,
    process: {
      env: {
        ...(flag === undefined ? {} : { FREEDOM_RAILGUN_UNSIGNED_RELAY_PREPARATION: flag }),
        ...extra,
      },
    },
    composition: 'enrolled',
    accountArchive: '/public/engine.asar',
    proverArchive: undefined,
    artifactDirectory: undefined,
    ...inputs,
  };
  vm.runInNewContext(
    section('  const relayPreparationFlag =', '  fs.mkdirSync(directory,'),
    context
  );
}
test('unsigned relay preparation is default-off and validates before output creation', () => {
  expect(() => relayPreparationSelection()).not.toThrow();
  expect(() => relayPreparationSelection('1')).not.toThrow();
  const hook = source.indexOf(
    "if (relayPreparationProbe && stage === 30 && attempt === 'restore')"
  );
  expect(hook).toBeGreaterThan(source.indexOf('const accountWindows = []'));
  expect(hook).toBeLessThan(source.indexOf('runs.push({\n              ...(transactStaging'));
});
test.each(['', '0', 'true', '2'])('unsigned preparation rejects selector %j', (flag) => {
  expect(() => relayPreparationSelection(flag)).toThrow();
});
test.each([
  'FREEDOM_RAILGUN_LOCAL_RELAY_REVIEW',
  'FREEDOM_RAILGUN_KOHAKU_SNAPSHOT',
  'FREEDOM_RAILGUN_KOHAKU',
  'FREEDOM_RAILGUN_PRIVATE_OPERATION',
  'FREEDOM_RAILGUN_FUTURE_UNKNOWN',
])('unsigned preparation rejects mixed %s', (name) => {
  expect(() => relayPreparationSelection('1', { [name]: '1' })).toThrow();
});
test.each([
  { composition: undefined },
  { accountArchive: undefined },
  { proverArchive: '/public/prover' },
  { artifactDirectory: '/public/artifacts' },
])('unsigned preparation rejects incompatible inputs %j', (inputs) => {
  expect(() => relayPreparationSelection('1', {}, inputs)).toThrow();
});
test('unsigned preparation inventory adds only the bounded optional source set', () => {
  const expression =
    section('  const sources = [', '\n  ];').replace('  const sources = ', '') + '\n]';
  const evaluate = (relayPreparationProbe) =>
    vm.runInNewContext(expression, {
      kohaku: null,
      publicShield: false,
      privateAdapterMode: false,
      publicAdapterMode: false,
      snapshotProbe: null,
      localReviewProbe: null,
      relayPreparationProbe,
      exactReviewProbe: null,
    });
  const off = evaluate(null),
    on = evaluate({});
  expect(on.length - off.length).toBe(23);
  expect(on).toContain('src/main/wallet/railgun-relay-reconstruct.js');
  expect(on).toContain('scripts/fixtures/railgun-relay-preparation-native.js');
  expect(off).not.toContain('scripts/fixtures/railgun-relay-preparation-native.js');
  for (const filename of on) expect(fs.existsSync(path.join(__dirname, '..', filename))).toBe(true);
});

function exactReviewSelection(flag, extra = {}, inputs = {}) {
  vm.runInNewContext(section('  const exactReviewFlag =', '  const relayPreparationFlag ='), {
    assert,
    process: {
      env: {
        ...(flag === undefined ? {} : { FREEDOM_RAILGUN_EXACT_RELAY_REVIEW: flag }),
        ...extra,
      },
    },
    composition: 'enrolled',
    accountArchive: '/public/engine.asar',
    proverArchive: undefined,
    artifactDirectory: undefined,
    ...inputs,
  });
}
test.each([undefined, 'accept', 'held-close'])(
  'exact review selector %j is supported before directory creation',
  (flag) => {
    expect(() => exactReviewSelection(flag)).not.toThrow();
    expect(source.indexOf('  const exactReviewFlag =')).toBeLessThan(
      source.indexOf('  fs.mkdirSync(directory,')
    );
  }
);
test.each(['', '0', '1', 'true', 'decline'])('exact review refuses selector %j', (flag) => {
  expect(() => exactReviewSelection(flag)).toThrow();
});
test.each([
  'FREEDOM_RAILGUN_UNSIGNED_RELAY_PREPARATION',
  'FREEDOM_RAILGUN_LOCAL_RELAY_REVIEW',
  'FREEDOM_RAILGUN_KOHAKU',
  'FREEDOM_RAILGUN_UNKNOWN',
])('exact review refuses mixed %s', (name) => {
  expect(() => exactReviewSelection('accept', { [name]: '1' })).toThrow();
});
test.each([
  { composition: undefined },
  { accountArchive: undefined },
  { proverArchive: '/prover' },
  { artifactDirectory: '/artifacts' },
])('exact review rejects incompatible input %j', (input) => {
  expect(() => exactReviewSelection('held-close', {}, input)).toThrow();
});
test('exact review inventory includes the unchanged unsigned observer plus exact production review sources', () => {
  const expression =
    section('  const sources = [', '\n  ];').replace('  const sources = ', '') + '\n]';
  const evaluate = (enabled) =>
    vm.runInNewContext(expression, {
      kohaku: null,
      publicShield: false,
      privateAdapterMode: false,
      publicAdapterMode: false,
      snapshotProbe: null,
      localReviewProbe: null,
      relayPreparationProbe: null,
      exactReviewProbe: enabled ? {} : null,
    });
  const off = evaluate(false),
    on = evaluate(true);
  expect(on.length - off.length).toBe(31);
  expect(new Set(on).size - new Set(off).size).toBe(26);
  for (const name of [
    'scripts/fixtures/railgun-relay-exact-review-native.js',
    'scripts/fixtures/railgun-relay-preparation-native.js',
    'src/main/wallet/railgun-relay-review-summary.js',
    'src/main/wallet/railgun-account-wallet.test.js',
  ])
    expect(on).toContain(name);
  expect(off).not.toContain('scripts/fixtures/railgun-relay-exact-review-native.js');
  const hook = source.indexOf("if (exactReviewProbe && stage === 30 && attempt === 'restore')");
  expect(hook).toBeGreaterThan(source.indexOf('const accountWindows = []'));
  expect(hook).toBeLessThan(source.indexOf('runs.push({\n              ...(transactStaging'));
});

test('relay refusal branch is default off and returns before legacy enrollment setup', async () => {
  const start = source.indexOf('  const refusalFlag =');
  const end = source.indexOf('  const [sourceFilename,', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls = [],
    fixture = {
      select: (...args) => {
        calls.push(['select', ...args]);
        return { scenario: args[0] };
      },
      execute: async (config) => {
        calls.push(['execute', config]);
      },
    };
  const run = Function(
    'process',
    'require',
    'return (async () => {' + source.slice(start, end) + 'return "legacy";})();'
  );
  const req = (name) => {
    expect(name).toBe('./fixtures/railgun-relay-refusal-native');
    return fixture;
  };
  await expect(run({ env: {}, argv: [] }, req)).resolves.toBe('legacy');
  expect(calls).toEqual([]);
  const env = { FREEDOM_RAILGUN_RELAY_REFUSAL: 'declined-disclosure' };
  await expect(run({ env, argv: ['electron', 'script', 'public'] }, req)).resolves.toBeUndefined();
  expect(calls).toEqual([
    ['select', 'declined-disclosure', ['public'], env],
    ['execute', { scenario: 'declined-disclosure' }],
  ]);
});
