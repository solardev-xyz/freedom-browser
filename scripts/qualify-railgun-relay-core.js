/** Explicit offline PUBLIC core/membership-math qualification. Nothing runs on
 * import; no enrolled owner, service signer substitution or proving capability. */
const assert = require('assert/strict');
const path = require('path');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const { sha } = require('./fixtures/railgun-relay-core-data');
const { EXPECTED_GUARDS } = require('./qualify-railgun-relay-proof');
const retained = require('./fixtures/railgun-relay-retained-run');
const { closedJob } = require('./fixtures/railgun-relay-wire-run');
const { normalizeRailgunRelayDraftCapsule } = require('../src/main/wallet/railgun-relay-capsule');
const TRUE_CHECKS = Object.freeze([
  'diagnosticContainsOnlyPublicFields',
  'freshPrivateInputsChecked',
  'independentOutputCommitmentsChecked',
  'twoLeafGrowthVerified',
  'localOriginalWitnessPreserved',
  'freshChangedRootRefused',
  'diagnosticChangedRootRefused',
  'changedOriginalPathRefused',
  'historicalEventSignatureVerified',
  'historicalMembershipPathVerified',
  'historicalSignatureMutationRefused',
  'historicalPathMutationRefused',
  'assemblerOriginalCoreCompleted',
  'independentInputBlindUnequal',
  'assemblerMismatchedOwnedNoteRefused',
]);
const FALSE_CHECKS = Object.freeze([
  'exactFailureCauseIndependentlyAttributed',
  'inputOwnershipVerified',
  'outputBlindingVerified',
  'proofVerified',
  'currentMembershipVerified',
  'authorityGranted',
]);
function producer(value) {
  assert.deepEqual(Object.keys(value).sort(), [
    'draftSha256',
    'draftText',
    'guards',
    'syntheticQuoteUnsigned',
  ]);
  assert.equal(typeof value.draftText, 'string');
  assert.ok(Buffer.byteLength(value.draftText) <= 60000);
  assert.equal(value.draftSha256, sha(value.draftText));
  const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(value.draftText));
  assert.equal(JSON.stringify(draft.data), value.draftText);
  assert.equal(draft.data.intent.context.inputAmount, '1000');
  assert.equal(draft.data.intent.context.feeAmount, '100');
  assert.equal(draft.data.intent.context.selfAmount, '900');
  assert.deepEqual(draft.data.selection, { tree: 0, position: 0 });
  assert.equal(value.syntheticQuoteUnsigned, true);
  assert.deepEqual(value.guards, EXPECTED_GUARDS);
  return draft;
}
function recovery(value, produced) {
  const draft = producer(produced);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      ...TRUE_CHECKS,
      ...FALSE_CHECKS,
      'draftSha256',
      'draftDigest',
      'originalRoot',
      'grownRoot',
      'historicalRoot',
      'publicSignals',
      'guards',
    ].sort()
  );
  assert.equal(value.draftSha256, produced.draftSha256);
  assert.equal(value.draftDigest, draft.digest);
  for (const key of TRUE_CHECKS) assert.equal(value[key], true, key);
  for (const key of FALSE_CHECKS) assert.equal(value[key], false, key);
  for (const key of ['originalRoot', 'grownRoot', 'historicalRoot'])
    assert.match(value[key], /^[0-9a-f]{64}$/);
  assert.equal('0x' + value.originalRoot, draft.data.intent.expected.merkleRoot);
  assert.notEqual(value.originalRoot, value.grownRoot);
  const history = require('./fixtures/railgun-relay-core-data').capturedHistory(produced.draftText);
  assert.equal(value.historicalRoot, history.proof.root);
  assert.ok(Array.isArray(value.publicSignals));
  assert.equal(value.publicSignals.length, 8);
  for (const v of value.publicSignals) assert.match(v, /^[0-9a-f]{64}$/);
  assert.equal(value.publicSignals[5], history.proof.root);
  assert.deepEqual(value.guards, EXPECTED_GUARDS);
}
async function pipeline({ archive, run, current }) {
  current();
  const made = await run(
    'producer',
    './fixtures/railgun-relay-core-producer-job',
    { archive },
    producer,
    30000
  );
  producer(made);
  current();
  const checked = await run(
    'recovery-math',
    './fixtures/railgun-relay-core-recovery-job',
    { archive, draftText: made.draftText },
    (value) => recovery(value, made),
    30000
  );
  recovery(checked, made);
  current();
  return { producerGuards: made.guards, syntheticQuoteUnsigned: true, recovery: checked };
}
function sourceHashes() {
  const sources = retained.sourceHashes(),
    root = path.resolve(__dirname, '..');
  for (const entry of [
    'scripts/qualify-railgun-relay-core.js',
    'scripts/qualify-railgun-relay-core.test.js',
    'scripts/fixtures/railgun-poi-signed-event.json',
    'scripts/fixtures/railgun-owned-poi-public-vector.json',
    'docs/qualification/railgun-poi-read-2026-10-03.json',
  ])
    sources[entry] = sha(fs.readFileSync(path.join(root, entry)));
  return sources;
}
function readConfig(filename) {
  const config = JSON.parse(retained.readBounded(filename, 4096));
  assert.deepEqual(Object.keys(config), ['archive']);
  assert.ok(typeof config.archive === 'string' && path.isAbsolute(config.archive));
  assert.equal(fs.realpathSync(config.archive), config.archive);
  return Object.freeze(config);
}
async function execute(config, directory) {
  const verify = () =>
    require('../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(config.archive);
  const before = sourceHashes(),
    archive = verify();
  const out = retained.freshDirectory(directory, config);
  const { app } = require('electron');
  app.setPath('userData', path.join(out, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const controller = new AbortController(),
    started = performance.now(),
    originalJobs = [];
  const timer = setTimeout(() => controller.abort(), 90000);
  const current = () =>
    assert.ok(!controller.signal.aborted && performance.now() - started < 90000);
  let scope, result;
  try {
    scope = require('../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'public-relay-core',
      signal: controller.signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'public-fixture',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: 11155111,
      role: 'engine',
      operation: 'public-sender-recovery',
    });
    result = await pipeline({
      archive,
      current,
      run: (role, filename, input, validate, ms) =>
        closedJob(
          require('../src/main/wallet/railgun-process').startRailgunProcess,
          {
            signal: controller.signal,
            process: {
              handle,
              filename: require.resolve(filename),
              input: JSON.stringify(input),
              binaryKey: false,
              heapMb: 256,
              rssMb: 768,
            },
          },
          validate,
          ms,
          originalJobs,
          role
        ),
    });
    current();
    assert.deepEqual(
      originalJobs.map((v) => v.role),
      ['producer', 'recovery-math']
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
    verify();
    assert.deepEqual(sourceHashes(), before);
  }
  assert.ok(result);
  assert.ok(performance.now() - started < 90000);
  const report = {
    schema: 'railgun-public-core-math-v1',
    sourceSha256: before,
    sourceInventoryIsExecutionCoverage: false,
    externalLauncherProvenanceRequired: true,
    versions: process.versions,
    originalJobs,
    ...result,
    engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
    publicTestKeys: true,
    syntheticOwnedNoteAndTree: true,
    syntheticTxoScanAdapters: true,
    historicalCapturedMembershipReplayed: true,
    inputOwnershipVerified: false,
    outputBlindingVerified: false,
    proofVerified: false,
    currentMembershipVerified: false,
    authorityGranted: false,
    enrolledAccountQualified: false,
    storageRestorationQualified: false,
    quoteSignatureVerified: false,
    productionListSignerSubstituted: false,
    liveServicesContacted: false,
    proofProduced: false,
    spendingKeyUsed: false,
    osConfinementQualified: false,
    keyLoans: 0,
    storageWorkers: 0,
  };
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  assert.ok(bytes.length <= 262144);
  fs.writeFileSync(path.join(out, 'report.json'), bytes, { flag: 'wx', mode: 0o600 });
}
async function main(argv = process.argv.slice(2)) {
  assert.equal(
    argv.length,
    2,
    'Usage: electron qualify-railgun-relay-core.js CONFIG_JSON FRESH_OUTPUT'
  );
  assert.ok(process.versions.electron && process.type === 'browser');
  return execute(readConfig(argv[0]), argv[1]);
}
if (
  require.main === module ||
  (process.versions.electron &&
    process.type === 'browser' &&
    typeof process.argv[1] === 'string' &&
    path.resolve(process.argv[1]) === path.resolve(__filename))
)
  main().then(
    () => require('electron').app.exit(0),
    () => {
      console.error('Public relay core qualification refused');
      require('electron').app.exit(1);
    }
  );
module.exports = {
  producer,
  recovery,
  pipeline,
  sourceHashes,
  readConfig,
  execute,
  main,
  TRUE_CHECKS,
  FALSE_CHECKS,
};
