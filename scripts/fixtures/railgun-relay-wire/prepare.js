'use strict';

// Port of reviewed extraction recipe; source/build only, never imports its output.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const verified = require('./inputs');
async function prepare(rootsFile, output) {
  const roots = verified.rootsFrom(rootsFile);
  const resolvedInputs = verified.verifyInputs(roots);
  const recipeBefore = verified.recipePins();
  const generated = verified.freshOutput(output, roots);
  const here = generated;
  const hash = verified.sha,
    need = verified.need;
  const inputs = {
    sources: Object.fromEntries(
      Object.entries(verified.pins.sources).map(([k, e]) => [
        k,
        { ...e, path: verified.resolveInput(roots, e.input) },
      ])
    ),
  };
  const parser = require(path.join(roots.buildTools, '@babel/parser'));
  const traverse = require(path.join(roots.buildTools, '@babel/traverse')).default;
  const esbuild = require(path.join(roots.buildTools, 'esbuild'));
  const selections = [];
  function pathRecord(absolute) {
    const hops = [];
    let prefix = path.parse(absolute).root;
    for (const part of absolute.slice(prefix.length).split(path.sep)) {
      prefix = path.join(prefix, part);
      if (fs.lstatSync(prefix).isSymbolicLink())
        hops.push({ path: prefix, target: fs.readlinkSync(prefix) });
    }
    return { requestedPath: absolute, resolvedPath: fs.realpathSync(absolute), symlinkHops: hops };
  }
  function select(key, name) {
    const entry = inputs.sources[key];
    const raw = fs.readFileSync(entry.path);
    need(raw.length === entry.bytes && hash(raw) === entry.sha256, `Source pin ${key}`);
    need(entry.selectedDeclarations.includes(name), `Selection not declared ${name}`);
    const source = raw.toString('utf8');
    const ast = parser.parse(source, { sourceType: 'module', plugins: ['typescript'] });
    const found = [];
    for (const outer of ast.program.body) {
      const node = outer.type === 'ExportNamedDeclaration' ? outer.declaration : outer;
      if (!node) continue;
      if (node.type === 'ClassDeclaration' && name.startsWith(`${node.id.name}.`)) {
        for (const method of node.body.body) {
          if (method.type === 'ClassMethod' && method.key.name === name.split('.')[1]) {
            need(
              method.static && method.accessibility === 'private',
              'Exact private static source method'
            );
            found.push(method);
          }
        }
      } else if (node.type === 'VariableDeclaration') {
        if (node.declarations.some((d) => d.id.name === name)) {
          need(node.declarations.length === 1 && node.kind === 'const', 'Single const declaration');
          found.push(node);
        }
      } else if (
        node.id?.name === name &&
        ['FunctionDeclaration', 'TSEnumDeclaration'].includes(node.type)
      ) {
        found.push(node);
      }
    }
    need(found.length === 1, `Exactly one source declaration ${name}`);
    const node = found[0],
      text = source.slice(node.start, node.end);
    selections.push({
      source: key,
      name,
      nodeType: node.type,
      startCodeUnit: node.start,
      endCodeUnit: node.end,
      exactTextSha256: hash(text),
      exactTextBytes: Buffer.byteLength(text),
    });
    return text;
  }
  const quote = JSON.stringify;
  const engine = path.join(roots.engineSource, 'src');
  const noble = path.join(roots.engineDependencies, '@noble/ed25519/lib/index.js');
  const ethereumAddress = path.join(roots.engineDependencies, 'ethers/lib.esm/address/address.js');
  const ethereumData = path.join(roots.engineDependencies, 'ethers/lib.esm/utils/data.js');
  const imports = `import * as ed from ${quote(noble)};\nimport { getPublicKey, verify } from ${quote(noble)};\nimport { ByteUtils } from ${quote(path.join(engine, 'utils/bytes.ts'))};\nimport { encryptJSONDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from ${quote(path.join(engine, 'utils/ecies.ts'))};\nimport { encodeAddress, decodeAddress } from ${quote(path.join(engine, 'key-derivation/bech32.ts'))};\nimport { getAddress } from ${quote(ethereumAddress)};\nimport { isHexString } from ${quote(ethereumData)};\n`;
  const engineDeclarations = inputs.sources.engineKeys.selectedDeclarations.map((n) =>
    select('engineKeys', n)
  );
  const walletDeclarations = ['walletBytes', 'walletCrypto', 'walletAddress'].flatMap((k) =>
    inputs.sources[k].selectedDeclarations.map((n) => select(k, n))
  );
  const conversion = select('clientConversion', 'bytesToHex');
  const enumeration = select('sharedEnum', 'BroadcasterTransactRequestType');
  const encryptMethod = select('clientEncrypt', 'BroadcasterTransaction.encryptTransaction');
  const serverDeclarations = inputs.sources.serverCrypto.selectedDeclarations.map((n) =>
    select('serverCrypto', n)
  );
  const configInput = inputs.sources.clientConfig;
  const configBytes = fs.readFileSync(configInput.path);
  need(
    hash(configBytes) === configInput.sha256 && configBytes.length === configInput.bytes,
    'Source config pin'
  );
  const configAst = parser.parse(configBytes.toString(), {
    sourceType: 'module',
    plugins: ['typescript'],
  });
  const configClass = configAst.program.body.find(
    (n) => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'BroadcasterConfig'
  )?.declaration;
  need(configClass?.type === 'ClassDeclaration', 'Source config class');
  const values = {};
  for (const name of configInput.selectedDeclarations) {
    const fields = configClass.body.body.filter(
      (n) => n.type === 'ClassProperty' && n.static && n.key.name === name
    );
    need(
      fields.length === 1 && ['BooleanLiteral', 'StringLiteral'].includes(fields[0].value?.type),
      'Source config literal'
    );
    values[name] = fields[0].value.value;
  }
  need(
    JSON.stringify(values) ===
      JSON.stringify({
        IS_DEV: false,
        MINIMUM_BROADCASTER_VERSION: '8.0.0',
        MAXIMUM_BROADCASTER_VERSION: '8.999.0',
      }),
    'Expected source defaults'
  );
  const constants = `const RailgunEngine = Object.freeze({ decodeAddress });\nconst BroadcasterConfig = Object.freeze(${JSON.stringify(values)});\n`;
  const exports = `export { ed, encodeAddress, decodeAddress, getRailgunWalletAddressData, verifyBroadcasterSignature, encryptDataWithSharedKey, decryptAESGCM256, encryptJSONDataWithSharedKey, tryDecryptJSONDataWithSharedKey, tryDecryptData, encryptResponseData };\nexport class OfflineClientEncryptor {\n${encryptMethod}\n}\n`;
  const generatedSource =
    imports +
    constants +
    [
      ...engineDeclarations,
      ...walletDeclarations,
      conversion,
      enumeration,
      ...serverDeclarations,
    ].join('\n\n') +
    '\n' +
    exports;
  const freeNames = new Set();
  traverse(parser.parse(generatedSource, { sourceType: 'module', plugins: ['typescript'] }), {
    ReferencedIdentifier(p) {
      if (p.findParent((ancestor) => ancestor.isTSType?.())) return;
      // Babel does not register TypeScript enum runtime bindings in this traversal.
      const exactSelectedEnum =
        p.node.name === 'BroadcasterTransactRequestType' &&
        selections.some((s) => s.name === p.node.name && s.nodeType === 'TSEnumDeclaration');
      if (!p.scope.hasBinding(p.node.name) && !exactSelectedEnum) freeNames.add(p.node.name);
    },
  });
  need(
    [...freeNames].every((n) => ['Object', 'Buffer', 'Error'].includes(n)),
    `Unexpected runtime free identifier: ${[...freeNames].join(', ')}`
  );
  need(process.env.ESBUILD_BINARY_PATH === undefined, 'External esbuild binary override refused');
  const builderBinary = require.resolve(
    `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
    { paths: [roots.buildTools] }
  );
  const builderBytes = fs.readFileSync(builderBinary);
  const entryPath = path.join(generated, 'selected-upstream.ts');
  fs.writeFileSync(entryPath, generatedSource, { flag: 'wx' });
  const build = await esbuild.build({
    entryPoints: [entryPath],
    outfile: path.join(generated, 'upstream.cjs'),
    absWorkingDir: here,
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    metafile: true,
    minify: false,
    treeShaking: true,
    sourcemap: false,
    nodePaths: [roots.engineDependencies],
    alias: Object.fromEntries(
      ['ethereum-cryptography', '@scure/base', 'buffer-xor'].map((name) => [
        name,
        path.join(roots.engineDependencies, name),
      ])
    ),
    logLevel: 'silent',
  });
  const graph = {};
  for (const [name, value] of Object.entries(build.metafile.inputs)) {
    const absolute = path.resolve(here, name);
    need(
      !/(?:waku|wallets\/wallets|keys-utils|scalar-multiply|poseidon|leveldown|levelup|provider-jsonrpc)/.test(
        absolute
      ),
      `Excluded runtime graph input ${name}`
    );
    const bytes = fs.readFileSync(absolute);
    need(bytes.length === value.bytes, 'Metafile input length');
    graph[name] = {
      ...pathRecord(absolute),
      bytes: bytes.length,
      sha256: hash(bytes),
      imports: value.imports,
    };
  }
  const sourceExternals = [
    ...new Set(
      Object.values(build.metafile.inputs).flatMap((x) =>
        x.imports.filter((i) => i.external).map((i) => i.path)
      )
    ),
  ].sort();
  fs.writeFileSync(
    path.join(generated, 'diagnostic-metafile.json'),
    JSON.stringify(build.metafile, null, 2),
    { flag: 'wx' }
  );
  const externals = [
    ...new Set(
      Object.values(build.metafile.outputs).flatMap((x) =>
        x.imports.filter((i) => i.external).map((i) => i.path)
      )
    ),
  ].sort();
  const allowed = new Set([
    'crypto',
    'node:crypto',
    'buffer',
    'node:buffer',
    'util',
    'node:util',
    'stream',
    'string_decoder',
    'events',
  ]);
  need(
    externals.every((name) => allowed.has(name)),
    `Unexpected external dependency: ${externals.join(', ')}`
  );
  for (const file of build.outputFiles) fs.writeFileSync(file.path, file.contents, { flag: 'wx' });
  const historicalRecord = {
    scope: 'Source extraction and build only; generated crypto bundle never imported/executed',
    builder: {
      ...pathRecord(builderBinary),
      bytes: builderBytes.length,
      sha256: hash(builderBytes),
      version: esbuild.version,
      platform: process.platform,
      arch: process.arch,
    },
    sourceConfigDefaults: values,
    runtimeFreeIdentifiers: [...freeNames].sort(),
    selections,
    bindings: {
      originalLeafModules: [
        'utils/bytes.ts',
        'utils/ecies.ts',
        'utils/encryption/aes.ts',
        'utils/encryption/ciphertext.ts',
        'key-derivation/bech32.ts',
      ],
      extractedBodiesHaveOriginalModuleInitialization: false,
      engineNamespaceReplacement:
        'Frozen object containing actual original leaf decodeAddress only',
      broadcasterConfigReplacement:
        'Frozen source-default dev/version constants only; actual config module not initialized',
      ethereumHelpers:
        'Actual installed ethers6.14.3 leaf exports; full package entrypoint excluded',
      noCryptoStubs: true,
      noRandomnessStubs: true,
    },
    generatedSource: { bytes: Buffer.byteLength(generatedSource), sha256: hash(generatedSource) },
    outputs: Object.fromEntries(
      build.outputFiles.map((f) => [
        path.basename(f.path),
        { bytes: f.contents.length, sha256: hash(f.contents) },
      ])
    ),
    externalModules: externals,
    sourceExternalEdges: sourceExternals,
    inactiveBrowserFallbackRetained: true,
    graph,
    toolInputs: Object.fromEntries(
      [
        '@babel/parser/package.json',
        '@babel/parser/lib/index.js',
        '@babel/traverse/package.json',
        '@babel/traverse/lib/index.js',
        'esbuild/package.json',
        'esbuild/lib/main.js',
      ].map((n) => {
        const b = fs.readFileSync(path.join(roots.buildTools, n));
        return [n, { bytes: b.length, sha256: hash(b) }];
      })
    ),
  };

  const graphInputs = Object.keys(graph)
    .filter((name) => path.resolve(here, name) !== entryPath)
    .map((name) => verified.normalized(roots, path.resolve(here, name)))
    .sort();
  verified.verifyGraph(graphInputs, externals);
  assert.deepEqual(selections, verified.pins.spans);
  // Recheck all inputs after the asynchronous build, before publishing completion.
  assert.deepEqual(verified.verifyInputs(roots), resolvedInputs);
  assert.deepEqual(verified.recipePins(), recipeBefore);
  const manifest = {
    schema: 1,
    recipe: recipeBefore,
    roots,
    resolvedInputs,
    graphInputs,
    externalModules: externals,
    outputs: {
      ...historicalRecord.outputs,
      'selected-upstream.ts': historicalRecord.generatedSource,
    },
    selectedSpans: selections,
    sourceConfigDefaults: values,
    node: process.version,
    nodeExecutableSha256: hash(fs.readFileSync(process.execPath)),
    scope: 'Build only; generated crypto module not imported',
  };
  fs.writeFileSync(path.join(generated, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return {
    manifestSha256: hash(fs.readFileSync(path.join(generated, 'build.json'))),
    output: generated,
    generatedCryptoExecuted: false,
  };
}
module.exports = { prepare };
