'use strict';

// Explicit opt-in qualification against an already-running LOCAL Anvil fork.
// Never connects a real wallet or broadcasts to the fork's upstream RPC.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { JsonRpcProvider, Contract, Interface, AbiCoder, dnsEncode, keccak256, toQuantity, getAddress } = require('ethers');
const { DomainChain } = require('../src/main/domains/chain');
const { DomainService } = require('../src/main/domains/service');
const { DomainOperationStore } = require('../src/main/domains/operation-store');
const { LEGACY_WRAPPER_GRACE } = require('../src/main/domains/ens-v2');
const { DomainTransactions } = require('../src/main/wallet/domain-transactions');
const { parseName, swarmContenthash, ABI, ZeroAddress, ZeroHash, commitmentFor } = require('../src/main/domains/contracts');

async function qualify() {
  const url = new URL(process.env.FREEDOM_DOMAIN_FORK_URL || 'http://127.0.0.1:18549');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  const provider = new JsonRpcProvider(url.href, 1, { staticNetwork: true });
  try {
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
    await provider.send('anvil_nodeInfo', []);
    const address = getAddress(`0x${crypto.randomBytes(20).toString('hex')}`);
    await provider.send('anvil_impersonateAccount', [address]);
    await provider.send('anvil_setBalance', [address, toQuantity(10n ** 23n)]);
    const account = { index: 0, name: 'Disposable fork fixture', type: 'mnemonic', address };
    const key = crypto.randomBytes(32);
    const safeStorage = { isEncryptionAvailable: () => true,
      encryptString: text => { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
      decryptString: bytes => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(); } };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-domain-fork-'));
    // Optional official testnet deployment overrides are for this local fork
    // qualifier only. They are never accepted by an Agent or wallet request.
    const deployments = process.env.FREEDOM_DOMAIN_FORK_DEPLOYMENTS
      ? JSON.parse(fs.readFileSync(process.env.FREEDOM_DOMAIN_FORK_DEPLOYMENTS, 'utf8')) : {};
    const chain = new DomainChain({ ...deployments, request: (method, params) => provider.send(method, params) });
    // Seed only the disposable account's ERC20 balance in Anvil storage. No
    // real holder is impersonated and no upstream transaction is possible.
    const seedToken = async (role, amount) => {
      for (let index = 0; index < 40; index++) {
        const slot = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, index]));
        const before = await provider.send('eth_getStorageAt', [chain.addresses[role], slot, 'latest']);
        await provider.send('anvil_setStorageAt', [chain.addresses[role], slot, `0x${amount.toString(16).padStart(64, '0')}`]);
        const [balance] = await chain.call(role, 'balanceOf', [address], await chain.snapshot());
        if (balance === amount) return;
        await provider.send('anvil_setStorageAt', [chain.addresses[role], slot, before]);
      }
      throw new Error(`Could not seed the local ${role} fixture balance`);
    };
    await seedToken('usdc', 1000000000n);
    await seedToken('dai', 1000n * 10n ** 18n);
    let sent = 0;
    const wallet = new DomainTransactions({ identityManager: { getActiveWalletIndex: () => 0, getDerivedWallets: async () => [account] },
      estimateGas: async tx => ({ gasLimit: ((await provider.estimateGas(tx)) * 120n / 100n).toString() }),
      getGasPrices: async () => { const fees = await provider.getFeeData(); return { type: 'eip1559', maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString() }; },
      balance: async () => 10n ** 23n, getSigner: () => ({}),
      signAndRecord: async tx => {
        sent++;
        const wire = { from: address, to: tx.to, data: tx.data, value: toQuantity(BigInt(tx.value)), gas: toQuantity(BigInt(tx.gasLimit)),
          maxFeePerGas: toQuantity(BigInt(tx.maxFeePerGas)), maxPriorityFeePerGas: toQuantity(BigInt(tx.maxPriorityFeePerGas)) };
        return { hash: await provider.send('eth_sendTransaction', [wire]) };
      } });
    const publicationId = `swarm_pub_${'ab'.repeat(12)}`;
    const reference = '12'.repeat(32);
    const options = { store: new DomainOperationStore({ directory, safeStorage }), chain, wallet, executeWaitMs: 30000, pollMs: 100,
      getPublication: async () => ({ publicationId, reference, state: 'completed', verified: true, public: true, target: 'public', indexDocument: 'index.html' }),
      // The reference is synthetic; no actual public site is claimed.
      verifyResolution: async () => false };
    let service = new DomainService(options);
    let approvals = 0;
    const context = { conversationId: 'owned-fork-fixture', requestApproval: async request => {
      assert.equal(request.action, 'wallet_transaction'); assert.equal(request.wallet.chainId, 1);
      assert.ok(request.wallet.domain?.name.endsWith('.eth') || /freedom-fixture-/.test(request.inputPreview)); approvals++; return 'approved'; } };
    const label = `freedom-fixture-${crypto.randomBytes(6).toString('hex')}`;
    const finish = async plan => {
      let result = plan;
      for (let step = 0; step < 8 && result.state !== 'completed'; step++) {
        if (result.state === 'waiting_commitment') {
          await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
          result = await service.status({ operationId: result.operationId });
        }
        assert.equal(result.state, 'ready', JSON.stringify(result));
        result = await service.execute(result.operationId, context);
      }
      assert.equal(result.state, 'completed', JSON.stringify(result));
      return result;
    };
    for (const namespace of deployments.namespaces || ['eth', 'wei', 'gwei']) {
      const name = `${label}.${namespace}`;
      const before = sent;
      const prepared = await service.prepare({ name, intent: 'register' }, context);
      assert.equal(prepared.state, 'ready');
      let receipt = await service.execute(prepared.operationId, context);
      assert.ok(['waiting_commitment', 'ready'].includes(receipt.state), JSON.stringify(receipt));
      const secret = options.store.revealSecret(options.store.get(prepared.operationId));
      assert.ok(!JSON.stringify(receipt).includes(secret));
      assert.ok(!fs.readFileSync(options.store.filename, 'utf8').includes(secret));
      // Simulate restart while waiting: recover from the disk journal, not chat.
      service.close();
      options.store = new DomainOperationStore({ directory, safeStorage });
      service = new DomainService(options);
      await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
      receipt = await service.status({ operationId: prepared.operationId });
      assert.equal(receipt.state, 'ready');
      receipt = await finish(receipt);
      assert.ok(sent - before >= 2);
      assert.equal(options.store.get(prepared.operationId).encryptedSecret, undefined);
      const state = await service.inspect({ name });
      assert.equal(state.owner, address);
      for (const change of [
        { intent: 'renew' },
        { intent: 'set_text', key: 'description', value: 'Owned local fork fixture' },
        { intent: 'set_address', address },
        { intent: 'set_website', publicationId },
        { intent: 'clear_website' },
      ]) {
        const plan = await service.prepare({ name, ...change }, context);
        const result = await finish(plan);
        assert.equal(result.state, 'completed', `${namespace}: ${change.intent}: ${JSON.stringify(result)}`);
        if (change.intent === 'set_website') {
          assert.equal(result.resolutionVerified, false);
          const updated = await service.inspect({ name, textKeys: ['description'] });
          assert.equal(updated.records.contenthash, swarmContenthash(reference));
          assert.equal(updated.records.text.description, 'Owned local fork fixture');
          if (namespace === 'eth' && deployments.universalResolver !== false) {
            // Same DAO-owned Universal Resolver used by ens-resolver.js (#352).
            // Prove the new permissioned resolver is reached through that path,
            // not only through the naming adapter's direct inspection.
            const universal = new Contract('0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
              ['function resolve(bytes,bytes) view returns(bytes,address)'], provider);
            const [resolved] = await universal.resolve(dnsEncode(name, 255), ABI.resolver.encodeFunctionData('contenthash', [parseName(name).node]));
            assert.equal(ABI.resolver.decodeFunctionResult('contenthash', resolved)[0], swarmContenthash(reference));
            console.log(JSON.stringify({ universalResolver: 'new ENSv2 Swarm contenthash resolved' }));
          }
        }
      }
      // Replay of a completed operation observes; it cannot sign a second time.
      const sentBeforeReplay = sent;
      await service.execute(prepared.operationId, context);
      assert.equal(sent, sentBeforeReplay);
      console.log(JSON.stringify({ namespace, registration: 'confirmed', restart: 'recovered', renewal: 'verified',
        addressTextWebsite: 'verified', replay: 'no second send', transactions: sent - before }));
    }
    // Compare a synthetic commitment with the official registrar only on the
    // fork. Actual operation secrets never leave the trusted signing path.
    const parsed = parseName(`${label}-vector.eth`);
    const vector = { ...parsed, protocol: 'ensv2', account, duration: 31536000, ensResolver: ZeroAddress };
    const dummySecret = `0x${'42'.repeat(32)}`;
    assert.equal((await chain.call('ensRegistrar', 'makeCommitment', [vector.label, address, dummySecret,
      ZeroAddress, ZeroAddress, 31536000, ZeroHash], await chain.snapshot()))[0], commitmentFor(vector, dummySecret));
    const daiName = `${label}-dai.eth`;
    await finish(await service.prepare({ name: daiName, intent: 'register', paymentToken: 'DAI' }, context));
    await finish(await service.prepare({ name: daiName, intent: 'renew', paymentToken: 'DAI' }, context));
    assert.equal((await service.inspect({ name: daiName })).owner, address);
    console.log(JSON.stringify({ dai: 'registration and renewal verified', commitmentVector: 'matches deployed registrar' }));
    // Renew existing legacy names on the private fork. Their real owners and
    // records are untouched on Ethereum. No deauthorized v1 registration.
    if (!deployments.legacyNames) {
      // Create a wrapped LEGACY fixture locally by wrapping a forked v1 name.
      // These sends are guarded by the local-Anvil checks above. No real owner
      // key, wallet or upstream broadcast is involved.
      const legacy = await service.inspect({ name: 'wrapped.eth' });
      assert.equal(legacy.ensVersion, 1);
      if (!legacy.wrapped) {
        await provider.send('anvil_impersonateAccount', [legacy.owner]);
        await provider.send('anvil_setBalance', [legacy.owner, toQuantity(10n ** 21n)]);
        for (const [to, signature, method, args] of [
          [chain.addresses.base, 'function approve(address,uint256)', 'approve', [chain.addresses.wrapper, legacy.tokenId]],
          [chain.addresses.wrapper, 'function wrapETH2LD(string,address,uint16,address)', 'wrapETH2LD', [legacy.label, legacy.owner, 0, chain.addresses.resolver]],
        ]) {
          const hash = await provider.send('eth_sendTransaction', [{ from: legacy.owner, to,
            data: new Interface([signature]).encodeFunctionData(method, args), gas: '0x180000' }]);
          assert.equal((await provider.waitForTransaction(hash)).status, 1);
        }
        await provider.send('anvil_stopImpersonatingAccount', [legacy.owner]);
      }
    }
    for (const name of deployments.legacyNames || ['vitalik.eth', 'wrapped.eth']) {
      const before = await service.inspect({ name });
      assert.equal(before.ensVersion, 1);
      const result = await finish(await service.prepare({ name, intent: 'renew' }, context));
      assert.equal(result.state, 'completed');
      const after = await service.inspect({ name });
      assert.equal(after.owner, before.owner);
      assert.equal(after.manager, before.manager);
      assert.equal(BigInt(after.expiry), BigInt(before.expiry) + 31536000n);
      assert.deepEqual(after.records, before.records);
      if (before.wrapped) assert.equal(BigInt(after.wrapperExpiry), BigInt(after.expiry) + LEGACY_WRAPPER_GRACE);
      console.log(JSON.stringify({ legacyName: name, wrapped: before.wrapped, renewal: 'verified', ownerManagerRecords: 'preserved' }));
    }
    service.close();
    assert.equal(approvals, sent);
    console.log(JSON.stringify({ passed: true, approvals, sent, directory, note: 'Local Anvil only; synthetic publication; no live spend or public website qualification.' }));
  } finally { provider.destroy(); }
}
qualify().catch(error => { console.error(error.message); process.exitCode = 1; });
