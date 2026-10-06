// Fixture input verification only. No generated module is imported here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const pins = require('./inputs.json');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};
const rootNames = [
  'engineSource',
  'walletSource',
  'sharedModelsSource',
  'clientSource',
  'serverSource',
  'engineDependencies',
  'buildTools',
];
function rootsFrom(filename) {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.deepEqual(Object.keys(value).sort(), [...rootNames].sort());
  return Object.fromEntries(
    rootNames.map((name) => {
      need(
        typeof value[name] === 'string' && path.isAbsolute(value[name]),
        `Absolute root required: ${name}`
      );
      const real = fs.realpathSync(value[name]);
      if (name === 'engineDependencies' || name === 'buildTools')
        need(
          path.basename(real) === 'node_modules',
          'Dependency root must retain node_modules layout'
        );
      need(fs.statSync(real).isDirectory(), `Directory required: ${name}`);
      return [name, real];
    })
  );
}
function resolveInput(roots, input) {
  const [alias, relative, extra] = input.split(':');
  need(
    extra === undefined &&
      rootNames.includes(alias) &&
      relative &&
      !path.isAbsolute(relative) &&
      !relative.split('/').includes('..'),
    'Invalid input key'
  );
  return path.join(roots[alias], relative);
}
function normalized(roots, filename) {
  const absolute = path.resolve(filename);
  const ordered = Object.entries(roots).sort((a, b) => b[1].length - a[1].length);
  for (const [key, root] of ordered)
    if (absolute.startsWith(root + path.sep))
      return key + ':' + path.relative(root, absolute).split(path.sep).join('/');
  throw new Error('Input outside configured roots');
}
function filePin(filename, expected) {
  const bytes = fs.readFileSync(filename);
  need(
    bytes.length === expected.bytes && sha(bytes) === expected.sha256,
    `Input hash mismatch: ${filename}`
  );
  return bytes;
}
function treeEntries(directory, prefix = '') {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const name = prefix + entry.name,
        filename = path.join(directory, entry.name);
      need(!entry.isSymbolicLink(), 'Tool package symlink refused');
      if (entry.isDirectory()) return treeEntries(filename, name + '/');
      need(entry.isFile(), 'Non-file tool input');
      const bytes = fs.readFileSync(filename);
      return [[name, bytes.length, sha(bytes)]];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
// Node resolves bare tool imports through scoped ancestor node_modules too.
// Package-tree hashes cover internal directories; reject unpinned ancestor candidates
// and scope/package symlinks before loading any build tool.
function verifyToolResolution(roots) {
  const toolRoot = roots.buildTools;
  need(fs.realpathSync(toolRoot) === toolRoot, 'Canonical tool root required');
  for (const key of Object.keys(pins.toolTrees)) {
    const directory = resolveInput(roots, key);
    need(fs.realpathSync(directory) === directory, 'Tool scope/package symlink refused');
    let current = path.dirname(directory);
    while (current === toolRoot || current.startsWith(toolRoot + path.sep)) {
      const candidate = path.join(current, 'node_modules');
      need(
        fs.lstatSync(candidate, { throwIfNoEntry: false }) === undefined,
        'Tool dependency shadow refused'
      );
      if (current === toolRoot) break;
      current = path.dirname(current);
    }
  }
}
function verifyInputs(roots) {
  need(`${process.platform}-${process.arch}` === pins.platform, 'Unreviewed builder platform');
  need(process.versions.node.startsWith('24.'), 'Node24 required');
  need(
    process.env.ESBUILD_BINARY_PATH === undefined && process.env.NODE_PATH === undefined,
    'External dependency override refused'
  );
  verifyToolResolution(roots);
  const observed = {};
  for (const [key, expected] of Object.entries(pins.files)) {
    const filename = resolveInput(roots, key);
    filePin(filename, expected);
    // Resolve through symlinks, then require the resulting file to remain in a supplied root.
    observed[key] = normalized(roots, fs.realpathSync(filename));
  }
  for (const [key, expected] of Object.entries(pins.toolTrees)) {
    const entries = treeEntries(resolveInput(roots, key));
    need(
      entries.length === expected.files && sha(JSON.stringify(entries)) === expected.sha256,
      `Tool package tree mismatch: ${key}`
    );
  }
  return observed;
}
function freshOutput(output, roots) {
  const absolute = path.resolve(output);
  need(!fs.existsSync(absolute), 'Output already exists');
  const parent = fs.realpathSync(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  for (const root of Object.values(roots).map((entry) => fs.realpathSync(entry)))
    need(
      resolved !== root &&
        !resolved.startsWith(root + path.sep) &&
        !root.startsWith(resolved + path.sep),
      'Output overlaps input'
    );
  fs.mkdirSync(resolved);
  return resolved;
}
function recipePins() {
  const files = fs
    .readdirSync(__dirname)
    .filter((name) => /\.(js|json)$/.test(name) && !name.endsWith('.test.js'));
  files.push('../../qualify-railgun-relay-wire.js');
  return Object.fromEntries(
    files.sort().map((name) => {
      const b = fs.readFileSync(path.join(__dirname, name));
      return [name, { bytes: b.length, sha256: sha(b) }];
    })
  );
}
function verifyGraph(graphInputs, externalModules) {
  assert.deepEqual(graphInputs, pins.graphInputs);
  assert.deepEqual(externalModules, pins.externalModules);
}
function verifyBuild(build, digest) {
  need(
    typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest),
    'Reviewed build manifest SHA256 required'
  );
  const bytes = fs.readFileSync(path.join(build, 'build.json'));
  need(sha(bytes) === digest, 'Build manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  assert.deepEqual(manifest.recipe, recipePins());
  assert.deepEqual(Object.keys(manifest.roots).sort(), [...rootNames].sort());
  const current = verifyInputs(manifest.roots);
  assert.deepEqual(current, manifest.resolvedInputs);
  verifyGraph(manifest.graphInputs, manifest.externalModules);
  assert.deepEqual(manifest.selectedSpans, pins.spans);
  assert.deepEqual(manifest.sourceConfigDefaults, {
    IS_DEV: false,
    MINIMUM_BROADCASTER_VERSION: '8.0.0',
    MAXIMUM_BROADCASTER_VERSION: '8.999.0',
  });
  for (const name of ['selected-upstream.ts', 'upstream.cjs'])
    filePin(path.join(build, name), manifest.outputs[name]);
  return manifest;
}
module.exports = {
  pins,
  sha,
  need,
  rootsFrom,
  resolveInput,
  normalized,
  filePin,
  verifyToolResolution,
  verifyInputs,
  freshOutput,
  recipePins,
  verifyGraph,
  verifyBuild,
};
