const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');
const api = require('./qualify-railgun-private-live');

const hash = (byte) => '0x' + byte.repeat(32);
const sha = (byte) => byte.repeat(32);
const OWNER = '0x' + 'c0'.repeat(20);
const SHIELD = hash('5b');
const TRANSFER = hash('7a');
const UNSHIELD = hash('7b');
const SCAN_SHA = sha('aa');
const NEWER_SCAN_SHA = sha('ab');
const D1_SHA = sha('d1');
const refused = (step) =>
  expect.objectContaining({ code: 'RAILGUN_LIVE_JOURNEY_REFUSED', ...(step ? { step } : {}) });
const expectRefusal = (run, step) => {
  let error;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toEqual(refused(step));
};

describe('pinned constants', () => {
  test('match the production list, service, ceiling and pinned destination source', () => {
    expect(api.REQUIRED_LIST).toBe(require('../src/main/wallet/railgun-poi-records').REQUIRED_LIST);
    expect(api.POI_ORIGIN).toBe(require('../src/main/wallet/railgun-public-services').POI_URL);
    expect(api.FEE_CAP_WEI).toBe(2000000000000000n);
    expect(api.GAS_LIMIT_CEILING).toBe(3000000n);
    expect(api.CHAIN_ID).toBe(require('../src/main/wallet/railgun-shield-pins.json').chainId);
    expect(api.FIXED_SOURCES).toContain('src/main/wallet/railgun-private-destination.js');
    for (const name of [...api.FIXED_SOURCES, ...api.SOURCE_DIRECTORIES])
      expect(fs.existsSync(path.join(__dirname, '..', name))).toBe(true);
  });
  test('every fixed qualification inventory that binds the submission binds its review budget', () => {
    // Directory-listing inventories (this qualifier, proof recovery, partial
    // submission, combined POI) take src/main/wallet/*.json already.
    const submission = "'src/main/wallet/railgun-private-submission.js',";
    const budget = "'src/main/wallet/railgun-recovered-review-budget.json',";
    const fixed = fs
      .readdirSync(__dirname)
      .filter((name) => /^qualify-.*\.js$/.test(name) && !name.endsWith('.test.js'))
      .filter((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').includes(submission));
    expect(fixed).toHaveLength(11);
    for (const name of fixed) {
      const lines = fs.readFileSync(path.join(__dirname, name), 'utf8').split('\n');
      const at = lines.findIndex((line) => line.trim() === submission);
      expect([name, lines[at + 1].trim()]).toEqual([name, budget]);
    }
  });
  test('the production submission keeps the same gas and fee bounds', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/main/wallet/railgun-private-submission.js'),
      'utf8'
    );
    expect(source).toContain('gasLimit <= 3000000n');
    expect(source).toContain('maxGasFee <= 2000000000000000n');
    expect(source).toContain('gasLimit * fee <= maxGasFee');
  });
  test('the recovered submission binds the current checkpoint the probe reproduces', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/main/wallet/railgun-private-submission.js'),
      'utf8'
    );
    for (const text of [
      'checkpointHash: currentCheckpointHash ?? snapshot.entry.facts.checkpointHash,',
      'minimumBlock: owned.publicThrough.number,',
      'currentCheckpointHash: owned.binding.checkpointHash,',
      'timeoutMs = 600000,',
      'const timer = setTimeout(stop, 20000);',
    ])
      expect(source).toContain(text);
    expect(api.RECOVERY_TIMEOUT_MS).toBe(600000);
    expect(api.HELD_TRANSFER_REPORT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  test('the production preflight queries the selected nullifier after every earlier check', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/main/wallet/railgun-private-preflight.js'),
      'utf8'
    );
    const order = [
      'const base = await deployment.acquire();',
      "step = 'artifacts';",
      "await getter('rootHistory'",
      "await getter('unshieldFee'",
      'assertRailgunArtifactVerifier(artifacts, encoded);',
      "await getter('nullifiers'",
      "step = 'anchor-recheck';",
    ].map((text) => {
      expect(source.split(text)).toHaveLength(2);
      return source.indexOf(text);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(api.PROBE_DISCLOSURE_ORDER.indexOf('selected-nullifier')).toBe(
      api.PROBE_DISCLOSURE_ORDER.length - 2
    );
  });
  test('loading the script starts no Electron, profile, wallet or network work', () => {
    const filename = path.join(__dirname, 'qualify-railgun-private-live.js');
    const imports = [];
    const req = (name) => {
      imports.push(name);
      return name.startsWith('.') ? require(path.join(__dirname, name)) : require(name);
    };
    req.main = {};
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: req,
      module: { exports: {} },
      __dirname,
      __filename: filename,
      process: { argv: [], versions: {}, env: {} },
      console,
      performance,
      URL,
      BigInt,
    });
    expect(imports).toEqual([
      'fs',
      'path',
      'crypto',
      'util',
      '../src/main/wallet/railgun-shield-pins.json',
    ]);
  });
});

describe('arguments', () => {
  const valid = [
    'transfer',
    '/w/engine.asar',
    '/w/prover.asar',
    '/w/artifacts',
    '/w/identity-data/railgun-sepolia-live',
    '/w/scan/report.json',
    SCAN_SHA,
    '/w/check/report.json',
    sha('bb'),
    '/w/l-a/transfer',
  ];
  // recover-submit writes recover-submit-<probe sha256> beside the probe's output.
  const recoverOutput = '/w/recover-submit-' + sha('bb');
  test('accepts the fixed ten-argument form for every mode', () => {
    for (const mode of api.MODES) {
      const output = mode === 'recover-submit' ? recoverOutput : '/w/l-a/transfer';
      expect(api.parseArguments([mode, ...valid.slice(1, 9), output])).toMatchObject({
        mode,
        profile: '/w/identity-data/railgun-sepolia-live',
        output,
      });
    }
  });
  test('recover-submit refuses any output but the one for its probe', () => {
    const recover = (output, previous = valid[7], previousSha = valid[8]) =>
      api.parseArguments(['recover-submit', ...valid.slice(1, 7), previous, previousSha, output]);
    expect(recover(recoverOutput).output).toBe(recoverOutput);
    for (const [output, previous, previousSha] of [
      ['/w/l-a/transfer'],
      ['/w/recover-submit-' + sha('bc')],
      ['/w/recover-submit-' + sha('bb') + '-2'],
      ['/w/other/recover-submit-' + sha('bb')],
      ['/recover-submit-' + sha('bb')],
      [recoverOutput, valid[7], sha('bc')],
      [recoverOutput, '/w/elsewhere/check/report.json'],
    ])
      expectRefusal(() => recover(output, previous, previousSha), 'output');
  });
  test.each([
    ['too few', valid.slice(0, 9), 'arguments'],
    ['unknown mode', ['send', ...valid.slice(1)], 'mode'],
    ['relative path', [...valid.slice(0, 1), 'engine.asar', ...valid.slice(2)], 'arguments'],
    ['bad scan sha', [...valid.slice(0, 6), 'abc', ...valid.slice(7)], 'arguments'],
    ['uppercase sha', [...valid.slice(0, 8), sha('BB'), valid[9]], 'arguments'],
    ['output inside profile', [...valid.slice(0, 9), valid[4] + '/out'], 'output'],
    ['output is profile', [...valid.slice(0, 9), valid[4]], 'output'],
    ['output replaces previous', [...valid.slice(0, 9), valid[7]], 'output'],
  ])('refuses %s', (_name, args, step) => {
    expectRefusal(() => api.parseArguments(args), step);
  });
});

describe('fee cap', () => {
  test('legacy and EIP-1559 exposure use the authorized maximum fee', () => {
    expect(api.feeExposure({ gasLimit: '1000000', gasPrice: '2000000000' }).exposure).toBe(
      2000000000000000n
    );
    expect(
      api.feeExposure({ gasLimit: 1000000n, maxFeePerGas: '3', maxPriorityFeePerGas: '1' }).exposure
    ).toBe(3000000n);
  });
  test.each([
    ['both fee fields', { gasLimit: 1, gasPrice: 1, maxFeePerGas: 1 }],
    ['no fee field', { gasLimit: 1 }],
    ['zero fee', { gasLimit: 1, gasPrice: 0 }],
    ['zero gas', { gasLimit: 0, gasPrice: 1 }],
    ['garbage', { gasLimit: 'x', gasPrice: 1 }],
  ])('refuses %s', (_name, tx) => {
    expectRefusal(() => api.feeExposure(tx), 'fee-shape');
  });
  test('allows exposure exactly at 0.002 ETH and refuses one wei above', () => {
    expect(api.assertFeeWithinCap({ gasLimit: 1000000n, gasPrice: 2000000000n }).exposure).toBe(
      api.FEE_CAP_WEI
    );
    expectRefusal(
      () => api.assertFeeWithinCap({ gasLimit: 1000000n, gasPrice: 2000000001n }),
      'fee-cap'
    );
    expectRefusal(
      () => api.assertFeeWithinCap({ gasLimit: 1n, maxFeePerGas: api.FEE_CAP_WEI + 1n }),
      'fee-cap'
    );
  });
  test('the gas ceiling holds even when the fee is tiny', () => {
    expect(api.assertFeeWithinCap({ gasLimit: 3000000n, gasPrice: 1n }).gasLimit).toBe(3000000n);
    expectRefusal(
      () => api.assertFeeWithinCap({ gasLimit: 3000001n, gasPrice: 1n }),
      'gas-ceiling'
    );
  });
  test('a caller cannot raise the cap', () => {
    expectRefusal(
      () => api.assertFeeWithinCap({ gasLimit: 1n, gasPrice: 1n }, api.FEE_CAP_WEI + 1n),
      'fee-cap'
    );
  });
  test('gas limit is the estimate with a 5/4 margin, rounded up, never above 3M', () => {
    expect(api.gasLimitFromEstimate('0xd77ec')).toBe(1103335n); // 882,668 gas
    expect(api.gasLimitFromEstimate(1n)).toBe(2n);
    expect(api.gasLimitFromEstimate(4n)).toBe(5n);
    expect(api.gasLimitFromEstimate(2400000n)).toBe(3000000n);
    expectRefusal(() => api.gasLimitFromEstimate(2400001n), 'gas-ceiling');
    for (const value of [0n, -1n, 'x', undefined])
      expectRefusal(() => api.gasLimitFromEstimate(value), 'estimate');
  });
  test('the submission plan refuses at the boundary before any send', () => {
    // 1,000,000 x 5/4 = 1,250,000 gas; 1.6 gwei puts exposure exactly on the cap.
    expect(api.planSubmissionFee({ estimate: '0xf4240', gasPrice: '1600000000' })).toEqual({
      estimate: '1000000',
      gasLimit: '1250000',
      headroom: '5/4',
      quotedGasPrice: '1600000000',
      quotedExposureWei: '2000000000000000',
      capWei: '2000000000000000',
    });
    expectRefusal(
      () => api.planSubmissionFee({ estimate: '0xf4240', gasPrice: '1600000001' }),
      'fee-cap'
    );
  });
  test('the planning check refuses before proving when the planning limit would exceed the cap', () => {
    expect(api.planningFeeCheck('1333333333').exposureWei).toBe('1999999999500000');
    expectRefusal(() => api.planningFeeCheck('1333333334'), 'fee-cap');
  });
  test('the review recheck binds the planned gas limit and the actual fee', () => {
    expect(api.reviewedFee({ gasLimit: '1250000', gasPrice: '1000000000' }, '1250000')).toEqual({
      gasLimit: '1250000',
      fee: '1000000000',
      feeField: 'gasPrice',
      exposureWei: '1250000000000000',
      capWei: '2000000000000000',
    });
    expectRefusal(
      () => api.reviewedFee({ gasLimit: '1250001', gasPrice: '1' }, '1250000'),
      'fee-gas-limit'
    );
    expectRefusal(
      () => api.reviewedFee({ gasLimit: '1250000', gasPrice: '1600000001' }, '1250000'),
      'fee-cap'
    );
  });
});

const shieldRecord = () => ({
  hash: SHIELD,
  state: 'submitted',
  intent: { kind: 'railgun-native-shield' },
  resolution: { railgun: { outcome: 'matched' } },
});
const transferRecord = (resolution = { railgun: { outcome: 'matched' } }) => ({
  hash: TRANSFER,
  state: 'submitted',
  intent: { kind: 'railgun-transact', operation: 'railgun-private-transfer', nullifier: 'private' },
  ...(resolution ? { resolution } : {}),
});
const unshieldRecord = (resolution = null) => ({
  hash: UNSHIELD,
  state: 'attempted',
  intent: { kind: 'railgun-transact', operation: 'railgun-token-unshield' },
  ...(resolution ? { resolution } : {}),
});
const journal = (records, archive = []) => ({ records, archive });
const chain = { transfer: { hash: TRANSFER, blockNumber: 100 } };

describe('journal', () => {
  test('the transfer is admitted only with a resolved journal and no prior private send', () => {
    expect(() => api.assertSpendAdmission(journal([], [shieldRecord()]), 'transfer')).not.toThrow();
    api.assertShieldRecord(journal([], [shieldRecord()]), SHIELD);
    expectRefusal(
      () =>
        api.assertSpendAdmission(journal([{ ...shieldRecord(), resolution: null }]), 'transfer'),
      'journal-unresolved'
    );
    expectRefusal(
      () => api.assertSpendAdmission(journal([], [shieldRecord(), transferRecord()]), 'transfer'),
      'spend-attempted'
    );
  });
  test('the unshield needs exactly the matched transfer', () => {
    expect(() =>
      api.assertSpendAdmission(journal([transferRecord()], [shieldRecord()]), 'unshield', chain)
    ).not.toThrow();
    for (const records of [
      [transferRecord({ railgun: { outcome: 'reverted' } })],
      [transferRecord(), unshieldRecord({ railgun: { outcome: 'matched' } })],
      [],
    ])
      expect(() => api.assertSpendAdmission(journal(records), 'unshield', chain)).toThrow();
    expectRefusal(
      () =>
        api.assertSpendAdmission(journal([transferRecord(), unshieldRecord()]), 'unshield', chain),
      'journal-unresolved'
    );
    expectRefusal(
      () => api.assertSpendAdmission(journal([transferRecord()]), 'unshield', { transfer: null }),
      'transfer-unresolved'
    );
  });
  test('an uncertain send is observation-only and blocks every later mode', () => {
    const before = journal([], [shieldRecord()]);
    const after = journal([transferRecord(null)], [shieldRecord()]);
    const outcome = api.classifySpendOutcome({
      result: { transactionHash: TRANSFER, submissionStatus: 'unknown' },
      before,
      after,
    });
    expect(outcome).toEqual({
      attempted: true,
      journaled: true,
      journaledHash: TRANSFER,
      journalState: 'submitted',
      submissionStatus: 'unknown',
      resendAllowed: false,
    });
    // No second transfer, no unshield and no post-transfer step while unresolved.
    expectRefusal(() => api.assertSpendAdmission(after, 'transfer'), 'journal-unresolved');
    expectRefusal(() => api.assertSpendAdmission(after, 'unshield', chain), 'journal-unresolved');
    expectRefusal(() => api.assertTransferSettled(after, chain), 'journal-unresolved');
    // Observation alone may select the open record.
    expect(api.selectObservedRecord(after, 'transfer', {}, null).hash).toBe(TRANSFER);
    expect(api.selectObservedRecord(after, 'transfer', {}, TRANSFER).hash).toBe(TRANSFER);
  });
  test('classifies acknowledged, not-sent and refused-after-journal outcomes', () => {
    const before = journal([], [shieldRecord()]);
    const after = journal([transferRecord(null)], [shieldRecord()]);
    expect(api.classifySpendOutcome({ result: { hash: TRANSFER }, before, after })).toMatchObject({
      submissionStatus: 'acknowledged',
      journaledHash: TRANSFER,
      resendAllowed: false,
    });
    expect(
      api.classifySpendOutcome({
        result: { status: 'recovery-required', stage: 'preflight' },
        before,
        after: before,
      })
    ).toEqual({
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
      resendAllowed: false,
    });
    expect(
      api.classifySpendOutcome({
        result: { status: 'recovery-required', stage: 'submission' },
        before,
        after,
      })
    ).toMatchObject({ attempted: true, submissionStatus: 'unknown' });
  });
  test('refuses unbound or multiple attempts', () => {
    const before = journal([]);
    expectRefusal(
      () => api.classifySpendOutcome({ result: { hash: TRANSFER }, before, after: before }),
      'spend-unjournaled'
    );
    expectRefusal(
      () =>
        api.classifySpendOutcome({
          result: { hash: UNSHIELD },
          before,
          after: journal([transferRecord(null)]),
        }),
      'spend-hash'
    );
    expectRefusal(
      () =>
        api.classifySpendOutcome({
          result: {},
          before,
          after: journal([transferRecord(null), unshieldRecord()]),
        }),
      'spend-multiple'
    );
  });
  test('observation of the unshield needs the matched transfer and no other open record', () => {
    const open = journal([transferRecord(), unshieldRecord()]);
    expect(api.selectObservedRecord(open, 'unshield', chain, null).hash).toBe(UNSHIELD);
    expectRefusal(
      () => api.selectObservedRecord(open, 'unshield', { transfer: { hash: UNSHIELD } }, null),
      'transfer-unresolved'
    );
    expectRefusal(
      () =>
        api.selectObservedRecord(
          journal([transferRecord(), unshieldRecord(), { ...shieldRecord(), resolution: null }]),
          'unshield',
          chain,
          UNSHIELD
        ),
      'journal-unresolved'
    );
    expectRefusal(() => api.selectObservedRecord(open, 'transfer', chain, TRANSFER), 'journal');
  });
});

const sourceMap = {
  'src/main/wallet/a.js': sha('01'),
  'scripts/qualify-railgun-live.js': sha('02'),
};
describe('sources and runtime', () => {
  test('source names are the sorted union of listing, fixed list, scan and predecessor', () => {
    const names = api.journeySourceNames({
      listed: ['src/main/wallet/b.js'],
      scan: { sourceSha256: sourceMap },
      previous: { sourceSha256: { 'docs/qualification/x.json': sha('03') } },
    });
    expect(names).toEqual([...names].sort());
    for (const name of [
      'src/main/wallet/b.js',
      'src/main/wallet/a.js',
      'docs/qualification/x.json',
      'src/main/wallet/railgun-private-destination.js',
      'scripts/qualify-railgun-private-live.js',
    ])
      expect(names).toContain(name);
    for (const bad of ['../outside.js', '/abs/file.js', 'a/../../b.js'])
      expectRefusal(
        () => api.journeySourceNames({ listed: [bad], scan: undefined, previous: undefined }),
        'sources'
      );
  });
  test('any changed, added or missing source refuses', () => {
    expect(api.changedSources(sourceMap, { ...sourceMap })).toEqual([]);
    expect(
      api.changedSources(sourceMap, { ...sourceMap, 'src/main/wallet/a.js': sha('09') })
    ).toEqual(['src/main/wallet/a.js']);
    expectRefusal(
      () =>
        api.assertSourcesMatch(sourceMap, { 'src/main/wallet/a.js': sha('01') }, 'scan-sources'),
      'scan-sources'
    );
    expect(() => api.assertSameSources(sourceMap, { ...sourceMap })).not.toThrow();
    expectRefusal(
      () => api.assertSameSources(sourceMap, { ...sourceMap, 'src/main/wallet/new.js': sha('04') }),
      'sources'
    );
    expectRefusal(
      () => api.assertSameSources(sourceMap, { ...sourceMap, 'src/main/wallet/a.js': sha('05') }),
      'sources'
    );
  });
  test('runtime archives and artifacts must be unchanged across modes', () => {
    const runtime = {
      engineSha256: sha('e0'),
      proverSha256: sha('f0'),
      artifactSha256: { '01x01.zkey': sha('11') },
    };
    expect(() => api.assertSameRuntime(runtime, JSON.parse(JSON.stringify(runtime)))).not.toThrow();
    expectRefusal(
      () => api.assertSameRuntime(runtime, { ...runtime, proverSha256: sha('f1') }),
      'runtime'
    );
    expectRefusal(
      () =>
        api.assertSameRuntime(runtime, {
          ...runtime,
          artifactSha256: { ...runtime.artifactSha256, 'POI_3x3.zkey': sha('12') },
        }),
      'runtime'
    );
    expectRefusal(() => api.assertSameRuntime(undefined, runtime), 'runtime');
  });
});

const scanReport = (number = 200, extra = {}) => ({
  passed: true,
  completed: true,
  chainId: 11155111,
  anchor: { number, hash: hash('ac') },
  txid: { independentEventCoverage: true },
  wallet: { assetCount: 1 },
  sourceSha256: sourceMap,
  ...extra,
});
const ownedPoiReport = (extra = {}) => ({
  observedAt: '2026-10-06T21:46:00.000Z',
  chainId: 11155111,
  sourceSha256: sourceMap,
  scanReportSha256: SCAN_SHA,
  circuitIsolationQualified: false,
  submissions: 0,
  spendingEnabled: false,
  passed: true,
  shieldTransactionHash: SHIELD,
  finalizedShieldMatched: true,
  walletRecoveredExpectedShield: true,
  poi: {
    allValid: true,
    selectedCount: 1,
    listKey: api.REQUIRED_LIST,
    statuses: ['Valid'],
    rootsAccepted: true,
    membershipVerified: true,
    ownershipAtSnapshot: true,
    txidProvenanceVerified: false,
    reservationsChecked: false,
    spendingEnabled: false,
  },
  ...extra,
});
const journeyReport = (mode, extra = {}) => ({
  journey: api.JOURNEY,
  version: 1,
  mode,
  chainId: 11155111,
  owner: OWNER,
  passed: true,
  scan: { sha256: SCAN_SHA, anchor: { number: 90, hash: hash('ac') } },
  chain: {
    ownedPoiReportSha256: D1_SHA,
    shieldTransactionHash: SHIELD,
    transfer: null,
    unshield: null,
  },
  ...extra,
});
const afterTransfer = (mode, extra = {}) =>
  journeyReport(mode, {
    scan: { sha256: NEWER_SCAN_SHA, anchor: { number: 200, hash: hash('ac') } },
    chain: {
      ownedPoiReportSha256: D1_SHA,
      shieldTransactionHash: SHIELD,
      transfer: { hash: TRANSFER, blockNumber: 100 },
      unshield: null,
    },
    ...extra,
  });

describe('scan and owned-POI predecessor reports', () => {
  test('the scan must be completed, source-pinned and cover TXID events', () => {
    expect(() => api.assertScanReport(scanReport())).not.toThrow();
    for (const [extra, step] of [
      [{ passed: false }, 'scan'],
      [{ completed: false }, 'scan'],
      [{ chainId: 1 }, 'scan'],
      [{ txid: { independentEventCoverage: false } }, 'scan-txid'],
      [{ wallet: { assetCount: 2 } }, 'scan-wallet'],
      [{ anchor: { number: 1, hash: '0x12' } }, 'scan-anchor'],
      [{ sourceSha256: {} }, 'scan'],
    ])
      expectRefusal(() => api.assertScanReport(scanReport(200, extra)), step);
  });
  test('check-transfer requires the Valid owned-POI report bound to this scan', () => {
    expect(() =>
      api.assertPredecessor('check-transfer', ownedPoiReport(), { scanSha: SCAN_SHA })
    ).not.toThrow();
    for (const [report, step] of [
      [ownedPoiReport({ scanReportSha256: NEWER_SCAN_SHA }), 'predecessor-scan'],
      [ownedPoiReport({ passed: false }), 'predecessor'],
      [ownedPoiReport({ submissions: 1 }), 'predecessor'],
      [ownedPoiReport({ journey: api.JOURNEY }), 'predecessor'],
      [
        ownedPoiReport({ poi: { ...ownedPoiReport().poi, statuses: ['Missing'] } }),
        'predecessor-poi',
      ],
      [ownedPoiReport({ poi: { ...ownedPoiReport().poi, listKey: sha('00') } }), 'predecessor-poi'],
      [
        ownedPoiReport({ poi: { ...ownedPoiReport().poi, rootsAccepted: false } }),
        'predecessor-poi',
      ],
    ])
      expectRefusal(
        () => api.assertPredecessor('check-transfer', report, { scanSha: SCAN_SHA }),
        step
      );
  });
});

