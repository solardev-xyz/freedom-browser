const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

const cases = [false, true].flatMap(direct => (direct ? [false] : [false, true]).flatMap(tokenMode => [false, true].map(cancel => ({ direct, tokenMode, cancel }))));
cases.push({ direct: true, tokenMode: false, cancel: false, controller: true });
for (const { direct, tokenMode, cancel, controller = false } of cases) {
test(controller ? 'PPv2 bounded controller registration, deposit, withdrawal, reconciliation and separate-note exit' : `PPv2 ${direct ? 'direct test ' : ''}${tokenMode ? 'token' : 'native'} ${cancel ? 'withheld relay, restart and reviewed emergency exit' : 'deposit, ASP state, lost withdrawal, restart, reconciliation and second spend'}`, async ({ electronApp, relaunchApp }, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the qualified Kohaku/SDK fixture');
  test.setTimeout(240000);
  const exercise = async ({ app }, { artifact, restart, exit, second, checkpoint, tokenMode, cancel, direct, controller }) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const runtimeLoader = req('./src/main/wallet/ppv2-runtime');
    artifact = runtimeLoader.verifyPPv2Runtime(artifact);
    const fs = req('fs'), path = req('path');
    const { Interface, Wallet, Transaction } = req('ethers');
    const vault = req('./src/main/identity/vault'), settings = req('./src/main/settings-store');
    const rpc = req('./src/main/networks/private-rpc'), tor = req('./src/main/tor-manager');
    const privacyContext = req('./src/main/networks/privacy-context'), { getPrivacyContext } = privacyContext;
    const originalPrivacyError = privacyContext.privacyError, errorCodes = [];
    privacyContext.privacyError = (code, message) => { errorCodes.push(code); if(errorCodes.length>12)errorCodes.shift(); return originalPrivacyError(code,message); };
    const { ARTIFACTS, DEPOSIT_ABI } = req('./src/main/wallet/ppv2-deposit-policy');
    const { ARTIFACTS: TRANSACT_ARTIFACTS } = req('./src/main/wallet/ppv2-transact-policy');
    const { ARTIFACTS: EXIT_ARTIFACTS, RAGEQUIT_ABI } = req('./src/main/wallet/ppv2-ragequit-policy');
    const { REGISTRATION_ABI } = req('./src/main/wallet/ppv2-public-operations');
    const router = req('./src/main/networks/kohaku-network-router');
    const originalRouter = router.createKohakuNetworkRouter;
    const original = { gate: settings.isWalletTorExperimentAvailable, rpc: rpc.createPrivateRpc, tor: tor.getWalletSocksEndpoint };
    const productionGate = original.gate();
    const endpoint = { signal: new AbortController().signal };
    settings.isWalletTorExperimentAvailable = () => true; tor.getWalletSocksEndpoint = () => endpoint;
    const config = req(`${artifact}/configuration.cjs`).configuration();
    if (controller) {
      const { CANDIDATE } = req('./src/main/wallet/ppv2-sepolia-preflight');
      for (const [index, key, pin] of [[0, 'poolAddress', 'pool'], [1, 'entrypointAddress', 'entrypoint'], [2, 'keystoreAddress', 'keystore']]) {
        config.deployment[key] = CANDIDATE[pin]; config.contracts[index].address = CANDIDATE[pin];
      }
    }
    const { TOKEN_ABI } = req('./src/main/wallet/ppv2-token-policy');
    const token = tokenMode ? `0x${'55'.repeat(20)}` : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    let tokenAllowance=10100n, tokenBalance=20000n;
    if(tokenMode){config.erc20Tokens=[token];config.contracts.push({address:token,selectors:[],eventTopics:[]});}
    const sdk = req(`${artifact}/sdk.cjs`), abis = req(`${artifact}/abis.cjs`);
    const quoteSigner = req('viem/accounts').privateKeyToAccount(Wallet.createRandom().privateKey);
    config.relayers[0].quoteSigner = quoteSigner.address.toLowerCase();
    const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk');
    config.ownerAddress = wallet.address.toLowerCase(); config.artifacts.manifest = sdk.DEFAULT_CIRCUIT_MANIFEST;
    const readAbis = [[...abis.POOL_VAULT_ABI, ...abis.POOL_VAULT_ALL_EVENTS_ABI, ...abis.POOL_VAULT_NOTE_EVENT_ABI, ...abis.POOL_VAULT_DEPOSITED_EVENT_ABI], abis.ENTRYPOINT_ABI,
      [...abis.KEYSTORE_ABI, ...abis.KEYSTORE_EVENTS_ABI, ...abis.KEYSTORE_AUTH_EVENTS_ABI], abis.ASP_REGISTRY_ABI, ...(tokenMode ? [TOKEN_ABI] : [])];
    const interfaces = readAbis.map((abi) => new Interface(abi));
    config.contracts.forEach((grant, index) => {
      grant.selectors = interfaces[index].fragments.filter((f) => f.type === 'function').map((f) => f.selector);
      grant.eventTopics = [...new Set(interfaces[index].fragments.filter((f) => f.type === 'event').map((f) => f.topicHash))];
    });
    const register = new Interface(REGISTRATION_ABI), depositABI = new Interface([DEPOSIT_ABI]), exitABI = new Interface([RAGEQUIT_ABI]);
    const hashService = await sdk.PoseidonHashService.create();
    const merkle = new sdk.MerkleService({ hashService });
    const stateLeaves = [], spent = new Set(); let aspLeaves = [], badRoot = false, reorg = false, relayLost = false, relaySends = 0, invalidQuote = false, fixturePlugin, quoteLifetime = 60000, shortQuoteExpiration = null;
    const tag = (s) => hashService.hash([`0x${Buffer.from(s).toString('hex')}`]);
    const leaf = (tagName, v) => hashService.hash([tag(tagName), `0x${BigInt(v).toString(16)}`, '0x6553f100']);
    const receipts = new Map(), logs = [], sends = [], methods = new Set(), contexts = new Map();
    let head = 256, nonce = 0, auth = 0n, viewing = `0x${'00'.repeat(32)}`, lost = false, timestampAvailable = true;
    const statePath = path.join(app.getPath('userData'), 'ppv2-public-chain-fixture.json');
    const saved = restart ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    if (saved) {
      tokenAllowance=BigInt(saved.tokenAllowance);tokenBalance=BigInt(saved.tokenBalance);
      head = saved.head; nonce = saved.nonce; auth = BigInt(saved.auth); viewing = saved.viewing;
      stateLeaves.push(...(saved.stateLeaves || [])); aspLeaves = saved.aspLeaves || []; for (const n of saved.spent || []) spent.add(n);
      logs.push(...saved.logs); for (const [hash, receipt] of saved.receipts) receipts.set(hash, receipt);
    }
    const blockHash = `0x${'ca'.repeat(32)}`;
    const quantity = (v) => `0x${v.toString(16)}`;
    rpc.createPrivateRpc = (handle) => {
      const context = getPrivacyContext(handle); contexts.set(context.subject.role, context);
      return { signal: context.signal, assertActive: () => getPrivacyContext(handle), ready: async () => {}, release() {},
        trust: { level: 'unverified' }, privacy: { mode: 'controlled-fixture' },
        async request(method, params, validate) {
          getPrivacyContext(handle); methods.add(method);
          let result;
          if (method === 'eth_call' && context.subject.role === 'transaction-rpc' && params[0].from) result = '0x';
          else if (method === 'eth_blockNumber') result = quantity(head);
          else if (method === 'eth_getBlockByNumber') result = { number: params[0] === 'finalized' ? quantity(head - 2) : params[0], hash: reorg && params[0] !== 'finalized' ? `0x${'dd'.repeat(32)}` : blockHash };
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
            } else if (call.name === 'spentNullifiers') result = iface.encodeFunctionResult(call.fragment, [spent.has(call.args[0].toString()) ? 1700000000n : 0n]);
            else if (call.name === 'allowance') result=iface.encodeFunctionResult(call.fragment,[tokenAllowance]);
            else if (call.name === 'balanceOf') result=iface.encodeFunctionResult(call.fragment,[tokenBalance]);
            else if (call.name === 'latestASPRoot') result = iface.encodeFunctionResult(call.fragment, [badRoot ? 1n : BigInt(await merkle.computeRoot(aspLeaves))]);
            else if (call.name === 'nullifyingKeys') result = iface.encodeFunctionResult(call.fragment, [auth]);
            else if (call.name === 'viewingKeys') result = iface.encodeFunctionResult(call.fragment, [viewing]);
            else if (call.name === 'isKnownRoot') result = iface.encodeFunctionResult(call.fragment, [true]);
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
              if(tokenMode){if(tx.value!==0n || tokenAllowance!==10100n)throw new Error('Invalid token deposit');tokenAllowance=0n;tokenBalance-=10100n;}
              const index = stateLeaves.length; const next = leaf('privacy_pools_note', `0x${decoded._proof.pubSignals[0].toString(16)}`); stateLeaves.push(next);
              const tree = interfaces[0].encodeEventLog(interfaces[0].getEvent('LeavesInserted'), [[BigInt(next)], BigInt(await merkle.computeRoot(stateLeaves)), BigInt(index)]);
              logs.push({ address: config.deployment.poolAddress, ...tree, blockNumber: quantity(head), blockHash, transactionHash: tx.hash, logIndex: '0x1', transactionIndex: '0x0', removed: false });
              const deposited = interfaces[0].encodeEventLog(interfaces[0].getEvent('Deposited'),
                [decoded._proof.pubSignals[0], token, controller ? 5000000000000000n : 10000n, config.deployment.entrypointAddress]);
              logs.push({ address: config.deployment.poolAddress, ...deposited, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x2', transactionIndex: '0x0', removed: false });
              const event = interfaces[0].encodeEventLog(interfaces[0].getEvent('Note'), [decoded._noteData.hint, decoded._noteData.data]);
              logs.push({ address: config.deployment.poolAddress, ...event, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false });
            } else if (tx.to.toLowerCase() === config.deployment.poolAddress) {
              const signals = exitABI.decodeFunctionData('ragequit', tx.data)._proof.pubSignals;
              const event = interfaces[0].encodeEventLog(interfaces[0].getEvent('Ragequit'),
                [wallet.address, `0x${signals[5].toString(16).padStart(40, '0')}`, signals[4], signals[1], signals[0], signals[6]]);
              const exitLog = { address: config.deployment.poolAddress, ...event, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false };
              logs.push(exitLog); spent.add(signals[0].toString());
              Object.assign(receipts.get(tx.hash), { to: config.deployment.poolAddress, logs: [exitLog] });
              head += 3;
            } else throw new Error('Unexpected fixture transaction');
            if (lost) throw new Error('Controlled lost broadcast response');
          } else throw new Error('Unexpected RPC request');
          if (!validate(result)) throw new Error('Invalid controlled response');
          return { result };
        } };
    };
    router.createKohakuNetworkRouter = (groups) => {
      if (groups.find(g => getPrivacyContext(g.handle).subject.role === 'relayer')?.route !== (direct ? 'direct-sepolia-test' : 'tor') ||
          groups.find(g => getPrivacyContext(g.handle).subject.role === 'asp')?.route !== 'tor') throw new Error('Incorrect role transport selection');
      return { fetch: async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/association-set/leaves')) return new Response(JSON.stringify({ leaves: aspLeaves.map((v) => BigInt(v).toString()) }));
      if (u.pathname.includes('/v1/quote/')) {
        const requested = JSON.parse(init.body), coder = req('ethers').AbiCoder.defaultAbiCoder();
        const amount = BigInt(requested.amount), fee = 100n;
        const data = coder.encode(['tuple(address recipient,address feeRecipient,uint256 feeAmount,uint256 nativeGas)'],
          [[requested.recipient, config.relayers[0].address, fee, 0n]]);
        const feeCommitment = { data, asset: direct ? req('ethers').getAddress(requested.asset) : requested.asset, expiration: Date.now()+quoteLifetime, feeAmount: '100',
          recipient: direct ? req('ethers').getAddress(requested.recipient) : requested.recipient, amountSent: (amount+fee).toString(), amountReceived: amount.toString(), ...(direct ? {} : { extraGas: false }) };
        if (quoteLifetime === 10000) shortQuoteExpiration = feeCommitment.expiration;
        feeCommitment.signedRelayerCommitment = await quoteSigner.signTypedData({
          domain: { name: 'Privacy Pools Relayer', version: '1', chainId: 11155111, verifyingContract: config.relayers[0].processorAddress },
          primaryType: 'RelayWithdrawalCommitment', types: { RelayWithdrawalCommitment: [
            { name: 'data', type: 'bytes' }, { name: 'asset', type: 'address' }, { name: 'expiration', type: 'uint256' },
            { name: 'amountSent', type: 'uint256' }, { name: 'amountReceived', type: 'uint256' },
          ] }, message: feeCommitment,
        });
        if (invalidQuote) feeCommitment.expiration++;
        return new Response(JSON.stringify({ txCost: '1', gasPrice: '1', feeAmount: '100', amountSent: (amount+fee).toString(),
          amountReceived: amount.toString(), feeCommitment }));
      }
      if (u.pathname.endsWith('/v1/relay/evm/11155111/withdrawal')) {
        const p = JSON.parse(init.body), signals = p.proof.publicSignals.map(BigInt);
        relaySends++;
        if (cancel) return new Response('{}', { status: 400 });
        head+=controller ? 3 : 6000;
        const txHash = `0x${(200+spent.size).toString(16).padStart(64,'0')}`;
        const start = stateLeaves.length, leaves = [leaf('privacy_pools_note', signals[1]), leaf('privacy_pools_nullifier', signals[0])];
        stateLeaves.push(...leaves); spent.add(signals[0].toString());
        const events = [interfaces[0].encodeEventLog(interfaces[0].getEvent('LeavesInserted'), [leaves.map(BigInt), BigInt(await merkle.computeRoot(stateLeaves)), BigInt(start)]),
          interfaces[0].encodeEventLog(interfaces[0].getEvent('Note'), [p.noteData[0].hint,p.noteData[0].data]),
          interfaces[0].encodeEventLog(interfaces[0].getEvent('Transacted'), [[signals[1]],[signals[0]],token,signals[5],config.relayers[0].processorAddress])]
          .map((e,i)=>({address:config.deployment.poolAddress,...e,blockNumber:quantity(head),blockHash,transactionHash:txHash,logIndex:quantity(i),transactionIndex:'0x0',removed:false}));
        logs.push(...events); receipts.set(txHash,{transactionHash:txHash,to:config.relayers[0].processorAddress,blockHash,blockNumber:quantity(head),status:'0x1',logs:events});
        head+=controller ? 3 : 6000;
        if (relayLost) throw new Error('Controlled lost relay response');
        return new Response(JSON.stringify({txHash}));
      }
      throw new Error('Controlled unavailable ASP snapshot');
    } }; };
    const directory = path.join(app.getPath('userData'), 'ppv2-lifecycle-vault');
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-lifecycle-artifacts-'));
    for (const entry of [...ARTIFACTS, ...EXIT_ARTIFACTS, ...TRANSACT_ARTIFACTS]) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
    let session, stage = 'open';
    try {
      if (!restart) await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
      await vault.unlockVault(directory, 'fixture-password', 0);
      const { openPPv2Session } = req('./src/main/wallet/ppv2-session');
      const adapter = req(`${artifact}/plugin.cjs`);
      // Main-only access to synthetic note labels for the controlled ASP.
      const createPlugin = adapter.createPPv2Plugin;
      req.cache[req.resolve(`${artifact}/plugin.cjs`)].exports = { ...adapter,
        createPPv2Plugin: async (...args) => (fixturePlugin = await createPlugin(...args)) };
      // This evaluated fixture owns main and instruments exports solely for
      // synthetic ASP state; the loader itself and its digest check are real.
      const { candidate } = runtimeLoader.loadPPv2Runtime(artifact);
      if (direct) {
      const profile = req('./src/main/profile-resolver').getActiveProfile();
      fs.writeFileSync(path.join(profile.userDataDir, 'ppv2-direct-test.json'), JSON.stringify({ version: 1, chainId: 11155111,
        profileId: profile.id, disposable: true, relayerExposure: 'direct-ip' }));
    }
    const open = () => openPPv2Session({ candidate, configuration: config, relayerRoute: direct ? 'direct-sepolia-test' : 'tor',
        proving: { sdkEntry: `${artifact}/sdk.cjs`, ragequitProverEntry: `${artifact}/serial-prover.cjs`, transactProverEntry: `${artifact}/serial-prover.cjs`, directory: artifactDir } });
      const reviews = [];
      const options = { signer: { getAddress: async () => wallet.address, signTransaction: (tx) => wallet.signTransaction(tx) },
        gasLimit: 1000000n, maxGasFee: 100000000n, review: async (request) => {
          reviews.push({ operation: request.operation, proofVerified: request.proofVerified, chainStateVerified: request.chainStateVerified, pendingRelayCancellation: request.pendingRelayCancellation, competingRelayMayWin: request.competingRelayMayWin }); return true;
        } };
      const resolve = (hash) => session.resolvePublicSubmission(hash, { minimumConfirmations: 1,
        review: async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }) });
      session = await open();
      if (direct && (session.descriptor.relayerTransport !== 'direct' || session.descriptor.relayerTorProtected || !session.descriptor.identityMayBeIpLinked)) throw new Error('Missing direct exposure label');
      const save = (commitment, depositHash) => fs.writeFileSync(statePath, JSON.stringify({head,nonce,tokenAllowance:tokenAllowance.toString(),tokenBalance:tokenBalance.toString(),auth:auth.toString(),viewing,logs,receipts:[...receipts],stateLeaves,aspLeaves,spent:[...spent],commitment,depositHash}));
      if (controller) {
        const { runSepoliaTestStep } = req('./src/main/wallet/ppv2-sepolia-test-step');
        const scope = req('./src/main/wallet/privacy-session').openPrivacySession();
        try {
          const handle = scope.getContext({ kind: 'private-account', principal: 'ppv2:0', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role: 'relayer' });
          const run = (action, reference) => runSepoliaTestStep({ handle, session, signer: wallet, owner: wallet.address.toLowerCase(), action, reference,
            readBalance: async () => 50000000000000000n, estimateGas: async () => 100000n, verifyDeployment: async () => true });
          const settle = async hash => { head += 12; return run('resolve-public', hash); };
          stage = 'controller auth'; const authTx = await run('register-auth');
          const blocked = await run('register-viewing').then(() => false, () => true);
          await settle(authTx.hash);
          stage = 'controller viewing'; await settle((await run('register-viewing')).hash);
          stage = 'controller deposit'; await settle((await run('deposit')).hash);
          const deposited = (await session.notes())[0];
          const exported = JSON.parse(await fixturePlugin.exportAccount()); let label;
          const walk = v => { if (!v || typeof v !== 'object') return; if (v.commitment === deposited.commitment && v.label) label = v.label; Object.values(v).forEach(walk); }; walk(exported);
          if (!label) throw new Error('Missing controller fixture label');
          const noteMath = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
          aspLeaves = [noteMath.computeLabelHash(label)]; head += 3; session.close(); session = await open();
          stage = 'controller withdrawal'; await run('withdraw', deposited.commitment);
          const relay = (await session.listRelayAttempts())[0];
          stage = 'controller relay reconciliation'; await run('resolve-relay', relay.id);
          stage = 'controller second deposit'; await settle((await run('deposit')).hash);
          const exitNote = (await session.notes()).find(n => n.value === 5000000000000000n && n.commitment !== deposited.commitment);
          if (!exitNote) throw new Error('Missing separate exit note');
          stage = 'controller exit'; await settle((await run('ragequit', exitNote.commitment)).hash);
          const status = await run('status');
          return { controller: true, blocked, publicSends: sends.length, relaySends, resolvedPublic: status.publicSubmissions.every(r => !!r.resolution),
            resolvedRelay: status.relayAttempts.every(r => !!r.resolution), liveTransactionSubmitted: false };
        } finally { scope.close(); }
      }
      if (restart) {
        if (!exit && !second) {
          const notes = await session.notes(); return { recovered: notes.length === 1, blocked: await session.submitPublicOperation({},{}).then(()=>null,e=>e.code) };
        }
        if (exit) {
          stage='ASP qualification'; await resolve(saved.depositHash);
          const pending = await session.notes();
          const exported=JSON.parse(await fixturePlugin.exportAccount()); let label;
          const walk=(v)=>{if(!v||typeof v!=='object')return;if(v.commitment===saved.commitment&&v.label)label=v.label;Object.values(v).forEach(walk);}; walk(exported);
          if(!label)throw new Error('Missing synthetic label');
          const noteMath=new sdk.NoteComputationService({hashService,cryptoService:new sdk.CryptoService()});
          aspLeaves=[noteMath.computeLabelHash(label)]; badRoot=true; head+=3; session.close(); session=await open();
          const mismatched=await session.notes();
          badRoot=false; head+=3; session.close(); session=await open(); const approved=await session.notes();
          const approvedLeaves=aspLeaves;
          // The compatibility fix must demote an active note on an empty set.
          aspLeaves=[]; head+=3; session.close(); session=await open();
          const emptySet=await session.notes();
          const emptyBefore = JSON.stringify(await session.listRelayAttempts()), emptySends = relaySends;
          const emptySetSpendCode=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:saved.commitment,amount:5900n,maxFee:100n,
            recipient:`0x${'77'.repeat(20)}`}).then(()=>null,e=>e.code);
          const emptySetSpendBlocked = emptySetSpendCode === 'PRIVATE_PPV2_NOTE_UNAVAILABLE' && relaySends === emptySends &&
            JSON.stringify(await session.listRelayAttempts()) === emptyBefore;
          aspLeaves=['0x123']; head+=3; session.close(); session=await open(); const revoked=await session.notes();
          aspLeaves=approvedLeaves; head+=3; session.close(); session=await open(); await session.notes();
          stage='withdrawal quote authentication'; invalidQuote=true; errorCodes.length=0;
          const invalidQuoteBlocked=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:saved.commitment,amount:5900n,maxFee:100n,recipient:`0x${'77'.repeat(20)}`}).then(()=>false,()=>true);
          const invalidQuoteCode=errorCodes.includes('PRIVATE_PPV2_RELAY_REFUSED');
          if(relaySends!==0)throw new Error('Invalid quote reached relay');
          invalidQuote=false; quoteLifetime=10000; errorCodes.length=0;
          const shortQuoteStart = performance.now();
          const shortQuoteCode=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:saved.commitment,amount:5900n,maxFee:100n,recipient:`0x${'77'.repeat(20)}`}).then(()=>null,(error)=>error.code);
          const shortQuoteRejectedAt = Date.now();
          const shortQuoteElapsedMs = Math.round(performance.now() - shortQuoteStart);
          // The SDK can itself discard the expired quote before producing the
          // final capture. Otherwise main refuses its 15-second delivery margin.
          const shortQuoteBlocked = shortQuoteCode === 'PRIVATE_PPV2_RELAY_REFUSED' ||
            (shortQuoteCode === 'PRIVATE_PPV2_OPERATION_FAILED' && shortQuoteExpiration !== null && shortQuoteRejectedAt >= shortQuoteExpiration);
          if(relaySends!==0 || (await session.listRelayAttempts()).length!==0) throw new Error('Short quote reserved or sent');
          quoteLifetime=60000; stage='withdrawal preparation';
          let prepared=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:saved.commitment,amount:5900n,maxFee:100n,recipient:`0x${'77'.repeat(20)}`});
          if (!tokenMode && !cancel) {
            // A root changes while the user reviews. Refuse before reserving
            // the note, then allow a freshly prepared operation to proceed.
            const stale = await session.submitNativeWithdrawal(prepared, async () => { badRoot = true; return true; }).then(() => null, (e) => e.code);
            badRoot = false;
            if (stale !== 'PRIVATE_PPV2_RELAY_REFUSED' || relaySends !== 0 || (await session.listRelayAttempts()).length !== 0) throw new Error('Stale root was journaled or relayed');
            prepared = await session.prepareNativeWithdrawal({ commitment:saved.commitment,amount:5900n,maxFee:100n,recipient:`0x${'77'.repeat(20)}` });
          }
          stage='withdrawal lost response'; relayLost=true;
          const outcome=await session[tokenMode?'submitTokenWithdrawal':'submitNativeWithdrawal'](prepared,async()=>true).then(()=>null,e=>e.code);
          const blocked=await session.submitPublicOperation({},{}).then(()=>null,e=>e.code);
          save(saved.commitment,saved.depositHash);
          return {pending:pending[0].status,mismatched:mismatched[0].status,approved:approved[0].status,revoked:revoked[0].status,
            emptySetStatus:emptySet[0].status,emptySetSpendBlocked,emptySetSpendCode,invalidQuoteBlocked,invalidQuoteCode,shortQuoteBlocked,shortQuoteCode,shortQuoteElapsedMs,shortQuoteExpiration,shortQuoteRejectedAt,
            outcome,blocked,relaySends,proofVerified:prepared.proofVerified,quoteSignatureVerified:prepared.quoteSignatureVerified};
        }
        stage='withdrawal recovery';
        const attempts=await session.listRelayAttempts();
        if (cancel) {
          if (checkpoint) {
            const before = await session.observeRelayAttempt(attempts[0].id);
            stage='competing emergency exit';
            const prepared = await session[tokenMode?'prepareTokenRagequit':'prepareNativeRagequit'](tokenMode ? {token, commitment:saved.commitment} : saved.commitment);
            const result = await session.submitPublicOperation(prepared, options);
            await resolve(result.hash);
            const observed = await session.observeRelayAttempt(attempts[0].id);
            const unresolved = (await session.listRelayAttempts())[0].resolution === null;
            save(saved.commitment,saved.depositHash);
            return { status:before.observation.status, exitStatus:observed.observation.status, unresolved, reviews, relaySends };
          }
          stage='emergency exit resolution after restart';
          const persisted = (await session.listRelayAttempts())[0];
          const resolved = await session.resolveRelayAttempt(attempts[0].id, async()=>({allowNextOperation:true,acceptedEvidence:'unverified-rpc'}));
          const notes = await session.notes();
          return { persistedExit:persisted.observation.status, requiredReview:!persisted.resolution, resolved:!!resolved.resolution,
            observation:resolved.observation.status, activeNotes:notes.filter(n=>n.status==='active').length, relaySends };
        }
        if (checkpoint) {
          const progress=await session.observeRelayAttempt(attempts[0].id);
          return { nextBlock:progress.scan?.nextBlock, status:progress.observation.status };
        }
        const resumed=(await session.listRelayAttempts())[0];
        const observation=await session.observeRelayAttempt(attempts[0].id);
        stage='withdrawal resolution';
        await session.resolveRelayAttempt(attempts[0].id,async()=>({allowNextOperation:true,acceptedEvidence:'unverified-rpc'}));
        const recovered=await session.notes(); const change=recovered.find(n=>n.status==='active');
        if(!change)throw new Error('Change not recovered');
        reorg=true;
        const reorgSends = relaySends;
        const reorgCode=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:change.commitment,amount:1000n,maxFee:100n,recipient:`0x${'77'.repeat(20)}`}).then(()=>null,e=>e.code);
        const reorgRecords = await session.listRelayAttempts();
        const reorgBlocked = reorgCode === 'PRIVATE_PPV2_RELAY_UNRESOLVED' && relaySends === reorgSends &&
          reorgRecords.length === attempts.length && reorgRecords[0].resolution === null;
        reorg=false; await session.observeRelayAttempt(attempts[0].id); await session.resolveRelayAttempt(attempts[0].id,async()=>({allowNextOperation:true,acceptedEvidence:'unverified-rpc'}));
        stage='second spend';
        const prepared=await session[tokenMode?'prepareTokenWithdrawal':'prepareNativeWithdrawal']({token,commitment:change.commitment,amount:1000n,maxFee:100n,recipient:`0x${'77'.repeat(20)}`});
        const result=await session[tokenMode?'submitTokenWithdrawal':'submitNativeWithdrawal'](prepared,async()=>true);
        const last=(await session.listRelayAttempts())[1];
        await session.observeRelayAttempt(last.id);
        await session.resolveRelayAttempt(last.id,async()=>({allowNextOperation:true,acceptedEvidence:'unverified-rpc'}));
        const after=await session.notes();
        return {checkpointPersisted:!!resumed.scan && resumed.observation.status==='unknown',
          observation:observation.observation.status,trust:observation.observation.trust,recoveredChange:change.value.toString(),reorgBlocked,reorgCode,
          secondHash:!!result.txHash,remaining:after.filter(n=>n.status==='active').map(n=>n.value.toString()),
          resolved:(await session.listRelayAttempts()).filter(r=>r.resolution).length,relaySends};
      }
      stage = 'registration';
      const registration = await session.prepareRegisterKeystore();
      const first = await session.submitPublicOperation(registration, options);
      const blockedSecond = await session.submitPublicOperation(registration, { ...options, step: 1 }).then(() => null, (e) => e.code);
      session.close(); vault.lockVault(); await vault.unlockVault(directory, 'fixture-password', 0); session = await open();
      await resolve(first.hash);
      stage = 'partial';
      const partial = await session.prepareRegisterKeystore();
      const viewingSubmission = await session.submitPublicOperation(partial, options); await resolve(viewingSubmission.hash);
      stage = 'prepared';
      const prepared = await session[tokenMode?'prepareTokenDeposit':'prepareNativeDeposit']({token, amount: 10000n, maxFee: 100n });
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
      fs.writeFileSync(statePath, JSON.stringify({ head, nonce, tokenAllowance:tokenAllowance.toString(),tokenBalance:tokenBalance.toString(),auth: auth.toString(), viewing, logs,
        receipts: [...receipts], stateLeaves, aspLeaves, spent: [...spent], commitment: recovered[0]?.commitment, depositHash: uncertain.hash }));
      return { assetBound:tokenMode?recovered[0]?.asset.contract===token:recovered[0]?.asset.__type==='native', productionGate, packaged: app.isPackaged, blockedSecond, partialSteps: partial.txs.length,
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
    } catch (error) { throw new Error(`Controlled lifecycle stage: ${stage}, ${error.code || 'fixture-failed'}, codes=${errorCodes.join(',')}`, { cause: error }); } finally {
      privacyContext.privacyError = originalPrivacyError;
      router.createKohakuNetworkRouter = originalRouter; session?.close(); vault.lockVault(); settings.isWalletTorExperimentAvailable = original.gate;
      rpc.createPrivateRpc = original.rpc; tor.getWalletSocksEndpoint = original.tor;
    }
  };
  const report = await electronApp.evaluate(exercise, { artifact, tokenMode, cancel, direct, controller, restart: false });
  if (controller) {
    await testInfo.attach('ppv2-controller-report', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(report).toMatchObject({ controller: true, blocked: true, publicSends: 5, relaySends: 1, resolvedPublic: true, resolvedRelay: true, liveTransactionSubmitted: false });
    return;
  }
  await electronApp.close(); const withdrawing = await relaunchApp();
  report.withdrawal = await withdrawing.evaluate(exercise, { artifact, tokenMode, cancel, direct, restart:true, exit:true });
  await withdrawing.close(); const restored = await relaunchApp();
  report.checkpoint = await restored.evaluate(exercise, { artifact, tokenMode, cancel, direct, restart:true, second:true, checkpoint:true });
  await restored.close(); const resumed = await relaunchApp();
  report.secondSpend = await resumed.evaluate(exercise, { artifact, tokenMode, cancel, direct, restart:true, second:true });
  await testInfo.attach('ppv2-withdrawal-report', {body:JSON.stringify(report,null,2),contentType:'application/json'});
  expect(report.checkpoint).toMatchObject({status:'unknown'});
  if (!cancel) expect(report.checkpoint.nextBlock).toBeGreaterThan(5000);
  else expect(report.checkpoint).toMatchObject({exitStatus:'exited',unresolved:true,relaySends:0,
    reviews:[expect.objectContaining({pendingRelayCancellation:true,competingRelayMayWin:true})]});
  expect(report.assetBound).toBe(true);
  expect(report.productionGate).toBe(false);
  expect(report.withdrawal).toMatchObject({pending:'pending',mismatched:'pending',approved:'active',revoked:'rejected',
    emptySetStatus:'rejected',emptySetSpendBlocked:true,invalidQuoteBlocked:true,invalidQuoteCode:true,shortQuoteBlocked:true,outcome:'PRIVATE_PPV2_RELAY_UNCERTAIN',blocked:'PRIVATE_PPV2_RELAY_UNRESOLVED',relaySends:1,proofVerified:true,quoteSignatureVerified:true});
  if (cancel) expect(report.secondSpend).toMatchObject({persistedExit:'exited',requiredReview:true,resolved:true,observation:'exited',activeNotes:0,relaySends:0});
  else expect(report.secondSpend).toMatchObject({checkpointPersisted:true,observation:'included',trust:'unverified-rpc',recoveredChange:'4000',reorgBlocked:true,
    secondHash:true,remaining:['2900'],resolved:2,relaySends:1});
});
}
