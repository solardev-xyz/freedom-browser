const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

test('PPv2 reviewed registration, uncertain deposit and encrypted note recovery', async ({ electronApp, relaunchApp }, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the qualified Kohaku/SDK fixture');
  test.setTimeout(120000);
  const exercise = async ({ app }, { artifact, restart, exit }) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const fs = req('fs'), path = req('path');
    const { Interface, Wallet, Transaction } = req('ethers');
    const vault = req('./src/main/identity/vault'), settings = req('./src/main/settings-store');
    const rpc = req('./src/main/networks/private-rpc'), tor = req('./src/main/tor-manager');
    const { getPrivacyContext } = req('./src/main/networks/privacy-context');
    const { ARTIFACTS, DEPOSIT_ABI } = req('./src/main/wallet/ppv2-deposit-policy');
    const { ARTIFACTS: EXIT_ARTIFACTS, RAGEQUIT_ABI } = req('./src/main/wallet/ppv2-ragequit-policy');
    const { REGISTRATION_ABI } = req('./src/main/wallet/ppv2-public-operations');
    const original = { gate: settings.isWalletTorExperimentAvailable, rpc: rpc.createPrivateRpc, tor: tor.getWalletSocksEndpoint };
    const productionGate = original.gate();
    const endpoint = { signal: new AbortController().signal };
    settings.isWalletTorExperimentAvailable = () => true; tor.getWalletSocksEndpoint = () => endpoint;
    const config = req(`${artifact}/configuration.cjs`).configuration();
    const sdk = req(`${artifact}/sdk.cjs`), abis = req(`${artifact}/abis.cjs`);
    const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk');
    config.ownerAddress = wallet.address.toLowerCase(); config.artifacts.manifest = sdk.DEFAULT_CIRCUIT_MANIFEST;
    const readAbis = [[...abis.POOL_VAULT_ABI, ...abis.POOL_VAULT_ALL_EVENTS_ABI, ...abis.POOL_VAULT_NOTE_EVENT_ABI, ...abis.POOL_VAULT_DEPOSITED_EVENT_ABI], abis.ENTRYPOINT_ABI,
      [...abis.KEYSTORE_ABI, ...abis.KEYSTORE_EVENTS_ABI, ...abis.KEYSTORE_AUTH_EVENTS_ABI], abis.ASP_REGISTRY_ABI];
    const interfaces = readAbis.map((abi) => new Interface(abi));
    config.contracts.forEach((grant, index) => {
      grant.selectors = interfaces[index].fragments.filter((f) => f.type === 'function').map((f) => f.selector);
      grant.eventTopics = [...new Set(interfaces[index].fragments.filter((f) => f.type === 'event').map((f) => f.topicHash))];
    });
    const register = new Interface(REGISTRATION_ABI), depositABI = new Interface([DEPOSIT_ABI]), exitABI = new Interface([RAGEQUIT_ABI]);
    const hashService = await sdk.PoseidonHashService.create();
    const receipts = new Map(), logs = [], sends = [], methods = new Set(), contexts = new Map();
    let head = 256, nonce = 0, auth = 0n, viewing = `0x${'00'.repeat(32)}`, lost = false, timestampAvailable = true;
    const statePath = path.join(app.getPath('userData'), 'ppv2-public-chain-fixture.json');
    const saved = restart ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    if (saved) {
      head = saved.head; nonce = saved.nonce; auth = BigInt(saved.auth); viewing = saved.viewing;
      logs.push(...saved.logs); for (const [hash, receipt] of saved.receipts) receipts.set(hash, receipt);
    }
    const blockHash = `0x${'ca'.repeat(32)}`;
    const quantity = (v) => `0x${v.toString(16)}`;
    rpc.createPrivateRpc = (handle) => {
      const context = getPrivacyContext(handle); contexts.set(context.subject.role, context);
      return { signal: context.signal, assertActive: () => getPrivacyContext(handle), ready: async () => {},
        trust: { level: 'unverified' }, privacy: { mode: 'controlled-fixture' },
        async request(method, params, validate) {
          getPrivacyContext(handle); methods.add(method);
          let result;
          if (method === 'eth_call' && context.subject.role === 'transaction-rpc' && params[0].from) result = '0x';
          else if (method === 'eth_blockNumber') result = quantity(head);
          else if (method === 'eth_getBlockByNumber') result = { number: params[0] === 'finalized' ? quantity(head - 2) : params[0], hash: blockHash };
          else if (method === 'eth_getLogs') {
            const filter = params[0]; const topics = filter.topics[0];
            result = logs.filter((log) => log.address === filter.address && topics.includes(log.topics[0]) &&
              BigInt(log.blockNumber) >= BigInt(filter.fromBlock) && BigInt(log.blockNumber) <= BigInt(filter.toBlock));
          } else if (method === 'eth_call') {
            const index = config.contracts.findIndex((grant) => grant.address === params[0].to);
            const iface = interfaces[index], call = iface.parseTransaction({ data: params[0].data });
            if (call.name === 'assets') result = iface.encodeFunctionResult(call.fragment, [[true, 1n, 100n, 0n]]);
            else if (call.name === 'commitments') {
              if (!timestampAvailable) throw new Error('Controlled timestamp unavailable');
              result = iface.encodeFunctionResult(call.fragment, [1700000000n]);
            } else if (call.name === 'nullifyingKeys') result = iface.encodeFunctionResult(call.fragment, [auth]);
            else if (call.name === 'viewingKeys') result = iface.encodeFunctionResult(call.fragment, [viewing]);
            else result = `0x${'00'.repeat(32)}`;
          } else if (method === 'eth_gasPrice') result = '0x64';
          else if (method === 'eth_getTransactionCount') result = quantity(nonce);
          else if (method === 'eth_getTransactionReceipt') result = receipts.get(params[0]) || null;
          else if (method === 'eth_getTransactionByHash') result = null;
          else if (method === 'eth_sendRawTransaction') {
            const tx = Transaction.from(params[0]); nonce++; head++;
            sends.push(tx); result = tx.hash;
            receipts.set(tx.hash, { transactionHash: tx.hash, from: tx.from, blockHash, blockNumber: quantity(head), status: '0x1' });
            if (tx.to.toLowerCase() === config.deployment.keystoreAddress) {
              const call = register.parseTransaction({ data: tx.data });
              if (call.name === 'setAuthPolicy') {
                auth = call.args[1];
                const event = interfaces[2].encodeEventLog(interfaces[2].getEvent('AuthPolicySet'), [wallet.address, call.args[1], call.args[0]]);
                logs.push({ address: config.deployment.keystoreAddress, ...event, blockNumber: quantity(head), blockHash,
                  transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false });
                const leaf = hashService.hash([config.ownerAddress, `0x${call.args[1].toString(16)}`, `0x${call.args[0].toString(16)}`]);
                const inserted = interfaces[2].encodeEventLog(interfaces[2].getEvent('LeafInserted'), [BigInt(leaf), BigInt(leaf), 0n]);
                logs.push({ address: config.deployment.keystoreAddress, ...inserted, blockNumber: quantity(head), blockHash,
                  transactionHash: tx.hash, logIndex: '0x1', transactionIndex: '0x0', removed: false });
              } else viewing = call.args[0];
            } else if (tx.to.toLowerCase() === config.deployment.entrypointAddress) {
              const decoded = depositABI.decodeFunctionData('deposit', tx.data);
              const event = interfaces[0].encodeEventLog(interfaces[0].getEvent('Note'), [decoded._noteData.hint, decoded._noteData.data]);
              logs.push({ address: config.deployment.poolAddress, ...event, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false });
            } else if (tx.to.toLowerCase() === config.deployment.poolAddress) {
              const signals = exitABI.decodeFunctionData('ragequit', tx.data)._proof.pubSignals;
              const event = interfaces[0].encodeEventLog(interfaces[0].getEvent('Ragequit'),
                [wallet.address, `0x${signals[5].toString(16).padStart(40, '0')}`, signals[4], signals[1], signals[0], signals[6]]);
              logs.push({ address: config.deployment.poolAddress, ...event, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false });
            } else throw new Error('Unexpected fixture transaction');
            if (lost) throw new Error('Controlled lost broadcast response');
          } else throw new Error('Unexpected RPC request');
          if (!validate(result)) throw new Error('Invalid controlled response');
          return { result };
        } };
    };
    const directory = path.join(app.getPath('userData'), 'ppv2-lifecycle-vault');
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-lifecycle-artifacts-'));
    for (const entry of [...ARTIFACTS, ...EXIT_ARTIFACTS]) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
    let session, stage = 'open';
    try {
      if (!restart) await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
      await vault.unlockVault(directory, 'fixture-password', 0);
      const { PPV2_CANDIDATE, openPPv2Session } = req('./src/main/wallet/ppv2-session');
      const candidate = { ...PPV2_CANDIDATE, createPlugin: req(`${artifact}/plugin.cjs`).createPPv2Plugin,
        inspectRegistration: req(`${artifact}/plugin.cjs`).inspectRegistration, inspectChange: req(`${artifact}/plugin.cjs`).inspectChange };
      const open = () => openPPv2Session({ candidate, configuration: config,
        proving: { sdkEntry: `${artifact}/sdk.cjs`, ragequitProverEntry: `${artifact}/serial-prover.cjs`, directory: artifactDir } });
      const reviews = [];
      const options = { signer: { getAddress: async () => wallet.address, signTransaction: (tx) => wallet.signTransaction(tx) },
        gasLimit: 1000000n, maxGasFee: 100000000n, review: async (request) => {
          reviews.push({ operation: request.operation, proofVerified: request.proofVerified, chainStateVerified: request.chainStateVerified }); return true;
        } };
      const resolve = (hash) => session.resolvePublicSubmission(hash, { minimumConfirmations: 1,
        review: async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }) });
      session = await open();
      if (restart) {
        const notes = await session.notes();
        const journal = await session.listPublicSubmissions();
        const rescan = await session.inspectNoteRecovery();
        const blocked = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n })
          .then((prepared) => session.submitPublicOperation(prepared, options)).then(() => null, (e) => e.code);
        if (exit) {
          stage = 'native ragequit';
          await resolve(saved.depositHash);
          const preparedExit = await session.prepareNativeRagequit(saved.commitment);
          const result = await session.submitPublicOperation(preparedExit, options);
          head += 3;
          const afterExit = await session.notes();
          return { kind: preparedExit.kind, amount: preparedExit.amount.toString(), value: preparedExit.value.toString(),
            proofVerified: preparedExit.proofVerified, chainStateVerified: preparedExit.chainStateVerified,
            commitmentBound: preparedExit.commitment === saved.commitment, ownerBound: preparedExit.from === config.ownerAddress,
            poolBound: preparedExit.to === config.deployment.poolAddress, sent: sends.length, journalKind: (await session.listPublicSubmissions())[3].intent.kind,
            observedStatus: afterExit[0]?.status, reviewed: reviews[0]?.operation, recordedHash: (await session.listPublicSubmissions())[3].hash === result.hash };
        }
        return { recovered: notes.length === 1 && notes[0].commitment === saved.commitment,
          rescanRecovered: rescan.notes.length === 1 && rescan.notes[0].commitment === saved.commitment,
          journalRestored: journal.length === 3 && journal[2].hash === saved.depositHash && journal[2].state === 'attempted',
          blocked, sends: sends.length, productionGate, packaged: app.isPackaged };
      }
      stage = 'registration';
      const registration = await session.prepareRegisterKeystore();
      const first = await session.submitPublicOperation(registration, options);
      const blockedSecond = await session.submitPublicOperation(registration, { ...options, step: 1 }).then(() => null, (e) => e.code);
      session.close(); vault.lockVault(); await vault.unlockVault(directory, 'fixture-password', 0); session = await open();
      await resolve(first.hash);
      stage = 'partial';
      const partial = await session.prepareRegisterKeystore();
      const second = await session.submitPublicOperation(partial, options); await resolve(second.hash);
      stage = 'prepared';
      const prepared = await session.prepareNativeDeposit({ amount: 10000n, maxFee: 100n });
      lost = true;
      const uncertain = await session.submitPublicOperation(prepared, options).then(() => null, (e) => ({ code: e.code, hash: e.transactionHash }));
      session.close(); vault.lockVault(); await vault.unlockVault(directory, 'fixture-password', 0); session = await open(); lost = false;
      const journal = await session.listPublicSubmissions();
      timestampAvailable = false;
      stage = 'missingTimestamp';
      const missingTimestamp = await session.notes();
      timestampAvailable = true; head++;
      stage = 'notes';
      const notes = await session.notes();
      session.close(); vault.lockVault(); await vault.unlockVault(directory, 'fixture-password', 0); session = await open();
      stage = 'restored';
      const restored = await session.notes();
      stage = 'balances';
      const balances = await session.balance();
      stage = 'recovery inspection';
      const originalNoteLogs = logs.filter((log) => log.address === config.deployment.poolAddress);
      const encryptedBefore = fs.readFileSync(path.join(req('./src/main/profile-resolver').getActiveProfile().userDataDir,
        'wallet-ppv2-experiment', fs.readdirSync(path.join(req('./src/main/profile-resolver').getActiveProfile().userDataDir,
          'wallet-ppv2-experiment'))[0]));
      // Model a provider omitting the deposit after a reorg. A full rescan must
      // report the discrepancy and preserve the existing encrypted cache.
      for (const log of originalNoteLogs) logs.splice(logs.indexOf(log), 1);
      const discrepancy = await session.inspectNoteRecovery();
      const encryptedAfter = fs.readFileSync(path.join(req('./src/main/profile-resolver').getActiveProfile().userDataDir,
        'wallet-ppv2-experiment', fs.readdirSync(path.join(req('./src/main/profile-resolver').getActiveProfile().userDataDir,
          'wallet-ppv2-experiment'))[0]));
      logs.push(...originalNoteLogs);
      const rescan = await session.inspectNoteRecovery();
      // Missing initialized state must block, even when chain scanning could
      // reconstruct notes. Restore the preserved cache before reopening.
      session.close();
      const profile = req('./src/main/profile-resolver').getActiveProfile();
      const cache = path.join(profile.userDataDir, 'wallet-ppv2-experiment');
      fs.renameSync(cache, `${cache}.recovery-fixture`);
      const missingCacheBlocked = await open().then(()=>false, e=>e.code === 'PRIVATE_PROFILE_STORE_MISSING');
      if (!missingCacheBlocked) throw new Error('Missing initialized cache was accepted');
      fs.renameSync(`${cache}.recovery-fixture`, cache);
      session = await open();
      stage = 'recovered';
      const recovered = await session.notes();
      const stateFiles = fs.readdirSync(cache).map((name) => fs.readFileSync(path.join(cache, name), 'utf8'));
      // Only public synthetic chain data, not note secrets or SDK state, is
      // saved for replay by a NEW Electron process in the second half.
      fs.writeFileSync(statePath, JSON.stringify({ head, nonce, auth: auth.toString(), viewing, logs,
        receipts: [...receipts], commitment: recovered[0]?.commitment, depositHash: uncertain.hash }));
      return { productionGate, packaged: app.isPackaged, blockedSecond, partialSteps: partial.txs.length,
        partialKind: partial.txs[0].kind, sends: sends.length, reviews, uncertain: uncertain.code,
        journalKinds: journal.map((record) => record.intent.kind), attemptedRecovered: journal[2].hash === uncertain.hash && journal[2].state === 'attempted',
        missingTimestampCount: missingTimestamp.length, proofCommitmentRecovered: notes[0]?.commitment === `0x${depositABI.decodeFunctionData('deposit', prepared.data)._proof.pubSignals[0].toString(16).padStart(64, '0')}`,
        notes: notes.map((note) => ({ value: note.value.toString(), status: note.status })),
        restoredEqual: JSON.stringify(restored, (_key, value) => typeof value === 'bigint' ? value.toString() : value) ===
          JSON.stringify(notes, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
        guardedCacheRestored: recovered.length === 1 && recovered[0].commitment === notes[0]?.commitment,
        rescanRecovered: rescan.notes.length === 1 && rescan.notes[0].commitment === notes[0]?.commitment,
        discrepancyDetected: discrepancy.missingFromScan.length === 1 && discrepancy.cacheReplaced === false,
        cachePreserved: encryptedBefore.equals(encryptedAfter),
        ciphertextOnly: recovered.length === 1 && stateFiles.every((bytes) => !bytes.includes(recovered[0].commitment)),
        balances: balances.map((balance) => ({ amount: balance.amount.toString(), tag: balance.tag })),
        isolatedRoles: contexts.get('protocol-rpc').isolationToken !== contexts.get('transaction-rpc').isolationToken,
        methods: [...methods].sort(), liveTransactionSubmitted: false };
    } catch (error) { throw new Error(`Controlled lifecycle stage: ${stage}, ${error.code || 'fixture-failed'}`, { cause: error }); } finally {
      session?.close(); vault.lockVault(); settings.isWalletTorExperimentAvailable = original.gate;
      rpc.createPrivateRpc = original.rpc; tor.getWalletSocksEndpoint = original.tor;
    }
  };
  const report = await electronApp.evaluate(exercise, { artifact, restart: false });
  await electronApp.close();
  const restarted = await relaunchApp();
  report.processRestart = await restarted.evaluate(exercise, { artifact, restart: true });
  await restarted.close();
  const exiting = await relaunchApp();
  report.nativeExit = await exiting.evaluate(exercise, { artifact, restart: true, exit: true });
  await testInfo.attach('ppv2-lifecycle-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.productionGate).toBe(false);
  expect(report.nativeExit).toMatchObject({ kind: 'ppv2-native-ragequit', amount: '10000', value: '0', proofVerified: true,
    chainStateVerified: false, commitmentBound: true, ownerBound: true, poolBound: true, sent: 1,
    journalKind: 'ppv2-native-ragequit', observedStatus: 'exited', reviewed: 'ppv2-native-ragequit', recordedHash: true });
  expect(report.processRestart).toMatchObject({ recovered: true, rescanRecovered: true, journalRestored: true,
    blocked: 'PRIVATE_SUBMISSION_UNRESOLVED', sends: 0, productionGate: false });
  expect(report.blockedSecond).toBe('PRIVATE_SUBMISSION_UNRESOLVED');
  expect(report.partialSteps).toBe(1); expect(report.partialKind).toBe('ppv2-register-viewing');
  expect(report.sends).toBe(3); expect(report.uncertain).toBe('PRIVATE_BROADCAST_UNCERTAIN');
  expect(report.journalKinds).toEqual(['ppv2-register-auth', 'ppv2-register-viewing', 'ppv2-native-deposit']);
  expect(report.attemptedRecovered).toBe(true); expect(report.missingTimestampCount).toBe(0);
  expect(report.proofCommitmentRecovered).toBe(true);
  expect(report.notes).toEqual([{ value: '10000', status: 'pending' }]);
  expect(report.restoredEqual).toBe(true); expect(report.guardedCacheRestored).toBe(true);
  expect(report.rescanRecovered).toBe(true); expect(report.discrepancyDetected).toBe(true); expect(report.cachePreserved).toBe(true);
  expect(report.ciphertextOnly).toBe(true); expect(report.isolatedRoles).toBe(true);
  expect(report.balances).toEqual([{ amount: '0', tag: 'spendable' }, { amount: '10000', tag: 'unspendable' }]);
  expect(report.reviews.every((review) => review.chainStateVerified === false)).toBe(true);
});
