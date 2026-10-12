/**
 * freedom-core design 0001, migration step 3: the JS identity stack is gone
 * from the app. Every vault and key consumer goes through
 * core/vault-backend.js to freedom-cored. The JS code survives only as a
 * frozen test reference in test/legacy-identity/ (it writes data the way
 * older releases did, for migration and compatibility tests), and nothing
 * in src/ may import it.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const LEGACY = path.join(SRC, '..', 'test', 'legacy-identity');

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

/** Module specifiers a file imports (require, import from, dynamic import). */
function imports(source) {
  const found = [];
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

test('the JS identity stack is no longer in src/', () => {
  expect(fs.existsSync(path.join(SRC, 'main', 'identity'))).toBe(false);
});

test('nothing in src/ imports the legacy test reference', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved === LEGACY || resolved.startsWith(LEGACY + path.sep)) {
        offenders.push(`${path.relative(SRC, file)} imports ${specifier}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