describe('mode order', () => {
  const pass = (mode, previous, scanSha = SCAN_SHA, scan = scanReport(90)) =>
    expect(() => api.assertPredecessor(mode, previous, { scanSha, scan })).not.toThrow();
  const fail = (mode, previous, step, scanSha = SCAN_SHA, scan = scanReport(90)) =>
    expectRefusal(() => api.assertPredecessor(mode, previous, { scanSha, scan }), step);
  const newer = [NEWER_SCAN_SHA, scanReport(200)];

  test('transfer follows a passed check on the same scan', () => {
    pass('transfer', journeyReport('check-transfer'));
    fail('transfer', journeyReport('check-transfer', { passed: false }), 'predecessor');
    fail('transfer', journeyReport('check-transfer'), 'predecessor-scan', NEWER_SCAN_SHA);
    fail('transfer', journeyReport('observe'), 'predecessor');
    fail('transfer', ownedPoiReport(), 'predecessor');
  });
  test('observe follows a journaled spend, a lost spend report, or an open observation', () => {
    const spent = { journaled: true, journaledHash: TRANSFER, submissionStatus: 'unknown' };
    pass('observe', journeyReport('transfer', { passed: false, spend: spent }));
    fail(
      'observe',
      journeyReport('transfer', { spend: { journaled: false, submissionStatus: 'not-sent' } }),
      'predecessor'
    );
    fail(
      'observe',
      journeyReport('transfer', { spend: { ...spent, journaled: null } }),
      'predecessor'
    );
    pass('observe', journeyReport('check-transfer'));
    pass(
      'observe',
      journeyReport('observe', { target: 'transfer', observedHash: TRANSFER, resolved: null })
    );
    fail(
      'observe',
      journeyReport('observe', {
        target: 'transfer',
        observedHash: TRANSFER,
        resolved: { outcome: 'matched' },
      }),
      'predecessor-resolved'
    );
    fail(
      'observe',
      journeyReport('transfer', { spend: spent }),
      'predecessor-scan',
      NEWER_SCAN_SHA
    );
  });
  test('the POI submission follows the finalized matched transfer and a newer covering scan', () => {
    const observed = (extra = {}) =>
      journeyReport('observe', {
        target: 'transfer',
        observedHash: TRANSFER,
        resolved: { outcome: 'matched' },
        transact: { operation: 'railgun-private-transfer', outputKind: 'shielded' },
        chain: {
          ownedPoiReportSha256: D1_SHA,
          shieldTransactionHash: SHIELD,
          transfer: { hash: TRANSFER, blockNumber: 100 },
          unshield: null,
        },
        ...extra,
      });
    pass('poi-submit', observed(), ...newer);
    fail('poi-submit', observed({ resolved: null }), 'predecessor-unresolved', ...newer);
    fail(
      'poi-submit',
      observed({ resolved: { outcome: 'reverted' } }),
      'predecessor-unresolved',
      ...newer
    );
    fail('poi-submit', observed({ target: 'unshield' }), 'predecessor', ...newer);
    fail('poi-submit', observed(), 'predecessor-scan', NEWER_SCAN_SHA, scanReport(99));
    fail('poi-submit', observed(), 'predecessor-scan', NEWER_SCAN_SHA, scanReport(80));
  });
  test('recover, status and the unshield follow their exact predecessors', () => {
    const attempt = { attempted: true, attemptCompleted: true };
    pass('recover', afterTransfer('poi-submit', { poiSubmission: attempt }), ...newer);
    // An undelivered response still continues to the read-only acceptance gate.
    pass(
      'recover',
      afterTransfer('poi-submit', { passed: false, poiSubmission: attempt }),
      ...newer
    );
    fail(
      'recover',
      afterTransfer('poi-submit', { poiSubmission: { ...attempt, attempted: false } }),
      'predecessor',
      ...newer
    );
    fail(
      'recover',
      afterTransfer('poi-submit', { poiSubmission: { ...attempt, attemptCompleted: false } }),
      'predecessor',
      ...newer
    );
    fail('recover', afterTransfer('status', { poiSubmission: attempt }), 'predecessor', ...newer);
    pass('status', afterTransfer('recover', { recovered: { outputRecovered: true } }), ...newer);
    pass(
      'status',
      afterTransfer('status', { poi: { allValid: false, statuses: ['Missing'] } }),
      ...newer
    );
    fail(
      'status',
      afterTransfer('status', { poi: { allValid: true } }),
      'predecessor-valid',
      ...newer
    );
    const valid = {
      allValid: true,
      statuses: ['Valid'],
      rootsAccepted: true,
      membershipVerified: true,
      listKey: api.REQUIRED_LIST,
    };
    pass('check-unshield', afterTransfer('status', { poi: valid }), ...newer);
    for (const poi of [
      { ...valid, allValid: false },
      { ...valid, statuses: ['ProofSubmitted'] },
      { ...valid, rootsAccepted: false },
      { ...valid, membershipVerified: false },
      { ...valid, listKey: sha('00') },
    ])
      fail('check-unshield', afterTransfer('status', { poi }), 'predecessor-poi', ...newer);
    const checked = (outputPoi, extra = {}) => {
      const report = afterTransfer('check-unshield', extra);
      report.chain.outputPoi = outputPoi;
      return report;
    };
    const bound = { reportSha256: sha('5a'), ...valid };
    pass('unshield', checked(bound), ...newer);
    fail('unshield', afterTransfer('check-unshield'), 'predecessor-poi', ...newer);
    fail('unshield', checked({ ...valid }), 'predecessor-poi', ...newer);
    fail('unshield', checked({ ...bound, statuses: ['Missing'] }), 'predecessor-poi', ...newer);
    fail('unshield', checked({ ...bound, membershipVerified: false }), 'predecessor-poi', ...newer);
    fail('unshield', afterTransfer('status', { poi: valid }), 'predecessor', ...newer);
    fail('unshield', checked(bound, { passed: false }), 'predecessor', ...newer);
    fail(
      'unshield',
      checked(bound),
      'predecessor-scan',
      NEWER_SCAN_SHA,
      scanReport(150, { anchor: { number: 99, hash: hash('ac') } })
    );
  });
  test('a journey report from another chain, owner shape or version is refused', () => {
    for (const extra of [
      { chainId: 1 },
      { version: 2 },
      { owner: 'not-an-address' },
      { journey: 'other' },
    ])
      fail('transfer', journeyReport('check-transfer', extra), 'predecessor');
  });
  test('the chain is carried forward as a copy and binds the Valid status report', () => {
    const previous = afterTransfer('status', {
      poi: {
        allValid: true,
        statuses: ['Valid'],
        rootsAccepted: true,
        membershipVerified: true,
        listKey: api.REQUIRED_LIST,
        elapsedMs: 3,
      },
    });
    const next = api.nextChain('check-unshield', previous, sha('99'));
    expect(next).toEqual({
      ...previous.chain,
      outputPoi: {
        reportSha256: sha('99'),
        allValid: true,
        statuses: ['Valid'],
        rootsAccepted: true,
        membershipVerified: true,
        listKey: api.REQUIRED_LIST,
      },
    });
    expect(next.transfer).not.toBe(previous.chain.transfer);
    expect(api.nextChain('unshield', { chain: next }, sha('98'))).toEqual(next);
    expect(api.nextChain('check-transfer', ownedPoiReport(), D1_SHA)).toEqual({
      ownedPoiReportSha256: D1_SHA,
      shieldTransactionHash: SHIELD,
      transfer: null,
      unshield: null,
    });
  });
});

describe('aggregate reports', () => {
  test('observation and transact summaries keep public facts only', () => {
    const record = {
      state: 'submitted',
      hash: TRANSFER,
      intent: { nullifier: hash('01'), commitment: hash('02'), intentDigest: sha('03') },
      observation: {
        status: 'included',
        blockNumber: '0xb4a2ee',
        blockHash: hash('0b'),
        confirmations: 14,
      },
    };
    expect(api.summarizeObservation(record)).toEqual({
      journalState: 'submitted',
      status: 'included',
      blockNumber: 11838190,
      blockHash: hash('0b'),
      confirmations: 14,
    });
    const transact = {
      status: 'matched',
      operation: 'railgun-token-unshield',
      nullifier: hash('01'),
      commitment: hash('02'),
      boundParamsHash: hash('03'),
      intentDigest: sha('04'),
      output: {
        kind: 'unshield',
        logIndex: '0x1',
        recipient: OWNER,
        amount: '997500000000000',
        received: '995006250000000',
        fee: '2493750000000',
        feeDeviation: false,
      },
      trust: 'unverified-rpc',
    };
    const summary = api.summarizeTransact(transact);
    expect(JSON.stringify(summary)).not.toMatch(/nullifier|commitment|boundParams|intentDigest/);
    expect(summary.unshield).toEqual({
      recipient: OWNER,
      amount: '997500000000000',
      received: '995006250000000',
      fee: '2493750000000',
      feeDeviation: false,
    });
    expect(
      api.summarizeTransact({
        ...transact,
        operation: 'railgun-private-transfer',
        output: { kind: 'shielded', tree: 0, position: 1 },
      })
    ).toEqual({
      status: 'matched',
      operation: 'railgun-private-transfer',
      outputKind: 'shielded',
      trust: 'unverified-rpc',
    });
  });
  test('resolution, receipt gas, POI status and POI response summaries', () => {
    expect(
      api.summarizeResolution({
        resolution: {
          minimumConfirmations: 12,
          railgun: {
            outcome: 'matched',
            finalizedBlockNumber: 120,
            finalizedBlockHash: hash('fb'),
            transact: { nullifier: hash('01') },
          },
        },
      })
    ).toEqual({
      outcome: 'matched',
      finalizedBlockNumber: 120,
      finalizedBlockHash: hash('fb'),
      minimumConfirmations: 12,
    });
    expect(api.summarizeResolution({})).toBeNull();
    expect(
      api.summarizeReceiptGas({
        gasUsed: '0xf4240',
        effectiveGasPrice: '0x3b9aca00',
        status: '0x1',
      })
    ).toEqual({
      gasUsed: '1000000',
      effectiveGasPrice: '1000000000',
      feePaidWei: '1000000000000000',
      receiptStatus: 'success',
    });
    expectRefusal(
      () => api.summarizeReceiptGas({ gasUsed: '0x0', effectiveGasPrice: '0x1' }),
      'receipt'
    );
    const poi = api.summarizeOwnedPoi(
      {
        listKey: api.REQUIRED_LIST,
        statuses: [{ blindedCommitment: hash('bc'), type: 'Transact', status: 'Valid' }],
        rootsAccepted: true,
        membershipVerified: true,
        ownershipAtSnapshot: true,
        proofs: [{ leaf: 'secret' }],
        events: [{}],
        txidProvenanceVerified: false,
        reservationsChecked: false,
        spendingEnabled: false,
      },
      12
    );
    expect(poi).toMatchObject({ allValid: true, statuses: ['Valid'], selectedCount: 1 });
    expect(JSON.stringify(poi)).not.toMatch(/blindedCommitment|proofs|events|secret/);
    expect(
      api.summarizeOwnedPoi(
        {
          listKey: api.REQUIRED_LIST,
          statuses: [{ status: 'ProofSubmitted' }],
          rootsAccepted: false,
          membershipVerified: false,
        },
        1
      ).allValid
    ).toBe(false);
    expect(
      api.summarizePoiResponse({
        classification: 'rpc-result',
        httpStatus: 200,
        responseBytes: 40,
        matchingEnvelope: true,
        acceptanceVerified: false,
        body: 'x',
      })
    ).toEqual({
      classification: 'rpc-result',
      httpStatus: 200,
      responseBytes: 40,
      matchingEnvelope: true,
      transportAuthenticated: false,
      acceptanceVerified: false,
    });
  });
  test('failures keep codes, steps and public hashes, never messages', () => {
    const error = Object.assign(new Error('secret ' + hash('01')), {
      code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
      step: 'fee-cap',
      transactionHash: TRANSFER,
    });
    expect(api.sanitizeFailure('fee-cap', error)).toEqual({
      stage: 'fee-cap',
      code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
      step: 'fee-cap',
      transactionHash: TRANSFER,
      reconciliationRequired: true,
    });
    expect(api.sanitizeFailure('prove', new TypeError('x'))).toEqual({
      stage: 'prove',
      code: 'TypeError',
    });
  });
  const fullReport = () => ({
    journey: api.JOURNEY,
    version: 1,
    mode: 'transfer',
    observedAt: '2026-10-07T00:00:00.000Z',
    owner: OWNER,
    previous: { sha256: sha('bb'), mode: 'check-transfer' },
    scan: { sha256: SCAN_SHA, anchor: { number: 90, hash: hash('ac') } },
    chain: {
      ownedPoiReportSha256: D1_SHA,
      shieldTransactionHash: SHIELD,
      transfer: { hash: TRANSFER, blockNumber: 100 },
      unshield: { hash: UNSHIELD, amount: '997500000000000' },
      outputPoi: { reportSha256: sha('5a'), statuses: ['Valid'], listKey: api.REQUIRED_LIST },
    },
    sourceSha256: sourceMap,
    runtime: {
      engineSha256: sha('e0'),
      proverSha256: sha('f0'),
      artifactSha256: { '01x01.zkey': sha('11') },
    },
    tor: { version: 'arti 2.6.0', binarySha256: sha('a7'), rpc: api.RPC_URL },
    limits: { feeCapWei: '2000000000000000', maxQualificationAmount: '10000000000000000' },
    poi: { listKey: api.REQUIRED_LIST, statuses: ['Valid'] },
    observation: { blockHash: hash('0b'), blockNumber: 1 },
    resolved: { finalizedBlockHash: hash('fb') },
    spend: { journaledHash: TRANSFER, submissionStatus: 'acknowledged' },
    submission: {
      status: 'refused',
      stage: 'preflight',
      diagnostic: {
        stage: 'preflight',
        substage: 'acquire',
        code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
        reason: 'rpc',
        step: 'deployment',
        deploymentStep: 'getter-tokenBlocklist',
        causeCode: 'PRIVATE_RPC_INVALID',
      },
      reviews: 0,
      elapsedMs: 2410,
    },
    recovered: { walletThrough: { number: 1, hash: hash('ac') } },
    passed: true,
  });
  test('a complete aggregate report passes redaction unchanged', () => {
    const report = fullReport();
    expect(api.assertAggregateReport(report)).toBe(true);
    expect(JSON.parse(api.renderReport(report))).toEqual(report);
  });
  test.each([
    ['a nullifier key', (r) => (r.spend.nullifier = hash('01'))],
    ['a payload key', (r) => (r.poi.payload = {})],
    ['a selector key', (r) => (r.selector = {})],
    ['proved calldata', (r) => (r.spend.data = '0x1234')],
    ['an unlisted 32-byte value', (r) => (r.spend.other = hash('01'))],
    ['an embedded 32-byte value', (r) => (r.failure = { detail: 'x ' + hash('01') })],
    ['a long hex blob', (r) => (r.spend.journaledHash = '0x' + 'ab'.repeat(40))],
    ['a Railgun address', (r) => (r.spend.recipient = '0zk1' + 'q'.repeat(100))],
    ['a bare 32-byte value outside sha256 keys', (r) => (r.spend.other = sha('01'))],
    ['an uppercase public hash', (r) => (r.spend.journaledHash = '0x' + 'AB'.repeat(32))],
    ['a bigint', (r) => (r.spend.fee = 1n)],
    ['a diagnostic nullifier', (r) => (r.submission.diagnostic.nullifier = hash('01'))],
    ['a diagnostic payload', (r) => (r.submission.diagnostic.data = '0x1234')],
  ])('refuses %s and writes a minimal failure instead', (_name, change) => {
    const report = fullReport();
    change(report);
    expect(() => api.assertAggregateReport(report)).toThrow();
    expect(JSON.parse(api.renderReport(report))).toEqual({
      journey: api.JOURNEY,
      version: 1,
      mode: 'transfer',
      passed: false,
      failure: { stage: 'report-redaction', code: 'RAILGUN_LIVE_JOURNEY_REFUSED' },
    });
  });
});

// ---------------------------------------------------------------------------
// Live wiring with injected fakes. Every production module reaches the steps
// through ctx.load, so these tests drive spend() and the mode runners whole.
// ---------------------------------------------------------------------------
const pins = require('../src/main/wallet/railgun-shield-pins.json');
const INSTANCE = '0zk1' + 'q'.repeat(60);
const AMOUNT = 997500000000000n;
const ANCHOR = { number: 200, hash: hash('ac') };
const settledTransfer = (resolution = { railgun: { outcome: 'matched' } }) => ({
  hash: TRANSFER,
  state: 'submitted',
  intent: {
    kind: 'railgun-transact',
    operation: 'railgun-private-transfer',
    tree: 0,
    nullifier: 'private-nullifier',
    intentDigest: 'private-digest',
  },
  ...(resolution ? { resolution } : {}),
});
function world({
  step = 'transfer',
  gasPrice = 1000000000n,
  reviewGasPrice = gasPrice,
  estimate = 1000000n,
  records,
  submit = 'ack',
  reviewCalls = 1,
  prove = 'proved',
  classification = 'rpc-result',
  poiStore = [],
  diagnostic,
} = {}) {
  const calls = {
    timeline: [],
    prove: [],
    submit: [],
    reviews: [],
    staging: [],
    poiReviews: [],
    diagnosticReads: [],
  };
  const diagnostics = new WeakMap();
  const log = (event) => calls.timeline.push(event);
  const afterTransfer = step !== 'transfer';
  const journal = {
    records: records ?? (afterTransfer ? [settledTransfer()] : []),
    archive: [shieldRecord()],
  };
  const weth = { __type: 'erc20', contract: pins.wrappedNative };
  const notes = [
    {
      id: '0:1',
      txid: SHIELD,
      spentTxid: afterTransfer ? hash('99') : false,
      asset: weth,
      amount: AMOUNT,
    },
    ...(afterTransfer
      ? [{ id: '0:2', txid: TRANSFER, spentTxid: false, asset: weth, amount: AMOUNT }]
      : []),
  ];
  const ownedPoi = [
    { id: '0:1', type: 'Shield', txid: SHIELD },
    ...(afterTransfer ? [{ id: '0:2', type: 'Transact', txid: TRANSFER }] : []),
  ];
  const owned = () => ({
    checkpointHash: 'checkpoint',
    read: { readiness: { to: ANCHOR }, instanceId: INSTANCE, received: notes },
    ownedPoi,
    trees: [],
  });
  const wallet = { view: {}, close: async () => log('wallet-close') };
  const identity = { descriptor: { instanceId: INSTANCE }, close: () => log('identity-close') };
  let stored;
  const storeEntries = poiStore.map((entry) => ({ ...entry }));
  const store = {
    list: async () => storeEntries.map((entry) => ({ ...entry })),
    prepare: async () => {
      storeEntries.push({ capsuleDigest: sha('cd'), state: 'prepared' });
      return { status: 'prepared' };
    },
    close() {},
    closed: Promise.resolve(),
  };
  const enrollment = {
    signal: new AbortController().signal,
    getContext: () => ({ role: 'engine' }),
    openPrivateCapsules: async () => ({ get: async () => stored }),
    openPrivateRecoveryStores: async () => ({
      reservations: {
        withSigningRecovery: async (use) =>
          use(
            [
              {
                entry: {
                  facts: {
                    intentDigest: 'private-digest',
                    nullifier: 'private-nullifier',
                    tree: 0,
                    position: 1,
                    noteHash: 'private-note-hash',
                  },
                  signing: { submitter: OWNER },
                },
              },
            ],
            { assertCurrent() {} }
          ),
      },
    }),
    openPoiIntents: async () => store,
    close: () => log('enrollment-close'),
  };
  const publicAccount = {
    generationId: 'generation',
    policy: 'policy',
    coordinator: {
      recover: async () => ({ to: { ...ANCHOR } }),
      withPublicSnapshot: async () => ({ evidence: {} }),
      assertSnapshot: () => ({ state: { storeId: 'store', trees: [] } }),
    },
    close: async () => log('public-close'),
  };
  const network = {
    request: async (_chainId, method) => {
      log(method);
      const results = {
        eth_getCode: '0x',
        eth_getBalance: '0xde0b6b3a7640000',
        eth_getTransactionCount: '0x3',
        eth_estimateGas: '0x' + estimate.toString(16),
      };
      return { result: results[method] };
    },
    getFeeQuote: async () => {
      log('eth_gasPrice');
      return { type: 'legacy', gasPrice: gasPrice.toString() };
    },
  };
  const rpcOrigin = new URL(api.RPC_URL).origin;
  const modules = {
    'wallet/railgun-identity': {
      openRailgunIdentity: async () => {
        log('identity-open');
        return identity;
      },
    },
    'wallet/railgun-account-enrollment': { openRailgunAccountEnrollment: async () => enrollment },
    'wallet/railgun-account-public': { openRailgunAccountPublic: async () => publicAccount },
    'wallet/railgun-account-wallet': {
      openRailgunAccountWallet: async () => wallet,
      readRailgunAccountOwnedNotes: () => owned(),
      prepareRailgunAccountPrivateIntent: async (_wallet, _owners, request) => {
        wallet.view = {};
        return {
          view: wallet.view,
          preparation: {
            amount: AMOUNT.toString(),
            recipient: request.recipient,
            witnessRetained: false,
            spendingEnabled: false,
            transaction: {},
            expected: {},
            transactionDigest: 'digest',
          },
          readOnly: { readOnly: true, writeAttempts: 0 },
        };
      },
    },
    'wallet/railgun-private-receive': {
      verifyRailgunPrivateReceiver: async () => ({
        recipientVerified: true,
        transactionDigest: 'digest',
        spendingEnabled: false,
      }),
    },
    'networks/privacy-context': {
      getPrivacyContext: () => ({
        profileId: 'profile',
        subject: { kind: 'private-account', role: 'engine', operation: 'x' },
      }),
      createPrivacyScope: () => ({ getContext: (subject) => subject, close() {} }),
    },
    'networks/private-rpc': {
      createPrivateRpc: () => ({ release() {} }),
      getPrivateRpcDestination: () => ({}),
      getPrivateRpcDestinationDetails: () => ({ url: api.RPC_URL }),
      createPrivateRpcDestinationConstraint: () => ({ constraint: {}, close() {} }),
    },
    'wallet/railgun-transact-staging': {
      stageRailgunTransactInput: async (options) => {
        calls.staging.push(options);
        return { status: 'staged', account: wallet, receipt: { staged: true }, close() {} };
      },
    },
    'wallet/railgun-private-operation': {
      proveRailgunAccountPrivateOperation: async (options) => {
        log('prove');
        calls.prove.push(options);
        stored = {
          capsule: {
            selection: { kind: options.request.kind, recipient: options.request.recipient },
          },
          provedTransaction: { to: pins.proxy, data: '0xdead' },
        };
        if (prove === 'refused') return { status: 'refused', stage: 'poi' };
        if (prove === 'signed-unfinished')
          return { status: 'signed-unfinished', stage: 'proof', holdId: sha('77') };
        return { status: 'proved', holdId: sha('77'), completion: { receipt: {}, close() {} } };
      },
    },
    // Mirrors production: review before signing, journal before the send.
    'wallet/railgun-private-submission': {
      submitRailgunPrivateTransaction: async (options) => {
        log('submit');
        calls.submit.push(options);
        if (submit === 'preflight') {
          // Production refuses at its preflight before any review or journal write.
          const refusal = Object.freeze({ status: 'recovery-required', stage: 'preflight' });
          diagnostics.set(refusal, diagnostic);
          return refusal;
        }
        const kind = stored.capsule.selection.kind;
        const request = {
          transaction: {
            to: pins.proxy,
            value: '0',
            data: '0xdead',
            chainId: 11155111,
            gasLimit: options.gasLimit.toString(),
            gasPrice: reviewGasPrice.toString(),
            nonce: 3,
          },
          from: OWNER,
          operation: kind,
          intent:
            kind === 'railgun-token-unshield'
              ? { recipient: OWNER, amount: AMOUNT.toString() }
              : {},
          maxGasFee: options.maxGasFee,
          fundingAddressPublic: true,
        };
        for (let n = 0; n < reviewCalls; n++) {
          let approved;
          try {
            approved = await options.review(request);
          } catch (error) {
            approved = error;
          }
          calls.reviews.push(approved);
          if (approved !== true) return { status: 'recovery-required', stage: 'submission' };
        }
        const sent = kind === 'railgun-token-unshield' ? UNSHIELD : TRANSFER;
        if (submit !== 'refused')
          journal.records.push({
            hash: sent,
            state: submit === 'ack' ? 'submitted' : 'attempted',
            intent: { kind: 'railgun-transact', operation: kind },
          });
        if (submit === 'ack') return { hash: sent };
        if (submit === 'lost') return { transactionHash: sent, submissionStatus: 'unknown' };
        return { status: 'recovery-required', stage: 'submission' };
      },
      getRailgunPrivateSubmissionDiagnostic: (result) => {
        calls.diagnosticReads.push(result);
        if (diagnostic === 'throws') throw Error('secret diagnostic read ' + hash('01'));
        return diagnostics.get(result) ?? null;
      },
    },
    'wallet/railgun-own-operation': {
      captureRailgunOwnOperation: async ({ selector }) => {
        calls.selector = selector;
        return {
          status: 'captured',
          capture: {
            capsule: { selection: { kind: 'railgun-private-transfer' } },
            capsuleDigest: sha('cd'),
          },
        };
      },
    },
    'wallet/railgun-own-poi-membership': {
      openRailgunOwnPoiMembership: async () => {
        log('membership');
        return { status: 'verified', receipt: {}, close() {}, closed: Promise.resolve() };
      },
    },
    'wallet/railgun-own-poi-proof': {
      proveRailgunOwnPoi: async () => {
        log('own-poi-proof');
        return {
          status: 'proved',
          separatelyVerified: true,
          payload: { blindedCommitmentsOut: ['x'] },
        };
      },
    },
    'wallet/railgun-poi-disclosure-plan': {
      prepareRailgunPoiDisclosurePlan: async () => ({
        status: 'prepared',
        plan: {},
        summary: {
          operation: 'transfer',
          outputCount: 1,
          listKey: api.REQUIRED_LIST,
          endpoint: api.POI_ORIGIN,
          requestInventory: [{ method: 'ppoi_submit_transact_proof', count: 1 }],
          disclosureCategories: ['blinded-output-commitment'],
        },
        close() {},
        closed: Promise.resolve(),
      }),
      submitRailgunRetainedPoi: async ({ review }) => {
        log('poi-submit');
        const base = {
          operation: 'transfer',
          outputCount: 1,
          listKey: api.REQUIRED_LIST,
          chainId: 11155111,
          unshieldIdCategory: 'absent',
        };
        for (const [purpose, destinations] of [
          [
            'validate-retained-poi',
            [
              { role: 'source-rpc', origin: rpcOrigin },
              { role: 'receipt-rpc', origin: rpcOrigin },
              { role: 'poi-service', origin: api.POI_ORIGIN },
            ],
          ],
          ['submit-retained-poi', [{ role: 'poi-service', origin: api.POI_ORIGIN }]],
        ]) {
          let approved;
          try {
            approved = await review({ ...base, purpose, destinations });
          } catch (error) {
            approved = error;
          }
          calls.poiReviews.push(approved);
          if (approved !== true) return { status: 'refused', stage: 'review' };
        }
        storeEntries[0].state = 'attempted';
        return {
          status: 'recovery-required',
          stage: 'response',
          response: {
            classification,
            httpStatus: classification === 'unavailable' ? null : 200,
            responseBytes: 40,
            matchingEnvelope: ['rpc-result', 'rpc-error'].includes(classification),
            acceptanceVerified: false,
          },
        };
      },
    },
    'wallet/railgun-account-poi': {
      openRailgunAccountPoi: (options) => {
        calls.poiNotes = options.noteIds;
        return { acquire: async () => ({ receipt: {} }), close() {}, closed: Promise.resolve() };
      },
      assertRailgunAccountPoi: () => ({
        listKey: api.REQUIRED_LIST,
        statuses: [{ blindedCommitment: hash('bc'), type: 'Transact', status: 'Valid' }],
        rootsAccepted: true,
        membershipVerified: true,
        ownershipAtSnapshot: true,
      }),
    },
  };
  const ctx = {
    args: { archive: '/e', proverArchive: '/p', artifactDirectory: '/a' },
    report: { passed: false },
    stage: 'preconditions',
    scan: {
      generationId: 'generation',
      publicPolicy: 'policy',
      anchor: ANCHOR,
      publicState: { storeId: 'store', trees: [] },
      wallet: { to: ANCHOR },
    },
    previous: {},
    chain: {
      ownedPoiReportSha256: D1_SHA,
      shieldTransactionHash: SHIELD,
      transfer: afterTransfer ? { hash: TRANSFER, blockNumber: 100 } : null,
      unshield: null,
    },
    owner: OWNER,
    network,
    readJournal: async () => JSON.parse(JSON.stringify(journal)),
    load: (name) => {
      if (!modules[name]) throw Error('unexpected module ' + name);
      return modules[name];
    },
  };
  return { ctx, calls, journal };
}
// Waits on real macrotasks only, so it also works under fake timers.
const until = async (ready) => {
  for (let n = 0; n < 1000; n++) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('test gate not entered');
};
const settle = async (work) => {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
};
const between = (timeline, from, to) =>
  timeline.slice(timeline.indexOf(from) + 1, timeline.indexOf(to));

