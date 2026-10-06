const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const inputs = require('./inputs');
const { main } = require('../../qualify-railgun-relay-wire');
const { run } = require('./campaign');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'railgun-wire-recipe-test-'));
const marker = (directory) => {
  const file = path.join(directory, 'upstream.cjs');
  fs.writeFileSync(
    file,
    "require('node:fs').writeFileSync(__dirname + '/IMPORTED', 'marker-only'); throw new Error('MARKER_IMPORT');"
  );
};
afterEach(() => jest.restoreAllMocks());
test('CLI import does not load generated code, builders or upstream modules', () => {
  expect(
    Object.keys(require.cache).filter((name) =>
      /upstream\.cjs|@babel\/parser|esbuild\/lib/.test(name)
    )
  ).toEqual([]);
});
test.each([
  [[]],
  [['run']],
  [['run', '--build', 'a', '--build', 'b', '--output', 'c']],
  [['check', '--build', 'a', '--build-sha256', 'bad']],
])('strict CLI rejects malformed command %j', async (...args) => {
  const argv = args.flat();
  await expect(main(argv)).rejects.toThrow();
});
test('location normalization is independent of two physical layouts and prefers dependency root', () => {
  for (const base of [temp(), temp()]) {
    const roots = {
      engineSource: path.join(base, 'source'),
      engineDependencies: path.join(base, 'source/dependencies'),
    };
    expect(inputs.normalized(roots, path.join(roots.engineSource, 'src/note.ts'))).toBe(
      'engineSource:src/note.ts'
    );
    expect(inputs.normalized(roots, path.join(roots.engineDependencies, 'pkg/index.js'))).toBe(
      'engineDependencies:pkg/index.js'
    );
  }
});
test('paths cannot select a new pin namespace or escape roots', () => {
  expect(() => inputs.resolveInput({}, 'unknown:x')).toThrow();
  expect(() => inputs.resolveInput({ engineSource: temp() }, 'engineSource:../x')).toThrow();
});
test('source byte drift rejects exact hash, not just file length', () => {
  const filename = path.join(temp(), 'source.js');
  fs.writeFileSync(filename, 'a');
  const pin = { bytes: 1, sha256: crypto.createHash('sha256').update('a').digest('hex') };
  expect(inputs.filePin(filename, pin).toString()).toBe('a');
  fs.writeFileSync(filename, 'b');
  expect(() => inputs.filePin(filename, pin)).toThrow('Input hash mismatch');
});
test('manifest digest admission precedes JSON parse and bundle import', () => {
  const build = temp();
  marker(build);
  fs.writeFileSync(path.join(build, 'build.json'), '{ invalid');
  expect(() => inputs.verifyBuild(build, '0'.repeat(64))).toThrow('Build manifest digest mismatch');
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('check refuses malformed digest without importing its marker bundle', async () => {
  const build = temp();
  marker(build);
  // Structural ordering seam only; actual pinned input/build check has separate source-only evidence.
  const spy = jest.spyOn(inputs, 'verifyBuild').mockReturnValue({ roots: {} });
  // CLI captures original verifier intentionally; exercise its real early digest refusal.
  await expect(main(['check', '--build', build, '--build-sha256', 'bad'])).rejects.toThrow(
    'Reviewed build manifest'
  );
  expect(spy).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('failed verification cannot import marker or create output', async () => {
  const build = temp();
  marker(build);
  const output = path.join(temp(), 'output');
  jest.spyOn(inputs, 'verifyBuild').mockImplementation(() => {
    throw new Error('INPUT_REFUSED');
  });
  await expect(run(build, '0'.repeat(64), output)).rejects.toThrow('INPUT_REFUSED');
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('existing output refuses before marker import and preserves bytes', async () => {
  const build = temp(),
    output = temp();
  marker(build);
  fs.writeFileSync(path.join(output, 'kept'), 'original');
  jest.spyOn(inputs, 'verifyBuild').mockReturnValue({ roots: {} });
  await expect(run(build, '0'.repeat(64), output)).rejects.toThrow('Output already exists');
  expect(fs.readFileSync(path.join(output, 'kept'), 'utf8')).toBe('original');
  expect(fs.existsSync(path.join(build, 'IMPORTED'))).toBe(false);
});
test('valid ordering seam reaches marker only after verification and fresh output', async () => {
  const build = temp(),
    output = path.join(temp(), 'output');
  marker(build);
  const spy = jest.spyOn(inputs, 'verifyBuild').mockImplementation(() => {
    expect(fs.existsSync(output)).toBe(false);
    return { roots: {} };
  });
  await expect(run(build, '0'.repeat(64), output)).rejects.toThrow('MARKER_IMPORT');
  expect(spy).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(output)).toBe(true);
  expect(fs.readFileSync(path.join(build, 'IMPORTED'), 'utf8')).toBe('marker-only');
});
test('output cannot overlap source tree or be its ancestor', () => {
  const base = temp(),
    source = path.join(base, 'source');
  fs.mkdirSync(source);
  expect(() => inputs.freshOutput(path.join(source, 'output'), { source })).toThrow(
    'Output overlaps input'
  );
});

test('unexpected graph input or emitted networking dependency is refused', () => {
  expect(() =>
    inputs.verifyGraph(inputs.pins.graphInputs, inputs.pins.externalModules)
  ).not.toThrow();
  expect(() =>
    inputs.verifyGraph(
      [...inputs.pins.graphInputs, 'engineDependencies:alternate/index.js'],
      inputs.pins.externalModules
    )
  ).toThrow();
  expect(() =>
    inputs.verifyGraph(inputs.pins.graphInputs.slice(1), inputs.pins.externalModules)
  ).toThrow();
  expect(() =>
    inputs.verifyGraph(inputs.pins.graphInputs, [...inputs.pins.externalModules, 'https'])
  ).toThrow();
});
test('root config accepts locations only, not caller policy or hashes', () => {
  const root = temp(),
    file = path.join(root, 'roots.json');
  fs.writeFileSync(file, JSON.stringify({ policy: {} }));
  expect(() => inputs.rootsFrom(file)).toThrow();
});

// Actual verifier source with small structural input pins; no upstream tools loaded.
function verifierFixture(pins, mutant = false) {
  const vm = require('node:vm');
  const filename = path.join(__dirname, 'inputs.js');
  let source = fs.readFileSync(filename, 'utf8');
  if (mutant) source = source.replace('  verifyToolResolution(roots);', '');
  const output = { exports: {} };
  vm.runInNewContext(
    source,
    {
      require: (name) => (name === './inputs.json' ? pins : require(name)),
      module: output,
      process,
      __dirname,
    },
    { filename }
  );
  return output.exports;
}
function fixturePin(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: inputs.sha(bytes) };
}
function markerToolFixture() {
  const base = fs.realpathSync(temp()),
    root = path.join(base, 'node_modules');
  const traverser = path.join(root, '@babel/traverse');
  const genuine = path.join(root, 'obug');
  fs.mkdirSync(traverser, { recursive: true });
  fs.mkdirSync(genuine);
  const loaded = path.join(base, 'LOADED');
  fs.writeFileSync(path.join(traverser, 'index.js'), "module.exports = require('obug');\n");
  fs.writeFileSync(path.join(genuine, 'index.js'), 'module.exports = "pinned";\n');
  const trees = Object.fromEntries(
    [traverser, genuine].map((dir) => {
      const pin = fixturePin(path.join(dir, 'index.js'));
      return [
        'buildTools:' + path.relative(root, dir),
        { files: 1, sha256: inputs.sha(JSON.stringify([['index.js', pin.bytes, pin.sha256]])) },
      ];
    })
  );
  const pins = { platform: `${process.platform}-${process.arch}`, files: {}, toolTrees: trees };
  return { base, root, traverser, loaded, pins };
}
test('scoped transitive tool shadow refuses before evaluation; old guard mutant executes marker', () => {
  const fixture = markerToolFixture();
  const shadow = path.join(fixture.root, '@babel/node_modules/obug');
  fs.mkdirSync(shadow, { recursive: true });
  fs.writeFileSync(
    path.join(shadow, 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(fixture.loaded)}, 'UNPINNED_SHADOW'); module.exports = 'shadow';`
  );
  const requireTool = require('node:module').createRequire(
    path.join(fixture.traverser, 'index.js')
  );
  expect(() => {
    verifierFixture(fixture.pins).verifyInputs({ buildTools: fixture.root });
    requireTool('obug');
  }).toThrow('Tool dependency shadow refused');
  expect(fs.existsSync(fixture.loaded)).toBe(false);
  // Distinguishing control: unchanged package trees alone do not detect this shadow.
  verifierFixture(fixture.pins, true).verifyInputs({ buildTools: fixture.root });
  expect(requireTool('obug')).toBe('shadow');
  expect(fs.readFileSync(fixture.loaded, 'utf8')).toBe('UNPINNED_SHADOW');
});
test('scoped tool directory symlink refuses before any tool is loaded', () => {
  const fixture = markerToolFixture();
  const scope = path.join(fixture.root, '@babel'),
    target = path.join(fixture.base, 'moved-scope');
  fs.renameSync(scope, target);
  fs.symlinkSync(target, scope, 'dir');
  expect(() => verifierFixture(fixture.pins).verifyInputs({ buildTools: fixture.root })).toThrow(
    'Tool scope/package symlink refused'
  );
  expect(fs.existsSync(fixture.loaded)).toBe(false);
});
test('top-level nested node_modules shadow candidate is refused', () => {
  const fixture = markerToolFixture();
  fs.mkdirSync(path.join(fixture.root, 'node_modules'));
  expect(() => verifierFixture(fixture.pins).verifyInputs({ buildTools: fixture.root })).toThrow(
    'Tool dependency shadow refused'
  );
});

// Evaluate the actual post-build publication block with a held synthetic build.
// This isolates completion ordering; it does not claim an actual esbuild execution.
async function heldBuildFixture(kind, removeRecheck = false) {
  const vm = require('node:vm'),
    assert = require('node:assert/strict');
  const base = fs.realpathSync(temp()),
    toolRoot = path.join(base, 'node_modules');
  fs.mkdirSync(toolRoot);
  const files = {
    source: path.join(base, 'source.js'),
    tool: path.join(toolRoot, 'tool.js'),
    license: path.join(base, 'LICENSE'),
    recipe: path.join(base, 'recipe.js'),
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, 'original');
  const pins = {
    platform: `${process.platform}-${process.arch}`,
    toolTrees: {},
    files: {
      'engineSource:source.js': fixturePin(files.source),
      'buildTools:tool.js': fixturePin(files.tool),
      'engineSource:LICENSE': fixturePin(files.license),
    },
  };
  const verifier = verifierFixture(pins),
    roots = { engineSource: base, buildTools: toolRoot };
  const resolvedInputs = verifier.verifyInputs(roots),
    recipeBefore = { recipe: fixturePin(files.recipe) };
  const generated = path.join(base, 'output');
  fs.mkdirSync(generated);
  const source = fs.readFileSync(path.join(__dirname, 'prepare.js'), 'utf8');
  const marker =
    '  // Recheck all inputs after the asynchronous build, before publishing completion.';
  const start = source.indexOf(marker),
    end = source.indexOf('\n}\nmodule.exports');
  expect(start).toBeGreaterThan(source.indexOf('await esbuild.build('));
  expect(end).toBeGreaterThan(start);
  let block = source.slice(start, end);
  if (removeRecheck)
    block = block
      .replace('  assert.deepEqual(verified.verifyInputs(roots), resolvedInputs);', '')
      .replace('  assert.deepEqual(verified.recipePins(), recipeBefore);', '');
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pending = vm.runInNewContext(`(async () => { await held; ${block} })()`, {
    held,
    assert,
    fs,
    path,
    process,
    hash: inputs.sha,
    roots,
    resolvedInputs,
    recipeBefore,
    generated,
    verified: {
      verifyInputs: verifier.verifyInputs,
      recipePins: () => ({ recipe: fixturePin(files.recipe) }),
    },
    graphInputs: [],
    externals: [],
    historicalRecord: { outputs: {}, generatedSource: {} },
    selections: [],
    values: {},
  });
  expect(fs.existsSync(path.join(generated, 'build.json'))).toBe(false);
  if (kind === 'mapping') {
    const other = path.join(base, 'same-bytes.js');
    fs.copyFileSync(files.source, other);
    fs.renameSync(files.source, path.join(base, 'preserved-source.js'));
    fs.symlinkSync(other, files.source);
  } else if (kind !== 'healthy') fs.writeFileSync(files[kind], 'modified');
  release();
  return { pending, manifest: path.join(generated, 'build.json') };
}
test.each(['source', 'tool', 'license', 'recipe', 'mapping'])(
  'held build refuses %s drift and publishes no manifest',
  async (kind) => {
    const { pending, manifest } = await heldBuildFixture(kind);
    await expect(pending).rejects.toThrow();
    expect(fs.existsSync(manifest)).toBe(false);
  }
);
test('held healthy build publishes only after release', async () => {
  const { pending, manifest } = await heldBuildFixture('healthy');
  await expect(pending).resolves.toEqual(
    expect.objectContaining({ generatedCryptoExecuted: false })
  );
  expect(fs.existsSync(manifest)).toBe(true);
});
test('removing post-build checks distinguishes the held input drift', async () => {
  const { pending, manifest } = await heldBuildFixture('source', true);
  await expect(pending).resolves.toEqual(
    expect.objectContaining({ generatedCryptoExecuted: false })
  );
  expect(fs.existsSync(manifest)).toBe(true);
});
