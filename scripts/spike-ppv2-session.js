#!/usr/bin/env node
/** Offline integration of the real patched Kohaku factory and pinned PPv2 SDK.
 * Usage: node scripts/spike-ppv2-session.js /absolute/compat-fixtures /absolute/ppv2
 * Uses only the public test mnemonic, controlled RPC/ASP responses and temp state.
 * The transport is substituted; actual TLS/SOCKS routing has separate unit tests.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { createRequire, syncBuiltinESMExports } = require('module');
const { execFileSync } = require('child_process');
const { buildSync } = require('esbuild');
const [fixtures, upstream] = process.argv.slice(2);
assert.ok([fixtures, upstream].every((entry) => entry && path.isAbsolute(entry)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-ppv2-session-'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const previous = JSON.parse(fs.readFileSync(path.join(fixtures, 'report.json')));
assert.equal(previous.adapterTypecheck.passed, true);
assert.equal(previous.compatibilityPatchSha256, digest(fs.readFileSync(path.join(__dirname, 'fixtures/kohaku-ppv2-compat.patch'))));
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), previous.sdkRevision);
assert.equal(execFileSync('git', ['-C', upstream, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), '');
const sdkDirectory = path.join(upstream, 'packages/sdk');
const sdkEntry = path.join(sdkDirectory, 'dist/index.cjs');
assert.equal(digest(fs.readFileSync(sdkEntry)), previous.sdkEntrySha256);
const sdk = require(sdkEntry);
const sdkRequire = createRequire(path.join(sdkDirectory, 'package.json'));
const viem = sdkRequire('viem');
const { mnemonicToAccount } = sdkRequire('viem/accounts');
function bundle(entry, name) {
  const outfile = path.join(directory, name);
  buildSync({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node24',
    nodePaths: [path.join(sdkDirectory, 'node_modules')], external: [sdkEntry],
    alias: { '@0xbow-io/privacy-pools-v2-sdk': sdkEntry,
      '@kohaku-eth/plugins': path.join(fixtures, 'packages/plugins/src/index.ts') } });
  return require(outfile);
}
const { createPPv2Plugin } = bundle(path.join(fixtures, 'packages/privacy-pools/src/v2/plugin.ts'), 'plugin.cjs');
const abi = bundle(path.join(sdkDirectory, 'src/constant/ContractInteractor.ts'), 'abis.cjs');
const { KohakuRpcInteractor } = require(path.join(fixtures, 'rpc.cjs'));
const { deriveKeystoreManager } = require(path.join(fixtures, 'derivation.cjs'));
const { configuration } = require('../test/helpers/ppv2-session-fixture');
const config = configuration(); config.artifacts.manifest = sdk.DEFAULT_CIRCUIT_MANIFEST;
const abis = [ [...abi.POOL_VAULT_ABI, ...abi.POOL_VAULT_ALL_EVENTS_ABI], abi.ENTRYPOINT_ABI,
  [...abi.KEYSTORE_ABI, ...abi.KEYSTORE_EVENTS_ABI, ...abi.KEYSTORE_AUTH_EVENTS_ABI], abi.ASP_REGISTRY_ABI ];
for (const [index, grant] of config.contracts.entries()) {
  grant.selectors = abis[index].filter((item) => item.type === 'function').map(viem.toFunctionSelector);
  grant.eventTopics = [...new Set(abis[index].filter((item) => item.type === 'event').map(viem.toEventSelector))];
}
const mnemonic = 'test test test test test test test test test test test junk'; // Public fixture.
let vault = new AbortController();
const profile = { id: 'controlled-fixture', userDataDir: directory };
const endpoint = { signal: new AbortController().signal };
const rpcUrl = 'https://rpc.example.test/';
const records = [], identities = new Map();
let capturedHost, holdRpc = false, releaseRpc, registered = false, authLog;
function substitute(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
substitute('../src/main/identity/vault', { getSessionSignal: () => vault.signal, getMnemonic: () => mnemonic });
substitute('../src/main/profile-resolver', { getActiveProfile: () => profile });
substitute('../src/main/settings-store', { isWalletTorExperimentAvailable: () => true });
substitute('../src/main/tor-manager', { getWalletSocksEndpoint: () => endpoint });
substitute('../src/main/networks/network-registry', { getNetwork: () => ({ access: { readOrder: ['direct'] } }),
  getEndpointSources: () => [{ keyed: false, coverage: { 11155111: rpcUrl } }], getEndpoints: () => [rpcUrl] });
const { getPrivacyContext } = require('../src/main/networks/privacy-context');
substitute('../src/main/networks/wallet-tor-transport', { createWalletTorTransport: () => ({ close() {},
  async request(handle, url, options) {
    const context = getPrivacyContext(handle);
    const role = context.subject.role;
    identities.set(`${context.generation}:${role}`, context.isolationToken);
    const target = new URL(url);
    let response;
    if (url === rpcUrl) {
      assert.equal(role, 'protocol-rpc');
      const request = JSON.parse(options.body);
      records.push({ role, method: request.method, params: request.params });
      if (holdRpc && request.method === 'eth_call') await new Promise((resolve) => { releaseRpc = resolve; });
      let result;
      if (request.method === 'eth_chainId') result = '0xaa36a7';
      else if (request.method === 'eth_blockNumber') result = '0x2800';
      else if (request.method === 'eth_getLogs') {
        const filter = request.params[0];
        result = registered && filter.topics[0].includes(authLog.topics[0]) &&
          BigInt(filter.fromBlock) <= 101n && BigInt(filter.toBlock) >= 101n ? [authLog] : [];
      } else if (request.method === 'eth_call') result = viem.encodeAbiParameters([{ type: 'uint256' }], [registered ? 1n : 0n]);
      else if (request.method === 'eth_getBlockByNumber') result = { number: '0x2700', hash: `0x${'77'.repeat(32)}` };
      else assert.fail('Unexpected SDK RPC method');
      response = { jsonrpc: '2.0', id: request.id, result };
    } else if (target.pathname.startsWith('/asp/')) {
      assert.equal(role, 'asp'); records.push({ role, path: target.pathname });
      if (target.pathname.endsWith('/note-events')) response = { events: [], lastSyncedBlock: '0x2800' };
      else if (target.pathname.endsWith('/event-snapshot/payload')) response = { chainId: '11155111',
        snapshotBlockNumber: '10240', generatedAt: '2026-09-26T00:00:00Z', deposits: [], transacts: [], ragequits: [], leaves: [], keystoreLeaves: [] };
      else assert.fail('Unexpected SDK ASP route');
    } else {
      assert.equal(role, 'relayer'); assert.equal(target.pathname, '/relayer/quote');
      records.push({ role, path: target.pathname }); response = { controlled: true };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(response)) };
  },
}) });

// Tripwires diagnose accidental ambient Node egress in this offline probe.
// They are not an OS sandbox and do not cover arbitrary native bypasses.
let ambientAttempts = 0;
const refuse = () => { ambientAttempts += 1; throw new Error('Ambient network refused'); };
globalThis.fetch = refuse; globalThis.WebSocket = refuse;
for (const [module, methods] of [['http', ['request', 'get']], ['https', ['request', 'get']],
  ['net', ['connect', 'createConnection']], ['tls', ['connect']], ['dns', ['lookup', 'resolve']],
  ['http2', ['connect']], ['dgram', ['createSocket']]]) {
  for (const method of methods) require(module)[method] = refuse;
}
syncBuiltinESMExports();
const { PPV2_CANDIDATE, openPPv2Session } = require('../src/main/wallet/ppv2-session');
assert.equal(PPV2_CANDIDATE.sdk, previous.sdkRevision);
assert.equal(PPV2_CANDIDATE.kohaku, previous.kohakuRevision);
const candidate = { ...PPV2_CANDIDATE, async createPlugin(host, params) {
  capturedHost = host;
  return createPPv2Plugin(host, params);
} };

async function main() {
  // Failures must not be retried/bisected; successful windows cover the range.
  const windows = [];
  const rpc = new KohakuRpcInteractor({ request: async (request) => { windows.push(request.params[0]); return []; } });
  await rpc.getLogsPaginated({ address: config.deployment.poolAddress, events: [], fromBlock: 100n, toBlock: 10240n });
  assert.deepEqual(windows.map((window) => [BigInt(window.fromBlock), BigInt(window.toBlock)]), [[100n, 5099n], [5100n, 10099n], [10100n, 10240n]]);
  let attempts = 0;
  const failing = new KohakuRpcInteractor({ request: async () => { attempts += 1; throw new Error('refused'); } });
  await assert.rejects(failing.getLogsPaginated({ address: config.deployment.poolAddress, events: [], fromBlock: 100n, toBlock: 10240n }));
  assert.equal(attempts, 1);

  const session = await openPPv2Session({ candidate, configuration: config });
  assert.equal(await session.instanceId(), config.ownerAddress);
  assert.equal(await session.isRegistered(), false);
  const reference = mnemonicToAccount(mnemonic, { path: "m/28784'/2'/0'" }).getHdKey().privateKey;
  const key = await capturedHost.keystore.deriveAt("m/28784'/2'/0'");
  assert.equal(key, `0x${Buffer.from(reference).toString('hex')}`);
  reference.fill(0);
  const registration = await session.prepareRegisterKeystore();
  assert.equal(registration.__type, 'publicOperation'); assert.equal(registration.txs.length, 2);
  for (const tx of registration.txs) {
    assert.equal(tx.to.toLowerCase(), config.deployment.keystoreAddress);
    assert.equal(tx.value, 0n); assert.match(tx.data, /^0x[0-9a-f]+$/i);
  }
  assert.deepEqual(await session.balance(), []);
  assert.deepEqual(await session.notes(), []);
  assert.ok(records.some((record) => record.role === 'asp'));
  // Deliberately exercise dispatch separately; the read-only plugin does not quote.
  await capturedHost.network.fetch('https://service.example.test/relayer/quote', { method: 'POST', body: '{}' });
  assert.ok(new Set(identities.values()).size >= 3);
  assert.equal(new Set(identities.values()).size, identities.size);
  const warmup = records.filter((record) => record.method === 'eth_getLogs');
  assert.ok(warmup.some((record) => record.params[0].fromBlock === '0x64'));
  assert.ok(warmup.every((record) => BigInt(record.params[0].toBlock) - BigInt(record.params[0].fromBlock) < 5000n));
  const stateDirectory = path.join(directory, 'wallet-ppv2-experiment');
  const files = fs.readdirSync(stateDirectory); assert.equal(files.length, 1);
  const before = fs.readFileSync(path.join(stateDirectory, files[0]));
  assert.ok(!before.includes(key)); assert.ok(!before.includes(config.ownerAddress)); assert.ok(!before.includes('syncCursor'));
  const oldStorage = capturedHost.storage;
  session.close();
  await assert.rejects(oldStorage.get('ppv2:controlled:notes'), { code: 'PRIVACY_CONTEXT_REVOKED' });
  const restored = await openPPv2Session({ candidate, configuration: config });
  assert.deepEqual(await restored.prepareRegisterKeystore(), registration);
  const aspBefore = records.filter((record) => record.role === 'asp').length;
  assert.deepEqual(await restored.notes(), []);
  assert.equal(records.filter((record) => record.role === 'asp').length, aspBefore, 'Restored sync cursor avoids rescanning an unchanged head');

  holdRpc = true;
  const pending = restored.isRegistered();
  const rejected = assert.rejects(pending, { code: 'PRIVACY_CONTEXT_REVOKED' });
  while (!releaseRpc) await new Promise((resolve) => setImmediate(resolve));
  vault.abort(); await rejected; releaseRpc(); holdRpc = false;
  vault = new AbortController();
  const unlocked = await openPPv2Session({ candidate, configuration: config });
  assert.equal(await unlocked.isRegistered(), false); unlocked.close();

  const hashService = await sdk.PoseidonHashService.create();
  const computation = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
  const event = abi.KEYSTORE_AUTH_EVENTS_ABI.find((entry) => entry.name === 'AuthPolicySet');
  async function rotate(index) {
    const derived = await deriveKeystoreManager({ keystore: { deriveAt: async () => key }, revocableKeyIndex: `0x${index.toString(16)}` });
    const authDigest = computation.computeAuthDigest(derived.keystoreManager.getPrivateRevocableKey());
    authLog = { address: config.deployment.keystoreAddress,
      topics: viem.encodeEventTopics({ abi: [event], eventName: event.name, args: { _account: config.ownerAddress } }),
      data: viem.encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [1n, BigInt(authDigest)]),
      blockNumber: '0x65', blockHash: `0x${'55'.repeat(32)}`, transactionHash: `0x${'66'.repeat(32)}`, logIndex: '0x0', removed: false };
    registered = true;
  }
  // Owner is deliberately NOT the secret-derivation signer. An event for that
  // signer would mask the candidate SDK's owner/signer recovery mismatch.
  assert.notEqual(viem.getAddress(config.ownerAddress), mnemonicToAccount(mnemonic, { path: "m/28784'/2'/0'" }).address);
  const rotationKey = `ppv2:controlled:keystore:11155111:${config.ownerAddress}`;
  for (const index of [7, 8]) {
    await rotate(index);
    const recovered = await openPPv2Session({ candidate, configuration: config });
    assert.equal(await recovered.isRegistered(), true);
    const record = JSON.parse(await capturedHost.storage.get(rotationKey));
    assert.equal(BigInt(record.revocableKeyIndex), BigInt(index));
    recovered.close();
  }
  await rotate(30); // Outside both the persisted candidate and the 0..19 scan.
  await assert.rejects(openPPv2Session({ candidate, configuration: config }), { code: 'PRIVATE_PPV2_UNAVAILABLE' });
  await rotate(8);
  const recoveredAgain = await openPPv2Session({ candidate, configuration: config });
  await capturedHost.storage.set(rotationKey, JSON.stringify({ version: 2, revocableKeyIndex: '0x8' }));
  recoveredAgain.close();
  await assert.rejects(openPPv2Session({ candidate, configuration: config }), { code: 'PRIVATE_PPV2_UNAVAILABLE' });
  // Repair only this deliberately corrupted synthetic test record through a
  // fresh host factory callback; no recovery bypass exists on the session API.
  const repairCandidate = { ...candidate, async createPlugin(host, params) {
    await host.storage.set(rotationKey, JSON.stringify({ version: 1, revocableKeyIndex: '0x8' }));
    return candidate.createPlugin(host, params);
  } };
  const repaired = await openPPv2Session({ candidate: repairCandidate, configuration: config }); repaired.close();
  registered = false; // A previously persisted registration cannot reset to index zero.
  await assert.rejects(openPPv2Session({ candidate, configuration: config }), { code: 'PRIVATE_PPV2_UNAVAILABLE' });
  assert.equal(ambientAttempts, 0);
  const report = { candidate: PPV2_CANDIDATE, compatibilityPatchSha256: previous.compatibilityPatchSha256,
    pluginSha256: digest(fs.readFileSync(path.join(directory, 'plugin.cjs'))), node: process.version,
    realKohakuFactory: true, realSdk: true, syntheticMnemonic: true, independentDerivation: 'viem/scure BIP32',
    registrationCallsPrepared: registration.txs.length, rpcWindowsBounded: true, failureAttempts: attempts,
    roleIsolation: true, encryptedStateRestored: true, syncCursorRestored: true, vaultLockRejectsLateRead: true,
    reopenedAfterUnlock: true, recoveredOwnerRotationIndices: [7, 8], staleCachedRotationRechecked: true,
    unknownRotationRefused: true, malformedRotationRecordRefused: true,
    missingPersistedRegistrationRefused: true, ambientNetworkAttempts: ambientAttempts,
    liveNetwork: false, transactionSubmitted: false, shieldUnshieldTested: false, productionIdentityFinalized: false };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, ...report }, null, 2));
}
main().catch((error) => {
  vault.abort();
  console.error(`Controlled PPv2 session probe failed (${error.code || error.name}); scratch: ${directory}`);
  process.exitCode = 1;
});
