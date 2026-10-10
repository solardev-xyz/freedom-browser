#!/usr/bin/env node
/** Build an isolated ASAR from the pinned, already-built SDK. No installation. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { createRequire } = require('module');
const esbuild = require('esbuild');

async function main() {
  let checkout = process.argv[2];
  let fixtures = process.argv[3];
  let repository = path.resolve(__dirname, '..');
  const deterministic = process.argv.includes('--deterministic');
  const recipe = require('./lib/ppv2-build-inputs');
  const originalPaths = [checkout, fixtures].filter(Boolean);
  const recipeRevision = deterministic ? recipe.committedRecipe(repository) : null;
  if (!checkout || !path.isAbsolute(checkout))
    throw new Error('Absolute pinned PPv2 checkout required');
  const revision = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (revision !== 'fe0244e3f14110efd83db02c60c96517dea9cd5a')
    throw new Error('Re-review changed SDK');
  if (
    execFileSync('git', ['-C', checkout, 'status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
    }).trim()
  )
    throw new Error('Clean SDK checkout required');
  const outputOption = process.argv.find((arg) => arg.startsWith('--output-root='));
  let directory = outputOption
    ? outputOption.slice('--output-root='.length)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-process-asar-'));
  if (!path.isAbsolute(directory)) throw new Error('Absolute output root required');
  if (outputOption) fs.mkdirSync(directory);
  directory = fs.realpathSync(directory);
  let staged;
  const metafiles = [];
  if (deterministic) {
    if (!fixtures || process.argv[4] !== '--exit-circuits')
      throw new Error('Complete runtime inputs required');
    staged = recipe.prepareInputs({ checkout, fixtures, directory, repository });
    ({ checkout, fixtures, repository } = staged);
  }
  const build = async (options) => {
    const result = await esbuild.build({
      ...options,
      ...(deterministic
        ? {
            absWorkingDir: staged.root,
            metafile: true,
            legalComments: 'eof',
            charset: 'ascii',
            sourcemap: false,
            minify: false,
          }
        : {}),
    });
    if (deterministic) metafiles.push(result.metafile);
    return result;
  };
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const sdkEntry = path.join(checkout, 'packages/sdk/dist/index.cjs');
  // web-worker uses its own __filename as a child bootstrap. Keep that package
  // separate rather than flattening it into the SDK bundle and breaking it.
  const workers = new Map();
  const built = await build({
    entryPoints: [sdkEntry],
    outfile: path.join(source, 'sdk.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    conditions: ['module-sync'],
    metafile: true,
    plugins: [
      {
        name: 'normalize-empty-asp-root',
        setup(build) {
          build.onLoad({ filter: /index\.cjs$/ }, ({ path: filename }) => {
            if (filename !== sdkEntry) return;
            const contents = fs.readFileSync(filename, 'utf8');
            const before = 'if (leaves.length === 0) return "0x0";';
            if (contents.split(before).length !== 2)
              throw new Error('Re-review SDK empty-root compatibility patch');
            return {
              contents: contents.replace(
                before,
                `if (leaves.length === 0) return "0x${'0'.repeat(64)}";`
              ),
              loader: 'js',
            };
          });
        },
      },
      {
        name: 'preserve-worker-bootstrap',
        setup(build) {
          build.onResolve({ filter: /^web-worker$/ }, ({ importer }) => {
            const entry = createRequire(importer).resolve('web-worker');
            const root = path.dirname(path.dirname(entry));
            if (deterministic) recipe.within(staged.root, root);
            const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
            workers.set(version, root);
            return { path: `./node_modules/web-worker-${version}/cjs/node.js`, external: true };
          });
        },
      },
    ],
  });
  for (const [version, root] of workers)
    fs.cpSync(root, path.join(source, `node_modules/web-worker-${version}`), { recursive: true });
  fs.copyFileSync(
    path.join(repository, 'scripts/fixtures/ppv2-process-job.js'),
    path.join(source, 'job.cjs')
  );
  const artifacts = path.join(source, 'artifacts');
  fs.mkdirSync(artifacts);
  const names = {
    wasm: ['deposit_js/deposit.wasm', 'deposit.wasm'],
    provingKey: ['groth16_pkey.zkey', 'deposit.zkey'],
    verificationKey: ['groth16_vkey.json', 'deposit.vkey.json'],
  };
  // Do not execute installed dependency code while verifying build inputs.
  const circuitManifest = deterministic
    ? Object.fromEntries(
        ['deposit', 'ragequit', 'transact_1x1'].map((circuit) => [
          circuit,
          Object.fromEntries(
            recipe.pins.circuitFiles
              .filter((file) => file.circuit === circuit)
              .map((file) => [`${file.kind}Sha256`, file.sha256])
          ),
        ])
      )
    : require(sdkEntry).DEFAULT_CIRCUIT_MANIFEST;
  const manifest = Object.entries(names).map(([kind, [relative, name]]) => {
    const bytes = fs.readFileSync(path.join(checkout, 'packages/circuits/build/deposit', relative));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== circuitManifest.deposit[`${kind}Sha256`])
      throw new Error('Artifact digest mismatch');
    fs.writeFileSync(path.join(artifacts, name), bytes);
    return { kind, name, size: bytes.length, sha256 };
  });
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  // Explicit opt-in: hydrate these pinned LFS artifacts first. Never generate
  // replacement proving keys or silently download from a runtime gateway.
  const exitManifest = [];
  if (process.argv[4] === '--exit-circuits') {
    for (const circuit of ['ragequit', 'transact_1x1']) {
      for (const [kind, relative] of Object.entries({
        wasm: `${circuit}_js/${circuit}.wasm`,
        provingKey: 'groth16_pkey.zkey',
        verificationKey: 'groth16_vkey.json',
      })) {
        const bytes = fs.readFileSync(
          path.join(checkout, 'packages/circuits/build', circuit, relative)
        );
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== circuitManifest[circuit][`${kind}Sha256`])
          throw new Error('Exit artifact digest mismatch');
        const name = `${circuit}.${{ wasm: 'wasm', provingKey: 'zkey', verificationKey: 'vkey.json' }[kind]}`;
        fs.writeFileSync(path.join(artifacts, name), bytes);
        exitManifest.push({ circuit, kind, name, size: bytes.length, sha256 });
      }
    }
    fs.writeFileSync(path.join(source, 'exit-manifest.json'), JSON.stringify(exitManifest));
    fs.copyFileSync(
      path.join(repository, 'scripts/fixtures/ppv2-exit-job.js'),
      path.join(source, 'exit-job.cjs')
    );
    // Same locked snarkjs dependency. Proving has a supported single-thread
    // option; verification needs the narrowly pinned source adaptation below.
    let serialVerifierPatched = false;
    await build({
      stdin: {
        contents: `const { groth16 } = require('snarkjs');
      exports.fullProve = (input, wasm, key) => groth16.fullProve(input, wasm, key, undefined, undefined, { singleThread: true });
      exports.verify = (...args) => groth16.verify(...args);`,
        resolveDir: path.join(checkout, 'packages/sdk'),
      },
      outfile: path.join(source, 'serial-prover.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      plugins: [
        {
          name: 'single-thread-groth16-verification',
          setup(build) {
            build.onLoad({ filter: /snarkjs[/\\]build[/\\]main\.cjs$/ }, ({ path: file }) => {
              if (serialVerifierPatched) throw new Error('Repeated verifier source');
              const contents = fs.readFileSync(file, 'utf8');
              if (
                createHash('sha256').update(contents).digest('hex') !==
                recipe.pins.serialVerifierSourceSha256
              )
                throw new Error('Changed pinned verifier source');
              const start = contents.indexOf('async function groth16Verify(');
              const end = contents.indexOf('\nfunction isWellConstructed$1(', start);
              const call = 'const curve = await getCurveFromName(vk_verifier.curve);';
              const body = contents.slice(start, end);
              if (
                contents.split('async function groth16Verify(').length !== 2 ||
                start < 0 ||
                end <= start ||
                body.split(call).length !== 2
              )
                throw new Error('Unexpected Groth16 verifier source');
              serialVerifierPatched = true;
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
          },
        },
        {
          name: 'preserve-serial-worker-bootstrap',
          setup(build) {
            build.onResolve({ filter: /^web-worker$/ }, ({ importer }) => {
              const entry = createRequire(importer).resolve('web-worker');
              const root = path.dirname(path.dirname(entry));
              if (deterministic) recipe.within(staged.root, root);
              const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
              if (!workers.has(version)) throw new Error('Unreviewed worker version');
              return { path: `./node_modules/web-worker-${version}/cjs/node.js`, external: true };
            });
          },
        },
      ],
    });
    if (!serialVerifierPatched) throw new Error('Groth16 verifier adaptation was not applied');
  }

  // Optional real Kohaku session candidate for the assembled-deposit probe.
  let sessionCandidate = null;
  if (fixtures) {
    if (!path.isAbsolute(fixtures))
      throw new Error('Absolute compatibility fixture directory required');
    const previous = JSON.parse(fs.readFileSync(path.join(fixtures, 'report.json')));
    const patchHash = createHash('sha256')
      .update(fs.readFileSync(path.join(repository, 'scripts/fixtures/kohaku-ppv2-compat.patch')))
      .digest('hex');
    if (
      !previous.adapterTypecheck.passed ||
      previous.sdkRevision !== revision ||
      previous.compatibilityPatchSha256 !== patchHash ||
      previous.sdkEntrySha256 !==
        createHash('sha256').update(fs.readFileSync(sdkEntry)).digest('hex')
    )
      throw new Error('Rebuild reviewed compatibility fixtures');
    await build({
      stdin: {
        contents: `
      export { createPPv2Plugin } from './plugin';
      export { createPPv2Broadcaster } from './broadcaster';
      import { deriveKeystoreManager } from './account/derivation';
      import { CryptoService, PoseidonHashService, NoteComputationService } from '@0xbow-io/privacy-pools-v2-sdk';
      export async function inspectRegistration(keystore, accountIndex) {
        const { keystoreManager } = await deriveKeystoreManager({ keystore, accountIndex });
        const hashService = await PoseidonHashService.create();
        const notes = new NoteComputationService({ hashService, cryptoService: new CryptoService() });
        return {
          nullifyingKeyHash: hashService.hash([keystoreManager.getPrivateNullifyingKey()]),
          authDigest: notes.computeAuthDigest(keystoreManager.getPrivateRevocableKey()),
          viewingKey: keystoreManager.getViewingKeyPair().publicKey,
        };
      }
      export async function inspectNullifier(keystore, accountIndex, commitment) {
        const { keystoreManager } = await deriveKeystoreManager({ keystore, accountIndex });
        const notes = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService: new CryptoService() });
        return notes.computeNullifier(keystoreManager.getPrivateNullifyingKey(), commitment);
      }
      export async function inspectChange(keystore, accountIndex, owner, noteData) {
        if (noteData.length !== 1) throw new Error('Expected one change note');
        const { keystoreManager } = await deriveKeystoreManager({ keystore, accountIndex });
        const cryptoService = new CryptoService();
        const notes = new NoteComputationService({ hashService: await PoseidonHashService.create(), cryptoService });
        const data = noteData[0].data;
        const secret = cryptoService.ecdh(keystoreManager.getViewingKeyPair().privateKey, data.slice(0,66));
        const payload = notes.decodeNotePayload(cryptoService.decrypt('0x'+data.slice(66), secret));
        const commitment = notes.computeFullCommitment({ noteAddressHash: notes.computeNoteAddressHash(owner, payload.noteSecret),
          tokenId: payload.tokenId, value: payload.value, label: payload.label });
        return { commitment, value: payload.value, tokenId: payload.tokenId };
      }`,
        resolveDir: path.join(fixtures, 'packages/privacy-pools/src/v2'),
        loader: 'ts',
      },
      outfile: path.join(source, 'plugin.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      nodePaths: [path.join(checkout, 'packages/sdk/node_modules')],
      alias: { '@kohaku-eth/plugins': path.join(fixtures, 'packages/plugins/src/index.ts') },
      plugins: [
        {
          name: 'local-sdk',
          setup(build) {
            build.onResolve({ filter: /^@0xbow-io\/privacy-pools-v2-sdk$/ }, () => ({
              path: './sdk.cjs',
              external: true,
            }));
          },
        },
      ],
    });
    await build({
      entryPoints: [path.join(checkout, 'packages/sdk/src/constant/ContractInteractor.ts')],
      outfile: path.join(source, 'abis.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    });
    fs.copyFileSync(
      path.join(repository, 'test/helpers/ppv2-session-fixture.js'),
      path.join(source, 'configuration.cjs')
    );
    await build({
      entryPoints: [path.join(fixtures, 'packages/privacy-pools/src/v2/adapters/http.adapter.ts')],
      outfile: path.join(source, 'http.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
    });
    sessionCandidate = { kohaku: previous.kohakuRevision, sdk: revision, patchSha256: patchHash };
    fs.writeFileSync(path.join(source, 'candidate.json'), JSON.stringify(sessionCandidate));
  }
  const output = path.join(directory, 'ppv2.asar');
  let inventory;
  if (deterministic) {
    inventory = recipe.inventoryInputs(staged.root, metafiles);
    inventory.workers = [...workers.values()].flatMap((root) =>
      recipe.inventoryTree(staged.root, root)
    );
    inventory.configs = [
      'ppv2/packages/sdk/tsconfig.json',
      'kohaku/tsconfig.json',
      'tsconfig.json',
    ].map((file) => ({
      file,
      sha256: recipe.digest(fs.readFileSync(path.join(staged.root, file))),
    }));
    recipe.verifyInventory(inventory, recipe.pins.dependencyInventorySha256);
    const licenseDirectory = path.join(source, 'licenses');
    for (const item of inventory.packages)
      for (const license of item.licenses) {
        const target = path.join(licenseDirectory, license.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(staged.root, license.file), target);
      }
    fs.mkdirSync(path.join(licenseDirectory, 'ppv2'), { recursive: true });
    fs.copyFileSync(path.join(checkout, 'LICENSE'), path.join(licenseDirectory, 'ppv2/LICENSE'));
    inventory.recipe = {
      revision: recipeRevision,
      pins: recipe.pins,
      builderSha256: recipe.digest(fs.readFileSync(__filename)),
      helperSha256: recipe.digest(fs.readFileSync(require.resolve('./lib/ppv2-build-inputs'))),
      sdkCompatibility: 'empty-asp-root-v1',
      snarkjsAdaptation: 'groth16-verify-single-thread-v1',
      dependencyResolution: 'Kohaku dependencies resolve from the pinned PPv2 pnpm tree',
      licenseReviewRequired: true,
      productionDistributionApproved: false,
    };
    fs.writeFileSync(
      path.join(source, 'build-inventory.json'),
      JSON.stringify(inventory, null, 2) + '\n'
    );
    const files = recipe.packedFiles(source);
    recipe.assertNoHostPaths(files, [
      directory,
      staged.root,
      process.env.HOME,
      ...originalPaths,
      ...originalPaths.map((value) => fs.realpathSync(value)),
    ]);
    await require('@electron/asar').createPackageFromFiles(source, output, files);
  } else await require('@electron/asar').createPackage(source, output);
  const report = {
    revision,
    output,
    deterministicRecipe: deterministic,
    ...(inventory
      ? {
          inventorySha256: recipe.digest(
            fs.readFileSync(path.join(source, 'build-inventory.json'))
          ),
        }
      : {}),
    sdkCompatibility: 'empty-asp-root-v1',
    manifest,
    exitManifest,
    sessionCandidate,
    webWorkerVersions: [...workers.keys()],
    asarSha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
    bundleInputs: Object.keys(built.metafile.inputs).length,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
