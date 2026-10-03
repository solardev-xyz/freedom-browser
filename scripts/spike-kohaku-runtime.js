#!/usr/bin/env node
/** Build an isolated, inspectable Kohaku runtime fixture from already-installed
 * pinned packages. Does not install dependencies or modify the application.
 * Usage: node scripts/spike-kohaku-runtime.js /absolute/scratch/workspace
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');

async function main() {
  const workspace = process.argv[2];
  if (!workspace || !path.isAbsolute(workspace))
    throw new Error('An absolute scratch workspace is required');
  const versions = {
    plugins: '0.0.1-alpha.13',
    provider: '0.1.0-alpha.9',
    railgun: '0.0.1-alpha.30',
  };
  const metadata = {};
  const imports = {};
  for (const [name, expected] of Object.entries(versions)) {
    const root = path.join(workspace, 'node_modules', '@kohaku-eth', name);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== expected) throw new Error(`Unexpected ${name} version`);
    metadata[name] = { version: pkg.version, license: pkg.license || null };
    const entry = name === 'railgun' ? 'dist/sdk/lib.js' : 'dist/index.js';
    try {
      await import(pathToFileURL(path.join(root, entry)).href);
      imports[name] = 'loaded';
    } catch (error) {
      imports[name] = error.code || error.name;
    }
  }
  const directory = path.join(workspace, 'asar-input');
  fs.mkdirSync(directory, { recursive: true });
  const railgun = path.join(workspace, 'node_modules/@kohaku-eth/railgun/dist');
  esbuild.buildSync({
    entryPoints: [path.join(railgun, 'sdk/lib.js')],
    outfile: path.join(directory, 'railgun.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    nodePaths: [path.resolve(__dirname, '../node_modules')],
  });
  fs.copyFileSync(path.join(railgun, 'pkg/index_bg.wasm'), path.join(directory, 'railgun.wasm'));
  fs.writeFileSync(
    path.join(directory, 'smoke.mjs'),
    `
import * as sdk from './railgun.mjs';
import { readFile } from 'node:fs/promises';
export async function probe() {
  const previous = globalThis.fetch;
  let ambientFetchCalls = 0;
  globalThis.fetch = () => { ambientFetchCalls++; throw new Error('Ambient fetch prohibited in this fixture'); };
  try {
    await sdk.ensureInitialized(new Uint8Array(await readFile(new URL('./railgun.wasm', import.meta.url))));
    // Public reference-vector keys, derived from the standard test/junk mnemonic.
    const spending = '0xb0958f8bc286ae0832fa83b01b719a225a07ce7b861ff311323f221667b3bd50';
    const viewing = '0x9da4b4f0b5493a6ba3f7df0611c3e0842f7e2bb3d640f313b235f1b75c1d80b9';
    const a = sdk.RailgunSigner.privateKey(spending, viewing, 11155111n);
    const b = sdk.RailgunSigner.privateKey(spending, viewing, 11155111n);
    const report = { initialized: true, address: a.address, restoredAddressMatches: a.address === b.address,
      spendingPath: sdk.RailgunSigner.spendingKeyPath(0), viewingPath: sdk.RailgunSigner.viewingKeyPath(0),
      ambientFetchCalls, node: process.versions.node, electron: process.versions.electron || null };
    a.free(); b.free();
    return report;
  } finally { globalThis.fetch = previous; }
}
`
  );
  fs.writeFileSync(
    path.join(directory, 'loader.cjs'),
    "exports.probe = async () => (await import('./smoke.mjs')).probe();\n"
  );
  const output = path.join(workspace, 'kohaku-runtime.asar');
  await require('@electron/asar').createPackage(directory, output);
  const nodeReport = await (
    await import(pathToFileURL(path.join(directory, 'smoke.mjs')).href)
  ).probe();
  const report = {
    metadata,
    directImports: imports,
    explicitBundlerDependency: { viem: require('viem/package.json').version },
    asarSha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
    nodeReport,
    scope:
      'Loading, WASM initialization and synthetic address reconstruction only; no sync, proving or broadcast',
  };
  fs.writeFileSync(path.join(workspace, 'runtime-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Electron fixture: ${output}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
