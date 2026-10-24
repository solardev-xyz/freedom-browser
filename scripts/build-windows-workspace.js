'use strict';

// Build only Codex's sandbox library and helpers, never its model/agent CLI.
// The archive digest pins both source and its Cargo.lock. Our small adapter is
// copied into that workspace so dependencies retain upstream's exact versions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { writeWindowsNotices } = require('./windows-workspace-notices');

const REVISION = '092d3acd6bec3e3a14bdc7e7a2810ab628ab759d';
const ARCHIVE_SHA256 = '79c8ea8547e1dd9969f63ef6b76a4fb0d1a024ef36c0c627fbcd2ffb658d9312';
const ROOT = path.resolve(__dirname, '..');
const ADAPTER = path.join(ROOT, 'src/main/agent/workspace-execution/native/windows');
const BINARIES = ['freedom-windows-workspace.exe', 'freedom-windows-sandbox-setup.exe', 'freedom-workspace-runner.exe'];

// Namespace OS identities, mutexes, firewall rules and helper discovery. Keep
// upstream Rust API names untouched. Freedom must not rotate Codex's accounts
// or reconcile its firewall rules when both products are installed.
const WFP_IDENTITIES = [
  ['0x2e31d31c_3948_4753_9117_e5d1a6496f41', '0xa73fae3d_c5b8_5525_bbc8_351f2742de8e'],
  ['0xe65054fd_4d32_4c7c_95ef_621f0cf6431a', '0x71c15a5a_68e8_52e2_ab7e_760350b33a21'],
  ['0x9f5f3812_79f0_4fe9_9615_4c2c92d2f0ff', '0x0c725ad1_2ee4_57b3_ae38_a33ec12bc7fc'],
  ['0x87498484_45ab_4510_845e_ece8b791b3bc', '0x95d6fdce_d18f_5d33_abb4_f77366454833'],
  ['0xaf4751de_f874_4a7b_a34d_f0d0f22d1d9b', '0xb959ac01_e338_59a4_99c2_b869db502bd3'],
  ['0xea10db66_a928_4b2e_a82e_a376a54f93ba', '0x1085c584_995e_5d7e_b9fe_c9242c5cada1'],
  ['0x83172805_f6be_4ae1_9dc6_6847aef04e7f', '0x1249c5c3_69ab_590b_b2b9_cf152234dec8'],
  ['0xd23b2efb_1efb_46b2_96f3_b0ccda5690c8', '0xbab38255_8f65_5ee6_b62f_c183cb235773'],
  ['0x420b026f_9dc9_4aea_88f4_0f2b9feab39a', '0x09046167_7a59_54f1_b597_77d44282dfe5'],
  ['0x8d917c81_99cc_45e7_84d6_824df860cfb8', '0x5f63a299_6f95_5605_adb8_8a6158d69483'],
  ['0xe1d6e0af_ce5f_471b_b2d3_15ca00e966f3', '0x4f3d5bed_0ec8_5f2a_ad02_20e8eafb4505'],
  ['0xc2bceca4_66ef_4a0f_ba80_f4f761b8c6f0', '0x5c009aba_422b_52a8_ab81_b525e526634e'],
  ['0xba10c618_84e7_4b83_8f74_36e22b2fa1ff', '0xe8de2aba_5dad_56b9_8b45_b161bd56d9b2'],
  ['0xfe7f22b8_5cf5_4adb_b2aa_71fc0a8f5d44', '0xc54f8184_7a1f_52e7_8c46_ce06522d0a17'],
];
const RUST_TOOLCHAIN = '1.95.0';
const REPLACEMENTS = [
  ...WFP_IDENTITIES,
  ['codex_wfp_', 'freedom_wfp_'],
  ['Codex Windows Sandbox', 'Freedom Windows Sandbox'],
  ['CodexSandbox', 'FreedomSbx'],
  ['codex_sandbox_offline_', 'freedom_sandbox_offline_'],
  ['Codex Sandbox', 'Freedom Sandbox'],
  ['SOFTWARE\\OpenAI\\Codex\\WindowsSandboxService', 'SOFTWARE\\FreedomBrowser\\WindowsSandbox'],
  ['codex-windows-sandbox-setup', 'freedom-windows-sandbox-setup'],
  ['codex-command-runner', 'freedom-workspace-runner'],
  ['codex-resources', 'freedom-resources'],
  ['.join("OpenAI").join("Codex")', '.join("FreedomBrowser").join("Sandbox")'],
];

