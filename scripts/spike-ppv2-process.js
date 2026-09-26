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
  const output = path.join(directory, 'ppv2.asar');
  await require('@electron/asar').createPackage(source, output);
  const report = { revision, output, manifest, webWorkerVersions: [...workers.keys()],
    asarSha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'), bundleInputs: Object.keys(built.metafile.inputs).length };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
