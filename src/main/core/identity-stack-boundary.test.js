/**
 * freedom-core design 0001: every vault and key consumer goes through
 * core/vault-backend.js. Nothing in src/ may import the JS identity stack
 * (src/main/identity/*) except the stack itself, until step 3 deletes it.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..');
const STACK = path.join(SRC, 'main', 'identity');

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

test('nothing outside the identity stack imports it', () => {
  const offenders = [];
  for (const file of jsFiles(SRC)) {
    if (file.startsWith(STACK + path.sep)) continue;
    for (const specifier of imports(fs.readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved === STACK || resolved.startsWith(STACK + path.sep)) {
        offenders.push(`${path.relative(SRC, file)} imports ${specifier}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
