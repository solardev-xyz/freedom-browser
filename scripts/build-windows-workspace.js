'use strict';

// Build only Codex's sandbox library and helpers, never its model/agent CLI.
// The archive digest pins both source and its Cargo.lock. Our small adapter is
// copied into that workspace so dependencies retain upstream's exact versions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REVISION = '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
const ARCHIVE_SHA256 = '79c8ea8547e1dd9969f63ef6b76a4fb0d1a024ef36c0c627fbcd2ffb658d9312';
const ROOT = path.resolve(__dirname, '..');
const ADAPTER = path.join(ROOT, 'src/main/agent/workspace-execution/native/windows');
const BINARIES = ['freedom-windows-workspace.exe', 'freedom-windows-sandbox-setup.exe', 'freedom-workspace-runner.exe'];

// Namespace OS identities, mutexes, firewall rules and helper discovery. Keep
// upstream Rust API names untouched. Freedom must not rotate Codex's accounts
// or reconcile its firewall rules when both products are installed.
const REPLACEMENTS = [
  ['CodexSandbox', 'FreedomSbx'],
  ['codex_sandbox_offline_', 'freedom_sandbox_offline_'],
  ['Codex Sandbox', 'Freedom Sandbox'],
  ['SOFTWARE\\OpenAI\\Codex\\WindowsSandboxService', 'SOFTWARE\\FreedomBrowser\\WindowsSandbox'],
  ['codex-windows-sandbox-setup', 'freedom-windows-sandbox-setup'],
  ['codex-command-runner', 'freedom-workspace-runner'],
  ['codex-resources', 'freedom-resources'],
  ['.join("OpenAI").join("Codex")', '.join("FreedomBrowser").join("Sandbox")'],
];

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status}`);
}
function patchSandbox(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) patchSandbox(filename);
    else if (item.name.endsWith('.rs') || item.name === 'Cargo.toml') {
      const original = fs.readFileSync(filename, 'utf8');
      let text = original;
      for (const [before, after] of REPLACEMENTS) text = text.replaceAll(before, after);
      if (text !== original) fs.writeFileSync(filename, text);
    }
  }
}

async function buildWindowsWorkspace(arch = process.arch) {
  if (process.platform !== 'win32') throw new Error('Build the Windows workspace helper on Windows');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows architecture: ${arch}`);
  if (arch !== process.arch) throw new Error('Cross-compiling the Windows sandbox is not qualified');
  const cache = path.join(ROOT, 'out/windows-workspace-source');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, `${REVISION}.tar.gz`);
  if (!fs.existsSync(archive)) {
    const response = await fetch(`https://codeload.github.com/openai/codex/tar.gz/${REVISION}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Sandbox source download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== ARCHIVE_SHA256) throw new Error('Sandbox source digest mismatch');
    fs.writeFileSync(archive, bytes, { flag: 'wx' });
  }
  if (digest(archive) !== ARCHIVE_SHA256) throw new Error('Sandbox source digest mismatch');
  const source = path.join(cache, `codex-${REVISION}`);
  if (!fs.existsSync(source)) run('tar.exe', ['-xzf', archive, '-C', cache], ROOT);
  const workspace = path.join(source, 'codex-rs');
  patchSandbox(path.join(workspace, 'windows-sandbox-rs'));
  const manifest = path.join(workspace, 'Cargo.toml');
  let text = fs.readFileSync(manifest, 'utf8');
  if (!text.includes('"freedom-windows-workspace",')) {
    text = text.replace('members = [', 'members = [\n    "freedom-windows-workspace",');
    fs.writeFileSync(manifest, text);
  }
  fs.cpSync(ADAPTER, path.join(workspace, 'freedom-windows-workspace'), { recursive: true });
  const cargo = process.env.FREEDOM_CARGO || path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe');
  run(cargo, ['build', '--release', '-p', 'freedom-windows-workspace', '-p', 'codex-windows-sandbox',
    '--bin', 'freedom-windows-workspace', '--bin', 'freedom-windows-sandbox-setup', '--bin', 'freedom-workspace-runner'], workspace);
  const output = path.join(ROOT, 'out/windows-workspace', arch);
  fs.mkdirSync(output, { recursive: true });
  const hashes = {};
  for (const filename of BINARIES) {
    fs.copyFileSync(path.join(workspace, 'target/release', filename), path.join(output, filename));
    hashes[filename] = digest(path.join(output, filename));
  }
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'CODEX-LICENSE.txt'));
  if (fs.existsSync(path.join(source, 'NOTICE'))) fs.copyFileSync(path.join(source, 'NOTICE'), path.join(output, 'CODEX-NOTICE.txt'));
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify({ version: 1, backend: 'elevated', arch, revision: REVISION, archiveSha256: ARCHIVE_SHA256, binaries: hashes }, null, 2)}\n`);
  console.log(`Windows workspace helper built: ${output}`);
  return output;
}

module.exports = { buildWindowsWorkspace, BINARIES, REVISION, ARCHIVE_SHA256 };
if (require.main === module) buildWindowsWorkspace().catch(error => { console.error(error.message); process.exitCode = 1; });
