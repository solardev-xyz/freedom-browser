'use strict';

const { WFP_IDENTITIES, REPLACEMENTS, RUST_TOOLCHAIN } = require('./build-windows-workspace');

test('Freedom owns all fourteen WFP identities independently of Codex', () => {
  expect(WFP_IDENTITIES).toHaveLength(14);
  const before = WFP_IDENTITIES.map(pair => pair[0]);
  const after = WFP_IDENTITIES.map(pair => pair[1]);
  expect(new Set(after).size).toBe(14);
  for (const identity of after) {
    expect(identity).toMatch(/^0x[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/);
    expect(before).not.toContain(identity);
  }
  expect(REPLACEMENTS).toContainEqual(['codex_wfp_', 'freedom_wfp_']);
  expect(RUST_TOOLCHAIN).toBe('1.95.0');
});

describe('DLL search hardening', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { cargoConfigArgs, restrictDllSearch, dependentLoadFlags, LOAD_LIBRARY_SEARCH_SYSTEM32 } = require('./build-windows-workspace');

  test('every helper links with System32-only static import resolution', () => {
    expect(LOAD_LIBRARY_SEARCH_SYSTEM32).toBe(0x800);
    expect(cargoConfigArgs('x64')).toEqual(['--config', 'target.x86_64-pc-windows-msvc.rustflags=["-C","link-arg=/DEPENDENTLOADFLAG:0x800"]']);
    expect(cargoConfigArgs('arm64')[1]).toMatch(/^target\.aarch64-pc-windows-msvc\.rustflags=.*\/DEPENDENTLOADFLAG:0x800/);
    const script = fs.readFileSync(path.join(__dirname, 'build-windows-workspace.js'), 'utf8');
    expect(script.match(/\.\.\.cargoConfigArgs\(arch\)/g)).toHaveLength(2);
    expect(script).toContain('restrictDllSearch(path.join(workspace, \'windows-sandbox-rs\'));');
  });

  test('the setup helper and runner restrict runtime DLL search before anything else', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-dll-search-'));
    try {
      const upstream = {
        'src/bin/setup_main/main.rs': '#[cfg(target_os = "windows")]\nfn main() -> anyhow::Result<()> {\n    codex_windows_sandbox::setup_helper_main()\n}\n',
        'src/bin/command_runner/main.rs': '#[cfg(target_os = "windows")]\nfn main() -> anyhow::Result<()> {\n    win::main()\n}\n',
      };
      for (const [file, text] of Object.entries(upstream)) {
        fs.mkdirSync(path.dirname(path.join(sandbox, file)), { recursive: true });
        fs.writeFileSync(path.join(sandbox, file), text);
      }
      restrictDllSearch(sandbox);
      const patched = Object.keys(upstream).map(file => fs.readFileSync(path.join(sandbox, file), 'utf8'));
      restrictDllSearch(sandbox);
      expect(Object.keys(upstream).map(file => fs.readFileSync(path.join(sandbox, file), 'utf8'))).toEqual(patched);
      for (const text of patched) {
        expect(text).toMatch(/fn main\(\) -> anyhow::Result<\(\)> \{\n {4}\/\/ Freedom: [^\n]+\n {4}if unsafe \{\n {8}windows_sys::Win32::System::LibraryLoader::SetDefaultDllDirectories\(\n {12}windows_sys::Win32::System::LibraryLoader::LOAD_LIBRARY_SEARCH_SYSTEM32,/);
      }
      fs.writeFileSync(path.join(sandbox, 'src/bin/command_runner/main.rs'), 'fn main() -> anyhow::Result<()> {\n    other::main()\n}\n');
      expect(() => restrictDllSearch(sandbox)).toThrow('Cannot restrict the DLL search path in src/bin/command_runner/main.rs');
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  });

  test('the workspace adapter restricts DLL search as its first step', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/main/agent/workspace-execution/native/windows/src/main.rs'), 'utf8');
    expect(source).toMatch(/\nfn main\(\) \{\n {4}let result = \(\|\| -> Result<\(\)> \{\n {8}restrict_dll_search\(\)\?;\n/);
    expect(source).toMatch(/fn restrict_dll_search\(\) -> Result<\(\)> \{\n {4}if unsafe \{ SetDefaultDllDirectories\(LOAD_LIBRARY_SEARCH_SYSTEM32\) \} == 0/);
    expect(source).toContain('const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x800;');
  });

  test('reads DependentLoadFlags from a PE32+ load configuration', () => {
    const image = (flags, { configSize = 0x140, directories = 16 } = {}) => {
      const bytes = Buffer.alloc(0x600);
      bytes.write('MZ', 0, 'ascii');
      bytes.writeUInt32LE(0x80, 0x3c);
      bytes.writeUInt32LE(0x4550, 0x80);
      bytes.writeUInt16LE(1, 0x80 + 6);
      bytes.writeUInt16LE(240, 0x80 + 20);
      const optional = 0x80 + 24;
      bytes.writeUInt16LE(0x20b, optional);
      bytes.writeUInt32LE(directories, optional + 108);
      bytes.writeUInt32LE(0x2010, optional + 112 + 80);
      const section = optional + 240;
      bytes.writeUInt32LE(0x200, section + 8);
      bytes.writeUInt32LE(0x2000, section + 12);
      bytes.writeUInt32LE(0x200, section + 16);
      bytes.writeUInt32LE(0x400, section + 20);
      bytes.writeUInt32LE(configSize, 0x410);
      bytes.writeUInt16LE(flags, 0x410 + 0x4e);
      return bytes;
    };
    expect(dependentLoadFlags(image(0x800))).toBe(0x800);
    expect(dependentLoadFlags(image(0))).toBe(0);
    expect(dependentLoadFlags(image(0x800, { configSize: 0x48 }))).toBe(0);
    expect(dependentLoadFlags(image(0x800, { directories: 10 }))).toBe(0);
    const notPe = image(0x800); notPe.write('ZZ', 0, 'ascii');
    expect(() => dependentLoadFlags(notPe)).toThrow('Not a PE image');
  });
});

describe('reusing a staged helper build', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { currentBuild, recipeSha256, textDigest, BINARIES, REVISION, ARCHIVE_SHA256 } = require('./build-windows-workspace');
  const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const adapter = path.join(__dirname, '../src/main/agent/workspace-execution/native/windows/src/main.rs');

  const stage = () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-windows-workspace-'));
    const binaries = {};
    for (const filename of BINARIES) {
      fs.writeFileSync(path.join(output, filename), `binary ${filename}`);
      binaries[filename] = sha256(`binary ${filename}`);
    }
    for (const filename of ['CODEX-LICENSE.txt', 'CODEX-DEPENDENCIES.json', 'CODEX-DEPENDENCIES.txt']) fs.writeFileSync(path.join(output, filename), 'notice');
    const manifest = { version: 1, backend: 'elevated', arch: 'x64', revision: REVISION, archiveSha256: ARCHIVE_SHA256,
      adapterSha256: textDigest(adapter), recipeSha256: recipeSha256(), binaries };
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest));
    return { output, manifest };
  };

  test('a build matching the recipe and every file it names is reused', () => {
    const { output } = stage();
    try {
      expect(currentBuild(output, 'x64')).toBe(true);
      expect(currentBuild(output, 'arm64')).toBe(false);
    } finally { fs.rmSync(output, { recursive: true, force: true }); }
  });

  test('a changed binary, a stale recipe or a missing notice forces a rebuild', () => {
    for (const tamper of [
      ({ output }) => fs.appendFileSync(path.join(output, BINARIES[1]), 'x'),
      ({ output, manifest }) => fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...manifest, recipeSha256: '0'.repeat(64) })),
      ({ output, manifest }) => fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ ...manifest, recipeSha256: undefined })),
      ({ output }) => fs.rmSync(path.join(output, 'CODEX-DEPENDENCIES.txt')),
      ({ output }) => fs.writeFileSync(path.join(output, 'manifest.json'), '{'),
    ]) {
      const staged = stage();
      try {
        tamper(staged);
        expect(currentBuild(staged.output, 'x64')).toBe(false);
      } finally { fs.rmSync(staged.output, { recursive: true, force: true }); }
    }
    expect(currentBuild(path.join(os.tmpdir(), 'freedom-no-such-build'), 'x64')).toBe(false);
  });

  // The published helpers are built on a core.autocrlf Windows checkout and
  // reused on LF ones; the repository LICENSE lands in CODEX-DEPENDENCIES.*.
  test('the recipe ignores line endings but tracks the repository LICENSE', () => {
    const real = fs.readFileSync;
    const license = path.join(__dirname, '../LICENSE');
    const recipe = recipeSha256();
    const adapterDigest = textDigest(adapter);
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      read.mockImplementation((file, ...rest) => {
        const out = real(file, ...rest);
        if (String(file).endsWith('manifest.json')) return out;
        const crlf = String(out).replace(/\n/g, '\r\n');
        return typeof out === 'string' ? crlf : Buffer.from(crlf);
      });
      expect(recipeSha256()).toBe(recipe);
      expect(textDigest(adapter)).toBe(adapterDigest);
      read.mockImplementation((file, ...rest) => {
        const out = real(file, ...rest);
        return path.resolve(String(file)) === license ? `${out}changed\n` : out;
      });
      expect(recipeSha256()).not.toBe(recipe);
    } finally { read.mockRestore(); }
  });
});
