/**
 * COL-6 (freedom-core design 0014, Q19): freedom-colibrid is Colibri's only
 * verifier, and the WASM path left with its npm package. A checkout's
 * node_modules can still hold the package (an install from before the
 * removal, or a node_modules shared with other worktrees), where a leftover
 * require would load it and pass every other test. This one fails instead:
 * no JavaScript under src/, test/, test-e2e/ or scripts/ (or at the
 * repository's root) names the package as a module or a path, nothing
 * declares or packs it, and the WASM path's modules and switches are gone.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const PACKAGE = '@corpus-core/colibri-stateless';

/**
 * Where `source` names the package: as a module (`require`,
 * `require.resolve`, `import … from`, `import()`), or as a quoted path or
 * path part (`'@corpus-core'`, `'colibri-stateless'`), or, unless
 * `fileNames` is false, one of its files (`'…/c4w.wasm'`). Prose in
 * comments, which names it without quotes, doesn't count.
 */
function packageReferences(source, { fileNames = true } = {}) {
  const patterns = [
    /require(?:\.resolve)?\(\s*['"`]@corpus-core\/colibri-stateless(?:\/[^'"`]*)?['"`]/g,
    /\bfrom\s*['"]@corpus-core\/colibri-stateless(?:\/[^'"]*)?['"]/g,
    /\bimport\(\s*['"`]@corpus-core\/colibri-stateless(?:\/[^'"`]*)?['"`]/g,
    /['"]@corpus-core(?:\/[^'"]*)?['"]/g,
    /['"](?:[^'"]*\/)?colibri-stateless(?:\/[^'"]*)?['"]/g,
    ...(fileNames ? [/['"][^'"]*\bc4w\.(?:wasm|js)['"]/g] : []),
  ];
  return [...new Set(patterns.flatMap((pattern) => source.match(pattern) ?? []))];
}

/** Files that name the package's files to refuse them: the packaging check's
 * test, which feeds it a stale `c4w.wasm` to see the build fail. */
const NAMES_FILES_TO_REFUSE = new Set(['scripts/check-asar-contents.test.js']);

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* jsFiles(full);
    } else if (/\.(c|m)?js$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Every JavaScript file the guard reads: the trees, and the root's own. */
function scannedFiles() {
  const files = ['src', 'test', 'test-e2e', 'scripts'].flatMap((dir) => [
    ...jsFiles(path.join(ROOT, dir)),
  ]);
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.(c|m)?js$/.test(entry.name)) files.push(path.join(ROOT, entry.name));
  }
  return files.filter((file) => file !== __filename);
}

test('the detector finds the package however a file names it, and not in prose', () => {
  expect(packageReferences(`require('${PACKAGE}')`)).not.toEqual([]);
  expect(packageReferences(`require.resolve("${PACKAGE}/package.json")`)).not.toEqual([]);
  expect(packageReferences(`import Colibri from '${PACKAGE}';`)).not.toEqual([]);
  expect(packageReferences(`await import('${PACKAGE}/cjs/index.js')`)).not.toEqual([]);
  expect(
    packageReferences("path.join(root, 'node_modules', '@corpus-core', 'colibri-stateless')")
  ).not.toEqual([]);
  expect(packageReferences("fs.readFileSync(path.join(dir, 'c4w.wasm'))")).not.toEqual([]);
  expect(packageReferences("'node_modules/stale/c4w.wasm'", { fileNames: false })).toEqual([]);
  expect(packageReferences(`// the ${PACKAGE} package's lists, embedded`)).toEqual([]);
  expect(packageReferences(' * `@corpus-core/colibri-stateless` 3.0.3 (history)')).toEqual([]);
});

test('no JavaScript under src/, test/, test-e2e/ or scripts/ reaches the package', () => {
  const files = scannedFiles();
  // The trees are there: an empty scan would pass vacuously.
  expect(files.length).toBeGreaterThan(1000);
  const offenders = files
    .map((file) => path.relative(ROOT, file).split(path.sep).join('/'))
    .map((file) => [
      file,
      packageReferences(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
        fileNames: !NAMES_FILES_TO_REFUSE.has(file),
      }),
    ])
    .filter(([, found]) => found.length > 0);
  expect(offenders).toEqual([]);
});

test('nothing declares or packs it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    expect(Object.keys(pkg[field] ?? {})).not.toContain(PACKAGE);
  }
  // electron-builder's configuration: files, asarUnpack, extraResources.
  expect(JSON.stringify(pkg.build)).not.toMatch(/colibri-stateless|c4w|colibri_native/);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  expect(Object.keys(lock.packages).filter((key) => key.includes('colibri-stateless'))).toEqual([]);
  expect(Object.keys(lock.packages[''].dependencies ?? {})).not.toContain(PACKAGE);
});

test("the WASM path's modules and switches are gone", () => {
  for (const file of [
    'src/main/ens/colibri-backend.js',
    'src/main/ens/colibri-runtime.js',
    'src/main/ens/colibri-worker.js',
    'src/main/ens/colibri-worker-host.js',
    'src/main/myotis/checkpoint-verifier-worker.js',
  ]) {
    expect([file, fs.existsSync(path.join(ROOT, file))]).toEqual([file, false]);
  }
  const switches = /FREEDOM_COLIBRI_BACKEND|C4_DISABLE_NATIVE|wasm-enforce-bounds-checks/;
  const offenders = scannedFiles()
    .filter((file) => switches.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file));
  expect(offenders).toEqual([]);
});
