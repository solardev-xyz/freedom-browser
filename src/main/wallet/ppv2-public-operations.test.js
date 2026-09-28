jest.mock('../identity/vault', () => ({ getMnemonic: () => 'test test test test test test test test test test test junk',
  getSessionSignal: () => mockVault.signal }));
jest.mock('../profile-resolver', () => ({ getActiveProfile: () => mockProfile }));
jest.mock('../networks/chain-data-router', () => ({ request: jest.fn(), broadcastRawTransaction: jest.fn() }));
jest.mock('../networks/private-rpc', () => ({ ...jest.requireActual('../networks/private-rpc'), createPrivateRpc: (handle) => ({
  signal: mockVault.signal, assertActive: () => require('../networks/privacy-context').getPrivacyContext(handle),
  ready: async () => {}, request: mockRequest,
}) }));
const fs = require('fs'), os = require('os'), path = require('path');
const { createHash } = require('crypto');
const { Wallet, Interface, Transaction } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2PublicOperations, REGISTRATION_ABI } = require('./ppv2-public-operations');
const { configuration } = require('../../../test/helpers/ppv2-session-fixture');
const { transactionIntent } = require('./private-transaction-intent');
const wallet = Wallet.fromPhrase('test test test test test test test test test test test junk');
const iface = new Interface(REGISTRATION_ABI);
let mockVault, mockProfile, scope, operations, config, receipts, nonce, lost, sent, signer, registered;
const mockRequest = jest.fn();
const blockHash = `0x${'c'.repeat(64)}`;
function open(tokenPolicy) {
  scope = createPrivacyScope({ signal: mockVault.signal, profileId: createHash('sha256')
    .update(JSON.stringify([mockProfile.id, mockProfile.userDataDir])).digest('hex') });
  operations = createPPv2PublicOperations({ scope, configuration: config, tokenPolicy,
    provider: { call: async () => `0x${(registered ? '1' : '0').padStart(64, '0')}` } });
}
function registration() {
  return { __type: 'publicOperation', txs: [
    { to: config.deployment.keystoreAddress, value: 0n, data: iface.encodeFunctionData('setAuthPolicy', [1n, 2n]) },
    { to: config.deployment.keystoreAddress, value: 0n, data: iface.encodeFunctionData('setViewingKey', [`0x${'ab'.repeat(32)}`]) },
  ] };
}
const options = (extra = {}) => ({ signer, gasLimit: 100000n, maxGasFee: 10000000n, review: async () => true, ...extra });
const resolve = (hash) => operations.resolve(hash, { minimumConfirmations: 2,
  review: async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }) });
