/** Disposable serial fee-output/pre-transaction-POI cryptography only.
 * Usage: electron script ENGINE_ASAR PROVER_ASAR ARTIFACTS NEW_DIRECTORY
 * Default lane has no quotes; opt-in wire composition uses synthetic quotes.
 * No relay transport, accounts, credential loans or submission. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { assertPublicShape } = require('./fixtures/railgun-relay-public-data');
// Exact existing Electron44.5.1/Node24.21.0 catalog. Prior public-adapter
// acknowledged report SHA4eb512b98f916370ef8ead002756ae69d21fcf82ae824e67ab3c7ba87bb2d592.
// The outer launcher must pin the matching runtime and guard source again.
const EXPECTED_GUARDS = Object.freeze({
  hooks: Object.freeze([
    'global.fetch',
    'global.WebSocket',
    'process.dlopen',
    'http.request',
    'http.get',
    'https.request',
    'https.get',
    'net.connect',
    'net.createConnection',
    'tls.connect',
    'http2.connect',
    'dgram.createSocket',
    'worker_threads.Worker',
    'child_process.spawn',
    'child_process.spawnSync',
    'child_process.exec',
    'child_process.execSync',
    'child_process.execFile',
    'child_process.execFileSync',
    'child_process.fork',
    'net.Socket.connect',
    'dgram.Socket.send',
    'dgram.Socket.connect',
    'dgram.Socket.bind',
    'dns.lookup',
    'dns.lookupService',
    'dns.resolve',
    'dns.resolve4',
    'dns.resolve6',
    'dns.resolveAny',
    'dns.resolveCaa',
    'dns.resolveCname',
    'dns.resolveMx',
    'dns.resolveNaptr',
    'dns.resolveNs',
    'dns.resolvePtr',
    'dns.resolveSoa',
    'dns.resolveSrv',
    'dns.resolveTlsa',
    'dns.resolveTxt',
    'dns.reverse',
    'dns.Resolver.resolveAny',
    'dns.Resolver.resolve4',
    'dns.Resolver.resolve6',
    'dns.Resolver.resolveCaa',
    'dns.Resolver.resolveCname',
    'dns.Resolver.resolveMx',
    'dns.Resolver.resolveNs',
    'dns.Resolver.resolveTlsa',
    'dns.Resolver.resolveTxt',
    'dns.Resolver.resolveSrv',
    'dns.Resolver.resolvePtr',
    'dns.Resolver.resolveNaptr',
    'dns.Resolver.resolveSoa',
    'dns.Resolver.reverse',
    'dns.Resolver.resolve',
    'dns.promises.lookup',
    'dns.promises.lookupService',
    'dns.promises.resolve',
    'dns.promises.resolve4',
    'dns.promises.resolve6',
    'dns.promises.resolveAny',
    'dns.promises.resolveCaa',
    'dns.promises.resolveCname',
    'dns.promises.resolveMx',
    'dns.promises.resolveNaptr',
    'dns.promises.resolveNs',
    'dns.promises.resolvePtr',
    'dns.promises.resolveSoa',
    'dns.promises.resolveSrv',
    'dns.promises.resolveTlsa',
    'dns.promises.resolveTxt',
    'dns.promises.reverse',
    'dns.promises.Resolver.resolveAny',
    'dns.promises.Resolver.resolve4',
    'dns.promises.Resolver.resolve6',
    'dns.promises.Resolver.resolveCaa',
    'dns.promises.Resolver.resolveCname',
    'dns.promises.Resolver.resolveMx',
    'dns.promises.Resolver.resolveNs',
    'dns.promises.Resolver.resolveTlsa',
    'dns.promises.Resolver.resolveTxt',
    'dns.promises.Resolver.resolveSrv',
    'dns.promises.Resolver.resolvePtr',
    'dns.promises.Resolver.resolveNaptr',
    'dns.promises.Resolver.resolveSoa',
    'dns.promises.Resolver.reverse',
    'dns.promises.Resolver.resolve',
    'electron.net.request',
    'electron.net.fetch',
    'electron.net.resolveHost',
  ]),
  canaries: 91,
  attempts: 0,
});
function assertGuards(guards) {
  assert.deepEqual(guards, EXPECTED_GUARDS);
}
function assertProducerResult(value, minGasPrice) {
  assert.deepEqual(Object.keys(value).sort(), ['guards', 'publicCase']);
  assertPublicShape(value.publicCase, minGasPrice);
  assertGuards(value.guards);
}
function createResultBroker(signal, validate) {
  let value,
    calls = 0,
    refused = false;
  return {
    broker: {
      signal,
      dispatch: async (wire) => {
        try {
          assert.equal(calls, 0);
          assert.equal(typeof wire, 'string');
          assert.ok(Buffer.byteLength(wire) <= 40000);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          validate(message.value);
          value = message.value;
          calls++;
          return JSON.stringify({ id: 1, value: null });
        } catch {
          refused = true;
          throw new Error('Relay fixture broker refused');
        }
      },
    },
    result() {
      assert.equal(refused, false);
      assert.equal(calls, 1);
      return value;
    },
  };
}
function assertVerification(value, minGasPrice) {
  assert.deepEqual(
    Object.keys(value).sort(),
    [
      'authorityGranted',
      'changedSignalsRefused',
      'feeAndSelfCommitmentsMatched',
      'guards',
      'minGasPrice',
      'prePoiVerified',
      'productionPayloadRefused',
      'productionPolicyRefused',
      'sameTransactionPrePoiRootMatched',
      'serviceAcceptanceQualified',
      'syntheticListRootMatched',
      'transactionVerified',
    ].sort()
  );
  assert.equal(value.minGasPrice, minGasPrice);
  assert.equal(value.changedSignalsRefused, 13);
  for (const name of [
    'transactionVerified',
    'prePoiVerified',
    'feeAndSelfCommitmentsMatched',
    'sameTransactionPrePoiRootMatched',
    'syntheticListRootMatched',
    'productionPolicyRefused',
    'productionPayloadRefused',
  ])
    assert.equal(value[name], true);
  assert.equal(value.authorityGranted, false);
  assert.equal(value.serviceAcceptanceQualified, false);
  assertGuards(value.guards);
}
async function main() {
  const wireConfig = require('./fixtures/railgun-relay-wire-run').selectedConfig(process.env);
  const { app } = require('electron');
  const [archive, proverArchive, artifactDirectory, directory] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  assert.notEqual(process.platform, 'win32');
  for (const p of [archive, proverArchive, artifactDirectory, directory])
    assert.ok(path.isAbsolute(p));
  assert.equal(fs.existsSync(directory), false);
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const repo = path.join(__dirname, '..');
  const sources = [
    'scripts/qualify-railgun-relay-proof.js',
    ...(wireConfig
      ? fs
          .readdirSync(path.join(repo, 'scripts/fixtures/railgun-relay-wire'))
          .filter((n) => /\.(js|json)$/.test(n))
          .map((n) => 'scripts/fixtures/railgun-relay-wire/' + n)
          .concat('scripts/qualify-railgun-relay-wire.js')
      : []),
    ...fs
      .readdirSync(path.join(repo, 'scripts/fixtures'))
      .filter((n) => /^railgun-relay-.*\.js$/.test(n))
      .map((n) => 'scripts/fixtures/' + n),
    ...['src/main/wallet', 'src/main/networks', 'src/main/identity'].flatMap((d) =>
      fs
        .readdirSync(path.join(repo, d))
        .filter((n) => /\.(js|json)$/.test(n))
        .map((n) => d + '/' + n)
    ),
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
  ].sort();
  const hashes = () =>
    Object.fromEntries(
      sources.map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(repo, file)))
          .digest('hex'),
      ])
    );
  const sourceSha256 = hashes();
  require('../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  require('../src/main/wallet/railgun-prover-runtime').verifyRailgunProverRuntime(proverArchive);
  if (wireConfig) {
    return require('./fixtures/railgun-relay-wire-run').runWireQualification({
      config: wireConfig,
      archive,
      proverArchive,
      artifactDirectory,
      directory,
      sourceSha256,
      hashes,
    });
  }
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'public-relay-fixture',
    signal: new AbortController().signal,
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
  const originalJobs = [],
    runs = [];
  let task;
  async function runJob(filename, input, validate) {
    const result = createResultBroker(scope.signal, validate);
    task = require('../src/main/wallet/railgun-process').startRailgunProcess({
      handle,
      filename,
      input: JSON.stringify(input),
      binaryKey: false,
      startupMs: 120000,
      lifetimeMs: 600000,
      heapMb: 256,
      rssMb: 768,
      broker: result.broker,
    });
    try {
      await task.ready;
    } finally {
      task.close();
      const closed = await task.closed;
      originalJobs.push(closed);
    }
    const closed = originalJobs.at(-1);
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    assert.equal(closed.exitCode, 15);
    assert.equal(closed.escalated, false);
    assert.equal(closed.peerDisconnected, false);
    task = undefined;
    return result.result();
  }
  try {
    for (const minGasPrice of [0, 1]) {
      const started = performance.now();
      const inputs = { archive, proverArchive, artifactDirectory, minGasPrice };
      const produced = await runJob(
        require.resolve('./fixtures/railgun-relay-proof-job'),
        inputs,
        (raw) => {
          // Bounded public-only shape before retaining or forwarding the result.
          assertProducerResult(raw, minGasPrice);
        }
      );
      const verified = await runJob(
        require.resolve('./fixtures/railgun-relay-verify-job'),
        { ...inputs, publicCase: produced.publicCase },
        (value) => assertVerification(value, minGasPrice)
      );
      runs.push({
        producerGuards: produced.guards,
        ...verified,
        elapsedMs: Math.round(performance.now() - started),
      });
      assert.deepEqual(hashes(), sourceSha256);
    }
    assert.equal(originalJobs.length, 4);
    const report = {
      schema: 'railgun-relay-public-vector-v1',
      createdAt: new Date().toISOString(),
      sourceSha256,
      engineSha256: require('../src/main/wallet/railgun-engine-manifest.json').sha256,
      proverSha256: require('../src/main/wallet/railgun-prover-manifest.json').sha256,
      versions: process.versions,
      artifactPins: Object.fromEntries(
        ['01x02', 'POI_3x3'].map((variant) => [
          variant,
          require('../src/main/wallet/railgun-artifacts').manifest[variant],
        ])
      ),
      runs,
      originalJobs,
      publicTestKeys: true,
      fixedPublicNoteRandoms: true,
      factoryRandomnessQualified: false,
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
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  } finally {
    task?.close();
    if (task) await task.closed;
    scope.close();
  }
}
// Electron's app-entry loader can leave require.main distinct from this module.
// Only the exact explicit browser-process entry may auto-run on that path.
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
      console.error('Relay public-vector qualification refused');
      require('electron').app.exit(1);
    }
  );
module.exports = { createResultBroker, assertVerification, assertProducerResult, EXPECTED_GUARDS };
