const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

test('real Kohaku session prepares a verified native deposit through the utility process', async ({ electronApp }, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to a fixture built with the patched Kohaku candidate');
  test.setTimeout(120000);
  const report = await electronApp.evaluate(async ({ app }, artifact) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'), path = req('path');
    const { Interface } = req('ethers');
    const vault = req('./src/main/identity/vault');
    const settings = req('./src/main/settings-store');
    const tor = req('./src/main/tor-manager');
    const rpc = req('./src/main/networks/private-rpc');
    const { getPrivacyContext } = req('./src/main/networks/privacy-context');
    const { ARTIFACTS, NATIVE, DEPOSIT_ABI } = req('./src/main/wallet/ppv2-deposit-policy');
    const original = { gate: settings.isWalletTorExperimentAvailable, tor: tor.getWalletSocksEndpoint, rpc: rpc.createPrivateRpc };
    const endpoint = { signal: new AbortController().signal };
    const config = req(`${artifact}/configuration.cjs`).configuration();
    const sdk = req(`${artifact}/sdk.cjs`), abis = req(`${artifact}/abis.cjs`);
    const readAbis = [[...abis.POOL_VAULT_ABI, ...abis.POOL_VAULT_ALL_EVENTS_ABI], abis.ENTRYPOINT_ABI,
      [...abis.KEYSTORE_ABI, ...abis.KEYSTORE_EVENTS_ABI, ...abis.KEYSTORE_AUTH_EVENTS_ABI], abis.ASP_REGISTRY_ABI];
    config.contracts.forEach((grant, index) => {
      const iface = new Interface(readAbis[index]);
      grant.selectors = iface.fragments.filter((fragment) => fragment.type === 'function').map((fragment) => fragment.selector);
      grant.eventTopics = [...new Set(iface.fragments.filter((fragment) => fragment.type === 'event').map((fragment) => fragment.topicHash))];
    });
    config.artifacts.manifest = sdk.DEFAULT_CIRCUIT_MANIFEST;
    const entrypoint = new Interface(abis.ENTRYPOINT_ABI);
    const registrationABI = new Interface(['function nullifyingKeys(address) view returns(uint256)', 'function viewingKeys(address) view returns(bytes32)']);
    let registrationKeys, registered = false;
    let feeBps = 100n;
    const methods = new Set();
    // Test-local controlled chain, through the real restricted Kohaku provider.
    // The packaged production gate remains false outside this evaluated harness.
    const productionGate = settings.isWalletTorExperimentAvailable();
    settings.isWalletTorExperimentAvailable = () => true;
    tor.getWalletSocksEndpoint = () => endpoint;
    rpc.createPrivateRpc = (handle) => ({ signal: getPrivacyContext(handle).signal, assertActive: () => getPrivacyContext(handle), ready: async () => {},
      trust: { level: 'unverified' }, privacy: { mode: 'controlled-fixture' },
      async request(method, params, validate) {
        getPrivacyContext(handle); methods.add(method);
        let result;
        if (method === 'eth_blockNumber') result = '0x100';
        else if (method === 'eth_getLogs') {
          result = [];
          // Registered state must include auth history: the real candidate
          // re-discovers the owner's revocable-key index on every reopen.
          const authInterface = new Interface(abis.KEYSTORE_AUTH_EVENTS_ABI);
          const event = authInterface.getEvent('AuthPolicySet'), filter = params[0];
          const registrationBlock = BigInt(config.deploymentBlock + 1);
          if (registered && filter.address === config.deployment.keystoreAddress && filter.topics[0].includes(event.topicHash) &&
              BigInt(filter.fromBlock) <= registrationBlock && BigInt(filter.toBlock) >= registrationBlock) {
            result.push({ address: config.deployment.keystoreAddress,
              ...authInterface.encodeEventLog(event, [config.ownerAddress, BigInt(registrationKeys.nullifyingKeyHash), BigInt(registrationKeys.authDigest)]),
              blockNumber: `0x${registrationBlock.toString(16)}`, blockHash: `0x${'ca'.repeat(32)}`, transactionHash: `0x${'cb'.repeat(32)}`,
              logIndex: '0x0', transactionIndex: '0x0', removed: false });
          }
        }
        else if (method === 'eth_call') {
          if (params[0].to === config.deployment.entrypointAddress && params[0].data.startsWith(entrypoint.getFunction('assets').selector)) {
            result = entrypoint.encodeFunctionResult('assets', [[true, 1n, feeBps, 0n]]);
          } else if (registered && params[0].to === config.deployment.keystoreAddress &&
              ['nullifyingKeys', 'viewingKeys'].some((name) => params[0].data.startsWith(registrationABI.getFunction(name).selector))) {
            const name = registrationABI.parseTransaction({ data: params[0].data }).name;
            result = name === 'nullifyingKeys' ? registrationKeys.nullifyingKeyHash : registrationKeys.viewingKey;
          } else result = `0x${'00'.repeat(32)}`;
        } else throw new Error('Unexpected RPC request');
        if (!validate(result)) throw new Error('Invalid controlled response');
        return { result };
      },
    });
    const directory = path.join(app.getPath('userData'), 'ppv2-deposit-vault');
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-deposit-artifacts-'));
    for (const entry of ARTIFACTS) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
    const livePids = () => app.getAppMetrics().filter((entry) => entry.name === 'Freedom private computation').map((entry) => entry.pid)
      .filter((pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } });
    let session;
    try {
      await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
      await vault.unlockVault(directory, 'fixture-password', 0);
      const { PPV2_CANDIDATE, openPPv2Session } = req('./src/main/wallet/ppv2-session');
      const source = JSON.parse(fs.readFileSync(`${artifact}/candidate.json`, 'utf8'));
      if (source.sdk !== PPV2_CANDIDATE.sdk || source.kohaku !== PPV2_CANDIDATE.kohaku) throw new Error('Candidate mismatch');
      const candidate = { ...PPV2_CANDIDATE, createPlugin: req(`${artifact}/plugin.cjs`).createPPv2Plugin,
        inspectRegistration: async (...args) => (registrationKeys = await req(`${artifact}/plugin.cjs`).inspectRegistration(...args)),
        inspectChange: req(`${artifact}/plugin.cjs`).inspectChange };
      let cancelOnProof = false, progressCount = 0;
      const proving = { sdkEntry: `${artifact}/sdk.cjs`, directory: artifactDir,
        onProgress: () => { progressCount += 1; if (cancelOnProof) vault.lockVault(); } };
      const open = () => openPPv2Session({ candidate, configuration: config, proving });
      session = await open();
      const registration = await session.prepareRegisterKeystore();
      registered = true; // Controlled chain now exposes this account's exact public keys.
      const start = performance.now();
      const deposit = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n });
      const elapsedMs = Math.round(performance.now() - start);
      const decoded = new Interface([DEPOSIT_ABI]).decodeFunctionData('deposit', deposit.data);
      const depositSummary = { chainId: deposit.chainId, from: deposit.from === config.ownerAddress,
        to: deposit.to === config.deployment.entrypointAddress, value: deposit.value.toString(), fee: deposit.fee.toString(),
        proofVerified: deposit.proofVerified, chainStateVerified: deposit.chainStateVerified,
        nativeToken: decoded._proof.pubSignals[1] === BigInt(NATIVE), amount: decoded._proof.pubSignals[2].toString(),
        noteBytes: (decoded._noteData.data.length - 2) / 2, aspBytes: (decoded._aspCiphertext.length - 2) / 2 };
      const afterProof = livePids();
      feeBps = 200n;
      const excessiveFee = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n }).then(() => null, (error) => error.code);
      feeBps = 100n;
      // Close and reopen the encrypted account before cancellation qualification.
      session.close(); session = await open(); cancelOnProof = true;
      const cancelled = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n }).then(() => null, (error) => error.code);
      // The session rejects promptly on lock; process termination has its own
      // exit boundary and must finish before this test considers cleanup passed.
      const deadline = Date.now() + 3000;
      while (livePids().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const afterCancel = livePids();
      cancelOnProof = false;
      await vault.unlockVault(directory, 'fixture-password', 0);
      session = await open();
      const recovered = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n });
      session.close();
      // Artifact mismatch refuses before any proof process starts; no download.
      fs.writeFileSync(path.join(artifactDir, ARTIFACTS[0].name), Buffer.alloc(ARTIFACTS[0].size));
      session = await open();
      const countBeforeBadArtifact = progressCount;
      const badArtifact = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n }).then(() => null, (error) => error.code);
      return { deposit: depositSummary, elapsedMs, registrationCalls: registration.txs.length,
        excessiveFee, cancelled, afterProof, afterCancel, recovered: recovered.proofVerified,
        badArtifact, badArtifactStartedProver: progressCount !== countBeforeBadArtifact,
        methods: [...methods].sort(), productionGate, packaged: app.isPackaged,
        jobFromAsar: req.resolve('./src/main/wallet/ppv2-deposit-job').includes('app.asar/'),
        sdkFromAsar: artifact.includes('.asar'), transactionSubmitted: false };
    } finally {
      session?.close(); vault.lockVault();
      settings.isWalletTorExperimentAvailable = original.gate;
      tor.getWalletSocksEndpoint = original.tor; rpc.createPrivateRpc = original.rpc;
    }
  }, artifact);
  await testInfo.attach('ppv2-deposit-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.deposit).toMatchObject({ chainId: 11155111, from: true, to: true, value: '10100', fee: '100',
    proofVerified: true, chainStateVerified: false, nativeToken: true, amount: '10000' });
  expect(report.deposit.noteBytes).toBeGreaterThan(32); expect(report.deposit.aspBytes).toBeGreaterThan(32);
  expect(report.registrationCalls).toBe(2);
  expect(report.excessiveFee).toBe('PRIVATE_PPV2_OPERATION_FAILED');
  expect(report.cancelled).toBe('PRIVACY_CONTEXT_REVOKED');
  expect(report.afterProof).toEqual([]); expect(report.afterCancel).toEqual([]);
  expect(report.recovered).toBe(true);
  expect(report.badArtifact).toBe('PRIVATE_PPV2_OPERATION_FAILED'); expect(report.badArtifactStartedProver).toBe(false);
  expect(report.methods).toEqual(['eth_blockNumber', 'eth_call', 'eth_getLogs']);
  expect(report.productionGate).toBe(false);
  if (report.packaged) expect(report.jobFromAsar).toBe(true);
});
