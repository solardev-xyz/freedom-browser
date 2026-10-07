/** Source-only inventory checks. No qualifier, Electron or native module is loaded. */
const fs = require('fs');
const path = require('path');
const { parse } = require('acorn');
const root = path.resolve(__dirname, '..');
const settings = 'src/main/settings-store.js';
const cache = 'src/main/swarm/ant-cache.js';
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
    else if (value && typeof value === 'object') visit(value, callback);
  }
}
function ast(source) {
  const program = parse(source, { sourceType: 'script', ecmaVersion: 'latest' });
  visit(program, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') node.type = 'StringLiteral';
  });
  return program;
}
function eagerImports(source) {
  const names = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    // Function bodies run later; this checks the actual eager CommonJS edge.
    if (/Function|Method/.test(node.type)) return;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'StringLiteral'
    )
      names.push(node.arguments[0].value);
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  }
  walk(ast(source));
  return names;
}
function closure(filename, seen = new Set()) {
  if (seen.has(filename)) return seen;
  seen.add(filename);
  for (const name of eagerImports(read(filename))) {
    if (!name.startsWith('.')) continue;
    let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), name));
    if (!path.posix.extname(resolved)) resolved += '.js';
    if (resolved.endsWith('.json')) seen.add(resolved);
    else closure(resolved, seen);
  }
  return seen;
}
function inventories(filename, source = read(filename)) {
  const found = [];
  visit(ast(source), (node) => {
    if (
      node.type !== 'VariableDeclarator' ||
      !['sources', 'names', 'files', 'FIXED_SOURCES'].includes(node.id.name) ||
      !node.init
    )
      return;
    const entries = new Set();
    visit(node.init, (part) => {
      if (part.type === 'StringLiteral') {
        if (part.value.startsWith('src/')) entries.add(part.value);
        // Actual source lists map these names under src/main using path.join.
        if (['settings-store.js', 'swarm/ant-cache.js'].includes(part.value))
          entries.add('src/main/' + part.value);
      }
      if (
        part.type === 'MemberExpression' &&
        part.property.name === 'sourceSha256' &&
        part.object.type === 'CallExpression' &&
        part.object.callee.name === 'require' &&
        part.object.arguments[0]?.type === 'StringLiteral'
      ) {
        const target = part.object.arguments[0].value;
        if (!target.startsWith('../docs/qualification/') || !target.endsWith('.json')) return;
        const original = JSON.parse(read(path.posix.join(path.posix.dirname(filename), target)));
        Object.keys(original.sourceSha256).forEach((name) => entries.add(name));
      }
    });
    if (entries.has(settings)) found.push(entries);
  });
  return found;
}
const qualifiers = fs
  .readdirSync(__dirname)
  .filter((name) => /^qualify-railgun.*\.js$/.test(name) && !name.endsWith('.test.js'))
  .map((name) => 'scripts/' + name);
const consumers = qualifiers.filter((name) => inventories(name).length);
const required = [...closure(cache)];

test('the changed settings import is eager and its transitive source closure is inspected', () => {
  expect(eagerImports(read(settings))).toContain('./swarm/ant-cache');
  expect(required).toContain(cache);
  expect(consumers).toHaveLength(12);
  expect(consumers).toContain('scripts/qualify-railgun-wallet-journal.js');
  expect(consumers).toContain('scripts/qualify-railgun-shield-submission.js');
});

test.each(consumers)(
  '%s pins the eager settings cache closure, including inherited source lists',
  (name) => {
    for (const entries of inventories(name)) {
      for (const dependency of required) expect(entries.has(dependency)).toBe(true);
    }
  }
);

test.each(consumers)('removing the cache pin is detected in %s', (name) => {
  const changed = read(name).replace(/['"](?:src\/main\/)?swarm\/ant-cache\.js['"],?\s*/g, '');
  expect(changed).not.toBe(read(name));
  const entries = inventories(name, changed);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.some((list) => required.some((dependency) => !list.has(dependency)))).toBe(true);
});
