/** One guarded sender-recovery job over an exact retained public transaction. */
const assert = require('assert/strict');
const path = require('path');
const crypto = require('crypto');
const fs = process.versions.electron ? require('original-fs') : require('fs');
const retained = require('./railgun-relay-retained-run');
const { closedJob } = require('./railgun-relay-wire-run');
const { EXPECTED_GUARDS } = require('../qualify-railgun-relay-proof');
const { verifyRailgunEngineRuntime } = require('../../src/main/wallet/railgun-engine-runtime');
const PUBLIC_CASE = {
  bytes: 5285,
  sha256: '3b415653aa2a797af98c41f7f56bb60b3dd877cca6bd0f47904633876aad3b38',
};
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
function readConfig(filename) {
  const value = JSON.parse(retained.readBounded(filename, 4096));
  assert.deepEqual(Object.keys(value).sort(), ['archive', 'publicCase']);
  for (const name of Object.values(value)) {
    assert.ok(typeof name === 'string' && path.isAbsolute(name));
    assert.equal(fs.realpathSync(name), name);
    assert.ok(fs.lstatSync(name).isFile());
  }
  return Object.freeze(value);
}
function sources() {
  const result = retained.sourceHashes();
  const entry = 'scripts/qualify-railgun-relay-sender-recovery.js';
  result[entry] = sha(retained.readBounded(path.resolve(__dirname, '../..', entry), 65536));
  return result;
}
function validate(value) {
  const expected = {
    publicCaseSha256: PUBLIC_CASE.sha256,
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    senderKeySource: 'Published fixture viewingKey=Buffer.alloc(32,8)',
    senderViewingPublicKey: value.senderViewingPublicKey,
    senderPublicKeyNodeCompared: true,
    results: [
      { id: 'fee-sender-recovery', accepted: true },
      { id: 'self-sender-recovery', accepted: true },
      {
        id: 'ciphertext-tamper',
        refused: true,
        originalCiphertextDecryptedBeforeRefusal: false,
        exactFailureCauseIndependentlyAttributed: false,
      },
      {
        id: 'annotation-sender-random-tamper',
        refused: true,
        originalCiphertextDecryptedBeforeRefusal: true,
        exactFailureCauseIndependentlyAttributed: false,
      },
      {
        id: 'recipient-substitution',
        refused: true,
        originalCiphertextDecryptedBeforeRefusal: true,
        exactFailureCauseIndependentlyAttributed: false,
      },
      {
        id: 'empty-unblind-fallback-guard',
        refused: true,
        scope:
          'Actual upstream fallback value checked by strict identity guard; not a corrupted-ciphertext recovery claim',
      },
    ],
    orderedAmounts: ['100', '900'],
    ciphertextAndCalldataUnchanged: true,
    feeRecipientPrivateKeyUsed: false,
    spendingKeyUsed: false,
    proofProduced: false,
    proofReverified: false,
    productionCapsuleImplemented: false,
    serviceAcceptanceQualified: false,
    authorityGranted: false,
    guards: EXPECTED_GUARDS,
  };
  assert.match(value.senderViewingPublicKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(value, expected);
}
async function execute(config, directory) {
  const before = sources();
  const publicCaseText = retained
    .readBounded(config.publicCase, PUBLIC_CASE.bytes, PUBLIC_CASE)
    .toString('utf8');
  const archive = verifyRailgunEngineRuntime(config.archive);
  const out = retained.freshDirectory(directory, config);
  const { app } = require('electron');
  app.setPath('userData', path.join(out, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const controller = new AbortController(),
    started = performance.now();
  const timer = setTimeout(() => controller.abort(), 60000);
  const current = () =>
    assert.ok(!controller.signal.aborted && performance.now() - started < 60000);
  let scope, result;
  const originalJobs = [];
  try {
    scope = require('../../src/main/networks/privacy-context').createPrivacyScope({
      profileId: 'public-sender-recovery',
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
    result = await closedJob(
      require('../../src/main/wallet/railgun-process').startRailgunProcess,
      {
        signal: controller.signal,
        process: {
          handle,
          filename: require.resolve('./railgun-relay-sender-recovery-job'),
          input: JSON.stringify({ archive, publicCaseText }),
          binaryKey: false,
          heapMb: 256,
          rssMb: 768,
        },
      },
      validate,
      30000,
      originalJobs,
      'sender-recovery'
    );
    validate(result);
    current();
    assert.equal(verifyRailgunEngineRuntime(config.archive), archive);
    assert.equal(
      retained.readBounded(config.publicCase, PUBLIC_CASE.bytes, PUBLIC_CASE).toString('utf8'),
      publicCaseText
    );
    assert.deepEqual(sources(), before);
    assert.deepEqual(
      originalJobs.map((v) => v.role),
      ['sender-recovery']
    );
    current();
  } finally {
    clearTimeout(timer);
    controller.abort();
    scope?.close();
  }
  const report = {
    schema: 'railgun-retained-sender-recovery-v1',
    sourceSha256: before,
    sourceInventoryIsExecutionCoverage: false,
    externalLauncherProvenanceRequired: true,
    versions: { ...process.versions },
    originalJobs,
    retainedPublicCase: PUBLIC_CASE,
    result,
    liveServiceContacted: false,
    accountOrCapsuleRecoveryQualified: false,
    osEgressSandboxQualified: false,
  };
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  assert.ok(bytes.length <= 262144);
  const filename = path.join(out, 'report.json');
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  assert.deepEqual(
    retained.readBounded(filename, bytes.length, { bytes: bytes.length, sha256: sha(bytes) }),
    bytes
  );
}
module.exports = { readConfig, validate, execute };
