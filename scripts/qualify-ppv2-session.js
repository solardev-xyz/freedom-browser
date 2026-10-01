/** Source Electron, explicit disposable profile, read-only by default.
 * Usage: electron script.js /absolute/pinned.asar /absolute/persistent-profile /absolute/report
 * Requires FREEDOM_WALLET_TOR_EXPERIMENT=1. Default is strictly unfunded/read-only.
 * --check-step=<action> checks funding without enabling signing or submission.
 * Optional --step=<action> [reference] executes one explicitly bounded test step.
 */
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { randomBytes, createHash } = require('crypto');
const { app, safeStorage } = require('electron');
const RPC = 'https://sepolia.rpc.sentio.xyz';
async function main() {
  const [archive, profileDirectory, output, stepOption, reference] = process.argv.slice(2);
  const { ACTIONS, runSepoliaTestStep } = require('../src/main/wallet/ppv2-sepolia-test-step');
  const checkOnly = stepOption?.startsWith('--check-step=') === true;
  const action = checkOnly ? stepOption.slice(13) : stepOption?.startsWith('--step=') ? stepOption.slice(7) : null;
  assert.ok(!checkOnly || !['status', 'resolve-public', 'resolve-public-failed', 'resolve-relay'].includes(action));
  assert.ok(process.argv.length <= 7 && (stepOption === undefined || ACTIONS.includes(action)));
  assert.ok(reference === undefined || ['withdraw', 'ragequit', 'ragequit-cancel', 'resolve-public', 'resolve-public-failed', 'resolve-relay'].includes(action));
  assert.ok([archive, profileDirectory, output].every(v => typeof v === 'string' && path.isAbsolute(v)));
  assert.ok(!app.isPackaged && process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1');
  assert.ok(!process.env.FREEDOM_IDENTITY_DATA, 'Qualification owns its identity directory');
  fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  process.env.FREEDOM_TEST_USER_DATA = profileDirectory;
  const { initializeProfile } = require('../src/main/profile-resolver');
  const profile = initializeProfile(app, { env: { FREEDOM_TEST_USER_DATA: profileDirectory } });
  await app.whenReady();
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux') assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const { MARKER, directTestExposure } = require('../src/main/networks/direct-testnet-transport');
  const marker = path.join(profileDirectory, MARKER);
  const vault = require('../src/main/identity/vault');
  const directory = path.join(profileDirectory, 'identity'), credential = path.join(profileDirectory, 'qualification-password.bin');
  if (!fs.existsSync(marker)) {
    // Provisioning an existing wallet as disposable is intentionally refused.
    assert.ok(!vault.vaultExists(directory) && !fs.existsSync(credential));
    fs.writeFileSync(marker, JSON.stringify({ version: 1, chainId: 11155111, profileId: profile.id,
      disposable: true, relayerExposure: 'direct-ip' }), { flag: 'wx', mode: 0o600 });
  }
  assert.ok(directTestExposure());
  let password;
  if (vault.vaultExists(directory)) {
    password = safeStorage.decryptString(fs.readFileSync(credential));
  } else {
    assert.ok(!fs.existsSync(credential)); password = randomBytes(32).toString('base64');
    fs.writeFileSync(credential, safeStorage.encryptString(password), { flag: 'wx', mode: 0o600 });
    await vault.createVault(directory, password);
  }
  await vault.unlockVault(directory, password, 0);
  // eslint-disable-next-line no-useless-assignment -- Drop the local credential reference after unlocking.
  password = undefined;
  const owner = require('../src/main/identity/derivation').deriveUserWallet(vault.getMnemonic()).address.toLowerCase();
  const loader = require('../src/main/wallet/ppv2-runtime');
  const verified = loader.verifyPPv2Runtime(archive), storedArchive = path.join(profileDirectory, 'ppv2.asar');
  if (!fs.existsSync(storedArchive)) require('original-fs').copyFileSync(verified, storedArchive, fs.constants.COPYFILE_EXCL);
  const runtime = loader.loadPPv2Runtime(storedArchive);
  const { ARTIFACTS } = require('../src/main/wallet/ppv2-deposit-policy');
  const allArtifacts = [...ARTIFACTS, ...require('../src/main/wallet/ppv2-ragequit-policy').ARTIFACTS, ...require('../src/main/wallet/ppv2-transact-policy').ARTIFACTS];
  const artifactDirectory = path.join(profileDirectory, 'proof-artifacts'); fs.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  for (const entry of allArtifacts) if (!fs.existsSync(path.join(artifactDirectory, entry.name))) {
    fs.writeFileSync(path.join(artifactDirectory, entry.name), fs.readFileSync(path.join(runtime.archive, 'artifacts', entry.name)), { flag: 'wx', mode: 0o600 });
  }
  const registry = require('../src/main/networks/network-registry');
  assert.ok(registry.addCustomChain({ chainId: 11155111, name: 'Sepolia disposable PPv2 test', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 } }, [RPC]).success);
  registry.updateNetwork(11155111, { access: { readOrder: ['direct'], allowDirect: true }, quorum: { timeoutMs: 45000 } });
  const tor = require('../src/main/tor-manager');
  const report = { harnessSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    controllerSha256: createHash('sha256').update(fs.readFileSync(require.resolve('../src/main/wallet/ppv2-sepolia-test-step'))).digest('hex'), observedAt: new Date().toISOString(), owner, chainId: 11155111, rpc: RPC, signingEnabled: false,
    broadcastEnabled: false, chainStateVerified: false, protocolLifecycleQualified: false, transportPrivacyQualified: false };
  let session, scope, stage = 'tor-start';
  try {
    await tor.startTor(); const started = Date.now();
    while (!tor.getWalletSocksEndpoint()) { assert.ok(Date.now() - started < 180000); await new Promise(r => setTimeout(r, 200)); }
    console.log('Managed Tor ready');
    const { openPrivacySession } = require('../src/main/wallet/privacy-session'); scope = openPrivacySession();
    const handle = role => scope.getContext({ kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
    await require('../src/main/wallet/ppv2-relay-journal').getPPv2RelayJournal(handle('storage'), 0).recordDirectExposure();
    const { createPrivateRpc } = require('../src/main/networks/private-rpc');
    const rpc = createPrivateRpc(handle('protocol-rpc'), 'protocol-rpc');
    report.protocolRpcHosts = rpc.trust.queried;
    const config = require('../src/main/wallet/ppv2-sepolia-configuration').sepoliaConfiguration(runtime, owner);
    const { createKohakuNetworkRouter } = require('../src/main/networks/kohaku-network-router');
    const network = createKohakuNetworkRouter(config.networks.map(g => ({ handle: handle(g.role), endpoints: g.endpoints.filter(e => !e.url.includes('/v1/relay/')),
      route: g.role === 'relayer' ? 'direct-sepolia-test' : 'tor' })));
    stage = 'deployment-preflight'; console.log(stage);
    const { inspectSepoliaDeployment, CANDIDATE } = require('../src/main/wallet/ppv2-sepolia-preflight');
    const inspect = () => inspectSepoliaDeployment({ signal: scope.signal, onStep: name => console.log('Preflight ' + name),
      rpc: async (method, params) => (await rpc.request(method, params, () => true)).result,
      getJson: async (role, p) => { const r = await network.fetch(CANDIDATE[role] + p); assert.ok(r.ok); return r.json(); },
      postJson: async (role, p, body) => { const r = await network.fetch(CANDIDATE[role] + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); },
    });
    report.deployment = await inspect();
    assert.ok(report.deployment.observationsConsistent);
    stage = 'session-open'; console.log(stage);
    const open = () => require('../src/main/wallet/ppv2-session').openPPv2Session({ candidate: runtime.candidate, configuration: config,
      relayerRoute: 'direct-sepolia-test', proving: { sdkEntry: runtime.sdkEntry, ragequitProverEntry: runtime.proverEntry, transactProverEntry: runtime.proverEntry, directory: artifactDirectory } });
    session = await open(); report.descriptor = session.descriptor;
    if (action) {
      const funding = JSON.parse(fs.readFileSync(path.join(profileDirectory, 'funding.json'), 'utf8'));
      assert.equal(funding.address, owner); assert.equal(funding.chainId, 11155111);
      assert.equal(funding.profileBinding, createHash('sha256').update(JSON.stringify([profile.id, profileDirectory])).digest('hex'));
      const ownerHandle = scope.getContext({ kind: 'public-address', principal: owner, chainId: 11155111, role: 'transaction-rpc' });
      const ownerRpc = createPrivateRpc(ownerHandle, 'transaction-rpc');
      const { Wallet } = require('ethers');
      const wallet = new Wallet(require('../src/main/identity/derivation').deriveUserWallet(vault.getMnemonic()).privateKey);
      const signer = { getAddress: () => wallet.getAddress(), signTransaction: transaction => {
        const gasLimit = BigInt(transaction.gasLimit), gasPrice = BigInt(transaction.gasPrice ?? transaction.maxFeePerGas);
        report.reviewedSigningRequest = { gasLimit: gasLimit.toString(), gasPriceWei: gasPrice.toString(), maxGasCostWei: (gasLimit * gasPrice).toString() };
        return wallet.signTransaction(transaction);
      } };
      stage = 'explicit-' + action; console.log(stage);
      report.explicitAction = action; report.checkOnly = checkOnly;
      report.signingEnabled = report.broadcastEnabled = !checkOnly && !['status', 'resolve-public', 'resolve-public-failed', 'resolve-relay'].includes(action);
      report.step = await runSepoliaTestStep({ handle: handle('relayer'), session, signer, owner, action, reference, checkOnly,
        readBalance: async () => BigInt((await ownerRpc.request('eth_getBalance', [owner, 'latest'], v => /^0x[0-9a-f]+$/i.test(v))).result),
        estimateGas: async tx => {
          const estimate = BigInt((await ownerRpc.request('eth_estimateGas', [{ from: owner, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }], v => /^0x[0-9a-f]+$/i.test(v))).result);
          report.gasEstimate = { operation: tx.kind, gas: estimate.toString() }; return estimate;
        },
        verifyDeployment: async () => (await inspect()).observationsConsistent === true });
      if (action === 'status') {
        // Public funding/gas evidence only; never serialize raw transactions or calldata.
        const quantity = value => typeof value === 'string' && /^0x[0-9a-f]{1,64}$/i.test(value);
        report.balanceWei = (await ownerRpc.request('eth_getBalance', [owner, 'latest'], quantity)).result;
        report.registration = await session.registrationStatus();
        assert.ok(report.step.publicSubmissions.length <= 6);
        report.publicReceipts = [];
        for (const record of report.step.publicSubmissions) {
          const receipt = (await ownerRpc.request('eth_getTransactionReceipt', [record.hash], value => value === null ||
            (value?.transactionHash?.toLowerCase() === record.hash && quantity(value.gasUsed) && quantity(value.effectiveGasPrice) &&
             ['0x0', '0x1'].includes(value.status) && quantity(value.blockNumber)))).result;
          report.publicReceipts.push(receipt === null ? { hash: record.hash, pending: true } : {
            hash: record.hash, status: receipt.status, blockNumber: receipt.blockNumber,
            gasUsed: BigInt(receipt.gasUsed).toString(), gasPriceWei: BigInt(receipt.effectiveGasPrice).toString(),
            gasCostWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
          });
        }
      }
      if (report.step?.needsFunding) report.signingEnabled = report.broadcastEnabled = false;
      report.passed = true;
      console.log(JSON.stringify({ action, needsFunding: report.step?.needsFunding === true }));
      return 0;
    }
    stage = 'registration'; console.log(stage); report.registration = await session.registrationStatus();
    stage = 'prepare-registration'; console.log(stage);
    const prepared = await session.prepareRegisterKeystore();
    const ownerHandle = scope.getContext({ kind: 'public-address', principal: owner, chainId: 11155111, role: 'transaction-rpc' });
    const ownerRpc = createPrivateRpc(ownerHandle, 'transaction-rpc');
    report.ownerRpcHosts = ownerRpc.trust.queried;
    report.simulations = [];
    for (const tx of prepared.txs) {
      stage = 'simulate-' + tx.kind; console.log(stage);
      assert.equal(tx.value, 0n);
      const call = { from: owner, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` };
      const result = await ownerRpc.request('eth_call', [call, 'latest'], v => v === '0x');
      report.simulations.push({ kind: tx.kind, returnedEmpty: result.result === '0x' });
    }
    stage = 'notes-and-balance'; console.log(stage);
    report.noteCount = (await session.notes()).length;
    stage = 'balance'; console.log(stage);
    report.assetCount = (await session.balance()).length;
    report.balanceWei = (await ownerRpc.request('eth_getBalance', [owner, 'latest'], v => /^0x[0-9a-f]+$/i.test(v))).result;
    stage = 'reopen'; console.log(stage);
    session.close(); session = await open();
    report.restartWithinProcess = { sameRegistration: JSON.stringify(await session.registrationStatus()) === JSON.stringify(report.registration),
      sameNoteCount: (await session.notes()).length === report.noteCount };
    report.passed = report.simulations.length === 2 && report.simulations.every(s => s.returnedEmpty) && report.noteCount === 0 &&
      report.restartWithinProcess.sameRegistration && report.restartWithinProcess.sameNoteCount;
    report.profileBinding = createHash('sha256').update(JSON.stringify([profile.id, profileDirectory])).digest('hex');
    if (report.passed) {
      const fundingPath = path.join(profileDirectory, 'funding.json');
      const funding = { chainId: 11155111, address: owner, requestedEther: '0.05', harnessOnly: true,
        runtimeSha256: require('../src/main/wallet/ppv2-runtime-manifest').sha256, profileBinding: report.profileBinding };
      if (fs.existsSync(fundingPath)) assert.deepEqual(JSON.parse(fs.readFileSync(fundingPath, 'utf8')), funding);
      else fs.writeFileSync(fundingPath, JSON.stringify(funding, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      report.funding = funding;
    }
    console.log(JSON.stringify({ passed: report.passed, owner, balanceWei: report.balanceWei }));
  } catch (error) { report.failure = { stage, code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : error.name };
    // eslint-disable-next-line preserve-caught-error -- Keep remote SDK/RPC payloads out of diagnostics.
    throw new Error('Qualification step refused', { cause: report.failure }); }
  finally {
    session?.close(); scope?.close(); vault.lockVault(); tor.stopTor();
    fs.writeFileSync(path.join(output, 'session.json'), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n', { mode: 0o600 });
  }
  return report.passed ? 0 : 1;
}
main().then(code => app.exit(code), error => { console.error('Qualification session stopped', error.cause || error.code || error.name); app.exit(1); });
