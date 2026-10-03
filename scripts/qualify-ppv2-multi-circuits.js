/** Offline resource probe only. Arguments: authenticated ASAR, pinned SDK checkout, new output dir. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { app } = require('electron');
const { loadPPv2Runtime } = require('../src/main/wallet/ppv2-runtime');
const { runPrivacyProcess } = require('../src/main/wallet/privacy-process');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');

async function main() {
  const [archive, checkout, output] = process.argv.slice(2);
  assert.ok([archive, checkout, output].every((p) => p && path.isAbsolute(p)));
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  await app.whenReady();
  const runtime = loadPPv2Runtime(archive);
  const sdkCheckoutRevision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(sdkCheckoutRevision, runtime.candidate.sdk);
  const scope = createPrivacyScope({
    profileId: 'offline-multi-circuit-probe',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-synthetic-witness',
    protocol: 'privacy-pools-v2',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'prover',
  });
  const checks = [];
  try {
    for (const circuit of ['transact_1x2', 'transact_2x1']) {
      const root = path.join(checkout, 'packages/circuits/build', circuit);
      const files = {
        wasm: `${circuit}_js/${circuit}.wasm`,
        provingKey: 'groth16_pkey.zkey',
        verificationKey: 'groth16_vkey.json',
      };
      const artifacts = {},
        inventory = {};
      for (const [kind, file] of Object.entries(files)) {
        const bytes = fs.readFileSync(path.join(root, file));
        artifacts[kind] = Buffer.alloc(bytes.length);
        bytes.copy(artifacts[kind]);
        inventory[kind] = {
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      console.log(`Probing ${circuit}`);
      const started = Date.now();
      try {
        const result = await runPrivacyProcess({
          handle,
          filename: require.resolve('./fixtures/ppv2-multi-circuit-job'),
          input: {
            circuit,
            artifacts,
            sdkEntry: runtime.sdkEntry,
            proverEntry: runtime.proverEntry,
          },
          validateResult: (v) =>
            v?.circuit === circuit &&
            v.verified === true &&
            v.publicSignalsBound === true &&
            v.tamperedAmountRejected === true &&
            v.publicSignalCount === 9,
        });
        checks.push({
          ...result.result,
          passed: true,
          elapsedMs: Date.now() - started,
          peakRssBytes: result.peakRssBytes,
          inventory,
        });
      } catch (error) {
        checks.push({
          circuit,
          passed: false,
          code: error.code || error.name,
          elapsedMs: Date.now() - started,
          inventory,
        });
      }
    }
    const report = {
      passed: checks.every((c) => c.passed),
      syntheticOnly: true,
      networkOperations: false,
      egressPolicy: 'runPrivacyProcess network-denial hooks; this probe does not measure egress',
      signingEnabled: false,
      broadcastEnabled: false,
      productionOperationsEnabled: false,
      runtimeSha256: require('../src/main/wallet/ppv2-runtime-manifest').sha256,
      candidate: { sdk: runtime.candidate.sdk, kohaku: runtime.candidate.kohaku },
      sdkCheckoutRevision,
      sourceSha256: Object.fromEntries(
        [__filename, require.resolve('./fixtures/ppv2-multi-circuit-job')].map((file) => [
          path.relative(path.join(__dirname, '..'), file),
          createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        ])
      ),
      rssMeasurement:
        'Working-set sampling every 100 ms plus at result; includes in-process verification',
      platform: process.platform,
      arch: process.arch,
      logicalCores: os.cpus().length,
      node: process.versions.node,
      electron: process.versions.electron,
      limits: { heapMiB: 256, rssMiB: 768, deadlineMs: 120000 },
      checks,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    return report.passed ? 0 : 1;
  } finally {
    scope.close();
  }
}
main().then(
  (code) => app.exit(code),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