// Observation over the real journal rules and a fake transact recovery.
function observeWorld({
  target = 'transfer',
  confirmations = 14,
  finalized = 120,
  output,
  previousMode = target,
} = {}) {
  const calls = { resolve: [], network: [] };
  const sent = target === 'transfer' ? TRANSFER : UNSHIELD;
  const operation = target === 'transfer' ? 'railgun-private-transfer' : 'railgun-token-unshield';
  const journal = {
    records: [
      ...(target === 'unshield' ? [settledTransfer()] : []),
      { hash: sent, state: 'submitted', intent: { kind: 'railgun-transact', operation } },
    ],
    archive: [shieldRecord()],
  };
  const transactOutput =
    output ??
    (target === 'transfer'
      ? { kind: 'shielded', tree: 0, position: 2 }
      : { kind: 'unshield', recipient: OWNER, amount: AMOUNT.toString(), received: '1', fee: '1' });
  const recovery = {
    observe: async (txHash) => ({
      record: {
        hash: txHash,
        state: 'submitted',
        observation: { status: 'included', blockNumber: 100, blockHash: hash('0b'), confirmations },
      },
      transact: {
        status: 'matched',
        operation,
        nullifier: 'private-nullifier',
        output: transactOutput,
        trust: 'unverified-rpc',
      },
    }),
    resolve: async (txHash, options) => {
      calls.resolve.push(options.minimumConfirmations);
      const decision = await options.review({
        transact: { status: 'matched', operation, output: transactOutput },
      });
      const record = journal.records.find((value) => value.hash === txHash);
      record.resolution = {
        minimumConfirmations: options.minimumConfirmations,
        railgun: {
          outcome: 'matched',
          finalizedBlockNumber: finalized,
          finalizedBlockHash: hash('fb'),
        },
      };
      return decision;
    },
    list: async () => journal.records.filter((value) => value.intent?.kind === 'railgun-transact'),
    close() {},
  };
  const ctx = {
    report: { passed: false },
    stage: 'preconditions',
    owner: OWNER,
    previous: {
      mode: previousMode,
      spend: { journaled: true, journaledHash: sent },
      spendRequest: target === 'unshield' ? { amount: AMOUNT.toString() } : undefined,
    },
    chain: {
      shieldTransactionHash: SHIELD,
      transfer: target === 'unshield' ? { hash: TRANSFER, blockNumber: 100 } : { hash: TRANSFER },
      unshield: target === 'unshield' ? { hash: UNSHIELD, amount: AMOUNT.toString() } : null,
    },
    network: {
      request: async (_chainId, method) => {
        calls.network.push(method);
        if (method === 'eth_getTransactionReceipt')
          return { result: { gasUsed: '0xf4240', effectiveGasPrice: '0x3b9aca00', status: '0x1' } };
        if (method === 'eth_getBlockByNumber')
          return { result: { number: '0x' + finalized.toString(16) } };
        throw Error('unexpected method ' + method);
      },
    },
    readJournal: async () => JSON.parse(JSON.stringify(journal)),
    load: (name) => {
      if (name !== 'wallet/railgun-transact-recovery') throw Error('unexpected module ' + name);
      return { openRailgunTransactRecovery: () => recovery };
    },
  };
  return { ctx, calls, journal };
}

// Held-transfer recovery over the real journal and report rules, a fake signing
// recovery store and fake production preflight and recovered submission. The
// probe's refusal diagnostic is the real production helper.
const realSubmission = require('../src/main/wallet/railgun-private-submission');
const HELD_SHA = api.HELD_TRANSFER_REPORT_SHA256;
const PROBE_SHA = sha('9b');
const HOLD_ID = sha('4d');
const HOLD_ANCHOR = 11859803;
const NEW_ANCHOR = { number: 11860000, hash: hash('ac') };
const OLD_CHECKPOINT = sha('0c');
const NEW_CHECKPOINT = sha('1c');
const NULLIFIER = hash('31');
const MERKLE_ROOT = hash('32');
const CALLDATA = '0xc0ffee99';
const SECRETS = [HOLD_ID, NULLIFIER, MERKLE_ROOT, OLD_CHECKPOINT, NEW_CHECKPOINT, CALLDATA];
const copy = (value) => JSON.parse(JSON.stringify(value));
const withoutSecrets = (report) => {
  const text = JSON.stringify(report);
  return SECRETS.every((value) => !text.includes(value.replace(/^0x/, '')));
};
const heldPlan = {
  estimate: '1247366',
  gasLimit: '1559208',
  headroom: '5/4',
  quotedGasPrice: '1000015',
  quotedExposureWei: '1559231388120',
  capWei: '2000000000000000',
};
// The s3b report shape: proved, refused at preflight with no review, never journaled.
const heldReport = (extra = {}) =>
  journeyReport('transfer', {
    passed: false,
    scan: { sha256: SCAN_SHA, anchor: { number: HOLD_ANCHOR, hash: hash('ac') } },
    runtime: {
      engineSha256: sha('e0'),
      proverSha256: sha('f0'),
      artifactSha256: { '01x01.zkey': sha('11') },
    },
    spendRequest: { kind: 'railgun-private-transfer', recipient: 'self', fullInputValue: true },
    prove: { status: 'proved', holdCreated: true, elapsedMs: 1 },
    spend: {
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
      resendAllowed: false,
    },
    fee: { plan: { ...heldPlan } },
    submission: { status: 'refused', stage: 'preflight', reviews: 0, elapsedMs: 1 },
    liveness: {
      inputHeld: true,
      state: 'proved-unsent',
      continuation: 'separately-authorized-recovery',
      laterSpendRefusal: 'RAILGUN_PRIVATE_INPUT_RESERVED',
    },
    ...extra,
  });
const heldChain = (extra = {}) => ({
  ownedPoiReportSha256: D1_SHA,
  shieldTransactionHash: SHIELD,
  transfer: null,
  unshield: null,
  heldTransfer: { reportSha256: HELD_SHA, estimate: '1247366', gasLimit: '1559208' },
  ...extra,
});
const PROBE_AT = '2026-10-07T12:00:00.000Z';
const SCAN_AT = '2026-10-07T11:30:00.000Z';
const probeReport = (extra = {}) =>
  journeyReport('preflight-probe', {
    observedAt: PROBE_AT,
    result: 'preflight-passed',
    scan: { sha256: NEWER_SCAN_SHA, anchor: { ...NEW_ANCHOR } },
    chain: heldChain(),
    preflight: {
      attempted: true,
      acquireCalls: 1,
      retry: false,
      passed: true,
      diagnostic: null,
      nullifierQuery: 'queried',
    },
    immutables: { unchanged: true },
    ...extra,
  });