function mine(hash, status = '0x1') {
  receipts.set(hash, { transactionHash: hash, from: wallet.address, blockHash, blockNumber: '0x10', status });
}
beforeEach(() => {
  mockVault = new AbortController(); mockProfile = { id: 'fixture', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-handoff-')) };
  config = configuration(); config.ownerAddress = wallet.address;
  receipts = new Map(); nonce = 0; lost = false; registered = true; sent = [];
  signer = { getAddress: async () => wallet.address, signTransaction: jest.fn((tx) => wallet.signTransaction(tx)) };
  mockRequest.mockReset().mockImplementation(async (method, params, validate) => {
    let result;
    if (method === 'eth_call') result = '0x';
    else if (method === 'eth_gasPrice') result = '0x64';
    else if (method === 'eth_getTransactionCount') result = `0x${nonce.toString(16)}`;
    else if (method === 'eth_getTransactionReceipt') result = receipts.get(params[0]) || null;
    else if (method === 'eth_getTransactionByHash') result = null;
    else if (method === 'eth_blockNumber') result = '0x11';
    else if (method === 'eth_getBlockByNumber') result = { number: '0x10', hash: blockHash };
    else if (method === 'eth_sendRawTransaction') {
      const tx = Transaction.from(params[0]); result = tx.hash; sent.push(tx); nonce++;
      if (lost) throw new Error('controlled lost response');
    } else throw new Error('Unexpected RPC');
    if (!validate(result)) throw new Error('Invalid fixture response');
    return { result };
  });
  open();
});
afterEach(() => { scope.close(); mockVault.abort(); });

test('registration is canonical, immutable, ordered and limited to the configured keystore', () => {
  const operation = operations.registration(registration());
  expect(Object.isFrozen(operation.txs[0])).toBe(true);
  for (const modify of [
    (v) => v.txs.reverse(), (v) => v.txs.push(v.txs[0]), (v) => { v.txs[0].to = wallet.address; },
    (v) => { v.txs[0].value = 1n; }, (v) => { v.txs[0].data += '00'; },
    (v) => { v.txs[0].data = iface.encodeFunctionData('setAuthPolicy', [0n, 1n]); },
    (v) => { v.txs[0] = v.txs[1]; },
  ]) {
    const bad = registration(); modify(bad); expect(() => operations.registration(bad)).toThrow();
  }
});

test('requires review, provenance, correct sender, fee cap and one use per prepared step', async () => {
  const plan = operations.registration(registration());
  await expect(operations.submit({ ...plan }, options())).rejects.toThrow();
  await expect(operations.submit(plan, options({ review: undefined }))).rejects.toThrow();
  await expect(operations.submit(plan, options({ step: 1 }))).rejects.toThrow();
  const review = jest.fn(async () => true);
  await expect(operations.submit(plan, options({ maxGasFee: 1n, review }))).rejects.toThrow();
  expect(review).not.toHaveBeenCalled(); expect(signer.signTransaction).not.toHaveBeenCalled();
  await expect(operations.submit(plan, options())).rejects.toThrow();
  const wrong = { ...signer, getAddress: async () => config.deployment.keystoreAddress };
  await expect(operations.submit(operations.registration(registration()), options({ signer: wrong })))
    .rejects.toMatchObject({ code: 'PRIVATE_SIGNER_MISMATCH' });
  expect(sent).toHaveLength(0);
});

test('submits only the reviewed step and persists its intent before transport; second step needs reviewed inclusion', async () => {
  const plan = operations.registration(registration());
  let reviewed;
  const first = await operations.submit(plan, options({ review: async (value) => { reviewed = value; return true; } }));
  expect(reviewed).toMatchObject({ operation: 'ppv2-register-auth', step: 0, steps: 2, chainStateVerified: false });
  expect(reviewed.intent).toEqual(transactionIntent(plan.txs[0].kind, plan.txs[0]));
  expect(sent).toHaveLength(1);
  expect((await operations.list())[0]).toMatchObject({ hash: first.hash, intent: reviewed.intent });
  await expect(operations.submit(plan, options({ step: 1 }))).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  mine(first.hash); await operations.observe(first.hash);
  await expect(operations.submit(plan, options({ step: 1 }))).rejects.toThrow();
  await resolve(first.hash);
  const second = await operations.submit(plan, options({ step: 1 }));
  expect(sent).toHaveLength(2); expect(second.nonce).toBe(1);
  expect((await operations.list())[1].intent.kind).toBe('ppv2-register-viewing');
});

test('reverted or reorged authorization cannot release the viewing-key step', async () => {
  const plan = operations.registration(registration());
  const first = await operations.submit(plan, options()); mine(first.hash, '0x0'); await resolve(first.hash);
  await expect(operations.submit(plan, options({ step: 1 }))).rejects.toThrow();
  mine(first.hash); await resolve(first.hash); receipts.clear();
  await expect(operations.submit(plan, options({ step: 1 }))).rejects.toThrow();
  expect(sent).toHaveLength(1);
});

test('lost broadcast survives restart and blocks fresh preparation until explicit reconciliation', async () => {
  lost = true;
  const failure = await operations.submit(operations.registration(registration()), options()).catch((e) => e);
  expect(failure.code).toBe('PRIVATE_BROADCAST_UNCERTAIN');
  scope.close(); open(); lost = false;
  const restored = await operations.list();
  expect(restored[0]).toMatchObject({ hash: failure.transactionHash, state: 'attempted', intent: { kind: 'ppv2-register-auth' } });
  await expect(operations.submit(operations.registration(registration()), options())).rejects.toThrow();
  mine(failure.transactionHash); await resolve(failure.transactionHash);
  // Fresh SDK preparation after re-reading partial registration contains only
  // the missing viewing-key call. There is no batch replay or automatic retry.
  const partial = registration(); partial.txs.shift();
  const second = await operations.submit(operations.registration(partial), options());
  expect(second.nonce).toBe(1); expect(sent).toHaveLength(2);
});

test('lock during review refuses signing and a late review cannot revive the operation', async () => {
  let finish;
  const pending = operations.submit(operations.registration(registration()), options({ review: () => new Promise((resolve) => { finish = resolve; }) }));
  while (!finish) await new Promise(setImmediate);
  mockVault.abort();
  await expect(pending).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  finish(true); await new Promise(setImmediate);
  expect(signer.signTransaction).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
});

test('prepared deposit preserves exact value/calldata and separates protocol fees from gas budget', async () => {
  const deposit = operations.deposit(Object.freeze({ kind: 'ppv2-native-deposit', chainId: 11155111,
    from: wallet.address, to: config.deployment.entrypointAddress, value: 10100n, amount: 10000n, fee: 100n,
    data: '0xabcd', proofVerified: true, chainStateVerified: false }));
  let review;
  registered = false;
  await expect(operations.submit(deposit, options())).rejects.toThrow();
  expect(sent).toHaveLength(0);
  registered = true;
  await operations.submit(deposit, options({ review: async (v) => { review = v; return true; } }));
  expect(review).toMatchObject({ protocolFee: 100n, maxGasFee: 10000000n, proofVerified: true, chainStateVerified: false });
  expect(sent[0].value).toBe(10100n); expect(sent[0].data).toBe('0xabcd');
});

test('preparation expiration and explicit rejection prevent signing', async () => {
  const plan = operations.registration(registration());
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
  await expect(operations.submit(plan, options())).rejects.toThrow(); clock.mockRestore();
  await expect(operations.submit(operations.registration(registration()), options({ review: async () => false })))
    .rejects.toMatchObject({ code: 'PRIVATE_REVIEW_REJECTED' });
  expect(signer.signTransaction).not.toHaveBeenCalled(); expect(sent).toHaveLength(0);
});

test('intent is durable before transport sees signed bytes and cannot be changed by a signer', async () => {
  const reply = mockRequest.getMockImplementation();
  let durableBeforeTransport = false;
  mockRequest.mockImplementation(async (method, params, validate) => {
    if (method === 'eth_sendRawTransaction') {
      const records = await operations.list();
      durableBeforeTransport = records[0]?.hash === Transaction.from(params[0]).hash && records[0]?.intent.kind === 'ppv2-register-auth';
    }
    return reply(method, params, validate);
  });
  signer.signTransaction.mockImplementation((tx) => wallet.signTransaction({ ...tx, to: wallet.address }));
  await expect(operations.submit(operations.registration(registration()), options()))
    .rejects.toMatchObject({ code: 'PRIVATE_SIGNED_INTENT_MISMATCH' });
  expect(await operations.list()).toEqual([]);
  signer.signTransaction.mockImplementation((tx) => wallet.signTransaction(tx));
  await operations.submit(operations.registration(registration()), options());
  expect(durableBeforeTransport).toBe(true);
});

test('native ragequit review exposes its full note amount and uses the public submission journal', async () => {
  registered = false; // Publishing a viewing key is not a prerequisite for exit.
  const prepared = Object.freeze({ kind: 'ppv2-native-ragequit', chainId: 11155111, from: wallet.address,
    to: config.deployment.poolAddress, value: 0n, data: '0xabcd', amount: 10000n, fee: 0n,
    commitment: `0x${'7'.padStart(64, '0')}`, proofVerified: true, chainStateVerified: false });
  expect(() => operations.ragequit(Object.freeze({ ...prepared, value: 1n }))).toThrow();
  expect(() => operations.ragequit(Object.freeze({ ...prepared, to: wallet.address }))).toThrow();
  let review;
  await operations.submit(operations.ragequit(prepared), options({ review: async (v) => { review = v; return true; } }));
  expect(review).toMatchObject({ operation: 'ppv2-native-ragequit', amount: 10000n, noteCommitment: prepared.commitment,
    protocolFee: 0n, chainStateVerified: false });
  expect(sent[0].value).toBe(0n); expect((await operations.list())[0].intent.kind).toBe('ppv2-native-ragequit');
});

function tokenOperations() {
  const { createPPv2TokenPolicy, TOKEN_ABI } = require('./ppv2-token-policy');
  const token=`0x${'55'.repeat(20)}`, tokenABI=new Interface(TOKEN_ABI);
  const assetABI=new Interface(['function assets(address) view returns(tuple(bool,uint256,uint256,uint256))']);
  const state={allowance:1n,fee:100n};
  config.erc20Tokens=[token]; config.contracts.push({address:token});
  const policy=createPPv2TokenPolicy({configuration:config,provider:{call:async({to,data})=>{
    if(to===config.deployment.entrypointAddress)return assetABI.encodeFunctionResult('assets',[[true,1n,state.fee,0n]]);
    const call=tokenABI.parseTransaction({data});return tokenABI.encodeFunctionResult(call.name,[call.name==='allowance'?state.allowance:20000n]);
  }}});
  scope.close(); open(policy);
  return {state,intent:{token,amount:10000n,maxFee:100n}};
}
test('zero-reset approval requires durable reconciliation before exact replacement before the next reviewed operation', async () => {
  const {state,intent}=tokenOperations();
  const reset=await operations.tokenApproval(intent);
  const result=await operations.submit(reset,options());
  expect(sent).toHaveLength(1); expect(reset.approvalAmount).toBe(0n);
  expect((await operations.list())[0].intent.kind).toBe('ppv2-token-approval');
  state.allowance=0n;
  await expect(operations.submit(await operations.tokenApproval(intent),options())).rejects.toThrow();
  mine(result.hash); await resolve(result.hash);
  const approval=await operations.tokenApproval(intent);
  expect(approval.approvalAmount).toBe(10100n);
  const approved=await operations.submit(approval,options());
  expect(sent).toHaveLength(2); expect(approved.hash).toBeTruthy();
});
test.each(['allowance','fee','simulation'])('refuses token changes during review or simulation: %s', async change => {
  const {state,intent}=tokenOperations();
  const prepared=await operations.tokenApproval(intent);
  if(change==='simulation') {
    const normal=mockRequest.getMockImplementation();
    mockRequest.mockImplementation((method,params,valid)=>method==='eth_call'?Promise.resolve({result:`0x${'0'.repeat(64)}`}):normal(method,params,valid));
  }
  await expect(operations.submit(prepared,options({review:async()=>{
    if(change==='allowance')state.allowance=0n;
    if(change==='fee')state.fee=99n;
    return true;
  }}))).rejects.toThrow();
  expect(sent).toHaveLength(0); expect(signer.signTransaction).not.toHaveBeenCalled();
});
