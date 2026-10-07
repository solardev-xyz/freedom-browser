// Ships the Visual C++ runtime DLLs next to every Windows binary that imports
// them (#563). Run from the afterPack hook (scripts/after-pack.js) on a win32
// package, before electron-builder wraps it into the installer and the zip.
//
// The Rust-built binaries Freedom bundles (Ant's antd.exe, arti.exe, the
// libradicle and Myotis addons) link the C runtime dynamically, so they import
// vcruntime140.dll. The Universal CRT half (api-ms-win-crt-*) is part of
// Windows 10/11, but vcruntime140.dll is not: it comes with the Visual C++
// Redistributable, which GitHub's Windows runners have and a clean Windows 11
// install does not. Without it arti.exe exits 0xC0000135 (DLL not found) and
// the addons fail to load, so Tor, Radicle and Ant never start.
//
// Microsoft allows exactly this, "app-local" deployment: the DLL goes in the
// same directory as the binary that needs it. That one placement covers both
// ways these binaries are loaded. A spawned .exe searches its own directory
// first. A .node addon is loaded by Node with LOAD_WITH_ALTERED_SEARCH_PATH,
// which searches the addon's directory first, but not the directory of
// Freedom.exe. So the DLLs are copied per directory, not once at the root.
//
// Driven by the binaries' import tables rather than a list of paths, so a new
// bundled binary is covered without anyone remembering this file. The DLLs
// come from the MSVC redistributable directory of the build machine's Visual
// Studio (VCToolsRedistDir, set by the developer shell release.yml packages
// in), or from FREEDOM_VCRUNTIME_DIR. If a binary imports one and none can be
// found, the build fails rather than ship a package that breaks on a clean
// machine.

const fs = require('fs');
const path = require('path');

// The Visual C++ runtime DLLs Microsoft lists as redistributable. The
// api-ms-win-crt-* / ucrtbase.dll half is the Universal CRT, a Windows
// component, and is deliberately not matched.
const VC_RUNTIME_DLL =
  /^(vcruntime140(_1)?|msvcp140(_1|_2|_atomic_wait|_codecvt_ids)?|concrt140|vccorlib140)\.dll$/i;

const BINARY = /\.(exe|dll|node)$/i;

// Names of the DLLs a PE file imports, lower-cased, or null when `buf` is not a
// PE image (the ELF and Mach-O prebuilds some npm packages ship for every
// platform sit in the same tree). Only reads the import directory; delay-load
// imports are not followed — none of the bundled binaries use them for the
// runtime, which is loaded at startup.
function readPeImports(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // "PE\0\0"
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  let dataDirs;
  if (magic === 0x20b)
    dataDirs = opt + 112; // PE32+
  else if (magic === 0x10b)
    dataDirs = opt + 96; // PE32
  else return null;
  const importRva = buf.readUInt32LE(dataDirs + 8); // data directory 1: imports
  if (importRva === 0) return [];

  const sectionTable = opt + optSize;
  const toOffset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = sectionTable + i * 40;
      const size = Math.max(buf.readUInt32LE(s + 8), buf.readUInt32LE(s + 16));
      const va = buf.readUInt32LE(s + 12);
      if (rva >= va && rva < va + size) return rva - va + buf.readUInt32LE(s + 20);
    }
    return -1;
  };

  const names = [];
  let desc = toOffset(importRva);
  if (desc < 0) return [];
  // IMAGE_IMPORT_DESCRIPTOR is 20 bytes; the table ends with an all-zero one.
  for (; desc + 20 <= buf.length; desc += 20) {
    const nameRva = buf.readUInt32LE(desc + 12);
    if (nameRva === 0) break;
    const at = toOffset(nameRva);
    if (at < 0) continue;
    const end = buf.indexOf(0, at);
    names.push(buf.toString('latin1', at, end < 0 ? buf.length : end).toLowerCase());
  }
  return names;
}

function* walkBinaries(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkBinaries(full);
    else if (entry.isFile() && BINARY.test(entry.name)) yield full;
  }
}