// The setup helper runs elevated from the per-user install directory, so a
// DLL planted beside it must never load. netapi32.dll and fwpuclnt.dll are not
// KnownDLLs and windows-sys links them as static (raw-dylib) imports, which the
// loader resolves before main and searches from the executable directory first.
// /DEPENDENTLOADFLAG makes the loader resolve every helper's static imports from
// System32; each main then calls SetDefaultDllDirectories before any runtime load.
const LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x800;
const RUST_TARGETS = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };
function cargoConfigArgs(arch) {
  // Joined with, not replacing, upstream's target rustflags (stack size, static CRT).
  return ['--config', `target.${RUST_TARGETS[arch]}.rustflags=["-C","link-arg=/DEPENDENTLOADFLAG:0x${LOAD_LIBRARY_SEARCH_SYSTEM32.toString(16)}"]`];
}
const RESTRICT_DLL_SEARCH = `    // Freedom: search System32 only for every DLL loaded from here on.
    if unsafe {
        windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories(
            windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    } == 0 {
        anyhow::bail!("Cannot restrict the DLL search path");
    }
`;
const DLL_SEARCH_PATCHES = [
  ['src/bin/setup_main/main.rs', 'fn main() -> anyhow::Result<()> {\n', '    codex_windows_sandbox::setup_helper_main()\n}'],
  ['src/bin/command_runner/main.rs', 'fn main() -> anyhow::Result<()> {\n', '    win::main()\n}'],
];
function restrictDllSearch(sandbox) {
  for (const [file, head, body] of DLL_SEARCH_PATCHES) {
    const filename = path.join(sandbox, file);
    const original = fs.readFileSync(filename, 'utf8');
    const text = original.replace(head + body, head + RESTRICT_DLL_SEARCH + body);
    if (!text.includes(head + RESTRICT_DLL_SEARCH + body)) throw new Error(`Cannot restrict the DLL search path in ${file}`);
    if (text !== original) fs.writeFileSync(filename, text);
  }
}
// DependentLoadFlags from a PE32+ file's load configuration, 0 when absent.
function dependentLoadFlags(bytes) {
  const header = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(header) !== 0x4550) throw new Error('Not a PE image');
  const optional = header + 24;
  if (bytes.readUInt16LE(optional) !== 0x20b) throw new Error('Not a PE32+ image');
  if (bytes.readUInt32LE(optional + 108) <= 10) return 0;
  const rva = bytes.readUInt32LE(optional + 112 + 10 * 8);
  if (!rva) return 0;
  const sections = optional + bytes.readUInt16LE(header + 20);
  for (let index = 0; index < bytes.readUInt16LE(header + 6); index++) {
    const section = sections + index * 40;
    const address = bytes.readUInt32LE(section + 12);
    if (rva < address || rva >= address + Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16))) continue;
    const offset = bytes.readUInt32LE(section + 20) + rva - address;
    return bytes.readUInt32LE(offset) >= 0x50 ? bytes.readUInt16LE(offset + 0x4e) : 0;
  }
  throw new Error('PE load configuration is outside every section');
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
// Everything besides the pinned source that decides the helpers' bytes: this
// script, the notices writer and every adapter file, by path and content.
function recipeSha256() {
  const files = [__filename, path.join(__dirname, 'windows-workspace-notices.js')];
  const walk = directory => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) walk(filename);
      else files.push(filename);
    }
  };
  walk(ADAPTER);
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(`${digest(file)}  ${path.relative(ROOT, file).split(path.sep).join('/')}\n`);
  return hash.digest('hex');
}
// The release workflow builds the helpers in their own job and stages them
// here before packaging. Reuse such a build only while its manifest still
// matches this recipe and every file it names; anything else is rebuilt.
function currentBuild(output, arch) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    return manifest.version === 1 && manifest.backend === 'elevated' && manifest.arch === arch &&
      manifest.revision === REVISION && manifest.archiveSha256 === ARCHIVE_SHA256 &&
      manifest.adapterSha256 === digest(path.join(ADAPTER, 'src/main.rs')) && manifest.recipeSha256 === recipeSha256() &&
      BINARIES.every(filename => manifest.binaries?.[filename] === digest(path.join(output, filename))) &&
      ['CODEX-LICENSE.txt', 'CODEX-DEPENDENCIES.json', 'CODEX-DEPENDENCIES.txt'].every(filename => fs.existsSync(path.join(output, filename)));
  } catch { return false; }
}
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
  const output = path.join(ROOT, 'out/windows-workspace', arch);
  if (currentBuild(output, arch)) {
    console.log(`Windows workspace helper is current: ${output}`);
    return output;
  }
  if (process.env.FREEDOM_WINDOWS_WORKSPACE_PREBUILT === '1') throw new Error(`No current prebuilt Windows workspace helper in ${output}`);
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
  const extracted = path.join(source, '.freedom-extracted');
  if (!fs.existsSync(extracted)) {
    // This Unix-only vendored license is a symlink. Windows tar cannot create
    // it as a standard user; the sandbox build does not use bubblewrap.
    run('tar.exe', ['-xzf', archive, '--exclude=*/vendor/bubblewrap/LICENSE', '-C', cache], ROOT);
    fs.writeFileSync(extracted, ARCHIVE_SHA256);
  }
  const workspace = path.join(source, 'codex-rs');
  patchSandbox(path.join(workspace, 'windows-sandbox-rs'));
  restrictDllSearch(path.join(workspace, 'windows-sandbox-rs'));
  const wfpSource = ['src/wfp.rs', 'src/wfp/filter_specs.rs'].map(file =>
    fs.readFileSync(path.join(workspace, 'windows-sandbox-rs', file), 'utf8')).join('\n');
  if (WFP_IDENTITIES.some(([before, after]) => wfpSource.includes(before) || !wfpSource.includes(after))) {
    throw new Error('Windows sandbox filter identities were not isolated from Codex');
  }
  fs.copyFileSync(path.join(workspace, 'windows-sandbox-rs/codex-windows-sandbox-setup.manifest'),
    path.join(workspace, 'windows-sandbox-rs/freedom-windows-sandbox-setup.manifest'));
  const manifest = path.join(workspace, 'Cargo.toml');
  // The release tag updates workspace.package but leaves Cargo.lock at 0.0.0.
  // Restore that local-package label; the source/third-party versions stay pinned.
  let text = fs.readFileSync(manifest, 'utf8').replace('[workspace.package]\nversion = "0.162.1"', '[workspace.package]\nversion = "0.0.0"');
  if (!text.includes('"freedom-windows-workspace",')) {
    text = text.replace('members = [', 'members = [\n    "freedom-windows-workspace",');
  }
  fs.writeFileSync(manifest, text);
  fs.cpSync(ADAPTER, path.join(workspace, 'freedom-windows-workspace'), { recursive: true });
  const locked = spawnSync('tar.exe', ['-xOf', archive, `codex-${REVISION}/codex-rs/Cargo.lock`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (locked.status !== 0) throw new Error('Cannot read the pinned sandbox lockfile');
  fs.writeFileSync(path.join(workspace, 'Cargo.lock'), `${locked.stdout}\n[[package]]\nname = "freedom-windows-workspace"\nversion = "0.1.0"\ndependencies = [\n "anyhow",\n "base64 0.22.1",\n "codex-protocol",\n "codex-utils-absolute-path",\n "codex-windows-sandbox",\n "serde",\n "serde_json",\n "tokio",\n]\n`);
  const cargo = process.env.FREEDOM_CARGO || path.join(process.env.USERPROFILE, '.cargo/bin/cargo.exe');
  run(cargo, [`+${RUST_TOOLCHAIN}`, 'build', '--locked', '--release', ...cargoConfigArgs(arch), '-p', 'freedom-windows-workspace', '-p', 'codex-windows-sandbox',
    '--bin', 'freedom-windows-workspace', '--bin', 'freedom-windows-sandbox-setup', '--bin', 'freedom-workspace-runner'], workspace);
  run(cargo, [`+${RUST_TOOLCHAIN}`, 'test', '--locked', '--release', ...cargoConfigArgs(arch), '-p', 'freedom-windows-workspace',
    '--bin', 'freedom-windows-workspace'], workspace);
  fs.mkdirSync(output, { recursive: true });
  const hashes = {};
  for (const filename of BINARIES) {
    fs.copyFileSync(path.join(workspace, 'target/release', filename), path.join(output, filename));
    if (dependentLoadFlags(fs.readFileSync(path.join(output, filename))) !== LOAD_LIBRARY_SEARCH_SYSTEM32) {
      throw new Error(`${filename} would resolve its DLL imports outside System32`);
    }
    hashes[filename] = digest(path.join(output, filename));
  }
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(output, 'CODEX-LICENSE.txt'));
  if (fs.existsSync(path.join(source, 'NOTICE'))) fs.copyFileSync(path.join(source, 'NOTICE'), path.join(output, 'CODEX-NOTICE.txt'));
  await writeWindowsNotices({ cargo, workspace, source, output, freedomRoot: ROOT, arch });
  const adapterSha256 = digest(path.join(ADAPTER, 'src/main.rs'));
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify({ version: 1, backend: 'elevated', arch, revision: REVISION, archiveSha256: ARCHIVE_SHA256, adapterSha256, recipeSha256: recipeSha256(), binaries: hashes }, null, 2)}\n`);
  console.log(`Windows workspace helper built: ${output}`);
  return output;
}

module.exports = { buildWindowsWorkspace, BINARIES, REVISION, ARCHIVE_SHA256, WFP_IDENTITIES, REPLACEMENTS, RUST_TOOLCHAIN, patchSandbox,
  cargoConfigArgs, restrictDllSearch, dependentLoadFlags, LOAD_LIBRARY_SEARCH_SYSTEM32, recipeSha256, currentBuild };
if (require.main === module) buildWindowsWorkspace().catch(error => { console.error(error.message); process.exitCode = 1; });
