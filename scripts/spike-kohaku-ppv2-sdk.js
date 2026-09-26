#!/usr/bin/env node
/** Reproducible offline SDK qualification; adds no application dependency.
 * Usage: node scripts/spike-kohaku-ppv2-sdk.js /absolute/kohaku /absolute/ppv2 [--compat]
 * PPv2 must have its frozen dependencies, SDK dist and deposit LFS files ready.
 * Pins are deliberate. Re-review before changing them; do not use real keys.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync, fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { buildSync } = require('esbuild');
const { HDNodeWallet } = require('ethers');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { createPrivacyArtifactLoader } = require('../src/main/wallet/privacy-artifacts');
const { runPrivacyWorker } = require('../src/main/wallet/privacy-worker');

const kohakuRevision = '6fdc248b3d28942d9aaa35c49c1ac76dab89dc0e';
const sdkRevision = 'fe0244e3f14110efd83db02c60c96517dea9cd5a';
const [kohaku, upstream] = process.argv.slice(2);
if (![kohaku, upstream].every((value) => value && path.isAbsolute(value))) {
  throw new Error('Absolute Kohaku and PPv2 source checkouts are required');
}
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
assert.equal(git(upstream, 'rev-parse', 'HEAD').trim(), sdkRevision);
assert.equal(git(upstream, 'status', '--porcelain', '--untracked-files=no').trim(), '');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ppv2-sdk-'));
const sdkDir = path.join(upstream, 'packages/sdk');
const sdkEntry = path.join(sdkDir, 'dist/index.cjs');
const sdkRequire = createRequire(path.join(sdkDir, 'package.json'));
const sdk = require(sdkEntry);
const viemDir = fs.realpathSync(path.join(sdkDir, 'node_modules/viem'));
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const report = {
  kohakuRevision, sdkRevision, node: process.version, platform: `${process.platform}-${process.arch}`,
  sdkEntrySha256: digest(fs.readFileSync(sdkEntry)),
  lockfileSha256: digest(fs.readFileSync(path.join(upstream, 'pnpm-lock.yaml'))),
  appIdentifier: sdk.APP_IDENTIFIER, applicationDependenciesChanged: false,
  auditCandidateConfirmed: false, liveNetworkTested: false, onchainTransactionSubmitted: false,
  sdkSources: ['LICENSE', 'packages/sdk/package.json', 'packages/sdk/src/constant/KeyDerivation.ts',
    'packages/sdk/src/constant/CircuitArtifacts.ts', 'packages/sdk/src/services/Groth16Prover.ts',
    'packages/sdk/src/interfaces/IRPCInteractor.ts', 'packages/sdk/src/types/NoteStatus.ts',
    'apps/sample-web/src/secretDerivationPayload.ts'].map((file) => ({ file, sha256: digest(fs.readFileSync(path.join(upstream, file))) })),
  sourceDigests: [],
};
const writeReport = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');

// Extract exact Git blobs, leaving both upstream checkouts untouched.
const files = git(kohaku, 'ls-tree', '-r', '--name-only', kohakuRevision,
  'packages/privacy-pools/src/v2', 'packages/plugins/src', 'packages/provider/src').trim().split('\n');
for (const file of files) {
  const source = git(kohaku, 'show', `${kohakuRevision}:${file}`);
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  report.sourceDigests.push({ file, sha256: digest(source) });
}
if (process.argv.includes('--compat')) {
  const patch = path.join(__dirname, 'fixtures/kohaku-ppv2-compat.patch');
  execFileSync('git', ['apply', '--check', patch], { cwd: directory });
  execFileSync('git', ['apply', patch], { cwd: directory });
  report.compatibilityPatchSha256 = digest(fs.readFileSync(patch));
}
const paths = {
  '@0xbow-io/privacy-pools-v2-sdk': [path.join(sdkDir, 'dist/index.d.ts')],
  '@kohaku-eth/plugins': [path.join(directory, 'packages/plugins/src/index.ts')],
  '@kohaku-eth/plugins/broadcaster': [path.join(directory, 'packages/plugins/src/broadcaster/base.ts')],
  '@kohaku-eth/provider': [path.join(directory, 'packages/provider/src/index.ts')],
  '~/*': [path.join(directory, 'packages/plugins/src/*')],
  viem: [path.join(viemDir, '_types/index.d.ts')],
  'viem/*': [path.join(viemDir, '_types/*/index.d.ts')],
  ox: [path.join(viemDir, '../ox')], 'ox/*': [path.join(viemDir, '../ox/*')],
  '@scure/*': [path.join(viemDir, '../@scure/*')],
};
const tsconfig = path.join(directory, 'tsconfig.json');
fs.writeFileSync(tsconfig, JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022',
    module: 'ESNext', moduleResolution: 'Bundler', paths, typeRoots: [path.join(sdkDir, 'node_modules/@types')] },
  include: ['packages/privacy-pools/src/v2/**/*.ts'],
}, null, 2));
const checked = spawnSync(process.execPath, [sdkRequire.resolve('typescript/bin/tsc'), '-p', tsconfig], { encoding: 'utf8' });
if (checked.error) throw checked.error;
assert.ok(checked.status !== null, 'Typecheck must finish');
const diagnostics = (checked.stdout + checked.stderr).replaceAll(directory, '<scratch>');
report.adapterTypecheck = { passed: checked.status === 0, diagnostics };
fs.writeFileSync(path.join(directory, 'typecheck.log'), diagnostics);

