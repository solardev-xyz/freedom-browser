/** Opt-in serial quote→producer→wire→verifier qualification. Outer coordinator
 * only: selected upstream/engine crypto runs exclusively inside guarded jobs. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const data = require('./railgun-relay-wire-composition');
const parser = require('./railgun-relay-wire/policy');
const baseline = () => require('../qualify-railgun-relay-proof');
const CHECKS = Object.freeze({
  originalQuoteRetained: true,
  sourceFeeEqualsProofFee: true,
  independentRecipientMatched: true,
  decryptedCalldataMatched: true,
  decryptedPrePoiMapMatched: true,
  decryptedInputReconstructed: true,
  upstreamAndNativeDecryptionMatched: true,
  quoteCurrentAfterEncryption: true,
  serviceAcceptanceQualified: false,
  authorityGranted: false,
});
const copy = (value) => JSON.parse(JSON.stringify(value));
function selectedConfig(environment) {
  assert.ok(
    environment.FREEDOM_RAILGUN_RELAY_WIRE === undefined ||
      environment.FREEDOM_RAILGUN_RELAY_WIRE === '1'
  );
  if (environment.FREEDOM_RAILGUN_RELAY_WIRE === undefined) {
    assert.equal(environment.FREEDOM_RAILGUN_RELAY_WIRE_INPUTS, undefined);
    return null;
  }
  return parseConfig(environment.FREEDOM_RAILGUN_RELAY_WIRE_INPUTS);
}
function parseConfig(value) {
  assert.equal(typeof value, 'string');
  assert.ok(path.isAbsolute(value) && fs.realpathSync(value) === value);
  const config = parser.parseBoundedJson(fs.readFileSync(value), data.LIMITS, 4096);
  assert.deepEqual(Object.keys(config).sort(), [
    'gasBundle',
    'gasBundleSha256',
    'retainPublic',
    'wireBuild',
    'wireBuildSha256',
  ]);
  for (const name of ['wireBuild', 'gasBundle'])
    assert.ok(path.isAbsolute(config[name]) && fs.realpathSync(config[name]) === config[name]);
  for (const name of ['wireBuildSha256', 'gasBundleSha256'])
    assert.match(config[name], /^[0-9a-f]{64}$/);
  assert.equal(config.retainPublic, true);
  return Object.freeze(config);
}
function waitFor(promise, milliseconds, signal) {
  let timer, abort;
  const deadline = new Promise((_, reject) => {
    const refused = () => reject(new Error('Wire fixture lifetime ended'));
    timer = setTimeout(refused, milliseconds);
    abort = refused;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) refused();
  });
  return Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
}
async function closedJob(
  start,
  options,
  validate,
  milliseconds,
  observations,
  role,
  clock = () => performance.now()
) {
  const reader = baseline().createResultBroker(options.signal, validate);
  const started = clock();
  const task = start({
    ...options.process,
    broker: reader.broker,
    startupMs: milliseconds,
    lifetimeMs: milliseconds,
  });
  // Observe original closure immediately, including rejection, even if ready fails.
  const closing = task.closed.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  let failure, outcome;
  try {
    await waitFor(task.ready, milliseconds, options.signal);
    assert.ok(!options.signal.aborted && clock() - started <= milliseconds);
  } catch (error) {
    failure = error;
  } finally {
    try {
      task.close();
    } catch (error) {
      failure ||= error;
    }
    try {
      const settled = await waitFor(closing, data.LIMITS.cleanupMs);
      if (settled.error) failure ||= settled.error;
      else {
        outcome = settled.value;
        observations.push({ role, ...outcome });
      }
    } catch (error) {
      failure ||= error;
    }
  }
  if (failure) throw failure;
  assert.ok(!options.signal.aborted && clock() - started <= milliseconds);
  assert.equal(outcome.code, 'RAILGUN_PROCESS_CLOSED');
  assert.equal(outcome.exitCode, 15);
  assert.equal(outcome.escalated, false);
  assert.equal(outcome.peerDisconnected, false);
  return reader.result();
}
async function pipeline({ config, inputs, signal, run, current }) {
  const { assertProducerResult, assertVerification, EXPECTED_GUARDS } = baseline();
  current();
  const common = {
    archive: inputs.archive,
    wireBuild: config.wireBuild,
    wireBuildSha256: config.wireBuildSha256,
    gasBundle: config.gasBundle,
    gasBundleSha256: config.gasBundleSha256,
  };
  const admitted = await run(
    'quote',
    './railgun-relay-wire-job',
    { ...common, mode: 'quote' },
    (value) => {
      assert.deepEqual(Object.keys(value).sort(), [
        'authorityGranted',
        'guards',
        'independentRecipientMatched',
        'originalByteSignaturesVerified',
        'selection',
        'sourceFeeEquals100',
      ]);
      assert.deepEqual(value.guards, EXPECTED_GUARDS);
      for (const key of [
        'independentRecipientMatched',
        'originalByteSignaturesVerified',
        'sourceFeeEquals100',
      ])
        assert.equal(value[key], true);
      assert.equal(value.authorityGranted, false);
      const selected = value.selection;
      const detached = data.selectRelayWireInput(
        Buffer.from(
          JSON.stringify({ data: selected.signedDataHex, signature: selected.signatureHex })
        ),
        selected.recipient,
        selected.selectedAt,
        '100'
      );
      assert.deepEqual(copy(selected), copy(detached));
    },
    15000
  );
  current();
  const selection = admitted.selection;
  let previousWall = selection.selectedAt;
  const selectedCurrent = () => {
    current();
    const now = Date.now();
    data.assertSelectionCurrent(selection, now, previousWall);
    previousWall = now;
  };
  selectedCurrent();
  const produced = await run(
    'producer',
    './railgun-relay-wire-producer-job',
    {
      archive: inputs.archive,
      proverArchive: inputs.proverArchive,
      artifactDirectory: inputs.artifactDirectory,
      selection,
    },
    (value) => assertProducerResult(value, 1),
    data.LIMITS.producerMs
  );
  selectedCurrent();
  const wired = await run(
    'wire',
    './railgun-relay-wire-job',
    { ...common, mode: 'wire', selection, publicCase: produced.publicCase },
    (value) => {
      assert.deepEqual(Object.keys(value).sort(), ['checks', 'guards', 'publicCase']);
      assert.deepEqual(value.checks, CHECKS);
      assert.deepEqual(value.guards, EXPECTED_GUARDS);
      data.assertCaseUnchanged(Buffer.from(JSON.stringify(produced.publicCase)), value.publicCase);
    },
    data.LIMITS.wireMs
  );
  selectedCurrent();
  const verified = await run(
    'verifier',
    './railgun-relay-verify-job',
    { ...inputs, minGasPrice: 1, publicCase: wired.publicCase },
    (value) => assertVerification(value, 1),
    data.LIMITS.verifierMs
  );
  selectedCurrent();
  assert.ok(!signal.aborted);
  return {
    selection,
    lastWallMs: previousWall,
    publicCase: wired.publicCase,
    quoteGuards: admitted.guards,
    producerGuards: produced.guards,
    wireGuards: wired.guards,
    checks: wired.checks,
    verified,
  };
}
async function runWireQualification({
  config,
  archive,
  proverArchive,
  artifactDirectory,
  directory,
  sourceSha256,
  hashes,
}) {
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), data.LIMITS.outerMs);
  const current = () =>
    assert.ok(!controller.signal.aborted && performance.now() - started <= data.LIMITS.outerMs);
  let scope, publication;
  try {
    scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'public-proof-wire-fixture',
      signal: controller.signal,
    });
    const handle = scope.getContext({
      kind: 'private-account',
      principal: 'public-fixture',
      protocol: 'railgun',
      deployment: 'offline',
      chainId: pinsChain(),
      role: 'prover',
      operation: 'poi-verify',
    });
    const originalJobs = [];
    const result = await pipeline({
      config,
      inputs: { archive, proverArchive, artifactDirectory },
      signal: controller.signal,
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
      originalJobs.map((v) => v.role),
      ['quote', 'producer', 'wire', 'verifier']
    );
    assert.deepEqual(hashes(), sourceSha256);
    const publicBytes = Buffer.from(JSON.stringify(result.publicCase, null, 2) + '\n');
    data.readPublicCase(publicBytes);
    const quoteBytes = Buffer.from(
      JSON.stringify({
        data: result.selection.signedDataHex,
        signature: result.selection.signatureHex,
      }) + '\n'
    );
    parser.parseSignedPacket(quoteBytes, data.POLICY);
    const publicationWallMs = Date.now();
    data.assertSelectionCurrent(result.selection, publicationWallMs, result.lastWallMs);
    current();
    // Only this fixed public-vector serializer is retained, after four closures.
    // No witnesses, credentials, shared keys, runtime payloads or profiles leave.
    const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
    const report = {
      schema: 'railgun-relay-proof-wire-v1',
      createdAt: new Date().toISOString(),
      sourceSha256,
      engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
      proverSha256: require('../../src/main/wallet/railgun-prover-manifest.json').sha256,
      wireBuildManifestSha256: config.wireBuildSha256,
      gasBundleSha256: config.gasBundleSha256,
      artifactPins: Object.fromEntries(
        ['01x02', 'POI_3x3'].map((variant) => [
          variant,
          require('../../src/main/wallet/railgun-artifacts').manifest[variant],
        ])
      ),
      versions: process.versions,
      originalJobs,
      quoteGuards: result.quoteGuards,
      producerGuards: result.producerGuards,
      wireGuards: result.wireGuards,
      verification: result.verified,
      composition: result.checks,
      retained: { publicCaseSha256: sha(publicBytes), signedQuoteSha256: sha(quoteBytes) },
      publicTestKeys: true,
      fixedPublicNoteRandoms: true,
      syntheticInputAndListHistory: true,
      genuineEnrolledAuthority: false,
      signedServiceQuoteQualified: false,
      relayTransportQualified: false,
      liveDisclosure: false,
      submissions: 0,
      keyLoans: 0,
      osEgressSandboxQualified: false,
      selectedSourceInventoryIsExecutionCoverage: false,
    };
    assert.ok(config.retainPublic);
    publication = {
      selection: result.selection,
      lastWallMs: publicationWallMs,
      files: [
        ['public-case.json', publicBytes],
        ['signed-quote.json', quoteBytes],
        ['report.json', Buffer.from(JSON.stringify(report, null, 2) + '\n')],
      ],
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
  }
  assert.ok(publication && performance.now() - started <= data.LIMITS.outerMs);
  data.assertSelectionCurrent(publication.selection, Date.now(), publication.lastWallMs);
  for (const [name, content] of publication.files) {
    fs.writeFileSync(path.join(directory, name), content, { flag: 'wx', mode: 0o600 });
  }
}
function pinsChain() {
  return require('../../src/main/wallet/railgun-shield-pins.json').chainId;
}
module.exports = {
  selectedConfig,
  parseConfig,
  waitFor,
  closedJob,
  pipeline,
  runWireQualification,
  CHECKS,
};