const newerScan = { scanSha: NEWER_SCAN_SHA, scan: scanReport(NEW_ANCHOR.number) };
// The held signing record and its capsule, as the production stores return them.
function heldState({ recipient = INSTANCE, foreign = false, signed = true } = {}) {
  const kind = 'railgun-private-transfer';
  return {
    entry: {
      id: HOLD_ID,
      state: 'signing',
      facts: {
        kind,
        tree: 0,
        position: 1,
        nullifier: NULLIFIER,
        noteHash: hash('33'),
        intentDigest: hash('34'),
        checkpointHash: OLD_CHECKPOINT,
        poiDigest: sha('35'),
      },
      signing: { submitter: OWNER, operationId: sha('36'), gatesDigest: sha('37') },
    },
    stored: {
      holdId: HOLD_ID,
      factsDigest: sha('38'),
      authorizationDigest: sha('39'),
      capsuleDigest: sha('3a'),
      capsule: {
        version: 1,
        walletId: sha('3b'),
        selection: {
          kind,
          tree: 0,
          position: 1,
          recipient,
          ...(foreign ? { recipientRelationship: 'foreign' } : {}),
        },
        preparation: {
          transaction: { chainId: 11155111, to: pins.proxy, value: '0x0', data: '0xcafe' },
          expected: {
            kind,
            tree: 0,
            merkleRoot: MERKLE_ROOT,
            nullifier: NULLIFIER,
            commitment: hash('3c'),
            boundParamsHash: hash('3d'),
          },
          amount: AMOUNT.toString(),
        },
        noteHash: hash('33'),
      },
      signingDigest: sha('3e'),
      signature: signed ? { R8: ['1', '2'], S: '3' } : null,
      provedTransaction: { to: pins.proxy, data: CALLDATA },
    },
  };
}
const recoverySummary = (extra = {}) => ({
  purpose: 'railgun-recovered-private-submission',
  chainId: 11155111,
  operation: 'railgun-private-transfer',
  submitter: OWNER,
  recipient: INSTANCE,
  selection: { noteId: '0:1', originalCheckpointHash: OLD_CHECKPOINT },
  destinations: {
    retainedSource: api.RPC_URL + '/retained',
    protocolRpc: api.RPC_URL,
    transactionRpc: api.RPC_URL,
    poi: api.POI_ORIGIN,
    txid: api.POI_ORIGIN,
  },
  exposures: copy(api.RECOVERY_EXPOSURES),
  requiredList: api.REQUIRED_LIST,
  inputCreatorDeterminedByCompletedWallet: true,
  originalSpendingSignatureReused: true,
  newSpendingSignature: false,
  eoaSigningAndBroadcast: true,
  simulationBeforeTransactionReview: true,
  automaticRetry: false,
  chainStateVerified: false,
  ...extra,
});
// Each recover-submit world gets a fresh canonical profile in its own temporary
// directory, so its recovery ledger starts absent unless a test shares the profile.
const LEDGER_ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'l-a-ledger-'));
afterAll(() => fs.rmSync(LEDGER_ROOT, { recursive: true, force: true }));
let profiles = 0;
const newProfile = () => {
  const profile = path.join(LEDGER_ROOT, `world-${++profiles}`, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  return profile;
};
const digest = (text) => createHash('sha256').update(text).digest('hex');
const QUALIFIER = 'scripts/qualify-railgun-private-live.js';
const COMMIT = 'd1727e0a'.repeat(5);
const SOURCES = {
  [QUALIFIER]: sha('5c'),
  'src/main/wallet/railgun-private-submission.js': sha('5d'),
};
// The real file system, with every ledger step on the world's timeline so tests
// can order the durable reservation against all other work. Hooks stand in for
// a concurrent winner, a swapped directory, an unreadable path or a short write.
function ledgerFs(log, { beforeCreate, beforeMkdir, lstat, write } = {}) {
  const kinds = new Map();
  return {
    lstatSync: (file) => (lstat ?? fs.lstatSync)(file),
    realpathSync: (file) => fs.realpathSync(file),
    readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
    readdirSync: (directory) => fs.readdirSync(directory),
    mkdirSync: (directory, options) => {
      beforeMkdir?.(directory);
      const created = fs.mkdirSync(directory, options);
      log('ledger-mkdir');
      return created;
    },
    openSync: (file, flags, mode) => {
      if (flags === 'wx') beforeCreate?.(file);
      const fd = fs.openSync(file, flags, mode);
      kinds.set(fd, flags);
      if (flags === 'wx') log('ledger-create');
      return fd;
    },
    writeSync: (fd, bytes) =>
      (write ?? ((_kind, ...rest) => fs.writeSync(...rest)))(kinds.get(fd), fd, bytes),
    fsyncSync: (fd) => {
      fs.fsyncSync(fd);
      log(
        {
          wx: 'ledger-pending-synced',
          a: 'ledger-finished-synced',
          r: 'ledger-directory-synced',
        }[kinds.get(fd)]
      );
    },
    closeSync: (fd) => {
      kinds.delete(fd);
      fs.closeSync(fd);
    },
  };
}
const ledgerLines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
// main()'s Electron, profile, vault and Tor owners as recorders that refuse: a run
// refused before them enters none. One recorder serves every run, because Jest
// keeps the first instance of a mocked module.
const MAIN_ENTERED = [];
const enter = (name) => () => {
  MAIN_ENTERED.push(name);
  throw Error(name + ' entered');
};
const MAIN_MOCKS = [
  [
    'electron',
    () => ({
      app: { isPackaged: false, whenReady: enter('app-ready'), exit: enter('app-exit') },
      safeStorage: {
        isEncryptionAvailable: enter('safe-storage'),
        decryptString: enter('decrypt'),
      },
    }),
  ],
  ['../src/main/profile-resolver', () => ({ initializeProfile: enter('profile') })],
  ['../src/main/profile-lock', () => ({ acquireProfileLock: enter('profile-lock') })],
  [
    '../src/main/identity/vault',
    () => ({ vaultExists: enter('vault'), unlockVault: enter('unlock'), lockVault: enter('lock') }),
  ],
  ['./qualify-ppv2-live', () => ({ openLiveTransport: enter('tor') })],
];
function heldWorld({
  mode = 'preflight-probe',
  records,
  signingRecords = 1,
  recipient,
  foreign,
  signed,
  checkpointHash = NEW_CHECKPOINT,
  checkpointTo = NEW_ANCHOR,
  preflight = 'pass',
  echoInput,
  during,
  spentTxid = false,
  ownedType = 'Shield',
  gasPrice = 1000015n,
  submit = 'ack',
  summary = {},
  reviewGasPrice = 1000015n,
  reviewTransaction = {},
  reviewCalls = 1,
  disclosureCalls = 1,
  diagnostic,
  alter,
  abortOnOpen = false,
  profile,
  probeSha = PROBE_SHA,
  ledger,
} = {}) {
  const calls = {
    timeline: [],
    loaded: [],
    network: [],
    preflights: [],
    acquires: 0,
    submit: [],
    disclosures: [],
    reviews: [],
    sign: 0,
    abandon: 0,
    recoveryTimeouts: [],
    recoveryControllers: [],
  };
  const log = (event) => calls.timeline.push(event);
  const journal = { records: records ?? [], archive: [shieldRecord()] };
  const state = {
    ...heldState({ recipient, foreign, signed }),
    journal,
    counts: {
      reservations: { held: 0, signing: signingRecords, abandoned: 0, legacy: 0 },
      capsules: { records: 1, signatures: 1, proofs: 1, capacity: 96 },
    },
  };
  alter?.(state);
  const reservations = {
    withSigningRecovery: async (use, options) => {
      log('recovery');
      calls.recoveryTimeouts.push(options.timeoutMs);
      const listed = Array.from({ length: signingRecords }, () => ({
        receipt: {},
        entry: copy(state.entry),
      }));
      // Like production, an ended phase aborts its signal and refuses assertCurrent.
      const phase = new AbortController();
      calls.recoveryControllers.push(phase);
      return use(listed, {
        signal: phase.signal,
        deadline: Infinity,
        assertCurrent() {
          if (phase.signal.aborted) throw Error('recovery phase ended');
        },
      });
    },
    assertReceiptContext() {},
    assertReceipt: async () => copy(state.entry),
    inspect: async () => ({ ...state.counts.reservations }),
    abandon: async () => calls.abandon++,
    abandonRecovered: async () => calls.abandon++,
  };
  const capsules = {
    readSigned: async () => copy(state.stored),
    inspect: async () => ({ ...state.counts.capsules }),
  };
  const enrollment = {
    signal: new AbortController().signal,
    getContext: () => ({ role: 'engine' }),
    openPrivateRecoveryStores: async () => {
      log('recovery-stores');
      return { reservations, capsules };
    },
    close: () => log('enrollment-close'),
  };
  const identity = { descriptor: { instanceId: INSTANCE }, close: () => log('identity-close') };
  const checkpoint = { to: { ...checkpointTo }, state: { storeId: 'store', trees: [] } };
  const publicAccount = {
    generationId: 'generation',
    policy: 'policy',
    coordinator: {
      recover: async () => ({ to: { ...NEW_ANCHOR } }),
      withPublicSnapshot: async () => ({ evidence: {} }),
      assertSnapshot: () => checkpoint,
    },
    close: async () => log('public-close'),
  };
  const destination = Object.freeze({ retained: true });
  const constraints = [];
  const weth = { __type: 'erc20', contract: pins.wrappedNative };
  const wallet = { view: {}, close: async () => log('wallet-close') };
  const network = {
    request: async (_chainId, method) => {
      calls.network.push(method);
      log(method);
      const results = {
        eth_getCode: '0x',
        eth_getBalance: '0xde0b6b3a7640000',
        eth_getTransactionCount: '0x3',
      };
      return { result: results[method] };
    },
    getFeeQuote: async () => {
      calls.network.push('eth_gasPrice');
      log('eth_gasPrice');
      return { type: 'legacy', gasPrice: gasPrice.toString() };
    },
  };
  const diagnostics = new WeakMap();
  const refusal = (stage, value) => {
    const result = Object.freeze({ status: 'recovery-required', stage });
    if (value) diagnostics.set(result, value);
    return result;
  };
  const modules = {
    'wallet/railgun-identity': {
      openRailgunIdentity: async () => {
        log('identity-open');
        return identity;
      },
    },
    'wallet/railgun-account-enrollment': { openRailgunAccountEnrollment: async () => enrollment },
    'wallet/railgun-account-public': {
      openRailgunAccountPublic: async () => publicAccount,
      getRailgunAccountPublicDestination: (coordinator, owner) => {
        if (coordinator !== publicAccount.coordinator || owner !== enrollment) throw Error('owner');
        return destination;
      },
    },
    'wallet/railgun-wallet-coverage': {
      checkpointHash: (value) => {
        if (value !== checkpoint) throw Error('checkpoint');
        return checkpointHash;
      },
    },
    'wallet/railgun-account-wallet': {
      openRailgunAccountWallet: async () => {
        log('wallet-open');
        return wallet;
      },
      readRailgunAccountOwnedNotes: () => ({
        checkpointHash: 'checkpoint',
        read: {
          readiness: { to: { ...NEW_ANCHOR } },
          instanceId: INSTANCE,
          received: [{ id: '0:1', txid: SHIELD, spentTxid, asset: weth, amount: AMOUNT }],
        },
        ownedPoi: [{ id: '0:1', type: ownedType, txid: SHIELD }],
        trees: [],
      }),
    },
    'networks/privacy-context': {
      getPrivacyContext: () => ({
        profileId: 'profile',
        subject: { kind: 'private-account', role: 'engine', operation: 'x' },
      }),
      createPrivacyScope: () => ({ getContext: (subject) => subject, close() {} }),
    },
    'networks/private-rpc': {
      createPrivateRpc: () => ({ release() {} }),
      getPrivateRpcDestination: () => ({}),
      getPrivateRpcDestinationDetails: () => ({ url: api.RPC_URL }),
      createPrivateRpcDestinationConstraint: () => {
        const constraint = Object.freeze({ index: constraints.length });
        constraints.push(constraint);
        return { constraint, close() {} };
      },
    },
    'wallet/railgun-private-preflight': {
      createRailgunPrivatePreflight: (options) => {
        calls.preflights.push(options);
        log('preflight-open');
        if (abortOnOpen) calls.recoveryControllers.at(-1).abort();
        if (preflight === 'open')
          throw Object.assign(Error('Railgun private preflight unavailable'), {
            code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
            reason: 'refused',
          });
        return {
          acquire: async () => {
            calls.acquires++;
            log('acquire');
            during?.(state);
            // Production's in-flight read fails inactive once the preflight closes.
            if (preflight === 'hang')
              return new Promise((_resolve, reject) => {
                calls.release = () =>
                  reject(
                    Object.assign(Error('Railgun private preflight unavailable'), {
                      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
                      reason: 'inactive',
                      step: 'rootHistory',
                    })
                  );
              });
            if (preflight !== 'pass')
              throw Object.assign(Error('secret /Users/someone ' + NULLIFIER), {
                code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
                nullifier: NULLIFIER,
                ...preflight,
              });
            return { receipt: {}, observation: {} };
          },
          close: () => {
            log('preflight-close');
            calls.release?.();
          },
        };
      },
      assertRailgunPrivatePreflight: (_source, _receipt, owner) => {
        if (owner !== enrollment) throw Error('enrollment');
        return {
          anchor: { number: '0xb4f9a0', hash: hash('a1'), timestamp: '0x67000000' },
          input: echoInput ?? { ...calls.preflights[0].input },
          deploymentMatched: true,
          verifierMatched: true,
          rootAccepted: true,
          inputUnspent: true,
          unshieldFeeBps: 25,
          trust: 'unverified-rpc',
          ownershipVerified: false,
          signingEnabled: false,
        };
      },
    },
    // Mirrors production order: disclosure review, preflight, transaction
    // review, then the journal write before the one send.
    'wallet/railgun-private-submission': {
      getRailgunPrivatePreflightDiagnostic: realSubmission.getRailgunPrivatePreflightDiagnostic,
      getRailgunPrivateSubmissionDiagnostic: (result) => diagnostics.get(result) ?? null,
      submitRailgunRecoveredPrivateTransaction: async (options) => {
        log('recover-submit');
        calls.submit.push(options);
        for (let n = 0; n < disclosureCalls; n++) {
          let approved;
          try {
            approved = await options.reviewDisclosures(
              Object.freeze(recoverySummary(summary)),
              options.signal
            );
          } catch (error) {
            approved = error;
          }
          calls.disclosures.push(approved);
          if (approved !== true)
            return refusal('disclosure-review', {
              stage: 'disclosure-review',
              code: 'RAILGUN_PRIVATE_SUBMISSION_REFUSED',
            });
        }
        if (submit === 'preflight') return refusal('preflight', diagnostic);
        const request = {
          transaction: {
            to: pins.proxy,
            value: '0',
            data: CALLDATA,
            chainId: 11155111,
            gasLimit: options.gasLimit.toString(),
            gasPrice: reviewGasPrice.toString(),
            nonce: 3,
            ...reviewTransaction,
          },
          from: OWNER,
          intent: {},
          operation: 'railgun-private-transfer',
          maxGasFee: options.maxGasFee,
          fundingAddressPublic: true,
          chainStateVerified: false,
        };
        for (let n = 0; n < reviewCalls; n++) {
          let approved;
          try {
            approved = await options.reviewTransaction(request);
          } catch (error) {
            approved = error;
          }
          calls.reviews.push(approved);
          if (approved !== true) return refusal('submission');
        }
        calls.sign++;
        log('sign');
        journal.records.push({
          hash: TRANSFER,
          state: submit === 'ack' ? 'submitted' : 'attempted',
          intent: {
            kind: 'railgun-transact',
            operation: 'railgun-private-transfer',
            tree: 0,
            nullifier: NULLIFIER,
          },
        });
        if (submit === 'ack') return { hash: TRANSFER };
        if (submit === 'lost') return { transactionHash: TRANSFER, submissionStatus: 'unknown' };
        return refusal('submission');
      },
    },
  };
  const recovering = mode === 'recover-submit';
  const previous = recovering ? probeReport() : heldReport();
  // recover-submit as main() hands it over: the canonical profile, the pinned
  // probe and scan digests, the source binding and the ledger file system.
  const binding = recovering && {
    args: {
      profile: profile ?? newProfile(),
      scanSha: NEWER_SCAN_SHA,
      previousFile: '/w/probe-1/report.json',
      previousSha: probeSha,
      output: '/w/recover-submit-' + probeSha,
    },
    report: { sourceSha256: { ...SOURCES } },
  };
  const ctx = {
    args: { archive: '/e', proverArchive: '/p', artifactDirectory: '/a', ...binding?.args },
    report: { passed: false, ...binding?.report },
    fs: ledgerFs(log, ledger),
    profileId: 'test',
    sourceCommit: COMMIT,
    stage: 'preconditions',
    scan: {
      observedAt: SCAN_AT,
      generationId: 'generation',
      publicPolicy: 'policy',
      anchor: { ...NEW_ANCHOR },
      publicState: { storeId: 'store', trees: [] },
      wallet: { to: { ...NEW_ANCHOR } },
    },
    previous,
    chain: api.nextChain(mode, previous, recovering ? probeSha : HELD_SHA),
    owner: OWNER,
    network,
    readJournal: async () => copy(journal),
    load: (name) => {
      calls.loaded.push(name);
      if (!modules[name]) throw Error('unexpected module ' + name);
      return modules[name];
    },
  };
  return { ctx, calls, state, journal, constraints, destination };
}

// Each probe holds for the real script and must fail for its mutation rows.
const PROBES = {
  'fee-boundary': async (m) => {
    expect(m.assertFeeWithinCap({ gasLimit: 1000000n, gasPrice: 2000000000n }).exposure).toBe(
      2000000000000000n
    );
    expect(() => m.assertFeeWithinCap({ gasLimit: 1000000n, gasPrice: 2000000001n })).toThrow();
    expect(() => m.assertFeeWithinCap({ gasLimit: 3000001n, gasPrice: 1n })).toThrow();
    expect(() => m.assertFeeWithinCap({ gasLimit: 1n, gasPrice: 1n, maxFeePerGas: 1n })).toThrow();
  },
  headroom: async (m) => {
    expect(m.gasLimitFromEstimate(882668n)).toBe(1103335n);
    expect(m.gasLimitFromEstimate(1n)).toBe(2n);
  },
  'review-fee-pure': async (m) => {
    expect(() => m.reviewedFee({ gasLimit: '1250001', gasPrice: '1' }, '1250000')).toThrow();
  },
  classify: async (m) => {
    const before = journal([]);
    expect(() =>
      m.classifySpendOutcome({ result: { hash: TRANSFER }, before, after: before })
    ).toThrow();
    const outcome = m.classifySpendOutcome({
      result: { hash: TRANSFER },
      before,
      after: journal([transferRecord(null)]),
    });
    expect(outcome.resendAllowed).toBe(false);
  },
  'uncertain-blocks': async (m) => {
    // Only the unresolved-record rule refuses these journals.
    const unresolvedShield = { ...shieldRecord(), resolution: null };
    expect(() => m.assertSpendAdmission(journal([unresolvedShield]), 'transfer')).toThrow();
    expect(() =>
      m.assertTransferSettled(journal([transferRecord(), unresolvedShield]), chain)
    ).toThrow();
    expect(() => m.assertTransferSettled(journal([transferRecord()]), chain)).not.toThrow();
  },
  'redaction-keys': async (m) => {
    for (const report of [
      { a: { instanceId: 'plain' } },
      { a: { random: 'plain' } },
      { a: { nullifier: 'plain' } },
    ])
      expect(() => m.assertAggregateReport(report)).toThrow();
  },
  'redaction-hex': async (m) => {
    for (const report of [
      { a: { other: 'ab'.repeat(16) } },
      { a: { other: 'x-' + 'cd'.repeat(16) + '-y' } },
      { a: { other: hash('01') } },
      { owner: hash('01') },
      { hash: OWNER },
    ])
      expect(() => m.assertAggregateReport(report)).toThrow();
    expect(
      m.assertAggregateReport({
        owner: OWNER,
        chain: { transfer: { hash: TRANSFER } },
        sourceSha256: { 'a.js': sha('01') },
        poi: { listKey: api.REQUIRED_LIST },
      })
    ).toBe(true);
  },
  'mode-order': async (m) => {
    const scan = [NEWER_SCAN_SHA, scanReport(200)];
    const ok = (mode, previous, scanSha = scan[0], report = scan[1]) =>
      expect(() => m.assertPredecessor(mode, previous, { scanSha, scan: report })).not.toThrow();
    const no = (mode, previous, scanSha = scan[0], report = scan[1]) =>
      expect(() => m.assertPredecessor(mode, previous, { scanSha, scan: report })).toThrow();
    const valid = {
      allValid: true,
      statuses: ['Valid'],
      rootsAccepted: true,
      membershipVerified: true,
      listKey: api.REQUIRED_LIST,
    };
    no('status', afterTransfer('status', { poi: valid }));
    ok('check-unshield', afterTransfer('status', { poi: valid }));
    no('check-unshield', afterTransfer('status', { poi: { ...valid, statuses: ['Missing'] } }));
    const checked = afterTransfer('check-unshield');
    checked.chain.outputPoi = { reportSha256: sha('5a'), ...valid };
    ok('unshield', checked);
    const unbound = afterTransfer('check-unshield');
    unbound.chain.outputPoi = { ...valid };
    no('unshield', unbound);
    const invalid = afterTransfer('check-unshield');
    invalid.chain.outputPoi = { reportSha256: sha('5a'), ...valid, membershipVerified: false };
    no('unshield', invalid);
    no('unshield', checked, NEWER_SCAN_SHA, scanReport(99));
    no(
      'observe',
      journeyReport('transfer', { spend: { journaled: false, journaledHash: TRANSFER } }),
      SCAN_SHA,
      scanReport(90)
    );
    no(
      'observe',
      journeyReport('observe', {
        target: 'transfer',
        observedHash: TRANSFER,
        resolved: { outcome: 'matched' },
      }),
      SCAN_SHA,
      scanReport(90)
    );
    const observed = afterTransfer('observe', {
      target: 'transfer',
      observedHash: TRANSFER,
      resolved: { outcome: 'reverted' },
      transact: { operation: 'railgun-private-transfer', outputKind: 'shielded' },
    });
    no('poi-submit', observed);
    ok('poi-submit', { ...observed, resolved: { outcome: 'matched' } });
    const attempt = { attempted: true, attemptCompleted: true };
    ok('recover', afterTransfer('poi-submit', { passed: false, poiSubmission: attempt }));
    no('recover', afterTransfer('poi-submit', { poiSubmission: { ...attempt, attempted: false } }));
    no('recover', afterTransfer('poi-submit', { poiSubmission: { attempted: true } }));
  },
  'owned-poi': async (m) => {
    expect(() =>
      m.assertPredecessor('check-transfer', ownedPoiReport({ scanReportSha256: NEWER_SCAN_SHA }), {
        scanSha: SCAN_SHA,
      })
    ).toThrow();
  },
  sources: async (m) => {
    expect(() =>
      m.assertSameSources(sourceMap, { ...sourceMap, 'src/main/wallet/new.js': sha('04') })
    ).toThrow();
  },
  arguments: async (m) => {
    const args = [
      'transfer',
      '/w/e',
      '/w/p',
      '/w/a',
      '/w/profile',
      '/w/scan.json',
      SCAN_SHA,
      '/w/prev.json',
      sha('bb'),
      '/w/profile/out',
    ];
    expect(() => m.parseArguments(args)).toThrow();
  },
  'source-listing': async (m) => {
    const listed = m.listSourceFiles(path.join(__dirname, '..'));
    for (const name of [
      'src/main/wallet/signers.js',
      'src/main/wallet/remote/signer.js',
      'src/main/wallet/ledger/signer.js',
      'src/main/wallet/railgun-private-destination.js',
      // The recovered review budget, loaded by the submission at module load.
      'src/main/wallet/railgun-recovered-review-budget.json',
    ])
      expect(listed).toContain(name);
    expect(listed.filter((name) => /__tests__|__fixtures__|\.test\.js$/.test(name))).toEqual([]);
  },
  dependency: async (m) => {
    const ethersPackage = JSON.stringify({ name: 'ethers', version: '6.17.0' });
    const adapterName = '@freedom/railgun-kohaku-adapter';
    const adapterPackage = JSON.stringify({ name: adapterName, version: '0.1.0' });
    const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
    const lock = (version, adapter = { version: '0.1.0', integrity }) =>
      JSON.stringify({
        packages: { 'node_modules/ethers': { version }, ['node_modules/' + adapterName]: adapter },
      });
    expect(
      m.dependencyIdentity({
        ethersPackage,
        adapterPackage,
        packageLock: lock('6.17.0'),
        electronVersion: '1.0.0',
      })
    ).toEqual({
      ethersVersion: '6.17.0',
      railgunKohakuAdapter: { version: '0.1.0', integrity },
      packageLockSha256: require('crypto')
        .createHash('sha256')
        .update(lock('6.17.0'))
        .digest('hex'),
      electronVersion: '1.0.0',
    });
    expect(() =>
      m.dependencyIdentity({ ethersPackage, adapterPackage, packageLock: lock('6.16.0') })
    ).toThrow();
    for (const [installed, locked] of [
      [adapterPackage, { version: '0.1.1', integrity }],
      [adapterPackage, { version: '0.1.0', integrity: 'sha1-' + 'A'.repeat(27) + '=' }],
      [adapterPackage, { version: '0.1.0' }],
      [adapterPackage, null],
      [JSON.stringify({ name: 'other', version: '0.1.0' }), { version: '0.1.0', integrity }],
      [undefined, { version: '0.1.0', integrity }],
    ])
      expect(() =>
        m.dependencyIdentity({
          ethersPackage,
          adapterPackage: installed,
          packageLock: lock('6.17.0', locked),
        })
      ).toThrow();
  },
  'shield-input': async (m) => {
    const weth = { __type: 'erc20', contract: pins.wrappedNative };
    const good = { id: '0:1', txid: SHIELD, spentTxid: false, asset: weth, amount: AMOUNT };
    const owned = (received, type = 'Shield') => ({
      read: { received },
      ownedPoi: received.map((note) => ({ id: note.id, type, txid: note.txid })),
    });
    expect(m.shieldInput(owned([good]), SHIELD)).toBe(good);
    for (const bad of [
      owned([good, { ...good, id: '0:9' }]),
      owned([{ ...good, spentTxid: hash('99') }]),
      owned([{ ...good, asset: { __type: 'erc20', contract: '0x' + '12'.repeat(20) } }]),
      owned([{ ...good, amount: 10000000000000001n }]),
      owned([{ ...good, amount: 0n }]),
      owned([good], 'Transact'),
      owned([]),
    ])
      expect(() => m.shieldInput(bad, SHIELD)).toThrow();
  },
  'spend-transfer': async (m) => {
    const { ctx, calls } = world();
    await m.spend(ctx, 'transfer');
    expect(ctx.report.passed).toBe(true);
    expect(ctx.report.spend).toMatchObject({ submissionStatus: 'acknowledged', journaled: true });
    expect(calls.prove).toHaveLength(1);
    expect(calls.prove[0].request).toEqual({
      kind: 'railgun-private-transfer',
      noteId: '0:1',
      recipient: INSTANCE,
    });
    expect(calls.submit).toHaveLength(1);
    expect(calls.submit[0].maxGasFee).toBe(2000000000000000n);
    expect(calls.submit[0].gasLimit).toBe(1250000n);
    expect(calls.reviews).toEqual([true]);
    // Only local work and one estimate between proof and submission.
    expect(between(calls.timeline, 'prove', 'submit')).toEqual(['wallet-close', 'eth_estimateGas']);
    expect(calls.timeline.filter((event) => event === 'eth_gasPrice')).toHaveLength(1);
    expect(ctx.report.liveness).toEqual({
      inputHeld: true,
      state: 'sent',
      continuation: 'observe',
    });
    expect(ctx.chain.transfer).toEqual({ hash: TRANSFER });
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
  },
  'spend-unshield': async (m) => {
    const { ctx, calls } = world({ step: 'unshield' });
    await m.spend(ctx, 'unshield');
    expect(ctx.report.spend.submissionStatus).toBe('acknowledged');
    expect(calls.staging).toHaveLength(1);
    expect(calls.prove[0].request).toEqual({
      kind: 'railgun-token-unshield',
      noteId: '0:2',
      recipient: OWNER,
    });
    expect(calls.prove[0].stagingReceipt).toEqual({ staged: true });
    expect(calls.reviews).toEqual([true]);
    expect(ctx.chain.unshield).toEqual({ hash: UNSHIELD, amount: AMOUNT.toString() });
    expect(ctx.report.spendRequest).toMatchObject({
      recipient: 'enrolled-eoa',
      recipientAddress: OWNER,
      amount: AMOUNT.toString(),
    });
  },
  'spend-planning': async (m) => {
    // 1,500,000 x 1,333,333,334 wei exceeds the cap before any hold exists.
    const { ctx, calls } = world({ gasPrice: 1333333334n });
    const error = await settle(m.spend(ctx, 'transfer'));
    expect(error).toEqual(refused('fee-cap'));
    expect(ctx.stage).toBe('submitter');
    expect(calls.prove).toHaveLength(0);
    expect(ctx.report.liveness).toEqual({
      inputHeld: false,
      state: 'no-hold',
      continuation: 'none',
    });
  },
  'spend-plan': async (m) => {
    // Planning passes (1.5e15); 1,700,000 x 5/4 x 1 gwei = 2.125e15 does not.
    const { ctx, calls } = world({ estimate: 1700000n });
    const error = await settle(m.spend(ctx, 'transfer'));
    expect(error).toEqual(refused('fee-cap'));
    expect(ctx.stage).toBe('fee-cap');
    expect(calls.prove).toHaveLength(1);
    expect(calls.submit).toHaveLength(0);
    expect(ctx.report.liveness).toMatchObject({
      inputHeld: true,
      state: 'proved-unsent',
      continuation: 'separately-authorized-recovery',
      laterSpendRefusal: 'RAILGUN_PRIVATE_INPUT_RESERVED',
    });
  },
  'spend-review-fee': async (m) => {
    // The populated fee rises above the plan: 1,250,000 x 1,600,000,001 > cap.
    const { ctx, calls, journal: state } = world({ reviewGasPrice: 1600000001n });
    await m.spend(ctx, 'transfer');
    expect(calls.reviews[0]).toEqual(refused('fee-cap'));
    expect(state.records).toEqual([]);
    expect(ctx.report.spend.submissionStatus).toBe('not-sent');
    expect(ctx.report.passed).toBe(false);
  },
  'spend-review-once': async (m) => {
    const { ctx, calls } = world({ reviewCalls: 2 });
    await m.spend(ctx, 'transfer');
    expect(calls.reviews[0]).toBe(true);
    expect(calls.reviews[1]).toEqual(refused('review-repeated'));
  },
  'spend-admission': async (m) => {
    const { ctx, calls } = world({ records: [transferRecord()] });
    expect(await settle(m.spend(ctx, 'transfer'))).toEqual(refused('spend-attempted'));
    expect(calls.timeline).not.toContain('identity-open');
    const open = world({ step: 'unshield', records: [settledTransfer(null)] });
    expect(await settle(m.spend(open.ctx, 'unshield'))).toEqual(refused('journal-unresolved'));
    expect(open.calls.prove).toHaveLength(0);
  },
  'spend-readback': async (m) => {
    // Refused after the journal write: the attempt is uncertain, never resent.
    const { ctx } = world({ submit: 'journaled-refused' });
    await m.spend(ctx, 'transfer');
    expect(ctx.report.spend).toMatchObject({
      attempted: true,
      journaled: true,
      journaledHash: TRANSFER,
      submissionStatus: 'unknown',
      resendAllowed: false,
    });
    expect(ctx.report.passed).toBe(false);
    expect(ctx.report.liveness).toMatchObject({
      state: 'journaled-uncertain',
      mayNeverResolve: true,
      unresolvedContinuation: 'separately-authorized-recovery',
    });
  },
  'spend-lost': async (m) => {
    const { ctx } = world({ submit: 'lost' });
    await m.spend(ctx, 'transfer');
    expect(ctx.report.spend.submissionStatus).toBe('unknown');
    expect(ctx.report.liveness.state).toBe('journaled-uncertain');
  },
  'spend-prove-refused': async (m) => {
    const held = world({ prove: 'signed-unfinished' });
    expect(await settle(m.spend(held.ctx, 'transfer'))).toEqual(refused('prove'));
    expect(held.ctx.report.liveness.state).toBe('proved-unsent');
    const none = world({ prove: 'refused' });
    expect(await settle(m.spend(none.ctx, 'transfer'))).toEqual(refused('prove'));
    expect(none.ctx.report.liveness.state).toBe('no-hold');
    expect(none.calls.submit).toHaveLength(0);
  },
  'spend-preflight-diagnostic': async (m) => {
    const hostile = {
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'rpc',
      step: 'deployment',
      deploymentStep: 'code-proxy',
      causeCode: 'PRIVATE_RPC_INVALID',
      message: 'secret /Users/someone/identity-data',
      stack: 'Error: secret\n    at /Users/someone/x.js:1:1',
      nullifier: hash('01'),
      payload: { data: '0xdead' },
    };
    const { ctx, calls } = world({ submit: 'preflight', diagnostic: hostile });
    await m.spend(ctx, 'transfer');
    expect(calls.reviews).toEqual([]);
    expect(calls.diagnosticReads).toHaveLength(1);
    expect(ctx.report.submission).toEqual({
      status: 'refused',
      stage: 'preflight',
      diagnostic: {
        stage: 'preflight',
        substage: 'acquire',
        code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
        reason: 'rpc',
        step: 'deployment',
        deploymentStep: 'code-proxy',
        causeCode: 'PRIVATE_RPC_INVALID',
      },
      reviews: 0,
      elapsedMs: expect.any(Number),
    });
    expect(ctx.report.spend).toMatchObject({
      attempted: false,
      journaled: false,
      submissionStatus: 'not-sent',
    });
    expect(ctx.report.liveness.state).toBe('proved-unsent');
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
    expect(JSON.stringify(ctx.report.submission)).not.toMatch(/secret|Users|dead|[0-9a-f]{32}/i);
    // Identifier-shaped checks drop each malformed value on its own.
    const shaped = world({
      submit: 'preflight',
      diagnostic: {
        ...hostile,
        code: 'not a code',
        causeCode: 'E' + 'ABCDEF0123456789'.repeat(2),
        step: 'x'.repeat(40),
        reason: 'Rpc',
      },
    });
    await m.spend(shaped.ctx, 'transfer');
    expect(shaped.ctx.report.submission.diagnostic).toEqual({
      stage: 'preflight',
      substage: 'acquire',
      deploymentStep: 'code-proxy',
    });
    // An unreadable diagnostic is null; the journal is still read back.
    const unreadable = world({ submit: 'preflight', diagnostic: 'throws' });
    await m.spend(unreadable.ctx, 'transfer');
    expect(unreadable.ctx.report.submission.diagnostic).toBeNull();
    expect(unreadable.ctx.report.spend.submissionStatus).toBe('not-sent');
    expect(m.assertAggregateReport(unreadable.ctx.report)).toBe(true);
    // A send is never described by a refusal diagnostic.
    const sent = world();
    await m.spend(sent.ctx, 'transfer');
    expect(sent.calls.diagnosticReads).toHaveLength(0);
    expect(sent.ctx.report.submission).not.toHaveProperty('diagnostic');
  },
  'poi-admission': async (m) => {
    const { ctx, calls } = world({ step: 'poi', records: [settledTransfer(null)] });
    expect(await settle(m.RUNNERS['poi-submit'](ctx))).toEqual(refused('journal-unresolved'));
    expect(calls.timeline).not.toContain('identity-open');
  },
  'poi-delivered': async (m) => {
    const { ctx, calls } = world({ step: 'poi' });
    await m.RUNNERS['poi-submit'](ctx);
    expect(ctx.report.passed).toBe(true);
    expect(ctx.report.poiSubmission).toMatchObject({
      classification: 'rpc-result',
      attempted: true,
      attemptCompleted: true,
      delivered: true,
      serviceAcceptanceVerified: false,
      acceptanceGate: 'status',
      reviews: ['validate-retained-poi', 'submit-retained-poi'],
    });
    expect(calls.poiReviews).toEqual([true, true]);
    expect(calls.selector).toEqual({
      tree: 0,
      position: 1,
      nullifier: 'private-nullifier',
      noteHash: 'private-note-hash',
    });
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
  },
  'poi-classification': async (m) => {
    for (const classification of ['unavailable', 'rpc-error', 'http-failure', 'malformed']) {
      const { ctx } = world({ step: 'poi', classification });
      await m.RUNNERS['poi-submit'](ctx);
      expect(ctx.report.passed).toBe(false);
      expect(ctx.report.poiSubmission).toMatchObject({
        classification,
        attempted: true,
        attemptCompleted: true,
        delivered: false,
        acceptanceGate: 'status',
      });
    }
  },
  'poi-attempted': async (m) => {
    const { ctx, calls } = world({
      step: 'poi',
      poiStore: [{ capsuleDigest: sha('cd'), state: 'attempted' }],
    });
    expect(await settle(m.RUNNERS['poi-submit'](ctx))).toEqual(refused('poi-attempted'));
    expect(calls.timeline).not.toContain('membership');
    expect(calls.timeline).not.toContain('poi-submit');
  },
  'observe-runner': async (m) => {
    const settled = observeWorld();
    await m.RUNNERS.observe(settled.ctx);
    expect(settled.calls.resolve).toEqual([12]);
    expect(settled.ctx.report).toMatchObject({
      passed: true,
      target: 'transfer',
      observedHash: TRANSFER,
      resolved: { outcome: 'matched', finalizedBlockNumber: 120, minimumConfirmations: 12 },
      gas: { gasUsed: '1000000', feePaidWei: '1000000000000000' },
    });
    expect(settled.ctx.chain.transfer).toEqual({ hash: TRANSFER, blockNumber: 100 });
    expect(m.assertAggregateReport(settled.ctx.report)).toBe(true);
    // Too few confirmations, or a finalized head below the block: observe only.
    for (const options of [{ confirmations: 11 }, { finalized: 99 }]) {
      const open = observeWorld(options);
      await m.RUNNERS.observe(open.ctx);
      expect(open.calls.resolve).toEqual([]);
      expect(open.ctx.report.resolved).toBeUndefined();
      expect(open.ctx.report.passed).toBe(true);
    }
    // The unshield resolves only for the enrolled EOA and the full amount.
    const unshield = observeWorld({ target: 'unshield' });
    await m.RUNNERS.observe(unshield.ctx);
    expect(unshield.ctx.report.resolved.outcome).toBe('matched');
    for (const output of [
      { kind: 'unshield', recipient: OWNER, amount: '1', received: '1', fee: '0' },
      {
        kind: 'unshield',
        recipient: '0x' + '11'.repeat(20),
        amount: AMOUNT.toString(),
        received: '1',
        fee: '0',
      },
    ]) {
      const wrong = observeWorld({ target: 'unshield', output });
      expect(await settle(m.RUNNERS.observe(wrong.ctx))).toEqual(refused('resolution'));
    }
  },
  'read-only-runners': async (m) => {
    const recovered = world({ step: 'recover' });
    await m.RUNNERS.recover(recovered.ctx);
    expect(recovered.ctx.report.recovered).toMatchObject({
      outputRecovered: true,
      outputEqualsInputValue: true,
      inputSpent: true,
    });
    const status = world({ step: 'status' });
    await m.RUNNERS.status(status.ctx);
    expect(status.calls.poiNotes).toEqual(['0:2']);
    expect(status.ctx.report.poi).toMatchObject({ allValid: true, statuses: ['Valid'] });
    const checkTransfer = world();
    await m.RUNNERS['check-transfer'](checkTransfer.ctx);
    expect(checkTransfer.ctx.report.preparation.receiver.recipientVerified).toBe(true);
    expect(checkTransfer.calls.prove).toHaveLength(0);
    const checkUnshield = world({ step: 'check-unshield' });
    await m.RUNNERS['check-unshield'](checkUnshield.ctx);
    expect(checkUnshield.ctx.report.spendRequest.recipientAddress).toBe(OWNER);
    for (const value of [recovered, status, checkTransfer, checkUnshield])
      expect(m.assertAggregateReport(value.ctx.report)).toBe(true);
  },
  'held-predecessor': async (m) => {
    const options = { ...newerScan, previousSha: HELD_SHA };
    for (const mode of ['spent-read', 'preflight-probe'])
      expect(() => m.assertPredecessor(mode, heldReport(), options)).not.toThrow();
    const no = (report, extra = {}) =>
      expect(() =>
        m.assertPredecessor('preflight-probe', report, { ...options, ...extra })
      ).toThrow();
    // The same content under another digest is another report.
    no(heldReport(), { previousSha: sha('d0') });
    // The hold-time scan, or one not newer than it, never qualifies.
    no(heldReport(), { scanSha: SCAN_SHA });
    no(heldReport(), { scan: scanReport(HOLD_ANCHOR) });
    no(heldReport({ liveness: { inputHeld: true, state: 'journaled-uncertain' } }));
    no(
      heldReport({
        spend: {
          attempted: true,
          journaled: true,
          submissionStatus: 'unknown',
          resendAllowed: false,
        },
      })
    );
    no(heldReport({ prove: { status: 'signed-unfinished', holdCreated: true } }));
    no(heldReport({ submission: { status: 'refused', stage: 'submission', reviews: 1 } }));
    no(heldReport({ failure: { stage: 'prove', code: 'X' } }));
    no(heldReport({ mode: 'check-transfer' }));
    no(heldReport({ passed: true }));
    no(heldReport({ spendRequest: { kind: 'railgun-token-unshield', recipient: 'enrolled-eoa' } }));
    no(heldReport({ fee: { plan: { ...heldPlan, gasLimit: '1559207' } } }));
    no(heldReport({ fee: undefined }));
    const journaled = heldReport();
    journaled.chain.transfer = { hash: TRANSFER };
    no(journaled);
  },
  'recover-predecessor': async (m) => {
    const options = { ...newerScan, previousSha: PROBE_SHA, now: Date.parse(PROBE_AT) + 60000 };
    const ok = (mode, report, extra = {}) =>
      expect(() => m.assertPredecessor(mode, report, { ...options, ...extra })).not.toThrow();
    const no = (mode, report, extra = {}) =>
      expect(() => m.assertPredecessor(mode, report, { ...options, ...extra })).toThrow();
    ok('recover-submit', probeReport());
    no('recover-submit', probeReport({ passed: false }));
    no('recover-submit', probeReport({ preflight: { passed: false, acquireCalls: 1 } }));
    no('recover-submit', probeReport({ preflight: { passed: true, acquireCalls: 2 } }));
    no('recover-submit', probeReport({ immutables: { unchanged: false } }));
    // Only a completed probe whose result is a passed preflight admits it.
    no('recover-submit', probeReport({ result: 'preflight-refused' }));
    no('recover-submit', probeReport({ result: 'not-completed' }));
    no('recover-submit', probeReport({ result: undefined }));
    no(
      'recover-submit',
      probeReport({
        chain: heldChain({
          heldTransfer: { reportSha256: sha('d0'), estimate: '1', gasLimit: '2' },
        }),
      })
    );
    no('recover-submit', probeReport({ chain: heldChain({ transfer: { hash: TRANSFER } }) }));
    no('recover-submit', heldReport());
    no('recover-submit', probeReport(), {
      scanSha: sha('ae'),
      scan: scanReport(NEW_ANCHOR.number),
    });
    // At most 30 minutes old, never in the future, canonical ISO time only.
    const at = Date.parse(PROBE_AT);
    expect(m.PROBE_MAX_AGE_MS).toBe(1800000);
    ok('recover-submit', probeReport(), { now: at });
    ok('recover-submit', probeReport(), { now: at + 1800000 });
    no('recover-submit', probeReport(), { now: at + 1800001 });
    no('recover-submit', probeReport(), { now: at - 1 });
    no('recover-submit', probeReport(), { now: NaN });
    for (const observedAt of [undefined, 'yesterday', '2026-10-07T12:00:00Z', at])
      no('recover-submit', probeReport({ observedAt }));
    // A journaled recovery, acknowledged or uncertain, continues only in observe.
    const spent = {
      attempted: true,
      journaled: true,
      journaledHash: TRANSFER,
      submissionStatus: 'unknown',
      resendAllowed: false,
    };
    const recovered = journeyReport('recover-submit', {
      passed: false,
      scan: { sha256: NEWER_SCAN_SHA, anchor: { ...NEW_ANCHOR } },
      chain: heldChain({ transfer: { hash: TRANSFER } }),
      spend: spent,
    });
    ok('observe', recovered);
    no('observe', { ...recovered, spend: { ...spent, journaled: false } });
    no('recover-submit', recovered);
    // A lost recover-submit report: the passed probe stands as its check report.
    ok('observe', probeReport());
    no('observe', probeReport({ preflight: { passed: false } }));
    no('observe', probeReport({ result: 'preflight-refused' }));
    // Observing a lost recovery needs no fresh probe.
    ok('observe', probeReport(), { now: Date.parse(PROBE_AT) + 86400000 });
  },
  'proof-runtime': async (m) => {
    const runtime = heldReport().runtime;
    const later = {
      ...copy(runtime),
      dependencies: { railgunKohakuAdapter: { version: '0.1.0' }, packageLockSha256: sha('5c') },
    };
    expect(() => m.assertSameProofRuntime(runtime, later)).not.toThrow();
    for (const changed of [
      { ...later, proverSha256: sha('f1') },
      { ...later, engineSha256: sha('e1') },
      { ...later, artifactSha256: { '01x01.zkey': sha('12') } },
    ])
      expect(() => m.assertSameProofRuntime(runtime, changed)).toThrow();
  },
  'held-chain': async (m) => {
    const probe = m.nextChain('preflight-probe', heldReport(), HELD_SHA);
    expect(probe).toEqual(heldChain());
    expect(m.nextChain('spent-read', heldReport(), HELD_SHA)).toEqual(heldChain());
    expect(m.nextChain('recover-submit', probeReport(), PROBE_SHA)).toEqual(
      heldChain({
        heldTransfer: { ...heldChain().heldTransfer, probeReportSha256: PROBE_SHA },
      })
    );
  },
  'preflight-binding': async (m) => {
    const held = heldState();
    const current = { checkpointHash: NEW_CHECKPOINT, minimumBlock: NEW_ANCHOR.number };
    const input = m.recoveredPreflightInput({ held, current, holdAnchor: HOLD_ANCHOR });
    expect(input).toEqual({
      tree: 0,
      merkleRoot: MERKLE_ROOT,
      nullifier: NULLIFIER,
      checkpointHash: NEW_CHECKPOINT,
      minimumBlock: NEW_ANCHOR.number,
    });
    const refuse = (value, against = current) =>
      expectRefusal(
        () =>
          m.assertRecoveredPreflightInput(value, {
            held,
            current: against,
            holdAnchor: HOLD_ANCHOR,
          }),
        'preflight-binding'
      );
    // Mixed old/new bindings, and a checkpoint from neither.
    refuse({ ...input, checkpointHash: OLD_CHECKPOINT });
    refuse({ ...input, minimumBlock: HOLD_ANCHOR });
    refuse({ ...input, checkpointHash: OLD_CHECKPOINT, minimumBlock: HOLD_ANCHOR });
    refuse({ ...input, checkpointHash: sha('2c') });
    refuse({ ...input, minimumBlock: NEW_ANCHOR.number + 1 });
    // A "current" checkpoint that is still the hold-time one.
    refuse(
      { ...input, checkpointHash: OLD_CHECKPOINT },
      { ...current, checkpointHash: OLD_CHECKPOINT }
    );
    refuse({ ...input, minimumBlock: HOLD_ANCHOR }, { ...current, minimumBlock: HOLD_ANCHOR });
    // The original held proof inputs only.
    refuse({ ...input, merkleRoot: hash('99') });
    refuse({ ...input, nullifier: hash('98') });
    refuse({ ...input, tree: 1 });
    refuse({ ...input, extra: 1 });
  },
  'held-unjournaled': async (m) => {
    const held = heldState();
    const record = (nullifier, resolution = { railgun: { outcome: 'reverted' } }) => ({
      hash: TRANSFER,
      state: 'submitted',
      intent: { kind: 'railgun-transact', tree: 0, nullifier },
      ...(resolution ? { resolution } : {}),
    });
    expect(() =>
      m.assertHeldUnjournaled(journal([], [shieldRecord(), record(hash('77'))]), held)
    ).not.toThrow();
    expect(() =>
      m.assertHeldUnjournaled(journal([], [shieldRecord(), record(NULLIFIER)]), held)
    ).toThrow();
    expect(() =>
      m.assertHeldUnjournaled(journal([record(NULLIFIER)], [shieldRecord()]), held)
    ).toThrow();
    expect(() =>
      m.assertHeldUnjournaled(journal([record(hash('77'), null)], [shieldRecord()]), held)
    ).toThrow();
  },
  'probe-pass': async (m) => {
    const { ctx, calls, constraints } = heldWorld();
    await m.RUNNERS['preflight-probe'](ctx);
    expect(ctx.report.passed).toBe(true);
    // Exactly one preflight, built by the recovered-submission rules.
    expect(calls.preflights).toHaveLength(1);
    expect(calls.acquires).toBe(1);
    expect(Object.keys(calls.preflights[0]).sort()).toEqual([
      'artifactDirectory',
      'destinationConstraint',
      'enrollment',
      'input',
    ]);
    expect(calls.preflights[0].input).toEqual({
      tree: 0,
      merkleRoot: MERKLE_ROOT,
      nullifier: NULLIFIER,
      checkpointHash: NEW_CHECKPOINT,
      minimumBlock: NEW_ANCHOR.number,
    });
    expect(calls.preflights[0].destinationConstraint).toBe(constraints[0]);
    expect(ctx.report.preflight).toEqual({
      attempted: true,
      acquireCalls: 1,
      retry: false,
      passed: true,
      diagnostic: null,
      nullifierQuery: 'queried',
      observation: {
        anchor: { blockNumber: 0xb4f9a0, blockHash: hash('a1'), timestamp: 0x67000000 },
        deploymentMatched: true,
        verifierMatched: true,
        rootAccepted: true,
        inputUnspent: true,
        unshieldFeeBps: 25,
        trust: 'unverified-rpc',
      },
      elapsedMs: expect.any(Number),
    });
    expect(ctx.report.preflightBinding).toMatchObject({
      rule: 'recovered-submission',
      minimumBlock: NEW_ANCHOR.number,
      holdAnchorNumber: HOLD_ANCHOR,
    });
    // No account wallet, proof, EOA request, POI, signing, broadcast or release.
    expect(calls.network).toEqual([]);
    for (const name of [
      'wallet/railgun-account-wallet',
      'wallet/railgun-private-operation',
      'wallet/railgun-account-poi',
      'wallet/signers',
    ])
      expect(calls.loaded).not.toContain(name);
    expect(calls.submit).toEqual([]);
    expect(calls.abandon).toBe(0);
    expect(calls.timeline.filter((event) => event === 'acquire')).toHaveLength(1);
    expect(calls.timeline.indexOf('acquire')).toBeLessThan(
      calls.timeline.indexOf('preflight-close')
    );
    // The preflight runs inside the first recovery read; the second re-reads.
    expect(calls.recoveryTimeouts).toEqual([60000, 15000]);
    expect(ctx.report.immutables).toEqual({
      unchanged: true,
      compared: [
        'hold-entry',
        'intent',
        'signing',
        'signature',
        'proved-transaction',
        'calldata-ciphertext',
        'capsule',
        'journal-records',
        'journal-archive',
        'hold-counts',
      ],
      changed: [],
      holds: {
        reservations: { held: 0, signing: 1, abandoned: 0, legacy: 0 },
        capsules: { records: 1, signed: 1, proved: 1 },
      },
      expectedStoreWrites: [
        'reservations-lease',
        'reservations-floor',
        'capsules-lease',
        'capsules-floor',
      ],
      wholeProfileIdentityAsserted: false,
    });
    expect(ctx.report.liveness.state).toBe('proved-unsent');
    // passed is a completed probe; result and scope say what it qualified.
    expect(ctx.report.result).toBe('preflight-passed');
    expect(ctx.report.scope).toEqual({
      qualifies: 'private-preflight-stage-only',
      passedMeans: 'probe-completed',
      notQualified: [
        'wallet-note-binding',
        'poi-status',
        'proof-recheck',
        'eoa-steps',
        'recovered-submission-timing',
      ],
    });
    expect(ctx.report.coverage).toMatchObject({
      scanAnchor: NEW_ANCHOR,
      holdAnchorNumber: HOLD_ANCHOR,
      preflightAnchor: { blockNumber: 0xb4f9a0, blockHash: hash('a1') },
      appliesTo: 'conditions-at-observation',
    });
    expect(ctx.report.disclosure).toMatchObject({
      nullifierQuery: 'queried',
      eoa: false,
      calldata: false,
      signing: false,
      broadcast: false,
    });
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
    expect(JSON.parse(m.renderReport(ctx.report))).toEqual(copy(ctx.report));
    expect(withoutSecrets(ctx.report)).toBe(true);
  },
  'probe-refusals': async (m) => {
    // [refusal tuple, nullifier query]: production queries the nullifier only
    // after the deployment, artifact, root, fee and verifier steps pass.
    for (const [tuple, query] of [
      [
        {
          reason: 'rpc',
          step: 'deployment',
          deploymentStep: 'anchor',
          causeCode: 'PRIVATE_RPC_INVALID',
        },
        'not-queried',
      ],
      [{ reason: 'stale', step: 'deployment', deploymentStep: 'anchor-recheck' }, 'not-queried'],
      [{ reason: 'mismatch', step: 'deployment', deploymentStep: 'slot-paused' }, 'not-queried'],
      [{ reason: 'refused', step: 'artifacts' }, 'not-queried'],
      [{ reason: 'rpc', step: 'rootHistory', causeCode: 'TOR_REQUEST_FAILED' }, 'not-queried'],
      [{ reason: 'mismatch', step: 'unshieldFee' }, 'not-queried'],
      [{ reason: 'mismatch', step: 'verifier' }, 'not-queried'],
      [{ reason: 'inactive', step: 'nullifiers' }, 'possibly-queried'],
      [{ reason: 'mismatch', step: 'nullifiers' }, 'queried'],
      [{ reason: 'stale', step: 'anchor-recheck' }, 'queried'],
    ]) {
      const { ctx, calls } = heldWorld({ preflight: tuple });
      await m.RUNNERS['preflight-probe'](ctx);
      // A completed probe whose preflight refused: one acquire, never a retry.
      expect(ctx.report.passed).toBe(true);
      expect(ctx.report.result).toBe('preflight-refused');
      expect(calls.acquires).toBe(1);
      expect(ctx.report.preflight).toEqual({
        attempted: true,
        acquireCalls: 1,
        retry: false,
        passed: false,
        diagnostic: {
          stage: 'preflight',
          substage: 'acquire',
          code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
          ...tuple,
        },
        nullifierQuery: query,
        observation: null,
        elapsedMs: expect.any(Number),
      });
      expect(calls.network).toEqual([]);
      expect(m.assertAggregateReport(ctx.report)).toBe(true);
      expect(withoutSecrets(ctx.report)).toBe(true);
    }
    // Construction refusal: no acquire and nothing queried.
    const open = heldWorld({ preflight: 'open' });
    await m.RUNNERS['preflight-probe'](open.ctx);
    expect(open.calls.acquires).toBe(0);
    expect(open.ctx.report.preflight).toMatchObject({
      attempted: false,
      acquireCalls: 0,
      passed: false,
      nullifierQuery: 'not-queried',
      diagnostic: {
        stage: 'preflight',
        substage: 'open',
        code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
        reason: 'refused',
      },
    });
    // An observation for another input is an admission refusal, never a pass.
    const echoed = heldWorld({
      echoInput: {
        tree: 0,
        merkleRoot: MERKLE_ROOT,
        nullifier: NULLIFIER,
        checkpointHash: OLD_CHECKPOINT,
        minimumBlock: HOLD_ANCHOR,
      },
    });
    await m.RUNNERS['preflight-probe'](echoed.ctx);
    expect(echoed.ctx.report.preflight).toMatchObject({
      passed: false,
      acquireCalls: 1,
      nullifierQuery: 'queried',
      observation: null,
      diagnostic: {
        stage: 'preflight',
        substage: 'admission',
        code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
      },
    });
  },
  'probe-binding-runner': async (m) => {
    // A coordinator still at the hold-time checkpoint, or a checkpoint that is
    // not this scan's: refused before any preflight exists.
    for (const options of [
      { checkpointHash: OLD_CHECKPOINT },
      { checkpointTo: { number: HOLD_ANCHOR, hash: hash('ac') } },
      { checkpointTo: { number: NEW_ANCHOR.number + 5, hash: hash('ae') } },
    ]) {
      const { ctx, calls } = heldWorld(options);
      expect(await settle(m.RUNNERS['preflight-probe'](ctx))).toEqual(refused('preflight-binding'));
      expect(calls.preflights).toEqual([]);
      expect(calls.acquires).toBe(0);
    }
  },
  'probe-hold': async (m) => {
    for (const [options, step] of [
      [{ signingRecords: 2 }, 'hold'],
      [{ foreign: true }, 'hold-recipient'],
      [{ recipient: '0zk1' + 'x'.repeat(60) }, 'hold-recipient'],
      [{ signed: false }, 'hold-signature'],
      // Each readHeld binding alone: submitter, proved target, kind, the facts'
      // tree and nullifier against the capsule, signing state and capsule hold id.
      [{ alter: (s) => (s.entry.signing.submitter = '0x' + '99'.repeat(20)) }, 'hold'],
      [{ alter: (s) => (s.stored.provedTransaction.to = '0x' + '98'.repeat(20)) }, 'hold'],
      [{ alter: (s) => (s.entry.facts.kind = 'railgun-token-unshield') }, 'hold'],
      [{ alter: (s) => (s.stored.capsule.selection.kind = 'railgun-token-unshield') }, 'hold'],
      [{ alter: (s) => (s.entry.facts.nullifier = hash('97')) }, 'hold'],
      [{ alter: (s) => (s.entry.facts.tree = 1) }, 'hold'],
      [{ alter: (s) => (s.entry.state = 'held') }, 'hold'],
      [{ alter: (s) => (s.stored.holdId = sha('96')) }, 'hold'],
      [{ alter: (s) => (s.entry.id = s.stored.holdId = 'hold') }, 'hold'],
    ]) {
      const { ctx, calls } = heldWorld(options);
      expect(await settle(m.RUNNERS['preflight-probe'](ctx))).toEqual(refused(step));
      expect(calls.preflights).toEqual([]);
      expect(calls.abandon).toBe(0);
    }
    // Any private send or open record refuses before the profile is opened.
    for (const [records, step] of [
      [
        [
          {
            hash: TRANSFER,
            state: 'submitted',
            intent: { kind: 'railgun-transact', tree: 0, nullifier: NULLIFIER },
            resolution: { railgun: { outcome: 'reverted' } },
          },
        ],
        'spend-attempted',
      ],
      [[{ hash: hash('41'), state: 'attempted', intent: { kind: 'other' } }], 'journal-unresolved'],
    ]) {
      const { ctx, calls } = heldWorld({ records });
      expect(await settle(m.RUNNERS['preflight-probe'](ctx))).toEqual(refused(step));
      expect(calls.timeline).not.toContain('identity-open');
    }
  },
  'recover-output': async (m) => {
    const args = (output, previous = '/w/probe/report.json', previousSha = PROBE_SHA) => [
      'recover-submit',
      '/w/engine.asar',
      '/w/prover.asar',
      '/w/artifacts',
      '/w/identity-data/railgun-sepolia-live',
      '/w/scan/report.json',
      NEWER_SCAN_SHA,
      previous,
      previousSha,
      output,
    ];
    const valid = '/w/recover-submit-' + PROBE_SHA;
    expect(m.parseArguments(args(valid)).output).toBe(valid);
    for (const [output, previous, previousSha] of [
      ['/w/l-a/recover'],
      ['/w/recover-submit-' + sha('9c')],
      ['/w/other/recover-submit-' + PROBE_SHA],
      [valid, '/w/elsewhere/probe/report.json'],
      [valid, undefined, sha('9c')],
    ])
      expectRefusal(() => m.parseArguments(args(output, previous, previousSha)), 'output');
    // Every other mode keeps a free output name.
    expect(m.parseArguments(['preflight-probe', ...args('/w/l-a/probe').slice(1)]).output).toBe(
      '/w/l-a/probe'
    );
  },
  'probe-timer': async (m) => {
    // The production 20 s acquisition timer closes a hung preflight: refused
    // inactive, one acquire, a completed probe and no retry.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { ctx, calls } = heldWorld({ preflight: 'hang' });
    let settled = false;
    const run = m.RUNNERS['preflight-probe'](ctx).finally(() => {
      settled = true;
    });
    run.catch(() => {});
    try {
      await until(() => calls.acquires === 1);
      await jest.advanceTimersByTimeAsync(19999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await until(() => settled);
      await run;
    } finally {
      calls.release?.();
      jest.useRealTimers();
    }
    expect(ctx.report.preflight).toMatchObject({
      attempted: true,
      acquireCalls: 1,
      retry: false,
      passed: false,
      diagnostic: {
        stage: 'preflight',
        substage: 'acquire',
        code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
        reason: 'inactive',
        step: 'rootHistory',
      },
      nullifierQuery: 'not-queried',
      elapsedMs: 20000,
    });
    expect(ctx.report.result).toBe('preflight-refused');
    expect(calls.acquires).toBe(1);
  },
  'probe-abort': async (m) => {
    // A recovery phase that ends while the preflight opens: never acquired.
    const opened = heldWorld({ abortOnOpen: true });
    expect(await settle(m.RUNNERS['preflight-probe'](opened.ctx))).toEqual(
      Error('recovery phase ended')
    );
    expect(opened.calls.acquires).toBe(0);
    expect(opened.ctx.report.preflight).toMatchObject({
      attempted: false,
      acquireCalls: 0,
      passed: false,
      nullifierQuery: 'not-queried',
      diagnostic: {
        stage: 'preflight',
        substage: 'open',
        code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
      },
    });
    expect(opened.ctx.report.result).toBe('not-completed');
    // A phase that ends during acquisition closes the in-flight preflight.
    const hung = heldWorld({ preflight: 'hang' });
    let settled = false;
    const run = settle(m.RUNNERS['preflight-probe'](hung.ctx)).then((value) => {
      settled = true;
      return value;
    });
    try {
      await until(() => hung.calls.acquires === 1);
      expect(settled).toBe(false);
      hung.calls.recoveryControllers[0].abort();
      await until(() => settled);
    } finally {
      hung.calls.release?.();
    }
    expect(await run).toEqual(Error('recovery phase ended'));
    expect(hung.ctx.report.preflight).toMatchObject({
      acquireCalls: 1,
      passed: false,
      diagnostic: { substage: 'acquire', reason: 'inactive', step: 'rootHistory' },
    });
    expect(hung.ctx.report.result).toBe('not-completed');
    expect(hung.ctx.report.passed).toBe(false);
  },
  'probe-immutables': async (m) => {
    for (const [name, during] of [
      ['signature', (s) => (s.stored.signature = { R8: ['9', '9'], S: '9' })],
      ['proved-transaction', (s) => (s.stored.provedTransaction.data = '0xbeef')],
      ['calldata-ciphertext', (s) => (s.stored.capsule.preparation.transaction.data = '0xcafd')],
      ['hold-entry', (s) => (s.entry.signing.operationId = sha('66'))],
      ['intent', (s) => (s.entry.facts.intentDigest = hash('67'))],
      [
        'journal-records',
        (s) =>
          s.journal.records.push({
            hash: hash('42'),
            state: 'submitted',
            intent: {},
            resolution: {},
          }),
      ],
      ['journal-archive', (s) => s.journal.archive.push({ hash: hash('43'), intent: {} })],
      ['hold-counts', (s) => (s.counts.reservations.abandoned = 1)],
    ]) {
      const { ctx } = heldWorld({ during });
      expect(await settle(m.RUNNERS['preflight-probe'](ctx))).toEqual(refused('immutables'));
      expect(ctx.report.passed).toBe(false);
      expect(ctx.report.immutables.unchanged).toBe(false);
      expect(ctx.report.immutables.changed).toContain(name);
      // The preflight itself passed; an incomplete probe never reports it.
      expect(ctx.report.preflight.passed).toBe(true);
      expect(ctx.report.result).toBe('not-completed');
      expect(m.assertAggregateReport(ctx.report)).toBe(true);
    }
  },
  'spent-read': async (m) => {
    // Through the scan anchor only: when the scan began, and when the wallet read.
    const anchorOnly = {
      through: NEW_ANCHOR,
      scanObservedAt: SCAN_AT,
      readAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      observedThroughAnchorOnly: true,
    };
    const before = Date.now();
    const unspent = heldWorld({ mode: 'spent-read' });
    await m.RUNNERS['spent-read'](unspent.ctx);
    expect(unspent.ctx.report.passed).toBe(true);
    expect(unspent.ctx.report.input).toEqual({ spent: false, ...anchorOnly });
    const readAt = Date.parse(unspent.ctx.report.input.readAt);
    expect(readAt >= before && readAt <= Date.now()).toBe(true);
    // An unrecorded or non-canonical scan time is null, never echoed.
    for (const observedAt of [undefined, '2026-10-07T11:00:00Z', 1]) {
      const other = heldWorld({ mode: 'spent-read' });
      other.ctx.scan.observedAt = observedAt;
      await m.RUNNERS['spent-read'](other.ctx);
      expect(other.ctx.report.input.scanObservedAt).toBeNull();
    }
    for (const spentTxid of [hash('9a'), '9A'.repeat(32)]) {
      const spent = heldWorld({ mode: 'spent-read', spentTxid });
      await m.RUNNERS['spent-read'](spent.ctx);
      expect(spent.ctx.report.input).toEqual({
        spent: true,
        transactionHash: hash('9a'),
        ...anchorOnly,
      });
      expect(m.assertAggregateReport(spent.ctx.report)).toBe(true);
      expect(withoutSecrets(spent.ctx.report)).toBe(true);
    }
    for (const [options, step] of [
      [{ spentTxid: '0x12' }, 'input-spent'],
      [{ ownedType: 'Transact' }, 'input-record'],
    ]) {
      const bad = heldWorld({ mode: 'spent-read', ...options });
      expect(await settle(m.RUNNERS['spent-read'](bad.ctx))).toEqual(refused(step));
    }
    // A wallet read only: no recovery store, preflight, submission or EOA request.
    expect(unspent.calls.network).toEqual([]);
    expect(unspent.calls.timeline).not.toContain('recovery-stores');
    for (const name of ['wallet/railgun-private-preflight', 'wallet/railgun-private-submission'])
      expect(unspent.calls.loaded).not.toContain(name);
    const journaled = heldWorld({
      mode: 'spent-read',
      records: [{ hash: hash('41'), state: 'attempted', intent: { kind: 'other' } }],
    });
    expect(await settle(m.RUNNERS['spent-read'](journaled.ctx))).toEqual(
      refused('journal-unresolved')
    );
  },
  'recover-ack': async (m) => {
    const { ctx, calls, destination } = heldWorld({ mode: 'recover-submit' });
    await m.RUNNERS['recover-submit'](ctx);
    expect(ctx.report.passed).toBe(true);
    expect(calls.submit).toHaveLength(1);
    const options = calls.submit[0];
    expect(Object.keys(options).sort()).toEqual(
      [
        'identity',
        'enrollment',
        'coordinator',
        'destination',
        'archive',
        'proverArchive',
        'artifactDirectory',
        'holdId',
        'reviewDisclosures',
        'reviewTransaction',
        'gasLimit',
        'maxGasFee',
        'signal',
        'timeoutMs',
      ].sort()
    );
    expect(options).toMatchObject({
      holdId: HOLD_ID,
      destination,
      archive: '/e',
      proverArchive: '/p',
      artifactDirectory: '/a',
      gasLimit: 1559208n,
      maxGasFee: 2000000000000000n,
      timeoutMs: 600000,
    });
    expect(options.signal).toBe(ctx.enrollment.signal);
    expect(calls.disclosures).toEqual([true]);
    expect(calls.reviews).toEqual([true]);
    expect(calls.sign).toBe(1);
    // The original signature is reused: no prover, spending key, wallet or preflight.
    for (const name of [
      'wallet/railgun-private-operation',
      'wallet/railgun-account-wallet',
      'wallet/railgun-private-preflight',
      'wallet/signers',
    ])
      expect(calls.loaded).not.toContain(name);
    expect(calls.abandon).toBe(0);
    // Public EOA reads and one fee quote before production; never calldata.
    expect(calls.network).toEqual([
      'eth_getCode',
      'eth_getBalance',
      'eth_getTransactionCount',
      'eth_getTransactionCount',
      'eth_gasPrice',
    ]);
    expect(ctx.report.spend).toEqual({
      attempted: true,
      journaled: true,
      journaledHash: TRANSFER,
      journalState: 'submitted',
      submissionStatus: 'acknowledged',
      resendAllowed: false,
    });
    expect(ctx.report.liveness).toEqual({
      inputHeld: true,
      state: 'sent',
      continuation: 'observe',
    });
    expect(ctx.chain.transfer).toEqual({ hash: TRANSFER });
    expect(ctx.chain.heldTransfer.probeReportSha256).toBe(PROBE_SHA);
    expect(ctx.report.fee.plan).toMatchObject({ estimate: '1247366', gasLimit: '1559208' });
    expect(ctx.report.fee.reviewed).toMatchObject({ gasLimit: '1559208', fee: '1000015' });
    expect(ctx.report.recovery.disclosure).toMatchObject({
      purpose: 'railgun-recovered-private-submission',
      recipient: 'self',
      originalSpendingSignatureReused: true,
      newSpendingSignature: false,
    });
    expect(ctx.report.submission).toMatchObject({
      status: 'acknowledged',
      reviews: { disclosure: 1, transaction: 1 },
    });
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
    expect(withoutSecrets(ctx.report)).toBe(true);
  },
  'recover-disclosure': async (m) => {
    const destinations = recoverySummary().destinations;
    for (const summary of [
      { newSpendingSignature: true },
      { originalSpendingSignatureReused: false },
      {
        exposures: {
          ...copy(api.RECOVERY_EXPOSURES),
          poi: [...api.RECOVERY_EXPOSURES.poi, 'extra'],
        },
      },
      { destinations: { ...destinations, protocolRpc: 'https://other.example' } },
      { destinations: { ...destinations, poi: 'https://other.example' } },
      { recipient: '0zk1' + 'x'.repeat(60) },
      { recipientRelationship: 'foreign' },
      { submitter: '0x' + '11'.repeat(20) },
      { selection: { noteId: '0:2', originalCheckpointHash: OLD_CHECKPOINT } },
      { selection: { noteId: '0:1', originalCheckpointHash: NEW_CHECKPOINT } },
      { operation: 'railgun-token-unshield' },
      { automaticRetry: true },
    ]) {
      const { ctx, calls, journal: state } = heldWorld({ mode: 'recover-submit', summary });
      await m.RUNNERS['recover-submit'](ctx);
      expect(calls.disclosures).toEqual([refused('disclosure-review')]);
      expect(calls.reviews).toEqual([]);
      expect(calls.sign).toBe(0);
      expect(state.records).toEqual([]);
      expect(ctx.report.spend).toMatchObject({ journaled: false, submissionStatus: 'not-sent' });
      expect(ctx.report.liveness.state).toBe('proved-unsent');
      expect(ctx.report.passed).toBe(false);
    }
    const twice = heldWorld({ mode: 'recover-submit', disclosureCalls: 2 });
    await m.RUNNERS['recover-submit'](twice.ctx);
    expect(twice.calls.disclosures).toEqual([true, refused('review-repeated')]);
    expect(twice.calls.sign).toBe(0);
  },
  'recover-review': async (m) => {
    // 1,559,208 gas x 1.3 gwei exceeds 0.002 ETH: refused before the EOA signature.
    for (const [options, step] of [
      [{ reviewGasPrice: 1300000000n }, 'fee-cap'],
      [{ reviewTransaction: { gasLimit: '1559209' } }, 'fee-gas-limit'],
      [{ reviewTransaction: { data: '0xbeef' } }, 'review-calldata'],
      [{ reviewTransaction: { to: '0x' + '11'.repeat(20) } }, 'review'],
    ]) {
      const { ctx, calls, journal: state } = heldWorld({ mode: 'recover-submit', ...options });
      await m.RUNNERS['recover-submit'](ctx);
      expect(calls.reviews).toEqual([refused(step)]);
      expect(calls.sign).toBe(0);
      expect(state.records).toEqual([]);
      expect(ctx.report.spend.submissionStatus).toBe('not-sent');
    }
    const twice = heldWorld({ mode: 'recover-submit', reviewCalls: 2 });
    await m.RUNNERS['recover-submit'](twice.ctx);
    expect(twice.calls.reviews).toEqual([true, refused('review-repeated')]);
    expect(twice.calls.sign).toBe(0);
  },
  'recover-admission': async (m) => {
    // An existing journal entry for the held input is never resent.
    const sent = heldWorld({
      mode: 'recover-submit',
      records: [
        {
          hash: TRANSFER,
          state: 'submitted',
          intent: { kind: 'railgun-transact', tree: 0, nullifier: NULLIFIER },
          resolution: { railgun: { outcome: 'reverted' } },
        },
      ],
    });
    expect(await settle(m.RUNNERS['recover-submit'](sent.ctx))).toEqual(refused('spend-attempted'));
    expect(sent.calls.submit).toEqual([]);
    expect(sent.calls.timeline).not.toContain('identity-open');
    const open = heldWorld({
      mode: 'recover-submit',
      records: [{ hash: hash('41'), state: 'attempted', intent: { kind: 'other' } }],
    });
    expect(await settle(m.RUNNERS['recover-submit'](open.ctx))).toEqual(
      refused('journal-unresolved')
    );
    expect(open.calls.submit).toEqual([]);
    expect(open.calls.timeline).not.toContain('identity-open');
    for (const [options, step] of [
      [{ signingRecords: 2 }, 'hold'],
      [{ signed: false }, 'hold-signature'],
    ]) {
      const held = heldWorld({ mode: 'recover-submit', ...options });
      expect(await settle(m.RUNNERS['recover-submit'](held.ctx))).toEqual(refused(step));
      expect(held.calls.submit).toEqual([]);
      expect(held.calls.network).toEqual([]);
    }
  },
  'recover-uncertain': async (m) => {
    const options = { ...newerScan, previousSha: sha('9c') };
    for (const submit of ['lost', 'journaled-refused']) {
      const { ctx, calls, journal: state } = heldWorld({ mode: 'recover-submit', submit });
      await m.RUNNERS['recover-submit'](ctx);
      expect(calls.sign).toBe(1);
      expect(ctx.report.spend).toMatchObject({
        attempted: true,
        journaled: true,
        journaledHash: TRANSFER,
        submissionStatus: 'unknown',
        resendAllowed: false,
      });
      expect(ctx.report.liveness).toMatchObject({
        state: 'journaled-uncertain',
        continuation: 'observe',
        mayNeverResolve: true,
      });
      expect(ctx.report.passed).toBe(false);
      expect(ctx.chain.transfer).toEqual({ hash: TRANSFER });
      // Observation only: the report admits observe and never another recovery.
      const report = journeyReport('recover-submit', {
        ...copy(ctx.report),
        scan: { sha256: NEWER_SCAN_SHA, anchor: { ...NEW_ANCHOR } },
        chain: copy(ctx.chain),
      });
      expect(() => m.assertPredecessor('observe', report, options)).not.toThrow();
      expect(() => m.assertPredecessor('recover-submit', report, options)).toThrow();
      // The journal itself now refuses any further recovery.
      const again = heldWorld({ mode: 'recover-submit', records: copy(state.records) });
      expect(await settle(m.RUNNERS['recover-submit'](again.ctx))).toEqual(
        refused('journal-unresolved')
      );
      expect(again.calls.submit).toEqual([]);
    }
    // The existing observe mode follows a journaled recovery of the transfer.
    const observed = observeWorld({ previousMode: 'recover-submit' });
    await m.RUNNERS.observe(observed.ctx);
    expect(observed.ctx.report).toMatchObject({
      passed: true,
      target: 'transfer',
      observedHash: TRANSFER,
    });
    // A refusal before the journal write is a value with its bounded diagnostic.
    const tuple = {
      stage: 'preflight',
      substage: 'acquire',
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
      reason: 'rpc',
      step: 'rootHistory',
      causeCode: 'TOR_REQUEST_FAILED',
    };
    const preflight = heldWorld({
      mode: 'recover-submit',
      submit: 'preflight',
      diagnostic: { ...tuple, message: 'secret /Users/someone', nullifier: NULLIFIER },
    });
    await m.RUNNERS['recover-submit'](preflight.ctx);
    expect(preflight.ctx.report.submission).toEqual({
      status: 'refused',
      stage: 'preflight',
      diagnostic: tuple,
      reviews: { disclosure: 1, transaction: 0 },
      elapsedMs: expect.any(Number),
    });
    expect(preflight.ctx.report.spend.submissionStatus).toBe('not-sent');
    expect(preflight.ctx.report.liveness.state).toBe('proved-unsent');
    expect(preflight.calls.sign).toBe(0);
    expect(m.assertAggregateReport(preflight.ctx.report)).toBe(true);
    expect(withoutSecrets(preflight.ctx.report)).toBe(true);
  },
  'recover-fee-plan': async (m) => {
    // Planning bound: 1,500,000 x 1,333,333,334 wei exceeds the cap before production.
    const planning = heldWorld({ mode: 'recover-submit', gasPrice: 1333333334n });
    expect(await settle(m.RUNNERS['recover-submit'](planning.ctx))).toEqual(refused('fee-cap'));
    expect(planning.ctx.stage).toBe('submitter');
    expect(planning.calls.submit).toEqual([]);
    // Planning passes (1.95e15); the held estimate x 5/4 at 1.3 gwei does not.
    const plan = heldWorld({ mode: 'recover-submit', gasPrice: 1300000000n });
    expect(await settle(m.RUNNERS['recover-submit'](plan.ctx))).toEqual(refused('fee-cap'));
    expect(plan.ctx.stage).toBe('fee-cap');
    expect(plan.calls.submit).toEqual([]);
    // A carried gas limit that is not the held estimate's 5/4 refuses.
    const carried = heldWorld({ mode: 'recover-submit' });
    carried.ctx.chain.heldTransfer.gasLimit = '1559209';
    expect(await settle(m.RUNNERS['recover-submit'](carried.ctx))).toEqual(refused('fee-plan'));
    expect(carried.calls.submit).toEqual([]);
  },
  // The one-use recovery ledger: reserved durably before any other work.
  'recover-ledger-ack': async (m) => {
    const { ctx, calls } = heldWorld({ mode: 'recover-submit' });
    await m.RUNNERS['recover-submit'](ctx);
    expect(ctx.report.passed).toBe(true);
    expect(calls.submit).toHaveLength(1);
    // Only the synced reservation precedes the account, POI, nullifier and EOA work.
    const work = calls.timeline.indexOf('identity-open');
    expect(calls.timeline.slice(0, work)).toEqual([
      'ledger-mkdir',
      'ledger-directory-synced',
      'ledger-create',
      'ledger-pending-synced',
      'ledger-directory-synced',
    ]);
    expect(calls.timeline.slice(work)).toEqual(
      expect.arrayContaining(['eth_getCode', 'eth_gasPrice', 'recover-submit', 'sign'])
    );
    expect(calls.timeline.at(-1)).toBe('ledger-finished-synced');
    // The profile's one allowance, named by no report digest.
    const file = m.recoveryLedgerPath(ctx.args.profile);
    expect(file).toBe(`${ctx.args.profile}.l-a-recovery-ledger/recover-submit.jsonl`);
    // A sibling of the profile; the profile itself gains nothing.
    expect(fs.readdirSync(path.dirname(ctx.args.profile)).sort()).toEqual([
      'profile',
      'profile.l-a-recovery-ledger',
    ]);
    expect(fs.readdirSync(ctx.args.profile)).toEqual([]);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['recover-submit.jsonl']);
    const [header, pending, finished, ...rest] = ledgerLines(file);
    expect(rest).toEqual([]);
    expect(header).toEqual({
      type: 'railgun-l-a-recovery-ledger',
      version: 1,
      journey: api.JOURNEY,
      chainId: 11155111,
      mode: 'recover-submit',
      budget: 1,
      profile: ctx.args.profile,
      profileId: 'test',
      heldTransferReportSha256: HELD_SHA,
    });
    expect(pending).toEqual({
      type: 'attempt-pending',
      attempt: 1,
      attemptId: expect.stringMatching(/^[0-9a-f]{32}$/),
      reservedAt: expect.any(String),
      pid: process.pid,
      output: ctx.args.output,
      probeReport: ctx.args.previousFile,
      binding: {
        heldTransferReportSha256: HELD_SHA,
        probeReportSha256: PROBE_SHA,
        probeObservedAt: PROBE_AT,
        scanReportSha256: NEWER_SCAN_SHA,
        scanAnchor: NEW_ANCHOR,
        sourceCommit: COMMIT,
        scriptSha256: SOURCES[QUALIFIER],
        sourcesSha256: digest(JSON.stringify(SOURCES)),
      },
    });
    expect(finished).toEqual({
      type: 'attempt-finished',
      attempt: 1,
      attemptId: pending.attemptId,
      finishedAt: expect.any(String),
      holdIdSha256: digest('railgun-l-a-recovery-hold-id\n' + HOLD_ID),
      outcome: {
        stage: 'journal-readback',
        failure: null,
        submission: 'acknowledged',
        spend: ctx.report.spend,
        passed: true,
      },
    });
    expect(m.readRecoveryLedger(fs, file, header)).toEqual({ pending, finished });
    expect(ctx.report.reservation).toEqual({
      ledger: 'profile-sibling',
      budget: 1,
      reservedBeforeAccountWork: true,
      finished: true,
    });
    // Local only, and still without a secret.
    expect(withoutSecrets(fs.readFileSync(file, 'utf8'))).toBe(true);
    expect(m.assertAggregateReport(ctx.report)).toBe(true);
    expect(withoutSecrets(ctx.report)).toBe(true);
    // A refusal inside the attempt is its finished outcome.
    const declined = heldWorld({ mode: 'recover-submit', signingRecords: 2 });
    expect(await settle(m.RUNNERS['recover-submit'](declined.ctx))).toEqual(refused('hold'));
    expect(declined.calls.timeline.at(-1)).toBe('ledger-finished-synced');
    expect(ledgerLines(m.recoveryLedgerPath(declined.ctx.args.profile))[2]).toMatchObject({
      holdIdSha256: null,
      outcome: {
        stage: 'hold',
        failure: { stage: 'hold', code: 'RAILGUN_LIVE_JOURNEY_REFUSED', step: 'hold' },
        submission: null,
        spend: { journaled: false, submissionStatus: 'not-sent' },
        passed: false,
      },
    });
    expect(declined.ctx.report.reservation.finished).toBe(true);
  },
  'recover-ledger-once': async (m) => {
    const first = heldWorld({ mode: 'recover-submit' });
    await m.RUNNERS['recover-submit'](first.ctx);
    expect(first.calls.submit).toHaveLength(1);
    const profile = first.ctx.args.profile;
    // Everything the profile's ledger directory holds, wherever a ledger lands in it.
    const directory = profile + '.l-a-recovery-ledger';
    const ledgers = () =>
      fs.existsSync(directory)
        ? fs
            .readdirSync(directory)
            .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
        : [];
    const recorded = ledgers();
    expect(recorded).toHaveLength(1);
    // Whatever probe, probe location or output a later invocation names.
    for (const [change, probeSha] of [
      [() => {}],
      [(args) => (args.output = '/w/recover-submit-' + PROBE_SHA + '-2')],
      [(args) => (args.output = '/elsewhere/recover-submit-' + PROBE_SHA)],
      [
        (args) => {
          args.previousFile = '/w/copied/probe-1/report.json';
          args.output = '/w/copied/recover-submit-' + PROBE_SHA;
        },
      ],
      [() => {}, sha('9d')],
    ]) {
      const again = heldWorld({ mode: 'recover-submit', profile, probeSha });
      change(again.ctx.args);
      expect(await settle(m.RUNNERS['recover-submit'](again.ctx))).toEqual(
        refused('recovery-attempted')
      );
      expect(again.ctx.stage).toBe('reservation');
      expect([again.calls.timeline, again.calls.loaded, again.calls.network]).toEqual([[], [], []]);
      expect(again.ctx.report.liveness.state).toBe('proved-unsent');
      expect(ledgers()).toEqual(recorded);
    }
    // A refused attempt spends the budget too: refused at preflight, before any send.
    const declined = heldWorld({ mode: 'recover-submit', submit: 'preflight' });
    await m.RUNNERS['recover-submit'](declined.ctx);
    expect(declined.calls.sign).toBe(0);
    const retry = heldWorld({ mode: 'recover-submit', profile: declined.ctx.args.profile });
    expect(await settle(m.RUNNERS['recover-submit'](retry.ctx))).toEqual(
      refused('recovery-attempted')
    );
    expect([retry.calls.timeline, retry.calls.submit]).toEqual([[], []]);
  },
  'recover-ledger-race': async (m) => {
    // Two invocations started together: one reserves, the other is refused
    // before it loads a module or makes a request.
    const profile = newProfile();
    const worlds = [0, 1].map(() => heldWorld({ mode: 'recover-submit', profile }));
    const outcomes = await Promise.all(
      worlds.map((world) => settle(m.RUNNERS['recover-submit'](world.ctx)))
    );
    expect(outcomes).toEqual([null, refused('recovery-attempted')]);
    expect(worlds[0].calls.submit).toHaveLength(1);
    const late = worlds[1].calls;
    expect([late.timeline, late.loaded, late.network]).toEqual([[], [], []]);
    // The race inside the reservation: a concurrent winner creates the ledger
    // after this invocation found none and before its exclusive create.
    const shared = newProfile();
    const winner = heldWorld({ mode: 'recover-submit', profile: shared });
    const loser = heldWorld({
      mode: 'recover-submit',
      profile: shared,
      ledger: { beforeCreate: () => m.reserveRecoveryAttempt(winner.ctx) },
    });
    expect(await settle(m.RUNNERS['recover-submit'](loser.ctx))).toEqual(
      refused('recovery-attempted')
    );
    expect(loser.calls.timeline).toEqual(['ledger-mkdir', 'ledger-directory-synced']);
    expect([loser.calls.loaded, loser.calls.network]).toEqual([[], []]);
    expect(winner.calls.timeline).toEqual([
      'ledger-create',
      'ledger-pending-synced',
      'ledger-directory-synced',
    ]);
    expect(ledgerLines(m.recoveryLedgerPath(shared))).toHaveLength(2);
  },
  'recover-ledger-interrupted': async (m) => {
    // A process that died after its reservation: pending, never finished.
    const crashed = heldWorld({ mode: 'recover-submit' });
    const reservation = m.reserveRecoveryAttempt(crashed.ctx);
    const pending = fs.readFileSync(reservation.file, 'utf8');
    const restart = heldWorld({ mode: 'recover-submit', profile: crashed.ctx.args.profile });
    expect(await settle(m.RUNNERS['recover-submit'](restart.ctx))).toEqual(
      refused('recovery-attempted')
    );
    expect([restart.calls.timeline, restart.calls.loaded, restart.calls.network]).toEqual([
      [],
      [],
      [],
    ]);
    // Never finished or repaired by a later run.
    expect(fs.readFileSync(reservation.file, 'utf8')).toBe(pending);
    expect(m.readRecoveryLedger(fs, reservation.file, reservation.header).finished).toBeNull();
    // A short reservation write refuses before any work, and the damage stays.
    const torn = heldWorld({
      mode: 'recover-submit',
      ledger: { write: (kind, ...rest) => (kind === 'wx' ? 0 : fs.writeSync(...rest)) },
    });
    expect(await settle(m.RUNNERS['recover-submit'](torn.ctx))).toEqual(refused('recovery-ledger'));
    expect(torn.calls.timeline).toEqual([
      'ledger-mkdir',
      'ledger-directory-synced',
      'ledger-create',
    ]);
    expect(torn.calls.loaded).toEqual([]);
    const afterTorn = heldWorld({ mode: 'recover-submit', profile: torn.ctx.args.profile });
    expect(await settle(m.RUNNERS['recover-submit'](afterTorn.ctx))).toEqual(
      refused('recovery-ledger')
    );
    expect(afterTorn.calls.loaded).toEqual([]);
    // An outcome that cannot be recorded leaves the attempt pending and fails the report.
    const unrecorded = heldWorld({
      mode: 'recover-submit',
      ledger: { write: (kind, ...rest) => (kind === 'a' ? 0 : fs.writeSync(...rest)) },
    });
    await m.RUNNERS['recover-submit'](unrecorded.ctx);
    expect(unrecorded.ctx.report.spend.submissionStatus).toBe('acknowledged');
    expect(unrecorded.ctx.report.reservation.finished).toBe(false);
    expect(unrecorded.ctx.report.passed).toBe(false);
    const unrecordedFile = m.recoveryLedgerPath(unrecorded.ctx.args.profile);
    expect(ledgerLines(unrecordedFile)).toHaveLength(2);
    const again = heldWorld({ mode: 'recover-submit', profile: unrecorded.ctx.args.profile });
    expect(await settle(m.RUNNERS['recover-submit'](again.ctx))).toEqual(
      refused('recovery-attempted')
    );
    expect(again.calls.submit).toEqual([]);
    // A ledger changed during the attempt is left as found, and fails the report.
    const swapped = heldWorld({ mode: 'recover-submit' });
    const swappedFile = m.recoveryLedgerPath(swapped.ctx.args.profile);
    const readJournal = swapped.ctx.readJournal;
    let foreign;
    swapped.ctx.readJournal = async () => {
      if (!foreign && fs.existsSync(swappedFile)) {
        const [header, entry] = ledgerLines(swappedFile);
        foreign = [header, { ...entry, attemptId: 'f'.repeat(32) }]
          .map((value) => JSON.stringify(value) + '\n')
          .join('');
        fs.writeFileSync(swappedFile, foreign);
      }
      return readJournal();
    };
    await m.RUNNERS['recover-submit'](swapped.ctx);
    expect(swapped.calls.submit).toHaveLength(1);
    expect(fs.readFileSync(swappedFile, 'utf8')).toBe(foreign);
    expect(swapped.ctx.report.reservation.finished).toBe(false);
    expect(swapped.ctx.report.passed).toBe(false);
  },
  'recover-ledger-damage': async (m) => {
    const line = (value) => JSON.stringify(value) + '\n';
    // Valid records of another profile's reservation, rebound to this profile.
    const reference = m.reserveRecoveryAttempt(heldWorld({ mode: 'recover-submit' }).ctx);
    const ledger = (profile) => {
      fs.mkdirSync(profile + '.l-a-recovery-ledger');
      const { header, pending } = reference;
      return {
        header: { ...header, profile },
        pending,
        done: { type: 'attempt-finished', attemptId: pending.attemptId, holdIdSha256: null },
      };
    };
    // Damaged, unbound or foreign ledgers refuse as damage, before any work.
    for (const damage of [
      () => '',
      () => 'not json\n',
      ({ pending }) => line(pending),
      ({ header }) => line(header),
      ({ header, pending }) => line({ ...header, profile: '/w/other/profile' }) + line(pending),
      ({ header, pending }) => line({ ...header, profileId: 'other' }) + line(pending),
      ({ header, pending }) => line({ ...header, budget: 2 }) + line(pending),
      ({ header, pending }) =>
        line(header) +
        line({ ...pending, binding: { ...pending.binding, heldTransferReportSha256: sha('9e') } }),
      ({ header, pending }) => line(header) + line({ ...pending, type: 'attempt-finished' }),
      ({ header, pending, done }) =>
        line(header) + line(pending) + line({ ...done, attemptId: 'f'.repeat(32) }),
      ({ header, pending, done }) => line(header) + line(pending) + line(done) + line(pending),
      ({ header, pending }) => line(header) + JSON.stringify(pending),
      // A finished record names its hold by a digest, or by none.
      ({ header, pending, done }) =>
        line(header) + line(pending) + line({ ...done, holdIdSha256: 'hold' }),
      ({ header, pending, done }) =>
        line(header) + line(pending) + line({ ...done, holdIdSha256: undefined }),
    ]) {
      const world = heldWorld({ mode: 'recover-submit' });
      const file = m.recoveryLedgerPath(world.ctx.args.profile);
      const text = damage(ledger(world.ctx.args.profile));
      fs.writeFileSync(file, text);
      expect(await settle(m.RUNNERS['recover-submit'](world.ctx))).toEqual(
        refused('recovery-ledger')
      );
      expect([world.calls.timeline, world.calls.loaded, world.calls.network]).toEqual([[], [], []]);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    }
    // A symlinked ledger is damage, even when it points at a valid one.
    const linked = heldWorld({ mode: 'recover-submit' });
    const target = newProfile() + '-ledger.jsonl';
    const { header, pending } = ledger(linked.ctx.args.profile);
    fs.writeFileSync(target, line(header) + line(pending));
    fs.symlinkSync(target, m.recoveryLedgerPath(linked.ctx.args.profile));
    expect(await settle(m.RUNNERS['recover-submit'](linked.ctx))).toEqual(
      refused('recovery-ledger')
    );
    expect(linked.calls.loaded).toEqual([]);
    // A symlinked ledger directory is refused and never written through.
    const redirected = heldWorld({ mode: 'recover-submit' });
    const elsewhere = path.join(path.dirname(newProfile()), 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, redirected.ctx.args.profile + '.l-a-recovery-ledger');
    expect(await settle(m.RUNNERS['recover-submit'](redirected.ctx))).toEqual(
      refused('recovery-ledger')
    );
    expect([redirected.calls.timeline, redirected.calls.loaded]).toEqual([[], []]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    // Also when it is swapped in after the admission read, before the reservation.
    const swappedIn = path.join(path.dirname(newProfile()), 'swapped-in');
    fs.mkdirSync(swappedIn);
    const swapped = heldWorld({
      mode: 'recover-submit',
      ledger: { beforeMkdir: (directory) => fs.symlinkSync(swappedIn, directory) },
    });
    expect(await settle(m.RUNNERS['recover-submit'](swapped.ctx))).toEqual(
      refused('recovery-ledger')
    );
    expect([swapped.calls.timeline, swapped.calls.loaded]).toEqual([[], []]);
    expect(fs.readdirSync(swappedIn)).toEqual([]);
  },
  'recover-ledger-binding': async (m) => {
    // A run without its complete binding reserves nothing and does nothing.
    for (const change of [
      (ctx) => (ctx.args.profile += '-missing'),
      (ctx) => {
        fs.symlinkSync(ctx.args.profile, ctx.args.profile + '-link');
        ctx.args.profile += '-link';
      },
      (ctx) => (ctx.args.profile += '/'),
      (ctx) => (ctx.args.profile = 'missing/profile'),
      (ctx) => delete ctx.fs,
      (ctx) => delete ctx.profileId,
      (ctx) => (ctx.chain.heldTransfer.reportSha256 = sha('9e')),
      (ctx) => (ctx.args.previousSha = sha('9d')),
      (ctx) => (ctx.args.scanSha = SCAN_SHA),
      (ctx) => (ctx.scan.anchor = { number: NEW_ANCHOR.number }),
      (ctx) => (ctx.previous = { ...ctx.previous, observedAt: undefined }),
      (ctx) => delete ctx.sourceCommit,
      (ctx) => delete ctx.report.sourceSha256[QUALIFIER],
    ]) {
      const { ctx, calls } = heldWorld({ mode: 'recover-submit' });
      const world = path.dirname(ctx.args.profile);
      change(ctx);
      expect(await settle(m.RUNNERS['recover-submit'](ctx))).toEqual(refused('recovery-binding'));
      expect([calls.timeline, calls.loaded, calls.network]).toEqual([[], [], []]);
      expect(fs.readdirSync(world).filter((name) => name.endsWith('-ledger'))).toEqual([]);
    }
  },
  // The allowance is the profile's, never a report digest's: another rendering of
  // the same hold, or a ledger minted under another pin, never adds a second one.
  'recover-ledger-campaign': async (m) => {
    // The operator's original held report, the only one the recovery modes admit.
    expect(m.HELD_TRANSFER_REPORT_SHA256).toBe(
      'd0d05c02c9303205f34382652737613932649a2bf4ecadd134cc8fc46489348c'
    );
    const RERENDERED = sha('d2');
    const line = (value) => JSON.stringify(value) + '\n';
    const campaign = (profile) => {
      const directory = profile + '.l-a-recovery-ledger';
      return fs.existsSync(directory)
        ? fs
            .readdirSync(directory)
            .map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')])
        : [];
    };
    const untouched = ({ calls }) =>
      expect([calls.timeline, calls.loaded, calls.network]).toEqual([[], [], []]);
    // A transport failure after the reservation and before any nullifier read
    // spends the allowance like every started attempt. The finished record names
    // the held operation by its hold id digest.
    const dropped = heldWorld({ mode: 'recover-submit' });
    dropped.ctx.network.request = async () => {
      throw Object.assign(Error('transport closed'), { code: 'ECONNRESET' });
    };
    expect(await settle(m.RUNNERS['recover-submit'](dropped.ctx))).toMatchObject({
      code: 'ECONNRESET',
    });
    expect([dropped.calls.submit, dropped.calls.preflights]).toEqual([[], []]);
    const profile = dropped.ctx.args.profile;
    const spent = campaign(profile);
    expect(spent.map(([name]) => name)).toEqual(['recover-submit.jsonl']);
    const [header, pending, finished] = ledgerLines(m.recoveryLedgerPath(profile));
    expect(finished).toMatchObject({
      holdIdSha256: digest('railgun-l-a-recovery-hold-id\n' + HOLD_ID),
      outcome: {
        stage: 'submitter',
        failure: { stage: 'submitter', code: 'ECONNRESET' },
        submission: null,
        passed: false,
      },
    });
    const retry = heldWorld({ mode: 'recover-submit', profile });
    expect(await settle(m.RUNNERS['recover-submit'](retry.ctx))).toEqual(
      refused('recovery-attempted')
    );
    untouched(retry);
    // Another rendering of the same hold has another digest: refused before the
    // reservation, on the spent profile and on a fresh one alike.
    const fresh = newProfile();
    for (const target of [profile, fresh]) {
      const other = heldWorld({ mode: 'recover-submit', profile: target });
      other.ctx.chain.heldTransfer.reportSha256 = RERENDERED;
      expectRefusal(() => m.assertRecoveryAdmissible(other.ctx), 'recovery-binding');
      expect(await settle(m.RUNNERS['recover-submit'](other.ctx))).toEqual(
        refused('recovery-binding')
      );
      untouched(other);
    }
    expect(campaign(profile)).toEqual(spent);
    expect(campaign(fresh)).toEqual([]);
    // A ledger minted for a profile under another pin is foreign: it refuses as
    // damage, and nothing is added beside it.
    const minted = heldWorld({ mode: 'recover-submit' });
    const mintedProfile = minted.ctx.args.profile;
    const repinned =
      line({ ...header, profile: mintedProfile, heldTransferReportSha256: RERENDERED }) +
      line({ ...pending, binding: { ...pending.binding, heldTransferReportSha256: RERENDERED } }) +
      line(finished);
    fs.mkdirSync(mintedProfile + '.l-a-recovery-ledger');
    fs.writeFileSync(m.recoveryLedgerPath(mintedProfile), repinned);
    expectRefusal(() => m.assertRecoveryAdmissible(minted.ctx), 'recovery-ledger');
    expect(await settle(m.RUNNERS['recover-submit'](minted.ctx))).toEqual(
      refused('recovery-ledger')
    );
    untouched(minted);
    expect(campaign(mintedProfile)).toEqual([['recover-submit.jsonl', repinned]]);
    // A valid ledger under a digest-keyed name, alone or beside the allowance, is
    // never read as an unspent campaign or as one allowance among several.
    const rebound = (target) =>
      line({ ...header, profile: target }) + line(pending) + line(finished);
    const keyed = `recover-submit-${HELD_SHA}.jsonl`;
    for (const names of [[keyed], ['recover-submit.jsonl', `recover-submit-${RERENDERED}.jsonl`]]) {
      const world = heldWorld({ mode: 'recover-submit' });
      const target = world.ctx.args.profile;
      fs.mkdirSync(target + '.l-a-recovery-ledger');
      for (const name of names)
        fs.writeFileSync(path.join(target + '.l-a-recovery-ledger', name), rebound(target));
      const before = campaign(target);
      expectRefusal(() => m.assertRecoveryAdmissible(world.ctx), 'recovery-ledger');
      expect(await settle(m.RUNNERS['recover-submit'](world.ctx))).toEqual(
        refused('recovery-ledger')
      );
      untouched(world);
      expect(campaign(target)).toEqual(before);
    }
  },
  // main()'s read-only admission: before unlock, Tor and the mode, it refuses a
  // spent, damaged or unbound campaign and creates nothing.
  'recover-ledger-admission': async (m) => {
    const source = m.main.toString();
    const order = [
      'assertPredecessor(mode, previous, {',
      '.initializeProfile(app, {',
      'ctx.profileId = profile.id;',
      "if (mode === 'recover-submit') {\n      ctx.stage = 'admission';\n      assertRecoveryAdmissible(ctx);",
      'await vault.unlockVault(',
      'await openLiveTransport(',
      'await RUNNERS[mode](ctx);',
    ].map((text) => {
      expect(source.split(text)).toHaveLength(2);
      return source.indexOf(text);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Unspent: no campaign yet, or an empty one. Admission creates nothing.
    const fresh = heldWorld({ mode: 'recover-submit' });
    const directory = fresh.ctx.args.profile + '.l-a-recovery-ledger';
    expect(m.assertRecoveryAdmissible(fresh.ctx)).toBeUndefined();
    expect(fs.existsSync(directory)).toBe(false);
    fs.mkdirSync(directory);
    expect(m.assertRecoveryAdmissible(fresh.ctx)).toBeUndefined();
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fresh.calls.timeline).toEqual([]);
    // Spent, even while pending: refused as attempted and left as found.
    const reservation = m.reserveRecoveryAttempt(fresh.ctx);
    const reserved = fs.readFileSync(reservation.file, 'utf8');
    const again = heldWorld({ mode: 'recover-submit', profile: fresh.ctx.args.profile });
    expectRefusal(() => m.assertRecoveryAdmissible(again.ctx), 'recovery-attempted');
    expect(fs.readFileSync(reservation.file, 'utf8')).toBe(reserved);
    // A damaged allowance, a symlinked campaign (even to an empty directory) and
    // an unreadable one refuse as damage; an unbound run refuses as unbound.
    const damaged = heldWorld({ mode: 'recover-submit' });
    fs.mkdirSync(damaged.ctx.args.profile + '.l-a-recovery-ledger');
    fs.writeFileSync(m.recoveryLedgerPath(damaged.ctx.args.profile), '');
    expectRefusal(() => m.assertRecoveryAdmissible(damaged.ctx), 'recovery-ledger');
    const linked = heldWorld({ mode: 'recover-submit' });
    const elsewhere = path.join(path.dirname(linked.ctx.args.profile), 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, linked.ctx.args.profile + '.l-a-recovery-ledger');
    expectRefusal(() => m.assertRecoveryAdmissible(linked.ctx), 'recovery-ledger');
    const unreadable = heldWorld({
      mode: 'recover-submit',
      ledger: {
        lstat: (file) => {
          if (file.endsWith('.l-a-recovery-ledger'))
            throw Object.assign(Error('unreadable'), { code: 'EIO' });
          return fs.lstatSync(file);
        },
      },
    });
    expectRefusal(() => m.assertRecoveryAdmissible(unreadable.ctx), 'recovery-ledger');
    const unbound = heldWorld({ mode: 'recover-submit' });
    delete unbound.ctx.profileId;
    expectRefusal(() => m.assertRecoveryAdmissible(unbound.ctx), 'recovery-binding');
    // A create that fails for another reason refuses as damage and writes
    // nothing: the reservation never completed, so the empty campaign is unspent.
    const denied = heldWorld({
      mode: 'recover-submit',
      ledger: {
        beforeCreate: () => {
          throw Object.assign(Error('denied'), { code: 'EACCES' });
        },
      },
    });
    expect(await settle(m.RUNNERS['recover-submit'](denied.ctx))).toEqual(
      refused('recovery-ledger')
    );
    expect(denied.calls.timeline).toEqual(['ledger-mkdir', 'ledger-directory-synced']);
    expect(denied.calls.loaded).toEqual([]);
    expect(fs.readdirSync(denied.ctx.args.profile + '.l-a-recovery-ledger')).toEqual([]);
    expect(m.assertRecoveryAdmissible(denied.ctx)).toBeUndefined();
  },
  // main() refuses another held report digest before the profile, the campaign,
  // the reservation and any network work.
  'recover-held-pin-main': async (m) => {
    const profile = newProfile();
    const world = path.dirname(profile);
    MAIN_ENTERED.length = 0;
    const run = async (heldSha) => {
      const directory = fs.mkdtempSync(path.join(world, 'run-'));
      const write = (file, value) => {
        fs.mkdirSync(path.dirname(file));
        const text = JSON.stringify(value);
        fs.writeFileSync(file, text);
        return digest(text);
      };
      const scanFile = path.join(directory, 'scan', 'report.json');
      const scanSha = write(
        scanFile,
        scanReport(NEW_ANCHOR.number, { sourceSha256: { [QUALIFIER]: sha('5c') } })
      );
      const previousFile = path.join(directory, 'probe-1', 'report.json');
      const previousSha = write(
        previousFile,
        probeReport({
          observedAt: new Date().toISOString(),
          scan: { sha256: scanSha, anchor: { ...NEW_ANCHOR } },
          chain: heldChain({
            heldTransfer: { reportSha256: heldSha, estimate: '1247366', gasLimit: '1559208' },
          }),
        })
      );
      const output = path.join(directory, 'recover-submit-' + previousSha);
      process.argv = [
        'electron',
        SCRIPT,
        'recover-submit',
        '/w/engine.asar',
        '/w/prover.asar',
        '/w/artifacts',
        profile,
        scanFile,
        scanSha,
        previousFile,
        previousSha,
        output,
      ];
      expect(await m.main()).toBe(1);
      return JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    };
    const saved = {
      argv: process.argv,
      tor: process.env.FREEDOM_WALLET_TOR_EXPERIMENT,
      identity: process.env.FREEDOM_IDENTITY_DATA,
    };
    const restore = (key, value) =>
      value === undefined ? delete process.env[key] : (process.env[key] = value);
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    for (const [name, factory] of MAIN_MOCKS) jest.doMock(name, factory);
    try {
      process.env.FREEDOM_WALLET_TOR_EXPERIMENT = '1';
      delete process.env.FREEDOM_IDENTITY_DATA;
      const other = await run(sha('d2'));
      expect(other.failure).toEqual({
        stage: 'preconditions',
        code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
        step: 'predecessor-held',
      });
      expect(other.reservation).toBeUndefined();
      // The pinned digest passes that check and is refused at the next one.
      const pinned = await run(HELD_SHA);
      expect(pinned.failure).toEqual({
        stage: 'preconditions',
        code: 'RAILGUN_LIVE_JOURNEY_REFUSED',
        step: 'scan-sources',
      });
      // No Electron readiness, profile, lock, vault or Tor transport was reached.
      expect(MAIN_ENTERED).toEqual([]);
      expect(fs.readdirSync(profile)).toEqual([]);
      expect(fs.existsSync(profile + '.l-a-recovery-ledger')).toBe(false);
    } finally {
      for (const [name] of MAIN_MOCKS) jest.dontMock(name);
      quiet.mockRestore();
      process.argv = saved.argv;
      restore('FREEDOM_WALLET_TOR_EXPERIMENT', saved.tor);
      restore('FREEDOM_IDENTITY_DATA', saved.identity);
    }
  },
};

describe('live wiring with injected production fakes', () => {
  test.each(Object.keys(PROBES))('%s', async (name) => {
    await PROBES[name](api);
  });
});

// Reproducible source controls: each row must make its probe fail. Each row's
// source text must occur exactly `count` times, so the table tracks the script.
const SCRIPT = path.join(__dirname, 'qualify-railgun-private-live.js');
const MUTATIONS = [
  [
    'fee cap boundary',
    "check(value.exposure <= cap, 'fee-cap');",
    "check(value.exposure < cap, 'fee-cap');",
    'fee-boundary',
  ],
  [
    'gas ceiling removed',
    "check(value.gasLimit <= GAS_LIMIT_CEILING, 'gas-ceiling');",
    'void 0;',
    'fee-boundary',
  ],
  ['fee shape removed', "check(eip1559 !== legacy, 'fee-shape');", 'void 0;', 'fee-boundary'],
  [
    'headroom not rounded up',
    '(value * numerator + denominator - 1n) / denominator',
    '(value * numerator) / denominator',
    'headroom',
  ],
  [
    'review gas limit unbound',
    "check(value.gasLimit === BigInt(gasLimit), 'fee-gas-limit');",
    'void 0;',
    'review-fee-pure',
  ],
  [
    'unjournaled hash accepted',
    "check(reported === null, 'spend-unjournaled');",
    'void 0;',
    'classify',
  ],
  [
    'resend allowed',
    'never resent.\n    resendAllowed: false,',
    'never resent.\n    resendAllowed: true,',
    'classify',
  ],
  [
    'unresolved journal accepted',
    'snapshot.records.every((record) => !!record?.resolution)',
    'true',
    'uncertain-blocks',
  ],
  [
    'forbidden keys ignored',
    "check(!FORBIDDEN_KEYS.has(name), 'report-redaction');",
    'void 0;',
    'redaction-keys',
  ],
  ['instanceId key dropped', "  'instanceId',\n", '', 'redaction-keys'],
  ['random key dropped', "  'random',\n", '', 'redaction-keys'],
  [
    'only 64-hex runs checked',
    'if (/[0-9a-fA-F]{32,}/.test(value))',
    'if (/[0-9a-fA-F]{64,}/.test(value))',
    'redaction-hex',
  ],
  [
    'any key may hold a 32-byte hash',
    'if (HASH.test(value)) return PUBLIC_HASH_KEYS.has(key);',
    'if (HASH.test(value)) return true;',
    'redaction-hex',
  ],
  [
    'any key may hold an address',
    'if (ADDRESS.test(value)) return ADDRESS_KEYS.has(key);',
    'if (ADDRESS.test(value)) return true;',
    'redaction-hex',
  ],
  [
    'status repeats after Valid',
    "check(previous.poi?.allValid !== true, 'predecessor-valid');",
    'void 0;',
    'mode-order',
  ],
  [
    'check-unshield without Valid',
    "check(validPoiStatus(previous.poi), 'predecessor-poi');",
    'void 0;',
    'mode-order',
  ],
  [
    'unshield unbound to status report',
    "check(SHA256.test(previous.chain.outputPoi?.reportSha256), 'predecessor-poi');",
    'void 0;',
    'mode-order',
  ],
  [
    'unshield without bound Valid',
    "check(validPoiStatus(previous.chain.outputPoi), 'predecessor-poi');",
    'void 0;',
    'mode-order',
  ],
  [
    'observe without journaled spend',
    "check(previous.spend?.journaled === true, 'predecessor');",
    'void 0;',
    'mode-order',
  ],
  [
    'observe after resolution',
    "check(!previous.resolved, 'predecessor-resolved');",
    'void 0;',
    'mode-order',
  ],
  [
    'D2 without matched transfer',
    "check(previous.resolved?.outcome === 'matched', 'predecessor-unresolved');",
    'void 0;',
    'mode-order',
  ],
  [
    'recover without attempt',
    "check(previous.poiSubmission?.attempted === true, 'predecessor');",
    'void 0;',
    'mode-order',
  ],
  [
    'recover without completed attempt',
    "check(previous.poiSubmission.attemptCompleted === true, 'predecessor');",
    'void 0;',
    'mode-order',
  ],
  [
    'scan order ignored',
    "check(notOlder && afterTransfer, 'predecessor-scan');",
    'void 0;',
    'mode-order',
    5,
  ],
  [
    'D1 unbound to scan',
    "check(report.scanReportSha256 === scanSha, 'predecessor-scan');",
    'void 0;',
    'owned-poi',
  ],
  [
    'source key set unchecked',
    "check(same(Object.keys(previous).sort(), Object.keys(actual).sort()), 'sources');",
    'void 0;',
    'sources',
  ],
  [
    'output inside profile',
    "check(inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside), 'output');",
    'void 0;',
    'arguments',
  ],
  [
    'subdirectories not pinned',
    'if (!/^__.*__$/.test(entry.name)) visit(name);',
    'void 0;',
    'source-listing',
  ],
  [
    'ethers not bound to the lock',
    "check(lock?.packages?.['node_modules/ethers']?.version === installed.version, 'dependencies');",
    'void 0;',
    'dependency',
  ],
  [
    'Kohaku adapter not bound to the lock',
    'locked?.version === adapter.version &&',
    '',
    'dependency',
  ],
  [
    'Kohaku adapter integrity unchecked',
    '/^sha512-[A-Za-z0-9+/]{86}==$/.test(locked.integrity)',
    'true',
    'dependency',
  ],
  [
    'Shield note selection loosened',
    "check(notes.length === 1 && notes[0].spentTxid === false && wethNote(notes[0]), 'input');",
    "check(notes.length >= 1, 'input');",
    'shield-input',
  ],
  [
    'Shield note type unchecked',
    "check(record?.type === 'Shield' && lower(record.txid) === shieldTransactionHash, 'input');",
    'void 0;',
    'shield-input',
  ],
  ['note ceiling unchecked', 'note.amount <= MAX_AMOUNT', 'true', 'shield-input'],
  [
    'planning fee check removed',
    'const planning = planningFeeCheck(quote.gasPrice);',
    'const planning = { gasPrice: quote.gasPrice };',
    'spend-planning',
  ],
  [
    'submission plan removed',
    'const fee = planSubmissionFee({ estimate, gasPrice: ctx.quotedGasPrice });',
    'const fee = { gasLimit: gasLimitFromEstimate(estimate).toString() };',
    'spend-plan',
  ],
  [
    'review fee recheck removed',
    'report.fee.reviewed = reviewedFee(actual, fee.gasLimit);',
    'report.fee.reviewed = null;',
    'spend-review-fee',
  ],
  [
    'review count guard removed',
    "check(++reviews === 1, 'review-repeated');",
    '++reviews;',
    'spend-review-once',
  ],
  ['maxGasFee raised', 'maxGasFee: FEE_CAP_WEI,', 'maxGasFee: FEE_CAP_WEI * 2n,', 'spend-transfer'],
  [
    'post-proof fee quote added',
    "const estimate = (await ctx.network.request(CHAIN_ID, 'eth_estimateGas', [rpcTx])).result;",
    "const estimate = (await ctx.network.request(CHAIN_ID, 'eth_estimateGas', [rpcTx])).result;\n  await ctx.network.getFeeQuote(CHAIN_ID);",
    'spend-transfer',
  ],
  [
    'transfer recipient changed',
    "const recipient = step === 'transfer' ? ctx.identity.descriptor.instanceId : ctx.owner;",
    "const recipient = step === 'transfer' ? '0zk1other' : ctx.owner;",
    'spend-transfer',
  ],
  [
    'unshield recipient changed',
    "const recipient = step === 'transfer' ? ctx.identity.descriptor.instanceId : ctx.owner;",
    "const recipient = step === 'transfer' ? ctx.identity.descriptor.instanceId : '0x' + '11'.repeat(20);",
    'spend-unshield',
  ],
  [
    'spend admission skipped',
    'assertSpendAdmission(before, step, ctx.chain);',
    'void 0;',
    'spend-admission',
  ],
  [
    'D2 journal settlement skipped',
    'assertTransferSettled(snapshot, ctx.chain);',
    'void 0;',
    'poi-admission',
  ],
  [
    'journal readback replaced',
    'after: await ctx.readJournal()',
    'after: before',
    'spend-readback',
  ],
  [
    'diagnostic values unchecked',
    "if (typeof item === 'string' && pattern.test(item) && !/[0-9a-fA-F]{16}/.test(item))",
    'if (item !== undefined)',
    'spend-preflight-diagnostic',
  ],
  [
    'diagnostic keys unrestricted',
    'for (const [key, pattern] of Object.entries(DIAGNOSTIC_KEYS)) {',
    'for (const [key, pattern] of Object.keys(value).map((name) => [name, /[^]*/])) {',
    'spend-preflight-diagnostic',
  ],
  [
    'diagnostic read failure blocks readback',
    "ctx.load('wallet/railgun-private-submission').getRailgunPrivateSubmissionDiagnostic(result)\n    );\n  } catch {\n    return null;\n  }",
    "ctx.load('wallet/railgun-private-submission').getRailgunPrivateSubmissionDiagnostic(result)\n    );\n  } finally {\n    void 0;\n  }",
    'spend-preflight-diagnostic',
  ],
  [
    'diagnostic on a send',
    "...(status === 'refused' ? { diagnostic: readSubmissionDiagnostic(ctx, result) } : {}),",
    '...{ diagnostic: readSubmissionDiagnostic(ctx, result) },',
    'spend-preflight-diagnostic',
  ],
  [
    'hold not reported',
    "if (typeof proved.holdId === 'string') onHold();",
    'void 0;',
    'spend-plan',
  ],
  [
    'D2 failure classified as delivered',
    "response?.classification === 'rpc-result' &&",
    '',
    'poi-classification',
  ],
  [
    'attempted POI entry resent',
    "check(existing[0]?.state !== 'attempted', 'poi-attempted');",
    'void 0;',
    'poi-attempted',
  ],
  [
    'resolution before 12 confirmations',
    'report.observation.confirmations >= MIN_CONFIRMATIONS;',
    'report.observation.confirmations >= 0;',
    'observe-runner',
  ],
  [
    'resolution before finality',
    'if (BigInt(finalized.number) >= BigInt(report.observation.blockNumber)) {',
    'if (true) {',
    'observe-runner',
  ],
  [
    'resolution confirmations lowered',
    'await ctx.recovery.resolve(hash, {\n          minimumConfirmations: MIN_CONFIRMATIONS,',
    'await ctx.recovery.resolve(hash, {\n          minimumConfirmations: 3,',
    'observe-runner',
  ],
  [
    'unshield amount unchecked at resolution',
    "check(transact.output.amount === expectedAmount, 'resolution');",
    'void 0;',
    'observe-runner',
  ],
  [
    'unshield recipient unchecked at resolution',
    "check(lower(transact.output.recipient) === ctx.owner, 'resolution');",
    'void 0;',
    'observe-runner',
  ],
  // Held-transfer recovery: predecessor binding.
  [
    'held report digest unpinned',
    "check(previousSha === HELD_TRANSFER_REPORT_SHA256, 'predecessor-held');",
    'void 0;',
    'held-predecessor',
  ],
  [
    'held report liveness unchecked',
    "previous.liveness?.state === 'proved-unsent' && previous.liveness.inputHeld === true,",
    'true,',
    'held-predecessor',
  ],
  [
    'held fee plan unchecked',
    "check(plan.gasLimit === gasLimitFromEstimate(plan.estimate).toString(), 'predecessor-held');",
    'void 0;',
    'held-predecessor',
  ],
  [
    'hold-time scan accepted',
    'scanSha !== previous.scan?.sha256 && anchor > previous.scan?.anchor?.number,',
    'true,',
    'held-predecessor',
  ],
  [
    'recovery without a passed preflight',
    'previous.preflight?.passed === true && previous.preflight.acquireCalls === 1,',
    'true,',
    'recover-predecessor',
  ],
  [
    'recovery without unchanged immutables',
    "check(previous.immutables?.unchanged === true, 'predecessor');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'recovery after a journaled transfer',
    "check(previous.chain.transfer === null, 'predecessor');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'probe report accepted by observe without a passed preflight',
    "check(previous.passed === true && previous.preflight?.passed === true, 'predecessor');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'held proof runtime unchecked',
    'assertSameRuntime(proof(previous), proof(actual));',
    'void 0;',
    'proof-runtime',
  ],
  [
    'probe digest not carried',
    'chain.heldTransfer = { ...chain.heldTransfer, probeReportSha256: previousSha };',
    'void 0;',
    'held-chain',
  ],
  // One recover-submit per fresh, passed probe.
  [
    'recover-submit output name unbound to the probe',
    'path.basename(output) === `recover-submit-${previousSha}` &&',
    'true &&',
    'recover-output',
  ],
  [
    'recover-submit output outside the probe directory',
    'path.dirname(output) === path.dirname(path.dirname(previousFile)),',
    'true,',
    'recover-output',
  ],
  [
    'refused probe result admits recovery',
    "check(previous.result === 'preflight-passed', 'predecessor-preflight');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'refused probe result observed',
    "check(previous.result === 'preflight-passed', 'predecessor');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'stale probe admitted',
    "check(probeFresh(previous.observedAt, now), 'predecessor-stale');",
    'void 0;',
    'recover-predecessor',
  ],
  [
    'probe age bound exclusive',
    'now - at <= PROBE_MAX_AGE_MS',
    'now - at < PROBE_MAX_AGE_MS',
    'recover-predecessor',
  ],
  [
    'probe age bound raised',
    'now - at <= PROBE_MAX_AGE_MS',
    'now - at <= PROBE_MAX_AGE_MS * 2',
    'recover-predecessor',
  ],
  ['future probe admitted', 'at <= now &&', 'true &&', 'recover-predecessor'],
  [
    'non-canonical probe time admitted',
    'new Date(at).toISOString() === observedAt &&',
    'true &&',
    'recover-predecessor',
  ],
  // Held journal and hold.
  [
    'held journal admission skipped',
    "assertSpendAdmission(snapshot, 'transfer', chain);",
    'void 0;',
    'recover-admission',
  ],
  [
    'held nullifier journal rule removed',
    'record.intent.tree === selection.tree &&',
    'false &&',
    'held-unjournaled',
  ],
  [
    'more than one signing record accepted',
    "check(Array.isArray(records) && records.length === 1, 'hold');",
    'void 0;',
    'probe-hold',
  ],
  [
    'hold without original signature accepted',
    "check(!!stored.signature && plainObject(stored.provedTransaction), 'hold-signature');",
    'void 0;',
    'probe-hold',
  ],
  [
    'hold recipient unchecked',
    "check(selection.recipient === ctx.identity.descriptor.instanceId, 'hold-recipient');",
    'void 0;',
    'probe-hold',
  ],
  [
    'foreign hold accepted',
    "check(!Object.hasOwn(selection, 'recipientRelationship'), 'hold-recipient');",
    'void 0;',
    'probe-hold',
  ],
  [
    'hold submitter unchecked',
    "check(lower(entry.signing?.submitter) === ctx.owner, 'hold');",
    'void 0;',
    'probe-hold',
  ],
  [
    'held proved target unchecked',
    "check(lower(stored.provedTransaction.to) === pins.proxy, 'hold');",
    'void 0;',
    'probe-hold',
  ],
  [
    'held capsule kind unchecked',
    'selection.kind === SPEND_KINDS.transfer && entry.facts.kind === SPEND_KINDS.transfer,',
    'entry.facts.kind === SPEND_KINDS.transfer,',
    'probe-hold',
  ],
  [
    'held facts kind unchecked',
    'selection.kind === SPEND_KINDS.transfer && entry.facts.kind === SPEND_KINDS.transfer,',
    'selection.kind === SPEND_KINDS.transfer,',
    'probe-hold',
  ],
  [
    'held facts tree unbound to the capsule',
    'entry.facts.tree === selection.tree && entry.facts.nullifier === preparation.expected.nullifier,',
    'entry.facts.nullifier === preparation.expected.nullifier,',
    'probe-hold',
  ],
  [
    'held facts nullifier unbound to the capsule',
    'entry.facts.tree === selection.tree && entry.facts.nullifier === preparation.expected.nullifier,',
    'entry.facts.tree === selection.tree,',
    'probe-hold',
  ],
  [
    'hold id shape unchecked',
    "SHA256.test(entry.id) && stored?.holdId === entry.id && entry.state === 'signing'",
    "stored?.holdId === entry.id && entry.state === 'signing'",
    'probe-hold',
  ],
  [
    'capsule hold id unbound',
    "SHA256.test(entry.id) && stored?.holdId === entry.id && entry.state === 'signing'",
    "SHA256.test(entry.id) && entry.state === 'signing'",
    'probe-hold',
  ],
  [
    'hold signing state unchecked',
    "SHA256.test(entry.id) && stored?.holdId === entry.id && entry.state === 'signing'",
    'SHA256.test(entry.id) && stored?.holdId === entry.id',
    'probe-hold',
  ],
  // Preflight binding: original proof inputs, current completed checkpoint.
  [
    'checkpoint unbound to the scan',
    'same(checkpoint.to, ctx.status.to) && same(checkpoint.to, ctx.scan.anchor),',
    'true,',
    'probe-binding-runner',
  ],
  [
    'builder uses the hold-time checkpoint',
    'checkpointHash: current.checkpointHash,',
    'checkpointHash: entry.facts.checkpointHash,',
    'preflight-binding',
  ],
  [
    'builder uses the hold-time block',
    'minimumBlock: current.minimumBlock,',
    'minimumBlock: holdAnchor,',
    'preflight-binding',
  ],
  [
    'checkpoint hash unbound to the current checkpoint',
    "check(input.checkpointHash === current.checkpointHash, 'preflight-binding');",
    'void 0;',
    'preflight-binding',
  ],
  [
    'minimum block unbound to the current checkpoint',
    "check(input.minimumBlock === current.minimumBlock, 'preflight-binding');",
    'void 0;',
    'preflight-binding',
  ],
  [
    'hold-time checkpoint hash accepted',
    "check(input.checkpointHash !== entry.facts.checkpointHash, 'preflight-binding');",
    'void 0;',
    'preflight-binding',
  ],
  [
    'hold-time block accepted',
    "check(Number.isSafeInteger(holdAnchor) && input.minimumBlock > holdAnchor, 'preflight-binding');",
    'void 0;',
    'preflight-binding',
  ],
  // The one preflight, its diagnostic and its disclosure.
  [
    'preflight retried',
    'acquired = await preflight.acquire();',
    'acquired = await preflight.acquire().catch(() => preflight.acquire());',
    'probe-refusals',
  ],
  [
    'observation for another input accepted',
    "check(same(observed.input, input), 'preflight-input');",
    'void 0;',
    'probe-refusals',
  ],
  [
    'probe diagnostic dropped',
    'diagnostic = readPreflightDiagnostic(ctx, substage, error);',
    'diagnostic = null;',
    'probe-refusals',
  ],
  [
    'probe acquisition timer removed',
    'const timer = setTimeout(stop, PREFLIGHT_MS);',
    'const timer = setTimeout(() => {}, PREFLIGHT_MS);',
    'probe-timer',
  ],
  [
    'probe acquisition timer lengthened',
    'const PREFLIGHT_MS = 20000;',
    'const PREFLIGHT_MS = 20001;',
    'probe-timer',
  ],
  [
    'probe acquisition timer shortened',
    'const PREFLIGHT_MS = 20000;',
    'const PREFLIGHT_MS = 19999;',
    'probe-timer',
  ],
  [
    'probe ignores the end of its recovery phase',
    "signal.addEventListener('abort', stop, { once: true });",
    'void 0;',
    'probe-abort',
  ],
  [
    'probe opens in an ended recovery phase',
    "check(!signal.aborted, 'preflight');",
    'void 0;',
    'probe-abort',
  ],
  [
    'probe scope dropped',
    'report.scope = JSON.parse(JSON.stringify(PROBE_SCOPE));',
    'void 0;',
    'probe-pass',
  ],
  [
    'probe result reported before completion',
    "report.result = 'not-completed';",
    "report.result = 'preflight-passed';",
    'probe-immutables',
  ],
  [
    'probe result ignores the preflight',
    "report.preflight.passed === true ? 'preflight-passed' : 'preflight-refused';",
    "'preflight-passed';",
    'probe-refusals',
  ],
  [
    'nullifier query reported after an earlier refusal',
    "if (diagnostic?.substage === 'open' || BEFORE_NULLIFIER.includes(diagnostic?.step))",
    "if (diagnostic?.substage === 'open')",
    'probe-refusals',
  ],
  [
    'possible nullifier query reported as none',
    "return diagnostic.reason === 'mismatch' ? 'queried' : 'possibly-queried';",
    "return 'not-queried';",
    'probe-refusals',
  ],
  // Immutable facts after the probe.
  [
    'changed immutables accepted',
    "check(changed.length === 0, 'immutables');",
    'void 0;',
    'probe-immutables',
  ],
  [
    'immutables never compared',
    '(name) => !same(parts.before[name], parts.after[name])',
    '() => false',
    'probe-immutables',
  ],
  ['hold not read again', 'held: reread,', 'held,', 'probe-immutables'],
  [
    'journal not read again',
    'journal: await ctx.readJournal(),',
    'journal: before,',
    'probe-immutables',
  ],
  // Recovered submission: disclosure review and transaction review policy.
  [
    'new spending signature accepted',
    'summary.originalSpendingSignatureReused === true && summary.newSpendingSignature === false,',
    'true,',
    'recover-disclosure',
  ],
  [
    'disclosure exposures unpinned',
    "check(same(summary.exposures, RECOVERY_EXPOSURES), 'disclosure-review');",
    'void 0;',
    'recover-disclosure',
  ],
  [
    'disclosure RPC destinations unchecked',
    "check(origin(summary.destinations[key]) === rpc, 'disclosure-review');",
    'void 0;',
    'recover-disclosure',
  ],
  [
    'disclosure POI destination unchecked',
    'summary.destinations.poi === POI_ORIGIN && summary.destinations.txid === POI_ORIGIN,',
    'true,',
    'recover-disclosure',
  ],
  [
    'disclosure recipient unchecked',
    "check(summary.recipient === ctx.identity.descriptor.instanceId, 'disclosure-review');",
    'void 0;',
    'recover-disclosure',
  ],
  [
    'disclosure review repeated',
    "check(++reviews.disclosure === 1, 'review-repeated');",
    '++reviews.disclosure;',
    'recover-disclosure',
  ],
  [
    'recovered review repeated',
    "check(++reviews.transaction === 1, 'review-repeated');",
    '++reviews.transaction;',
    'recover-review',
  ],
  [
    'recovered calldata unbound',
    "check(actual.data === held.stored.provedTransaction.data, 'review-calldata');",
    'void 0;',
    'recover-review',
  ],
  [
    'recovered review fee recheck removed',
    'return reviewedFee(actual, fee.gasLimit);',
    'return null;',
    'recover-review',
  ],
  [
    'recovered maxGasFee raised',
    'const maxGasFee = FEE_CAP_WEI;',
    'const maxGasFee = FEE_CAP_WEI * 2n;',
    'recover-ack',
  ],
  [
    'recovered fee plan removed',
    'const fee = planSubmissionFee({\n    estimate: ctx.chain.heldTransfer.estimate,',
    'const fee = (({ estimate }) => ({ gasLimit: gasLimitFromEstimate(estimate).toString() }))({\n    estimate: ctx.chain.heldTransfer.estimate,',
    'recover-fee-plan',
  ],
  [
    'carried gas limit unchecked',
    "check(fee.gasLimit === ctx.chain.heldTransfer.gasLimit, 'fee-plan');",
    'void 0;',
    'recover-fee-plan',
  ],
  [
    'recovered send not chained',
    'if (report.spend.journaled) ctx.chain.transfer = { hash: report.spend.journaledHash };',
    'void 0;',
    'recover-uncertain',
  ],
  [
    'recovered send not observable',
    "if (['recover-submit', 'preflight-probe'].includes(previous.mode)) return 'transfer';",
    '',
    'recover-uncertain',
  ],
  [
    'recovery hold not reported',
    'report.liveness = describeLiveness({ holdCreated: true, spend: report.spend });',
    'report.liveness = describeLiveness({ holdCreated: false, spend: report.spend });',
    'recover-ack',
  ],
  // The one-use recovery ledger.
  [
    'recovery attempt not reserved',
    'reservation = reserveRecoveryAttempt(ctx);',
    'void 0;',
    'recover-ledger-once',
  ],
  [
    'recovery reserved after the attempt',
    'reservation = reserveRecoveryAttempt(ctx);\n' +
      '      report.reservation = {\n' +
      "        ledger: 'profile-sibling',\n" +
      '        budget: 1,\n' +
      '        reservedBeforeAccountWork: true,\n' +
      '        finished: false,\n' +
      '      };\n' +
      '      await recoverSubmit(ctx);',
    'await recoverSubmit(ctx);\n' +
      '      reservation = reserveRecoveryAttempt(ctx);\n' +
      "      report.reservation = { ledger: 'profile-sibling', finished: false };",
    'recover-ledger-ack',
  ],
  [
    'recovery ledger keyed by the probe',
    'const file = recoveryLedgerPath(profile);',
    'const file = recoveryLedgerPath(profile) + ctx.args.previousSha;',
    'recover-ledger-once',
  ],
  [
    'recovery ledger keyed by the output',
    'const file = recoveryLedgerPath(profile);',
    'const file = recoveryLedgerPath(profile) + path.basename(ctx.args.output);',
    'recover-ledger-once',
  ],
  [
    'recovery ledger created without exclusion',
    "fd = fsImpl.openSync(file, 'wx', 0o600);",
    "fd = fsImpl.openSync(file, 'w', 0o600);",
    'recover-ledger-race',
  ],
  [
    'failed create appended to',
    "    throw refusal('recovery-ledger');\n  }\n  try {\n    const bytes",
    "    fd = fsImpl.openSync(file, 'a');\n  }\n  try {\n    const bytes",
    'recover-ledger-admission',
  ],
  [
    'existing recovery ledger not validated',
    "  readRecoveryLedger(fsImpl, file, header);\n  throw refusal('recovery-attempted');",
    "  throw refusal('recovery-attempted');",
    'recover-ledger-damage',
  ],
  // The profile campaign: one allowance, named by no report digest.
  [
    'held report pin re-pointed',
    "'d0d05c02c9303205f34382652737613932649a2bf4ecadd134cc8fc46489348c'",
    "'d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2'",
    'recover-ledger-campaign',
  ],
  [
    'recovery allowance keyed by the held report',
    'path.join(`${profile}.l-a-recovery-ledger`, RECOVERY_ALLOWANCE)',
    'path.join(`${profile}.l-a-recovery-ledger`, `recover-submit-${HELD_TRANSFER_REPORT_SHA256}.jsonl`)',
    'recover-ledger-ack',
  ],
  [
    'entries beside the allowance admitted',
    "check(names.length === 1 && names[0] === path.basename(file), 'recovery-ledger');",
    'void 0;',
    'recover-ledger-campaign',
  ],
  [
    'spent allowance read as unspent',
    "  readRecoveryLedger(fsImpl, file, header);\n  throw refusal('recovery-attempted');",
    '  readRecoveryLedger(fsImpl, file, header);',
    'recover-ledger-once',
  ],
  [
    'reservation without the campaign read',
    '  assertRecoveryUnspent(fsImpl, file, header);\n  return { fsImpl, binding, header, file };',
    '  return { fsImpl, binding, header, file };',
    'recover-ledger-admission',
  ],
  [
    'lost create race read as damage',
    "    assertRecoveryUnspent(fsImpl, file, header);\n    throw refusal('recovery-ledger');",
    "    throw refusal('recovery-ledger');",
    'recover-ledger-race',
  ],
  [
    'symlinked campaign followed at admission',
    "  check(stat.isDirectory(), 'recovery-ledger');",
    'void 0;',
    'recover-ledger-admission',
  ],
  [
    'unreadable campaign read as absent',
    "    if (error?.code === 'ENOENT') return;",
    '    return;',
    'recover-ledger-admission',
  ],
  [
    'admission creates the campaign',
    'function assertRecoveryAdmissible(ctx) {\n  recoveryAdmission(ctx);',
    'function assertRecoveryAdmissible(ctx) {\n  reserveRecoveryAttempt(ctx);',
    'recover-ledger-admission',
  ],
  [
    'campaign admission skipped in main',
    "    if (mode === 'recover-submit') {\n      ctx.stage = 'admission';\n      assertRecoveryAdmissible(ctx);\n    }\n",
    '',
    'recover-ledger-admission',
  ],
  [
    'finished hold digest unchecked',
    'finished.holdIdSha256 === null || SHA256.test(finished.holdIdSha256),',
    'true,',
    'recover-ledger-damage',
  ],
  [
    'probe held report digest unchecked',
    'previous.chain.heldTransfer?.reportSha256 === HELD_TRANSFER_REPORT_SHA256,',
    'true,',
    'recover-held-pin-main',
  ],
  [
    'pending record not synced',
    "    check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');\n" +
      '    fsImpl.fsyncSync(fd);',
    "    check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');",
    'recover-ledger-ack',
  ],
  [
    'pending record directory entry not synced',
    '  syncDirectory(fsImpl, directory);\n  return Object.freeze({ file, header, pending',
    '  return Object.freeze({ file, header, pending',
    'recover-ledger-ack',
  ],
  [
    'new ledger directory not synced',
    'if (created) syncDirectory(fsImpl, path.dirname(directory));',
    'void 0;',
    'recover-ledger-ack',
  ],
  [
    'short pending write accepted',
    "    check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');\n" +
      '    fsImpl.fsyncSync(fd);',
    '    fsImpl.writeSync(fd, bytes);\n    fsImpl.fsyncSync(fd);',
    'recover-ledger-interrupted',
  ],
  [
    'symlinked ledger directory followed',
    'holds(() => fsImpl.lstatSync(directory).isDirectory()),',
    'true,',
    'recover-ledger-damage',
  ],
  [
    'non-canonical profile accepted',
    '() => fsImpl.lstatSync(profile).isDirectory() && fsImpl.realpathSync(profile) === profile',
    '() => true',
    'recover-ledger-binding',
  ],
  [
    'recovery profile id unbound',
    "check(typeof ctx.profileId === 'string' && ctx.profileId.length > 0, 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'recovery held transfer unbound',
    "check(chain?.heldTransfer?.reportSha256 === HELD_TRANSFER_REPORT_SHA256, 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'recovery probe unbound',
    'SHA256.test(args.previousSha) && chain.heldTransfer.probeReportSha256 === args.previousSha,',
    'true,',
    'recover-ledger-binding',
  ],
  [
    'recovery scan unbound',
    "check(SHA256.test(args.scanSha) && previous?.scan?.sha256 === args.scanSha, 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'recovery scan anchor unbound',
    'Number.isSafeInteger(scan?.anchor?.number) && HASH.test(scan.anchor.hash),',
    'true,',
    'recover-ledger-binding',
  ],
  [
    'recovery probe time unbound',
    "check(typeof previous.observedAt === 'string', 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'recovery source commit unbound',
    "check(COMMIT.test(ctx.sourceCommit), 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'recovery script digest unbound',
    "check(plainObject(sources) && SHA256.test(sources[QUALIFIER]), 'recovery-binding');",
    'void 0;',
    'recover-ledger-binding',
  ],
  [
    'symlinked or oversized ledger read',
    "check(stat.isFile() && stat.size <= RECOVERY_LEDGER_MAX_BYTES, 'recovery-ledger');",
    'void 0;',
    'recover-ledger-damage',
  ],
  [
    'torn ledger write read',
    "check(lines.pop() === '', 'recovery-ledger');",
    'void 0;',
    'recover-ledger-damage',
  ],
  [
    'ledger header unchecked',
    "check(same(first, header), 'recovery-ledger');",
    'void 0;',
    'recover-ledger-damage',
  ],
  [
    'ledger pending record unchecked',
    "pending?.type === 'attempt-pending' &&",
    'true &&',
    'recover-ledger-damage',
  ],
  [
    'ledger finished record unchecked',
    "(finished?.type === 'attempt-finished' && finished.attemptId === pending.attemptId),",
    'true,',
    'recover-ledger-damage',
  ],
  [
    'ledger extra records unchecked',
    "check(rest.length === 0, 'recovery-ledger');",
    'void 0;',
    'recover-ledger-damage',
  ],
  [
    'recovery outcome not recorded',
    'if (reservation) finishRecoveryAttempt(ctx, reservation, failure);',
    'void 0;',
    'recover-ledger-ack',
  ],
  [
    'recovery hold digest not recorded',
    'ctx.holdIdSha256 = sha(HOLD_ID_DOMAIN + held.entry.id);',
    'void 0;',
    'recover-ledger-ack',
  ],
  ['recovery failure not recorded', 'failure = { error };', 'void 0;', 'recover-ledger-ack'],
  [
    'changed ledger finished anyway',
    'same(current.pending, reservation.pending) && current.finished === null,',
    'true,',
    'recover-ledger-interrupted',
  ],
  [
    'short finished write accepted',
    "      check(fsImpl.writeSync(fd, bytes) === bytes.length, 'recovery-ledger');",
    '      fsImpl.writeSync(fd, bytes);',
    'recover-ledger-interrupted',
  ],
  [
    'unrecorded outcome passes',
    '  } catch {\n    report.passed = false;\n  }',
    '  } catch {\n    void 0;\n  }',
    'recover-ledger-interrupted',
  ],
  [
    'recorded outcome not reported',
    'report.reservation.finished = true;',
    'void 0;',
    'recover-ledger-ack',
  ],
  // The spent read.
  [
    'spent marker dropped',
    'if (note.spentTxid === false) return { spent: false };',
    'return { spent: false };',
    'spent-read',
  ],
  [
    'spent input record unchecked',
    "check(record?.type === 'Shield' && lower(record.txid) === lower(note.txid), 'input-record');",
    'void 0;',
    'spent-read',
  ],
  [
    'spent read time dropped',
    'const readAt = new Date().toISOString();',
    'const readAt = null;',
    'spent-read',
  ],
  [
    'spent read scan time unchecked',
    'scanObservedAt: isoTime(ctx.scan.observedAt),',
    'scanObservedAt: ctx.scan.observedAt ?? null,',
    'spent-read',
  ],
  ['spent read anchor-only label dropped', 'observedThroughAnchorOnly: true,', '', 'spent-read'],
  [
    'spent txid shape unchecked',
    "check(HASH.test(value), 'input-spent');",
    'void 0;',
    'spent-read',
  ],
];
function loadVariant(source) {
  const variant = { exports: {} };
  // Same realm and same relative requires as the real script; never writes a file.
  new Function('exports', 'require', 'module', '__filename', '__dirname', source)(
    variant.exports,
    require,
    variant,
    SCRIPT,
    __dirname
  );
  return variant.exports;
}
describe('source mutation controls', () => {
  const original = fs.readFileSync(SCRIPT, 'utf8');
  test('the unmodified script loads through the control loader and passes every probe', async () => {
    const control = loadVariant(original);
    for (const probe of new Set(MUTATIONS.map((row) => row[3]))) await PROBES[probe](control);
  });
  test.each(MUTATIONS)('%s is caught', async (_name, from, to, probe, count = 1) => {
    expect(original.split(from).length - 1).toBe(count);
    const mutant = loadVariant(original.split(from).join(to));
    let failure = null;
    try {
      await PROBES[probe](mutant);
    } catch (error) {
      failure = error;
    }
    expect(failure).not.toBeNull();
  });
});

describe('recovery campaign under a re-pinned held report', () => {
  // Even a qualifier re-pinned to another rendering of the same hold finds the
  // profile's allowance spent, in either order: no second ledger appears.
  test('never mints a second allowance for the same profile', async () => {
    const RERENDERED = sha('d2');
    const original = fs.readFileSync(SCRIPT, 'utf8');
    expect(original.split(HELD_SHA)).toHaveLength(2);
    const repinned = loadVariant(original.split(HELD_SHA).join(RERENDERED));
    expect(repinned.HELD_TRANSFER_REPORT_SHA256).toBe(RERENDERED);
    const world = (m, profile) => {
      const value = heldWorld({ mode: 'recover-submit', profile });
      if (m === repinned) {
        value.ctx.chain.heldTransfer.reportSha256 = RERENDERED;
        value.ctx.previous.chain.heldTransfer.reportSha256 = RERENDERED;
      }
      return value;
    };
    for (const [first, second] of [
      [api, repinned],
      [repinned, api],
    ]) {
      const spent = world(first);
      await first.RUNNERS['recover-submit'](spent.ctx);
      expect(spent.calls.submit).toHaveLength(1);
      const profile = spent.ctx.args.profile;
      const file = first.recoveryLedgerPath(profile);
      expect(second.recoveryLedgerPath(profile)).toBe(file);
      const ledger = fs.readFileSync(file, 'utf8');
      const again = world(second, profile);
      expectRefusal(() => second.assertRecoveryAdmissible(again.ctx), 'recovery-ledger');
      expect(await settle(second.RUNNERS['recover-submit'](again.ctx))).toEqual(
        refused('recovery-ledger')
      );
      expect([again.calls.timeline, again.calls.loaded, again.calls.network]).toEqual([[], [], []]);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['recover-submit.jsonl']);
      expect(fs.readFileSync(file, 'utf8')).toBe(ledger);
    }
  });
});
