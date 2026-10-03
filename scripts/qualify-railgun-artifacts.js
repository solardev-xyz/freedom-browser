/** Local public artifact qualification. Existing snarkjs only; no installation,
 * download, wallet witness or signing. Captured RPC agreement is not chain proof.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const {
  manifest,
  loadRailgunArtifacts,
  assertRailgunArtifactVerifier,
} = require('../src/main/wallet/railgun-artifacts');
const sha = (data) => createHash('sha256').update(data).digest('hex');
async function main() {
  const [directory, snarkjsDirectory, output] = process.argv.slice(2);
  for (const p of [directory, snarkjsDirectory, output]) assert.ok(path.isAbsolute(p));
  assert.ok(!fs.existsSync(output));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(snarkjsDirectory, 'package.json'))).version,
    '0.7.5'
  );
  const snarkjs = require(snarkjsDirectory);
  const deploymentFile = path.join(
    __dirname,
    '../docs/qualification/railgun-sepolia-verifiers-2026-10-02.json'
  );
  const deployment = JSON.parse(fs.readFileSync(deploymentFile));
  const scope = createPrivacyScope({
    profileId: 'railgun-artifact-qualification',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-artifacts',
    protocol: 'railgun',
    deployment: 'captured-sepolia',
    chainId: 11155111,
    role: 'artifacts',
  });
  const sources = [
    'scripts/qualify-railgun-artifacts.js',
    'src/main/wallet/railgun-artifacts.js',
    'src/main/wallet/privacy-artifacts.js',
    'src/main/networks/privacy-context.js',
    'docs/qualification/railgun-sepolia-verifiers-2026-10-02.json',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
    );
  const sourceSha256 = hashes(),
    reports = [];
  try {
    for (const variant of Object.keys(manifest)) {
      const artifacts = await loadRailgunArtifacts({ handle, directory, variant });
      try {
        // Read the same pinned bytes again after export; local privileged writers
        // are outside this qualification's trust boundary.
        const zkeyFilename = path.join(directory, variant + '.zkey');
        const derived = await snarkjs.zKey.exportVerificationKey(zkeyFilename);
        assert.equal(
          sha(fs.readFileSync(zkeyFilename)),
          manifest[variant].find((x) => x.kind === 'zkey').sha256
        );
        for (const name of [
          'protocol',
          'nPublic',
          'vk_alpha_1',
          'vk_beta_2',
          'vk_gamma_2',
          'vk_delta_2',
          'vk_alphabeta_12',
          'IC',
        ])
          assert.deepEqual(derived[name], artifacts.vkey[name]);
        assert.equal(derived.curve.toLowerCase(), artifacts.vkey.curve.toLowerCase());
        const shape = variant.startsWith('POI') ? null : variant.split('x').map(Number);
        const captured =
          shape &&
          deployment.verificationKeys.find(
            (v) => JSON.stringify(v.shape) === JSON.stringify(shape)
          );
        if (captured) assertRailgunArtifactVerifier(artifacts, captured.encoded);
        reports.push({
          variant,
          nPublic: derived.nPublic,
          artifacts: manifest[variant],
          derivedVkeySha256: sha(JSON.stringify(derived)),
          derivedVkeyMatches: true,
          capturedVerifierMatches: !!captured,
          capturedArtifactCID: captured ? captured.artifactsIPFSHash : null,
        });
      } finally {
        artifacts.wasm.fill(0);
        artifacts.zkey.fill(0);
      }
    }
    assert.deepEqual(hashes(), sourceSha256);
    const loadedModules = Object.keys(require.cache)
      .filter((p) => p.includes('/node_modules/'))
      .sort()
      .map((filename) => ({
        file: path.relative(path.resolve(__dirname, '..'), filename),
        sha256: sha(fs.readFileSync(filename)),
      }));
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          snarkjsVersion: '0.7.5',
          loadedModules,
          upstreamWalletCommit: '5c9d04c844879b8377d91775052e88c836b48730',
          upstreamHashesSha256: '19e13c94aeeadc28d1a7e31631f9f025a5f32ad9f8771a17c45f74d5ed5d9bb8',
          archiveAnchor: deployment.anchor,
          sourceTrust: deployment.trust,
          liveAcquisition: false,
          submissions: 0,
          reports,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(
      JSON.stringify({
        variants: reports.length,
        capturedVerifierMatches: reports.filter((r) => r.capturedVerifierMatches).length,
      })
    );
  } finally {
    scope.close();
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
