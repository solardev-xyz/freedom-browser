#!/usr/bin/env node
/** Assemble only the existing snarkjs proving closure. No install, SDK import,
 * circuit download or production-distribution approval. --capture-inputs writes
 * an unapproved inventory for review; ordinary builds require committed pins.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto'),
  { createRequire, builtinModules } = require('module');
const esbuild = require('esbuild'),
  asar = require('@electron/asar');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const serialSource = 'e99bbb85ee536fd64476f87492665d1a382e930e4e412278a3fd8e2f987c283f';
async function main() {
  const [inputDirectory, outputDirectory, mode] = process.argv.slice(2);
  assert.ok(path.isAbsolute(inputDirectory) && path.isAbsolute(outputDirectory));
  assert.ok(mode === undefined || mode === '--capture-inputs');
  const root = fs.realpathSync(inputDirectory),
    output = path.resolve(outputDirectory);
  assert.ok(!fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  const source = path.join(output, 'source');
  fs.mkdirSync(source);
  function relative(filename) {
    const real = fs.realpathSync(filename),
      value = path.relative(root, real);
    assert.ok(value && value !== '..' && !value.startsWith('../') && !path.isAbsolute(value));
    return value.split(path.sep).join('/');
  }
  const inputs = new Map(),
    packages = new Map(),
    workers = new Map();
  function record(filename) {
    const file = relative(filename),
      stat = fs.statSync(filename);
    assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024);
    const entry = { file, size: stat.size, sha256: digest(fs.readFileSync(filename)) };
    const previous = inputs.get(file);
    if (previous) assert.deepEqual(previous, entry);
    inputs.set(file, entry);
    return entry;
  }
  function packageFor(filename) {
    let directory = path.dirname(filename);
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
      const parent = path.dirname(directory);
      assert.notEqual(parent, directory);
      relative(directory);
      directory = parent;
    }
    const file = path.join(directory, 'package.json'),
      key = relative(file);
    if (packages.has(key)) return packages.get(key);
    const metadata = JSON.parse(fs.readFileSync(file));
    record(file);
    const licenses = fs
      .readdirSync(directory)
      .filter((name) => /^(license|copying|notice)(?:[.-]|$)/i.test(name));
    assert.equal(typeof metadata.license, 'string', 'Missing dependency license identifier');
    const item = {
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      directory,
      metadata: key,
      licenses: licenses.sort().map((name) => record(path.join(directory, name))),
    };
    packages.set(key, item);
    return item;
  }
  const snark = path.join(root, 'node_modules/.pnpm/snarkjs@0.7.5/node_modules/snarkjs'),
    snarkEntry = createRequire(path.join(snark, 'package.json')).resolve('snarkjs');
  assert.equal(packageFor(snarkEntry).version, '0.7.5');
  let patched = false;
  const result = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: `const { groth16 } = require('snarkjs');
exports.fullProve = (input, wasm, key) => groth16.fullProve(input, wasm, key, undefined, undefined, { singleThread: true });
exports.verify = (...args) => groth16.verify(...args);`,
      resolveDir: snark,
      sourcefile: 'railgun-serial-entry.cjs',
    },
    outfile: path.join(source, 'serial-prover.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
    legalComments: 'eof',
    charset: 'ascii',
    sourcemap: false,
    minify: false,
    plugins: [
      {
        name: 'pinned-serial-verifier',
        setup(build) {
          build.onLoad({ filter: /snarkjs[/\\]build[/\\]main\.cjs$/ }, ({ path: file }) => {
            assert.equal(patched, false);
            const contents = fs.readFileSync(file, 'utf8');
            assert.equal(digest(contents), serialSource);
            record(file);
            const start = contents.indexOf('async function groth16Verify('),
              end = contents.indexOf('\nfunction isWellConstructed$1(', start),
              call = 'const curve = await getCurveFromName(vk_verifier.curve);',
              body = contents.slice(start, end);
            assert.equal(contents.split('async function groth16Verify(').length, 2);
            assert.ok(start >= 0 && end > start);
            assert.equal(body.split(call).length, 2);
            patched = true;
            return {
              contents:
                contents.slice(0, start) +
                body.replace(
                  call,
                  'const curve = await getCurveFromName(vk_verifier.curve, { singleThread: true });'
                ) +
                contents.slice(end),
              loader: 'js',
              resolveDir: path.dirname(file),
            };
          });
          build.onResolve({ filter: /^web-worker$/ }, ({ importer }) => {
            const entry = createRequire(importer).resolve('web-worker'),
              pkg = packageFor(entry);
            workers.set(pkg.version, pkg);
            return { path: `./node_modules/web-worker-${pkg.version}/cjs/node.js`, external: true };
          });
        },
      },
    ],
  });
  assert.ok(patched);
  for (const file of Object.keys(result.metafile.inputs)) {
    const full = path.resolve(root, file);
    if (full === path.join(snark, 'railgun-serial-entry.cjs')) continue;
    record(full);
    packageFor(full);
  }
  const externals = [
    ...new Set(
      Object.values(result.metafile.outputs).flatMap((o) =>
        o.imports.filter((i) => i.external).map((i) => i.path)
      )
    ),
  ].sort();
  for (const name of externals)
    assert.ok(
      builtinModules.includes(name.replace(/^node:/, '')) ||
        /^\.\/node_modules\/web-worker-[0-9.]+\/cjs\/node\.js$/.test(name)
    );
  function copyWorker(pkg) {
    const destination = path.join(source, 'node_modules', 'web-worker-' + pkg.version);
    function copy(directory, target) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name),
          stat = fs.lstatSync(file);
        assert.ok(!stat.isSymbolicLink());
        if (stat.isDirectory()) copy(file, path.join(target, name));
        else {
          record(file);
          fs.copyFileSync(file, path.join(target, name), fs.constants.COPYFILE_EXCL);
        }
      }
    }
    copy(pkg.directory, destination);
  }
  for (const pkg of workers.values()) copyWorker(pkg);
  const licensesDirectory = path.join(source, 'licenses');
  fs.mkdirSync(licensesDirectory);
  for (const pkg of packages.values()) {
    const directory = path.join(
      licensesDirectory,
      pkg.name.replaceAll('/', '__') + '-' + pkg.version
    );
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of pkg.licenses)
      fs.copyFileSync(path.join(root, entry.file), path.join(directory, path.basename(entry.file)));
    fs.copyFileSync(path.join(root, pkg.metadata), path.join(directory, 'package.json'));
  }
  const inventory = {
    schema: 'railgun-prover-inputs-v1',
    snarkjs: '0.7.5',
    esbuild: esbuild.version,
    asar: require('@electron/asar/package.json').version,
    adaptation: 'groth16-verify-single-thread-v1',
    serialSource,
    files: [...inputs.values()].sort((a, b) => a.file.localeCompare(b.file)),
    packages: [...packages.values()]
      .map(({ directory: _directory, ...p }) => p)
      .sort((a, b) => a.metadata.localeCompare(b.metadata)),
    externals,
  };
  // Reread every input after bundling to detect modification during assembly.
  for (const entry of inventory.files)
    assert.equal(digest(fs.readFileSync(path.join(root, entry.file))), entry.sha256);
  if (mode !== '--capture-inputs')
    assert.deepEqual(inventory, require('./fixtures/railgun-prover-inputs.json'));
  fs.writeFileSync(path.join(output, 'inputs.json'), JSON.stringify(inventory, null, 2) + '\n');
  fs.writeFileSync(
    path.join(source, 'build-inventory.json'),
    JSON.stringify(inventory, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(source, 'candidate.json'),
    JSON.stringify(
      {
        schema: 'railgun-serial-prover-v1',
        productionDistributionApproved: false,
        builderSha256: digest(fs.readFileSync(__filename)),
        inputsSha256: digest(JSON.stringify(inventory)),
      },
      null,
      2
    ) + '\n'
  );
  const archive = path.join(output, 'railgun-prover.asar');
  await asar.createPackage(source, archive);
  const report = {
    sha256: digest(fs.readFileSync(archive)),
    size: fs.statSync(archive).size,
    inventorySha256: digest(JSON.stringify(inventory)),
    builderSha256: digest(fs.readFileSync(__filename)),
    snarkjs: inventory.snarkjs,
    esbuild: inventory.esbuild,
    inputFiles: inventory.files.length,
    packages: inventory.packages.map(({ name, version, license }) => ({ name, version, license })),
    productionDistributionApproved: false,
    capturedInputs: mode === '--capture-inputs',
  };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
