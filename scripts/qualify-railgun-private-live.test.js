const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
  test('the production submission keeps the same gas and fee bounds', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/main/wallet/railgun-private-submission.js'),
      'utf8'
    );
    expect(source).toContain('gasLimit <= 3000000n');
    expect(source).toContain('maxGasFee <= 2000000000000000n');
    expect(source).toContain('gasLimit * fee <= maxGasFee');
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
  test('accepts the fixed ten-argument form for every mode', () => {
    for (const mode of api.MODES)
      expect(api.parseArguments([mode, ...valid.slice(1)])).toMatchObject({
        mode,
        profile: '/w/identity-data/railgun-sepolia-live',
        output: '/w/l-a/transfer',
      });
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
} = {}) {
  const calls = { timeline: [], prove: [], submit: [], reviews: [], staging: [], poiReviews: [] };
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
    ])
      expect(listed).toContain(name);
    expect(listed.filter((name) => /__tests__|__fixtures__|\.test\.js$/.test(name))).toEqual([]);
  },
  dependency: async (m) => {
    const ethersPackage = JSON.stringify({ name: 'ethers', version: '6.17.0' });
    const lock = (version) => JSON.stringify({ packages: { 'node_modules/ethers': { version } } });
    expect(
      m.dependencyIdentity({ ethersPackage, packageLock: lock('6.17.0'), electronVersion: '1.0.0' })
    ).toEqual({
      ethersVersion: '6.17.0',
      packageLockSha256: require('crypto')
        .createHash('sha256')
        .update(lock('6.17.0'))
        .digest('hex'),
      electronVersion: '1.0.0',
    });
    expect(() => m.dependencyIdentity({ ethersPackage, packageLock: lock('6.16.0') })).toThrow();
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
