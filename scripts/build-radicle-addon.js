/**
 * Build the libradicle napi addon from a sibling checkout and install it
 * into radicle-bin/<platform>/libradicle.node, where radicle-embedded.js
 * looks for it.
 *
 * Usage: npm run radicle:build-addon [-- /path/to/libradicle]
 *
 * The libradicle repo: rad:z2SzCC9zYnP17QRPZUhrP2RTEwZHj
 * (clone with `rad clone`, or from a mirror). Default expected location
 * is a sibling directory of this repo.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const repoRoot = path.join(__dirname, '..');
const libradicleDir = process.argv[2] || path.join(repoRoot, '..', 'libradicle');

if (!fs.existsSync(path.join(libradicleDir, 'napi', 'Cargo.toml'))) {
  console.error(`libradicle checkout not found at ${libradicleDir}`);
  console.error('Clone it next to freedom-browser, or pass the path:');
  console.error('  rad clone rad:z2SzCC9zYnP17QRPZUhrP2RTEwZHj');
  console.error('  npm run radicle:build-addon -- /path/to/libradicle');
  process.exit(1);
}

console.log(`Building libradicle napi addon (release) in ${libradicleDir}…`);
execSync('cargo build --release -p libradicle-napi', {
  cwd: libradicleDir,
  stdio: 'inherit',
});

const ext = { darwin: 'dylib', win32: 'dll' }[process.platform] || 'so';
const prefix = process.platform === 'win32' ? '' : 'lib';
const artifact = path.join(
  libradicleDir,
  'target',
  'release',
  `${prefix}libradicle_napi.${ext}`
);

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const platformKey =
  process.platform === 'darwin'
    ? `mac-${arch}`
    : process.platform === 'win32'
      ? `win-${arch}`
      : `linux-${arch}`;

const destDir = path.join(repoRoot, 'radicle-bin', platformKey);
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, 'libradicle.node');
fs.copyFileSync(artifact, dest);
console.log(`Installed ${dest}`);
