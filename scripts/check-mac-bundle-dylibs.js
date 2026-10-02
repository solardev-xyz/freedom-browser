// Assert every Mach-O file in a built macOS app links only libraries that
// every Mac has, or that the app ships itself.
//
// The nightly of 2026-09-29 shipped an `arti` linked against
// /opt/homebrew/opt/xz/lib/liblzma.5.dylib: the macOS build runner has
// Homebrew's xz, and a -sys crate found it through pkg-config. Tor then failed
// to start on users' Macs — on Macs without Homebrew xz because the file does
// not exist, and on Macs with it because library validation refuses a dylib
// signed by another Team ID. The packaged Tor smoke test passed anyway: the
// smoke runner has the same Homebrew dylib, and GitHub's macOS runners do not
// enforce library validation the way a user's Mac does. Only the link table
// shows the problem on such a runner, so this reads it for *every* binary in
// the bundle (Arti, antd, the native addons, the Myotis supervisor, Electron
// itself) rather than trusting any one of them to be built carefully.
//
// Allowed references:
//   - /usr/lib/… and /System/Library/… (part of macOS);
//   - @rpath/…, @loader_path/…, @executable_path/… (resolved inside the app).
// Anything else — /opt/homebrew, /usr/local, a build tree, a user's home — is
// reported, and the script exits 1.
//
// Usage:
//   node scripts/check-mac-bundle-dylibs.js <path/to/Freedom.app>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ALLOWED_PREFIXES = [
  '/usr/lib/',
  '/System/Library/',
  '@rpath/',
  '@loader_path/',
  '@executable_path/',
];

// Thin and fat Mach-O magics, both byte orders.
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

/**
 * Whether a file starts with a Mach-O (or universal binary) magic.
 * @param {string} file
 */
function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(buf.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Library references in `otool -L` output that are neither part of macOS nor
 * resolved inside the app. Header lines (the file itself, and one per
 * architecture of a universal binary) end with ':' and are skipped.
 *
 * For a dylib (a `.node` addon is one), `otool -L` also lists the library's
 * own install name (LC_ID_DYLIB). That is a label, not a dependency: an addon
 * is loaded by path and its id is never resolved. Rust bakes the build tree
 * into it (e.g. `/Users/runner/work/myotis/…/libmyotis_node.dylib`), so it is
 * dropped via `ownIds` (`otool -D`), or it would read as a foreign library.
 * @param {string} otoolOutput
 * @param {string[]} [ownIds]
 * @returns {string[]}
 */
function foreignLibraries(otoolOutput, ownIds = []) {
  return String(otoolOutput)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(':'))
    .map((line) => line.replace(/\s+\((compatibility|current) version.*$/, ''))
    .filter((lib) => !ownIds.includes(lib))
    .filter((lib) => !ALLOWED_PREFIXES.some((prefix) => lib.startsWith(prefix)));
}

/**
 * Install names in `otool -D` output (one per architecture of a universal
 * binary; none for an executable).
 * @param {string} otoolDOutput
 * @returns {string[]}
 */
function installNames(otoolDOutput) {
  return String(otoolDOutput)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(':'));
}

/**
 * Every regular file under `dir`, without following symlinks (framework
 * bundles are full of them and would otherwise be visited twice).
 * @param {string} dir
 * @returns {string[]}
 */
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * `otool -L` and `otool -D` for one file. Xcode's `otool` shim re-splits its arguments, so a
 * path with parentheses fails ("Freedom Helper (GPU)" became "Freedom Helper "
 * on the macos-14 runner's Xcode 15.4). It is handed a symlink with a plain
 * name instead; otool reads through it, and the header line naming the link is
 * skipped by foreignLibraries anyway.
 * @param {string} file
 * @returns {{list: string, ids: string[]}}
 */
function otoolLibraries(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otool-'));
  const link = path.join(dir, 'macho');
  try {
    fs.symlinkSync(file, link);
    return {
      list: execFileSync('otool', ['-L', link], { encoding: 'utf8' }),
      ids: installNames(execFileSync('otool', ['-D', link], { encoding: 'utf8' })),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} appPath
 * @param {{otool?: (file: string) => (string | {list: string, ids: string[]})}} [options]
 * @returns {{checked: number, problems: {file: string, libs: string[]}[]}}
 */
function checkBundle(appPath, options = {}) {
  const otool = options.otool || otoolLibraries;
  const problems = [];
  let checked = 0;
  for (const file of walkFiles(appPath)) {
    if (!isMachO(file)) continue;
    checked += 1;
    // A test double may return plain `otool -L` text.
    const result = otool(file);
    const { list, ids } = typeof result === 'string' ? { list: result, ids: [] } : result;
    const libs = [...new Set(foreignLibraries(list, ids))];
    if (libs.length > 0) problems.push({ file: path.relative(appPath, file), libs });
  }
  return { checked, problems };
}

function main() {
  const appPath = process.argv[2];
  if (!appPath || !fs.existsSync(appPath)) {
    console.error('Usage: node scripts/check-mac-bundle-dylibs.js <path/to/Freedom.app>');
    process.exit(2);
  }
  const { checked, problems } = checkBundle(appPath);
  if (checked === 0) {
    console.error(`No Mach-O files found under ${appPath}; is this a macOS app?`);
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(
      `${problems.length} of ${checked} Mach-O files link libraries that are not part of macOS ` +
        'and not shipped inside the app:'
    );
    for (const { file, libs } of problems) {
      console.error(`  ${file}`);
      for (const lib of libs) console.error(`    -> ${lib}`);
    }
    console.error(
      'These fail to load on Macs without them, and under library validation even with them. ' +
        'Link them statically or ship them in the bundle.'
    );
    process.exit(1);
  }
  console.log(`All ${checked} Mach-O files link only macOS system libraries or the app's own.`);
}

if (require.main === module) main();

module.exports = {
  isMachO,
  foreignLibraries,
  installNames,
  walkFiles,
  checkBundle,
  ALLOWED_PREFIXES,
};
