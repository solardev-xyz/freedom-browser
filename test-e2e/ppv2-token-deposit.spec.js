const { test, expect } = require('./fixtures');
const artifact = process.env.FREEDOM_PP_V2_PROCESS_ASAR;

test('PPv2 token reset, approval, deposit and restart recovery', async ({ electronApp, relaunchApp }, testInfo) => {
  test.skip(!artifact, 'Set FREEDOM_PP_V2_PROCESS_ASAR to the qualified Kohaku/SDK fixture');
  test.setTimeout(120000);
  const exercise = async ({ app }, { artifact, phase }) => {
    const req = process.mainModule.require('module').createRequire(`${app.getAppPath()}/package.json`);
    const runtimeLoader = req('./src/main/wallet/ppv2-runtime');
    artifact = runtimeLoader.verifyPPv2Runtime(artifact);
    const fs = req('fs'), path = req('path');
    const { Interface, Wallet, Transaction } = req('ethers');
    const vault = req('./src/main/identity/vault'), settings = req('./src/main/settings-store');
    const rpc = req('./src/main/networks/private-rpc'), tor = req('./src/main/tor-manager');
    const { getPrivacyContext } = req('./src/main/networks/privacy-context');
    const { ARTIFACTS, DEPOSIT_ABI } = req('./src/main/wallet/ppv2-deposit-policy');
    const { ARTIFACTS: EXIT_ARTIFACTS, RAGEQUIT_ABI } = req('./src/main/wallet/ppv2-ragequit-policy');
    const exitABI = new Interface([RAGEQUIT_ABI]);
    const { TOKEN_ABI } = req('./src/main/wallet/ppv2-token-policy');
    const token = `0x${'55'.repeat(20)}`, tokenABI = new Interface(TOKEN_ABI);
    let allowance = 5n, balance = 20000n;
    const { REGISTRATION_ABI } = req('./src/main/wallet/ppv2-public-operations');
    const original = { gate: settings.isWalletTorExperimentAvailable, rpc: rpc.createPrivateRpc, tor: tor.getWalletSocksEndpoint };
    const productionGate = original.gate();
    const endpoint = { signal: new AbortController().signal };
    settings.isWalletTorExperimentAvailable = () => true; tor.getWalletSocksEndpoint = () => endpoint;
    const config = req(`${artifact}/configuration.cjs`).configuration();
    config.erc20Tokens = [token]; config.contracts.push({ address:token, selectors:[], eventTopics:[] });
    const sdk = req(`${artifact}/sdk.cjs`), abis = req(`${artifact}/abis.cjs`);
    const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk');
    config.ownerAddress = wallet.address.toLowerCase(); config.artifacts.manifest = sdk.DEFAULT_CIRCUIT_MANIFEST;
    const readAbis = [[...abis.POOL_VAULT_ABI, ...abis.POOL_VAULT_ALL_EVENTS_ABI, ...abis.POOL_VAULT_NOTE_EVENT_ABI, ...abis.POOL_VAULT_DEPOSITED_EVENT_ABI], abis.ENTRYPOINT_ABI,
      [...abis.KEYSTORE_ABI, ...abis.KEYSTORE_EVENTS_ABI, ...abis.KEYSTORE_AUTH_EVENTS_ABI], abis.ASP_REGISTRY_ABI, TOKEN_ABI];
    const interfaces = readAbis.map((abi) => new Interface(abi));
    config.contracts.forEach((grant, index) => {
      grant.selectors = interfaces[index].fragments.filter((f) => f.type === 'function').map((f) => f.selector);
      grant.eventTopics = [...new Set(interfaces[index].fragments.filter((f) => f.type === 'event').map((f) => f.topicHash))];
    });
    const register = new Interface(REGISTRATION_ABI), depositABI = new Interface([DEPOSIT_ABI]);
    const hashService = await sdk.PoseidonHashService.create();
    const receipts = new Map(), logs = [], sends = [], methods = new Set(), contexts = new Map();
    let head = 256, nonce = 0, auth = 0n, viewing = `0x${'00'.repeat(32)}`, lost = false;
    const statePath = path.join(app.getPath('userData'), 'ppv2-public-chain-fixture.json');
    const saved = phase ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
    if (saved) {
      allowance=BigInt(saved.allowance); balance=BigInt(saved.balance);
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
              result = iface.encodeFunctionResult(call.fragment, [1700000000n]);
            } else if (call.name === 'allowance') result = iface.encodeFunctionResult(call.fragment, [allowance]);
            else if (call.name === 'balanceOf') result = iface.encodeFunctionResult(call.fragment, [balance]);
            else if (call.name === 'nullifyingKeys') result = iface.encodeFunctionResult(call.fragment, [auth]);
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
            } else if (tx.to.toLowerCase() === token) {
              const call=tokenABI.parseTransaction({data:tx.data});
              if(call.name!=='approve' || call.args[0].toLowerCase()!==config.deployment.entrypointAddress ||
                  (allowance!==0n && call.args[1]!==0n)) throw new Error('Unsafe fixture approval');
              allowance=call.args[1];
            } else if (tx.to.toLowerCase() === config.deployment.entrypointAddress) {
              const decoded = depositABI.decodeFunctionData('deposit', tx.data);
              if (tx.value!==0n || allowance!==10100n || decoded._proof.pubSignals[1]!==BigInt(token)) throw new Error('Wrong token deposit');
              allowance-=10100n; balance-=10100n;
              const event = interfaces[0].encodeEventLog(interfaces[0].getEvent('Note'), [decoded._noteData.hint, decoded._noteData.data]);
              logs.push({ address: config.deployment.poolAddress, ...event, blockNumber: quantity(head), blockHash,
                transactionHash: tx.hash, logIndex: '0x0', transactionIndex: '0x0', removed: false });
            } else if(tx.to.toLowerCase()===config.deployment.poolAddress){
              const signals=exitABI.decodeFunctionData('ragequit',tx.data)._proof.pubSignals;
              if(signals[5]!==BigInt(token))throw new Error('Wrong exit asset');
              balance+=signals[4];
              const event=interfaces[0].encodeEventLog(interfaces[0].getEvent('Ragequit'),[wallet.address,token,signals[4],signals[1],signals[0],signals[6]]);
              logs.push({address:config.deployment.poolAddress,...event,blockNumber:quantity(head),blockHash,
                transactionHash:tx.hash,logIndex:'0x0',transactionIndex:'0x0',removed:false});
            } else throw new Error('Unexpected fixture transaction');
            if (lost) throw new Error('Controlled lost broadcast response');
          } else throw new Error('Unexpected RPC request');
          if (!validate(result)) throw new Error('Invalid controlled response');
          return { result };
        } };
    };
    const directory = path.join(app.getPath('userData'), 'ppv2-lifecycle-vault');
    const artifactDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'ppv2-lifecycle-artifacts-'));
    for (const entry of [...ARTIFACTS,...EXIT_ARTIFACTS]) fs.writeFileSync(path.join(artifactDir, entry.name), fs.readFileSync(`${artifact}/artifacts/${entry.name}`));
    let session, stage = 'open';
    try {
      if (!phase) await vault.importVault(directory, 'fixture-password', 'test test test test test test test test test test test junk');
      await vault.unlockVault(directory, 'fixture-password', 0);
      const { openPPv2Session } = req('./src/main/wallet/ppv2-session');
      const { candidate } = runtimeLoader.loadPPv2Runtime(artifact);
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
      const intent={token,amount:10000n,maxFee:100n};
      const save=(lastHash)=>fs.writeFileSync(statePath,JSON.stringify({head,nonce,auth:auth.toString(),viewing,logs,
        receipts:[...receipts],allowance:allowance.toString(),balance:balance.toString(),lastHash}));
      const uncertain=async(prepared)=>{
        lost=true;
        const result=await session.submitPublicOperation(prepared,options).then(()=>null,e=>({code:e.code,hash:e.transactionHash}));
        if(result?.code!=='PRIVATE_BROADCAST_UNCERTAIN')throw new Error('Expected durable uncertainty');
        save(result.hash); return result.code;
      };
      if(!phase){
        stage='registration';
        const first=await session.submitPublicOperation(await session.prepareRegisterKeystore(),options); await resolve(first.hash);
        const second=await session.submitPublicOperation(await session.prepareRegisterKeystore(),options); await resolve(second.hash);
        stage='reset';
        const reset=await session.prepareTokenApproval(intent);
        const beforeRefusal = JSON.stringify((await session.listPublicSubmissions()).map(r=>({hash:r.hash,nonce:r.nonce,state:r.state,intent:r.intent}))), sendsBeforeRefusal = sends.length;
        const depositRefusalCode=await session.prepareTokenDeposit(intent).then(()=>null,e=>e.code);
        const refused = depositRefusalCode === 'PRIVATE_PPV2_ALLOWANCE_REQUIRED' && sends.length === sendsBeforeRefusal &&
          JSON.stringify((await session.listPublicSubmissions()).map(r=>({hash:r.hash,nonce:r.nonce,state:r.state,intent:r.intent}))) === beforeRefusal;
        const outcome=await uncertain(reset);
        return {kind:reset.kind,approvalAmount:reset.approvalAmount.toString(),depositRefused:refused,depositRefusalCode,outcome,
          productionGate,packaged:app.isPackaged};
      }
      stage='restored reservation';
      const blocked=await session.prepareTokenApproval(intent).then(()=>false,()=>true);
      const before=await session.listPublicSubmissions();
      await resolve(saved.lastHash);
      if(phase===1){
        stage='exact approval';
        const approval=await session.prepareTokenApproval(intent);
        const outcome=await uncertain(approval);
        return {blocked,journalCount:before.length,approvalAmount:approval.approvalAmount.toString(),outcome};
      }
      if(phase===2){
        stage='token deposit';
        const noApproval=(await session.prepareTokenApproval(intent))===null;
        const prepared=await session.prepareTokenDeposit(intent);
        const outcome=await uncertain(prepared);
        return {blocked,noApproval,kind:prepared.kind,tokenBound:prepared.token===token,amount:prepared.amount.toString(),
          fee:prepared.fee.toString(),value:prepared.value.toString(),proofVerified:prepared.proofVerified,outcome};
      }
      stage='token note recovery'; head+=3;
      const notes=await session.notes();
      const rescan=await session.inspectNoteRecovery();
      session.close();
      const cache=path.join(req('./src/main/profile-resolver').getActiveProfile().userDataDir,'wallet-ppv2-experiment');
      fs.renameSync(cache,`${cache}.token-recovery-fixture`);
      const missingCacheBlocked = await open().then(()=>false, e=>e.code === 'PRIVATE_PROFILE_STORE_MISSING');
      if (!missingCacheBlocked) throw new Error('Missing initialized cache was accepted');
      fs.renameSync(`${cache}.token-recovery-fixture`, cache);
      session=await open(); const recovered=await session.notes();
      stage='token emergency exit';
      const exit=await session.prepareTokenRagequit({token,commitment:recovered[0].commitment});
      await session.submitPublicOperation(exit,options); head+=3;
      const exited=await session.notes();
      return {exitKind:exit.kind,exitProofVerified:exit.proofVerified,exitStatus:exited[0]?.status,
        blocked,journalCount:before.length,balance:balance.toString(),allowance:allowance.toString(),
        notes:notes.map(n=>({amount:n.value.toString(),token:n.asset.contract,status:n.status})),
        guardedCacheRestored:recovered[0]?.commitment===notes[0]?.commitment,
        rescanRecovered:rescan.notes[0]?.commitment===notes[0]?.commitment,
        journalKinds:(await session.listPublicSubmissions()).map(r=>r.intent.kind),sends:sends.length};
    } catch(error) { throw new Error(`Controlled token stage: ${stage}, ${error.code||'fixture-failed'}`,{cause:error}); }
    finally {session?.close();vault.lockVault();settings.isWalletTorExperimentAvailable=original.gate;
      rpc.createPrivateRpc=original.rpc;tor.getWalletSocksEndpoint=original.tor;}
  };
  const report=[];let current=electronApp;
  for(let phase=0;phase<4;phase++){
    report.push(await current.evaluate(exercise,{artifact,phase}));
    if(phase<3){await current.close();current=await relaunchApp();}
  }
  await testInfo.attach('ppv2-token-deposit-report',{body:JSON.stringify(report,null,2),contentType:'application/json'});
  expect(report[0]).toMatchObject({kind:'ppv2-token-approval',approvalAmount:'0',depositRefused:true,productionGate:false});
  expect(report[1]).toMatchObject({blocked:true,journalCount:3,approvalAmount:'10100'});
  expect(report[2]).toMatchObject({blocked:true,noApproval:true,kind:'ppv2-token-deposit',tokenBound:true,
    amount:'10000',fee:'100',value:'0',proofVerified:true});
  expect(report[3]).toMatchObject({blocked:true,journalCount:5,balance:'19900',allowance:'0',
    guardedCacheRestored:true,rescanRecovered:true,sends:1,exitKind:'ppv2-token-ragequit',exitProofVerified:true,exitStatus:'exited'});
  expect(report[3].notes).toEqual([{amount:'10000',token:`0x${'55'.repeat(20)}`,status:'pending'}]);
});
