/** Offline, development-only runtime assembly. No downloads or pin updates. */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const pins = require('../fixtures/ppv2-build-inputs.json');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (file) => fs.readFileSync(file);
const assertDigest = (file, expected) => {
  if (digest(read(file)) !== expected)
    throw new Error(`Changed pinned input: ${path.basename(file)}`);
};
const recipeFiles = [
  'scripts/spike-ppv2-process.js',
  'scripts/lib/ppv2-build-inputs.js',
  'scripts/fixtures/ppv2-build-inputs.json',
  'scripts/fixtures/kohaku-ppv2-compat.patch',
];
function committedRecipe(repository) {
  for (const file of recipeFiles) {
    const committed = execFileSync('git', ['-C', repository, 'show', `HEAD:${file}`]);
    if (!committed.equals(read(path.join(repository, file))))
      throw new Error('Commit the reviewed build recipe before deterministic assembly');
  }
  // A later documentation/runtime-pin commit must not perturb identical builds.
  return execFileSync('git', ['-C', repository, 'log', '-1', '--format=%H', '--', ...recipeFiles], {
    encoding: 'utf8',
  }).trim();
}
function assertNoHostPaths(files, forbidden) {
  for (const file of files.filter((file) => fs.statSync(file).isFile())) {
    const bytes = read(file);
    if (forbidden.filter(Boolean).some((value) => bytes.includes(value)))
      throw new Error('Host path embedded in runtime');
  }
}
function within(root, file) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`))
    throw new Error(`Build input escapes staging root: ${relative}`);
  return relative.split(path.sep).join('/');
}
function prepareInputs({ checkout, fixtures, directory, repository }) {
  if (
    process.versions.node !== pins.node ||
    require('esbuild').version !== pins.esbuild ||
    require('@electron/asar/package.json').version !== pins.asar
  )
    throw new Error('Pinned build toolchain required');
  const previous = JSON.parse(read(path.join(fixtures, 'report.json')));
  if (
    previous.failed ||
    !previous.adapterTypecheck?.passed ||
    !previous.derivation?.passed ||
    !previous.processProof?.verified ||
    previous.sdkRevision !== pins.sdkRevision ||
    previous.kohakuRevision !== pins.kohakuRevision ||
    previous.compatibilityPatchSha256 !== pins.compatibilityPatchSha256
  )
    throw new Error('Complete pinned compatibility qualification required');
  assertDigest(path.join(checkout, 'pnpm-lock.yaml'), pins.lockfileSha256);
  assertDigest(path.join(checkout, 'packages/sdk/dist/index.cjs'), pins.sdkEntrySha256);
  assertDigest(path.join(checkout, 'LICENSE'), pins.sdkLicenseSha256);
  assertDigest(
    path.join(repository, 'scripts/fixtures/kohaku-ppv2-compat.patch'),
    pins.compatibilityPatchSha256
  );
  for (const entry of pins.adapterSources)
    assertDigest(path.join(fixtures, entry.file), entry.sha256);
  // Packed test helpers come from an immutable Freedom revision, not a dirty worktree.
  const repoBytes = pins.freedomFiles.map((entry) => {
    const bytes = execFileSync('git', [
      '-C',
      repository,
      'show',
      `${pins.freedomRevision}:${entry.file}`,
    ]);
    if (digest(bytes) !== entry.sha256) throw new Error('Changed pinned Freedom input');
    return [entry.file, bytes];
  });
  const root = path.join(directory, 'inputs');
  fs.mkdirSync(root);
  const sdk = path.join(root, 'ppv2'),
    adapter = path.join(root, 'kohaku'),
    repo = path.join(root, 'freedom');
  fs.mkdirSync(sdk);
  fs.mkdirSync(adapter);
  fs.mkdirSync(repo);
  for (const name of ['node_modules', 'packages', 'package.json', 'pnpm-lock.yaml', 'LICENSE'])
    fs.cpSync(path.join(checkout, name), path.join(sdk, name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  assertDigest(path.join(sdk, 'pnpm-lock.yaml'), pins.lockfileSha256);
  assertDigest(path.join(sdk, 'packages/sdk/dist/index.cjs'), pins.sdkEntrySha256);
  assertDigest(path.join(sdk, 'LICENSE'), pins.sdkLicenseSha256);
  assertDigest(path.join(sdk, 'packages/sdk/tsconfig.json'), pins.sdkConfigSha256);
  for (const entry of pins.adapterSources) {
    const destination = path.join(adapter, entry.file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(fixtures, entry.file), destination);
    assertDigest(destination, entry.sha256);
  }
  fs.writeFileSync(path.join(adapter, 'report.json'), JSON.stringify(previous));
  // The qualification fixture's type-resolution map also supplies transitive
  // Kohaku imports. Recreate it against staged packages, never its old host paths.
  const sdkRequire = createRequire(path.join(sdk, 'packages/sdk/package.json'));
  const viem = path.dirname(sdkRequire.resolve('viem/package.json'));
  within(root, viem);
  const adapterModules = path.join(adapter, 'node_modules');
  fs.mkdirSync(adapterModules);
  fs.symlinkSync(path.relative(adapterModules, viem), path.join(adapterModules, 'viem'), 'dir');
  const relativeViem = path.relative(adapter, viem).split(path.sep).join('/');
  fs.writeFileSync(
    path.join(adapter, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {
          viem: [`${relativeViem}/_types/index.d.ts`],
          'viem/*': [`${relativeViem}/_types/*/index.d.ts`],
          ox: [`${relativeViem}/../ox`],
          'ox/*': [`${relativeViem}/../ox/*`],
          '@scure/*': [`${relativeViem}/../@scure/*`],
        },
      },
    })
  );
  assertDigest(path.join(adapter, 'tsconfig.json'), pins.adapterConfigSha256);
  for (const [name, bytes] of repoBytes) {
    const destination = path.join(repo, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  fs.mkdirSync(path.join(repo, 'scripts/fixtures'), { recursive: true });
  fs.copyFileSync(
    path.join(repository, 'scripts/fixtures/kohaku-ppv2-compat.patch'),
    path.join(repo, 'scripts/fixtures/kohaku-ppv2-compat.patch')
  );
  return { checkout: sdk, fixtures: adapter, repository: repo, root };
}
function inventoryInputs(root, metafiles) {
  const inputs = new Map(),
    packages = new Map();
  for (const metadata of metafiles)
    for (const name of Object.keys(metadata.inputs)) {
      if (name === '<stdin>') continue;
      if (path.isAbsolute(name) || name.startsWith('../'))
        throw new Error('Non-relative build input');
      const file = path.resolve(root, name),
        relative = within(root, file);
      inputs.set(relative, { file: relative, sha256: digest(read(file)) });
      let directory = path.dirname(file);
      while (directory !== root && directory.startsWith(root + path.sep)) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) {
          within(root, manifest);
          const pkg = JSON.parse(read(manifest)),
            key = within(root, directory);
          if (!pkg.name) {
            directory = path.dirname(directory);
            continue;
          }
          if (!packages.has(key)) {
            const licenses = fs
              .readdirSync(directory)
              .filter((name) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name))
              .sort()
              .filter((name) => fs.statSync(path.join(directory, name)).isFile())
              .map((name) => {
                const file = path.join(directory, name);
                return { file: within(root, file), sha256: digest(read(file)) };
              });
            packages.set(key, {
              path: key,
              name: pkg.name || null,
              version: pkg.version || null,
              declaredLicense: pkg.license || null,
              packageSha256: digest(read(manifest)),
              licenses,
            });
          }
          break;
        }
        directory = path.dirname(directory);
      }
    }
  return {
    inputs: [...inputs.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    packages: [...packages.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    ),
    // Pinned Kohaku sources have no package metadata in the qualification fixture.
    // Preserve that gap explicitly; this is not a distribution licence clearance.
    unattributedInputs: [...inputs.keys()]
      .filter((file) => ![...packages.keys()].some((directory) => file.startsWith(directory + '/')))
      .sort(),
  };
}
function inventoryTree(root, directory) {
  const result = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    const relative = within(root, file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error('Unsupported dependency entry');
    if (stat.isDirectory()) result.push(...inventoryTree(root, file));
    else result.push({ file: relative, sha256: digest(read(file)) });
  }
  return result;
}
function verifyInventory(inventory, expected) {
  if (digest(JSON.stringify(inventory)) !== expected)
    throw new Error('Changed runtime dependency inventory; explicit review required');
}
function packedFiles(root) {
  const files = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        name.endsWith('.node')
      )
        throw new Error('Unsupported runtime archive entry');
      fs.chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
      files.push(file);
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return files;
}
module.exports = {
  pins,
  digest,
  assertDigest,
  within,
  prepareInputs,
  inventoryInputs,
  inventoryTree,
  verifyInventory,
  packedFiles,
  committedRecipe,
  assertNoHostPaths,
};
