#!/usr/bin/env node
/** Compile one pinned, dependency-free upstream host-network consumer into a
 * scratch fixture. No application dependency or upstream source is vendored.
 * Usage: node scripts/spike-kohaku-network.js /absolute/kohaku/checkout
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { transformSync } = require('esbuild');
const revision = '8ac0c528f63e1d43be7b662a1f2f7c15514ca61e';
const checkout = process.argv[2];
if (!checkout || !path.isAbsolute(checkout))
  throw new Error('An absolute Kohaku checkout is required');
const actual = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (actual !== revision) throw new Error('Check out the reviewed Kohaku revision first');
const file = 'packages/tornado-cash/src/relayer/relayer-client.ts';
// Read Git's pinned blob, not a possibly modified working copy.
const source = execFileSync('git', ['-C', checkout, 'show', `${revision}:${file}`], {
  encoding: 'utf8',
});
const { code } = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' });
if (/\brequire\(/.test(code))
  throw new Error('Fixture unexpectedly requires external runtime dependencies');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kohaku-network-fixture-'));
const output = path.join(directory, 'relayer.cjs');
fs.writeFileSync(output, code);
const report = {
  revision,
  source: file,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  compiledSha256: createHash('sha256').update(code).digest('hex'),
  esbuild: require('esbuild').version,
  output,
  scope:
    'Host-network interop with synthetic SOCKS/TLS fixtures only; no on-chain or real relayer submission',
};
fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