function bundle(entry, name, aliases = {}) {
  const output = path.join(directory, name);
  buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    nodePaths: [path.join(sdkDir, 'node_modules')],
    alias: { '@0xbow-io/privacy-pools-v2-sdk': sdkEntry, '@privacy-pools-v2/sdk': sdkEntry, ...aliases },
    external: [sdkEntry],
  });
  return require(output);
}

// Independent HKDF/X25519 implementation through Node crypto, not SDK helpers.
function deriveIndependently(signature, signerAddress, rotation) {
  const hkdf = (ikm, salt, info, size) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, size));
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const expand = (key, info, size) => {
    let previous = Buffer.alloc(0), result = Buffer.alloc(0);
    for (let counter = 1; result.length < size; counter += 1) {
      previous = hmac(key, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]));
      result = Buffer.concat([result, previous]);
    }
    return result.subarray(0, size);
  };
  const root = hkdf(Buffer.from(signature.slice(2, 66), 'hex'), Buffer.from(signerAddress.slice(2), 'hex'), 'Standardized-Secret-Derivation-v1-Root', 32);
  const app = hkdf(root, 'TODO-privacy-pools-v2', 'Standardized-Secret-Derivation-v1-App', 32);
  const master = hmac('PP_V2', app);
  const identity = expand(master, 'IDENTITY', 32);
  const viewing = expand(master, 'VIEWING', 32);
  const scalar = (bytes) => `0x${(BigInt('0x' + bytes.toString('hex')) %
    21888242871839275222246405745257275088548364400416034343698204186575808495617n).toString(16).padStart(64, '0')}`;
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(rotation));
  const viewingPrivate = expand(viewing, 'VIEWING_KEY', 32);
  viewingPrivate[0] &= 248; viewingPrivate[31] &= 127; viewingPrivate[31] |= 64;
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), viewingPrivate]), format: 'der', type: 'pkcs8' });
  const publicBytes = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    nullifying: scalar(expand(identity, 'NULLIFYING', 48)),
    revocable: scalar(expand(identity, Buffer.concat([Buffer.from('AUTH0:REVOCABLE'), counter]), 48)),
    viewing: { privateKey: `0x${viewingPrivate.toString('hex')}`, publicKey: `0x${publicBytes.toString('hex')}` },
  };
}

