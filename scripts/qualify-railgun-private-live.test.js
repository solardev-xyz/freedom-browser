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
    pass('recover', afterTransfer('poi-submit', { poiSubmission: { attempted: true } }), ...newer);
    fail(
      'recover',
      afterTransfer('poi-submit', { poiSubmission: { attempted: false } }),
      'predecessor',
      ...newer
    );
    fail(
      'recover',
      afterTransfer('poi-submit', { passed: false, poiSubmission: { attempted: true } }),
      'predecessor',
      ...newer
    );
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
