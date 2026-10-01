jest.mock('../settings-store', () => ({ isWalletTorExperimentAvailable: () => true }));
jest.mock('../tor-manager', () => ({ getWalletSocksEndpoint: () => mockEndpoint }));
jest.mock('../networks/network-registry', () => ({ getNetwork: () => ({}), getEndpoints: () => ['https://rpc.example'], getEndpointSources: () => [{ keyed: false, coverage: { '11155111': 'https://rpc.example' } }] }));
jest.mock('../networks/wallet-tor-transport', () => ({ createWalletTorTransport: () => ({ request: mockRequest }) }));
jest.mock('../networks/chain-data-router', () => ({ request: jest.fn(), broadcastRawTransaction: jest.fn(), getFeeQuote: jest.fn() }));
jest.mock('./private-submission-journal', () => ({ getPrivateSubmissionJournal: (context) => mockJournals.get(context) }));
const mockJournals = new WeakMap();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSubmissionJournal } = jest.requireActual('./private-submission-journal');
const mockRequest = jest.fn();
let mockEndpoint;
const { Wallet, Transaction } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { getPrivateTransactionNetwork } = require('./private-transaction-network');
const service = require('./transaction-service');
const chainData = require('../networks/chain-data-router');
const wallet = new Wallet(`0x${'1'.repeat(64)}`); // Public synthetic fixture only.
const params = { chainId: 11155111, to: `0x${'2'.repeat(40)}`, value: '1', gasLimit: '21000' };
let scope, handle, network, tor, journalDirectory;
let requests;
let receipt, canonical;
let nonce;
let responseHook;
let signer;
beforeEach(() => {
  jest.clearAllMocks();
  tor = new AbortController(); mockEndpoint = { signal: tor.signal };
  scope = createPrivacyScope({ profileId: 'test', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'public-address', principal: wallet.address, chainId: 11155111, role: 'transaction-rpc' });
  journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-send-fixture-'));
  mockJournals.set(handle, createSubmissionJournal({ handle, directory: journalDirectory, key: Buffer.alloc(32, 3) }));
  network = getPrivateTransactionNetwork(handle);
  canonical = { number: '0x10', hash: `0x${'c'.repeat(64)}` };
  requests = []; receipt = null; nonce = '0x0'; responseHook = null;
  signer = { getAddress: async () => wallet.address, signTransaction: jest.fn((tx) => wallet.signTransaction(tx)) };
  mockRequest.mockImplementation(async (context, _url, options) => {
    expect(context).toBe(handle);
    const call = JSON.parse(options.body); requests.push(call);
    if (responseHook) await responseHook(call);
    const result = { eth_chainId: '0xaa36a7', eth_gasPrice: '0x64', eth_getTransactionCount: nonce,
      eth_estimateGas: '0x5208', eth_call: '0x', eth_getTransactionReceipt: receipt, eth_getTransactionByHash: null,
      eth_getBlockByNumber: canonical, eth_blockNumber: '0x11' }[call.method];
    return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id,
      result: call.method === 'eth_sendRawTransaction' ? Transaction.from(call.params[0]).hash : result })) };
  });
});
afterEach(() => { scope.close(); tor.abort(); });

