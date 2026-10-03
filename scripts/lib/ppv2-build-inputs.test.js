const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const {
  digest,
  within,
  inventoryInputs,
  packedFiles,
  assertDigest,
  verifyInventory,
  inventoryTree,
  committedRecipe,
  assertNoHostPaths,
} = require('./ppv2-build-inputs');

const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-build-test-'));
const write = (root, name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

test('archive bytes ignore root depth, creation order and executable modes', async () => {
  const outputs = [];
  for (const reverse of [false, true]) {
    const root = directory(),
      source = path.join(root, reverse ? 'deeper/source' : 'source');
    fs.mkdirSync(source, { recursive: true });
    const entries = [
      ['z.js', 'exports.value = 1;'],
      ['nested/a.json', '{"value":2}'],
    ];
    for (const [name, content] of reverse ? entries.reverse() : entries) {
      const file = write(source, name, content);
      fs.chmodSync(file, reverse ? 0o755 : 0o600);
    }
    const output = path.join(root, 'runtime.asar');
    await asar.createPackageFromFiles(source, output, packedFiles(source));
    outputs.push(digest(fs.readFileSync(output)));
  }
  expect(outputs[0]).toBe(outputs[1]);
});

test('host paths are refused in any packed file, including licence and worker documentation', () => {
  const root = directory();
  for (const name of ['bundle.cjs', 'LICENSE', 'worker/README.md', 'worker/index.d.ts']) {
    const file = write(root, name, 'fixture text /private/test-build-root/source');
    expect(() => assertNoHostPaths([file], ['/private/test-build-root'])).toThrow('Host path');
    fs.writeFileSync(file, 'portable fixture text');
    assertNoHostPaths([file], ['/private/test-build-root']);
  }
});

test('recipe provenance rejects staged or unstaged edits and ignores unrelated later commits', () => {
  const root = directory();
  const git = (...args) =>
    require('child_process')
      .execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
      .trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Synthetic Fixture');
  git('config', 'commit.gpgsign', 'false');
  const files = [
    'scripts/spike-ppv2-process.js',
    'scripts/lib/ppv2-build-inputs.js',
    'scripts/fixtures/ppv2-build-inputs.json',
    'scripts/fixtures/kohaku-ppv2-compat.patch',
  ];
  for (const file of files) write(root, file, 'fixture');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const revision = committedRecipe(root);
  write(root, 'documentation.md', 'unrelated');
  git('add', '.');
  git('commit', '-qm', 'documentation');
  expect(committedRecipe(root)).toBe(revision);
  for (const file of files) {
    write(root, file, 'changed');
    expect(() => committedRecipe(root)).toThrow('Commit the reviewed build recipe');
    git('add', file);
    expect(() => committedRecipe(root)).toThrow('Commit the reviewed build recipe');
    write(root, file, 'fixture');
    git('add', file);
  }
});

test.each(['symlink', 'native', 'special'])('archive refuses unsupported %s entries', (kind) => {
  const root = directory();
  if (kind === 'symlink')
    fs.symlinkSync(write(directory(), 'elsewhere.js', 'secret'), path.join(root, 'link.js'));
  else if (kind === 'native') write(root, 'addon.node', 'native');
  else {
    // Simulate a special filesystem entry without creating a socket or FIFO.
    const original = fs.lstatSync;
    const file = write(root, 'special', '');
    const spy = jest
      .spyOn(fs, 'lstatSync')
      .mockImplementation((target, ...args) =>
        target === file
          ? { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false }
          : original(target, ...args)
      );
    try {
      expect(() => packedFiles(root)).toThrow('Unsupported runtime archive entry');
    } finally {
      spy.mockRestore();
    }
    return;
  }
  expect(() => packedFiles(root)).toThrow('Unsupported runtime archive entry');
});

test('dependency inventory rejects changed code, package metadata, licences and extra inputs', () => {
  const root = directory();
  write(root, 'pkg/package.json', '{"name":"fixture","license":"MIT"}');
  write(root, 'pkg/index.js', 'exports.value = 1;');
  write(root, 'pkg/LICENSE', 'synthetic licence');
  const metadata = [{ inputs: { 'pkg/index.js': {} } }];
  const expected = digest(JSON.stringify(inventoryInputs(root, metadata)));
  verifyInventory(inventoryInputs(root, metadata), expected);
  for (const file of ['pkg/index.js', 'pkg/LICENSE', 'pkg/package.json']) {
    const target = path.join(root, file),
      bytes = fs.readFileSync(target);
    fs.appendFileSync(target, ' ');
    expect(() => verifyInventory(inventoryInputs(root, metadata), expected)).toThrow(
      'Changed runtime dependency inventory'
    );
    fs.writeFileSync(target, bytes);
  }
  write(root, 'pkg/additional.js', 'exports.extra = 1;');
  metadata[0].inputs['pkg/additional.js'] = {};
  expect(() => verifyInventory(inventoryInputs(root, metadata), expected)).toThrow(
    'Changed runtime dependency inventory'
  );
});

test('worker inventory includes non-bundled files and refuses links', () => {
  const root = directory();
  write(root, 'worker/bootstrap.js', 'worker fixture');
  const before = inventoryTree(root, path.join(root, 'worker'));
  expect(before).toEqual([{ file: 'worker/bootstrap.js', sha256: digest('worker fixture') }]);
  write(root, 'worker/bootstrap.js', 'changed worker');
  expect(inventoryTree(root, path.join(root, 'worker'))).not.toEqual(before);
  fs.symlinkSync('bootstrap.js', path.join(root, 'worker/link.js'));
  expect(() => inventoryTree(root, path.join(root, 'worker'))).toThrow(
    'Unsupported dependency entry'
  );
});

test('metafile input cannot escape through traversal or a symlink', () => {
  const root = directory(),
    outside = write(directory(), 'escape.js', 'exports.bad = true');
  expect(() => within(root, outside)).toThrow('escapes staging root');
  fs.symlinkSync(outside, path.join(root, 'escape.js'));
  expect(() => inventoryInputs(root, [{ inputs: { 'escape.js': {} } }])).toThrow(
    'escapes staging root'
  );
});

test('inventory attributes CJS subdirectories to their package and preserves licence evidence', () => {
  const root = directory();
  write(
    root,
    'pkg/package.json',
    JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' })
  );
  write(root, 'pkg/lib/package.json', '{"type":"commonjs"}');
  write(root, 'pkg/lib/index.js', 'exports.fixture = true;');
  write(root, 'pkg/LICENSE', 'public synthetic licence fixture');
  const result = inventoryInputs(root, [{ inputs: { 'pkg/lib/index.js': {} } }]);
  expect(result.packages).toHaveLength(1);
  expect(result.packages[0]).toMatchObject({
    name: 'fixture',
    version: '1.0.0',
    declaredLicense: 'MIT',
    licenses: [{ file: 'pkg/LICENSE', sha256: digest('public synthetic licence fixture') }],
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(root);
  const file = path.join(root, 'pkg/lib/index.js');
  assertDigest(file, result.inputs[0].sha256);
  fs.appendFileSync(file, '// changed');
  expect(() => assertDigest(file, result.inputs[0].sha256)).toThrow('Changed pinned input');
});
