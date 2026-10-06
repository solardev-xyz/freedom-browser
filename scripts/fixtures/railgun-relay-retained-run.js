/** Retained public files only; two guarded verifiers and no producer path. */
'use strict';
const assert = require('assert/strict');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const crypto = require('crypto');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
const fixed = require('./railgun-relay-retained-inputs.json');
const basis = require('./railgun-relay-retained-basis.json');
const baseline = require('../qualify-railgun-relay-proof');
const { closedJob } = require('./railgun-relay-wire-run');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const REPLAY_MS = 60000;
function readBounded(filename, limit, expected) {
  assert.ok(typeof filename === 'string' && path.isAbsolute(filename));
  assert.equal(fs.realpathSync(filename), filename);
  const entry = fs.lstatSync(filename, { bigint: true });
  assert.ok(entry.isFile() && entry.size <= BigInt(limit));
  if (expected) assert.equal(entry.size, BigInt(expected.bytes));
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert.ok(before.isFile());
    for (const key of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs'])
      assert.equal(before[key], entry[key]);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(n > 0);
      offset += n;
    }
    const after = fs.fstatSync(fd, { bigint: true }),
      current = fs.lstatSync(filename, { bigint: true });
    assert.ok(current.isFile());
    for (const key of ['ino', 'dev', 'size', 'mtimeNs', 'ctimeNs']) {
      assert.equal(after[key], before[key]);
      assert.equal(current[key], before[key]);
    }
    assert.equal(fs.realpathSync(filename), filename);
    if (expected) assert.equal(sha(bytes), expected.sha256);
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function readConfig(filename) {
  const value = parser.parseBoundedJson(readBounded(filename, 4096), data.LIMITS, 4096);
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'archive',
      'artifactDirectory',
      'gasBundle',
      'proverArchive',
      'publicCase',
      'signedQuote',
      'wireBuild',
    ].sort()
  );
  for (const [key, filename] of Object.entries(value)) {
    assert.equal(typeof filename, 'string');
    assert.ok(path.isAbsolute(filename));
    assert.equal(fs.realpathSync(filename), filename);
    assert.equal(
      fs.statSync(filename).isDirectory(),
      key === 'artifactDirectory' || key === 'wireBuild'
    );
    if (key !== 'artifactDirectory' && key !== 'wireBuild')
      assert.ok(fs.statSync(filename).isFile());
  }
  return Object.freeze(value);
}
function retainedSnapshot(config) {
  const publicBytes = readBounded(config.publicCase, data.LIMITS.publicCaseBytes, fixed.publicCase);
  const quoteBytes = readBounded(
    config.signedQuote,
    data.POLICY.limits.packetBytes,
    fixed.signedQuote
  );
  const publicCase = data.readPublicCase(publicBytes),
    parsed = parser.parseSignedPacket(quoteBytes, data.POLICY);
  return Object.freeze({
    publicCaseText: publicBytes.toString('utf8'),
    signedQuoteText: quoteBytes.toString('utf8'),
    publicCase,
    publicCaseSha256: sha(publicBytes),
    signedQuoteSha256: sha(quoteBytes),
    signedDataSha256: sha(parsed.signedBytes),
    historicalEvaluationAt: parsed.candidate.feeExpiration - data.LIMITS.quoteLifetimeMs,
  });
}
function assertQuoteResult(value, snapshot) {
  const manifest = require('../../src/main/wallet/railgun-engine-manifest.json');
  assert.deepEqual(value, {
    publicCaseSha256: snapshot.publicCaseSha256,
    signedQuoteSha256: snapshot.signedQuoteSha256,
    publicKeyBasisSha256: basis.independentPublicKeyBasisSha256,
    signedDataSha256: snapshot.signedDataSha256,
    originalQuoteSignatureVerified: true,
    publicRecipientAndFeeCommitmentBound: true,
    historicalEvaluationAt: snapshot.historicalEvaluationAt,
    historicalEvaluationDerivedFromExpiry: true,
    historicalWallClockEstablished: false,
    currentQuoteAdmission: false,
    uniqueQuoteCalldataCommitment: false,
    encryptionTranscriptReplayed: false,
    feeCiphertextDecryptableByBroadcaster: false,
    serviceAcceptanceQualified: false,
    authorityGranted: false,
    wireBuildSha256: fixed.wireBuildSha256,
    gasBundleSha256: fixed.gasBundleSha256,
    engineArchiveIdentity: { sha256: manifest.sha256, bytes: manifest.size },
    guards: baseline.EXPECTED_GUARDS,
  });
}
async function pipeline({ config, snapshot, run, current }) {
  current();
  const quoteInput = {
    archive: config.archive,
    wireBuild: config.wireBuild,
    wireBuildSha256: fixed.wireBuildSha256,
    gasBundle: config.gasBundle,
    gasBundleSha256: fixed.gasBundleSha256,
    publicCaseText: snapshot.publicCaseText,
    signedQuoteText: snapshot.signedQuoteText,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(quoteInput)) <= 65536);
  const quoted = await run(
    'quote',
    './railgun-relay-retained-job',
    quoteInput,
    (value) => assertQuoteResult(value, snapshot),
    data.LIMITS.wireMs
  );
  current();
  // A supplied runner must not bypass the real callback's exact result contract.
  assertQuoteResult(quoted, snapshot);
  const proofInput = {
    archive: config.archive,
    proverArchive: config.proverArchive,
    artifactDirectory: config.artifactDirectory,
    minGasPrice: 1,
    publicCase: snapshot.publicCase,
  };
  assert.ok(Buffer.byteLength(JSON.stringify(proofInput)) <= 65536);
  const verified = await run(
    'verifier',
    './railgun-relay-verify-job',
    proofInput,
    (value) => baseline.assertVerification(value, 1),
    data.LIMITS.verifierMs
  );
  current();
  baseline.assertVerification(verified, 1);
  return { quote: quoted, verification: verified };
}
function sourceHashes() {
  const root = path.resolve(__dirname, '../..');
  const directories = [
    'scripts/fixtures',
    'scripts/fixtures/railgun-relay-wire',
    'src/main/wallet',
    'src/main/networks',
    'src/main/identity',
  ];
  const names = [
    'scripts/qualify-railgun-relay-retained.js',
    'scripts/qualify-railgun-relay-proof.js',
    'scripts/qualify-railgun-relay-wire.js',
  ];
  for (const directory of directories)
    for (const name of fs.readdirSync(path.join(root, directory)))
      if (
        /\.(js|json)$/.test(name) &&
        (directory !== 'scripts/fixtures' || name.startsWith('railgun-relay-'))
      )
        names.push(directory + '/' + name);
  return Object.fromEntries(
    names.sort().map((name) => [name, sha(fs.readFileSync(path.join(root, name)))])
  );
}
function verifyInputs(config, snapshot) {
  require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
    config.archive
  );
  require('../../src/main/wallet/railgun-prover-runtime').verifyRailgunProverRuntime(
    config.proverArchive
  );
  require('./railgun-relay-wire/inputs').verifyBuild(config.wireBuild, fixed.wireBuildSha256);
  assert.equal(sha(readBounded(config.gasBundle, 1048576)), fixed.gasBundleSha256);
  assert.deepEqual(retainedSnapshot(config), snapshot);
}
function freshDirectory(directory, config) {
  const absolute = path.resolve(directory);
  assert.equal(fs.existsSync(absolute), false);
  const resolved = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  const inputs = [path.resolve(__dirname, '../..'), ...Object.values(config)];
  for (const filename of inputs) {
    const real = fs.realpathSync(filename);
    assert.ok(
      resolved !== real &&
        !resolved.startsWith(real + path.sep) &&
        !real.startsWith(resolved + path.sep)
    );
  }
  fs.mkdirSync(resolved, { mode: 0o700 });
  return resolved;
}
async function execute(config, directory) {
  const snapshot = retainedSnapshot(config),
    before = sourceHashes();
  verifyInputs(config, snapshot);
  const out = freshDirectory(directory, config);
  const { app } = require('electron');
  app.setPath('userData', path.join(out, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const controller = new AbortController(),
    started = performance.now();
  const timer = setTimeout(() => controller.abort(), REPLAY_MS);
  const current = () =>
    assert.ok(!controller.signal.aborted && performance.now() - started <= REPLAY_MS);
  let scope, result;
  const originalJobs = [];
  try {
    scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'retained-public-proof-reverify',
      signal: controller.signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'public-fixture',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: 11155111,
      role: 'prover',
      operation: 'poi-verify',
    });
    result = await pipeline({
      config,
      snapshot,
      current,
      run: (role, filename, input, validate, ms) =>
        closedJob(
          require('../../src/main/wallet/railgun-process').startRailgunProcess,
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
      originalJobs.map((job) => job.role),
      ['quote', 'verifier']
    );
    verifyInputs(config, snapshot);
    assert.deepEqual(sourceHashes(), before);
    current();
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
  }
  assert.ok(result);
  assert.ok(performance.now() - started <= REPLAY_MS);
  const report = {
    schema: 'railgun-retained-public-reverification-v1',
    sourceSha256: before,
    sourceInventoryIsExecutionCoverage: false,
    externalLauncherProvenanceRequired: true,
    originalJobs,
    versions: process.versions,
    retainedInputs: { publicCase: fixed.publicCase, signedQuote: fixed.signedQuote },
    historicalProvenance: {
      sourceCommit: fixed.originalSourceCommit,
      report: fixed.historicalReport,
      rootObservation: fixed.historicalRootObservation,
    },
    quote: result.quote,
    verification: result.verification,
    artifactPins: Object.fromEntries(
      ['01x02', 'POI_3x3'].map((v) => [
        v,
        require('../../src/main/wallet/railgun-artifacts').manifest[v],
      ])
    ),
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    proverSha256: require('../../src/main/wallet/railgun-prover-manifest.json').sha256,
    publicTestKeys: true,
    syntheticInputAndListHistory: true,
    liveServiceContacted: false,
    producerExecuted: false,
    privateKeyDerived: false,
    encryptionTranscriptReplayed: false,
    historicalWallClockEstablished: false,
    currentQuoteAdmission: false,
    feeCiphertextDecryptableByBroadcaster: false,
    serviceAcceptanceQualified: false,
    authorityGranted: false,
    osEgressSandboxQualified: false,
  };
  const output = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  assert.ok(output.length <= 262144);
  const target = path.join(out, 'report.json');
  fs.writeFileSync(target, output, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(
    readBounded(target, 262144, { bytes: output.length, sha256: sha(output) }),
    output
  );
}
module.exports = {
  readBounded,
  readConfig,
  retainedSnapshot,
  assertQuoteResult,
  pipeline,
  sourceHashes,
  verifyInputs,
  freshDirectory,
  execute,
};