test('fees, gas, simulation, nonce, signing, submission and receipts use only the context route', async () => {
  const options = { privacyContext: handle, review: async () => true };
  expect(await service.estimateGas({ ...params, from: wallet.address }, options)).toEqual({ gasLimit: '25200' });
  await network.request(11155111, 'eth_call', [{ from: wallet.address, to: params.to, value: '0x1' }, 'latest']);
  const sent = await service.signAndSendTransaction(params, signer, options);
  receipt = { transactionHash: sent.hash, from: wallet.address, blockHash: `0x${'c'.repeat(64)}`, status: '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x64' };
  expect(await service.waitForTransaction(sent.hash, 11155111, 2, options)).toMatchObject({ status: 'included', blockNumber: 16, confirmations: 2, verified: false });
  expect(requests.map((r) => r.method)).toEqual(['eth_chainId', 'eth_estimateGas', 'eth_call', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_sendRawTransaction', 'eth_getTransactionReceipt', 'eth_getBlockByNumber', 'eth_blockNumber']);
  expect(chainData.request).not.toHaveBeenCalled();
  expect(chainData.broadcastRawTransaction).not.toHaveBeenCalled();
});

test('signers that broadcast through their own RPC are rejected before network or device interaction', async () => {
  signer.sendTransaction = jest.fn();
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true })).rejects.toMatchObject({ code: 'PRIVATE_REMOTE_BROADCAST_UNSUPPORTED' });
  expect(mockRequest).not.toHaveBeenCalled(); expect(signer.sendTransaction).not.toHaveBeenCalled();
});

test('changed signer output and lock during signing never reach broadcast', async () => {
  signer.signTransaction.mockImplementation((tx) => wallet.signTransaction({ ...tx, value: '2' }));
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true })).rejects.toMatchObject({ code: 'PRIVATE_SIGNED_INTENT_MISMATCH' });
  signer.signTransaction.mockImplementation(async (tx) => { scope.close(); return wallet.signTransaction(tx); });
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true })).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(requests.some((r) => r.method === 'eth_sendRawTransaction')).toBe(false);
});

test('a lost broadcast response preserves deterministic hash and refuses a duplicate attempt', async () => {
  let signed;
  responseHook = async (call) => { if (call.method === 'eth_sendRawTransaction') { signed = call.params[0]; throw new Error('response lost'); } };
  const error = await service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true }).catch((error) => error);
  expect(error).toMatchObject({ code: 'PRIVATE_BROADCAST_UNCERTAIN', submissionStatus: 'unknown', transactionHash: Transaction.from(signed).hash });
  await expect(network.broadcastRawTransaction(11155111, signed)).rejects.toMatchObject({ code: 'PRIVATE_BROADCAST_ALREADY_ATTEMPTED' });
  responseHook = null;
  expect(await service.getTransactionStatus(error.transactionHash, 11155111, { privacyContext: handle, review: async () => true })).toMatchObject({ status: 'unknown' });
  expect(requests.filter((r) => r.method === 'eth_sendRawTransaction')).toHaveLength(1);
});

test('other-account nonces, arbitrary hashes and Tor replacement cannot cross the context', async () => {
  await expect(network.request(11155111, 'eth_getTransactionCount', [params.to, 'pending'])).rejects.toMatchObject({ code: 'PRIVATE_TRANSACTION_REQUEST_REFUSED' });
  await expect(network.request(11155111, 'eth_getTransactionReceipt', [`0x${'f'.repeat(64)}`])).rejects.toMatchObject({ code: 'PRIVATE_TRANSACTION_REQUEST_REFUSED' });
  mockEndpoint = { signal: new AbortController().signal };
  await expect(network.getFeeQuote(11155111)).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a fresh caller gets a new client after Tor restarts while old references stay revoked', async () => {
  tor.abort(); tor = new AbortController(); mockEndpoint = { signal: tor.signal };
  const next = getPrivateTransactionNetwork(handle);
  expect(next).not.toBe(network);
  await expect(network.getFeeQuote(11155111)).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect((await next.getFeeQuote(11155111)).gasPrice).toBe('100');
});

test('lock cancels receipt polling without waiting for its timer', async () => {
  const sent = await service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true });
  const waiting = service.waitForTransaction(sent.hash, 11155111, 1, { privacyContext: handle, review: async () => true });
  await new Promise(setImmediate);
  scope.close();
  await expect(waiting).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
});


