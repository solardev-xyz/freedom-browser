#!/usr/bin/env node
/** Compile the dependency-free HTTP adapter from the reviewed open PPv2 PR.
 * This does not install or execute the access-controlled SDK or a prover.
 * Usage: node scripts/spike-kohaku-ppv2.js /absolute/kohaku/checkout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { transformSync } = require('esbuild');
const revision = '6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e';
const checkout = process.argv[2];
if (!checkout || !path.isAbsolute(checkout)) throw new Error('An absolute Kohaku checkout containing PR 258 is required');
const sources = [
  'packages/privacy-pools/src/v2/adapters/http.adapter.ts',
  'packages/privacy-pools/src/v2/adapters/rpc.adapter.ts',
  'packages/privacy-pools/src/v2/session.ts',
  'packages/privacy-pools/package.json', '.npmrc',
  'examples/ppv2-sample-app/README.md', 'examples/ppv2-sample-app/src/wallet/config.ts',
].map((file) => {
  const source = execFileSync('git', ['-C', checkout, 'show', `${revision}:${file}`], { encoding: 'utf8' });
  return { file, source, sha256: createHash('sha256').update(source).digest('hex') };
});
const { code } = transformSync(sources[0].source, { loader: 'ts', format: 'cjs', target: 'node24' });
if (/\brequire\(/.test(code)) throw new Error('HTTP adapter unexpectedly requires runtime dependencies');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kohaku-ppv2-fixture-'));
const output = path.join(directory, 'http-adapter.cjs');
fs.writeFileSync(output, code);
const report = { revision, upstream: 'https://github.com/ethereum/kohaku/pull/258',
  sources: sources.map(({ file, sha256 }) => ({ file, sha256 })),
  compiledSha256: createHash('sha256').update(code).digest('hex'), esbuild: require('esbuild').version, output,
  scope: 'HTTP-adapter interop only. SDK, proving, deployment and recovery unqualified.',
};
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