async function main() {
  if (process.argv.includes('--compat')) {
    assert.equal(report.adapterTypecheck.passed, true, diagnostics);
    bundle(path.join(directory, 'packages/privacy-pools/src/v2/adapters/rpc.adapter.ts'), 'rpc.cjs');
    bundle(path.join(directory, 'packages/privacy-pools/src/v2/mapping/status.ts'), 'status.cjs', {
      '@0xbow-io/privacy-pools-v2-sdk': path.join(upstream, 'packages/sdk/src/types/NoteStatus.ts'),
    });
    report.adapterFixtures = { rpc: path.join(directory, 'rpc.cjs'), status: path.join(directory, 'status.cjs') };
  }
  assert.equal(sdk.APP_IDENTIFIER, 'TODO-privacy-pools-v2', 'Re-review identity constants before rerunning');
  const derivation = bundle(path.join(directory, 'packages/privacy-pools/src/v2/account/derivation.ts'), 'derivation.cjs');
  const canonical = bundle(path.join(upstream, 'apps/sample-web/src/secretDerivationPayload.ts'), 'canonical.cjs');
  const testSeed = Buffer.alloc(32, 0x42); // Public synthetic seed; never a wallet credential.
  const results = [];
  for (const index of [0, 1]) {
    const expectedPath = `m/28784'/2'/${index}'`;
    const signer = HDNodeWallet.fromSeed(testSeed).derivePath(expectedPath);
    const payload = canonical.buildSecretDerivationPayload(signer.address);
    const { EIP712Domain: _domain, ...types } = payload.types;
    const signature = await signer.signTypedData(payload.domain, types, payload.message);
    for (const rotation of [0, 7]) {
      const keystore = { deriveAt: async (requested) => { assert.equal(requested, expectedPath); return signer.privateKey; } };
      const derived = await derivation.deriveKeystoreManager({ keystore, accountIndex: index, revocableKeyIndex: `0x${rotation.toString(16)}` });
      assert.equal(derived.deriveConfig.signature, signature);
      assert.equal(derived.signerAddress, signer.address);
      const expected = deriveIndependently(signature, signer.address, rotation);
      const km = derived.keystoreManager;
      assert.equal(km.getPrivateNullifyingKey(), expected.nullifying);
      assert.equal(km.getPrivateRevocableKey(), expected.revocable);
      assert.deepEqual(km.getViewingKeyPair(), expected.viewing);
      assert.equal(BigInt(km.getRevocableKeyIndex()), BigInt(rotation));
      results.push({ index, rotation, expected });
    }
  }
  assert.equal(results[0].expected.nullifying, results[1].expected.nullifying);
  assert.deepEqual(results[0].expected.viewing, results[1].expected.viewing);
  assert.notEqual(results[0].expected.revocable, results[1].expected.revocable);
  assert.notEqual(results[0].expected.nullifying, results[2].expected.nullifying);
  report.derivation = { passed: true, cases: results.length, independentSignature: 'ethers', independentKdf: 'node:crypto',
    canonicalPayloadMatched: true, accountsSeparated: true, rotationPreservesIdentity: true, productionIdentityFinalized: false };
  console.log('Canonical derivation and independent HKDF/X25519 checks passed.');

  const scope = createPrivacyScope({ profileId: 'ppv2-sdk-offline-fixture', signal: new AbortController().signal });
  const context = (role) => scope.getContext({ kind: 'private-account', principal: 'synthetic', protocol: 'ppv2-fixture',
    deployment: sdkRevision, role, chainId: 11155111 });
  try {
    const artifactDir = path.join(directory, 'artifacts'); fs.mkdirSync(artifactDir);
    const definitions = [
      ['wasm', 'deposit_js/deposit.wasm', 'deposit.wasm'],
      ['provingKey', 'groth16_pkey.zkey', 'deposit.zkey'],
      ['verificationKey', 'groth16_vkey.json', 'deposit.vkey.json'],
    ];
    const manifest = definitions.map(([kind, relative, name]) => {
      const source = path.join(upstream, 'packages/circuits/build/deposit', relative);
      const bytes = fs.readFileSync(source);
      const sha256 = sdk.DEFAULT_CIRCUIT_MANIFEST.deposit[`${kind}Sha256`];
      assert.equal(digest(bytes), sha256, `Pinned ${kind} must match SDK manifest (not an LFS pointer)`);
      fs.writeFileSync(path.join(artifactDir, name), bytes);
      return { name, size: bytes.length, sha256 };
    });
    const loader = createPrivacyArtifactLoader({ handle: context('artifacts'), directory: artifactDir, manifest });
    const artifacts = {};
    for (const [kind, , name] of definitions) artifacts[kind] = await loader.load(name);
    report.artifacts = manifest;
    const filename = path.join(__dirname, 'fixtures/ppv2-sdk-proof-worker.js');
    const args = { handle: context('prover'), filename, heapMb: 256, timeoutMs: 60000 };
    const workerData = { sdkEntry, artifacts, shared: new SharedArrayBuffer(8) };
    try {
      report.workerProof = await runPrivacyWorker({ ...args, workerData });
    } catch (error) {
      assert.equal(error.code, 'PRIVATE_WORKER_FAILED');
      report.workerProof = { verified: false, diagnostic: error.code };
    }
    // Exercise the same unmodified SDK/proof fixture in a separate process.
    // Only public artifacts and synthetic inputs enter it. Wait for exit before
    // accepting the result; no child process survives this probe.
    report.processProof = await new Promise((resolve, reject) => {
      const child = fork(filename, [sdkEntry, artifactDir], { env: {}, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let result, failure;
      child.stdout.resume(); child.stderr.resume();
      const timer = setTimeout(() => { failure = new Error('Proof process timeout'); child.kill('SIGKILL'); }, 60000);
      child.once('message', (message) => { result = message; child.kill('SIGTERM'); });
      child.once('error', (error) => { failure = error; });
      child.once('close', () => {
        clearTimeout(timer);
        if (failure || !result?.verified || !result?.tamperedRejected) reject(failure || new Error('Proof process failed'));
        else resolve(result);
      });
    });
    console.log('Separate-process deposit proof verified; changed public signals rejected.');
    if (!report.workerProof.verified) {
      report.cancellation = { tested: false, reason: 'SDK cannot prove inside the existing Node worker boundary' };
    } else {
      // Revoke the authoritative scope after the real prover starts. No result
      // may escape after revocation.
      const shared = new SharedArrayBuffer(8), state = new Int32Array(shared);
      const task = runPrivacyWorker({ ...args, workerData: { ...workerData, shared } });
      const refused = assert.rejects(task, { code: 'PRIVACY_CONTEXT_REVOKED' });
      const deadline = Date.now() + 30000;
      while (Atomics.load(state, 0) === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(Atomics.load(state, 0), 1, 'Real prover must have started');
      assert.equal(Atomics.load(state, 1), 0, 'Proof must still be in flight');
      scope.close();
      await refused;
      assert.equal(Atomics.load(state, 1), 0);
      report.cancellation = { realProverStarted: true, scopeRevocationRejectedResult: true };
    }
  } finally { scope.close(); }
  report.limits = [
    'No working full protocol session claimed; inspect adapterTypecheck and compatibilityPatchSha256 separately.',
    'Synthetic local deposit proof only; no transfer, unshield, chain recovery or audited deployment qualification.',
    'Network tripwires are diagnostic, not a sandbox, and do not cover nested workers.',
    'Separate-process proof success does not qualify an application process host or vault cancellation.',
    'RSS is process-wide at result time, not peak prover memory; JS heap limit excludes WASM/native allocations.',
    'No packaged Electron qualification or production keys.',
  ];
  writeReport();
  console.log(JSON.stringify({ directory, adapterTypecheckPassed: report.adapterTypecheck.passed,
    derivation: report.derivation, workerProof: report.workerProof, processProof: report.processProof,
    cancellation: report.cancellation }, null, 2));
}

main().catch((error) => {
  report.failed = true; writeReport();
  console.error(`PPv2 spike failed (${error.code || error.name}); inspect ${directory}`);
  process.exitCode = 1;
});