test('review sees complete frozen intent; rejection, expiry and lock prevent signing', async () => {
  const review = jest.fn(async (value) => {
    expect(value.transaction).toMatchObject({ nonce: 0, gasPrice: '100', chainId: 11155111 });
    expect(Object.isFrozen(value.transaction)).toBe(true);
    expect(value.unsignedSerialized).toMatch(/^0x/);
    return false;
  });
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review })).rejects.toMatchObject({ code: 'PRIVATE_REVIEW_REJECTED' });
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review: () => new Promise(() => {}), reviewTimeoutMs: 5 })).rejects.toMatchObject({ code: 'PRIVACY_REQUEST_ABORTED' });
  expect(signer.signTransaction).not.toHaveBeenCalled();
});

test('explicit invalid contexts and absent review never reach ordinary networking', async () => {
  for (const context of [false, 0, '', {}]) {
    await expect(service.getGasPrices(11155111, { privacyContext: context })).rejects.toMatchObject({ code: 'INVALID_PRIVACY_CONTEXT' });
  }
  await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle })).rejects.toMatchObject({ code: 'PRIVATE_REVIEW_REQUIRED' });
  expect(chainData.getFeeQuote).not.toHaveBeenCalled();
  expect(mockRequest).not.toHaveBeenCalled();
});


test('restart recovers a lost-response hash for receipt queries and blocks a new signature', async () => {
  responseHook = async (call) => { if (call.method === 'eth_sendRawTransaction') throw new Error('lost'); };
  const error = await service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true }).catch((error) => error);
  scope.close();
  scope = createPrivacyScope({ profileId: 'test', signal: new AbortController().signal });
  handle = scope.getContext({ kind: 'public-address', principal: wallet.address, chainId: 11155111, role: 'transaction-rpc' });
  mockJournals.set(handle, createSubmissionJournal({ handle, directory: journalDirectory, key: Buffer.alloc(32, 3) }));
  network = getPrivateTransactionNetwork(handle);
  expect(await network.listSubmissions()).toEqual([expect.objectContaining({ hash: error.transactionHash, state: 'attempted' })]);
  responseHook = null; signer.signTransaction.mockClear();
  await expect(service.signAndSendTransaction({ ...params, value: '2' }, signer, { privacyContext: handle, review: async () => true }))
    .rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
  expect(signer.signTransaction).not.toHaveBeenCalled();
  expect(await service.getTransactionStatus(error.transactionHash, 11155111, { privacyContext: handle })).toMatchObject({ status: 'unknown' });
  expect(requests.filter((r) => r.method === 'eth_sendRawTransaction')).toHaveLength(1);
});

test('disk failure before broadcast sends no bytes; a failed acknowledgment keeps a recoverable unknown outcome', async () => {
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
  try {
    await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true }))
      .rejects.toMatchObject({ code: 'PRIVATE_STORAGE_WRITE_FAILED' });
    expect(requests.some((r) => r.method === 'eth_sendRawTransaction')).toBe(false);
  } finally { rename.mockRestore(); }
  responseHook = async (call) => {
    if (call.method === 'eth_sendRawTransaction') jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full'); });
  };
  try {
    const error = await service.signAndSendTransaction(params, signer, { privacyContext: handle, review: async () => true }).catch((error) => error);
    expect(error).toMatchObject({ code: 'PRIVATE_BROADCAST_UNCERTAIN', submissionStatus: 'unknown' });
    expect(await network.listSubmissions()).toEqual([expect.objectContaining({ hash: error.transactionHash, state: 'attempted' })]);
  } finally { jest.restoreAllMocks(); }
});

