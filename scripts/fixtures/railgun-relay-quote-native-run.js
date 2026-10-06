/** Five guarded job-body cases. No enrollment or account-bound owner is called. */
const assert = require('assert/strict');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const { readBounded, freshDirectory, sourceHashes } = require('./railgun-relay-retained-run');
const { closedJob } = require('./railgun-relay-wire-run');
const { buildVectors, PUBLIC_KEY, MASTER } = require('./railgun-relay-quote-native-vectors');
const data = require('../../src/main/wallet/railgun-relay-quote-data');
const { verifyRailgunEngineRuntime } = require('../../src/main/wallet/railgun-engine-runtime');
const approved = require('./railgun-relay-quote-native-pins.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const IDS = ['accepted', 'signature-mismatch', 'wrong-chain', 'identity-key', 'identity-r'];
function sourceSnapshot() {
  const sources = sourceHashes();
  const entry = 'scripts/qualify-railgun-relay-quote-job.js';
  sources[entry] = sha(readBounded(path.resolve(__dirname, '../..', entry), 65536));
  return sources;
}
function readConfig(filename) {
  const config = JSON.parse(readBounded(filename, 4096).toString('utf8'));
  data.shape(config, ['archive']);
  assert.equal(typeof config.archive, 'string');
  assert.ok(path.isAbsolute(config.archive));
  assert.equal(fs.realpathSync(config.archive), config.archive);
  assert.ok(fs.lstatSync(config.archive).isFile());
  return Object.freeze(config);
}
function assertApproved() {
  assert.match(approved.jobSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(approved.refusalLines).sort(), IDS.slice(1).sort());
  for (const line of Object.values(approved.refusalLines))
    assert.ok(Number.isSafeInteger(line) && line > 0);
  const filename = require.resolve('../../src/main/wallet/railgun-relay-quote-job');
  assert.equal(sha(readBounded(filename, 65536)), approved.jobSha256);
}
function expectedResult(row, input) {
  if (row.expected === 'refused')
    return {
      caseId: row.id,
      productionInputSha256: sha(input),
      jobSha256: approved.jobSha256,
      observedAssertionRefusal: true,
      productionResultMessages: 0,
      exactCryptographicPredicateIndependentlyAttributed: false,
      guards: data.EXPECTED_GUARDS,
    };
  const parsed = JSON.parse(input);
  const binding = data.normalizeRailgunRelayQuote(parsed.quote, parsed.gas);
  return {
    inputSha256: sha(input),
    quoteSha256: binding.quoteSha256,
    viewingPublicKey: PUBLIC_KEY,
    masterPublicKey: MASTER,
    signatureVerified: true,
    operatorTrusted: false,
    spendingEnabled: false,
    disclosureEnabled: false,
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    guards: data.EXPECTED_GUARDS,
  };
}
async function execute(config, directory) {
  assertApproved();
  const before = sourceSnapshot();
  const archive = verifyRailgunEngineRuntime(config.archive);
  const out = freshDirectory(directory, config);
  const { app } = require('electron');
  app.setPath('userData', path.join(out, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 90000);
  const current = () =>
    assert.ok(!controller.signal.aborted && performance.now() - started < 90000);
  let scope, vectors;
  const originalJobs = [],
    results = [];
  try {
    // Deliberately public-seed Node signing and pure address codec preparation.
    // It is separate from the guarded verification observations below.
    vectors = buildVectors(archive, Date.now());
    assert.deepEqual(
      vectors.cases.map((row) => row.id),
      IDS
    );
    current();
    scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'public-quote-job-qualification',
      signal: controller.signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'public-fixture',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: 11155111,
      role: 'engine',
      operation: 'relay-quote-review',
    });
    for (const row of vectors.cases) {
      current();
      const productionInput = JSON.stringify({
        archive,
        quote: row.quote,
        gas: vectors.gas,
      });
      assert.ok(Buffer.byteLength(productionInput) <= 24000);
      const expected = expectedResult(row, productionInput);
      const accepted = row.expected === 'accepted';
      const input = accepted
        ? productionInput
        : JSON.stringify({ caseId: row.id, productionInput });
      const filename = accepted
        ? require.resolve('../../src/main/wallet/railgun-relay-quote-job')
        : require.resolve('./railgun-relay-quote-native-refusal');
      const value = await closedJob(
        require('../../src/main/wallet/railgun-process').startRailgunProcess,
        {
          signal: controller.signal,
          process: {
            handle,
            filename,
            input,
            binaryKey: false,
            heapMb: 256,
            rssMb: 768,
          },
        },
        (actual) => assert.deepEqual(actual, expected),
        15000,
        originalJobs,
        row.id
      );
      assert.deepEqual(value, expected);
      results.push({ caseId: row.id, expected: row.expected, value });
    }
    current();
    assert.deepEqual(
      originalJobs.map((row) => row.role),
      IDS
    );
    assert.equal(verifyRailgunEngineRuntime(archive), archive);
    assertApproved();
    assert.deepEqual(sourceSnapshot(), before);
    current();
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
  }
  assert.equal(results.length, 5);
  const vectorBytes = Buffer.from(JSON.stringify(vectors, null, 2) + '\n');
  const report = {
    schema: 'railgun-production-quote-job-qualification-v1',
    sourceSha256: before,
    sourceInventoryIsExecutionCoverage: false,
    externalLauncherProvenanceRequired: true,
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    versions: { ...process.versions },
    fixturePreparation: {
      publicSeedOnly: true,
      nodeBuiltinSigning: true,
      pureAddressCodecOnly: true,
      outsideGuardedJob: true,
    },
    vectors: { bytes: vectorBytes.length, sha256: sha(vectorBytes) },
    originalJobs,
    results,
    jobBodyQualifiedOnly: true,
    accountEnrollmentExercised: false,
    productionQuoteOwnerExercised: false,
    accountControllerExercised: false,
    expiryAdmissionQualified: false,
    operatorTrustQualified: false,
    spendingEnabled: false,
    disclosureEnabled: false,
    liveServiceContacted: false,
    osEgressSandboxQualified: false,
    exactCryptographicPredicateIndependentlyAttributed: false,
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  assert.ok(vectorBytes.length <= 24000 && reportBytes.length <= 262144);
  for (const [name, bytes] of [
    ['vectors.json', vectorBytes],
    ['report.json', reportBytes],
  ]) {
    const filename = path.join(out, name);
    fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    assert.deepEqual(
      readBounded(filename, bytes.length, {
        bytes: bytes.length,
        sha256: sha(bytes),
      }),
      bytes
    );
  }
}
module.exports = { readConfig, assertApproved, expectedResult, execute };
