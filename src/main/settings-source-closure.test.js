/** Source-only inventory checks. No qualifier, Electron or native module is loaded. */
const fs = require('fs');
const path = require('path');
const { parse } = require('acorn');
const root = path.resolve(__dirname, '../..');
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
test('settings retains the eager Ant-cache dependency and its inspected source closure', () => {
  expect(eagerImports(read(settings))).toContain('./swarm/ant-cache');
  const required = [...closure(cache)];
  expect(required).toContain(cache);
  for (const filename of required)
    expect(fs.statSync(path.join(root, filename)).isFile()).toBe(true);
});