test('a reviewed resolution allows one new nonce; missing evidence before or during signing closes the gate', async () => {
  const options = { privacyContext: handle, review: async () => true };
  const first = await service.signAndSendTransaction(params, signer, options);
  const included = { transactionHash: first.hash, from: wallet.address, blockHash: `0x${'c'.repeat(64)}`, status: '0x1', blockNumber: '0x10' };
  const policy = { minimumConfirmations: 2, review: async () => ({ allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' }) };
  receipt = included;
  await network.resolveSubmission(first.hash, policy);
  const includedBlock = canonical; canonical = null; signer.signTransaction.mockClear(); nonce = '0x1';
  await expect(service.signAndSendTransaction(params, signer, options)).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_UNAVAILABLE' });
  expect(signer.signTransaction).not.toHaveBeenCalled();
  receipt = included; canonical = includedBlock;
  await network.resolveSubmission(first.hash, policy);
  signer.signTransaction.mockImplementation(async (tx) => { canonical = null; return wallet.signTransaction(tx); });
  await expect(service.signAndSendTransaction(params, signer, options)).rejects.toMatchObject({ code: 'PRIVATE_RECONCILIATION_UNAVAILABLE' });
  expect(requests.filter((call) => call.method === 'eth_sendRawTransaction')).toHaveLength(1);
  receipt = included; canonical = includedBlock;
  await network.resolveSubmission(first.hash, policy);
  signer.signTransaction.mockImplementation((tx) => wallet.signTransaction(tx));
  const second = await service.signAndSendTransaction(params, signer, options);
  expect(second.hash).not.toBe(first.hash);
  expect(requests.filter((call) => call.method === 'eth_sendRawTransaction')).toHaveLength(2);
  expect(await network.listSubmissions()).toHaveLength(2);
  await expect(network.assertCanSubmit()).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNRESOLVED' });
});

test('rejects intent metadata that does not match signed bytes before journaling or transport', async () => {
  const { transactionIntent } = require('./private-transaction-intent');
  const signed = await wallet.signTransaction({ ...params, data: '0xabcd', nonce: 0, gasPrice: 100n });
  const wrong = transactionIntent('ppv2-native-deposit', { ...params, from: wallet.address, data: '0xabcd', value: '2' });
  await expect(network.broadcastRawTransaction(11155111, signed, { intent: wrong }))
    .rejects.toMatchObject({ code: 'PRIVATE_INTENT_INVALID' });
  expect(await network.listSubmissions()).toEqual([]); expect(requests).toEqual([]);
});

test('an absolute preparation deadline cannot be extended by slow nonce reads', async () => {
  const expiresAt = Date.now() + 1000;
  let clock;
  responseHook = async (call) => {
    if (call.method === 'eth_getTransactionCount') clock = jest.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
  };
  try {
    await expect(service.signAndSendTransaction(params, signer, { privacyContext: handle,
      reviewExpiresAt: expiresAt, review: async () => true })).rejects.toMatchObject({ code: 'PRIVATE_REVIEW_EXPIRED' });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(requests.some((request) => request.method === 'eth_sendRawTransaction')).toBe(false);
  } finally { clock?.mockRestore(); }
});


test('exit reservation is derived from signed calldata and durable before an uncertain transport handoff', async () => {
  const { transactionIntent } = require('./private-transaction-intent');
  const { Interface } = require('ethers');
  const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
  const data = new Interface([require('./ppv2-ragequit-policy').RAGEQUIT_ABI]).encodeFunctionData('ragequit',
    [[[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [1n, 7n, 3n, BigInt(wallet.address), 100n, BigInt(require('./ppv2-deposit-policy').NATIVE), 4n]]]);
  const tx = { ...params, from: wallet.address, data, value: 0n, nonce: 0, gasPrice: 100n };
  const intent = transactionIntent('ppv2-native-ragequit', tx);
  const signed = await wallet.signTransaction(tx);
  let durable = false;
  responseHook = async (call) => {
    if (call.method !== 'eth_sendRawTransaction') return;
    const records = await network.listSubmissions();
    durable = records[0].intent.commitment === word(7) && records[0].intent.pool === params.to;
    throw new Error('Lost response');
  };
  await expect(network.broadcastRawTransaction(11155111, signed, { intent: { ...intent, commitment: word(8) } }))
    .rejects.toMatchObject({ code: 'PRIVATE_BROADCAST_UNCERTAIN' });
  expect(durable).toBe(true);
  expect((await network.listSubmissions())[0]).toMatchObject({ state: 'attempted', intent });
});
