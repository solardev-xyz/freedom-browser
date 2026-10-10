#!/usr/bin/env node
/** Read-only pin-review aid. It does not update the trusted pin or execute SDK
 * code. Literal import inventory is a review aid, not a JavaScript sandbox or
 * a proof that computed/dynamic imports cannot exist. Review bundle changes.
 */
const fs = require('fs'),
  path = require('path');
const { createHash } = require('crypto');
const { isBuiltin } = require('module');
const asar = require('@electron/asar');
const archive = process.argv[2];
if (!archive || !path.isAbsolute(archive)) throw new Error('Absolute ASAR path required');
const metadata = asar.getRawHeader(archive).header,
  files = new Map();
let links = 0,
  unpacked = 0,
  native = 0;
function walk(entries, prefix = '') {
  for (const [name, entry] of Object.entries(entries)) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
      throw new Error('Invalid archive path');
    const filename = `${prefix}${name}`;
    if (entry.link) links++;
    if (entry.unpacked) unpacked++;
    if (name.endsWith('.node')) native++;
    if (entry.files) walk(entry.files, `${filename}/`);
    else files.set(filename, entry);
  }
}
walk(metadata.files);
if (links || unpacked || native || fs.existsSync(`${archive}.unpacked`))
  throw new Error('Runtime must be entirely packed, without links or native addons');
const modules = {},
  pending = ['plugin.cjs', 'sdk.cjs', 'serial-prover.cjs'];
while (pending.length) {
  const filename = pending.pop();
  if (Object.hasOwn(modules, filename)) continue;
  if (!files.has(filename)) throw new Error('Missing runtime module');
  const bytes = asar.extractFile(archive, filename),
    text = bytes.toString('utf8');
  const imports = [
    ...new Set(
      [...text.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    ),
  ].sort();
  const local = [];
  for (const specifier of imports) {
    if (isBuiltin(specifier)) continue;
    if (!specifier.startsWith('./') && !specifier.startsWith('../'))
      throw new Error(`External runtime module: ${specifier}`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
    if (target.startsWith('../') || target.startsWith('/'))
      throw new Error('Runtime module escapes archive');
    let resolved = [target, `${target}.js`, `${target}.cjs`].find((name) => files.has(name));
    if (!resolved && files.has(`${target}/package.json`)) {
      const pkg = JSON.parse(asar.extractFile(archive, `${target}/package.json`).toString('utf8'));
      resolved = path.posix.normalize(path.posix.join(target, pkg.main || 'index.js'));
    }
    if (!resolved || !files.has(resolved) || resolved.startsWith('../'))
      throw new Error('Unresolved runtime module');
    local.push(resolved);
    pending.push(resolved);
  }
  modules[filename] = {
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    imports,
    local,
  };
}
console.log(
  JSON.stringify(
    {
      archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
      archiveSize: fs.statSync(archive).size,
      files: files.size,
      links,
      unpacked,
      native,
      candidate: JSON.parse(asar.extractFile(archive, 'candidate.json').toString('utf8')),
      modules,
      limitation:
        'Literal require/import inventory only; computed imports and behavioral authority require source review',
      productionQualified: false,
    },
    null,
    2
  )
);
