'use strict';

// Explicit opt-in qualification against an already-running LOCAL Anvil fork.
// Never connects a real wallet or broadcasts to the fork's upstream RPC.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { JsonRpcProvider, Interface, toQuantity } = require('ethers');
const { DomainChain } = require('../src/main/domains/chain');
const { DomainService } = require('../src/main/domains/service');
const { DomainOperationStore } = require('../src/main/domains/operation-store');
const { DomainTransactions } = require('../src/main/wallet/domain-transactions');
const { ADDRESSES, parseName, swarmContenthash, registrationTuple, commitmentFor } = require('../src/main/domains/contracts');

async function qualify() {
  const url = new URL(process.env.FREEDOM_DOMAIN_FORK_URL || 'http://127.0.0.1:18549');
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  const provider = new JsonRpcProvider(url.href, 1, { staticNetwork: true });
  try {
    assert.match(await provider.send('web3_clientVersion', []), /anvil/i);
    await provider.send('anvil_nodeInfo', []);
    const address = '0x000000000000000000000000000000000000dEaD';
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
    const chain = new DomainChain({ request: (method, params) => provider.send(method, params) });
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
    const options = { store: new DomainOperationStore({ directory, safeStorage }), chain, wallet, executeWaitMs: 0,
      getPublication: async () => ({ publicationId, reference, state: 'completed', verified: true, indexDocument: 'index.html' }),
      // The reference is synthetic; no actual public site is claimed.
      verifyResolution: async () => false };
    let service = new DomainService(options);
    let approvals = 0;
    const context = { conversationId: 'owned-fork-fixture', requestApproval: async request => {
      assert.equal(request.action, 'wallet_transaction'); assert.equal(request.wallet.chainId, 1);
      assert.match(request.inputPreview, /freedom-fixture-/); approvals++; return 'approved'; } };
    const label = `freedom-fixture-${crypto.randomBytes(6).toString('hex')}`;
    for (const namespace of ['eth', 'wei', 'gwei']) {
      const name = `${label}.${namespace}`;
      const before = sent;
      const prepared = await service.prepare({ name, intent: 'register' }, context);
      assert.equal(prepared.state, 'ready');
      let receipt = await service.execute(prepared.operationId, context);
      assert.equal(receipt.state, 'waiting_commitment');
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
      receipt = await service.execute(prepared.operationId, context);
      assert.equal(receipt.state, 'completed');
      assert.equal(sent - before, 2);
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
        const result = await service.execute(plan.operationId, context);
        assert.equal(result.state, 'completed', `${namespace}: ${change.intent}: ${JSON.stringify(result)}`);
        if (change.intent === 'set_website') {
          assert.equal(result.resolutionVerified, false);
          const updated = await service.inspect({ name, textKeys: ['description'] });
          assert.equal(updated.records.contenthash, swarmContenthash(reference));
          assert.equal(updated.records.text.description, 'Owned local fork fixture');
        }
      }
      // Replay of a completed operation observes; it cannot sign a second time.
      const sentBeforeReplay = sent;
      await service.execute(prepared.operationId, context);
      assert.equal(sent, sentBeforeReplay);
      console.log(JSON.stringify({ namespace, registration: 'confirmed', restart: 'recovered', renewal: 'verified',
        addressTextWebsite: 'verified', replay: 'no second send', transactions: sent - before }));
    }
    // Compare the local tuple commitment with the deployed pinned contract on
    // the private fork only; never leak a real preimage to a public RPC.
    const parsed = parseName(`${label}-vector.eth`);
    const vector = { ...parsed, account, duration: 31536000 };
    const dummySecret = `0x${'42'.repeat(32)}`;
    assert.equal((await chain.call('controller', 'makeCommitment', [registrationTuple(vector, dummySecret)], await chain.snapshot()))[0], commitmentFor(vector, dummySecret));
    // Create one wrapped name using the legacy controller on this private fork
    // to qualify the distinct renewal path without enabling legacy registration.
    const legacy = new Interface([
      'function makeCommitment(string,address,uint256,bytes32,address,bytes[],bool,uint16) pure returns(bytes32)',
      'function commit(bytes32)', 'function register(string,address,uint256,bytes32,address,bytes[],bool,uint16) payable',
    ]);
    const wrappedLabel = `${label}-wrapped`;
    const wrappedSecret = `0x${crypto.randomBytes(32).toString('hex')}`;
    const legacyArgs = [wrappedLabel, address, 31536000, wrappedSecret, ADDRESSES.resolver, [], false, 0];
    const legacyCall = async (method, args, value = 0n) => {
      const tx = { from: address, to: ADDRESSES.wrappedController, data: legacy.encodeFunctionData(method, args), value: toQuantity(value) };
      const gas = BigInt(await provider.send('eth_estimateGas', [tx])) * 120n / 100n;
      const txHash = await provider.send('eth_sendTransaction', [{ ...tx, gas: toQuantity(gas) }]);
      assert.equal((await provider.send('eth_getTransactionReceipt', [txHash])).status, '0x1');
    };
    const rawCommitment = await provider.send('eth_call', [{ to: ADDRESSES.wrappedController, data: legacy.encodeFunctionData('makeCommitment', legacyArgs) }, 'latest']);
    const [legacyCommitment] = legacy.decodeFunctionResult('makeCommitment', rawCommitment);
    await legacyCall('commit', [legacyCommitment]);
    await provider.send('evm_increaseTime', [61]); await provider.send('evm_mine', []);
    const [wrappedPrice] = await chain.call('wrappedController', 'rentPrice', [wrappedLabel, 31536000], await chain.snapshot());
    await legacyCall('register', legacyArgs, wrappedPrice.base + wrappedPrice.premium);
    const wrappedName = `${wrappedLabel}.eth`;
    const wrappedBefore = await service.inspect({ name: wrappedName });
    assert.equal(wrappedBefore.wrapped, true);
    const wrappedPlan = await service.prepare({ name: wrappedName, intent: 'renew' }, context);
    const wrappedResult = await service.execute(wrappedPlan.operationId, context);
    assert.equal(wrappedResult.state, 'completed');
    const wrappedAfter = await service.inspect({ name: wrappedName });
    assert.equal(BigInt(wrappedAfter.wrapperExpiry), BigInt(wrappedBefore.wrapperExpiry) + 31536000n);
    assert.equal(wrappedAfter.owner, wrappedBefore.owner);
    console.log(JSON.stringify({ wrappedRenewal: 'verified', baseAndWrapperExpiry: 'extended', owner: 'preserved' }));
    service.close();
    assert.equal(approvals, sent);
    console.log(JSON.stringify({ passed: true, approvals, sent, directory, note: 'Local Anvil only; synthetic publication; no live spend or public website qualification.' }));
  } finally { provider.destroy(); }
}
qualify().catch(error => { console.error(error.message); process.exitCode = 1; });
