#!/usr/bin/env node
/** Build an isolated ASAR from the pinned, already-built SDK. No installation. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { createRequire } = require('module');
const esbuild = require('esbuild');

async function main() {
  const checkout = process.argv[2];
  if (!checkout || !path.isAbsolute(checkout)) throw new Error('Absolute pinned PPv2 checkout required');
  const revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (revision !== 'fe0244e3f14110efd83db02c60c96517dea9cd5a') throw new Error('Re-review changed SDK');
  if (execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Clean SDK checkout required');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-process-asar-'));
  const source = path.join(directory, 'source'); fs.mkdirSync(source);
  const sdkEntry = path.join(checkout, 'packages/sdk/dist/index.cjs');
  // web-worker uses its own __filename as a child bootstrap. Keep that package
  // separate rather than flattening it into the SDK bundle and breaking it.
  const workers = new Map();
  const built = await esbuild.build({ entryPoints: [sdkEntry], outfile: path.join(source, 'sdk.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', conditions: ['module-sync'], metafile: true,
    plugins: [{ name: 'preserve-worker-bootstrap', setup(build) {
      build.onResolve({ filter: /^web-worker$/ }, ({ importer }) => {
        const entry = createRequire(importer).resolve('web-worker');
        const root = path.dirname(path.dirname(entry));
        const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
        workers.set(version, root);
        return { path: `./node_modules/web-worker-${version}/cjs/node.js`, external: true };
      });
    } }],
  });
  for (const [version, root] of workers) fs.cpSync(root, path.join(source, `node_modules/web-worker-${version}`), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures/ppv2-process-job.js'), path.join(source, 'job.cjs'));
  const artifacts = path.join(source, 'artifacts'); fs.mkdirSync(artifacts);
  const names = { wasm: ['deposit_js/deposit.wasm', 'deposit.wasm'], provingKey: ['groth16_pkey.zkey', 'deposit.zkey'], verificationKey: ['groth16_vkey.json', 'deposit.vkey.json'] };
  const sdk = require(sdkEntry);
  const manifest = Object.entries(names).map(([kind, [relative, name]]) => {
    const bytes = fs.readFileSync(path.join(checkout, 'packages/circuits/build/deposit', relative));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== sdk.DEFAULT_CIRCUIT_MANIFEST.deposit[`${kind}Sha256`]) throw new Error('Artifact digest mismatch');
    fs.writeFileSync(path.join(artifacts, name), bytes); return { kind, name, size: bytes.length, sha256 };
  });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  // Explicit opt-in: hydrate these pinned LFS artifacts first. Never generate
  // replacement proving keys or silently download from a runtime gateway.
  const exitManifest = [];
  if (process.argv[4] === '--exit-circuits') {
    for (const circuit of ['ragequit', 'transact_1x1']) {
      for (const [kind, relative] of Object.entries({ wasm: `${circuit}_js/${circuit}.wasm`,
        provingKey: 'groth16_pkey.zkey', verificationKey: 'groth16_vkey.json' })) {
        const bytes = fs.readFileSync(path.join(checkout, 'packages/circuits/build', circuit, relative));
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== sdk.DEFAULT_CIRCUIT_MANIFEST[circuit][`${kind}Sha256`]) throw new Error('Exit artifact digest mismatch');
        const name = `${circuit}.${{ wasm: 'wasm', provingKey: 'zkey', verificationKey: 'vkey.json' }[kind]}`;
        fs.writeFileSync(path.join(artifacts, name), bytes);
        exitManifest.push({ circuit, kind, name, size: bytes.length, sha256 });
      }
    }
    fs.writeFileSync(path.join(source, 'exit-manifest.json'), JSON.stringify(exitManifest));
    fs.copyFileSync(path.join(__dirname, 'fixtures/ppv2-exit-job.js'), path.join(source, 'exit-job.cjs'));
    // Same locked snarkjs dependency, using its supported prover option. This
    // is an experimental factory implementation, not a patched SDK/dependency.
    await esbuild.build({ stdin: { contents: `const { groth16 } = require('snarkjs');
      exports.fullProve = (input, wasm, key) => groth16.fullProve(input, wasm, key, undefined, undefined, { singleThread: true });
      exports.verify = (...args) => groth16.verify(...args);`, resolveDir: path.join(checkout, 'packages/sdk') },
      outfile: path.join(source, 'serial-prover.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      plugins: [{ name: 'preserve-serial-worker-bootstrap', setup(build) {
        build.onResolve({ filter: /^web-worker$/ }, ({ importer }) => {
          const entry = createRequire(importer).resolve('web-worker');
          const root = path.dirname(path.dirname(entry));
          const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
          if (!workers.has(version)) throw new Error('Unreviewed worker version');
          return { path: `./node_modules/web-worker-${version}/cjs/node.js`, external: true };
        });
      } }],
    });

  }

  // Optional real Kohaku session candidate for the assembled-deposit probe.
  const fixtures = process.argv[3];
  let sessionCandidate = null;
  if (fixtures) {
    if (!path.isAbsolute(fixtures)) throw new Error('Absolute compatibility fixture directory required');
    const previous = JSON.parse(fs.readFileSync(path.join(fixtures, 'report.json')));
    const patchHash = createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures/kohaku-ppv2-compat.patch'))).digest('hex');
    if (!previous.adapterTypecheck.passed || previous.sdkRevision !== revision || previous.compatibilityPatchSha256 !== patchHash ||
        previous.sdkEntrySha256 !== createHash('sha256').update(fs.readFileSync(sdkEntry)).digest('hex')) throw new Error('Rebuild reviewed compatibility fixtures');
    await esbuild.build({ entryPoints: [path.join(fixtures, 'packages/privacy-pools/src/v2/plugin.ts')],
      outfile: path.join(source, 'plugin.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      nodePaths: [path.join(checkout, 'packages/sdk/node_modules')],
      alias: { '@kohaku-eth/plugins': path.join(fixtures, 'packages/plugins/src/index.ts') },
      plugins: [{ name: 'local-sdk', setup(build) {
        build.onResolve({ filter: /^@0xbow-io\/privacy-pools-v2-sdk$/ }, () => ({ path: './sdk.cjs', external: true }));
      } }],
    });
    await esbuild.build({ entryPoints: [path.join(checkout, 'packages/sdk/src/constant/ContractInteractor.ts')],
      outfile: path.join(source, 'abis.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
    fs.copyFileSync(path.join(__dirname, '../test/helpers/ppv2-session-fixture.js'), path.join(source, 'configuration.cjs'));
    sessionCandidate = { kohaku: previous.kohakuRevision, sdk: revision, patchSha256: patchHash };
    fs.writeFileSync(path.join(source, 'candidate.json'), JSON.stringify(sessionCandidate));
  }
  const output = path.join(directory, 'ppv2.asar');
  await require('@electron/asar').createPackage(source, output);
  const report = { revision, output, manifest, exitManifest, sessionCandidate, webWorkerVersions: [...workers.keys()],
    asarSha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'), bundleInputs: Object.keys(built.metafile.inputs).length };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