// The directory holding the redistributable CRT DLLs for `arch` (x64, arm64),
// or null. FREEDOM_VCRUNTIME_DIR wins; otherwise the developer shell's
// VCToolsRedistDir\<arch>\Microsoft.VC14x.CRT.
function findRedistDir(arch, env = process.env) {
  if (env.FREEDOM_VCRUNTIME_DIR) return env.FREEDOM_VCRUNTIME_DIR;
  if (!env.VCToolsRedistDir) return null;
  const archDir = path.join(env.VCToolsRedistDir, arch);
  if (!fs.existsSync(archDir)) return null;
  const crt = fs
    .readdirSync(archDir)
    .filter((name) => /^Microsoft\.VC\d+\.CRT$/i.test(name))
    .sort()
    .pop();
  return crt ? path.join(archDir, crt) : null;
}

// Every binary under `appDir` that imports a VC runtime DLL, as
// [{ binary (relative to appDir), dir (absolute), dlls }].
function runtimeImporters(appDir) {
  const importers = [];
  for (const file of walkBinaries(appDir)) {
    if (VC_RUNTIME_DLL.test(path.basename(file))) continue;
    const imports = readPeImports(fs.readFileSync(file));
    const dlls = (imports || []).filter((name) => VC_RUNTIME_DLL.test(name));
    if (dlls.length === 0) continue;
    importers.push({ binary: path.relative(appDir, file), dir: path.dirname(file), dlls });
  }
  return importers;
}

// Copies every VC runtime DLL a binary under `appDir` imports into that
// binary's directory. Returns [{ binary, dir, dlls }] for what it placed.
function bundleVcRuntime(appDir, { redistDir, log = () => {} } = {}) {
  const importers = runtimeImporters(appDir);
  const needs = new Map(); // directory -> Set of DLL names
  for (const { dir, dlls } of importers) {
    if (!needs.has(dir)) needs.set(dir, new Set());
    for (const name of dlls) needs.get(dir).add(name);
  }
  if (importers.length === 0) return [];

  if (!redistDir || !fs.existsSync(redistDir)) {
    throw new Error(
      `${importers.map((i) => i.binary).join(', ')} import the Visual C++ runtime ` +
        `(${[...new Set(importers.flatMap((i) => i.dlls))].join(', ')}), which a clean ` +
        'Windows install does not have, and no redistributable copy was found to ship ' +
        'beside them. Package from a Visual Studio developer shell (VCToolsRedistDir), ' +
        'or point FREEDOM_VCRUNTIME_DIR at a directory holding the DLLs.'
    );
  }
  const available = new Map(
    fs.readdirSync(redistDir).map((name) => [name.toLowerCase(), path.join(redistDir, name)])
  );
  for (const [dir, names] of needs) {
    for (const name of names) {
      const source = available.get(name);
      if (!source) throw new Error(`${name} is imported under ${dir} but not in ${redistDir}`);
      fs.copyFileSync(source, path.join(dir, path.basename(source)));
    }
  }
  for (const { binary, dlls } of importers) log(`${binary} → ${dlls.join(', ')}`);
  return importers;
}

// The binaries under an installed or unpacked `appDir` that import a VC
// runtime DLL with no copy beside them, as [{ binary, missing }]. What
// release.yml's Windows smoke legs assert on: the runner itself has the
// runtime in System32, so the app starting there proves nothing about a
// clean machine.
function missingVcRuntime(appDir) {
  return runtimeImporters(appDir)
    .map(({ binary, dir, dlls }) => ({
      binary,
      missing: dlls.filter((name) => !fs.existsSync(path.join(dir, name))),
    }))
    .filter(({ missing }) => missing.length > 0);
}

module.exports = {
  VC_RUNTIME_DLL,
  readPeImports,
  findRedistDir,
  bundleVcRuntime,
  missingVcRuntime,
};

//   node scripts/win-vcruntime.js --check <installed or unpacked app dir>
if (require.main === module) {
  const [flag, dir] = process.argv.slice(2);
  if (flag !== '--check' || !dir) {
    console.error('usage: node scripts/win-vcruntime.js --check <app dir>');
    process.exit(2);
  }
  const importers = runtimeImporters(dir);
  for (const { binary, dlls } of importers) console.log(`${binary}: ${dlls.join(', ')}`);
  const missing = missingVcRuntime(dir);
  for (const { binary, missing: dlls } of missing) {
    console.error(`${binary} imports ${dlls.join(', ')} but no copy ships beside it`);
  }
  if (missing.length > 0) process.exit(1);
  console.log(`${importers.length} binaries import the VC++ runtime; every one has it beside it`);
}
