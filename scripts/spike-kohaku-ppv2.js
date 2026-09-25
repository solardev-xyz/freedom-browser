#!/usr/bin/env node
/** Compile dependency-free HTTP/storage adapters from the reviewed PPv2 PR.
 * This does not install or execute the access-controlled SDK or a prover.
 * Usage: node scripts/spike-kohaku-ppv2.js /absolute/kohaku/checkout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { transformSync, buildSync } = require('esbuild');
const revision = '6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e';
const checkout = process.argv[2];
if (!checkout || !path.isAbsolute(checkout)) throw new Error('An absolute Kohaku checkout containing PR 258 is required');
const sources = [
  'packages/privacy-pools/src/v2/adapters/http.adapter.ts',
  'packages/privacy-pools/src/v2/adapters/rpc.adapter.ts',
  'packages/privacy-pools/src/v2/session.ts',
  'packages/privacy-pools/package.json', '.npmrc',
  'examples/ppv2-sample-app/README.md', 'examples/ppv2-sample-app/src/wallet/config.ts',
  'packages/privacy-pools/src/v2/adapters/storage.adapter.ts',
  'packages/privacy-pools/src/v2/interfaces/errors.ts', 'packages/plugins/src/errors.ts',
  'examples/ppv2-sample-app/src/live/session.ts', 'packages/privacy-pools/src/v2/account/derivation.ts',
].map((file) => {
  const source = execFileSync('git', ['-C', checkout, 'show', `${revision}:${file}`], { encoding: 'utf8' });
  return { file, source, sha256: createHash('sha256').update(source).digest('hex') };
});
const { code } = transformSync(sources[0].source, { loader: 'ts', format: 'cjs', target: 'node24' });
if (/\brequire\(/.test(code)) throw new Error('HTTP adapter unexpectedly requires runtime dependencies');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kohaku-ppv2-fixture-'));
const output = path.join(directory, 'http-adapter.cjs');
fs.writeFileSync(output, code);
// Bundle only the exact storage adapter and its error hierarchy. Mapping the
// plugins import to its pinned error module avoids executing unrelated package
// entry points; type-only SDK imports disappear during TS compilation.
for (const source of sources.slice(7, 10)) {
  const target = path.join(directory, source.file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source.source);
}
const storageBuild = buildSync({
  entryPoints: [path.join(directory, sources[7].file)], bundle: true, write: false,
  platform: 'node', format: 'cjs', target: 'node24',
  alias: { '@kohaku-eth/plugins': path.join(directory, 'packages/plugins/src/errors.ts') },
});
const storageCode = storageBuild.outputFiles[0].text;
if (/\brequire\(/.test(storageCode)) throw new Error('Storage fixture unexpectedly requires runtime dependencies');
const storageOutput = path.join(directory, 'storage-adapter.cjs');
fs.writeFileSync(storageOutput, storageCode);
const report = { revision, upstream: 'https://github.com/ethereum/kohaku/pull/258',
  sources: sources.map(({ file, sha256 }) => ({ file, sha256 })),
  compiledSha256: createHash('sha256').update(code).digest('hex'), esbuild: require('esbuild').version, output,
  storageOutput, storageCompiledSha256: createHash('sha256').update(storageCode).digest('hex'),
  scope: 'HTTP/storage-adapter interop only. SDK, proving, deployment and shielded-note recovery unqualified.',
};
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
